/**
 * BM25 over the inverted index.
 *
 * BM25 rather than plain TF-IDF for two properties that matter on code:
 * *saturation* (the tenth occurrence of `retry` in a function adds almost
 * nothing over the third, so a repetitive file cannot dominate) and *length
 * normalization* (a one-line signature and a 300-line class are compared
 * fairly). The field weighting that makes names dominate is applied upstream,
 * in `document.ts`, by term repetition.
 */

import type { IndexSnapshot } from "./store.js";

/** Term-frequency saturation. 1.2 is the standard default and behaves well on code. */
export const BM25_K1 = 1.2;

/** Length-normalization strength. 0.75 is the standard default. */
export const BM25_B = 0.75;

/** One scored document, by ordinal into {@link IndexSnapshot.chunks}. */
export interface RankedEntry {
  ordinal: number;
  score: number;
}

/**
 * Inverse document frequency, in the BM25 "probabilistic" form with the +1
 * smoothing that keeps very common terms at a small positive weight rather
 * than a negative one.
 */
function idf(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * Rank documents for `terms`, highest score first.
 *
 * @param allowed - When non-null, only these ordinals may score; this is how
 *   `kind:`/`path:` filters are applied *before* ranking, so the ranks handed
 *   to fusion describe the filtered corpus rather than the whole index.
 */
export function bm25Rank(
  snapshot: IndexSnapshot,
  terms: readonly string[],
  allowed: ReadonlySet<number> | null,
  limit: number,
): RankedEntry[] {
  const documentCount = snapshot.chunks.length;
  if (documentCount === 0 || terms.length === 0) return [];

  const avgDocLength = snapshot.avgDocLength > 0 ? snapshot.avgDocLength : 1;
  const scores = new Map<number, number>();

  for (const term of terms) {
    const entries = snapshot.postings.get(term);
    if (!entries || entries.length === 0) continue;
    const documentFrequency = entries.length / 2;
    const weight = idf(documentCount, documentFrequency);
    if (weight <= 0) continue;

    for (let i = 0; i < entries.length; i += 2) {
      const ordinal = entries[i];
      const frequency = entries[i + 1];
      if (ordinal === undefined || frequency === undefined) continue;
      if (allowed && !allowed.has(ordinal)) continue;
      const length = snapshot.docLengths[ordinal] ?? avgDocLength;
      const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgDocLength);
      scores.set(
        ordinal,
        (scores.get(ordinal) ?? 0) + (weight * frequency * (BM25_K1 + 1)) / denominator,
      );
    }
  }

  return topEntries(scores, limit);
}

/** Sort a score map descending (ordinal ascending on ties, for determinism) and cap it. */
export function topEntries(scores: ReadonlyMap<number, number>, limit: number): RankedEntry[] {
  const entries: RankedEntry[] = [];
  for (const [ordinal, score] of scores) {
    if (score > 0) entries.push({ ordinal, score });
  }
  entries.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.ordinal - b.ordinal));
  return entries.length > limit ? entries.slice(0, limit) : entries;
}
