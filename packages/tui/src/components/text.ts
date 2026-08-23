/**
 * The `Text` component: styled, wrapped, padded static text.
 *
 * @packageDocumentation
 */

import type { Style } from "../ansi.js";
import { type ThemeToken, style as themeStyle, themeVersion } from "../theme.js";
import type { Component } from "../tui.js";
import { type Align, padToWidth, truncateToWidth, wrapText } from "../width.js";

/** Options for {@link Text}. */
export interface TextOptions {
  /** Explicit style, or a theme token resolved at render time. */
  readonly style?: Style | ThemeToken;
  /** Horizontal alignment within the available width (default `"left"`). */
  readonly align?: Align;
  /** Word-wrap instead of truncating (default `true`). */
  readonly wrap?: boolean;
  /** Blank columns on the left and right (default `0`). */
  readonly paddingX?: number;
  /** Blank rows above and below (default `0`). */
  readonly paddingY?: number;
  /** Pad every line to the full width (default `false`). */
  readonly fill?: boolean;
}

/**
 * Renders a block of text.
 *
 * @example
 * ```ts
 * const banner = new Text("Welcome to Arcturn", { style: "accent", align: "center" });
 * ```
 */
export class Text implements Component {
  private value: string;
  private options: TextOptions;
  private cache: { width: number; value: string; version: number; lines: string[] } | undefined;

  constructor(text = "", options: TextOptions = {}) {
    this.value = text;
    this.options = options;
  }

  /** The current text content. */
  get text(): string {
    return this.value;
  }

  /** Replaces the text content. */
  setText(text: string): void {
    if (text === this.value) return;
    this.value = text;
    this.cache = undefined;
  }

  /** Merges new options into the component. */
  setOptions(options: TextOptions): void {
    this.options = { ...this.options, ...options };
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const version = themeVersion();
    if (
      this.cache &&
      this.cache.width === width &&
      this.cache.value === this.value &&
      this.cache.version === version
    ) {
      return this.cache.lines;
    }
    const { align = "left", wrap = true, paddingX = 0, paddingY = 0, fill = false } = this.options;

    const contentWidth = Math.max(1, width - paddingX * 2);
    const raw = wrap
      ? wrapText(this.value, contentWidth)
      : this.value.split("\n").map((l) => truncateToWidth(l, contentWidth));

    const apply = resolveStyle(this.options.style);
    const pad = " ".repeat(paddingX);
    const lines: string[] = [];
    for (let i = 0; i < paddingY; i++) lines.push(fill ? " ".repeat(width) : "");
    for (const line of raw) {
      const aligned = align === "left" && !fill ? line : padToWidth(line, contentWidth, align);
      lines.push(pad + apply(aligned) + (fill ? pad : ""));
    }
    for (let i = 0; i < paddingY; i++) lines.push(fill ? " ".repeat(width) : "");

    this.cache = { width, value: this.value, version, lines };
    return lines;
  }
}

/** Resolves a style option (explicit style or theme token) to a style function. */
export function resolveStyle(input: Style | ThemeToken | undefined): Style {
  if (input === undefined) return themeStyle("text");
  if (typeof input === "string") return themeStyle(input);
  return input;
}
