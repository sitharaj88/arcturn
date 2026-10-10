/**
 * The advisor tool on the Anthropic adapter (beta `advisor-tool-2026-03-01`):
 * sent only for a pairing the API accepts and only on the first-party beta
 * surface, its blocks replayed verbatim while the tool rides along, and the
 * advisor's own tokens — reported in `usage.iterations` — billed at the
 * advisor's rate on top of the executor's.
 */

import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { AssistantMessage, LLMRequest, ModelSpec } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { requireModel } from "../catalog.js";
import { addUsage } from "../cost.js";
import { collect, terminal, userMessage } from "../test-helpers/fixtures.js";
import {
  ANTHROPIC_ADVISOR_BETA,
  type AnthropicClientLike,
  anthropicAdvisorPairValid,
  anthropicAdvisorsFor,
  anthropicEventStream,
  buildAnthropicRequest,
  createAnthropicProvider,
} from "./anthropic.js";

const sonnet55 = () => requireModel("anthropic/claude-sonnet-5-5");
const opus55 = () => requireModel("anthropic/claude-opus-5-5");

const plainTurn: unknown[] = [
  { type: "message_start", message: { id: "m", model: "claude-sonnet-5-5", usage: {} } },
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

async function drain(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of source) {
    // drain
  }
}

function request(model: ModelSpec, extra: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model,
    messages: [userMessage("plan the migration")],
    serverTools: [{ kind: "advisor", model: "claude-opus-5-5" }],
    ...extra,
  };
}

