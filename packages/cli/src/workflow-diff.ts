/**
 * `/workflow diff` — put two runs side by side and say what actually changed.
 *
 * The question this answers is the one a fork or a race immediately creates:
 * *was the second run better, and where?* Until now the only way to ask it was
 * to open two `journal.jsonl` files and read them in parallel, which is how
 * "the second run was faster" and "the second run skipped a step" end up
 * looking the same.
 *
 * Everything is read from the durable journal — no discovery, no engine, no
 * agent, so a run in another terminal (or one whose workflow file has since
 * been deleted) is still comparable. Every field is read DEFENSIVELY: the
 * journal is an append-only file written by several versions of this program,
 * and a torn line or a field a newer run carries and an older one does not is
 * an ordinary state, not an error. A fact this module cannot read is
 * `undefined` — never `0`, never `"?"` masquerading as data.
 *
 * Two runs of *different* workflows are still comparable, and the renderer
 * says so rather than pretending: rows align by step id, which is what a
 * refactored pipeline keeps stable even when its stages move.
 *
 * @packageDocumentation
 */

import { join } from "node:path";
import { formatCost, formatDuration, formatTokens, totalTokens } from "./format.js";
import { FANCY_GLYPHS, type GlyphSet } from "./glyphs.js";
import { raceSummaryFacts, type StepRaceSummary } from "./workflow-race.js";
import type { JournalLine } from "./workflow-run.js";
import { readJournalLines } from "./workflow-run.js";

/** One run's headline facts. */
export interface DiffRunFacts {
  readonly runId: string;
  readonly workflow?: string;
  /** The `runEnd` status, when the run finished. */
  readonly status?: string;
  /** True when the run's header says it was forked from another run. */
  readonly forkedFrom?: { readonly runId: string; readonly at: string };
  /** How many of the source run's patches a `--revert` fork undid before starting. */
  readonly revertedPatches?: number;
  readonly steps: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
  /** False when any step of the run was unpriced — see {@link formatWorkflowDiff}. */
  readonly costKnown: boolean;
  readonly tokens: number;
}

/** What one step of one run did, as far as its journal recorded it. */
export interface DiffStepFacts {
  readonly stepId: string;
  readonly stage: number;
  readonly role?: string;
  readonly status: string;
  readonly attempts?: number;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly writes?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
  readonly tokens?: number;
  /** The model the step's last turn ran on, when the journal recorded one. */
  readonly model?: string;
  /** MODEL RACING: how this step's race resolved. */
  readonly race?: StepRaceSummary;
  /** A `[judges:N]` panel's verdict, when the run recorded one. */
  readonly judges?: string;
  /** A `[contract:…]` reply's scalar fields, when the run recorded one. */
  readonly contract?: string;
  /** The first non-empty line of the step's output. */
  readonly firstLine?: string;
}

/** One step, in both runs. */
export interface DiffRow {
  readonly stepId: string;
  readonly stage?: number;
  readonly role?: string;
  readonly a?: DiffStepFacts;
  readonly b?: DiffStepFacts;
  /** True when anything a reader would act on is different between the two. */
  readonly differs: boolean;
  /** The first output line, when the two runs' differ. */
  readonly textA?: string;
  readonly textB?: string;
}

/** Two runs, compared. */
export interface WorkflowRunDiff {
  readonly a: DiffRunFacts;
  readonly b: DiffRunFacts;
  /** False when the two runs ran different workflows; rows align by step id. */
  readonly sameWorkflow: boolean;
  readonly rows: readonly DiffRow[];
}

