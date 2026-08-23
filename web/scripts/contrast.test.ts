/**
 * Verified contrast — the design system's own accountability check.
 *
 * The site's claim is that it does not overclaim. DESIGN.md §2.1.2 used to
 * annotate 26 contrast ratios by hand; 17 were wrong when computed from the
 * hexes actually shipping in `app/globals.css`, 11 of them optimistically. So
 * the numbers are no longer written by a human. This file parses the tokens
 * out of the stylesheet, computes WCAG 2.1 contrast for every pairing the
 * components actually produce, fails when one is under its floor, and
 * regenerates the table in DESIGN.md from the same computation.
 *
 *   npx vitest run scripts/contrast.test.ts                     # check
 *   UPDATE_CONTRAST_TABLE=1 npx vitest run scripts/contrast.test.ts   # rewrite §2.1.2
 *
 * Everything here reads the real files. Nothing is hard-coded except the
 * floors (WCAG) and the roles the spec assigns each token.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const CSS_PATH = join(WEB_DIR, "app", "globals.css");
const DESIGN_PATH = join(WEB_DIR, "DESIGN.md");

// Comments go first: the stylesheet documents tokens *inside* comments
// ("writes `z-(--z-header)`"), and a declaration parser that cannot tell the
// two apart would read prose as a colour.
const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/* ------------------------------------------------------------------ *
 * WCAG 2.1 contrast
 * ------------------------------------------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

const toLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }: Rgb): number =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Two decimals, the precision the table publishes. Truncated, never rounded
 *  up: a token that computes to 4.497 must not be published as "4.50". */
const floor2 = (n: number): string => (Math.floor(n * 100) / 100).toFixed(2);

/* ------------------------------------------------------------------ *
 * Oklab mixing — `color-mix(in oklab, …)` resolved the way a browser does
 * ------------------------------------------------------------------ */

const cbrt = Math.cbrt;

function toOklab({ r, g, b }: Rgb): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const toSrgb = (c: number): number => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(v * 255)));
  };
  return {
    r: toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** `color-mix(in oklab, A p%, B)` with both sides opaque. */
function mixOklab(a: Rgb, b: Rgb, pct: number): Rgb {
  const t = pct / 100;
  const [al, aa, ab] = toOklab(a);
  const [bl, ba, bb] = toOklab(b);
  return fromOklab([bl + (al - bl) * t, ba + (aa - ba) * t, bb + (ab - bb) * t]);
}

/**
 * `color-mix(in oklab, A p%, transparent)` is A at alpha p — mixing in a
 * premultiplied space with a zero-alpha colour leaves the colour untouched and
 * scales only the alpha. The browser then composites that over whatever ground
 * it lands on, in sRGB, which is what this does.
 */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const blend = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return { r: blend(fg.r, bg.r), g: blend(fg.g, bg.g), b: blend(fg.b, bg.b) };
}

/* ------------------------------------------------------------------ *
 * Parsing the stylesheet
 * ------------------------------------------------------------------ */

type Decls = Map<string, string>;

/** Every rule body whose selector is exactly `selector`, in source order. */
function ruleBodies(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `\s*\{` is the boundary that keeps `:root` from matching `:root:not(…)`
  // or `:root[data-theme="light"]` — those continue with `:` or `[`.
  const opener = new RegExp(`${escaped}\\s*\\{`, "g");
  const bodies: string[] = [];
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    bodies.push(source.slice(start, i - 1));
    match = opener.exec(source);
  }
  return bodies;
}

