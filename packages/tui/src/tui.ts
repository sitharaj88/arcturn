/**
 * The differential renderer.
 *
 * A frame is a flat array of strings, one per terminal row. Each render builds a new
 * frame, compares it against the previous one and writes only the rows that changed,
 * using relative cursor movement plus erase-line. Redrawing a 40-row UI after a
 * single keystroke therefore costs one line of output, not forty.
 *
 * ### Invariants
 *
 * - A frame never exceeds `terminal.rows` lines. Longer frames are clipped to their
 *   last `rows` lines, which guarantees the whole block stays on screen and keeps
 *   relative cursor arithmetic valid.
 * - A line never exceeds `terminal.columns` display columns. Over-wide lines are
 *   truncated (or wrapped, see {@link TUIOptions.overflow}) so the terminal's own
 *   auto-wrap can never desynchronise the row mapping.
 *
 * @packageDocumentation
 */

import { CSI, cursorDown, type Style } from "./ansi.js";
import { FrameComposer } from "./composer.js";
import { type Key, KeyDecoder } from "./keys.js";
import type { Terminal, Unsubscribe } from "./terminal.js";
import { getTheme } from "./theme.js";
import { padToWidth, sliceByWidth, stringWidth, truncateToWidth, wrapText } from "./width.js";

/** Resets every SGR attribute, including the canvas background. */
const RESET_SGR = `${CSI}0m`;

/**
 * The SGR sequence that opens `style`'s colour at the *current* colour level.
 *
 * `Style.open` always carries the truecolour form regardless of what the
 * terminal supports, so it cannot be used directly: applying the style to an
 * empty string and stripping the trailing `close` yields the level-appropriate
 * opener instead — and `""` when colour is off, which correctly disables the
 * canvas altogether.
 */
function openSequence(style: Style): string {
  const painted = style("");
  if (style.close === "" || !painted.endsWith(style.close)) return painted;
  return painted.slice(0, painted.length - style.close.length);
}

/** Cursor position relative to the top-left of a component's own output. */
export interface CursorPosition {
  /** 0-based row within the component's rendered lines. */
  readonly row: number;
  /** 0-based display column. */
  readonly col: number;
}

/**
 * The unit of composition.
 *
 * A component is a pure-ish function from an available width to an array of
 * rendered lines, optionally able to consume key events and report a cursor.
 *
 * @example
 * ```ts
 * class Clock implements Component {
 *   render(width: number): string[] {
 *     return [new Date().toISOString().padEnd(width)];
 *   }
 * }
 * ```
 */
export interface Component {
  /**
   * Renders the component.
   *
   * @param width - Columns available. Implementations must not return lines wider
   *   than this.
   * @returns One string per terminal row.
   */
  render(width: number): string[];

  /**
   * Height-aware render, used in screen mode for the one flexible region
   * (typically a scrolling transcript viewport). A component implementing
   * this receives the rows left over after every fixed component is laid
   * out, and must return exactly that many lines.
   *
   * @param width - Columns available.
   * @param height - Rows this component must fill exactly.
   */
  renderArea?(width: number, height: number): string[];

  /**
   * Handles a key event.
   *
   * @param key - The decoded key.
   * @returns `true` when the key was consumed and should not propagate.
   */
  handleInput?(key: Key): boolean;

  /** Reports where the hardware cursor should sit, relative to this component. */
  getCursor?(): CursorPosition | undefined;

  /** Called when the component gains focus. */
  onFocus?(): void;
  /** Called when the component loses focus. */
  onBlur?(): void;
  /** Drops any cached render output (called on theme or size changes). */
  invalidate?(): void;
}

/** Vertical placement of an overlay. */
export type OverlayAlign = "top" | "middle" | "bottom";
/** Horizontal placement of an overlay. */
export type OverlayJustify = "left" | "center" | "right";

/** Placement options for {@link TUI.setOverlay}. */
export interface OverlayOptions {
  /** Vertical anchor (default `"middle"`). */
  readonly align?: OverlayAlign;
  /** Horizontal anchor (default `"center"`). */
  readonly justify?: OverlayJustify;
  /** Absolute row, overriding {@link OverlayOptions.align}. */
  readonly row?: number;
  /** Absolute column, overriding {@link OverlayOptions.justify}. */
  readonly col?: number;
  /** Render width. Accepts a column count or a `0 < n <= 1` fraction of the screen. */
  readonly width?: number;
  /** Give the overlay keyboard focus while it is shown (default `true`). */
  readonly focus?: boolean;
}

