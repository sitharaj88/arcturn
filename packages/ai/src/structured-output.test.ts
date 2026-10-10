/**
 * Native structured output and strict tools across the non-Anthropic
 * adapters, plus the capability and grammar tables every adapter shares.
 */

import type { JsonSchema, ModelSpec, ToolDefinition } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { buildGoogleRequest } from "./providers/google.js";
import { buildOpenAIRequest } from "./providers/openai.js";
import { buildOpenAIResponsesRequest } from "./providers/openai-responses.js";
import {
  ANTHROPIC_STRICT_LIMITS,
  createStrictBudget,
  isOpenAIStrictSchema,
  isStrictSchema,
  withoutAdditionalProperties,
} from "./strict-schema.js";
import { supportsStructuredOutput, supportsTaskBudget } from "./structured-output.js";
import { modelSpec, userMessage } from "./test-helpers/fixtures.js";

const allRequired: JsonSchema = {
  type: "object",
  properties: { decision: { enum: ["A", "B"] }, n: { type: "integer" } },
  required: ["decision", "n"],
  additionalProperties: false,
};
const withOptional: JsonSchema = {
  type: "object",
  properties: { decision: { enum: ["A", "B"] }, note: { type: "string" } },
  required: ["decision"],
  additionalProperties: false,
};
const format = { name: "verdict", schema: allRequired };

const openai = (over: Partial<ModelSpec> = {}) =>
  modelSpec({ id: "openai/gpt-5", provider: "openai", model: "gpt-5", ...over });
const strictTool = (parameters: JsonSchema): ToolDefinition => ({
  name: "t",
  description: "d",
  parameters,
  strict: true,
});

describe("OpenAI Chat Completions", () => {
  it("sends response_format json_schema with name, schema and strict", () => {
    const params = buildOpenAIRequest({
      model: openai(),
      messages: [userMessage("x")],
      responseFormat: format,
    });
    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", schema: allRequired, strict: true },
    });
  });

  it("downgrades strict for a schema with optional properties", () => {
    const params = buildOpenAIRequest({
      model: openai(),
      messages: [userMessage("x")],
      responseFormat: { name: "v", schema: withOptional },
      tools: [strictTool(withOptional), { ...strictTool(allRequired), name: "u" }],
    });
    expect(params.response_format).toMatchObject({ json_schema: { strict: false } });
    const [optional, required] = params.tools ?? [];
    expect(optional).not.toHaveProperty("function.strict");
    expect(required).toMatchObject({ function: { strict: true } });
  });

  it("sends nothing to an OpenAI-compatible endpoint unless it declares support", () => {
    const compatible = openai({ provider: "openai-compatible", baseUrl: "http://x/v1" });
    const plain = buildOpenAIRequest({
      model: compatible,
      messages: [userMessage("x")],
      responseFormat: format,
      tools: [strictTool(allRequired)],
    });
    expect(plain.response_format).toBeUndefined();
    expect(plain.tools?.[0]).not.toHaveProperty("function.strict");
    const declared = buildOpenAIRequest({
      model: {
        ...compatible,
        capabilities: { ...compatible.capabilities, structuredOutput: true },
      },
      messages: [userMessage("x")],
      responseFormat: format,
    });
    expect(declared.response_format).toMatchObject({ type: "json_schema" });
  });
});

describe("OpenAI Responses", () => {
  it("sends text.format and strict function tools", () => {
    const params = buildOpenAIResponsesRequest({
      model: openai({ provider: "openai-responses" }),
      messages: [userMessage("x")],
      responseFormat: format,
      tools: [strictTool(allRequired), { ...strictTool(withOptional), name: "u" }],
    });
    expect(params.text).toEqual({
      format: { type: "json_schema", name: "verdict", schema: allRequired, strict: true },
    });
    expect(params.tools?.[0]).toMatchObject({ strict: true });
    expect(params.tools?.[1]).toMatchObject({ strict: false });
  });
});

describe("Google", () => {
  it("sends responseMimeType and a JSON schema without additionalProperties", () => {
    const params = buildGoogleRequest({
      model: modelSpec({ provider: "google", model: "gemini-2.5-pro" }),
      messages: [userMessage("x")],
      responseFormat: format,
    });
    expect(params.config?.responseMimeType).toBe("application/json");
    expect(params.config?.responseJsonSchema).toEqual({
      type: "object",
      properties: allRequired.properties,
      required: ["decision", "n"],
    });
  });

  it("sends nothing to a Gemini before 2.5", () => {
    const params = buildGoogleRequest({
      model: modelSpec({ provider: "google", model: "gemini-2.0-flash" }),
      messages: [userMessage("x")],
      responseFormat: format,
    });
    expect(params.config?.responseMimeType).toBeUndefined();
  });
});