function declsOf(source: string, selector: string): Decls {
  const out: Decls = new Map();
  for (const body of ruleBodies(source, selector)) {
    for (const line of body.split(";")) {
      const m = /(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(line.trim());
      if (m) out.set(m[1], m[2].trim());
    }
  }
  return out;
}

const merge = (...maps: Decls[]): Decls => new Map(maps.flatMap((m) => [...m]));

const RAW_RAMPS = declsOf(css, "@theme");
const ROOT_DARK = declsOf(css, ":root");
const LIGHT_MEDIA = declsOf(css, ':root:not([data-theme="dark"])');
const LIGHT_ATTR = declsOf(css, ':root[data-theme="light"]');
const FORCE_DARK = declsOf(css, ".force-dark");

/**
 * The three colour contexts a pixel can be painted in. Each is the cascade the
 * browser actually resolves, not a hand-copied list: light is the dark root
 * with the light block over it, so a token the light block forgot is caught
 * here as a dark value on a light ground rather than passing silently.
 */
const CONTEXTS = {
  dark: merge(RAW_RAMPS, ROOT_DARK),
  light: merge(RAW_RAMPS, ROOT_DARK, LIGHT_ATTR),
  "force-dark on light": merge(RAW_RAMPS, ROOT_DARK, LIGHT_ATTR, FORCE_DARK),
} as const;

type ContextName = keyof typeof CONTEXTS;

/** Resolve a token to a colour, following one level of `color-mix`. */
function resolve(decls: Decls, token: string, ground: Rgb | null = null): Rgb | null {
  const raw = decls.get(token);
  if (!raw) return null;

  const direct = parseHex(raw);
  if (direct) return direct;

  const mix = /^color-mix\(in oklab,\s*var\((--[a-z0-9-]+)\)\s*([\d.]+)%,\s*(.+)\)$/i.exec(raw);
  if (!mix) return null;
  const from = resolve(decls, mix[1]);
  if (!from) return null;
  const pct = Number.parseFloat(mix[2]);
  const rest = mix[3].trim();
  if (rest === "transparent") return ground ? over(from, pct / 100, ground) : null;
  const to = resolve(decls, rest.startsWith("var(") ? rest.slice(4, -1) : rest);
  return to ? mixOklab(from, to, pct) : null;
}

/* ------------------------------------------------------------------ *
 * What the components actually pair
 * ------------------------------------------------------------------ */

/** Class fragment → semantic token, longest fragment first so
 *  `text-accent-hover` never matches as `text-accent`. */
const TEXT_UTILITIES: ReadonlyArray<[string, string]> = [
  ["accent-hover", "--accent-hover"],
  ["accent-quiet", "--accent-quiet"],
  ["accent", "--accent"],
  ["muted", "--text-muted"],
  ["faint", "--text-faint"],
  ["text", "--text"],
  ["good", "--good"],
  ["warn", "--warn"],
  ["bad", "--bad"],
];

const SURFACE_UTILITIES: ReadonlyArray<[string, string]> = [
  ["surface-raised", "--surface-raised"],
  ["surface-card", "--surface-card"],
  ["surface-inset", "--surface-inset"],
  ["surface-hover", "--surface-hover"],
  ["surface", "--surface"],
];

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["app", "components"]) {
    const root = join(WEB_DIR, dir);
    for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (entry.endsWith(".tsx")) out.push(join(root, entry));
    }
  }
  return out;
}

/** Scan the components for the class names that create a pairing. */
function usedTokens(): { text: Set<string>; surface: Set<string> } {
  // `--surface` is the page ground: <body> paints it whether or not any
  // component names it, so every text token lands on it at least once.
  const surface = new Set<string>(["--surface"]);
  const text = new Set<string>();
  const textRe = new RegExp(`\\btext-(${TEXT_UTILITIES.map(([c]) => c).join("|")})\\b`, "g");
  const bgRe = new RegExp(`\\bbg-(${SURFACE_UTILITIES.map(([c]) => c).join("|")})\\b`, "g");
  const byClass = new Map([...TEXT_UTILITIES, ...SURFACE_UTILITIES]);

  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(textRe)) text.add(byClass.get(m[1])!);
    for (const m of src.matchAll(bgRe)) surface.add(byClass.get(m[1])!);
  }
  return { text, surface };
}

const USED = usedTokens();

/**
 * Every JSX opening tag that carries `className` containing `needle`.
 *
 * Walks forward from the nearest preceding `<` to the `>` that closes the tag,
 * skipping any `>` nested inside a `{…}` expression or a string, so an
 * attribute value can contain one without truncating the tag.
 */
