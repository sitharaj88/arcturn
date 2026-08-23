import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, setColorLevel } from "./ansi.js";
import { SYNC_END, SYNC_START } from "./composer.js";
import { TestTerminal } from "./terminal.js";
import { darkTheme, lightTheme, setTheme } from "./theme.js";
import { type Component, TUI } from "./tui.js";

const ESC = "";
const ERASE_LINE = `${ESC}[2K`;
const ERASE_DOWN = `${ESC}[0J`;

class Lines implements Component {
  constructor(public lines: string[]) {}
  render(): string[] {
    return this.lines;
  }
}

/**
 * A terminal that reports backpressure: every write is captured, but writes
 * return `false` while `blocked`, and drain callbacks fire on `drain()`.
 */
class BackpressureTerminal extends TestTerminal {
  blocked = false;
  drains: (() => void)[] = [];

  writeChunk(data: string): boolean {
    this.write(data);
    return !this.blocked;
  }

  onceDrain(callback: () => void): void {
    this.drains.push(callback);
  }

  drain(): void {
    const pending = this.drains;
    this.drains = [];
    for (const callback of pending) callback();
  }
}

beforeEach(() => {
  setColorLevel(ColorLevel.None);
});

describe("frame coalescing under backpressure", () => {
  it("drops stale frames and writes only the newest after drain", () => {
    const terminal = new BackpressureTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    const component = new Lines(["a"]);
    tui.add(component);
    tui.renderNow();
    terminal.clearWrites();

    // The first write reports a full buffer; later frames must wait.
    terminal.blocked = true;
    component.lines = ["b"];
    tui.renderNow();
    expect(terminal.output).toContain("b");
    terminal.clearWrites();

    // Two more frames while blocked: nothing is written yet.
    component.lines = ["c"];
    tui.renderNow();
    component.lines = ["d"];
    tui.renderNow();
    expect(terminal.output).toBe("");

    // Drain: only the newest frame lands; "c" was never written.
    terminal.blocked = false;
    terminal.drain();
    expect(terminal.output).toContain("d");
    expect(terminal.output).not.toContain("c");
  });

  it("never drops printAbove content while frames coalesce", () => {
    const terminal = new BackpressureTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    const component = new Lines(["live"]);
    tui.add(component);
    tui.renderNow();

    terminal.blocked = true;
    tui.printAbove(["one"]);
    terminal.clearWrites();
    tui.printAbove(["two"]);
    tui.printAbove(["three"]);
    terminal.blocked = false;
    terminal.drain();

    expect(terminal.output).toContain("two");
    expect(terminal.output).toContain("three");
    expect(terminal.output).toContain("live");
  });
});

describe("printAbove", () => {
  it("erases the block, prints content, repaints — in one write", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["live1", "live2"]));
    tui.renderNow();
    terminal.clearWrites();

    tui.printAbove(["scrollback line"]);

    expect(terminal.writes).toHaveLength(1);
    const out = terminal.output;
    // Climb to the top of the two-row block, erase down, content, repaint.
    expect(out).toBe(
      `${ESC}[1A\r${ERASE_DOWN}scrollback line\r\n${ERASE_LINE}live1\r\n${ERASE_LINE}live2`,
    );
  });

  it("writes content directly when nothing is painted yet", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.printAbove(["early"]);
    expect(terminal.output).toBe(`early\r\n`);
  });
});

describe("synchronized output", () => {
  class SyncTerminal extends TestTerminal {
    override get supportsSyncOutput(): boolean {
      return true;
    }
  }

  it("wraps each flush in 2026 markers when the terminal supports it", () => {
    const terminal = new SyncTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["a"]));
    tui.renderNow();
    expect(terminal.output.startsWith(SYNC_START)).toBe(true);
    expect(terminal.output.endsWith(SYNC_END)).toBe(true);
  });

  it("stays unwrapped on terminals that do not support it", () => {
    const terminal = new TestTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["a"]));
    tui.renderNow();
    expect(terminal.output).not.toContain("2026");
  });
});

