/**
 * The markdown parser, driven as a function.
 *
 * `MARKDOWN_SOURCE` is the text the webview runs. Compiling it here with
 * `new Function` means these tests exercise the shipped bytes rather than a
 * second copy of the algorithm kept in sync by hand — and because the parser
 * returns plain data, none of it needs a DOM.
 */

import { describe, expect, it } from "vitest";
import { MARKDOWN_SOURCE, type MarkdownBlock } from "./webview-markdown.js";

const parseMarkdown = new Function(`${MARKDOWN_SOURCE}\nreturn parseMarkdown;`)() as (
  text: string,
) => MarkdownBlock[];

/** Flatten every string a tree would render, so a test can assert on words. */
function words(nodes: unknown): string {
  if (Array.isArray(nodes)) return nodes.map(words).join("");
  if (nodes === null || typeof nodes !== "object") return "";
  const node = nodes as Record<string, unknown>;
  if (node.t === "text" || node.t === "code") return String(node.v);
  if (node.t === "br") return "\n";
  return words(node.c ?? node.items ?? []);
}

describe("parseMarkdown: blocks", () => {
  it("makes a paragraph out of consecutive lines", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { t: "p", c: [{ t: "text", v: "one\ntwo" }] },
      { t: "p", c: [{ t: "text", v: "three" }] },
    ]);
  });

  it("reads ATX headings up to level six and no further", () => {
    const blocks = parseMarkdown("# One\n\n###### Six\n\n####### Seven");
    expect(blocks[0]).toEqual({ t: "h", level: 1, c: [{ t: "text", v: "One" }] });
    expect(blocks[1]).toEqual({ t: "h", level: 6, c: [{ t: "text", v: "Six" }] });
    expect(blocks[2]?.t).toBe("p");
  });

  it("keeps a fenced block verbatim, with its language", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n\n  indented\n```")).toEqual([
      { t: "code", lang: "ts", v: "const a = 1;\n\n  indented", open: false },
    ]);
  });

  it("renders a fence the stream has not closed yet, and says it is open", () => {
    expect(parseMarkdown("```py\nprint(")).toEqual([
      { t: "code", lang: "py", v: "print(", open: true },
    ]);
  });

  it("reads the path out of a fence info string, and still knows the language", () => {
    // A fence with anything after the language used to fail MD_FENCE outright
    // and render as prose — four lines of code as a paragraph, with the
    // backticks in it. Every shape a model actually emits now parses.
    expect(parseMarkdown("```ts src/sidebar/webview-client.ts\nx\n```")).toEqual([
      { t: "code", lang: "ts", file: "src/sidebar/webview-client.ts", v: "x", open: false },
    ]);
    expect(parseMarkdown("```ts:src/foo.ts\nx\n```")).toEqual([
      { t: "code", lang: "ts", file: "src/foo.ts", v: "x", open: false },
    ]);
    expect(parseMarkdown("```src/foo.py\nx\n```")).toEqual([
      { t: "code", lang: "py", file: "src/foo.py", v: "x", open: false },
    ]);
    expect(parseMarkdown('```js title="app/main.js"\nx\n```')).toEqual([
      { t: "code", lang: "js", file: "app/main.js", v: "x", open: false },
    ]);
  });

  it("carries no filename when the fence names none", () => {
    // The key is absent rather than empty: a renderer that draws a path row
    // for every block would draw an empty one for almost every block.
    expect(Object.keys(parseMarkdown("```ts\nx\n```")[0] ?? {})).toEqual([
      "t",
      "lang",
      "v",
      "open",
    ]);
    expect(parseMarkdown("```\nx\n```")).toEqual([{ t: "code", lang: "", v: "x", open: false }]);
  });

  it("does not read markdown inside a fence", () => {
    const blocks = parseMarkdown("```\n# not a heading\n**not bold**\n```");
    expect(blocks).toEqual([
      { t: "code", lang: "", v: "# not a heading\n**not bold**", open: false },
    ]);
  });

  it("reads a bullet list, an ordered list, and its start number", () => {
    expect(parseMarkdown("- a\n- b")).toEqual([
      {
        t: "list",
        ordered: false,
        start: 1,
        items: [
          { checked: null, c: [{ t: "p", c: [{ t: "text", v: "a" }] }] },
          { checked: null, c: [{ t: "p", c: [{ t: "text", v: "b" }] }] },
        ],
      },
    ]);
    const ordered = parseMarkdown("3. c\n4. d")[0];
    expect(ordered).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  it("nests a list under its parent item", () => {
    const blocks = parseMarkdown("- outer\n  - inner");
    const outer = blocks[0] as { items: { c: MarkdownBlock[] }[] };
    expect(outer.items).toHaveLength(1);
    expect(outer.items[0]?.c[1]).toMatchObject({ t: "list", ordered: false });
    expect(words(outer.items[0]?.c[1])).toBe("inner");
  });

  it("reads task-list checkboxes", () => {
    const list = parseMarkdown("- [ ] todo\n- [x] done")[0] as {
      items: { checked: boolean | null }[];
    };
    expect(list.items.map((item) => item.checked)).toEqual([false, true]);
  });

  it("reads a blockquote as blocks, not as text", () => {
    expect(parseMarkdown("> **hi**\n> there")).toEqual([
      {
        t: "quote",
        c: [
          {
            t: "p",
            c: [
              { t: "strong", c: [{ t: "text", v: "hi" }] },
              { t: "text", v: "\nthere" },
            ],
          },
        ],
      },
    ]);
  });

  it("reads a thematic break", () => {
    expect(parseMarkdown("a\n\n---\n\nb")[1]).toEqual({ t: "hr" });
  });
});