/** How the renderer deals with lines wider than the terminal. */
export type OverflowMode = "truncate" | "wrap";

/** Constructor options for {@link TUI}. */
export interface TUIOptions {
  /** Show the hardware cursor when the focused component reports one (default `true`). */
  readonly manageCursor?: boolean;
  /** Repaint automatically when the terminal is resized (default `true`). */
  readonly autoResize?: boolean;
  /** Treatment of over-wide lines (default `"truncate"`). */
  readonly overflow?: OverflowMode;
  /** Milliseconds to wait before a lone `ESC` is reported as an escape key (default `30`). */
  readonly escapeTimeout?: number;
  /**
   * Milliseconds an unterminated bracketed paste waits for its `ESC[201~`
   * before the text that did arrive is delivered anyway (default `2000`).
   *
   * The bound exists for the terminal that dies mid-paste; it is two orders of
   * magnitude above {@link TUIOptions.escapeTimeout} because a live terminal
   * paces a long paste in chunks and does go quiet between them. Whatever
   * arrived is delivered as pasted text, never as key presses, and normal key
   * decoding resumes — so the worst case is a truncated paste, not a wedged UI.
   */
  readonly pasteTimeout?: number;
  /**
   * Rendering mode (default `"inline"`).
   *
   * `"inline"` renders a block at the bottom of the normal screen, keeping
   * the terminal's native scrollback. `"screen"` takes over the alternate
   * screen buffer and renders full frames with absolute addressing — the
   * terminal's rewrap can never smear or duplicate anything, resizes are a
   * plain repaint, and leaving restores the user's shell screen.
   */
  readonly mode?: "inline" | "screen";
  /**
   * Milliseconds a resize burst must stay quiet before the UI repaints
   * (default `80`).
   *
   * An interactive drag delivers dozens of resize events while the emulator
   * rewraps the screen underneath every write; repainting per event smears
   * frames across half-applied sizes. Instead the first event of a burst
   * erases the live block once — while the size has moved a single step from
   * the painted width, where the erase arithmetic is near-exact on any
   * emulator — painting is held while events keep arriving, and one clean
   * repaint happens at the final size. `0` repaints synchronously on every
   * event (useful for tests).
   */
  readonly resizeSettleMs?: number;
}

/** A global key handler, invoked when no component consumed the key. */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler may return nothing to decline the key
export type KeyHandler = (key: Key) => boolean | void;

interface Frame {
  lines: string[];
  cursor?: CursorPosition;
}

interface OverlayEntry {
  component: Component;
  options: OverlayOptions;
  previousFocus: Component | null;
}

/**
 * Owns a list of components, renders them into frames and writes only the
 * differences to a {@link Terminal}.
 *
 * @example
 * ```ts
 * const tui = new TUI(new ProcessTerminal());
 * const editor = new Editor({ onSubmit: (text) => console.log(text) });
 * tui.add(new Text("Type something:"));
 * tui.add(editor);
 * tui.focus(editor);
 * tui.start();
 * ```
 */
export class TUI {
  private readonly terminal: Terminal;
  private readonly options: Required<TUIOptions>;
  private readonly decoder = new KeyDecoder();
  private readonly keyHandlers: KeyHandler[] = [];
  /** Handlers that see a key *before* the focused component. */
  private readonly priorityKeyHandlers: KeyHandler[] = [];
  private readonly keyObservers: ((key: Key) => void)[] = [];

  private componentList: Component[] = [];
  private focusedComponent: Component | null = null;
  private overlayEntry: OverlayEntry | null = null;

  private readonly composer: FrameComposer;
  private forceRepaint = false;
  /** Who paints the screen ground: our cells, or the terminal's default bg. */
  private groundOwner: "cells" | "terminal" = "cells";

  private renderScheduled = false;
  private lastRenderAt = 0;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;
  private pasteTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribers: Unsubscribe[] = [];

