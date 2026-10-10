import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { LLMRequest, StreamEvent } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { requireModel } from "../catalog.js";
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
  type AnthropicClientLike,
  buildAnthropicRequest,
  createAnthropicProvider,
  mapAnthropicStopReason,
  REDACTED_THINKING_PREFIX,
  toAnthropicMessages,
} from "./anthropic.js";

const spec = modelSpec();

function fakeClient(events: unknown[]): AnthropicClientLike & { params: unknown } {
  const client = {
    params: undefined as unknown,
    messages: {
      create: vi.fn(async (params: unknown) => {
        client.params = params;
        return (async function* () {
          for (const event of events) yield event as RawMessageStreamEvent;
        })();
      }),
    },
  };
  return client as unknown as AnthropicClientLike & { params: unknown };
}

function messageStart(usage: Record<string, unknown> = {}): unknown {
  return {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "test-model",
      usage: { input_tokens: 10, output_tokens: 0, ...usage },
    },
  };
}

const MESSAGE_STOP = { type: "message_stop" };

function messageDelta(stopReason: string, usage: Record<string, unknown> = {}): unknown {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5, ...usage },
  };
}

async function streamOf(
  events: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const client = fakeClient(events);
  const provider = createAnthropicProvider({ client });
  return collect(provider.stream({ model: spec, messages: [userMessage("hi")], ...overrides }));
}

