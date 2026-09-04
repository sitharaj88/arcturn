/**
 * `/workflow fork` — take an existing run's finished work and try the rest of
 * the pipeline a different way.
 *
 * The idea is small and the implementation is deliberately smaller: **a fork
 * is a resume that starts in a new directory.** Nothing here teaches the
 * engine a new mode. It builds a fresh run directory whose journal opens with
 * a header saying where it came from, followed by a verbatim copy of the
 * source run's finished stages, and then hands that directory to the ordinary
 * resume machinery. Every guarantee resume already makes — a copied step is
 * never re-run, its patch is never re-applied, a step whose prompt changed
 * under it is refused — is inherited rather than re-implemented.
 *
 * Three things have to be copied for that to be true, and getting any of them
 * wrong is a silent corruption rather than an error:
 *
 * 1. **The `stepEnd` lines**, which are what `buildResumeState` reads. Only
 *    the latest terminal per step, exactly as the fold would.
 * 2. **The patch files those lines point at**, into the new run's own
 *    directory, with `record.patchPath` rewritten — because a later stage's
 *    worktree is *seeded* by replaying `appliedPatches`, and a fork whose
 *    records pointed into the source run would break the moment that run was
 *    pruned (`~/.arcturn/workflow-runs` is swept weekly).
 * 3. **The run's frozen baseline and untracked snapshot** (`_run-baseline.patch`,
 *    `_run-untracked/`). These are the pre-run picture of the user's checkout,
 *    and the write lane freezes them once per run *precisely* so a later
 *    process cannot re-read a checkout the run has already changed. A fork
 *    that let its new lane capture a fresh baseline would capture the source
 *    run's own applied patches into it, and then replay those same patches on
 *    top: `git apply` refuses, and every fork of a pipeline whose earlier
 *    stage wrote anything would die at its first worktree.
 *
 * One thing a fork CANNOT inherit, and the reason `--revert` exists: the user's
 * checkout. A fork writes into the same working tree the source run wrote into,
 * so forking a run that *finished* meant re-running a step whose patch was
 * already sitting in those files, and `git apply` refused — correctly. The fix
 * is not to weaken the apply, it is to put the checkout back: `--revert`
 * reverse-applies the source run's patches for every step from `--at` onwards,
 * newest first, before the fork is cut. See {@link createForkRevert}.
 *
 * Two run-scoped grants can ride along: `--model` pins ONE step to another
 * model (a `stepModelOverride` line, folded like a turn raise and honoured by
 * the dispatch seam), and `--raise` grants it a turn ceiling. Both are
 * journal-only — the workflow file and the role file are never touched.
 *
 * @packageDocumentation
 */

import { cp, mkdir, mkdtemp, open as openFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Workflow, WorkflowPatchRecord } from "./workflow.js";
import type { ForkOrigin, JournalLine } from "./workflow-run.js";
import { RUN_JOURNAL_FILE, RUN_JOURNAL_SCHEMA_VERSION, readJournalLines } from "./workflow-run.js";

/** Run-level artifacts a fork must carry over verbatim. See the module doc. */
const FROZEN_RUN_ARTIFACTS: readonly string[] = ["_run-baseline.patch", "_run-untracked"];

/** What `/workflow fork <args>` parsed to. */
export interface ForkArgs {
  readonly runId: string;
  readonly at: string;
  readonly model?: string;
  readonly raise?: number;
  readonly input?: string;
  /**
   * Undo the source run's later work in the checkout before continuing.
   *
   * The flag IS the consent: it names an irreversible act on the user's own
   * files, so there is no second prompt to answer and `arcturn -p` behaves
   * exactly like the interactive session. See {@link createForkRevert}.
   */
  readonly revert?: boolean;
}

/** Usage line, shown for every parse failure so the fix is on screen. */
export const FORK_USAGE =
  "Usage: /workflow fork <runId> --at <stepId> [--revert] [--model <tag>] [--raise <n>] [--input <text>]";

/**
 * Parse the fork verb's arguments.
 *
 * `--input` deliberately swallows the REST of the line: a run's input is prose
 * ("the auth service, staging only"), and quoting rules invented for one flag
 * are a thing a person has to remember. Every other flag takes one token.
 *
 * @param rest - Everything after `fork`.
 * @returns The parsed arguments, or a single-sentence complaint.
 */
