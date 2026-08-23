/**
 * The `StatusBar` component: a single line of left/centre/right aligned segments.
 *
 * @packageDocumentation
 */

import type { Style } from "../ansi.js";
import type { ThemeToken } from "../theme.js";
import type { Component } from "../tui.js";
import { padToWidth, stringWidth, truncateToWidth } from "../width.js";
import { resolveStyle } from "./text.js";

/** One labelled chunk of a {@link StatusBar}. */
export interface StatusSegment {
  /** Text to display. */
  readonly text: string;
  /** Style override; defaults to the bar's own style. */
  readonly style?: Style | ThemeToken;
}

/** Options for {@link StatusBar}. */
export interface StatusBarOptions {
  /** Segments pinned to the left edge. */
  readonly left?: readonly StatusSegment[];
  /** Segments centred in the remaining space. */
  readonly center?: readonly StatusSegment[];
  /** Segments pinned to the right edge. */
  readonly right?: readonly StatusSegment[];
  /** Text placed between adjacent segments (default `"  "`). */
  readonly separator?: string;
  /** Default segment style; defaults to the `statusBar` theme token. */
  readonly style?: Style | ThemeToken;
  /** Pad the bar to the full width (default `true`). */
  readonly fill?: boolean;
}

/**
 * Renders a one-line status bar.
 *
 * Right-aligned segments always win the space contest: when the line is too narrow
 * the centre group is dropped first, then the left group is truncated.
 *
 * @example
 * ```ts
 * new StatusBar({
 *   left: [{ text: "arcturn", style: "statusBarAccent" }, { text: "main" }],
 *   right: [{ text: "12.4k tokens" }],
 * });
 * ```
 */
export class StatusBar implements Component {
  private options: StatusBarOptions;

  constructor(options: StatusBarOptions = {}) {
    this.options = options;
  }

  /** Merges new options into the bar. */
  setOptions(options: StatusBarOptions): void {
    this.options = { ...this.options, ...options };
  }

  render(width: number): string[] {
    const separator = this.options.separator ?? "  ";
    const baseStyle = resolveStyle(this.options.style ?? "statusBar");
    const fill = this.options.fill ?? true;

    const join = (segments: readonly StatusSegment[] | undefined): string => {
      if (!segments || segments.length === 0) return "";
      return segments
        .map((s) => (s.style ? resolveStyle(s.style) : baseStyle)(s.text))
        .join(baseStyle(separator));
    };

    const left = join(this.options.left);
    const center = join(this.options.center);
    const right = join(this.options.right);

    const leftWidth = stringWidth(left);
    const centerWidth = stringWidth(center);
    const rightWidth = stringWidth(right);

    if (leftWidth + centerWidth + rightWidth + 2 > width) {
      // Not enough room for three groups: keep left and right only.
      const budget = Math.max(0, width - rightWidth - 1);
      const head = truncateToWidth(left, budget);
      const line = padToWidth(head, Math.max(0, width - rightWidth)) + right;
      return [truncateToWidth(line, width, "")];
    }

    const leftPad = Math.max(0, Math.floor((width - centerWidth) / 2) - leftWidth);
    const line =
      left +
      " ".repeat(leftPad) +
      center +
      " ".repeat(Math.max(0, width - leftWidth - leftPad - centerWidth - rightWidth)) +
      right;
    return [fill ? padToWidth(line, width) : line];
  }
}
