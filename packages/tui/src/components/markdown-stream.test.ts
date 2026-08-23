import { beforeEach, describe, expect, it } from "vitest";
import { ColorLevel, setColorLevel } from "../ansi.js";
import { darkTheme, lightTheme, setTheme } from "../theme.js";
import { MarkdownStream, renderMarkdown } from "./markdown.js";

beforeEach(() => {
  setColorLevel(ColorLevel.None);
  setTheme(darkTheme);
});

const DOC = `# Title

First paragraph with some text that will wrap around at narrow widths for sure.

## Section

- bullet one
- bullet two
  - nested

\`\`\`ts
const x = 1;

const y = 2; // blank line above must not split the fence
\`\`\`

Closing paragraph after the fence.

| a | b |
|---|---|
| 1 | 2 |

Very last line.`;

/** Streams `text` into a MarkdownStream in chunks of the given sizes, cycling. */
function streamed(text: string, chunkSizes: number[], width: number): string[] {
  const stream = new MarkdownStream();
  let i = 0;
  let size = 0;
  while (i < text.length) {
    const n = chunkSizes[size % chunkSizes.length] ?? 7;
    size++;
    stream.append(text.slice(i, i + n));
    i += n;
    // Render mid-stream too: must never throw, and must keep fences intact.
    stream.render(width);
  }
  return stream.render(width);
}

describe("MarkdownStream", () => {
  it("matches the one-shot render when streamed in tiny chunks", () => {
    expect(streamed(DOC, [3], 60)).toEqual(renderMarkdown(DOC, 60));
  });

  it("matches the one-shot render when streamed in uneven chunks", () => {
    expect(streamed(DOC, [1, 17, 5, 64, 2], 42)).toEqual(renderMarkdown(DOC, 42));
  });

  it("never splits inside a code fence", () => {
    const fenced = "intro\n\n```\na\n\nb\n\nc\n\nd\n```\n\nafter";
    expect(streamed(fenced, [4], 40)).toEqual(renderMarkdown(fenced, 40));
  });

  it("keeps list context together across blank lines", () => {
    const listy = "- item one\n\n- item two loose list\n\n- item three\n\nplain paragraph";
    expect(streamed(listy, [6], 50)).toEqual(renderMarkdown(listy, 50));
  });

  it("re-renders the cached prefix when the width changes", () => {
    const stream = new MarkdownStream();
    for (let i = 0; i < DOC.length; i += 9) stream.append(DOC.slice(i, i + 9));
    stream.render(80);
    expect(stream.render(40)).toEqual(renderMarkdown(DOC, 40));
  });

  it("reset clears everything", () => {
    const stream = new MarkdownStream();
    stream.append("# hello\n\nworld");
    stream.render(40);
    stream.reset();
    expect(stream.render(40)).toEqual([]);
    expect(stream.source).toBe("");
    stream.append("fresh");
    expect(stream.render(40)).toEqual(renderMarkdown("fresh", 40));
  });

  it("exposes the full source text", () => {
    const stream = new MarkdownStream();
    stream.append("one\n\ntwo\n\nthree");
    stream.render(40);
    expect(stream.source).toBe("one\n\ntwo\n\nthree");
  });

  it("re-styles the cached stable prefix (including a table) after a theme switch", () => {
    setColorLevel(ColorLevel.TrueColor);
    const stream = new MarkdownStream();
    // A blank line after the table pushes it into the stable, cached prefix
    // before we render again — this is the "table content" case that must
    // pick up the new theme's tableBorder/tableHeader styling.
    stream.append("| a | b |\n|---|---|\n| 1 | 2 |\n\nlive tail");
    const before = stream.render(40);

    setTheme(lightTheme);
    const after = stream.render(40); // same width — only the theme moved

    // fails pre-fix: #stableLines was cached on width alone and never
    // rebuilt, so the table's borders/header keep the old theme's ANSI.
    expect(after).not.toEqual(before);
    expect(after).toEqual(renderMarkdown(stream.source, 40));
  });

  it("does not mix themes when a chunk crosses a stable boundary right after a theme switch", () => {
    setColorLevel(ColorLevel.TrueColor);
    const stream = new MarkdownStream();
    stream.append("first paragraph\n\n");
    stream.render(40); // establishes the stable prefix under the dark theme

    setTheme(lightTheme);
    stream.append("second paragraph\n\nlive tail"); // advances the boundary post-switch
    const after = stream.render(40);

    expect(after).toEqual(renderMarkdown(stream.source, 40));
  });
});
