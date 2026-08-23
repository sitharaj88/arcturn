/**
 * The icon set used across the interactive UI, with an ASCII fallback for
 * terminals that cannot render the fancy Unicode glyphs.
 *
 * Every decorative glyph in the CLI flows through this one module so a single
 * capability check decides, for the whole app, whether to draw the fancy set or
 * the ASCII set. The check sniffs the locale/`TERM` environment and defaults to
 * the fancy set on anything that looks like a modern UTF-8 terminal.
 *
 * @packageDocumentation
 */

/** Environment variables consulted by {@link supportsUnicode}. */
export interface UnicodeDetectionEnv {
  /** `TERM`, e.g. `xterm-256color`. */
  TERM?: string | undefined;
  /** `LANG`, e.g. `en_US.UTF-8`. */
  LANG?: string | undefined;
  /** `LC_ALL`, which overrides every other locale category. */
  LC_ALL?: string | undefined;
  /** `LC_CTYPE`, the character-classification locale. */
  LC_CTYPE?: string | undefined;
  /** `TERM_PROGRAM`, set by iTerm, Apple Terminal, VS Code, … */
  TERM_PROGRAM?: string | undefined;
  /** Opt-out escape hatch: any non-empty value forces the ASCII set. */
  ARCTURN_ASCII?: string | undefined;
  /** Allow other keys without widening the type surface. */
  [key: string]: string | undefined;
}

/**
 * Decide whether the terminal can render the fancy Unicode glyph set.
 *
 * The heuristic is deliberately optimistic — modern terminals are UTF-8 — and
 * only falls back to ASCII when the environment positively indicates otherwise:
 * `ARCTURN_ASCII` is set, `TERM` is `dumb`, or a locale is present that does not
 * mention UTF-8.
 *
 * @param env - Environment to inspect (defaults to `process.env`).
 * @returns `true` when the fancy set should be used.
 */
export function supportsUnicode(env: UnicodeDetectionEnv = process.env): boolean {
  if (env.ARCTURN_ASCII !== undefined && env.ARCTURN_ASCII !== "") return false;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return false;
  if (env.TERM_PROGRAM !== undefined && env.TERM_PROGRAM !== "") return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale !== "" && !/utf-?8/i.test(locale)) return false;
  return true;
}

/** A complete set of decorative glyphs keyed by role. */
export interface GlyphSet {
  /** `true` for the fancy set, `false` for the ASCII set. */
  readonly unicode: boolean;
  /** The arcturn brand mark shown in the welcome banner. */
  readonly brand: string;
  /** Status dot leading a tool or agent turn. */
  readonly statusDot: string;
  /** Accent gutter marking a human turn. */
  readonly userGutter: string;
  /** Caret drawn before the editor's first line. */
  readonly promptCaret: string;
  /** Tree connector introducing a tool's result. */
  readonly treeResult: string;
  /** Connector introducing nested (sub-agent) activity. */
  readonly nested: string;
  /** Header mark for the permission dialog. */
  readonly permission: string;
  /** Header mark for the plan dialog, and the `plan` tool. */
  readonly plan: string;
  /** Interrupt / cancellation mark. */
  readonly interrupt: string;
  /** Arrow used in "before → after" phrasing. */
  readonly arrow: string;
  /** Steering hint mark shown while a run is active. */
  readonly steer: string;
  /** The Enter key, for hints. */
  readonly enter: string;
  /** The Control modifier, for hints. */
  readonly ctrl: string;
  /** Informational notice mark. */
  readonly info: string;
  /** Warning notice mark. */
  readonly warn: string;
  /** Error notice mark. */
  readonly error: string;
  /** Success / completion mark. */
  readonly done: string;
  /** Separator dot used between inline facts, e.g. `model · mode`. */
  readonly dot: string;
  /** A pending todo checkbox. */
  readonly todoPending: string;
  /** An in-progress todo checkbox. */
  readonly todoActive: string;
  /** A completed todo checkbox. */
  readonly todoDone: string;
  /** A filled cell of a progress bar. */
  readonly barFilled: string;
  /** An empty cell of a progress bar. */
  readonly barEmpty: string;
  /** Name of the {@link import("@arcturn/tui").Spinner} animation to use. */
  readonly spinner: "dots" | "line";
  /** Per-tool glyphs, keyed by built-in tool name. */
  readonly tools: Readonly<Record<string, string>>;
  /** Glyph used for tools with no specific entry. */
  readonly toolDefault: string;
}

/** The fancy Unicode glyph set, used on capable terminals. */
export const FANCY_GLYPHS: GlyphSet = {
  unicode: true,
  brand: "✦",
  statusDot: "●",
  userGutter: "▌",
  promptCaret: "›",
  treeResult: "⎿",
  nested: "↳",
  permission: "◆",
  plan: "✧",
  interrupt: "⊘",
  arrow: "→",
  steer: "↳",
  enter: "⏎",
  ctrl: "⌃",
  info: "ℹ",
  warn: "⚠",
  error: "✗",
  done: "✓",
  dot: "·",
  todoPending: "☐",
  todoActive: "◐",
  todoDone: "☑",
  barFilled: "▰",
  barEmpty: "▱",
  spinner: "dots",
  tools: {
    read: "◇",
    write: "✎",
    edit: "✎",
    bash: "❯",
    grep: "⌕",
    glob: "⌕",
    ls: "▸",
    fetch: "⤓",
    websearch: "⌖",
    symbols: "◈",
    memory: "❖",
    todo: "☰",
    plan: "✧",
    subagent: "⌘",
  },
  toolDefault: "◇",
};

/** The ASCII fallback glyph set, used when Unicode is unavailable. */
export const ASCII_GLYPHS: GlyphSet = {
  unicode: false,
  brand: "*",
  statusDot: "*",
  userGutter: "|",
  promptCaret: ">",
  treeResult: "\\",
  nested: ">",
  permission: "!",
  plan: "*",
  interrupt: "x",
  arrow: "->",
  steer: ">",
  enter: "enter",
  ctrl: "^",
  info: "i",
  warn: "!",
  error: "x",
  done: "+",
  dot: "-",
  todoPending: "[ ]",
  todoActive: "[~]",
  todoDone: "[x]",
  barFilled: "#",
  barEmpty: "-",
  spinner: "line",
  tools: {
    read: "-",
    write: "*",
    edit: "*",
    bash: "$",
    grep: "/",
    glob: "/",
    ls: ">",
    fetch: "v",
    websearch: "?",
    symbols: "%",
    memory: "M",
    todo: "=",
    plan: "*",
    subagent: "@",
  },
  toolDefault: "-",
};

/**
 * Resolve the glyph set appropriate for the given environment.
 *
 * @param env - Environment to inspect (defaults to `process.env`).
 * @returns {@link FANCY_GLYPHS} or {@link ASCII_GLYPHS}.
 */
export function resolveGlyphs(env: UnicodeDetectionEnv = process.env): GlyphSet {
  return supportsUnicode(env) ? FANCY_GLYPHS : ASCII_GLYPHS;
}

/**
 * Look up the glyph for a tool by name, falling back to a generic mark.
 *
 * @param name - Tool name, e.g. `"bash"`.
 * @param set - The glyph set to read from (defaults to {@link FANCY_GLYPHS}).
 * @returns The tool's glyph.
 */
export function toolGlyph(name: string, set: GlyphSet = FANCY_GLYPHS): string {
  return set.tools[name] ?? set.toolDefault;
}
