import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi.js";
import {
  charWidth,
  clusterWidth,
  expandTabs,
  padToWidth,
  sliceByWidth,
  stringWidth,
  tokenize,
  truncateToWidth,
  wrapText,
} from "./width.js";

const ESC = "\u001b";
const BOLD = `${ESC}[1m`;
const UNBOLD = `${ESC}[22m`;

describe("stringWidth", () => {
  it("counts printable ASCII one column per character", () => {
    expect(stringWidth("")).toBe(0);
    expect(stringWidth("hello")).toBe(5);
    expect(stringWidth("a b c")).toBe(5);
  });

  it("ignores ANSI escape sequences", () => {
    expect(stringWidth(`${BOLD}bold${UNBOLD}`)).toBe(4);
    expect(stringWidth(`${ESC}[38;2;1;2;3mrgb${ESC}[39m`)).toBe(3);
    expect(stringWidth(`${ESC}[2K${ESC}[5;1Hx`)).toBe(1);
  });

  it("counts CJK characters as two columns", () => {
    expect(stringWidth("日本語")).toBe(6);
    expect(stringWidth("한국어")).toBe(6);
    expect(stringWidth("a日b")).toBe(4);
  });

  it("counts emoji as two columns, including ZWJ sequences and flags", () => {
    expect(stringWidth("👍")).toBe(2);
    expect(stringWidth("👨‍👩‍👧")).toBe(2);
    expect(stringWidth("🇯🇵")).toBe(2);
  });

  it("treats combining marks as zero width", () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT renders as a single cell.
    expect(stringWidth("é")).toBe(1);
    expect(stringWidth("áb́")).toBe(2);
  });

  it("treats control characters as zero width", () => {
    expect(charWidth(0x07)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
  });

  it("expands tabs to a fixed cell count", () => {
    expect(stringWidth("a\tb")).toBe(6);
    expect(clusterWidth("\t")).toBe(4);
    expect(expandTabs("a\tb")).toBe("a    b");
  });
});

describe("tokenize", () => {
  it("separates escape sequences from graphemes", () => {
    const tokens = tokenize(`${BOLD}日x${UNBOLD}`);
    expect(tokens.map((t) => t.ansi)).toEqual([true, false, false, true]);
    expect(tokens.map((t) => t.width)).toEqual([0, 2, 1, 0]);
  });
});

describe("wrapText", () => {
  it("word-wraps and drops the break whitespace", () => {
    expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  it("honours explicit newlines", () => {
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("returns a single empty line for empty input", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("hard-breaks words longer than the width", () => {
    expect(wrapText("abcdefghijklmno", 5)).toEqual(["abcde", "fghij", "klmno"]);
  });

  it("breaks CJK text on column boundaries", () => {
    expect(wrapText("日本語のテキストです", 6)).toEqual(["日本語", "のテキ", "ストで", "す"]);
  });

  it("preserves styling across the break", () => {
    const wrapped = wrapText(`${BOLD}the quick brown fox${UNBOLD}`, 10);
    expect(wrapped).toHaveLength(2);
    expect(wrapped[0]?.startsWith(BOLD)).toBe(true);
    // The continuation line re-opens the style rather than losing it.
    expect(wrapped[1]?.startsWith(BOLD)).toBe(true);
    expect(wrapped.map(stripAnsi)).toEqual(["the quick", "brown fox"]);
  });

  it("indents continuation lines", () => {
    expect(wrapText("the quick brown fox", 10, { indent: "  " })).toEqual([
      "the quick",
      "  brown",
      "  fox",
    ]);
  });

  it("never produces a line wider than the requested width", () => {
    const text = "日本語 mixed with ASCII and 👍 emoji plus a verylongunbrokenword here";
    for (const width of [5, 8, 13, 20]) {
      for (const line of wrapText(text, width)) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("truncateToWidth", () => {
  it("leaves short strings alone", () => {
    expect(truncateToWidth("hi", 10)).toBe("hi");
  });

  it("appends an ellipsis when clipping", () => {
    expect(truncateToWidth("hello world", 8)).toBe("hello w…");
    expect(stringWidth(truncateToWidth("hello world", 8))).toBe(8);
  });

  it("never splits a wide character in half", () => {
    const result = truncateToWidth("日本語テキスト", 7);
    expect(result).toBe("日本語…");
    expect(stringWidth(result)).toBe(7);
  });

  it("keeps styling on the retained prefix", () => {
    const result = truncateToWidth(`${BOLD}hello world${UNBOLD}`, 8);
    expect(stripAnsi(result)).toBe("hello w…");
    expect(result.startsWith(BOLD)).toBe(true);
  });

  it("supports an empty ellipsis and zero width", () => {
    expect(truncateToWidth("hello", 3, "")).toBe("hel");
    expect(truncateToWidth("hello", 0)).toBe("");
  });
});

describe("sliceByWidth", () => {
  it("slices by display column", () => {
    expect(sliceByWidth("abcdef", 2, 4)).toBe("cd");
    expect(sliceByWidth("abcdef", 3)).toBe("def");
  });

  it("substitutes a space for a wide glyph clipped at the boundary", () => {
    expect(sliceByWidth("日本語", 1, 4)).toBe(" 本");
  });

  it("carries active styling into the slice", () => {
    const sliced = sliceByWidth(`${BOLD}abcdef${UNBOLD}`, 2, 4);
    expect(stripAnsi(sliced)).toBe("cd");
    expect(sliced.startsWith(BOLD)).toBe(true);
  });
});

describe("padToWidth", () => {
  it("pads left, centre and right", () => {
    expect(padToWidth("ab", 5)).toBe("ab   ");
    expect(padToWidth("ab", 5, "right")).toBe("   ab");
    expect(padToWidth("ab", 5, "center")).toBe(" ab  ");
  });

  it("accounts for wide characters", () => {
    expect(padToWidth("日", 4)).toBe("日  ");
  });

  it("truncates content that is already too wide", () => {
    expect(stringWidth(padToWidth("hello world", 5))).toBe(5);
  });
});