export function parseForkArgs(rest: string): ForkArgs | { error: string } {
  const trimmed = rest.trim();
  if (trimmed === "") return { error: FORK_USAGE };
  const tokens = trimmed.split(/\s+/);
  let runId: string | undefined;
  let at: string | undefined;
  let model: string | undefined;
  let raise: number | undefined;
  let input: string | undefined;
  let revert = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "--input") {
      // Everything after the flag, verbatim, including spaces.
      const marker = trimmed.indexOf("--input");
      input = trimmed.slice(marker + "--input".length).trim();
      break;
    }
    if (token === "--revert") {
      revert = true;
      continue;
    }
    if (token === "--at" || token === "--model" || token === "--raise") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `${token} needs a value. ${FORK_USAGE}` };
      }
      if (token === "--at") at = value;
      else if (token === "--model") model = value;
      else {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { error: `--raise needs a positive number of turns, got "${value}".` };
        }
        raise = parsed;
      }
      i += 1;
      continue;
    }
    if (token.startsWith("--")) return { error: `Unknown option "${token}". ${FORK_USAGE}` };
    if (runId === undefined) runId = token;
    else return { error: `Unexpected argument "${token}". ${FORK_USAGE}` };
  }
  if (runId === undefined) return { error: FORK_USAGE };
  if (at === undefined) return { error: `A fork needs --at <stepId>. ${FORK_USAGE}` };
  return {
    runId,
    at,
    ...(model === undefined ? {} : { model }),
    ...(raise === undefined ? {} : { raise }),
    ...(input === undefined ? {} : { input }),
    ...(revert ? { revert: true } : {}),
  };
}

/** What one copied step contributed to the run's pipe, for the staleness check. */
export interface ForkStepFacts {
  readonly text: string;
  readonly record?: WorkflowPatchRecord;
  readonly contract?: Record<string, unknown>;
}

/** What {@link forkWorkflowRun} is asked to do. */
export interface ForkRequest {
  /** `~/.arcturn/workflow-runs`. */
  readonly runsRoot: string;
  /** The run being forked. */
  readonly sourceRunId: string;
  /** The step the fork is cut at — the first one that runs live. */
  readonly at: string;
  /** The new run's id, already minted by the caller. */
  readonly newRunId: string;
  /** The workflow as it is on disk NOW — what the fork will actually run. */
  readonly workflow: Workflow;
  /** A model tag pinned to the `--at` step only. */
  readonly model?: string;
  /** A turn ceiling granted to the `--at` step only. */
  readonly raise?: number;
  /** Replacement run input; the source run's input when absent. */
  readonly input?: string;
  /**
   * Recompute every finished step's prompt hash from the workflow on disk —
   * the engine's own `replayPromptHashes`, injected so this module never
   * imports the driver back.
   */
  readonly promptHashes: (
    recorded: ReadonlyMap<string, ForkStepFacts>,
  ) => ReadonlyMap<string, string>;
  /** Clock injection. */
  readonly now?: () => number;
  /**
   * Undo the source run's later patches in the user's checkout, from `--revert`.
   *
   * Injected rather than performed here for the same reason `promptHashes` is:
   * this module owns the *decision* (which patches, in which order, and whether
   * the fork may proceed at all), and the caller owns the git seam it runs
   * through — the write lane's checkout and its apply queue, so a revert can
   * never interleave with a live run's `git apply` into the same tree. Build
   * one with {@link createForkRevert}.
   *
   * Absent means the human did not pass `--revert`: a source run with applied
   * work at or after `--at` is then REFUSED rather than reverted, because
   * rewinding someone's files is not a thing to do by inference.
   */
  readonly revert?: (plan: ForkRevertPlan) => Promise<ForkRevertResult>;
}

// ------------------------------------------------------------------- reverting

/** One patch the source run applied, and the step that applied it. */
export interface ForkRevertPatch {
  readonly stepId: string;
  /** Absolute path of the patch file, in the SOURCE run's directory. */
  readonly patchPath: string;
}

/**
 * Exactly what a `--revert` fork has to take back out of the checkout.
 *
 * Computed from the source run's journal alone — no git, no filesystem — so the
 * "you need `--revert`" refusal costs nothing and can be made before anything
 * is created.
 */
