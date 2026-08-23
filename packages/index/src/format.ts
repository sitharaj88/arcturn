/**
 * Rendering a search result — the part of this package that actually decides
 * its cost.
 *
 * Everything upstream is bookkeeping. What the model *pays* for is this file's
 * output, so every decision here is a token decision:
 *
 * - **The default is an address, not content.** `path:line  kind label — doc`
 *   is around 20–25 tokens. The body it stands in for is 200–500. The agent
 *   already has `read`; the index's job is to tell it *where*, precisely
 *   enough that one `read` finishes the job.
 * - **Repeated context is written once.** Several hits in one file collapse
 *   under a single path header, and a hit contained inside a higher-ranked hit
 *   (a method already covered by its class) is dropped outright.
 * - **The budget is hard and honest.** Output stops at a token ceiling and
 *   says how many matches it withheld and exactly which filters would narrow
 *   them. It never silently drops results.
 * - **The result ends with the next move.** A `nextStep` line names the exact
 *   `read` call for the top hit, so the agent goes to content instead of
 *   spending another turn re-searching.
 */

import { estimateTokens } from "./tokenize.js";
import type { DetailLevel, SearchHit, SearchResult } from "./types.js";

/** Default ceiling for one rendered result. */
export const DEFAULT_TOKEN_BUDGET = 1500;

/** Lines of body shown on each side of a declaration in `snippets` mode. */
export const DEFAULT_CONTEXT_LINES = 3;

/** Hits rendered per file before the rest collapse into a count. */
export const DEFAULT_MAX_HITS_PER_FILE = 3;

/** Body lines rendered per hit in `full` mode, before the budget even applies. */
const MAX_FULL_BODY_LINES = 60;

/** Rendered label cap: a signature is an identifier, not the source. */
const MAX_LABEL_CHARS = 90;

/** Rendered doc cap: one clause of intent, never a paragraph. */
const MAX_DOC_CHARS = 70;

/**
 * Character budget for one hit's description line — roughly 30 tokens, the
 * per-hit target the architecture sets.
 *
 * Enforced on the *description*, never on the address: a truncated
 * `file:line` is worse than useless, so a very long path buys a shorter
 * description rather than a clipped one.
 */
const MAX_HIT_LINE_CHARS = 118;

/** Floor on description room, so even an absurd path leaves something readable. */
const MIN_DESCRIPTION_CHARS = 28;

/** Tokens held back for the truncation notice and the `nextStep` line. */
const RESERVED_TOKENS = 70;

/** Options for {@link formatSearchResult}. */
export interface FormatOptions {
  /** How much of each hit to render. Defaults to `"signatures"`. */
  detail?: DetailLevel;
  /** Hard token ceiling for the whole result. Defaults to {@link DEFAULT_TOKEN_BUDGET}. */
  tokenBudget?: number;
  /** Context lines in `snippets` mode. Defaults to {@link DEFAULT_CONTEXT_LINES}. */
  contextLines?: number;
  /** Hits per file before collapsing. Defaults to {@link DEFAULT_MAX_HITS_PER_FILE}. */
  maxHitsPerFile?: number;
}

/** The rendered result plus the accounting a caller may want to report. */
export interface FormattedSearchResult {
  /** The text handed to the model. */
  text: string;
  /** Hits actually rendered. */
  shown: number;
  /** Hits withheld by the budget or by per-file collapsing. */
  omitted: number;
  /** True when the budget stopped the render. */
  truncated: boolean;
  /** `chars / 4` estimate of {@link text}. */
  estimatedTokens: number;
  /** The suggested follow-up `read` call, if there was a top hit. */
  nextStep?: string;
}

/** Trim to `max` characters with an ellipsis, preferring a word boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The first sentence of a doc comment, which is where the intent lives. */
function firstSentence(doc: string, max: number): string {
  const period = doc.indexOf(". ");
  const base = period > 0 && period < max ? doc.slice(0, period + 1) : doc;
  return clip(base, max);
}

