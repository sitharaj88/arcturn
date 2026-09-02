/**
 * Screen-mode scroll-region tests.
 *
 * A vertical scroll changes almost every row of the frame, so the plain
 * row-by-row diff repaints the whole viewport for a one-row move — the frame
 * that costs the most is the one that changed the least. These tests pin the
 * fast path that moves the rows with the terminal's own scroll instead, and —
 * more importantly — pin that the screen it leaves behind is byte-for-byte the
 * frame that was submitted.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, setColorLevel, stripAnsi } from "./ansi.js";
import { FrameComposer } from "./composer.js";
import { TestTerminal } from "./terminal.js";
import { darkTheme, setTheme } from "./theme.js";

const ESC = "\u001b";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal's own ESC sequences is the point.
const CSI_SEQUENCE = /^\u001b\[([0-9;?]*)([@-~])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal's own ESC sequences is the point.
const SCROLL_REGION = /\u001b\[\d+;\d+r/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal's own ESC sequences is the point.
const ROW_ADDRESS = /\u001b\[\d+;1H/g;

beforeEach(() => {
  setColorLevel(ColorLevel.None);
  setTheme(darkTheme);
});

/**
 * A terminal emulator good enough to prove placement: absolute cursor
 * addressing, erase-line/screen, a DECSTBM scroll region and SU/SD.
 *
 * Cells hold plain characters — style bytes are dropped — because what the
 * scroll-region path can get wrong is *where a row lands*, not how it is
 * coloured.
 */
class Screen {
  rows: string[];
  private cursorRow = 0;
  private cursorCol = 0;
  private top: number;
  private bottom: number;
  /** Rows the terminal filled itself (SU/SD) rather than the app painting them. */
  filled = new Set<number>();

  constructor(
    private readonly columns: number,
    private readonly height: number,
  ) {
    this.rows = Array.from({ length: height }, () => "");
    this.top = 0;
    this.bottom = height - 1;
  }

  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch !== ESC) {
        if (ch === "\r") {
          this.cursorCol = 0;
          i++;
          continue;
        }
        if (ch === "\n") {
          this.cursorRow++;
          i++;
          continue;
        }
        this.put(ch);
        i++;
        continue;
      }
      const match = CSI_SEQUENCE.exec(data.slice(i));
      if (!match) {
        i++;
        continue;
      }
      const [seq, params = "", final = ""] = match;
      this.control(params, final);
      i += seq.length;
    }
  }

  private nums(params: string): number[] {
    return params.split(";").map((p) => (p === "" ? Number.NaN : Number.parseInt(p, 10)));
  }

  private control(params: string, final: string): void {
    if (params.startsWith("?")) return; // private modes: 2026 and friends
    const n = this.nums(params);
    switch (final) {
      case "H": {
        this.cursorRow = (Number.isNaN(n[0]) ? 1 : n[0]!) - 1;
        this.cursorCol = (Number.isNaN(n[1]) ? 1 : n[1]!) - 1;
        return;
      }
      case "G":
        this.cursorCol = (Number.isNaN(n[0]) ? 1 : n[0]!) - 1;
        return;
      case "K": {
        const mode = Number.isNaN(n[0]) ? 0 : n[0]!;
        if (mode === 2) this.rows[this.cursorRow] = "";
        else if (mode === 0) {
          this.rows[this.cursorRow] = (this.rows[this.cursorRow] ?? "").slice(0, this.cursorCol);
        }
        this.filled.delete(this.cursorRow);
        return;
      }
      case "J": {
        const mode = Number.isNaN(n[0]) ? 0 : n[0]!;
        if (mode === 2) {
          this.rows = this.rows.map(() => "");
          this.filled.clear();
        }
        return;
      }
      case "r": {
        this.top = Number.isNaN(n[0]) ? 0 : n[0]! - 1;
        this.bottom = Number.isNaN(n[1]) ? this.height - 1 : n[1]! - 1;
        this.cursorRow = 0;
        this.cursorCol = 0;
        return;
      }
      case "S":
        this.scroll(Number.isNaN(n[0]) ? 1 : n[0]!);
        return;
      case "T":
        this.scroll(-(Number.isNaN(n[0]) ? 1 : n[0]!));
        return;
      case "A":
        this.cursorRow -= Number.isNaN(n[0]) ? 1 : n[0]!;
        return;
      case "B":
        this.cursorRow += Number.isNaN(n[0]) ? 1 : n[0]!;
        return;
      default:
        return; // SGR and anything else does not move content
    }
  }

  /** Positive scrolls content up (SU), negative down (SD), inside the region. */
  private scroll(amount: number): void {
    const region = this.rows.slice(this.top, this.bottom + 1);
    const filledRegion = region.map((_, i) => this.filled.has(this.top + i));
    const n = Math.min(Math.abs(amount), region.length);
    const blanks = Array.from({ length: n }, () => "");
    const next =
      amount > 0
        ? [...region.slice(n), ...blanks]
        : [...blanks, ...region.slice(0, region.length - n)];
    const nextFilled =
      amount > 0
        ? [...filledRegion.slice(n), ...Array.from({ length: n }, () => true)]
        : [...Array.from({ length: n }, () => true), ...filledRegion.slice(0, region.length - n)];
    for (let i = 0; i < region.length; i++) {
      this.rows[this.top + i] = next[i] ?? "";
      if (nextFilled[i]) this.filled.add(this.top + i);
      else this.filled.delete(this.top + i);
    }
  }

  private put(ch: string): void {
    if (this.cursorRow < 0 || this.cursorRow >= this.height) return;
    const row = this.rows[this.cursorRow] ?? "";
    const padded =
      row.length < this.cursorCol ? row + " ".repeat(this.cursorCol - row.length) : row;
    this.rows[this.cursorRow] =
      padded.slice(0, this.cursorCol) + ch + padded.slice(this.cursorCol + ch.length);
    this.cursorCol += 1;
    if (this.cursorCol >= this.columns) this.cursorCol = this.columns - 1;
  }

  /** Rows as the app would compare them: trailing blanks trimmed. */
  plain(): string[] {
    return this.rows.map((row) => row.replace(/\s+$/, ""));
  }
}

