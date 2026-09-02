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
import type { AssistantMessage, Usage } from "@arcturn/types";
import { formatCost, oneLine } from "./format.js";
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
  | "token-ceiling"
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
  /**
   * A dollar ceiling the run's STARTER bound it to, when that ceiling did not
   * come from the workflow file — an upper bound on every ceiling this run may
   * ever be enforced under, resumes and raises included.
   *
   * Written by the wire path, which is the only starter that can hand the
   * engine a `budgetUsd` of its own: `WorkflowRunRequest.budgetUsd` may lower
   * the file's ceiling and may never raise it, and the engine enforces the
   * lowered figure by running a bounded *copy* of the parsed workflow. That
   * copy is in memory only. A resume rediscovers the workflow from disk — the
   * file, with its full ceiling — so without this field the lowered ceiling
   * simply evaporated at the first resume, and the plain resume the ask's own
   * refusal text recommends became the raise the wire had just been denied.
   *
   * On the header rather than a line of its own because a journal with no
   * header cannot be resumed by either entry point at all (both read the
   * workflow's name from it), so there is no state in which the cap is missing
   * and the run still continues. Absent for every run started from a terminal.
   */
  readonly budgetCapUsd?: number;
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
  /**
   * A capped excerpt of what the agent had said when the step FAILED.
   *
   * `text` is deliberately empty on a failed step — a failure must not feed
   * the next stage's `{{prev}}` — but the run used to discard the agent's
   * final words along with it, so a step that hit its turn ceiling three
   * tasks into five left no trace of how far it got. The excerpt is the
   * honest middle: the pipe stays clean, and a human reading the journal (or
   * the failure message, which carries the same excerpt) sees where the agent
   * stopped. Absent on every non-failed terminal and when the agent said
   * nothing.
   */
  readonly finalText?: string;
  /**
   * The shape of the agent's last turn, on a FAILED step: what the model
   * emitted (block kinds and sizes, the stop reason), not what it said.
   *
   * `finalText` answers "how far did it get"; this answers "what came back at
   * the end" — the question a step that produced nothing leaves open. A turn
   * that was 69,786 characters of reasoning, no text and no tool call, ending
   * on the words "Now write.", is a different fault from a turn the output
   * limit cut off, and until this field existed telling them apart meant an
   * engineer reading session JSONL by hand. Absent on every non-failed
   * terminal. See {@link LastTurnShape}.
   */
  readonly lastTurn?: LastTurnShape;
  /**
   * What the step's agent spent its turns on, on EVERY terminal — not just a
   * failed one. See {@link StepActivity} for why the succeeded-but-thrashed
   * step is the one worth being able to find later.
   */
  readonly activity?: StepActivity;
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

/** Which of the two run-scope ceilings a budget-ask line names. */
export type BudgetCeilingKind = "usd" | "tokens";

/**
 * The run parked itself at a stage boundary to ask about an approaching
 * ceiling — the STAGE-BOUNDARY BUDGET ASK.
 *
 * A hard ceiling (`budgetUsd:`/`budgetTokens:`) writes `runEnd{failed}` and
 * both resume entry points refuse a failed run permanently, so by the time it
 * fires the operator's only options are an autopsy or a fresh run. This line
 * is the earlier, answerable moment: the run crossed the ask fraction with
 * stages still to go, journalled this durably, and finished `"paused"` — a
 * resumable state. The line carries the numbers (not rendered prose) so both
 * folds re-render the same question from the same facts.
 */
export interface BudgetAskLine {
  readonly kind: "budgetAsk";
  readonly ceiling: BudgetCeilingKind;
  /** The run's cumulative spend at the ask, in the ceiling's own unit. */
  readonly spent: number;
  /** The ceiling in force at the ask (the file's, or an earlier raise's). */
  readonly limit: number;
  /** Stages finished when the ask fired. */
  readonly stagesDone: number;
  readonly stagesTotal: number;
  readonly ts: number;
}

/**
 * A human answered a {@link BudgetAskLine} with a plain resume: an informed
 * "keep going". That ceiling never asks again this run — it will hard-stop
 * exactly as it always did, but now with the operator's consent on record.
 */
export interface BudgetAckLine {
  readonly kind: "budgetAck";
  readonly ceiling: BudgetCeilingKind;
  readonly ts: number;
}

/**
 * A human raised one ceiling *for this run* in answer to a budget ask.
 *
 * Run-scoped on purpose: the engine continues with a bounded copy of the
 * parsed workflow — the file on disk and the shared parsed object are never
 * mutated — and the ask re-arms against the new limit. Written only by the
 * terminal resume path; the wire may never raise a ceiling (see
 * `serve-workflows.ts` and the `@arcturn/server` seam contract).
 */
export interface BudgetRaiseLine {
  readonly kind: "budgetRaise";
  readonly ceiling: BudgetCeilingKind;
  /** The new ceiling, validated above both the old limit and the spend. */
  readonly value: number;
  readonly ts: number;
}

/**
 * A step failed with its retries spent, and the run parked to ask a human —
 * the STEP-FAILURE ASK.
 *
 * The twin of {@link BudgetAskLine}, and for the same reason. A failed step
 * used to write `runEnd{failed}`, which both resume entry points refuse
 * permanently: the survey, the threat model and the ADR that stages 1–4 paid
 * for were still on disk, and the only way back was to buy them again. A step
 * failure is the *most* recoverable stop this engine has — the work is
 * captured to a patch, and the fix is usually one number — so it parks instead
 * and states the question.
 *
 * Durable, because the park only exists if the question does: a
 * `runEnd{paused}` with no recorded ask is a pause nobody can answer. The line
 * carries facts rather than prose, so the resume fold and the status fold
 * re-render one identical question.
 */
