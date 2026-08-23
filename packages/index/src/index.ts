/**
 * `@arcturn/index` — a token-optimized code index for the Arcturn agent harness.
 *
 * ## The governing principle
 *
 * An index's token cost is what it puts in the model's context, not what it
 * costs to build. A retrieval tool that returns whole file bodies is *worse*
 * than `grep`, because it spends thousands of tokens answering a question the
 * agent could have answered with a `file:line`. So retrieval here returns
 * **addresses, not content**, and the agent reads only what it decides it
 * needs, with the tools it already has.
 *
 * ## The pipeline
 *
 * ```text
 *  walk ──► chunk ──────► store ──────────► search ────────► format ──► tool
 *   │        │             │                 │                │
 *   │        │             │                 │                └─ hard token budget,
 *   │        │             │                 │                   per-file collapsing,
 *   │        │             │                 │                   an explicit `read` hint
 *   │        │             │                 └─ BM25 ⊕ symbol-name ⊕ (optional) vectors,
 *   │        │             │                    merged by Reciprocal Rank Fusion
 *   │        │             └─ JSONL chunks + a compact inverted index,
 *   │        │                keyed by content hash so `git checkout` is free
 *   │        └─ declaration boundaries per language, never fixed windows;
 *   │           an unparseable file still indexes as one whole-file chunk
 *   └─ .gitignore-aware, binary/minified/oversize-skipping, interruptible
 * ```
 *
 * ## Relationship to the LSP `symbols` tool
 *
 * `symbols` (in `@arcturn/cli`) is the **precise** path: when a language
 * server is running for a file's language, it knows the real symbol table.
 * This package is the **always-available** path: no server, no network, every
 * file type including prose and config, and fuzzy matching that
 * `workspace/symbol` does not attempt. They are complements — use `symbols`
 * when you have a server and want ground truth for one language, and
 * `search_code` when you want to find your way around a repository.
 *
 * ## Quick start
 *
 * ```ts
 * import { createSearchCodeTool } from "@arcturn/index";
 *
 * const searchCode = createSearchCodeTool();
 * // register alongside the built-in tools; it indexes ctx.cwd on first use
 * ```
 */

export { BM25_B, BM25_K1, bm25Rank, type RankedEntry, topEntries } from "./bm25.js";
export {
  chunkFile,
  MAX_BODY_CHARS,
  MAX_BODY_LINES,
  MAX_CONTAINER_BODY_LINES,
  MAX_DOC_CHARS,
  MAX_SIGNATURE_CHARS,
} from "./chunker.js";
export { chunkDocumentTokens, chunkEmbeddingText, queryTokens } from "./document.js";
export { cosineSimilarity, embedQuery, vectorRank } from "./embedder.js";
export {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_HITS_PER_FILE,
  DEFAULT_TOKEN_BUDGET,
  type FormatOptions,
  type FormattedSearchResult,
  formatSearchResult,
  hitLabel,
  nextStepFor,
} from "./format.js";
export { type FusedEntry, type FusionList, RRF_K, reciprocalRankFusion } from "./fusion.js";
export { IgnoreMatcher, parseIgnoreFile } from "./gitignore.js";
export {
  type ChunkFileFn,
  DEFAULT_MAX_FILE_BYTES,
  type IndexRepoOptions,
  indexRepo,
  looksBinary,
  looksMinified,
  type SkipReason,
} from "./indexer.js";
export {
  type BlockStyle,
  type DeclarationRule,
  detectLanguage,
  LANGUAGE_RULES,
  type LanguageRules,
  rulesFor,
} from "./language.js";
export { type CommentSyntax, type MaskedSource, maskSource, splitLines } from "./mask.js";
export {
  DEFAULT_DAMPING,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TOLERANCE,
  type PageRankAdjacency,
  type PageRankEdge,
  type PageRankOptions,
  type PageRankResult,
  pageRank,
} from "./pagerank.js";
export {
  buildReferenceGraph,
  buildRepoMap,
  DEFAULT_REPO_MAP_TOKEN_BUDGET,
  edgeMultiplier,
  type ReferenceEdge,
  type ReferenceGraph,
  type RenderedRepoMap,
  type RenderRepoMapOptions,
  type RepoMap,
  type RepoMapDefinition,
  type RepoMapOptions,
  type RepoMapStats,
  renderRepoMap,
} from "./repomap.js";
export {
  declarationEnd,
  indentHeaderEnd,
  indentOf,
  type RawDeclaration,
  scanDeclarations,
} from "./scanner.js";
export {
  compilePathFilter,
  DEFAULT_SEARCH_LIMIT,
  searchIndex,
} from "./search.js";
export {
  buildPostings,
  CodeIndexStore,
  contentHash,
  type FileRecord,
  INDEX_FORMAT_VERSION,
  type IndexSnapshot,
} from "./store.js";
export {
  createFindReferencesTool,
  createFindSymbolTool,
  createStructuralTools,
  DEFAULT_MAX_OCCURRENCES,
  DEFAULT_MAX_REFERENCE_FILES,
  FIND_REFERENCES_DESCRIPTION,
  FIND_SYMBOL_DESCRIPTION,
  type FindReferencesOptions,
  type FindSymbolQuery,
  type FindSymbolResult,
  findReferences,
  findSymbols,
  formatReferences,
  formatSymbolMatches,
  type OccurrenceContext,
  type RawOccurrence,
  type ReferencesResult,
  type RenderedStructuralResult,
  type ResolvedReference,
  type StructuralFormatOptions,
  type StructuralToolOptions,
  type SymbolMatch,
  type SymbolMatchType,
  scanOccurrences,
  type UnresolvedReason,
  type UnresolvedReference,
  wholeWordPattern,
} from "./structural.js";
export { symbolRank, symbolScore } from "./symbol-score.js";
export {
  estimateTokens,
  expandIdentifier,
  splitIdentifier,
  tokenize,
  tokenizePath,
  weightedTokens,
} from "./tokenize.js";
export {
  type CodeIndexOptions,
  CodeIndexService,
  createSearchCodeTool,
  DEFAULT_MIN_REFRESH_INTERVAL_MS,
  DEFAULT_REFRESH_BUDGET_MS,
  defaultIndexRoot,
  indexDirFor,
} from "./tool.js";
export {
  CHUNK_KINDS,
  type ChunkKind,
  type CodeChunk,
  DETAIL_LEVELS,
  type DetailLevel,
  type Embedder,
  type HitSignals,
  type IndexStats,
  type LanguageId,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from "./types.js";
export {
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_MAX_FILES,
  type WalkOptions,
  walkRepository,
} from "./walk.js";
