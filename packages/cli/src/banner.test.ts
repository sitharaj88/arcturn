import { ColorLevel, setColorLevel, stripAnsi } from "@arcturn/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { bannerLines } from "./banner.js";
import { ASCII_GLYPHS, FANCY_GLYPHS } from "./glyphs.js";
import { LOGO_HEIGHT, LOGO_WIDTH, renderLogo } from "./logo.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

const info = {
  glyphs: FANCY_GLYPHS,
  model: "Claude Sonnet 4.5",
  mode: "default",
  cwd: "~/projects/demo",
  version: "0.1.0",
};

describe("renderLogo", () => {
  it("renders a fixed-size mark from the bitmap", () => {
    const art = renderLogo({ plain: true });
    expect(art).toHaveLength(LOGO_HEIGHT);
    for (const line of art) expect(line.length).toBeLessThanOrEqual(LOGO_WIDTH);
    // The bar, the stem and the tail are all present.
    expect(art[0]).toContain("█");
    expect(art.join("\n")).toContain("▀");
  });

  it("is identical with and without colour once styles are stripped", () => {
    setColorLevel(ColorLevel.TrueColor);
    const coloured = renderLogo().map(stripAnsi);
    setColorLevel(ColorLevel.None);
    expect(coloured).toEqual(renderLogo({ plain: true }));
  });
});

describe("bannerLines", () => {
  it("draws the hero banner with the mark on wide Unicode terminals", () => {
    const text = bannerLines({ ...info, width: 90 }).join("\n");
    expect(text).toContain("█");
    // The wordmark is pixel type now — three rows of half-blocks, not text.
    expect(text).toContain("▀");
    expect(text).toContain("every turn counts");
    expect(text).toContain("v0.1.0");
    expect(text).toContain("Claude Sonnet 4.5");
    expect(text).toContain("~/projects/demo");
    // A one-line keymap replaces the tips paragraph.
    expect(text).toContain("commands");
    expect(text).toContain("interrupt");
    // The hero is deliberately borderless — its one decoration is the brand
    // rule, not a frame.
    expect(text).not.toContain("╭");
    expect(text).toContain("─");
  });

  it("keeps every hero row within the terminal width", () => {
    for (const line of bannerLines({ ...info, width: 74 })) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(74);
    }
  });

  it("shows the keymap strip on the hero banner", () => {
    const text = bannerLines({ ...info, width: 90 }).join("\n");
    expect(text).toContain("send");
    expect(text).toContain("commands");
    expect(text).toContain("steer the run");
  });

  it("clips over-long facts instead of breaking the frame", () => {
    const long = {
      ...info,
      model: "a-very-long-model-display-name-that-cannot-possibly-fit",
      cwd: `/deep/${"nested/".repeat(20)}dir`,
    };
    for (const width of [30, 45, 60, 74, 100]) {
      for (const line of bannerLines({ ...long, width })) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("falls back to the plain card below the hero width", () => {
    // The pixel hero fits down to 52 columns; below that, the framed card.
    const text = bannerLines({ ...info, width: 48 }).join("\n");
    expect(text).not.toContain("█");
    expect(text).toContain("arcturn");
    expect(text).toContain("╭");
  });

  it("never draws block art on ASCII terminals", () => {
    const text = bannerLines({ ...info, glyphs: ASCII_GLYPHS, width: 90 }).join("\n");
    expect(text).not.toContain("█");
    expect(text).not.toContain("▌");
    expect(text).toContain("arcturn");
    expect(text).toContain("+");
  });

  it("degrades to three unframed lines when very narrow", () => {
    const lines = bannerLines({ ...info, width: 24 });
    expect(lines.join("\n")).not.toContain("╭");
    expect(lines[0]).toContain("arcturn");
  });
});
