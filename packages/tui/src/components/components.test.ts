import { beforeEach, describe, expect, it } from "vitest";
import { bold, ColorLevel, setColorLevel, stripAnsi } from "../ansi.js";
import { createKey } from "../keys.js";
import { createTheme, darkTheme, getTheme, lightTheme, setTheme, style } from "../theme.js";
import { stringWidth } from "../width.js";
import { BORDERS, Box } from "./box.js";
import { Divider } from "./divider.js";
import { SelectList } from "./select-list.js";
import { SPINNER_FRAMES, Spinner } from "./spinner.js";
import { Stack } from "./stack.js";
import { StatusBar } from "./status-bar.js";
import { Text } from "./text.js";

beforeEach(() => {
  setColorLevel(ColorLevel.None);
  setTheme(darkTheme);
});

describe("Text", () => {
  it("wraps to the available width", () => {
    expect(new Text("hello world").render(6)).toEqual(["hello", "world"]);
  });

  it("aligns content", () => {
    expect(new Text("hi", { align: "center" }).render(6)).toEqual(["  hi  "]);
    expect(new Text("hi", { align: "right" }).render(6)).toEqual(["    hi"]);
  });

  it("applies padding", () => {
    expect(new Text("hi", { paddingX: 1, paddingY: 1 }).render(6)).toEqual(["", " hi", ""]);
  });

  it("truncates instead of wrapping when wrap is off", () => {
    expect(new Text("hello world", { wrap: false }).render(6)).toEqual(["hello…"]);
  });

  it("caches until the text or width changes", () => {
    const text = new Text("a");
    const first = text.render(10);
    expect(text.render(10)).toBe(first);
    text.setText("b");
    expect(text.render(10)).toEqual(["b"]);
  });

  it("accepts a theme token or an explicit style", () => {
    setColorLevel(ColorLevel.TrueColor);
    expect(stripAnsi(new Text("x", { style: "accent" }).render(5)[0] ?? "")).toBe("x");
    expect(new Text("x", { style: bold }).render(5)[0]).toContain("[1m");
  });

  it("re-styles after a theme switch even when text and width are unchanged", () => {
    setColorLevel(ColorLevel.TrueColor);
    setTheme(darkTheme);
    const text = new Text("x", { style: "accent" });
    const before = text.render(5)[0];
    setTheme(lightTheme);
    const after = text.render(5)[0];
    expect(after).not.toBe(before);
    expect(after).toBe(style("accent")("x"));
  });
});

describe("Box", () => {
  it("draws a border with padding around its child", () => {
    expect(new Box(new Text("hi")).render(8)).toEqual(["╭──────╮", "│ hi   │", "╰──────╯"]);
  });

  it("splices a title into the top border", () => {
    expect(new Box(new Text("hi"), { title: "T", border: "single" }).render(12)).toEqual([
      "┌─ T ──────┐",
      "│ hi       │",
      "└──────────┘",
    ]);
  });

  it("centres the title when asked", () => {
    expect(new Box(new Text("x"), { title: "T", titleAlign: "center" }).render(12)[0]).toBe(
      "╭─── T ────╮",
    );
  });

  it("omits the frame for border: none", () => {
    expect(new Box(new Text("hi"), { border: "none" }).render(8)).toEqual([" hi     "]);
  });

  it("exposes every border character set", () => {
    expect(Object.keys(BORDERS)).toEqual(["single", "double", "round", "bold", "ascii"]);
    expect(new Box(new Text("x"), { border: "double" }).render(6)[0]).toBe("╔════╗");
    expect(new Box(new Text("x"), { border: "ascii" }).render(6)[0]).toBe("+----+");
  });

  it("keeps every line exactly the box width", () => {
    for (const line of new Box(new Text("日本語のテキスト"), { title: "タイトル" }).render(14)) {
      expect(stringWidth(line)).toBe(14);
    }
  });

  it("translates a child cursor into box coordinates", () => {
    const child = {
      render: () => ["ab"],
      getCursor: () => ({ row: 0, col: 1 }),
    };
    const box = new Box(child);
    box.render(10);
    // One row for the top border; one column for the border plus one for the padding.
    expect(box.getCursor()).toEqual({ row: 1, col: 3 });
  });
});

