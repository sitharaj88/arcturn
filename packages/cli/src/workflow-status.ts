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
import { formatDuration, formatTokens } from "./format.js";
import { FANCY_GLYPHS, type GlyphSet } from "./glyphs.js";
import type { WorkflowRunStatus, WorkflowStepStatus } from "./workflow.js";
import { type JournalLine, readJournalLines, type WorkflowStopReason } from "./workflow-run.js";

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
  /** Last-known running spend, from the newest `budget` line. */
  spentUsd?: number;
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
  readonly turns?: number;
  readonly stopReason?: WorkflowStopReason;
  readonly startedAt?: number;
  readonly lastWriteTs?: number;
  /** The first question a `paused` run is waiting on, when one is pending. */
  readonly pendingQuestion?: string;
  /** Every question it is waiting on — more than one when a parallel stage paused. */
  readonly pendingQuestions: readonly PendingJournalQuestion[];
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
 */
export function foldJournal(runId: string, lines: readonly JournalLine[]): JournalRun {
  const stages = new Map<number, JournalStage>();
  const run: JournalRun = { runId, stages: [], pendingQuestions: [] };
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
        run.startedAt = line.startedAt;
        run.stepTimeoutMs = line.stepTimeoutMs;
        run.maxStepRetries = line.maxStepRetries;
        bumpWrite(run, line.startedAt);
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
          });
        }
        // The human-question gate: a `paused` terminal arms that step's pending
        // question; any later terminal for the same step (an answered pause
        // re-writes it as `done`) retires it. "Latest wins", forward-folded,
        // per step — a parallel stage's siblings are settled independently.
        if (line.status === "paused") pending.set(line.id, line.question ?? "");
        else pending.delete(line.id);
        bumpWrite(run, line.endedAt);
        break;
      }
      case "budget":
        if (line.spentUsd !== undefined) run.spentUsd = line.spentUsd;
        if (line.turns !== undefined) run.turns = line.turns;
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
    ...(run.turns === undefined ? {} : { turns: run.turns }),
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.lastWriteTs === undefined ? {} : { lastWriteTs: run.lastWriteTs }),
    ...(run.pendingQuestion === undefined ? {} : { pendingQuestion: run.pendingQuestion }),
    pendingQuestions: run.pendingQuestions,
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
      lines.push(`    answer with /workflow resume ${row.runId} <answer>`);
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
  const facts: string[] = [];
  if (run.spentUsd !== undefined) facts.push(`spend $${run.spentUsd.toFixed(2)}`);
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
    }
  }
  if (state === "paused") {
    lines.push("");
    // The detail view has the room to list every owed question with the step
    // that raised it, which is what an operator needs to answer them.
    if (run.pendingQuestions.length === 1 && run.pendingQuestion) {
      lines.push(`Awaiting a human answer: ${run.pendingQuestion}`);
    } else if (run.pendingQuestions.length > 1) {
      lines.push(`Awaiting ${run.pendingQuestions.length} human answers:`);
      for (const q of run.pendingQuestions) lines.push(`  ${q.stepId}: ${q.question}`);
    }
    lines.push(`Answer with /workflow resume ${run.runId} <answer>`);
  } else if (state === "stalled" || state === "resumable") {
    lines.push("");
    lines.push(`Resume with /workflow resume ${run.runId}`);
  }
  return lines;
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
 * @param root - The `~/.arcturn/workflow-runs` directory.
 * @returns Folded runs, in no particular order (the formatter sorts them).
 */
export async function readWorkflowRuns(root: string): Promise<JournalRun[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const runs: JournalRun[] = [];
  await Promise.all(
    entries.map(async (name) => {
      const lines = await readJournalLines(join(root, name));
      if (lines.length === 0) return;
      runs.push(foldJournal(name, lines));
    }),
  );
  return runs;
}

/**
 * Read and fold one run's journal by id.
 *
 * @param root - The `~/.arcturn/workflow-runs` directory.
 * @param runId - The run id (directory name).
 */
export async function readWorkflowRun(
  root: string,
  runId: string,
): Promise<JournalRun | undefined> {
  const lines = await readJournalLines(join(root, runId));
  if (lines.length === 0) return undefined;
  return foldJournal(runId, lines);
}
