import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { LLMRequest, ModelSpec, StreamEvent } from "@arcturn/types";
import type {
  ConverseStreamCommand,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../catalog.js";
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
import { type AnthropicClientLike, REDACTED_THINKING_PREFIX } from "./anthropic.js";
import {
  type BedrockRuntimeClientLike,
  bedrockCacheKey,
  bedrockModelFamily,
  buildConverseRequest,
  checkBedrockCredentials,
  createBedrockProvider,
  mapConverseStopReason,
  normalizeBedrockModelId,
  parseConverseUsage,
  resolveBedrockRegion,
  toBedrockError,
  toConverseMessages,
  toConverseSystem,
  toConverseToolConfig,
} from "./bedrock.js";
import { bedrockInferenceProfile, bedrockModel } from "./bedrock-models.js";

const CLAUDE_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const nova = modelSpec({
  id: "bedrock/amazon.nova-pro-v1:0",
  provider: "bedrock",
  model: "amazon.nova-pro-v1:0",
});

const claude = modelSpec({
  id: `bedrock/${CLAUDE_ID}`,
  provider: "bedrock",
  model: CLAUDE_ID,
});

/** A spec with a region pinned through the Bedrock `providerOptions` bag. */
function pinned(region: string, overrides: Partial<ModelSpec> = {}): ModelSpec {
  return { ...modelSpec({ provider: "bedrock", ...overrides }), providerOptions: { region } };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeConverseClient extends BedrockRuntimeClientLike {
  input?: ConverseStreamCommandInput;
  abortSignal?: AbortSignal;
}

function fakeConverseClient(events: unknown[]): FakeConverseClient {
  const client: FakeConverseClient = {
    send: vi.fn(
      async (
        command: ConverseStreamCommand,
        options?: { abortSignal?: AbortSignal },
      ): Promise<ConverseStreamCommandOutput> => {
        client.input = command.input;
        client.abortSignal = options?.abortSignal;
        return {
          $metadata: {},
          stream: (async function* () {
            for (const event of events) yield event as ConverseStreamOutput;
          })(),
        };
      },
    ),
  };
  return client;
}

function throwingConverseClient(error: unknown): BedrockRuntimeClientLike {
  return {
    send: vi.fn(async () => {
      throw error;
    }),
  };
}

function fakeAnthropicClient(events: unknown[]): AnthropicClientLike & { params?: unknown } {
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
  return client as unknown as AnthropicClientLike & { params?: unknown };
}

// ---------------------------------------------------------------------------
// Converse event helpers
// ---------------------------------------------------------------------------

const MESSAGE_START = { messageStart: { role: "assistant" } };

function textDelta(index: number, text: string): unknown {
  return { contentBlockDelta: { contentBlockIndex: index, delta: { text } } };
}

function toolStart(index: number, toolUseId: string, name: string): unknown {
  return {
    contentBlockStart: { contentBlockIndex: index, start: { toolUse: { toolUseId, name } } },
  };
}

function toolDelta(index: number, input: string): unknown {
  return { contentBlockDelta: { contentBlockIndex: index, delta: { toolUse: { input } } } };
}

function reasoningDelta(index: number, reasoningContent: Record<string, unknown>): unknown {
  return { contentBlockDelta: { contentBlockIndex: index, delta: { reasoningContent } } };
}

function blockStop(index: number): unknown {
  return { contentBlockStop: { contentBlockIndex: index } };
}

function messageStop(stopReason: string): unknown {
  return { messageStop: { stopReason } };
}

function metadata(usage: Record<string, number>): unknown {
  return { metadata: { usage, metrics: { latencyMs: 12 } } };
}

async function streamOf(
  events: unknown[],
  overrides: Partial<LLMRequest> = {},
): Promise<StreamEvent[]> {
  const client = fakeConverseClient(events);
  const provider = createBedrockProvider({ converseClient: client, region: "us-east-1" });
  return collect(provider.stream({ model: nova, messages: [userMessage("hi")], ...overrides }));
}

// ---------------------------------------------------------------------------
// Model ids and regions
// ---------------------------------------------------------------------------

describe("normalizeBedrockModelId", () => {
  it("strips inference-profile prefixes and ARN wrappers", () => {
    expect(normalizeBedrockModelId("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(normalizeBedrockModelId(CLAUDE_ID)).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(normalizeBedrockModelId("apac.anthropic.claude-sonnet-4-20250514-v1:0")).toBe(
      "anthropic.claude-sonnet-4-20250514-v1:0",
    );
    expect(
      normalizeBedrockModelId(
        "arn:aws:bedrock:eu-west-1:1234:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ),
    ).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(normalizeBedrockModelId("amazon.nova-pro-v1:0")).toBe("amazon.nova-pro-v1:0");
  });
});

describe("bedrockModelFamily", () => {
  it("routes Claude ids to the Messages API and everything else to Converse", () => {
    expect(bedrockModelFamily("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
    expect(bedrockModelFamily(CLAUDE_ID)).toBe("anthropic");
    expect(bedrockModelFamily("global.anthropic.claude-opus-4-5-20251101-v1:0")).toBe("anthropic");
    expect(bedrockModelFamily("amazon.nova-pro-v1:0")).toBe("converse");
    expect(bedrockModelFamily("meta.llama3-3-70b-instruct-v1:0")).toBe("converse");
    expect(bedrockModelFamily("mistral.pixtral-large-2502-v1:0")).toBe("converse");
  });
});

describe("resolveBedrockRegion", () => {
  it("prefers an explicit region, then the spec, then the environment", () => {
    const env = { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-west-2" };
    expect(
      resolveBedrockRegion({ region: "ap-southeast-2", spec: pinned("eu-central-1"), env }),
    ).toBe("ap-southeast-2");
    expect(resolveBedrockRegion({ spec: pinned("eu-central-1"), env })).toBe("eu-central-1");
    expect(resolveBedrockRegion({ spec: nova, env })).toBe("us-east-1");
    expect(resolveBedrockRegion({ spec: nova, env: { AWS_DEFAULT_REGION: "us-west-2" } })).toBe(
      "us-west-2",
    );
  });

  it("returns undefined when no region can be determined", () => {
    expect(resolveBedrockRegion({ spec: nova, env: {} })).toBeUndefined();
  });
});

describe("checkBedrockCredentials", () => {
  it("accepts ambient credentials as long as a region resolves", () => {
    const ctx = {
      spec: pinned("us-east-1"),
      apiKey: undefined,
      baseUrl: undefined,
      headers: undefined,
    };
    expect(checkBedrockCredentials(ctx, {})).toBeUndefined();
  });

  it("fails only when no region can be determined", () => {
    const ctx = { spec: nova, apiKey: undefined, baseUrl: undefined, headers: undefined };
    const failure = checkBedrockCredentials(ctx, {});
    expect(failure?.kind).toBe("invalidRequest");
    expect(failure?.message).toContain("AWS_REGION");
    expect(checkBedrockCredentials(ctx, { AWS_REGION: "us-east-1" })).toBeUndefined();
  });
});

describe("bedrockCacheKey", () => {
  it("separates regions and families so clients are never shared", () => {
    expect(bedrockCacheKey(pinned("us-east-1", { model: "amazon.nova-pro-v1:0" }))).not.toBe(
      bedrockCacheKey(pinned("eu-central-1", { model: "amazon.nova-pro-v1:0" })),
    );
    expect(bedrockCacheKey(pinned("us-east-1", { model: CLAUDE_ID }))).toContain("anthropic");
    expect(bedrockCacheKey(pinned("us-east-1", { model: "amazon.nova-pro-v1:0" }))).toContain(
      "converse",
    );
  });
});

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

describe("toConverseMessages", () => {
  it("maps text and base64 images, dropping blanks and unsupported types", () => {
    const result = toConverseMessages([
      userMessage("hello"),
      imageMessage("aGk=", "image/jpg"),
      { role: "user", content: [{ type: "text", text: "  " }], timestamp: 1 },
      imageMessage("aGk=", "image/tiff"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    const blocks = result[0]?.content ?? [];
    expect(blocks[0]).toEqual({ text: "hello" });
    expect(blocks[1]?.image?.format).toBe("jpeg");
    expect(Array.from(blocks[1]?.image?.source?.bytes ?? [])).toEqual([104, 105]);
    expect(blocks).toHaveLength(2);
  });

  it("maps assistant tool calls and signed or redacted reasoning, dropping unsigned", () => {
    const result = toConverseMessages([
      assistantMessage([
        { type: "thinking", thinking: "signed", signature: "sig" },
        { type: "thinking", thinking: "unsigned" },
        { type: "thinking", thinking: "", signature: `${REDACTED_THINKING_PREFIX}aGk=` },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
      ]),
    ]);
    const blocks = result[0]?.content ?? [];
    expect(blocks[0]).toEqual({
      reasoningContent: { reasoningText: { text: "signed", signature: "sig" } },
    });
    expect(Array.from(blocks[1]?.reasoningContent?.redactedContent ?? [])).toEqual([104, 105]);
    expect(blocks[2]).toEqual({ text: "answer" });
    expect(blocks[3]).toEqual({
      toolUse: { toolUseId: "t1", name: "read", input: { path: "a.ts" } },
    });
  });

  it("coalesces tool results into one user turn, ahead of other content", () => {
    const result = toConverseMessages([
      userMessage("run them"),
      assistantMessage([{ type: "toolCall", id: "a", name: "read", arguments: {} }]),
      toolResult("a", "read", "contents"),
      userMessage("and now this"),
      toolResult("b", "list", "failed", { isError: true }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[2]?.role).toBe("user");
    const blocks = result[2]?.content ?? [];
    expect(blocks.map((block) => (block.toolResult ? "toolResult" : "text"))).toEqual([
      "toolResult",
      "toolResult",
      "text",
    ]);
    expect(blocks[0]?.toolResult).toMatchObject({
      toolUseId: "a",
      status: "success",
      content: [{ text: "contents" }],
    });
    expect(blocks[1]?.toolResult?.status).toBe("error");
  });

  it("substitutes placeholder text for an empty tool result", () => {
    const result = toConverseMessages([toolResult("a", "read", "")]);
    expect(result[0]?.content?.[0]?.toolResult?.content).toEqual([{ text: "(no tool output)" }]);
  });

  it("merges consecutive same-role turns and skips empty messages", () => {
    const result = toConverseMessages([
      userMessage("one"),
      userMessage("two"),
      assistantMessage([{ type: "text", text: "" }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toEqual([{ text: "one" }, { text: "two" }]);
  });
});

describe("toConverseSystem / toConverseToolConfig", () => {
  it("wraps a non-empty system prompt and omits an empty one", () => {
    expect(toConverseSystem("be brief")).toEqual([{ text: "be brief" }]);
    expect(toConverseSystem("")).toBeUndefined();
    expect(toConverseSystem(undefined)).toBeUndefined();
  });

  it("maps tool definitions onto toolSpec entries", () => {
    const config = toConverseToolConfig([
      { name: "read", description: "Read a file", parameters: { properties: {} } },
      { name: "bare", description: "", parameters: {} },
    ]);
    expect(config?.tools?.[0]).toEqual({
      toolSpec: {
        name: "read",
        description: "Read a file",
        inputSchema: { json: { properties: {}, type: "object" } },
      },
    });
    expect(config?.tools?.[1]?.toolSpec).not.toHaveProperty("description");
    expect(toConverseToolConfig([])).toBeUndefined();
    expect(toConverseToolConfig(undefined)).toBeUndefined();
  });
});

describe("buildConverseRequest", () => {
  it("carries the model, system, tools and clamped max tokens", () => {
    const input = buildConverseRequest({
      model: nova,
      system: "be brief",
      messages: [userMessage("hi")],
      tools: [{ name: "read", description: "d", parameters: {} }],
      maxOutputTokens: 999_999,
      temperature: 0.4,
    });
    expect(input.modelId).toBe("amazon.nova-pro-v1:0");
    expect(input.system).toEqual([{ text: "be brief" }]);
    expect(input.toolConfig?.tools).toHaveLength(1);
    expect(input.inferenceConfig).toEqual({ maxTokens: nova.maxOutputTokens, temperature: 0.4 });
  });

  it("enables reasoning and suppresses temperature when thinking is requested", () => {
    const input = buildConverseRequest({
      model: nova,
      messages: [userMessage("hi")],
      thinking: "medium",
      temperature: 0.9,
    });
    expect(input.additionalModelRequestFields).toEqual({
      reasoning_config: { type: "enabled", budget_tokens: 16_384 },
    });
    expect(input.inferenceConfig?.temperature).toBeUndefined();

    const noRoom = buildConverseRequest({
      model: modelSpec({ provider: "bedrock", maxOutputTokens: 1_500 }),
      messages: [userMessage("hi")],
      thinking: "high",
    });
    expect(noRoom.additionalModelRequestFields).toBeUndefined();
  });

  it("mirrors the adaptive thinking branch for a 5-generation Claude on Converse", () => {
    // Claude normally leaves Converse for the native Messages API, but a spec
    // can be pinned to it with providerOptions.family.
    const opus5 = modelSpec({
      provider: "bedrock",
      model: "global.anthropic.claude-opus-5",
      id: "bedrock/global.anthropic.claude-opus-5",
    });
    const input = buildConverseRequest({
      model: opus5,
      messages: [userMessage("hi")],
      thinking: "high",
    });
    expect(input.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(input.additionalModelRequestFields).not.toHaveProperty("reasoning_config");
  });

  it("keeps the reasoning budget for 4.5-generation Claude and non-Claude models", () => {
    const opus45 = modelSpec({
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      id: "bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0",
    });
    expect(
      buildConverseRequest({ model: opus45, messages: [userMessage("hi")], thinking: "low" })
        .additionalModelRequestFields,
    ).toEqual({ reasoning_config: { type: "enabled", budget_tokens: 4_096 } });
  });

  it("forwards providerOptions but keeps adapter-only keys off the wire", () => {
    const input = buildConverseRequest({
      model: nova,
      messages: [userMessage("hi")],
      providerOptions: { region: "eu-central-1", family: "converse", requestMetadata: { a: "b" } },
    });
    expect(input).not.toHaveProperty("region");
    expect(input).not.toHaveProperty("family");
    expect(input.requestMetadata).toEqual({ a: "b" });
  });
});

describe("mapConverseStopReason", () => {
  it("maps every documented value", () => {
    expect(mapConverseStopReason("end_turn")).toBe("endTurn");
    expect(mapConverseStopReason("stop_sequence")).toBe("endTurn");
    expect(mapConverseStopReason("tool_use")).toBe("toolCalls");
    expect(mapConverseStopReason("max_tokens")).toBe("maxTokens");
    expect(mapConverseStopReason("model_context_window_exceeded")).toBe("maxTokens");
    expect(mapConverseStopReason("content_filtered")).toBe("error");
    expect(mapConverseStopReason("guardrail_intervened")).toBe("error");
    expect(mapConverseStopReason("malformed_tool_use")).toBe("error");
    expect(mapConverseStopReason(undefined)).toBe("endTurn");
  });
});

describe("parseConverseUsage", () => {
  it("defaults every counter the model omitted", () => {
    expect(parseConverseUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(parseConverseUsage(undefined).inputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Converse streaming
// ---------------------------------------------------------------------------

describe("converse streaming", () => {
  it("assembles text and priced usage from the metadata event", async () => {
    const events = await streamOf([
      MESSAGE_START,
      textDelta(0, "Hello"),
      textDelta(0, " world"),
      blockStop(0),
      messageStop("end_turn"),
      metadata({ inputTokens: 10, outputTokens: 7, cacheReadInputTokens: 4 }),
    ]);
    expect(events[0]).toEqual({ type: "start", model: nova.id });
    expect(events.some((event) => event.type === "textStart")).toBe(true);
    expect(textOf(events)).toBe("Hello world");
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("endTurn");
    expect(end.message.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
    expect(end.message.usage.costUsd).toBeGreaterThan(0);
  });

  it("accumulates tool-call JSON across deltas", async () => {
    const events = await streamOf([
      MESSAGE_START,
      toolStart(0, "tooluse_1", "read"),
      toolDelta(0, '{"path":'),
      toolDelta(0, '"a.ts"}'),
      blockStop(0),
      messageStop("tool_use"),
      metadata({ inputTokens: 1, outputTokens: 2 }),
    ]);
    expect(events.find((event) => event.type === "toolCallStart")).toEqual({
      type: "toolCallStart",
      blockIndex: 0,
      id: "tooluse_1",
      name: "read",
    });
    expect(events.find((event) => event.type === "toolCallEnd")).toEqual({
      type: "toolCallEnd",
      blockIndex: 0,
      id: "tooluse_1",
      name: "read",
      arguments: { path: "a.ts" },
    });
    const end = terminal(events);
    expect(end.message.stopReason).toBe("toolCalls");
    expect(end.message.content).toEqual([
      { type: "toolCall", id: "tooluse_1", name: "read", arguments: { path: "a.ts" } },
    ]);
  });

  it("degrades malformed tool JSON to empty arguments", async () => {
    const events = await streamOf([
      MESSAGE_START,
      toolStart(0, "t", "x"),
      toolDelta(0, "!!not json!!"),
      blockStop(0),
      messageStop("tool_use"),
    ]);
    expect(events.find((event) => event.type === "toolCallEnd")).toMatchObject({ arguments: {} });
  });

  it("round-trips reasoning text with a chunked signature", async () => {
    const events = await streamOf([
      MESSAGE_START,
      reasoningDelta(0, { text: "step 1" }),
      reasoningDelta(0, { signature: "AB" }),
      reasoningDelta(0, { signature: "CD" }),
      blockStop(0),
      messageStop("end_turn"),
    ]);
    expect(events.some((event) => event.type === "thinkingStart")).toBe(true);
    expect(terminal(events).message.content).toEqual([
      { type: "thinking", thinking: "step 1", signature: "ABCD" },
    ]);
  });

  it("preserves redacted reasoning as an opaque base64 signature", async () => {
    const events = await streamOf([
      MESSAGE_START,
      reasoningDelta(0, { redactedContent: new Uint8Array([104, 105]) }),
      blockStop(0),
      messageStop("end_turn"),
    ]);
    expect(terminal(events).message.content).toEqual([
      { type: "thinking", thinking: "", signature: `${REDACTED_THINKING_PREFIX}aGk=` },
    ]);
  });

  it("surfaces a filtered response as stopReason error", async () => {
    const events = await streamOf([MESSAGE_START, messageStop("content_filtered")]);
    const end = terminal(events);
    expect(end.type).toBe("end");
    expect(end.message.stopReason).toBe("error");
    expect(end.message.errorMessage).toContain("content_filtered");
  });

  it("classifies an in-band throttling event as a rate limit", async () => {
    const events = await streamOf([
      MESSAGE_START,
      textDelta(0, "partial"),
      { throttlingException: { message: "Too many tokens" } },
    ]);
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("rateLimit");
    expect(last.message.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("classifies an in-band validation event as an invalid request", async () => {
    const events = await streamOf([
      MESSAGE_START,
      { validationException: { message: "bad input" } },
    ]);
    const last = terminal(events);
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error).toMatchObject({ kind: "invalidRequest", message: "bad input" });
  });

  it("reports a truncated stream as a retryable network error", async () => {
    const events = await streamOf([MESSAGE_START, textDelta(0, "part")]);
    const last = terminal(events);
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("network");
    expect(last.message.content).toEqual([{ type: "text", text: "part" }]);
  });

  it("reports a missing event-stream body as a network error", async () => {
    const client: BedrockRuntimeClientLike = {
      send: vi.fn(async () => ({ $metadata: {} })),
    };
    const events = await collect(
      createBedrockProvider({ converseClient: client, region: "us-east-1" }).stream({
        model: nova,
        messages: [userMessage("hi")],
      }),
    );
    const last = terminal(events);
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("network");
  });

  it("forwards the abort signal and ends as aborted", async () => {
    const controller = new AbortController();
    const client = fakeConverseClient([MESSAGE_START, messageStop("end_turn")]);
    await collect(
      createBedrockProvider({ converseClient: client, region: "us-east-1" }).stream({
        model: nova,
        messages: [userMessage("hi")],
        signal: controller.signal,
      }),
    );
    expect(client.abortSignal).toBe(controller.signal);

    const aborted = Object.assign(new Error("Request aborted"), { name: "AbortError" });
    const events = await collect(
      createBedrockProvider({
        converseClient: throwingConverseClient(aborted),
        region: "us-east-1",
      }).stream({ model: nova, messages: [userMessage("hi")], signal: controller.signal }),
    );
    const last = terminal(events);
    expect(last.type).toBe("end");
    expect(last.message.stopReason).toBe("aborted");
  });

  it("maps a thrown AWS exception onto an AIError", async () => {
    const failure = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
      $response: { headers: { "retry-after": "3" } },
    });
    const events = await collect(
      createBedrockProvider({
        converseClient: throwingConverseClient(failure),
        region: "us-east-1",
      }).stream({ model: nova, messages: [userMessage("hi")] }),
    );
    const last = terminal(events);
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error).toMatchObject({ kind: "rateLimit", status: 429, retryAfterMs: 3000 });
  });

  it("fails cleanly, not fatally, when no region can be resolved", async () => {
    const events = await collect(
      createBedrockProvider({ env: {} }).stream({ model: nova, messages: [userMessage("hi")] }),
    );
    const last = terminal(events);
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("invalidRequest");
    expect(last.error.message).toContain("AWS_REGION");
  });

  it("complete() returns the terminal message", async () => {
    const client = fakeConverseClient([
      MESSAGE_START,
      textDelta(0, "done"),
      blockStop(0),
      messageStop("end_turn"),
    ]);
    const message = await createBedrockProvider({
      converseClient: client,
      region: "us-east-1",
    }).complete({ model: nova, messages: [userMessage("hi")] });
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
  });
});

// ---------------------------------------------------------------------------
// Claude on Bedrock
// ---------------------------------------------------------------------------

describe("claude on bedrock", () => {
  const messageStart = {
    type: "message_start",
    message: { id: "msg_1", model: CLAUDE_ID, usage: { input_tokens: 10, output_tokens: 0 } },
  };
  const messageDelta = {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5 },
  };

  it("streams through the Messages API and never touches the Converse client", async () => {
    const anthropicClient = fakeAnthropicClient([
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi there" } },
      { type: "content_block_stop", index: 0 },
      messageDelta,
      { type: "message_stop" },
    ]);
    const converseClient = fakeConverseClient([]);
    const events = await collect(
      createBedrockProvider({ anthropicClient, converseClient, region: "us-east-1" }).stream({
        model: claude,
        system: "be brief",
        messages: [userMessage("hi")],
      }),
    );
    expect(textOf(events)).toBe("hi there");
    expect(terminal(events).message.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(converseClient.input).toBeUndefined();
    const params = anthropicClient.params as { model: string; system: unknown[] };
    expect(params.model).toBe(CLAUDE_ID);
    expect(params.system).toHaveLength(1);
  });

  it("strips adapter-only providerOptions before they reach the Messages payload", async () => {
    const anthropicClient = fakeAnthropicClient([messageStart, { type: "message_stop" }]);
    await collect(
      createBedrockProvider({ anthropicClient, region: "us-east-1" }).stream({
        model: claude,
        messages: [userMessage("hi")],
        providerOptions: { region: "eu-central-1", family: "anthropic", top_k: 40 },
      }),
    );
    const params = anthropicClient.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("region");
    expect(params).not.toHaveProperty("family");
    expect(params.top_k).toBe(40);
  });

  it("maps Messages API failures onto AIError kinds", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("access denied"), { name: "AccessDeniedException" });
        }),
      },
    } as unknown as AnthropicClientLike;
    const events = await collect(
      createBedrockProvider({ anthropicClient: client, region: "us-east-1" }).stream({
        model: claude,
        messages: [userMessage("hi")],
      }),
    );
    const last = terminal(events);
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("auth");
  });

  it("honours an explicit family override", async () => {
    const converseClient = fakeConverseClient([MESSAGE_START, messageStop("end_turn")]);
    await collect(
      createBedrockProvider({ converseClient, region: "us-east-1" }).stream({
        model: claude,
        messages: [userMessage("hi")],
        providerOptions: { family: "converse" },
      }),
    );
    expect(converseClient.input?.modelId).toBe(CLAUDE_ID);
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("toBedrockError", () => {
  const table: Array<[string, string]> = [
    ["ThrottlingException", "rateLimit"],
    ["ServiceQuotaExceededException", "rateLimit"],
    ["AccessDeniedException", "auth"],
    ["UnrecognizedClientException", "auth"],
    ["ExpiredTokenException", "auth"],
    ["CredentialsProviderError", "auth"],
    ["ValidationException", "invalidRequest"],
    ["ResourceNotFoundException", "invalidRequest"],
    ["InternalServerException", "overloaded"],
    ["ServiceUnavailableException", "overloaded"],
    ["ModelStreamErrorException", "network"],
    ["ModelTimeoutException", "network"],
    ["TimeoutError", "network"],
  ];

  it.each(table)("classifies %s", (name, kind) => {
    const error = Object.assign(new Error(`${name} happened`), { name });
    expect(toBedrockError(error).kind).toBe(kind);
  });

  it("reports aborts, whether by name or by signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(toBedrockError(new Error("boom"), controller.signal).kind).toBe("aborted");
    expect(toBedrockError(Object.assign(new Error("x"), { name: "AbortError" })).kind).toBe(
      "aborted",
    );
  });

  it("falls back to the HTTP status and retry-after header", () => {
    const error = Object.assign(new Error("nope"), {
      name: "SomethingNew",
      $metadata: { httpStatusCode: 503 },
      $response: { headers: { "retry-after": "5" } },
    });
    expect(toBedrockError(error)).toMatchObject({
      kind: "overloaded",
      status: 503,
      retryAfterMs: 5000,
    });
  });

  it("treats a server fault with no status as overloaded", () => {
    const error = Object.assign(new Error("upstream blew up"), {
      name: "MysteryException",
      $fault: "server",
    });
    expect(toBedrockError(error).kind).toBe("overloaded");
  });

  it("carries the AWS status onto throttling errors", () => {
    const error = Object.assign(new Error("slow down"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
    });
    expect(toBedrockError(error)).toMatchObject({ kind: "rateLimit", status: 429 });
  });
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe("bedrock catalog", () => {
  it("registers bare model ids and their inference-profile variants", () => {
    expect(getModel("bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0")?.provider).toBe("bedrock");
    expect(getModel(`bedrock/${CLAUDE_ID}`)?.model).toBe(CLAUDE_ID);
    expect(getModel("bedrock/eu.amazon.nova-pro-v1:0")?.displayName).toContain("eu");
    const pro = getModel("bedrock/amazon.nova-pro-v1:0");
    expect(pro?.contextWindow).toBe(300_000);
    expect(pro?.capabilities).toEqual({
      tools: true,
      vision: true,
      thinking: false,
      caching: false,
    });
  });

  it("builds ad-hoc specs for models the catalog does not ship", () => {
    const spec = bedrockModel("cohere.command-r-plus-v1:0", {
      displayName: "Command R+",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      cost: { input: 3, output: 15 },
      region: "eu-west-1",
    });
    expect(spec.id).toBe("bedrock/cohere.command-r-plus-v1:0");
    expect(spec.provider).toBe("bedrock");
    expect(spec.apiKeyEnv).toBe("AWS_BEARER_TOKEN_BEDROCK");
    expect(resolveBedrockRegion({ spec, env: {} })).toBe("eu-west-1");
    expect(bedrockModelFamily(spec.model)).toBe("converse");
  });

  it("derives inference-profile variants from a bare spec", () => {
    const base = bedrockModel("anthropic.claude-haiku-4-5-20251001-v1:0");
    const profile = bedrockInferenceProfile(base, "apac");
    expect(profile.model).toBe("apac.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(profile.id).toBe("bedrock/apac.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(bedrockModelFamily(profile.model)).toBe("anthropic");
  });
});
