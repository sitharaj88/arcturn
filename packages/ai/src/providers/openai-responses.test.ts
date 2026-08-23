import type { LLMRequest, StreamEvent } from "@arcturn/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
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
  buildOpenAIResponsesRequest,
  createOpenAIResponsesProvider,
  decodeReasoningSignature,
  encodeReasoningSignature,
  mapResponsesStop,
  type OpenAIResponsesClientLike,
  openaiResponsesModel,
  parseResponsesUsage,
  registerOpenAIResponsesProvider,
  responsesErrorToAIError,
  supportsResponsesTemperature,
  toResponsesInput,
} from "./openai-responses.js";
import { getProviderFactory, unregisterProviderFactory } from "./registry.js";

const spec = modelSpec({
  id: "openai-responses/gpt-5.1",
  provider: "openai-responses",
  model: "gpt-5.1",
  maxOutputTokens: 128_000,
});

/* -------------------------------------------------------------------------- */
/* Fake transport                                                             */
/* -------------------------------------------------------------------------- */

function fakeClient(events: unknown[]): OpenAIResponsesClientLike {
  return {
    responses: {
      create: vi.fn(async () =>
        (async function* () {
          for (const event of events) yield event as ResponseStreamEvent;
        })(),
      ),
    },
  } as unknown as OpenAIResponsesClientLike;
}

function throwingClient(error: unknown): OpenAIResponsesClientLike {
  return {
    responses: {
      create: vi.fn(async () => {
        throw error;
      }),
    },
  } as unknown as OpenAIResponsesClientLike;
}

async function streamOf(
  events: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const provider = createOpenAIResponsesProvider({ client: fakeClient(events) });
  return collect(provider.stream({ model: spec, messages: [userMessage("hi")], ...overrides }));
}

/** Every terminal path must produce exactly one `end` or `error`. */
function terminalCount(events: StreamEvent[]): number {
  return events.filter((event) => event.type === "end" || event.type === "error").length;
}

/* -------------------------------------------------------------------------- */
/* SSE fixtures                                                               */
/* -------------------------------------------------------------------------- */

function itemAdded(outputIndex: number, item: Record<string, unknown>): Record<string, unknown> {
  return { type: "response.output_item.added", output_index: outputIndex, item };
}

function itemDone(outputIndex: number, item: Record<string, unknown>): Record<string, unknown> {
  return { type: "response.output_item.done", output_index: outputIndex, item };
}

function textDeltaEvent(outputIndex: number, itemId: string, delta: string) {
  return {
    type: "response.output_text.delta",
    output_index: outputIndex,
    item_id: itemId,
    delta,
  };
}

function argsDeltaEvent(outputIndex: number, itemId: string, delta: string) {
  return {
    type: "response.function_call_arguments.delta",
    output_index: outputIndex,
    item_id: itemId,
    delta,
  };
}

function summaryDeltaEvent(outputIndex: number, itemId: string, delta: string) {
  return {
    type: "response.reasoning_summary_text.delta",
    output_index: outputIndex,
    item_id: itemId,
    summary_index: 0,
    delta,
  };
}

function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCallItem(
  id: string,
  callId: string,
  name: string,
  args: string,
): Record<string, unknown> {
  return { type: "function_call", id, call_id: callId, name, arguments: args };
}

function reasoningItem(id: string, encrypted?: string): Record<string, unknown> {
  return {
    type: "reasoning",
    id,
    summary: [],
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 30,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 12 },
  total_tokens: 130,
};

function completed(usage: Record<string, unknown> | undefined = USAGE) {
  return {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", ...(usage ? { usage } : {}) },
  };
}

/* -------------------------------------------------------------------------- */
/* Request mapping                                                            */
/* -------------------------------------------------------------------------- */

