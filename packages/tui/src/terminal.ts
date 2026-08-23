/**
 * The terminal abstraction that every other module in this package talks to.
 *
 * Nothing else touches `process.stdout` / `process.stdin` directly, which makes the
 * whole library testable headlessly: swap {@link ProcessTerminal} for
 * {@link TestTerminal} and the renderer, components and key handling behave
 * identically while every byte written is captured in an array.
 *
 * @packageDocumentation
 */

import {
  cursorTo,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  ERASE_LINE,
  ERASE_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./ansi.js";

/** Terminal dimensions in character cells. */
export interface TerminalSize {
  /** Number of columns. */
  readonly columns: number;
  /** Number of rows. */
  readonly rows: number;
}

/** Removes a previously registered listener. */
export type Unsubscribe = () => void;

/**
 * A writable, resizable, readable terminal.
 *
 * Row and column arguments are **0-based**; implementations translate to the
 * 1-based ANSI wire format.
 */
export interface Terminal {
  /** Current width in columns. */
  readonly columns: number;
  /** Current height in rows. */
  readonly rows: number;
  /** Whether the output stream is an interactive terminal. */
  readonly isTTY: boolean;
  /** Whether raw mode is currently engaged. */
  readonly isRawMode: boolean;

  /** Writes raw bytes (including escape sequences) to the terminal. */
  write(data: string): void;

  /**
   * Writes raw bytes and reports backpressure: `false` means the stream's
   * buffer is full and the caller should pause until {@link Terminal.onceDrain}
   * fires. Optional — callers fall back to {@link Terminal.write}.
   */
  writeChunk?(data: string): boolean;

  /**
   * Invokes `callback` once when a backed-up stream becomes writable again.
   * Optional; only meaningful alongside {@link Terminal.writeChunk}.
   */
  onceDrain?(callback: () => void): void;

  /**
   * Whether writes may be wrapped in synchronized-output markers (DEC private
   * mode 2026) so the terminal paints each flush atomically. Terminals that do
   * not understand the mode ignore it, so this is safe to report for any real
   * TTY; test terminals report `false` to keep captured bytes minimal.
   */
  readonly supportsSyncOutput?: boolean;

  /**
   * Whether the emulator rewraps previously painted rows when its width
   * changes (Terminal.app, iTerm2, xterm.js do; tmux keeps one physical row
   * per written row). Drives the erase arithmetic after a resize. Absent means
   * `true`.
   */
  readonly reflowsOnResize?: boolean;

  /** Subscribes to size changes. Returns an unsubscribe function. */
  onResize(listener: (size: TerminalSize) => void): Unsubscribe;

  /** Subscribes to raw input chunks. Returns an unsubscribe function. */
  onInput(listener: (data: string) => void): Unsubscribe;

  /** Puts the input stream into raw mode (no line buffering, no echo). */
  enterRawMode(): void;
  /** Restores cooked mode. */
  exitRawMode(): void;

  /** Makes the hardware cursor visible. */
  showCursor(): void;
  /** Hides the hardware cursor. */
  hideCursor(): void;

  /** Moves the cursor to an absolute 0-based position. */
  moveCursor(row: number, col: number): void;
  /** Erases the entire line the cursor is on. */
  clearLine(): void;
  /** Erases the whole screen and homes the cursor. */
  clearScreen(): void;

  /** Asks the terminal to bracket pasted text with `ESC [200~` / `ESC [201~`. */
  enableBracketedPaste(): void;
  /** Turns bracketed paste back off. */
  disableBracketedPaste(): void;

  /**
   * Switches to the alternate screen buffer (optional). Full-screen mode: no
   * scrollback interaction, the app owns every cell, and leaving restores the
   * user's shell screen untouched.
   */
  enterAltScreen?(): void;
  /** Returns from the alternate screen buffer (optional). */
  exitAltScreen?(): void;

  /** Enables SGR mouse reporting, for wheel scrolling (optional). */
  enableMouse?(): void;
  /** Disables SGR mouse reporting (optional). */
  disableMouse?(): void;

  /** Restores the terminal to its original state and drops all listeners. */
  dispose(): void;
}

/** Constructor options for {@link ProcessTerminal}. */
export interface ProcessTerminalOptions {
  /** Output stream (defaults to `process.stdout`). */
  readonly stdout?: NodeJS.WriteStream;
  /** Input stream (defaults to `process.stdin`). */
  readonly stdin?: NodeJS.ReadStream;
  /** Register `exit`/`SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT` cleanup handlers (default `true`). */
  readonly handleSignals?: boolean;
  /** Fallback size used when the stream reports no dimensions. */
  readonly fallbackSize?: TerminalSize;
}

/** Enter the alternate screen buffer (xterm 1049: saves cursor + screen). */
const ENTER_ALT_SCREEN = "\u001b[?1049h";
/** Leave the alternate screen buffer, restoring the shell's screen. */
const EXIT_ALT_SCREEN = "\u001b[?1049l";
/** Button-event mouse reporting (1000) in SGR encoding (1006). */
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
/** Mouse reporting off. */
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1000l";

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };
// SIGQUIT (Ctrl-\) is POSIX-only but harmless to register on Windows: Node simply
// never delivers it there, so no platform guard is needed for this array itself.
const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
// SIGBREAK (Ctrl-Break) only exists on Windows; guarded so POSIX runs never
// register a listener for a signal name the platform doesn't support.
if (process.platform === "win32") CLEANUP_SIGNALS.push("SIGBREAK");

