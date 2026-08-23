/**
 * Display-width aware string utilities.
 *
 * Terminal layout has to be done in *columns*, not in UTF-16 code units: CJK
 * ideographs and emoji occupy two columns, combining marks occupy none, and ANSI
 * escape sequences occupy none while still being part of the string. Everything in
 * this module measures and slices in columns while preserving styling.
 *
 * @packageDocumentation
 */

import { eastAsianWidth } from "get-east-asian-width";
import { ANSI_PATTERN, CSI } from "./ansi.js";

/** Number of columns a literal tab is assumed to occupy. */
export const TAB_WIDTH = 4;

const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const ZERO_WIDTH_START = /^[\p{Mn}\p{Me}\p{Cf}]/u;
const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Splits a string into grapheme clusters, falling back to code points. */
function graphemes(input: string): string[] {
  if (segmenter) {
    const out: string[] = [];
    for (const { segment } of segmenter.segment(input)) out.push(segment);
    return out;
  }
  return Array.from(input);
}

/**
 * Returns the number of terminal columns occupied by a single code point.
 *
 * Control characters and combining marks are zero-width; East Asian wide/fullwidth
 * characters are two columns; everything else is one.
 *
 * @param codePoint - A Unicode code point.
 */
export function charWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint === 0x09) return 1; // handled by callers that expand tabs
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  const char = String.fromCodePoint(codePoint);
  if (ZERO_WIDTH_START.test(char)) return 0;
  if (EMOJI_PRESENTATION.test(char)) return 2;
  return eastAsianWidth(codePoint, { ambiguousAsWide: false });
}

/**
 * Returns the number of terminal columns occupied by one grapheme cluster.
 *
 * @param cluster - A single grapheme cluster (as produced by `Intl.Segmenter`).
 */
export function clusterWidth(cluster: string): number {
  if (cluster === "") return 0;
  if (cluster === "\t") return TAB_WIDTH;
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;

  // Flag sequences (pairs of regional indicators) render as one double-wide glyph.
  if (REGIONAL_INDICATOR.test(cluster)) return 2;
  // An explicit emoji-presentation selector forces the wide glyph.
  if (cluster.includes("️")) return 2;

  return charWidth(first);
}

/** A single unit of a tokenised string: either an escape sequence or a grapheme. */
export interface WidthToken {
  /** Raw text of the token. */
  readonly text: string;
  /** `true` when the token is an ANSI escape sequence (zero display width). */
  readonly ansi: boolean;
  /** Display width in terminal columns. */
  readonly width: number;
}

/**
 * Splits a string into ANSI escape sequences and grapheme clusters, annotating each
 * with its display width. This is the shared primitive behind {@link stringWidth},
 * {@link truncateToWidth}, {@link sliceByWidth} and {@link wrapText}.
 *
 * @param input - Possibly styled text.
 */
export function tokenize(input: string): WidthToken[] {
  const tokens: WidthToken[] = [];
  const re = new RegExp(ANSI_PATTERN.source, "g");
  let last = 0;
  let match: RegExpExecArray | null = re.exec(input);
  while (match !== null) {
    if (match.index > last) pushText(tokens, input.slice(last, match.index));
    tokens.push({ text: match[0], ansi: true, width: 0 });
    last = match.index + match[0].length;
    match = re.exec(input);
  }
  if (last < input.length) pushText(tokens, input.slice(last));
  return tokens;
}

function pushText(tokens: WidthToken[], text: string): void {
  for (const cluster of graphemes(text)) {
    tokens.push({ text: cluster, ansi: false, width: clusterWidth(cluster) });
  }
}

/**
 * Measures the display width of a string in terminal columns.
 *
 * ANSI escape sequences are ignored, combining marks count as zero, emoji and
 * East Asian wide characters count as two, and tabs count as {@link TAB_WIDTH}.
 *
 * @param input - Possibly styled text.
 * @returns Column count.
 *
 * @example
 * ```ts
 * stringWidth("hello");        // 5
 * stringWidth("\u001b[1mhi\u001b[22m"); // 2
 * stringWidth("日本語");        // 6
 * ```
 */
export function stringWidth(input: string): number {
  if (input === "") return 0;
  // Fast path: plain printable ASCII is one column per character.
  if (ASCII_PRINTABLE.test(input)) return input.length;
  let total = 0;
  for (const token of tokenize(input)) total += token.width;
  return total;
}

/* -------------------------------------------------------------------------- */
/* SGR state tracking                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tracks which SGR attributes are active so that styling can be re-opened at the
 * start of a wrapped line and closed at its end.
 */
class SgrState {
  private active: string[] = [];

  /** Feeds an escape sequence into the tracker. */
  push(seq: string): void {
    if (!seq.startsWith(CSI) || !seq.endsWith("m")) return;
    const params = seq.slice(CSI.length, -1);
    if (params === "" || params === "0") {
      this.active = [];
      return;
    }
    this.active.push(seq);
  }

