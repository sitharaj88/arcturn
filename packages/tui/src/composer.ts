/**
 * The frame composer: the single owner of every byte that reaches the terminal
 * while a TUI is running.
 *
 * The renderer submits *desired state* — the latest frame, plus any transcript
 * lines to insert above the live block — and the composer turns state changes
 * into terminal writes. Decoupling the two is what keeps the UI responsive on a
 * slow terminal:
 *
 * - **Latest-wins frames.** If the terminal is still draining a previous write,
 *   newly submitted frames replace the pending one instead of queueing behind
 *   it. The terminal is never more than one frame behind the application, no
 *   matter how slowly it drains, and the event loop never blocks on a write.
 * - **Atomic writes.** Each flush is one `write()` call containing the erase,
 *   the content and the repaint, optionally wrapped in synchronized-output
 *   markers (DEC private mode 2026) so capable terminals paint it in one step —
 *   no torn frames, no flicker.
 * - **Chunked content.** Transcript insertions are never dropped, but very
 *   large ones are written in slices with the event loop given a turn between
 *   slices, so a huge tool result cannot freeze input handling.
 *
 * - **Theme-owned canvas.** In screen mode the composer can paint every cell it
 *   touches with the active theme's background (see {@link FrameComposerOptions.canvas}),
 *   so a light theme is readable on a dark terminal and vice versa.
 *
 * The diff algorithm and its byte output are unchanged from the classic
 * renderer: unchanged frames write nothing, a single changed row costs one
 * line of output. With no canvas configured the bytes are identical to the
 * canvas-less composer, sequence for sequence.
 *
 * @packageDocumentation
 */

import {
  CSI,
  cursorDown,
  cursorTo,
  cursorToColumn,
  cursorUp,
  ERASE_DOWN,
  ERASE_LINE,
  ERASE_SCREEN,
} from "./ansi.js";
import type { Terminal } from "./terminal.js";
import type { CursorPosition } from "./tui.js";
import { stringWidth } from "./width.js";

/** Begin synchronized update (DEC private mode 2026). */
export const SYNC_START = `${CSI}?2026h`;
/** End synchronized update (DEC private mode 2026). */
export const SYNC_END = `${CSI}?2026l`;

/** A desired screen state, as submitted by the renderer. */
export interface ComposedFrame {
  /** One string per terminal row. */
  readonly lines: string[];
  /** Where the hardware cursor should sit, or `undefined` to leave it hidden. */
  readonly cursor?: CursorPosition;
  /** Terminal width the frame was laid out for. */
  readonly width: number;
  /** Terminal height the frame was laid out for. */
  readonly height: number;
  /** Repaint every row even if it looks unchanged. */
  readonly forceRepaint?: boolean;
}

/** Maximum transcript lines written per slice when the terminal signals drain. */
const CONTENT_SLICE_LINES = 400;

/**
 * SGR "default background". Rendered lines that carry their own background —
 * diff rows, code blocks — close it with this sequence, which would punch a
 * hole through the canvas unless the canvas is immediately re-opened.
 */
const BG_RESET = `${CSI}49m`;
/**
 * Every SGR that drops the canvas: the full reset (`ESC[0m` and its `ESC[m`
 * shorthand) plus the foreground/background defaults.
 *
 * The full reset matters more than it looks: `sliceByWidth` in `width.ts`
 * appends one whenever it truncates a row that still has styling open, so a
 * clipped row would otherwise lose the canvas from the cut onwards and expose
 * the terminal's own ground for the rest of the line.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal's own ESC sequences is the point.
const CANVAS_DROPPING_SGR = /\u001b\[(?:0?|39|49)m/g;

/** Options accepted by {@link FrameComposer}. */
export interface FrameComposerOptions {
  /** Absolute (alternate-screen) addressing rather than an inline block. */
  readonly screen?: boolean;
  /**
   * Returns the SGR sequence that opens the canvas colour — the background the
   * composer paints behind every cell it touches — or `""` for no canvas.
   *
   * Called once per {@link FrameComposer.flush}, so a theme switch (or a change
   * in colour support) takes effect on the very next frame with no plumbing.
   * Only meaningful in screen mode: an inline block shares the shell's screen
   * and must never tint it, so inline callers simply omit this.
   */
  readonly canvas?: () => string;
}

