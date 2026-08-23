/**
 * The welcome banner shown when the interactive app starts.
 *
 * Three tiers, chosen by terminal capability and width:
 *
 * - **Hero** (Unicode, ≥ 70 columns): a full-width rounded card with the ✦ mark
 *   rendered in the brand gradient, the `arcturn▌` wordmark, tagline, session facts
 *   and key hints.
 * - **Card** (Unicode or ASCII, ≥ 30 columns): the same facts in a compact
 *   bordered card without the art.
 * - **Minimal** (under 30 columns): three plain lines, nothing that can wrap.
 *
 * Kept free of runtime dependencies so it can be rendered (and tested) from
 * plain inputs.
 */

import { BORDERS, bold, padToWidth, stringWidth, style, truncateToWidth } from "@arcturn/tui";
import { oneLine } from "./format.js";
import type { GlyphSet } from "./glyphs.js";
import { brandRule, renderWordmark, WORDMARK_WIDTH } from "./logo.js";

/** Everything the banner shows. */
export interface BannerInfo {
  /** Terminal width in columns. */
  readonly width: number;
  /** Resolved glyph set. */
  readonly glyphs: GlyphSet;
  /** Active model display name. */
  readonly model: string;
  /** Active permission mode. */
  readonly mode: string;
  /** Working directory, already shortened for display. */
  readonly cwd: string;
  /** CLI version, without a leading `v`. */
  readonly version: string;
  /**
   * Columns of the pixel wordmark (and its rule) currently lit — the launch
   * animation sweeps this from 0 to full so the mark ignites left to right.
   * Omitted means fully lit.
   */
  readonly reveal?: number;
}

/** Width at which the pixel-wordmark hero fits (wordmark + margins). */
const HERO_MIN_WIDTH = 52;
/** Width at which any bordered card fits. */
const CARD_MIN_WIDTH = 30;

/** The brand promise: every agent turn, guided. */
const TAGLINE = "every turn counts";

/**
 * Render the welcome banner.
 *
 * @param info - Session facts to show.
 * @returns Styled lines ready for scrollback, ending in one blank spacer line.
 */
export function bannerLines(info: BannerInfo): string[] {
  if (info.width < CARD_MIN_WIDTH) return minimalBanner(info);
  if (info.glyphs.unicode && info.width >= HERO_MIN_WIDTH) return heroBanner(info);
  return cardBanner(info);
}

function tipsLine(glyphs: GlyphSet): string {
  const exitKey = glyphs.unicode ? `${glyphs.ctrl}D` : "Ctrl+D";
  const d = glyphs.dot;
  return `/help commands ${d} ${glyphs.enter} send ${d} esc interrupt ${d} ${exitKey} exit`;
}

function minimalBanner(info: BannerInfo): string[] {
  const clip = (line: string): string => truncateToWidth(line, info.width);
  const g = info.glyphs;
  return [
    clip(
      `${style("accent")(bold(g.brand))} ${style("title")("arcturn")} ${style("muted")(`v${info.version}`)}`,
    ),
    clip(style("muted")(`${info.model} ${g.dot} ${info.mode}`)),
    clip(style("muted")(info.cwd)),
    "",
  ];
}

/** Frame body rows in a full-width rounded card with two columns of padding. */
function frame(rows: readonly string[], width: number, glyphs: GlyphSet): string[] {
  const chars = glyphs.unicode ? BORDERS.round : BORDERS.ascii;
  const contentWidth = width - 6;
  const runWidth = width - 2;
  const borderFn = style("accent");
  const top = borderFn(chars.topLeft + chars.horizontal.repeat(runWidth) + chars.topRight);
  const bottom = borderFn(chars.bottomLeft + chars.horizontal.repeat(runWidth) + chars.bottomRight);
  // Rows are clipped before padding so an over-long row can never push the
  // right border out of the frame, whatever width the terminal was resized to.
  const body = rows.map(
    (row) =>
      `${borderFn(chars.vertical)}  ${padToWidth(truncateToWidth(row, contentWidth), contentWidth)}  ${borderFn(chars.vertical)}`,
  );
  return [top, ...body, bottom, ""];
}

/** Lay out a left segment and a right segment across a fixed content width. */
function columns(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - stringWidth(left) - stringWidth(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function cardBanner(info: BannerInfo): string[] {
  const g = info.glyphs;
  const contentWidth = info.width - 6;
  const brand = `${style("accent")(bold(g.brand))}  ${style("title")("arcturn")}`;
  const rows = [
    columns(brand, style("muted")(`v${info.version}`), contentWidth),
    "",
    `${style("title")(info.model)} ${style("muted")(`${g.dot} ${info.mode} mode`)}`,
    style("muted")(oneLine(info.cwd, contentWidth)),
    "",
    style("muted")(oneLine(tipsLine(g), contentWidth)),
  ];
  return frame(rows, info.width, g);
}

function heroBanner(info: BannerInfo): string[] {
  const g = info.glyphs;
  // Big type is what terminals do best: the pixel wordmark IS the hero,
  // washed ember-to-starlight, over an aligned fact column and a one-line
  // keymap. No frame, no paragraph of tips — modern, quiet, scannable.
  const indent = "  ";
  const innerWidth = Math.max(20, info.width - indent.length * 2);
  const ruleWidth = Math.min(WORDMARK_WIDTH, innerWidth);
  const clip = (line: string): string => indent + truncateToWidth(line, innerWidth);

  const label = (text: string): string => style("muted")(padToWidth(text, 7));
  const key = (glyph: string, action: string): string =>
    `${style("accent")(glyph)} ${style("muted")(action)}`;
  const dot = style("muted")(` ${g.dot} `);

  const reveal = Math.max(0, Math.min(info.reveal ?? Number.POSITIVE_INFINITY, innerWidth));
  const ignite = (line: string): string => indent + truncateToWidth(line, reveal);

  const rows: string[] = [""];
  for (const line of renderWordmark()) rows.push(ignite(line));
  rows.push("");
  rows.push(
    clip(`${style("info")(style("italic")(TAGLINE))}  ${style("muted")(`v${info.version}`)}`),
  );
  rows.push(ignite(brandRule(ruleWidth)));
  rows.push("");
  rows.push(clip(`${label("model")}${style("title")(info.model)}`));
  rows.push(clip(`${label("mode")}${style("text")(info.mode)}`));
  rows.push(clip(`${label("dir")}${style("muted")(oneLine(info.cwd, innerWidth - 7))}`));
  rows.push("");
  // The keymap packs greedily into as many lines as the width demands —
  // segments are never truncated away, they wrap.
  const segments = [
    key(g.enter, "send"),
    key("/", "commands"),
    key("@", "files"),
    key("esc", "interrupt"),
    key(`${g.ctrl}D`, "exit"),
  ];
  let current = "";
  for (const segment of segments) {
    const candidate = current === "" ? segment : `${current}${dot}${segment}`;
    if (current !== "" && stringWidth(candidate) > innerWidth) {
      rows.push(clip(current));
      current = segment;
    } else {
      current = candidate;
    }
  }
  if (current !== "") rows.push(clip(current));
  rows.push(clip(style("muted")("type while arcturn works to steer the run")));
  rows.push("");
  return rows;
}
