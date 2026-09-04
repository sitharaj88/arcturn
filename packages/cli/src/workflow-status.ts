/**
 * Read side of the org-workflow run journal — the surface behind `/workflow
 * status`.
 *
 * The *resilience* half of this work writes `journal.jsonl` (an append-only
 * line-per-event file under `~/.arcturn/workflow-runs/<runId>/`, schema in
 * `workflow-run.ts`); this module only ever *reads* it, folding the typed
 * {@link JournalLine} stream into a per-run view so an operator can answer "what
 * is it doing / what did it do" without an engineer grepping session JSONL.
 *
 * The fold ({@link foldJournal}) and the renderers ({@link formatRunsTable},
 * {@link formatRunDetail}) are pure and carry the whole contract under test;
 * {@link readWorkflowRuns} is the thin filesystem wrapper the command uses, built
 * on the writer's own {@link readJournalLines} so reader and writer can never
 * drift on the on-disk format.
 *
 * @packageDocumentation
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describeContractValue } from "./contracts.js";
import { formatDuration, formatTokens, totalTokens } from "./format.js";
import { FANCY_GLYPHS, type GlyphSet } from "./glyphs.js";
import { describeJudges, type JudgesRecord } from "./judges.js";
import type { WorkflowRunStatus, WorkflowStepStatus } from "./workflow.js";
import { describeRace, raceSummaryFacts, type StepRaceSummary } from "./workflow-race.js";
import {
  activityFacts,
  BUDGET_ASK_STEP_ID,
  type BudgetAskAudience,
  type BudgetCeilingKind,
  budgetAskFacts,
  budgetAskQuestion,
  budgetAskResumeHint,
  describeActivity,
  describeLastTurn,
  type ForkOrigin,
  type JournalLine,
  type PendingBudgetAsk,
  type PendingStepFailAsk,
  readJournalLines,
  type StepActivity,
  stepFailAskFacts,
  stepFailAskQuestion,
  stepFailAskResumeHint,
  type WorkflowStopReason,
} from "./workflow-run.js";

/** Default step wall-clock ceiling, mirrored from the engine for staleness. */
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** One step, as reconstructed from the journal. */
export interface JournalStep {
  readonly id: string;
  readonly stage: number;
  readonly branch?: number;
  readonly agent?: string;
  readonly modelTag?: string;
  /** Terminal status, once a `stepEnd` line landed; `running` while dangling. */
  status: "running" | WorkflowStepStatus;
  tokens?: number;
  attempts?: number;
  recordStatus?: string;
  startedAt?: number;
  endedAt?: number;
  /** The validated object a `[contract:<name>]` step replied with. */
  contract?: Record<string, unknown>;
  /** What a `[judges:N]` step's panel decided. */
  judges?: JudgesRecord;
  /**
   * MODEL RACING: how this step's race resolved, when it declared one.
   *
   * Read through {@link raceSummaryFacts} rather than trusted off the line: a
   * journal is written by several versions of this program, and a torn or
   * hand-edited block must cost this one line, not the whole status view.
   */
  race?: StepRaceSummary;
  /**
   * What the step's agent spent its turns on, when the terminal recorded it.
   *
   * Folded only so the DENIED count can be rendered: a step that reports
   * `done` while the permission mode refused every command it was told to run
   * looks perfect in every other column of this view. Validated off disk
   * through {@link activityFacts} like every other folded record.
   */
  activity?: StepActivity;
}

/** One stage, as reconstructed from the journal. */
export interface JournalStage {
  readonly index: number;
  parallel?: boolean;
  readonly steps: JournalStep[];
  status?: WorkflowStepStatus;
}