/** Read one run's journal and reduce it to comparable facts. */
function readRun(
  lines: readonly JournalLine[],
  runId: string,
): {
  facts: DiffRunFacts;
  steps: Map<string, DiffStepFacts>;
} {
  const steps = new Map<string, DiffStepFacts>();
  let workflow: string | undefined;
  let status: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let forkedFrom: { runId: string; at: string } | undefined;
  let revertedPatches: number | undefined;
  let costKnown = true;
  let costUsd = 0;
  let tokens = 0;

  for (const line of lines) {
    if (line.kind === "run") {
      workflow = line.workflow;
      startedAt = line.startedAt;
      if (line.forkedFrom !== undefined && typeof line.forkedFrom.runId === "string") {
        forkedFrom = { runId: line.forkedFrom.runId, at: line.forkedFrom.at };
      }
      continue;
    }
    if (line.kind === "forkRevert") {
      // A fork that rewound the checkout is a materially different run from
      // one that did not, so the headline says so.
      if (typeof line.patches === "number" && line.patches > 0) revertedPatches = line.patches;
      continue;
    }
    if (line.kind === "runEnd") {
      status = line.status;
      endedAt = line.ts;
      continue;
    }
    if (line.kind !== "stepEnd") continue;
    const usage = line.usage ?? {};
    const stepTokens = totalTokens(usage);
    // THE RUN'S TOTALS ARE THE BILL. A raced step spent every arm's tokens,
    // and `raceUsage` is what the run was actually charged — the per-step
    // columns below stay the winner's (that is the answer the step produced),
    // but a diff that compares two runs on cost has to compare what they cost.
    const billed = line.raceUsage ?? usage;
    tokens += totalTokens(billed);
    if (typeof billed.costUsd === "number") costUsd += billed.costUsd;
    else costKnown = false;
    const activity = line.activity;
    const duration =
      typeof line.startedAt === "number" && typeof line.endedAt === "number"
        ? Math.max(0, line.endedAt - line.startedAt)
        : undefined;
    if (typeof line.endedAt === "number" && (endedAt === undefined || line.endedAt > endedAt)) {
      endedAt = line.endedAt;
    }
    // Latest terminal per step wins, exactly as every other fold of this file
    // does: a resume appends, so the newest line is the one that describes it.
    steps.set(line.id, {
      stepId: line.id,
      stage: line.stage,
      ...(line.agent === undefined ? {} : { role: line.agent }),
      status: line.status,
      ...(typeof line.attempts === "number" ? { attempts: line.attempts } : {}),
      ...(activity === undefined
        ? {}
        : {
            turns: activity.turns,
            toolCalls: Object.values(activity.toolCalls ?? {}).reduce(
              (sum, count) => sum + count,
              0,
            ),
            writes: activity.writes,
          }),
      ...(duration === undefined ? {} : { durationMs: duration }),
      ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
      tokens: stepTokens,
      ...(line.lastTurn?.model === undefined ? {} : { model: line.lastTurn.model }),
      ...(raceSummaryFacts(line.race) === undefined
        ? {}
        : { race: raceSummaryFacts(line.race) as StepRaceSummary }),
      ...(describeJudges(line.judges) === undefined ? {} : { judges: describeJudges(line.judges) }),
      ...(describeContractRecord(line.contract) === undefined
        ? {}
        : { contract: describeContractRecord(line.contract) }),
      ...(firstLineOf(line.text) === undefined ? {} : { firstLine: firstLineOf(line.text) }),
    });
  }

  return {
    facts: {
      runId,
      ...(workflow === undefined ? {} : { workflow }),
      ...(status === undefined ? {} : { status }),
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
      ...(revertedPatches === undefined ? {} : { revertedPatches }),
      steps: steps.size,
      ...(startedAt === undefined || endedAt === undefined
        ? {}
        : { durationMs: Math.max(0, endedAt - startedAt) }),
      ...(costKnown ? { costUsd } : {}),
      costKnown,
      tokens,
    },
    steps,
  };
}

/**
 * A `[judges:N]` panel in one phrase, read defensively.
 *
 * Written by another seam of the engine, so nothing here assumes the shape is
 * present or complete — an older run has no judges field at all.
 *
 * @param value - Whatever the journal line carried.
 */
function describeJudges(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as { agreed?: unknown; verdicts?: unknown; arbitrated?: unknown };
  const verdicts = Array.isArray(raw.verdicts)
    ? raw.verdicts.filter((one): one is string => typeof one === "string")
    : [];
  if (typeof raw.agreed !== "boolean" && verdicts.length === 0) return undefined;
  const head = raw.agreed === true ? "agreed" : raw.arbitrated === true ? "arbitrated" : "split";
  return verdicts.length === 0 ? head : `${head} (${verdicts.join(", ")})`;
}

