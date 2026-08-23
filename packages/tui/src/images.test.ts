import { describe, expect, it } from "vitest";
import { BEL, ESC } from "./ansi.js";
import {
  detectImageSupport,
  encodeItermImage,
  encodeKittyImage,
  imagePlaceholderLines,
  renderImage,
} from "./images.js";
import { stringWidth } from "./width.js";

const KITTY_START = `${ESC}_G`;
const KITTY_END = `${ESC}\\`;

describe("detectImageSupport", () => {
  it("defaults to none on a bare environment", () => {
    expect(detectImageSupport({})).toBe("none");
  });

  it("detects kitty via TERM containing 'kitty'", () => {
    expect(detectImageSupport({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(detectImageSupport({ TERM: "KITTY" })).toBe("kitty");
  });

  it("detects kitty via KITTY_WINDOW_ID", () => {
    expect(detectImageSupport({ TERM: "xterm-256color", KITTY_WINDOW_ID: "1" })).toBe("kitty");
  });

  it("ignores an empty KITTY_WINDOW_ID", () => {
    expect(detectImageSupport({ TERM: "xterm-256color", KITTY_WINDOW_ID: "" })).toBe("none");
  });

  it("detects iterm via TERM_PROGRAM=iTerm.app", () => {
    expect(detectImageSupport({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
  });

  it("detects iterm via TERM_PROGRAM=WezTerm", () => {
    expect(detectImageSupport({ TERM_PROGRAM: "WezTerm" })).toBe("iterm");
  });

  it("does not treat other TERM_PROGRAM values as iterm support", () => {
    expect(detectImageSupport({ TERM_PROGRAM: "vscode" })).toBe("none");
    expect(detectImageSupport({ TERM_PROGRAM: "Apple_Terminal" })).toBe("none");
  });

  it("prefers kitty detection over iterm when both signals are present", () => {
    expect(detectImageSupport({ TERM: "xterm-kitty", TERM_PROGRAM: "iTerm.app" })).toBe("kitty");
  });

  it("honours the ARCTURN_NO_IMAGES opt-out over every other signal", () => {
    expect(detectImageSupport({ TERM: "xterm-kitty", ARCTURN_NO_IMAGES: "1" })).toBe("none");
    expect(detectImageSupport({ TERM_PROGRAM: "iTerm.app", ARCTURN_NO_IMAGES: "true" })).toBe(
      "none",
    );
  });

  it("treats an empty ARCTURN_NO_IMAGES as not opting out", () => {
    expect(detectImageSupport({ TERM: "xterm-kitty", ARCTURN_NO_IMAGES: "" })).toBe("kitty");
  });
});

describe("encodeKittyImage", () => {
  it("produces a single chunk for small payloads, flagged a=T and m=0", () => {
    const data = Buffer.from("small png bytes");
    const seq = encodeKittyImage(data);

    expect(seq.startsWith(KITTY_START)).toBe(true);
    expect(seq.endsWith(KITTY_END)).toBe(true);

    const control = seq.slice(KITTY_START.length, seq.indexOf(";"));
    expect(control).toContain("a=T");
    expect(control).toContain("f=100");
    expect(control).toContain("m=0");

    const payload = seq.slice(seq.indexOf(";") + 1, seq.length - KITTY_END.length);
    expect(payload).toBe(data.toString("base64"));
  });

  it("splits payloads over 4096 base64 bytes into multiple correctly-flagged chunks", () => {
    const data = Buffer.alloc(6000, 0x42); // -> base64 length well over 4096
    const seq = encodeKittyImage(data);

    // Split the concatenated APC sequences back into individual chunks.
    const parts = seq
      .split(KITTY_END)
      .filter((s) => s.length > 0)
      .map((s) => s + KITTY_END);

    expect(parts.length).toBeGreaterThan(1);

    const first = parts[0]!;
    const last = parts[parts.length - 1]!;

    expect(first.startsWith(KITTY_START)).toBe(true);
    const firstControl = first.slice(KITTY_START.length, first.indexOf(";"));
    expect(firstControl).toContain("a=T");
    expect(firstControl).toContain("f=100");
    expect(firstControl).toContain("m=1");

    const lastControl = last.slice(KITTY_START.length, last.indexOf(";"));
    expect(lastControl).toContain("m=0");
    expect(lastControl).not.toContain("a=T"); // continuation chunks omit transmission keys

    // Every middle chunk (not first, not last) also carries m=1 and no control data.
    for (const part of parts.slice(1, -1)) {
      const ctrl = part.slice(KITTY_START.length, part.indexOf(";"));
      expect(ctrl).toBe("m=1");
    }

    // Each chunk's base64 payload is at most 4096 characters.
    for (const part of parts) {
      const payload = part.slice(part.indexOf(";") + 1, part.length - KITTY_END.length);
      expect(payload.length).toBeLessThanOrEqual(4096);
    }

    // Reassembling every payload reproduces the original base64 (and thus the bytes).
    const reassembled = parts
      .map((p) => p.slice(p.indexOf(";") + 1, p.length - KITTY_END.length))
      .join("");
    expect(reassembled).toBe(data.toString("base64"));
    expect(Buffer.from(reassembled, "base64").equals(data)).toBe(true);
  });

  it("forwards id, columns and rows as control keys on the first chunk", () => {
    const seq = encodeKittyImage(Buffer.from("x"), { id: 7, columns: 40, rows: 12 });
    const control = seq.slice(KITTY_START.length, seq.indexOf(";"));
    expect(control).toContain("i=7");
    expect(control).toContain("c=40");
    expect(control).toContain("r=12");
  });

  it("handles an empty buffer without producing an unterminated sequence", () => {
    const seq = encodeKittyImage(Buffer.alloc(0));
    expect(seq.startsWith(KITTY_START)).toBe(true);
    expect(seq.endsWith(KITTY_END)).toBe(true);
    expect(seq).toContain("a=T");
    expect(seq).toContain("m=0");
  });

  it("handles a huge buffer, producing the expected number of chunks", () => {
    const size = 200_000;
    const data = Buffer.alloc(size, 0x7);
    const seq = encodeKittyImage(data);
    const base64Length = data.toString("base64").length;
    const expectedChunks = Math.ceil(base64Length / 4096);

    const parts = seq.split(KITTY_END).filter((s) => s.length > 0);
    expect(parts.length).toBe(expectedChunks);
  });
});

describe("encodeItermImage", () => {
  it("produces the ESC]1337;File=inline=1;size=N:<base64> BEL shape", () => {
    const data = Buffer.from("hello iterm");
    const seq = encodeItermImage(data);

    expect(seq.startsWith(`${ESC}]1337;File=`)).toBe(true);
    expect(seq.endsWith(BEL)).toBe(true);

    const body = seq.slice(`${ESC}]1337;File=`.length, seq.length - BEL.length);
    const [params, payload] = body.split(":");
    expect(params).toContain("inline=1");
    expect(params).toContain(`size=${data.length}`);
    expect(payload).toBe(data.toString("base64"));
  });

  it("base64-encodes the name field", () => {
    const seq = encodeItermImage(Buffer.from("x"), { name: "diagram.png" });
    const expectedName = Buffer.from("diagram.png", "utf8").toString("base64");
    expect(seq).toContain(`name=${expectedName}`);
  });

  it("includes width/height and preserveAspectRatio when given", () => {
    const seq = encodeItermImage(Buffer.from("x"), {
      width: 40,
      height: "auto",
      preserveAspectRatio: false,
    });
    expect(seq).toContain("width=40");
    expect(seq).toContain("height=auto");
    expect(seq).toContain("preserveAspectRatio=0");
  });

  it("handles an empty buffer without producing an unterminated sequence", () => {
    const seq = encodeItermImage(Buffer.alloc(0));
    expect(seq.startsWith(`${ESC}]1337;File=`)).toBe(true);
    expect(seq.endsWith(BEL)).toBe(true);
    expect(seq).toContain("size=0");
  });
});

describe("renderImage", () => {
  const data = Buffer.alloc(24 * 1024, 0x1);

  it("returns a kitty escape sequence when support is kitty", () => {
    const out = renderImage(data, { support: "kitty", altText: "diagram.png" });
    expect(out.startsWith(KITTY_START)).toBe(true);
    expect(out.endsWith(KITTY_END)).toBe(true);
  });

  it("returns an iterm escape sequence when support is iterm", () => {
    const out = renderImage(data, { support: "iterm", altText: "diagram.png" });
    expect(out.startsWith(`${ESC}]1337;File=`)).toBe(true);
    expect(out.endsWith(BEL)).toBe(true);
    const expectedName = Buffer.from("diagram.png", "utf8").toString("base64");
    expect(out).toContain(`name=${expectedName}`);
  });

  it("falls back to an alt-text placeholder when support is none", () => {
    const out = renderImage(data, { support: "none", altText: "diagram.png" });
    expect(out).toBe("[image: diagram.png 24KB]");
  });

  it("never emits an escape character in the fallback path", () => {
    const out = renderImage(data, { support: "none", altText: "diagram.png" });
    expect(out.includes(ESC)).toBe(false);
  });

  it("handles an empty buffer for every support level", () => {
    const empty = Buffer.alloc(0);
    expect(renderImage(empty, { support: "none", altText: "x" })).toBe("[image: x 0B]");
    expect(renderImage(empty, { support: "kitty", altText: "x" }).endsWith(KITTY_END)).toBe(true);
    expect(renderImage(empty, { support: "iterm", altText: "x" }).endsWith(BEL)).toBe(true);
  });

  it("handles a huge buffer for every support level without throwing", () => {
    const huge = Buffer.alloc(5_000_000, 0x9);
    expect(() => renderImage(huge, { support: "none", altText: "big" })).not.toThrow();
    expect(renderImage(huge, { support: "none", altText: "big" })).toBe("[image: big 4.8MB]");
    expect(() => renderImage(huge, { support: "kitty", altText: "big" })).not.toThrow();
    expect(() => renderImage(huge, { support: "iterm", altText: "big" })).not.toThrow();
  });

  it("forwards maxRows to the kitty/iterm encoders", () => {
    const kitty = renderImage(data, { support: "kitty", altText: "x", maxRows: 10 });
    const control = kitty.slice(KITTY_START.length, kitty.indexOf(";"));
    expect(control).toContain("r=10");

    const iterm = renderImage(data, { support: "iterm", altText: "x", maxRows: 10 });
    expect(iterm).toContain("height=10");
  });
});

describe("imagePlaceholderLines", () => {
  it("returns exactly `rows` lines", () => {
    expect(imagePlaceholderLines(5, "diagram.png")).toHaveLength(5);
    expect(imagePlaceholderLines(1, "x")).toHaveLength(1);
  });

  it("clamps rows below 1 up to a single line", () => {
    expect(imagePlaceholderLines(0, "x")).toHaveLength(1);
    expect(imagePlaceholderLines(-3, "x")).toHaveLength(1);
  });

  it("truncates a fractional row count", () => {
    expect(imagePlaceholderLines(3.9, "x")).toHaveLength(3);
  });

  it("puts the label on the first line", () => {
    const lines = imagePlaceholderLines(3, "diagram.png");
    expect(lines[0]).toBe("[image: diagram.png]");
  });

  it("gives every line the same measured width", () => {
    const lines = imagePlaceholderLines(4, "a longer label.png");
    const widths = lines.map((line) => stringWidth(line));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(stringWidth("[image: a longer label.png]"));
  });

  it("measures correctly even for wide-character labels", () => {
    const lines = imagePlaceholderLines(2, "日本語.png");
    expect(stringWidth(lines[0]!)).toBe(stringWidth(lines[1]!));
    expect(stringWidth(lines[0]!)).toBe(stringWidth("[image: 日本語.png]"));
  });
});
