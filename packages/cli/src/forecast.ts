/**
 * RUN FORECASTING — `/workflow forecast <name>` and the run-start banner.
 *
 * Before a workflow spends a token, this module answers "what has this
 * pipeline cost before, on the models it will actually use". It is read-only
 * and best-effort over exactly one source of truth: the local insights ledger
 * (`~/.arcturn/insights/events.jsonl` and its one rotated generation). No
 * network, no new files, nothing that can slow or fail a run — a forecast
 * that cannot be built is a forecast that says so, never an error.
 *
 * Two moving parts:
 *
 * - {@link forecastWorkflow} — pure. Folds `step-end` / `park` / `run-end`
 *   ledger events into a per-stage prediction, replicating the model each
 *   stage will actually run on (see {@link resolveForecastStepModel}) so the
 *   history it reports is history *for that model*, not history in general.
 * - {@link renderForecast} / {@link renderForecastBanner} / {@link
 *   formatForecastJson} — pure rendering over the result above.
 *
 * ## Why cost needs a pricing lookup and history alone cannot give it
 *
 * `StepEndRecord` (insights.ts) carries token counts but never a dollar
 * figure — "money rides on `run-end`'s own `costUsd`", by design, because a
 * run's cost is priced once at the provider boundary. A per-STAGE dollar
 * estimate therefore cannot be read off the ledger directly; it has to be
 * *recomputed* from the stage's historical token usage against the pricing
 * table of the model that generated it, one sample at a time — which is what
 * {@link ForecastWorkflowOptions.resolveModelSpec} is for. A sample whose
 * model cannot be priced (a coding-plan endpoint, an unrecognised id) makes
 * the whole stage's cost "unknown" rather than a silently wrong `$0.00`,
 * exactly as `formatCost`'s callers elsewhere in this codebase already do.
 *
 * @packageDocumentation
 */

import { calculateCostUsd } from "@arcturn/ai";
import type { ModelSpec, Usage } from "@arcturn/types";
import type { AgentDef } from "./agents.js";
import { formatCost, formatDuration, formatTokens } from "./format.js";
import { FANCY_GLYPHS, type GlyphSet } from "./glyphs.js";
import type { InsightsEvent, ParkRecord, RunEndRecord, StepEndRecord } from "./insights.js";
import type { Workflow, WorkflowStep } from "./workflow.js";

// ---------------------------------------------------------------------------
// Model resolution — replicating the run's own precedence
// ---------------------------------------------------------------------------

/** The slice of the role catalog {@link resolveForecastStepModel} needs. */
export interface ForecastRoleLookup {
  get(name: string): Pick<AgentDef, "model"> | undefined;
}

/**
 * Resolve the model id a step will actually run on — the SAME precedence the
 * engine itself uses (`workflow.ts`'s pre-pass, `runWorktreeStep`, and the
 * worktree lane's `spawn`): `[tag]` on the step wins, then the role's own
 * `model:`, then the host's subagent default. Mirrored here rather than
 * imported because the engine's version is entangled with dispatch (it
 * refuses a step outright on an unknown tag); a forecast must never throw —
 * an unresolvable `[tag]` simply forecasts as "no model, no history" for that
 * stage, same as a step whose role carries no history yet.
 *
 * @param step - The workflow step (only `modelTag`/`agent` are read).
 * @param roles - The run's role catalog.
 * @param resolveTag - Resolves a `[tag]` or a role's `model:` id to a spec —
 *   hand it the SAME resolver the run itself will use (`composeTagResolver`
 *   composed with the host's `resolveModelTag`), so a forecast is byte-
 *   identical to what the run would pick.
 * @param subagentDefault - The host's fallback when neither names a model.
 */
export function resolveForecastStepModel(
  step: Pick<WorkflowStep, "modelTag" | "agent">,
  roles: ForecastRoleLookup,
  resolveTag: (tag: string) => ModelSpec | undefined,
  subagentDefault: () => ModelSpec | undefined,
): string | undefined {
  if (step.modelTag !== undefined) return resolveTag(step.modelTag)?.id;
  if (step.agent !== undefined) {
    const role = roles.get(step.agent);
    if (role?.model !== undefined) {
      const spec = resolveTag(role.model);
      if (spec) return spec.id;
    }
  }
  return subagentDefault()?.id;
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over an ALREADY-SORTED ascending array.
 *
 * `rank = ceil(p/100 * n)`, clamped to `[1, n]` — the standard nearest-rank
 * definition, chosen over interpolation because every value here (a
 * duration, a token count, a dollar figure) is one that actually happened;
 * interpolating between two real runs would report a number no run produced.
 *
 * @param sortedAsc - Values, ascending. Empty reads back as `0`.
 * @param p - Percentile, `0`–`100`.
 */
function nearestRank(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1] ?? 0;
}

