/**
 * The `Editor` component: a multi-line text input with cursor movement, an undo
 * stack, submission history, bracketed-paste support and pluggable autocomplete.
 *
 * @packageDocumentation
 */

import { inverse, sanitizeUntrustedText } from "../ansi.js";
import type { Key } from "../keys.js";
import { matchesKey } from "../keys.js";
import { style as themeStyle } from "../theme.js";
import type { Component, CursorPosition } from "../tui.js";
import { stringWidth, truncateToWidth } from "../width.js";
import { SelectList } from "./select-list.js";

/** A snapshot of the editable buffer. */
export interface EditorState {
  /** Logical lines (never empty — an empty buffer is `[""]`). */
  readonly lines: readonly string[];
  /** Index of the line the caret is on. */
  readonly cursorLine: number;
  /** UTF-16 offset of the caret within its line. */
  readonly cursorCol: number;
}

/** One entry offered by an {@link AutocompleteProvider}. */
export interface AutocompleteSuggestion {
  /** Text inserted when the suggestion is accepted. */
  readonly value: string;
  /** Text shown in the dropdown (defaults to {@link AutocompleteSuggestion.value}). */
  readonly label?: string;
  /** Secondary text shown next to the label. */
  readonly description?: string;
}

/** Editor position and surrounding text handed to an {@link AutocompleteProvider}. */
export interface AutocompleteContext {
  /** The full buffer. */
  readonly lines: readonly string[];
  /** Caret line. */
  readonly cursorLine: number;
  /** Caret column (UTF-16 offset). */
  readonly cursorCol: number;
  /** The token being completed, including its trigger character. */
  readonly prefix: string;
}

/** Supplies completion candidates to an {@link Editor}. */
export interface AutocompleteProvider {
  /**
   * Returns candidates for the current context. May be synchronous or async;
   * stale async results are discarded automatically.
   */
  getSuggestions(
    context: AutocompleteContext,
  ): readonly AutocompleteSuggestion[] | Promise<readonly AutocompleteSuggestion[]>;

  /**
   * Applies a suggestion. When omitted, the token under the caret is replaced with
   * {@link AutocompleteSuggestion.value}.
   */
  applyCompletion?(context: AutocompleteContext, suggestion: AutocompleteSuggestion): EditorState;
}

/** Options for {@link Editor}. */
export interface EditorOptions {
  /** Text shown when the buffer is empty. */
  readonly placeholder?: string;
  /**
   * Rewrites pasted text before insertion. The hook for hosts that read
   * meaning into a paste — a terminal drag-and-drop arrives as nothing but a
   * pasted path, and the CLI turns it into an attachment mention here.
   * Return the replacement; the paste is inserted verbatim without one.
   */
  readonly transformPaste?: (text: string) => string;
  /** Initial buffer contents. */
  readonly initialText?: string;
  /** Marker drawn before the first line (default `"› "`). */
  readonly prompt?: string;
  /** Marker drawn before continuation lines (defaults to spaces matching `prompt`). */
  readonly continuation?: string;
  /** Maximum buffer rows shown before the view scrolls (default `10`). */
  readonly maxVisibleLines?: number;
  /** Pre-populated submission history, most recent last. */
  readonly history?: readonly string[];
  /** Number of history entries retained (default `100`). */
  readonly maxHistory?: number;
  /** Completion source. */
  readonly autocomplete?: AutocompleteProvider;
  /** Characters that open the completion dropdown (default `["@", "/", "#"]`). */
  readonly autocompleteTriggers?: readonly string[];
  /** Maximum dropdown rows (default `6`). */
  readonly autocompleteMaxVisible?: number;
  /** Called when the user submits with Enter. */
  readonly onSubmit?: (text: string) => void;
  /** Called on every buffer change. */
  readonly onChange?: (text: string) => void;
  /** Called when Escape is pressed with no dropdown open. */
  readonly onCancel?: () => void;
  /** Called when async work finished and a repaint is needed. */
  readonly onUpdate?: () => void;
}

