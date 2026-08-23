/**
 * Theming: a token → {@link Style} map that every component reads from.
 *
 * Components never hard-code colours; they look up semantic tokens such as
 * `accent` or `border` so a single {@link setTheme} call restyles the whole UI.
 *
 * @packageDocumentation
 */

import {
  bg,
  bold,
  combine,
  dim,
  fg,
  italic,
  type Style,
  strikethrough,
  underline,
} from "./ansi.js";

/** Semantic style slots available to components. */
export type ThemeToken =
  /**
   * The screen-mode canvas colour painted behind everything; inline mode never
   * paints it.
   *
   * In screen mode the TUI owns the whole viewport, so the theme — not the
   * user's terminal profile — decides the ground every other token is read
   * against. That is what makes a light theme usable on a dark terminal. In
   * inline mode the surrounding scrollback belongs to the shell and must not be
   * tinted, so this token is simply never emitted.
   */
  | "background"
  /** Default body text. */
  | "text"
  /** De-emphasised text (hints, secondary info). */
  | "muted"
  /** Primary highlight colour. */
  | "accent"
  /** Errors and failures. */
  | "error"
  /** Success confirmations. */
  | "success"
  /** Warnings. */
  | "warning"
  /** Informational notices. */
  | "info"
  /** Box borders and rules. */
  | "border"
  /** Box borders when the component has focus. */
  | "borderFocus"
  /** Box / panel titles. */
  | "title"
  /** Markdown heading level 1. */
  | "heading1"
  /** Markdown heading level 2. */
  | "heading2"
  /** Markdown heading level 3 and deeper. */
  | "heading3"
  /** Inline code spans. */
  | "code"
  /** Fenced code block body. */
  | "codeBg"
  /** Fence markers around code blocks. */
  | "codeBorder"
  /** Language keywords inside highlighted code. */
  | "codeKeyword"
  /** String literals inside highlighted code. */
  | "codeString"
  /** Comments inside highlighted code. */
  | "codeComment"
  /** Numeric literals inside highlighted code. */
  | "codeNumber"
  /** Link text. */
  | "link"
  /** Link target shown after the label. */
  | "linkUrl"
  /** Blockquote text. */
  | "quote"
  /** Blockquote gutter. */
  | "quoteBorder"
  /** List bullets and numbers. */
  | "listBullet"
  /** Selected row in a list. */
  | "selection"
  /** Placeholder text in inputs. */
  | "placeholder"
  /** Text cursor block. */
  | "cursor"
  /** Spinner glyph. */
  | "spinner"
  /** Status bar body. */
  | "statusBar"
  /** Emphasised status bar segment. */
  | "statusBarAccent"
  /** Horizontal rules. */
  | "hr"
  /** Table borders. */
  | "tableBorder"
  /** Table header cells. */
  | "tableHeader"
  /** Strong emphasis. */
  | "bold"
  /** Emphasis. */
  | "italic"
  /** Struck-through text. */
  | "strikethrough"
  /** Underlined text. */
  | "underline"
  /** Added lines in a diff (foreground + subtle background tint). */
  | "diffAdded"
  /** Removed lines in a diff (foreground + subtle background tint). */
  | "diffRemoved";

/** A complete set of styles keyed by {@link ThemeToken}. */
export type ThemeStyles = Readonly<Record<ThemeToken, Style>>;

/** A named theme. */
export interface Theme {
  /** Human-readable identifier, e.g. `"arcturn-dark"`. */
  readonly name: string;
  /** Style for every token. */
  readonly styles: ThemeStyles;
}

/**
 * The built-in dark theme.
 *
 * The Arcturus system: the star's own gold (`#f2af48`) as the accent, starlight
 * (`#fad185`) for live/informational glow, ember (`#b87436`) in the shadows, all
 * on warm greys — no blue cast anywhere.
 *
 * Line weights form a deliberate three-step hierarchy against a `#1a1a1a`
 * ground: rules recede (`hr`/`tableBorder`), box borders sit above them, and
 * code fences lead. Diff tints are warm shadows of the success/error hues.
 */
