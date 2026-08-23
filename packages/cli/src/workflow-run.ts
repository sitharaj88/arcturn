/**
 * RESILIENCE SUBSTRATE for the org-workflow runtime — the durable run journal
 * and the resume state rebuilt from it.
 *
 * `runWorkflow` (see `workflow.ts`) holds *all* of a run's live state in memory:
 * the accumulated `results`, the `appliedPatches` that seed each later stage's
 * worktree, the `prev` pipe text, and the running `usage`. A crash, a machine
 * sleep mid-response, or a Ctrl+C between stages loses every bit of it above the
 * last patch that happened to land on disk — the exact ledger incident this
 * module closes (an agent building a fix died on sleep and its whole run was
 * gone because nothing was resumable).
 *
 * The fix is an **append-only JSONL journal** written as the run progresses, one
 * object per line, mirroring the crash-consistency model of
 * `core/session/jsonl-store.ts`: writes are serialized through a single promise
 * chain so concurrent parallel-branch appends never interleave, and a torn final
 * line (a write cut off by the crash) is simply dropped on read, recovering the
 * whole prefix. Each `stepEnd` line is the durability commit for one step — once
 * it is on disk with its patch record, that step is *done* and never re-run.
 *
 * ## What the journal buys, concretely
 *
 * - **Resume** ({@link buildResumeState}): replay the journal, and every step
 *   whose latest line is a `stepEnd{status:"done"}` is treated as complete — its
 *   recorded `text` re-enters the pipe and its applied patch re-enters the run
 *   state, but it is *not re-run* and its patch is *never re-applied*. Only the
 *   step the crash interrupted (a `stepStart` with no matching `stepEnd`) and
 *   everything after it run live. A killed run continues; it never restarts.
 * - **Observability**: the same file is the durable trace a `/workflow status`
 *   view reads — which stage, which steps done/failed, spend so far — without an
 *   engineer grepping session JSONL by hand.
 *
 * The engine takes the journal as an **injected sink** ({@link RunJournal}), the
 * same way it takes `onEvent`, so it stays testable with no filesystem;
 * {@link createFileRunJournal} is the production, file-backed implementation.
 *
 * Type-only imports from `workflow.js` are fully erased at runtime, so this
 * module never requires the driver back — the dependency is one-way (the driver
 * requires this module) with no runtime cycle.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@arcturn/types";
import type { WorkflowPatchRecord, WorkflowRunStatus, WorkflowStepStatus } from "./workflow.js";

/** Bumped when a journal line's shape changes incompatibly. */
export const RUN_JOURNAL_SCHEMA_VERSION = 1;

/** File name of the append-only journal inside a run's artifact directory. */
export const RUN_JOURNAL_FILE = "journal.jsonl";

/** File name of the small run header written once, beside the journal. */
export const RUN_MANIFEST_FILE = "manifest.json";

/**
 * Why a whole run halted, recorded on a `stop` line.
 *
 * The full vocabulary is defined here so a reader tolerates every kind; this
 * module only ever emits nothing of its own (stop lines belong to the run-level
 * budget/deadline enforcement), but the resume reader must parse them.
 */
export type WorkflowStopReason =
  | "cost-ceiling"
  | "turn-ceiling"
  | "run-deadline"
  | "repeated-transient"
  | "cancelled"
  | "deterministic-failure"
  | "error";

/** The run-header line: exactly one, first, on a fresh run. */
export interface RunHeaderLine {
  readonly kind: "run";
  readonly v: number;
  readonly runId: string;
  readonly workflow: string;
  readonly source: string;
  readonly input: string;
  readonly stepTimeoutMs: number;
  readonly maxStepRetries: number;
  readonly startedAt: number;
}

/** A stage began. */
export interface StageStartLine {
  readonly kind: "stageStart";
  readonly stage: number;
  readonly parallel: boolean;
  readonly steps: number;
  readonly ts: number;
}

/** A stage finished, with its rolled-up status. */
export interface StageEndLine {
  readonly kind: "stageEnd";
  readonly stage: number;
  readonly status: WorkflowStepStatus;
  readonly ts: number;
}

/** A step began running live. Paired with exactly one {@link StepEndLine}. */
export interface StepStartLine {
  readonly kind: "stepStart";
  readonly id: string;
  readonly stage: number;
  readonly branch: number;
  readonly agent?: string;
  readonly modelTag?: string;
  readonly promptHash: string;
  readonly ts: number;
}

/**
 * A step reached a terminal state — the resumable unit.
 *
 * Carries everything resume needs to reconstitute the step without re-running
 * it: its {@link WorkflowStepStatus}, the `text` that re-enters the pipe, the
 * patch `record` (whose `applied` entry re-enters the run's applied-patch
 * state), the `usage` that keeps the run total accurate, and a `promptHash` so
 * a resume can notice the workflow file changed under it.
 */