/** A whole run, folded from its `journal.jsonl`. */
export interface JournalRun {
  readonly runId: string;
  workflow?: string;
  source?: string;
  startedAt?: number;
  stepTimeoutMs?: number;
  maxStepRetries?: number;
  readonly stages: JournalStage[];
  /**
   * Where this run was forked from, when its header says it was one.
   *
   * A forked run's first stages were copied rather than executed, and without
   * this an operator reading `/workflow status` sees a run that finished six
   * steps in nine seconds with no way to know why.
   */
  forkedFrom?: ForkOrigin;
  /**
   * What a `--revert` fork took back out of the user's checkout before this
   * run started, from its `forkRevert` line. Absent for every other run.
   */
  forkRevert?: { steps: readonly string[]; patches: number };
  /** Last-known running spend, from the newest `budget` line. */
  spentUsd?: number;
  /**
   * Last-known running token total, from the newest `budget` line's `usage` —
   * input + output + cache read + cache write, the same sum the engine's
   * `budgetTokens:` ceiling compares against. Unlike {@link spentUsd} it is
   * known for every model, priced or not, which is exactly why the token
   * ceiling exists.
   */
  spentTokens?: number;
  /** Last-known running turn count, from the newest `budget` line. */
  turns?: number;
  /** A `stop` line's reason, when the run halted for a named condition. */
  stopReason?: WorkflowStopReason;
  /** A `runEnd` line's status, when the run finished. */
  endStatus?: WorkflowRunStatus;
  /**
   * Every human-question the run is paused on, in journal order.
   *
   * A *stage* pauses, not a step: a parallel stage whose branches each raise an
   * `ORG-ASK` owes an answer for each of them. Modelling this as one question
   * told the operator the run was waiting on strictly less than it was — the
   * last paused branch overwrote the others — so the fold keeps them all.
   *
   * A question is retired the moment its own step is answered (that step's
   * `stepEnd` re-writes as `done`), independently of its siblings.
   */
  pendingQuestions: PendingJournalQuestion[];
  /**
   * The first entry of {@link pendingQuestions}, or `undefined` when none are
   * owed — the single-question view, kept for readers that want one line.
   *
   * Deliberately the *first* and not the last: it is the question an operator
   * is asked about first, so a one-line reader stays consistent with the list.
   */
  pendingQuestion?: string;
  /**
   * The step-failure park this run is holding, when one is pending.
   *
   * Kept on the fold (rather than derived from the question text) because the
   * *hint* under a parked run differs by failure kind: `raise <n>` is offered
   * only where a turn ceiling actually tripped, and offering a reply the
   * engine will refuse is an instruction to loop.
   */
  parkedStep?: PendingStepFailAsk;
  /**
   * The stage-boundary budget ask this run is holding, when one is pending.
   *
   * {@link parkedStep}'s twin for the other park a wire client may want to
   * offer a raise for: kept on the fold rather than re-derived from the
   * question text, on the same grounds — a client that knows a raise is
   * meaningful for this park (`serve-workflows.ts`'s `WorkflowRunQuestion.raise`)
   * needs the ceiling in force, and the question string alone does not carry
   * that back out as a number.
   */
  budgetAsk?: PendingBudgetAsk;
  /** Wall clock of the newest journal line — the staleness signal. */
  lastWriteTs?: number;
}

/** One unanswered `ORG-ASK`, and the step that raised it. */
export interface PendingJournalQuestion {
  /** Step id that raised it — what `/workflow resume` names to answer just this one. */
  readonly stepId: string;
  /** The question text, after the `ORG-ASK:` marker. */
  readonly question: string;
}

/** The state a run is rendered in — the one-glance "is it hung?" answer. */
export type RunState =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "paused"
  | "stalled"
  | "resumable"
  | "unknown";

/** A row in the `/workflow status` table. */
export interface RunSummary {
  readonly runId: string;
  readonly workflow: string;
  readonly state: RunState;
  readonly stage?: number;
  readonly stageCount: number;
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly spentUsd?: number;
  readonly spentTokens?: number;
  readonly turns?: number;
  readonly stopReason?: WorkflowStopReason;
  readonly startedAt?: number;
  readonly lastWriteTs?: number;
  /** The first question a `paused` run is waiting on, when one is pending. */
  readonly pendingQuestion?: string;
  /** Every question it is waiting on — more than one when a parallel stage paused. */
  readonly pendingQuestions: readonly PendingJournalQuestion[];
  /** The step-failure park it is holding, when it is parked on one. */
  readonly parkedStep?: PendingStepFailAsk;
}

/** Track the newest timestamp seen, from whichever field a line carries it in. */
function bumpWrite(run: JournalRun, ts: number | undefined): void {
  if (ts === undefined) return;
  if (run.lastWriteTs === undefined || ts > run.lastWriteTs) run.lastWriteTs = ts;
}

