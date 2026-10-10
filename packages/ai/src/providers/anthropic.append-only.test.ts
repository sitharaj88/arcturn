/**
 * The Anthropic adapter's half of append-only history: mid-conversation
 * system messages and their fold, the thinking-binding controls and their
 * `input_transformations` report, native tool search with `defer_loading`,
 * and server-side compaction / tool-result clearing.
 */

import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type {
  AssistantMessage,
  LLMRequest,
  Message,
  StreamEvent,
  SystemMessage,
} from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireModel } from "../catalog.js";
import { collect, terminal, toolResult, userMessage } from "../test-helpers/fixtures.js";
import {
  type AnthropicClientLike,
  anthropicSystemMessages,
  buildAnthropicRequest,
  createAnthropicProvider,
  resetSystemMessageSupport,
  toAnthropicMessages,
} from "./anthropic.js";

const opus55 = () => requireModel("anthropic/claude-opus-5-5");
const sonnet5 = () => requireModel("anthropic/claude-sonnet-5");

afterEach(() => resetSystemMessageSupport());

function system(text: string): SystemMessage {
  return { role: "system", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: "claude-opus-5-5",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolCalls" : "endTurn",
    timestamp: 1,
  };
}

const plainTurn: unknown[] = [
  {
    type: "message_start",
    message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1 } },
  },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

/** A client with both surfaces; `failFirst` makes the first create throw. */
function dualClient(events: unknown[], failFirst?: unknown) {
  const stream = () =>
    (async function* () {
      for (const event of events) yield event as RawMessageStreamEvent;
    })();
  let failed = false;
  const respond = async () => {
    if (failFirst !== undefined && !failed) {
      failed = true;
      throw failFirst;
    }
    return stream();
  };
  const ga = vi.fn(async (_params: unknown) => respond());
  const beta = vi.fn(async (_params: unknown) => respond());
  const client = { messages: { create: ga }, beta: { messages: { create: beta } } };
  return { client: client as unknown as AnthropicClientLike, ga, beta };
}

describe("mid-conversation system messages", () => {
  it("render as role:system on Opus 5.5 and fold into the user turn on Sonnet 5", () => {
    const history: Message[] = [userMessage("hi"), system("Turn budget: 2 left.")];
    expect(anthropicSystemMessages(opus55())).toBe(true);
    expect(anthropicSystemMessages(sonnet5())).toBe(false);

    const native = buildAnthropicRequest({ model: opus55(), messages: history }).messages;
    expect(native.map((message) => message.role)).toEqual(["user", "system"]);
    expect(native[1]?.content).toEqual([{ type: "text", text: "Turn budget: 2 left." }]);

    const folded = buildAnthropicRequest({ model: sonnet5(), messages: history }).messages;
    expect(folded.map((message) => message.role)).toEqual(["user"]);
    expect(JSON.stringify(folded[0]?.content)).toContain(
      "<system-reminder>\\nTurn budget: 2 left.\\n</system-reminder>",
    );
  });

  it("folds where the API forbids one: first, after an assistant turn, or before a user turn", () => {
    const options = { systemMessages: true };
    // messages[0]
    expect(
      toAnthropicMessages([system("a"), userMessage("u")], options).map((m) => m.role),
    ).toEqual(["user"]);
    // after an assistant turn
    expect(
      toAnthropicMessages(
        [userMessage("u"), assistant([{ type: "text", text: "x" }]), system("b")],
        options,
      ).map((m) => m.role),
    ).toEqual(["user", "assistant", "user"]);
    // followed by a user turn
    expect(
      toAnthropicMessages([userMessage("u"), system("c"), userMessage("v")], options).map(
        (m) => m.role,
      ),
    ).toEqual(["user"]);
    // adjacent ones merge into one system message
    const merged = toAnthropicMessages([userMessage("u"), system("d"), system("e")], options);
    expect(merged.map((m) => m.role)).toEqual(["user", "system"]);
    expect(merged[1]?.content).toHaveLength(2);
  });

  it("keeps the same bytes once the model answers after it", () => {
    // Sent last as role:system, then followed by the model's reply: still a
    // system message, so the next request extends the previous one.
    const first = toAnthropicMessages(
      [toolCallTurn(), toolResult("t1", "read", "ok"), system("note")],
      {
        systemMessages: true,
      },
    );
    const second = toAnthropicMessages(
      [
        toolCallTurn(),
        toolResult("t1", "read", "ok"),
        system("note"),
        assistant([{ type: "text", text: "next" }]),
      ],
      { systemMessages: true },
    );
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
  });

  it("retries once with the fold after the 400, and folds from then on", async () => {
    const refusal = Object.assign(new Error("role 'system' is not supported on this model"), {
      status: 400,
    });
    const { client, ga } = dualClient(plainTurn, refusal);
    const provider = createAnthropicProvider({ client });
    const request: LLMRequest = {
      model: opus55(),
      messages: [userMessage("hi"), system("operator note")],
    };
    const first = terminal(await collect(provider.stream(request)));
    expect(first.type).toBe("end");
    expect(ga).toHaveBeenCalledTimes(2);
    const roles = (call: number) =>
      (
        (ga.mock.calls[call]?.[0] as { messages?: Array<{ role: string }> } | undefined)
          ?.messages ?? []
      ).map((message) => message.role);
    expect(roles(0)).toEqual(["user", "system"]);
    expect(roles(1)).toEqual(["user"]);
    // The verdict sticks: the next request folds without asking again.
    await collect(provider.stream(request));
    expect(ga).toHaveBeenCalledTimes(3);
    expect(roles(2)).toEqual(["user"]);
    expect(anthropicSystemMessages(opus55())).toBe(false);
  });

  it("does not retry other 400s", async () => {
    const other = Object.assign(new Error("messages.1: something else"), { status: 400 });
    const { client, ga } = dualClient(plainTurn, other);
    const events = await collect(
      createAnthropicProvider({ client }).stream({
        model: opus55(),
        messages: [userMessage("hi"), system("note")],
      }),
    );
    expect(terminal(events).type).toBe("error");
    expect(ga).toHaveBeenCalledTimes(1);
  });
});

