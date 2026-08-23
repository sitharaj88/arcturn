/**
 * Reciprocal Rank Fusion.
 *
 * The three retrieval signals produce scores on incomparable scales: a BM25
 * score of 8.3, a symbol score of 1040, and a cosine similarity of 0.71 cannot
 * be added, and normalizing them requires per-query calibration that is
 * fragile in exactly the cases that matter. RRF sidesteps this entirely by
 * throwing the scores away and keeping only the *ranks*:
 *
 * ```text
 * score(d) = Σ_lists  weight_l / (k + rank_l(d))
 * ```
 *
 * It is parameter-free apart from `k`, robust to a list being empty or
 * garbage, and the standard choice for hybrid retrieval. `k = 60` is the value
 * from the original Cormack et al. paper and the de-facto default: large
 * enough that ranks 1 and 2 are close, small enough that rank 1 still wins.
 */

import type { RankedEntry } from "./bm25.js";
import type { HitSignals } from "./types.js";

/** The RRF smoothing constant. */
export const RRF_K = 60;

/** One ranked list entering the fusion, tagged with which signal produced it. */
export interface FusionList {
  /** Which {@link HitSignals} field records this list's rank. */
  signal: keyof HitSignals;
  entries: readonly RankedEntry[];
  /**
   * Relative influence. Symbol-name matching is weighted above the others
   * because on code it is the signal most likely to be *what the user meant*.
   */
  weight: number;
}

/** A fused result: one document, its combined score, and where it came from. */
export interface FusedEntry {
  ordinal: number;
  score: number;
  signals: HitSignals;
}

/**
 * Fuse ranked lists into one ordering.
 *
 * Ties break on ordinal, so results are deterministic across runs — a
 * property worth having when an agent may re-issue the same query.
 */
export function reciprocalRankFusion(
  lists: readonly FusionList[],
  k: number = RRF_K,
): FusedEntry[] {
  const scores = new Map<number, number>();
  const signals = new Map<number, HitSignals>();

  for (const list of lists) {
    for (let i = 0; i < list.entries.length; i++) {
      const entry = list.entries[i];
      if (!entry) continue;
      const rank = i + 1;
      scores.set(entry.ordinal, (scores.get(entry.ordinal) ?? 0) + list.weight / (k + rank));
      const existing = signals.get(entry.ordinal) ?? {};
      existing[list.signal] = rank;
      signals.set(entry.ordinal, existing);
    }
  }

  const fused: FusedEntry[] = [];
  for (const [ordinal, score] of scores) {
    fused.push({ ordinal, score, signals: signals.get(ordinal) ?? {} });
  }
  fused.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.ordinal - b.ordinal));
  return fused;
}