export interface StepEndLine {
  readonly kind: "stepEnd";
  readonly id: string;
  readonly stage: number;
  readonly branch: number;
  readonly status: WorkflowStepStatus;
  readonly agent?: string;
  readonly modelTag?: string;
  readonly usage: Usage;
  readonly record?: WorkflowPatchRecord;
  readonly text: string;
  readonly promptHash: string;
  /** How many attempts (1 + self-healing retries) this step took. */
  readonly attempts: number;
  readonly startedAt: number;
  readonly endedAt: number;
  /**
   * The question this step raised, when `status` is `"paused"`.
   *
   * The human-question gate ({@link buildResumeState} reads it into
   * {@link ResumeState.paused} and {@link ResumeState.pendings}): a role emitted
   * an `ORG-ASK:` line, so the run stopped for a person rather than guessing.
   * Carried on the durable terminal so the pause — and the question itself —
   * survive the process dying, which is the whole point of the gate over the old
   * "halt and re-run from scratch".
   */
  readonly question?: string;
  /**
   * True when this `done` terminal was written by a resume that *injected a
   * human's answer* in place of re-running the step. The previous run paused
   * here for a question; the answer is now this step's `text`, so `{{prev}}`
   * carries it forward exactly where the asking role's output would have gone.
   */
  readonly answered?: boolean;
  /**
   * True when this terminal was *reconstructed* by a resume rather than
   * observed: the previous run was killed inside the step's irreversible
   * window, and {@link buildResumeState} + the checkout probe decided the work
   * had already landed. The status is then the best-supported reading of the
   * checkout, not a report the step actually made.
   */
  readonly recovered?: boolean;
}

/**
 * **Write-ahead**: a step is about to do something it cannot take back.
 *
 * This is the barrier that makes a killed run recoverable rather than
 * ambiguous. The write lane's `git apply` mutates the user's real checkout from
 * *inside* `runStep`, while the step's terminal ({@link StepEndLine}) is only
 * written once `runStep` returns — so a crash in between used to leave the
 * checkout mutated and the journal saying "not done", and resume re-ran the
 * step straight into a double-apply. The runner now records this line, and
 * flushes it, *before* the act; {@link StepEffectLine} records how it settled.
 *
 * Two acts, and the difference matters on resume:
 *
 * - `"guarded"` — a declaration, made once at the top of a step: *this runner
 *   announces every irreversible act before performing it*. A step carrying
 *   only this and no `"apply"` intent provably never reached one, so resume
 *   re-runs it live. A runner that declares nothing is `"unknown"` and is
 *   never re-run (see {@link decideInterruptedStep}).
 * - `"apply"` — the irreversible window itself: this exact patch is about to be
 *   replayed into `target`. Carries the patch's path and content hash so a
 *   resume can probe the checkout for it.
 */
export interface StepIntentLine {
  readonly kind: "stepIntent";
  readonly id: string;
  readonly stage: number;
  readonly branch: number;
  /** 0-based attempt within the step's self-healing retry loop. */
  readonly attempt: number;
  readonly act: "guarded" | "apply";
  /** Absolute path of the patch about to be applied (`act: "apply"`). */
  readonly patchPath?: string;
  /** SHA-256 of the patch bytes, so a resume can tell it apart from a rewrite. */
  readonly patchHash?: string;
  /** The checkout being mutated. */
  readonly target?: string;
  readonly ts: number;
}

/**
 * How the irreversible act announced by a {@link StepIntentLine} settled.
 *
 * Written immediately after the act returns and before anything else, so the
 * ambiguous window is the width of one `git apply` plus one journal append —
 * and a crash inside *that* is resolved by probing the checkout itself.
 */
export interface StepEffectLine {
  readonly kind: "stepEffect";
  readonly id: string;
  readonly stage: number;
  readonly branch: number;
  readonly attempt: number;
  readonly act: "apply";
  /** True when the patch is now in the checkout. */
  readonly applied: boolean;
  readonly patchPath?: string;
  /** The engine-minted record, so a recovered step re-enters the run whole. */
  readonly record?: WorkflowPatchRecord;
  readonly ts: number;
}

/** A rolled-up spend snapshot; emitted by the run-level budget layer. */
export interface BudgetLine {
  readonly kind: "budget";
  readonly usage: Usage;
  readonly spentUsd?: number;
  readonly turns?: number;
  readonly ts: number;
}

/** The whole run was halted by a STOP condition. */
export interface StopLine {
  readonly kind: "stop";
  readonly reason: WorkflowStopReason;
  readonly ts: number;
}

