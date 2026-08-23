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

import { type Key, matchesKey } from "../keys.js";
import { style as themeStyle } from "../theme.js";
import type { Component } from "../tui.js";
import { stringWidth, truncateToWidth, wrapText } from "../width.js";

/** Options for {@link Viewport}. */
export interface ViewportOptions {
  /** Produces the logical (unwrapped, styled) transcript lines at a width. */
  readonly getLines: (width: number) => readonly string[];
  /** Rows scrolled per wheel step (default 3). */
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
    const rows = this.displayRows(width);
    const total = rows.length;

    // Anchored reading: while scrolled up, growth below must not move the view.
    if (this.offset > 0 && total > this.lastTotal) this.offset += total - this.lastTotal;
    this.lastTotal = total;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, total - height)));

    // The window of `height` rows ending `offset` rows above the bottom.
    const end = total - this.offset;
    const visible = rows.slice(Math.max(0, end - height), end);
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

  /** Scrolls by `delta` display rows (positive = up, away from the tail). */
  private scrollBy(delta: number): void {
    this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset()));
  }

  private maxOffset(): number {
    return Math.max(0, this.lastTotal - this.lastHeight);
  }

  private wheelStep(): number {
    return Math.max(1, this.options.wheelStep ?? 3);
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