/**
 * A validated contract reply in one phrase.
 *
 * Deliberately NOT `contracts.ts`'s `describeContractValue`: that one needs the
 * contract *declaration*, which a diff of two arbitrary runs has no way to
 * obtain (the workflow file may be gone). Scalars only, for the same reason —
 * an array of reasons is the body of the answer, not a headline.
 *
 * @param value - Whatever the journal line carried.
 */
function describeContractRecord(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") parts.push(`${key}=${raw}`);
    else if (typeof raw === "number" || typeof raw === "boolean") parts.push(`${key}=${raw}`);
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** The first non-empty line of a step's output, capped. */
function firstLineOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed.length > 90 ? `${trimmed.slice(0, 89)}…` : trimmed;
  }
  return undefined;
}

/** Fields whose disagreement is worth marking a row for. */
function rowDiffers(a: DiffStepFacts | undefined, b: DiffStepFacts | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return (
    a.status !== b.status ||
    a.attempts !== b.attempts ||
    a.model !== b.model ||
    a.race?.winner !== b.race?.winner ||
    a.judges !== b.judges ||
    a.contract !== b.contract ||
    a.firstLine !== b.firstLine ||
    (a.writes ?? 0) !== (b.writes ?? 0)
  );
}

/**
 * Compare two runs by id.
 *
 * @param root - `~/.arcturn/workflow-runs`.
 * @param runA - The baseline run.
 * @param runB - The run being judged against it.
 * @returns The comparison, or a single-sentence complaint naming the run that
 *   could not be read.
 */
export async function diffWorkflowRuns(
  root: string,
  runA: string,
  runB: string,
): Promise<WorkflowRunDiff | { error: string }> {
  const linesA = await readJournalLines(join(root, runA));
  if (linesA.length === 0) return { error: `No run journal for "${runA}". Try /workflow status.` };
  const linesB = await readJournalLines(join(root, runB));
  if (linesB.length === 0) return { error: `No run journal for "${runB}". Try /workflow status.` };

  const a = readRun(linesA, runA);
  const b = readRun(linesB, runB);

  // Step ids, in A's order first (the baseline reads top to bottom) and then
  // whatever B has that A does not — a step a fork added shows up rather than
  // vanishing because the baseline never had it.
  const ids: string[] = [...a.steps.keys()];
  for (const id of b.steps.keys()) if (!ids.includes(id)) ids.push(id);
  ids.sort(compareStepIds);

  const rows: DiffRow[] = ids.map((stepId) => {
    const left = a.steps.get(stepId);
    const right = b.steps.get(stepId);
    const differs = rowDiffers(left, right);
    return {
      stepId,
      ...((left?.stage ?? right?.stage) === undefined
        ? {}
        : { stage: left?.stage ?? right?.stage }),
      ...((left?.role ?? right?.role) === undefined ? {} : { role: left?.role ?? right?.role }),
      ...(left === undefined ? {} : { a: left }),
      ...(right === undefined ? {} : { b: right }),
      differs,
      ...(differs && left?.firstLine !== right?.firstLine
        ? {
            ...(left?.firstLine === undefined ? {} : { textA: left.firstLine }),
            ...(right?.firstLine === undefined ? {} : { textB: right.firstLine }),
          }
        : {}),
    };
  });

  return {
    a: a.facts,
    b: b.facts,
    sameWorkflow: a.facts.workflow === b.facts.workflow,
    rows,
  };
}

/** Sort step ids the way a workflow file writes them: 1, 2, 2.1, 2.2, 10. */
function compareStepIds(left: string, right: string): number {
  const l = left.split(".").map((part) => Number.parseInt(part, 10));
  const r = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const a = l[i];
    const b = r[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (Number.isNaN(a) || Number.isNaN(b)) return left.localeCompare(right);
    if (a !== b) return a - b;
  }
  return 0;
}

/** `unknown` rather than a fabricated zero — the house rule for missing facts. */
function orUnknown(text: string | undefined): string {
  return text ?? "unknown";
}

/** One step's facts as one cell. */
function cell(facts: DiffStepFacts | undefined): string {
  if (facts === undefined) return "—";
  const parts = [facts.status];
  if (facts.attempts !== undefined && facts.attempts > 1) parts.push(`${facts.attempts}a`);
  if (facts.turns !== undefined) parts.push(`${facts.turns}t`);
  if (facts.toolCalls !== undefined) parts.push(`${facts.toolCalls}c`);
  if (facts.writes !== undefined && facts.writes > 0) parts.push(`${facts.writes}w`);
  if (facts.durationMs !== undefined) parts.push(formatDuration(facts.durationMs));
  parts.push(facts.costUsd === undefined ? "unknown" : formatCost(facts.costUsd));
  return parts.join(" ");
}

