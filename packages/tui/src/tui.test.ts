import { beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, setColorLevel, stripAnsi } from "./ansi.js";
import { createKey, type Key, KeyDecoder } from "./keys.js";
import { TestTerminal } from "./terminal.js";
import { darkTheme, lightTheme, setTheme } from "./theme.js";
import { type Component, overlayLine, TUI } from "./tui.js";
import { stringWidth } from "./width.js";

const ESC = "\u001b";
const ERASE_LINE = `${ESC}[2K`;
const ERASE_DOWN = `${ESC}[0J`;

/** Minimal component that renders whatever lines it is given. */
class Lines implements Component {
  constructor(public lines: string[]) {}
  render(): string[] {
    return [...this.lines];
  }
}

/** Component that records keys and optionally consumes them. */
class Recorder implements Component {
  readonly seen: Key[] = [];
  constructor(
    private readonly label: string,
    private readonly consume = true,
  ) {}
  render(): string[] {
    return [this.label];
  }
  handleInput(key: Key): boolean {
    this.seen.push(key);
    return this.consume;
  }
}

function makeTui(lines: string[], columns = 20, rows = 10) {
  const terminal = new TestTerminal({ columns, rows });
  const tui = new TUI(terminal, { manageCursor: false });
  const component = new Lines(lines);
  tui.add(component);
  tui.renderNow();
  terminal.clearWrites();
  return { terminal, tui, component };
}

beforeEach(() => {
  setColorLevel(ColorLevel.None);
});

describe("initial paint", () => {
  it("writes every line separated by CRLF, each preceded by erase-line", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["a", "b", "c"]));
    tui.renderNow();
    expect(terminal.output).toBe(`${ERASE_LINE}a\r\n${ERASE_LINE}b\r\n${ERASE_LINE}c`);
  });

  it("writes nothing for an empty component list", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    tui.renderNow();
    expect(terminal.output).toBe("");
  });
});

describe("differential rendering", () => {
  it("writes nothing when the frame is unchanged", () => {
    const { terminal, tui } = makeTui(["a", "b", "c"]);
    tui.renderNow();
    expect(terminal.output).toBe("");
  });

  it("rewrites only the changed line", () => {
    const { terminal, tui, component } = makeTui(["a", "b", "c"]);
    component.lines[1] = "B";
    tui.renderNow();
    // Move up from the last row to row 1, return to column 0, erase, rewrite.
    expect(terminal.output).toBe(`${ESC}[1A\r${ERASE_LINE}B`);
    expect(terminal.output).not.toContain("a");
    expect(terminal.output).not.toContain("c");
  });

  it("rewrites a contiguous span covering all changes", () => {
    const { terminal, tui, component } = makeTui(["a", "b", "c", "d"]);
    component.lines[1] = "B";
    component.lines[3] = "D";
    tui.renderNow();
    const out = terminal.output;
    expect(out).toContain("B");
    expect(out).toContain("D");
    // The unchanged first line is never touched.
    expect(out.startsWith(`${ESC}[2A`)).toBe(true);
    expect(out).not.toContain("a");
  });

  it("scrolls in appended lines with a newline instead of a cursor move", () => {
    const { terminal, tui, component } = makeTui(["a", "b"]);
    component.lines.push("c");
    tui.renderNow();
    expect(terminal.output).toBe(`\r\n${ERASE_LINE}c`);
  });

  it("erases the surplus rows when the frame shrinks", () => {
    const { terminal, tui, component } = makeTui(["a", "b", "c", "d"]);
    component.lines = ["a", "b"];
    tui.renderNow();
    expect(terminal.output).toBe(`${ESC}[1A\r${ERASE_DOWN}`);
  });

  it("clears everything when the frame becomes empty", () => {
    const { terminal, tui, component } = makeTui(["a", "b"]);
    component.lines = [];
    tui.renderNow();
    expect(terminal.output).toContain(ERASE_DOWN);
  });

  it("keeps the tracked cursor row consistent across several frames", () => {
    const { terminal, tui, component } = makeTui(["a", "b", "c"]);
    component.lines = ["a", "b", "c", "d", "e"];
    tui.renderNow();
    terminal.clearWrites();
    component.lines[0] = "A";
    tui.renderNow();
    // From row 4 back up to row 0.
    expect(terminal.output).toBe(`${ESC}[4A\r${ERASE_LINE}A`);
  });
});