export interface StepFailAskLine {
  readonly kind: "stepFailAsk";
  /** The step that failed — a real step id, unlike the budget ask's sentinel. */
  readonly stepId: string;
  /** The `@role` it dispatched to, when it named one. */
  readonly role?: string;
  /** The classified cause, so the reply grammar knows whether `raise` applies. */
  readonly failureKind?: WorkflowFailureKind;
  /** The step's own failure text — the honest cause a human reads, verbatim. */
  readonly cause: string;
  /**
   * Where the lane captured the work this step could not apply, when it
   * captured any (`record.status === "captured"`). The human can apply it by
   * hand instead of paying to reproduce it.
   */
  readonly patchPath?: string;
  /**
   * The turn ceiling that tripped, for a `turn-ceiling` failure — lifted from
   * the cause the lane wrote. It is what a `raise <n>` must exceed, recorded
   * rather than re-parsed on every resume (the same rule
   * {@link BudgetAskLine.limit} follows).
   */
  readonly ceiling?: number;
  /** How many times this step has now been run and failed, across resumes. */
  readonly attempts: number;
  /** The failed step's last turn, when the lane saw one. See {@link StepEndLine.lastTurn}. */
  readonly lastTurn?: LastTurnShape;
  /** What the failed step spent its turns on. See {@link StepActivity}. */
  readonly activity?: StepActivity;
  readonly ts: number;
}

/**
 * A human answered a {@link StepFailAskLine} with `abandon`: end the run
 * `failed`, exactly as it always did.
 *
 * The tombstone is still available — it is just no longer the *default*. The
 * line exists so the fold can tell "the human chose to stop" from "the ask was
 * never answered", which is the difference between a settled run and one still
 * owed a reply.
 */
export interface StepAbandonLine {
  readonly kind: "stepAbandon";
  readonly stepId: string;
  readonly ts: number;
}

/**
 * A human raised a role's turn ceiling *for this run* in answer to a
 * step-failure ask.
 *
 * Run-scoped exactly as {@link BudgetRaiseLine} is: the role file on disk is
 * never touched, so the journal is the only place the grant lives, and a fresh
 * run gets the file's number back. Written only by the terminal resume path;
 * the wire may never raise a ceiling.
 *
 * Keyed by {@link turnRaiseKey} on the fold — the ROLE when the step named
 * one, so a second step dispatching the same role inherits the rope the human
 * granted it, and the step itself otherwise.
 */
