import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "./ansi.js";
import { detectScrollRegionSupport, ProcessTerminal, TestTerminal } from "./terminal.js";

/** A minimal non-TTY stand-in for `process.stdout`/`process.stdin`. */
function fakeStream(written?: string[]): NodeJS.WriteStream & NodeJS.ReadStream {
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & NodeJS.ReadStream;
  stream.isTTY = false;
  stream.write = ((data: string) => {
    written?.push(data);
    return true;
  }) as NodeJS.WriteStream["write"];
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  return stream;
}

describe("TestTerminal", () => {
  it("reports the configured size and TTY-ness", () => {
    const term = new TestTerminal({ columns: 40, rows: 12, isTTY: false });
    expect(term.columns).toBe(40);
    expect(term.rows).toBe(12);
    expect(term.isTTY).toBe(false);
  });

  it("captures writes individually and concatenated", () => {
    const term = new TestTerminal();
    term.write("a");
    term.write("b");
    expect(term.writes).toEqual(["a", "b"]);
    expect(term.output).toBe("ab");
    term.clearWrites();
    expect(term.output).toBe("");
  });

  it("ignores empty writes", () => {
    const term = new TestTerminal();
    term.write("");
    expect(term.writes).toHaveLength(0);
  });

  it("delivers injected input to every listener", () => {
    const term = new TestTerminal();
    const seen: string[] = [];
    const off = term.onInput((data) => seen.push(data));
    term.injectInput("hi");
    off();
    term.injectInput("ignored");
    expect(seen).toEqual(["hi"]);
  });

  it("notifies resize listeners with the new size", () => {
    const term = new TestTerminal({ columns: 80, rows: 24 });
    const sizes: Array<{ columns: number; rows: number }> = [];
    term.onResize((size) => sizes.push(size));
    term.resize(100, 30);
    expect(sizes).toEqual([{ columns: 100, rows: 30 }]);
    expect(term.columns).toBe(100);
    expect(term.rows).toBe(30);
  });

  it("tracks raw mode", () => {
    const term = new TestTerminal();
    expect(term.isRawMode).toBe(false);
    term.enterRawMode();
    expect(term.isRawMode).toBe(true);
    term.exitRawMode();
    expect(term.isRawMode).toBe(false);
  });

  it("emits cursor visibility codes only on a state change", () => {
    const term = new TestTerminal();
    term.showCursor();
    expect(term.output).toBe("");
    term.hideCursor();
    term.hideCursor();
    expect(term.output).toBe(HIDE_CURSOR);
    term.showCursor();
    expect(term.output).toBe(HIDE_CURSOR + SHOW_CURSOR);
    expect(term.isCursorVisible).toBe(true);
  });

  it("emits the bracketed-paste enable sequence", () => {
    const term = new TestTerminal();
    term.enableBracketedPaste();
    expect(term.output).toBe(ENABLE_BRACKETED_PASTE);
    expect(term.isBracketedPasteEnabled).toBe(true);
  });

  it("converts 0-based cursor moves to 1-based ANSI", () => {
    const term = new TestTerminal();
    term.moveCursor(2, 3);
    expect(term.output).toBe("\u001b[3;4H");
  });

  it("drops listeners on dispose", () => {
    const term = new TestTerminal();
    let calls = 0;
    term.onInput(() => calls++);
    term.dispose();
    term.injectInput("x");
    expect(calls).toBe(0);
    expect(term.isDisposed).toBe(true);
  });
});

/**
 * A stdout whose writes complete only when the test says so — which is how a
 * real terminal behaves once it is slower than the app that feeds it.
 */
function slowStream(pending: ((error?: Error) => void)[]): NodeJS.WriteStream {
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
  stream.isTTY = false;
  stream.write = ((_data: string, callback?: (error?: Error) => void) => {
    if (callback) pending.push(callback);
    return true; // Node's own high-water mark never trips: 64 KB is ~10 frames.
  }) as NodeJS.WriteStream["write"];
  return stream;
}

