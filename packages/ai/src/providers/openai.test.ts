import type { LLMRequest, StreamEvent } from "@arcturn/types";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
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
  buildOpenAIRequest,
  createOpenAIProvider,
  mapOpenAIFinishReason,
  type OpenAIClientLike,
  parseOpenAIUsage,
  supportsTemperature,
  toOpenAIMessages,
} from "./openai.js";

const spec = modelSpec({
  id: "openai/gpt-5",
  provider: "openai",
  model: "gpt-5",
  maxOutputTokens: 128_000,
});

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-5",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageChunk(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-5",
    choices: [],
    usage,
  };
}

function fakeClient(chunks: unknown[]): OpenAIClientLike {
  return {
    chat: {
      completions: {
        create: vi.fn(async () =>
          (async function* () {
            for (const item of chunks) yield item as ChatCompletionChunk;
          })(),
        ),
      },
    },
  } as unknown as OpenAIClientLike;
}

async function streamOf(
  chunks: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const provider = createOpenAIProvider({ client: fakeClient(chunks) });
  return collect(provider.stream({ model: spec, messages: [userMessage("hi")], ...overrides }));
}

describe("toOpenAIMessages", () => {
  it("puts the system prompt first and collapses text-only user content", () => {
    expect(toOpenAIMessages([userMessage("hello")], "be brief")).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
  });

  it("builds content parts when an image is present", () => {
    const result = toOpenAIMessages([imageMessage("AAA", "image/png")]);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
    });
  });

  it("serialises assistant tool calls and drops thinking blocks", () => {
    const result = toOpenAIMessages([
      assistantMessage([
        { type: "thinking", thinking: "internal", signature: "s" },
        { type: "text", text: "calling" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
      ]),
    ]);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "calling",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
      ],
    });
  });

  it("drops assistant messages with neither text nor tool calls", () => {
    expect(toOpenAIMessages([assistantMessage([{ type: "thinking", thinking: "x" }])])).toEqual([]);
  });

  it("uses null content for a tool-call-only assistant turn", () => {
    const result = toOpenAIMessages([
      assistantMessage([{ type: "toolCall", id: "c", name: "n", arguments: {} }]),
    ]);
    expect(result[0]).toMatchObject({ content: null });
  });

  it("maps tool results to the tool role and hoists images into a user turn", () => {
    const result = toOpenAIMessages([
      toolResult("call_1", "read", "file body", {
        content: [
          { type: "text", text: "file body" },
          { type: "image", data: "IMG", mimeType: "image/png" },
        ],
      }),
    ]);
    expect(result[0]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file body" });
    expect(result[1]).toMatchObject({ role: "user" });
    expect((result[1] as { content: unknown[] }).content).toHaveLength(2);
  });

  it("never sends empty tool content", () => {
    expect(toOpenAIMessages([toolResult("c", "n", "")])[0]).toMatchObject({
      content: "(no tool output)",
    });
    expect(
      toOpenAIMessages([
        toolResult("c", "n", "", {
          content: [{ type: "image", data: "I", mimeType: "image/png" }],
        }),
      ])[0],
    ).toMatchObject({ content: "(see attached image)" });
  });
});