describe("resize", () => {
  it("repaints the whole frame when the width changes", () => {
    const { terminal, tui } = makeTui(["a", "b", "c"]);
    terminal.resize(30, 10);
    tui.renderNow();
    const out = terminal.output;
    expect(out.startsWith(`${ESC}[2A\r${ERASE_DOWN}`)).toBe(true);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
  });

  it("repaints the whole frame when the height changes", () => {
    const { terminal, tui } = makeTui(["a", "b", "c"]);
    terminal.resize(20, 20);
    tui.renderNow();
    expect(terminal.output).toContain(ERASE_DOWN);
  });

  it("climbs by the reflowed row count when the terminal narrows", () => {
    // Two 38-column lines plus "z", painted at 40 columns. After narrowing to
    // 20 columns the terminal rewraps each wide line onto two physical rows,
    // so reaching the block's top row takes 4 rows, not the 2 logical ones.
    const { terminal, tui } = makeTui(["x".repeat(38), "y".repeat(38), "z"], 40, 10);
    terminal.resize(20, 10);
    tui.renderNow();
    const out = terminal.output;
    expect(out.startsWith(`${ESC}[4A\r${ERASE_DOWN}`)).toBe(true);
    // The repaint after the erase must not climb a second time.
    expect(out.indexOf(ERASE_DOWN)).toBe(out.lastIndexOf(ERASE_DOWN));
  });

  it("never climbs beyond the viewport after a resize", () => {
    const lines = Array.from({ length: 8 }, () => "w".repeat(38));
    const { terminal, tui } = makeTui(lines, 40, 6);
    terminal.resize(20, 6);
    tui.renderNow();
    // 8 wide lines reflow to 16 rows, but only 5 rows are climbable.
    expect(terminal.output.startsWith(`${ESC}[5A\r${ERASE_DOWN}`)).toBe(true);
  });

  it("re-renders components at the new width", () => {
    const terminal = new TestTerminal({ columns: 10, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    const widths: number[] = [];
    tui.add({
      render(width: number): string[] {
        widths.push(width);
        return ["x"];
      },
    });
    tui.renderNow();
    terminal.resize(25, 10);
    tui.renderNow();
    expect(widths).toEqual([10, 25]);
  });
});

describe("layout invariants", () => {
  it("truncates lines wider than the terminal", () => {
    const terminal = new TestTerminal({ columns: 6, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["日本語日本語"]));
    const frame = tui.buildFrame();
    expect(frame.lines).toHaveLength(1);
    expect(stringWidth(frame.lines[0]!)).toBeLessThanOrEqual(6);
  });

  it("wraps instead of truncating in wrap mode", () => {
    const terminal = new TestTerminal({ columns: 6, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false, overflow: "wrap" });
    tui.add(new Lines(["日本語日本語"]));
    const frame = tui.buildFrame();
    expect(frame.lines).toEqual(["日本語", "日本語"]);
  });

  it("never emits a line wider than the terminal, even with styling", () => {
    setColorLevel(ColorLevel.TrueColor);
    const terminal = new TestTerminal({ columns: 8, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines([`${ESC}[1mhello world${ESC}[22m`, "日本語テキストです"]));
    for (const line of tui.buildFrame().lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(8);
    }
  });

  it("clips a frame taller than the terminal to its last rows", () => {
    const terminal = new TestTerminal({ columns: 10, rows: 3 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["1", "2", "3", "4", "5"]));
    expect(tui.buildFrame().lines).toEqual(["3", "4", "5"]);
  });
});

describe("overlays", () => {
  it("splices the overlay into the base lines at the requested position", () => {
    const terminal = new TestTerminal({ columns: 5, rows: 5 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["aaaaa", "bbbbb", "ccccc"]));
    tui.setOverlay(new Lines(["XX"]), { row: 1, col: 1, width: 2, focus: false });
    expect(tui.buildFrame().lines.slice(0, 3)).toEqual(["aaaaa", "bXXbb", "ccccc"]);
  });

  it("centres the overlay by default", () => {
    const terminal = new TestTerminal({ columns: 9, rows: 3 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["---------", "---------", "---------"]));
    tui.setOverlay(new Lines(["ab"]), { width: 2, focus: false });
    expect(tui.buildFrame().lines[1]).toBe("---ab----");
  });

  it("restores the previous focus when dismissed", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const base = new Recorder("base");
    const modal = new Recorder("modal");
    tui.add(base);
    tui.focus(base);
    tui.setOverlay(modal);
    expect(tui.focused).toBe(modal);
    tui.setOverlay(null);
    expect(tui.focused).toBe(base);
  });

  it("routes input to the overlay while it is shown", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const base = new Recorder("base");
    const modal = new Recorder("modal");
    tui.add(base);
    tui.focus(base);
    tui.setOverlay(modal);
    tui.dispatchKey(createKey("a"));
    expect(modal.seen).toHaveLength(1);
    expect(base.seen).toHaveLength(0);
  });
});

describe("overlayLine", () => {
  it("keeps the surrounding content and the total width", () => {
    expect(overlayLine("abcdef", "XY", 2, 6)).toBe("abXYef");
    expect(stringWidth(overlayLine("日本語", "X", 1, 6))).toBe(6);
  });
});

describe("focus and input", () => {
  it("cycles focus over input-capable components", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const a = new Recorder("a");
    const b = new Recorder("b");
    tui.add(new Lines(["static"]));
    tui.add(a);
    tui.add(b);
    tui.focusNext();
    expect(tui.focused).toBe(a);
    tui.focusNext();
    expect(tui.focused).toBe(b);
    tui.focusNext();
    expect(tui.focused).toBe(a);
    tui.focusPrevious();
    expect(tui.focused).toBe(b);
  });

  it("falls back to global handlers when the component declines the key", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const component = new Recorder("a", false);
    tui.add(component);
    tui.focus(component);
    const seen: Key[] = [];
    tui.onKey((key) => {
      seen.push(key);
      return true;
    });
    expect(tui.dispatchKey(createKey("q"))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("decodes raw input chunks into key events", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const component = new Recorder("a");
    tui.add(component);
    tui.focus(component);
    tui.feedInput(`${ESC}[A`);
    expect(component.seen.map((k) => k.name)).toEqual(["up"]);
  });

  it("surfaces bracketed paste as a single event", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const component = new Recorder("a");
    tui.add(component);
    tui.focus(component);
    tui.feedInput(`${ESC}[200~pasted${ESC}[201~`);
    expect(component.seen).toHaveLength(1);
    expect(component.seen[0]?.paste).toBe("pasted");
  });
});

