/**
 * Adversarial review of Wave 2 (append-only history), provider side. Each test
 * names a defect found in review and was watched to fail before its fix.
 */

import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { AssistantMessage, Message } from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireModel } from "../catalog.js";
import { collect, terminal, userMessage } from "../test-helpers/fixtures.js";
import {
  type AnthropicClientLike,
  createAnthropicProvider,
  resetSystemMessageSupport,
} from "./anthropic.js";

const opus55 = () => requireModel("anthropic/claude-opus-5-5");

afterEach(() => resetSystemMessageSupport());

const transformations = [
  { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
];

const turnWithTransformations: unknown[] = [
  {
    type: "message_start",
    message: {
      id: "m",
      model: "claude-opus-5-5",
      usage: { input_tokens: 1 },
      input_transformations: transformations,
    },
  },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

const plainTurn = turnWithTransformations.slice(1);
plainTurn.unshift({
  type: "message_start",
  message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1 } },
});

/** Both surfaces; the first `failures` creates throw `error`. */
function client(events: unknown[], error: unknown, failures = 1) {
  const stream = () =>
    (async function* () {
      for (const event of events) yield event as RawMessageStreamEvent;
    })();
  let failed = 0;
  const respond = async () => {
    if (failed < failures) {
      failed++;
      throw error;
    }
    return stream();
  };
  const ga = vi.fn(async (_params: unknown) => respond());
  const beta = vi.fn(async (_params: unknown) => respond());
  return {
    client: {
      messages: { create: ga },
      beta: { messages: { create: beta } },
    } as unknown as AnthropicClientLike,
    ga,
    beta,
  };
}

function assistantWithThinking(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "t", signature: "sig-1" },
      { type: "text", text: "hello" },
    ],
    model: "claude-opus-5-5",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "endTurn",
    timestamp: 1,
  };
}

const history = (): Message[] => [userMessage("one"), assistantWithThinking(), userMessage("two")];

const bindingError = () =>
  Object.assign(
    new Error(
      "400 messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to " +
        "a different conversation. Remove the block, or set " +
        '`thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
    ),
    { status: 400 },
  );

describe("a thinking block bound to a different conversation (an enforced account, no thinkingBinding set)", () => {
  it("recovers once with drop_block instead of wedging the session, and reports what was dropped", async () => {
    const { client: c, ga, beta } = client(turnWithTransformations, bindingError());
    const provider = createAnthropicProvider({ client: c });
    const result = terminal(
      await collect(provider.stream({ model: opus55(), messages: history(), thinking: "high" })),
    );
    expect(result.type).toBe("end");
    expect(ga).toHaveBeenCalledTimes(1);
    expect(beta).toHaveBeenCalledTimes(1);
    expect(beta.mock.calls[0]?.[0]).toMatchObject({
      betas: ["thinking-binding-controls-2026-08-01"],
      thinking: { block_binding: { prefix_mismatch_behavior: "drop_block" } },
    });
    // The report lands on the message, so the loop says "bug in arcturn".
    if (result.type === "end") expect(result.message.inputTransformations).toEqual(transformations);
  });

  it("is sticky for the client: later requests ask for drop_block up front", async () => {
    const { client: c, ga, beta } = client(plainTurn, bindingError());
    const provider = createAnthropicProvider({ client: c });
    await collect(provider.stream({ model: opus55(), messages: history(), thinking: "high" }));
    await collect(provider.stream({ model: opus55(), messages: history(), thinking: "high" }));
    expect(ga).toHaveBeenCalledTimes(1); // only the failed first attempt
    expect(beta).toHaveBeenCalledTimes(2);
  });

  it("does not second-guess an explicit thinkingBinding of error", async () => {
    const { client: c, ga, beta } = client(plainTurn, bindingError());
    const provider = createAnthropicProvider({ client: c, thinkingBinding: "error" });
    const result = terminal(
      await collect(provider.stream({ model: opus55(), messages: history(), thinking: "high" })),
    );
    expect(result.type).toBe("error");
    expect(ga.mock.calls.length + beta.mock.calls.length).toBe(1);
  });

  it("strips the thinking and retries once where the endpoint has no beta surface", async () => {
    const { client: c, ga } = client(plainTurn, bindingError());
    const bare = { messages: c.messages } as unknown as AnthropicClientLike;
    const provider = createAnthropicProvider({ client: bare });
    const result = terminal(
      await collect(provider.stream({ model: opus55(), messages: history(), thinking: "high" })),
    );
    expect(result.type).toBe("end");
    expect(ga).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(ga.mock.calls[0]?.[0])).toContain("sig-1");
    expect(JSON.stringify(ga.mock.calls[1]?.[0])).not.toContain("sig-1");
  });
});