export const darkTheme: Theme = {
  name: "arcturn-dark",
  styles: {
    // The brand's warm ink ground (`--color-ink-950`): darker and warmer than
    // the `#1a1a1a` a bare terminal offers, so the golds sit on their own paper.
    background: bg("#0c0a07"),
    // Explicit, never the terminal's default: screen mode paints its own
    // canvas, so body text must be legible against OUR ground rather than
    // whatever the user's terminal happens to use.
    text: fg("#f0ece5"),
    muted: fg("#96918a"),
    accent: fg("#f2af48"),
    error: fg("#f0705a"),
    success: fg("#9ece6a"),
    warning: fg("#ff9e64"),
    info: fg("#fad185"),
    // Lifted from #47413a so box borders read clearly above the rules below
    // them while staying under `codeBorder`.
    border: fg("#514a41"),
    borderFocus: fg("#f2af48"),
    title: combine(bold, fg("#f0ece5")),
    heading1: combine(bold, underline, fg("#f2af48")),
    heading2: combine(bold, fg("#fad185")),
    heading3: combine(bold, fg("#d99a52")),
    code: fg("#e8b465"),
    codeBg: fg("#e8e3da"),
    codeBorder: fg("#6d675f"),
    // Was #bb9af7, a violet with a distinct blue cast that fought the brand.
    // Warm orchid keeps keywords separable from strings/numbers without it.
    codeKeyword: fg("#e0a3d1"),
    codeString: fg("#9ece6a"),
    codeComment: combine(dim, fg("#6d675f")),
    codeNumber: fg("#ff9e64"),
    link: fg("#f2af48"),
    linkUrl: combine(dim, fg("#6d675f")),
    quote: combine(italic, fg("#b5ada0")),
    // Ember rather than a second copy of `border`: the quote gutter is a brand
    // mark, and duplicating `border` flattened the line hierarchy.
    quoteBorder: fg("#6b4a24"),
    listBullet: fg("#f2af48"),
    selection: combine(bold, fg("#f2af48")),
    placeholder: combine(dim, fg("#6d675f")),
    cursor: fg("#f0ece5"),
    spinner: fg("#fad185"),
    statusBar: fg("#96918a"),
    statusBarAccent: combine(bold, fg("#f2af48")),
    // Raised from #3a342c (1.42:1), which was effectively invisible on a true
    // black terminal; still the faintest line in the system.
    hr: fg("#403a31"),
    tableBorder: fg("#403a31"),
    tableHeader: combine(bold, fg("#f0ece5")),
    bold,
    italic,
    strikethrough,
    underline,
    diffAdded: combine(fg("#9ece6a"), bg("#1d2a1f")),
    // Background warmed from #2d2029 (a magenta/blue-leaning tint) to a warm
    // ember shadow, matching the no-blue identity.
    diffRemoved: combine(fg("#f0705a"), bg("#2b1f1c")),
  },
};

/**
 * The built-in light theme.
 *
 * A full parchment-warm counterpart to {@link darkTheme}, not a derivative of
 * it: every colour-bearing token is stated explicitly. Deep amber replaces the
 * star's pale gold (`#f2af48` measures ~1.9:1 on white and is unreadable),
 * neutrals are warm parchment greys rather than cool ones, and every text token
 * clears 4.5:1 against both pure white and the warm `#faf6ef` paper tone the
 * palette is tuned around.
 *
 * Only attribute-only tokens (`bold`, `italic`, `strikethrough`, `underline`,
 * and the identity `text`) are shared with the dark theme; nothing that carries
 * a colour is inherited.
 */