describe("toAnthropicMessages", () => {
  it("maps text and images", () => {
    const result = toAnthropicMessages([userMessage("hello"), imageMessage("BASE64", "image/jpg")]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BASE64" } },
        ],
      },
    ]);
  });

  it("drops unsupported image types and blank text", () => {
    const result = toAnthropicMessages([
      { role: "user", content: [{ type: "text", text: "   " }], timestamp: 1 },
      imageMessage("X", "image/tiff"),
    ]);
    expect(result).toEqual([]);
  });

  it("keeps signed thinking, encodes redacted thinking and drops unsigned thinking", () => {
    const result = toAnthropicMessages([
      assistantMessage([
        { type: "thinking", thinking: "signed", signature: "sig" },
        { type: "thinking", thinking: "unsigned" },
        { type: "thinking", thinking: "", signature: `${REDACTED_THINKING_PREFIX}BLOB` },
        { type: "text", text: "answer" },
      ]),
    ]);
    expect(result[0]?.content).toEqual([
      { type: "thinking", thinking: "signed", signature: "sig" },
      { type: "redacted_thinking", data: "BLOB" },
      { type: "text", text: "answer" },
    ]);
  });

  it("emits tool_use blocks and coalesces consecutive tool results into one user turn", () => {
    const result = toAnthropicMessages([
      userMessage("run them"),
      assistantMessage([
        { type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
        { type: "toolCall", id: "b", name: "list", arguments: {} },
      ]),
      toolResult("a", "read", "contents"),
      toolResult("b", "list", "failed", { isError: true }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[1]?.role).toBe("assistant");
    expect(result[2]?.role).toBe("user");
    expect(result[2]?.content).toHaveLength(2);
    expect(result[2]?.content?.[1]).toMatchObject({ tool_use_id: "b", is_error: true });
  });

  it("places tool_result blocks before other content in a merged user turn", () => {
    const result = toAnthropicMessages([
      toolResult("a", "read", "ok"),
      userMessage("and now this"),
      toolResult("b", "read", "ok too"),
    ]);
    expect(result).toHaveLength(1);
    const blocks = result[0]?.content as Array<{ type: string }>;
    expect(blocks.map((block) => block.type)).toEqual(["tool_result", "tool_result", "text"]);
  });

  it("substitutes placeholder text for an empty tool result", () => {
    const result = toAnthropicMessages([toolResult("a", "read", "")]);
    expect(result[0]?.content?.[0]).toMatchObject({
      content: [{ type: "text", text: "(no tool output)" }],
    });
  });

  it("skips assistant messages that end up empty", () => {
    expect(toAnthropicMessages([assistantMessage([{ type: "text", text: "" }])])).toEqual([]);
  });
});

describe("buildAnthropicRequest", () => {
  it("sets caching breakpoints on the system prompt, last tool and last user block", () => {
    const params = buildAnthropicRequest({
      model: spec,
      system: "be brief",
      messages: [userMessage("hi")],
      tools: [
        { name: "a", description: "", parameters: { type: "object" } },
        { name: "b", description: "", parameters: { type: "object" } },
      ],
    });
    expect(params.system).toEqual([
      { type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.tools?.[0]).not.toHaveProperty("cache_control");
    expect(params.tools?.[1]).toHaveProperty("cache_control", { type: "ephemeral" });
    const blocks = params.messages[0]?.content as Array<Record<string, unknown>>;
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits caching for models that do not support it", () => {
    const params = buildAnthropicRequest({
      model: modelSpec({ capabilities: { ...spec.capabilities, caching: false } }),
      system: "hi",
      messages: [userMessage("hi")],
    });
    expect(params.system).toEqual([{ type: "text", text: "hi" }]);
  });

  it("maps thinking levels onto budgets and suppresses temperature", () => {
    const base = { model: spec, messages: [userMessage("hi")], temperature: 0.7 };
    expect(buildAnthropicRequest({ ...base, thinking: "off" }).thinking).toBeUndefined();
    expect(buildAnthropicRequest({ ...base, thinking: "off" }).temperature).toBe(0.7);
    expect(buildAnthropicRequest({ ...base, thinking: "low" }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
    expect(buildAnthropicRequest({ ...base, thinking: "medium" }).thinking).toMatchObject({
      budget_tokens: 16384,
    });
    expect(buildAnthropicRequest({ ...base, thinking: "high" }).thinking).toMatchObject({
      budget_tokens: 32768,
    });
    expect(buildAnthropicRequest({ ...base, thinking: "high" }).temperature).toBeUndefined();
  });

  it("keeps budget_tokens for a 4.5-generation model", () => {
    const opus45 = modelSpec({ model: "claude-opus-4-5", id: "anthropic/claude-opus-4-5" });
    const params = buildAnthropicRequest({
      model: opus45,
      messages: [userMessage("hi")],
      thinking: "medium",
    });
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
    expect(params.output_config).toBeUndefined();
  });

  it("emits adaptive thinking with an effort level for a 5-generation model", () => {
    const opus5 = modelSpec({ model: "claude-opus-5", id: "anthropic/claude-opus-5" });
    const base = { model: opus5, messages: [userMessage("hi")] };

    const high = buildAnthropicRequest({ ...base, thinking: "high" });
    expect(high.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(high.thinking).not.toHaveProperty("budget_tokens");
    expect(high.output_config).toEqual({ effort: "high" });

    expect(buildAnthropicRequest({ ...base, thinking: "low" }).output_config).toEqual({
      effort: "low",
    });
    expect(buildAnthropicRequest({ ...base, thinking: "medium" }).output_config).toEqual({
      effort: "medium",
    });

    // "off" omits the parameter rather than sending `disabled` — which Opus 5
    // rejects above effort `high` and which carries two documented failure
    // modes below it. But omitting `thinking` runs *adaptive* on Opus 5, at its
    // default `high`: "off" used to buy the most expensive turn on offer. The
    // lowest effort is the closest thing to off this model has.
    const off = buildAnthropicRequest({ ...base, thinking: "off" });
    expect(off.thinking).toBeUndefined();
    expect(off.output_config).toEqual({ effort: "low" });
  });

  it("treats the 4.6 generation as adaptive and dated 4.x ids as budget", () => {
    const sonnet46 = modelSpec({ model: "claude-sonnet-4-6", id: "anthropic/claude-sonnet-4-6" });
    expect(
      buildAnthropicRequest({ model: sonnet46, messages: [userMessage("hi")], thinking: "high" })
        .thinking,
    ).toEqual({ type: "adaptive" });

    // The minor version must not swallow a date suffix: this is 4.0, not 4.20.
    const dated = modelSpec({
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      id: "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0",
    });
    expect(
      buildAnthropicRequest({ model: dated, messages: [userMessage("hi")], thinking: "high" })
        .thinking,
    ).toMatchObject({ type: "enabled" });
  });

  it("lets an explicit thinkingStyle capability override the model id", () => {
    const proxied = modelSpec({
      model: "claude-opus-4-5",
      capabilities: { ...spec.capabilities, thinkingStyle: "adaptive" },
    });
    expect(
      buildAnthropicRequest({ model: proxied, messages: [userMessage("hi")], thinking: "high" })
        .thinking,
    ).toEqual({ type: "adaptive" });
  });

  it("drops temperature on models that removed the sampling parameters", () => {
    const opus5 = modelSpec({ model: "claude-opus-5", id: "anthropic/claude-opus-5" });
    expect(
      buildAnthropicRequest({
        model: opus5,
        messages: [userMessage("hi")],
        thinking: "off",
        temperature: 0.7,
      }).temperature,
    ).toBeUndefined();

    // 4.6 still accepts sampling parameters.
    const sonnet46 = modelSpec({ model: "claude-sonnet-4-6", id: "anthropic/claude-sonnet-4-6" });
    expect(
      buildAnthropicRequest({
        model: sonnet46,
        messages: [userMessage("hi")],
        thinking: "off",
        temperature: 0.7,
      }).temperature,
    ).toBe(0.7);
  });

  it("enables eager input streaming only on tools that ask for it, first-party only", () => {
    const tools = [
      { name: "read", description: "d", parameters: {} },
      { name: "write", description: "d", parameters: {}, eagerInputStreaming: true },
    ];
    const params = buildAnthropicRequest(
      { model: spec, messages: [userMessage("hi")], tools },
      { firstParty: true },
    );
    expect(params.tools).toHaveLength(2);
    expect(params.tools?.[0]).not.toHaveProperty("eager_input_streaming");
    expect(params.tools?.[1]).toMatchObject({ eager_input_streaming: true });
    // Bedrock, Vertex and proxies build without `firstParty`.
    const elsewhere = buildAnthropicRequest({ model: spec, messages: [userMessage("hi")], tools });
    expect(elsewhere.tools?.[1]).not.toHaveProperty("eager_input_streaming");
  });

  it("clamps the thinking budget to leave room for an answer", () => {
    const small = modelSpec({ maxOutputTokens: 4_000 });
    const params = buildAnthropicRequest({
      model: small,
      messages: [userMessage("hi")],
      thinking: "high",
    });
    expect(params.thinking).toEqual({ type: "enabled", budget_tokens: 2976 });
  });

  it("disables thinking when there is no room for a budget", () => {
    const tiny = modelSpec({ maxOutputTokens: 1_500 });
    expect(
      buildAnthropicRequest({ model: tiny, messages: [userMessage("hi")], thinking: "high" })
        .thinking,
    ).toBeUndefined();
  });

  it("clamps max_tokens to the model ceiling and merges providerOptions", () => {
    const params = buildAnthropicRequest({
      model: spec,
      messages: [userMessage("hi")],
      maxOutputTokens: 999_999,
      providerOptions: { top_k: 40 },
    });
    expect(params.max_tokens).toBe(spec.maxOutputTokens);
    expect((params as unknown as { top_k: number }).top_k).toBe(40);
  });
});

describe("buildAnthropicRequest — the 5.5 generation's thinking rules", () => {
  const ask = (id: string, thinking?: LLMRequest["thinking"]) =>
    buildAnthropicRequest({
      model: requireModel(id),
      messages: [userMessage("hi")],
      ...(thinking === undefined ? {} : { thinking }),
    });

  it("sends xhigh and max as themselves wherever the model has them", () => {
    for (const id of [
      "anthropic/claude-opus-5-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
    ]) {
      expect(ask(id, "xhigh").output_config, id).toEqual({ effort: "xhigh" });
      expect(ask(id, "max").output_config, id).toEqual({ effort: "max" });
    }
  });

  it("clamps xhigh down to high on the 4.6 generation, which has no xhigh", () => {
    // Opus 4.6 and Sonnet 4.6 take low | medium | high | max. Sending the level
    // they lack is a 400; the nearest level below it is the honest substitute.
    for (const id of ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]) {
      expect(ask(id, "xhigh").output_config, id).toEqual({ effort: "high" });
      expect(ask(id, "max").output_config, id).toEqual({ effort: "max" });
    }
  });

  it("clamps by id for an ad-hoc 4.6 spec the catalog never saw", () => {
    const proxied = modelSpec({ model: "us.anthropic.claude-sonnet-4-6" });
    expect(
      buildAnthropicRequest({ model: proxied, messages: [userMessage("hi")], thinking: "xhigh" })
        .output_config,
    ).toEqual({ effort: "high" });
  });

  it("gives the budget generation a budget for xhigh and max instead of an effort", () => {
    const params = ask("anthropic/claude-sonnet-4-5", "max");
    expect(params.thinking).toMatchObject({ type: "enabled" });
    expect(params.output_config).toBeUndefined();
    // Clamped to leave room for an answer under the 64K output ceiling.
    expect((params.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(64_000);
  });

  it("asks for summarized thinking on adaptive models whose default display is omitted", () => {
    // From Opus 4.7 on, thinking blocks stream with empty text unless the
    // request asks for a summary — and Arcturn renders thinking.
    for (const id of [
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
    ]) {
      expect(ask(id, "high").thinking, id).toEqual({ type: "adaptive", display: "summarized" });
    }
    // 4.6 already defaults to summarized and predates the field.
    expect(ask("anthropic/claude-sonnet-4-6", "high").thinking).toEqual({ type: "adaptive" });
  });

  it("never sends a thinking key for off on a model whose thinking cannot be turned off", () => {
    // Fable 5.1 and Opus 5.5 400 on `disabled` and on `budget_tokens`; the
    // lowest effort is the only lever, so "off" spends it.
    for (const id of ["anthropic/claude-fable-5-1", "anthropic/claude-opus-5-5"]) {
      const off = ask(id, "off");
      expect(off, id).not.toHaveProperty("thinking");
      expect(off.output_config, id).toEqual({ effort: "low" });
      // Undefined thinking is the loop's spelling of "off".
      expect(ask(id).output_config, id).toEqual({ effort: "low" });
    }
  });

  it("turns thinking off on Sonnet 5.5 with between_tools and nothing else", () => {
    // `disabled` 400s on Sonnet 5.5. `between_tools` takes no other field and
    // is accepted only at effort high or below, so no effort rides along.
    const off = ask("anthropic/claude-sonnet-5-5", "off");
    expect(off.thinking).toEqual({ type: "between_tools" });
    expect(off.output_config).toBeUndefined();
  });

  it("turns thinking off on Haiku 5.5 with disabled, where omitting it would think", () => {
    const off = ask("anthropic/claude-haiku-5-5", "off");
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off.output_config).toBeUndefined();
  });

  it("still omits thinking for off on the 4.x models, where omitting means no thinking", () => {
    for (const id of ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6"]) {
      const off = ask(id, "off");
      expect(off, id).not.toHaveProperty("thinking");
      expect(off, id).not.toHaveProperty("output_config");
    }
  });

  it("always sends Opus 5.5 an explicit effort, since its default is medium, not high", () => {
    for (const level of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(ask("anthropic/claude-opus-5-5", level).output_config?.effort, level).toBeDefined();
    }
    expect(ask("anthropic/claude-opus-5-5", "high").output_config).toEqual({ effort: "high" });
  });

  it("infers the off-rules from the id for a spec the catalog never saw", () => {
    const bare = (model: string) =>
      buildAnthropicRequest({
        model: modelSpec({ model }),
        messages: [userMessage("hi")],
        thinking: "off",
      });
    expect(bare("claude-fable-5-1")).not.toHaveProperty("thinking");
    expect(bare("claude-fable-5-1").output_config).toEqual({ effort: "low" });
    expect(bare("anthropic.claude-opus-5-5").output_config).toEqual({ effort: "low" });
    expect(bare("claude-sonnet-5-5").thinking).toEqual({ type: "between_tools" });
    expect(bare("claude-haiku-5-5").thinking).toEqual({ type: "disabled" });
    expect(bare("claude-sonnet-5").thinking).toEqual({ type: "disabled" });
  });
});

describe("mapAnthropicStopReason", () => {
  it("maps every documented value", () => {
    expect(mapAnthropicStopReason("end_turn")).toBe("endTurn");
    expect(mapAnthropicStopReason("stop_sequence")).toBe("endTurn");
    expect(mapAnthropicStopReason("pause_turn")).toBe("pauseTurn");
    expect(mapAnthropicStopReason("max_tokens")).toBe("maxTokens");
    expect(mapAnthropicStopReason("model_context_window_exceeded")).toBe("maxTokens");
    expect(mapAnthropicStopReason("tool_use")).toBe("toolCalls");
    expect(mapAnthropicStopReason("refusal")).toBe("refusal");
    expect(mapAnthropicStopReason(null)).toBe("endTurn");
  });
});

describe("anthropic streaming", () => {
  it("assembles text with usage from message_start and message_delta", async () => {
    const events = await streamOf([
      messageStart({ cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      messageDelta("end_turn", { output_tokens: 7 }),
      MESSAGE_STOP,
    ]);
    expect(textOf(events)).toBe("Hello world");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    });
    expect(end.message.usage.costUsd).toBeGreaterThan(0);
  });

  it("does not let message_delta zero out message_start usage", async () => {
    const events = await streamOf([
      messageStart({ input_tokens: 100, cache_read_input_tokens: 9 }),
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      MESSAGE_STOP,
    ]);
    expect(terminal(events).message.usage).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 9,
      outputTokens: 3,
    });
  });

  it("surfaces thinking tokens from output_tokens_details", async () => {
    const events = await streamOf([
      messageStart(),
      messageDelta("end_turn", {
        output_tokens: 900,
        // Streaming only carries the breakdown on the final message_delta.
        output_tokens_details: { thinking_tokens: 640 },
      }),
      MESSAGE_STOP,
    ]);
    const usage = terminal(events).message.usage;
    expect(usage.thinkingTokens).toBe(640);
    // A subset of output_tokens, which stays the billed total.
    expect(usage.outputTokens).toBe(900);
  });

  it("leaves thinking tokens absent when the provider reports no breakdown", async () => {
    const events = await streamOf([messageStart(), messageDelta("end_turn"), MESSAGE_STOP]);
    expect(terminal(events).message.usage.thinkingTokens).toBeUndefined();
  });

  it("accumulates tool-call JSON deltas and emits parsed arguments", async () => {
    const events = await streamOf([
      messageStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
      },
      { type: "content_block_stop", index: 0 },
      messageDelta("tool_use"),
      MESSAGE_STOP,
    ]);
    const toolEnd = events.find((event) => event.type === "toolCallEnd");
    expect(toolEnd).toEqual({
      type: "toolCallEnd",
      blockIndex: 0,
      id: "toolu_1",
      name: "read",
      arguments: { path: "a.ts" },
    });
    const end = terminal(events);
    expect(end.message.stopReason).toBe("toolCalls");
    expect(end.message.content).toEqual([
      { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } },
    ]);
  });

  it("degrades malformed tool JSON to empty arguments", async () => {
    const events = await streamOf([
      messageStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "x" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "!!not json!!" },
      },
      { type: "content_block_stop", index: 0 },
      messageDelta("tool_use"),
      MESSAGE_STOP,
    ]);
    expect(events.find((event) => event.type === "toolCallEnd")).toMatchObject({ arguments: {} });
  });

  it("round-trips thinking with a chunked signature", async () => {
    const events = await streamOf([
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "step 1" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "AB" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "CD" },
      },
      { type: "content_block_stop", index: 0 },
      messageDelta("end_turn"),
      MESSAGE_STOP,
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "thinking", thinking: "step 1", signature: "ABCD" },
    ]);
    expect(events.some((event) => event.type === "thinkingDelta")).toBe(true);
  });

  it("preserves redacted thinking blobs", async () => {
    const events = await streamOf([
      messageStart(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "OPAQUE" },
      },
      { type: "content_block_stop", index: 0 },
      messageDelta("end_turn"),
      MESSAGE_STOP,
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "thinking", thinking: "", signature: `${REDACTED_THINKING_PREFIX}OPAQUE` },
    ]);
  });

  it("reports a truncated stream as a retryable network error", async () => {
    const events = await streamOf([
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "part" } },
    ]);
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("network");
    expect(last.message.content).toEqual([{ type: "text", text: "part" }]);
  });

  it("surfaces a refusal as its own stop reason, with the category it was declined under", async () => {
    // HTTP 200, `stop_reason: "refusal"`: a classifier declined the request.
    // That is a finished turn, not a failed one — filing it as `error` sent it
    // down every retry and "the run failed" path a transport fault takes.
    const events = await streamOf([
      messageStart(),
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "Exploit development" },
        },
        usage: { output_tokens: 1 },
      },
      MESSAGE_STOP,
    ]);
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("refusal");
    expect(end.message.stopDetails).toEqual({
      category: "cyber",
      explanation: "Exploit development",
    });
    expect(end.message.errorMessage).toBeUndefined();
  });

  it("keeps a null refusal category as null and an absent explanation absent", async () => {
    const events = await streamOf([
      messageStart(),
      {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: null } },
        usage: { output_tokens: 1 },
      },
      MESSAGE_STOP,
    ]);
    const end = terminal(events);
    expect(end.message.stopReason).toBe("refusal");
    expect(end.message.stopDetails).toEqual({ category: null });
  });

  it("leaves stopDetails off every stop that is not a refusal", async () => {
    const events = await streamOf([messageStart(), messageDelta("end_turn"), MESSAGE_STOP]);
    expect(terminal(events).message).not.toHaveProperty("stopDetails");
  });

  it("drops the partial output of a refused turn when replaying history", () => {
    // A classifier can fire mid-stream; the docs say discard the partial
    // rather than treat it as a finished turn. Replaying it would also hand a
    // thinking block from a declined attempt back to the API.
    const refused = assistantMessage(
      [
        { type: "thinking", thinking: "partial", signature: "sig" },
        { type: "text", text: "Here is how to" },
      ],
      { stopReason: "refusal", stopDetails: { category: "cyber" } },
    );
    expect(toAnthropicMessages([userMessage("q"), refused, userMessage("something else")])).toEqual(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "q" },
            { type: "text", text: "something else" },
          ],
        },
      ],
    );
  });

  it("maps SDK failures onto AIError kinds", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("rate limited"), {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }),
      },
    } as unknown as AnthropicClientLike;
    const events = await collect(
      createAnthropicProvider({ client }).stream({ model: spec, messages: [userMessage("hi")] }),
    );
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error).toMatchObject({ kind: "rateLimit", status: 429, retryAfterMs: 2000 });
  });

  it("forwards the abort signal and ends as aborted", async () => {
    const controller = new AbortController();
    const client = fakeClient([messageStart(), MESSAGE_STOP]);
    const provider = createAnthropicProvider({ client });
    await collect(
      provider.stream({ model: spec, messages: [userMessage("hi")], signal: controller.signal }),
    );
    const create = (client as unknown as { messages: { create: ReturnType<typeof vi.fn> } })
      .messages.create;
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("complete() returns the terminal message", async () => {
    const client = fakeClient([
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
      { type: "content_block_stop", index: 0 },
      messageDelta("end_turn"),
      MESSAGE_STOP,
    ]);
    const message = await createAnthropicProvider({ client }).complete({
      model: spec,
      messages: [userMessage("hi")],
    });
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
  });
});

