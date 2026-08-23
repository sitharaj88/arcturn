/**
 * Accessibility floor for the built-in palettes.
 *
 * Every colour-bearing token is decoded straight out of its {@link Style} `open`
 * sequence — `open` always carries the truecolour form (`38;2;r;g;b` for the
 * foreground, `48;2;r;g;b` for the background) regardless of the terminal's
 * detected colour level, so these assertions are independent of `setColorLevel`.
 *
 * Every palette is measured first against **its own `background` token** — the
 * canvas the TUI paints in screen mode, which is the ground the user actually
 * sees. The historical hard-coded grounds are kept as a secondary floor for
 * inline mode, where the terminal's own ground is unknown and unpaintable: the
 * dark palette must also clear `#1a1a1a`, and the light palette both pure white
 * and the warm parchment tone the brand is tuned for.
 *
 * A dedicated test guards the historical bug class where `lightTheme` spread
 * `darkTheme.styles` and silently inherited pale golds that are unreadable on a
 * light ground: no light token may be byte-identical to a dark token that fails
 * the light-background floor.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from "vitest";
import type { Style } from "./ansi.js";
import { darkTheme, lightTheme, type Theme, type ThemeToken } from "./theme.js";

/** Terminal ground the dark palette is designed for. */
const DARK_BG = "#1a1a1a";
/** Pure white — the worst case for a warm light palette. */
const WHITE = "#ffffff";
/** The warm parchment ground the light palette is tuned around. */
const PAPER = "#faf6ef";

/** Tokens that only ever draw hairlines or ghost text; exempt down to 1.2:1. */
const DECORATIVE: ReadonlySet<ThemeToken> = new Set<ThemeToken>([
  "border",
  "hr",
  "tableBorder",
  "quoteBorder",
  "codeBorder",
  "placeholder",
]);

/** Secondary text and accent rules: readable, but not required to hit 4.5:1. */
const RELAXED: ReadonlySet<ThemeToken> = new Set<ThemeToken>([
  "borderFocus",
  "codeComment",
  "linkUrl",
]);

/** Tokens that legitimately carry no colour (pure SGR attributes or identity). */
const ATTRIBUTE_ONLY: ReadonlySet<ThemeToken> = new Set<ThemeToken>([
  "bold",
  "italic",
  "strikethrough",
  "underline",
]);

/**
 * Tokens that carry a background and no foreground: the screen-mode canvas.
 * They are the *ground* other tokens are measured against, never text.
 */
const BACKGROUND_ONLY: ReadonlySet<ThemeToken> = new Set<ThemeToken>(["background"]);

const DECORATIVE_MIN = 1.2;
const RELAXED_MIN = 3;
const TEXT_MIN = 4.5;

function floorFor(token: ThemeToken): number {
  if (DECORATIVE.has(token)) return DECORATIVE_MIN;
  if (RELAXED.has(token)) return RELAXED_MIN;
  return TEXT_MIN;
}