export interface TurnRaiseLine {
  readonly kind: "turnRaise";
  readonly stepId: string;
  readonly role?: string;
  /** The new ceiling, validated above the one that just tripped. */
  readonly value: number;
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
  | BudgetAskLine
  | BudgetAckLine
  | BudgetRaiseLine
  | StepFailAskLine
  | StepAbandonLine
  | TurnRaiseLine
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
  // The budget-ask trio is durable for the same reason `stepEnd` is: each one
  // is a commitment a later resume acts on. An ask that never reached disk is
  // a pause with no question (unanswerable); an ack or raise that vanished
  // would re-ask a question the human already answered — or worse, run under a
  // ceiling the human never granted. The step-failure trio is the same
  // commitment about the same kind of question, so it keeps the same promise.
  [
    "stepIntent",
    "stepEffect",
    "stepEnd",
    "budgetAsk",
    "budgetAck",
    "budgetRaise",
    "stepFailAsk",
    "stepAbandon",
    "turnRaise",
  ],
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

/**
 * The synthetic step id a budget-ask pause is keyed under.
 *
 * The pause machinery is step-keyed end to end (`WorkflowPause.stepId`, the
 * status fold's pending map, the resume command's wording), and the budget ask
 * is a *run*-level question with no step behind it — so it borrows a sentinel
 * id that no real step can collide with: parsed step ids are always numeric
 * (`"3"`, `"4.2"`).
 */
export const BUDGET_ASK_STEP_ID = "budget";

/**
 * The one affirmative reply that answers a stage-boundary budget ask "keep
 * going".
 *
 * A *word*, not an empty resume, and that is the whole point: the ack is
 * written to the journal as the operator's consent on record, and an empty
 * gesture is not consent. A client script that routinely nudges stalled runs,
 * or a resume of a run that crashed after the ask was journalled but before
 * anybody ever saw it, must not be able to mint that record. Compare the
 * role-pause gate, which refuses a bare resume with "an answer, not a nudge" —
 * the budget ask now holds the same line.
 *
 * Named here because {@link budgetAskQuestion} is the text that tells the
 * operator to send it; the grammar that recognises it (and its `raise`
 * sibling) lives with the engine in `workflow.ts`.
 */
export const BUDGET_ACK_ANSWER = "continue";

/** What a caller may do about a budget ask, for the renderers below. */
export interface BudgetAskAudience {
  /**
   * Whether this origin may raise a ceiling at all. The interactive terminal
   * may; the wire may not (`@arcturn/server`'s workflow seam: nothing on the
   * wire raises a ceiling), so a question rendered for a wire client must not
   * advertise a reply that client will only ever be refused for sending.
   * Defaults to `true` — the terminal is the origin with full authority.
   */
  readonly allowRaise?: boolean;
}

/**
 * The recorded facts of one ask, validated out of a {@link BudgetAskLine}.
 *
 * `readJournalLines` promises only that a line parsed as an object with a
 * string `kind`: every numeric field below may be missing, `null` or a string
 * on a line a crash tore in half. Both folds run over that data, and both of
 * them used to hand it straight to {@link budgetAskQuestion} — where one
 * `undefined.toFixed(2)` threw out of `foldJournal`, past `readWorkflowRuns`'s
 * un-guarded `Promise.all`, and took `/workflow status` down for every run on
 * the machine. So the shape is checked once, here, and a line that fails the
 * check is *dropped*: an ask nobody can restate is not an ask.
 *
 * @param line - A candidate `budgetAsk` line, straight off disk.
 * @returns The ask's facts, or `undefined` when the line is not usable.
 */
export function budgetAskFacts(line: BudgetAskLine): PendingBudgetAsk | undefined {
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (line.ceiling !== "usd" && line.ceiling !== "tokens") return undefined;
  // A zero or negative limit is not a ceiling anyone is nearing, and it is the
  // divisor of the percentage the question renders.
  if (!positive(line.limit) || !count(line.spent)) return undefined;
  if (!count(line.stagesDone) || !count(line.stagesTotal)) return undefined;
  return {
    ceiling: line.ceiling,
    spent: line.spent,
    limit: line.limit,
    stagesDone: line.stagesDone,
    stagesTotal: line.stagesTotal,
  };
}

/**
 * Render the question a stage-boundary budget ask puts to the human.
 *
 * One renderer, exported, because two independent folds surface the same ask —
 * {@link buildResumeState} for resume and `workflow-status.ts`'s `foldJournal`
 * for `/workflow status` — and the {@link BudgetAskLine} deliberately carries
 * numbers rather than prose. Two renderers would be two questions for one ask.
 *
 * The *answer options* half of the text is rendered per origin rather than
 * fixed: this string travels verbatim over the wire, and a wire client told to
 * `raise` would follow the instruction into a refusal, forever. Same renderer,
 * one sentence chosen by what the reader may actually do.
 *
 * @param ask - The recorded ask facts (a {@link BudgetAskLine} or its fold).
 * @param audience - What the origin reading this may do about it.
 */
export function budgetAskQuestion(ask: PendingBudgetAsk, audience: BudgetAskAudience = {}): string {
  // Not `contextPercent`: that helper is named for a model's context window
  // and clamps at 100%, and a spend the ceiling already passed must read as
  // the >100% it is rather than as "exactly full".
  const pct = ask.limit > 0 ? Math.round((ask.spent / ask.limit) * 100) : 0;
  const remaining = Math.max(0, ask.stagesTotal - ask.stagesDone);
  const consumed =
    ask.ceiling === "usd"
      ? // `formatCost`, not `toFixed(2)`: a sub-cent spend rendered "$0.00"
        // reads as "this was free", which is the one answer certainly wrong.
        `spent ${formatCost(ask.spent)} of its ${formatCost(ask.limit)} run budget`
      : `consumed ${Math.round(ask.spent).toLocaleString("en-US")} of its ` +
        `${Math.round(ask.limit).toLocaleString("en-US")}-token run budget`;
  // The wire's sentence is the terser of the two on purpose: a question
  // crossing the seam is capped by `sanitizeDescription` before a client sees
  // it, and the half that says what THIS reader may do must survive the cap.
  const options =
    audience.allowRaise === false
      ? `Reply "${BUDGET_ACK_ANSWER}" to run on; the wire cannot raise a ceiling.`
      : `Reply "${BUDGET_ACK_ANSWER}" to run on to the hard stop, or ` +
        '"raise <new-limit>" to lift the ceiling for this run only.';
  return (
    `This run has ${consumed} (${pct}%), with ${remaining} of ${ask.stagesTotal} stage(s) ` +
    `still to go. ${options}`
  );
}

/**
 * The `/workflow resume …` hint that goes under a parked run.
 *
 * Exported and shared because `/workflow status` prints it in two places (the
 * table row and the detail view) and the two copies had already drifted in
 * capitalisation — the first sign that they would drift in *content* next, and
 * a budget checkpoint's valid replies are exactly the thing an operator must
 * not be told two versions of.
 *
 * @param runId - The parked run.
 * @param audience - What the origin reading this may do about it.
 */
export function budgetAskResumeHint(runId: string, audience: BudgetAskAudience = {}): string {
  const ack = `/workflow resume ${runId} ${BUDGET_ACK_ANSWER}`;
  return audience.allowRaise === false
    ? `${ack} runs on to the hard stop; raising the ceiling is terminal-only`
    : `${ack} runs on to the hard stop, /workflow resume ${runId} raise <new-limit> lifts it`;
}

/**
 * The reply that re-runs a step parked by a {@link StepFailAskLine}.
 *
 * A *word*, for the same reason {@link BUDGET_ACK_ANSWER} is one: every retry
 * is money, and an empty resume is not a decision to spend it. A client script
 * that nudges stalled runs, or a resume of a run that crashed after the ask
 * reached disk but before anybody read it, must not be able to buy a rerun.
 */
export const STEP_RETRY_ANSWER = "retry";

/**
 * The reply that ends a parked run `failed` — today's behaviour, now chosen
 * rather than imposed.
 *
 * Named beside {@link STEP_RETRY_ANSWER} because the two are rendered as one
 * sentence and must never drift apart.
 */
export const STEP_ABANDON_ANSWER = "abandon";

/** A pending step-failure ask, rebuilt from the journal. */
export interface PendingStepFailAsk {
  readonly stepId: string;
  readonly role?: string;
  readonly failureKind?: WorkflowFailureKind;
  readonly cause: string;
  readonly patchPath?: string;
  readonly ceiling?: number;
  readonly attempts: number;
  /** What the failed step's model emitted on its last turn, when recorded. */
  readonly lastTurn?: LastTurnShape;
  /** What the failed step spent its turns on, when recorded. */
  readonly activity?: StepActivity;
}

/* ------------------------------------------------------------------ *
 * The last turn's shape
 * ------------------------------------------------------------------ */

/** One block of an assistant turn, reduced to its kind and its size. */
export interface TurnBlockShape {
  readonly type: "text" | "thinking" | "toolCall";
  /** Characters of text or reasoning; for a tool call, of its serialized arguments. */
  readonly chars: number;
  /** The tool a `toolCall` block named. */
  readonly name?: string;
}

/**
 * What a model emitted on one turn — the diagnosis a parked step owes the
 * person who has to decide what to do about it.
 *
 * Deliberately a *shape*, not a transcript: block kinds, sizes, the stop
 * reason, and — only when the turn delivered nothing visible — the tail of
 * its reasoning. That last field is the one that turns "step 3 produced
 * nothing" into "the model reasoned for 70,000 characters, wrote 'Now write.'
 * and stopped", and it is captured only in that case so the journal does not
 * routinely carry reasoning.
 */
export interface LastTurnShape {
  /** The catalog id the turn ran on — the first thing to check when a step goes quiet. */
  readonly model: string;
  /** The provider's stop reason, verbatim (`endTurn`, `maxTokens`, …). */
  readonly stopReason: string;
  readonly blocks: readonly TurnBlockShape[];
  /**
   * The last ~{@link REASONING_TAIL_CHARS} characters of the turn's reasoning,
   * present only when the turn had reasoning and nothing else.
   */
  readonly reasoningTail?: string;
}

/** How much reasoning a silent turn's shape keeps — enough for its last sentence or two. */
export const REASONING_TAIL_CHARS = 160;

/**
 * Token shapes a reasoning tail must never carry into a journal or a CI log.
 * A step that read a `.env` and then went quiet could, in principle, end its
 * reasoning on the key it just read; the tail is short, but short is not the
 * same as safe. Matched shapes are replaced, not the whole tail dropped, so
 * the sentence around them still explains the silence.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
  /:\/\/[^\s/:@]+:[^\s@]+@/g,
];

/** Replace credential-shaped substrings in a reasoning tail. */
export function scrubReasoningTail(tail: string): string {
  let out = tail;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

/** Cap a tail to its last {@link REASONING_TAIL_CHARS} characters, marking the cut. */
function capTail(reasoning: string): string {
  return reasoning.length <= REASONING_TAIL_CHARS
    ? reasoning
    : `…${reasoning.slice(-REASONING_TAIL_CHARS)}`;
}

/**
 * Whether a shape shows a turn that delivered nothing: no tool call and no
 * text characters. The journal-side twin of the loop's own check, for a step
 * whose *earlier* turns spoke but whose last did not.
 */
export function lastTurnDeliveredNothing(shape: LastTurnShape): boolean {
  return !shape.blocks.some(
    (block) => block.type === "toolCall" || (block.type === "text" && block.chars > 0),
  );
}

/** Whether a turn carried anything a caller could act on: non-blank text or a tool call. */
function deliveredSomething(message: AssistantMessage): boolean {
  return message.content.some(
    (block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
  );
}

/**
 * Reduce an assistant message to its {@link LastTurnShape}.
 *
 * @param message - The turn, as the agent loop delivered it.
 */
export function turnShapeOf(message: AssistantMessage): LastTurnShape {
  const blocks: TurnBlockShape[] = message.content.map((block) => {
    // Trimmed: a whitespace-only text block is size, not substance, and every
    // reader of this shape asks "did it say anything", not "how many bytes".
    if (block.type === "text") return { type: "text", chars: block.text.trim().length };
    if (block.type === "thinking") return { type: "thinking", chars: block.thinking.length };
    return {
      type: "toolCall",
      chars: JSON.stringify(block.arguments ?? {}).length,
      name: block.name,
    };
  });
  let reasoningTail: string | undefined;
  if (!deliveredSomething(message)) {
    const reasoning = message.content
      .map((block) => (block.type === "thinking" ? block.thinking : ""))
      .join("")
      .trim();
    if (reasoning !== "") reasoningTail = capTail(scrubReasoningTail(reasoning));
  }
  return {
    model: message.model,
    stopReason: message.stopReason,
    blocks,
    ...(reasoningTail === undefined ? {} : { reasoningTail }),
  };
}

/**
 * Validate a {@link LastTurnShape} that came off disk.
 *
 * Same tolerance rule as every other fact folded out of the journal: a field
 * that is not the shape it claims to be is dropped, never coerced, and a
 * shape with no usable model, stop reason or block list is no shape at all.
 */
export function lastTurnFacts(value: unknown): LastTurnShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== "string" || raw.model === "") return undefined;
  if (typeof raw.stopReason !== "string" || raw.stopReason === "") return undefined;
  if (!Array.isArray(raw.blocks)) return undefined;
  const blocks: TurnBlockShape[] = [];
  for (const entry of raw.blocks) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const block = entry as Record<string, unknown>;
    if (block.type !== "text" && block.type !== "thinking" && block.type !== "toolCall") {
      return undefined;
    }
    if (typeof block.chars !== "number" || !Number.isFinite(block.chars) || block.chars < 0) {
      return undefined;
    }
    blocks.push({
      type: block.type,
      chars: Math.floor(block.chars),
      ...(typeof block.name === "string" && block.name !== "" ? { name: block.name } : {}),
    });
  }
  // Re-capped and re-scrubbed on the way in: a line written by an older
  // build, or edited by hand, does not get to be longer or rawer than one
  // this build would write.
  const tail =
    typeof raw.reasoningTail === "string"
      ? capTail(scrubReasoningTail(raw.reasoningTail.trim()))
      : "";
  return {
    model: raw.model,
    stopReason: raw.stopReason,
    blocks,
    ...(tail === "" ? {} : { reasoningTail: tail }),
  };
}