/**
 * Fold a run's typed journal lines into a {@link JournalRun}.
 *
 * The lines are the writer's own {@link JournalLine} union, so this stays a
 * pure structural fold with no re-parsing — reader and writer share one schema.
 *
 * @param runId - The run directory's id (used when no `run` header was written).
 * @param lines - The journal, in append order.
 * @param audience - What the origin this view is rendered for may do about a
 *   budget checkpoint. The wire passes `{ allowRaise: false }`, because the
 *   question text travels verbatim to a client the seam forbids from raising
 *   anything; the terminal takes the default.
 */
export function foldJournal(
  runId: string,
  lines: readonly JournalLine[],
  audience: BudgetAskAudience = {},
): JournalRun {
  const stages = new Map<number, JournalStage>();
  const run: JournalRun = { runId, stages: [], pendingQuestions: [] };
  // Which ceiling the pending budget ask names, so an ack or raise retires it
  // only when it answers THAT ceiling — the rule `buildResumeState` already
  // follows. Two folds of one journal disagreeing about whether a question is
  // still owed is how status says "answered" while resume asks again.
  let askedCeiling: BudgetCeilingKind | undefined;
  // The step-failure park's fold, the budget ask's twin: which step is parked,
  // kept so a later terminal for THAT step (the retry landing) retires it and
  // so the resume hint can offer `raise` only where a turn ceiling tripped.
  // Two folds of one journal disagreeing about whether a question is still
  // owed is how status says "answered" while resume asks again.
  let parkedStep: PendingStepFailAsk | undefined;
  // Every step whose latest terminal is a `paused` one, in the order the journal
  // first saw it — insertion order is what makes `pendingQuestions` stable and
  // `pendingQuestion` the *first* question rather than whichever branch of a
  // parallel stage happened to finish last. A later terminal for one of these
  // steps (an answered pause) retires that entry and only that entry.
  const pending = new Map<string, string>();

  const stageFor = (index: number): JournalStage => {
    let stage = stages.get(index);
    if (!stage) {
      stage = { index, steps: [] };
      stages.set(index, stage);
    }
    return stage;
  };

  for (const line of lines) {
    switch (line.kind) {
      case "run":
        run.workflow = line.workflow;
        run.source = line.source;
        if (
          line.forkedFrom !== undefined &&
          typeof line.forkedFrom.runId === "string" &&
          typeof line.forkedFrom.at === "string"
        ) {
          run.forkedFrom = line.forkedFrom;
        }
        run.startedAt = line.startedAt;
        run.stepTimeoutMs = line.stepTimeoutMs;
        run.maxStepRetries = line.maxStepRetries;
        bumpWrite(run, line.startedAt);
        break;
      case "forkRevert":
        // Tolerated the way every other folded-off-disk fact is: a torn line
        // with no usable numbers is no revert, not a revert of `NaN` patches.
        if (Array.isArray(line.steps) && typeof line.patches === "number" && line.patches > 0) {
          run.forkRevert = {
            steps: line.steps.filter((step): step is string => typeof step === "string"),
            patches: line.patches,
          };
        }
        break;
      case "stageStart": {
        const stage = stageFor(line.stage);
        stage.parallel = line.parallel;
        bumpWrite(run, line.ts);
        break;
      }
      case "stageEnd":
        stageFor(line.stage).status = line.status;
        bumpWrite(run, line.ts);
        break;
      case "stepStart": {
        const stage = stageFor(line.stage);
        const existing = stage.steps.find((step) => step.id === line.id);
        if (existing) {
          // A resume re-opens a step it re-runs: reset it to running.
          existing.status = "running";
          existing.startedAt = line.ts;
          existing.endedAt = undefined;
        } else {
          stage.steps.push({
            id: line.id,
            stage: line.stage,
            branch: line.branch,
            ...(line.agent === undefined ? {} : { agent: line.agent }),
            ...(line.modelTag === undefined ? {} : { modelTag: line.modelTag }),
            status: "running",
            startedAt: line.ts,
          });
        }
        bumpWrite(run, line.ts);
        break;
      }
      case "stepEnd": {
        const stage = stageFor(line.stage);
        const step = stage.steps.find((candidate) => candidate.id === line.id);
        const patch: Partial<JournalStep> = {
          status: line.status,
          tokens: line.usage.outputTokens,
          attempts: line.attempts,
          startedAt: line.startedAt,
          endedAt: line.endedAt,
          ...(line.record?.status === undefined ? {} : { recordStatus: line.record.status }),
          ...(line.contract === undefined ? {} : { contract: line.contract }),
          ...(line.judges === undefined ? {} : { judges: line.judges }),
          ...(raceSummaryFacts(line.race) === undefined
            ? {}
            : { race: raceSummaryFacts(line.race) }),
          ...(activityFacts(line.activity) === undefined
            ? {}
            : { activity: activityFacts(line.activity) }),
        };
        if (step) Object.assign(step, patch);
        else {
          stage.steps.push({
            id: line.id,
            stage: line.stage,
            branch: line.branch,
            ...(line.agent === undefined ? {} : { agent: line.agent }),
            status: line.status,
            tokens: line.usage.outputTokens,
            attempts: line.attempts,
            startedAt: line.startedAt,
            endedAt: line.endedAt,
            ...(line.record?.status === undefined ? {} : { recordStatus: line.record.status }),
            ...(line.contract === undefined ? {} : { contract: line.contract }),
            ...(line.judges === undefined ? {} : { judges: line.judges }),
            ...(raceSummaryFacts(line.race) === undefined
              ? {}
              : { race: raceSummaryFacts(line.race) }),
            ...(activityFacts(line.activity) === undefined
              ? {}
              : { activity: activityFacts(line.activity) }),
          });
        }
        // The human-question gate: a `paused` terminal arms that step's pending
        // question; any later terminal for the same step (an answered pause
        // re-writes it as `done`) retires it. "Latest wins", forward-folded,
        // per step — a parallel stage's siblings are settled independently.
        if (line.status === "paused") pending.set(line.id, line.question ?? "");
        else pending.delete(line.id);
        // A fresh terminal for a parked step is the retry landing: the park's
        // question is answered and gone, whatever this terminal says. The
        // `stepFailAsk` that a *failing* terminal is followed by re-arms it on
        // the very next line, so a step that failed again stays parked.
        if (parkedStep?.stepId === line.id) parkedStep = undefined;
        bumpWrite(run, line.endedAt);
        break;
      }
      case "budget":
        if (line.spentUsd !== undefined) run.spentUsd = line.spentUsd;
        if (line.turns !== undefined) run.turns = line.turns;
        // Guarded although the writer always sets `usage`: the fold's contract
        // is to tolerate any line that survived `readJournalLines`.
        if (line.usage !== undefined) run.spentTokens = totalTokens(line.usage);
        bumpWrite(run, line.ts);
        break;
      case "budgetAsk": {
        // The stage-boundary budget ask is a *run*-level pending question,
        // keyed under its sentinel step id so the same "latest wins" retiring
        // the step questions use applies. Rendered here from the recorded
        // numbers by the writer's own renderer, so status and resume restate
        // one identical question — and validated first, because these numbers
        // came off disk and a torn line must not throw the whole view away.
        const facts = budgetAskFacts(line);
        if (facts !== undefined) {
          askedCeiling = facts.ceiling;
          run.budgetAsk = facts;
          pending.set(BUDGET_ASK_STEP_ID, budgetAskQuestion(facts, audience));
        }
        bumpWrite(run, line.ts);
        break;
      }
      case "budgetAck":
      case "budgetRaise":
        // Either reply settles the ask — but only the ask it answers: an ack
        // runs that ceiling to the hard stop, a raise continues under the new
        // one (and may ask again later, which appends a fresh `budgetAsk`
        // after this line). A reply naming the *other* ceiling settles nothing.
        if (askedCeiling !== undefined && askedCeiling === line.ceiling) {
          pending.delete(BUDGET_ASK_STEP_ID);
          askedCeiling = undefined;
          run.budgetAsk = undefined;
        }
        bumpWrite(run, line.ts);
        break;
      case "stepFailAsk": {
        // The step-failure park is a pending question keyed under the step
        // that failed — a real id, not the budget ask's sentinel. Rendered
        // here from the recorded facts by the writer's own renderer, so status
        // and resume restate one identical question, and validated first
        // because these numbers came off disk.
        const facts = stepFailAskFacts(line);
        if (facts !== undefined) {
          parkedStep = facts;
          pending.set(facts.stepId, stepFailAskQuestion(facts, audience));
        }
        bumpWrite(run, line.ts);
        break;
      }
      case "stepAbandon":
        // The human chose the tombstone: the question is settled, and the
        // `runEnd{failed}` that follows is the run's own answer.
        if (parkedStep?.stepId === line.stepId) {
          pending.delete(line.stepId);
          parkedStep = undefined;
        }
        bumpWrite(run, line.ts);
        break;
      case "turnRaise":
        // A grant settles nothing on its own — the retry's terminal does. It
        // is recorded here only for the clock.
        bumpWrite(run, line.ts);
        break;
      case "stop":
        run.stopReason = line.reason;
        bumpWrite(run, line.ts);
        break;
      case "runEnd":
        run.endStatus = line.status;
        bumpWrite(run, line.ts);
        break;
      default:
        break;
    }
  }

  run.stages.push(...[...stages.values()].sort((a, b) => a.index - b.index));
  run.pendingQuestions = [...pending].map(([stepId, question]) => ({ stepId, question }));
  run.pendingQuestion = run.pendingQuestions[0]?.question;
  if (parkedStep !== undefined) run.parkedStep = parkedStep;
  return run;
}

