import type { LLMRequest, StreamEvent } from "@arcturn/types";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  collect,
  imageMessage,
  modelSpec,
  terminal,
  textOf,
  toolResult,
  userMessage,
} from "../test-helpers/fixtures.js";
import {
  buildGoogleRequest,
  createGoogleProvider,
  type GoogleClientLike,
  mapGoogleFinishReason,
  parseGoogleUsage,
  SYNTHETIC_TOOL_ID_PREFIX,
  supportsToolCallIds,
  toGoogleContents,
} from "./google.js";

const spec = modelSpec({
  id: "google/gemini-2.5-pro",
  provider: "google",
  model: "gemini-2.5-pro",
  maxOutputTokens: 65_536,
});

interface FakeGoogleClient extends GoogleClientLike {
  params?: GenerateContentParameters;
}

function fakeClient(chunks: unknown[]): FakeGoogleClient {
  const client: FakeGoogleClient = {
    models: {
      generateContentStream: vi.fn(async (params: GenerateContentParameters) => {
        client.params = params;
        return (async function* () {
          for (const item of chunks) yield item as GenerateContentResponse;
        })();
      }),
    },
  };
  return client;
}

function chunk(parts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { candidates: [{ content: { parts, role: "model" }, ...extra }] };
}

async function streamOf(
  chunks: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const provider = createGoogleProvider({ client: fakeClient(chunks) });
  return collect(provider.stream({ model: spec, messages: [userMessage("hi")], ...overrides }));
}

describe("supportsToolCallIds", () => {
  it("only accepts ids from Gemini 3 onwards", () => {
    expect(supportsToolCallIds("gemini-2.5-pro")).toBe(false);
    expect(supportsToolCallIds("gemini-3-pro-preview")).toBe(true);
    expect(supportsToolCallIds("claude-sonnet-4-5")).toBe(true);
  });
});

describe("toGoogleContents", () => {
  it("uses the model role for assistant turns and inlineData for images", () => {
    expect(toGoogleContents([userMessage("hi"), imageMessage("IMG")], "gemini-2.5-pro")).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "IMG" } }] },
    ]);
  });

  it("marks thinking parts and keeps an empty part that carries a signature", () => {
    const contents = toGoogleContents(
      [
        assistantMessage([
          { type: "thinking", thinking: "", signature: "SIG" },
          { type: "text", text: "answer" },
        ]),
      ],
      "gemini-2.5-pro",
    );
    expect(contents[0]?.parts).toEqual([
      { text: "", thought: true, thoughtSignature: "SIG" },
      { text: "answer" },
    ]);
  });

  it("replays a function call's thought signature back to Gemini", () => {
    // The other half of the round trip: captured on the way in, sent on the way
    // out, or the next request is the one that 400s.
    const message = assistantMessage([
      { type: "toolCall", id: "fc_1", name: "read", arguments: { p: 1 }, signature: "FCSIG" },
    ]);
    expect(toGoogleContents([message], "gemini-3.5-flash-lite")[0]?.parts?.[0]).toEqual({
      functionCall: { id: "fc_1", name: "read", args: { p: 1 } },
      thoughtSignature: "FCSIG",
    });
  });

  it("omits function-call ids on Gemini 2.5 but keeps them on Gemini 3", () => {
    const message = assistantMessage([
      { type: "toolCall", id: "fc_1", name: "read", arguments: { p: 1 } },
    ]);
    expect(toGoogleContents([message], "gemini-2.5-pro")[0]?.parts?.[0]).toEqual({
      functionCall: { name: "read", args: { p: 1 } },
    });
    expect(toGoogleContents([message], "gemini-3-pro-preview")[0]?.parts?.[0]).toEqual({
      functionCall: { id: "fc_1", name: "read", args: { p: 1 } },
    });
  });

  it("never echoes a synthetic tool id back to the API", () => {
    const id = `${SYNTHETIC_TOOL_ID_PREFIX}read-0`;
    const contents = toGoogleContents(
      [
        assistantMessage([{ type: "toolCall", id, name: "read", arguments: {} }]),
        toolResult(id, "read", "done"),
      ],
      "gemini-3-pro-preview",
    );
    expect(contents[0]?.parts?.[0]?.functionCall).not.toHaveProperty("id");
    expect(contents[1]?.parts?.[0]?.functionResponse).not.toHaveProperty("id");
  });

  it("coalesces all function responses into one user turn", () => {
    const contents = toGoogleContents(
      [toolResult("a", "read", "one"), toolResult("b", "list", "two")],
      "gemini-2.5-pro",
    );
    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts).toEqual([
      { functionResponse: { name: "read", response: { output: "one" } } },
      { functionResponse: { name: "list", response: { output: "two" } } },
    ]);
  });

  it("uses the error key for failed tool results", () => {
    const contents = toGoogleContents(
      [toolResult("a", "read", "kaboom", { isError: true })],
      "gemini-2.5-pro",
    );
    expect(contents[0]?.parts?.[0]?.functionResponse?.response).toEqual({ error: "kaboom" });
  });

  it("emits tool-result images as a separate user turn", () => {
    const contents = toGoogleContents(
      [
        toolResult("a", "shot", "", {
          content: [{ type: "image", data: "IMG", mimeType: "image/png" }],
        }),
      ],
      "gemini-2.5-pro",
    );
    expect(contents).toHaveLength(2);
    expect(contents[1]?.parts?.[1]).toEqual({
      inlineData: { mimeType: "image/png", data: "IMG" },
    });
  });
});