export interface ForkRevertPlan {
  /** The run whose work is in the checkout. */
  readonly sourceRunId: string;
  /** The step the fork is cut at. */
  readonly at: string;
  /**
   * The patches, NEWEST FIRST — the order they must be reverse-applied in.
   *
   * Applying is a stack: stage 4's patch was cut against a tree that already
   * held stage 3's, so it has to come off first. Reversing in journal order
   * instead would fail on the first patch whose context a later one changed.
   */
  readonly patches: readonly ForkRevertPatch[];
  /** The steps that applied them, in run order (oldest first). */
  readonly steps: readonly string[];
  /** The stage number the checkout returns to. */
  readonly stageBefore: number;
}

/** How a revert settled. */
export type ForkRevertResult =
  | { readonly ok: true; readonly steps: readonly string[]; readonly patches: number }
  | { readonly ok: false; readonly error: string };

/**
 * `steps 3-5`, `step 3` — how a span of reverted steps is named in prose.
 *
 * @param steps - Step ids in run order.
 */
export function formatStepSpan(steps: readonly string[]): string {
  if (steps.length === 0) return "later steps";
  if (steps.length === 1) return `step ${steps[0]}`;
  return `steps ${steps[0]}-${steps[steps.length - 1]}`;
}

/**
 * The refusal a finished run gets when the human did not ask for `--revert`.
 *
 * @param plan - What a revert would have had to undo.
 */
export function forkRevertRefusal(plan: ForkRevertPlan): string {
  return (
    `Run ${plan.sourceRunId} already applied ${formatStepSpan(plan.steps)} into this checkout; ` +
    `add --revert to undo them first, or fork a run that stopped at ${plan.at}.`
  );
}

/** The line printed once a revert has actually happened. */
function forkRevertNotice(plan: ForkRevertPlan): string {
  return (
    `Reverted ${plan.patches.length} patch(es) from ${formatStepSpan(plan.steps)} of ` +
    `${plan.sourceRunId}; the checkout now matches the end of stage ${plan.stageBefore}.`
  );
}

/**
 * Which patches the source run put into the checkout at or after `--at`.
 *
 * Two sources, because a run can leave a patch in the tree two ways:
 *
 * - a `stepEnd` whose `record.status` is `"applied"` — the ordinary case, and
 *   the same fact `buildResumeState` folds into `completed` and the engine
 *   folds into `appliedPatches`;
 * - a `stepEffect` with `applied: true` — the write-ahead barrier's other half,
 *   written the instant `git apply` returned. A run killed between the apply
 *   and its terminal has only this, and a fork that ignored it would re-run a
 *   step whose patch is already in the user's files.
 *
 * Only the LATEST terminal per step counts (a resume appends, so an older line
 * describes a run that has since been superseded), and patch paths are
 * de-duplicated: the effect line and the terminal normally name the same file.
 *
 * @param lines - The source run's journal, in append order.
 * @param laterIds - Every step id at or after the fork point.
 */
function collectAppliedPatches(
  lines: readonly JournalLine[],
  laterIds: ReadonlySet<string>,
): ForkRevertPatch[] {
  const latestTerminal = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.kind === "stepEnd" && laterIds.has(line.id)) latestTerminal.set(line.id, index);
  });
  const seen = new Set<string>();
  const found: ForkRevertPatch[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "stepEnd") {
      if (latestTerminal.get(line.id) !== index) return;
      const record = line.record;
      if (record?.status !== "applied" || record.patchPath === undefined) return;
      if (seen.has(record.patchPath)) return;
      seen.add(record.patchPath);
      found.push({ stepId: line.id, patchPath: record.patchPath });
      return;
    }
    if (line.kind !== "stepEffect") return;
    if (!laterIds.has(line.id) || line.applied !== true) return;
    const path = line.patchPath ?? line.record?.patchPath;
    if (path === undefined || seen.has(path)) return;
    seen.add(path);
    found.push({ stepId: line.id, patchPath: path });
  });
  return found;
}

/**
 * The git seam a revert runs through: the write lane's own checkout and `git`.
 *
 * Structurally identical to the slice of `WriteLane` this needs, so production
 * passes the lane itself and a test passes anything with the two members.
 */
