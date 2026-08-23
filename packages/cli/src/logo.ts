/**
 * The arcturn brand mark, rendered as terminal art.
 *
 * The mark is a four-point guiding star over a sweeping arc — the name drawn
 * literally — on a small pixel grid rasterised with half-block characters,
 * two pixel rows per terminal row, washed in the brand gradient (starlight
 * fading to ember — the same ramp the website wears). `fg()` degrades
 * the gradient to the 256-colour or 16-colour palette on lesser terminals, so
 * the art needs no capability check of its own; callers should simply not
 * draw it on ASCII-only terminals.
 *
 * @packageDocumentation
 */

import { fg, getTheme, lightTheme } from "@arcturn/tui";

/**
 * The mark as a 12×12 bitmap: a four-point star (the guide) above an arc
 * sweeping up from the left (the turn).
 */
const ARCTURN_BITMAP: readonly string[] = [
  ".....##.....",
  ".....##.....",
  "....####....",
  "..########..",
  "..########..",
  "....####....",
  ".....##.....",
  ".....##.....",
  "............",
  "##..........",
  ".#####......",
  "...########.",
];

/**
 * Brand gradient endpoints, top to bottom: starlight above, ember below —
 * the star glows brightest and the turn fades into the dark.
 *
 * This is the DARK ground's ramp. On a light canvas the same two colours are
 * washed out (starlight is barely a tint on parchment), so
 * {@link brandGradient} swaps in the light theme's deepened ramp: the same
 * gold→ember arc, walked from the darker end of the brand scale.
 */
export const BRAND_GRADIENT = ["#fad185", "#b87436"] as const;

/** The light-canvas ramp: deep amber above, burnt ember below. */
export const BRAND_GRADIENT_LIGHT = ["#b06a06", "#8a4212"] as const;

/**
 * The brand ramp for the active theme.
 *
 * The wordmark is block art, so it lives or dies by contrast against the
 * canvas the composer paints — a fixed ramp cannot serve both grounds.
 */
export function brandGradient(): readonly [`#${string}`, `#${string}`] {
  return getTheme().name === lightTheme.name ? BRAND_GRADIENT_LIGHT : BRAND_GRADIENT;
}

/** The block cursor drawn after the wordmark — arcturn's "I'm typing" tell. */
export const CURSOR_BLOCK = "▌";

/** Columns the rendered art occupies. */
export const LOGO_WIDTH = ARCTURN_BITMAP[0]?.length ?? 0;

/** Terminal rows the rendered art occupies. */
export const LOGO_HEIGHT = Math.ceil(ARCTURN_BITMAP.length / 2);

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Linear blend between the gradient endpoints at `t` ∈ [0, 1]. */
function ramp(t: number, from: string, to: string): [number, number, number] {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(
    Math.round,
  ) as [number, number, number];
}

/** Options for {@link renderLogo}. */
export interface RenderLogoOptions {
  /** Gradient endpoints, top to bottom (default: {@link brandGradient} for the active theme). */
  readonly gradient?: readonly [string, string];
  /** Emit plain uncoloured art (used by tests and `NO_COLOR` paths). */
  readonly plain?: boolean;
}

/**
 * Render the arcturn mark.
 *
 * @param options - Gradient override or plain mode.
 * @returns {@link LOGO_HEIGHT} strings, each {@link LOGO_WIDTH} columns wide.
 */
