import { beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, fg, setColorLevel } from "../ansi.js";
import { createKey } from "../keys.js";
import { createTheme, darkTheme, setTheme, style } from "../theme.js";
import { Viewport } from "./viewport.js";

beforeEach(() => {
  setColorLevel(ColorLevel.None);
  setTheme(darkTheme);
});

function makeViewport(lines: string[], wheelStep?: number): Viewport {
  return new Viewport({ getLines: () => lines, ...(wheelStep ? { wheelStep } : {}) });
}

describe("Viewport", () => {
  it("returns exactly the requested height, bottom-anchored with top padding", () => {
    const viewport = makeViewport(["a", "b"]);
    expect(viewport.renderArea(60, 5)).toEqual(["", "", "", "a", "b"]);
    expect(viewport.renderArea(10, 2)).toEqual(["a", "b"]);
  });

  it("follows the tail while offset is 0", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const viewport = makeViewport(lines);
    expect(viewport.renderArea(60, 3)).toEqual(["c", "d", "e"]);
    expect(viewport.isFollowing).toBe(true);
    lines.push("f");
    expect(viewport.renderArea(60, 3)).toEqual(["d", "e", "f"]);
  });

  it("keeps the visible window anchored while content streams in below", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines, 3);
    viewport.renderArea(60, 4); // ["l6".."l9"]

    viewport.handleInput(createKey("wheelup")); // offset 3
    const scrolled = viewport.renderArea(60, 4);
    expect(scrolled[0]).toBe("… 3 lines below · End to follow");
    expect(scrolled.slice(1)).toEqual(["l4", "l5", "l6"]);
    expect(viewport.isFollowing).toBe(false);

    lines.push("l10", "l11");
    const after = viewport.renderArea(60, 4);
    // The offset grew by the appended rows, so the window content stayed put.
    expect(after[0]).toBe("… 5 lines below · End to follow");
    expect(after.slice(1)).toEqual(["l4", "l5", "l6"]);
  });

  it("wraps over-wide lines into multiple display rows", () => {
    const viewport = makeViewport(["aaaa bbbb cccc", "ok"]);
    expect(viewport.renderArea(5, 4)).toEqual(["aaaa", "bbbb", "cccc", "ok"]);
  });

  it("returns consistent wraps across renders and re-wraps on width change", () => {
    const lines = ["aaaa bbbb cccc"];
    const viewport = makeViewport(lines);
    const first = viewport.renderArea(5, 3);
    expect(viewport.renderArea(5, 3)).toEqual(first);
    lines.push("dd");
    // The cached wrap of the first line is reused verbatim while it scrolls up.
    expect(viewport.renderArea(5, 4)).toEqual(["aaaa", "bbbb", "cccc", "dd"]);
    // A width change invalidates the cache and produces a different wrap.
    expect(viewport.renderArea(9, 3)).toEqual(["aaaa bbbb", "cccc", "dd"]);
  });

  it("re-wraps after invalidate()", () => {
    const viewport = makeViewport(["aaaa bbbb"]);
    expect(viewport.renderArea(5, 2)).toEqual(["aaaa", "bbbb"]);
    viewport.invalidate();
    expect(viewport.renderArea(5, 2)).toEqual(["aaaa", "bbbb"]);
  });

  it("shows the indicator row only while scrolled, with the row count", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines, 3);
    const following = viewport.renderArea(60, 4);
    expect(following.some((l) => l.includes("below"))).toBe(false);

    viewport.handleInput(createKey("wheelup"));
    viewport.handleInput(createKey("wheeldown"));
    viewport.handleInput(createKey("wheelup")); // net offset 3
    const scrolled = viewport.renderArea(60, 4);
    expect(scrolled[0]).toBe("… 3 lines below · End to follow");
    expect(scrolled.slice(1)).toEqual(["l2", "l3", "l4"]);
  });

  it("singularises the indicator for a single hidden line", () => {
    const viewport = makeViewport(["a", "b", "c"], 1);
    viewport.renderArea(60, 2);
    viewport.handleInput(createKey("wheelup"));
    expect(viewport.renderArea(60, 2)[0]).toBe("… 1 line below · End to follow");
  });

  it("truncates the indicator to the available width", () => {
    const viewport = makeViewport(["a", "b", "c", "d"], 1);
    viewport.renderArea(8, 2);
    viewport.handleInput(createKey("wheelup"));
    const row = viewport.renderArea(8, 2)[0] ?? "";
    expect(row.endsWith("…")).toBe(true);
  });

  it("scrolls by the wheel step and clamps at both extremes", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines, 4);
    viewport.renderArea(60, 4); // max offset 6

    expect(viewport.handleInput(createKey("wheeldown"))).toBe(true); // already at bottom
    expect(viewport.isFollowing).toBe(true);

    viewport.handleInput(createKey("wheelup")); // 4 — one notch lands whole
    expect(viewport.renderArea(60, 4)[0]).toBe("… 4 lines below · End to follow");
    // A second notch in the same frame is metered: it shows on the next one,
    // where it clamps at the top.
    viewport.handleInput(createKey("wheelup"));
    expect(viewport.renderArea(60, 4)[0]).toBe("… 6 lines below · End to follow");

    viewport.handleInput(createKey("wheelup")); // stays 6
    expect(viewport.renderArea(60, 4)[0]).toBe("… 6 lines below · End to follow");

    viewport.handleInput(createKey("wheeldown")); // 2
    expect(viewport.renderArea(60, 4)[0]).toBe("… 2 lines below · End to follow");
    viewport.handleInput(createKey("wheeldown")); // clamped to 0
    expect(viewport.isFollowing).toBe(true);
  });

  it("pages by the last rendered height minus one", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 5); // page = 4, max offset 7

    expect(viewport.handleInput(createKey("pageup"))).toBe(true);
    expect(viewport.renderArea(60, 5)[0]).toBe("… 4 lines below · End to follow");
    viewport.handleInput(createKey("pageup")); // clamped to 7
    expect(viewport.renderArea(60, 5)[0]).toBe("… 7 lines below · End to follow");

    expect(viewport.handleInput(createKey("pagedown"))).toBe(true);
    expect(viewport.renderArea(60, 5)[0]).toBe("… 3 lines below · End to follow");
    viewport.handleInput(createKey("pagedown")); // clamped to 0
    expect(viewport.isFollowing).toBe(true);
    expect(viewport.renderArea(60, 5)).toEqual(["l7", "l8", "l9", "l10", "l11"]);
  });

  it("jumps to the top with home and back to following with end", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 3); // max offset 6

    expect(viewport.handleInput(createKey("home"))).toBe(true);
    const top = viewport.renderArea(60, 3);
    expect(top[0]).toBe("… 6 lines below · End to follow");
    expect(top.slice(1)).toEqual(["l1", "l2"]);
    viewport.handleInput(createKey("home")); // already at the top
    expect(viewport.renderArea(60, 3).slice(1)).toEqual(["l1", "l2"]);

    expect(viewport.handleInput(createKey("end"))).toBe(true);
    expect(viewport.isFollowing).toBe(true);
    expect(viewport.renderArea(60, 3)).toEqual(["l6", "l7", "l8"]);
  });

  it("scrolls one line per arrow, for the wheel that arrives as arrows", () => {
    // The selection handover focuses the viewport while alternate scroll
    // (mode 1007) delivers wheel motion as plain arrow keys.
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 4); // max offset 6

    expect(viewport.handleInput(createKey("up"))).toBe(true);
    expect(viewport.renderArea(60, 4)[0]).toBe("… 1 line below · End to follow");
    viewport.handleInput(createKey("up"));
    expect(viewport.renderArea(60, 4)[0]).toBe("… 2 lines below · End to follow");

    expect(viewport.handleInput(createKey("down"))).toBe(true);
    expect(viewport.renderArea(60, 4)[0]).toBe("… 1 line below · End to follow");
    viewport.handleInput(createKey("down")); // back to following
    expect(viewport.isFollowing).toBe(true);
  });

  it("spreads a burst of wheel notches over frames instead of one jump", () => {
    // The bug: a trackpad flick arrives as many wheel reports in ONE stdin
    // chunk, every one of them is applied, and the single frame that follows
    // teleports the view by the whole burst.
    const lines = Array.from({ length: 400 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 32);

    for (let i = 0; i < 30; i++) viewport.handleInput(createKey("wheelup"));

    const budget = Math.ceil(32 / 4);
    const seen: number[] = [];
    let previous = 0;
    for (let frame = 0; frame < 12; frame++) {
      viewport.renderArea(60, 32);
      seen.push(viewport.scrollOffset - previous);
      previous = viewport.scrollOffset;
    }
    expect(Math.max(...seen)).toBeLessThanOrEqual(budget);
    // Not a single notch is dropped: the sum of the frames is the burst.
    expect(viewport.scrollOffset).toBe(30);
  });

  it("tracks a reversal instead of unwinding the backlog behind it", () => {
    // Flick up, then flick down before the first one has finished showing:
    // the finger is going down now, so the view must go down now.
    const lines = Array.from({ length: 400 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 32);
    for (let i = 0; i < 40; i++) viewport.handleInput(createKey("wheelup"));
    viewport.renderArea(60, 32);
    const high = viewport.scrollOffset;
    expect(high).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) viewport.handleInput(createKey("wheeldown"));
    viewport.renderArea(60, 32);
    expect(viewport.scrollOffset).toBe(high - 3);
    // …and settling adds nothing back: the abandoned up-motion is gone.
    for (let i = 0; i < 6; i++) viewport.renderArea(60, 32);
    expect(viewport.scrollOffset).toBe(high - 3);
  });

  it("absorbs a single stray opposite notch instead of discarding the backlog", () => {
    // Real trackpads occasionally misreport one frame of a flick's direction.
    // A lone reversed notch mid-flick must not be read as "the user reversed":
    // the rest of the flick, arriving in the same stdin chunk, settles it.
    const lines = Array.from({ length: 400 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 32);
    for (let i = 0; i < 40; i++) {
      // The stray notch lands late, once a real backlog has built up behind
      // it — the exact shape of the bug: 38 real notches queue, one stray
      // reversal arrives, then the flick's last notch confirms the original
      // direction resumed.
      viewport.handleInput(createKey(i === 38 ? "wheeldown" : "wheelup"));
    }
    for (let frame = 0; frame < 30; frame++) viewport.renderArea(60, 32);
    // 39 real up-notches once the stray one is discounted — not the ~9 rows a
    // full backlog reset would leave behind.
    expect(viewport.scrollOffset).toBe(39);
  });

  it("clamps queued wheel motion to what the transcript can actually show", () => {
    // 20 scrollable rows: queuing thousands of notches must not leave a
    // backlog that keeps draining long after the transcript has topped out.
    const height = 8;
    const lines = Array.from({ length: height + 20 }, (_, i) => `l${i}`);
    const viewport = new Viewport({ getLines: () => lines });
    viewport.renderArea(60, height);
    for (let i = 0; i < 5000; i++) viewport.handleInput(createKey("wheelup"));

    const budget = Math.max(1, Math.ceil(height / 4));
    const maxFramesToSettle = Math.ceil(20 / budget) + 1;
    let frames = 0;
    while (viewport.scrollOffset < 20 && frames <= maxFramesToSettle) {
      viewport.renderArea(60, height);
      frames++;
    }
    expect(viewport.scrollOffset).toBe(20);
    expect(frames).toBeLessThanOrEqual(maxFramesToSettle);
  });

  it("settles in time bounded by the remaining distance, not the notch count", () => {
    // A 10-row/frame budget (wheelStep 10) against a transcript with far more
    // scrollable rows than the queued notches could ever reach unclamped.
    const height = 8;
    const scrollable = 200;
    const lines = Array.from({ length: height + scrollable }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines, 10);
    viewport.renderArea(60, height);
    // 1000 notches * wheelStep 10 = 10 000 rows requested against 200
    // scrollable: wildly more than the backlog should ever hold onto.
    for (let i = 0; i < 1000; i++) viewport.handleInput(createKey("wheelup"));

    const budget = 10;
    const maxFramesToSettle = Math.ceil(scrollable / budget) + 1;
    let frames = 0;
    while (viewport.scrollOffset < scrollable && frames <= maxFramesToSettle) {
      viewport.renderArea(60, height);
      frames++;
    }
    expect(viewport.scrollOffset).toBe(scrollable);
    // Bounded by the transcript, not by the 1000 notches (which would take
    // 1000 frames to drain at one notch's budget per frame, unclamped).
    expect(frames).toBeLessThanOrEqual(maxFramesToSettle);
  });

  it("asks for another frame while wheel motion is still pending", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `l${i}`);
    let asked = 0;
    const viewport = new Viewport({
      getLines: () => lines,
      onScrollPending: () => {
        asked++;
      },
    });
    viewport.renderArea(60, 32);
    for (let i = 0; i < 20; i++) viewport.handleInput(createKey("wheelup"));

    viewport.renderArea(60, 32);
    expect(asked).toBe(1);
    // Drain to the end; the last frame must not ask for another.
    for (let i = 0; i < 10; i++) viewport.renderArea(60, 32);
    expect(viewport.scrollOffset).toBe(20);
    const settled = asked;
    viewport.renderArea(60, 32);
    expect(asked).toBe(settled);
  });

  it("lands one notch whole and immediately, however large the step", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines, 6);
    viewport.renderArea(60, 8);
    viewport.handleInput(createKey("wheelup"));
    expect(viewport.renderArea(60, 8)[0]).toBe("\u2026 6 lines below \u00b7 End to follow");
  });

  it("drops residual wheel motion once the view is clamped at an end", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 8);
    for (let i = 0; i < 100; i++) viewport.handleInput(createKey("wheelup"));
    // Settle at the top.
    for (let i = 0; i < 20; i++) viewport.renderArea(60, 8);
    expect(viewport.scrollOffset).toBe(32);
    // One notch down must move one row, not unwind a 68-notch backlog.
    viewport.handleInput(createKey("wheeldown"));
    viewport.renderArea(60, 8);
    expect(viewport.scrollOffset).toBe(31);
  });

  it("applies paging and home/end at once, flushing any pending wheel motion", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 32);
    for (let i = 0; i < 50; i++) viewport.handleInput(createKey("wheelup"));
    viewport.handleInput(createKey("home"));
    viewport.renderArea(60, 32);
    expect(viewport.scrollOffset).toBe(400 - 32);
    viewport.handleInput(createKey("end"));
    viewport.renderArea(60, 32);
    expect(viewport.isFollowing).toBe(true);
  });

  it("selects across rows: live highlight, plain text on release", () => {
    const lines = ["\u001b[31malpha beta\u001b[0m", "gamma delta", "epsilon"];
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 3);

    // Anchor at row 0 col 6 ("beta"), drag to row 1 col 4 (end of "gamma").
    expect(viewport.beginSelectionAt(0, 6)).toBe(true);
    viewport.dragSelectionTo(1, 4);

    const frame = viewport.renderArea(60, 3);
    expect(frame[0]).toContain("\u001b[7m");
    expect(frame[1]).toContain("\u001b[7m");
    expect(frame[2]).not.toContain("\u001b[7m");

    const text = viewport.endSelection();
    expect(text).toBe("beta\ngamma");
    // The gesture is over: nothing highlighted, nothing held.
    expect(viewport.hasSelection).toBe(false);
    expect(viewport.renderArea(60, 3)[0]).not.toContain("\u001b[7m");
  });

  it("selects backwards the same as forwards", () => {
    const viewport = makeViewport(["one", "two", "three"]);
    viewport.renderArea(60, 3);
    viewport.beginSelectionAt(2, 2);
    viewport.dragSelectionTo(0, 0);
    expect(viewport.endSelection()).toBe("one\ntwo\nthr");
  });

  it("a click — no movement — ends with nothing", () => {
    const viewport = makeViewport(["one", "two"]);
    viewport.renderArea(60, 2);
    viewport.beginSelectionAt(0, 1);
    expect(viewport.endSelection()).toBeUndefined();
  });

  it("auto-scrolls while the drag rides the top edge, growing past a screenful", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 4); // shows line-6..line-9

    viewport.beginSelectionAt(3, 5); // "line-9", col 5
    for (let i = 0; i < 6; i++) viewport.dragSelectionTo(0, 0); // ride the top edge
    const text = viewport.endSelection();
    // Six edge ticks scrolled six rows: the head reached line-0, so the span
    // covers the whole buffer ("line-9" is six columns, so col 5+1 keeps it whole).
    expect(text).toBe(lines.join("\n"));
  });

  it("double-click semantics: the word is the non-whitespace run under the cell", () => {
    const viewport = makeViewport(["\u001b[32mrun\u001b[0m src/cart.ts --fast", "x"]);
    viewport.renderArea(60, 2);

    expect(viewport.selectWordAt(0, 7)).toBe(true); // inside "src/cart.ts"
    expect(viewport.selectionText()).toBe("src/cart.ts");
    // The highlight survives the copy: it is the receipt.
    expect(viewport.hasSelection).toBe(true);
    expect(viewport.renderArea(60, 2)[0]).toContain("\u001b[7m");

    expect(viewport.selectWordAt(0, 3)).toBe(false); // the space after "run"
    expect(viewport.selectWordAt(1, 0)).toBe(true); // one-character word
    expect(viewport.selectionText()).toBe("x");
  });

  it("triple-click semantics: the whole display row, plain", () => {
    const viewport = makeViewport(["\u001b[31malpha\u001b[0m beta  ", ""]);
    viewport.renderArea(60, 2);
    expect(viewport.selectRowAt(0)).toBe(true);
    expect(viewport.selectionText()).toBe("alpha beta");
    expect(viewport.selectRowAt(1)).toBe(false); // a blank row selects nothing
  });

  it("declines keys it does not handle", () => {
    const viewport = makeViewport(["a"]);
    expect(viewport.handleInput(createKey("a"))).toBe(false);
    expect(viewport.handleInput(createKey("left"))).toBe(false);
    expect(viewport.handleInput(createKey("enter"))).toBe(false);
    expect(viewport.handleInput(createKey("pageup", { ctrl: true }))).toBe(false);
  });

  it("supports follow() and stays clamped when content shrinks", () => {
    let lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const viewport = new Viewport({ getLines: () => lines });
    viewport.renderArea(60, 4);
    viewport.handleInput(createKey("home"));
    expect(viewport.isFollowing).toBe(false);
    viewport.follow();
    expect(viewport.isFollowing).toBe(true);

    viewport.handleInput(createKey("home")); // offset 6
    lines = lines.slice(0, 5); // shrink below the previous offset
    expect(viewport.renderArea(60, 4)).toEqual([
      "… 1 line below · End to follow",
      "l1",
      "l2",
      "l3",
    ]);
  });

  it("reflects a theme change on the next render because getLines() re-styles content live", () => {
    // The wrap cache is keyed on the styled line *content* (not on width alone),
    // so a caller like MarkdownStream/Markdown that re-styles its lines on a
    // theme change naturally produces a different cache key here — no
    // themeVersion plumbing needed inside Viewport itself. Prove that directly
    // rather than assuming it, per the mission's instruction.
    setColorLevel(ColorLevel.TrueColor);
    const red = createTheme("red", { accent: fg("#ff0000") }, darkTheme);
    const green = createTheme("green", { accent: fg("#00ff00") }, darkTheme);

    setTheme(red);
    const viewport = new Viewport({ getLines: () => [style("accent")("hello")] });
    const before = viewport.renderArea(20, 1);

    setTheme(green);
    const after = viewport.renderArea(20, 1);

    expect(after).not.toEqual(before);
    expect(after[0]).toBe(style("accent")("hello")); // sanity: green is now active
  });

  it("render() falls back to a ten-row area", () => {
    const viewport = makeViewport(["a", "b"]);
    const lines = viewport.render(10);
    expect(lines).toHaveLength(10);
    expect(lines.slice(8)).toEqual(["a", "b"]);
  });
});