  constructor(terminal: Terminal, options: TUIOptions = {}) {
    this.terminal = terminal;
    const screen = options.mode === "screen";
    this.composer = new FrameComposer(terminal, {
      screen,
      // Screen mode owns the whole viewport, so the theme owns the ground under
      // it: read per flush, so `setTheme` lands on the next frame. Inline mode
      // shares the shell's screen and passes no canvas at all.
      ...(screen
        ? {
            // A scroll moves every row, so the row diff would rewrite the
            // whole viewport for the smallest change on screen. When the
            // terminal can move rows itself, let it.
            scrollRegion: terminal.supportsScrollRegion !== false,
            // Ground AND default ink: an unstyled cell must be legible on our
            // canvas, never the terminal's own foreground. When the host has
            // synced the TERMINAL's default background to the theme (OSC 11),
            // the ground is omitted: explicit background cells render opaque
            // while default-background cells go through the terminal's own
            // compositing (Terminal.app blurs/tints them), so mixing the two
            // shows the same colour in two shades. One owner, one shade.
            canvas: () => {
              const styles = getTheme().styles;
              return this.groundOwner === "terminal"
                ? openSequence(styles.text)
                : openSequence(styles.background) + openSequence(styles.text);
            },
          }
        : {}),
    });
    this.options = {
      mode: options.mode ?? "inline",
      manageCursor: options.manageCursor ?? true,
      autoResize: options.autoResize ?? true,
      overflow: options.overflow ?? "truncate",
      escapeTimeout: options.escapeTimeout ?? 30,
      pasteTimeout: options.pasteTimeout ?? 2000,
      resizeSettleMs: options.resizeSettleMs ?? 80,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Component management                                                    */
  /* ---------------------------------------------------------------------- */

  /** The components rendered, in order, from top to bottom. */
  get components(): readonly Component[] {
    return this.componentList;
  }

  /** Appends a component to the bottom of the stack. */
  add(component: Component): void {
    this.componentList.push(component);
    this.requestRender();
  }

  /** Inserts a component at a specific index. */
  insert(index: number, component: Component): void {
    this.componentList.splice(index, 0, component);
    this.requestRender();
  }

  /**
   * Removes a component.
   *
   * @returns `true` when the component was present.
   */
  remove(component: Component): boolean {
    const index = this.componentList.indexOf(component);
    if (index === -1) return false;
    this.componentList.splice(index, 1);
    if (this.focusedComponent === component) this.focus(null);
    this.requestRender();
    return true;
  }

  /** Replaces the whole component list. */
  setComponents(components: readonly Component[]): void {
    this.componentList = [...components];
    if (this.focusedComponent && !this.componentList.includes(this.focusedComponent)) {
      this.focus(null);
    }
    this.requestRender();
  }

  /** Removes every component. */
  clear(): void {
    this.setComponents([]);
  }

  /* ---------------------------------------------------------------------- */
  /* Focus                                                                   */
  /* ---------------------------------------------------------------------- */

  /** The component currently receiving key events, if any. */
  get focused(): Component | null {
    return this.focusedComponent;
  }

  /**
   * Moves keyboard focus.
   *
   * @param component - Component to focus, or `null` to clear focus.
   */
  focus(component: Component | null): void {
    if (this.focusedComponent === component) return;
    this.focusedComponent?.onBlur?.();
    this.focusedComponent = component;
    component?.onFocus?.();
    this.requestRender();
  }

  /** Focuses the next input-capable component, wrapping around. */
  focusNext(): void {
    this.cycleFocus(1);
  }

  /** Focuses the previous input-capable component, wrapping around. */
  focusPrevious(): void {
    this.cycleFocus(-1);
  }

  private cycleFocus(direction: 1 | -1): void {
    const candidates = this.componentList.filter((c) => typeof c.handleInput === "function");
    if (candidates.length === 0) return;
    const current = this.focusedComponent ? candidates.indexOf(this.focusedComponent) : -1;
    const start = current === -1 ? (direction === 1 ? -1 : 0) : current;
    const next = (start + direction + candidates.length) % candidates.length;
    this.focus(candidates[next] ?? null);
  }

  /* ---------------------------------------------------------------------- */
  /* Overlay                                                                 */
  /* ---------------------------------------------------------------------- */

  /** The modal component currently drawn on top of the content, if any. */
  get overlay(): Component | null {
    return this.overlayEntry?.component ?? null;
  }

  /**
   * Shows (or hides) a modal overlay drawn over the regular content.
   *
   * @param component - Component to overlay, or `null` to dismiss the current one.
   * @param options - Placement and focus behaviour.
   */
  setOverlay(component: Component | null, options: OverlayOptions = {}): void {
    // Painted synchronously, unlike most state changes: a modal opening or
    // closing is a one-shot event a person is waiting on, not the kind of
    // flood the frame governor exists to smooth. Queuing a dialog behind the
    // governor would add a frame of latency to every permission prompt for
    // no benefit — nothing else is competing to paint at that moment.
    if (component === null) {
      const previous = this.overlayEntry;
      this.overlayEntry = null;
      if (previous && previous.options.focus !== false) this.focus(previous.previousFocus);
      if (this.running) this.renderNow();
      return;
    }
    this.overlayEntry = {
      component,
      options,
      previousFocus: this.focusedComponent,
    };
    if (options.focus !== false) this.focus(component);
    if (this.running) this.renderNow();
  }

  /* ---------------------------------------------------------------------- */
  /* Input                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Registers a key handler.
   *
   * By default the handler is a *fallback*: it runs only for keys the focused
   * component (or overlay) declined, which is what a global shortcut wants.
   * With `priority`, it runs **before** the focused component instead — the
   * only way a host can claim a key an input already binds, and therefore the
   * escape hatch for chrome that owns a key contextually (a transcript that
   * takes `End` while it is scrolled away from the tail, say). Use it
   * sparingly and conditionally: a priority handler that always consumes takes
   * the key away from the editor for good.
   *
   * @param handler - Returns `true` to mark the key as handled.
   * @param options - `priority` runs the handler ahead of the focused component.
   * @returns A function that removes the handler.
   */
  onKey(handler: KeyHandler, options: { priority?: boolean } = {}): Unsubscribe {
    const handlers = options.priority ? this.priorityKeyHandlers : this.keyHandlers;
    handlers.push(handler);
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  }

  /**
   * Observes every decoded key before dispatch, consumed or not.
   *
   * An {@link TUI.onKey} handler only hears what the focused component let
   * through, which is right for handling and wrong for noticing — "the user
   * touched the keyboard" is a fact a host may need even when the editor
   * eats the keystroke (the mouse re-grab after a text selection lives on
   * exactly that fact). Observers cannot consume.
   */
  onKeyEvent(observer: (key: Key) => void): Unsubscribe {
    this.keyObservers.push(observer);
    return () => {
      const index = this.keyObservers.indexOf(observer);
      if (index !== -1) this.keyObservers.splice(index, 1);
    };
  }

  /**
   * Dispatches a key event: overlay first, then the focused component, then the
   * global handlers. Schedules a render if anything consumed it.
   *
   * @param key - Key to dispatch.
   * @returns `true` when the key was consumed.
   */
  dispatchKey(key: Key): boolean {
    for (const observer of [...this.keyObservers]) observer(key);
    let handled = false;
    for (const handler of [...this.priorityKeyHandlers]) {
      if (handler(key) === true) {
        handled = true;
        break;
      }
    }
    const target = this.overlayEntry?.component ?? this.focusedComponent;
    if (!handled) handled = target?.handleInput?.(key) ?? false;
    if (!handled) {
      for (const handler of [...this.keyHandlers]) {
        if (handler(key) === true) {
          handled = true;
          break;
        }
      }
    }
    this.requestRender();
    return handled;
  }

  /** Feeds a raw terminal input chunk through the key decoder and dispatches it. */
  feedInput(data: string): void {
    for (const key of this.decoder.push(data)) this.dispatchKey(key);
    this.armEscapeTimer();
    this.armPasteTimer();
  }

  private armEscapeTimer(): void {
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    if (this.decoder.pending === "") return;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      for (const key of this.decoder.flush()) this.dispatchKey(key);
    }, this.options.escapeTimeout);
    this.escapeTimer.unref?.();
  }