describe("server-tool blocks in history", () => {
  const searchTurn = (): AssistantMessage => ({
    role: "assistant",
    content: [
      {
        type: "serverTool",
        provider: "anthropic",
        block: {
          type: "server_tool_use",
          id: "srv1",
          name: "tool_search_tool_bm25",
          input: { query: "q" },
        },
      },
      {
        type: "serverTool",
        provider: "anthropic",
        block: {
          type: "tool_search_tool_result",
          tool_use_id: "srv1",
          content: { type: "tool_search_tool_search_result", tool_references: [] },
        },
      },
      { type: "text", text: "found nothing" },
    ],
    model: "claude-opus-5-5",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "endTurn",
    timestamp: 1,
  });

  it("are not replayed to a request that does not carry the search tool (a /model switch off the native path)", async () => {
    const { buildAnthropicRequest } = await import("./anthropic.js");
    const messages: Message[] = [userMessage("one"), searchTurn(), userMessage("two")];
    const tool = {
      name: "read",
      description: "read",
      parameters: { type: "object", properties: {} },
    };
    const plain = buildAnthropicRequest({ model: opus55(), messages, tools: [tool] });
    expect(JSON.stringify(plain.messages)).not.toContain("tool_search_tool");
    // The text of that turn survives.
    expect(JSON.stringify(plain.messages)).toContain("found nothing");
    // On the native path (a deferred tool in the set) the turn goes back whole.
    const native = buildAnthropicRequest({
      model: opus55(),
      messages,
      tools: [tool, { ...tool, name: "deploy", deferLoading: true }],
    });
    expect(JSON.stringify(native.messages)).toContain("tool_search_tool_result");
  });
});

describe("server-side tool-result clearing", () => {
  it("never clears the tools whose results are the state (exclude_tools), as local editing does not", async () => {
    const { client: c, beta } = client(plainTurn, undefined, 0);
    await collect(
      createAnthropicProvider({ client: c }).stream({
        model: opus55(),
        messages: [userMessage("hi")],
        contextManagement: { clearToolUses: true, protectTools: ["todo", "plan"] },
      }),
    );
    expect(beta.mock.calls[0]?.[0]).toMatchObject({
      context_management: {
        edits: [{ type: "clear_tool_uses_20250919", exclude_tools: ["todo", "plan"] }],
      },
    });
  });
});

describe("failover and server-side context management", () => {
  it("does not carry server compaction to a fallback link that cannot run it", async () => {
    const { streamFailover } = await import("../failover.js");
    const { createAIError } = await import("../errors.js");
    const seen: Array<LLMRequestLike> = [];
    type LLMRequestLike = { model: { id: string }; contextManagement?: unknown };
    const failing = {
      stream: () =>
        (async function* () {
          yield { type: "start", model: "a" } as const;
          yield {
            type: "error",
            error: createAIError("overloaded", "busy"),
            message: {
              role: "assistant",
              content: [],
              model: "a",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "error",
              timestamp: 0,
            },
          } as const;
        })(),
      complete: async () => {
        throw new Error("unused");
      },
    };
    const answering = {
      stream: (r: LLMRequestLike) => {
        seen.push(r);
        return (async function* () {
          yield { type: "start", model: "b" } as const;
          yield {
            type: "end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              model: "b",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "endTurn",
              timestamp: 0,
            },
          } as const;
        })();
      },
      complete: async () => {
        throw new Error("unused");
      },
    };
    const gpt = requireModel("openai/gpt-5");
    await collect(
      streamFailover(
        [
          { client: failing as never, model: opus55() },
          { client: answering as never, model: gpt },
        ],
        {
          model: opus55(),
          messages: [userMessage("hi")],
          contextManagement: { compact: true, clearToolUses: true },
        },
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model.id).toBe(gpt.id);
    expect(seen[0]?.contextManagement).toBeUndefined();
  });
});
