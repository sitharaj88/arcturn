/**
 * The shape of a transcript line.
 *
 * A terminal mock used to be a list of `{ text, tone }` strings, which is
 * precisely why it read as a generic fake: the component knew nothing about
 * what it was drawing, so it could not draw a tool call, a result tree, a
 * bordered dialog or a status bar — only text someone had hand-spaced. Lines
 * are **structured** instead: each one names what it is, and the renderer owns
 * the glyph, the column and the tone.
 *
 * `{ text, tone }` is still a legal line — it is the `"text"` kind with its
 * discriminant omitted — so every script written against the old shape keeps
 * rendering exactly as it did.
 */

/** Semantic colour roles a line can take. */
export type TerminalTone = "default" | "muted" | "accent" | "good" | "warn" | "bad" | "prompt";

/**
 * Tone → utility class. Exported so `<TerminalPlayer>` paints its streamed
 * lines from the same table; a second table would be a second truth.
 */
export const TERMINAL_TONES: Record<TerminalTone, string> = {
  default: "text-text",
  muted: "text-muted",
  accent: "text-accent",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  prompt: "text-faint",
};

/**
 * Fields every line may carry.
 *
 * `text`, `tone` and `cursor` sit on the base rather than on the `"text"` kind
 * alone so the union stays readable as a flat record — `line.tone` is a legal
 * access on any line, which is what lets `<TerminalPlayer>` keep treating a
 * transcript as rows of text while the structured kinds land around it.
 */
interface TerminalLineBase {
  /** Payload of the `"text"` kind; ignored by the structured kinds. */
  text?: string;
  /** Overrides the kind's own tone where the kind honours one. */
  tone?: TerminalTone;
  /** Draw a blinking block cursor at the end of the line. */
  cursor?: boolean;
}

/** Assistant prose, a diff body, or any line the structured kinds don't cover. */
export interface TerminalTextLine extends TerminalLineBase {
  kind?: "text";
  text: string;
}

/** The session header: `✦ arcturn · model · cwd`. */
export interface TerminalChromeLine extends TerminalLineBase {
  kind: "chrome";
  /** Product name after the brand mark. Defaults to `"arcturn"`. */
  app?: string;
  /** Model in effect, e.g. `"claude-sonnet-4-5"`. */
  model?: string;
  /** Working directory the session is bound to, e.g. `"~/projects/api"`. */
  cwd?: string;
}

/** A human turn: the accent gutter bar `▌` and the typed text. */
export interface TerminalUserLine extends TerminalLineBase {
  kind: "user";
  text: string;
}

/** Lifecycle of a tool call, which decides the bullet's tone. */
export type TerminalToolState = "run" | "done" | "error";

/** A tool call: `● ▸ ls  ~/projects/api`. */
export interface TerminalToolLine extends TerminalLineBase {
  kind: "tool";
  /** Built-in tool name; picks the glyph. Unknown names get `◇`. */
  name: string;
  /** The call's subject — a path, a pattern, a command line. */
  args?: string;
  /** Defaults to `"done"`. `"error"` reddens the bullet. */
  state?: TerminalToolState;
  /** `1` draws the row as sub-agent activity: indented, marked `↳`. */
  depth?: number;
}

/** A tool's result, indented under its call: `⎿ 5 entries`. */
export interface TerminalResultLine extends TerminalLineBase {
  kind: "result";
  text: string;
  /** A continuation line — no connector, indented under the result text. */
  cont?: boolean;
  /** Must match the `depth` of the call it belongs to. */
  depth?: number;
}

/** Notice levels, which pick both the glyph and the tone. */
export type TerminalNoticeLevel = "info" | "warn" | "good" | "bad";

/** A runtime notice: `⚠ …`, `✓ …`, `✗ …`, `ℹ …`. */
export interface TerminalNoticeLine extends TerminalLineBase {
  kind: "notice";
  level: TerminalNoticeLevel;
  text: string;
}

/** Which row of the permission dialog is highlighted. */
export type TerminalPermissionChoice = "once" | "always" | "deny";

/**
 * The permission gate, drawn as the bordered sub-box the CLI overlays: title on
 * the border, the tool and its subject, the three answers, the key hints.
 */
export interface TerminalPermissionLine extends TerminalLineBase {
  kind: "permission";
  /** Tool being asked about; picks the glyph on the first row. */
  tool: string;
  /** What the tool wants to do — a path, or the whole command line. */
  subject: string;
  /** The muted line under the subject, e.g. `bash: wc -l …`. */
  description?: string;
  /**
   * Rule offered by the "always" row, e.g. `bash wc *`. Omitted, the row reads
   * `Allow always: <tool> (project)`, exactly as `suggestRule` builds it.
   */
  rule?: string;
  /** Highlighted row. Defaults to `"once"`, the CLI's initial selection. */
  selected?: TerminalPermissionChoice;
  /** A delegating role — a `/workflow` stage — shown above the tool row. */
  origin?: string;
  /** Overrides the `↑↓ select · enter confirm · esc cancel` footer. */
  footer?: string;
}

/** The live activity line: `⠋ thinking · 52s · 465 tokens · esc to interrupt`. */
export interface TerminalThinkingLine extends TerminalLineBase {
  kind: "thinking";
  /** Working verb. Defaults to `"thinking"`. */
  verb?: string;
  /** Elapsed wall time, pre-formatted, e.g. `"52s"`. */
  elapsed: string;
  /** Token count, pre-formatted; ` tokens` is appended. */
  tokens?: string;
  /** Trailing hint. Defaults to `"esc to interrupt"`. */
  hint?: string;
}

/** The completion line: `✓ 1m34s · 1.3k tokens`. */
export interface TerminalDoneLine extends TerminalLineBase {
  kind: "done";
  elapsed: string;
  /** Token count, pre-formatted; ` tokens` is appended. */
  tokens?: string;
  /** An extra trailing fact, e.g. `"$0.0412 of $2.00"`. */
  text?: string;
}

/** The prompt editor's own bordered box, with its mode label on the border. */
export interface TerminalInputLine extends TerminalLineBase {
  kind: "input";
  /** Typed text. When absent the placeholder is drawn instead. */
  value?: string;
  /** Defaults to the CLI's own placeholder. */
  placeholder?: string;
  /** Border label. Defaults to `"default"`, or `"↳ steering"` when running. */
  label?: string;
  /** A run is live: the label becomes the steering hint and takes the accent. */
  running?: boolean;
}

/** The terminal's last line: brand and session facts left, spend right. */
export interface TerminalStatusLine extends TerminalLineBase {
  kind: "status";
  /** Product name after the brand mark. Defaults to `"arcturn"`. */
  app?: string;
  /** Model in effect, e.g. `"GLM-5.3 (coding plan)"`. */
  model?: string;
  /** Permission mode, e.g. `"default"`. */
  mode?: string;
  /** Git branch segment, e.g. `"main*"`. */
  branch?: string;
  /** Spend so far, pre-formatted, e.g. `"$0.00"`. */
  cost?: string;
  /** Context used, as a percentage; rendered as `ctx 2%`. */
  ctx?: string;
}

/** A blank row, keeping its line height. */
export interface TerminalBlankLine extends TerminalLineBase {
  kind: "blank";
}

/** One line of a transcript. */
export type TerminalLine =
  | TerminalTextLine
  | TerminalChromeLine
  | TerminalUserLine
  | TerminalToolLine
  | TerminalResultLine
  | TerminalNoticeLine
  | TerminalPermissionLine
  | TerminalThinkingLine
  | TerminalDoneLine
  | TerminalInputLine
  | TerminalStatusLine
  | TerminalBlankLine;