/**
 * Render a {@link LastTurnShape} for a human — one line of facts, plus the
 * reasoning tail on a second line when the turn was silent.
 *
 * One renderer, like {@link stepFailAskQuestion}: `/workflow status`, the
 * terminal park notice and the resume restatement all show the same words.
 *
 * @example
 * last turn: zai/glm-5.3-flash · stopped endTurn · thinking 69,786 chars · no text · no tool call
 * reasoning ended: "…Numbers coherent. Compose."
 */
export function describeLastTurn(shape: LastTurnShape): string {
  const sum = (type: TurnBlockShape["type"]): number =>
    shape.blocks.filter((block) => block.type === type).reduce((n, block) => n + block.chars, 0);
  const thinking = sum("thinking");
  const text = sum("text");
  const calls = shape.blocks
    .filter((block) => block.type === "toolCall")
    .map((block) => block.name ?? "?");
  const facts = [
    `last turn: ${shape.model}`,
    `stopped ${shape.stopReason}`,
    thinking > 0 ? `thinking ${thinking.toLocaleString("en-US")} chars` : "no thinking",
    text > 0 ? `text ${text.toLocaleString("en-US")} chars` : "no text",
    calls.length > 0 ? `tool calls: ${calls.join(", ")}` : "no tool call",
  ];
  const head = facts.join(" · ");
  if (shape.reasoningTail === undefined) return head;
  return `${head}\nreasoning ended: ${JSON.stringify(shape.reasoningTail)}`;
}