/**
 * A {@link Terminal} backed by the real process streams.
 *
 * Handles raw mode, bracketed paste, cursor visibility and — importantly —
 * restoring all of them when the process exits or is signalled, so a crash never
 * leaves the user's shell in raw mode with an invisible cursor.
 *
 * @example
 * ```ts
 * const term = new ProcessTerminal();
 * term.enterRawMode();
 * term.enableBracketedPaste();
 * term.onInput((data) => decoder.push(data));
 * ```
 */
export class ProcessTerminal implements Terminal {
  private readonly stdout: NodeJS.WriteStream;
  private readonly stdin: NodeJS.ReadStream;
  private readonly fallback: TerminalSize;
  private readonly resizeListeners = new Set<(size: TerminalSize) => void>();
  private readonly inputListeners = new Set<(data: string) => void>();

  private raw = false;
  private cursorHidden = false;
  private pasteEnabled = false;
  private altScreen = false;
  private mouseEnabled = false;
  private disposed = false;
  private inputAttached = false;

  private readonly onStdoutResize = (): void => {
    const size = { columns: this.columns, rows: this.rows };
    for (const listener of this.resizeListeners) listener(size);
  };

  private readonly onStdinData = (chunk: Buffer | string): void => {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const listener of this.inputListeners) listener(data);
  };

  private readonly onProcessExit = (): void => {
    this.restore();
  };

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.restore();
    // Re-raise with the default handler so exit codes stay conventional.
    process.removeListener(signal, this.onSignal);
    process.kill(process.pid, signal);
  };

  constructor(options: ProcessTerminalOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stdin = options.stdin ?? process.stdin;
    this.fallback = options.fallbackSize ?? DEFAULT_SIZE;

    this.stdout.on("resize", this.onStdoutResize);
    if (options.handleSignals !== false) {
      process.on("exit", this.onProcessExit);
      for (const signal of CLEANUP_SIGNALS) process.on(signal, this.onSignal);
    }
    this.setBlockingMode(false);
  }

  /**
   * Switches the output fd between blocking and non-blocking mode.
   *
   * Node puts TTY fds in blocking mode, so a large write to a slow terminal
   * stalls the whole event loop — keystrokes included. Non-blocking mode makes
   * `write()` buffer instead and report backpressure through its return value,
   * which {@link ProcessTerminal.writeChunk} exposes. Blocking mode is restored
   * on {@link ProcessTerminal.dispose}/exit so final restore sequences are
   * never lost. Best-effort: the internal handle API may be absent.
   */
  private setBlockingMode(blocking: boolean): void {
    if (!this.stdout.isTTY) return;
    const handle = (this.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })
      ._handle;
    try {
      handle?.setBlocking?.(blocking);
    } catch {
      // Leave the stream as-is; writeChunk still works, minus backpressure.
    }
  }

  get columns(): number {
    return this.stdout.columns ?? this.fallback.columns;
  }

  get rows(): number {
    return this.stdout.rows ?? this.fallback.rows;
  }

  get isTTY(): boolean {
    return Boolean(this.stdout.isTTY);
  }

  get isRawMode(): boolean {
    return this.raw;
  }

  write(data: string): void {
    if (this.disposed || data === "") return;
    this.stdout.write(data);
  }

  writeChunk(data: string): boolean {
    if (this.disposed || data === "") return true;
    return this.stdout.write(data);
  }

  onceDrain(callback: () => void): void {
    this.stdout.once("drain", callback);
  }

  get supportsSyncOutput(): boolean {
    return this.isTTY;
  }

  get reflowsOnResize(): boolean {
    // tmux repaints panes itself and never rewraps history rows.
    return process.env.TMUX === undefined;
  }

  onResize(listener: (size: TerminalSize) => void): Unsubscribe {
    this.resizeListeners.add(listener);
    return () => {
      this.resizeListeners.delete(listener);
    };
  }

  onInput(listener: (data: string) => void): Unsubscribe {
    this.inputListeners.add(listener);
    this.attachInput();
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  enterRawMode(): void {
    if (this.raw) return;
    if (typeof this.stdin.setRawMode === "function" && this.stdin.isTTY) {
      this.stdin.setRawMode(true);
    }
    this.raw = true;
    this.attachInput();
  }

  exitRawMode(): void {
    if (!this.raw) return;
    if (typeof this.stdin.setRawMode === "function" && this.stdin.isTTY) {
      this.stdin.setRawMode(false);
    }
    this.raw = false;
  }

  showCursor(): void {
    if (!this.cursorHidden) return;
    this.cursorHidden = false;
    this.write(SHOW_CURSOR);
  }

  hideCursor(): void {
    if (this.cursorHidden) return;
    this.cursorHidden = true;
    this.write(HIDE_CURSOR);
  }

  moveCursor(row: number, col: number): void {
    this.write(cursorTo(row, col));
  }

  clearLine(): void {
    this.write(ERASE_LINE);
  }

  clearScreen(): void {
    this.write(`${ERASE_SCREEN}${cursorTo(0, 0)}`);
  }

  enableBracketedPaste(): void {
    if (this.pasteEnabled) return;
    this.pasteEnabled = true;
    this.write(ENABLE_BRACKETED_PASTE);
  }

  disableBracketedPaste(): void {
    if (!this.pasteEnabled) return;
    this.pasteEnabled = false;
    this.write(DISABLE_BRACKETED_PASTE);
  }

  enterAltScreen(): void {
    if (this.altScreen) return;
    this.altScreen = true;
    this.write(ENTER_ALT_SCREEN);
  }

  exitAltScreen(): void {
    if (!this.altScreen) return;
    this.altScreen = false;
    this.write(EXIT_ALT_SCREEN);
  }

  enableMouse(): void {
    if (this.mouseEnabled) return;
    this.mouseEnabled = true;
    this.write(ENABLE_MOUSE);
  }

  disableMouse(): void {
    if (!this.mouseEnabled) return;
    this.mouseEnabled = false;
    this.write(DISABLE_MOUSE);
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore();
    this.disposed = true;
    this.resizeListeners.clear();
    this.inputListeners.clear();
    this.stdout.removeListener("resize", this.onStdoutResize);
    process.removeListener("exit", this.onProcessExit);
    for (const signal of CLEANUP_SIGNALS) process.removeListener(signal, this.onSignal);
  }

  /** Undoes every terminal mode this instance turned on. Safe to call repeatedly. */
  private restore(): void {
    if (this.disposed) return;
    // Back to blocking mode so restore sequences (and any final queued output)
    // are on the wire before the process exits.
    this.setBlockingMode(true);
    if (this.mouseEnabled) {
      this.mouseEnabled = false;
      this.stdout.write(DISABLE_MOUSE);
    }
    if (this.altScreen) {
      this.altScreen = false;
      this.stdout.write(EXIT_ALT_SCREEN);
    }
    if (this.pasteEnabled) {
      this.pasteEnabled = false;
      this.stdout.write(DISABLE_BRACKETED_PASTE);
    }
    if (this.cursorHidden) {
      this.cursorHidden = false;
      this.stdout.write(SHOW_CURSOR);
    }
    this.exitRawMode();
    if (this.inputAttached) {
      this.inputAttached = false;
      this.stdin.removeListener("data", this.onStdinData);
      if (typeof this.stdin.pause === "function") this.stdin.pause();
    }
  }

  private attachInput(): void {
    if (this.inputAttached || this.disposed) return;
    this.inputAttached = true;
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", this.onStdinData);
    if (typeof this.stdin.resume === "function") this.stdin.resume();
  }
}