describe("capability tables", () => {
  it.each([
    ["anthropic", "claude-opus-5-5", true],
    ["anthropic", "claude-sonnet-4-5", true],
    ["anthropic", "claude-opus-4-1", true],
    ["anthropic", "claude-sonnet-4-20250514", false],
    ["anthropic-compatible", "claude-opus-5-5", false],
    ["bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0", true],
    ["bedrock", "amazon.nova-pro-v1:0", false],
    ["vertex", "claude-opus-4-6", true],
    ["vertex", "gemini-2.5-pro", true],
    ["openai", "gpt-5", true],
    ["azure", "gpt-5", true],
    ["openai-compatible", "llama-3", false],
    ["google", "gemini-2.5-flash", true],
    ["google", "gemini-1.5-pro", false],
  ])("structured output on %s %s is %s", (provider, model, expected) => {
    expect(supportsStructuredOutput(modelSpec({ provider, model }))).toBe(expected);
  });

  it.each([
    ["claude-opus-5-5", true],
    ["claude-opus-5", true],
    ["claude-opus-4-8", true],
    ["claude-opus-4-7", true],
    ["claude-opus-4-6", false],
    ["claude-fable-5-1", true],
    ["claude-sonnet-5-5", true],
    ["claude-sonnet-5", false],
    ["claude-haiku-5-5", true],
    ["claude-haiku-4-5", false],
  ])("task budgets on %s is %s", (model, expected) => {
    expect(supportsTaskBudget(modelSpec({ model }))).toBe(expected);
  });

  it("task budgets are first-party only, unless declared", () => {
    expect(supportsTaskBudget(modelSpec({ provider: "vertex", model: "claude-opus-5-5" }))).toBe(
      false,
    );
    const declared = modelSpec({ provider: "vertex", model: "claude-opus-5-5" });
    declared.capabilities.taskBudget = true;
    expect(supportsTaskBudget(declared)).toBe(true);
  });
});

describe("strict grammar", () => {
  it.each<[string, JsonSchema, boolean, boolean]>([
    ["all required", allRequired, true, true],
    ["optional property", withOptional, true, false],
    [
      "no additionalProperties",
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      false,
      false,
    ],
    [
      "numeric bound",
      {
        type: "object",
        properties: { a: { type: "number", minimum: 0 } },
        required: ["a"],
        additionalProperties: false,
      },
      false,
      false,
    ],
    [
      "nested oneOf",
      {
        type: "object",
        properties: { a: { oneOf: [{ type: "string" }, { type: "array" }] } },
        required: ["a"],
        additionalProperties: false,
      },
      false,
      false,
    ],
    [
      "nested object without additionalProperties",
      {
        type: "object",
        properties: {
          a: { type: "array", items: { type: "object", properties: { b: { type: "string" } } } },
        },
        required: ["a"],
        additionalProperties: false,
      },
      false,
      false,
    ],
    [
      "unsupported format",
      {
        type: "object",
        properties: { a: { type: "string", format: "regex" } },
        required: ["a"],
        additionalProperties: false,
      },
      false,
      false,
    ],
    [
      "minItems 1 and a nullable union",
      {
        type: "object",
        properties: {
          a: { type: "array", items: { type: "string" }, minItems: 1 },
          b: { type: ["string", "null"] },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
      true,
      true,
    ],
  ])("%s: anthropic %s, openai %s", (_label, schema, anthropic, openaiStrict) => {
    expect(isStrictSchema(schema)).toBe(anthropic);
    expect(isOpenAIStrictSchema(schema)).toBe(openaiStrict);
  });

  it("budgets optional and union properties across a request", () => {
    const budget = createStrictBudget();
    const optionalHeavy: JsonSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: ANTHROPIC_STRICT_LIMITS.optionalParameters }, (_, i) => [
          `p${i}`,
          { type: "string" },
        ]),
      ),
      required: [],
      additionalProperties: false,
    };
    expect(budget.admit(optionalHeavy, true)).toBe(true);
    // The 25th optional property, on any schema, no longer fits.
    expect(budget.admit(withOptional, true)).toBe(false);
    expect(budget.admit(allRequired, true)).toBe(true);
  });

  it("strips additionalProperties at every depth and nothing else", () => {
    expect(
      withoutAdditionalProperties({
        type: "object",
        properties: {
          additionalProperties: { type: "string" },
          inner: { type: "object", properties: {}, additionalProperties: false },
        },
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        // A PROPERTY named additionalProperties is data, and stays.
        additionalProperties: { type: "string" },
        inner: { type: "object", properties: {} },
      },
    });
  });
});
