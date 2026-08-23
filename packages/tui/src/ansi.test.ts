import { afterEach, describe, expect, it } from "vitest";
import {
  bold,
  ColorLevel,
  combine,
  cursorTo,
  cursorUp,
  detectColorLevel,
  fg,
  getColorLevel,
  hasAnsi,
  hyperlink,
  sanitizeUntrustedText,
  setColorLevel,
  stripAnsi,
  underline,
} from "./ansi.js";

const ESC = "\u001b";
const originalLevel = getColorLevel();

afterEach(() => {
  setColorLevel(originalLevel);
});

function hyperlinkAtLevel(level: ColorLevel): string {
  setColorLevel(level);
  return hyperlink("Arcturn", "https://example.com");
}

describe("stripAnsi", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsi(`${ESC}[1mbold${ESC}[22m`)).toBe("bold");
    expect(stripAnsi(`${ESC}[38;5;213mpink${ESC}[39m`)).toBe("pink");
    expect(stripAnsi(`${ESC}[38;2;10;20;30mrgb${ESC}[39m`)).toBe("rgb");
  });

  it("removes cursor and erase sequences", () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[3;5Hx`)).toBe("x");
    expect(stripAnsi(`${ESC}[?25lhidden${ESC}[?25h`)).toBe("hidden");
  });

  it("removes OSC-8 hyperlinks", () => {
    expect(stripAnsi(hyperlinkAtLevel(ColorLevel.TrueColor))).toBe("Arcturn");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain")).toBe("plain");
    expect(hasAnsi("plain")).toBe(false);
    expect(hasAnsi(`${ESC}[1mx${ESC}[22m`)).toBe(true);
  });
});

describe("style helpers", () => {
  it("emits nothing when colour is disabled", () => {
    setColorLevel(ColorLevel.None);
    expect(bold("hi")).toBe("hi");
    expect(fg("red")("hi")).toBe("hi");
  });

  it("wraps text in open/close codes", () => {
    setColorLevel(ColorLevel.TrueColor);
    expect(bold("hi")).toBe(`${ESC}[1mhi${ESC}[22m`);
    expect(underline("hi")).toBe(`${ESC}[4mhi${ESC}[24m`);
  });

  it("re-opens the outer style after a nested close", () => {
    setColorLevel(ColorLevel.TrueColor);
    const nested = bold(`a${underline("b")}c`);
    // The inner close must not terminate the outer bold.
    expect(nested.endsWith(`${ESC}[22m`)).toBe(true);
    expect(stripAnsi(nested)).toBe("abc");
  });

  it("degrades truecolour to 256 and to basic", () => {
    setColorLevel(ColorLevel.TrueColor);
    expect(fg([255, 0, 0])("x")).toBe(`${ESC}[38;2;255;0;0mx${ESC}[39m`);
    setColorLevel(ColorLevel.Ansi256);
    expect(fg([255, 0, 0])("x")).toMatch(new RegExp(`^${ESC}\\[38;5;\\d+mx${ESC}\\[39m$`));
    setColorLevel(ColorLevel.Basic);
    expect(fg([255, 0, 0])("x")).toMatch(new RegExp(`^${ESC}\\[3\\dmx${ESC}\\[39m$`));
  });

  it("combines styles outermost-first", () => {
    setColorLevel(ColorLevel.TrueColor);
    const strong = combine(bold, underline);
    expect(stripAnsi(strong("x"))).toBe("x");
    expect(strong("x").startsWith(`${ESC}[1m`)).toBe(true);
  });
});

describe("detectColorLevel", () => {
  it("honours NO_COLOR", () => {
    expect(detectColorLevel({ env: { NO_COLOR: "1", TERM: "xterm-256color" }, isTTY: true })).toBe(
      ColorLevel.None,
    );
  });

  it("returns None for a non-TTY", () => {
    expect(detectColorLevel({ env: { TERM: "xterm-256color" }, isTTY: false })).toBe(
      ColorLevel.None,
    );
  });

  it("returns None for TERM=dumb even on a TTY", () => {
    expect(detectColorLevel({ env: { TERM: "dumb" }, isTTY: true })).toBe(ColorLevel.None);
  });

  it("detects truecolour and 256-colour terminals", () => {
    expect(detectColorLevel({ env: { TERM: "xterm", COLORTERM: "truecolor" }, isTTY: true })).toBe(
      ColorLevel.TrueColor,
    );
    expect(detectColorLevel({ env: { TERM: "screen-256color" }, isTTY: true })).toBe(
      ColorLevel.Ansi256,
    );
  });

  it("honours FORCE_COLOR even without a TTY", () => {
    expect(detectColorLevel({ env: { FORCE_COLOR: "3" }, isTTY: false })).toBe(
      ColorLevel.TrueColor,
    );
    expect(detectColorLevel({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe(ColorLevel.None);
  });
});

describe("sanitizeUntrustedText", () => {
  const BEL = "\x07";

  it("strips complete ANSI escape sequences", () => {
    expect(sanitizeUntrustedText(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  it("strips an OSC 52 clipboard-write sequence", () => {
    expect(sanitizeUntrustedText(`before${ESC}]52;c;b3duZWQ=${BEL}after`)).toBe("beforeafter");
  });

  it("strips a bare ESC with no following sequence", () => {
    expect(sanitizeUntrustedText(`a${ESC}b`)).toBe("ab");
  });

  it("strips a bare BEL", () => {
    expect(sanitizeUntrustedText(`a${BEL}b`)).toBe("ab");
  });

  it("strips DEL and other C0/C1 control bytes", () => {
    expect(sanitizeUntrustedText("a\x7fb\x01c\x9fd")).toBe("abcd");
  });

  it("preserves newline, tab and carriage return", () => {
    expect(sanitizeUntrustedText("a\nb\tc\rd")).toBe("a\nb\tc\rd");
  });

  it("leaves unicode and emoji untouched", () => {
    expect(sanitizeUntrustedText("héllo 世界 🎉👍🏽")).toBe("héllo 世界 🎉👍🏽");
  });
});

describe("cursor codes", () => {
  it("converts 0-based coordinates to 1-based ANSI", () => {
    expect(cursorTo(0, 0)).toBe(`${ESC}[1;1H`);
    expect(cursorTo(4, 9)).toBe(`${ESC}[5;10H`);
  });

  it("emits nothing for a zero-length move", () => {
    expect(cursorUp(0)).toBe("");
    expect(cursorUp(3)).toBe(`${ESC}[3A`);
  });
});