describe("buildGoogleRequest", () => {
  it("places the system prompt, tools and limits in config", () => {
    const params = buildGoogleRequest({
      model: spec,
      system: "be brief",
      messages: [userMessage("hi")],
      tools: [{ name: "read", description: "reads", parameters: { type: "object" } }],
      temperature: 0.2,
      maxOutputTokens: 1024,
    });
    expect(params.model).toBe("gemini-2.5-pro");
    expect(params.config?.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "be brief" }],
    });
    expect(params.config?.maxOutputTokens).toBe(1024);
    expect(params.config?.temperature).toBe(0.2);
    expect(params.config?.tools).toEqual([
      {
        functionDeclarations: [
          { name: "read", description: "reads", parametersJsonSchema: { type: "object" } },
        ],
      },
    ]);
  });

  it("uses thinking budgets for the 2.5 family", () => {
    const base = { model: spec, messages: [userMessage("hi")] };
    expect(buildGoogleRequest({ ...base, thinking: "off" }).config?.thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
    expect(buildGoogleRequest({ ...base, thinking: "medium" }).config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 16_384,
    });
  });

  it("uses thinking levels for Gemini 3", () => {
    const three = modelSpec({ provider: "google", model: "gemini-3-pro-preview" });
    expect(
      buildGoogleRequest({ model: three, messages: [], thinking: "high" }).config?.thinkingConfig,
    ).toEqual({ thinkingLevel: "HIGH", includeThoughts: true });
    expect(
      buildGoogleRequest({ model: three, messages: [], thinking: "off" }).config?.thinkingConfig,
    ).toEqual({ thinkingLevel: "MINIMAL" });
  });

  it("passes the abort signal through config and merges providerOptions", () => {
    const controller = new AbortController();
    const params = buildGoogleRequest({
      model: spec,
      messages: [],
      signal: controller.signal,
      providerOptions: { topK: 5 },
    });
    expect(params.config?.abortSignal).toBe(controller.signal);
    expect((params.config as unknown as { topK: number }).topK).toBe(5);
  });
});

