/**
 * The `Viewport` component: a scrollable transcript region for screen mode.
 *
 * The viewport is the one flexible component per screen — it implements
 * {@link Component.renderArea} and fills exactly the rows left over after the
 * fixed components render. Content is bottom-anchored: a short transcript sits
 * at the bottom of the area, and while following (offset `0`) new lines slide
 * in from below like a terminal.
 *
 * @packageDocumentation
 */

import { stripAnsi } from "../ansi.js";
import { type Key, matchesKey } from "../keys.js";
import { style as themeStyle } from "../theme.js";
import type { Component } from "../tui.js";
import { sliceByWidth, stringWidth, tokenize, truncateToWidth, wrapText } from "../width.js";

/** Options for {@link Viewport}. */
export interface ViewportOptions {
  /** Produces the logical (unwrapped, styled) transcript lines at a width. */
  readonly getLines: (width: number) => readonly string[];
  /**
   * Rows scrolled per wheel event (default 1). One, deliberately: every
   * modern emulator already multiplies a physical notch into several wheel
   * events (xterm.js one per computed line, kitty via its multiplier), so a
   * larger step here compounds into chunky, overspeed scrolling.
   */
  readonly wheelStep?: number;
  /**
   * When this reports `true` and the content fits the area, the content is
   * vertically centered instead of bottom-anchored — the splash-screen
   * treatment for an empty session. Scrolling behavior is unaffected.
   */
  readonly centered?: () => boolean;
}

/**
 * A scrollable, bottom-anchored transcript viewport.
 *
 * Scrolling is measured in display rows from the bottom: offset `0` means the
 * view is pinned to the newest rows (following). While scrolled up, freshly
 * appended rows do not move the visible window — the offset grows with the
 * content so the reader's place is kept (anchored reading).
 *
 * @example
 * ```ts
 * const transcript: string[] = [];
 * const viewport = new Viewport({ getLines: () => transcript });
 * tui.add(viewport);
 * ```
 */
export class Viewport implements Component {
  private readonly options: ViewportOptions;

  /** Display rows scrolled up from the bottom; `0` follows the tail. */
  private offset = 0;
  /** Height most recently given to {@link Viewport.renderArea}. */
  private lastHeight = 10;
  /** Total display rows at the previous render, for anchored reading. */
  private lastTotal = 0;

  /** Wrap cache: logical line → its display rows at {@link Viewport.cacheWidth}. */
  private cache = new Map<string, readonly string[]>();
  private cacheWidth = -1;
  /** Width most recently given to {@link Viewport.renderArea}. */
  private lastWidth = 80;

  /**
   * The live text selection, in absolute display coordinates: `row` indexes
   * {@link Viewport.displayRows}, `col` is a 0-based display column. Absolute,
   * not screen-relative, so the selection stays glued to its text while the
   * view scrolls under the pointer.
   */
  private selection:
    | { anchor: { row: number; col: number }; head: { row: number; col: number } }
    | undefined;

  constructor(options: ViewportOptions) {
    this.options = options;
  }

  /** `true` while the view is pinned to the newest rows. */
  get isFollowing(): boolean {
    return this.offset === 0;
  }

  /** Snaps the view back to the bottom (offset `0`). */
  follow(): void {
    this.offset = 0;
  }

  /** Drops the wrap cache so every line re-wraps on the next render. */
  invalidate(): void {
    this.cache.clear();
    this.cacheWidth = -1;
  }

  render(width: number): string[] {
    // Inline-mode fallback: behave like a fixed ten-row area.
    return this.renderArea(width, 10);
  }

