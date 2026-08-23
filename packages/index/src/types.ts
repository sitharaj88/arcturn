/**
 * Core data types for `@arcturn/index` — Arcturn's token-optimized code index.
 *
 * The governing principle of this package: **an index's token cost is what it
 * puts into the model's context, not what it costs to build.** Every type here
 * follows from that. Retrieval returns *addresses* (`file:line`) plus the
 * smallest useful description of a symbol; bodies live on disk and are only
 * returned when the caller explicitly opts in.
 *
 * This index complements — never duplicates — the LSP-backed `symbols` tool in
 * `@arcturn/cli`. That one is the *precise* path when a language server is
 * running for the file's language. This one is the *always-available* path: it
 * works offline, needs no server, covers every file type, and answers fuzzy
 * questions ("where is auth handled") that `workspace/symbol` cannot.
 */

/**
 * What a chunk represents. Kept deliberately close to LSP `SymbolKind` naming
 * so a caller can filter with the same vocabulary it uses for `symbols`, plus
 * a few language-family specifics (`trait`, `impl`, `extension`, `macro`) and
 * two synthetic kinds:
 *
 * - `section` — a Markdown heading and the prose beneath it.
 * - `file` — the whole-file fallback chunk, emitted when a file yields no
 *   declarations at all (config, data, prose, or an unparseable source file).
 */
export type ChunkKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "extension"
  | "type"
  | "const"
  | "property"
  | "module"
  | "macro"
  | "section"
  | "file";

/** Every `ChunkKind`, for validation and for the tool's JSON schema enum. */
export const CHUNK_KINDS: readonly ChunkKind[] = [
  "function",
  "method",
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "impl",
  "extension",
  "type",
  "const",
  "property",
  "module",
  "macro",
  "section",
  "file",
];

/** Language families the chunker knows how to scan. `text` is the fallback. */
export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "ruby"
  | "php"
  | "c"
  | "cpp"
  | "csharp"
  | "swift"
  | "shell"
  | "markdown"
  | "text";

/**
 * One indexed unit of code: a declaration boundary, not a fixed line window.
 *
 * Fixed windows split functions in half and retrieve meaningless fragments;
 * chunking on declarations means every hit is a thing a developer can name.
 */
export interface CodeChunk {
  /**
   * Stable identity: `${file}:${startLine}:${name}`. Stable across reindexes
   * as long as the declaration stays put, which lets vectors and any future
   * side tables be keyed without a separate id allocator.
   */
  id: string;
  /** Repo-relative path with POSIX separators — the address half of a hit. */
  file: string;
  /** 1-based line of the declaration itself (not of its doc comment). */
  startLine: number;
  /** 1-based inclusive last line of the declaration's body. */
  endLine: number;
  /** What kind of thing this is; lets callers filter cheaply. */
  kind: ChunkKind;
  /** Bare symbol name (`tryConsume`), without its container. */
  name: string;
  /** Dotted container path (`TokenBucket`, `Outer.Inner`) when nested. */
  container?: string;
  /** The declaration line(s), collapsed and capped — returned instead of the body. */
  signature?: string;
  /** Leading comment / docstring, collapsed and capped. Carries intent identifiers do not. */
  doc?: string;
  /** Full source of the declaration. **Stored, never returned by default.** */
  body?: string;
  /** Which scanner produced this chunk. */
  language: LanguageId;
}

/** How much of each hit to render. The whole token story lives here. */
export type DetailLevel = "signatures" | "snippets" | "full";

/** Every `DetailLevel`, for validation and the tool schema. */
export const DETAIL_LEVELS: readonly DetailLevel[] = ["signatures", "snippets", "full"];

/**
 * Optional semantic recall, **off by default**.
 *
 * Embedding a repository costs real tokens (and usually real money): a 5k-file
 * codebase is millions of tokens through an embedding endpoint. The BM25 +
 * symbol-name hybrid answers the great majority of code queries for zero
 * marginal cost, so this seam exists to be plugged in deliberately, never by
 * accident. When present, its ranking is fused in as one more list — it never
 * replaces the lexical signals.
 */
export interface Embedder {
  /**
   * Identifies the model/config. Stored alongside the vectors; if it changes,
   * the persisted vectors are discarded rather than silently mixed.
   */
  readonly id: string;
  /** Vector width. Vectors of any other width are rejected on load. */
  readonly dimensions: number;
  /** Embed a batch. Implementations should honor `signal` if they can. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

/** Which signals contributed to a hit, and at what rank. Useful for debugging relevance. */
export interface HitSignals {
  /** 1-based rank in the BM25 list, if it appeared there. */
  bm25?: number;
  /** 1-based rank in the symbol-name list, if it appeared there. */
  symbol?: number;
  /** 1-based rank in the embedding list, if an `Embedder` was configured. */
  vector?: number;
}

/** One retrieved chunk with its fused score and provenance. */
export interface SearchHit {
  chunk: CodeChunk;
  /** Reciprocal-rank-fusion score. Comparable within one result, not across queries. */
  score: number;
  signals: HitSignals;
}

/** Filters and knobs for {@link "./search.js" | searchIndex}. */
export interface SearchOptions {
  /** Restrict to one or more {@link ChunkKind}s. */
  kind?: ChunkKind | readonly ChunkKind[];
  /** Restrict by path: a glob (`src/**`, `*.py`) or a plain substring. */
  path?: string;
  /** Maximum hits to return. Defaults to 20. */
  limit?: number;
  /** Optional semantic signal. Omitted by default; see {@link Embedder}. */
  embedder?: Embedder;
  /** Cancels a long fusion pass on a very large index. */
  signal?: AbortSignal;
}

/** The ranked result of one search, before rendering. */
export interface SearchResult {
  query: string;
  /** Hits in fused rank order, capped at `limit`. */
  hits: SearchHit[];
  /** How many chunks matched at all, before the `limit` cap. */
  totalMatches: number;
  /** How many chunks were considered (after `kind`/`path` filtering). */
  candidates: number;
}

/** What one indexing pass did. Returned by `indexRepo` and surfaced in tool details. */
export interface IndexStats {
  /** Files the walker offered to the indexer. */
  filesScanned: number;
  /** Files whose content hash changed (or were new) and were re-chunked. */
  filesIndexed: number;
  /** Files skipped as binary, oversized, minified, or unreadable. */
  filesSkipped: number;
  /** Files present in the index but gone from disk; their chunks were dropped. */
  filesRemoved: number;
  /** Chunks produced by this pass (only for re-chunked files). */
  chunksIndexed: number;
  /** Total chunks in the index after this pass. */
  totalChunks: number;
  /** Wall-clock duration of the pass. */
  durationMs: number;
  /** True when the pass stopped early (abort signal or time budget). */
  aborted: boolean;
}