function tagsWithClass(src: string, needle: string): string[] {
  const tags: string[] = [];
  let at = src.indexOf(needle);
  while (at !== -1) {
    const open = src.lastIndexOf("<", at);
    if (open !== -1) {
      let depth = 0;
      let quote = "";
      let i = open;
      for (; i < src.length; i += 1) {
        const c = src[i];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        else if (c === ">" && depth === 0) break;
      }
      tags.push(src.slice(open, i + 1));
    }
    at = src.indexOf(needle, at + needle.length);
  }
  return tags;
}

/* ------------------------------------------------------------------ *
 * Floors (§2.1.5)
 * ------------------------------------------------------------------ */

const BODY_FLOOR = 4.5;
const NON_TEXT_FLOOR = 3;

/** Every text token in the palette, in the order §2.1.2 declares them. The
 *  cross-product test enforces only the ones components use; this list is what
 *  the generated table documents, so a token can never be quietly undocumented. */
const PALETTE_TEXT: ReadonlyArray<[token: string, floor: number, note: string]> = [
  ["--text", BODY_FLOOR, "body + headings"],
  ["--text-muted", BODY_FLOOR, "secondary prose, lede"],
  ["--text-faint", BODY_FLOOR, "captions, metadata"],
  ["--accent", BODY_FLOOR, "links, accent text"],
  ["--accent-hover", BODY_FLOOR, "link hover"],
  ["--accent-quiet", NON_TEXT_FLOOR, "decoration only — never text"],
  ["--good", BODY_FLOOR, "status"],
  ["--warn", BODY_FLOOR, "status"],
  ["--bad", BODY_FLOOR, "status"],
];

const PALETTE_NON_TEXT: ReadonlyArray<[token: string, floor: number, note: string]> = [
  ["--focus-ring", NON_TEXT_FLOOR, "focus outline"],
  ["--border-control", NON_TEXT_FLOOR, "ghost button + input boundary"],
];

const ALL_SURFACES = SURFACE_UTILITIES.map(([, token]) => token);
const FLOOR_BY_TOKEN = new Map(PALETTE_TEXT.map(([token, floor]) => [token, floor]));

interface Row {
  token: string;
  floor: number;
  note: string;
  onSurface: number;
  worstGround: string;
  worst: number;
}

function rowsFor(context: ContextName): Row[] {
  const decls = CONTEXTS[context];
  const surfaceColour = new Map(
    ALL_SURFACES.map((token) => [token, resolve(decls, token)] as const),
  );

  return [...PALETTE_TEXT, ...PALETTE_NON_TEXT].map(([token, floor, note]) => {
    const fg = resolve(decls, token);
    if (!fg) throw new Error(`${context}: ${token} is not declared or is not a colour`);
    let worst = Number.POSITIVE_INFINITY;
    let worstGround = "";
    for (const ground of ALL_SURFACES) {
      const bg = surfaceColour.get(ground);
      if (!bg) throw new Error(`${context}: ${ground} is not declared or is not a colour`);
      const ratio = contrast(fg, bg);
      if (ratio < worst) {
        worst = ratio;
        worstGround = ground;
      }
    }
    const surfaceBg = surfaceColour.get("--surface")!;
    return { token, floor, note, onSurface: contrast(fg, surfaceBg), worstGround, worst };
  });
}

/* ------------------------------------------------------------------ *
 * The generated table
 * ------------------------------------------------------------------ */

const BEGIN = "<!-- BEGIN GENERATED: contrast — do not hand-edit, see scripts/contrast.test.ts -->";
const END = "<!-- END GENERATED: contrast -->";

