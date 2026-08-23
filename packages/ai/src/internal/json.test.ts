import { describe, expect, it } from "vitest";
import { isCompleteJsonObject, parseToolArguments } from "./json.js";

describe("parseToolArguments", () => {
  it("parses well-formed JSON objects", () => {
    expect(parseToolArguments('{"path":"a.ts","limit":10}')).toEqual({ path: "a.ts", limit: 10 });
  });

  it("returns an empty object for empty input", () => {
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
  });

  it("repairs raw control characters inside strings", () => {
    expect(parseToolArguments('{"text":"line1\nline2"}')).toEqual({ text: "line1\nline2" });
  });

  it("completes a truncated object", () => {
    expect(parseToolArguments('{"path":"src/index.ts","content":"hel')).toEqual({
      path: "src/index.ts",
    });
  });

  it("completes truncated nested structures", () => {
    expect(parseToolArguments('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } });
  });

  it("drops a dangling key with no value", () => {
    expect(parseToolArguments('{"a":1,"b":')).toEqual({ a: 1 });
  });

  it("falls back to an empty object for hopeless input", () => {
    expect(parseToolArguments("not json at all")).toEqual({});
  });

  it("rejects non-object JSON", () => {
    expect(parseToolArguments("[1,2,3]")).toEqual({});
    expect(parseToolArguments('"a string"')).toEqual({});
  });

  it("never throws on arbitrary fragments", () => {
    const fragments = ['{"a":"\\', "{{{{", '{"a":"b"', "}", '{"a":\\u00'];
    for (const fragment of fragments) {
      expect(() => parseToolArguments(fragment)).not.toThrow();
    }
  });
});

describe("isCompleteJsonObject", () => {
  it("distinguishes complete from partial payloads", () => {
    expect(isCompleteJsonObject('{"a":1}')).toBe(true);
    expect(isCompleteJsonObject('{"a":1')).toBe(false);
  });
});