describe("server-side refusal fallbacks", () => {
  /** A client exposing both the GA and the beta Messages surfaces. */
  function dualClient(events: unknown[]) {
    const stream = () =>
      (async function* () {
        for (const event of events) yield event as RawMessageStreamEvent;
      })();
    const ga = vi.fn(async (_params: unknown) => stream());
    const beta = vi.fn(async (_params: unknown) => stream());
    const client = { messages: { create: ga }, beta: { messages: { create: beta } } };
    return { client: client as unknown as AnthropicClientLike, ga, beta };
  }

  const opus55 = () => requireModel("anthropic/claude-opus-5-5");
  const plainTurn = [messageStart(), messageDelta("end_turn"), MESSAGE_STOP];

  it("opts in through the beta surface with the default-mode header", async () => {
    const { client, ga, beta } = dualClient(plainTurn);
    const provider = createAnthropicProvider({ client, fallbacks: "default" });
    await collect(provider.stream({ model: opus55(), messages: [userMessage("hi")] }));
    expect(ga).not.toHaveBeenCalled();
    expect(beta).toHaveBeenCalledTimes(1);
    expect(beta.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
  });

  it("stays on the GA surface, with no fallbacks key, unless the provider opted in", async () => {
    const { client, ga, beta } = dualClient(plainTurn);
    await collect(
      createAnthropicProvider({ client }).stream({
        model: opus55(),
        messages: [userMessage("hi")],
      }),
    );
    expect(beta).not.toHaveBeenCalled();
    expect(ga.mock.calls[0]?.[0]).not.toHaveProperty("fallbacks");
  });

  it("does not ask for a fallback on a model that has none", async () => {
    // Haiku 5.5 runs classifiers but has no server-side fallback: "default"
    // would stay declined and a list would 400. Opus 4.8 runs none at all.
    for (const id of ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-4-8"]) {
      const { client, ga, beta } = dualClient(plainTurn);
      const provider = createAnthropicProvider({ client, fallbacks: "default" });
      await collect(provider.stream({ model: requireModel(id), messages: [userMessage("hi")] }));
      expect(beta, id).not.toHaveBeenCalled();
      expect(ga.mock.calls[0]?.[0], id).not.toHaveProperty("fallbacks");
    }
  });

  it("bills a fallback turn at the model that answered, and drops the declined attempt's reasoning", async () => {
    const { client } = dualClient([
      {
        type: "message_start",
        message: {
          id: "m",
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "fallback",
          from: { model: "claude-opus-5-5" },
          to: { model: "claude-opus-4-8" },
          trigger: { type: "refusal", category: "cyber" },
        },
      },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "answer" } },
      { type: "content_block_stop", index: 2 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        usage: {
          output_tokens: 1000,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 10, output_tokens: 3 },
            {
              type: "fallback_message",
              model: "claude-opus-4-8",
              input_tokens: 10,
              output_tokens: 1000,
            },
          ],
        },
      },
      MESSAGE_STOP,
    ]);
    const provider = createAnthropicProvider({ client, fallbacks: "default" });
    const events = await collect(
      provider.stream({ model: opus55(), messages: [userMessage("q")] }),
    );
    const message = terminal(events).message;
    expect(message.model).toBe("anthropic/claude-opus-4-8");
    expect(message.stopReason).toBe("endTurn");
    // Opus 4.8's $5/$25, not Opus 5.5's $4/$20.
    expect(message.usage.costUsd).toBeCloseTo((10 * 5 + 1000 * 25) / 1_000_000, 10);
    // Thinking from before the switch point belongs to the model that declined;
    // the docs say omit it when the turn is echoed back.
    expect(message.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("recognises a sticky-served turn, which carries no fallback block", async () => {
    const { client } = dualClient([
      {
        type: "message_start",
        message: {
          id: "m",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 1000,
          iterations: [
            {
              type: "fallback_message",
              model: "claude-opus-4-8",
              input_tokens: 10,
              output_tokens: 1000,
            },
          ],
        },
      },
      MESSAGE_STOP,
    ]);
    const provider = createAnthropicProvider({ client, fallbacks: "default" });
    const message = terminal(
      await collect(provider.stream({ model: opus55(), messages: [userMessage("q")] })),
    ).message;
    expect(message.model).toBe("anthropic/claude-opus-4-8");
    expect(message.usage.costUsd).toBeCloseTo((10 * 5 + 1000 * 25) / 1_000_000, 10);
  });

  it("reports cost as unknown, never $0, when the answering model is not in the catalog", async () => {
    const { client } = dualClient([
      {
        type: "message_start",
        message: {
          id: "m",
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 5,
          iterations: [
            {
              type: "fallback_message",
              model: "claude-unknown-9",
              input_tokens: 10,
              output_tokens: 5,
            },
          ],
        },
      },
      MESSAGE_STOP,
    ]);
    const provider = createAnthropicProvider({ client, fallbacks: "default" });
    const message = terminal(
      await collect(provider.stream({ model: opus55(), messages: [userMessage("q")] })),
    ).message;
    expect(message.model).toBe("anthropic/claude-unknown-9");
    expect(message.usage.costUsd).toBeUndefined();
  });
});