describe("toResponsesInput", () => {
  it("maps a multi-turn conversation with a tool result and an image", () => {
    const input = toResponsesInput([
      userMessage("read a.ts"),
      assistantMessage([
        { type: "text", text: "on it" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
      ]),
      toolResult("call_1", "read", "file body"),
      imageMessage("AAA", "image/png"),
    ]);

    expect(input).toEqual([
      { role: "user", content: "read a.ts" },
      { role: "assistant", content: "on it" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
      {
        role: "user",
        content: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAA" }],
      },
    ]);
  });

  it("interleaves text and image parts in one user turn", () => {
    const input = toResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: "data:image/png;base64,ZZZ", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ]);
    expect(input[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", detail: "auto", image_url: "data:image/png;base64,ZZZ" },
      ],
    });
  });

  it("hoists tool-result images into a following user turn", () => {
    const input = toResponsesInput([
      toolResult("call_1", "screenshot", "", {
        content: [{ type: "image", data: "IMG", mimeType: "image/png" }],
      }),
    ]);
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "(see attached image)",
    });
    expect(input[1]).toMatchObject({ role: "user" });
    expect((input[1] as { content: unknown[] }).content).toHaveLength(2);
  });

  it("never sends empty tool output", () => {
    expect(toResponsesInput([toolResult("c", "n", "")])[0]).toMatchObject({
      output: "(no tool output)",
    });
  });

  it("replays signed reasoning items ahead of the output they produced", () => {
    const signature = encodeReasoningSignature({ id: "rs_1", encryptedContent: "ENC" });
    const input = toResponsesInput([
      assistantMessage([
        { type: "thinking", thinking: "summary text", signature },
        { type: "toolCall", id: "call_9", name: "grep", arguments: { q: "x" } },
      ]),
    ]);
    expect(input).toEqual([
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
      { type: "function_call", call_id: "call_9", name: "grep", arguments: '{"q":"x"}' },
    ]);
  });

  it("drops reasoning items that are unsigned, orphaned, or unsupported", () => {
    const signed = encodeReasoningSignature({ id: "rs_1" });
    // No signature at all.
    expect(
      toResponsesInput([
        assistantMessage([
          { type: "thinking", thinking: "x" },
          { type: "text", text: "answer" },
        ]),
      ]),
    ).toEqual([{ role: "assistant", content: "answer" }]);
    // Signed, but nothing follows it in the turn.
    expect(
      toResponsesInput([
        assistantMessage([{ type: "thinking", thinking: "x", signature: signed }]),
      ]),
    ).toEqual([]);
    // Signed and followed, but the model is not reasoning-capable.
    expect(
      toResponsesInput(
        [
          assistantMessage([
            { type: "thinking", thinking: "x", signature: signed },
            { type: "text", text: "answer" },
          ]),
        ],
        { includeReasoning: false },
      ),
    ).toEqual([{ role: "assistant", content: "answer" }]);
  });
});

describe("reasoning signatures", () => {
  it("round-trips id and encrypted content", () => {
    const encoded = encodeReasoningSignature({ id: "rs_1", encryptedContent: "ENC" });
    expect(decodeReasoningSignature(encoded)).toEqual({ id: "rs_1", encryptedContent: "ENC" });
    expect(decodeReasoningSignature(encodeReasoningSignature({ id: "rs_2" }))).toEqual({
      id: "rs_2",
    });
  });

  it("accepts a bare id and rejects foreign or empty signatures", () => {
    expect(decodeReasoningSignature("rs_bare")).toEqual({ id: "rs_bare" });
    expect(decodeReasoningSignature(undefined)).toBeUndefined();
    expect(decodeReasoningSignature("")).toBeUndefined();
    expect(decodeReasoningSignature("{not json")).toBeUndefined();
    expect(decodeReasoningSignature('{"other":1}')).toBeUndefined();
    expect(encodeReasoningSignature({ id: "" })).toBe("");
  });
});