/**
 * Owns the terminal's painted state and schedules writes against it.
 *
 * All submissions are cheap and synchronous; actual writing happens in
 * {@link FrameComposer.flush}, which the owner calls after submitting (and
 * which re-arms itself on drain when the terminal applies backpressure).
 */
export class FrameComposer {
  private readonly terminal: Terminal;
  /**
   * Screen mode: frames are the whole viewport, addressed absolutely
   * (row 0 is the top of the screen). There is no erase arithmetic at all —
   * a changed row is rewritten in place and a size change repaints the
   * screen — which is what makes this mode immune to resize artifacts.
   */
  private readonly screen: boolean;
  /** Resolves the current canvas SGR, or `""` when the theme paints no ground. */
  private readonly canvas: (() => string) | undefined;
  /** The canvas resolved for the flush in progress (`""` outside a flush). */
  private canvasSgr = "";

  /** Rows the terminal is known to display (the last flushed frame). */
  private flushedLines: string[] = [];
  private flushedWidth = 0;
  private flushedHeight = 0;
  /** 0-based row of the hardware cursor within the flushed block. */
  private cursorRow = 0;
  /** Display column the hardware cursor was left at, for reflow arithmetic. */
  private cursorCol = 0;
  private painted = false;

  private pendingFrame: ComposedFrame | null = null;
  private pendingContent: string[] = [];
  private waitingForDrain = false;
  private sliceScheduled = false;
  private suspended = false;

  constructor(terminal: Terminal, options: FrameComposerOptions = {}) {
    this.terminal = terminal;
    this.screen = options.screen ?? false;
    this.canvas = options.canvas;
  }

  /* ---------------------------------------------------------------- state */

  /** Whether anything has been painted since the last reset. */
  get hasPainted(): boolean {
    return this.painted;
  }

  /** The rows currently on the terminal (the last flushed frame). */
  get lines(): readonly string[] {
    return this.flushedLines;
  }

  /** 0-based row the hardware cursor was left on within the flushed block. */
  get row(): number {
    return this.cursorRow;
  }

  /** Forget the painted block entirely (used after an external screen clear). */
  reset(): void {
    this.flushedLines = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.painted = false;
    this.pendingFrame = null;
    this.pendingContent = [];
  }

  /**
   * Whether the painted block, rewrapped to the given size, would no longer
   * fit the viewport — meaning its top rows are about to scroll into the
   * terminal's history, where they can never be erased again.
   */
  overflowsAt(width: number, height: number): boolean {
    if (!this.painted) return false;
    const columns = Math.max(1, width);
    const reflows = this.terminal.reflowsOnResize !== false;
    let rows = 0;
    for (const line of this.flushedLines) {
      rows += reflows ? Math.max(1, Math.ceil(stringWidth(line) / columns)) : 1;
    }
    // Two rows of margin: the next resize step lands before we can react.
    return rows > Math.max(1, height - 2);
  }

  /**
   * Erase the painted block immediately and forget it.
   *
   * Used mid-resize when {@link FrameComposer.overflowsAt} reports the block
   * is about to outgrow the viewport: erasing now, while its rows are still
   * reachable, is the only alternative to leaving stale copies in scrollback.
   */
  collapse(width: number, height: number): void {
    if (!this.painted) return;
    this.canvasSgr = this.canvas?.() ?? "";
    const bytes = this.eraseReflowedBlock(width, height) + (this.canvasSgr !== "" ? BG_RESET : "");
    this.flushedLines = [];
    this.flushedWidth = width;
    this.flushedHeight = height;
    this.terminal.write(bytes);
  }

  /** Hold all writes; submissions keep updating the pending state. */
  suspend(): void {
    this.suspended = true;
  }

  /** Allow writes again. The caller decides when to flush. */
  resume(): void {
    this.suspended = false;
  }

  /* ----------------------------------------------------------- submission */

  /** Replaces the pending frame — the newest submission always wins. */
  submitFrame(frame: ComposedFrame): void {
    this.pendingFrame = frame;
  }

  /** Queues transcript lines to insert above the live block. Never dropped. */
  submitContent(lines: readonly string[]): void {
    this.pendingContent.push(...lines);
  }

  /** Whether a frame or content is waiting to be written. */
  get hasPendingWork(): boolean {
    return this.pendingFrame !== null || this.pendingContent.length > 0;
  }

  /* ------------------------------------------------------------- flushing */