export function renderLogo(options: RenderLogoOptions = {}): string[] {
  const [from, to] = options.gradient ?? brandGradient();
  const rows = ARCTURN_BITMAP.length;
  const lines: string[] = [];

  for (let top = 0; top < rows; top += 2) {
    const topRow = ARCTURN_BITMAP[top] ?? "";
    const bottomRow = ARCTURN_BITMAP[top + 1] ?? "";
    let line = "";
    for (let col = 0; col < LOGO_WIDTH; col++) {
      const hasTop = topRow[col] === "#";
      const hasBottom = bottomRow[col] === "#";
      const char = hasTop && hasBottom ? "█" : hasTop ? "▀" : hasBottom ? "▄" : " ";
      if (char === " ") {
        line += " ";
        continue;
      }
      // Colour by the centre of whichever pixel rows are lit.
      const t = (hasTop && hasBottom ? top + 0.5 : hasTop ? top : top + 1) / (rows - 1);
      line += options.plain ? char : fg(ramp(t, from, to))(char);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

/**
 * A horizontal rule washed in the brand ramp: ember on the left rising to
 * starlight on the right — the turn, drawn as a line. The hero banner's
 * signature element.
 *
 * @param width - Columns to fill.
 * @param char - Rule character (default `"─"`).
 */
export function brandRule(width: number, char = "─"): string {
  const [top, bottom] = brandGradient();
  let line = "";
  for (let i = 0; i < width; i++) {
    const t = width <= 1 ? 0 : i / (width - 1);
    // Left→right runs ember→starlight, so sample the ramp reversed.
    line += fg(ramp(1 - t, top, bottom))(char);
  }
  return line;
}

/* -------------------------------------------------------------------------- */
/* The pixel wordmark                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A 5×6 pixel letterform per character of "ARCTURN", plus the cursor block.
 * Rendered with half-blocks (two pixel rows per terminal row) the wordmark
 * stands three terminal rows tall — big type is what terminals do best.
 */
const WORDMARK_FONT: Readonly<Record<string, readonly string[]>> = {
  A: [".███.", "█...█", "█...█", "█████", "█...█", "█...█"],
  R: ["████.", "█...█", "█...█", "████.", "█.█..", "█..█."],
  C: [".████", "█....", "█....", "█....", "█....", ".████"],
  T: ["█████", "..█..", "..█..", "..█..", "..█..", "..█.."],
  U: ["█...█", "█...█", "█...█", "█...█", "█...█", ".███."],
  N: ["█...█", "██..█", "█.█.█", "█..██", "█...█", "█...█"],
};

/** The wordmark's pixel bitmap: ARCTURN, a gap, and the live cursor block. */
function wordmarkBitmap(): string[] {
  const letters = "ARCTURN".split("").map((ch) => WORDMARK_FONT[ch] ?? []);
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) {
    const line = letters.map((glyph) => (glyph[r] ?? ".....").replace(/█/g, "#")).join(".");
    rows.push(`${line}..##`);
  }
  return rows;
}

const WORDMARK_BITMAP = wordmarkBitmap();

/** Columns the rendered wordmark occupies. */
export const WORDMARK_WIDTH = WORDMARK_BITMAP[0]?.length ?? 0;

/** Terminal rows the rendered wordmark occupies. */
export const WORDMARK_HEIGHT = Math.ceil(WORDMARK_BITMAP.length / 2);

/**
 * Render the big ARCTURN pixel wordmark, washed left-to-right in the brand
 * ramp — ember rising to starlight, with the cursor block glowing at the end.
 *
 * @param options - Plain mode for tests and `NO_COLOR` paths.
 * @returns {@link WORDMARK_HEIGHT} strings, {@link WORDMARK_WIDTH} columns wide.
 */
export function renderWordmark(options: { plain?: boolean } = {}): string[] {
  const [top, bottom] = brandGradient();
  const rows = WORDMARK_BITMAP.length;
  const lines: string[] = [];
  for (let r = 0; r < rows; r += 2) {
    const topRow = WORDMARK_BITMAP[r] ?? "";
    const bottomRow = WORDMARK_BITMAP[r + 1] ?? "";
    let line = "";
    for (let col = 0; col < WORDMARK_WIDTH; col++) {
      const hasTop = topRow[col] === "#";
      const hasBottom = bottomRow[col] === "#";
      const char = hasTop && hasBottom ? "█" : hasTop ? "▀" : hasBottom ? "▄" : " ";
      if (char === " ") {
        line += " ";
        continue;
      }
      // Horizontal wash: ember on the left rising to starlight on the right.
      const t = WORDMARK_WIDTH <= 1 ? 0 : col / (WORDMARK_WIDTH - 1);
      line += options.plain ? char : fg(ramp(1 - t, top, bottom))(char);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

/**
 * The coloured `arcturn▌` wordmark: the name with the brand cursor blocked on.
 *
 * @param paintName - Style applied to the letters (usually the `title` token).
 */
export function wordmark(paintName: (text: string) => string): string {
  return `${paintName("arcturn")}${fg(brandGradient()[0])(CURSOR_BLOCK)}`;
}