describe("content after a resize", () => {
  it("erases the rewrapped block before printing content queued during a drag", async () => {
    const terminal = new TestTerminal({ columns: 40, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false, resizeSettleMs: 15 });
    // Two full-width rows: narrowing to 20 columns rewraps each onto two
    // physical rows, so the erase must climb 4 rows, not the 2 logical ones —
    // or the block's top row survives above the content, duplicated.
    tui.add(new Lines(["a".repeat(40), "b".repeat(40)]));
    tui.start();
    terminal.clearWrites();
    terminal.resize(20, 10);
    tui.printAbove(["queued row"]);
    expect(terminal.output).toBe(""); // held while the resize settles
    await new Promise((resolve) => setTimeout(resolve, 50));
    const out = terminal.output;
    expect(out.indexOf(`${ESC}[4A\r${ERASE_DOWN}`)).toBe(0);
    expect(out).toContain("queued row");
  });
});

describe("content slicing", () => {
  it("splits very large insertions across event-loop turns without loss", async () => {
    const terminal = new BackpressureTerminal({ columns: 20, rows: 10 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["live"]));
    tui.renderNow();
    terminal.clearWrites();

    const big = Array.from({ length: 1000 }, (_, i) => `row ${i}`);
    tui.printAbove(big);

    // The first slice is written synchronously; the rest follow on later turns.
    expect(terminal.output).toContain("row 0");
    expect(terminal.output).not.toContain("row 999");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminal.output).toContain("row 999");
    expect(terminal.output).toContain("live");
    // Every row arrived exactly once.
    for (const probe of ["row 0", "row 399", "row 400", "row 500", "row 999"]) {
      expect(terminal.output.split(`${probe}\r\n`).length).toBe(2);
    }
  });
});