describe("Stack", () => {
  it("concatenates children with a gap", () => {
    expect(new Stack([new Text("a"), new Text("b")], { gap: 1 }).render(10)).toEqual([
      "a",
      "",
      "b",
    ]);
  });

  it("offers input to children until one consumes it", () => {
    const seen: string[] = [];
    const make = (label: string, consume: boolean) => ({
      render: () => [label],
      handleInput: () => {
        seen.push(label);
        return consume;
      },
    });
    const stack = new Stack([make("a", false), make("b", true), make("c", true)]);
    expect(stack.handleInput(createKey("x"))).toBe(true);
    expect(seen).toEqual(["a", "b"]);
  });

  it("offsets a child cursor by the preceding lines", () => {
    const stack = new Stack([
      new Text("one\ntwo"),
      { render: () => ["x"], getCursor: () => ({ row: 0, col: 1 }) },
    ]);
    stack.render(10);
    expect(stack.getCursor()).toEqual({ row: 2, col: 1 });
  });
});

describe("Divider", () => {
  it("fills the width", () => {
    expect(new Divider().render(8)).toEqual(["────────"]);
  });

  it("splices in a label", () => {
    expect(new Divider({ label: "hi", align: "center" }).render(12)).toEqual(["──── hi ────"]);
  });

  it("honours a custom character and margin", () => {
    expect(new Divider({ char: "=", margin: 1 }).render(6)).toEqual([" ==== "]);
  });
});

describe("Spinner", () => {
  it("advances through its frames", () => {
    const spinner = new Spinner({ frames: "line" });
    expect(spinner.frame).toBe(SPINNER_FRAMES.line[0]);
    spinner.tick();
    expect(spinner.frame).toBe(SPINNER_FRAMES.line[1]);
  });

  it("wraps around at the end of the animation", () => {
    const spinner = new Spinner({ frames: ["a", "b"] });
    spinner.tick();
    spinner.tick();
    expect(spinner.frame).toBe("a");
  });

  it("renders the glyph and label on one line", () => {
    expect(new Spinner({ frames: ["*"], label: "loading" }).render(20)).toEqual(["* loading"]);
  });

  it("truncates a label that does not fit", () => {
    const line = new Spinner({ frames: ["*"], label: "a very long label" }).render(8)[0] ?? "";
    expect(stringWidth(line)).toBeLessThanOrEqual(8);
  });
});

describe("StatusBar", () => {
  it("pins segments to both edges, one cell in from the right", () => {
    // The last column is margin, not content: an emulator that draws an
    // ambiguous-width glyph wide — or that mishandles the final cell — clips
    // whatever sits there, and what sits there is the bar's number.
    expect(new StatusBar({ left: [{ text: "L" }], right: [{ text: "R" }] }).render(10)).toEqual([
      "L       R ",
    ]);
  });

  it("centres the middle group within the content area", () => {
    expect(
      new StatusBar({
        left: [{ text: "L" }],
        center: [{ text: "C" }],
        right: [{ text: "R" }],
      }).render(12),
    ).toEqual(["L    C    R "]);
  });

  it("never exceeds the width when space runs out", () => {
    const line =
      new StatusBar({
        left: [{ text: "a very long left segment" }],
        right: [{ text: "right" }],
      }).render(12)[0] ?? "";
    expect(stringWidth(line)).toBeLessThanOrEqual(12);
    expect(line.trimEnd().endsWith("right")).toBe(true);
    // The margin survives even the space-starved path.
    expect(line.endsWith(" ")).toBe(true);
  });
});

