/**
 * Structural lookup: `find_symbol` and `find_references`.
 *
 * ## Why these are separate tools from `search_code`
 *
 * Retrieval splits into two epistemic categories, and collapsing them into one
 * best-effort ranked list caps the first category's accuracy for no reason:
 *
 * | Query class | Answer set | Achievable |
 * |---|---|---|
 * | "where is the symbol named `X` defined" | closed, enumerable | ~100% over indexed definitions |
 * | "where do we handle retries" | open, judgement-dependent | HitFile 0.65–0.85 |
 *
 * `search_code` answers the second kind: it ranks, it fuses signals, and its
 * order is a guess. The two tools here answer the first kind: they **enumerate**
 * and they **do not rank**. Their order is a documented sort, not a relevance
 * judgement, and the caller can reproduce it by hand.
 *
 * ## The honesty contract
 *
 * A structural tool that reports "3 callers" as *the* callers is worse than
 * `grep`, because it stops the agent looking. PyCG measured 84.9% completeness
 * on curated call graphs; reflection, dynamic dispatch, string-keyed dispatch
 * and DI defeat every static analyzer. So every result here declares what it
 * could not resolve:
 *
 * - {@link findReferences} splits occurrences into **resolved** (inside an
 *   indexed declaration, with the enclosing symbol named) and **unresolved**
 *   (in a comment, in a string literal, at file scope, or in a file the
 *   chunker could not parse), and reports both counts in the first line.
 * - {@link findSymbols} reports the indexed code files that yielded no
 *   declarations at all, because definitions inside them genuinely are not in
 *   the answer set.
 * - Neither tool ever truncates silently: an omitted match is always counted.
 *
 * ## Relationship to the LSP `symbols` tool
 *
 * `symbols` (in `@arcturn/cli`) is the precise path *when a language server
 * is running for that file's language*: it knows the real symbol table,
 * including type-directed resolution this index cannot do. These tools are the
 * always-available path — offline, no server, every language the chunker
 * knows, plus a whole-file fallback for the rest. Use `symbols` for ground
 * truth in one language; use these when there is no server, when the question
 * spans languages, or when you want the textual occurrences a symbol table
 * deliberately omits.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult, ToolResultContent } from "@arcturn/types";
import { DEFAULT_TOKEN_BUDGET, hitLabel } from "./format.js";
import { detectLanguage, rulesFor } from "./language.js";
import { maskSource } from "./mask.js";
import { compilePathFilter } from "./search.js";
import { estimateTokens } from "./tokenize.js";
import { type CodeIndexOptions, CodeIndexService } from "./tool.js";
import { CHUNK_KINDS, type ChunkKind, type CodeChunk, type LanguageId } from "./types.js";

// Local mirrors of the result/path helpers `tool.ts` also keeps private. Those
// live in `@arcturn/tools`, which this package deliberately does not depend
// on; `tool.ts` and `packages/cli/src/lsp/symbols.ts` both re-declare them for
// the same reason, so this file follows the established pattern rather than
// widening an existing module's export surface.

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
function resolveCwd(cwd: string): string {
  return resolve(cwd, ".");
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Indexed files read by one {@link findReferences} call before it stops and
 * says so.
 *
 * A reference scan reads file bytes, which is the one genuinely unbounded cost
 * in this package. The cap exists so a 50k-file monorepo cannot turn one tool
 * call into a minute of I/O; when it bites, the result reports how many files
 * went unsearched rather than pretending the answer is complete.
 */
export const DEFAULT_MAX_REFERENCE_FILES = 5_000;

/** Occurrences collected before a scan stops and reports the cap. */
export const DEFAULT_MAX_OCCURRENCES = 5_000;

/** Characters of source line shown beside an occurrence. */
const MAX_SOURCE_CHARS = 68;

/** Rendered label cap, matching `format.ts`'s discipline. */
const MAX_LABEL_CHARS = 90;

/** Tokens held back for the header, the omission notices, and the fallback hint. */
const RESERVED_TOKENS = 110;

/**
 * Share of the body budget reserved for the unresolved section.
 *
 * The unresolved list is the feature, not the footnote: it is what keeps the
 * agent looking when static analysis is incomplete. Reserving room for it means
 * a symbol with hundreds of clean references can never crowd the three
 * string-keyed occurrences that actually explain a bug out of the output.
 */
const UNRESOLVED_BUDGET_SHARE = 0.35;

/** Unparsed code files named individually before the rest become a count. */
const MAX_LISTED_UNPARSED_FILES = 3;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** A rendered structural result plus the accounting behind it. */
export interface RenderedStructuralResult {
  /** The text handed to the model. */
  text: string;
  /** Rows actually rendered. */
  shown: number;
  /** Rows withheld by the token budget. Always reported in {@link text} too. */
  omitted: number;
  /** True when the budget stopped the render. */
  truncated: boolean;
  /** `chars / 4` estimate of {@link text}. */
  estimatedTokens: number;
}

