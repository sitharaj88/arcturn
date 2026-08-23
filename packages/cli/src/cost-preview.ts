/**
 * COST PREVIEW — forecast what a plan will probably cost, *before* the user
 * approves it.
 *
 * This is the sibling of `cost-guard.ts`: the guard is a ceiling ("stop me
 * if I cross $5"), this is a forecast ("this will probably run about 8-24
 * turns and cost $1.20-$3.60"). Approving a *budget* up front is a different
 * act than approving a *plan*, and arcturn does not conflate them.
 *
 * Like `cost-guard.ts`, this module has no dependency on `runtime.ts` or
 * `commands.ts` — it is a set of pure, independently-testable functions. See
 * `INTEGRATION-cost-preview.md` for exactly where the CLI would wire this
 * up (a `/cost preview` subaction, and a small ring buffer of recent
 * `turnEnd` usages that the runtime does not currently keep).
 *
 * Two estimators feed a common {@link CostEstimate} shape:
 *
 * - {@link estimateFromHistory} — the primary estimator. Uses the *caller's
 *   own* recent turns (median cost/turn, median tokens/turn) so the forecast
 *   reflects how this session/task has actually been behaving, not a
 *   generic assumption.
 * - {@link estimateFromModel} — the fallback when there is no history yet.
 *   Uses {@link ModelSpec.cost} (when published) and injectable per-turn
 *   token assumptions.
 *
 * Both route dollar arithmetic through {@link calculateCostUsd} from
 * `@arcturn/ai` — the same function `runtime.ts` uses to price a real
 * turn — so the *shape* of the estimate's arithmetic matches production
 * accounting exactly; only the *inputs* (assumed vs. measured usage) are a
 * forecast.
 *
 * Honesty over confidence: every estimate is a range, never a point, and an
 * unpriced model yields no dollar figures at all rather than an invented
 * number (see {@link estimateFromModel}).
 */

import { calculateCostUsd } from "@arcturn/ai";
import type { ModelSpec, Usage } from "@arcturn/types";
import { formatCost } from "./format.js";

/**
 * One historical turn, as needed to forecast future ones. Mirrors the
 * `usage` carried by an `AgentEvent` of type `"turnEnd"` plus the cost it
 * was actually billed at (`runtime.metrics.costUsd`'s per-turn delta) —
 * see `INTEGRATION-cost-preview.md` for where these would be recorded.
 */