/** Constructor options for {@link TestTerminal}. */
export interface TestTerminalOptions {
  /** Initial width (default `80`). */
  readonly columns?: number;
  /** Initial height (default `24`). */
  readonly rows?: number;
  /** Reported TTY-ness (default `true`). */
  readonly isTTY?: boolean;
}

/**
 * An in-memory {@link Terminal} for tests.
 *
 * Every write is captured, input can be injected synchronously, and the size can be
 * changed to exercise resize handling — all without a real TTY.
 *
 * @example
 * ```ts
 * const term = new TestTerminal({ columns: 20, rows: 5 });
 * const tui = new TUI(term);
 * tui.add(new Text("hi"));
 * tui.renderNow();
 * expect(term.output).toContain("hi");
 * term.injectInput("\u001b[A"); // arrow up
 * ```
 */
export class TestTerminal implements Terminal {
  private cols: number;
  private rowCount: number;
  private readonly tty: boolean;
  private readonly captured: string[] = [];
  private readonly resizeListeners = new Set<(size: TerminalSize) => void>();
  private readonly inputListeners = new Set<(data: string) => void>();

  private raw = false;
  private cursorVisible = true;
  private paste = false;
  private altScreenOn = false;
  private mouseOn = false;
  private destroyed = false;

  constructor(options: TestTerminalOptions = {}) {
    this.cols = options.columns ?? DEFAULT_SIZE.columns;
    this.rowCount = options.rows ?? DEFAULT_SIZE.rows;
    this.tty = options.isTTY ?? true;
  }

