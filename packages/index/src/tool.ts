/**
 * The `search_code` tool, and the session-scoped service behind it.
 *
 * The service exists separately from the tool for one reason: a host that
 * wants the index warm can call {@link CodeIndexService.ensureIndexed} at
 * session start and let the first search be instant. The tool itself never
 * assumes that happened — it refreshes with a wall-clock budget and answers
 * from whatever is ready, because "indexing must never make a session wait".
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult, ToolResultContent } from "@arcturn/types";
import { type FormatOptions, formatSearchResult } from "./format.js";
import { type ChunkFileFn, indexRepo } from "./indexer.js";
import { searchIndex } from "./search.js";
import { CodeIndexStore } from "./store.js";
import {
  CHUNK_KINDS,
  type ChunkKind,
  DETAIL_LEVELS,
  type DetailLevel,
  type Embedder,
  type IndexStats,
  type SearchOptions,
  type SearchResult,
} from "./types.js";
import type { WalkOptions } from "./walk.js";

// Local mirrors of `@arcturn/tools`'s result-utils.ts and path-utils.ts.
// Those modules are not part of the `@arcturn/tools` package's public export
// surface (only `resolvePath` is re-exported, and this package does not depend
// on `@arcturn/tools`), so — exactly as `packages/cli/src/lsp/symbols.ts`
// already does — the same shapes are built here rather than reaching across
// package boundaries. See "Integrating the tool" in this package's README.

/** Build a successful text-only tool result. */
function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const content: ToolResultContent[] = [{ type: "text", text }];
  return { content, details };
}

/** Build an error tool result (an expected failure, not a thrown exception). */
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Standard result returned when a tool observes `ctx.signal` has aborted. */
function abortedResult(): ToolResult {
  return errorResult("Aborted: the operation was cancelled before it completed.");
}

/** Resolve `path` against `cwd` and normalize it (mirrors `tools/path-utils.ts`). */
function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

/** Default wall-clock budget for the refresh performed at the start of a search. */
export const DEFAULT_REFRESH_BUDGET_MS = 4_000;

/** Minimum gap between refreshes of the same root within one session. */
export const DEFAULT_MIN_REFRESH_INTERVAL_MS = 2_000;

/** Where indexes live when the caller does not say otherwise. */
export function defaultIndexRoot(): string {
  return join(homedir(), ".arcturn", "index");
}

/** Per-root index directory: `<indexRoot>/<16 hex chars of sha1(root)>`. */
export function indexDirFor(indexRoot: string, root: string): string {
  return join(indexRoot, createHash("sha1").update(root).digest("hex").slice(0, 16));
}

/** Options shared by {@link CodeIndexService} and {@link createSearchCodeTool}. */
export interface CodeIndexOptions {
  /** Directory that holds per-repository indexes. Defaults to `~/.arcturn/index`. */
  indexRoot?: string;
  /** Optional semantic recall. **Off by default**; see {@link Embedder}. */
  embedder?: Embedder;
  /** Wall-clock budget for the pre-search refresh. Defaults to 4s. */
  refreshBudgetMs?: number;
  /** Minimum gap between refreshes of one root. Defaults to 2s. */
  minRefreshIntervalMs?: number;
  /** Per-file size cap handed to the indexer. */
  maxFileBytes?: number;
  /** Walk configuration (gitignore handling, extra ignores, file cap). */
  walk?: Omit<WalkOptions, "root" | "signal">;
  /** Substitute chunker, for instrumentation and tests. */
  chunkFile?: ChunkFileFn;
  /** Token budget for rendered results. Defaults to 1500. */
  tokenBudget?: number;
}

interface RootState {
  store: CodeIndexStore;
  lastRefreshAt: number;
  inFlight: Promise<IndexStats> | null;
  lastStats: IndexStats | null;
}

/**
 * A session-scoped, multi-root code index.
 *
 * One instance serves every working directory a session touches, keeping one
 * loaded store per root. Concurrent searches of the same root share a single
 * refresh rather than racing to reindex the same tree.
 */