describe("buildOpenAIResponsesRequest", () => {
  it("maps system to instructions and clamps max_output_tokens", () => {
    const params = buildOpenAIResponsesRequest({
      model: spec,
      system: "be brief",
      messages: [userMessage("hi")],
      maxOutputTokens: 999_999,
    });
    expect(params.instructions).toBe("be brief");
    expect(params.max_output_tokens).toBe(128_000);
    expect(params.stream).toBe(true);
    expect(params.store).toBe(false);
  });

  it("emits flat function tools", () => {
    const params = buildOpenAIResponsesRequest({
      model: spec,
      messages: [],
      tools: [{ name: "read", description: "reads", parameters: { type: "object" } }],
    });
    expect(params.tools?.[0]).toEqual({
      type: "function",
      name: "read",
      description: "reads",
      parameters: { type: "object" },
      strict: false,
    });
  });

  it("maps thinking level onto reasoning.effort and requests encrypted reasoning", () => {
    expect(
      buildOpenAIResponsesRequest({ model: spec, messages: [], thinking: "off" }).reasoning,
    ).toBeUndefined();
    const high = buildOpenAIResponsesRequest({ model: spec, messages: [], thinking: "high" });
    expect(high.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(high.include).toEqual(["reasoning.encrypted_content"]);

    const noSummary = buildOpenAIResponsesRequest(
      { model: spec, messages: [], thinking: "low" },
      { reasoningSummary: null },
    );
    expect(noSummary.reasoning).toEqual({ effort: "low" });

    const noThink = modelSpec({
      provider: "openai-responses",
      model: "gpt-4.1",
      capabilities: { tools: true, vision: true, thinking: false, caching: true },
    });
    const plain = buildOpenAIResponsesRequest({ model: noThink, messages: [], thinking: "high" });
    expect(plain.reasoning).toBeUndefined();
    expect(plain.include).toBeUndefined();
  });

  it("omits include when the response is stored server-side", () => {
    const params = buildOpenAIResponsesRequest(
      { model: spec, messages: [], thinking: "medium" },
      { store: true },
    );
    expect(params.store).toBe(true);
    expect(params.include).toBeUndefined();
  });

  it("omits temperature for reasoning models and merges providerOptions", () => {
    expect(
      buildOpenAIResponsesRequest({ model: spec, messages: [], temperature: 0.5 }).temperature,
    ).toBeUndefined();
    const chatty = modelSpec({ provider: "openai-responses", model: "gpt-4.1" });
    expect(
      buildOpenAIResponsesRequest({ model: chatty, messages: [], temperature: 0.5 }).temperature,
    ).toBe(0.5);
    const merged = buildOpenAIResponsesRequest({
      model: spec,
      messages: [],
      providerOptions: { truncation: "auto" },
    });
    expect(merged.truncation).toBe("auto");
  });
});

describe("supportsResponsesTemperature", () => {
  it("borrows the Chat Completions reasoning-model rule", () => {
    expect(supportsResponsesTemperature(modelSpec({ model: "o3" }))).toBe(false);
    expect(supportsResponsesTemperature(modelSpec({ model: "gpt-5.1" }))).toBe(false);
    expect(supportsResponsesTemperature(modelSpec({ model: "gpt-4o" }))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Usage, stop reasons, error classification                                  */
/* -------------------------------------------------------------------------- */

describe("parseResponsesUsage", () => {
  it("subtracts cache buckets from the cache-inclusive input count", () => {
    expect(parseResponsesUsage(USAGE)).toEqual({
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
    });
  });

  it("keeps reasoning tokens folded into outputTokens", () => {
    expect(
      parseResponsesUsage({
        input_tokens: 10,
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 40 },
      }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 50 });
    // A gateway that reports reasoning outside output_tokens still counts.
    expect(
      parseResponsesUsage({
        input_tokens: 10,
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toMatchObject({ outputTokens: 7 });
  });

  it("reads cache writes and rejects non-objects", () => {
    expect(
      parseResponsesUsage({
        input_tokens: 100,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 },
      }),
    ).toEqual({
      inputTokens: 70,
      outputTokens: 1,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
    });
    expect(parseResponsesUsage(null)).toBeUndefined();
    expect(parseResponsesUsage("nope")).toBeUndefined();
  });
});

describe("mapResponsesStop", () => {
  it("maps every terminal status", () => {
    expect(mapResponsesStop({ status: "completed" })).toEqual({ stopReason: "endTurn" });
    expect(
      mapResponsesStop({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toEqual({ stopReason: "maxTokens" });
    expect(
      mapResponsesStop({ status: "incomplete", incomplete_details: { reason: "content_filter" } }),
    ).toMatchObject({ stopReason: "error" });
    expect(mapResponsesStop({ status: "cancelled" })).toEqual({ stopReason: "aborted" });
    expect(mapResponsesStop({ status: "failed" })).toMatchObject({ stopReason: "error" });
    expect(mapResponsesStop({ status: "in_progress" })).toEqual({ stopReason: "endTurn" });
  });
});

describe("responsesErrorToAIError", () => {
  it("maps known response error codes and falls back to shared heuristics", () => {
    expect(responsesErrorToAIError("rate_limit_exceeded", "slow down").kind).toBe("rateLimit");
    expect(responsesErrorToAIError("server_error", "boom").kind).toBe("overloaded");
    expect(responsesErrorToAIError("invalid_prompt", "bad api key").kind).toBe("auth");
    expect(responsesErrorToAIError(null, "something odd").kind).toBe("unknown");
  });
});

describe("transport error classification", () => {
  const cases: Array<[string, unknown, string, number | undefined]> = [
    ["401 as auth", Object.assign(new Error("bad key"), { status: 401 }), "auth", undefined],
    [
      "429 as rateLimit with retryAfter",
      Object.assign(new Error("slow down"), {
        status: 429,
        headers: { "retry-after": "2" },
      }),
      "rateLimit",
      2000,
    ],
    [
      "400 as invalidRequest",
      Object.assign(new Error("bad input"), { status: 400 }),
      "invalidRequest",
      undefined,
    ],
    [
      "500 as overloaded",
      Object.assign(new Error("boom"), { status: 500 }),
      "overloaded",
      undefined,
    ],
  ];

  for (const [name, thrown, kind, retryAfterMs] of cases) {
    it(`classifies ${name}`, async () => {
      const events = await collect(
        createOpenAIResponsesProvider({ client: throwingClient(thrown) }).stream({
          model: spec,
          messages: [userMessage("hi")],
        }),
      );
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      expect(terminalCount(events)).toBe(1);
      const last = terminal(events);
      expect(last.type).toBe("error");
      if (last.type !== "error") throw new Error("unreachable");
      expect(last.error.kind).toBe(kind);
      expect(last.error.retryAfterMs).toBe(retryAfterMs);
      expect(last.message.stopReason).toBe("error");
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

describe("openai-responses streaming", () => {
  it("assembles text and usage from a completed response", async () => {
    const events = await streamOf([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "Hel"),
      textDeltaEvent(0, "msg_1", "lo"),
      itemDone(0, messageItem("msg_1", "Hello")),
      completed(),
    ]);

    expect(textOf(events)).toBe("Hello");
    expect(terminalCount(events)).toBe(1);
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(end.message.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
    });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });

  it("backfills text when the server sends no deltas", async () => {
    const events = await streamOf([itemDone(0, messageItem("msg_1", "whole answer")), completed()]);
    expect(textOf(events)).toBe("whole answer");
    expect(terminal(events).message.content).toEqual([{ type: "text", text: "whole answer" }]);
  });

  it("accumulates tool-call argument deltas and parses them at the end", async () => {
    const events = await streamOf([
      itemAdded(0, functionCallItem("fc_1", "call_1", "read", "")),
      argsDeltaEvent(0, "fc_1", '{"pa'),
      argsDeltaEvent(0, "fc_1", 'th":"a.ts"}'),
      itemDone(0, functionCallItem("fc_1", "call_1", "read", '{"path":"a.ts"}')),
      completed(),
    ]);

    expect(events.find((event) => event.type === "toolCallStart")).toMatchObject({
      id: "call_1",
      name: "read",
      blockIndex: 0,
    });
    const deltas = events
      .filter(
        (event): event is Extract<StreamEvent, { type: "toolCallDelta" }> =>
          event.type === "toolCallDelta",
      )
      .map((event) => event.argumentsDelta)
      .join("");
    expect(deltas).toBe('{"path":"a.ts"}');
    expect(events.find((event) => event.type === "toolCallEnd")).toMatchObject({
      arguments: { path: "a.ts" },
    });
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    ]);
    expect(terminal(events).message.stopReason).toBe("toolCalls");
  });

  it("degrades malformed tool JSON to empty arguments", async () => {
    const events = await streamOf([
      itemAdded(0, functionCallItem("fc_1", "call_1", "read", "")),
      argsDeltaEvent(0, "fc_1", "<<<not json>>>"),
      itemDone(0, functionCallItem("fc_1", "call_1", "read", "<<<not json>>>")),
      completed(),
    ]);
    expect(events.find((event) => event.type === "toolCallEnd")).toMatchObject({ arguments: {} });
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
    ]);
  });

  it("recovers arguments that only arrive on the done item", async () => {
    const events = await streamOf([
      itemAdded(0, functionCallItem("fc_1", "call_1", "ls", "")),
      itemDone(0, functionCallItem("fc_1", "call_1", "ls", '{"dir":"."}')),
      completed(),
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "ls", arguments: { dir: "." } },
    ]);
  });

  it("handles parallel tool calls in their own blocks", async () => {
    const events = await streamOf([
      itemAdded(0, functionCallItem("fc_1", "call_1", "one", "")),
      argsDeltaEvent(0, "fc_1", "{"),
      itemAdded(1, functionCallItem("fc_2", "call_2", "two", "")),
      argsDeltaEvent(1, "fc_2", '{"x"'),
      argsDeltaEvent(0, "fc_1", '"y":1}'),
      argsDeltaEvent(1, "fc_2", ":2}"),
      itemDone(0, functionCallItem("fc_1", "call_1", "one", '{"y":1}')),
      itemDone(1, functionCallItem("fc_2", "call_2", "two", '{"x":2}')),
      completed(),
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "toolCall", id: "call_1", name: "one", arguments: { y: 1 } },
      { type: "toolCall", id: "call_2", name: "two", arguments: { x: 2 } },
    ]);
  });

  it("closes tool calls that never receive a done event", async () => {
    const events = await streamOf([
      itemAdded(0, functionCallItem("fc_1", "call_1", "read", "")),
      argsDeltaEvent(0, "fc_1", '{"path":"a"}'),
    ]);
    expect(events.find((event) => event.type === "toolCallEnd")).toMatchObject({
      arguments: { path: "a" },
    });
    expect(terminal(events).message.stopReason).toBe("toolCalls");
  });

  it("streams reasoning summaries and round-trips the reasoning item", async () => {
    const events = await streamOf(
      [
        itemAdded(0, reasoningItem("rs_1")),
        summaryDeltaEvent(0, "rs_1", "think "),
        summaryDeltaEvent(0, "rs_1", "harder"),
        itemDone(0, reasoningItem("rs_1", "ENCRYPTED")),
        itemAdded(1, functionCallItem("fc_1", "call_1", "read", "")),
        argsDeltaEvent(1, "fc_1", '{"path":"a.ts"}'),
        itemDone(1, functionCallItem("fc_1", "call_1", "read", '{"path":"a.ts"}')),
        completed(),
      ],
      { thinking: "high" },
    );

    const thinking = events
      .filter(
        (event): event is Extract<StreamEvent, { type: "thinkingDelta" }> =>
          event.type === "thinkingDelta",
      )
      .map((event) => event.delta)
      .join("");
    expect(thinking).toBe("think harder");

    const message = terminal(events).message;
    expect(message.content[0]).toEqual({
      type: "thinking",
      thinking: "think harder",
      signature: encodeReasoningSignature({ id: "rs_1", encryptedContent: "ENCRYPTED" }),
    });

    // Feeding the assistant message straight back reproduces the reasoning item.
    expect(toResponsesInput([message])).toEqual([
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENCRYPTED" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
    ]);
  });

  it("keeps a signature-only thinking block when no summary streams", async () => {
    const events = await streamOf([
      itemAdded(0, reasoningItem("rs_9")),
      itemDone(0, reasoningItem("rs_9", "ENC9")),
      itemAdded(1, messageItem("msg_1", "")),
      textDeltaEvent(1, "msg_1", "done"),
      itemDone(1, messageItem("msg_1", "done")),
      completed(),
    ]);
    const message = terminal(events).message;
    expect(message.content[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: encodeReasoningSignature({ id: "rs_9", encryptedContent: "ENC9" }),
    });
    expect(toResponsesInput([message])[0]).toMatchObject({ type: "reasoning", id: "rs_9" });
  });

  it("backfills reasoning summary text from the done item", async () => {
    const events = await streamOf([
      itemAdded(0, reasoningItem("rs_2")),
      itemDone(0, {
        type: "reasoning",
        id: "rs_2",
        summary: [{ type: "summary_text", text: "batched summary" }],
      }),
      itemAdded(1, messageItem("msg_1", "")),
      textDeltaEvent(1, "msg_1", "ok"),
      itemDone(1, messageItem("msg_1", "ok")),
      completed(),
    ]);
    expect(terminal(events).message.content[0]).toMatchObject({ thinking: "batched summary" });
  });

  it("ends as maxTokens when the response is incomplete on the token ceiling", async () => {
    const events = await streamOf([
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "partial"),
      {
        type: "response.incomplete",
        response: {
          id: "resp_1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: USAGE,
        },
      },
    ]);
    expect(terminalCount(events)).toBe(1);
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("maxTokens");
    expect(textOf(events)).toBe("partial");
  });

  it("ends in error when the response is incomplete on a content filter", async () => {
    const events = await streamOf([
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "part"),
      {
        type: "response.incomplete",
        response: {
          id: "resp_1",
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      },
    ]);
    expect(terminalCount(events)).toBe(1);
    const end = terminal(events);
    expect(end.message.stopReason).toBe("error");
    expect(end.message.errorMessage).toBe("Response incomplete: content_filter");
  });

  it("emits exactly one error event for a failed response, keeping partial content", async () => {
    const events = await streamOf([
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "half "),
      {
        type: "response.failed",
        response: {
          id: "resp_1",
          status: "failed",
          error: { code: "server_error", message: "internal boom" },
          usage: USAGE,
        },
      },
    ]);
    expect(terminalCount(events)).toBe(1);
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("overloaded");
    expect(last.error.message).toBe("internal boom");
    expect(last.message.stopReason).toBe("error");
    expect(last.message.content).toEqual([{ type: "text", text: "half " }]);
    expect(last.message.usage).toMatchObject({ inputTokens: 60 });
  });

  it("emits exactly one error event for a stream-level error event", async () => {
    const events = await streamOf([
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "x"),
      { type: "error", code: "rate_limit_exceeded", message: "too many requests", param: null },
    ]);
    expect(terminalCount(events)).toBe(1);
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("rateLimit");
  });

  it("ends as aborted when the signal is already set", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await streamOf([itemAdded(0, messageItem("msg_1", "never"))], {
      signal: controller.signal,
    });
    expect(terminalCount(events)).toBe(1);
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("aborted");
  });

  it("ends as aborted when the transport reports an abort mid-stream", async () => {
    const controller = new AbortController();
    const client = {
      responses: {
        create: vi.fn(async () =>
          (async function* () {
            yield itemAdded(0, messageItem("msg_1", "")) as unknown as ResponseStreamEvent;
            yield textDeltaEvent(0, "msg_1", "partial") as unknown as ResponseStreamEvent;
            controller.abort();
            throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
          })(),
        ),
      },
    } as unknown as OpenAIResponsesClientLike;

    const events = await collect(
      createOpenAIResponsesProvider({ client }).stream({
        model: spec,
        messages: [userMessage("hi")],
        signal: controller.signal,
      }),
    );
    expect(terminalCount(events)).toBe(1);
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("aborted");
    expect(end.message.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("ignores unknown event types", async () => {
    const events = await streamOf([
      { type: "response.web_search_call.in_progress", output_index: 5, item_id: "ws_1" },
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "fine"),
      itemDone(0, messageItem("msg_1", "fine")),
      completed(undefined),
    ]);
    expect(textOf(events)).toBe("fine");
    expect(terminal(events).type).toBe("end");
  });

  it("sends the mapped payload through the SDK and completes without streaming", async () => {
    const client = fakeClient([
      itemAdded(0, messageItem("msg_1", "")),
      textDeltaEvent(0, "msg_1", "hi there"),
      itemDone(0, messageItem("msg_1", "hi there")),
      completed(),
    ]);
    const message = await createOpenAIResponsesProvider({ client }).complete({
      model: spec,
      system: "be brief",
      messages: [userMessage("hello")],
      signal: new AbortController().signal,
    });
    expect(message.content).toEqual([{ type: "text", text: "hi there" }]);
    const create = client.responses.create as unknown as ReturnType<typeof vi.fn>;
    const [params, requestOptions] = create.mock.calls[0] as [
      Record<string, unknown>,
      { signal?: AbortSignal } | undefined,
    ];
    expect(params.instructions).toBe("be brief");
    expect(params.input).toEqual([{ role: "user", content: "hello" }]);
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
  });
});

/* -------------------------------------------------------------------------- */
/* Catalog + registration                                                     */
/* -------------------------------------------------------------------------- */

describe("openaiResponsesModel", () => {
  it("builds a spec routed at the responses provider", () => {
    expect(openaiResponsesModel("gpt-5.1")).toEqual({
      id: "openai-responses/gpt-5.1",
      provider: "openai-responses",
      model: "gpt-5.1",
      displayName: "gpt-5.1",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      capabilities: { tools: true, vision: true, thinking: true, caching: true },
      apiKeyEnv: "OPENAI_API_KEY",
    });
  });

  it("honours overrides", () => {
    const custom = openaiResponsesModel("o4-mini", {
      id: "custom/o4-mini",
      displayName: "o4 mini",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      cost: { input: 1, output: 4 },
      capabilities: { vision: false },
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "GATEWAY_KEY",
    });
    expect(custom).toMatchObject({
      id: "custom/o4-mini",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "GATEWAY_KEY",
      cost: { input: 1, output: 4 },
      capabilities: { tools: true, vision: false, thinking: true, caching: true },
    });
  });
});

describe("registerOpenAIResponsesProvider", () => {
  it("registers a factory that requires an API key naming OPENAI_API_KEY", () => {
    const previous = getProviderFactory("openai-responses");
    try {
      registerOpenAIResponsesProvider();
      const registration = getProviderFactory("openai-responses");
      expect(registration).toBeDefined();
      if (!registration) throw new Error("unreachable");

      const ctx = {
        spec: openaiResponsesModel("gpt-5.1"),
        apiKey: undefined,
        baseUrl: undefined,
        headers: undefined,
      };
      expect(registration.checkCredentials?.(ctx)).toEqual({
        kind: "auth",
        message: "No API key for openai-responses; set OPENAI_API_KEY",
      });
      expect(registration.checkCredentials?.({ ...ctx, apiKey: "sk-test" })).toBeUndefined();

      const client = registration.factory({ ...ctx, apiKey: "sk-test" });
      expect(typeof client.stream).toBe("function");
      expect(typeof client.complete).toBe("function");
    } finally {
      unregisterProviderFactory("openai-responses");
      if (previous) {
        // Restore whatever the host had registered before this test ran.
        registerOpenAIResponsesProvider();
      }
    }
  });
});
