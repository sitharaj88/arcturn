/**
 * Wave 3 on the Anthropic adapter: native structured outputs
 * (`output_config.format`), `strict: true` tools within the request's strict
 * budget, `eager_input_streaming` only where it is safe, task budgets behind
 * their beta, the regex tool-search variant, and a malformed streamed input
 * flagged rather than silently repaired.
 */

import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { LLMRequest, StreamEvent, ToolDefinition } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { requireModel } from "../catalog.js";
import { ANTHROPIC_STRICT_LIMITS } from "../strict-schema.js";
import { collect, modelSpec, terminal, userMessage } from "../test-helpers/fixtures.js";
import {
  ANTHROPIC_TASK_BUDGET_BETA,
  type AnthropicClientLike,
  anthropicEventStream,
  buildAnthropicRequest,
  createAnthropicProvider,
} from "./anthropic.js";

const opus55 = () => requireModel("anthropic/claude-opus-5-5");
const sonnet5 = () => requireModel("anthropic/claude-sonnet-5");

const contractSchema = {
  type: "object",
  properties: {
    decision: { enum: ["SHIP", "HOLD"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "reasons"],
  additionalProperties: false,
};

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    ...extra,
  };
}

const plainTurn: unknown[] = [
  { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: {} } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

function dualClient(events: unknown[] = plainTurn) {
  const stream = () =>
    (async function* () {
      for (const event of events) yield event as RawMessageStreamEvent;
    })();
  const ga = vi.fn(async (_params: unknown) => stream());
  const beta = vi.fn(async (_params: unknown) => stream());
  const client = { messages: { create: ga }, beta: { messages: { create: beta } } };
  return { client: client as unknown as AnthropicClientLike, ga, beta };
}

async function drain(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of source) out.push(event);
  return out;
}

describe("native structured output", () => {
  it("sends output_config.format beside the effort, with no name", () => {
    const params = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("decide")],
      thinking: "high",
      responseFormat: { name: "verdict", schema: contractSchema },
    });
    expect(params.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema: contractSchema },
    });
    // Thinking stays on beside the format: the two are compatible.
    expect(params.thinking).toMatchObject({ type: "adaptive" });
    expect(params).not.toHaveProperty("output_format");
  });

  it("drops the format on a model or endpoint without structured outputs", () => {
    const old = modelSpec({ model: "claude-sonnet-4-20250514" });
    expect(
      buildAnthropicRequest({
        model: old,
        messages: [userMessage("x")],
        responseFormat: { name: "v", schema: contractSchema },
      }).output_config,
    ).toBeUndefined();
    const gateway = { ...opus55(), provider: "anthropic-compatible" };
    expect(
      buildAnthropicRequest({
        model: gateway,
        messages: [userMessage("x")],
        responseFormat: { name: "v", schema: contractSchema },
      }).output_config?.format,
    ).toBeUndefined();
    const declared = {
      ...gateway,
      capabilities: { ...gateway.capabilities, structuredOutput: true },
    };
    expect(
      buildAnthropicRequest({
        model: declared,
        messages: [userMessage("x")],
        responseFormat: { name: "v", schema: contractSchema },
      }).output_config?.format,
    ).toEqual({ type: "json_schema", schema: contractSchema });
  });
});

describe("strict tools", () => {
  it("passes strict through only for a tool that asked and whose schema fits", () => {
    const params = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("x")],
      tools: [
        tool("read", { strict: true }),
        tool("mcp__srv__thing"),
        {
          ...tool("bounded", { strict: true }),
          parameters: {
            type: "object",
            properties: { n: { type: "number", minimum: 1 } },
            required: ["n"],
            additionalProperties: false,
          },
        },
      ],
    });
    const byName = new Map((params.tools ?? []).map((t) => [(t as { name: string }).name, t]));
    expect(byName.get("read")).toMatchObject({ strict: true });
    expect(byName.get("mcp__srv__thing")).not.toHaveProperty("strict");
    // `minimum` is outside the strict grammar: sent, but not strict.
    expect(byName.get("bounded")).not.toHaveProperty("strict");
  });

  it("stops marking tools strict at the request's strict budget", () => {
    const many = Array.from({ length: ANTHROPIC_STRICT_LIMITS.strictTools + 3 }, (_, i) =>
      tool(`t${i}`, { strict: true }),
    );
    const params = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("x")],
      tools: many,
    });
    const strict = (params.tools ?? []).filter((t) => (t as { strict?: boolean }).strict === true);
    expect(strict).toHaveLength(ANTHROPIC_STRICT_LIMITS.strictTools);
  });

  it("demotes the same tools whatever order the list arrives in, so the prefix is stable", () => {
    const names = Array.from(
      { length: ANTHROPIC_STRICT_LIMITS.strictTools + 4 },
      (_, i) => `t${String(i).padStart(2, "0")}`,
    );
    const strictSet = (order: string[]): string[] => {
      const params = buildAnthropicRequest({
        model: opus55(),
        messages: [userMessage("x")],
        tools: order.map((name) => tool(name, { strict: true })),
      });
      return (params.tools ?? [])
        .filter((t) => (t as { strict?: boolean }).strict === true)
        .map((t) => (t as { name: string }).name)
        .sort();
    };
    const forward = strictSet(names);
    expect(strictSet([...names].reverse())).toEqual(forward);
    // A tool added later that sorts after the rest leaves the earlier ones alone.
    expect(strictSet([...names, "zz"])).toEqual(forward);
    // The ones kept are the first by name.
    expect(forward).toEqual(names.slice(0, ANTHROPIC_STRICT_LIMITS.strictTools));
  });

  it("is never sent to a model without the grammar", () => {
    const params = buildAnthropicRequest({
      model: modelSpec({ model: "claude-3-7-sonnet-20250219" }),
      messages: [userMessage("x")],
      tools: [tool("read", { strict: true })],
    });
    expect(params.tools?.[0]).not.toHaveProperty("strict");
  });
});