/* ------------------------------------------------------------------ *
 * What the step actually DID
 * ------------------------------------------------------------------ */

/**
 * What a step's agent spent its turns on — counts and tool names, nothing else.
 *
 * The fact that was missing when a write-lane builder burned all eighty of its
 * turns reading. The park said "hit its 80-turn ceiling", which is true and
 * useless; "80 turns · bash 77 · read 17 · no file written" is the same event
 * with the diagnosis attached, and it is the difference between "re-run it with
 * more rope" and "this role never started writing".
 *
 * Recorded on EVERY step, not only failed ones: it costs a few integers, and a
 * succeeded-but-thrashed step is exactly the one a retrospective wants to find
 * before it becomes a failure. Deliberately counts only — a tool NAME and how
 * many times it was called. No arguments, no paths, no output.
 */
export interface StepActivity {
  /** Turns the child agent completed. */
  readonly turns: number;
  /** How many times each tool was called, by tool name. */
  readonly toolCalls: Readonly<Record<string, number>>;
  /** Calls to a tool that authors files (`write`, `edit`, `multiedit`). */
  readonly writes: number;
}

/** Tools whose call means a file was authored. Mirrors `workflow.ts`'s `WRITE_TOOLS`. */
const AUTHORING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multiedit"]);

/**
 * How many of a tool-call tally were authoring calls.
 *
 * One helper so the activity record and the write-lane progress check can never
 * disagree about what "wrote something" means.
 *
 * @param toolCalls - Call counts by tool name.
 */
export function countWrites(toolCalls: Readonly<Record<string, number>>): number {
  let writes = 0;
  for (const [name, count] of Object.entries(toolCalls)) {
    if (AUTHORING_TOOLS.has(name)) writes += count;
  }
  return writes;
}

/** How many distinct tools {@link describeActivity} names before it summarises. */
const ACTIVITY_TOOLS_SHOWN = 6;

/**
 * Validate a {@link StepActivity} that came off disk.
 *
 * Same tolerance rule as {@link lastTurnFacts}: a field that is not the shape it
 * claims to be is dropped rather than coerced, and a record with no usable turn
 * count is no record at all. `writes` is *recomputed* from the tally rather than
 * trusted, so a hand-edited line cannot claim files it never wrote.
 *
 * @param value - A candidate activity record, straight off disk.
 */
export function activityFacts(value: unknown): StepActivity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.turns !== "number" || !Number.isFinite(raw.turns) || raw.turns < 0) {
    return undefined;
  }
  const toolCalls: Record<string, number> = {};
  if (typeof raw.toolCalls === "object" && raw.toolCalls !== null) {
    for (const [name, count] of Object.entries(raw.toolCalls as Record<string, unknown>)) {
      if (name === "") continue;
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
      toolCalls[name] = Math.floor(count);
    }
  }
  return { turns: Math.floor(raw.turns), toolCalls, writes: countWrites(toolCalls) };
}

/**
 * Render a {@link StepActivity} for a human — one line of counts.
 *
 * Tools are ordered by call count (ties by name, so the line is stable), the
 * busiest {@link ACTIVITY_TOOLS_SHOWN} are named and the rest are summarised.
 * The write count is spelled out rather than omitted when it is zero: "no file
 * written" is the whole point of the line on a write-lane step.
 *
 * @example
 * activity: 80 turns · bash 77 · read 17 · grep 1 · no file written
 *
 * @param activity - The step's recorded counts.
 */
export function describeActivity(activity: StepActivity): string {
  const ranked = Object.entries(activity.toolCalls)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, ACTIVITY_TOOLS_SHOWN).map(([name, count]) => `${name} ${count}`);
  const hidden = ranked.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);
  const calls = shown.length > 0 ? shown : ["no tool call"];
  const writes =
    activity.writes === 0
      ? "no file written"
      : `${activity.writes} write${activity.writes === 1 ? "" : "s"}`;
  return [
    `activity: ${activity.turns} turn${activity.turns === 1 ? "" : "s"}`,
    ...calls,
    writes,
  ].join(" · ");
}

