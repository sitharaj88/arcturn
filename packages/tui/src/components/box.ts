/**
 * The `Box` component: a bordered, padded, optionally titled container.
 *
 * @packageDocumentation
 */

import type { Style } from "../ansi.js";
import type { Key } from "../keys.js";
import type { ThemeToken } from "../theme.js";
import type { Component, CursorPosition } from "../tui.js";
import { type Align, padToWidth, stringWidth, truncateToWidth } from "../width.js";
import { resolveStyle } from "./text.js";

/** Names of the built-in border character sets. */
export type BorderStyle = "single" | "double" | "round" | "bold" | "ascii" | "none";

/** The nine characters that make up a border. */
export interface BorderChars {
  /** Top-left corner. */
  readonly topLeft: string;
  /** Top-right corner. */
  readonly topRight: string;
  /** Bottom-left corner. */
  readonly bottomLeft: string;
  /** Bottom-right corner. */
  readonly bottomRight: string;
  /** Horizontal run. */
  readonly horizontal: string;
  /** Vertical run. */
  readonly vertical: string;
}

/** Built-in border character sets. */
export const BORDERS: Record<Exclude<BorderStyle, "none">, BorderChars> = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
  },
  round: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  bold: {
    topLeft: "┏",
    topRight: "┓",
    bottomLeft: "┗",
    bottomRight: "┛",
    horizontal: "━",
    vertical: "┃",
  },
  ascii: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
  },
};

/** Padding inside a {@link Box}. */
export interface BoxPadding {
  /** Columns of padding on the left and right. */
  readonly x?: number;
  /** Rows of padding above and below. */
  readonly y?: number;
}

/** Options for {@link Box}. */
export interface BoxOptions {
  /** Border character set (default `"round"`). */
  readonly border?: BorderStyle;
  /** Title drawn into the top border. */
  readonly title?: string;
  /** Where the title sits (default `"left"`). */
  readonly titleAlign?: Align;
  /** Inner padding; a number sets both axes (default `{ x: 1, y: 0 }`). */
  readonly padding?: number | BoxPadding;
  /** Border style override; defaults to the `border` theme token. */
  readonly borderStyle?: Style | ThemeToken;
  /** Title style override; defaults to the `title` theme token. */
  readonly titleStyle?: Style | ThemeToken;
  /** Use the `borderFocus` token instead of `border` (default `false`). */
  readonly focused?: boolean;
}

/**
 * Draws a border and padding around one or more child components.
 *
 * @example
 * ```ts
 * const box = new Box(new Text("hello"), { title: "Greeting", border: "double" });
 * ```
 */
export class Box implements Component {
  private children: Component[];
  private options: BoxOptions;
  private childOffsetRow = 0;
  private childOffsetCol = 0;
  private childOffsets: number[] = [];

  constructor(child: Component | readonly Component[], options: BoxOptions = {}) {
    this.children = Array.isArray(child) ? [...child] : [child as Component];
    this.options = options;
  }

  /** Merges new options into the box (e.g. to toggle the focus ring). */
  setOptions(options: BoxOptions): void {
    this.options = { ...this.options, ...options };
  }

  /** Replaces the box contents. */
  setChildren(children: readonly Component[]): void {
    this.children = [...children];
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): string[] {
    const border = this.options.border ?? "round";
    const padding = normalizePadding(this.options.padding);
    const chars = border === "none" ? undefined : BORDERS[border];
    const frame = chars ? 1 : 0;

    const contentWidth = Math.max(1, width - frame * 2 - padding.x * 2);
    const inner: string[] = [];
    for (let i = 0; i < padding.y; i++) inner.push("");
    this.childOffsets = [];
    for (const child of this.children) {
      this.childOffsets.push(inner.length);
      inner.push(...child.render(contentWidth));
    }
    for (let i = 0; i < padding.y; i++) inner.push("");

    // `childOffsets` already accounts for the top padding rows.
    this.childOffsetRow = frame;
    this.childOffsetCol = frame + padding.x;

    const borderFn = resolveStyle(
      this.options.borderStyle ?? (this.options.focused ? "borderFocus" : "border"),
    );
    const pad = " ".repeat(padding.x);
    const body = inner.map((line) => {
      const cell = pad + padToWidth(line, contentWidth) + pad;
      return chars ? borderFn(chars.vertical) + cell + borderFn(chars.vertical) : cell;
    });

    if (!chars) return body;

    const runWidth = Math.max(0, width - 2);
    const top = borderFn(chars.topLeft + this.buildTop(chars, runWidth) + chars.topRight);
    const bottom = borderFn(
      chars.bottomLeft + chars.horizontal.repeat(runWidth) + chars.bottomRight,
    );
    return [top, ...body, bottom];
  }

  handleInput(key: Key): boolean {
    for (const child of this.children) {
      if (child.handleInput?.(key) === true) return true;
    }
    return false;
  }

  getCursor(): CursorPosition | undefined {
    for (let i = 0; i < this.children.length; i++) {
      const local = this.children[i]!.getCursor?.();
      if (local) {
        return {
          row: this.childOffsetRow + (this.childOffsets[i] ?? 0) + local.row,
          col: this.childOffsetCol + local.col,
        };
      }
    }
    return undefined;
  }

  /** Builds the horizontal run of the top border, splicing in the title. */
  private buildTop(chars: BorderChars, runWidth: number): string {
    const rawTitle = this.options.title;
    if (!rawTitle || runWidth < 4) return chars.horizontal.repeat(runWidth);

    const titleFn = resolveStyle(this.options.titleStyle ?? "title");
    const label = ` ${truncateToWidth(rawTitle, runWidth - 4)} `;
    const labelWidth = stringWidth(label);
    const slack = runWidth - labelWidth;
    const align = this.options.titleAlign ?? "left";
    const left = align === "left" ? 1 : align === "right" ? slack - 1 : Math.floor(slack / 2);
    const leftRun = Math.max(0, Math.min(slack, left));
    return (
      chars.horizontal.repeat(leftRun) +
      titleFn(label) +
      chars.horizontal.repeat(Math.max(0, slack - leftRun))
    );
  }
}

function normalizePadding(padding: number | BoxPadding | undefined): { x: number; y: number } {
  if (padding === undefined) return { x: 1, y: 0 };
  if (typeof padding === "number") return { x: padding, y: padding };
  return { x: padding.x ?? 1, y: padding.y ?? 0 };
}
