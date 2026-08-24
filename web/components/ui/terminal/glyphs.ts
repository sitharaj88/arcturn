/**
 * The terminal's glyph vocabulary, transcribed from the product itself —
 * `packages/cli/src/glyphs.ts` (`FANCY_GLYPHS`), the dialogs in
 * `packages/cli/src/interactive/` and `packages/tui/src/components/`.
 *
 * DESIGN.md §3.9: illustrate real output, never invent it. These are the marks
 * arcturn actually prints, so a mock built out of them cannot drift into a
 * generic "hacker terminal". The ASCII fallback set has no counterpart here —
 * the web can always render Unicode.
 */

/** Structural marks: one per role, exactly as `FANCY_GLYPHS` names them. */
export const TERMINAL_GLYPHS = {
  /** Brand mark leading the session header and the status bar. */
  brand: "✦",
  /** Status dot leading a tool call. */
  statusDot: "●",
  /** Accent gutter marking a human turn. */
  userGutter: "▌",
  /** Caret drawn before the prompt editor's first line. */
  promptCaret: "›",
  /** Tree connector introducing a tool's result. */
  treeResult: "⎿",
  /** Connector introducing nested (sub-agent) activity, and the steer hint. */
  nested: "↳",
  /** Header mark for the permission dialog. */
  permission: "◆",
  /** Marker drawn in front of a `SelectList`'s highlighted row. */
  pointer: "❯",
  /** Informational notice mark. */
  info: "ℹ",
  /** Warning notice mark. */
  warn: "⚠",
  /** Error notice mark. */
  error: "✗",
  /** Success / completion mark. */
  done: "✓",
  /** Separator between inline facts, e.g. `model · mode`. */
  dot: "·",
  /** First frame of the braille spinner the CLI runs while a turn is live. */
  spinner: "⠋",
} as const;

/** Per-tool marks, keyed by built-in tool name (`FANCY_GLYPHS.tools`). */
export const TERMINAL_TOOL_GLYPHS: Readonly<Record<string, string>> = {
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
};

/** Mark used for tools with no specific entry (`FANCY_GLYPHS.toolDefault`). */
export const TERMINAL_TOOL_GLYPH_DEFAULT = "◇";

/**
 * Look up a tool's mark, falling back to the generic one.
 *
 * @param name - Tool name, e.g. `"bash"`.
 */
export function terminalToolGlyph(name: string): string {
  return TERMINAL_TOOL_GLYPHS[name] ?? TERMINAL_TOOL_GLYPH_DEFAULT;
}

/** The prompt editor's placeholder, verbatim from `interactive/app.ts`. */
export const TERMINAL_INPUT_PLACEHOLDER = "Ask arcturn anything, or type / for commands";

/** The dialog footer, verbatim from `createChoice` in `interactive/dialogs.ts`. */
export const TERMINAL_DIALOG_FOOTER = "↑↓ select · enter confirm · esc cancel";

/** The permission dialog's title, verbatim from `permissionDialog`. */
export const TERMINAL_PERMISSION_TITLE = `${TERMINAL_GLYPHS.permission} Permission required`;

/** The activity line's default trailing hint, from `#renderActivity`. */
export const TERMINAL_INTERRUPT_HINT = "esc to interrupt";
