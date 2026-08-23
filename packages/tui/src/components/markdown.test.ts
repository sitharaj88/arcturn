import { beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, setColorLevel, stripAnsi } from "../ansi.js";
import { darkTheme, lightTheme, setTheme } from "../theme.js";
import { stringWidth } from "../width.js";
import { highlightCode, Markdown, renderMarkdown } from "./markdown.js";

const ESC = "";

beforeEach(() => {
  setColorLevel(ColorLevel.None);
  setTheme(darkTheme);
});

describe("block rendering", () => {
  it("renders headings, dropping the hashes for h1 and h2", () => {
    expect(renderMarkdown("# One\n\n## Two\n\n### Three", 40)).toEqual([
      "One",
      "",
      "Two",
      "",
      "### Three",
    ]);
  });

  it("renders paragraphs with inline styling flattened to text", () => {
    expect(renderMarkdown("Hello **bold** and *italic* and `code` and ~~gone~~.", 60)).toEqual([
      "Hello bold and italic and code and gone.",
    ]);
  });

  it("renders fenced code blocks framed by a gutter with the language label", () => {
    expect(renderMarkdown("```ts\nconst x = 1; // hi\n```", 40)).toEqual([
      "╭╴ts",
      "│ const x = 1; // hi",
      "╰╴",
    ]);
    expect(renderMarkdown("```\nplain\n```", 40)).toEqual(["╭╴", "│ plain", "╰╴"]);
  });

  it("renders unordered, ordered, nested and task lists", () => {
    expect(renderMarkdown("- one\n- two\n  - nested\n- three", 40)).toEqual([
      "• one",
      "• two",
      "  • nested",
      "• three",
    ]);
    expect(renderMarkdown("1. first\n2. second", 40)).toEqual(["1. first", "2. second"]);
    expect(renderMarkdown("- [x] done\n- [ ] todo", 40)).toEqual(["• [x] done", "• [ ] todo"]);
  });

  it("renders blockquotes with a gutter", () => {
    expect(renderMarkdown("> quoted text\n> more", 40)).toEqual(["│ quoted text", "│ more"]);
  });

  it("renders horizontal rules capped at 80 columns", () => {
    expect(renderMarkdown("---", 10)).toEqual(["──────────"]);
    expect(renderMarkdown("---", 200)[0]).toHaveLength(80);
  });

  it("renders tables with box-drawing borders", () => {
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 40)).toEqual([
      "┌───┬───┐",
      "│ a │ b │",
      "├───┼───┤",
      "│ 1 │ 2 │",
      "└───┴───┘",
    ]);
  });

  it("separates blocks with a single blank line", () => {
    expect(renderMarkdown("# Title\n\nSome text.\n\n- item\n\n```js\nlet a = 2;\n```", 40)).toEqual(
      ["Title", "", "Some text.", "", "• item", "", "╭╴js", "│ let a = 2;", "╰╴"],
    );
  });
});

describe("links", () => {
  it("appends the target after the label", () => {
    expect(renderMarkdown("See [Arcturn](https://arcturn.dev) here.", 60)).toEqual([
      "See Arcturn (https://arcturn.dev) here.",
    ]);
  });

  it("omits the target for a bare autolink", () => {
    expect(renderMarkdown("<https://arcturn.dev>", 60)).toEqual(["https://arcturn.dev"]);
  });

  it("can suppress targets entirely", () => {
    expect(renderMarkdown("[Arcturn](https://arcturn.dev)", 60, { showLinkUrls: false })).toEqual([
      "Arcturn",
    ]);
  });

  it("strips a bare BEL/ESC injected into an osc8 hyperlink href", () => {
    setColorLevel(ColorLevel.TrueColor);
    const BEL = "";
    // A well-formed OSC-8 wrapper legitimately contains ESC/BEL as its own
    // terminators, so the assertion isn't "no control bytes at all" — it's
    // that the attacker's forged target and terminator never reach the
    // terminal once the real wrapper is stripped back off.
    const evil = `https://good.example${BEL}${ESC}]8;;https://evil.example${BEL}pwned`;
    const out = renderMarkdown(`[click](${evil})`, 80, { osc8Links: true }).join("\n");
    expect(out).not.toContain("evil.example");
    expect(stripAnsi(out)).not.toContain(BEL);
    expect(stripAnsi(out)).not.toContain(ESC);
  });

  it("strips a bare BEL/ESC injected into a plain-text link target", () => {
    const BEL = "";
    const evil = `https://good.example${BEL}${ESC}[31mred`;
    const out = renderMarkdown(`[click](${evil})`, 80).join("\n");
    expect(out).not.toContain(BEL);
    expect(out).not.toContain(ESC);
  });
});

