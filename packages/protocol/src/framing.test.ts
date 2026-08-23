import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINE_LENGTH, encodeFrame, FrameDecoder, isProtocolError } from "./framing.js";

describe("encodeFrame", () => {
  it("JSON-stringifies and appends a single LF", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
    expect(encodeFrame("hello")).toBe('"hello"\n');
    expect(encodeFrame(null)).toBe("null\n");
    expect(encodeFrame([1, 2, 3])).toBe("[1,2,3]\n");
  });
});

describe("FrameDecoder basic framing", () => {
  it("decodes a single frame fed as one chunk", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed('{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it("decodes multiple frames present in a single chunk", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("reassembles a frame split across multiple feed() calls", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed('{"a":')).toEqual([]);
    expect(decoder.feed("1")).toEqual([]);
    expect(decoder.feed("}\n")).toEqual([{ a: 1 }]);
  });

  it("holds back an incomplete trailing frame across calls", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }]);
    expect(decoder.feed("\n")).toEqual([{ b: 2 }]);
  });

  it("skips blank lines", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed('{"a":1}\n\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("tolerates CRLF line endings", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed('{"a":1}\r\n{"b":2}\r\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("tolerates a CRLF split so the CR and LF land in different chunks", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed('{"a":1}\r')).toEqual([]);
    expect(decoder.feed("\n")).toEqual([{ a: 1 }]);
  });

  it("does not treat U+2028/U+2029 as delimiters (they are frame content)", () => {
    const decoder = new FrameDecoder();
    const value = { text: "line1 line2 line3" };
    const frames = decoder.feed(encodeFrame(value));
    expect(frames).toEqual([value]);
  });

  it("decodes values fed as Uint8Array chunks", () => {
    const decoder = new FrameDecoder();
    const bytes = new TextEncoder().encode('{"a":1}\n{"b":2}\n');
    expect(decoder.feed(bytes)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("round-trips encodeFrame through FrameDecoder", () => {
    const decoder = new FrameDecoder();
    const value = { hello: "world", n: 42, nested: { arr: [1, 2, 3] } };
    expect(decoder.feed(encodeFrame(value))).toEqual([value]);
  });
});

describe("FrameDecoder malformed-line recovery", () => {
  it("emits a ProtocolError for malformed JSON without throwing, and keeps going", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.feed('{"a":1}\nnot json at all\n{"b":2}\n');
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({ a: 1 });
    expect(isProtocolError(frames[1])).toBe(true);
    if (isProtocolError(frames[1])) {
      expect(frames[1].code).toBe("malformedJson");
      expect(frames[1].raw).toBe("not json at all");
    }
    expect(frames[2]).toEqual({ b: 2 });
  });

  it("recovers a malformed line split across chunk boundaries", () => {
    const decoder = new FrameDecoder();
    expect(decoder.feed("not js")).toEqual([]);
    const frames = decoder.feed('on\n{"ok":true}\n');
    expect(isProtocolError(frames[0])).toBe(true);
    expect(frames[1]).toEqual({ ok: true });
  });
});

describe("FrameDecoder max-line-length guard", () => {
  it("uses a 32 MiB default", () => {
    expect(DEFAULT_MAX_LINE_LENGTH).toBe(32 * 1024 * 1024);
  });

  it("errors an overlong frame and resyncs at the next newline", () => {
    const decoder = new FrameDecoder({ maxLineLength: 16 });
    const overlong = `{"pad":"${"x".repeat(40)}"}`;
    const frames = decoder.feed(`${overlong}\n{"ok":1}\n`);
    expect(frames).toHaveLength(2);
    expect(isProtocolError(frames[0])).toBe(true);
    if (isProtocolError(frames[0])) {
      expect(frames[0].code).toBe("lineTooLong");
    }
    expect(frames[1]).toEqual({ ok: 1 });
  });

  it("resyncs even when the overlong line's terminator arrives in a later chunk", () => {
    const decoder = new FrameDecoder({ maxLineLength: 8 });
    // Threshold crossed with no newline in sight yet: error fires immediately
    // and the decoder starts discarding until it finds one.
    const first = decoder.feed("x".repeat(20));
    expect(first).toHaveLength(1);
    expect(isProtocolError(first[0])).toBe(true);
    if (isProtocolError(first[0])) expect(first[0].code).toBe("lineTooLong");
    // Still garbage, still resyncing: no repeated error while no newline appears.
    expect(decoder.feed("x".repeat(20))).toEqual([]);
    expect(decoder.feed('garbage-tail\n{"ok":1}\n')).toEqual([{ ok: 1 }]);
  });

  it("does not flag a line right at the boundary", () => {
    const decoder = new FrameDecoder({ maxLineLength: 100 });
    const line = JSON.stringify({ v: "y".repeat(50) });
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(100);
    expect(decoder.feed(`${line}\n`)).toEqual([JSON.parse(line)]);
  });
});

describe("FrameDecoder UTF-8 chunk-boundary splitting", () => {
  it("reassembles a multi-byte emoji split across Uint8Array chunks", () => {
    const decoder = new FrameDecoder();
    const value = { emoji: "🚀🔥🎉" };
    const bytes = new TextEncoder().encode(encodeFrame(value));
    const frames: unknown[] = [];
    for (const byte of bytes) {
      frames.push(...decoder.feed(new Uint8Array([byte])));
    }
    expect(frames).toEqual([value]);
  });

  it("reassembles CJK text split across Uint8Array chunks at every byte position", () => {
    const value = { text: "你好，世界。こんにちは世界" };
    const bytes = new TextEncoder().encode(encodeFrame(value));
    for (let splitAt = 0; splitAt <= bytes.length; splitAt++) {
      const decoder = new FrameDecoder();
      const first = bytes.slice(0, splitAt);
      const second = bytes.slice(splitAt);
      const frames = [...decoder.feed(first), ...decoder.feed(second)];
      expect(frames, `split at byte ${splitAt}`).toEqual([value]);
    }
  });
});

describe("FrameDecoder fuzz: multi-frame buffer split at every byte position", () => {
  it("reassembles three frames regardless of where the string is split", () => {
    const text = `${encodeFrame({ a: 1 })}${encodeFrame({ b: "two" })}${encodeFrame([1, 2, 3])}`;
    const expected = [{ a: 1 }, { b: "two" }, [1, 2, 3]];
    for (let splitAt = 0; splitAt <= text.length; splitAt++) {
      const decoder = new FrameDecoder();
      const first = text.slice(0, splitAt);
      const second = text.slice(splitAt);
      const frames = [...decoder.feed(first), ...decoder.feed(second)];
      expect(frames, `split at char ${splitAt}`).toEqual(expected);
    }
  });

  it("reassembles the same buffer split into three arbitrary pieces at every pair of cut points", () => {
    const text = `${encodeFrame({ x: true })}${encodeFrame({ y: false })}`;
    const expected = [{ x: true }, { y: false }];
    for (let i = 0; i <= text.length; i++) {
      for (let j = i; j <= text.length; j++) {
        const decoder = new FrameDecoder();
        const frames = [
          ...decoder.feed(text.slice(0, i)),
          ...decoder.feed(text.slice(i, j)),
          ...decoder.feed(text.slice(j)),
        ];
        expect(frames, `cuts at ${i},${j}`).toEqual(expected);
      }
    }
  });
});