  /**
   * Writes pending work to the terminal.
   *
   * When the terminal reports backpressure the flush stops and re-arms itself
   * on the drain event; submissions that arrive in between simply update the
   * pending state, so the next flush writes the newest frame only.
   */
  flush(): void {
    if (this.suspended || this.waitingForDrain || this.sliceScheduled) return;
    if (!this.hasPendingWork) return;

    this.canvasSgr = this.canvas?.() ?? "";
    let buffer = "";
    let sliceRemainder = false;

    if (this.pendingContent.length > 0) {
      const canYield = typeof this.terminal.writeChunk === "function";
      let content = this.pendingContent;
      if (canYield && content.length > CONTENT_SLICE_LINES) {
        content = content.slice(0, CONTENT_SLICE_LINES);
        this.pendingContent = this.pendingContent.slice(CONTENT_SLICE_LINES);
        sliceRemainder = true;
      } else {
        this.pendingContent = [];
      }
      // Content erases against the size the next frame was laid out for: a
      // resize may have rewrapped the painted block while writes were held.
      const width = this.pendingFrame?.width ?? this.flushedWidth;
      const height = this.pendingFrame?.height ?? this.flushedHeight;
      buffer += this.composeContent(content, width, height);
    }

    if (!sliceRemainder && this.pendingFrame) {
      const frame = this.pendingFrame;
      this.pendingFrame = null;
      buffer += this.composeFrame(frame);
    }

    // Close the canvas at the end of the flush: the composer owns only the
    // cells it painted, and whatever writes next (teardown, a raw
    // `terminal.write`, the shell) must not inherit the tint.
    if (this.canvasSgr !== "" && buffer !== "") buffer += BG_RESET;

    const writable = this.writeOut(buffer);
    if (!writable) this.armDrain();
    else if (sliceRemainder) this.scheduleSlice();
  }

  /** Writes bytes out; returns `false` when the terminal wants a drain pause. */
  private writeOut(buffer: string): boolean {
    if (buffer === "") return true;
    const wrapped = this.terminal.supportsSyncOutput ? SYNC_START + buffer + SYNC_END : buffer;
    if (typeof this.terminal.writeChunk === "function") {
      return this.terminal.writeChunk(wrapped);
    }
    this.terminal.write(wrapped);
    return true;
  }

  private armDrain(): void {
    if (this.waitingForDrain) return;
    if (typeof this.terminal.onceDrain !== "function") return;
    this.waitingForDrain = true;
    this.terminal.onceDrain(() => {
      this.waitingForDrain = false;
      this.flush();
    });
  }