/** Pulls `38;2;r;g;b` (foreground) or `48;2;r;g;b` (background) out of an SGR string. */
function parseTrueColor(open: string, background: boolean): string | undefined {
  const introducer = background ? 48 : 38;
  const match = new RegExp(`${introducer};2;(\\d{1,3});(\\d{1,3});(\\d{1,3})`).exec(open);
  if (!match) return undefined;
  const hex = match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

const foreground = (style: Style): string | undefined => parseTrueColor(style.open, false);
const background = (style: Style): string | undefined => parseTrueColor(style.open, true);

/** Relative luminance per WCAG 2.x. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG contrast ratio between two hex colours, in `[1, 21]`. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const tokensOf = (theme: Theme): ThemeToken[] => Object.keys(theme.styles) as ThemeToken[];

/** Tokens whose foreground is meant to be read on their own background tint. */
const SELF_GROUNDED: ReadonlySet<ThemeToken> = new Set<ThemeToken>(["diffAdded", "diffRemoved"]);

const ESC = "\u001b";

describe("contrast helpers", () => {
  it("decodes truecolour foregrounds and backgrounds from an SGR sequence", () => {
    expect(parseTrueColor(`${ESC}[1m${ESC}[38;2;242;175;72m`, false)).toBe("#f2af48");
    expect(parseTrueColor(`${ESC}[38;2;1;2;3m${ESC}[48;2;29;42;31m`, true)).toBe("#1d2a1f");
    expect(parseTrueColor(`${ESC}[1m`, false)).toBeUndefined();
  });

  it("matches known WCAG ratios", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("token coverage", () => {
  for (const theme of [darkTheme, lightTheme]) {
    it(`${theme.name} declares a colour for every non-attribute token`, () => {
      const uncoloured = tokensOf(theme).filter(
        (token) =>
          !ATTRIBUTE_ONLY.has(token) &&
          foreground(theme.styles[token]) === undefined &&
          background(theme.styles[token]) === undefined,
      );
      expect(uncoloured).toEqual([]);
    });

    it(`${theme.name} canvas is background-only, never a text token`, () => {
      for (const token of BACKGROUND_ONLY) {
        const style = theme.styles[token];
        expect(background(style)).toBeDefined();
        expect(foreground(style)).toBeUndefined();
      }
    });
  }
});

/** The screen-mode canvas of a theme, as a hex colour. */
function canvasOf(theme: Theme): string {
  const ground = background(theme.styles.background);
  if (ground === undefined) throw new Error(`${theme.name} declares no background token`);
  return ground;
}

describe("darkTheme contrast", () => {
  for (const token of tokensOf(darkTheme)) {
    if (ATTRIBUTE_ONLY.has(token) || BACKGROUND_ONLY.has(token)) continue;
    // The theme's own canvas first (screen mode), then the legacy dark ground
    // as an inline-mode safety net.
    for (const ground of new Set([canvasOf(darkTheme), DARK_BG])) {
      it(`${token} clears its ${floorFor(token)}:1 floor on ${ground}`, () => {
        const style = darkTheme.styles[token];
        const fg = foreground(style);
        expect(fg).toBeDefined();
        const base = SELF_GROUNDED.has(token) ? (background(style) ?? ground) : ground;
        expect(contrast(fg as string, base)).toBeGreaterThanOrEqual(floorFor(token));
      });
    }
  }

  it("keeps a legible border hierarchy: rules recede, code fences lead", () => {
    const ratio = (token: ThemeToken): number =>
      contrast(foreground(darkTheme.styles[token]) as string, DARK_BG);
    expect(ratio("hr")).toBeLessThan(ratio("border"));
    expect(ratio("border")).toBeLessThan(ratio("codeBorder"));
  });
});

describe("lightTheme contrast", () => {
  for (const token of tokensOf(lightTheme)) {
    if (ATTRIBUTE_ONLY.has(token) || BACKGROUND_ONLY.has(token)) continue;
    for (const ground of new Set([canvasOf(lightTheme), WHITE, PAPER])) {
      it(`${token} clears its ${floorFor(token)}:1 floor on ${ground}`, () => {
        const style = lightTheme.styles[token];
        const fg = foreground(style);
        expect(fg).toBeDefined();
        const base = SELF_GROUNDED.has(token) ? (background(style) ?? ground) : ground;
        expect(contrast(fg as string, base)).toBeGreaterThanOrEqual(floorFor(token));
      });
    }
  }
});

describe("light/dark independence", () => {
  it("shares no colour-bearing style between the two palettes", () => {
    const shared = tokensOf(darkTheme).filter((token) => {
      const dark = darkTheme.styles[token];
      if (foreground(dark) === undefined && background(dark) === undefined) return false;
      return lightTheme.styles[token].open === dark.open;
    });
    expect(shared).toEqual([]);
  });

  it("never inherits a dark token that would be unreadable on a light ground", () => {
    const inherited = tokensOf(darkTheme).filter((token) => {
      const dark = darkTheme.styles[token];
      const fg = foreground(dark);
      if (fg === undefined) return false;
      const readableOnLight =
        contrast(fg, WHITE) >= floorFor(token) && contrast(fg, PAPER) >= floorFor(token);
      return !readableOnLight && lightTheme.styles[token].open === dark.open;
    });
    expect(inherited).toEqual([]);
  });
});