/**
 * Decide the state a run is rendered in.
 *
 * The states an operator acts on: a finished run reports its `runEnd` status; a
 * run with a step still open and a fresh journal is `running`; one whose journal
 * has gone quiet past the step deadline is `stalled` (hung, or the host died —
 * either way, look); one that stopped at a stage boundary with no `runEnd` is
 * `resumable` (a clean cut point to resume from).
 *
 * @param run - The folded run.
 * @param now - Current wall clock.
 */
export function deriveRunState(run: JournalRun, now: number = Date.now()): RunState {
  // The human-question gate: a `"paused"` end is a *soft* stop. It reads as
  // `paused` only while a question is actually pending; once answered, its
  // stale `runEnd{paused}` (no new terminal was written before the continuation
  // died) is an ordinary `resumable` — there is nothing left to answer.
  if (run.endStatus === "paused") {
    return run.pendingQuestion !== undefined ? "paused" : "resumable";
  }
  if (run.endStatus) return run.endStatus;
  const dangling = run.stages.some((stage) =>
    stage.steps.some((step) => step.status === "running"),
  );
  const stepTimeout = run.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const age = run.lastWriteTs === undefined ? undefined : Math.max(0, now - run.lastWriteTs);
  if (dangling) {
    if (age !== undefined && age > stepTimeout) return "stalled";
    return "running";
  }
  return run.stages.length > 0 ? "resumable" : "unknown";
}