function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The forecast
// ---------------------------------------------------------------------------

/** Where a stage's historical sample came from, poorest to best match. */
export type ForecastHistorySource = "step" | "step-any-model" | "role";

/** A cheaper model with a lower observed stop rate on this same step. */
export interface ForecastAlternative {
  readonly model: string;
  readonly stopRate: number;
  readonly samples: number;
}

/** One stage's historical prediction, when the ledger has anything to say. */
export interface ForecastHistory {
  /** Where these samples came from — see {@link ForecastHistorySource}. */
  readonly source: ForecastHistorySource;
  /** How many terminals this prediction is built from. */
  readonly samples: number;
  readonly p50DurationMs: number;
  readonly p90DurationMs: number;
  /** `undefined` when at least one sample's model could not be priced. */
  readonly costUsd?: number;
  readonly costKnown: boolean;
  readonly p50Tokens: number;
  /** `(parks + failed terminals) / samples`, over these same samples. */
  readonly stopRate: number;
  /** A different model seen on this step with a lower stop rate, if any. */
  readonly alternative?: ForecastAlternative;
}

/** One stage of the forecast — one row of `/workflow forecast`. */
export interface ForecastStage {
  readonly stepId: string;
  readonly role?: string;
  /** The model this run would actually use, resolved the same way the run resolves it. */
  readonly model?: string;
  /**
   * MODEL RACING: this row is ONE ARM of a `[race:a|b]` step, not the whole
   * step. A raced step has no single model, so it forecasts as one row per
   * arm, each bucketed on that arm's own samples — the winner's terminals
   * under the winner, the loser's under the loser. Several rows therefore
   * share a `stepId`. Absent (rather than `false`) on every ordinary stage,
   * so an existing `--json` reader sees exactly what it saw before.
   */
  readonly raceArm?: true;
  /**
   * MODEL RACING: of this step's arms, the one the totals take their wall
   * clock from — the arm that has won this step most often (see
   * {@link ForecastTotals}). Set on exactly one arm of each raced step.
   */
  readonly raceWinner?: true;
  /** Absent when the ledger has no usable history for this stage at all. */
  readonly history?: ForecastHistory;
}

/**
 * The forecast's totals line.
 *
 * A raced step is the one place where duration and cost part company, and
 * they are billed differently on purpose: a race is over the moment its first
 * arm is over, so the run's WALL CLOCK is the winning arm's alone — never the
 * sum of the arms, never a loser's — while every arm's tokens were actually
 * paid for, so the run's SPEND is all of them. Duration and stop risk
 * therefore count only the arm marked {@link ForecastStage.raceWinner}; cost
 * counts every arm.
 */
export interface ForecastTotals {
  /**
   * Sum of every timed stage's `p50DurationMs` (a stage with no history
   * contributes `0`; a raced step contributes its winning arm only).
   */
  readonly p50DurationMs: number;
  /** `undefined` when any stage that HAS history could not price its cost. */
  readonly costUsd?: number;
  readonly costKnown: boolean;
  /**
   * `1 - Π(1 - stopRate_i)` over every timed stage (a stage with no history
   * contributes `0` risk; a raced step contributes its winning arm only).
   */
  readonly stopProbability: number;
}

/** What the local ledger says about this workflow's *whole runs*, as a sanity check. */
export interface ForecastRunHistory {
  readonly runs: number;
  readonly p50DurationMs: number;
  readonly costUsd?: number;
  readonly costKnown: boolean;
}

/** Everything `/workflow forecast` prints, and exactly what `--json` emits. */
export interface WorkflowForecast {
  readonly workflow: string;
  readonly windowDays: number;
  readonly stages: readonly ForecastStage[];
  readonly totals: ForecastTotals;
  readonly runHistory: ForecastRunHistory;
  /** Stages whose `history` is `undefined` — the confidence line's caveat. */
  readonly stagesWithoutHistory: number;
}