describe("the advisor pairing table", () => {
  it("accepts the pairs the API accepts, and nothing else", () => {
    expect(anthropicAdvisorPairValid("claude-sonnet-5-5", "claude-opus-5-5")).toBe(true);
    expect(anthropicAdvisorPairValid("claude-haiku-4-5", "claude-sonnet-4-6")).toBe(true);
    // Sonnet 5.5 rejects the 4.x Opus advisors and Sonnet 5.
    expect(anthropicAdvisorPairValid("claude-sonnet-5-5", "claude-opus-4-8")).toBe(false);
    expect(anthropicAdvisorPairValid("claude-sonnet-5-5", "claude-sonnet-5")).toBe(false);
    // An advisor weaker than its executor.
    expect(anthropicAdvisorPairValid("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false);
    // Ids the table does not know.
    expect(anthropicAdvisorPairValid("gpt-5", "claude-opus-5-5")).toBe(false);
    // A dated or prefixed id names the same model.
    expect(anthropicAdvisorPairValid("claude-haiku-4-5-20251001", "claude-opus-5-5")).toBe(true);
  });

  it("lists an executor's valid advisors for a config warning", () => {
    expect(anthropicAdvisorsFor("claude-fable-5-1")).toEqual([
      "claude-mythos-5-1",
      "claude-fable-5-1",
    ]);
    expect(anthropicAdvisorsFor("claude-3-opus")).toEqual([]);
  });
});

describe("sending the advisor tool", () => {
  it("goes out on the beta surface beside its header, for a valid first-party pair", async () => {
    const { client, ga, beta } = dualClient();
    await drain(anthropicEventStream(client, request(sonnet55()), { firstParty: true }));
    expect(ga).not.toHaveBeenCalled();
    const sent = beta.mock.calls[0]?.[0] as { betas: string[]; tools: unknown[] };
    expect(sent.betas).toContain(ANTHROPIC_ADVISOR_BETA);
    expect(sent.tools).toEqual([
      {
        type: "advisor_20260301",
        name: "advisor",
        model: "claude-opus-5-5",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("is never sent for an invalid pair, off the first-party API, or without a beta surface", async () => {
    const cases: Array<[AnthropicClientLike, LLMRequest, { firstParty?: boolean }]> = [];
    const invalid = dualClient();
    cases.push([
      invalid.client,
      request(sonnet55(), { serverTools: [{ kind: "advisor", model: "claude-opus-4-8" }] }),
      { firstParty: true },
    ]);
    const proxy = dualClient();
    cases.push([proxy.client, request(sonnet55()), {}]);
    const create = vi.fn(async (_params: unknown) =>
      (async function* () {
        for (const event of plainTurn) yield event as RawMessageStreamEvent;
      })(),
    );
    const noBeta = { messages: { create } } as unknown as AnthropicClientLike;
    cases.push([noBeta, request(sonnet55()), { firstParty: true }]);
    for (const [client, req, options] of cases)
      await drain(anthropicEventStream(client, req, options));
    for (const call of [
      ...invalid.ga.mock.calls,
      ...invalid.beta.mock.calls,
      ...proxy.ga.mock.calls,
      ...proxy.beta.mock.calls,
      ...create.mock.calls,
    ]) {
      const sent = call[0] as { tools?: unknown[]; betas?: string[] };
      expect(sent.tools).toBeUndefined();
      expect(sent.betas ?? []).not.toContain(ANTHROPIC_ADVISOR_BETA);
    }
    expect(invalid.beta).not.toHaveBeenCalled();
    expect(proxy.beta).not.toHaveBeenCalled();
  });
});

const advisorUse = { type: "server_tool_use", id: "srvtoolu_a", name: "advisor", input: {} };
const advisorResult = {
  type: "advisor_tool_result",
  tool_use_id: "srvtoolu_a",
  content: {
    type: "advisor_redacted_result",
    encrypted_content: "opaque",
    stop_reason: "end_turn",
  },
};

describe("replaying the advisor's blocks", () => {
  const history: LLMRequest["messages"] = [
    userMessage("plan"),
    {
      role: "assistant",
      content: [
        { type: "serverTool", provider: "anthropic", block: advisorUse },
        { type: "serverTool", provider: "anthropic", block: advisorResult },
        { type: "text", text: "Plan ready." },
      ],
      model: "anthropic/claude-sonnet-5-5",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 2,
    },
    userMessage("go"),
  ];

  it("replays them verbatim while the tool rides along", () => {
    const params = buildAnthropicRequest(request(sonnet55(), { messages: history }), {
      firstParty: true,
      advisor: true,
    });
    expect(params.messages[1]?.content).toEqual([
      advisorUse,
      advisorResult,
      { type: "text", text: "Plan ready." },
    ]);
  });

  it("drops them together when it does not", () => {
    const params = buildAnthropicRequest(request(sonnet55(), { messages: history }), {
      firstParty: true,
    });
    expect(params.messages[1]?.content).toEqual([{ type: "text", text: "Plan ready." }]);
  });
});

describe("billing the advisor", () => {
  const advisedTurn: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "m",
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 1_000, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { ...advisorUse } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: advisorResult },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        output_tokens: 500,
        iterations: [
          {
            type: "message",
            model: "claude-sonnet-5-5",
            input_tokens: 600,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            type: "advisor_message",
            model: "claude-opus-5-5",
            input_tokens: 2_000,
            output_tokens: 300,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 0,
          },
          {
            type: "message",
            model: "claude-sonnet-5-5",
            input_tokens: 400,
            output_tokens: 400,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    },
    { type: "message_stop" },
  ];

  it("prices the advisor's iterations at its own rate and adds them to the message's cost", async () => {
    const { client } = dualClient(advisedTurn);
    const message = terminal(
      await collect(createAnthropicProvider({ client }).stream(request(sonnet55()))),
    ).message as AssistantMessage;
    // Executor: 1,000 in × $2 + 500 out × $10 per MTok = $0.007.
    // Advisor (Opus 5.5): 2,000 in × $4 + 300 out × $20 + 1,000 cached × $0.20 = $0.0142.
    const opus = opus55().cost!;
    const advisorCost =
      (2_000 * opus.input + 300 * opus.output + 1_000 * (opus.cacheRead ?? 0)) / 1e6;
    expect(message.usage.advisor).toEqual([
      {
        model: "anthropic/claude-opus-5-5",
        inputTokens: 2_000,
        outputTokens: 300,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        costUsd: expect.closeTo(advisorCost, 9),
      },
    ]);
    // The top-level counts stay the executor's own.
    expect(message.usage.inputTokens).toBe(1_000);
    expect(message.usage.outputTokens).toBe(500);
    const sonnet = sonnet55().cost!;
    expect(message.usage.costUsd).toBeCloseTo(
      (1_000 * sonnet.input + 500 * sonnet.output) / 1e6 + advisorCost,
      9,
    );
  });

  it("adds up across turns, per advisor model", () => {
    const one = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1,
      advisor: [
        {
          model: "anthropic/claude-opus-5-5",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.5,
        },
      ],
    };
    const sum = addUsage(addUsage(one, one), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(sum.advisor).toEqual([
      {
        model: "anthropic/claude-opus-5-5",
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 1,
      },
    ]);
    expect(sum.costUsd).toBe(2);
  });
});