export interface TurnSample {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * The part of a arcturn "plan" this module needs: a step count. In arcturn a plan
 * is presented as markdown (see `packages/core/src/state-tools.ts`'s
 * `createPlanTool`), not a structured list, so callers typically pass the
 * length of the accompanying todo list (`runtime.agent.todos.length`,
 * `createTodoTool`'s `TodoItem[]`) — the closest thing arcturn has to discrete
 * "steps" at forecast time.
 */
export interface PlanShape {
  /** Number of discrete steps in the plan. Negative or fractional values are clamped/floored. */
  steps: number;
}

/** Which data an estimate was derived from. */
export type CostEstimateBasis = "history" | "model" | "unpriced";

/**
 * A forecast for how much a plan will probably cost to execute.
 *
 * Always a range, never a point: a single confidently-wrong number is worse
 * than an honest spread. `usdLow`/`usdHigh` are omitted entirely (rather
 * than set to `0` or guessed) whenever there is no pricing to derive them
 * from — see {@link estimateFromModel}.
 */
export interface CostEstimate {
  basis: CostEstimateBasis;
  /** Low end of the turn-count forecast. */
  turnsLow: number;
  /** High end of the turn-count forecast. Always `>= turnsLow`. */
  turnsHigh: number;
  /** Low end of the USD forecast. Present only when pricing is known. */
  usdLow?: number;
  /** High end of the USD forecast. Present only when pricing is known. Always `>= usdLow` when both are present. */
  usdHigh?: number;
  /** See {@link MEDIAN_CONFIDENCE_SAMPLE_SIZE} for the rule. */
  confidence: "low" | "medium";
  /** Number of historical turn samples backing the estimate (`0` for `"model"`/`"unpriced"`). */
  sampleSize: number;
  /**
   * Median of `inputTokens + outputTokens` across the history sample, when
   * `basis === "history"` and the sample is non-empty. Informational only —
   * the dollar range is derived from median *cost*, not from this figure —
   * but useful for a caller that wants to show "~3.2k tokens/turn" alongside
   * the dollar estimate.
   */
  medianTokensPerTurn?: number;
}

/**
 * Sample size at or above which {@link CostEstimate.confidence} is
 * `"medium"` rather than `"low"`.
 *
 * The rule is deliberately simple: below this many recent turns, a median
 * is too easily dominated by one or two data points to call it more than a
 * rough guess. There is no "high" tier — even a long history is still a
 * forecast of *future* turns behaving like *past* ones, which this module
 * has no way to guarantee.
 */
export const MEDIAN_CONFIDENCE_SAMPLE_SIZE = 8;

/** Default multiplier for {@link estimateFromHistory}'s/{@link estimateFromModel}'s `turnsHigh`. */
export const DEFAULT_TURNS_PER_STEP_HIGH = 3;

/** Options shared by both estimators' turn-count heuristic. */
export interface TurnCountOptions {
  /**
   * `turnsHigh = steps * turnsPerStepHigh`. Default {@link DEFAULT_TURNS_PER_STEP_HIGH}.
   *
   * This is a heuristic, not a prediction: a plan step is rarely exactly one
   * model turn (it usually costs a read, an edit, maybe a retry), so the low
   * end assumes the optimistic "one turn per step" case and the high end
   * scales it up by this factor. Tune it per-project if steps in your plans
   * tend to run more or less turn-hungry than 3x.
   */
  turnsPerStepHigh?: number;
}

/** Options for {@link estimateFromModel}. */
export interface ModelEstimateAssumptions extends TurnCountOptions {
  /**
   * Assumed input tokens for one turn (prompt + tool results + context).
   * Default `4000` — a rough mid-size-repo agentic-coding turn. Override
   * this per-project once real data suggests a better baseline; it is only
   * ever used before any history exists.
   */
  inputTokensPerTurn?: number;
  /** Assumed output tokens for one turn. Default `800`. */
  outputTokensPerTurn?: number;
}

const DEFAULT_INPUT_TOKENS_PER_TURN = 4000;
const DEFAULT_OUTPUT_TOKENS_PER_TURN = 800;

/** Round to the same precision `calculateCostUsd` uses, so ranges stay stable under repeated formatting. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e7) / 1e7;
}

function normalizeSteps(steps: number): number {
  if (!Number.isFinite(steps) || steps <= 0) return 0;
  return Math.floor(steps);
}

function turnRange(
  steps: number,
  turnsPerStepHigh: number,
): { turnsLow: number; turnsHigh: number } {
  const normalizedSteps = normalizeSteps(steps);
  const k =
    Number.isFinite(turnsPerStepHigh) && turnsPerStepHigh > 0
      ? turnsPerStepHigh
      : DEFAULT_TURNS_PER_STEP_HIGH;
  const turnsLow = normalizedSteps;
  const turnsHigh = Math.max(turnsLow, Math.round(normalizedSteps * k));
  return { turnsLow, turnsHigh };
}

function confidenceFor(sampleSize: number): "low" | "medium" {
  return sampleSize >= MEDIAN_CONFIDENCE_SAMPLE_SIZE ? "medium" : "low";
}

/**
 * Median of a numeric array. `0` for an empty array (callers guard on
 * `length` before trusting that as a real value).
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[mid - 1] ?? 0;
  return (lower + upper) / 2;
}

/**
 * Forecast a plan's cost from the caller's own recent turns.
 *
 * This is the primary estimator: it takes the median cost-per-turn (and,
 * informationally, median tokens-per-turn) from `history` and multiplies by
 * an estimated turn count derived from `plan.steps` (see
 * {@link TurnCountOptions.turnsPerStepHigh}). The median — not the mean — is
 * used deliberately so a single unusually expensive or cheap turn (a big
 * file read, a one-off compaction) does not skew the forecast; see
 * `cost-preview.test.ts` for a case with a deliberate outlier.
 *
 * An empty `history` still returns a well-formed `basis: "history"` estimate
 * with no dollar figures (there is nothing to derive them from) — callers
 * that want a dollar figure regardless should fall back to
 * {@link estimateFromModel} themselves, or use {@link estimateCost}, which
 * does this automatically.
 *
 * @param history - Recent turns, most-recent-first or in any order (order
 *   does not affect a median).
 * @param plan - The plan being estimated; only `steps` is used.
 * @param options - Turn-count heuristic overrides.
 */
export function estimateFromHistory(
  history: readonly TurnSample[],
  plan: PlanShape,
  options: TurnCountOptions = {},
): CostEstimate {
  const { turnsLow, turnsHigh } = turnRange(
    plan.steps,
    options.turnsPerStepHigh ?? DEFAULT_TURNS_PER_STEP_HIGH,
  );
  const sampleSize = history.length;

  if (sampleSize === 0) {
    return { basis: "history", turnsLow, turnsHigh, confidence: "low", sampleSize: 0 };
  }

  const medianCostPerTurn = median(history.map((sample) => sample.costUsd));
  const medianTokensPerTurn = median(
    history.map((sample) => sample.inputTokens + sample.outputTokens),
  );

  return {
    basis: "history",
    turnsLow,
    turnsHigh,
    usdLow: roundUsd(turnsLow * medianCostPerTurn),
    usdHigh: roundUsd(turnsHigh * medianCostPerTurn),
    confidence: confidenceFor(sampleSize),
    sampleSize,
    medianTokensPerTurn,
  };
}

/**
 * Forecast a plan's cost from a model's published pricing plus assumed
 * per-turn token usage. Use this when there is no turn history yet (a fresh
 * session, a brand-new model).
 *
 * Routes through {@link calculateCostUsd} — the same helper `runtime.ts`
 * uses to price a real turn — so the only "invented" numbers are the
 * assumed token counts, never the pricing arithmetic.
 *
 * When `model.cost` is undefined (many `ModelSpec`s, especially
 * self-hosted/openai-compatible ones, do not publish pricing) this returns
 * `basis: "unpriced"` with no `usdLow`/`usdHigh` at all — guessing a price
 * would be worse than admitting it is unknown.
 *
 * @param model - The model the plan would run against.
 * @param plan - The plan being estimated; only `steps` is used.
 * @param assumptions - Injectable per-turn token assumptions and turn-count heuristic overrides.
 */
export function estimateFromModel(
  model: ModelSpec,
  plan: PlanShape,
  assumptions: ModelEstimateAssumptions = {},
): CostEstimate {
  const { turnsLow, turnsHigh } = turnRange(
    plan.steps,
    assumptions.turnsPerStepHigh ?? DEFAULT_TURNS_PER_STEP_HIGH,
  );
  const confidence = confidenceFor(0);

  const usage: Usage = {
    inputTokens: assumptions.inputTokensPerTurn ?? DEFAULT_INPUT_TOKENS_PER_TURN,
    outputTokens: assumptions.outputTokensPerTurn ?? DEFAULT_OUTPUT_TOKENS_PER_TURN,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const perTurnUsd = calculateCostUsd(model, usage);

  if (perTurnUsd === undefined) {
    return { basis: "unpriced", turnsLow, turnsHigh, confidence, sampleSize: 0 };
  }

  return {
    basis: "model",
    turnsLow,
    turnsHigh,
    usdLow: roundUsd(turnsLow * perTurnUsd),
    usdHigh: roundUsd(turnsHigh * perTurnUsd),
    confidence,
    sampleSize: 0,
  };
}

/** Options for {@link estimateCost}. */
export interface EstimateCostOptions extends ModelEstimateAssumptions {
  /** Recent turns, if any. Empty (or omitted) falls back to {@link estimateFromModel}. */
  history?: readonly TurnSample[];
  /** The plan being estimated. */
  plan: PlanShape;
  /** The model the plan would run against; used only for the fallback path. */
  model: ModelSpec;
}

/**
 * Convenience wrapper: use {@link estimateFromHistory} when there is any
 * history, otherwise fall back to {@link estimateFromModel}. This is the
 * function most callers (e.g. a `/cost preview` command) want — it saves
 * them from re-implementing the "do we have data yet?" branch.
 *
 * @param options - History (optional), plan, model and assumption overrides.
 */
export function estimateCost(options: EstimateCostOptions): CostEstimate {
  const { history, plan, model, ...assumptions } = options;
  if (history && history.length > 0) {
    return estimateFromHistory(history, plan, assumptions);
  }
  return estimateFromModel(model, plan, assumptions);
}

/**
 * Render a {@link CostEstimate} as a single readable line, e.g.:
 *
 * - `~8-24 turns · $1.20-$3.60 (based on 12 recent turns)` (`"history"`)
 * - `~8-24 turns · $1.20-$3.60 (assumption-based on claude-sonnet-5 pricing)` (`"model"`)
 * - `~8-24 turns · price unknown for claude-sonnet-5` (`"unpriced"`)
 *
 * Dollar amounts are formatted with `formatCost` from `format.ts` so they
 * match every other cost figure arcturn prints.
 *
 * @param estimate - The estimate to render.
 * @param model - The model the estimate was (or would be) priced against; only its `displayName` is used.
 */
export function formatEstimate(estimate: CostEstimate, model: ModelSpec): string {
  const turns =
    estimate.turnsLow === estimate.turnsHigh
      ? `~${estimate.turnsLow} turns`
      : `~${estimate.turnsLow}-${estimate.turnsHigh} turns`;

  if (estimate.basis === "unpriced") {
    return `${turns} · price unknown for ${model.displayName}`;
  }

  const usdLow = estimate.usdLow ?? 0;
  const usdHigh = estimate.usdHigh ?? 0;
  const dollars =
    usdLow === usdHigh ? formatCost(usdLow) : `${formatCost(usdLow)}-${formatCost(usdHigh)}`;

  const suffix =
    estimate.basis === "history"
      ? `(based on ${estimate.sampleSize} recent turn${estimate.sampleSize === 1 ? "" : "s"})`
      : `(assumption-based on ${model.displayName} pricing)`;

  return `${turns} · ${dollars} ${suffix}`;
}