/** Options accepted by every renderer here. */
export interface StructuralFormatOptions {
  /** Hard token ceiling for the whole result. Defaults to 1500. */
  tokenBudget?: number;
}

/** Trim to `max` characters with an ellipsis, preferring a word boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** `TokenBucket.tryConsume`, or just `tryConsume` at top level. */
function qualifiedName(chunk: CodeChunk): string {
  return chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
}

/** Group chunks by their file, preserving source order within each file. */
function groupChunksByFile(chunks: readonly CodeChunk[]): Map<string, CodeChunk[]> {
  const byFile = new Map<string, CodeChunk[]>();
  for (const chunk of chunks) {
    const existing = byFile.get(chunk.file);
    if (existing) existing.push(chunk);
    else byFile.set(chunk.file, [chunk]);
  }
  return byFile;
}

// ---------------------------------------------------------------------------
// find_symbol
// ---------------------------------------------------------------------------

/**
 * How a definition matched the query.
 *
 * This is a *classification*, not a score: it exists so the render can put
 * exact matches above prefix matches deterministically, and so a truncated
 * result never drops the exact match in favour of an alphabetically earlier
 * prefix match. Within one class the order is purely `path`, then line.
 */
export type SymbolMatchType = "exact" | "prefix";

/** One matching definition. */
export interface SymbolMatch {
  chunk: CodeChunk;
  matchType: SymbolMatchType;
}

/** Input to {@link findSymbols}. */
export interface FindSymbolQuery {
  /**
   * The symbol name. Matching is case-insensitive. A name containing a dot
   * (`TokenBucket.tryConsume`) is matched against the qualified name instead
   * of the bare one.
   */
  name: string;
  /** Restrict to one or more {@link ChunkKind}s. */
  kind?: ChunkKind | readonly ChunkKind[];
  /** `true` requires whole-name equality; the default also accepts prefixes. */
  exact?: boolean;
}

/** The complete, unranked answer set for one symbol lookup. */
export interface FindSymbolResult {
  /** The name as asked for. */
  name: string;
  /** Whether prefix matches were accepted. */
  exact: boolean;
  /**
   * **Every** matching definition, in the documented order: exact matches
   * first, then prefix matches; within each, by path then by line. Never
   * truncated — truncation happens only at render time, and is counted there.
   */
  matches: SymbolMatch[];
  /** Distinct files the matches live in. */
  files: number;
  /** Indexed definitions considered (after the `kind` filter). */
  searched: number;
  /**
   * Indexed files in a language the chunker has rules for that nonetheless
   * yielded no declarations — so any definition inside them is genuinely
   * outside this tool's answer set. Sorted, and reported to the caller.
   */
  unparsedFiles: string[];
}

/** Normalize the `kind` filter into a set, or null when unfiltered. */
function kindSet(kind: FindSymbolQuery["kind"]): ReadonlySet<ChunkKind> | null {
  if (kind === undefined) return null;
  const kinds = Array.isArray(kind) ? kind : [kind as ChunkKind];
  return kinds.length > 0 ? new Set(kinds) : null;
}

/** Files whose language has declaration rules but which produced no declaration. */
function unparsedCodeFiles(chunks: readonly CodeChunk[]): string[] {
  const parsed = new Set<string>();
  const fallbackOnly = new Map<string, LanguageId>();
  for (const chunk of chunks) {
    if (chunk.kind === "file") {
      if (!parsed.has(chunk.file)) fallbackOnly.set(chunk.file, chunk.language);
      continue;
    }
    parsed.add(chunk.file);
    fallbackOnly.delete(chunk.file);
  }
  const out: string[] = [];
  for (const [file, language] of fallbackOnly) {
    if (rulesFor(language).declarations.length > 0) out.push(file);
  }
  return out.sort();
}

/**
 * Enumerate every indexed definition named `name`.
 *
 * Exhaustive over the chunks it is handed: it is a linear scan with no cutoff,
 * no ranking and no scoring. Two definitions that both match are both returned,
 * in a stable order the caller can predict.
 *
 * @param chunks - Every chunk in the index (`store.allChunks()`).
 * @returns The complete answer set plus the caveat about unparsed files.
 */
export function findSymbols(
  chunks: readonly CodeChunk[],
  query: FindSymbolQuery,
): FindSymbolResult {
  const needle = query.name.trim();
  const exact = query.exact === true;
  const lowered = needle.toLowerCase();
  const qualifiedLookup = needle.includes(".");
  const kinds = kindSet(query.kind);

  const matches: SymbolMatch[] = [];
  let searched = 0;

  for (const chunk of chunks) {
    if (kinds && !kinds.has(chunk.kind)) continue;
    searched++;
    if (lowered.length === 0) continue;
    const candidate = (qualifiedLookup ? qualifiedName(chunk) : chunk.name).toLowerCase();
    if (candidate === lowered) {
      matches.push({ chunk, matchType: "exact" });
      continue;
    }
    if (!exact && candidate.startsWith(lowered)) matches.push({ chunk, matchType: "prefix" });
  }

  matches.sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === "exact" ? -1 : 1;
    if (a.chunk.file !== b.chunk.file) return a.chunk.file < b.chunk.file ? -1 : 1;
    if (a.chunk.startLine !== b.chunk.startLine) return a.chunk.startLine - b.chunk.startLine;
    return qualifiedName(a.chunk) < qualifiedName(b.chunk) ? -1 : 1;
  });

  const files = new Set(matches.map((match) => match.chunk.file));
  return {
    name: needle,
    exact,
    matches,
    files: files.size,
    searched,
    unparsedFiles: unparsedCodeFiles(chunks),
  };
}

