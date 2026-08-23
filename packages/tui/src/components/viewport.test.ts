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
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 4); // ["l6".."l9"]

    viewport.handleInput(createKey("wheelup")); // offset 3
    const scrolled = viewport.renderArea(60, 4);
    expect(scrolled[0]).toBe("… 3 lines below · End/G to follow");
    expect(scrolled.slice(1)).toEqual(["l4", "l5", "l6"]);
    expect(viewport.isFollowing).toBe(false);

    lines.push("l10", "l11");
    const after = viewport.renderArea(60, 4);
    // The offset grew by the appended rows, so the window content stayed put.
    expect(after[0]).toBe("… 5 lines below · End/G to follow");
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
    const viewport = makeViewport(lines);
    const following = viewport.renderArea(60, 4);
    expect(following.some((l) => l.includes("below"))).toBe(false);

    viewport.handleInput(createKey("wheelup"));
    viewport.handleInput(createKey("wheeldown"));
    viewport.handleInput(createKey("wheelup")); // net offset 3
    const scrolled = viewport.renderArea(60, 4);
    expect(scrolled[0]).toBe("… 3 lines below · End/G to follow");
    expect(scrolled.slice(1)).toEqual(["l2", "l3", "l4"]);
  });

  it("singularises the indicator for a single hidden line", () => {
    const viewport = makeViewport(["a", "b", "c"], 1);
    viewport.renderArea(60, 2);
    viewport.handleInput(createKey("wheelup"));
    expect(viewport.renderArea(60, 2)[0]).toBe("… 1 line below · End/G to follow");
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

    viewport.handleInput(createKey("wheelup")); // 4
    viewport.handleInput(createKey("wheelup")); // clamped to 6
    expect(viewport.renderArea(60, 4)[0]).toBe("… 6 lines below · End/G to follow");

    viewport.handleInput(createKey("wheelup")); // stays 6
    expect(viewport.renderArea(60, 4)[0]).toBe("… 6 lines below · End/G to follow");

    viewport.handleInput(createKey("wheeldown")); // 2
    expect(viewport.renderArea(60, 4)[0]).toBe("… 2 lines below · End/G to follow");
    viewport.handleInput(createKey("wheeldown")); // clamped to 0
    expect(viewport.isFollowing).toBe(true);
  });

  it("pages by the last rendered height minus one", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const viewport = makeViewport(lines);
    viewport.renderArea(60, 5); // page = 4, max offset 7

    expect(viewport.handleInput(createKey("pageup"))).toBe(true);
    expect(viewport.renderArea(60, 5)[0]).toBe("… 4 lines below · End/G to follow");
    viewport.handleInput(createKey("pageup")); // clamped to 7
    expect(viewport.renderArea(60, 5)[0]).toBe("… 7 lines below · End/G to follow");

    expect(viewport.handleInput(createKey("pagedown"))).toBe(true);
    expect(viewport.renderArea(60, 5)[0]).toBe("… 3 lines below · End/G to follow");
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
    expect(top[0]).toBe("… 6 lines below · End/G to follow");
    expect(top.slice(1)).toEqual(["l1", "l2"]);
    viewport.handleInput(createKey("home")); // already at the top
    expect(viewport.renderArea(60, 3).slice(1)).toEqual(["l1", "l2"]);

    expect(viewport.handleInput(createKey("end"))).toBe(true);
    expect(viewport.isFollowing).toBe(true);
    expect(viewport.renderArea(60, 3)).toEqual(["l6", "l7", "l8"]);
  });

  it("declines keys it does not handle", () => {
    const viewport = makeViewport(["a"]);
    expect(viewport.handleInput(createKey("a"))).toBe(false);
    expect(viewport.handleInput(createKey("up"))).toBe(false);
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
      "… 1 line below · End/G to follow",
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
