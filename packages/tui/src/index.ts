/**
 * `@arcturn/tui` — a from-scratch terminal UI library with differential rendering.
 *
 * The package is intentionally standalone: it depends only on `marked` and
 * `get-east-asian-width`, and every terminal interaction goes through the
 * {@link Terminal} interface so the whole library can be driven headlessly.
 *
 * @example
 * ```ts
 * import { Editor, ProcessTerminal, Text, TUI } from "@arcturn/tui";
 *
 * const tui = new TUI(new ProcessTerminal());
 * const editor = new Editor({ onSubmit: (text) => console.log(text) });
 * tui.add(new Text("Ask me anything", { style: "accent" }));
 * tui.add(editor);
 * tui.focus(editor);
 * tui.start();
 * ```
 *
 * ### Terminal compatibility
 *
 * Escape sequences are hardcoded xterm/ECMA-48 (SGR, CSI cursor/erase, `?1049`
 * alt screen, `?2004` bracketed paste, OSC 8 hyperlinks) — there is no terminfo
 * lookup, so a terminal that doesn't understand a given sequence will show it
 * as garbage rather than falling back gracefully. The library is POSIX-first:
 * {@link ProcessTerminal} degrades cleanly when `stdout`/`stdin` aren't TTYs
 * (no raw mode, no alt screen, no cursor control), and cleanup on exit or a
 * signal restores the terminal so a crash never leaves it in raw mode or the
 * alt screen with a hidden cursor. Windows/ConPTY is untested.
 *
 * @packageDocumentation
 */

/* ANSI + styling ----------------------------------------------------------- */
export {
  ANSI_PATTERN,
  BEL,
  bg,
  bold,
  type Color,
  type ColorDetectionInput,
  ColorLevel,
  CSI,
  combine,
  cursorBack,
  cursorDown,
  cursorForward,
  cursorTo,
  cursorToColumn,
  cursorUp,
  DISABLE_BRACKETED_PASTE,
  detectColorLevel,
  dim,
  ENABLE_BRACKETED_PASTE,
  ERASE_DOWN,
  ERASE_LINE,
  ERASE_LINE_END,
  ERASE_SCREEN,
  ESC,
  fg,
  getColorLevel,
  HIDE_CURSOR,
  hasAnsi,
  hidden,
  hyperlink,
  inverse,
  italic,
  makeStyle,
  type NamedColor,
  none,
  PASTE_END,
  PASTE_START,
  reset,
  SHOW_CURSOR,
  type Style,
  setColorLevel,
  strikethrough,
  stripAnsi,
  underline,
} from "./ansi.js";
/* Components --------------------------------------------------------------- */
export * from "./components/index.js";
export {
  detectImageSupport,
  encodeItermImage,
  encodeKittyImage,
  type ImageSupport,
  imagePlaceholderLines,
  renderImage,
} from "./images.js";
/* Key decoding ------------------------------------------------------------- */
export {
  createKey,
  isPrintable,
  type Key,
  KeyDecoder,
  keyToString,
  matchesKey,
  type SpecialKeyName,
} from "./keys.js";
/* OSC ---------------------------------------------------------------------- */
export {
  backgroundHexOf,
  type OscIo,
  parseOsc11Reply,
  type QueryBackgroundOptions,
  queryTerminalBackground,
  setBackgroundSequence,
} from "./osc.js";
/* Terminal ----------------------------------------------------------------- */
export {
  detectScrollRegionSupport,
  ProcessTerminal,
  type ProcessTerminalOptions,
  type ScrollRegionDetectionEnv,
  type Terminal,
  type TerminalSize,
  TestTerminal,
  type TestTerminalOptions,
  type Unsubscribe,
} from "./terminal.js";
/* Theming ------------------------------------------------------------------ */
export {
  createTheme,
  darkTheme,
  getTheme,
  lightTheme,
  onThemeChange,
  setTheme,
  style,
  type Theme,
  type ThemeStyles,
  type ThemeToken,
  themeVersion,
} from "./theme.js";

/* Renderer ----------------------------------------------------------------- */
export {
  type Component,
  type CursorPosition,
  type KeyHandler,
  type OverflowMode,
  type OverlayAlign,
  type OverlayJustify,
  type OverlayOptions,
  overlayLine,
  TUI,
  type TUIOptions,
} from "./tui.js";
/* Width, wrapping, truncation ---------------------------------------------- */
export {
  type Align,
  charWidth,
  clusterWidth,
  expandTabs,
  padToWidth,
  sliceByWidth,
  stringWidth,
  TAB_WIDTH,
  tokenize,
  truncateToWidth,
  type WidthToken,
  type WrapOptions,
  wrapText,
} from "./width.js";