describe("wrapping", () => {
  it("wraps paragraphs to the available width", () => {
    expect(
      renderMarkdown("This is a long paragraph that should wrap across multiple lines nicely.", 20),
    ).toEqual([
      "This is a long",
      "paragraph that",
      "should wrap across",
      "multiple lines",
      "nicely.",
    ]);
  });

  it("never exceeds the requested width", () => {
    const source = [
      "# A heading that is quite long indeed",
      "",
      "A paragraph with 日本語 text and a https://example.com/very/long/url in it.",
      "",
      "- a list item that also runs on for a while",
      "",
      "> a quoted passage that is long enough to wrap",
    ].join("\n");
    for (const width of [12, 24, 40]) {
      for (const line of renderMarkdown(source, width)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("applies horizontal padding", () => {
    expect(renderMarkdown("hi", 10, { paddingX: 2 })).toEqual(["  hi"]);
  });
});

describe("styling", () => {
  it("emits ANSI codes when colour is enabled", () => {
    setColorLevel(ColorLevel.TrueColor);
    const [line] = renderMarkdown("**bold**", 40);
    expect(line).not.toBe("bold");
    expect(stripAnsi(line ?? "")).toBe("bold");
  });

  it("highlights keywords, strings, numbers and comments", () => {
    setColorLevel(ColorLevel.TrueColor);
    const [line] = highlightCode(['const x = "s"; // note'], "ts");
    expect(stripAnsi(line ?? "")).toBe('const x = "s"; // note');
    // Four distinct styles plus plain runs means plenty of escape sequences.
    expect((line ?? "").split("\u001b[").length - 1).toBeGreaterThan(6);
  });

  it("only treats # as a comment for languages that use it", () => {
    setColorLevel(ColorLevel.None);
    expect(highlightCode(["# comment"], "bash")).toEqual(["# comment"]);
    expect(highlightCode(["#notacomment"], "ts")).toEqual(["#notacomment"]);
  });
});

describe("Markdown component", () => {
  it("caches per width and source", () => {
    const component = new Markdown("hello");
    const first = component.render(40);
    expect(component.render(40)).toBe(first);
    expect(component.render(30)).not.toBe(first);
  });

  it("re-renders after setMarkdown and append", () => {
    const component = new Markdown("one");
    expect(component.render(40)).toEqual(["one"]);
    component.setMarkdown("two");
    expect(component.render(40)).toEqual(["two"]);
    component.append("\n\nthree");
    expect(component.render(40)).toEqual(["two", "", "three"]);
  });

  it("handles an empty document", () => {
    expect(new Markdown("").render(40)).toEqual([]);
  });

  it("does not throw on a partially streamed code fence", () => {
    expect(() => new Markdown("```ts\nconst a =").render(40)).not.toThrow();
  });

  it("re-styles a cached table after a theme switch, at the same width and source", () => {
    setColorLevel(ColorLevel.TrueColor);
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |";
    const component = new Markdown(doc);
    const before = component.render(40);

    setTheme(lightTheme);
    const after = component.render(40); // same width, same source — only the theme moved

    expect(after).not.toEqual(before); // fails pre-fix: the {width, source} cache serves stale ANSI
    expect(after).toEqual(renderMarkdown(doc, 40)); // matches a fresh render under the new theme
  });

  it("re-styles any cached document after a theme switch, at the same width and source", () => {
    setColorLevel(ColorLevel.TrueColor);
    const component = new Markdown("# Heading\n\nSome **bold** text.");
    const before = component.render(40);

    setTheme(lightTheme);
    const after = component.render(40);

    expect(after).not.toEqual(before);
  });
});