/** Summarise a folded run into one table row. */
export function summariseRun(run: JournalRun, now: number = Date.now()): RunSummary {
  const steps = run.stages.flatMap((stage) => stage.steps);
  const done = steps.filter((step) => step.status !== "running").length;
  const running = run.stages.find((stage) => stage.steps.some((step) => step.status === "running"));
  const stage = running?.index ?? run.stages.at(-1)?.index;
  return {
    runId: run.runId,
    workflow: run.workflow ?? "?",
    state: deriveRunState(run, now),
    ...(stage === undefined ? {} : { stage }),
    stageCount: run.stages.length,
    stepsDone: done,
    stepsTotal: steps.length,
    ...(run.spentUsd === undefined ? {} : { spentUsd: run.spentUsd }),
    ...(run.spentTokens === undefined ? {} : { spentTokens: run.spentTokens }),
    ...(run.turns === undefined ? {} : { turns: run.turns }),
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.lastWriteTs === undefined ? {} : { lastWriteTs: run.lastWriteTs }),
    ...(run.pendingQuestion === undefined ? {} : { pendingQuestion: run.pendingQuestion }),
    pendingQuestions: run.pendingQuestions,
    ...(run.parkedStep === undefined ? {} : { parkedStep: run.parkedStep }),
  };
}

const STATE_GLYPH: Record<RunState, (glyphs: GlyphSet) => string> = {
  running: (g) => g.statusDot,
  done: (g) => g.done,
  failed: (g) => g.error,
  cancelled: (g) => g.interrupt,
  paused: (g) => g.warn,
  stalled: (g) => g.warn,
  resumable: (g) => g.arrow,
  unknown: (g) => g.dot,
};

/**
 * Render the `/workflow status` table: one row per run, newest first.
 *
 * @param runs - Folded runs.
 * @param now - Current wall clock, for elapsed and staleness.
 * @param glyphs - Glyph set.
 */
