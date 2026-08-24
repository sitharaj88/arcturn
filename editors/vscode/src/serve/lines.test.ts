import { describe, expect, it } from "vitest";
import { createLineSplitter } from "./lines.js";

describe("createLineSplitter", () => {
  it("emits one line per newline, whatever the chunk boundaries are", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("arcturn serv");
    splitter.push("ing on ws://127.0.0.1:1\n  press Ctr");
    splitter.push("l+C to stop\n");
    expect(lines).toEqual(["arcturn serving on ws://127.0.0.1:1", "  press Ctrl+C to stop"]);
  });

  it("strips a trailing carriage return", () => {
    const lines: string[] = [];
    createLineSplitter((line) => lines.push(line)).push("a\r\nb\r\n");
    expect(lines).toEqual(["a", "b"]);
  });

  it("decodes a Buffer chunk, which is what a child stdout delivers", () => {
    const lines: string[] = [];
    createLineSplitter((line) => lines.push(line)).push(Buffer.from("hello\n", "utf8"));
    expect(lines).toEqual(["hello"]);
  });

  it("flush emits a trailing partial line", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push("no newline here");
    expect(lines).toEqual([]);
    splitter.flush();
    expect(lines).toEqual(["no newline here"]);
    splitter.flush();
    expect(lines).toEqual(["no newline here"]);
  });

  it("drops a pathologically long line instead of buffering it forever", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line), { maxLineLength: 8 });
    splitter.push("aaaaaaaaaaaaaaaaaaaaaaaa");
    splitter.push("bbbb\nrecovered\n");
    expect(lines).toEqual(["recovered"]);
  });

  it("stops emitting after dispose", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.dispose();
    splitter.push("ignored\n");
    splitter.flush();
    expect(lines).toEqual([]);
  });
});