  /**
   * The watchdog for a bracketed paste whose `ESC[201~` never arrives.
   *
   * Re-armed on every chunk, so it only fires once the terminal has been silent
   * for {@link TUIOptions.pasteTimeout} — long enough that a live terminal
   * pacing a long paste never trips it, and short enough that one that dies
   * mid-paste does not leave the UI treating the next keystroke as content.
   */
  private armPasteTimer(): void {
    if (this.pasteTimer !== undefined) {
      clearTimeout(this.pasteTimer);
      this.pasteTimer = undefined;
    }
    if (!this.decoder.pasting) return;
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = undefined;
      for (const key of this.decoder.endPaste()) this.dispatchKey(key);
    }, this.options.pasteTimeout);
    this.pasteTimer.unref?.();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /** `true` between {@link TUI.start} and {@link TUI.stop}. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Puts the terminal into raw mode, subscribes to input and resize, and paints the
   * first frame.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.options.mode === "screen") {
      this.terminal.enterAltScreen?.();
      this.terminal.enableMouse?.();
    }
    this.terminal.enterRawMode();
    this.terminal.enableBracketedPaste();
    this.terminal.enableFocusReporting?.();
    this.terminal.enableKeyboardEnhancements?.();
    this.unsubscribers.push(this.terminal.onInput((data) => this.feedInput(data)));
    if (this.options.autoResize) {
      this.unsubscribers.push(this.terminal.onResize(() => this.handleResize()));
    }
    this.renderNow();
  }

  /** Restores the terminal and leaves the cursor on a fresh line below the UI. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.frameTimer !== undefined) {
      clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
    }
    if (this.escapeTimer !== undefined) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    if (this.pasteTimer !== undefined) {
      clearTimeout(this.pasteTimer);
      this.pasteTimer = undefined;
    }
    if (this.resizeTimer !== undefined) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
      this.composer.resume();
    }
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];

    // Popped before the alternate screen closes: kitty scopes the keyboard
    // stack to the screen buffer, so a pop issued after the switch would land
    // on the main screen's stack instead of undoing this session's push.
    this.terminal.disableKeyboardEnhancements?.();
    if (this.options.mode === "screen") {
      // Drop the theme canvas (and any other attribute) *before* the shell's
      // screen comes back, or its prompt inherits the tint.
      this.terminal.write(RESET_SGR);
      // Leaving the alternate screen restores the shell exactly as it was.
      this.terminal.disableMouse?.();
      this.terminal.exitAltScreen?.();
    } else {
      // Park the cursor just below the rendered block so the shell prompt lands cleanly.
      const last = Math.max(0, this.composer.lines.length - 1);
      this.terminal.write(cursorDown(Math.max(0, last - this.composer.row)));
      this.terminal.write("\r\n");
    }
    this.terminal.showCursor();
    this.terminal.disableFocusReporting?.();
    this.terminal.disableBracketedPaste();
    this.terminal.exitRawMode();
  }

  /** Stops the UI and disposes the terminal. */
  dispose(): void {
    this.stop();
    this.terminal.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Marks the whole screen dirty so the next render is a full repaint. Also clears
   * per-component render caches.
   */
  /**
   * Declare that the terminal's own default background has been set to the
   * theme's ground (via OSC 11), so the canvas stops painting per-cell
   * backgrounds and every cell — painted, erased, and the window margin —
   * renders through the terminal's single, uniformly-composited ground.
   * Screen mode only; a no-op flag anywhere else. Takes effect next frame.
   */
  setGroundOwner(owner: "cells" | "terminal"): void {
    if (this.groundOwner === owner) return;
    this.groundOwner = owner;
    this.invalidate();
    this.requestRender();
  }

  invalidate(): void {
    this.forceRepaint = true;
    for (const component of this.componentList) component.invalidate?.();
    this.overlayEntry?.component.invalidate?.();
  }

  /** One frame per this many milliseconds while events flood in (~60fps). */
  private static readonly FRAME_INTERVAL_MS = 16;

  /**
   * Schedules a render. Multiple calls within the same synchronous block
   * collapse into a single frame (microtask), and calls arriving faster than
   * the frame interval collapse into one trailing frame — a wheel flick or a
   * fast stream repaints at a steady ~60fps instead of once per stdin chunk,
   * which is the difference between smooth scrolling and shearing. The first
   * render after quiet stays on the microtask queue, so a lone keystroke
   * never waits on the governor.
   */
  requestRender(): void {
    // Before start() there is nothing to paint INTO: in screen mode the
    // alternate screen is not open yet, so an early scheduled render would
    // write an absolute-addressed frame straight into the user's shell.
    // start() renders the first frame itself, so a pre-start request needs
    // no memory at all. (renderNow() stays unguarded — tests drive an
    // unstarted TUI through it deliberately.)
    if (!this.running) return;
    if (this.renderScheduled || this.frameTimer !== undefined) return;
    const since = Date.now() - this.lastRenderAt;
    if (since < TUI.FRAME_INTERVAL_MS) {
      this.frameTimer = setTimeout(() => {
        this.frameTimer = undefined;
        this.renderNow();
      }, TUI.FRAME_INTERVAL_MS - since);
      return;
    }
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      this.renderNow();
    });
  }

  /** Renders synchronously, bypassing the microtask scheduler. */
  renderNow(): void {
    this.lastRenderAt = Date.now();
    const width = Math.max(1, this.terminal.columns);
    const height = Math.max(1, this.terminal.rows);
    const frame = this.buildFrame(width, height);

    const manage = this.options.manageCursor;
    this.composer.submitFrame({
      lines: frame.lines,
      cursor: manage ? frame.cursor : undefined,
      width,
      height,
      forceRepaint: this.forceRepaint,
    });
    this.forceRepaint = false;
    this.composer.flush();

    // Mid-resize the cursor stays hidden; the settle repaint restores it.
    if (manage && this.resizeTimer === undefined) {
      if (frame.cursor && frame.lines.length > 0) this.terminal.showCursor();
      else this.terminal.hideCursor();
    }
  }

  /** Rows left for the height-aware component after fixed components render. */
  private flexHeight(width: number, height: number): number {
    let fixed = 0;
    for (const component of this.componentList) {
      if (component.renderArea) continue;
      fixed += component.render(width).length;
    }
    return Math.max(1, height - fixed);
  }

  /**
   * Coalesces a burst of resize events into one clean repaint.
   *
   * See {@link TUIOptions.resizeSettleMs}: the first event of a burst erases
   * the live block (one step from the painted size, where the erase is
   * near-exact on any emulator) and suspends painting; each further event
   * re-arms the settle timer; the settle does a single full repaint at the
   * final size.
   */
  private handleResize(): void {
    const settleMs = this.options.resizeSettleMs;
    if (settleMs <= 0 || this.options.mode === "screen") {
      // Screen mode repaints on every event: absolute addressing has no erase
      // arithmetic to get wrong, so mid-drag frames are always safe — this is
      // what makes the resize feel live rather than settled-after-the-fact.
      this.invalidate();
      this.renderNow();
      return;
    }
    const width = Math.max(1, this.terminal.columns);
    const height = Math.max(1, this.terminal.rows);
    if (this.resizeTimer === undefined) {
      if (this.options.manageCursor) this.terminal.hideCursor();
      this.composer.suspend();
    } else {
      clearTimeout(this.resizeTimer);
    }
    // The old block stays on screen through the drag — the terminal rewraps
    // it natively, so nothing blinks — and the settle repaint replaces it in
    // one atomic write. The one exception: a block about to outgrow the
    // viewport is erased right now, while its rows can still be reached.
    if (this.composer.overflowsAt(width, height)) this.composer.collapse(width, height);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.composer.resume();
      this.invalidate();
      this.renderNow();
    }, settleMs);
    this.resizeTimer.unref?.();
  }

  /**
   * Prints lines *above* the live block, into the terminal's scrollback, as a
   * single atomic write together with the repaint: the block is erased, the
   * lines are written where it stood, and the current frame is repainted below
   * them. Very large insertions are written in slices so the event loop keeps
   * breathing; the rows themselves are never dropped.
   *
   * @param lines - Finished transcript rows (already styled).
   */
  printAbove(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const width = Math.max(1, this.terminal.columns);
    const height = Math.max(1, this.terminal.rows);
    const frame = this.buildFrame(width, height);
    this.composer.submitContent(lines);
    this.composer.submitFrame({
      lines: frame.lines,
      cursor: this.options.manageCursor ? frame.cursor : undefined,
      width,
      height,
    });
    this.composer.flush();
    if (this.options.manageCursor && this.resizeTimer === undefined) {
      if (frame.cursor && frame.lines.length > 0) this.terminal.showCursor();
      else this.terminal.hideCursor();
    }
  }

  /**
   * Builds the next frame without writing anything. Exposed for tests and for
   * callers that want to inspect the composed output.
   *
   * @param width - Available columns (defaults to the terminal width).
   * @param height - Available rows (defaults to the terminal height).
   */
  buildFrame(width = this.terminal.columns, height = this.terminal.rows): Frame {
    const lines: string[] = [];
    let cursor: CursorPosition | undefined;

    // Screen mode lays the one height-aware component (the flexible region)
    // out with exactly the rows left over after the fixed components.
    const flex = this.options.mode === "screen" ? this.flexHeight(width, height) : undefined;

    for (const component of this.componentList) {
      const offset = lines.length;
      const rendered =
        flex !== undefined && component.renderArea
          ? component.renderArea(width, flex)
          : component.render(width);
      lines.push(...rendered);
      if (component === this.focusedComponent && !this.overlayEntry) {
        const local = component.getCursor?.();
        if (local) cursor = { row: offset + local.row, col: local.col };
      }
    }

    if (this.overlayEntry) {
      const result = this.compositeOverlay(lines, width, height, this.overlayEntry);
      lines.length = 0;
      lines.push(...result.lines);
      cursor = result.cursor;
    }

    const normalized = this.normalize(lines, width);
    return this.clip(normalized, height, cursor);
  }

  /** Enforces the "no line wider than the terminal" invariant. */
  private normalize(lines: string[], width: number): string[] {
    const out: string[] = [];
    for (const line of lines) {
      if (stringWidth(line) <= width) {
        out.push(line);
        continue;
      }
      if (this.options.overflow === "wrap") out.push(...wrapText(line, width));
      else out.push(truncateToWidth(line, width));
    }
    return out;
  }

  /** Enforces the "frame fits on screen" invariant by keeping the trailing rows. */
  private clip(lines: string[], height: number, cursor?: CursorPosition): Frame {
    if (lines.length <= height) return cursor ? { lines, cursor } : { lines };
    const drop = lines.length - height;
    const clipped = lines.slice(drop);
    if (!cursor) return { lines: clipped };
    const row = cursor.row - drop;
    return row >= 0 ? { lines: clipped, cursor: { row, col: cursor.col } } : { lines: clipped };
  }

  private compositeOverlay(
    base: string[],
    width: number,
    height: number,
    entry: OverlayEntry,
  ): Frame {
    const { component, options } = entry;
    const overlayWidth = resolveOverlayWidth(options.width, width);
    const overlayLines = component
      .render(overlayWidth)
      .map((l) => truncateToWidth(l, overlayWidth));

    const canvasHeight = Math.max(base.length, Math.min(height, base.length || height));
    const lines = [...base];
    while (lines.length < canvasHeight) lines.push("");

    const row = resolveOverlayRow(options, lines.length, overlayLines.length);
    const col = resolveOverlayColumn(options, width, overlayWidth);

    while (lines.length < row + overlayLines.length) lines.push("");

    for (let i = 0; i < overlayLines.length; i++) {
      const index = row + i;
      lines[index] = overlayLine(lines[index] ?? "", overlayLines[i] ?? "", col, width);
    }

    let cursor: CursorPosition | undefined;
    const local = component.getCursor?.();
    if (local) cursor = { row: row + local.row, col: col + local.col };
    return cursor ? { lines, cursor } : { lines };
  }
}