export class CodeIndexService {
  private readonly options: CodeIndexOptions;
  private readonly indexRoot: string;
  /**
   * Keyed by *promise*, not by resolved state: opening a store is async, and
   * two searches issued in the same tick must share one store rather than each
   * opening their own and then racing to write the same index files.
   */
  private readonly roots = new Map<string, Promise<RootState>>();

  constructor(options: CodeIndexOptions = {}) {
    this.options = options;
    this.indexRoot = options.indexRoot ?? defaultIndexRoot();
  }

  /** The directory this service persists `root`'s index in. */
  directoryFor(root: string): string {
    return indexDirFor(this.indexRoot, root);
  }

  /** Load (once) and return the store for `root`. */
  async storeFor(root: string): Promise<CodeIndexStore> {
    return (await this.stateFor(root)).store;
  }

  private stateFor(root: string): Promise<RootState> {
    const existing = this.roots.get(root);
    if (existing) return existing;
    const opening = CodeIndexStore.open(this.directoryFor(root), root)
      .then((store): RootState => ({ store, lastRefreshAt: 0, inFlight: null, lastStats: null }))
      .catch((error) => {
        // A store that failed to open must not be cached as broken forever.
        this.roots.delete(root);
        throw error;
      });
    this.roots.set(root, opening);
    return opening;
  }

  /**
   * Bring `root`'s index up to date, bounded by a wall-clock budget.
   *
   * A cold index gets the full budget and may return partial — that is the
   * point: a partially indexed repository still answers most queries, and the
   * next call continues where this one stopped. Refreshes within
   * `minRefreshIntervalMs` are skipped entirely.
   */
  async ensureIndexed(
    root: string,
    signal?: AbortSignal,
    budgetMs = this.options.refreshBudgetMs ?? DEFAULT_REFRESH_BUDGET_MS,
  ): Promise<IndexStats | null> {
    const state = await this.stateFor(root);
    if (state.inFlight) return state.inFlight;

    const minInterval = this.options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
    const warm = state.store.chunkCount > 0;
    if (warm && Date.now() - state.lastRefreshAt < minInterval) return state.lastStats;

    const run = indexRepo({
      root,
      store: state.store,
      signal,
      deadline: Date.now() + budgetMs,
      chunkFile: this.options.chunkFile,
      maxFileBytes: this.options.maxFileBytes,
      walk: this.options.walk,
      embedder: this.options.embedder,
    })
      .then((stats) => {
        state.lastStats = stats;
        return stats;
      })
      .finally(() => {
        state.lastRefreshAt = Date.now();
        state.inFlight = null;
      });

    state.inFlight = run;
    return run;
  }