interface Snapshot {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface VisualLine {
  logical: number;
  start: number;
  end: number;
}

const DEFAULT_TRIGGERS = ["@", "/", "#"];
const WORD_CHAR = /[\p{L}\p{N}_]/u;

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

interface GraphemeSpan {
  index: number;
  text: string;
}

/** Splits a line into grapheme clusters annotated with their UTF-16 offsets. */
function spans(text: string): GraphemeSpan[] {
  if (segmenter) {
    const out: GraphemeSpan[] = [];
    for (const s of segmenter.segment(text)) out.push({ index: s.index, text: s.segment });
    return out;
  }
  const out: GraphemeSpan[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push({ index: i, text: ch });
    i += ch.length;
  }
  return out;
}

/**
 * A multi-line text input.
 *
 * Enter submits; Shift+Enter, Alt+Enter and Ctrl+J insert a newline. Emacs-style
 * bindings (Ctrl+A/E/K/U/W/Y, Alt+B/F/D) are supported alongside the arrow keys.
 * Up/Down step through submission history when the caret is on the first/last row.
 *
 * @example
 * ```ts
 * const editor = new Editor({
 *   prompt: "› ",
 *   placeholder: "Ask anything…",
 *   onSubmit: (text) => runPrompt(text),
 * });
 * tui.add(editor);
 * tui.focus(editor);
 * ```
 */
export class Editor implements Component {
  private readonly options: EditorOptions;
  private lines: string[];
  private cursorLine = 0;
  private cursorCol = 0;

  private undoStack: Snapshot[] = [];
  private typingRun = false;
  private killBuffer = "";

  private historyEntries: string[];
  private historyIndex = -1;
  private historyDraft: Snapshot | null = null;

  private focusedFlag = false;
  private scrollOffset = 0;

  private suggestionList: SelectList<AutocompleteSuggestion> | null = null;
  private suggestionPrefix = "";
  private requestToken = 0;

  private cursorPosition: CursorPosition | undefined;

  constructor(options: EditorOptions = {}) {
    this.options = options;
    this.lines = sanitizeUntrustedText(options.initialText ?? "").split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.cursorLine = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorLine]!.length;
    this.historyEntries = [...(options.history ?? [])];
  }

  /* ---------------------------------------------------------------------- */
  /* Public state                                                            */
  /* ---------------------------------------------------------------------- */

  /** The buffer contents joined with newlines. */
  get text(): string {
    return this.lines.join("\n");
  }

  /** A read-only view of the buffer state. */
  get state(): EditorState {
    return { lines: this.lines, cursorLine: this.cursorLine, cursorCol: this.cursorCol };
  }

  /** Submission history, oldest first. */
  get history(): readonly string[] {
    return this.historyEntries;
  }

  /** Whether the completion dropdown is currently open. */
  get isAutocompleteOpen(): boolean {
    return this.suggestionList !== null;
  }

  /** Suggestions currently offered, if the dropdown is open. */
  get suggestions(): readonly AutocompleteSuggestion[] {
    return (this.suggestionList?.filteredItems ?? []).map((i) => i.data as AutocompleteSuggestion);
  }

  /** Whether the editor currently has focus. */
  get focused(): boolean {
    return this.focusedFlag;
  }

