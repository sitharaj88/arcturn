/**
 * Minimal ANSI escape-sequence helpers: SGR styling, colour-support detection and
 * cursor/erase control codes.
 *
 * The module has no runtime dependencies and never touches the terminal directly —
 * everything returns plain strings so that it can be unit-tested headlessly.
 *
 * @packageDocumentation
 */

/** The ASCII escape character that introduces every ANSI sequence. */
export const ESC = "\u001b";

/** The BEL character, used as an OSC string terminator. */
export const BEL = "\u0007";

/** Control Sequence Introducer (`ESC [`). */
export const CSI = `${ESC}[`;

/**
 * Matches ANSI escape sequences (CSI/SGR, OSC hyperlinks, SS2/SS3 and friends).
 *
 * Adapted from the well-known `ansi-regex` pattern; hand-rolled here so the package
 * stays dependency-free for string handling.
 */
const ANSI_SOURCE =
  // The private-parameter bytes <, = and > are part of the CSI prefix (kitty
  // keyboard pushes, SGR mouse reports), not final bytes — without them here
  // a sequence like `CSI > 1 u` would be stripped in half.
  "[\\u001b\\u009b][[\\]()#;?<>=]*" +
  "(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*" +
  "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)" +
  "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))";

export const ANSI_PATTERN = new RegExp(ANSI_SOURCE);

/** Creates a fresh global-flagged ANSI regex (avoids shared `lastIndex` state). */
function ansiRegex(): RegExp {
  return new RegExp(ANSI_SOURCE, "g");
}

/**
 * Removes every ANSI escape sequence from a string.
 *
 * @param input - Possibly styled text.
 * @returns The plain-text content of `input`.
 */
export function stripAnsi(input: string): string {
  return input.replace(ansiRegex(), "");
}

/**
 * Returns `true` when the string contains at least one ANSI escape sequence.
 *
 * @param input - Text to inspect.
 */
export function hasAnsi(input: string): boolean {
  return ansiRegex().test(input);
}

/**
 * Matches bare control characters that survive {@link stripAnsi} — a lone `ESC`
 * or `BEL` not part of a complete sequence, `DEL`, the rest of the C0 range and
 * the C1 range. `\n`, `\t` and `\r` are excluded: callers (e.g. the editor's
 * `insertText`) already normalise those.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching raw control bytes to strip them
const BARE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Sanitises text arriving from an untrusted external source (bracketed paste,
 * programmatically supplied initial/replacement content) before it enters
 * editable buffer state or is otherwise written to the terminal.
 *
 * Strips every complete ANSI escape sequence (CSI/OSC/etc., via {@link stripAnsi})
 * and then any remaining bare control byte — `ESC`, `BEL`, `DEL`, the rest of the
 * C0 range and the C1 range — so no unprintable byte can reach the terminal.
 * `\n`, `\t` and `\r` are preserved (callers normalise those); unicode text
 * (emoji, CJK, combining marks, …) is left untouched.
 *
 * @param input - Untrusted text (e.g. a bracketed-paste payload).
 * @returns `input` with all escape sequences and bare control characters removed.
 */
export function sanitizeUntrustedText(input: string): string {
  return stripAnsi(input).replace(BARE_CONTROL_PATTERN, "");
}

/** Colour capability of the output stream. */
export enum ColorLevel {
  /** Colour disabled — style functions become identity functions. */
  None = 0,
  /** 16 basic colours. */
  Basic = 1,
  /** 256-colour indexed palette. */
  Ansi256 = 2,
  /** 24-bit truecolour. */
  TrueColor = 3,
}

/** Environment inputs used by {@link detectColorLevel}. */
export interface ColorDetectionInput {
  /** Environment variables (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Whether the destination stream is a TTY (defaults to `process.stdout.isTTY`). */
  isTTY?: boolean;
}

/**
 * Detects the colour level that should be used for a stream.
 *
 * Honours `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, `COLORTERM=truecolor|24bit`,
 * `TERM=*-256color` and CI environments.
 *
 * @param input - Optional environment overrides, useful for tests.
 * @returns The detected {@link ColorLevel}.
 */