/* -------------------------------------------------------------------------- */
/* Overlay geometry helpers                                                    */
/* -------------------------------------------------------------------------- */

function resolveOverlayWidth(requested: number | undefined, available: number): number {
  if (requested === undefined) return Math.max(1, Math.min(available, Math.floor(available * 0.7)));
  if (requested > 0 && requested <= 1) return Math.max(1, Math.round(available * requested));
  return Math.max(1, Math.min(available, Math.floor(requested)));
}

function resolveOverlayRow(options: OverlayOptions, total: number, overlayHeight: number): number {
  if (options.row !== undefined) return Math.max(0, options.row);
  const slack = Math.max(0, total - overlayHeight);
  switch (options.align ?? "middle") {
    case "top":
      return 0;
    case "bottom":
      return slack;
    default:
      return Math.floor(slack / 2);
  }
}

function resolveOverlayColumn(
  options: OverlayOptions,
  width: number,
  overlayWidth: number,
): number {
  if (options.col !== undefined) return Math.max(0, options.col);
  const slack = Math.max(0, width - overlayWidth);
  switch (options.justify ?? "center") {
    case "left":
      return 0;
    case "right":
      return slack;
    default:
      return Math.floor(slack / 2);
  }
}

/**
 * Splices `over` into `base` starting at display column `col`, preserving the
 * surrounding content and never exceeding `width` columns.
 *
 * @param base - The line being drawn over.
 * @param over - The overlay content.
 * @param col - Display column at which the overlay starts.
 * @param width - Total line width.
 */
export function overlayLine(base: string, over: string, col: number, width: number): string {
  const overWidth = stringWidth(over);
  const left = padToWidth(sliceByWidth(base, 0, col), col);
  const right = sliceByWidth(base, col + overWidth, width);
  return truncateToWidth(left + over + right, width, "");
}
