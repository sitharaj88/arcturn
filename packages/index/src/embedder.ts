/**
 * The embedding seam — **off by default, and deliberately so.**
 *
 * ## Why it is off
 *
 * Embedding a repository is not free. A 5,000-file codebase produces on the
 * order of 100,000 chunks; even at the ~40-token summaries this package sends
 * (never bodies — see `chunkEmbeddingText`), that is millions of tokens
 * through an embedding endpoint on the first index and more on every branch
 * with new code. Arcturn's default retrieval path costs zero tokens and zero
 * network calls, and on the queries developers actually type — a
 * half-remembered identifier, a file path, a concept that appears verbatim in
 * a doc comment — the BM25 + symbol hybrid is already strong.
 *
 * ## When it earns its keep
 *
 * Queries whose vocabulary does not appear in the code at all: "where do we
 * handle retries" against a codebase that spells it `backoff`, or "rate
 * limiting" against a file that only ever says `TokenBucket`. That is real
 * recall, and a caller who wants it can plug in an {@link Embedder} and pay
 * for it knowingly.
 *
 * ## How it participates
 *
 * As one more ranked list into Reciprocal Rank Fusion — never as a
 * replacement. A misbehaving or slow embedder degrades the result to the
 * lexical signals rather than breaking the search.
 */

import type { RankedEntry } from "./bm25.js";
import type { IndexSnapshot } from "./store.js";
import type { Embedder } from "./types.js";

/**
 * Cosine similarity of two equal-length vectors.
 *
 * Returns 0 for mismatched lengths or a zero vector rather than `NaN`, because
 * a malformed vector must cost one document its semantic score, not poison the
 * whole ranking.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank stored chunk vectors against the query vector.
 *
 * Exhaustive rather than approximate: an ANN index would be another dependency
 * and another on-disk format, and a linear scan of 100k float arrays is a few
 * milliseconds — well under the cost of the embedding call that produced the
 * query vector in the first place.
 */
export function vectorRank(
  snapshot: IndexSnapshot,
  queryVector: readonly number[],
  allowed: ReadonlySet<number> | null,
  limit: number,
): RankedEntry[] {
  if (!snapshot.vectors || snapshot.vectors.size === 0 || queryVector.length === 0) return [];
  const entries: RankedEntry[] = [];
  for (const [ordinal, vector] of snapshot.vectors) {
    if (allowed && !allowed.has(ordinal)) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score > 0) entries.push({ ordinal, score });
  }
  entries.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.ordinal - b.ordinal));
  return entries.length > limit ? entries.slice(0, limit) : entries;
}

/**
 * Embed one query string, tolerating any failure.
 *
 * @returns The query vector, or `null` when the embedder is unavailable,
 *   errors, cancels, or returns a vector of the wrong width. Callers treat
 *   `null` as "no semantic signal this query".
 */
export async function embedQuery(
  embedder: Embedder,
  query: string,
  signal?: AbortSignal,
): Promise<readonly number[] | null> {
  try {
    const vectors = await embedder.embed([query], signal);
    const vector = vectors[0];
    if (!vector || vector.length !== embedder.dimensions) return null;
    return vector;
  } catch {
    return null;
  }
}