export function detectColorLevel(input: ColorDetectionInput = {}): ColorLevel {
  const env = input.env ?? (typeof process !== "undefined" ? process.env : {});
  const isTTY =
    input.isTTY ?? (typeof process !== "undefined" ? Boolean(process.stdout?.isTTY) : false);

  // https://no-color.org — any non-empty value disables colour.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return ColorLevel.None;

  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return ColorLevel.None;
    if (force === "1" || force === "true" || force === "") return ColorLevel.Basic;
    if (force === "2") return ColorLevel.Ansi256;
    if (force === "3") return ColorLevel.TrueColor;
  }

  const term = env.TERM ?? "";
  if (term === "dumb") return ColorLevel.None;
  if (!isTTY) return ColorLevel.None;

  const colorTerm = (env.COLORTERM ?? "").toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return ColorLevel.TrueColor;
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "vscode") {
    return ColorLevel.TrueColor;
  }
  // Windows Terminal sets none of TERM, COLORTERM or TERM_PROGRAM, so without
  // this it falls through to the `term !== "" ? Basic : None` default below
  // and lands on None. It sets WT_SESSION (a session GUID) instead, and it —
  // along with the modern conhost.exe it hosts, which has understood VT
  // sequences since the Windows 10 1703 update — has supported 24-bit colour
  // for that whole time.
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") return ColorLevel.TrueColor;
  if (/-256(color)?$/i.test(term)) return ColorLevel.Ansi256;
  if (term !== "") return ColorLevel.Basic;
  return ColorLevel.None;
}

let currentLevel: ColorLevel = detectColorLevel();

/**
 * Returns the colour level currently used by the style helpers.
 */
export function getColorLevel(): ColorLevel {
  return currentLevel;
}

/**
 * Overrides the colour level globally. Primarily used by tests and by CLI flags
 * such as `--no-color`.
 *
 * @param level - The level to use from now on.
 */
export function setColorLevel(level: ColorLevel): void {
  currentLevel = level;
}

/**
 * A composable text-styling function.
 *
 * Calling the style wraps `text` in its escape codes; `open`/`close` expose the raw
 * codes so styles can be combined or emitted manually.
 */
export interface Style {
  (text: string): string;
  /** Escape sequence that enables the style. */
  readonly open: string;
  /** Escape sequence that disables the style. */
  readonly close: string;
  /** Minimum {@link ColorLevel} required for this style to be emitted. */
  readonly level: ColorLevel;
}

/** Replaces nested `close` codes so that nesting styles does not truncate the outer one. */
function reopen(text: string, open: string, close: string): string {
  if (close === "" || !text.includes(close)) return text;
  return text.split(close).join(close + open);
}

/**
 * Builds a {@link Style} from raw open/close escape sequences.
 *
 * @param open - Escape sequence enabling the style.
 * @param close - Escape sequence disabling the style.
 * @param level - Minimum colour level required (defaults to {@link ColorLevel.Basic}).
 */
export function makeStyle(open: string, close: string, level = ColorLevel.Basic): Style {
  const fn = (text: string): string => {
    if (currentLevel < level) return text;
    return open + reopen(text, open, close) + close;
  };
  return Object.assign(fn, { open, close, level }) as Style;
}

/**
 * Combines several styles into one. Styles are applied left-to-right, so the first
 * argument becomes the outermost wrapper.
 *
 * @param styles - Styles to merge.
 */
export function combine(...styles: Style[]): Style {
  const open = styles.map((s) => s.open).join("");
  const close = styles
    .map((s) => s.close)
    .reverse()
    .join("");
  const level = styles.reduce<ColorLevel>(
    (max, s) => (s.level > max ? s.level : max),
    ColorLevel.Basic,
  );
  const fn = (text: string): string => {
    let out = text;
    for (let i = styles.length - 1; i >= 0; i--) out = styles[i]!(out);
    return out;
  };
  return Object.assign(fn, { open, close, level }) as Style;
}

/** Identity style — never emits escape codes. */
export const none: Style = makeStyle("", "", ColorLevel.None);

/** Resets all SGR attributes. */
export const reset: Style = makeStyle(`${CSI}0m`, `${CSI}0m`);
/** Bold / increased intensity. */
export const bold: Style = makeStyle(`${CSI}1m`, `${CSI}22m`);
/** Dim / faint. */
export const dim: Style = makeStyle(`${CSI}2m`, `${CSI}22m`);
/** Italic. */
export const italic: Style = makeStyle(`${CSI}3m`, `${CSI}23m`);
/** Underline. */
export const underline: Style = makeStyle(`${CSI}4m`, `${CSI}24m`);
/** Reverse video (swaps foreground and background). */
export const inverse: Style = makeStyle(`${CSI}7m`, `${CSI}27m`);
/** Hidden / concealed text. */
export const hidden: Style = makeStyle(`${CSI}8m`, `${CSI}28m`);
/** Strikethrough. */
export const strikethrough: Style = makeStyle(`${CSI}9m`, `${CSI}29m`);