describe("eager input streaming", () => {
  const tools = [tool("write", { eagerInputStreaming: true }), tool("read")];

  it("rides only on the tools that asked, and only to the first-party API", () => {
    const firstParty = buildAnthropicRequest(
      { model: opus55(), messages: [userMessage("x")], tools },
      { firstParty: true },
    );
    expect(firstParty.tools?.[0]).toMatchObject({ eager_input_streaming: true });
    expect(firstParty.tools?.[1]).not.toHaveProperty("eager_input_streaming");
    // Bedrock and Vertex build without `firstParty`; so does a proxy.
    const elsewhere = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("x")],
      tools,
    });
    for (const sent of elsewhere.tools ?? [])
      expect(sent).not.toHaveProperty("eager_input_streaming");
  });

  it("goes without strict on a tool that streams eagerly, keeps it elsewhere", () => {
    const both = buildAnthropicRequest(
      {
        model: opus55(),
        messages: [userMessage("x")],
        tools: [tool("write", { eagerInputStreaming: true, strict: true })],
      },
      { firstParty: true },
    );
    expect(both.tools?.[0]).toMatchObject({ eager_input_streaming: true });
    expect(both.tools?.[0]).not.toHaveProperty("strict");
    // Off the first-party API there is no eager streaming, so strict applies.
    const vertex = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("x")],
      tools: [tool("write", { eagerInputStreaming: true, strict: true })],
    });
    expect(vertex.tools?.[0]).toMatchObject({ strict: true });
  });

  it("is off when the provider points at a custom base URL", async () => {
    const direct = dualClient();
    await collect(
      createAnthropicProvider({ client: direct.client }).stream({
        model: opus55(),
        messages: [userMessage("x")],
        tools,
      }),
    );
    const sent = direct.ga.mock.calls[0]?.[0] as { tools: Array<Record<string, unknown>> };
    expect(sent.tools[0]).toMatchObject({ eager_input_streaming: true });

    const proxied = dualClient();
    await collect(
      createAnthropicProvider({
        client: proxied.client,
        baseUrl: "https://gateway.example",
      }).stream({ model: opus55(), messages: [userMessage("x")], tools }),
    );
    const viaProxy = proxied.ga.mock.calls[0]?.[0] as { tools: Array<Record<string, unknown>> };
    expect(viaProxy.tools[0]).not.toHaveProperty("eager_input_streaming");
  });
});

describe("malformed streamed input", () => {
  function toolTurn(json: string, stop: string): unknown[] {
    return [
      { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: {} } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "write", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: json },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
  }

  it("flags input that was not valid JSON instead of silently repairing it", async () => {
    // An unescaped inner quote: the tolerant parser recovers *something*.
    const raw = '{"path":"a.txt","content":"he said "hi" ok"}';
    const { client } = dualClient(toolTurn(raw, "tool_use"));
    const events = await collect(
      createAnthropicProvider({ client }).stream({ model: opus55(), messages: [userMessage("x")] }),
    );
    const end = events.find(
      (event): event is Extract<StreamEvent, { type: "toolCallEnd" }> =>
        event.type === "toolCallEnd",
    );
    expect(end?.malformedArguments).toBe(raw);
    const call = terminal(events).message.content.find((block) => block.type === "toolCall");
    expect(call).toMatchObject({ type: "toolCall", malformedArguments: raw });
  });

  it("carries no flag for valid input", async () => {
    const { client } = dualClient(toolTurn('{"path":"a.txt","content":"ok"}', "tool_use"));
    const events = await collect(
      createAnthropicProvider({ client }).stream({ model: opus55(), messages: [userMessage("x")] }),
    );
    const call = terminal(events).message.content.find((block) => block.type === "toolCall");
    expect(call).toEqual({
      type: "toolCall",
      id: "toolu_1",
      name: "write",
      arguments: { path: "a.txt", content: "ok" },
    });
  });

  it("flags an input cut off at max_tokens and keeps the stop reason", async () => {
    const { client } = dualClient(toolTurn('{"path":"a.txt","content":"half a fi', "max_tokens"));
    const events = await collect(
      createAnthropicProvider({ client }).stream({ model: opus55(), messages: [userMessage("x")] }),
    );
    const message = terminal(events).message;
    expect(message.stopReason).toBe("maxTokens");
    expect(message.content[0]).toMatchObject({
      malformedArguments: '{"path":"a.txt","content":"half a fi',
    });
  });
});