/** Options for {@link forecastWorkflow}. */
export interface ForecastWorkflowOptions {
  readonly workflow: Workflow;
  /** The run's role catalog — a map or a resolver, either is accepted. */
  readonly roles: ReadonlyMap<string, AgentDef> | ((name: string) => AgentDef | undefined);
  /** The model each step would actually run on — see {@link resolveForecastStepModel}. */
  readonly resolveStepModel: (step: WorkflowStep) => string | undefined;
  /**
   * Resolves a model id to its pricing spec, for repricing historical token
   * usage (see the module doc). Omit and every stage's cost reads "unknown".
   */
  readonly resolveModelSpec?: (modelId: string) => ModelSpec | undefined;
  /** Ledger events, both generations, any order. */
  readonly events: readonly InsightsEvent[];
  /** Clock. */
  readonly now: number;
  /** How far back to look. Defaults to `30`. */
  readonly windowDays?: number;
}

function roleLookup(
  roles: ForecastWorkflowOptions["roles"],
): (name: string) => AgentDef | undefined {
  return typeof roles === "function" ? roles : (name) => roles.get(name);
}

function allSteps(workflow: Workflow): WorkflowStep[] {
  return workflow.stages.flatMap((stage) => stage.steps);
}

function usageTotal(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Failed-plus-parked over samples, and the two counts it is built from.
 *
 * A park is attributed to `records` when its own `(runId, stepId)` pair
 * shows up among them — which is exactly the run/step pairs `records` was
 * already filtered to, so this reads as "this bucket's own park", never
 * another model's or another workflow's, with no extra join needed.
 *
 * @param records - The step-end terminals this bucket is built from.
 * @param parks - Every `park` event in the window (unfiltered; matched here).
 */
function stopStats(
  records: readonly StepEndRecord[],
  parks: readonly ParkRecord[],
): { samples: number; failed: number; parked: number; stopRate: number } {
  const samples = records.length;
  const failed = records.filter(isStop).length;
  const keys = new Set(records.map((r) => `${r.runId} ${r.stepId}`));
  const parked = parks.filter((p) => keys.has(`${p.runId} ${p.stepId}`)).length;
  return { samples, failed, parked, stopRate: samples === 0 ? 0 : (failed + parked) / samples };
}

/**
 * Did this terminal STOP anything?
 *
 * `failed` means "stopped" for every ordinary step. A race's losing arm is
 * the exception, and the reason this is a function: it is recorded `failed`
 * whatever happened to it, and the arm the engine cut off the instant another
 * one won (`aborted`) — or the one that produced a perfectly good answer a
 * moment late (`slower`) — did not fail at anything. Only an arm that failed
 * on its own terms, or produced nothing, is a stop. Its duration and its
 * tokens count either way: that is what makes a lost arm a real sample of its
 * own model on this exact step. See {@link StepEndRecord.raceOutcome}.
 *
 * @param record - One step-end terminal.
 */
function isStop(record: StepEndRecord): boolean {
  if (record.status !== "failed") return false;
  if (record.race !== "lost") return true;
  return record.raceOutcome === "failed" || record.raceOutcome === "void";
}

/** Price one step-end record's usage against its OWN model. `undefined` = unpriced. */
function priceSample(
  record: StepEndRecord,
  resolveModelSpec: ((modelId: string) => ModelSpec | undefined) | undefined,
): number | undefined {
  if (record.model === undefined || resolveModelSpec === undefined) return undefined;
  const spec = resolveModelSpec(record.model);
  if (!spec) return undefined;
  return calculateCostUsd(spec, { ...record.usage });
}

/** Build a {@link ForecastHistory} from one bucket of terminals, or `undefined` if empty. */
function summarize(
  records: readonly StepEndRecord[],
  source: ForecastHistorySource,
  parks: readonly ParkRecord[],
  resolveModelSpec: ((modelId: string) => ModelSpec | undefined) | undefined,
  alternative: ForecastAlternative | undefined,
): ForecastHistory | undefined {
  if (records.length === 0) return undefined;
  const { samples, stopRate } = stopStats(records, parks);
  const durations = ascending(records.map((r) => r.durationMs));
  const tokens = ascending(records.map((r) => usageTotal(r.usage)));
  const prices = records.map((r) => priceSample(r, resolveModelSpec));
  const costKnown = prices.every((p) => p !== undefined);
  const costs = costKnown ? ascending(prices as number[]) : [];
  return {
    source,
    samples,
    p50DurationMs: nearestRank(durations, 50),
    p90DurationMs: nearestRank(durations, 90),
    ...(costKnown ? { costUsd: nearestRank(costs, 50) } : {}),
    costKnown,
    p50Tokens: nearestRank(tokens, 50),
    stopRate,
    ...(alternative === undefined ? {} : { alternative }),
  };
}

/** The best other model seen on this exact step, if its stop rate beats `currentStopRate`. */
function bestAlternative(
  sameStepAnyModel: readonly StepEndRecord[],
  currentModel: string | undefined,
  currentStopRate: number,
  parks: readonly ParkRecord[],
): ForecastAlternative | undefined {
  const byModel = new Map<string, StepEndRecord[]>();
  for (const record of sameStepAnyModel) {
    if (record.model === undefined || record.model === currentModel) continue;
    const bucket = byModel.get(record.model) ?? [];
    bucket.push(record);
    byModel.set(record.model, bucket);
  }
  let best: ForecastAlternative | undefined;
  for (const [model, records] of byModel) {
    const { samples, stopRate } = stopStats(records, parks);
    if (stopRate >= currentStopRate) continue;
    if (
      best === undefined ||
      stopRate < best.stopRate ||
      (stopRate === best.stopRate &&
        (samples > best.samples || (samples === best.samples && model < best.model)))
    ) {
      best = { model, stopRate, samples };
    }
  }
  return best;
}

/**
 * MODEL RACING: the model ids a `[race:a|b]` step will actually run on, in
 * the order the step declares them.
 *
 * A raced step has no single model — it runs one brief on two or three at
 * once — which is why it cannot be forecast as one row, and why the step's
 * own `[tag]` precedence (see {@link resolveForecastStepModel}) has nothing
 * to say about it. The tags resolve through the same
 * {@link ForecastWorkflowOptions.resolveModelSpec} the cost repricing uses
 * (the command hands both the run's own resolver), and a tag this machine no
 * longer knows falls back to its own text so the arm still gets a row instead
 * of quietly vanishing. Duplicates collapse: two tags can name one model, and
 * one model is one arm.
 *
 * @param race - {@link WorkflowStep.race}, in written order.
 * @param resolveModelSpec - The run's tag/model resolver, if any.
 */
function raceArmModels(
  race: readonly string[],
  resolveModelSpec: ((modelId: string) => ModelSpec | undefined) | undefined,
): string[] {
  const seen = new Set<string>();
  const arms: string[] = [];
  for (const tag of race) {
    const model = resolveModelSpec?.(tag)?.id ?? tag;
    if (seen.has(model)) continue;
    seen.add(model);
    arms.push(model);
  }
  return arms;
}

/**
 * Which arm of a race the run's WALL CLOCK will belong to.
 *
 * A race ends when its first arm ends, so the duration and the stop risk the
 * totals carry are the winner's alone. The best guess at the next winner the
 * ledger can offer is the arm that has won this exact step most often before
 * (`race: "won"` terminals). Ties — including a step that has never raced
 * here — fall back to the FIRST DECLARED arm, because that rule is
 * deterministic in a way the alternatives are not: it does not depend on
 * ledger order, on model ids sorting, or on which arm happens to be listed
 * first in a `Map`, so two forecasts of the same workflow over the same
 * ledger always name the same arm.
 *
 * @param arms - The declared arms, in written order.
 * @param records - This step's terminals, all arms, already windowed.
 */
function historicalRaceWinner(
  arms: readonly string[],
  records: readonly StepEndRecord[],
): string | undefined {
  let winner = arms[0];
  let mostWins = -1;
  for (const arm of arms) {
    const wins = records.filter((r) => r.model === arm && r.race === "won").length;
    if (wins > mostWins) {
      winner = arm;
      mostWins = wins;
    }
  }
  return winner;
}

/**
 * The stages the totals take DURATION and STOP RISK from: every ordinary
 * stage, plus one arm — the historical winner — of each raced step. See
 * {@link ForecastTotals} for why cost does not use this filter.
 *
 * @param stages - Every forecast row.
 */
function timedStages(stages: readonly ForecastStage[]): ForecastStage[] {
  return stages.filter((stage) => stage.raceArm !== true || stage.raceWinner === true);
}

/** Default look-back window, in days. */
export const DEFAULT_FORECAST_WINDOW_DAYS = 30;

/**
 * Predict duration, cost, tokens and stop risk for every stage of a workflow,
 * from the local insights ledger. Pure — no clock but the one handed in, no
 * filesystem, never throws.
 *
 * @param options - The workflow, its role catalog, model resolution, the
 *   ledger and the window to look back over.
 */
export function forecastWorkflow(options: ForecastWorkflowOptions): WorkflowForecast {
  const windowDays = options.windowDays ?? DEFAULT_FORECAST_WINDOW_DAYS;
  const sinceMs = options.now - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = options.events.filter((event) => event.ts >= sinceMs);

  const stepEnds = inWindow.filter((e): e is StepEndRecord => e.kind === "step-end");
  // Superseded terminals are earlier ATTEMPTS of a step the final terminal
  // already describes, so counting them would sample the same step twice —
  // with one exception. A race's losing arm is `superseded` for that reason
  // (nothing that counts steps may count it) but it is not another attempt at
  // all: it is a different MODEL answering this exact step, at its own speed
  // and its own price, which is the one thing the ledger can learn that no
  // single-model history can. See {@link isStop} for the half of this that
  // keeps "the winner appeared first" from reading as a failure.
  const nonSuperseded = stepEnds.filter((e) => e.superseded !== true || e.race === "lost");
  const parks = inWindow.filter((e): e is ParkRecord => e.kind === "park");
  const runEnds = inWindow.filter(
    (e): e is RunEndRecord => e.kind === "run-end" && e.workflow === options.workflow.name,
  );

  const roles = roleLookup(options.roles);
  const stages: ForecastStage[] = allSteps(options.workflow).flatMap((step): ForecastStage[] => {
    const model = options.resolveStepModel(step);
    // The role's OWN name from the catalog, when it is still loaded — a
    // workflow authored before a role file was renamed would otherwise
    // forecast under a name the ledger never recorded anything against.
    // Falls back to the step's own `@role` text so a step naming an
    // unknown role still gets its role-history fallback a chance.
    const role = (step.agent === undefined ? undefined : roles(step.agent)?.name) ?? step.agent;

    const sameStepAnyModel = nonSuperseded.filter(
      (e) => e.workflow === options.workflow.name && e.stepId === step.id,
    );
    const sameStepSameModel =
      model === undefined ? [] : sameStepAnyModel.filter((e) => e.model === model);
    const roleHistory = (): ForecastHistory | undefined =>
      role === undefined
        ? undefined
        : summarize(
            nonSuperseded.filter((e) => e.role === role),
            "role",
            parks,
            options.resolveModelSpec,
            undefined,
          );

    // MODEL RACING: one row per arm, each on its OWN samples. A raced step
    // has no single model to label a row with, so labelling it with one — the
    // first declared arm, say — reports the arm that LOST every race under
    // durations the winner earned. Splitting is the only honest shape, and
    // the samples are already there: the ledger writes one terminal per arm,
    // the losers marked `superseded`/`race: "lost"`, which the filter above
    // deliberately keeps.
    if (step.race !== undefined && step.race.length > 0) {
      const arms = raceArmModels(step.race, options.resolveModelSpec);
      const winner = historicalRaceWinner(arms, sameStepAnyModel);
      return arms.map((arm) => {
        const ownSamples = sameStepAnyModel.filter((e) => e.model === arm);
        // No `step-any-model` fallback, and no alternative, for an arm: the
        // "other model on this step" IS the other arm of this same race, so
        // borrowing its numbers here would re-create exactly the mislabelling
        // this split exists to end ("consider racing the model you are
        // already racing"). An arm with nothing of its own drops straight to
        // role history instead.
        const armHistory =
          ownSamples.length > 0
            ? summarize(ownSamples, "step", parks, options.resolveModelSpec, undefined)
            : roleHistory();
        return {
          stepId: step.id,
          ...(role === undefined ? {} : { role }),
          model: arm,
          raceArm: true as const,
          ...(arm === winner ? { raceWinner: true as const } : {}),
          ...(armHistory === undefined ? {} : { history: armHistory }),
        };
      });
    }

    let history: ForecastHistory | undefined;
    if (sameStepSameModel.length > 0) {
      const alt = bestAlternative(
        sameStepAnyModel,
        model,
        stopStats(sameStepSameModel, parks).stopRate,
        parks,
      );
      history = summarize(sameStepSameModel, "step", parks, options.resolveModelSpec, alt);
    } else if (sameStepAnyModel.length > 0) {
      const alt = bestAlternative(
        sameStepAnyModel,
        model,
        stopStats(sameStepAnyModel, parks).stopRate,
        parks,
      );
      history = summarize(sameStepAnyModel, "step-any-model", parks, options.resolveModelSpec, alt);
    } else {
      history = roleHistory();
    }

    return [
      {
        stepId: step.id,
        ...(role === undefined ? {} : { role }),
        ...(model === undefined ? {} : { model }),
        ...(history === undefined ? {} : { history }),
      },
    ];
  });

  const stagesWithoutHistory = stages.filter((s) => s.history === undefined).length;
  // Duration and risk: the winning arm only — a race's wall clock is its
  // winner's. Cost: every arm, because every arm's tokens were spent. See
  // {@link ForecastTotals}.
  const timed = timedStages(stages);
  const p50DurationMs = timed.reduce((sum, s) => sum + (s.history?.p50DurationMs ?? 0), 0);
  const totalsCostKnown = stages.every((s) => s.history === undefined || s.history.costKnown);
  const costUsd = totalsCostKnown
    ? stages.reduce((sum, s) => sum + (s.history?.costUsd ?? 0), 0)
    : undefined;
  const stopProbability =
    1 - timed.reduce((product, s) => product * (1 - (s.history?.stopRate ?? 0)), 1);

  const runDurations = ascending(runEnds.map((r) => r.durationMs));
  const runCostKnown = runEnds.length === 0 ? true : runEnds.every((r) => r.costUsd !== undefined);
  const runCosts = runCostKnown ? ascending(runEnds.map((r) => r.costUsd ?? 0)) : [];

  return {
    workflow: options.workflow.name,
    windowDays,
    stages,
    totals: {
      p50DurationMs,
      ...(totalsCostKnown ? { costUsd } : {}),
      costKnown: totalsCostKnown,
      stopProbability,
    },
    runHistory: {
      runs: runEnds.length,
      p50DurationMs: nearestRank(runDurations, 50),
      ...(runCostKnown ? { costUsd: nearestRank(runCosts, 50) } : {}),
      costKnown: runCostKnown,
    },
    stagesWithoutHistory,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function sourceLabel(source: ForecastHistorySource): string {
  switch (source) {
    case "step":
      return "-";
    case "step-any-model":
      return "any model";
    case "role":
      return "from role history";
  }
}

/**
 * The `source` cell: where a row's numbers came from, and — for a raced step
 * — that this row is only one ARM of it, since several rows then share a step
 * number and the model column alone does not say why. An ordinary stage
 * renders exactly the string it always has.
 *
 * @param stage - One forecast row.
 */
function sourceCell(stage: ForecastStage): string {
  const parts: string[] = [];
  if (stage.raceArm === true) parts.push("race arm");
  if (stage.history === undefined) parts.push("no history");
  else {
    const label = sourceLabel(stage.history.source);
    if (label !== "-") parts.push(label);
  }
  return parts.length === 0 ? "-" : parts.join(", ");
}

/** `n runs of this workflow in the last <window> days; <k> stages have no history.` */
function confidenceLine(forecast: WorkflowForecast): string {
  const runs = forecast.runHistory.runs;
  const base = `${runs} run${runs === 1 ? "" : "s"} of this workflow in the last ${forecast.windowDays} days`;
  if (forecast.stagesWithoutHistory === 0) return `${base}.`;
  const n = forecast.stagesWithoutHistory;
  return `${base}; ${n} stage${n === 1 ? " has" : "s have"} no history.`;
}

/**
 * Render `/workflow forecast <name>` — a table per stage plus totals, a
 * historical whole-run sanity line, and the confidence line.
 *
 * @param forecast - From {@link forecastWorkflow}.
 * @param glyphs - Glyph set; the ASCII set is used on terminals that need it.
 */
export function renderForecast(
  forecast: WorkflowForecast,
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  const lines: string[] = [`Forecast — ${forecast.workflow}`];

  if (forecast.stages.length === 0) {
    lines.push("", "This workflow has no steps.");
    return lines;
  }

  const rows: string[][] = [];
  const altNotes: string[] = [];
  const raceNotes: string[] = [];
  for (const stage of forecast.stages) {
    const h = stage.history;
    rows.push([
      stage.stepId,
      stage.role === undefined ? "-" : `@${stage.role}`,
      stage.model ?? "-",
      h === undefined ? "-" : String(h.samples),
      h === undefined ? "-" : formatDuration(h.p50DurationMs),
      h === undefined ? "-" : formatDuration(h.p90DurationMs),
      h === undefined ? "-" : h.costKnown ? formatCost(h.costUsd ?? 0) : "unknown",
      h === undefined ? "-" : formatTokens(h.p50Tokens),
      h === undefined ? "-" : percent(h.stopRate),
      sourceCell(stage),
    ]);
    if (h?.alternative !== undefined) {
      altNotes.push(
        `    step ${stage.stepId}: ${percent(h.alternative.stopRate)} on ${h.alternative.model}, n=${h.alternative.samples}`,
      );
    }
    if (stage.raceWinner === true) {
      raceNotes.push(`    step ${stage.stepId}: timed on ${stage.model ?? "an unresolved model"}`);
    }
  }
  lines.push(
    "",
    ...pad(["step", "role", "model", "n", "p50", "p90", "cost", "tokens", "stop", "source"], rows),
  );
  if (altNotes.length > 0) {
    lines.push("", "Lower-risk alternative seen in history:", ...altNotes);
  }
  if (raceNotes.length > 0) {
    lines.push(
      "",
      "Raced steps run every arm at once: the totals take duration from the arm",
      "that has won most often, and cost from all of them.",
      ...raceNotes,
    );
  }

  lines.push(
    "",
    `Totals: p50 ${formatDuration(forecast.totals.p50DurationMs)} ${glyphs.dot} cost ` +
      `${forecast.totals.costKnown ? formatCost(forecast.totals.costUsd ?? 0) : "unknown"} ${glyphs.dot} ` +
      `stop risk ${percent(forecast.totals.stopProbability)}`,
  );
  lines.push(
    `Historical whole run: p50 ${formatDuration(forecast.runHistory.p50DurationMs)} ${glyphs.dot} cost ` +
      `${forecast.runHistory.costKnown ? formatCost(forecast.runHistory.costUsd ?? 0) : "unknown"} ` +
      `(n=${forecast.runHistory.runs})`,
  );
  lines.push(confidenceLine(forecast));
  return lines;
}

/** Stop-rate threshold at which the run-start banner adds its second line. */
const BANNER_STOP_RISK_THRESHOLD = 0.25;

/**
 * The one- or two-line run-start banner: never delays or blocks a run, and
 * `forecastWorkflow` never throws, so a caller can print this unconditionally
 * right after the workflow is resolved.
 *
 * @param forecast - From {@link forecastWorkflow}.
 */
export function renderForecastBanner(forecast: WorkflowForecast): string[] {
  if (forecast.runHistory.runs === 0 && forecast.stagesWithoutHistory === forecast.stages.length) {
    return ["forecast: no history for this workflow yet"];
  }
  const cost = forecast.totals.costKnown ? formatCost(forecast.totals.costUsd ?? 0) : "unknown";
  const lines = [
    `forecast: ~${formatDuration(forecast.totals.p50DurationMs)} · ~${cost} · ` +
      `stop risk ${percent(forecast.totals.stopProbability)} (n=${forecast.runHistory.runs} runs)`,
  ];
  // Only the stages the totals are timed on: a race's losing arm can carry a
  // frightening stop rate that costs the run nothing, since the winner is
  // what the run waits for. See {@link ForecastTotals}.
  const risky = timedStages(forecast.stages)
    .filter((s) => s.history !== undefined && s.history.stopRate >= BANNER_STOP_RISK_THRESHOLD)
    .sort((a, b) => (b.history?.stopRate ?? 0) - (a.history?.stopRate ?? 0))[0];
  if (risky?.history !== undefined) {
    const h = risky.history;
    const stopped = Math.round(h.stopRate * h.samples);
    const alt =
      h.alternative === undefined
        ? ""
        : ` — ${Math.round(h.alternative.stopRate * h.alternative.samples)}/${h.alternative.samples} on ${h.alternative.model}`;
    lines.push(
      `stage ${risky.stepId}${risky.role === undefined ? "" : ` ${risky.role}`} stopped ` +
        `${stopped}/${h.samples} on ${risky.model ?? "an unresolved model"}${alt}`,
    );
  }
  return lines;
}

/**
 * Serialize the forecast for `--json`.
 *
 * @param forecast - From {@link forecastWorkflow}.
 */
export function formatForecastJson(forecast: WorkflowForecast): string {
  return JSON.stringify(forecast, null, 2);
}
