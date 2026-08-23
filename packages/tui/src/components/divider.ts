/**
 * The `Divider` component: a full-width horizontal rule with an optional label.
 *
 * @packageDocumentation
 */

import type { Style } from "../ansi.js";
import type { ThemeToken } from "../theme.js";
import type { Component } from "../tui.js";
import { type Align, stringWidth, truncateToWidth } from "../width.js";
import { resolveStyle } from "./text.js";

/** Options for {@link Divider}. */
export interface DividerOptions {
  /** Character repeated to draw the rule (default `"─"`). */
  readonly char?: string;
  /** Optional label spliced into the rule. */
  readonly label?: string;
  /** Where the label sits (default `"left"`). */
  readonly align?: Align;
  /** Rule style; defaults to the `hr` theme token. */
  readonly style?: Style | ThemeToken;
  /** Label style; defaults to the `muted` theme token. */
  readonly labelStyle?: Style | ThemeToken;
  /** Blank columns kept clear at both ends (default `0`). */
  readonly margin?: number;
}

/**
 * Draws a single-line horizontal rule.
 *
 * @example
 * ```ts
 * new Divider({ label: "history", align: "center" });
 * // ────────────── history ──────────────
 * ```
 */
export class Divider implements Component {
  private options: DividerOptions;

  constructor(options: DividerOptions = {}) {
    this.options = options;
  }

  /** Merges new options into the divider. */
  setOptions(options: DividerOptions): void {
    this.options = { ...this.options, ...options };
  }

  render(width: number): string[] {
    const { char = "─", align = "left", margin = 0 } = this.options;
    const ruleFn = resolveStyle(this.options.style ?? "hr");
    const labelFn = resolveStyle(this.options.labelStyle ?? "muted");
    const gutter = " ".repeat(margin);
    const span = Math.max(0, width - margin * 2);
    if (span === 0) return [""];

    if (!this.options.label) return [gutter + ruleFn(char.repeat(span)) + gutter];

    const label = ` ${truncateToWidth(this.options.label, Math.max(1, span - 4))} `;
    const labelWidth = stringWidth(label);
    const slack = Math.max(0, span - labelWidth);
    const left =
      align === "left" ? Math.min(2, slack) : align === "right" ? slack : Math.floor(slack / 2);
    return [
      gutter +
        ruleFn(char.repeat(left)) +
        labelFn(label) +
        ruleFn(char.repeat(slack - left)) +
        gutter,
    ];
  }
}