/**
 * A human's reply to a pending step-failure ask, threaded in by a resume path.
 *
 * Whether the origin may *raise* a turn ceiling is not on here — that is a
 * property of the run's origin, not of one sentence, and it also decides how
 * the question is worded. It lives on `WorkflowRunContext.allowBudgetRaise`,
 * the one flag both raise gates read.
 */
export interface StepFailReply {
  /** The verbatim reply; `""` is a plain resume, which answers nothing. */
  readonly text: string;
}

/**
 * The key a run-scoped turn raise is stored under.
 *
 * The ROLE when the step named one: a human who granted `@rag-builder` 120
 * turns at stage 5 has said something about the role, and a later stage
 * dispatching the same role would otherwise walk into the same 64-turn wall
 * and park again for the same answer. A step with no role is keyed by itself,
 * because there is nothing else to key it by.
 *
 * @param stepId - The step the ask named.
 * @param role - Its `@role`, when it had one.
 */
export function turnRaiseKey(stepId: string, role?: string): string {
  return role === undefined || role === "" ? `step:${stepId}` : `role:${role}`;
}

/**
 * The recorded facts of one step-failure ask, validated out of a
 * {@link StepFailAskLine}.
 *
 * Exactly {@link budgetAskFacts}' contract and for exactly its reason:
 * `readJournalLines` promises only an object with a string `kind`, both folds
 * run over that data, and a torn line that reached a renderer once took
 * `/workflow status` down for every run on the machine. A line that fails the
 * check is *dropped* — an ask nobody can restate is not an ask.
 *
 * @param line - A candidate `stepFailAsk` line, straight off disk.
 * @returns The ask's facts, or `undefined` when the line is not usable.
 */
export function stepFailAskFacts(line: StepFailAskLine): PendingStepFailAsk | undefined {
  // A pause with no step to retry, or no cause to state, is unanswerable.
  if (typeof line.stepId !== "string" || line.stepId === "") return undefined;
  if (typeof line.cause !== "string" || line.cause.trim() === "") return undefined;
  const attempts =
    typeof line.attempts === "number" && Number.isFinite(line.attempts) && line.attempts > 0
      ? Math.floor(line.attempts)
      : 1;
  const ceiling =
    typeof line.ceiling === "number" && Number.isFinite(line.ceiling) && line.ceiling > 0
      ? line.ceiling
      : undefined;
  const lastTurn = lastTurnFacts(line.lastTurn);
  const activity = activityFacts(line.activity);
  return {
    stepId: line.stepId,
    ...(typeof line.role === "string" && line.role !== "" ? { role: line.role } : {}),
    ...(typeof line.failureKind === "string"
      ? { failureKind: line.failureKind as WorkflowFailureKind }
      : {}),
    cause: line.cause,
    ...(typeof line.patchPath === "string" && line.patchPath !== ""
      ? { patchPath: line.patchPath }
      : {}),
    ...(ceiling === undefined ? {} : { ceiling }),
    attempts,
    ...(lastTurn === undefined ? {} : { lastTurn }),
    ...(activity === undefined ? {} : { activity }),
  };
}

/**
 * How much of a failed step's cause the park question restates.
 *
 * The cause carries the agent's preserved final words, which are already
 * capped at 500 characters of their own — enough to make a question nobody
 * finishes reading. The full text is on the step's `error` and on its durable
 * `stepEnd` line either way.
 */
const CAUSE_MAX_CHARS = 400;

/**
 * How much of a role name the wire's terse park question spends.
 *
 * See {@link stepFailAskQuestion}: that string is capped at 160 characters by
 * `sanitizeDescription` before a client sees it, and a long role name would
 * otherwise eat the half that tells the reader what they may reply.
 */
const WIRE_ROLE_MAX_CHARS = 20;

/**
 * Render the question a step-failure park puts to the human.
 *
 * One renderer, exported, for the reason {@link budgetAskQuestion} is one: two
 * independent folds surface the same ask ({@link buildResumeState} for resume,
 * `workflow-status.ts` for `/workflow status`), and the line carries facts
 * rather than prose. Two renderers would be two questions for one ask.
 *
 * The *answer options* half is rendered per origin, again like the budget
 * ask's: `raise` is terminal-only, and a wire client told to send it would
 * follow its own question into a refusal forever.
 *
 * THE ALERT THIS IS. A turn ceiling had no human-facing warning at all — the
 * wrap-up note goes to the model, and the model ignored it — so when the
 * ceiling is what stopped the step, this sentence says so in those words and
 * names `raise <n>` as the lever. That is the alert the operator never got.
 *
 * @param ask - The recorded ask facts.
 * @param audience - What the origin reading this may do about it.
 */
