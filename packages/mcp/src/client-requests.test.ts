/**
 * Server-initiated requests the client answers: `elicitation/create` (ask the
 * user for structured input) and `sampling/createMessage` (generate with the
 * user's model). Both run against the in-process fake server.
 */

import type { McpConfig } from "@arcturn/types";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateElicitationSchema } from "./elicitation.js";
import {
  DEFAULT_MCP_SAMPLING_MAX_TOKENS,
  type McpElicitationRequest,
  McpManager,
  type McpManagerOptions,
  type McpSamplingRequest,
} from "./manager.js";
import { createTestServer, type TestServerHandle } from "./test-support.js";

const FLAT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", title: "Your name", minLength: 1 },
    age: { type: "integer", minimum: 0 },
    subscribe: { type: "boolean", default: false },
    tier: { type: "string", enum: ["free", "pro"] },
  },
  required: ["name"],
};

describe("McpManager server-initiated requests", () => {
  let handles: Map<string, TestServerHandle> = new Map();
  let managers: McpManager[] = [];

  afterEach(async () => {
    for (const manager of managers) await manager.close();
    for (const handle of handles.values()) await handle.server.close();
    handles = new Map();
    managers = [];
  });

  async function connect(
    config: McpConfig,
    options: Omit<McpManagerOptions, "transportFactory"> = {},
  ): Promise<McpManager> {
    const manager = new McpManager(config, {
      ...options,
      transportFactory: (name) => {
        const handle = createTestServer();
        handles.set(name, handle);
        return handle.clientTransport;
      },
    });
    managers.push(manager);
    await manager.connect();
    return manager;
  }

  function handle(name: string): TestServerHandle {
    const found = handles.get(name);
    if (!found) throw new Error(`no fake server for ${name}`);
    return found;
  }

  describe("elicitation", () => {
    it("advertises form elicitation, hands the request to elicit, and returns its answer to the server", async () => {
      const seen: McpElicitationRequest[] = [];
      await connect(
        { servers: { forms: { type: "stdio", command: "unused" } } },
        {
          elicit: async (request) => {
            seen.push(request);
            return { action: "accept", content: { name: "Ada", age: 36, tier: "pro" } };
          },
        },
      );

      expect(handle("forms").clientCapabilities()?.elicitation).toEqual({ form: {} });

      const answer = await handle("forms").elicit({
        message: "Who are you?",
        requestedSchema: FLAT_SCHEMA,
      });

      expect(answer).toEqual({
        action: "accept",
        content: { name: "Ada", age: 36, tier: "pro" },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.server).toBe("forms");
      expect(seen[0]?.message).toBe("Who are you?");
      expect(seen[0]?.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
        ["name", "string", true],
        ["age", "number", false],
        ["subscribe", "boolean", false],
        ["tier", "enum", false],
      ]);
    });

    it("caps how often one server may put a form in front of the user", async () => {
      const refused: string[] = [];
      let asked = 0;
      await connect(
        { servers: { forms: { type: "stdio", command: "unused" } } },
        {
          elicit: async () => {
            asked++;
            return { action: "decline" };
          },
          onElicitationRefused: ({ reason }) => refused.push(reason),
        },
      );
      const params = { message: "again?", requestedSchema: FLAT_SCHEMA };
      for (let i = 0; i < 5; i++)
        expect(await handle("forms").elicit(params)).toEqual({ action: "decline" });
      await expect(handle("forms").elicit(params)).rejects.toThrow(/too many/i);
      expect(asked).toBe(5);
      expect(refused).toHaveLength(1);
    });

    it("relays decline and cancel without content", async () => {
      const answers = [{ action: "decline" as const }, { action: "cancel" as const }];
      await connect(
        { servers: { forms: { type: "stdio", command: "unused" } } },
        { elicit: async () => answers.shift() ?? { action: "cancel" } },
      );
      const params = { message: "Proceed?", requestedSchema: FLAT_SCHEMA };
      expect(await handle("forms").elicit(params)).toEqual({ action: "decline" });
      expect(await handle("forms").elicit(params)).toEqual({ action: "cancel" });
    });

    it("declines (never accepts with empty content) when the host has no elicit handler", async () => {
      await connect({ servers: { forms: { type: "stdio", command: "unused" } } });

      const answer = await handle("forms").elicit({
        message: "Who are you?",
        requestedSchema: FLAT_SCHEMA,
      });

      expect(answer).toEqual({ action: "decline" });
    });

    it("refuses a nested requestedSchema without ever asking the host", async () => {
      const elicit = vi.fn(async () => ({ action: "decline" as const }));
      await connect({ servers: { forms: { type: "stdio", command: "unused" } } }, { elicit });
      // Elicitation is on — this is the nested schema being refused, not the
      // capability being absent.
      expect(handle("forms").clientCapabilities()?.elicitation).toBeDefined();

      // The SDK's own request parse rejects this shape before any handler
      // runs; the point pinned here is that the host is never asked.
      await expect(
        handle("forms").elicit({
          message: "Where do you live?",
          requestedSchema: {
            type: "object",
            properties: {
              address: {
                type: "object",
                properties: { street: { type: "string" } },
              },
            },
          },
        }),
      ).rejects.toThrow();
      expect(elicit).not.toHaveBeenCalled();
    });

    it.each([
      [
        "a required field that is not a property",
        { type: "object", properties: { a: { type: "string" } }, required: ["address"] },
      ],
      [
        "an enum with no options",
        { type: "object", properties: { address: { type: "string", enum: [] } } },
      ],
    ])("refuses %s with InvalidParams and reports the refusal", async (_label, requestedSchema) => {
      const elicit = vi.fn(async () => ({ action: "decline" as const }));
      const refused: { server: string; reason: string }[] = [];
      await connect(
        { servers: { forms: { type: "stdio", command: "unused" } } },
        { elicit, onElicitationRefused: (event) => refused.push(event) },
      );

      await expect(
        handle("forms").elicit({ message: "Where do you live?", requestedSchema }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

      expect(elicit).not.toHaveBeenCalled();
      expect(refused).toEqual([{ server: "forms", reason: expect.stringMatching(/address/) }]);
    });

    it("refuses to forward an accept whose content does not fit the schema", async () => {
      await connect(
        { servers: { forms: { type: "stdio", command: "unused" } } },
        // `name` is required and missing; `age` is not an integer.
        { elicit: async () => ({ action: "accept", content: { age: 3.5 } }) },
      );

      await expect(
        handle("forms").elicit({ message: "Who are you?", requestedSchema: FLAT_SCHEMA }),
      ).rejects.toThrow(/name|age/);
    });
  });

  describe("validateElicitationSchema", () => {
    it("accepts the flat primitive subset, including single and multi-select enums", () => {
      const result = validateElicitationSchema({
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          score: { type: "number", minimum: 0, maximum: 1 },
          colour: {
            type: "string",
            oneOf: [
              { const: "r", title: "Red" },
              { const: "g", title: "Green" },
            ],
          },
          tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
          agree: { type: "boolean" },
        },
        required: ["email"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.fields.map((field) => field.kind)).toEqual([
        "string",
        "number",
        "enum",
        "multiEnum",
        "boolean",
      ]);
      const colour = result.fields[2];
      expect(colour?.kind === "enum" ? colour.options : undefined).toEqual([
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
      ]);
    });

    it.each([
      ["a non-object root", { type: "array", items: { type: "string" } }],
      ["a missing properties map", { type: "object" }],
      [
        "a nested object property",
        { type: "object", properties: { a: { type: "object", properties: {} } } },
      ],
      [
        "an array of objects",
        { type: "object", properties: { a: { type: "array", items: { type: "object" } } } },
      ],
      ["an untyped property", { type: "object", properties: { a: { title: "A" } } }],
      [
        "a property carrying its own properties",
        {
          type: "object",
          properties: { a: { type: "string", properties: { b: { type: "string" } } } },
        },
      ],
      ["a $ref", { type: "object", properties: { a: { $ref: "#/defs/a" } } }],
      [
        "a required name that is not a property",
        { type: "object", properties: { a: { type: "string" } }, required: ["b"] },
      ],
      ["an empty enum", { type: "object", properties: { a: { type: "string", enum: [] } } }],
    ])("refuses %s", (_label, schema) => {
      const result = validateElicitationSchema(schema);
      expect(result.ok).toBe(false);
    });
  });

  describe("sampling", () => {
    const SAMPLE = {
      messages: [{ role: "user", content: { type: "text", text: "Summarise the README." } }],
      maxTokens: 100,
    };

    it("advertises sampling only to the server that opted in, and answers MethodNotFound to the rest", async () => {
      const sample = vi.fn(async () => ({ model: "m", text: "ok" }));
      await connect(
        {
          servers: {
            trusted: { type: "stdio", command: "unused", sampling: true },
            other: { type: "stdio", command: "unused" },
          },
        },
        { sample },
      );

      expect(handle("trusted").clientCapabilities()?.sampling).toEqual({});
      expect(handle("other").clientCapabilities()?.sampling).toBeUndefined();

      await expect(handle("other").sample(SAMPLE)).rejects.toMatchObject({
        code: ErrorCode.MethodNotFound,
      });
      expect(sample).not.toHaveBeenCalled();
    });

    it("never advertises sampling when the host supplies no sample handler", async () => {
      await connect({ servers: { trusted: { type: "stdio", command: "unused", sampling: true } } });
      expect(handle("trusted").clientCapabilities()?.sampling).toBeUndefined();
      await expect(handle("trusted").sample(SAMPLE)).rejects.toMatchObject({
        code: ErrorCode.MethodNotFound,
      });
    });

    it("hands the host the server's messages, system prompt, hints and a capped maxTokens", async () => {
      const seen: McpSamplingRequest[] = [];
      await connect(
        { servers: { trusted: { type: "stdio", command: "unused", sampling: true } } },
        {
          sample: async (request) => {
            seen.push(request);
            return { model: "anthropic/claude-haiku", text: "A summary.", stopReason: "endTurn" };
          },
        },
      );

      const result = await handle("trusted").sample({
        messages: [
          { role: "user", content: { type: "text", text: "Summarise the README." } },
          { role: "assistant", content: [{ type: "text", text: "Which section?" }] },
          { role: "user", content: { type: "text", text: "All of it." } },
        ],
        systemPrompt: "You are terse.",
        modelPreferences: { hints: [{ name: "haiku" }, { name: "sonnet" }] },
        temperature: 0.2,
        maxTokens: 1_000_000,
      });

      expect(result).toEqual({
        role: "assistant",
        content: { type: "text", text: "A summary." },
        model: "anthropic/claude-haiku",
        stopReason: "endTurn",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        server: "trusted",
        messages: [
          { role: "user", text: "Summarise the README." },
          { role: "assistant", text: "Which section?" },
          { role: "user", text: "All of it." },
        ],
        systemPrompt: "You are terse.",
        modelHints: ["haiku", "sonnet"],
        temperature: 0.2,
        maxTokens: DEFAULT_MCP_SAMPLING_MAX_TOKENS,
      });

      // The server can lower the ceiling, never raise it.
      await handle("trusted").sample(SAMPLE);
      expect(seen[1]?.maxTokens).toBe(100);
    });

    it("refuses a sampling request that carries tools (the capability is not declared)", async () => {
      const sample = vi.fn(async () => ({ model: "m", text: "ok" }));
      await connect(
        { servers: { trusted: { type: "stdio", command: "unused", sampling: true } } },
        { sample },
      );
      await expect(
        handle("trusted").sample({
          ...SAMPLE,
          tools: [{ name: "t", inputSchema: { type: "object" } }],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(sample).not.toHaveBeenCalled();
    });

    it("reports a host failure to the server as an error, not a fabricated message", async () => {
      await connect(
        { servers: { trusted: { type: "stdio", command: "unused", sampling: true } } },
        {
          sample: async () => {
            throw new Error("session cost limit reached");
          },
        },
      );
      await expect(handle("trusted").sample(SAMPLE)).rejects.toThrow(/cost limit/);
    });
  });
});