/** `path:line  kind name(signature)` — the whole render of one definition. */
function symbolLine(match: SymbolMatch): string {
  const { chunk } = match;
  const label = hitLabel({ chunk, score: 0, signals: {} });
  return `${chunk.file}:${chunk.startLine}  ${chunk.kind} ${clip(label, MAX_LABEL_CHARS)}`;
}

/** The caveat line naming indexed code files that produced no declarations. */
function unparsedNotice(files: readonly string[]): string | null {
  if (files.length === 0) return null;
  const listed = files.slice(0, MAX_LISTED_UNPARSED_FILES).join(", ");
  const rest = files.length - Math.min(files.length, MAX_LISTED_UNPARSED_FILES);
  const tail = rest > 0 ? ` and ${rest} more` : "";
  return (
    `Not covered: ${files.length} indexed code file${files.length === 1 ? "" : "s"} ` +
    `yielded no parsed declarations (${listed}${tail}). ` +
    "Definitions inside them are not in this answer set — use `find_references` or `grep`."
  );
}

/**
 * Render a {@link FindSymbolResult} within a hard token budget.
 *
 * Rows are emitted in {@link FindSymbolResult.matches} order and stop at the
 * budget, which is the only thing that ever removes a row — and it always says
 * exactly how many rows it removed.
 */
export function formatSymbolMatches(
  result: FindSymbolResult,
  options: StructuralFormatOptions = {},
): RenderedStructuralResult {
  const budget = Math.max(120, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const caveat = unparsedNotice(result.unparsedFiles);
  const mode = result.exact ? "exact" : "exact or prefix";

  if (result.matches.length === 0) {
    const lines = [
      `No indexed definition named "${result.name}" (${mode} match over ` +
        `${result.searched} indexed definition${result.searched === 1 ? "" : "s"}).`,
    ];
    if (result.exact)
      lines.push('Retry with exact:false for a prefix match ("Token" → "TokenBucket").');
    lines.push(
      "If the name is right, the definition is outside the index: try `search_code` for a " +
        "fuzzy or conceptual query, or `grep` for a literal string.",
    );
    if (caveat) lines.push(caveat);
    const text = lines.join("\n");
    return { text, shown: 0, omitted: 0, truncated: false, estimatedTokens: estimateTokens(text) };
  }

  const header =
    `${result.name}: ${result.matches.length} definition${result.matches.length === 1 ? "" : "s"} ` +
    `in ${result.files} file${result.files === 1 ? "" : "s"} (${mode} match, ` +
    "complete — sorted by path, exact matches first, not ranked)";

  const available = Math.max(60, budget - RESERVED_TOKENS) - estimateTokens(header);
  const rows: string[] = [];
  let used = 0;
  let shown = 0;

  for (const match of result.matches) {
    const line = symbolLine(match);
    const cost = estimateTokens(line) + 1;
    if (shown > 0 && used + cost > available) break;
    rows.push(line);
    used += cost;
    shown++;
  }

  const omitted = result.matches.length - shown;
  const lines = [header, ...rows];
  if (omitted > 0) {
    lines.push(
      `… ${omitted} more definition${omitted === 1 ? "" : "s"} not shown (token budget reached; ` +
        `${result.matches.length} matched in total). Narrow with kind: or a longer name.`,
    );
  }
  if (shown === 1) {
    const only = result.matches[0];
    if (only) {
      const span = Math.min(only.chunk.endLine - only.chunk.startLine + 1, 200);
      lines.push(
        `Next: read({"path":"${only.chunk.file}","offset":${only.chunk.startLine},` +
          `"limit":${span}}) for ${qualifiedName(only.chunk)}.`,
      );
    }
  }
  if (caveat) lines.push(caveat);

  const text = lines.join("\n");
  return {
    text,
    shown,
    omitted,
    truncated: omitted > 0,
    estimatedTokens: estimateTokens(text),
  };
}

// ---------------------------------------------------------------------------
// Occurrence scanning
// ---------------------------------------------------------------------------

/** Where in the source an occurrence physically sits. */
export type OccurrenceContext = "code" | "comment" | "string";

/** One textual occurrence of an identifier, before the index attributes it. */
export interface RawOccurrence {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  context: OccurrenceContext;
  /** The source line, trimmed. */
  text: string;
}

/** Identifier characters, for the whole-word boundary assertions. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * A whole-word matcher for `name`.
 *
 * Boundary assertions are applied only on the sides where `name` actually ends
 * in an identifier character, so a dotted or punctuated query still matches.
 */
export function wholeWordPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const first = name[0] ?? "";
  const last = name[name.length - 1] ?? "";
  const before = IDENTIFIER_CHAR.test(first) ? "(?<![A-Za-z0-9_$])" : "";
  const after = IDENTIFIER_CHAR.test(last) ? "(?![A-Za-z0-9_$])" : "";
  return new RegExp(`${before}${escaped}${after}`, "g");
}

