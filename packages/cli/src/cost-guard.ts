/**
 * COST GUARD — abort a run once its cumulative USD cost crosses a configured
 * ceiling.
 *
 * {@link ArcturnRuntime.metrics.costUsd} (see `runtime.ts`'s `#onEvent`) is
 * updated after every `turnEnd` event, so that is the natural point to check
 * the spend against the limit. The guard itself stays event-driven rather
 * than reading `runtime.metrics` directly so it can be unit-tested with a
 * synthetic event stream and a fake cost source — see `cost-guard.test.ts`.
 *
 * This module intentionally has no dependency on `runtime.ts`: it is wired
 * up by the caller (see `INTEGRATION-cost-guard.md` for the exact call
 * sites in `config.ts`, `args.ts`, `runtime.ts` and `commands.ts`, none of
 * which this file touches).
 */

import type { AgentEvent } from "@arcturn/types";

/**
 * Pure threshold check, kept separate from {@link createCostGuard} so the
 * abort condition can be tested without constructing an event stream.
 *
 * A limit of `0` (or a non-finite/negative value) means "disabled" — the
 * guard never aborts, no matter how much has been spent.
 *
 * @param spentUsd - Cumulative cost so far, in USD.
 * @param limitUsd - Configured ceiling, in USD. `0` disables the guard.
 * @returns Whether the run should be aborted for exceeding its cost ceiling.
 */
export function shouldAbortForCost(spentUsd: number, limitUsd: number): boolean {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) return false;
  if (!Number.isFinite(spentUsd)) return false;
  return spentUsd >= limitUsd;
}

/**
 * Run-level token threshold check — {@link shouldAbortForCost}'s sibling for
 * the one ceiling that can still bite on a model with no published pricing.
 * On such a model (a coding-plan endpoint, Ollama, vLLM) `costUsd` is never
 * minted, so a dollar ceiling compares against a spend that never moves;
 * token counts, by contrast, arrive on every turn. Same conventions as the
 * cost check: a limit of `0`/`undefined` (or a negative/non-finite value)
 * disables the guard, and a non-finite spend never trips it.
 *
 * The comparison is strict (`>`) where the cost check's is `>=`: tokens are
 * a discrete count, and a run that consumed *exactly* its ceiling has not
 * exceeded it — which is what the abort message will say it did.
 *
 * @param spentTokens - Total tokens consumed so far: input + output + cache
 *   read + cache write. Thinking tokens are a subset of output and must never
 *   be added separately (see `Usage.thinkingTokens` in `@arcturn/types`).
 * @param limitTokens - Configured ceiling, in tokens. `undefined` or `0`
 *   disables the guard.
 * @returns Whether the run should be aborted for exceeding its token ceiling.
 */
export function shouldAbortForTokens(
  spentTokens: number,
  limitTokens: number | undefined,
): boolean {
  const limit = limitTokens ?? 0;
  if (!Number.isFinite(limit) || limit <= 0) return false;
  if (!Number.isFinite(spentTokens)) return false;
  return spentTokens > limit;
}

/**
 * Render the message shown to the user when the guard fires.
 *
 * Exported so the CLI (and its tests) can assert on the exact wording
 * without duplicating it.
 *
 * @param limitUsd - The ceiling that was crossed, in USD.
 */
export function costLimitMessage(limitUsd: number): string {
  const formatted = limitUsd < 0.01 ? `$${limitUsd.toFixed(4)}` : `$${limitUsd.toFixed(2)}`;
  return `Cost limit ${formatted} reached; run aborted. Raise it with --max-cost or /cost limit.`;
}

/** Options for {@link createCostGuard}. */
export interface CostGuardOptions {
  /** USD ceiling for cumulative run cost. `0` or `undefined` disables the guard. */
  limitUsd: number | undefined;
  /** Reads the current cumulative cost, e.g. `() => runtime.metrics.costUsd`. */
  getCostUsd: () => number;
  /** Aborts the run, e.g. `(reason) => runtime.agent.abort()`. */
  abort: (reason: string) => void;
  /** Surfaces the abort message to the user, e.g. a `notice` event or `ui.print`. */
  notify?: (message: string) => void;
}

/** Handle returned by {@link createCostGuard}. */
export interface CostGuard {
  /** Feed one runtime event through the guard. */
  onEvent(event: AgentEvent): void;
  /** Re-arm the guard, allowing it to abort again on the next threshold cross. */
  reset(): void;
}

/**
 * Build a guard that watches an {@link AgentEvent} stream and aborts the run
 * once cumulative cost reaches `options.limitUsd`.
 *
 * The guard fires at most once per run: `runStart` re-arms it (so a fresh
 * run — or a `/clear` / resumed session — gets its own chance to trip the
 * limit), and it will not call `abort` a second time before the next
 * `runStart` even if more `turnEnd` events arrive after the first trip.
 *
 * @param options - Cost source, abort hook and limit.
 */
export function createCostGuard(options: CostGuardOptions): CostGuard {
  // `options` is read through on every event rather than destructured: a
  // caller may expose `limitUsd` as a live getter (arcturn's `/cost limit` does),
  // and destructuring would freeze the ceiling at construction time.
  const { getCostUsd, abort, notify } = options;
  let tripped = false;

  return {
    onEvent(event: AgentEvent): void {
      if (event.type === "runStart") {
        tripped = false;
        return;
      }
      if (event.type !== "turnEnd") return;
      if (tripped) return;
      const limit = options.limitUsd ?? 0;
      if (!shouldAbortForCost(getCostUsd(), limit)) return;

      tripped = true;
      const message = costLimitMessage(limit);
      abort(message);
      notify?.(message);
    },
    reset(): void {
      tripped = false;
    },
  };
}