export function stepFailAskQuestion(
  ask: PendingStepFailAsk,
  audience: BudgetAskAudience = {},
): string {
  const named = (role: string | undefined): string =>
    role === undefined || role === "" ? `Step ${ask.stepId}` : `Step ${ask.stepId} (@${role})`;
  const who = named(ask.role);
  const turnCeiling = ask.failureKind === "turn-ceiling";
  const stopped = turnCeiling ? "ran out of turns" : "failed";
  // The wire's sentence is the terser of the two, exactly as the budget ask's
  // is and for exactly its reason: a question crossing the seam is capped by
  // `sanitizeDescription` (first line, 160 characters), and the half that says
  // what THIS reader may do must survive the cap. So the role name is bounded
  // here too — an org is free to call a role
  // `security-threat-modeller-v2`, and paying for that in the reply options is
  // the one trade this sentence must not make. The cause itself is not lost:
  // it reaches a wire client as the `Step N failed: …` notice
  // `reportWorkflowEvent` publishes onto the session stream.
  if (audience.allowRaise === false) {
    const short =
      ask.role !== undefined && ask.role.length > WIRE_ROLE_MAX_CHARS
        ? `${ask.role.slice(0, WIRE_ROLE_MAX_CHARS - 1)}…`
        : ask.role;
    return (
      `${named(short)} ${stopped}; the run is parked. Reply "${STEP_RETRY_ANSWER}" to rerun it ` +
      `or "${STEP_ABANDON_ANSWER}" to end it` +
      (turnCeiling ? "; the wire cannot raise a turn ceiling." : ".")
    );
  }
  const tries = ask.attempts === 1 ? "" : ` after ${String(ask.attempts)} attempts`;
  const headline = turnCeiling
    ? `${who} ran out of turns${tries} — it hit a turn ceiling, it did not crash.`
    : `${who} failed${tries}.`;
  // The cause is the lane's own honest text and is MULTI-LINE by construction:
  // a failed step's message carries the agent's preserved final words on a
  // second line. Flattening it with a blind `\s+ → " "` ran two sentences
  // together ("…narrow the step Its final words before the stop: …"), so each
  // line is closed off before the join. Bounded, too — the whole thing is on
  // the step's own `error` and on the durable `stepEnd`, and a question is
  // read, not archived.
  const sentence = oneLine(
    ask.cause
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
      .join(" "),
    CAUSE_MAX_CHARS,
  );
  const captured =
    ask.patchPath === undefined
      ? ""
      : ` Its unapplied work was captured to ${ask.patchPath}, so the partial result is not lost.`;
  const raiseTo = ask.ceiling === undefined ? "" : ` (above ${String(ask.ceiling)})`;
  const options = turnCeiling
    ? `Reply "${STEP_RETRY_ANSWER}" to run this step again, "raise <n>"${raiseTo} to lift its ` +
      `turn ceiling for this run only and retry, or "${STEP_ABANDON_ANSWER}" to end the run failed.`
    : `Reply "${STEP_RETRY_ANSWER}" to run this step again, or "${STEP_ABANDON_ANSWER}" to end ` +
      "the run failed.";
  return (
    `${headline} This run is parked, not finished: every earlier stage is on disk and is ` +
    `reused, not paid for again. ${sentence}${captured} ${options}`
  );
}

/**
 * The `/workflow resume …` hint that goes under a run parked at a failed step.
 *
 * Shared for the reason {@link budgetAskResumeHint} is shared: `/workflow
 * status` prints it in two places, and a parked run's valid replies are
 * exactly the thing an operator must not be told two versions of.
 *
 * @param runId - The parked run.
 * @param ask - The recorded ask, so the hint offers `raise` only where it applies.
 * @param audience - What the origin reading this may do about it.
 */
export function stepFailAskResumeHint(
  runId: string,
  ask: PendingStepFailAsk,
  audience: BudgetAskAudience = {},
): string {
  const base =
    `/workflow resume ${runId} ${STEP_RETRY_ANSWER} runs the step again, ` +
    `/workflow resume ${runId} ${STEP_ABANDON_ANSWER} ends the run failed`;
  if (ask.failureKind !== "turn-ceiling") return base;
  return audience.allowRaise === false
    ? `${base}; raising a turn ceiling is terminal-only`
    : `${base}, /workflow resume ${runId} raise <n> lifts its turn ceiling for this run and retries`;
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
  /**
   * The stage-boundary budget ask the run parked on, when one is pending —
   * the latest {@link BudgetAskLine} with no later ack or raise for its
   * ceiling. A run holding one of these is `paused` for a *run*-level
   * question, not a step's; the engine (never a command parser) interprets
   * {@link budgetAnswer} against it on resume.
   */
  readonly budgetAsk?: PendingBudgetAsk;
  /**
   * Ceilings a human already answered `continue` to. Each one is ask-once: the
   * engine never re-asks about it this run, and the hard stop fires exactly as
   * it always did.
   */
  readonly budgetAcks?: ReadonlySet<BudgetCeilingKind>;
  /**
   * Run-scoped ceiling raises, latest per ceiling. A resumed `runWorkflow`
   * prefers these over the workflow file's frontmatter from the very start of
   * the run — the file itself was never touched, so the journal is the only
   * place the granted ceiling lives.
   */
  readonly budgetRaises?: ReadonlyMap<BudgetCeilingKind, number>;
  /**
   * The dollar cap the run's starter bound it to, from the journal's own
   * header ({@link RunHeaderLine.budgetCapUsd}) — present only for a run
   * started over the wire with a `budgetUsd` of its own.
   *
   * A resumed run enforces `min(file ceiling, this)`, and no raise may lift a
   * ceiling past it: the wire's "may lower, never raise" contract binds the
   * run, not just the request that started it.
   */
  readonly budgetCapUsd?: number;
  /**
   * The human's reply to the pending {@link budgetAsk}, supplied by the
   * resume flow — never read from the journal (the same rule as
   * {@link answer}).
   *
   * `""` is a plain resume, and a plain resume is NOT an answer: it re-surfaces
   * the question. Only the explicit {@link BUDGET_ACK_ANSWER} acknowledges.
   */
  readonly budgetAnswer?: BudgetAskReply;
  /**
   * The step-failure ask the run parked on, when one is pending — the latest
   * {@link StepFailAskLine} with no later terminal for its step and no
   * `stepAbandon`. A run holding one is `paused` on a *recoverable* stop: the
   * step failed, nothing after it ran, and a person decides whether to spend
   * again. The engine (never a command parser) interprets
   * {@link stepFailAnswer} against it on resume.
   */
  readonly stepFailAsk?: PendingStepFailAsk;
  /**
   * Run-scoped turn-ceiling grants, latest per {@link turnRaiseKey}. A resumed
   * `runWorkflow` prefers these over the role file's own `maxTurns:` — and
   * over the session's `subagentMaxTurns` clamp — from the very start of the
   * run, because neither file was touched and the journal is the only place
   * the grant lives.
   */
  readonly turnRaises?: ReadonlyMap<string, number>;
  /**
   * The human's reply to the pending {@link stepFailAsk}, supplied by the
   * resume flow — never read from the journal (the same rule as
   * {@link answer} and {@link budgetAnswer}).
   *
   * `""` is a plain resume, and a plain resume is NOT an answer: it
   * re-surfaces the question and spends nothing.
   */
  readonly stepFailAnswer?: StepFailReply;
}