describe("task budgets", () => {
  const request = (overrides: Partial<LLMRequest> = {}): LLMRequest => ({
    model: opus55(),
    messages: [userMessage("x")],
    taskBudget: { total: 50_000 },
    ...overrides,
  });

  it("sends the beta header and output_config.task_budget on the first-party API", async () => {
    const { client, beta, ga } = dualClient();
    await drain(anthropicEventStream(client, request(), { firstParty: true }));
    expect(ga).not.toHaveBeenCalled();
    const sent = beta.mock.calls[0]?.[0] as {
      betas: string[];
      output_config: Record<string, unknown>;
    };
    expect(sent.betas).toContain(ANTHROPIC_TASK_BUDGET_BETA);
    expect(sent.output_config.task_budget).toEqual({ type: "tokens", total: 50_000 });
  });

  it("passes remaining only when the request carries one", async () => {
    const { client, beta } = dualClient();
    await drain(
      anthropicEventStream(client, request({ taskBudget: { total: 50_000, remaining: 31_000 } }), {
        firstParty: true,
      }),
    );
    const sent = beta.mock.calls[0]?.[0] as { output_config: Record<string, unknown> };
    expect(sent.output_config.task_budget).toEqual({
      type: "tokens",
      total: 50_000,
      remaining: 31_000,
    });
  });

  it("is not sent to Sonnet 5, nor off the first-party API", async () => {
    for (const [req, options] of [
      [request({ model: sonnet5() }), { firstParty: true }],
      [request(), {}],
    ] as const) {
      const { client, ga, beta } = dualClient();
      await drain(anthropicEventStream(client, req, options));
      expect(beta).not.toHaveBeenCalled();
      const sent = ga.mock.calls[0]?.[0] as { output_config?: Record<string, unknown> };
      expect(sent.output_config?.task_budget).toBeUndefined();
    }
  });
});

describe("tool search variant", () => {
  it("sends the regex tool when configured, BM25 otherwise", () => {
    const tools = [tool("read"), tool("rare", { deferLoading: true })];
    const bm25 = buildAnthropicRequest({ model: opus55(), messages: [userMessage("x")], tools });
    expect(bm25.tools?.at(-1)).toMatchObject({ type: "tool_search_tool_bm25_20251119" });
    const regex = buildAnthropicRequest(
      { model: opus55(), messages: [userMessage("x")], tools },
      { toolSearch: "regex" },
    );
    expect(regex.tools?.at(-1)).toMatchObject({
      type: "tool_search_tool_regex_20251119",
      name: "tool_search_tool_regex",
    });
  });

  it("is chosen by the provider option, end to end", async () => {
    const { client, ga } = dualClient();
    await collect(
      createAnthropicProvider({ client, toolSearch: "regex" }).stream({
        model: opus55(),
        messages: [userMessage("x")],
        tools: [tool("read"), tool("rare", { deferLoading: true })],
      }),
    );
    const sent = ga.mock.calls[0]?.[0] as { tools: Array<Record<string, unknown>> };
    expect(sent.tools.at(-1)).toMatchObject({ type: "tool_search_tool_regex_20251119" });
  });

  it("still indexes a deferred tool's full description and schema", () => {
    const rare = tool("rare", { deferLoading: true, description: "Rolls back a deploy." });
    const params = buildAnthropicRequest(
      { model: opus55(), messages: [userMessage("x")], tools: [tool("read"), rare] },
      { toolSearch: "regex" },
    );
    expect(params.tools?.[1]).toEqual({
      name: "rare",
      description: "Rolls back a deploy.",
      input_schema: rare.parameters,
      defer_loading: true,
    });
  });

  it("replays a paused regex search verbatim, its trailing server_tool_use last", () => {
    const search = {
      type: "server_tool_use",
      id: "srv1",
      name: "tool_search_tool_regex",
      input: { pattern: "roll" },
    };
    const params = buildAnthropicRequest(
      {
        model: opus55(),
        messages: [
          userMessage("roll back"),
          {
            role: "assistant",
            content: [{ type: "serverTool", provider: "anthropic", block: search }],
            model: "anthropic/claude-opus-5-5",
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "pauseTurn",
            timestamp: 1,
          },
        ],
        tools: [tool("read"), tool("rare", { deferLoading: true })],
      },
      { toolSearch: "regex" },
    );
    // The continuation is the paused turn sent back as-is: no user turn after it.
    expect(params.messages.at(-1)).toEqual({ role: "assistant", content: [search] });
  });
});