describe("theme canvas", () => {
  // The canvas is ground AND default ink: an unstyled cell must be legible on
  // our own canvas rather than taking the terminal's foreground, which is the
  // wrong colour for the theme by definition (a light theme in a dark
  // terminal would otherwise draw terminal-light body text on parchment).
  /** `lightTheme.styles.background` + `.text` — parchment ground, dark ink. */
  const PARCHMENT = `${ESC}[48;2;250;246;239m${ESC}[38;2;36;29;21m`;
  /** `darkTheme.styles.background` + `.text` — warm ink ground, light ink. */
  const INK = `${ESC}[48;2;12;10;7m${ESC}[38;2;240;236;229m`;
  /** SGR "default background". */
  const BG_RESET = `${ESC}[49m`;
  const ERASE_SCREEN = `${ESC}[2J`;

  afterEach(() => {
    setTheme(darkTheme);
    setColorLevel(ColorLevel.None);
  });

  it("paints the canvas before every erase in screen mode", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.renderNow();

    const out = terminal.output;
    // BCE: the erase itself must run under the canvas so cleared cells fill.
    expect(out).toContain(PARCHMENT + ERASE_SCREEN);
    // And the row itself starts under the canvas so its cells show it too.
    expect(out).toContain(`${PARCHMENT}hello`);

    // An incremental (diff) repaint erases per line — also under the canvas.
    terminal.clearWrites();
    (tui.components[0] as Lines).lines = ["world"];
    tui.renderNow();
    expect(terminal.output).toContain(`${PARCHMENT}${ERASE_LINE}${PARCHMENT}world`);
  });

  it("paints every viewport row edge to edge — no BCE dependence", () => {
    // Apple's Terminal.app erases to ITS default background, not the current
    // SGR one, so erase-based filling left the canvas only behind characters:
    // parchment stripes on a dark terminal. Rows must write their own cells.
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 12, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello", "", "hi"]));
    tui.renderNow();

    const out = terminal.output;
    // Content rows are padded to the full 12 columns under the canvas…
    expect(out).toContain(`${PARCHMENT}hello${PARCHMENT}${" ".repeat(7)}`);
    expect(out).toContain(`${PARCHMENT}hi${PARCHMENT}${" ".repeat(10)}`);
    // …and a blank row (plus the viewport rows below the content) is a full
    // row of canvas-coloured spaces rather than an erase side effect.
    const blankRow = `${PARCHMENT}${PARCHMENT}${" ".repeat(12)}`;
    expect(out.split(blankRow).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("pads an incrementally repainted row to the full width", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 12, rows: 3 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    const lines = new Lines(["aaaa"]);
    tui.add(lines);
    tui.renderNow();
    terminal.clearWrites();
    lines.lines = ["bb"];
    tui.renderNow();

    expect(terminal.output).toContain(`${PARCHMENT}bb${PARCHMENT}${" ".repeat(10)}`);
  });

  it("re-opens the canvas after a full reset inside a line", () => {
    // width.ts's sliceByWidth appends ESC[0m whenever it truncates a row that
    // still has styling open, so a clipped row used to lose the canvas from
    // the cut onwards and expose the terminal's own ground for the rest of
    // the line — visible as dark bands across an otherwise light screen.
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 30, rows: 3 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines([`before${ESC}[0mafter`]));
    tui.renderNow();

    expect(terminal.output).toContain(`${ESC}[0m${PARCHMENT}after`);
  });

  it("re-opens the canvas after the ESC[m shorthand reset", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 30, rows: 3 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines([`before${ESC}[mafter`]));
    tui.renderNow();

    expect(terminal.output).toContain(`${ESC}[m${PARCHMENT}after`);
  });

  it("re-opens the canvas after every background reset inside a line", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    // A diff row closes the background mid-line (`49m`); without a re-open the
    // rest of the row falls back to the terminal's own ground.
    tui.add(new Lines([lightTheme.styles.diffAdded("+ added")]));
    tui.renderNow();

    const out = terminal.output;
    expect(out).toContain(BG_RESET + PARCHMENT);
    expect(out.includes(BG_RESET) && !out.includes(BG_RESET + PARCHMENT)).toBe(false);
  });

  it("ends the flush with a background reset so nothing leaks", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.renderNow();
    expect(terminal.output.endsWith(BG_RESET)).toBe(true);
  });

  it("picks up a theme switch on the next flush", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.renderNow();
    expect(terminal.output).toContain(PARCHMENT);

    terminal.clearWrites();
    setTheme(darkTheme);
    tui.invalidate();
    tui.renderNow();
    const out = terminal.output;
    expect(out).toContain(INK + ERASE_SCREEN);
    expect(out).not.toContain(PARCHMENT);
  });

  it("never paints a canvas in inline mode", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.renderNow();
    expect(terminal.output).not.toContain("48;2");
    expect(terminal.output).toBe(`${ERASE_LINE}hello`);
  });

  it("degrades the canvas to the terminal's colour level", () => {
    setColorLevel(ColorLevel.Ansi256);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["hello"]));
    tui.renderNow();
    // `Style.open` is always truecolour; the canvas must follow the *level*.
    expect(terminal.output).not.toContain("48;2");
    expect(terminal.output).toContain(`${ESC}[48;5;`);
  });

  it("is byte-identical to the un-canvassed output when the canvas is empty", () => {
    // Colour off ⇒ the background style emits nothing ⇒ canvas is "".
    setColorLevel(ColorLevel.None);
    setTheme(lightTheme);
    const terminal = new TestTerminal({ columns: 20, rows: 4 });
    const tui = new TUI(terminal, { mode: "screen", manageCursor: false });
    tui.add(new Lines(["a", "b"]));
    tui.renderNow();
    expect(terminal.output).toBe(`${ERASE_SCREEN}${ESC}[1;1H${ESC}[1;1Ha${ESC}[2;1Hb`);

    terminal.clearWrites();
    (tui.components[0] as Lines).lines = ["a", "c"];
    tui.renderNow();
    expect(terminal.output).toBe(`${ESC}[2;1H${ERASE_LINE}c`);
  });
});