export function formatRunsTable(
  runs: readonly JournalRun[],
  now: number = Date.now(),
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  if (runs.length === 0) {
    return ["No workflow runs recorded yet.", "Run one with /workflow <name> to build a journal."];
  }
  const summaries = runs
    .map((run) => summariseRun(run, now))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const lines = [`Workflow runs (${summaries.length}):`, ""];
  for (const row of summaries) {
    const state = `${STATE_GLYPH[row.state](glyphs)} ${row.state}`;
    const facts = [
      row.workflow,
      row.stage === undefined
        ? `${row.stageCount} stage(s)`
        : `stage ${row.stage}/${row.stageCount}`,
      `${row.stepsDone}/${row.stepsTotal} steps`,
    ];
    if (row.spentUsd !== undefined) facts.push(`$${row.spentUsd.toFixed(2)}`);
    // `en-US` grouping, not `formatTokens`'s compact form: this is the figure
    // an operator compares against a `budgetTokens:` ceiling (and the ceiling's
    // own abort message), so the two must read in the same notation.
    if (row.spentTokens !== undefined) {
      facts.push(`${row.spentTokens.toLocaleString("en-US")} tok`);
    }
    if (row.turns !== undefined) facts.push(`${row.turns} turns`);
    if (row.startedAt !== undefined) facts.push(formatDuration(Math.max(0, now - row.startedAt)));
    if ((row.state === "stalled" || row.state === "running") && row.lastWriteTs !== undefined) {
      facts.push(`quiet ${formatDuration(Math.max(0, now - row.lastWriteTs))}`);
    }
    if (row.stopReason !== undefined) facts.push(`stop: ${row.stopReason}`);
    lines.push(`  ${row.runId}  ${state}`);
    lines.push(`    ${facts.join(` ${glyphs.dot} `)}`);
    if (row.state === "paused") {
      // The human-question gate: a paused run needs an answer, not a bare resume.
      // A parallel stage can owe several — the row names the first and counts
      // the rest, so a one-line overview never understates what is waiting.
      if (row.pendingQuestion) {
        const more = row.pendingQuestions.length;
        const count = more > 1 ? ` (${more} questions — see /workflow status ${row.runId})` : "";
        lines.push(`    asks: ${row.pendingQuestion}${count}`);
      }
      // A budget checkpoint takes a different pair of replies than a role's
      // question, so the hint says so — telling the operator "<answer>" here
      // would invite prose the engine can only bounce back. One shared
      // renderer with the detail view below: two copies of the valid replies
      // is one copy too many.
      if (row.pendingQuestions[0]?.stepId === BUDGET_ASK_STEP_ID) {
        lines.push(`    ${budgetAskResumeHint(row.runId)}`);
      } else if (row.parkedStep !== undefined) {
        // A parked step takes `retry`/`abandon` (and `raise <n>` only for a
        // turn ceiling), not prose — telling the operator "<answer>" here
        // would invite a reply the engine can only bounce back.
        lines.push(`    ${stepFailAskResumeHint(row.runId, row.parkedStep)}`);
      } else {
        lines.push(`    answer with /workflow resume ${row.runId} <answer>`);
      }
    } else if (row.state === "stalled" || row.state === "resumable") {
      lines.push(`    resume with /workflow resume ${row.runId}`);
    }
  }
  return lines;
}

/**
 * Render one run's stage/step tree — the mid-run, cross-terminal detail view.
 *
 * @param run - The folded run.
 * @param now - Current wall clock.
 * @param glyphs - Glyph set.
 */