function expected(lines: readonly string[], height: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < height; i++) out.push(stripAnsi(lines[i] ?? "").replace(/\s+$/, ""));
  return out;
}

/** A viewport-shaped frame: `head` banner, a window of `body`, then chrome. */
function frameFor(body: readonly string[], offset: number, viewport: number, height: number) {
  const end = body.length - offset;
  const start = Math.max(0, end - viewport);
  const window = body.slice(start, end);
  const lines = [...window];
  while (lines.length < viewport) lines.unshift("");
  if (offset > 0) lines[0] = `… ${offset} lines below`;
  lines.push("── input ──", "> ", "status bar");
  while (lines.length < height) lines.push("");
  return lines;
}

describe("screen-mode scroll region", () => {
  const W = 40;
  const H = 20;
  const VIEWPORT = 17;
  const body = Array.from({ length: 300 }, (_, i) => `row ${i} of the transcript`);

  function setup() {
    const terminal = new TestTerminal({ columns: W, rows: H });
    const composer = new FrameComposer(terminal, { screen: true });
    const screen = new Screen(W, H);
    const paint = (lines: string[]) => {
      terminal.clearWrites();
      composer.submitFrame({ lines, width: W, height: H });
      composer.flush();
      screen.feed(terminal.output);
      return terminal.output;
    };
    return { terminal, composer, screen, paint };
  }

  it("moves rows with DECSTBM + SU instead of repainting the whole viewport", () => {
    const { paint } = setup();
    paint(frameFor(body, 0, VIEWPORT, H));
    const out = paint(frameFor(body, 1, VIEWPORT, H));

    // Scrolling up by one shows one earlier row: the terminal scrolls its own
    // rows DOWN by one (SD) and only the newly exposed row is painted.
    expect(out).toMatch(SCROLL_REGION); // DECSTBM
    expect(out).toContain(`${ESC}[1T`); // SD 1
    expect(out).toContain(`${ESC}[r`); // region reset
    // Two rows repainted at most: the exposed row and the banner it becomes.
    expect(out.match(ROW_ADDRESS)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("costs a fraction of the full repaint it replaces", () => {
    const { paint } = setup();
    paint(frameFor(body, 0, VIEWPORT, H));
    const shift = paint(frameFor(body, 1, VIEWPORT, H)).length;
    // A frame where every row genuinely differs is the control.
    const scrambled = frameFor(body, 1, VIEWPORT, H).map((line, i) => `${i}:${line}`);
    const full = paint(scrambled).length;
    expect(shift * 4).toBeLessThan(full);
  });

  it("leaves the screen exactly equal to the frame, notch after notch", () => {
    const { screen, paint } = setup();
    let offset = 0;
    paint(frameFor(body, offset, VIEWPORT, H));
    // Up in ones, up in a bounded burst, back down, and past the bottom.
    const moves = [1, 1, 1, 5, 8, 4, -1, -3, -8, -6, 12, 12, -20, 3];
    for (const move of moves) {
      offset = Math.max(0, Math.min(offset + move, body.length - VIEWPORT));
      const lines = frameFor(body, offset, VIEWPORT, H);
      paint(lines);
      expect(screen.plain()).toEqual(expected(lines, H));
    }
  });

  it("falls back to the full diff when the frame changed by more than a shift", () => {
    const { screen, paint } = setup();
    paint(frameFor(body, 0, VIEWPORT, H));
    // A shift *and* an edit inside the shifted band: the shift is still the
    // cheap way to move the rows, but the edited row must be repainted too.
    const lines = frameFor(body, 3, VIEWPORT, H);
    lines[5] = "an edited row, not part of the shift";
    paint(lines);
    expect(screen.plain()).toEqual(expected(lines, H));

    // A frame with no shift relation at all must still land.
    const unrelated = lines.map((line, i) => (i % 2 === 0 ? `x${i}` : line));
    paint(unrelated);
    expect(screen.plain()).toEqual(expected(unrelated, H));
  });

  it("takes the plain diff, untouched, for a one-row change — the common keystroke frame", () => {
    // The overwhelming majority of screen-mode frames are a keystroke: one
    // row (the input line) differs and nothing moved. `detectShift` must
    // rule this out cheaply rather than running its full search, and —
    // whichever path it takes — the bytes it writes must be exactly the
    // plain row diff, never a scroll region.
    const { screen, paint } = setup();
    paint(frameFor(body, 0, VIEWPORT, H));
    const lines = frameFor(body, 0, VIEWPORT, H);
    lines[10] = "a single keystroke changed this row only";
    const out = paint(lines);
    expect(out).not.toMatch(SCROLL_REGION);
    expect(out).not.toContain(`${ESC}[1T`);
    expect(out).not.toContain(`${ESC}[1S`);
    expect(screen.plain()).toEqual(expected(lines, H));
  });

  it("rewrites a row the shift blanked even when its content did not change", () => {
    // The one way a shift can silently lose a row: the terminal fills the
    // exposed band with blanks, and the row that belongs there happens to
    // carry the same text it carried before the scroll — so a diff taken
    // against the *old* screen sees no change and writes nothing.
    const before = Array.from({ length: H }, (_, i) => `a${i}`);
    const after = [...before];
    for (let i = 0; i <= H - 4; i++) after[i] = before[i + 3] ?? "";
    after[H - 3] = before[H - 3] ?? ""; // the coincidence
    after[H - 2] = "fresh one";
    after[H - 1] = "fresh two";

    const terminal = new TestTerminal({ columns: W, rows: H });
    const composer = new FrameComposer(terminal, { screen: true });
    const screen = new Screen(W, H);
    composer.submitFrame({ lines: before, width: W, height: H });
    composer.flush();
    screen.feed(terminal.output);
    terminal.clearWrites();
    composer.submitFrame({ lines: after, width: W, height: H });
    composer.flush();
    expect(terminal.output).toContain(`${ESC}[3S`); // the shift did happen
    screen.feed(terminal.output);
    expect(screen.plain()).toEqual(expected(after, H));
  });

  it("rewrites an unchanged row the downward shift blanked", () => {
    const before = Array.from({ length: H }, (_, i) => `a${i}`);
    const after = [...before];
    for (let i = H - 1; i >= 3; i--) after[i] = before[i - 3] ?? "";
    after[2] = before[2] ?? ""; // the coincidence, at the top this time
    after[0] = "fresh one";
    after[1] = "fresh two";

    const terminal = new TestTerminal({ columns: W, rows: H });
    const composer = new FrameComposer(terminal, { screen: true });
    const screen = new Screen(W, H);
    composer.submitFrame({ lines: before, width: W, height: H });
    composer.flush();
    screen.feed(terminal.output);
    terminal.clearWrites();
    composer.submitFrame({ lines: after, width: W, height: H });
    composer.flush();
    expect(terminal.output).toContain(`${ESC}[3T`);
    screen.feed(terminal.output);
    expect(screen.plain()).toEqual(expected(after, H));
  });

  it("parks the cursor absolutely after a shifted frame", () => {
    const terminal = new TestTerminal({ columns: W, rows: H });
    const composer = new FrameComposer(terminal, { screen: true });
    composer.submitFrame({ lines: frameFor(body, 0, VIEWPORT, H), width: W, height: H });
    composer.flush();
    terminal.clearWrites();
    composer.submitFrame({
      lines: frameFor(body, 1, VIEWPORT, H),
      cursor: { row: 18, col: 4 },
      width: W,
      height: H,
    });
    composer.flush();
    expect(terminal.output.endsWith(`${ESC}[19;5H`)).toBe(true);
  });

  it("stays off when the terminal does not want a scroll region", () => {
    const terminal = new TestTerminal({ columns: W, rows: H });
    const composer = new FrameComposer(terminal, { screen: true, scrollRegion: false });
    composer.submitFrame({ lines: frameFor(body, 0, VIEWPORT, H), width: W, height: H });
    composer.flush();
    terminal.clearWrites();
    composer.submitFrame({ lines: frameFor(body, 1, VIEWPORT, H), width: W, height: H });
    composer.flush();
    expect(terminal.output).not.toContain(`${ESC}[1T`);
    expect(terminal.output).not.toMatch(SCROLL_REGION);
  });

  it("never shifts in inline mode", () => {
    const terminal = new TestTerminal({ columns: W, rows: H });
    const composer = new FrameComposer(terminal, {});
    composer.submitFrame({ lines: frameFor(body, 0, VIEWPORT, H), width: W, height: H });
    composer.flush();
    terminal.clearWrites();
    composer.submitFrame({ lines: frameFor(body, 1, VIEWPORT, H), width: W, height: H });
    composer.flush();
    expect(terminal.output).not.toMatch(SCROLL_REGION);
  });

  it("repaints every row the shift left blank, canvas and all", () => {
    setColorLevel(ColorLevel.Ansi256);
    const terminal = new TestTerminal({ columns: W, rows: H });
    const canvas = `${ESC}[48;5;16m`;
    const composer = new FrameComposer(terminal, { screen: true, canvas: () => canvas });
    const screen = new Screen(W, H);
    composer.submitFrame({ lines: frameFor(body, 0, VIEWPORT, H), width: W, height: H });
    composer.flush();
    screen.feed(terminal.output);
    terminal.clearWrites();
    const lines = frameFor(body, 6, VIEWPORT, H);
    composer.submitFrame({ lines, width: W, height: H });
    composer.flush();
    screen.feed(terminal.output);
    // Nothing the terminal filled itself may be left showing: every exposed
    // row was painted over with a real, canvassed row.
    expect([...screen.filled]).toEqual([]);
    expect(screen.plain()).toEqual(expected(lines, H));
  });
});