function toolCallTurn(): AssistantMessage {
  return assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }]);
}

describe("thinking-binding controls", () => {
  const transformations = [
    { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
  ];

  it("sends the beta header and block_binding, and lands input_transformations on the message", async () => {
    const events: unknown[] = [
      {
        type: "message_start",
        message: {
          id: "m",
          model: "claude-opus-5-5",
          usage: { input_tokens: 1 },
          input_transformations: transformations,
        },
      },
      ...plainTurn.slice(1),
    ];
    const { client, beta, ga } = dualClient(events);
    const provider = createAnthropicProvider({ client, thinkingBinding: "drop_block" });
    const result = terminal(
      await collect(
        provider.stream({ model: opus55(), messages: [userMessage("hi")], thinking: "high" }),
      ),
    );
    expect(ga).not.toHaveBeenCalled();
    expect(beta.mock.calls[0]?.[0]).toMatchObject({
      betas: ["thinking-binding-controls-2026-08-01"],
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    });
    expect(result.message.inputTransformations).toEqual(transformations);
  });

  it("binds even where 'off' leaves thinking out, but never next to between_tools", () => {
    const fable = buildAnthropicRequest(
      { model: requireModel("anthropic/claude-fable-5-1"), messages: [userMessage("hi")] },
      { thinkingBinding: "error" },
    );
    expect(fable.thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "error" },
    });
    const sonnet55 = buildAnthropicRequest(
      { model: requireModel("anthropic/claude-sonnet-5-5"), messages: [userMessage("hi")] },
      { thinkingBinding: "error" },
    );
    expect(sonnet55.thinking).toEqual({ type: "between_tools" });
  });

  it("records nothing when the provider reports an empty list", async () => {
    const events: unknown[] = [
      {
        type: "message_start",
        message: { id: "m", model: "x", usage: { input_tokens: 1 }, input_transformations: [] },
      },
      ...plainTurn.slice(1),
    ];
    const { client } = dualClient(events);
    const result = terminal(
      await collect(
        createAnthropicProvider({ client, thinkingBinding: "error" }).stream({
          model: opus55(),
          messages: [userMessage("hi")],
        }),
      ),
    );
    expect(result.message.inputTransformations).toBeUndefined();
  });
});