export function formatRunDetail(
  run: JournalRun,
  now: number = Date.now(),
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  const state = deriveRunState(run, now);
  const lines = [`Run ${run.runId} — ${run.workflow ?? "?"} [${state}]`];
  if (run.source) lines.push(`  source: ${run.source}`);
  if (run.forkedFrom) {
    lines.push(`  forked from ${run.forkedFrom.runId} at step ${run.forkedFrom.at}`);
  }
  if (run.forkRevert && run.forkRevert.patches > 0) {
    const steps = run.forkRevert.steps;
    const span =
      steps.length === 0
        ? "later steps"
        : steps.length === 1
          ? `step ${steps[0]}`
          : `steps ${steps[0]}-${steps[steps.length - 1]}`;
    lines.push(
      `  reverted ${run.forkRevert.patches} patch(es) from ${span} of the source run before starting`,
    );
  }
  const facts: string[] = [];
  if (run.spentUsd !== undefined) facts.push(`spend $${run.spentUsd.toFixed(2)}`);
  if (run.spentTokens !== undefined) {
    facts.push(`${run.spentTokens.toLocaleString("en-US")} tokens`);
  }
  if (run.turns !== undefined) facts.push(`${run.turns} turns`);
  if (run.startedAt !== undefined) {
    facts.push(`elapsed ${formatDuration(Math.max(0, now - run.startedAt))}`);
  }
  if (facts.length > 0) lines.push(`  ${facts.join(` ${glyphs.dot} `)}`);
  if (run.stopReason) lines.push(`  stopped: ${run.stopReason}`);
  lines.push("");

  for (const stage of run.stages) {
    const head = `Stage ${stage.index}${stage.parallel ? " (parallel)" : ""}${stage.status ? ` — ${stage.status}` : ""}`;
    lines.push(head);
    for (const step of stage.steps) {
      const mark = step.status === "running" ? glyphs.statusDot : stepMark(step.status, glyphs);
      const label = step.agent ? `@${step.agent}` : `step ${step.id}`;
      const detail: string[] = [];
      if (step.recordStatus) detail.push(`patch ${step.recordStatus}`);
      if (step.tokens !== undefined) detail.push(formatTokens(step.tokens));
      if (step.attempts !== undefined && step.attempts > 1)
        detail.push(`${step.attempts} attempts`);
      if (step.startedAt !== undefined && step.endedAt !== undefined) {
        detail.push(formatDuration(Math.max(0, step.endedAt - step.startedAt)));
      }
      const tail = detail.length > 0 ? `  ${glyphs.dot} ${detail.join(` ${glyphs.dot} `)}` : "";
      lines.push(`  ${mark} ${step.id} ${label} — ${step.status}${tail}`);
      // MODEL RACING: which models ran this step and how each of them ended.
      // On its own line because a race answers a different question from "did
      // this step work", and squeezing a three-arm race into the tail above
      // would push the row past every terminal width.
      if (step.race) {
        const won =
          step.startedAt !== undefined && step.endedAt !== undefined
            ? Math.max(0, step.endedAt - step.startedAt)
            : undefined;
        lines.push(`      race: ${describeRace(step.race, won, glyphs.dot)}`);
      }
      // The typed reply, and how it was reached — on their own lines rather
      // than in the `·`-joined tail, because both are the ANSWER a step
      // produced, and the tail is a row of costs. A step that ran a panel is
      // also the one step whose second line is worth more than its first:
      // "judges: 2 · SHIP / DO-NOT-SHIP" is the finding.
      if (step.judges !== undefined) {
        lines.push(`      ${describeJudges(step.judges, glyphs.dot)}`);
      }
      if (step.contract !== undefined) {
        lines.push(`      contract: ${contractSummary(step.contract)}`);
      }
      // REFUSED CALLS, and only refused calls. The whole activity line on
      // every step would double the height of this view for a number that is
      // usually zero; a step whose tools were BLOCKED is the one case where
      // "done" is not the whole truth, so that is the case that gets a line.
      if ((step.activity?.denied ?? 0) > 0 && step.activity !== undefined) {
        lines.push(`      ${describeActivity(step.activity)}`);
      }
    }
  }
  if (state === "paused") {
    lines.push("");
    // The detail view has the room to list every owed question with the step
    // that raised it, which is what an operator needs to answer them.
    if (run.pendingQuestions.length === 1 && run.pendingQuestion) {
      // A parked step did not *ask* anything — it broke, and the run stopped
      // to be told what to do about it. Calling that "awaiting a human answer"
      // sends an operator hunting the transcript for an `ORG-ASK` that is not
      // there.
      lines.push(
        run.parkedStep === undefined
          ? `Awaiting a human answer: ${run.pendingQuestion}`
          : `Parked at a failed step: ${run.pendingQuestion}`,
      );
      // The diagnosis under the park: what the model emitted on the turn the
      // step failed on. Rendered by the journal's own renderer, so status, the
      // terminal notice and the resume restatement show one set of words.
      if (run.parkedStep?.lastTurn !== undefined) {
        for (const line of describeLastTurn(run.parkedStep.lastTurn).split("\n")) {
          lines.push(`  ${line}`);
        }
      }
      // …and what the step spent its turns on, under the same park. A role
      // that burned its whole ceiling reading says so here rather than in a
      // session file nobody opens.
      if (run.parkedStep?.activity !== undefined) {
        lines.push(`  ${describeActivity(run.parkedStep.activity)}`);
      }
    } else if (run.pendingQuestions.length > 1) {
      lines.push(`Awaiting ${run.pendingQuestions.length} human answers:`);
      for (const q of run.pendingQuestions) lines.push(`  ${q.stepId}: ${q.question}`);
    }
    if (run.pendingQuestions[0]?.stepId === BUDGET_ASK_STEP_ID) {
      lines.push(budgetAskResumeHint(run.runId));
    } else if (run.parkedStep !== undefined) {
      lines.push(stepFailAskResumeHint(run.runId, run.parkedStep));
    } else {
      lines.push(`Answer with /workflow resume ${run.runId} <answer>`);
    }
  } else if (state === "stalled" || state === "resumable") {
    lines.push("");
    lines.push(`Resume with /workflow resume ${run.runId}`);
  }
  return lines;
}