/**
 * Render the comparison for a terminal.
 *
 * @param diff - The comparison.
 * @param glyphs - Glyph set.
 */
export function formatWorkflowDiff(
  diff: WorkflowRunDiff,
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  const lines: string[] = [
    `A ${diff.a.runId} — ${diff.a.workflow ?? "?"} [${orUnknown(diff.a.status)}]` +
      (diff.a.forkedFrom === undefined
        ? ""
        : ` (forked from ${diff.a.forkedFrom.runId} at ${diff.a.forkedFrom.at})`) +
      (diff.a.revertedPatches === undefined
        ? ""
        : ` (reverted ${diff.a.revertedPatches} patch(es) first)`),
    `B ${diff.b.runId} — ${diff.b.workflow ?? "?"} [${orUnknown(diff.b.status)}]` +
      (diff.b.forkedFrom === undefined
        ? ""
        : ` (forked from ${diff.b.forkedFrom.runId} at ${diff.b.forkedFrom.at})`) +
      (diff.b.revertedPatches === undefined
        ? ""
        : ` (reverted ${diff.b.revertedPatches} patch(es) first)`),
  ];
  if (!diff.sameWorkflow) {
    lines.push(
      "These are two different workflows; rows are aligned by step id, which is the only thing they share.",
    );
  }
  lines.push("");
  lines.push("    step  role            A → B");
  for (const row of diff.rows) {
    const mark = row.differs ? glyphs.warn : " ";
    const role = row.role === undefined ? "" : `@${row.role}`;
    lines.push(`  ${mark} ${row.stepId.padEnd(5)} ${role.padEnd(15)} ${cell(row.a)}`);
    lines.push(`  ${" ".repeat(1)} ${" ".repeat(5)} ${" ".repeat(15)} ${cell(row.b)}`);
    const detail: string[] = [];
    if (row.a?.model !== row.b?.model) {
      detail.push(`model ${orUnknown(row.a?.model)} → ${orUnknown(row.b?.model)}`);
    }
    if (row.a?.race?.winner !== row.b?.race?.winner) {
      detail.push(`race ${orUnknown(row.a?.race?.winner)} → ${orUnknown(row.b?.race?.winner)}`);
    }
    if (row.a?.judges !== row.b?.judges) {
      detail.push(`judges ${orUnknown(row.a?.judges)} → ${orUnknown(row.b?.judges)}`);
    }
    if (row.a?.contract !== row.b?.contract) {
      detail.push(`contract ${orUnknown(row.a?.contract)} → ${orUnknown(row.b?.contract)}`);
    }
    for (const one of detail) lines.push(`      ${one}`);
    if (row.textA !== undefined || row.textB !== undefined) {
      lines.push(`      A: ${row.textA ?? "—"}`);
      lines.push(`      B: ${row.textB ?? "—"}`);
    }
  }
  lines.push("");
  lines.push(
    `Totals  A ${totalsOf(diff.a)}${glyphs.dot ? ` ${glyphs.dot} ` : "  "}B ${totalsOf(diff.b)}`,
  );
  const differing = diff.rows.filter((row) => row.differs).length;
  lines.push(
    differing === 0
      ? "No step differs between these runs."
      : `${differing} of ${diff.rows.length} step(s) differ.`,
  );
  return lines;
}

/** One run's totals line. */
function totalsOf(facts: DiffRunFacts): string {
  const parts = [`${facts.steps} step(s)`];
  if (facts.durationMs !== undefined) parts.push(formatDuration(facts.durationMs));
  parts.push(
    facts.costKnown && facts.costUsd !== undefined ? formatCost(facts.costUsd) : "unknown",
  );
  parts.push(formatTokens(facts.tokens));
  return parts.join(" ");
}

/** The comparison as structured json. */
export function formatWorkflowDiffJson(diff: WorkflowRunDiff): string {
  return JSON.stringify(diff, null, 2);
}