/** A pending stage-boundary budget ask, rebuilt from the journal. */
export interface PendingBudgetAsk {
  readonly ceiling: BudgetCeilingKind;
  readonly spent: number;
  readonly limit: number;
  readonly stagesDone: number;
  readonly stagesTotal: number;
}

/**
 * A human's reply to a pending budget ask, threaded in by a resume path.
 *
 * Whether the reply's origin may *raise* a ceiling is not on here: that is a
 * property of the run's origin, not of one sentence, and it also decides how
 * the question itself is worded — so it lives on
 * `WorkflowRunContext.allowBudgetRaise`, one flag read by both.
 */
export interface BudgetAskReply {
  /** The verbatim reply; `""` is a plain resume, which answers nothing. */
  readonly text: string;
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
  // The budget-ask gate's fold: an ask is pending until a later ack or raise
  // for its ceiling settles it (a raise re-arms the ask, so a *later* ask for
  // the same ceiling can pend again — append order decides).
  let budgetAsk: PendingBudgetAsk | undefined;
  const budgetAcks = new Set<BudgetCeilingKind>();
  const budgetRaises = new Map<BudgetCeilingKind, number>();
  let budgetCapUsd: number | undefined;
  // The step-failure gate's fold, the budget gate's twin: an ask is pending
  // until the step it names produces a fresh terminal (the retry ran) or a
  // `stepAbandon` settles it. A `turnRaise` deliberately does NOT settle it —
  // a crash between the grant and the retry must re-ask rather than spend on
  // a gesture nobody made twice.
  let stepFailAsk: PendingStepFailAsk | undefined;
  const turnRaises = new Map<string, number>();

  for (const line of lines) {
    switch (line.kind) {
      case "run":
        runId = line.runId;
        source = line.source;
        workflow = line.workflow;
        startedAt = line.startedAt;
        // Same tolerance rule as every other field folded off disk: a cap that
        // is not a usable positive number is no cap, not a ceiling of `NaN`.
        if (typeof line.budgetCapUsd === "number" && line.budgetCapUsd > 0) {
          budgetCapUsd = line.budgetCapUsd;
        }
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
        // A fresh terminal for the asked step is the retry landing (or the
        // failure that a NEW ask is about to be appended for, below). Either
        // way the previous ask is answered and gone.
        if (stepFailAsk?.stepId === line.id) stepFailAsk = undefined;
        break;
      case "budgetAsk": {
        // A torn line is dropped rather than folded (see `budgetAskFacts`) —
        // and it does not disturb whatever ask was already pending.
        const facts = budgetAskFacts(line);
        if (facts !== undefined) budgetAsk = facts;
        break;
      }
      case "budgetAck":
        budgetAcks.add(line.ceiling);
        if (budgetAsk?.ceiling === line.ceiling) budgetAsk = undefined;
        break;
      case "budgetRaise":
        budgetRaises.set(line.ceiling, line.value);
        if (budgetAsk?.ceiling === line.ceiling) budgetAsk = undefined;
        break;
      case "stepFailAsk": {
        // A torn line is dropped rather than folded (see `stepFailAskFacts`),
        // and it does not disturb whatever ask was already pending.
        const facts = stepFailAskFacts(line);
        if (facts !== undefined) stepFailAsk = facts;
        break;
      }
      case "stepAbandon":
        if (stepFailAsk?.stepId === line.stepId) stepFailAsk = undefined;
        break;
      case "turnRaise":
        // Same tolerance rule as every other number folded off disk: a grant
        // that is not a usable positive count is no grant, not a ceiling of
        // `NaN` handed to a child agent.
        if (typeof line.value === "number" && Number.isFinite(line.value) && line.value > 0) {
          turnRaises.set(turnRaiseKey(line.stepId, line.role), Math.floor(line.value));
        }
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
    // Absent-when-empty, so a hand-built resume state (every host and test
    // that constructs one) stays valid without naming fields it has no use for.
    ...(budgetAsk === undefined ? {} : { budgetAsk }),
    ...(budgetAcks.size === 0 ? {} : { budgetAcks }),
    ...(budgetRaises.size === 0 ? {} : { budgetRaises }),
    ...(budgetCapUsd === undefined ? {} : { budgetCapUsd }),
    ...(stepFailAsk === undefined ? {} : { stepFailAsk }),
    ...(turnRaises.size === 0 ? {} : { turnRaises }),
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
 * deadline; `git-lock` from a git index-lock collision; `turn-ceiling` is a
 * child agent exhausting its `maxTurns` (recognised via `@arcturn/core`'s
 * `isTurnCeilingError`) — deterministic on purpose: a rerun of the same step
 * under the same ceiling runs out of the same rope, so the fix is the role
 * file's `maxTurns:` or a narrower step, never a retry. The rest label the
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
  | "turn-ceiling"
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