describe("render scheduling", () => {
  it("collapses several requestRender calls into one frame", async () => {
    const { terminal, tui, component } = makeTui(["a"]);
    tui.start();
    // start() just painted, so an immediate request lands inside the frame
    // governor's ~60fps window; let the window pass so this test measures
    // coalescing, not the governor (which has its own test below).
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.clearWrites();
    component.lines = ["b"];
    tui.requestRender();
    tui.requestRender();
    tui.requestRender();
    expect(terminal.writes).toHaveLength(0);
    await Promise.resolve();
    expect(terminal.writes).toHaveLength(1);
    expect(stripAnsi(terminal.output)).toContain("b");
    tui.stop();
  });

  it("governs a flood to one trailing frame instead of one frame per event", async () => {
    // A wheel flick delivers many stdin chunks in a few milliseconds; each
    // used to paint its own full frame. Requests inside the frame interval
    // now collapse into a single trailing frame — smooth scrolling is a
    // steady ~60fps, not shearing at chunk rate.
    const { terminal, tui, component } = makeTui(["a"]);
    tui.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.clearWrites();
    component.lines = ["b"];
    tui.requestRender();
    await Promise.resolve(); // first request after quiet: immediate frame
    const afterFirst = terminal.writes.length;
    expect(afterFirst).toBe(1);
    component.lines = ["c"];
    for (let i = 0; i < 10; i += 1) {
      tui.requestRender();
      await Promise.resolve();
    }
    // Still within the frame window: nothing painted yet.
    expect(terminal.writes.length).toBe(afterFirst);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // One trailing frame carried the final state.
    expect(terminal.writes.length).toBe(afterFirst + 1);
    expect(stripAnsi(terminal.output)).toContain("c");
    tui.stop();
  });

  it("defers a pre-start request to start()'s own first frame", async () => {
    // In screen mode an early scheduled render would write an absolute-
    // addressed frame straight into the user's shell — the alternate screen
    // is not open yet. Nothing may reach the terminal until start().
    const terminal = new TestTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["a"]));
    tui.requestRender();
    await Promise.resolve();
    expect(terminal.writes).toHaveLength(0);
    tui.start();
    expect(stripAnsi(terminal.output)).toContain("a");
    tui.stop();
  });
});