describe("parseMarkdown: inline", () => {
  it("reads bold, italic, strikethrough and inline code", () => {
    expect(parseMarkdown("**b** _i_ ~~s~~ `c`")[0]).toEqual({
      t: "p",
      c: [
        { t: "strong", c: [{ t: "text", v: "b" }] },
        { t: "text", v: " " },
        { t: "em", c: [{ t: "text", v: "i" }] },
        { t: "text", v: " " },
        { t: "del", c: [{ t: "text", v: "s" }] },
        { t: "text", v: " " },
        { t: "code", v: "c" },
      ],
    });
  });

  it("lets inline code hold the characters that mark up everything else", () => {
    expect(parseMarkdown("`**not bold**`")[0]).toEqual({
      t: "p",
      c: [{ t: "code", v: "**not bold**" }],
    });
  });

  it("honours a backslash escape", () => {
    expect(words(parseMarkdown("\\*not italic\\*"))).toBe("*not italic*");
  });

  it("leaves an unclosed emphasis run as the characters the model sent", () => {
    expect(words(parseMarkdown("**half"))).toBe("**half");
  });

  it("breaks a line on two trailing spaces", () => {
    expect(parseMarkdown("a  \nb")[0]).toEqual({
      t: "p",
      c: [{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }],
    });
  });
});

describe("parseMarkdown: links", () => {
  it("reads an inline link", () => {
    expect(parseMarkdown("[docs](https://arcturn.dev/x)")[0]).toEqual({
      t: "p",
      c: [{ t: "link", href: "https://arcturn.dev/x", c: [{ t: "text", v: "docs" }] }],
    });
  });

  it("linkifies a bare url and an angle autolink", () => {
    expect(parseMarkdown("see https://a.example/b now")[0]).toMatchObject({
      c: [
        { t: "text", v: "see " },
        { t: "link", href: "https://a.example/b" },
        { t: "text", v: " now" },
      ],
    });
    expect(parseMarkdown("<https://a.example/>")[0]).toMatchObject({
      c: [{ t: "link", href: "https://a.example/" }],
    });
  });

  it("refuses every scheme but http, https and mailto, keeping the text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox",
      "file:///etc/passwd",
    ]) {
      const paragraph = parseMarkdown(`[click](${href})`)[0];
      expect(paragraph).toEqual({ t: "p", c: [{ t: "text", v: `[click](${href})` }] });
    }
  });
});

