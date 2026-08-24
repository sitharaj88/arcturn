/**
 * Live session spend, computed from the event stream.
 *
 * RFC 0004 §1 Stage 2 asks for the status bar to be "honest per RFC-current
 * behavior: `$0.42`, `$0.42+` when partly priced, `n/a` when the model
 * publishes no pricing". That convention is the CLI's
 * `format.ts#formatCostTotal` paired with `runtime.ts`'s
 * `SessionMetrics.unpricedTurns`, whose doc states the rule this module
 * exists to honour:
 *
 * > `$0.00` for an unpriced model reads as "free", which is the silent wrong
 * > answer this counter exists to prevent.
 *
 * The *convention* is mirrored; the *code* is not imported. RFC 0004 §0 makes
 * the protocol the only boundary, so this module reads `turnEnd` events and
 * nothing else — no `@arcturn/cli` internals, no `@arcturn/ai` pricing table.
 *
 * ### One difference from the CLI, recorded rather than hidden
 *
 * `runtime.ts` computes a turn's cost as
 * `event.usage.costUsd ?? calculateCostUsd(model, event.usage)`: when the
 * engine did not stamp a cost, it prices the turn itself from the model's
 * catalog entry. The extension has no catalog — `@arcturn/ai` is not reachable
 * across the protocol boundary — so a turn arriving without `usage.costUsd`
 * is counted as *unpriced* here even in the cases where the CLI could have
 * priced it. That errs toward `+`/`n/a`, which is the honest direction: the
 * total is reported as a floor rather than as an answer.
 */

import type { AgentEvent, Usage } from "../serve/engine.js";

/** Running totals for the open session. Mirrors `SessionMetrics`' shape. */
export interface CostState {
  /** Completed model turns. */
  readonly turns: number;
  /** Turns whose cost the engine did not report. */
  readonly unpricedTurns: number;
  /** Summed cost of the turns that *were* priced. A floor when unpriced > 0. */
  readonly costUsd: number;
  /** Summed token usage. */
  readonly usage: Usage;
}

const emptyUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** A session that has spent nothing yet. */
export const initialCostState: CostState = {
  turns: 0,
  unpricedTurns: 0,
  costUsd: 0,
  usage: emptyUsage,
};

/**
 * USD with enough precision at both ends of the range. Mirrors
 * `packages/cli/src/format.ts#formatCost`.
 *
 * @param usd - Cost in dollars.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * A total that may be missing the cost of turns nobody could price. Mirrors
 * `packages/cli/src/format.ts#formatCostTotal`.
 *
 * @param usd - Dollars that *could* be priced.
 * @param complete - `false` when at least one turn's cost was unknown.
 */
export function formatCostTotal(usd: number, complete: boolean): string {
  if (complete) return formatCost(usd);
  if (!Number.isFinite(usd) || usd <= 0) return "n/a";
  return `${formatCost(usd)}+`;
}

/**
 * Fold one event into the running totals.
 *
 * Only `turnEnd` counts: it is the event `runtime.ts` accounts against, and
 * the stream's own `usage` events are per-message partials of the same spend.
 *
 * @param state - Current totals.
 * @param event - The event, exactly as `@arcturn/types` defines it.
 * @returns The same state object for every event that is not a `turnEnd`.
 */
export function reduceCost(state: CostState, event: AgentEvent): CostState {
  if (event.type !== "turnEnd") return state;
  const usage = event.usage;
  const cost = usage.costUsd;
  // `undefined` is not zero, and neither is NaN: an unpriced turn spent money
  // nobody can name. It adds nothing to the dollar total and is counted
  // instead, so the display can admit the gap.
  const priced = typeof cost === "number" && Number.isFinite(cost);
  return {
    turns: state.turns + 1,
    unpricedTurns: state.unpricedTurns + (priced ? 0 : 1),
    costUsd: state.costUsd + (priced ? cost : 0),
    usage: {
      inputTokens: state.usage.inputTokens + usage.inputTokens,
      outputTokens: state.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: state.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: state.usage.cacheWriteTokens + usage.cacheWriteTokens,
    },
  };
}

/**
 * The status-bar text: `$0.42`, `$0.42+`, or `n/a`.
 *
 * @param state - Current totals.
 */
export function costLabel(state: CostState): string {
  return formatCostTotal(state.costUsd, state.unpricedTurns === 0);
}

/** One row of the cost quick-pick. */
export interface CostRow {
  label: string;
  detail: string;
}

/**
 * The breakdown behind the status-bar figure.
 *
 * @param state - Current totals.
 */
export function costBreakdown(state: CostState): CostRow[] {
  const rows: CostRow[] = [
    { label: "Total", detail: costLabel(state) },
    { label: "Turns", detail: String(state.turns) },
    { label: "Input tokens", detail: formatTokens(state.usage.inputTokens) },
    { label: "Output tokens", detail: formatTokens(state.usage.outputTokens) },
    { label: "Cache read tokens", detail: formatTokens(state.usage.cacheReadTokens) },
    { label: "Cache write tokens", detail: formatTokens(state.usage.cacheWriteTokens) },
  ];
  if (state.unpricedTurns > 0) {
    rows.push({
      label: `Unpriced turns: ${String(state.unpricedTurns)}`,
      detail: "These turns spent money the engine could not price, so the total is a floor",
    });
  }
  return rows;
}

/**
 * Status-bar tooltip text.
 *
 * @param state - Current totals.
 */
export function costTooltip(state: CostState): string {
  const lines = [`Arcturn session spend: ${costLabel(state)}`, `Turns: ${String(state.turns)}`];
  if (state.unpricedTurns > 0) {
    lines.push(
      `${String(state.unpricedTurns)} turn(s) could not be priced — the total is a floor, not the answer`,
    );
  }
  return lines.join("\n");
}

/** Compact token count: `842`, `12.4k`, `1.20M`. Mirrors `format.ts#formatTokens`. */
function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