  /** Escape sequences needed to restore the current style on a fresh line. */
  prefix(): string {
    return this.active.join("");
  }

  /** `true` when any attribute is currently active. */
  get isActive(): boolean {
    return this.active.length > 0;
  }

  /** Returns a copy of this tracker. */
  clone(): SgrState {
    const next = new SgrState();
    next.active = [...this.active];
    return next;
  }
}

const RESET_ALL = `${CSI}0m`;

/* -------------------------------------------------------------------------- */
/* Slicing / truncation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the columns `[start, end)` of a styled string.
 *
 * Styling active at `start` is re-opened at the beginning of the slice, and a reset
 * is appended when styling is still active at the end. Double-width characters that
 * straddle a boundary are replaced by a space so the result keeps its exact width.
 *
 * @param input - Possibly styled text.
 * @param start - First column to keep (0-based, inclusive).
 * @param end - Column to stop at (exclusive). Defaults to the end of the string.
 */
export function sliceByWidth(input: string, start: number, end = Number.POSITIVE_INFINITY): string {
  if (end <= start) return "";
  const state = new SgrState();
  let column = 0;
  let out = "";
  let started = false;

  for (const token of tokenize(input)) {
    if (token.ansi) {
      state.push(token.text);
      if (started) out += token.text;
      continue;
    }
    const next = column + token.width;
    if (next <= start) {
      column = next;
      continue;
    }
    if (!started) {
      started = true;
      out += state.prefix();
      // A wide glyph clipped by `start` degrades to a space.
      if (column < start) {
        out += " ".repeat(next - start);
        column = next;
        continue;
      }
    }
    if (next > end) {
      out += " ".repeat(Math.max(0, end - column));
      column = end;
      break;
    }
    out += token.text;
    column = next;
  }

  if (started && state.isActive) out += RESET_ALL;
  return out;
}

/**
 * Truncates a styled string so that it occupies at most `width` columns, appending
 * an ellipsis when content was removed.
 *
 * @param input - Possibly styled text.
 * @param width - Maximum number of columns.
 * @param ellipsis - Marker appended when truncation happens (default `"…"`).
 * @returns The truncated string, never wider than `width`.
 *
 * @example
 * ```ts
 * truncateToWidth("hello world", 8);       // "hello w…"
 * truncateToWidth("日本語テキスト", 7);     // "日本語…"
 * ```
 */
export function truncateToWidth(input: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  const total = stringWidth(input);
  if (total <= width) return input;

  const markerWidth = stringWidth(ellipsis);
  if (markerWidth >= width) return sliceByWidth(input, 0, width);

  const head = sliceByWidth(input, 0, width - markerWidth);
  const pad = width - markerWidth - stringWidth(head);
  return head + (pad > 0 ? " ".repeat(pad) : "") + ellipsis;
}

/** Horizontal alignment used by {@link padToWidth}. */
export type Align = "left" | "center" | "right";

/**
 * Pads (or truncates) a styled string to exactly `width` columns.
 *
 * @param input - Possibly styled text.
 * @param width - Target column count.
 * @param align - Where to place the content within the field (default `"left"`).
 * @param fill - Character used for padding (default `" "`).
 */
export function padToWidth(
  input: string,
  width: number,
  align: Align = "left",
  fill = " ",
): string {
  if (width <= 0) return "";
  const current = stringWidth(input);
  if (current > width) return truncateToWidth(input, width);
  const missing = width - current;
  if (missing === 0) return input;
  if (align === "right") return fill.repeat(missing) + input;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return fill.repeat(left) + input + fill.repeat(missing - left);
  }
  return input + fill.repeat(missing);
}

/* -------------------------------------------------------------------------- */
/* Wrapping                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link wrapText}. */
export interface WrapOptions {
  /** Break words that are longer than the wrap width (default `true`). */
  hard?: boolean;
  /** Collapse leading whitespace on continuation lines (default `true`). */
  trim?: boolean;
  /** String prefixed to every continuation line (default `""`). */
  indent?: string;
}

interface Chunk {
  /** Visible text of the chunk (no escape sequences). */
  text: string;
  /** Rendered text including escape sequences. */
  rendered: string;
  width: number;
  whitespace: boolean;
}

/**
 * Word-wraps styled text to a column width, preserving ANSI styling across line
 * breaks (active attributes are closed at the end of a line and re-opened on the
 * next one).
 *
 * Existing newlines in `input` are honoured as hard breaks.
 *
 * @param input - Possibly styled text.
 * @param width - Maximum line width in columns.
 * @param options - See {@link WrapOptions}.
 * @returns One entry per output line. Never empty (an empty input yields `[""]`).
 *
 * @example
 * ```ts
 * wrapText("the quick brown fox", 10);
 * // ["the quick", "brown fox"]
 * ```
 */