describe("native tool search", () => {
  const tools = [
    { name: "read", description: "Read.", parameters: { type: "object" } },
    { name: "deploy", description: "Deploy.", parameters: { type: "object" }, deferLoading: true },
  ];

  it("sends deferred tools with defer_loading beside the BM25 search tool", () => {
    const params = buildAnthropicRequest({ model: opus55(), messages: [userMessage("hi")], tools });
    expect(params.tools?.map((tool) => [tool.name, "defer_loading" in tool])).toEqual([
      ["read", false],
      ["deploy", true],
      ["tool_search_tool_bm25", false],
    ]);
    expect(params.tools?.at(-1)).toMatchObject({ type: "tool_search_tool_bm25_20251119" });
  });

  it("never defers every tool", () => {
    const params = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("hi")],
      tools: tools.map((tool) => ({ ...tool, deferLoading: true })),
    });
    expect(
      params.tools?.filter((tool) => !("defer_loading" in tool)).map((tool) => tool.name),
    ).toEqual(["read", "tool_search_tool_bm25"]);
  });

  it("carries the server's blocks into the message and replays them verbatim", async () => {
    const serverUse = {
      type: "server_tool_use",
      id: "srv1",
      name: "tool_search_tool_bm25",
      input: {},
    };
    const searchResult = {
      type: "tool_search_tool_result",
      tool_use_id: "srv1",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [{ type: "tool_reference", tool_name: "deploy" }],
      },
    };
    const events: unknown[] = [
      plainTurn[0],
      { type: "content_block_start", index: 0, content_block: serverUse },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"deploy"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: searchResult },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "d1", name: "deploy", input: {} },
      },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const { client } = dualClient(events);
    const result = terminal(
      await collect(
        createAnthropicProvider({ client }).stream({
          model: opus55(),
          messages: [userMessage("ship")],
          tools,
        }),
      ),
    );
    const message = result.message;
    expect(message.content.map((block) => block.type)).toEqual([
      "serverTool",
      "serverTool",
      "toolCall",
    ]);
    expect(message.content[0]).toEqual({
      type: "serverTool",
      provider: "anthropic",
      block: { ...serverUse, input: { query: "deploy" } },
    });

    const next = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("ship"), message, toolResult("d1", "deploy", "deployed")],
      tools,
    });
    expect(next.messages[1]?.content).toEqual([
      { ...serverUse, input: { query: "deploy" } },
      searchResult,
      { type: "tool_use", id: "d1", name: "deploy", input: {} },
    ]);
  });
});

describe("server-side context management", () => {
  it("asks for compaction and tool-result clearing under their betas", async () => {
    const { client, beta } = dualClient(plainTurn);
    await collect(
      createAnthropicProvider({ client }).stream({
        model: opus55(),
        messages: [userMessage("hi")],
        contextManagement: { compact: true, clearToolUses: true },
      }),
    );
    expect(beta.mock.calls[0]?.[0]).toMatchObject({
      betas: ["compact-2026-01-12", "context-management-2025-06-27"],
      context_management: {
        edits: [{ type: "clear_tool_uses_20250919" }, { type: "compact_20260112" }],
      },
    });
  });

  it("streams a compaction block into the message and replays it byte for byte", async () => {
    const events: unknown[] = [
      plainTurn[0],
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "compaction", content: null, encrypted_content: null },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "compaction_delta", content: "summary so far", encrypted_content: "enc==" },
      },
      { type: "content_block_stop", index: 0 },
      ...plainTurn.slice(1),
    ];
    const { client } = dualClient(events);
    const result = terminal(
      await collect(
        createAnthropicProvider({ client }).stream({
          model: opus55(),
          messages: [userMessage("hi")],
          contextManagement: { compact: true },
        }),
      ),
    );
    expect(result.message.content).toEqual([
      { type: "compaction", summary: "summary so far", encryptedContent: "enc==" },
    ]);
    const next = buildAnthropicRequest({
      model: opus55(),
      messages: [userMessage("hi"), result.message, userMessage("more")],
    });
    expect(next.messages[1]?.content).toEqual([
      { type: "compaction", content: "summary so far", encrypted_content: "enc==" },
    ]);
  });

  it("keeps the compaction beta on while the history carries a compaction block", async () => {
    const { client, beta } = dualClient(plainTurn);
    await collect(
      createAnthropicProvider({ client }).stream({
        model: opus55(),
        messages: [
          userMessage("hi"),
          assistant([{ type: "compaction", summary: "s", encryptedContent: "e" }]),
          userMessage("more"),
        ],
      }),
    );
    expect(beta.mock.calls[0]?.[0]).toMatchObject({ betas: ["compact-2026-01-12"] });
  });

  it("refuses a client without a beta surface instead of sending the full history", async () => {
    const ga = vi.fn(async () => (async function* () {})());
    const client = { messages: { create: ga } } as unknown as AnthropicClientLike;
    const events: StreamEvent[] = await collect(
      createAnthropicProvider({ client }).stream({
        model: opus55(),
        messages: [userMessage("hi")],
        contextManagement: { compact: true },
      }),
    );
    const end = terminal(events);
    expect(end.type).toBe("error");
    expect(end.type === "error" ? end.error.message : "").toMatch(/Server-side context management/);
    expect(ga).not.toHaveBeenCalled();
  });
});