/**
 * Every whole-word occurrence of `name` in `text`, classified as code, comment
 * or string.
 *
 * Exhaustive by construction: it is a literal scan of every line, which is the
 * one retrieval class where 100% is real and checkable against a second
 * implementation.
 *
 * Classification uses two masking passes. The first is the language's real
 * mask (comments *and* strings blanked), so anything it preserves is code. The
 * second blanks comments only, so anything it preserves but the first blanked
 * was inside a string literal. The residual ambiguity — a string literal that
 * itself contains a comment introducer, e.g. `"http://host/name"` — is labelled
 * `comment`; it is unresolved either way, so only the label is affected.
 *
 * Two known approximations, both erring toward *reporting* an occurrence as
 * unattributed rather than dropping or over-claiming it:
 *
 * - A template-literal interpolation (`` `${charge}` ``) is inside the string
 *   as far as the mask is concerned, so a genuine reference there is reported
 *   under "not attributed" rather than resolved. It is still counted.
 * - The mask is heuristic per language family, so a pathological file may
 *   mis-split code and comment. The occurrence still appears; only its label
 *   can be wrong.
 */
export function scanOccurrences(text: string, name: string, language: LanguageId): RawOccurrence[] {
  if (name.length === 0 || !text.includes(name)) return [];
  const syntax = rulesFor(language).syntax;
  const full = maskSource(text, syntax);
  const commentsOnly = maskSource(text, { ...syntax, strings: [], multiline: [] });
  const pattern = wholeWordPattern(name);

  const out: RawOccurrence[] = [];
  for (let i = 0; i < full.lines.length; i++) {
    const raw = full.lines[i] ?? "";
    if (!raw.includes(name)) continue;
    const maskedFull = full.masked[i] ?? "";
    const maskedComments = commentsOnly.masked[i] ?? "";
    pattern.lastIndex = 0;
    let match = pattern.exec(raw);
    while (match !== null) {
      const column = match.index;
      const context: OccurrenceContext = maskedFull.startsWith(name, column)
        ? "code"
        : maskedComments.startsWith(name, column)
          ? "string"
          : "comment";
      out.push({ line: i + 1, column: column + 1, context, text: raw.trim() });
      match = pattern.exec(raw);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// find_references
// ---------------------------------------------------------------------------

/** Why an occurrence could not be attributed to an indexed symbol. */
export type UnresolvedReason =
  /** Inside a comment — documentation, not a reference. */
  | "comment"
  /** Inside a string literal — the classic string-keyed dispatch blind spot. */
  | "string"
  /** Code at file scope: an import, a re-export, a top-level statement. */
  | "file-scope"
  /** The chunker parsed no declarations in this file, so nothing can enclose it. */
  | "unparsed-file";

/** One occurrence the index could attribute to an enclosing declaration. */
export interface ResolvedReference {
  /** Repo-relative path with POSIX separators. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Qualified name of the enclosing declaration, e.g. `TokenBucket.tryConsume`. */
  symbol: string;
  /** Kind of the enclosing declaration. */
  kind: ChunkKind;
  /** True when this occurrence *is* the declaration of `name`, not a use of it. */
  definition: boolean;
  /** The source line, trimmed. */
  text: string;
}

/** One occurrence the index could not attribute — the honest half of the result. */
export interface UnresolvedReference {
  file: string;
  line: number;
  column: number;
  reason: UnresolvedReason;
  text: string;
}

/** Input to {@link findReferences}. */
export interface FindReferencesOptions {
  /** Absolute repository root; occurrences are read from disk beneath it. */
  root: string;
  /** Every chunk in the index (`store.allChunks()`), used for attribution. */
  chunks: readonly CodeChunk[];
  /** The identifier to look for. Matched whole-word, case-sensitively. */
  name: string;
  /** Restrict to files matching a glob (`src/**`) or containing a substring. */
  path?: string;
  /** Indexed files to read before stopping. Defaults to {@link DEFAULT_MAX_REFERENCE_FILES}. */
  maxFiles?: number;
  /** Occurrences to collect before stopping. Defaults to {@link DEFAULT_MAX_OCCURRENCES}. */
  maxOccurrences?: number;
  /** Cancels the scan between files. */
  signal?: AbortSignal;
}

/** The complete occurrence set for one identifier, split by what could be attributed. */
export interface ReferencesResult {
  name: string;
  /** Occurrences inside an indexed declaration, sorted by path, line, column. */
  resolved: ResolvedReference[];
  /** Occurrences that could not be attributed, same sort. */
  unresolved: UnresolvedReference[];
  /** Distinct files containing at least one resolved reference. */
  filesWithReferences: number;
  /** Indexed files actually read. */
  filesSearched: number;
  /** Indexed files that could not be read now (deleted or unreadable since indexing). */
  filesUnreadable: number;
  /** Indexed files left unread because a cap was reached. */
  filesNotSearched: number;
  /** True when a file or occurrence cap stopped the scan early. */
  capped: boolean;
}

/**
 * The innermost indexed declaration covering `line`.
 *
 * `file` chunks are excluded on purpose: a whole-file fallback names no symbol,
 * so an occurrence "inside" one is exactly the case this tool must report as
 * unresolved rather than dress up as a reference.
 */
function enclosingChunk(chunks: readonly CodeChunk[], line: number): CodeChunk | undefined {
  let best: CodeChunk | undefined;
  for (const chunk of chunks) {
    if (chunk.kind === "file") continue;
    if (chunk.startLine > line || chunk.endLine < line) continue;
    if (
      best === undefined ||
      chunk.startLine > best.startLine ||
      (chunk.startLine === best.startLine && chunk.endLine < best.endLine)
    ) {
      best = chunk;
    }
  }
  return best;
}

/**
 * Enumerate every occurrence of `name`, split into resolved and unresolved.
 *
 * The literal scan is exhaustive over the files the index knows about; the
 * *attribution* of each occurrence to a symbol is the statically-derived part,
 * and everything it cannot attribute is returned rather than dropped.
 *
 * @returns Both halves of the answer set plus the coverage accounting a caller
 *   needs to decide whether to fall back to `grep`. Never throws: an unreadable
 *   file increments `filesUnreadable` and the scan continues.
 */
export async function findReferences(options: FindReferencesOptions): Promise<ReferencesResult> {
  const name = options.name.trim();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_REFERENCE_FILES;
  const maxOccurrences = options.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const matchesPath = options.path ? compilePathFilter(options.path) : null;

  const result: ReferencesResult = {
    name,
    resolved: [],
    unresolved: [],
    filesWithReferences: 0,
    filesSearched: 0,
    filesUnreadable: 0,
    filesNotSearched: 0,
    capped: false,
  };
  if (name.length === 0) return result;

  const byFile = groupChunksByFile(options.chunks);
  const files = [...byFile.keys()].filter((file) => !matchesPath || matchesPath(file)).sort();
  const filesWithReferences = new Set<string>();
  let occurrences = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file === undefined) continue;
    if (
      options.signal?.aborted ||
      result.filesSearched >= maxFiles ||
      occurrences >= maxOccurrences
    ) {
      result.filesNotSearched = files.length - i;
      result.capped = true;
      break;
    }

    let text: string;
    try {
      const buffer = await readFile(join(options.root, file));
      // Cheap sound prefilter: a file whose bytes do not contain the name
      // cannot contain a whole-word occurrence of it, and skipping the two
      // masking passes for it is most of the cost of a large repository.
      result.filesSearched++;
      if (!buffer.includes(name)) continue;
      text = buffer.toString("utf8");
    } catch {
      result.filesUnreadable++;
      continue;
    }

    const chunks = byFile.get(file) ?? [];
    const first = chunks[0];
    const language = first ? first.language : detectLanguage(file);
    const hasDeclarations = chunks.some((chunk) => chunk.kind !== "file");
    const declarationLines = new Set(
      chunks.filter((chunk) => chunk.name === name).map((chunk) => chunk.startLine),
    );

    for (const occurrence of scanOccurrences(text, name, language)) {
      if (occurrences >= maxOccurrences) {
        result.capped = true;
        break;
      }
      occurrences++;
      const enclosing =
        occurrence.context === "code" ? enclosingChunk(chunks, occurrence.line) : undefined;
      if (enclosing) {
        filesWithReferences.add(file);
        result.resolved.push({
          file,
          line: occurrence.line,
          column: occurrence.column,
          symbol: qualifiedName(enclosing),
          kind: enclosing.kind,
          definition: declarationLines.has(occurrence.line),
          text: occurrence.text,
        });
        continue;
      }
      const reason: UnresolvedReason =
        occurrence.context === "comment"
          ? "comment"
          : occurrence.context === "string"
            ? "string"
            : hasDeclarations
              ? "file-scope"
              : "unparsed-file";
      result.unresolved.push({
        file,
        line: occurrence.line,
        column: occurrence.column,
        reason,
        text: occurrence.text,
      });
    }
  }

  result.filesWithReferences = filesWithReferences.size;
  return result;
}

/** Human wording for each unresolved reason, used in the render. */
const REASON_LABELS: Readonly<Record<UnresolvedReason, string>> = {
  comment: "comment",
  string: "string literal",
  "file-scope": "file scope",
  "unparsed-file": "file not parsed",
};

/** `name: N references in M files · K textual occurrences not attributed`. */
function referencesHeader(result: ReferencesResult): string {
  const refs = result.resolved.length;
  const files = result.filesWithReferences;
  const unresolved = result.unresolved.length;
  return (
    `${result.name}: ${refs} reference${refs === 1 ? "" : "s"} in ` +
    `${files} file${files === 1 ? "" : "s"} · ${unresolved} textual ` +
    `occurrence${unresolved === 1 ? "" : "s"} not attributed`
  );
}

/** One resolved row: address, enclosing symbol, and the source line. */
function resolvedRow(reference: ResolvedReference): string {
  const marker = reference.definition ? " [def]" : "";
  return (
    `  :${reference.line}  ${clip(reference.symbol, MAX_LABEL_CHARS)} (${reference.kind})` +
    `${marker}  ${clip(reference.text, MAX_SOURCE_CHARS)}`
  );
}

/** One unresolved row: address, why it is unresolved, and the source line. */
function unresolvedRow(reference: UnresolvedReference): string {
  return (
    `  ${reference.file}:${reference.line}  ${REASON_LABELS[reference.reason]}  ` +
    clip(reference.text, MAX_SOURCE_CHARS)
  );
}

/**
 * Render a {@link ReferencesResult} within a hard token budget.
 *
 * The counts in the header are never truncated, and the unresolved section has
 * a reserved share of the budget so a symbol with hundreds of clean references
 * cannot crowd out the handful of occurrences that say "keep looking".
 */
export function formatReferences(
  result: ReferencesResult,
  options: StructuralFormatOptions = {},
): RenderedStructuralResult {
  const budget = Math.max(140, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const header = referencesHeader(result);
  const body = Math.max(60, budget - RESERVED_TOKENS - estimateTokens(header));
  const unresolvedBudget =
    result.unresolved.length > 0 ? Math.floor(body * UNRESOLVED_BUDGET_SHARE) : 0;

  const lines: string[] = [header];
  let shown = 0;

  // Resolved, grouped by file so each path is written once.
  let used = 0;
  let resolvedShown = 0;
  const resolvedBudget = body - unresolvedBudget;
  let currentFile: string | null = null;
  for (const reference of result.resolved) {
    const rows: string[] = [];
    if (reference.file !== currentFile) rows.push(reference.file);
    rows.push(resolvedRow(reference));
    const cost = rows.reduce((total, row) => total + estimateTokens(row) + 1, 0);
    if (resolvedShown > 0 && used + cost > resolvedBudget) break;
    if (reference.file !== currentFile) currentFile = reference.file;
    lines.push(...rows);
    used += cost;
    resolvedShown++;
  }
  shown += resolvedShown;
  const resolvedOmitted = result.resolved.length - resolvedShown;
  if (resolvedOmitted > 0) {
    lines.push(
      `… ${resolvedOmitted} more reference${resolvedOmitted === 1 ? "" : "s"} not listed ` +
        "(token budget reached); the count above is complete. Narrow with path:.",
    );
  }

  // Unresolved, always headed by its count even when the list is empty.
  let unresolvedOmitted = 0;
  if (result.unresolved.length > 0) {
    lines.push(`Not attributed (${result.unresolved.length}) — the index cannot name an owner:`);
    let spent = 0;
    const room = unresolvedBudget + Math.max(0, resolvedBudget - used);
    let unresolvedShown = 0;
    for (const reference of result.unresolved) {
      const row = unresolvedRow(reference);
      const cost = estimateTokens(row) + 1;
      if (unresolvedShown > 0 && spent + cost > room) break;
      lines.push(row);
      spent += cost;
      unresolvedShown++;
    }
    shown += unresolvedShown;
    unresolvedOmitted = result.unresolved.length - unresolvedShown;
    if (unresolvedOmitted > 0) {
      lines.push(`  … ${unresolvedOmitted} more not listed (token budget reached).`);
    }
  }

  if (result.resolved.length === 0 && result.unresolved.length === 0) {
    lines.push(
      "No occurrence at all — matching is whole-word and case-sensitive, so check the exact " +
        "spelling, or use `search_code` if you are unsure of the name.",
    );
  }

  lines.push(coverageNotice(result));

  const text = lines.join("\n");
  return {
    text,
    shown,
    omitted: resolvedOmitted + unresolvedOmitted,
    truncated: resolvedOmitted + unresolvedOmitted > 0,
    estimatedTokens: estimateTokens(text),
  };
}

/**
 * The closing line that keeps the agent looking.
 *
 * Always present. A reference scan is exhaustive over *statically visible*
 * occurrences in *indexed* files, and both qualifiers matter: a call made
 * through a lookup table, a decorator, a DI container or a generated name never
 * appears here at all, and no count can reveal its absence.
 */
function coverageNotice(result: ReferencesResult): string {
  const parts = [
    `Searched ${result.filesSearched} indexed file${result.filesSearched === 1 ? "" : "s"}.`,
  ];
  if (result.filesNotSearched > 0) {
    parts.push(`${result.filesNotSearched} more not searched (cap reached) — narrow with path:.`);
  }
  if (result.filesUnreadable > 0) {
    parts.push(`${result.filesUnreadable} indexed file(s) could not be read.`);
  }
  parts.push(
    "Dynamic dispatch, reflection and string-keyed calls are invisible to this scan, and " +
      "binary, minified, oversized and ignored files are not indexed — if a caller is missing, " +
      `grep for "${result.name}".`,
  );
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The `find_symbol` description.
 *
 * Exported because it is the routing mechanism, not decoration: SWE-agent
 * ablations measured a *badly designed* search interface at −6.0 pp, worse than
 * having no search at all (−2.3 pp). The first sentence states the guarantee;
 * the rest says when to prefer this over each neighbouring tool.
 */
export const FIND_SYMBOL_DESCRIPTION = [
  "Exhaustive over indexed definitions. Use when you know the symbol's name; prefer this over",
  "search_code for a known identifier.",
  "",
  "Returns EVERY definition whose name matches, as `path:line kind name(signature)` — an address,",
  "never a body. This is a lookup, not a search: results are not ranked and not scored. They are",
  "sorted by path and line, with exact matches before prefix matches, so the order is reproducible",
  "and means nothing about relevance. If the token budget cannot fit them all, the result says",
  "exactly how many it withheld; it never drops one silently.",
  "",
  "Matching is case-insensitive. `exact:true` requires the whole name; the default also accepts",
  "prefixes, so `Token` finds `TokenBucket`. A dotted name (`TokenBucket.tryConsume`) matches the",
  "qualified name. `kind:` narrows to function/method/class/interface/type/const/… .",
  "",
  "Prefer `find_symbol` when you have a name and want its definition(s).",
  "Prefer `search_code` when you are half-remembering a name or asking a conceptual question",
  '("where is auth handled") — that path ranks, and ranking is a guess.',
  "Prefer `find_references` for use sites rather than definitions, and `grep` for literal text that",
  "is not a symbol name.",
  "Coverage: the index skips binary, minified, oversized and ignored files, and a file whose",
  "declarations the chunker could not parse is reported explicitly rather than omitted.",
].join("\n");

/**
 * The `find_references` description.
 *
 * The second sentence is the whole design: a tool that reports "3 callers" as
 * *the* callers is worse than `grep`, because it stops the agent looking. The
 * unresolved count is what makes stopping a decision rather than an accident.
 */
export const FIND_REFERENCES_DESCRIPTION = [
  "Exhaustive over statically visible references, and reports what it could not resolve. Dynamic",
  "dispatch and reflection may not appear — the unresolved count tells you when to fall back to",
  "grep.",
  "",
  "Finds every whole-word occurrence of an identifier across indexed files and splits it in two:",
  "• RESOLVED — the occurrence sits inside an indexed declaration, so the enclosing symbol is named",
  "  (`TokenBucket.tryConsume (method)`), and the declaration itself is marked [def].",
  "• NOT ATTRIBUTED — a comment, a string literal, code at file scope (imports, top-level",
  "  statements), or a file whose declarations could not be parsed.",
  'The first line always states both counts ("14 references in 6 files · 3 textual occurrences not',
  'attributed"). A non-zero unresolved count is a signal, not noise: a name inside a string literal',
  "is exactly what string-keyed dispatch looks like.",
  "",
  "Prefer `find_references` over `grep` when you want call sites attributed to the function or",
  "class that contains them, and over `search_code` whenever you have an exact identifier.",
  "Prefer `grep` when the text is not an identifier, when you need a regex, or when this tool's",
  "unresolved count or coverage note says the answer may be incomplete.",
  "Use `path:` to restrict a large repository; matching is case-sensitive and whole-word.",
].join("\n");

/** Options for {@link createFindSymbolTool} and {@link createFindReferencesTool}. */
export interface StructuralToolOptions extends CodeIndexOptions {
  /**
   * Share one warm index with `search_code` and the sibling structural tool.
   *
   * Without it each tool opens its own {@link CodeIndexService} for the same
   * root: correct (writes are atomic) but wasteful, since each would hold its
   * own copy of the chunks and refresh on its own schedule.
   */
  service?: CodeIndexService;
}

/** Resolve the index service a tool should use, honoring a shared one. */
function serviceFor(options: StructuralToolOptions): CodeIndexService {
  return options.service ?? new CodeIndexService(options);
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

/** Prepare the index for `root` and hand back every chunk in it. */
async function chunksFor(
  service: CodeIndexService,
  root: string,
  signal: AbortSignal,
): Promise<readonly CodeChunk[]> {
  await service.ensureIndexed(root, signal);
  const store = await service.storeFor(root);
  return store.allChunks();
}

/**
 * Create the `find_symbol` tool.
 *
 * Read-only: no permission is requested, matching `grep`, `glob`, `symbols`
 * and `search_code`.
 */
export function createFindSymbolTool(options: StructuralToolOptions = {}): Tool {
  const service = serviceFor(options);

  return {
    definition: {
      name: "find_symbol",
      description: FIND_SYMBOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The symbol name. Case-insensitive. A dotted name ('TokenBucket.tryConsume') is " +
              "matched against the qualified name.",
          },
          kind: {
            description:
              "Restrict to one or more declaration kinds. The cheapest way to cut a large result.",
            oneOf: [
              { type: "string", enum: [...CHUNK_KINDS] },
              { type: "array", items: { type: "string", enum: [...CHUNK_KINDS] } },
            ],
          },
          exact: {
            type: "boolean",
            description:
              "true requires the whole name to match; false (the default) also accepts prefixes.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },

    async execute(input, ctx: ToolExecutionContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const name = input.name;
      if (typeof name !== "string" || name.trim().length === 0) {
        return errorResult("`name` is required and must be a non-empty string.");
      }

      const root = resolveCwd(ctx.cwd);
      if (!isAbsolute(root)) {
        return errorResult(`Cannot index a non-absolute working directory: ${ctx.cwd}`);
      }

      let chunks: readonly CodeChunk[];
      try {
        chunks = await chunksFor(service, root, ctx.signal);
      } catch (error) {
        return errorResult(`Code index unavailable: ${(error as Error).message}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const result = findSymbols(chunks, {
        name,
        kind: parseKinds(input.kind),
        exact: input.exact === true,
      });
      const rendered = formatSymbolMatches(result, { tokenBudget: options.tokenBudget });

      return textResult(rendered.text, {
        matchCount: result.matches.length,
        files: result.files,
        shown: rendered.shown,
        omitted: rendered.omitted,
        truncated: rendered.truncated,
        estimatedTokens: rendered.estimatedTokens,
        searchedDefinitions: result.searched,
        unparsedFiles: result.unparsedFiles.length,
        exhaustive: true,
      });
    },
  };
}

/**
 * Create the `find_references` tool.
 *
 * Read-only: no permission is requested. It reads indexed files from disk to
 * locate occurrences, which is what makes the literal half of the answer
 * exhaustive rather than limited to the (capped) bodies stored in the index.
 */
export function createFindReferencesTool(options: StructuralToolOptions = {}): Tool {
  const service = serviceFor(options);

  return {
    definition: {
      name: "find_references",
      description: FIND_REFERENCES_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The identifier to find. Matched whole-word and case-sensitively, so 'user' does " +
              "not match 'users'.",
          },
          path: {
            type: "string",
            description:
              "Restrict to files matching a glob ('src/**', '*.py') or containing a substring " +
              "('/auth/'). Paths are repo-relative with forward slashes.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },

    async execute(input, ctx: ToolExecutionContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const name = input.name;
      if (typeof name !== "string" || name.trim().length === 0) {
        return errorResult("`name` is required and must be a non-empty string.");
      }

      const root = resolveCwd(ctx.cwd);
      if (!isAbsolute(root)) {
        return errorResult(`Cannot index a non-absolute working directory: ${ctx.cwd}`);
      }

      let result: ReferencesResult;
      try {
        const chunks = await chunksFor(service, root, ctx.signal);
        if (ctx.signal.aborted) return abortedResult();
        result = await findReferences({
          root,
          chunks,
          name,
          path: typeof input.path === "string" && input.path.length > 0 ? input.path : undefined,
          signal: ctx.signal,
        });
      } catch (error) {
        return errorResult(`Code index unavailable: ${(error as Error).message}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const rendered = formatReferences(result, { tokenBudget: options.tokenBudget });

      return textResult(rendered.text, {
        references: result.resolved.length,
        filesWithReferences: result.filesWithReferences,
        unresolved: result.unresolved.length,
        definitions: result.resolved.filter((reference) => reference.definition).length,
        shown: rendered.shown,
        omitted: rendered.omitted,
        truncated: rendered.truncated,
        estimatedTokens: rendered.estimatedTokens,
        filesSearched: result.filesSearched,
        filesNotSearched: result.filesNotSearched,
        filesUnreadable: result.filesUnreadable,
        capped: result.capped,
        exhaustive: !result.capped,
      });
    },
  };
}

/**
 * Create both structural tools over one shared, warm index.
 *
 * The convenience that matters at wiring time: two tools, one
 * {@link CodeIndexService}, one refresh schedule. Pass `service` in
 * `options` to share the same index with `search_code` as well.
 */
export function createStructuralTools(options: StructuralToolOptions = {}): {
  findSymbol: Tool;
  findReferences: Tool;
} {
  const service = serviceFor(options);
  return {
    findSymbol: createFindSymbolTool({ ...options, service }),
    findReferences: createFindReferencesTool({ ...options, service }),
  };
}