describe("cursor management", () => {
  it("positions the hardware cursor reported by the focused component", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal);
    const component: Component = {
      render: () => ["one", "two"],
      handleInput: () => false,
      getCursor: () => ({ row: 1, col: 2 }),
    };
    tui.add(component);
    tui.focus(component);
    tui.renderNow();
    // Already on row 1 after painting two lines, so only a column move is needed.
    expect(terminal.output.endsWith(`${ESC}[3G`)).toBe(true);
    expect(terminal.isCursorVisible).toBe(true);
  });

  it("hides the cursor when nothing reports one", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal);
    tui.add(new Lines(["x"]));
    tui.renderNow();
    expect(terminal.isCursorVisible).toBe(false);
  });
});

describe("lifecycle", () => {
  it("enters raw mode and enables bracketed paste on start", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["x"]));
    tui.start();
    expect(terminal.isRawMode).toBe(true);
    expect(terminal.isBracketedPasteEnabled).toBe(true);
    tui.stop();
    expect(terminal.isRawMode).toBe(false);
    expect(terminal.isBracketedPasteEnabled).toBe(false);
  });

  it("repaints synchronously on a resize event when resizeSettleMs is 0", () => {
    const terminal = new TestTerminal({ columns: 10, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false, resizeSettleMs: 0 });
    tui.add(new Lines(["abc"]));
    tui.start();
    terminal.clearWrites();
    terminal.resize(20, 10);
    expect(terminal.output).toContain("abc");
  });

  it("holds painting through a resize burst and repaints once settled", async () => {
    const terminal = new TestTerminal({ columns: 10, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false, resizeSettleMs: 15 });
    tui.add(new Lines(["abc", "def"]));
    tui.start();
    terminal.clearWrites();
    terminal.resize(20, 10);
    terminal.resize(30, 10);
    terminal.resize(40, 10);
    // Mid-drag nothing is written: the old block stays visible (the terminal
    // rewraps it natively), so there is nothing to blink.
    expect(terminal.output).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // One clean erase-and-repaint at the final size.
    expect(terminal.output).toContain(ERASE_DOWN);
    expect(terminal.output).toContain("abc");
    expect(terminal.output).toContain("def");
    tui.stop();
  });

  it("erases the block mid-burst when it is about to outgrow the viewport", () => {
    const terminal = new TestTerminal({ columns: 40, rows: 12 });
    const tui = new TUI(terminal, { manageCursor: false, resizeSettleMs: 15 });
    tui.add(new Lines(Array.from({ length: 8 }, (_, i) => `row ${i} ${"x".repeat(30)}`)));
    tui.start();
    terminal.clearWrites();
    // Narrowing to 20 columns rewraps every row onto two physical rows: the
    // 8-row block becomes 16 rows in a 12-row viewport. Waiting for the
    // settle would let its top rows scroll into unreachable history, so the
    // erase happens immediately.
    terminal.resize(20, 12);
    expect(terminal.output).toContain(ERASE_DOWN);
    tui.stop();
  });

  it("keeps printAbove content queued through a resize burst", async () => {
    const terminal = new TestTerminal({ columns: 10, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false, resizeSettleMs: 15 });
    tui.add(new Lines(["live"]));
    tui.start();
    terminal.clearWrites();
    terminal.resize(20, 10);
    tui.printAbove(["transcript row"]);
    expect(terminal.output).not.toContain("transcript row");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(terminal.output).toContain("transcript row");
    expect(terminal.output).toContain("live");
    tui.stop();
  });

  it("routes terminal input through the decoder once started", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    const component = new Recorder("a");
    tui.add(component);
    tui.focus(component);
    tui.start();
    terminal.injectInput("hi");
    tui.stop();
    expect(component.seen.map((k) => k.name)).toEqual(["h", "i"]);
  });
});

