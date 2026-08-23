/**
 * Turning a {@link CodeChunk} into the "document" the retrieval layer indexes.
 *
 * BM25 has no native notion of fields, so field weighting is done the standard
 * cheap way — by repeating a field's terms. The weights below encode the one
 * empirical fact that matters most for code search: **the name is the signal.**
 * A term in a symbol's name is worth four times the same term in its doc
 * comment and far more than the same term buried in its body.
 *
 * Body identifiers are included exactly once each, deduplicated. That is
 * deliberate: it makes "the file that merely mentions `TokenBucket`" findable,
 * while ensuring it can never out-rank the declaration actually *named*
 * `TokenBucket`.
 */

import { tokenize, weightedTokens } from "./tokenize.js";
import type { CodeChunk } from "./types.js";

/** Field weights, highest signal first. */
const NAME_WEIGHT = 4;
const CONTAINER_WEIGHT = 2;
const SIGNATURE_WEIGHT = 2;
const DOC_WEIGHT = 1;
const PATH_WEIGHT = 1;

/** Cap on distinct body identifiers folded into a document. */
const MAX_BODY_TERMS = 400;

/**
 * The full term list for one chunk, with duplicates (term frequency is a BM25
 * input) and with field weighting applied by repetition.
 */
export function chunkDocumentTokens(chunk: CodeChunk): string[] {
  const tokens: string[] = [];
  tokens.push(...weightedTokens(chunk.name, NAME_WEIGHT));
  if (chunk.container) tokens.push(...weightedTokens(chunk.container, CONTAINER_WEIGHT));
  if (chunk.signature) tokens.push(...weightedTokens(chunk.signature, SIGNATURE_WEIGHT));
  if (chunk.doc) tokens.push(...weightedTokens(chunk.doc, DOC_WEIGHT));
  tokens.push(...weightedTokens(chunk.file, PATH_WEIGHT));
  tokens.push(chunk.kind);

  if (chunk.body) {
    const seen = new Set<string>();
    for (const term of tokenize(chunk.body)) {
      if (seen.has(term)) continue;
      seen.add(term);
      tokens.push(term);
      if (seen.size >= MAX_BODY_TERMS) break;
    }
  }
  return tokens;
}

/**
 * The compact natural-language description of a chunk handed to an
 * {@link "./types.js" | Embedder}.
 *
 * Never the body: embedding bodies is what makes indexing a repository
 * expensive, and the address-plus-signature is what the retriever returns
 * anyway. Kept to roughly one line so batches stay cheap.
 */
export function chunkEmbeddingText(chunk: CodeChunk): string {
  const qualified = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
  const parts = [`${chunk.kind} ${qualified}`, `in ${chunk.file}`];
  if (chunk.signature) parts.push(chunk.signature);
  if (chunk.doc) parts.push(chunk.doc);
  return parts.join(" — ");
}

/**
 * Query-side tokenization: the same splitter as the document side (so
 * `getUserById` and "user id" meet in the middle), deduplicated because a
 * repeated query term should not double-count against BM25.
 */
export function queryTokens(query: string): string[] {
  return [...new Set(tokenize(query))];
}