  private scheduleSlice(): void {
    if (this.sliceScheduled) return;
    this.sliceScheduled = true;
    const later: (fn: () => void) => void =
      typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);
    later(() => {
      this.sliceScheduled = false;
      this.flush();
    });
  }

  /* --------------------------------------------------------------- canvas */

  /**
   * An erase sequence run *under* the canvas.
   *
   * Terminals implement background-colour erase (BCE): `ED`/`EL` fill the
   * cleared cells with the currently selected background, so opening the canvas
   * first is what makes the erase paint the ground rather than punch a hole in
   * it. With no canvas the erase is returned untouched.
   */
  private erase(sequence: string): string {
    return this.canvasSgr + sequence;
  }

  /**
   * A rendered row, wrapped so every one of its cells sits on the canvas.
   *
   * The row is prefixed with the canvas (its own text cells show the ground),
   * and every `49m` *inside* it — emitted by any style that carries a
   * background of its own, such as the diff tokens — is followed by a canvas
   * re-open, so closing a local background falls back to the canvas instead of
   * to the terminal's ground. With no canvas the row is returned unchanged.
   */
  private paint(line: string): string {
    if (this.canvasSgr === "") return line;
    // Re-open the canvas after anything that would drop it: a closed
    // background must not expose the terminal's ground, a closed foreground
    // must not expose its default ink, and a full reset must not do both.
    const canvas = this.canvasSgr;
    return canvas + line.replace(CANVAS_DROPPING_SGR, (sgr) => sgr + canvas);
  }

  /**
   * {@link FrameComposer.paint} plus an explicit canvas-coloured pad out to
   * the full row width. See {@link FrameComposer.composeScreenFrame}: erases
   * cannot be trusted to fill cells with the canvas (no BCE on Terminal.app),
   * so every screen-mode row writes its own background, cell by cell.
   */
  private paintRow(line: string, width: number): string {
    if (this.canvasSgr === "") return this.paint(line);
    const pad = Math.max(0, width - stringWidth(line));
    return this.paint(line) + (pad > 0 ? this.canvasSgr + " ".repeat(pad) : "");
  }

  /* ------------------------------------------------------------ composing */

  /**
   * Bytes that erase the live block and print `content` into scrollback where
   * the block stood. The next {@link composeFrame} repaints below it.
   *
   * When the terminal was resized since the block was painted, the erase must
   * climb by the *rewrapped* row count — the plain logical count would leave
   * the block's top rows (typically the input box border) alive above the
   * content, duplicated.
   */
  private composeContent(content: readonly string[], width: number, height: number): string {
    let buffer = "";
    if (this.painted) {
      const sizeChanged = this.flushedWidth !== width || this.flushedHeight !== height;
      if (sizeChanged) {
        buffer += this.eraseReflowedBlock(width, height);
        this.flushedWidth = width;
        this.flushedHeight = height;
      } else {
        buffer += cursorUp(this.cursorRow);
        buffer += `\r${this.erase(ERASE_DOWN)}`;
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.painted = false;
      }
      this.flushedLines = [];
    }
    buffer += content.map((line) => `${this.paint(line)}\r\n`).join("");
    return buffer;
  }

  /** Bytes that bring the terminal from the flushed frame to `frame`. */
  private composeFrame(frame: ComposedFrame): string {
    if (this.screen) return this.composeScreenFrame(frame);
    let buffer = "";
    const sizeChanged = this.flushedWidth !== frame.width || this.flushedHeight !== frame.height;
    if (this.painted && sizeChanged) {
      buffer += this.eraseReflowedBlock(frame.width, frame.height);
    }
    if (!this.painted || frame.forceRepaint || sizeChanged) {
      buffer += this.fullRepaint(frame.lines);
    } else {
      buffer += this.incrementalRepaint(frame.lines);
    }
    this.flushedLines = frame.lines;
    this.flushedWidth = frame.width;
    this.flushedHeight = frame.height;
    this.painted = true;
    buffer += this.composeCursor(frame.cursor, frame.lines.length);
    return buffer;
  }

  /**
   * Screen-mode repaint: absolute row addressing, no relative arithmetic.
   *
   * A size change (or force) clears the screen and rewrites every row;
   * otherwise only changed rows are rewritten in place. Either way the frame
   * ends with the hardware cursor parked absolutely, so nothing can drift.
   */
  private composeScreenFrame(frame: ComposedFrame): string {
    let buffer = "";
    const sizeChanged = this.flushedWidth !== frame.width || this.flushedHeight !== frame.height;
    const repaintAll = !this.painted || frame.forceRepaint || sizeChanged;
    const canvassed = this.canvasSgr !== "";
    if (repaintAll) {
      buffer += this.erase(ERASE_SCREEN) + cursorTo(0, 0);
      // With a canvas, EVERY row of the viewport is painted edge to edge —
      // blank ones included. Erase-with-background (BCE) would make that
      // redundant, but Apple's Terminal.app famously erases to its own
      // default background instead, which left the canvas visible only
      // behind actual characters: parchment stripes on the terminal's dark
      // ground. Explicit cells are the only portable canvas.
      const rows = canvassed ? Math.max(frame.lines.length, frame.height) : frame.lines.length;
      for (let i = 0; i < rows; i++) {
        const line = frame.lines[i] ?? "";
        if (line === "" && !canvassed) continue;
        buffer += cursorTo(i, 0) + this.paintRow(line, frame.width);
      }
    } else {
      const previous = this.flushedLines;
      const max = Math.max(frame.lines.length, previous.length);
      for (let i = 0; i < max; i++) {
        const line = frame.lines[i] ?? "";
        if ((previous[i] ?? "") === line) continue;
        buffer += cursorTo(i, 0) + this.erase(ERASE_LINE) + this.paintRow(line, frame.width);
      }
    }
    this.flushedLines = frame.lines;
    this.flushedWidth = frame.width;
    this.flushedHeight = frame.height;
    this.painted = true;
    if (frame.cursor && frame.lines.length > 0) {
      const row = Math.max(0, Math.min(frame.cursor.row, frame.height - 1));
      const col = Math.max(0, frame.cursor.col);
      buffer += cursorTo(row, col);
      this.cursorRow = row;
      this.cursorCol = col;
    }
    return buffer;
  }

  /**
   * Erase the previous frame after a terminal resize.
   *
   * A resize makes the terminal rewrap the painted block, so the physical
   * distance from the hardware cursor to the block's top row must be
   * recomputed from the previous logical lines at the *new* width: every line
   * wider than the terminal now occupies `ceil(width/columns)` rows, and the
   * cursor's own line may have wrapped above the cursor column. The climb is
   * clamped to the viewport since anything further up has scrolled away.
   */
  private eraseReflowedBlock(width: number, height: number): string {
    const columns = Math.max(1, width);
    // Rewrapping emulators (Terminal.app, iTerm2, xterm.js — verified: they
    // keep trailing spaces when rewrapping) fold each over-wide row into
    // ceil(width/columns) physical rows. Non-rewrapping hosts (tmux) keep one
    // physical row per written row, so the climb is just the logical count.
    const reflows = this.terminal.reflowsOnResize !== false;
    let rows = reflows ? Math.floor(this.cursorCol / columns) : 0;
    const upto = Math.min(this.cursorRow, this.flushedLines.length);
    for (let i = 0; i < upto; i++) {
      rows += reflows
        ? Math.max(1, Math.ceil(stringWidth(this.flushedLines[i] ?? "") / columns))
        : 1;
    }
    const up = Math.min(rows, Math.max(0, height - 1));
    this.cursorRow = 0;
    this.cursorCol = 0;
    // The screen below the cursor is now clean; fullRepaint must not climb again.
    this.painted = false;
    return `${up > 0 ? cursorUp(up) : ""}\r${this.erase(ERASE_DOWN)}`;
  }

  private fullRepaint(lines: string[]): string {
    let buffer = "";
    if (this.painted) {
      buffer += cursorUp(this.cursorRow);
      buffer += "\r";
      buffer += this.erase(ERASE_DOWN);
    }
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) buffer += "\r\n";
      buffer += this.erase(ERASE_LINE) + this.paint(lines[i] ?? "");
    }
    this.cursorRow = Math.max(0, lines.length - 1);
    this.cursorCol = stringWidth(lines[lines.length - 1] ?? "");
    return buffer;
  }

  private incrementalRepaint(lines: string[]): string {
    const previous = this.flushedLines;
    const max = Math.max(lines.length, previous.length);
    let firstChanged = -1;
    let lastChanged = -1;
    for (let i = 0; i < max; i++) {
      if ((previous[i] ?? "") !== (lines[i] ?? "")) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }
    if (firstChanged === -1) return "";

    let buffer = "";
    const renderEnd = Math.min(lastChanged, lines.length - 1);

    if (renderEnd >= firstChanged) {
      // Appending rows beyond the old frame requires a newline to create them.
      const appendStart = firstChanged >= previous.length && firstChanged > 0;
      const moveTarget = appendStart ? firstChanged - 1 : firstChanged;
      buffer += this.moveTo(moveTarget);
      buffer += appendStart ? "\r\n" : "\r";
      if (appendStart) this.cursorRow = firstChanged;

      for (let i = firstChanged; i <= renderEnd; i++) {
        if (i > firstChanged) buffer += "\r\n";
        buffer += this.erase(ERASE_LINE) + this.paint(lines[i] ?? "");
      }
      this.cursorRow = renderEnd;
      this.cursorCol = stringWidth(lines[renderEnd] ?? "");
    }

    if (previous.length > lines.length) {
      // Everything from the first surplus row down is gone.
      buffer += this.moveTo(lines.length);
      buffer += `\r${this.erase(ERASE_DOWN)}`;
      this.cursorRow = lines.length;
      this.cursorCol = 0;
    }

    return buffer;
  }

  /** The vertical movement needed to reach `row`, updating the tracked row. */
  private moveTo(row: number): string {
    const delta = row - this.cursorRow;
    this.cursorRow = row;
    return delta > 0 ? cursorDown(delta) : cursorUp(-delta);
  }

  /** Bytes that park the hardware cursor for `cursor`, or `""` when hidden. */
  private composeCursor(cursor: CursorPosition | undefined, total: number): string {
    if (!cursor || total === 0) return "";
    const row = Math.max(0, Math.min(cursor.row, total - 1));
    const col = Math.max(0, cursor.col);
    const bytes = this.moveTo(row) + cursorToColumn(col);
    this.cursorCol = col;
    return bytes;
  }
}
