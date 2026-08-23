/**
 * Hybrid retrieval: filter, rank by three independent signals, fuse.
 *
 * The shape of the pipeline is the whole design:
 *
 * ```text
 *   query ─┬─► BM25 over name/container/signature/doc/path/body terms  ─┐
 *          ├─► symbol-name scoring (exact ▸ prefix ▸ subsequence)  ×2  ─┼─► RRF ─► hits
 *          └─► optional embeddings (off by default)                    ─┘
 * ```
 *
 * Filters are applied *before* ranking, so `kind:"function"` changes which
 * documents get rank 1 rather than merely hiding rows after the fact.
 */

import { bm25Rank, type RankedEntry } from "./bm25.js";
import { queryTokens } from "./document.js";
import { embedQuery, vectorRank } from "./embedder.js";
import { type FusionList, reciprocalRankFusion } from "./fusion.js";
import type { IndexSnapshot } from "./store.js";
import { symbolRank } from "./symbol-score.js";
import type { CodeChunk, SearchHit, SearchOptions, SearchResult } from "./types.js";

/** Default number of hits returned. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** How deep each individual signal ranks before fusion. */
const PER_SIGNAL_DEPTH = 200;

/**
 * Fusion weights. The symbol list counts double: on code, "the thing actually
 * named that" is more often the intent than "the text that mentions it most".
 */
const BM25_WEIGHT = 1;
const SYMBOL_WEIGHT = 2;
const VECTOR_WEIGHT = 1;

/** Characters that turn a `path` filter from a substring test into a glob. */
const GLOB_CHARS = /[*?[\]]/;

/** Compile a `path` filter into a predicate over repo-relative POSIX paths. */
export function compilePathFilter(pattern: string): (path: string) => boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return () => true;

  if (!GLOB_CHARS.test(trimmed)) {
    const needle = trimmed.toLowerCase();
    return (path) => path.toLowerCase().includes(needle);
  }

  let body = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "*") {
      if (trimmed[i + 1] === "*") {
        body += trimmed[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += trimmed[i + 2] === "/" ? 2 : 1;
        continue;
      }
      body += "[^/]*";
      continue;
    }
    if (ch === "?") {
      body += "[^/]";
      continue;
    }
    body += /[.+^${}()|\\]/.test(ch ?? "") ? `\\${ch}` : ch;
  }
  const anchored = trimmed.includes("/");
  let regex: RegExp;
  try {
    regex = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, "i");
  } catch {
    const needle = trimmed.toLowerCase();
    return (path) => path.toLowerCase().includes(needle);
  }
  return (path) => regex.test(path);
}

/** Build the allowed-ordinal set for the active filters, or null when unfiltered. */
function buildCandidates(
  chunks: readonly CodeChunk[],
  options: SearchOptions,
): ReadonlySet<number> | null {
  const kinds =
    options.kind === undefined
      ? null
      : new Set(Array.isArray(options.kind) ? options.kind : [options.kind]);
  const pathMatches = options.path ? compilePathFilter(options.path) : null;
  if (!kinds && !pathMatches) return null;

  const allowed = new Set<number>();
  for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
    const chunk = chunks[ordinal];
    if (!chunk) continue;
    if (kinds && !kinds.has(chunk.kind)) continue;
    if (pathMatches && !pathMatches(chunk.file)) continue;
    allowed.add(ordinal);
  }
  return allowed;
}

/**
 * Search the index.
 *
 * @returns Hits in fused rank order. An empty index, an empty query, or a
 *   filter that excludes everything all produce an empty result rather than an
 *   error — a search that finds nothing is an answer.
 */
export async function searchIndex(
  snapshot: IndexSnapshot,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT);
  const trimmed = query.trim();
  const allowed = buildCandidates(snapshot.chunks, options);
  const candidates = allowed ? allowed.size : snapshot.chunks.length;

  if (trimmed.length === 0 || snapshot.chunks.length === 0 || candidates === 0) {
    return { query, hits: [], totalMatches: 0, candidates };
  }

  const lexical = bm25Rank(snapshot, queryTokens(trimmed), allowed, PER_SIGNAL_DEPTH);
  const symbols = symbolRank(snapshot.chunks, trimmed, allowed, PER_SIGNAL_DEPTH);

  let vectors: RankedEntry[] = [];
  if (options.embedder && snapshot.vectors && snapshot.vectors.size > 0) {
    const queryVector = await embedQuery(options.embedder, trimmed, options.signal);
    if (queryVector) vectors = vectorRank(snapshot, queryVector, allowed, PER_SIGNAL_DEPTH);
  }

  const lists: FusionList[] = [
    { signal: "bm25", entries: lexical, weight: BM25_WEIGHT },
    { signal: "symbol", entries: symbols, weight: SYMBOL_WEIGHT },
    { signal: "vector", entries: vectors, weight: VECTOR_WEIGHT },
  ];
  const fused = reciprocalRankFusion(lists);

  const hits: SearchHit[] = [];
  for (const entry of fused) {
    if (hits.length >= limit) break;
    const chunk = snapshot.chunks[entry.ordinal];
    if (!chunk) continue;
    hits.push({ chunk, score: entry.score, signals: entry.signals });
  }

  return { query, hits, totalMatches: fused.length, candidates };
}