describe("buildOpenAIRequest", () => {
  it("uses max_completion_tokens for OpenAI proper and max_tokens for compatibles", () => {
    expect(buildOpenAIRequest({ model: spec, messages: [] }).max_completion_tokens).toBe(128_000);
    const compat = modelSpec({
      provider: "openai-compatible",
      model: "llama",
      maxOutputTokens: 4096,
      baseUrl: "http://x/v1",
    });
    const params = buildOpenAIRequest({ model: compat, messages: [] });
    expect(params.max_tokens).toBe(4096);
    expect(params.max_completion_tokens).toBeUndefined();
  });

  it("requests usage in the stream by default", () => {
    expect(buildOpenAIRequest({ model: spec, messages: [] }).stream_options).toEqual({
      include_usage: true,
    });
    expect(
      buildOpenAIRequest({ model: spec, messages: [] }, { includeUsage: false }).stream_options,
    ).toBeUndefined();
  });

  it("omits temperature for reasoning models but keeps it elsewhere", () => {
    expect(
      buildOpenAIRequest({ model: spec, messages: [], temperature: 0.5 }).temperature,
    ).toBeUndefined();
    const chatty = modelSpec({ provider: "openai", model: "gpt-4.1" });
    expect(buildOpenAIRequest({ model: chatty, messages: [], temperature: 0.5 }).temperature).toBe(
      0.5,
    );
  });

  it("maps thinking level onto reasoning_effort", () => {
    expect(
      buildOpenAIRequest({ model: spec, messages: [], thinking: "off" }).reasoning_effort,
    ).toBeUndefined();
    expect(
      buildOpenAIRequest({ model: spec, messages: [], thinking: "low" }).reasoning_effort,
    ).toBe("low");
    expect(
      buildOpenAIRequest({ model: spec, messages: [], thinking: "high" }).reasoning_effort,
    ).toBe("high");
    const noThink = modelSpec({
      provider: "openai",
      model: "gpt-4.1",
      capabilities: { tools: true, vision: true, thinking: false, caching: true },
    });
    expect(
      buildOpenAIRequest({ model: noThink, messages: [], thinking: "high" }).reasoning_effort,
    ).toBeUndefined();
  });

  it("converts tool definitions and merges providerOptions", () => {
    const params = buildOpenAIRequest({
      model: spec,
      messages: [],
      tools: [{ name: "read", description: "reads", parameters: { type: "object" } }],
      providerOptions: { seed: 7 },
    });
    expect(params.tools?.[0]).toEqual({
      type: "function",
      function: { name: "read", description: "reads", parameters: { type: "object" } },
    });
    expect((params as unknown as { seed: number }).seed).toBe(7);
  });
});

describe("supportsTemperature", () => {
  it("excludes o-series and gpt-5 on OpenAI proper only", () => {
    expect(supportsTemperature(modelSpec({ provider: "openai", model: "o3" }))).toBe(false);
    expect(supportsTemperature(modelSpec({ provider: "openai", model: "gpt-5.1" }))).toBe(false);
    expect(supportsTemperature(modelSpec({ provider: "openai", model: "gpt-4o" }))).toBe(true);
    expect(supportsTemperature(modelSpec({ provider: "openai-compatible", model: "gpt-5" }))).toBe(
      true,
    );
  });
});

describe("parseOpenAIUsage", () => {
  it("subtracts cached tokens from the cache-inclusive prompt count", () => {
    expect(
      parseOpenAIUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });
  });

  it("reads the DeepSeek and Kimi cache fields", () => {
    expect(
      parseOpenAIUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 4 })?.cacheReadTokens,
    ).toBe(4);
    expect(parseOpenAIUsage({ prompt_tokens: 10, cached_tokens: 6 })?.cacheReadTokens).toBe(6);
  });

  it("returns undefined for non-objects", () => {
    expect(parseOpenAIUsage(null)).toBeUndefined();
    expect(parseOpenAIUsage(undefined)).toBeUndefined();
  });
});

describe("mapOpenAIFinishReason", () => {
  it("maps known and unknown values", () => {
    expect(mapOpenAIFinishReason("stop")).toBe("endTurn");
    expect(mapOpenAIFinishReason("length")).toBe("maxTokens");
    expect(mapOpenAIFinishReason("tool_calls")).toBe("toolCalls");
    expect(mapOpenAIFinishReason("function_call")).toBe("toolCalls");
    expect(mapOpenAIFinishReason("content_filter")).toBe("error");
    expect(mapOpenAIFinishReason("something-new")).toBe("endTurn");
    expect(mapOpenAIFinishReason(null)).toBe("endTurn");
  });
});

