/** Token cost accounting for model specs that publish pricing. */

import type { ModelSpec, Usage } from "@arcturn/types";

const PER_MILLION = 1_000_000;

/**
 * Estimate the USD cost of a completion.
 *
 * Cache reads fall back to the input rate and cache writes fall back to the
 * input rate as well, so a partially specified {@link ModelSpec.cost} still
 * yields a sensible number.
 *
 * @returns The cost in USD, or `undefined` when the spec carries no pricing.
 */
export function calculateCostUsd(spec: ModelSpec, usage: Usage): number | undefined {
  const cost = spec.cost;
  if (!cost) return undefined;

  const cacheReadRate = cost.cacheRead ?? cost.input;
  const cacheWriteRate = cost.cacheWrite ?? cost.input;

  const total =
    (usage.inputTokens * cost.input +
      usage.outputTokens * cost.output +
      usage.cacheReadTokens * cacheReadRate +
      usage.cacheWriteTokens * cacheWriteRate) /
    PER_MILLION;

  if (!Number.isFinite(total)) return undefined;
  // Round to a tenth of a micro-dollar; keeps sums stable without losing signal.
  return Math.round(total * 1e7) / 1e7;
}

/** An all-zero {@link Usage} record. */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Add two usage records together, cost included.
 *
 * Cost is priced once, at the provider boundary, where the exact
 * {@link ModelSpec} that served the turn is known (see the stream assembler's
 * `pricedUsage`); every consumer downstream *propagates* that number rather
 * than re-deriving it. A summing helper that dropped `costUsd` therefore did
 * not discard a "stale" estimate — it discarded the only cost figure that ever
 * existed, silently, at the exact moment two priced turns were rolled into a
 * run total. That is how a spend column reaches an operator blank.
 *
 * So cost adds like every other bucket, and — deliberately — it stays
 * `undefined` when *neither* side carries one: a total of `0` for an unpriced
 * model is a fabricated figure an operator would act on, while an absent one
 * reads as "not known", which is the truth. A partially priced sum reports the
 * priced part, a floor rather than a fiction.
 *
 * This matches `@arcturn/core`'s `addUsage` exactly; the two are the same
 * operation and must not disagree about whether money survives addition.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const costUsd =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}