export function wrapText(input: string, width: number, options: WrapOptions = {}): string[] {
  const { hard = true, trim = true, indent = "" } = options;
  if (width <= 0) return [""];

  const lines: string[] = [];
  for (const paragraph of input.split("\n")) {
    lines.push(...wrapParagraph(paragraph, width, hard, trim, indent));
  }
  return lines.length > 0 ? lines : [""];
}

function wrapParagraph(
  input: string,
  width: number,
  hard: boolean,
  trim: boolean,
  indent: string,
): string[] {
  if (input === "") return [""];

  const indentWidth = stringWidth(indent);
  const chunks = splitChunks(input);
  const lines: string[] = [];

  let current = "";
  let currentWidth = 0;
  const state = new SgrState();
  let lineStartState = state.clone();
  let isFirst = true;

  const flush = (): void => {
    const prefix = isFirst ? "" : indent;
    const styled = lineStartState.prefix();
    const suffix = state.isActive ? RESET_ALL : "";
    // Trailing spaces are never meaningful in a terminal line and would push the
    // rendered width past the requested limit.
    lines.push(prefix + styled + current.replace(/[ \t]+$/, "") + suffix);
    isFirst = false;
    current = "";
    currentWidth = 0;
    lineStartState = state.clone();
  };

  const limit = (): number => (isFirst ? width : Math.max(1, width - indentWidth));

  for (const chunk of chunks) {
    if (chunk.whitespace) {
      // Trailing whitespace never forces a wrap; it is dropped at the break.
      if (currentWidth === 0 && trim && lines.length > 0) {
        applyAnsi(chunk.rendered, state);
        continue;
      }
      if (currentWidth + chunk.width > limit()) {
        applyAnsi(chunk.rendered, state);
        flush();
        continue;
      }
      current += chunk.rendered;
      currentWidth += chunk.width;
      applyAnsi(chunk.rendered, state);
      continue;
    }

    if (currentWidth + chunk.width <= limit()) {
      current += chunk.rendered;
      currentWidth += chunk.width;
      applyAnsi(chunk.rendered, state);
      continue;
    }

    if (currentWidth > 0) flush();

    if (chunk.width <= limit()) {
      current += chunk.rendered;
      currentWidth += chunk.width;
      applyAnsi(chunk.rendered, state);
      continue;
    }

    if (!hard) {
      current += chunk.rendered;
      currentWidth += chunk.width;
      applyAnsi(chunk.rendered, state);
      flush();
      continue;
    }

    // Hard-break an over-long word across as many lines as needed.
    let offset = 0;
    while (offset < chunk.width) {
      const take = Math.min(limit(), chunk.width - offset);
      const piece = sliceByWidth(chunk.rendered, offset, offset + take);
      current += piece;
      currentWidth += take;
      offset += take;
      if (offset < chunk.width) flush();
    }
    applyAnsi(chunk.rendered, state);
    lineStartState = state.clone();
  }

  if (currentWidth > 0 || lines.length === 0) flush();
  return lines;
}

/** Feeds every escape sequence contained in `rendered` into `state`. */
function applyAnsi(rendered: string, state: SgrState): void {
  const re = new RegExp(ANSI_PATTERN.source, "g");
  let match: RegExpExecArray | null = re.exec(rendered);
  while (match !== null) {
    state.push(match[0]);
    match = re.exec(rendered);
  }
}

/** Splits a line into alternating word / whitespace chunks, keeping escapes attached. */
function splitChunks(input: string): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | undefined;

  for (const token of tokenize(input)) {
    if (token.ansi) {
      if (cur) cur.rendered += token.text;
      else chunks.push({ text: "", rendered: token.text, width: 0, whitespace: false });
      continue;
    }
    const ws = /^\s$/.test(token.text);
    if (!cur || cur.whitespace !== ws) {
      // Merge a pending escape-only chunk into the new chunk.
      const pending = chunks.length > 0 && chunks[chunks.length - 1]!.text === "" && !cur;
      const lead = pending ? chunks.pop()!.rendered : "";
      cur = { text: token.text, rendered: lead + token.text, width: token.width, whitespace: ws };
      chunks.push(cur);
      continue;
    }
    cur.text += token.text;
    cur.rendered += token.text;
    cur.width += token.width;
  }
  return chunks;
}

/**
 * Expands literal tabs to spaces using {@link TAB_WIDTH}.
 *
 * @param input - Text possibly containing tabs.
 * @param tabWidth - Columns per tab (default {@link TAB_WIDTH}).
 */
export function expandTabs(input: string, tabWidth = TAB_WIDTH): string {
  if (!input.includes("\t")) return input;
  return input.replace(/\t/g, " ".repeat(tabWidth));
}
