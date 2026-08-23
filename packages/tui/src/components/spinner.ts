/**
 * The `Spinner` component: an animated activity indicator.
 *
 * Animation is driven explicitly through {@link Spinner.tick} (or a timer started
 * with {@link Spinner.start}) so tests can advance frames deterministically without
 * fake timers.
 *
 * @packageDocumentation
 */

import type { Style } from "../ansi.js";
import type { ThemeToken } from "../theme.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../width.js";
import { resolveStyle } from "./text.js";

/** Built-in spinner animations. */
export const SPINNER_FRAMES = {
  /** Braille dots — the default. */
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  /** ASCII-safe rotating bar. */
  line: ["-", "\\", "|", "/"],
  /** Growing/shrinking bar. */
  bar: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"],
  /** Clock faces. */
  clock: ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"],
  /** Bouncing arrow. */
  arrow: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"],
} as const satisfies Record<string, readonly string[]>;

/** Name of a built-in spinner animation. */
export type SpinnerName = keyof typeof SPINNER_FRAMES;

/** Options for {@link Spinner}. */
export interface SpinnerOptions {
  /** Built-in animation name or a custom frame list (default `"dots"`). */
  readonly frames?: SpinnerName | readonly string[];
  /** Text shown after the glyph. */
  readonly label?: string;
  /** Milliseconds between frames when using {@link Spinner.start} (default `80`). */
  readonly interval?: number;
  /** Glyph style; defaults to the `spinner` theme token. */
  readonly style?: Style | ThemeToken;
  /** Label style; defaults to the `muted` theme token. */
  readonly labelStyle?: Style | ThemeToken;
}

/**
 * An animated single-line activity indicator.
 *
 * @example
 * ```ts
 * const spinner = new Spinner({ label: "Thinking…" });
 * spinner.start(() => tui.requestRender());
 * // …later
 * spinner.stop();
 * ```
 */
export class Spinner implements Component {
  private readonly frames: readonly string[];
  private readonly interval: number;
  private options: SpinnerOptions;
  private index = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SpinnerOptions = {}) {
    this.options = options;
    const frames = options.frames ?? "dots";
    this.frames = typeof frames === "string" ? SPINNER_FRAMES[frames] : frames;
    this.interval = options.interval ?? 80;
  }

  /** The glyph currently displayed. */
  get frame(): string {
    return this.frames[this.index % this.frames.length] ?? "";
  }

  /** Whether a timer started by {@link Spinner.start} is running. */
  get isSpinning(): boolean {
    return this.timer !== undefined;
  }

  /** Advances to the next animation frame. */
  tick(): void {
    this.index = (this.index + 1) % this.frames.length;
  }

  /** Replaces the label. */
  setLabel(label: string): void {
    this.options = { ...this.options, label };
  }

  /**
   * Starts a timer that advances the animation.
   *
   * @param onTick - Called after each frame change, typically `tui.requestRender`.
   */
  start(onTick?: () => void): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.tick();
      onTick?.();
    }, this.interval);
    this.timer.unref?.();
  }

  /** Stops the animation timer. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  render(width: number): string[] {
    const glyphFn = resolveStyle(this.options.style ?? "spinner");
    const labelFn = resolveStyle(this.options.labelStyle ?? "muted");
    const label = this.options.label;
    const body = label ? `${this.frame} ${label}` : this.frame;
    const styled = label ? `${glyphFn(this.frame)} ${labelFn(label)}` : glyphFn(this.frame);
    return [body.length > width ? truncateToWidth(styled, width) : styled];
  }
}