/** The run ended (clean or failed). Absent when the process died mid-run. */
export interface RunEndLine {
  readonly kind: "runEnd";
  readonly status: WorkflowRunStatus;
  readonly ts: number;
}

/** One line of the append-only journal. */
export type JournalLine =
  | RunHeaderLine
  | StageStartLine
  | StageEndLine
  | StepStartLine
  | StepIntentLine
  | StepEffectLine
  | StepEndLine
  | BudgetLine
  | StopLine
  | RunEndLine;

/**
 * The journal lines correctness — not merely observability — depends on.
 *
 * These are appended through {@link RunJournal.appendDurable}: they are flushed
 * to disk and a failure to write one is *raised*, never swallowed. Everything
 * else (stage roll-ups, budget snapshots, the run header) is best-effort, as it
 * always was.
 */
export const DURABLE_JOURNAL_KINDS: ReadonlySet<JournalLine["kind"]> = new Set<JournalLine["kind"]>(
  ["stepIntent", "stepEffect", "stepEnd"],
);

/**
 * The durable journal sink the engine appends to.
 *
 * Injected so the driver stays testable without a filesystem — a test passes an
 * in-memory recorder, production passes {@link createFileRunJournal}. `append`
 * must never reject: a journal write failing must not fail the run (the same
 * contract as the `onEvent` sink), so a file-backed implementation swallows its
 * own errors and still resolves.
 *
 * {@link appendDurable} is the deliberate exception. "A journal write may never
 * fail a run" is right for a stage roll-up and *wrong* for the record that says
 * "this step is about to change the user's checkout": swallowing that one is
 * how a crash turns into a double-apply, because resume then has no idea the
 * act began. So the durability-critical lines ({@link DURABLE_JOURNAL_KINDS})
 * go through a path that flushes and *raises*, and the caller decides — the
 * write lane refuses to apply at all when its intent could not be recorded.
 */
export interface RunJournal {
  append(line: JournalLine): Promise<void>;
  /**
   * Append a line correctness depends on, flush it, and **reject** when it did
   * not reach durable storage.
   *
   * Optional so every existing in-memory sink still satisfies the interface;
   * callers fall back to {@link append} when it is absent, which is exactly the
   * "cannot promise durability" case a resume must treat conservatively.
   */
  appendDurable?(line: JournalLine): Promise<void>;
}

/** The small header written once beside the journal, for `/workflow status`. */
export interface RunManifest {
  readonly v: number;
  readonly runId: string;
  readonly workflow: string;
  readonly source: string;
  readonly input: string;
  readonly stepTimeoutMs: number;
  readonly maxStepRetries: number;
  readonly startedAt: number;
}