describe("parseGoogleUsage", () => {
  it("removes cached tokens from the prompt count and adds thoughts to output", () => {
    expect(
      parseGoogleUsage({
        promptTokenCount: 100,
        cachedContentTokenCount: 30,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
      }),
    ).toEqual({
      inputTokens: 70,
      outputTokens: 25,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
  });

  it("returns undefined for non-objects", () => {
    expect(parseGoogleUsage(undefined)).toBeUndefined();
  });
});

describe("mapGoogleFinishReason", () => {
  it("treats anything but STOP and MAX_TOKENS as an error", () => {
    expect(mapGoogleFinishReason("STOP")).toBe("endTurn");
    expect(mapGoogleFinishReason("MAX_TOKENS")).toBe("maxTokens");
    expect(mapGoogleFinishReason("SAFETY")).toBe("error");
    expect(mapGoogleFinishReason("MALFORMED_FUNCTION_CALL")).toBe("error");
    expect(mapGoogleFinishReason(undefined)).toBeUndefined();
  });
});

describe("google streaming", () => {
  it("assembles text across chunks", async () => {
    const events = await streamOf([
      chunk([{ text: "Hel" }]),
      chunk([{ text: "lo" }], { finishReason: "STOP" }),
      { usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 } },
    ]);
    expect(textOf(events)).toBe("Hello");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.usage).toMatchObject({ inputTokens: 8, outputTokens: 2 });
  });

  it("switches blocks when a part flips between thought and answer", async () => {
    const events = await streamOf([
      chunk([{ text: "reasoning", thought: true, thoughtSignature: "SIG" }]),
      chunk([{ text: "answer" }], { finishReason: "STOP" }),
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "thinking", thinking: "reasoning", signature: "SIG" },
      { type: "text", text: "answer" },
    ]);
    const blockEnds = events.filter((event) => event.type === "blockEnd");
    expect(blockEnds).toHaveLength(2);
  });

  it("keeps an empty text part inside the current block", async () => {
    const events = await streamOf([
      chunk([{ text: "a" }, { text: "" }, { text: "b" }], { finishReason: "STOP" }),
    ]);
    expect(terminal(events).message.content).toEqual([{ type: "text", text: "ab" }]);
  });

  it("keeps the thought signature Gemini attaches to a function call", async () => {
    // Gemini 3 signs the *tool call*, not just the thinking that led to it, and
    // rejects the follow-up turn outright when the signature does not come back:
    //   400 INVALID_ARGUMENT — "Function call is missing a thought_signature in
    //   functionCall parts. This is required for tools to work correctly."
    // Dropping it here is what made every multi-turn tool use on Gemini fail on
    // its SECOND request, which is the whole agent loop.
    const events = await streamOf([
      chunk(
        [{ functionCall: { name: "read", args: { path: "a.ts" } }, thoughtSignature: "FCSIG" }],
        {
          finishReason: "STOP",
        },
      ),
    ]);
    expect(terminal(events).message.content).toEqual([
      {
        type: "toolCall",
        id: expect.any(String),
        name: "read",
        arguments: { path: "a.ts" },
        signature: "FCSIG",
      },
    ]);
  });

  it("synthesises start/delta/end for whole function calls", async () => {
    const events = await streamOf([
      chunk([{ functionCall: { name: "read", args: { path: "a.ts" } } }], {
        finishReason: "STOP",
      }),
    ]);
    const types = events.map((event) => event.type);
    expect(types).toContain("toolCallStart");
    expect(types).toContain("toolCallDelta");
    expect(types).toContain("toolCallEnd");
    const end = terminal(events);
    // Gemini has no tool_use finish reason, so it must be inferred.
    expect(end.message.stopReason).toBe("toolCalls");
    expect(end.message.content[0]).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "a.ts" },
    });
  });

  it("synthesises unique ids for id-less and duplicate function calls", async () => {
    const events = await streamOf([
      chunk(
        [
          { functionCall: { name: "read", args: {} } },
          { functionCall: { name: "read", args: {} } },
        ],
        {
          finishReason: "STOP",
        },
      ),
    ]);
    const ids = terminal(events).message.content.map((block) =>
      block.type === "toolCall" ? block.id : "",
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id.startsWith(SYNTHETIC_TOOL_ID_PREFIX)).toBe(true);
  });

  it("closes an open text block before a function call", async () => {
    const events = await streamOf([
      chunk([{ text: "thinking about it" }, { functionCall: { name: "go", args: {} } }], {
        finishReason: "STOP",
      }),
    ]);
    const order = events
      .filter((event) => event.type === "blockEnd" || event.type === "toolCallStart")
      .map((event) => event.type);
    expect(order[0]).toBe("blockEnd");
    expect(order[1]).toBe("toolCallStart");
  });

  it("surfaces a safety stop as stopReason error", async () => {
    const events = await streamOf([chunk([{ text: "x" }], { finishReason: "SAFETY" })]);
    const end = terminal(events);
    expect(end.message.stopReason).toBe("error");
    expect(end.message.errorMessage).toBe("Provider stopped with: SAFETY");
  });

  it("maps SDK failures onto AIError kinds", async () => {
    const client = {
      models: {
        generateContentStream: vi.fn(async () => {
          throw Object.assign(new Error("exhausted"), { status: "RESOURCE_EXHAUSTED" });
        }),
      },
    } as unknown as GoogleClientLike;
    const events = await collect(
      createGoogleProvider({ client }).stream({ model: spec, messages: [userMessage("hi")] }),
    );
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("rateLimit");
  });

  it("complete() returns the terminal message", async () => {
    const client = fakeClient([chunk([{ text: "done" }], { finishReason: "STOP" })]);
    const message = await createGoogleProvider({ client }).complete({
      model: spec,
      messages: [userMessage("hi")],
    });
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
  });
});