  get columns(): number {
    return this.cols;
  }

  get rows(): number {
    return this.rowCount;
  }

  get isTTY(): boolean {
    return this.tty;
  }

  get isRawMode(): boolean {
    return this.raw;
  }

  /** Whether the cursor is currently shown. */
  get isCursorVisible(): boolean {
    return this.cursorVisible;
  }

  /** Whether bracketed paste has been enabled. */
  get isBracketedPasteEnabled(): boolean {
    return this.paste;
  }

  /** Whether {@link TestTerminal.dispose} has been called. */
  get isDisposed(): boolean {
    return this.destroyed;
  }

  /** Every individual `write()` call, in order. */
  get writes(): readonly string[] {
    return this.captured;
  }

  /** All captured writes concatenated. */
  get output(): string {
    return this.captured.join("");
  }

  write(data: string): void {
    if (data === "") return;
    this.captured.push(data);
  }

  /** Empties the capture buffer, so a test can assert on the next frame alone. */
  clearWrites(): void {
    this.captured.length = 0;
  }

  onResize(listener: (size: TerminalSize) => void): Unsubscribe {
    this.resizeListeners.add(listener);
    return () => {
      this.resizeListeners.delete(listener);
    };
  }

  onInput(listener: (data: string) => void): Unsubscribe {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  /** Delivers raw input to every registered listener. */
  injectInput(data: string): void {
    for (const listener of [...this.inputListeners]) listener(data);
  }

  /** Changes the reported size and notifies resize listeners. */
  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rowCount = rows;
    const size = { columns, rows };
    for (const listener of [...this.resizeListeners]) listener(size);
  }

  enterRawMode(): void {
    this.raw = true;
  }

  exitRawMode(): void {
    this.raw = false;
  }

  showCursor(): void {
    if (this.cursorVisible) return;
    this.cursorVisible = true;
    this.write(SHOW_CURSOR);
  }

  hideCursor(): void {
    if (!this.cursorVisible) return;
    this.cursorVisible = false;
    this.write(HIDE_CURSOR);
  }

  moveCursor(row: number, col: number): void {
    this.write(cursorTo(row, col));
  }

  clearLine(): void {
    this.write(ERASE_LINE);
  }

  clearScreen(): void {
    this.write(`${ERASE_SCREEN}${cursorTo(0, 0)}`);
  }

  enableBracketedPaste(): void {
    this.paste = true;
    this.write(ENABLE_BRACKETED_PASTE);
  }

  disableBracketedPaste(): void {
    this.paste = false;
    this.write(DISABLE_BRACKETED_PASTE);
  }

  /** Whether the alternate screen buffer is active. */
  get isAltScreen(): boolean {
    return this.altScreenOn;
  }

  /** Whether mouse reporting is enabled. */
  get isMouseEnabled(): boolean {
    return this.mouseOn;
  }

  enterAltScreen(): void {
    if (this.altScreenOn) return;
    this.altScreenOn = true;
    this.write(ENTER_ALT_SCREEN);
  }

  exitAltScreen(): void {
    if (!this.altScreenOn) return;
    this.altScreenOn = false;
    this.write(EXIT_ALT_SCREEN);
  }

  enableMouse(): void {
    if (this.mouseOn) return;
    this.mouseOn = true;
    this.write(ENABLE_MOUSE);
  }

  disableMouse(): void {
    if (!this.mouseOn) return;
    this.mouseOn = false;
    this.write(DISABLE_MOUSE);
  }

  dispose(): void {
    this.destroyed = true;
    this.raw = false;
    this.resizeListeners.clear();
    this.inputListeners.clear();
  }
}