describe("KeyDecoder integration", () => {
  it("shares the same decoding as the standalone decoder", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}[1;5D`).map((k) => k.name)).toEqual(["left"]);
  });
});

describe("bracketed paste", () => {
  /** A TUI wired to a recorder, with both input timers tuned for the test. */
  function pasteTui(options: { escapeTimeout?: number; pasteTimeout?: number } = {}) {
    const terminal = new TestTerminal({ columns: 40, rows: 6 });
    const tui = new TUI(terminal, {
      manageCursor: false,
      escapeTimeout: options.escapeTimeout ?? 1,
      pasteTimeout: options.pasteTimeout ?? 10_000,
    });
    const recorder = new Recorder("rec");
    tui.add(recorder);
    tui.focus(recorder);
    tui.start();
    return { terminal, tui, recorder };
  }

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("announces the mode on start and turns it off again on stop", () => {
    const terminal = new TestTerminal();
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["x"]));
    tui.start();
    expect(terminal.output).toContain(`${ESC}[?2004h`);
    terminal.clearWrites();
    tui.stop();
    // Leaving ?2004h set would corrupt the shell the session exits back into.
    expect(terminal.output).toContain(`${ESC}[?2004l`);
  });

  it("survives the escape timer firing between the chunks of one paste", async () => {
    // The reported bug: the escape resolver fired during a paste the terminal
    // was still pacing, so the marker's ESC became an interrupt and "[200~"
    // became text. A paste is one paste however long the terminal takes.
    const { recorder, tui } = pasteTui({ escapeTimeout: 1 });
    const line = "/workflow rag-setup Build a small RAG app over ./corpus";
    tui.feedInput(`${ESC}[200~${line.slice(0, 20)}`);
    await settle(30);
    expect(recorder.seen).toEqual([]);
    tui.feedInput(line.slice(20));
    await settle(30);
    expect(recorder.seen).toEqual([]);
    tui.feedInput(`${ESC}[201~`);
    expect(recorder.seen.map((key) => key.name)).toEqual(["paste"]);
    expect(recorder.seen[0]?.paste).toBe(line);
    tui.stop();
  });

  it("delivers an unterminated paste once the watchdog fires, and keeps decoding", async () => {
    const { recorder, tui } = pasteTui({ escapeTimeout: 1, pasteTimeout: 20 });
    tui.feedInput(`${ESC}[200~half a line`);
    await settle(5);
    expect(recorder.seen).toEqual([]);
    await settle(60);
    expect(recorder.seen.map((key) => key.name)).toEqual(["paste"]);
    expect(recorder.seen[0]?.paste).toBe("half a line");
    // Recovered, not wedged: the very next keystroke is a keystroke again.
    tui.feedInput("\r");
    expect(recorder.seen.map((key) => key.name)).toEqual(["paste", "enter"]);
    tui.stop();
  });

  it("keeps the watchdog off the clock while a paste is still arriving", async () => {
    // Two constraints hold this test together, and both must survive any
    // retuning: each gap must be shorter than the timeout (or the watchdog
    // fires and the test is meaningless), and the gaps must SUM to more than
    // the timeout (or an implementation that never re-arms would pass). The
    // slack between them is what a loaded runner eats — at 25ms against 40ms
    // there was 15ms of it, and windows-latest/node22 ate that during a
    // release. 60ms against 200ms across five chunks keeps both properties
    // with 140ms of room: a non-re-arming build still fires on chunk four.
    const { recorder, tui } = pasteTui({ escapeTimeout: 1, pasteTimeout: 200 });
    for (let i = 0; i < 5; i++) {
      tui.feedInput(i === 0 ? `${ESC}[200~chunk${i} ` : `chunk${i} `);
      await settle(60);
      expect(recorder.seen).toEqual([]);
    }
    tui.feedInput(`${ESC}[201~`);
    expect(recorder.seen[0]?.paste).toBe("chunk0 chunk1 chunk2 chunk3 chunk4 ");
    tui.stop();
  });
});

describe("ground ownership", () => {
  it("stops painting per-cell grounds once the terminal owns the canvas", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.renderNow();
    const GROUND = "\u001b[48;2;250;246;239m";
    const INK = "\u001b[38;2;36;29;21m";
    expect(terminal.output).toContain(GROUND); // cells own the ground by default

    terminal.clearWrites();
    tui.setGroundOwner("terminal");
    tui.renderNow();
    const owned = terminal.output;
    // The theme's ink still travels with every row…
    expect(owned).toContain(`${INK}hello`);
    // …but no cell paints the ground any more: the terminal's synced default
    // background renders every cell in ONE composited shade (margin included).
    expect(owned).not.toContain(GROUND);

    setTheme(darkTheme);
    setColorLevel(ColorLevel.None);
  });
});

describe("screen-mode teardown", () => {
  it("resets SGR fully before leaving the alternate screen", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 6 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.start();
    terminal.clearWrites();
    tui.stop();

    const out = terminal.output;
    const reset = out.indexOf(`${ESC}[0m`);
    const exit = out.indexOf(`${ESC}[?1049l`);
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(exit).toBeGreaterThanOrEqual(0);
    // The tint must be gone before the shell's screen comes back.
    expect(reset).toBeLessThan(exit);
  });
});

describe("priority key handlers", () => {
  class Sink implements Component {
    seen: string[] = [];
    render(): string[] {
      return ["sink"];
    }
    handleInput(key: Key): boolean {
      this.seen.push(key.name);
      return true;
    }
  }

  it("sees a key before the focused component, and can consume it", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 6 });
    const tui = new TUI(terminal, { manageCursor: false });
    const sink = new Sink();
    tui.add(sink);
    tui.focus(sink);

    const claimed: string[] = [];
    tui.onKey(
      (key) => {
        if (key.name !== "end") return false;
        claimed.push(key.name);
        return true;
      },
      { priority: true },
    );

    expect(tui.dispatchKey(createKey("end"))).toBe(true);
    expect(claimed).toEqual(["end"]);
    expect(sink.seen).toEqual([]); // the focused component never saw it

    // Anything the priority handler declines still reaches the component.
    tui.dispatchKey(createKey("home"));
    expect(sink.seen).toEqual(["home"]);
  });

  it("keeps ordinary handlers behind the focused component", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 6 });
    const tui = new TUI(terminal, { manageCursor: false });
    const sink = new Sink();
    tui.add(sink);
    tui.focus(sink);
    const fallback: string[] = [];
    tui.onKey((key) => {
      fallback.push(key.name);
      return true;
    });
    tui.dispatchKey(createKey("end"));
    expect(sink.seen).toEqual(["end"]);
    expect(fallback).toEqual([]);
  });

  it("unsubscribes a priority handler", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 6 });
    const tui = new TUI(terminal, { manageCursor: false });
    const sink = new Sink();
    tui.add(sink);
    tui.focus(sink);
    const off = tui.onKey(() => true, { priority: true });
    tui.dispatchKey(createKey("end"));
    expect(sink.seen).toEqual([]);
    off();
    tui.dispatchKey(createKey("end"));
    expect(sink.seen).toEqual(["end"]);
  });
});