  /** Search `root`'s index, refreshing it first within the configured budget. */
  async search(
    root: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<{ result: SearchResult; stats: IndexStats | null }> {
    const stats = await this.ensureIndexed(root, options.signal);
    const state = await this.stateFor(root);
    const result = await searchIndex(state.store.snapshot(), query, {
      ...options,
      embedder: options.embedder ?? this.options.embedder,
    });
    return { result, stats };
  }
}

/** Parse the `kind` argument, which may be one kind or several. */
function parseKinds(raw: unknown): ChunkKind[] | undefined {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const kinds = values.filter(
    (value): value is ChunkKind =>
      typeof value === "string" && (CHUNK_KINDS as readonly string[]).includes(value),
  );
  return kinds.length > 0 ? kinds : undefined;
}

/** Parse the `detail` argument, falling back to the cheap default. */
function parseDetail(raw: unknown): DetailLevel {
  return typeof raw === "string" && (DETAIL_LEVELS as readonly string[]).includes(raw)
    ? (raw as DetailLevel)
    : "signatures";
}

const TOOL_DESCRIPTION = [
  "Search the codebase by symbol name or by meaning and get back ADDRESSES (file:line), not file",
  "contents. Backed by an always-available offline index that chunks source on declaration",
  "boundaries — functions, classes, methods, types, constants, and Markdown sections — across",
  "TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, Ruby, PHP, C/C++, C#, Swift, shell and",
  "Markdown, plus a whole-file entry for everything else. Identifiers are indexed split as well as",
  'whole, so `getUserById` is found by "user id".',
  "",
  "Prefer `search_code` over `grep` when:",
  "• you want where something is DEFINED and only half-remember the name;",
  '• the question is conceptual or structural — "where is auth handled", "what parses the config",',
  '  "which class implements retries";',
  "• you want a map of the symbols in an area before reading any file.",
  "",
  "Prefer `grep` over `search_code` when:",
  "• you need EVERY literal occurrence of an exact string or regex — call sites, a config key, a",
  "  TODO marker, a version string;",
  "• the text is not a symbol name, or lives in a file this index skips (binary, minified, over",
  "  1 MB, or gitignored).",
  "Use `glob` to find files by path pattern, and `symbols` when a language server is running and",
  "you want that language's own exact definitions for one file.",
  "",
  'Results default to detail="signatures" (~20-25 tokens per hit) because the cheapest next step',
  "is almost always `read` at the line returned — the result even names that call for you. Ask for",
  '"snippets" only when a signature is not enough to choose between hits, and "full" only when you',
  "genuinely need bodies; both cost several times more tokens for the same hits. Every result is",
  "capped by a token budget and states how many matches it withheld.",
].join("\n");

/**
 * Create the `search_code` tool.
 *
 * Read-only: no permission is requested, matching `grep`, `glob`, and
 * `symbols`.
 */
export function createSearchCodeTool(options: CodeIndexOptions = {}): Tool {
  const service = new CodeIndexService(options);

  return {
    definition: {
      name: "search_code",
      description: TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to find: a symbol name (exact or partial), or a few words describing the " +
              "behavior you are looking for.",
          },
          kind: {
            description:
              "Restrict to one or more declaration kinds. Use this before widening a query — it " +
              "is the cheapest way to cut a noisy result down.",
            oneOf: [
              { type: "string", enum: [...CHUNK_KINDS] },
              { type: "array", items: { type: "string", enum: [...CHUNK_KINDS] } },
            ],
          },
          path: {
            type: "string",
            description:
              "Restrict to files matching a glob ('src/**', '*.py') or containing a substring " +
              "('/auth/'). Paths are repo-relative with forward slashes.",
          },
          limit: {
            type: "number",
            description: "Maximum hits to return. Defaults to 20.",
          },
          detail: {
            type: "string",
            enum: [...DETAIL_LEVELS],
            description:
              "'signatures' (default, cheapest) returns one line per hit; 'snippets' adds a few " +
              "lines of body; 'full' returns bodies. Prefer reading the file at the returned line " +
              "over asking for 'full'.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },

    async execute(input, ctx: ToolExecutionContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const query = input.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        return errorResult("`query` is required and must be a non-empty string.");
      }

      const root = resolvePath(ctx.cwd, ".");
      if (!isAbsolute(root)) {
        return errorResult(`Cannot index a non-absolute working directory: ${ctx.cwd}`);
      }

      const searchOptions: SearchOptions = {
        kind: parseKinds(input.kind),
        path: typeof input.path === "string" && input.path.length > 0 ? input.path : undefined,
        limit:
          typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : undefined,
        signal: ctx.signal,
      };
      const detail = parseDetail(input.detail);

      let searched: { result: SearchResult; stats: IndexStats | null };
      try {
        searched = await service.search(root, query, searchOptions);
      } catch (error) {
        return errorResult(`Code index unavailable: ${(error as Error).message}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const formatOptions: FormatOptions = { detail, tokenBudget: options.tokenBudget };
      const formatted = formatSearchResult(searched.result, formatOptions);

      const stats = searched.stats;
      const warming = stats?.aborted === true;
      const text = warming
        ? `${formatted.text}\n(The index is still warming up — ${stats?.filesScanned ?? 0} files scanned so far. Re-run for fuller coverage.)`
        : formatted.text;

      return textResult(text, {
        matchCount: searched.result.totalMatches,
        shown: formatted.shown,
        omitted: formatted.omitted,
        truncated: formatted.truncated,
        estimatedTokens: formatted.estimatedTokens,
        detail,
        candidates: searched.result.candidates,
        indexedFiles: stats?.filesScanned,
        indexedChunks: stats?.totalChunks,
        indexWarming: warming,
        nextStep: formatted.nextStep,
      });
    },
  };
}