export const lightTheme: Theme = {
  name: "arcturn-light",
  styles: {
    // Parchment: the warm ground the whole light palette is tuned against.
    background: bg("#faf6ef"),
    // Explicit for the same reason as the dark theme: inheriting the
    // terminal's default foreground would leave a light-terminal-coloured
    // body text on our parchment canvas.
    text: fg("#241d15"),
    //
    // The SAME system as the dark theme, walked to the other end of the ramp.
    // Dark spends its brand on three rungs — starlight #fad185, gold #f2af48,
    // a softer gold #e8b465 — and reuses each across every token that plays
    // that role. Light mirrors it exactly, because a palette that invents a
    // slightly different brown per token reads as sludge, not as a brand:
    //
    //   deep   #7a4300  the starlight role: heading2, info, spinner
    //   brand  #9a5600  the gold role: accent, links, bullets, selection…
    //   soft   #996322  the softer-gold role: heading3
    //   code   #9c5f16  inline code, a hair off brand like dark's #e8b465
    //   ember  #a34a08  the #ff9e64 role: warning and code numbers
    //
    // Every value sits at hue 26-34°, the Arcturus gold's own hue family.
    muted: fg("#6b6154"),
    accent: fg("#9a5600"),
    error: fg("#b3261e"),
    success: fg("#1f6a34"),
    warning: fg("#a34a08"),
    info: fg("#7a4300"),
    border: fg("#cdbfa8"),
    borderFocus: fg("#9a5600"),
    title: combine(bold, fg("#241d15")),
    heading1: combine(bold, underline, fg("#9a5600")),
    heading2: combine(bold, fg("#7a4300")),
    heading3: combine(bold, fg("#996322")),
    code: fg("#9c5f16"),
    codeBg: fg("#3a2f22"),
    codeBorder: fg("#8a8072"),
    codeKeyword: fg("#8e3b73"),
    codeString: fg("#1f6a34"),
    // Unlike the dark theme these carry no `dim`: on parchment dim burns most
    // of the remaining contrast, and comments still have to be readable.
    codeComment: fg("#8a8072"),
    codeNumber: fg("#a34a08"),
    link: fg("#9a5600"),
    linkUrl: fg("#8a8072"),
    quote: combine(italic, fg("#5f574a")),
    quoteBorder: fg("#b08b52"),
    listBullet: fg("#9a5600"),
    selection: combine(bold, fg("#9a5600")),
    placeholder: fg("#8a8072"),
    cursor: fg("#241d15"),
    spinner: fg("#7a4300"),
    statusBar: fg("#6b6154"),
    statusBarAccent: combine(bold, fg("#9a5600")),
    hr: fg("#ddd0ba"),
    tableBorder: fg("#cdbfa8"),
    tableHeader: combine(bold, fg("#241d15")),
    bold,
    italic,
    strikethrough,
    underline,
    diffAdded: combine(fg("#14562a"), bg("#e2f2dd")),
    diffRemoved: combine(fg("#a3231a"), bg("#fbe4de")),
  },
};

let activeTheme: Theme = darkTheme;
let version = 0;
const listeners = new Set<(theme: Theme) => void>();

/** Dispatches to a snapshot of the subscriber set, swallowing listener errors. */
function notify(theme: Theme): void {
  for (const listener of [...listeners]) {
    try {
      listener(theme);
    } catch {
      // A misbehaving subscriber must not break its peers or the caller; there
      // is no safe channel to report on while the alternate screen is active.
    }
  }
}

/**
 * Returns the theme currently in effect.
 */
export function getTheme(): Theme {
  return activeTheme;
}

/**
 * Installs a theme globally. All components pick it up on their next render.
 *
 * @param theme - The theme to activate.
 */
export function setTheme(theme: Theme): void {
  activeTheme = theme;
  version += 1;
  notify(theme);
}

/**
 * Returns a counter that increases by one on every {@link setTheme} call.
 *
 * Consumers that bake styled ANSI into a cache key the cache on this number and
 * discard it when the value moves, so a theme switch cannot leave stale colours
 * on screen. It is monotonic and never reset — comparing for equality with a
 * previously stored value is the only supported use.
 */
export function themeVersion(): number {
  return version;
}

/**
 * Subscribes to theme changes.
 *
 * Listeners run **after** {@link getTheme} already reports the new theme, in
 * registration order, against a snapshot of the subscriber list taken before
 * dispatch begins — so subscribing or unsubscribing from inside a listener
 * affects the *next* change, never the one in flight. A listener that throws is
 * isolated: the remaining listeners still run and the error never propagates out
 * of {@link setTheme}.
 *
 * @param listener - Called with the newly active theme.
 * @returns An idempotent unsubscribe function.
 *
 * @example
 * ```ts
 * const off = onThemeChange(() => cache.clear());
 * off();
 * ```
 */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Looks up a single token in the active theme.
 *
 * @param token - Token to resolve.
 * @returns The style function for that token.
 *
 * @example
 * ```ts
 * const line = style("accent")("Arcturn");
 * ```
 */
export function style(token: ThemeToken): Style {
  return activeTheme.styles[token];
}

/**
 * Derives a new theme from an existing one by overriding some tokens.
 *
 * @param name - Name of the derived theme.
 * @param overrides - Tokens to replace.
 * @param base - Theme to derive from (defaults to the active theme).
 */
export function createTheme(
  name: string,
  overrides: Partial<Record<ThemeToken, Style>>,
  base: Theme = activeTheme,
): Theme {
  return { name, styles: { ...base.styles, ...overrides } };
}