/** Named 16-colour palette entries accepted by {@link fg} and {@link bg}. */
export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

const NAMED_OFFSETS: Record<NamedColor, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 60,
  brightRed: 61,
  brightGreen: 62,
  brightYellow: 63,
  brightBlue: 64,
  brightMagenta: 65,
  brightCyan: 66,
  brightWhite: 67,
};

/**
 * A colour specification.
 *
 * - `NamedColor` — one of the 16 standard terminal colours.
 * - `number` — a 256-colour palette index (0-255).
 * - `[r, g, b]` — truecolour components (0-255 each).
 * - `"#rrggbb"` / `"#rgb"` — hex truecolour.
 */
export type Color = NamedColor | number | readonly [number, number, number] | `#${string}`;

/** Parses `#rgb` / `#rrggbb` into RGB components. */
function parseHex(hex: string): [number, number, number] {
  const raw = hex.slice(1);
  const full =
    raw.length === 3
      ? `${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
      : raw.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Converts RGB to the nearest 256-colour palette index. */
function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return (
    16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
  );
}

/** Converts a 256-colour index to the nearest basic 16-colour SGR offset. */
function ansi256ToBasicOffset(index: number): number {
  if (index < 8) return index;
  if (index < 16) return 60 + (index - 8);
  if (index >= 232) return index < 244 ? 0 : 67; // grayscale ramp → black / bright white
  const n = index - 16;
  const r = Math.floor(n / 36);
  const g = Math.floor((n % 36) / 6);
  const b = n % 6;
  const bits = (r >= 3 ? 1 : 0) | ((g >= 3 ? 1 : 0) << 1) | ((b >= 3 ? 1 : 0) << 2);
  return bits;
}

function colorStyle(color: Color, background: boolean): Style {
  const base = background ? 40 : 30;
  const closeCode = background ? 49 : 39;
  const close = `${CSI}${closeCode}m`;

  if (typeof color === "string" && color.startsWith("#")) {
    const [r, g, b] = parseHex(color);
    return rgbStyle(r, g, b, background);
  }
  if (typeof color === "string") {
    const offset = NAMED_OFFSETS[color as NamedColor] ?? 7;
    return makeStyle(`${CSI}${base + offset}m`, close, ColorLevel.Basic);
  }
  if (typeof color === "number") {
    const index = Math.max(0, Math.min(255, Math.round(color)));
    const open256 = `${CSI}${background ? 48 : 38};5;${index}m`;
    const openBasic = `${CSI}${base + ansi256ToBasicOffset(index)}m`;
    return degradingStyle(open256, openBasic, close, ColorLevel.Ansi256);
  }
  const [r, g, b] = color;
  return rgbStyle(r, g, b, background);
}

function rgbStyle(r: number, g: number, b: number, background: boolean): Style {
  const base = background ? 40 : 30;
  const close = `${CSI}${background ? 49 : 39}m`;
  const openTrue = `${CSI}${background ? 48 : 38};2;${clamp8(r)};${clamp8(g)};${clamp8(b)}m`;
  const index = rgbToAnsi256(clamp8(r), clamp8(g), clamp8(b));
  const open256 = `${CSI}${background ? 48 : 38};5;${index}m`;
  const openBasic = `${CSI}${base + ansi256ToBasicOffset(index)}m`;

  const fn = (text: string): string => {
    if (currentLevel === ColorLevel.None) return text;
    const open =
      currentLevel === ColorLevel.TrueColor
        ? openTrue
        : currentLevel === ColorLevel.Ansi256
          ? open256
          : openBasic;
    return open + reopen(text, open, close) + close;
  };
  return Object.assign(fn, {
    open: openTrue,
    close,
    level: ColorLevel.Basic,
  }) as Style;
}

/** Builds a style that downgrades from a rich sequence to a basic one. */
function degradingStyle(rich: string, basic: string, close: string, richLevel: ColorLevel): Style {
  const fn = (text: string): string => {
    if (currentLevel === ColorLevel.None) return text;
    const open = currentLevel >= richLevel ? rich : basic;
    return open + reopen(text, open, close) + close;
  };
  return Object.assign(fn, { open: rich, close, level: ColorLevel.Basic }) as Style;
}

function clamp8(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Creates a foreground-colour style.
 *
 * @param color - Named colour, 256-palette index, RGB triple or hex string.
 *
 * @example
 * ```ts
 * fg("#ff8800")("warning");
 * fg(212)("pink");
 * ```
 */
export function fg(color: Color): Style {
  return colorStyle(color, false);
}

/**
 * Creates a background-colour style.
 *
 * @param color - Named colour, 256-palette index, RGB triple or hex string.
 */
export function bg(color: Color): Style {
  return colorStyle(color, true);
}

/* -------------------------------------------------------------------------- */
/* Cursor and erase control codes                                              */
/* -------------------------------------------------------------------------- */

/** Moves the cursor to an absolute position. Rows/columns are **0-based**. */
export function cursorTo(row: number, col: number): string {
  return `${CSI}${Math.max(0, row) + 1};${Math.max(0, col) + 1}H`;
}

/** Moves the cursor `n` rows up (no-op when `n <= 0`). */
export function cursorUp(n = 1): string {
  return n > 0 ? `${CSI}${n}A` : "";
}

/** Moves the cursor `n` rows down (no-op when `n <= 0`). */
export function cursorDown(n = 1): string {
  return n > 0 ? `${CSI}${n}B` : "";
}

/** Moves the cursor `n` columns right (no-op when `n <= 0`). */
export function cursorForward(n = 1): string {
  return n > 0 ? `${CSI}${n}C` : "";
}

/** Moves the cursor `n` columns left (no-op when `n <= 0`). */
export function cursorBack(n = 1): string {
  return n > 0 ? `${CSI}${n}D` : "";
}

/** Moves the cursor to an absolute **0-based** column on the current row. */
export function cursorToColumn(col: number): string {
  return `${CSI}${Math.max(0, col) + 1}G`;
}

/**
 * Sets the vertical scrolling region (DECSTBM) to the **0-based**, inclusive
 * row range — the rows {@link scrollUp} and {@link scrollDown} move. Homes the
 * cursor, as the standard requires, so absolute addressing must follow.
 */
export function scrollRegion(top: number, bottom: number): string {
  return `${CSI}${Math.max(0, top) + 1};${Math.max(0, bottom) + 1}r`;
}

/** Restores the scrolling region to the whole screen. Homes the cursor. */
export const RESET_SCROLL_REGION = `${CSI}r`;

/**
 * Scrolls the scrolling region up by `n` rows (SU): the content moves toward
 * the top, and `n` blank rows appear at the bottom of the region.
 */
export function scrollUp(n = 1): string {
  return n > 0 ? `${CSI}${n}S` : "";
}

/**
 * Scrolls the scrolling region down by `n` rows (SD): the content moves toward
 * the bottom, and `n` blank rows appear at the top of the region.
 */
export function scrollDown(n = 1): string {
  return n > 0 ? `${CSI}${n}T` : "";
}

/** Erases the entire current line, leaving the cursor where it is. */
export const ERASE_LINE = `${CSI}2K`;
/** Erases from the cursor to the end of the current line. */
export const ERASE_LINE_END = `${CSI}0K`;
/** Erases from the cursor to the end of the screen. */
export const ERASE_DOWN = `${CSI}0J`;
/** Erases the whole screen. */
export const ERASE_SCREEN = `${CSI}2J`;
/** Hides the terminal cursor. */
export const HIDE_CURSOR = `${CSI}?25l`;
/** Shows the terminal cursor. */
export const SHOW_CURSOR = `${CSI}?25h`;
/** Enables bracketed-paste mode. */
export const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
/** Disables bracketed-paste mode. */
export const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;
/** Sequence emitted by the terminal before pasted content. */
export const PASTE_START = `${CSI}200~`;
/** Sequence emitted by the terminal after pasted content. */
export const PASTE_END = `${CSI}201~`;

/**
 * Wraps text in an OSC-8 hyperlink. Terminals without support render the label only.
 *
 * @param label - Visible text.
 * @param url - Target URL.
 */
export function hyperlink(label: string, url: string): string {
  if (currentLevel === ColorLevel.None) return label;
  const start = `${ESC}]8;;`;
  return `${start}${url}${BEL}${label}${start}${BEL}`;
}