/**
 * The identifying label for a hit: its qualified name plus whatever the
 * signature adds after it (a parameter list, a return type, a base class).
 *
 * Built from the qualified name rather than echoed from the signature so the
 * container is always present — `TokenBucket.tryConsume(…)` locates a method
 * that `tryConsume(…)` alone does not — and so `export`/`public` boilerplate
 * before the name is dropped.
 */
export function hitLabel(hit: SearchHit): string {
  const { chunk } = hit;
  const qualified = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
  const signature = chunk.signature;
  if (!signature) return clip(qualified, MAX_LABEL_CHARS);

  const at = signature.indexOf(chunk.name);
  if (at < 0) return clip(signature, MAX_LABEL_CHARS);
  const tail = signature.slice(at + chunk.name.length).trim();
  if (tail.length === 0) return clip(qualified, MAX_LABEL_CHARS);
  const glued = /^[(<[?:!]/.test(tail);
  return clip(`${qualified}${glued ? "" : " "}${tail}`, MAX_LABEL_CHARS);
}

/** `kind label — doc`, the constant-cost description of one hit. */
function hitDescription(hit: SearchHit): string {
  const doc = hit.chunk.doc ? ` — ${firstSentence(hit.chunk.doc, MAX_DOC_CHARS)}` : "";
  return `${hit.chunk.kind} ${hitLabel(hit)}${doc}`;
}

/**
 * One hit's headline: its address, then as much description as the per-hit
 * character budget leaves after the address is paid for.
 */
function hitHeadline(prefix: string, hit: SearchHit): string {
  const room = Math.max(MIN_DESCRIPTION_CHARS, MAX_HIT_LINE_CHARS - prefix.length);
  return `${prefix}${clip(hitDescription(hit), room)}`;
}

/** Body lines with 1-based numbers, for `snippets` and `full`. */
function bodyLines(hit: SearchHit, maxLines: number, indent: string): string[] {
  const body = hit.chunk.body;
  if (!body) return [];
  const lines = body.split("\n");
  const shown = lines.slice(0, maxLines);
  const rendered = shown.map((line, offset) => `${indent}${hit.chunk.startLine + offset}| ${line}`);
  if (lines.length > shown.length) {
    rendered.push(`${indent}… ${lines.length - shown.length} more lines`);
  }
  return rendered;
}

/** Extra lines a detail level adds beneath a hit's description. */
function detailLines(hit: SearchHit, detail: DetailLevel, contextLines: number): string[] {
  if (detail === "signatures") return [];
  const indent = "    ";
  if (detail === "snippets") return bodyLines(hit, contextLines * 2 + 1, indent);
  return bodyLines(hit, MAX_FULL_BODY_LINES, indent);
}

/** A renderable unit: one file's hits, kept together so the path is written once. */
interface Block {
  text: string;
  hits: number;
  hidden: number;
}

/**
 * Drop hits that are wholly contained in a better-ranked hit from the same
 * file — a method already covered by its class, or an overload group. The
 * agent gets the enclosing address either way.
 */
function collapseContained(hits: readonly SearchHit[]): SearchHit[] {
  const kept: SearchHit[] = [];
  for (const hit of hits) {
    const contained = kept.some(
      (other) =>
        other.chunk.file === hit.chunk.file &&
        other.chunk.startLine <= hit.chunk.startLine &&
        other.chunk.endLine >= hit.chunk.endLine,
    );
    if (!contained) kept.push(hit);
  }
  return kept;
}

/** Group hits by file, preserving rank order both between and within groups. */
function groupByFile(hits: readonly SearchHit[]): Array<{ file: string; hits: SearchHit[] }> {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const existing = groups.get(hit.chunk.file);
    if (existing) existing.push(hit);
    else groups.set(hit.chunk.file, [hit]);
  }
  return [...groups].map(([file, fileHits]) => ({ file, hits: fileHits }));
}

/** Render one file's group into a single budgetable block. */
function renderBlock(
  group: { file: string; hits: SearchHit[] },
  detail: DetailLevel,
  contextLines: number,
  maxHitsPerFile: number,
): Block {
  const shown = group.hits.slice(0, maxHitsPerFile);
  const hidden = group.hits.length - shown.length;

  if (shown.length === 1) {
    const hit = shown[0];
    if (!hit) return { text: "", hits: 0, hidden: 0 };
    const lines = [
      hitHeadline(`${group.file}:${hit.chunk.startLine}  `, hit),
      ...detailLines(hit, detail, contextLines),
    ];
    return { text: lines.join("\n"), hits: 1, hidden };
  }

  const lines: string[] = [group.file];
  for (const hit of shown) {
    lines.push(hitHeadline(`  :${hit.chunk.startLine}  `, hit));
    lines.push(...detailLines(hit, detail, contextLines));
  }
  if (hidden > 0) lines.push(`  + ${hidden} more here (narrow with path:"${group.file}")`);
  return { text: lines.join("\n"), hits: shown.length, hidden };
}

/** The exact follow-up call for the top hit. */
export function nextStepFor(hit: SearchHit): string {
  const { chunk } = hit;
  const span = Math.min(chunk.endLine - chunk.startLine + 1, 200);
  const qualified = chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name;
  return `Next: read({"path":"${chunk.file}","offset":${chunk.startLine},"limit":${span}}) for ${qualified}.`;
}

/**
 * Render a {@link SearchResult} within a hard token budget.
 *
 * @returns The text to hand the model plus the accounting behind it. Always
 *   renders at least one hit when there is one, clipping it if a single hit
 *   somehow exceeds the whole budget.
 */
export function formatSearchResult(
  result: SearchResult,
  options: FormatOptions = {},
): FormattedSearchResult {
  const detail = options.detail ?? "signatures";
  const budget = Math.max(80, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxHitsPerFile = Math.max(1, options.maxHitsPerFile ?? DEFAULT_MAX_HITS_PER_FILE);

  if (result.hits.length === 0) {
    const text =
      `No indexed symbol matches "${result.query}". ` +
      "Try fewer or more distinctive words, drop the kind:/path: filters, " +
      "or use `grep` if you need an exact string that is not a symbol name.";
    return { text, shown: 0, omitted: 0, truncated: false, estimatedTokens: estimateTokens(text) };
  }

  const hits = collapseContained(result.hits);
  const collapsedAway = result.hits.length - hits.length;
  const blocks = groupByFile(hits).map((group) =>
    renderBlock(group, detail, contextLines, maxHitsPerFile),
  );

  const available = Math.max(40, budget - RESERVED_TOKENS);
  const rendered: string[] = [];
  let used = 0;
  let shown = 0;
  let hiddenInFiles = 0;
  let truncated = false;

  for (const block of blocks) {
    if (block.hits === 0) continue;
    const cost = estimateTokens(block.text) + 1;
    if (used + cost > available) {
      if (shown > 0) {
        truncated = true;
        break;
      }
      // A single hit larger than the whole budget still gets rendered, clipped:
      // an address the agent can act on beats an empty result.
      const clipped = clip(block.text, available * 4);
      rendered.push(clipped);
      used += estimateTokens(clipped);
      shown += block.hits;
      hiddenInFiles += block.hidden;
      truncated = true;
      break;
    }
    rendered.push(block.text);
    used += cost;
    shown += block.hits;
    hiddenInFiles += block.hidden;
  }

  const omitted = Math.max(0, result.totalMatches - shown);
  if (truncated || hiddenInFiles > 0 || omitted > 0) {
    const notice =
      omitted > 0
        ? `… ${omitted} more match${omitted === 1 ? "" : "es"} not shown` +
          (truncated ? " (token budget reached)" : "") +
          '. Narrow with kind:"function", path:"src/**", or a more specific query.'
        : `… ${hiddenInFiles} more match${hiddenInFiles === 1 ? "" : "es"} collapsed into the files above.`;
    rendered.push(notice);
  }

  const top = hits[0];
  const nextStep = top ? nextStepFor(top) : undefined;
  if (nextStep) rendered.push(nextStep);

  const text = rendered.join("\n");
  return {
    text,
    shown,
    omitted: omitted + collapsedAway,
    truncated,
    estimatedTokens: estimateTokens(text),
    nextStep,
  };
}