describe("SelectList", () => {
  it("select(value) moves the pointer to that row", () => {
    const list = new SelectList({
      items: [
        { value: "dark", data: 1 },
        { value: "light", data: 2 },
      ],
    });
    expect(list.selectedIndex).toBe(0);
    list.select("light");
    expect(list.selectedIndex).toBe(1);
    // Unknown values leave the pointer where it is — a picker must never
    // lose its place because a stale name was handed in.
    list.select("solarized");
    expect(list.selectedIndex).toBe(1);
  });

  const items = [{ value: "one" }, { value: "two" }, { value: "three" }];

  it("marks the highlighted row and shows an overflow hint", () => {
    const list = new SelectList({ items, maxVisible: 2 });
    expect(list.render(20)).toEqual(["❯ one", "  two", "  … 1 more (1/3)"]);
  });

  it("moves the highlight and wraps around", () => {
    const list = new SelectList({ items });
    list.selectNext();
    expect(list.selected?.value).toBe("two");
    list.selectPrevious();
    list.selectPrevious();
    expect(list.selected?.value).toBe("three");
  });

  it("stops at the ends when wrap is off", () => {
    const list = new SelectList({ items, wrap: false });
    list.selectPrevious();
    expect(list.selectedIndex).toBe(0);
  });

  it("skips disabled rows", () => {
    const list = new SelectList({
      items: [{ value: "a" }, { value: "b", disabled: true }, { value: "c" }],
    });
    list.selectNext();
    expect(list.selected?.value).toBe("c");
  });

  it("filters items case-insensitively", () => {
    const list = new SelectList({ items: [{ value: "Alpha" }, { value: "beta" }] });
    list.setFilter("AL");
    expect(list.filteredItems.map((i) => i.value)).toEqual(["Alpha"]);
  });

  it("edits the filter from printable keys when filterable", () => {
    const list = new SelectList({
      items: [{ value: "alpha" }, { value: "beta" }],
      filterable: true,
    });
    list.handleInput(createKey("b", { text: "b" }));
    list.handleInput(createKey("e", { text: "e" }));
    expect(list.filter).toBe("be");
    expect(list.render(20)).toEqual(["filter: be", "❯ beta"]);
    list.handleInput(createKey("backspace"));
    expect(list.filter).toBe("b");
  });

  it("reports no matches", () => {
    const list = new SelectList({ items });
    list.setFilter("zzz");
    expect(list.render(20)).toEqual(["no matches"]);
  });

  it("lays descriptions out in a second column", () => {
    const list = new SelectList({
      items: [
        { value: "read", description: "read a file" },
        { value: "write", description: "write" },
      ],
    });
    expect(list.render(40)).toEqual(["❯ read   read a file", "  write  write"]);
  });

  it("confirms and cancels through key events", () => {
    const chosen: string[] = [];
    let cancelled = 0;
    const list = new SelectList({
      items,
      onSelect: (item) => chosen.push(item.value),
      onCancel: () => cancelled++,
    });
    list.handleInput(createKey("down"));
    list.handleInput(createKey("enter"));
    list.handleInput(createKey("escape"));
    expect(chosen).toEqual(["two"]);
    expect(cancelled).toBe(1);
  });

  it("jumps to the ends with home and end", () => {
    const list = new SelectList({ items });
    list.handleInput(createKey("end"));
    expect(list.selectedIndex).toBe(2);
    list.handleInput(createKey("home"));
    expect(list.selectedIndex).toBe(0);
  });
});

describe("theme", () => {
  it("defaults to the dark theme", () => {
    expect(getTheme()).toBe(darkTheme);
  });

  it("swaps themes globally", () => {
    setTheme(lightTheme);
    expect(getTheme().name).toBe("arcturn-light");
  });

  it("resolves tokens through style()", () => {
    setColorLevel(ColorLevel.TrueColor);
    expect(stripAnsi(style("error")("boom"))).toBe("boom");
    expect(style("error")("boom")).not.toBe("boom");
  });

  it("derives a theme with overrides", () => {
    const custom = createTheme("custom", { accent: bold }, darkTheme);
    expect(custom.name).toBe("custom");
    expect(custom.styles.accent).toBe(bold);
    expect(custom.styles.error).toBe(darkTheme.styles.error);
  });

  it("keeps every token defined in both built-in themes", () => {
    expect(Object.keys(lightTheme.styles).sort()).toEqual(Object.keys(darkTheme.styles).sort());
  });
});