describe("openai streaming", () => {
  it("assembles text and usage", async () => {
    const events = await streamOf([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
      usageChunk({
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 2 },
      }),
    ]);
    expect(textOf(events)).toBe("Hello");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
    });
  });

  it("accumulates index-keyed tool-call argument deltas", async () => {
    const events = await streamOf([
      chunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
      chunk({}, "tool_calls"),
      usageChunk({ prompt_tokens: 1, completion_tokens: 1 }),
    ]);
    const start = events.find((event) => event.type === "toolCallStart");
    expect(start).toMatchObject({ id: "call_1", name: "read", blockIndex: 0 });
    const deltas = events
      .filter(
        (event): event is Extract<StreamEvent, { type: "toolCallDelta" }> =>
          event.type === "toolCallDelta",
      )
      .map((event) => event.argumentsDelta)
      .join("");
    expect(deltas).toBe('{"path":"a.ts"}');
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    ]);
  });

  it("handles parallel tool calls that interleave across chunks", async () => {
    const events = await streamOf([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: "{" } }] }),
      chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: '{"x"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"y":1}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: ":2}" } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "a", name: "one", arguments: { y: 1 } },
      { type: "toolCall", id: "b", name: "two", arguments: { x: 2 } },
    ]);
  });

  it("falls back to id keying when the gateway omits index", async () => {
    const events = await streamOf([
      chunk({ tool_calls: [{ id: "z", function: { name: "n", arguments: '{"a":' } }] }),
      chunk({ tool_calls: [{ id: "z", function: { arguments: "1}" } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "z", name: "n", arguments: { a: 1 } },
    ]);
  });

  it("backfills a late-arriving tool name and id", async () => {
    const events = await streamOf([
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "late", function: { name: "named" } }] }),
      chunk({}, "tool_calls"),
    ]);
    const start = events.find((event) => event.type === "toolCallStart");
    expect(start).toMatchObject({ id: "late", name: "named" });
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "late", name: "named", arguments: { a: 1 } },
    ]);
  });

  it("degrades malformed tool JSON to empty arguments", async () => {
    const events = await streamOf([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "n", arguments: "<<<>>>" } }] }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.find((event) => event.type === "toolCallEnd")).toMatchObject({ arguments: {} });
  });

  it("reads reasoning from compatible-provider delta fields", async () => {
    const events = await streamOf([
      chunk({ reasoning_content: "step " }),
      chunk({ reasoning: "two" }),
      chunk({ content: "answer" }),
      chunk({}, "stop"),
    ]);
    const thinking = events
      .filter(
        (event): event is Extract<StreamEvent, { type: "thinkingDelta" }> =>
          event.type === "thinkingDelta",
      )
      .map((event) => event.delta)
      .join("");
    expect(thinking).toBe("step two");
    expect(terminal(events).message.content).toEqual([
      { type: "thinking", thinking: "step two" },
      { type: "text", text: "answer" },
    ]);
  });

  it("prefers the first non-empty reasoning field when a gateway duplicates it", async () => {
    const events = await streamOf([
      chunk({ reasoning_content: "once", reasoning: "once" }),
      chunk({}, "stop"),
    ]);
    expect(terminal(events).message.content).toEqual([{ type: "thinking", thinking: "once" }]);
  });

  it("infers toolCalls when no finish_reason arrives", async () => {
    const events = await streamOf([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "n", arguments: "{}" } }] }),
    ]);
    expect(terminal(events).message.stopReason).toBe("toolCalls");
  });

  it("maps content_filter to a stopReason of error", async () => {
    const events = await streamOf([chunk({ content: "part" }), chunk({}, "content_filter")]);
    const end = terminal(events);
    expect(end.message.stopReason).toBe("error");
    expect(end.message.errorMessage).toBe("Provider finish_reason: content_filter");
  });

  it("maps length to maxTokens", async () => {
    const events = await streamOf([chunk({ content: "x" }), chunk({}, "length")]);
    expect(terminal(events).message.stopReason).toBe("maxTokens");
  });

  it("emits exactly one start and one terminal event on SDK failure", async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw Object.assign(new Error("bad request"), { status: 400 });
          }),
        },
      },
    } as unknown as OpenAIClientLike;
    const events = await collect(
      createOpenAIProvider({ client }).stream({ model: spec, messages: [userMessage("hi")] }),
    );
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("invalidRequest");
  });

  it("ends as aborted when the signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await streamOf([chunk({ content: "never" })], { signal: controller.signal });
    expect(terminal(events).message.stopReason).toBe("aborted");
  });
});