function renderTable(): string {
  const lines: string[] = [
    BEGIN,
    "",
    "Computed from the token hexes in `app/globals.css` by",
    "`scripts/contrast.test.ts`, which fails the build if any pair drops below its",
    "floor. **Do not hand-edit these numbers** — regenerate them with",
    "`UPDATE_CONTRAST_TABLE=1 npx vitest run scripts/contrast.test.ts` from `web/`.",
    "",
    "*Worst ground* is the lowest-contrast surface the token can legally land on,",
    "across `--surface`, `--surface-raised`, `--surface-card`, `--surface-inset` and",
    "`--surface-hover`. The floor is the one that has to hold.",
    "",
  ];

  for (const context of ["dark", "light"] as const) {
    lines.push(`**${context[0].toUpperCase()}${context.slice(1)}**`, "");
    lines.push("| Token | Value | vs `--surface` | Worst ground | Worst | Floor | Used for |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rowsFor(context)) {
      const value = CONTEXTS[context].get(row.token) ?? "";
      lines.push(
        `| \`${row.token}\` | \`${value}\` | ${floor2(row.onSurface)}:1 | ` +
          `\`${row.worstGround}\` | ${floor2(row.worst)}:1 | ${row.floor}:1 | ${row.note} |`,
      );
    }
    lines.push("");
  }

  const gold = parseHex(RAW_RAMPS.get("--color-gold") ?? "")!;
  const goldHover = parseHex(RAW_RAMPS.get("--color-gold-hover") ?? "")!;
  const onAccent = parseHex(ROOT_DARK.get("--on-accent") ?? "")!;
  lines.push(
    `The gold fill is the same in both themes, so \`--on-accent\` on it is one number: ` +
      `${floor2(contrast(onAccent, gold))}:1 at rest, ` +
      `${floor2(contrast(onAccent, goldHover))}:1 on hover.`,
    "",
    "`.force-dark` resolves every one of these to its dark value — the always-dark",
    "scope redeclares the full block, which is asserted rather than assumed.",
    "",
    END,
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("contrast", () => {
  it("clears the body floor for every text/surface pair the components produce", () => {
    const failures: string[] = [];
    for (const context of Object.keys(CONTEXTS) as ContextName[]) {
      const decls = CONTEXTS[context];
      for (const token of [...USED.text].sort()) {
        // Floors are per token: §2.1.5 puts `--accent-quiet` at the non-text
        // 3:1 because it may only ever paint decoration, which the next test
        // proves rather than assumes.
        const floor = FLOOR_BY_TOKEN.get(token) ?? BODY_FLOOR;
        const fg = resolve(decls, token);
        expect(fg, `${context}: ${token}`).not.toBeNull();
        for (const ground of [...USED.surface].sort()) {
          const bg = resolve(decls, ground);
          expect(bg, `${context}: ${ground}`).not.toBeNull();
          const ratio = contrast(fg!, bg!);
          if (ratio < floor) {
            failures.push(`${context}: ${token} on ${ground} = ${floor2(ratio)}:1 (< ${floor})`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("paints --accent-quiet only on decoration that is hidden from the a11y tree", () => {
    // `--accent-quiet` sits at 3.27:1 on light — below the text floor and
    // above the non-text one — so §2.1.5 restricts it to decoration. That is
    // only true while every element carrying it is `aria-hidden`: the eyebrow
    // arc (an SVG) and the `$` prompt glyph in a command chip, which is also
    // excluded from the copy payload. Anything else is a real contrast bug.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("text-accent-quiet")) continue;
      for (const tag of tagsWithClass(src, "text-accent-quiet")) {
        if (!/aria-hidden/.test(tag)) {
          offenders.push(`${file.slice(WEB_DIR.length)}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("clears the non-text floor for the focus ring and control borders", () => {
    const failures: string[] = [];
    for (const context of Object.keys(CONTEXTS) as ContextName[]) {
      const decls = CONTEXTS[context];
      for (const [token] of PALETTE_NON_TEXT) {
        const fg = resolve(decls, token);
        expect(fg, `${context}: ${token}`).not.toBeNull();
        for (const ground of ALL_SURFACES) {
          const bg = resolve(decls, ground)!;
          const ratio = contrast(fg!, bg);
          if (ratio < NON_TEXT_FLOOR) {
            failures.push(`${context}: ${token} on ${ground} = ${floor2(ratio)}:1`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("clears the body floor for text on the gold fill", () => {
    const gold = parseHex(RAW_RAMPS.get("--color-gold") ?? "")!;
    const goldHover = parseHex(RAW_RAMPS.get("--color-gold-hover") ?? "")!;
    const onAccent = parseHex(ROOT_DARK.get("--on-accent") ?? "")!;
    expect(contrast(onAccent, gold)).toBeGreaterThanOrEqual(BODY_FLOOR);
    expect(contrast(onAccent, goldHover)).toBeGreaterThanOrEqual(BODY_FLOOR);
  });

  it("clears the body floor for text on every accent tint", () => {
    // The tints are the four grounds §2.1.2 mixes from the accent. Two are
    // opaque mixes over `--surface-card`; two carry alpha, so they are
    // composited over each surface they can sit on.
    const failures: string[] = [];
    for (const context of Object.keys(CONTEXTS) as ContextName[]) {
      const decls = CONTEXTS[context];
      const pairs: ReadonlyArray<[tint: string, fg: string]> = [
        ["--accent-tint-card", "--text"],
        ["--accent-tint-chip", "--text"],
        ["--accent-tint-icon", "--accent"],
        ["--accent-tint-badge", "--accent"],
      ];
      for (const [tint, fgToken] of pairs) {
        const fg = resolve(decls, fgToken)!;
        for (const ground of ALL_SURFACES) {
          const bg = resolve(decls, tint, resolve(decls, ground));
          if (!bg) continue; // opaque mix: it has no ground to composite over
          const ratio = contrast(fg, bg);
          if (ratio < BODY_FLOOR) {
            failures.push(`${context}: ${fgToken} on ${tint} over ${ground} = ${floor2(ratio)}:1`);
          }
        }
        const opaque = resolve(decls, tint);
        if (opaque && contrast(fg, opaque) < BODY_FLOOR) {
          failures.push(`${context}: ${fgToken} on ${tint} = ${floor2(contrast(fg, opaque))}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("redeclares every dark token inside the always-dark scope", () => {
    // `.force-dark` inherits from whichever root is active, so anything it
    // leaves out silently takes the *light* value inside dark terminal art.
    // `--elev-glow` was exactly that bug.
    const missing = [...ROOT_DARK.keys()].filter((token) => !FORCE_DARK.has(token));
    expect(missing).toEqual([]);
    const drifted = [...FORCE_DARK.entries()]
      .filter(([token, value]) => ROOT_DARK.has(token) && ROOT_DARK.get(token) !== value)
      .map(([token]) => token);
    expect(drifted).toEqual([]);
  });

  it("keeps the two light blocks byte-identical", () => {
    // §2.1.2's standing rule: the `prefers-color-scheme` guard and the explicit
    // attribute must not drift, or a system-light visitor and a toggled-light
    // visitor see two different sites. Compared as declarations so the extra
    // indentation inside the media query is not counted as drift.
    const flatten = (m: Decls) =>
      [...m.entries()].map(([k, v]) => `${k}: ${v}`).sort((a, b) => a.localeCompare(b));
    expect(flatten(LIGHT_MEDIA)).toEqual(flatten(LIGHT_ATTR));
    expect(LIGHT_MEDIA.size).toBeGreaterThan(0);
  });

  it("documents every text token the components use", () => {
    const documented = new Set(PALETTE_TEXT.map(([token]) => token));
    const undocumented = [...USED.text].filter((token) => !documented.has(token));
    expect(undocumented).toEqual([]);
  });

  it("matches the generated table in DESIGN.md §2.1.2", () => {
    const table = renderTable();
    const design = readFileSync(DESIGN_PATH, "utf8");
    const start = design.indexOf(BEGIN);
    const end = design.indexOf(END);
    expect(start, "DESIGN.md is missing the generated-contrast markers").toBeGreaterThan(-1);

    const next =
      start > -1 && end > -1
        ? design.slice(0, start) + table + design.slice(end + END.length)
        : design;

    if (process.env.UPDATE_CONTRAST_TABLE) {
      writeFileSync(DESIGN_PATH, next, "utf8");
      return;
    }
    expect(
      next === design,
      "DESIGN.md §2.1.2 is stale — regenerate with " +
        "`UPDATE_CONTRAST_TABLE=1 npx vitest run scripts/contrast.test.ts`",
    ).toBe(true);
  });
});