/** SHA-256 of a step's spliced prompt — the staleness key resume compares on. */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * SHA-256 of a patch's bytes — the identity a write-ahead intent carries.
 *
 * Same primitive as {@link hashPrompt}, named separately because the two answer
 * different questions ("did the workflow change under this run?" versus "is
 * *this* patch the one the checkout is holding?") and a reader should not have
 * to infer which from the call site.
 */
export function hashPatch(patch: string): string {
  return createHash("sha256").update(patch, "utf8").digest("hex");
}

/**
 * A file-backed {@link RunJournal} appending to `<dir>/journal.jsonl`.
 *
 * Writes are serialized through a single promise chain (mirroring
 * `JsonlSessionStore.append`) so a parallel stage's concurrent `stepEnd`
 * appends can never interleave into a half-written line.
 *
 * Two write paths, because two different things are at stake:
 *
 * - {@link RunJournal.append} is best-effort: a failure to `mkdir`/`appendFile`
 *   is swallowed so hygiene can never fail a run, but the returned promise
 *   still resolves *after* the attempt.
 * - {@link RunJournal.appendDurable} `fdatasync`s the line and **rejects** when
 *   it did not land. A page-cached "write" that a power cut eats is not a
 *   durability commit, and a swallowed one is worse than none at all: the
 *   caller would go on to `git apply` believing the crash is recoverable. The
 *   whole point of the write-ahead record is that the act does not happen
 *   unless the record does.
 *
 * @param dir - The run's artifact directory (`~/.arcturn/workflow-runs/<id>/`).
 */
export function createFileRunJournal(dir: string): RunJournal {
  const path = join(dir, RUN_JOURNAL_FILE);
  let ready: Promise<void> | undefined;
  const ensureDir = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true }).then(
      () => undefined,
      () => undefined,
    );
    return ready;
  };
  /** Append and flush, or throw. Never memoizes a failed `mkdir`. */
  const writeAndFlush = async (line: JournalLine): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const handle = await open(path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(line)}\n`, "utf8");
      // Data only: the line's bytes are what recovery reads, and skipping the
      // metadata flush keeps the barrier cheap enough to sit in the hot path.
      await handle.datasync();
    } finally {
      await handle.close();
    }
  };
  let queue: Promise<void> = Promise.resolve();
  /** Chain `task` after the in-flight writes, keeping the chain alive on error. */
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = queue.catch(() => undefined).then(task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    append(line: JournalLine): Promise<void> {
      return enqueue(async () => {
        try {
          await ensureDir();
          await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
        } catch {
          // A journal write must never be able to fail a run — the run's own
          // durability degrades to "not recorded", it does not crash.
        }
      });
    },
    appendDurable(line: JournalLine): Promise<void> {
      return enqueue(() => writeAndFlush(line));
    },
  };
}

/** Write the run manifest header. Best-effort: never rejects. */
export async function writeManifest(dir: string, manifest: RunManifest): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RUN_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    // The manifest is a convenience for the status view; its absence never
    // fails a run (the journal's own `run` header carries the same fields).
  }
}

/** Read the run manifest, or `undefined` when it is missing or unreadable. */
export async function readManifest(dir: string): Promise<RunManifest | undefined> {
  try {
    const raw = await readFile(join(dir, RUN_MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as RunManifest;
    if (typeof parsed?.runId === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse one journal line, tolerating anything that is not a well-formed object.
 *
 * @returns The parsed line, or `undefined` for a blank or malformed line.
 */
function parseJournalLine(line: string): JournalLine | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as JournalLine;
    if (parsed !== null && typeof parsed === "object" && typeof parsed.kind === "string") {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every valid line of a run's journal, in append order.
 *
 * A crash mid-append leaves a torn final line; like `JsonlSessionStore.entries`,
 * an unparseable line is dropped rather than throwing — recovering the whole
 * durable prefix, which is exactly the set of steps resume may trust. A missing
 * file yields `[]` (nothing was ever journaled).
 *
 * @param dir - The run's artifact directory.
 */
export async function readJournalLines(dir: string): Promise<JournalLine[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, RUN_JOURNAL_FILE), "utf8");
  } catch {
    return [];
  }
  const out: JournalLine[] = [];
  for (const line of raw.split("\n")) {
    const parsed = parseJournalLine(line);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * One step reconstructed from its terminal journal line, ready to be spliced
 * back into a resumed run in place of re-executing it.
 */
export interface ResumedStep {
  readonly status: WorkflowStepStatus;
  readonly text: string;
  readonly record?: WorkflowPatchRecord;
  readonly usage: Usage;
  /** The prompt hash the step ran under, for the staleness check on resume. */
  readonly promptHash: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /**
   * The `ORG-ASK:` question this step raised, for a `paused` terminal.
   *
   * Carried so a re-surfaced pause ({@link ResumeState.paused}) re-arms the
   * run's pause with the *same* question the human was asked, rather than an
   * empty one — a resume that cannot restate the question cannot be answered.
   */
  readonly question?: string;
}

/**
 * The state a resumed {@link runWorkflow} re-enters with.
 *
 * `completed` maps a step id to its recorded terminal outcome for every step the
 * previous run *finished* (a `stepEnd{status:"done"}`). The driver, walking its
 * stage loop exactly as a live run does, substitutes these in place of running —
 * so `prev`, `appliedPatches` and the run `usage` reconstruct themselves through
 * the unchanged accumulation logic, byte-identical to the original run — and
 * runs everything else live from the first unfinished step onward.
 */
export interface ResumeState {
  readonly runId?: string;
  readonly source?: string;
  readonly workflow?: string;
  readonly startedAt?: number;
  /** Step id → its finished outcome; only `done` steps are here. */
  readonly completed: ReadonlyMap<string, ResumedStep>;
  /**
   * Step id → what the crash interrupted: a step the previous run *started* and
   * never durably finished. These are the steps whose side effect may or may
   * not have landed; {@link decideInterruptedStep} decides which of them may be
   * re-run. Never overlaps {@link completed}.
   */
  readonly interrupted: ReadonlyMap<string, InterruptedStep>;
  /** True when the journal recorded a clean `runEnd` (the run already finished). */
  readonly ended: boolean;
  /** The `runEnd` status, when the run ended. */
  readonly endedStatus?: WorkflowRunStatus;
  /**
   * Every step whose *latest* terminal is a `stepEnd{status:"paused"}`, by id.
   *
   * A stage can raise more than one question — two reviewers in one parallel
   * stage both hitting a real ambiguity is an ordinary org shape — and each of
   * them journalled its own `paused` terminal. Every one of those steps is
   * *settled*: it ran, it produced output, and it is waiting on a person. This
   * map is how the driver knows that, and it is the whole fix for the
   * double-apply the gate reopened: a paused step the resume state did not
   * carry was in neither {@link completed} nor {@link interrupted}, so it read
   * as "never seen" and was RE-EXECUTED — irreversible act and all.
   *
   * A paused step is therefore never run again. It is either answered (see
   * {@link answer}/{@link answers}) or re-surfaced from this map exactly as it
   * was recorded, re-arming the run's pause.
   *
   * A paused step that already applied a patch is *also* in {@link completed}
   * (the "an applied record proves the checkout changed" rule); this map wins
   * for it, because its terminal here carries the question too.
   */
  readonly paused: ReadonlyMap<string, ResumedStep>;
  /**
   * The human-question gate's pending pause, when the run stopped for a person.
   *
   * The FIRST of {@link pendings} — the question an operator is shown first —
   * kept as its own field because every existing reader (`/workflow resume`,
   * the status view, the hosts) asks "what is this run waiting on?" and wants
   * one answer. Absent means the run is not paused for a question (a fresh run,
   * a crash, or a clean end).
   */
  readonly pending?: PendingQuestion;
  /**
   * EVERY question the paused stage raised, in journal (branch) order.
   *
   * Surfaced together so the human sees the whole stage's ambiguity at once
   * rather than being drip-fed one question per resume. Empty when the run is
   * not paused.
   */
  readonly pendings: readonly PendingQuestion[];
  /**
   * The human's reply to the paused stage, supplied by the resume flow — never
   * read from the journal.
   *
   * `stepId` names the question the operator was answering; the reply settles
   * that step **and every other paused step of the same stage** that has no
   * more specific answer in {@link answers}. That is deliberate: the whole
   * stage's questions are surfaced together ({@link pendings}), so the reply is
   * a reply to the stage, and a person who has answered is not made to answer
   * again for each branch. Per-question precision is still available — a host
   * that wants it fills in {@link answers} instead.
   *
   * When it applies to a step, the run loop completes that step with `text` as
   * its output (status `done`, no re-run, no new spend) so `{{prev}}` carries
   * the answer into the next stage, then runs everything after it live. The
   * `/workflow resume <runId> <answer>` command fills this in.
   */
  readonly answer?: PendingAnswer;
  /**
   * Per-question answers, when the caller wants to settle each one exactly.
   *
   * Takes precedence over {@link answer} for the steps it names, and unlike
   * {@link answer} it never spills onto a sibling: a stage with two questions
   * and one entry here settles that one step and pauses again on the other —
   * still without re-running anything.
   */
  readonly answers?: readonly PendingAnswer[];
}

/**
 * A question a paused run is waiting on, rebuilt from the journal.
 *
 * The `promptHash` is the same staleness key every resume path compares on: if
 * the workflow file changed under the run, an injected answer would be attached
 * to a *different* question, so resume refuses rather than mis-answer.
 */
export interface PendingQuestion {
  readonly stepId: string;
  readonly stage: number;
  readonly branch: number;
  /** The `ORG-ASK:` text the role raised — what the human is being asked. */
  readonly question: string;
  /** The spliced prompt hash the asking step ran under. */
  readonly promptHash: string;
}

/** A human answer to inject in place of a paused step's question. */
export interface PendingAnswer {
  /** The paused step to complete with this answer. */
  readonly stepId: string;
  /** The answer text — becomes the step's output and the next stage's `{{prev}}`. */
  readonly text: string;
}

/**
 * A step the previous run started and never durably finished — the crash point.
 *
 * Everything here comes from lines that reached disk *before* the step's
 * irreversible act, which is the only evidence a crash leaves behind. `act` is
 * the strongest write-ahead declaration found:
 *
 * - `"unknown"` — the runner declared nothing. It may have mutated the user's
 *   checkout and left no trace; nothing may be assumed.
 * - `"guarded"` — the runner promised to announce irreversible acts first, and
 *   announced none. Nothing landed.
 * - `"apply"` — the patch at `patchPath` was about to be replayed into
 *   `target`. If `applied` is set, the act settled and the journal knows how.
 */
export interface InterruptedStep {
  readonly id: string;
  readonly stage: number;
  readonly branch: number;
  /** The prompt the step ran under, for resume's staleness check. */
  readonly promptHash?: string;
  readonly act: "unknown" | "guarded" | "apply";
  readonly attempt?: number;
  readonly patchPath?: string;
  readonly patchHash?: string;
  readonly target?: string;
  /** The recorded settlement of the act; absent when the crash beat it. */
  readonly applied?: boolean;
  /** The patch record the effect line carried, when it landed. */
  readonly record?: WorkflowPatchRecord;
}

/**
 * What a probe of the real checkout says about one patch.
 *
 * Deliberately three-valued: "I could not tell" is a distinct, common answer
 * (the patch file is gone, the tree moved on, git is unavailable) and collapsing
 * it into either boolean is precisely how a resume corrupts a working tree.
 */
export type PatchPresence = "applied" | "not-applied" | "indeterminate";

/** What resume does about one interrupted step. */
export interface InterruptedVerdict {
  /** `"rerun"`: execute it live. `"recover"`: never execute it again. */
  readonly action: "rerun" | "recover";
  /** One clause, for the operator-facing note and the step's own text. */
  readonly reason: string;
}

/**
 * Decide whether an interrupted step may be re-executed.
 *
 * The asymmetry is the whole design: re-running a step whose `git apply` already
 * landed either mutates the user's checkout twice or hard-fails as a refused
 * patch, and *both* are worse than skipping work that may already be done. So a
 * re-run needs positive evidence that nothing landed; ambiguity recovers.
 *
 * | evidence on disk | verdict |
 * | --- | --- |
 * | `guarded` declared, no `apply` intent | **rerun** — the runner promised to announce any irreversible act, and did not |
 * | `apply` intent, effect says not applied | **rerun** — the act settled having changed nothing |
 * | `apply` intent, effect says applied | **recover** — the patch is in the checkout |
 * | `apply` intent, no effect, probe says `not-applied` | **rerun** — the checkout is still in the pre-apply state |
 * | `apply` intent, no effect, probe says `applied` | **recover** |
 * | `apply` intent, no effect, probe `indeterminate`/absent | **recover** — cannot prove the tree is clean |
 * | nothing declared (`unknown`) | **recover** — an opaque runner may have written anywhere |
 *
 * The last row is why an injected runner (any host wiring its own `runStep`,
 * every test double, an un-roled step whose tools were never narrowed) is never
 * re-run after a crash: the engine cannot see what it did, and guessing "it
 * probably did nothing" is the guess that corrupts a checkout.
 *
 * @param step - The interrupted step, as rebuilt from the journal.
 * @param presence - What a checkout probe said, when one could be run.
 */
export function decideInterruptedStep(
  step: InterruptedStep,
  presence?: PatchPresence,
): InterruptedVerdict {
  if (step.act === "guarded") {
    return {
      action: "rerun",
      reason: "it was interrupted before it changed anything outside its own worktree",
    };
  }
  if (step.act === "apply") {
    if (step.applied === true) {
      return { action: "recover", reason: "its patch was already applied to your checkout" };
    }
    if (step.applied === false) {
      return { action: "rerun", reason: "its patch was refused, so nothing was changed" };
    }
    if (presence === "not-applied") {
      return {
        action: "rerun",
        reason: "its patch still applies cleanly, so the interrupted run never landed it",
      };
    }
    if (presence === "applied") {
      return {
        action: "recover",
        reason: "its patch reverses cleanly out of your checkout, so it is already there",
      };
    }
    return {
      action: "recover",
      reason:
        "it was interrupted while applying its patch and the checkout can no longer be probed " +
        "for it, so re-running could apply the same change twice",
    };
  }
  return {
    action: "recover",
    reason:
      "the interrupted run never recorded what it had done, so re-running it could repeat a " +
      "change that already landed",
  };
}

/**
 * Rebuild {@link ResumeState} from a run's journal lines.
 *
 * Every step lands in exactly one of three buckets:
 *
 * 1. **Complete** ({@link ResumeState.completed}) — its latest journal entry is
 *    a `stepEnd` with status `done`, *or* a `stepEnd` of any status whose patch
 *    record says `applied`. The second clause is a hard safety rule, not a
 *    convenience: a terminal line that says "this patch is in the user's
 *    checkout" is proof the irreversible act happened, and re-running it would
 *    double-apply no matter how the step itself was scored.
 * 2. **Interrupted** ({@link ResumeState.interrupted}) — a `stepStart` (or a
 *    write-ahead `stepIntent`) with no `stepEnd` after it: the crash point. This
 *    used to be folded into "just re-run it", which is exactly the double-apply
 *    the write lane's `git apply` can produce; it is now carried out to the
 *    driver with its write-ahead evidence so {@link decideInterruptedStep} can
 *    rule on it.
 * 3. **Not started, or terminally failed** — absent from both maps, and re-run
 *    live, as before. A `stepEnd{failed}` means the previous run *observed* the
 *    failure, so there is no ambiguity to resolve.
 * 4. **Paused for a human answer** ({@link ResumeState.paused}) — its latest
 *    terminal is a `stepEnd{status:"paused"}`. It is in neither of the two maps
 *    above: not `completed` (re-splicing its question as output would re-ask,
 *    not answer) and not `interrupted` (it is not a crash point). It gets its
 *    own map, and *every* paused step of a stage is in it — a parallel stage
 *    can raise several questions, and a paused step missing from the resume
 *    state is one the driver re-executes. A resume injects the human's answer
 *    in its place; an answered pause re-writes it as `done`, so "latest wins"
 *    moves it into `completed` on the next read.
 *
 * "Latest wins" matters because a resumed run appends to the same journal: a
 * step re-run on one resume and finished appends a fresh `stepEnd`, so a later
 * resume must read that one, not the earlier non-terminal record. A re-opened
 * step (a fresh `stepStart` after an earlier `stepEnd`) is interrupted again.
 *
 * Tolerant by construction: the lines are whatever survived
 * {@link readJournalLines}, so a torn tail, a line missing fields a newer
 * schema added, or an intent with no matching effect are all normal inputs and
 * degrade toward "do not re-run", never toward a throw.
 *
 * @param lines - The journal, in append order (see {@link readJournalLines}).
 */
export function buildResumeState(lines: readonly JournalLine[]): ResumeState {
  let runId: string | undefined;
  let source: string | undefined;
  let workflow: string | undefined;
  let startedAt: number | undefined;
  let ended = false;
  let endedStatus: WorkflowRunStatus | undefined;
  // Latest terminal record per step id — a resume appends, so the newest wins.
  const latest = new Map<string, StepEndLine>();
  // Steps currently *open*: started (or announced) with no terminal after it.
  // A `stepEnd` closes one; a later `stepStart` for the same id re-opens it.
  const open = new Map<string, InterruptedStep>();

  for (const line of lines) {
    switch (line.kind) {
      case "run":
        runId = line.runId;
        source = line.source;
        workflow = line.workflow;
        startedAt = line.startedAt;
        break;
      case "stepStart":
        latest.delete(line.id);
        open.set(line.id, {
          id: line.id,
          stage: line.stage,
          branch: line.branch,
          ...(line.promptHash === undefined ? {} : { promptHash: line.promptHash }),
          act: "unknown",
        });
        break;
      case "stepIntent": {
        const current = open.get(line.id) ?? {
          id: line.id,
          stage: line.stage,
          branch: line.branch,
          act: "unknown" as const,
        };
        // An `apply` announcement is strictly stronger than the `guarded`
        // declaration that preceded it, and a later `guarded` (the next attempt
        // starting) supersedes the previous attempt's settled window.
        open.set(line.id, {
          ...current,
          act: line.act,
          attempt: line.attempt,
          ...(line.patchPath === undefined ? {} : { patchPath: line.patchPath }),
          ...(line.patchHash === undefined ? {} : { patchHash: line.patchHash }),
          ...(line.target === undefined ? {} : { target: line.target }),
          // A fresh intent opens a fresh window: whatever the previous one
          // settled as no longer describes what is in flight.
          applied: undefined,
          record: undefined,
        });
        break;
      }
      case "stepEffect": {
        const current = open.get(line.id);
        if (current === undefined) break;
        open.set(line.id, {
          ...current,
          applied: line.applied,
          ...(line.record === undefined ? {} : { record: line.record }),
        });
        break;
      }
      case "stepEnd":
        latest.set(line.id, line);
        open.delete(line.id);
        break;
      case "runEnd":
        ended = true;
        endedStatus = line.status;
        break;
      default:
        break;
    }
  }

  const completed = new Map<string, ResumedStep>();
  for (const [id, line] of latest) {
    // A finished step is trusted as complete — and so is any step whose record
    // says its patch reached the checkout, whatever the step's own status: that
    // fact alone makes a re-run a double-apply.
    if (line.status !== "done" && line.record?.status !== "applied") continue;
    completed.set(id, {
      status: line.status,
      text: line.text,
      ...(line.record === undefined ? {} : { record: line.record }),
      usage: line.usage,
      promptHash: line.promptHash,
      ...(line.startedAt === undefined ? {} : { startedAt: line.startedAt }),
      ...(line.endedAt === undefined ? {} : { endedAt: line.endedAt }),
    });
  }

  const interrupted = new Map<string, InterruptedStep>();
  for (const [id, step] of open) {
    if (completed.has(id)) continue;
    // Strip the `undefined` placeholders the fold uses to reset a window, so an
    // entry only carries fields the journal actually recorded.
    const { applied, record, ...rest } = step;
    interrupted.set(id, {
      ...rest,
      ...(applied === undefined ? {} : { applied }),
      ...(record === undefined ? {} : { record }),
    });
  }

  // The human-question gate: the run is paused iff a step's *latest* terminal is
  // a `paused` one (an answered pause re-writes it as `done`, so "latest wins"
  // clears itself the moment the answer lands). A stage can pause on SEVERAL
  // steps at once — a parallel stage's branches all run to a terminal before the
  // pause short-circuits anything — so every one of them is collected here. The
  // first is `pending`, the question an operator is shown first.
  const paused = new Map<string, ResumedStep>();
  const pendings: PendingQuestion[] = [];
  for (const [id, line] of latest) {
    if (line.status !== "paused") continue;
    paused.set(id, {
      status: line.status,
      text: line.text,
      ...(line.record === undefined ? {} : { record: line.record }),
      usage: line.usage,
      promptHash: line.promptHash,
      ...(line.startedAt === undefined ? {} : { startedAt: line.startedAt }),
      ...(line.endedAt === undefined ? {} : { endedAt: line.endedAt }),
      ...(line.question === undefined ? {} : { question: line.question }),
    });
    pendings.push({
      stepId: id,
      stage: line.stage,
      branch: line.branch,
      question: line.question ?? "",
      promptHash: line.promptHash,
    });
  }
  const pending = pendings[0];

  return {
    ...(runId === undefined ? {} : { runId }),
    ...(source === undefined ? {} : { source }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(startedAt === undefined ? {} : { startedAt }),
    completed,
    interrupted,
    paused,
    ended,
    ...(endedStatus === undefined ? {} : { endedStatus }),
    ...(pending === undefined ? {} : { pending }),
    pendings,
  };
}

/**
 * The transient/deterministic split lifted from the LLM layer to the step level.
 *
 * A transient failure — a stalled/dead LLM socket surfaced as `network`, a rate
 * limit or overload that outlived the request-layer retries, a git index lock, a
 * step that hit its wall-clock deadline — *can* succeed on a fresh attempt, so it
 * is retried with backoff. A deterministic failure — a refused patch (a real
 * merge conflict or a path-escape audit), a parse/validation refusal, a
 * plan-mode lane refusal, an empty required output — *cannot* change on a rerun,
 * so it fails immediately. Retrying it would only burn tokens and wall clock on
 * an outcome that is already settled, the exact anti-pattern the request-layer
 * classifier already avoids.
 */
export type WorkflowFailureClass = "transient" | "deterministic";

/**
 * Machine-readable cause threaded onto a failing step's outcome so the
 * classifier never has to regex an error string.
 *
 * `network`/`rateLimit`/`overloaded` come straight from the terminal
 * `AIError["kind"]` the child agent surfaced; `timeout` is minted by the step
 * deadline; `git-lock` from a git index-lock collision; the rest label the
 * deterministic refusals the runtime already produces.
 */
export type WorkflowFailureKind =
  | "network"
  | "rateLimit"
  | "overloaded"
  | "timeout"
  | "git-lock"
  | "patch-refused"
  | "config"
  | "agent-error"
  | "cancelled";

/** The transient kinds, in one place so the classifier and tests agree. */
const TRANSIENT_KINDS: ReadonlySet<WorkflowFailureKind> = new Set<WorkflowFailureKind>([
  "network",
  "rateLimit",
  "overloaded",
  "timeout",
  "git-lock",
]);

/**
 * Classify a failing step's {@link WorkflowFailureKind}.
 *
 * An unknown/absent kind is deterministic — the safe default: never retry
 * something we cannot positively identify as transient, so a genuinely broken
 * step fails fast instead of looping.
 *
 * @param kind - The failure kind threaded onto the step outcome, if any.
 */
export function classifyFailureKind(kind: WorkflowFailureKind | undefined): WorkflowFailureClass {
  return kind !== undefined && TRANSIENT_KINDS.has(kind) ? "transient" : "deterministic";
}

/**
 * Map an `AIError["kind"]` (as re-emitted on a child agent's stream) onto the
 * workflow-level failure kind. Only the transient LLM kinds are lifted; every
 * other AI error (auth, invalidRequest, unknown) is a deterministic
 * `agent-error` that a rerun will not fix.
 *
 * @param kind - The terminal stream error kind, when the child surfaced one.
 */
export function failureKindFromAIError(
  kind: "auth" | "rateLimit" | "overloaded" | "invalidRequest" | "network" | "aborted" | "unknown",
): WorkflowFailureKind {
  switch (kind) {
    case "network":
      return "network";
    case "rateLimit":
      return "rateLimit";
    case "overloaded":
      return "overloaded";
    case "aborted":
      return "cancelled";
    default:
      return "agent-error";
  }
}

/** True when a git error message names an index/ref lock — a transient collision. */
export function isGitLockError(message: string): boolean {
  return /\.lock|index\.lock|unable to create|another git process/i.test(message);
}