/**
 * One line describing a journalled contract value.
 *
 * The journal records the validated OBJECT, not the contract that shaped it —
 * a run's `.md` file may have been edited or deleted by the time anyone reads
 * its status, and a status view that had to re-parse the workflow to render a
 * line would show nothing for exactly the runs worth looking at. So the
 * object's own keys stand in for the declaration, in the order the model wrote
 * them, and {@link describeContractValue} does the rest: scalars only, arrays
 * left out, one line.
 *
 * @param value - The object recorded on the step's terminal.
 */
function contractSummary(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  const rendered = describeContractValue(
    {
      name: "contract",
      line: 0,
      fields: keys.map((name) => ({
        name,
        optional: true,
        type: { kind: "string" as const },
      })),
    },
    value,
  );
  // `describeContractValue` falls back to "<name>: N fields" when nothing in
  // the object renders as a scalar (a contract whose fields are all arrays),
  // and the synthetic contract's name is "contract" — which the caller has
  // already printed. Without this the line read `contract: contract: 2 fields`.
  const fallback = `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  return rendered === `contract: ${fallback}` ? fallback : rendered;
}

function stepMark(status: JournalStep["status"], glyphs: GlyphSet): string {
  switch (status) {
    case "done":
      return glyphs.done;
    case "failed":
      return glyphs.error;
    case "cancelled":
      return glyphs.interrupt;
    case "paused":
      return glyphs.warn;
    default:
      return glyphs.dot;
  }
}

/**
 * Read and fold every run journal under a `workflow-runs` root.
 *
 * A directory without a readable `journal.jsonl` (an older run, or one still
 * being set up) yields no lines and is skipped — the reader is best-effort by
 * contract, exactly as the writer is.
 *
 * One run's fold is also isolated from the others. The fold is written to
 * tolerate anything `readJournalLines` let through, but "written to" is not
 * "proven to" — and the blast radius of getting that wrong here is the whole
 * view: an unguarded `Promise.all` turns one torn line in one run's journal
 * into "`/workflow status` is broken" for every run on the machine. A run that
 * cannot be folded is dropped, exactly as a run with no readable journal is.
 *
 * @param root - The `~/.arcturn/workflow-runs` directory.
 * @param audience - Forwarded to {@link foldJournal}.
 * @returns Folded runs, in no particular order (the formatter sorts them).
 */
export async function readWorkflowRuns(
  root: string,
  audience: BudgetAskAudience = {},
): Promise<JournalRun[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const runs: JournalRun[] = [];
  await Promise.all(
    entries.map(async (name) => {
      try {
        const lines = await readJournalLines(join(root, name));
        if (lines.length === 0) return;
        runs.push(foldJournal(name, lines, audience));
      } catch {
        // One unreadable run costs that row, never the listing.
      }
    }),
  );
  return runs;
}

/**
 * Read and fold one run's journal by id.
 *
 * @param root - The `~/.arcturn/workflow-runs` directory.
 * @param runId - The run id (directory name).
 * @param audience - Forwarded to {@link foldJournal}.
 */
export async function readWorkflowRun(
  root: string,
  runId: string,
  audience: BudgetAskAudience = {},
): Promise<JournalRun | undefined> {
  const lines = await readJournalLines(join(root, runId));
  if (lines.length === 0) return undefined;
  return foldJournal(runId, lines, audience);
}
