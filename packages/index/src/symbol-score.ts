/**
 * Symbol-name scoring: the signal that makes this feel like a code index
 * rather than a text search.
 *
 * When someone types `TokenBucket`, they mean *the thing called TokenBucket* —
 * not the twelve files that mention it. BM25 alone cannot express that,
 * because it sees a symbol's name as just more text. This ranker looks only at
 * the name and its container path, and grades matches in tiers: exact beats
 * qualified-exact beats prefix beats containment beats word-set beats
 * subsequence. Fusion then gives this list double weight, which is what the
 * architecture means by "with a strong boost".
 */

import type { RankedEntry } from "./bm25.js";
import { splitIdentifier } from "./tokenize.js";
import type { ChunkKind, CodeChunk } from "./types.js";

/** Match tiers, widely separated so a weaker tier can never overtake a stronger one. */
const EXACT_NAME = 1000;
const EXACT_QUALIFIED = 950;
const NAME_PREFIX = 700;
const QUALIFIED_SUFFIX = 650;
const NAME_CONTAINS = 500;
const QUALIFIED_CONTAINS = 400;
const ALL_WORDS_ORDERED = 350;
const ALL_WORDS = 300;
const SUBSEQUENCE = 150;

/** Rewards a match that covers most of the name: `Bucket` fits `Bucket` better than `BucketFactory`. */
const COVERAGE_BONUS = 30;

/**
 * A within-tier nudge toward real declarations.
 *
 * Two chunks can match a name exactly — `class TokenBucket` and the Markdown
 * heading `## TokenBucket` that documents it. Someone searching for a symbol
 * wants the declaration; the prose about it is the second-best answer, and a
 * whole-file chunk that merely shares a stem is the third. Kept small enough
 * (max 12 against a 50-point tier gap and a 30-point coverage bonus) that it
 * can never lift a weaker match tier above a stronger one.
 */
const KIND_BONUS: Readonly<Record<ChunkKind, number>> = {
  class: 12,
  struct: 12,
  interface: 12,
  trait: 12,
  enum: 12,
  type: 11,
  function: 10,
  method: 10,
  const: 8,
  property: 8,
  module: 8,
  macro: 8,
  impl: 6,
  extension: 6,
  section: 2,
  file: 0,
};

/** Is `query` a subsequence of `name`? Returns its coverage ratio, or 0. */
function subsequenceCoverage(query: string, name: string): number {
  if (query.length === 0 || query.length > name.length) return 0;
  let matched = 0;
  for (let i = 0; i < name.length && matched < query.length; i++) {
    if (name[i] === query[matched]) matched++;
  }
  return matched === query.length ? query.length / name.length : 0;
}

/** Do `nameParts` contain every one of `queryParts`, and if so, in order? */
function wordSetMatch(
  queryParts: readonly string[],
  nameParts: readonly string[],
): "none" | "unordered" | "ordered" {
  if (queryParts.length === 0) return "none";
  let cursor = 0;
  let ordered = true;
  for (const part of queryParts) {
    const at = nameParts.indexOf(part, cursor);
    if (at >= 0) {
      cursor = at + 1;
      continue;
    }
    if (!nameParts.includes(part)) return "none";
    ordered = false;
  }
  return ordered ? "ordered" : "unordered";
}

/** Score one chunk against a normalized query. Zero means "not a name match at all". */
export function symbolScore(
  chunk: CodeChunk,
  query: string,
  queryParts: readonly string[],
): number {
  const name = chunk.name.toLowerCase();
  if (name.length === 0) return 0;
  const qualified = chunk.container ? `${chunk.container.toLowerCase()}.${name}` : name;

  const coverage = query.length / Math.max(name.length, query.length);
  const kind = KIND_BONUS[chunk.kind];
  const bonus = Math.round(COVERAGE_BONUS * coverage) + kind;

  if (name === query) return EXACT_NAME + COVERAGE_BONUS + kind;
  if (qualified === query) return EXACT_QUALIFIED + COVERAGE_BONUS + kind;
  if (name.startsWith(query)) return NAME_PREFIX + bonus;
  if (qualified.endsWith(`.${query}`)) return QUALIFIED_SUFFIX + bonus;
  if (name.includes(query)) return NAME_CONTAINS + bonus;
  if (qualified.includes(query)) return QUALIFIED_CONTAINS + bonus;

  const nameParts = splitIdentifier(
    chunk.container ? `${chunk.container} ${chunk.name}` : chunk.name,
  );
  const words = wordSetMatch(queryParts, nameParts);
  if (words === "ordered") return ALL_WORDS_ORDERED + bonus;
  if (words === "unordered") return ALL_WORDS + bonus;

  const subsequence = subsequenceCoverage(query, name);
  if (subsequence > 0) return Math.round(SUBSEQUENCE * subsequence) + kind;
  return 0;
}

/**
 * Rank every candidate chunk by name similarity to `query`.
 *
 * Linear in the number of chunks, which is fine: this is a few string
 * comparisons per chunk, and it runs on the *filtered* candidate set.
 */
export function symbolRank(
  chunks: readonly CodeChunk[],
  query: string,
  allowed: ReadonlySet<number> | null,
  limit: number,
): RankedEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [];
  const queryParts = splitIdentifier(query);

  const entries: RankedEntry[] = [];
  for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
    if (allowed && !allowed.has(ordinal)) continue;
    const chunk = chunks[ordinal];
    if (!chunk) continue;
    const score = symbolScore(chunk, normalized, queryParts);
    if (score > 0) entries.push({ ordinal, score });
  }

  entries.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.ordinal - b.ordinal));
  return entries.length > limit ? entries.slice(0, limit) : entries;
}