  renderArea(width: number, height: number): string[] {
    this.lastHeight = height;
    this.lastWidth = width;
    const rows = this.displayRows(width);
    const total = rows.length;

    // Anchored reading: while scrolled up, growth below must not move the view.
    if (this.offset > 0 && total > this.lastTotal) this.offset += total - this.lastTotal;
    this.lastTotal = total;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - height)));

    // The window of `height` rows ending `offset` rows above the bottom.
    const end = total - this.offset;
    const start = Math.max(0, end - height);
    const visible = rows.slice(start, end);
    // Paint the live selection onto the rows it crosses, before padding and
    // the scroll banner are laid over the frame.
    const span = this.orderedSelection();
    if (span) {
      for (let i = 0; i < visible.length; i++) {
        const row = start + i;
        if (row < span.from.row || row > span.to.row) continue;
        const c1 = row === span.from.row ? span.from.col : 0;
        const c2 = row === span.to.row ? span.to.col + 1 : Number.POSITIVE_INFINITY;
        visible[i] = highlightSpan(visible[i] ?? "", c1, c2);
      }
    }
    const lines: string[] = [];
    const slack = height - visible.length;
    // Bottom-anchored by default; centered while the host says the view is
    // in its empty splash state.
    const padTop = slack > 0 && this.options.centered?.() ? Math.floor(slack / 2) : slack;
    for (let i = 0; i < padTop; i++) lines.push("");
    lines.push(...visible);
    while (lines.length < height) lines.push("");

    if (this.offset > 0 && lines.length > 0) {
      const unit = this.offset === 1 ? "line" : "lines";
      lines[0] = themeStyle("muted")(
        truncateToWidth(`… ${this.offset} ${unit} below · End/G to follow`, width),
      );
    }
    return lines;
  }

  handleInput(key: Key): boolean {
    const page = Math.max(1, this.lastHeight - 1);
    if (matchesKey(key, "wheelup")) {
      this.scrollBy(this.wheelStep());
      return true;
    }
    if (matchesKey(key, "wheeldown")) {
      this.scrollBy(-this.wheelStep());
      return true;
    }
    // One line per arrow. Only ever reached while the viewport holds focus,
    // where alternate scroll (terminal.ts) can deliver wheel motion as arrow
    // keys — so this never competes with an editor.
    if (matchesKey(key, "up")) {
      this.scrollBy(1);
      return true;
    }
    if (matchesKey(key, "down")) {
      this.scrollBy(-1);
      return true;
    }
    if (matchesKey(key, "pageup")) {
      this.scrollBy(page);
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      this.scrollBy(-page);
      return true;
    }
    if (matchesKey(key, "home")) {
      this.offset = this.maxOffset();
      return true;
    }
    if (matchesKey(key, "end")) {
      this.offset = 0;
      return true;
    }
    return false;
  }

  /** Height most recently given to {@link Viewport.renderArea}. */
  get renderedHeight(): number {
    return this.lastHeight;
  }

  /** `true` while a selection gesture is holding a span. */
  get hasSelection(): boolean {
    return this.selection !== undefined;
  }

  /**
   * Begins a selection at a cell of the rendered area (0-based row within
   * the area, 0-based column). Lands on the nearest content row, so a drag
   * that starts on the blank padding above a short transcript still selects
   * from the top.
   *
   * @returns `false` when there is no content to select at all.
   */
  beginSelectionAt(localRow: number, column: number): boolean {
    const cell = this.contentCell(localRow, column);
    if (cell === undefined) return false;
    this.selection = { anchor: cell, head: { ...cell } };
    return true;
  }

  /**
   * Extends the selection to a cell, auto-scrolling when the pointer rides
   * the top or bottom edge — which is how a drag selects more than a
   * screenful: the view moves, the anchor stays glued to its text.
   */
  dragSelectionTo(localRow: number, column: number): void {
    if (this.selection === undefined) return;
    if (localRow <= 0) this.scrollBy(1);
    else if (localRow >= this.lastHeight - 1) this.scrollBy(-1);
    const cell = this.contentCell(localRow, column);
    if (cell !== undefined) this.selection.head = cell;
  }

  /**
   * Ends the gesture and returns the selected text, plain and
   * newline-joined, with per-row trailing whitespace trimmed the way
   * terminals trim it. A click — no movement, or nothing but blanks — ends
   * with `undefined` and no selection left behind.
   */
  endSelection(): string | undefined {
    const span = this.orderedSelection();
    this.selection = undefined;
    if (!span) return undefined;
    if (span.from.row === span.to.row && span.from.col === span.to.col) return undefined;
    return this.spanText(span);
  }

  /**
   * Selects the word under a cell — the contiguous run of non-whitespace
   * columns, which is what a double-click means in a terminal: file paths,
   * URLs and identifiers come out whole. Lands on nothing when the cell is
   * blank.
   */
  selectWordAt(localRow: number, column: number): boolean {
    const cell = this.contentCell(localRow, column);
    if (cell === undefined) return false;
    const plain = stripAnsi(this.displayRows(this.lastWidth)[cell.row] ?? "");
    const clusters = columnClusters(plain);
    const hit = clusters.find(
      (cluster) => cell.col >= cluster.start && cell.col < cluster.start + cluster.width,
    );
    if (hit === undefined || hit.blank) return false;
    let first = clusters.indexOf(hit);
    let last = first;
    while (first > 0 && !clusters[first - 1]!.blank) first--;
    while (last < clusters.length - 1 && !clusters[last + 1]!.blank) last++;
    const from = clusters[first]!;
    const to = clusters[last]!;
    this.selection = {
      anchor: { row: cell.row, col: from.start },
      head: { row: cell.row, col: to.start + to.width - 1 },
    };
    return true;
  }

  /** Selects a whole display row — the triple-click. Blank rows select nothing. */
  selectRowAt(localRow: number): boolean {
    const cell = this.contentCell(localRow, 0);
    if (cell === undefined) return false;
    const plain = stripAnsi(this.displayRows(this.lastWidth)[cell.row] ?? "").trimEnd();
    const width = stringWidth(plain);
    if (width === 0) return false;
    this.selection = {
      anchor: { row: cell.row, col: 0 },
      head: { row: cell.row, col: width - 1 },
    };
    return true;
  }

  /**
   * The selected text without ending the selection — for gestures like the
   * double-click, where the copy is immediate but the highlight should stay
   * up as the receipt until the next gesture replaces it.
   */
  selectionText(): string | undefined {
    const span = this.orderedSelection();
    // No zero-movement check here: a word-select of a one-character word is
    // a real single-cell span, not an abandoned click.
    return span ? this.spanText(span) : undefined;
  }

  /** Drops the selection without producing text. */
  clearSelection(): void {
    this.selection = undefined;
  }

  /** The plain text of a span: sliced by column, trimmed per row, newline-joined. */
  private spanText(span: {
    from: { row: number; col: number };
    to: { row: number; col: number };
  }): string | undefined {
    const rows = this.displayRows(this.lastWidth);
    const parts: string[] = [];
    for (let row = span.from.row; row <= span.to.row; row++) {
      const c1 = row === span.from.row ? span.from.col : 0;
      const c2 = row === span.to.row ? span.to.col + 1 : Number.POSITIVE_INFINITY;
      parts.push(stripAnsi(sliceByWidth(rows[row] ?? "", c1, c2)).trimEnd());
    }
    const text = parts.join("\n");
    return text.trim() === "" ? undefined : text;
  }

  /** The selection with `from` before `to` in reading order, or `undefined`. */
  private orderedSelection():
    | { from: { row: number; col: number }; to: { row: number; col: number } }
    | undefined {
    if (this.selection === undefined) return undefined;
    const { anchor, head } = this.selection;
    const forward = anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col);
    return forward ? { from: anchor, to: head } : { from: head, to: anchor };
  }

  /** Maps an area cell to the nearest absolute content cell. */
  private contentCell(localRow: number, column: number): { row: number; col: number } | undefined {
    const rows = this.displayRows(this.lastWidth);
    const total = rows.length;
    if (total === 0) return undefined;
    const height = this.lastHeight;
    const end = total - this.offset;
    const start = Math.max(0, end - height);
    const visibleCount = Math.min(height, end - start);
    const slack = height - visibleCount;
    const padTop = slack > 0 && this.options.centered?.() ? Math.floor(slack / 2) : slack;
    const row = Math.max(0, Math.min(total - 1, start + (localRow - padTop)));
    return { row, col: Math.max(0, column) };
  }

  /** Scrolls by `delta` display rows (positive = up, away from the tail). */
  private scrollBy(delta: number): void {
    this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset()));
  }

  private maxOffset(): number {
    return Math.max(0, this.lastTotal - this.lastHeight);
  }

  private wheelStep(): number {
    return Math.max(1, this.options.wheelStep ?? 1);
  }

  /** Wraps the logical lines into display rows, reusing cached wraps per line. */
  private displayRows(width: number): string[] {
    if (width !== this.cacheWidth) {
      this.cache.clear();
      this.cacheWidth = width;
    }
    const lines = this.options.getLines(width);
    // Keep the append-mostly cache from growing without bound when old lines
    // are edited or dropped: reset once it clearly outnumbers the transcript.
    if (this.cache.size > lines.length * 2 + 256) this.cache.clear();

    const rows: string[] = [];
    for (const line of lines) {
      let wrapped = this.cache.get(line);
      if (wrapped === undefined) {
        wrapped = stringWidth(line) <= width ? [line] : wrapText(line, width);
        this.cache.set(line, wrapped);
      }
      rows.push(...wrapped);
    }
    return rows;
  }
}

/**
 * Repaints columns `[c1, c2)` of a styled row in reverse video.
 *
 * The middle is stripped of its own styling first: selection colour must win
 * over content colour (that is what makes it read as a selection), and a
 * mid-row SGR reset would otherwise switch the highlight off part-way.
 */
/** A plain row as column-addressed grapheme clusters, blanks marked. */
function columnClusters(plain: string): { start: number; width: number; blank: boolean }[] {
  const clusters: { start: number; width: number; blank: boolean }[] = [];
  let column = 0;
  for (const token of tokenize(plain)) {
    if (token.ansi || token.width === 0) continue;
    clusters.push({ start: column, width: token.width, blank: token.text.trim() === "" });
    column += token.width;
  }
  return clusters;
}

function highlightSpan(row: string, c1: number, c2: number): string {
  const before = sliceByWidth(row, 0, c1);
  const middle = stripAnsi(sliceByWidth(row, c1, c2));
  const after = Number.isFinite(c2) ? sliceByWidth(row, c2) : "";
  if (middle === "") return row;
  return `${before}\u001b[7m${middle}\u001b[27m${after}`;
}