describe("parseMarkdown: tables", () => {
  const table = (text: string) => {
    const block = parseMarkdown(text)[0];
    if (block?.t !== "table") throw new Error(`not a table: ${block?.t}`);
    return block;
  };

  it("reads a header, a delimiter and a body", () => {
    const built = table("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |");
    expect(built.head.map(words)).toEqual(["a", "b"]);
    expect(built.rows.map((row) => row.map(words))).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("takes the alignment the delimiter row asks for", () => {
    expect(table("| a | b | c | d |\n|:-|-:|:-:|-|\n| 1 | 2 | 3 | 4 |").align).toEqual([
      "left",
      "right",
      "center",
      "",
    ]);
  });

  it("reads a table whose rows have no outer pipes", () => {
    // The frame is optional in GFM and models leave it off about half the time.
    const built = table("a | b\n--|--\n1 | 2");
    expect(built.head.map(words)).toEqual(["a", "b"]);
    expect(built.rows.map((row) => row.map(words))).toEqual([["1", "2"]]);
  });

  it("keeps cells as markdown, not as flat text", () => {
    const built = table("| a |\n| - |\n| **b** `c` |");
    expect(built.rows[0]?.[0]?.map((node) => node.t)).toEqual(["strong", "text", "code"]);
  });

  it("carries an escaped pipe through as data", () => {
    // The escape belongs to the inline pass, which is the only place in this
    // file that resolves one — so what the cell holds is still the escape.
    const built = table("| a | b |\n| - | - |\n| x \\| y | z |");
    expect(built.rows[0]?.map(words)).toEqual(["x | y", "z"]);
  });

  it("squares a ragged row against the header", () => {
    // A short row is what a table looks like while it is still arriving, and
    // a long one is a model miscounting. Neither should drop a row.
    const built = table("| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 |");
    expect(built.rows.map((row) => row.map(words))).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
  });

  it("stops the table at a blank line and at the next block", () => {
    const blocks = parseMarkdown("| a |\n| - |\n| 1 |\n\nafter");
    expect(blocks[0]?.t).toBe("table");
    expect(words(blocks[1])).toBe("after");

    const heading = parseMarkdown("| a |\n| - |\n| 1 |\n# next");
    expect(heading[0]?.t).toBe("table");
    expect(heading[1]?.t).toBe("h");
  });
});

describe("parseMarkdown: what is not a table", () => {
  it("leaves prose that merely contains pipes alone", () => {
    // Pipes are ordinary punctuation in a sentence about shells, and the
    // delimiter row is the only thing that makes a table a table.
    expect(parseMarkdown("run ls | wc -l to count them")[0]?.t).toBe("p");
    expect(parseMarkdown("a | b\nc | d")[0]?.t).toBe("p");
  });

  it("does not let a line ending in a pipe capture the rule under it", () => {
    // Without the guard that the delimiter row carries a pipe of its own,
    // this reads as a one-column table and the horizontal rule disappears.
    const blocks = parseMarkdown("ends with a pipe |\n---");
    expect(blocks[0]?.t).toBe("p");
    expect(blocks[1]?.t).toBe("hr");
  });

  it("refuses a delimiter row that does not match the header's width", () => {
    // GFM's rule, and a good one: a mismatch is a coincidence, not a table.
    expect(parseMarkdown("| a | b | c |\n| - | - |\n| 1 | 2 | 3 |")[0]?.t).toBe("p");
  });

  it("waits for the delimiter row rather than half-drawing a table", () => {
    // Mid-stream the header has arrived and the delimiter has not. A table
    // that appeared column by column would rebuild itself on every delta.
    expect(parseMarkdown("| a | b |")[0]?.t).toBe("p");
    expect(parseMarkdown("| a | b |\n| -")[0]?.t).toBe("p");
    expect(parseMarkdown("| a | b |\n| - | - |")[0]?.t).toBe("table");
  });
});

describe("parseMarkdown: what it refuses to do", () => {
  it("never passes raw html through — a tag is characters, not markup", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")[0]).toEqual({
      t: "p",
      c: [{ t: "text", v: "<img src=x onerror=alert(1)>" }],
    });
    expect(words(parseMarkdown("<b>bold?</b>"))).toBe("<b>bold?</b>");
  });

  it("emits only the node kinds the renderer knows", () => {
    const known = new Set(["p", "h", "code", "quote", "list", "table", "hr"]);
    const inline = new Set(["text", "code", "strong", "em", "del", "link", "br"]);
    const walkInline = (nodes: unknown): void => {
      for (const node of nodes as Record<string, unknown>[]) {
        expect(inline).toContain(node.t);
        if (node.c !== undefined) walkInline(node.c);
      }
    };
    const walk = (blocks: MarkdownBlock[]): void => {
      for (const block of blocks) {
        expect(known).toContain(block.t);
        if (block.t === "quote") walk(block.c);
        else if (block.t === "list") for (const item of block.items) walk(item.c);
        else if (block.t === "table") {
          for (const cell of block.head) walkInline(cell);
          for (const row of block.rows) for (const cell of row) walkInline(cell);
        } else if (block.t !== "code" && block.t !== "hr") walkInline(block.c);
      }
    };
    walk(
      parseMarkdown(
        "# h\n\ntext **b** [l](https://x.example) `c`\n\n> q\n\n- a\n  1. b\n\n| a | *b* |\n| - | --: |\n| 1 | 2 |\n\n```js\nx\n```\n\n---",
      ),
    );
  });

  it("returns nothing for nothing, and does not hang on pathological input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
    expect(parseMarkdown("*".repeat(2000)).length).toBeGreaterThan(0);
    expect(parseMarkdown(`${"> ".repeat(500)}deep`).length).toBeGreaterThan(0);
  });
});