export interface ForkRevertGit {
  /** The user's checkout — the tree being rewound. */
  readonly cwd: string;
  /** One `git` invocation; must REJECT on a non-zero exit. */
  exec(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Is `candidate` inside `root`?
 *
 * Defense in depth for the rehearsal copy below: the paths come from `git
 * apply --numstat`, which never emits a `..` segment, but they are used to
 * read from the user's checkout and write into a scratch directory, so each
 * side gets its own containment check rather than trusting one promise.
 */
function within(candidate: string, root: string): boolean {
  const target = resolve(candidate);
  const base = resolve(root);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** git's own complaint, flattened to one line for a terminal notice. */
function gitBlurb(error: unknown): string {
  const raw =
    (error as { stderr?: string })?.stderr ??
    (error instanceof Error ? error.message : String(error));
  const first = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return first ?? "git failed with no message";
}

/**
 * Every path a patch touches, from `git apply --numstat -z`.
 *
 * `-z` so pathnames arrive verbatim rather than C-quoted: these paths are used
 * to build the dry-run copy below and to ask `git status` about the checkout,
 * and a path that has been through quoting is a path that names nothing.
 */
async function patchPaths(git: ForkRevertGit, patchPath: string): Promise<string[]> {
  let stdout = "";
  try {
    stdout = (await git.exec(git.cwd, ["apply", "--numstat", "-z", "--", patchPath])).stdout;
  } catch {
    // A patch git cannot even parse fails its own dry run below with a far
    // better message than a guess about which files it meant.
    return [];
  }
  const out: string[] = [];
  const chunks = stdout.split("\0");
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk === undefined || chunk === "") continue;
    if (!chunk.includes("\t")) {
      out.push(chunk);
      continue;
    }
    // "<added>\t<deleted>\t<path>" for an ordinary change; a RENAME leaves the
    // record empty after the second tab and puts both paths in the two chunks
    // that follow, and a revert needs to carry both of them.
    const rest = chunk.split("\t").slice(2).join("\t");
    if (rest !== "") {
      out.push(rest);
      continue;
    }
    for (let taken = 0; taken < 2 && i + 1 < chunks.length; taken += 1) {
      i += 1;
      const path = chunks[i];
      if (path !== undefined && path !== "") out.push(path);
    }
  }
  return out;
}

const APPLY_ARGS: readonly string[] = ["apply", "--whitespace=nowarn"];

/**
 * Build the `--revert` executor: take the source run's later patches back out
 * of the user's checkout, or refuse without touching a byte.
 *
 * **The order is a stack.** Stage 4's patch was cut against a tree that already
 * held stage 3's, so stage 4's comes off first. Reversing in journal order
 * fails on the first patch whose context a later one moved.
 *
 * **Why there is a dry run at all, and why it is a real one.** "Refuse before
 * touching anything" cannot be answered by checking each patch against the
 * checkout as it stands: patch 3's reverse only fits a tree patch 4 has already
 * been taken out of, so a per-patch `--check` would refuse forks that are
 * perfectly safe. Nor can one `git apply --check -R p4 p3` answer it — `git
 * apply` validates every patch in an invocation against the working tree it
 * started with and does not chain them, so a series touching one file fails
 * there too (verified against git 2.51). So the sequence is *rehearsed*: the
 * touched files are copied into a scratch directory and the whole reverse
 * series is really applied there, in order. Only if the rehearsal succeeds does
 * the checkout itself get touched. The copy is of the touched files alone, so
 * the cost is the size of what the run wrote and not the size of the repo.
 *
 * **Why a failed rehearsal is attributed the way it is.** The patch that fails
 * in the rehearsal is the one to name, because everything before it succeeded —
 * that is the STEP whose work no longer fits. `git status --porcelain` over the
 * touched paths then decides whether the honest cause is "you have edits there"
 * rather than "the patch is stale"; both are refusals, and the difference is
 * only which sentence a human can act on. Note that a clean rehearsal *is* the
 * proof that those files still hold exactly what the run left in them: a run
 * leaves its own patches uncommitted, so "the tree differs from HEAD" is the
 * normal state after any write-lane run and can never itself be the test.
 *
 * @param options.git - The checkout and its `git`.
 * @param options.serialize - Runs the revert with every other apply into the
 *   same checkout excluded (the engine's own apply queue), so a live run's
 *   `git apply` can never interleave with this one.
 * @param options.print - Where the plan and the outcome are shown.
 */
export function createForkRevert(options: {
  readonly git: ForkRevertGit;
  readonly serialize: <T>(task: () => Promise<T>) => Promise<T>;
  readonly print: (line: string) => void;
}): (plan: ForkRevertPlan) => Promise<ForkRevertResult> {
  const { git, serialize, print } = options;
  return async (plan: ForkRevertPlan): Promise<ForkRevertResult> => {
    if (plan.patches.length === 0) return { ok: true, steps: [], patches: 0 };

    // A missing patch file is its own refusal: git's message for one would be
    // about a path, and the fact worth stating is that the run was pruned.
    for (const patch of plan.patches) {
      try {
        await stat(patch.patchPath);
      } catch {
        return {
          ok: false,
          error:
            `Cannot revert step ${patch.stepId} of run ${plan.sourceRunId}: its patch file is ` +
            `gone (${patch.patchPath}), so what it changed cannot be undone. Nothing was undone.`,
        };
      }
    }

    // DRY RUN, always: the list is on screen before the first byte moves.
    print(
      `Reverting ${plan.patches.length} patch(es) applied by ${plan.sourceRunId} at or after ` +
        `step ${plan.at}, newest first:`,
    );
    for (const patch of plan.patches) {
      print(`  step ${patch.stepId} — ${basename(patch.patchPath)}`);
    }

    const touched = new Set<string>();
    for (const patch of plan.patches) {
      for (const path of await patchPaths(git, patch.patchPath)) touched.add(path);
    }

    /** Which files a human has changed under the revert set, if any. */
    const dirtyFiles = async (): Promise<string[]> => {
      if (touched.size === 0) return [];
      try {
        const { stdout } = await git.exec(git.cwd, ["status", "--porcelain", "--", ...touched]);
        return stdout
          .split("\n")
          .map((line) => line.slice(3).trim())
          .filter((path) => path !== "");
      } catch {
        // No status is not evidence of a clean tree; the caller then reports
        // the step-level refusal, which is true either way.
        return [];
      }
    };

    const refuse = async (
      culprit: ForkRevertPatch,
      complaint: string,
    ): Promise<ForkRevertResult> => {
      const dirty = await dirtyFiles();
      if (dirty.length > 0) {
        return {
          ok: false,
          error:
            `Cannot revert run ${plan.sourceRunId}: the checkout has uncommitted changes in ` +
            `${dirty.join(", ")} that step ${culprit.stepId}'s patch no longer reverses out of ` +
            `(${complaint}). Commit, stash or discard them and fork again; nothing was undone.`,
        };
      }
      return {
        ok: false,
        error:
          `Cannot revert step ${culprit.stepId} of run ${plan.sourceRunId}: git will not take ` +
          `its patch back out (${complaint}). The checkout has moved on since that run; ` +
          "nothing was undone.",
      };
    };

    return await serialize(async () => {
      // THE REHEARSAL. A scratch copy of exactly the files the series touches,
      // outside the checkout, where the whole reverse sequence is really run.
      const scratch = await mkdtemp(join(tmpdir(), "arcturn-fork-revert-"));
      try {
        for (const path of touched) {
          const source = join(git.cwd, path);
          if (!within(source, git.cwd)) continue;
          const dest = join(scratch, path);
          if (!within(dest, scratch)) continue;
          try {
            await mkdir(dirname(dest), { recursive: true });
            await cp(source, dest);
          } catch {
            // Absent in the checkout is a legitimate state — the reverse of a
            // patch that deleted the file expects exactly that.
          }
        }
        for (const patch of plan.patches) {
          try {
            await git.exec(scratch, [...APPLY_ARGS, "-R", "--", patch.patchPath]);
          } catch (error) {
            return await refuse(patch, gitBlurb(error));
          }
        }
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }

      // THE ACT. Same order, same patches, on a tree nothing else can be
      // writing to — the apply queue is held for the whole of this callback.
      const done: ForkRevertPatch[] = [];
      for (const patch of plan.patches) {
        try {
          await git.exec(git.cwd, [...APPLY_ARGS, "-R", "--", patch.patchPath]);
          done.push(patch);
        } catch (error) {
          // The rehearsal passed and this did not, so the checkout changed
          // underneath a held queue. Say exactly how far it got rather than
          // continuing on a guess.
          return {
            ok: false,
            error:
              `Cannot revert run ${plan.sourceRunId}: git refused step ${patch.stepId}'s patch ` +
              `after the dry run accepted it (${gitBlurb(error)}). ` +
              `${done.length} of ${plan.patches.length} patch(es) were already taken back out; ` +
              "inspect the checkout with git status before forking again.",
          };
        }
      }
      print(forkRevertNotice(plan));
      return { ok: true, steps: plan.steps, patches: plan.patches.length };
    });
  };
}

/** How a fork settled. */
export type ForkOutcome =
  | {
      readonly ok: true;
      /** The new run's id. */
      readonly runId: string;
      /** The input the new run will carry. */
      readonly input: string;
      /** Stages copied wholesale from the source run. */
      readonly stages: number;
      /** Steps copied with them. */
      readonly steps: number;
      /** Patch files carried into the new run's directory. */
      readonly patches: number;
      /**
       * What `--revert` took back out of the checkout first, when it did.
       * Absent for a fork of a run that had applied nothing at or after `--at`.
       */
      readonly reverted?: { readonly steps: readonly string[]; readonly patches: number };
      /** Where it came from, as journalled. */
      readonly origin: ForkOrigin;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Cut a fork: build the new run's directory and journal, ready to resume.
 *
 * Refuses — without creating anything — when `--at` names a step the workflow
 * does not have, when nothing finished before it, or when the workflow file
 * changed under one of the steps that would be copied. The last one matters
 * most: a fork that reused a step whose prompt has since been rewritten would
 * feed the rest of the pipeline an answer to a question nobody asks any more.
 *
 * @param request - The fork to cut.
 */
export async function forkWorkflowRun(request: ForkRequest): Promise<ForkOutcome> {
  const now = request.now ?? Date.now;
  const sourceDir = join(request.runsRoot, request.sourceRunId);
  const lines = await readJournalLines(sourceDir);
  if (lines.length === 0) {
    return { ok: false, error: `No run journal for "${request.sourceRunId}".` };
  }
  const header = lines.find(
    (line): line is Extract<JournalLine, { kind: "run" }> => line.kind === "run",
  );
  if (header === undefined) {
    return {
      ok: false,
      error: `Run ${request.sourceRunId} has no header line, so there is nothing to fork from.`,
    };
  }

  const position = request.workflow.stages.findIndex((stage) =>
    stage.steps.some((step) => step.id === request.at),
  );
  if (position === -1) {
    return {
      ok: false,
      error: `Workflow "${request.workflow.name}" has no step "${request.at}"; /workflow status ${request.sourceRunId} lists the steps it ran.`,
    };
  }
  if (position === 0) {
    return {
      ok: false,
      error: `Step ${request.at} is in the first stage of "${request.workflow.name}", so no stage finished before it — run the workflow again instead of forking it.`,
    };
  }

  // Latest terminal per step, exactly as `buildResumeState` folds them: a
  // resumed run appends, so the newest line for a step is the one that counts.
  const latest = new Map<string, Extract<JournalLine, { kind: "stepEnd" }>>();
  for (const line of lines) if (line.kind === "stepEnd") latest.set(line.id, line);

  const copiedStages = request.workflow.stages.slice(0, position);
  const copiedIds: string[] = [];
  const recorded = new Map<string, ForkStepFacts>();
  for (const stage of copiedStages) {
    for (const step of stage.steps) {
      const terminal = latest.get(step.id);
      if (
        terminal === undefined ||
        (terminal.status !== "done" && terminal.record?.status !== "applied")
      ) {
        return {
          ok: false,
          error: `Run ${request.sourceRunId} never finished step ${step.id}, so it has no completed stage before ${request.at} to fork from.`,
        };
      }
      copiedIds.push(step.id);
      recorded.set(step.id, {
        text: terminal.text,
        ...(terminal.record === undefined ? {} : { record: terminal.record }),
        ...(terminal.contract === undefined ? {} : { contract: terminal.contract }),
      });
    }
  }

  // THE STALENESS REFUSAL. Recomputed from the workflow on disk now; a
  // mismatch means the file was edited since the source run, and the answer
  // this fork would reuse is an answer to a question the file no longer asks.
  const hashes = request.promptHashes(recorded);
  for (const id of copiedIds) {
    const terminal = latest.get(id);
    const expected = hashes.get(id);
    if (terminal === undefined || expected === undefined) continue;
    if (terminal.promptHash !== expected) {
      return {
        ok: false,
        error: `Step ${id} of "${request.workflow.name}" has changed since run ${request.sourceRunId} ran it, so its recorded answer cannot be reused. Run the workflow fresh instead.`,
      };
    }
  }

  const at = request.at;

  // THE CHECKOUT REFUSAL, and the last decision made before anything exists.
  //
  // A fork writes into the same working tree the source run wrote into. If that
  // run APPLIED anything at or after `--at`, those changes are still in the
  // user's files, and the very first step this fork runs would produce a patch
  // git refuses — the fork dies half-started, after paying for a model call.
  // So the question is asked here, from the journal alone, before a directory
  // is created: either the human passed `--revert` and the checkout is rewound
  // now, or the fork is refused with the flag named.
  const laterIds = new Set<string>();
  for (const stage of request.workflow.stages.slice(position)) {
    for (const step of stage.steps) laterIds.add(step.id);
  }
  const revertPatches = collectAppliedPatches(lines, laterIds);
  let reverted: { steps: readonly string[]; patches: number } | undefined;
  if (revertPatches.length > 0) {
    const seenSteps: string[] = [];
    for (const patch of revertPatches) {
      if (!seenSteps.includes(patch.stepId)) seenSteps.push(patch.stepId);
    }
    const plan: ForkRevertPlan = {
      sourceRunId: request.sourceRunId,
      at,
      // Newest first: applying is a stack, so it comes off in reverse.
      patches: [...revertPatches].reverse(),
      steps: seenSteps,
      stageBefore: request.workflow.stages[position - 1]?.index ?? position,
    };
    if (request.revert === undefined) return { ok: false, error: forkRevertRefusal(plan) };
    const outcome = await request.revert(plan);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    if (outcome.patches > 0) reverted = { steps: outcome.steps, patches: outcome.patches };
  }

  const targetDir = join(request.runsRoot, request.newRunId);
  await mkdir(targetDir, { recursive: true });

  // The frozen picture of the checkout this run started against. See the
  // module doc for why a fork must inherit it rather than re-capture one.
  for (const artifact of FROZEN_RUN_ARTIFACTS) {
    try {
      await cp(join(sourceDir, artifact), join(targetDir, artifact), { recursive: true });
    } catch {
      // Absent for a run with no write-lane step, and for one whose lane never
      // needed a baseline. Not having it is the same state a fresh run is in.
    }
  }

  const ts = now();
  const origin: ForkOrigin = { runId: request.sourceRunId, at, ts };
  const input = request.input ?? header.input;
  const out: JournalLine[] = [
    {
      kind: "run",
      v: RUN_JOURNAL_SCHEMA_VERSION,
      runId: request.newRunId,
      workflow: header.workflow,
      source: header.source,
      input,
      stepTimeoutMs: header.stepTimeoutMs,
      maxStepRetries: header.maxStepRetries,
      startedAt: ts,
      ...(header.budgetCapUsd === undefined ? {} : { budgetCapUsd: header.budgetCapUsd }),
      forkedFrom: origin,
    },
  ];
  // Immediately under the header, because it happened before this run's first
  // step and it is the thing an operator reading the journal needs first: the
  // user's own files were rewound on this run's behalf.
  if (reverted !== undefined) {
    out.push({ kind: "forkRevert", steps: [...reverted.steps], patches: reverted.patches, ts });
  }

  // STAGE LINES ARE NOT COPIED. The fork's own run walks every stage the
  // workflow has — the replayed ones included — and journals its own
  // `stageStart`/`stageEnd` for each. Copying the source run's pair as well
  // put TWO `stageEnd`s for stage 1 in one journal, and `/workflow status`
  // folds that last-wins: a fork that failed later rendered "Stage 1 — failed"
  // over steps whose own terminals said `done`. One writer per stage line.
  const wanted = new Set(copiedIds);
  let patches = 0;
  for (const line of lines) {
    if (line.kind !== "stepEnd") continue;
    if (!wanted.has(line.id) || latest.get(line.id) !== line) continue;
    const original = line.record;
    if (original?.patchPath === undefined) {
      out.push(line);
      continue;
    }
    const patchPath = original.patchPath;
    // The patch moves with the record, so the new run seeds its own worktrees
    // from its own files and survives the source run being pruned.
    const copiedPath = join(targetDir, basename(patchPath));
    try {
      await cp(patchPath, copiedPath);
      patches += 1;
    } catch {
      // The source run was pruned out from under this fork. Keeping the
      // original path is strictly better than dropping the record: the seed
      // replay then fails loudly at the first worktree instead of silently
      // handing a role a checkout missing an earlier stage's work.
      out.push(line);
      continue;
    }
    out.push({ ...line, record: { ...original, patchPath: copiedPath } });
  }

  // THE HASHES ARE RESTAMPED, and this is the whole reason a fork past a
  // write-lane stage used to die.
  //
  // A worktree step's terminal carries a patch record, and `{{prev}}` renders
  // that record as a trailer whose `patch=` names an ABSOLUTE path. The copy
  // above moves the patch file into this run's own directory and rewrites the
  // record to match — so the very same reused step now contributes a
  // different trailer to the next stage's `{{prev}}`, and every later reused
  // step's prompt legitimately differs from the one the source run recorded.
  // Leaving the source's hashes on the copied lines meant the fork's own
  // resume recomputed the prompt, saw a hash that no longer matched, and
  // refused with `the workflow "<name>" changed since this run` — about a file
  // nobody had touched.
  //
  // So the hashes are recomputed from the lines as they will be ON DISK,
  // through the SAME {@link replayPromptHashes} the staleness refusal above
  // used: one function produces the recorded prompt, called twice with the two
  // sets of facts it is asked about. The refusal keeps comparing the source's
  // facts against the source's hashes — "did the FILE change?" — and this
  // keeps the fork internally consistent — "what will this run's own resume
  // recompute?". Only steps downstream of a moved patch actually change.
  const forkedFacts = new Map<string, ForkStepFacts>();
  for (const line of out) {
    if (line.kind !== "stepEnd" || !wanted.has(line.id)) continue;
    forkedFacts.set(line.id, {
      text: line.text,
      ...(line.record === undefined ? {} : { record: line.record }),
      ...(line.contract === undefined ? {} : { contract: line.contract }),
    });
  }
  const forkedHashes = request.promptHashes(forkedFacts);
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    if (line === undefined || line.kind !== "stepEnd" || !wanted.has(line.id)) continue;
    const hash = forkedHashes.get(line.id);
    if (hash === undefined || hash === line.promptHash) continue;
    out[i] = { ...line, promptHash: hash };
  }

  // The run-scoped grants, after the copied prefix so the fold sees them last.
  if (request.model !== undefined) {
    out.push({ kind: "stepModelOverride", stepId: at, tag: request.model, ts });
  }
  if (request.raise !== undefined) {
    out.push({ kind: "turnRaise", stepId: at, value: request.raise, ts });
  }

  const journalPath = join(targetDir, RUN_JOURNAL_FILE);
  await writeFile(journalPath, `${out.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  // Flushed, not merely written: a `--revert` fork has ALREADY changed the
  // user's files by the time this runs, and the `forkRevert` line above is the
  // only record that it did. Everything else in this file is reconstructible
  // from the source run; that line is not.
  if (reverted !== undefined) {
    try {
      const handle = await openFile(journalPath, "r+");
      try {
        await handle.datasync();
      } finally {
        await handle.close();
      }
    } catch {
      // A filesystem that will not sync is not a reason to fail a fork whose
      // bytes are already written.
    }
  }

  return {
    ok: true,
    runId: request.newRunId,
    input,
    stages: copiedStages.length,
    steps: copiedIds.length,
    patches,
    ...(reverted === undefined ? {} : { reverted }),
    origin,
  };
}

/**
 * The line a fork prints once it is cut, before the run starts.
 *
 * @param outcome - A successful fork.
 * @param workflow - The workflow's name.
 */
export function describeFork(
  outcome: Extract<ForkOutcome, { ok: true }>,
  workflow: string,
): string {
  const parts = [
    `Forked ${outcome.origin.runId} at step ${outcome.origin.at} into run ${outcome.runId}`,
    `${outcome.stages} stage(s) and ${outcome.steps} finished step(s) are reused, not redone`,
  ];
  if (outcome.patches > 0) parts.push(`${outcome.patches} patch file(s) carried over`);
  if (outcome.reverted !== undefined) {
    parts.push(
      `${outcome.reverted.patches} patch(es) from ${formatStepSpan(outcome.reverted.steps)} ` +
        "were taken back out of the checkout first",
    );
  }
  return `${parts.join("; ")}. Continuing ${workflow}.`;
}