describe("ProcessTerminal backpressure", () => {
  it("reports a full pipe while a previous write is still in flight", () => {
    // Node reports backpressure on `process.stdout` only past a 64 KB
    // high-water mark, which on a slow terminal is seconds of stale frames
    // queued ahead of the newest one — latest-wins never gets to engage.
    const pending: ((error?: Error) => void)[] = [];
    const term = new ProcessTerminal({
      stdout: slowStream(pending),
      stdin: fakeStream(),
      handleSignals: false,
    });

    expect(term.writeChunk("frame one")).toBe(true);
    expect(term.writeChunk("frame two")).toBe(false);
    expect(term.writeChunk("frame three")).toBe(false);
    term.dispose();
  });

  it("drains once every write has completed, and not before", () => {
    const pending: ((error?: Error) => void)[] = [];
    const term = new ProcessTerminal({
      stdout: slowStream(pending),
      stdin: fakeStream(),
      handleSignals: false,
    });
    term.writeChunk("a");
    term.writeChunk("b");
    let drained = 0;
    term.onceDrain(() => drained++);
    expect(drained).toBe(0);

    pending.shift()?.();
    expect(drained).toBe(0); // one still in flight
    pending.shift()?.();
    expect(drained).toBe(1);
    expect(term.writeChunk("c")).toBe(true);
    term.dispose();
  });

  it("releases drain waiters on dispose so nothing waits on a dead stream", () => {
    const pending: ((error?: Error) => void)[] = [];
    const term = new ProcessTerminal({
      stdout: slowStream(pending),
      stdin: fakeStream(),
      handleSignals: false,
    });
    term.writeChunk("a");
    let drained = 0;
    term.onceDrain(() => drained++);
    term.dispose();
    expect(drained).toBe(1);
  });

  it("serves a drain callback immediately when nothing is in flight", () => {
    const pending: ((error?: Error) => void)[] = [];
    const term = new ProcessTerminal({
      stdout: slowStream(pending),
      stdin: fakeStream(),
      handleSignals: false,
    });
    let drained = 0;
    term.onceDrain(() => drained++);
    expect(drained).toBe(1);
    term.dispose();
  });
});

describe("ProcessTerminal signal cleanup", () => {
  // Ctrl-\ delivers SIGQUIT; without a handler for it, the process dies via the
  // default disposition and skips ProcessTerminal.restore(), leaving the real
  // terminal in raw mode/alt screen with a hidden cursor.
  it("registers a SIGQUIT handler alongside SIGINT/SIGTERM/SIGHUP", () => {
    const before = process.listenerCount("SIGQUIT");
    const term = new ProcessTerminal({ stdout: fakeStream(), stdin: fakeStream() });
    expect(process.listenerCount("SIGQUIT")).toBe(before + 1);
    term.dispose();
    expect(process.listenerCount("SIGQUIT")).toBe(before);
  });

  it("removes SIGQUIT (and the other signal handlers) on dispose", () => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
    const before = signals.map((s) => process.listenerCount(s));
    const term = new ProcessTerminal({ stdout: fakeStream(), stdin: fakeStream() });
    term.dispose();
    const after = signals.map((s) => process.listenerCount(s));
    expect(after).toEqual(before);
  });

  it("turns bracketed paste back off on the process-exit restore path", () => {
    // Every teardown that is not an ordinary stop() — a crash, `process.exit`,
    // SIGINT, SIGTERM, SIGHUP, SIGQUIT — arrives through this one listener.
    // Leaving ?2004h set corrupts every later shell prompt, so it has to be
    // as reliable as the alt-screen and raw-mode restore beside it.
    const written: string[] = [];
    const before = new Set(process.listeners("exit"));
    const term = new ProcessTerminal({ stdout: fakeStream(written), stdin: fakeStream() });
    const onExit = process.listeners("exit").find((listener) => !before.has(listener));
    term.enableBracketedPaste();
    term.enterAltScreen();
    written.length = 0;

    onExit?.call(process, 0);
    expect(written.join("")).toContain(DISABLE_BRACKETED_PASTE);
    expect(written.join("")).toContain("[?1049l");
    term.dispose();
  });

  it("turns bracketed paste back off on dispose", () => {
    const written: string[] = [];
    const term = new ProcessTerminal({ stdout: fakeStream(written), stdin: fakeStream() });
    term.enableBracketedPaste();
    written.length = 0;
    term.dispose();
    expect(written.join("")).toContain(DISABLE_BRACKETED_PASTE);
    // …and only once: a second teardown must not re-emit it.
    written.length = 0;
    term.dispose();
    expect(written).toEqual([]);
  });

  it("does not register signal handlers when handleSignals is false", () => {
    const before = process.listenerCount("SIGQUIT");
    const term = new ProcessTerminal({
      stdout: fakeStream(),
      stdin: fakeStream(),
      handleSignals: false,
    });
    expect(process.listenerCount("SIGQUIT")).toBe(before);
    term.dispose();
  });
});

describe("detectScrollRegionSupport", () => {
  it("is on for a normal xterm TTY", () => {
    expect(detectScrollRegionSupport(true, { TERM: "xterm-256color" })).toBe(true);
  });

  it("is off for TERM=dumb, which has no cursor addressing at all", () => {
    expect(detectScrollRegionSupport(true, { TERM: "dumb" })).toBe(false);
  });

  it("is off for a non-TTY stream regardless of TERM", () => {
    expect(detectScrollRegionSupport(false, { TERM: "xterm-256color" })).toBe(false);
  });

  it("is off behind the ARCTURN_NO_SCROLL_REGION escape hatch", () => {
    expect(
      detectScrollRegionSupport(true, { TERM: "xterm-256color", ARCTURN_NO_SCROLL_REGION: "1" }),
    ).toBe(false);
  });

  it("ignores an empty ARCTURN_NO_SCROLL_REGION", () => {
    expect(
      detectScrollRegionSupport(true, { TERM: "xterm-256color", ARCTURN_NO_SCROLL_REGION: "" }),
    ).toBe(true);
  });
});
