import { describe, expect, it } from "vitest";
import {
  ASCII_GLYPHS,
  FANCY_GLYPHS,
  type GlyphSet,
  resolveGlyphs,
  supportsUnicode,
  toolGlyph,
} from "./glyphs.js";

describe("supportsUnicode", () => {
  it("treats UTF-8 locales as capable", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
    expect(supportsUnicode({ LC_ALL: "C.UTF-8" })).toBe(true);
    expect(supportsUnicode({ LC_CTYPE: "en_GB.utf8" })).toBe(true);
  });

  it("defaults to capable when no locale hint is present", () => {
    expect(supportsUnicode({})).toBe(true);
  });

  it("falls back to ASCII for non-UTF-8 locales and dumb terminals", () => {
    expect(supportsUnicode({ LANG: "C" })).toBe(false);
    expect(supportsUnicode({ LC_ALL: "POSIX" })).toBe(false);
    expect(supportsUnicode({ TERM: "dumb", LANG: "en_US.UTF-8" })).toBe(false);
  });

  it("honours the ARCTURN_ASCII opt-out even on a UTF-8 terminal", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8", ARCTURN_ASCII: "1" })).toBe(false);
  });

  it("trusts a known terminal program regardless of locale", () => {
    expect(supportsUnicode({ TERM_PROGRAM: "iTerm.app", LANG: "C" })).toBe(true);
  });
});

describe("resolveGlyphs", () => {
  it("returns the fancy set on capable terminals and the ASCII set otherwise", () => {
    expect(resolveGlyphs({ LANG: "en_US.UTF-8" })).toBe(FANCY_GLYPHS);
    expect(resolveGlyphs({ LANG: "C" })).toBe(ASCII_GLYPHS);
  });

  it("keeps the two sets genuinely distinct", () => {
    expect(FANCY_GLYPHS.brand).not.toBe(ASCII_GLYPHS.brand);
    expect(FANCY_GLYPHS.statusDot).toBe("●");
    expect(ASCII_GLYPHS.statusDot).toBe("*");
    // Every ASCII glyph must be printable 7-bit ASCII.
    const ascii = Object.values(ASCII_GLYPHS.tools).join("");
    expect(/^[\x20-\x7E]*$/.test(ascii)).toBe(true);
  });
});

describe("toolGlyph", () => {
  it("selects a per-tool glyph in the fancy set", () => {
    expect(toolGlyph("read", FANCY_GLYPHS)).toBe("◇");
    expect(toolGlyph("bash", FANCY_GLYPHS)).toBe("❯");
    expect(toolGlyph("edit", FANCY_GLYPHS)).toBe("✎");
    expect(toolGlyph("grep", FANCY_GLYPHS)).toBe("⌕");
  });

  it("selects the matching ASCII glyph in the fallback set", () => {
    expect(toolGlyph("read", ASCII_GLYPHS)).toBe("-");
    expect(toolGlyph("bash", ASCII_GLYPHS)).toBe("$");
  });

  it("falls back to the default glyph for unknown tools", () => {
    const set: GlyphSet = FANCY_GLYPHS;
    expect(toolGlyph("mystery-tool", set)).toBe(set.toolDefault);
  });
});