  /**
   * Replaces the buffer, placing the caret at the end.
   *
   * `text` is treated as untrusted (it may come from a programmatic caller
   * relaying external content) and sanitised with {@link sanitizeUntrustedText}
   * before it enters buffer state.
   */
  setText(text: string): void {
    const sanitized = sanitizeUntrustedText(text);
    if (sanitized === this.text) return;
    this.pushUndo();
    this.lines = sanitized.split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.cursorLine = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorLine]!.length;
    this.afterChange();
  }

  /** Empties the buffer and clears the undo stack. */
  reset(): void {
    this.lines = [""];
    this.cursorLine = 0;
    this.cursorCol = 0;
    this.undoStack = [];
    this.typingRun = false;
    this.scrollOffset = 0;
    this.historyIndex = -1;
    this.historyDraft = null;
    this.closeAutocomplete();
    this.options.onChange?.("");
  }

  /** Appends an entry to the submission history, de-duplicating consecutive repeats. */
  addToHistory(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (this.historyEntries[this.historyEntries.length - 1] === trimmed) return;
    this.historyEntries.push(trimmed);
    const max = this.options.maxHistory ?? 100;
    if (this.historyEntries.length > max)
      this.historyEntries.splice(0, this.historyEntries.length - max);
  }

  onFocus(): void {
    this.focusedFlag = true;
  }

  onBlur(): void {
    this.focusedFlag = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Input                                                                   */
  /* ---------------------------------------------------------------------- */

  handleInput(key: Key): boolean {
    // 1. Bracketed paste is inserted as one undo unit — through the host's
    //    transform when it supplies one (the CLI turns a dropped file's
    //    pasted path into an @-mention there).
    if (key.name === "paste") {
      const raw = key.paste ?? "";
      this.insertText(this.options.transformPaste?.(raw) ?? raw, true);
      return true;
    }

    // 2. The dropdown consumes navigation and acceptance keys while it is open.
    if (this.suggestionList) {
      if (key.name === "escape") {
        this.closeAutocomplete();
        return true;
      }
      if (key.name === "tab" || (key.name === "enter" && !key.shift && !key.alt)) {
        return this.acceptCompletion();
      }
      if (
        key.name === "up" ||
        key.name === "down" ||
        key.name === "pageup" ||
        key.name === "pagedown"
      ) {
        return this.suggestionList.handleInput(key);
      }
    }

    // 3. Newline before submit so Shift/Alt+Enter never submits.
    if (isNewlineKey(key)) {
      this.insertNewline();
      return true;
    }
    if (key.name === "enter") {
      this.submit();
      return true;
    }

    if (key.name === "tab" && !key.shift) {
      void this.requestCompletions(true);
      return true;
    }
    if (key.name === "escape") {
      this.options.onCancel?.();
      return true;
    }

    if (key.name === "backspace" && !key.alt && !key.ctrl) {
      this.deleteBackward();
      return true;
    }
    if (key.name === "delete" || matchesKey(key, "ctrl+d")) {
      this.deleteForward();
      return true;
    }
    if (matchesKey(key, "ctrl+w") || matchesKey(key, "alt+backspace")) {
      this.deleteWordBackward();
      return true;
    }
    if (matchesKey(key, "alt+d")) {
      this.deleteWordForward();
      return true;
    }
    if (matchesKey(key, "ctrl+k")) {
      this.killToLineEnd();
      return true;
    }
    if (matchesKey(key, "ctrl+u")) {
      this.killToLineStart();
      return true;
    }
    if (matchesKey(key, "ctrl+y")) {
      this.insertText(this.killBuffer, true);
      return true;
    }
    if (matchesKey(key, "ctrl+z") || matchesKey(key, "ctrl+_")) {
      this.undo();
      return true;
    }

    if (key.name === "home" || matchesKey(key, "ctrl+a")) {
      this.moveToLineStart();
      return true;
    }
    if (key.name === "end" || matchesKey(key, "ctrl+e")) {
      this.moveToLineEnd();
      return true;
    }
    if ((key.name === "left" && (key.alt || key.ctrl)) || matchesKey(key, "alt+b")) {
      this.moveWord(-1);
      return true;
    }
    if ((key.name === "right" && (key.alt || key.ctrl)) || matchesKey(key, "alt+f")) {
      this.moveWord(1);
      return true;
    }
    if (key.name === "left" || matchesKey(key, "ctrl+b")) {
      this.moveChar(-1);
      return true;
    }
    if (key.name === "right" || matchesKey(key, "ctrl+f")) {
      this.moveChar(1);
      return true;
    }
    if (key.name === "up") {
      this.moveVertical(-1);
      return true;
    }
    if (key.name === "down") {
      this.moveVertical(1);
      return true;
    }

    if (key.text !== undefined && !key.ctrl && !key.alt && !key.meta) {
      this.insertText(key.text, false);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Editing primitives                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Inserts text at the caret, splitting on newlines.
   *
   * `text` may originate from an untrusted external source (bracketed paste,
   * a kill-buffer yank of previously-pasted content) so it is first run through
   * {@link sanitizeUntrustedText} to strip ANSI escape sequences and bare
   * control bytes — otherwise a paste containing e.g. an OSC 52 clipboard
   * write or a fake OSC-8 link would land in the buffer and later be written
   * verbatim to the terminal.
   */
  insertText(text: string, atomic: boolean): void {
    if (text === "") return;
    const sanitized = sanitizeUntrustedText(text);
    if (sanitized === "") return;
    const normalized = sanitized.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    if (atomic || /\s/.test(normalized) || !this.typingRun) this.pushUndo();
    this.typingRun = !atomic;

    const line = this.lines[this.cursorLine]!;
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);
    const parts = normalized.split("\n");

    if (parts.length === 1) {
      this.lines[this.cursorLine] = before + parts[0]! + after;
      this.cursorCol = before.length + parts[0]!.length;
    } else {
      const last = parts[parts.length - 1]!;
      const middle = parts.slice(1, -1);
      this.lines.splice(this.cursorLine, 1, before + parts[0]!, ...middle, last + after);
      this.cursorLine += parts.length - 1;
      this.cursorCol = last.length;
    }
    this.afterChange();
  }

  /** Inserts a hard line break at the caret. */
  insertNewline(): void {
    this.pushUndo();
    this.typingRun = false;
    const line = this.lines[this.cursorLine]!;
    this.lines.splice(
      this.cursorLine,
      1,
      line.slice(0, this.cursorCol),
      line.slice(this.cursorCol),
    );
    this.cursorLine += 1;
    this.cursorCol = 0;
    this.afterChange();
  }

  /** Deletes the grapheme before the caret, joining lines at column 0. */
  deleteBackward(): void {
    if (this.cursorCol === 0 && this.cursorLine === 0) return;
    this.pushUndo();
    this.typingRun = false;
    if (this.cursorCol === 0) {
      const current = this.lines[this.cursorLine]!;
      const previous = this.lines[this.cursorLine - 1]!;
      this.lines.splice(this.cursorLine - 1, 2, previous + current);
      this.cursorLine -= 1;
      this.cursorCol = previous.length;
    } else {
      const line = this.lines[this.cursorLine]!;
      const start = this.previousGrapheme(line, this.cursorCol);
      this.lines[this.cursorLine] = line.slice(0, start) + line.slice(this.cursorCol);
      this.cursorCol = start;
    }
    this.afterChange();
  }

  /** Deletes the grapheme after the caret, joining lines at end of line. */
  deleteForward(): void {
    const line = this.lines[this.cursorLine]!;
    if (this.cursorCol >= line.length && this.cursorLine === this.lines.length - 1) return;
    this.pushUndo();
    this.typingRun = false;
    if (this.cursorCol >= line.length) {
      const next = this.lines[this.cursorLine + 1]!;
      this.lines.splice(this.cursorLine, 2, line + next);
    } else {
      const end = this.nextGrapheme(line, this.cursorCol);
      this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + line.slice(end);
    }
    this.afterChange();
  }

  /** Deletes from the caret back to the start of the previous word. */
  deleteWordBackward(): void {
    if (this.cursorCol === 0) {
      this.deleteBackward();
      return;
    }
    this.pushUndo();
    this.typingRun = false;
    const line = this.lines[this.cursorLine]!;
    const start = wordBoundaryBackward(line, this.cursorCol);
    this.killBuffer = line.slice(start, this.cursorCol);
    this.lines[this.cursorLine] = line.slice(0, start) + line.slice(this.cursorCol);
    this.cursorCol = start;
    this.afterChange();
  }

  /** Deletes from the caret forward to the end of the next word. */
  deleteWordForward(): void {
    const line = this.lines[this.cursorLine]!;
    if (this.cursorCol >= line.length) {
      this.deleteForward();
      return;
    }
    this.pushUndo();
    this.typingRun = false;
    const end = wordBoundaryForward(line, this.cursorCol);
    this.killBuffer = line.slice(this.cursorCol, end);
    this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + line.slice(end);
    this.afterChange();
  }

  /** Cuts from the caret to the end of the line into the kill buffer. */
  killToLineEnd(): void {
    const line = this.lines[this.cursorLine]!;
    if (this.cursorCol >= line.length) {
      this.deleteForward();
      return;
    }
    this.pushUndo();
    this.typingRun = false;
    this.killBuffer = line.slice(this.cursorCol);
    this.lines[this.cursorLine] = line.slice(0, this.cursorCol);
    this.afterChange();
  }

  /** Cuts from the start of the line to the caret into the kill buffer. */
  killToLineStart(): void {
    if (this.cursorCol === 0) return;
    this.pushUndo();
    this.typingRun = false;
    const line = this.lines[this.cursorLine]!;
    this.killBuffer = line.slice(0, this.cursorCol);
    this.lines[this.cursorLine] = line.slice(this.cursorCol);
    this.cursorCol = 0;
    this.afterChange();
  }

  /** The most recently killed text. */
  get killed(): string {
    return this.killBuffer;
  }

  /** Restores the buffer to the previous undo checkpoint. */
  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.lines = [...snapshot.lines];
    this.cursorLine = snapshot.cursorLine;
    this.cursorCol = snapshot.cursorCol;
    this.typingRun = false;
    this.exitHistory();
    this.closeAutocomplete();
    this.options.onChange?.(this.text);
    return true;
  }

  /** Number of undo checkpoints currently held. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Submits the buffer, records it in history and clears the editor. */
  submit(): void {
    const value = this.text.trim();
    this.closeAutocomplete();
    if (value !== "") this.addToHistory(value);
    this.reset();
    if (value !== "") this.options.onSubmit?.(value);
  }

  /* ---------------------------------------------------------------------- */
  /* Cursor movement                                                         */
  /* ---------------------------------------------------------------------- */

  /** Moves the caret one grapheme left or right, crossing line boundaries. */
  moveChar(direction: -1 | 1): void {
    const line = this.lines[this.cursorLine]!;
    if (direction === -1) {
      if (this.cursorCol > 0) this.cursorCol = this.previousGrapheme(line, this.cursorCol);
      else if (this.cursorLine > 0) {
        this.cursorLine -= 1;
        this.cursorCol = this.lines[this.cursorLine]!.length;
      }
    } else if (this.cursorCol < line.length) {
      this.cursorCol = this.nextGrapheme(line, this.cursorCol);
    } else if (this.cursorLine < this.lines.length - 1) {
      this.cursorLine += 1;
      this.cursorCol = 0;
    }
    this.afterCursorMove();
  }

  /** Moves the caret one word left or right. */
  moveWord(direction: -1 | 1): void {
    const line = this.lines[this.cursorLine]!;
    if (direction === -1) {
      if (this.cursorCol === 0) {
        this.moveChar(-1);
        return;
      }
      this.cursorCol = wordBoundaryBackward(line, this.cursorCol);
    } else {
      if (this.cursorCol >= line.length) {
        this.moveChar(1);
        return;
      }
      this.cursorCol = wordBoundaryForward(line, this.cursorCol);
    }
    this.afterCursorMove();
  }

  /** Moves the caret to column 0 of the current line. */
  moveToLineStart(): void {
    this.cursorCol = 0;
    this.afterCursorMove();
  }

  /** Moves the caret to the end of the current line. */
  moveToLineEnd(): void {
    this.cursorCol = this.lines[this.cursorLine]!.length;
    this.afterCursorMove();
  }

  /**
   * Moves the caret up or down a line, stepping into submission history when it is
   * already on the first (up) or last (down) line.
   */
  moveVertical(direction: -1 | 1): void {
    const atFirst = this.cursorLine === 0;
    const atLast = this.cursorLine === this.lines.length - 1;
    if (direction === -1 && atFirst) {
      if (this.navigateHistory(-1)) return;
      this.moveToLineStart();
      return;
    }
    if (direction === 1 && atLast) {
      if (this.historyIndex !== -1 && this.navigateHistory(1)) return;
      this.moveToLineEnd();
      return;
    }
    const target = this.cursorLine + direction;
    this.cursorLine = target;
    this.cursorCol = Math.min(this.cursorCol, this.lines[target]!.length);
    this.afterCursorMove();
  }

  /**
   * Steps through submission history.
   *
   * @param direction - `-1` for older entries, `1` for newer ones.
   * @returns `true` when the buffer was replaced.
   */
  navigateHistory(direction: -1 | 1): boolean {
    if (this.historyEntries.length === 0) return false;
    const next = this.historyIndex + (direction === -1 ? 1 : -1);
    if (next < -1 || next >= this.historyEntries.length) return false;

    if (this.historyIndex === -1 && next >= 0) {
      this.historyDraft = {
        lines: [...this.lines],
        cursorLine: this.cursorLine,
        cursorCol: this.cursorCol,
      };
    }
    this.historyIndex = next;

    if (next === -1) {
      const draft = this.historyDraft ?? { lines: [""], cursorLine: 0, cursorCol: 0 };
      this.lines = [...draft.lines];
      this.cursorLine = draft.cursorLine;
      this.cursorCol = draft.cursorCol;
      this.historyDraft = null;
    } else {
      const entry = this.historyEntries[this.historyEntries.length - 1 - next]!;
      this.lines = entry.split("\n");
      this.cursorLine = direction === -1 ? 0 : this.lines.length - 1;
      this.cursorCol = direction === -1 ? 0 : this.lines[this.cursorLine]!.length;
    }
    this.closeAutocomplete();
    this.options.onChange?.(this.text);
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Autocomplete                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Queries the provider for completions at the caret.
   *
   * @param explicit - `true` when triggered by Tab, which queries even without a
   *   trigger character.
   */
  async requestCompletions(explicit = false): Promise<void> {
    const provider = this.options.autocomplete;
    if (!provider) return;
    const prefix = this.currentToken();
    const triggers = this.options.autocompleteTriggers ?? DEFAULT_TRIGGERS;
    const triggered = triggers.some((t) => prefix.startsWith(t));
    if (!explicit && !triggered) {
      this.closeAutocomplete();
      return;
    }
    if (explicit && !triggered && prefix === "") {
      this.closeAutocomplete();
      return;
    }

    const context: AutocompleteContext = {
      lines: [...this.lines],
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
      prefix,
    };
    const token = ++this.requestToken;
    const result = provider.getSuggestions(context);
    const suggestions = result instanceof Promise ? await result : result;
    if (token !== this.requestToken) return;
    this.showSuggestions(suggestions, prefix);
    if (result instanceof Promise) this.options.onUpdate?.();
  }

  /** Accepts the highlighted suggestion. Returns `false` when nothing was open. */
  acceptCompletion(): boolean {
    const list = this.suggestionList;
    const selected = list?.selected?.data as AutocompleteSuggestion | undefined;
    if (!list || !selected) return false;

    const context: AutocompleteContext = {
      lines: [...this.lines],
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
      prefix: this.suggestionPrefix,
    };
    this.pushUndo();
    const applied = this.options.autocomplete?.applyCompletion?.(context, selected);
    if (applied) {
      this.lines = [...applied.lines];
      this.cursorLine = applied.cursorLine;
      this.cursorCol = applied.cursorCol;
    } else {
      const line = this.lines[this.cursorLine]!;
      const start = this.cursorCol - this.suggestionPrefix.length;
      this.lines[this.cursorLine] =
        line.slice(0, start) + selected.value + line.slice(this.cursorCol);
      this.cursorCol = start + selected.value.length;
    }
    this.closeAutocomplete();
    this.typingRun = false;
    this.options.onChange?.(this.text);
    return true;
  }

  /** Closes the completion dropdown. */
  closeAutocomplete(): void {
    this.requestToken++;
    this.suggestionList = null;
    this.suggestionPrefix = "";
  }

  private showSuggestions(suggestions: readonly AutocompleteSuggestion[], prefix: string): void {
    if (suggestions.length === 0) {
      this.closeAutocomplete();
      return;
    }
    this.suggestionPrefix = prefix;
    this.suggestionList = new SelectList<AutocompleteSuggestion>({
      items: suggestions.map((s) => ({
        value: s.value,
        label: s.label ?? s.value,
        ...(s.description !== undefined ? { description: s.description } : {}),
        data: s,
      })),
      maxVisible: this.options.autocompleteMaxVisible ?? 6,
    });
  }

  /** The whitespace-delimited token immediately before the caret. */
  private currentToken(): string {
    const line = this.lines[this.cursorLine]!;
    const before = line.slice(0, this.cursorCol);
    const match = /(\S+)$/.exec(before);
    return match?.[1] ?? "";
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                               */
  /* ---------------------------------------------------------------------- */

  invalidate(): void {
    this.cursorPosition = undefined;
  }

  getCursor(): CursorPosition | undefined {
    return this.cursorPosition;
  }

  render(width: number): string[] {
    this.cursorPosition = undefined;
    const prompt = this.options.prompt ?? "› ";
    const promptWidth = stringWidth(prompt);
    const continuation = this.options.continuation ?? " ".repeat(promptWidth);
    const contentWidth = Math.max(1, width - promptWidth);

    const visual = this.buildVisualLines(contentWidth);
    // The caret occupies the column after the last glyph, so a cursor at the
    // end of an exactly-full visual row would render one column past the
    // width — which the frame renderer then truncates into an ellipsis, and
    // typing appears to stop at the edge instead of wrapping. Give that
    // caret a home: an empty continuation row right after the full one.
    const cursorText = this.lines[this.cursorLine] ?? "";
    if (this.cursorCol === cursorText.length) {
      for (let i = visual.length - 1; i >= 0; i--) {
        const vl = visual[i]!;
        if (vl.logical !== this.cursorLine) continue;
        if (
          vl.end === cursorText.length &&
          stringWidth(cursorText.slice(vl.start, vl.end)) >= contentWidth
        ) {
          visual.splice(i + 1, 0, {
            logical: this.cursorLine,
            start: cursorText.length,
            end: cursorText.length,
          });
        }
        break;
      }
    }
    const cursorVisual = this.findVisualIndex(visual);
    const maxVisible = Math.max(1, this.options.maxVisibleLines ?? 10);
    this.scrollOffset = clampScroll(this.scrollOffset, cursorVisual, visual.length, maxVisible);

    const start = this.scrollOffset;
    const end = Math.min(visual.length, start + maxVisible);
    const out: string[] = [];

    const showPlaceholder =
      this.options.placeholder !== undefined && this.lines.length === 1 && this.lines[0] === "";

    for (let i = start; i < end; i++) {
      const vl = visual[i]!;
      const gutter = themeStyle("muted")(i === 0 ? prompt : continuation);
      const text = this.lines[vl.logical]!.slice(vl.start, vl.end);
      let body: string;
      if (showPlaceholder && i === 0) {
        body = themeStyle("placeholder")(
          truncateToWidth(this.options.placeholder ?? "", contentWidth),
        );
      } else {
        body = this.renderLine(text, i === cursorVisual ? this.cursorCol - vl.start : -1);
      }
      out.push(gutter + body);
      if (i === cursorVisual) {
        this.cursorPosition = {
          row: out.length - 1,
          col: promptWidth + stringWidth(this.lines[vl.logical]!.slice(vl.start, this.cursorCol)),
        };
      }
    }

    if (visual.length > end) {
      out.push(themeStyle("muted")(`${continuation}… ${visual.length - end} more line(s)`));
    }

    if (this.suggestionList) {
      out.push(...this.suggestionList.render(width));
    }
    return out;
  }

  /** Renders one visual row, drawing an inverse-video caret when focused. */
  private renderLine(text: string, caretOffset: number): string {
    if (!this.focusedFlag || caretOffset < 0) return text;
    const before = text.slice(0, caretOffset);
    const at = caretOffset < text.length ? this.sliceGrapheme(text, caretOffset) : " ";
    const after = caretOffset < text.length ? text.slice(caretOffset + at.length) : "";
    return before + themeStyle("cursor")(inverse(at)) + after;
  }

  private sliceGrapheme(text: string, offset: number): string {
    const end = this.nextGrapheme(text, offset);
    return text.slice(offset, end);
  }

  /** Maps logical lines onto width-limited visual rows. */
  private buildVisualLines(width: number): VisualLine[] {
    const out: VisualLine[] = [];
    for (let logical = 0; logical < this.lines.length; logical++) {
      for (const range of wrapRanges(this.lines[logical]!, width)) {
        out.push({ logical, start: range.start, end: range.end });
      }
    }
    return out.length > 0 ? out : [{ logical: 0, start: 0, end: 0 }];
  }

  private findVisualIndex(visual: VisualLine[]): number {
    // The last matching row wins: a cursor sitting on the boundary two rows
    // share (the end of one is the start of the next) belongs to the later
    // row, so typing past the fold lands the caret at the start of the next
    // visual line rather than one column past the end of the full one.
    let fallback = 0;
    let match = -1;
    for (let i = 0; i < visual.length; i++) {
      const vl = visual[i]!;
      if (vl.logical !== this.cursorLine) continue;
      fallback = i;
      if (this.cursorCol >= vl.start && this.cursorCol <= vl.end) match = i;
    }
    return match === -1 ? fallback : match;
  }

  private previousGrapheme(text: string, offset: number): number {
    let last = 0;
    for (const span of spans(text)) {
      if (span.index >= offset) break;
      last = span.index;
    }
    return last;
  }

  private nextGrapheme(text: string, offset: number): number {
    for (const span of spans(text)) {
      if (span.index > offset) return span.index;
    }
    return text.length;
  }

  private pushUndo(): void {
    this.undoStack.push({
      lines: [...this.lines],
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
    });
    if (this.undoStack.length > 500) this.undoStack.shift();
  }

  private exitHistory(): void {
    this.historyIndex = -1;
    this.historyDraft = null;
  }

  private afterChange(): void {
    this.exitHistory();
    this.options.onChange?.(this.text);
    void this.requestCompletions(false);
  }

  private afterCursorMove(): void {
    if (this.suggestionList) void this.requestCompletions(false);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** `true` when the key means "insert a line break" rather than "submit". */
function isNewlineKey(key: Key): boolean {
  if (key.name !== "enter" && key.name !== "j") return false;
  if (key.name === "j") return key.ctrl;
  return key.shift || key.alt;
}

function clampScroll(offset: number, cursor: number, total: number, maxVisible: number): number {
  let next = Math.max(0, Math.min(offset, Math.max(0, total - maxVisible)));
  if (cursor < next) next = cursor;
  if (cursor >= next + maxVisible) next = cursor - maxVisible + 1;
  return Math.max(0, next);
}

/** Word-wraps a plain line, returning UTF-16 offset ranges for each visual row. */
function wrapRanges(text: string, width: number): Array<{ start: number; end: number }> {
  if (text === "") return [{ start: 0, end: 0 }];
  const glyphs = spans(text);
  const ranges: Array<{ start: number; end: number }> = [];

  let start = 0;
  let columns = 0;
  let lastBreak = -1;
  let i = 0;

  while (i < glyphs.length) {
    const glyph = glyphs[i]!;
    const w = stringWidth(glyph.text);
    if (columns + w > width && glyph.index > start) {
      // Prefer breaking after the last whitespace on this row.
      const breakAt = lastBreak > start ? lastBreak : glyph.index;
      ranges.push({ start, end: breakAt });
      start = breakAt;
      columns = 0;
      lastBreak = -1;
      while (i > 0 && glyphs[i - 1]!.index >= start) i--;
      continue;
    }
    columns += w;
    if (/\s/.test(glyph.text)) lastBreak = glyph.index + glyph.text.length;
    i++;
  }
  ranges.push({ start, end: text.length });
  return ranges;
}

/** Finds the offset of the start of the word before `offset`. */
export function wordBoundaryBackward(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
  if (i > 0 && !WORD_CHAR.test(text[i - 1] ?? "")) {
    while (i > 0 && !WORD_CHAR.test(text[i - 1] ?? "") && !/\s/.test(text[i - 1] ?? "")) i--;
    return i;
  }
  while (i > 0 && WORD_CHAR.test(text[i - 1] ?? "")) i--;
  return i;
}

/** Finds the offset of the end of the word after `offset`. */
export function wordBoundaryForward(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  if (i < text.length && !WORD_CHAR.test(text[i] ?? "")) {
    while (i < text.length && !WORD_CHAR.test(text[i] ?? "") && !/\s/.test(text[i] ?? "")) i++;
    return i;
  }
  while (i < text.length && WORD_CHAR.test(text[i] ?? "")) i++;
  return i;
}
