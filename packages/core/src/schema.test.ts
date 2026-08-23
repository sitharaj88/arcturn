import { describe, expect, it } from "vitest";
import { formatSchemaErrors, validateSchema, validateToolInput } from "./schema.js";

describe("validateSchema", () => {
  it("accepts a matching object", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name"],
    };
    expect(validateSchema(schema, { name: "arcturn", age: 2 }).valid).toBe(true);
  });

  it("reports missing required properties", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const result = validateSchema(schema, {});
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ path: "/path", message: "is required" }]);
  });

  it("reports type mismatches with the received value", () => {
    const result = validateSchema(
      { type: "object", properties: { n: { type: "number" } } },
      { n: "x" },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe("/n");
    expect(result.errors[0]?.message).toContain("expected number");
  });

  it("treats integers as numbers but not the reverse", () => {
    expect(validateSchema({ type: "number" }, 3).valid).toBe(true);
    expect(validateSchema({ type: "integer" }, 3.5).valid).toBe(false);
  });

  it("enforces enums", () => {
    const schema = { type: "string", enum: ["pending", "done"] };
    expect(validateSchema(schema, "done").valid).toBe(true);
    const bad = validateSchema(schema, "nope");
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]?.message).toContain("must be one of");
  });

  it("validates nested arrays of objects", () => {
    const schema = {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, status: { enum: ["pending", "done"] } },
            required: ["text", "status"],
          },
        },
      },
      required: ["todos"],
    };
    const bad = validateSchema(schema, { todos: [{ text: "a", status: "pending" }, { text: 3 }] });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.path)).toContain("/todos/1/text");
    expect(bad.errors.map((e) => e.path)).toContain("/todos/1/status");
  });

  it("rejects unexpected properties when additionalProperties is false", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const result = validateSchema(schema, { a: "ok", b: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe("/b");
  });

  it("honours string, number and array bounds", () => {
    expect(validateSchema({ type: "string", minLength: 2 }, "a").valid).toBe(false);
    expect(validateSchema({ type: "number", maximum: 10 }, 11).valid).toBe(false);
    expect(validateSchema({ type: "array", minItems: 1 }, []).valid).toBe(false);
    expect(validateSchema({ type: "string", pattern: "^a+$" }, "aaa").valid).toBe(true);
  });

  it("supports anyOf, oneOf and allOf", () => {
    const anyOf = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(validateSchema(anyOf, 4).valid).toBe(true);
    expect(validateSchema(anyOf, true).valid).toBe(false);

    const oneOf = { oneOf: [{ type: "string" }, { type: "string", minLength: 10 }] };
    expect(validateSchema(oneOf, "short").valid).toBe(true);
    expect(validateSchema(oneOf, "a very long string").valid).toBe(false);

    const allOf = { allOf: [{ type: "string" }, { minLength: 3 }] };
    expect(validateSchema(allOf, "ab").valid).toBe(false);
  });

  it("ignores unknown keywords rather than failing", () => {
    expect(validateSchema({ type: "string", format: "uri", $comment: "hi" }, "x").valid).toBe(true);
  });

  it("accepts null only for the null type", () => {
    expect(validateSchema({ type: "null" }, null).valid).toBe(true);
    expect(validateSchema({ type: "object" }, null).valid).toBe(false);
    expect(validateSchema({ type: ["string", "null"] }, null).valid).toBe(true);
  });
});

describe("validateToolInput", () => {
  it("formats errors into one readable line", () => {
    const result = validateToolInput(
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      {},
    );
    expect(formatSchemaErrors(result.errors)).toBe("/path is required");
  });

  it("labels root-level failures", () => {
    const result = validateToolInput({ type: "object", required: ["a"] }, {});
    expect(formatSchemaErrors(result.errors)).toContain("/a is required");
  });
});
