/**
 * Provider-native web search and web fetch on the Anthropic adapter
 * (`LLMRequest.serverTools`): which variant goes to which model and platform,
 * the domain filter, the client tool it replaces, and the server's own blocks
 * replayed exactly when the request still carries the tool that made them.
 */

import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type {
  AssistantMessage,
  LLMRequest,
  ModelSpec,
  ServerToolRequest,
  ToolDefinition,
} from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { requireModel } from "../catalog.js";
import { collect, terminal, userMessage } from "../test-helpers/fixtures.js";
import {
  type AnthropicClientLike,
  anthropicWebTools,
  buildAnthropicRequest,
  createAnthropicProvider,
} from "./anthropic.js";

const opus55 = () => requireModel("anthropic/claude-opus-5-5");
const sonnet45 = () => requireModel("anthropic/claude-sonnet-4-5");
const vertexOpus = () => requireModel("vertex/claude-opus-5-5");

function bedrockOpus(): ModelSpec {
  return { ...opus55(), id: "bedrock/anthropic.claude-opus-5-5", provider: "bedrock" };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  };
}

const clientTools = [tool("read"), tool("websearch"), tool("fetch")];

const nativeWeb: ServerToolRequest[] = [
  { kind: "webSearch", maxUses: 5, blockedDomains: ["evil.example"], replaces: "websearch" },
  { kind: "webFetch", maxUses: 3, allowedDomains: ["docs.example"], replaces: "fetch" },
];

function request(model: ModelSpec, extra: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model,
    messages: [userMessage("look it up")],
    tools: clientTools,
    serverTools: nativeWeb,
    ...extra,
  };
}

function toolNames(params: { tools?: ReadonlyArray<{ name: string }> }): string[] {
  return (params.tools ?? []).map((entry) => entry.name);
}

describe("which native web tools a model gets", () => {
  it("sends the dynamic-filtering variants to Opus 5.5 on the first-party API", () => {
    const params = buildAnthropicRequest(request(opus55()), { firstParty: true });
    const wire = params.tools?.filter((entry) => entry.name.startsWith("web_"));
    expect(wire).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 5,
        blocked_domains: ["evil.example"],
      },
      {
        type: "web_fetch_20260209",
        name: "web_fetch",
        max_uses: 3,
        allowed_domains: ["docs.example"],
        // A breakpoint on the final tool caches the whole tool prefix.
        cache_control: { type: "ephemeral" },
      },
    ]);
    // The client tools they replace are not offered beside them, and the
    // dynamic variants run code execution themselves: never declared twice.
    expect(toolNames(params)).toEqual(["read", "web_search", "web_fetch"]);
    expect(params.tools?.some((entry) => "type" in entry && entry.type.startsWith("code_"))).toBe(
      false,
    );
  });

  it("sends the basic variants to a model older than the 4.6 generation", () => {
    const params = buildAnthropicRequest(request(sonnet45()), { firstParty: true });
    expect(
      params.tools
        ?.filter((entry) => entry.name.startsWith("web_"))
        .map((entry) => ("type" in entry ? entry.type : "")),
    ).toEqual(["web_search_20250305", "web_fetch_20250910"]);
  });

  it("sends only the basic search on Vertex, and keeps the client fetch", () => {
    const params = buildAnthropicRequest(request(vertexOpus()));
    expect(toolNames(params)).toEqual(["read", "fetch", "web_search"]);
    expect(params.tools?.at(-1)).toMatchObject({ type: "web_search_20250305" });
  });

  it("sends nothing native to Bedrock or a gateway, which keep the client tools", () => {
    for (const model of [bedrockOpus(), { ...opus55(), provider: "anthropic-compatible" }]) {
      const params = buildAnthropicRequest(request(model));
      expect(toolNames(params)).toEqual(["read", "websearch", "fetch"]);
    }
    // The first-party adapter at a custom base URL is a proxy: not assumed.
    expect(toolNames(buildAnthropicRequest(request(opus55())))).toEqual([
      "read",
      "websearch",
      "fetch",
    ]);
  });

  it("lets a gateway declare what it takes", () => {
    const gateway = {
      ...opus55(),
      provider: "anthropic-compatible",
      capabilities: { ...opus55().capabilities, webTools: "basicSearch" as const },
    };
    expect(anthropicWebTools(gateway, {})).toBe("basicSearch");
    expect(toolNames(buildAnthropicRequest(request(gateway)))).toEqual([
      "read",
      "fetch",
      "web_search",
    ]);
  });

  it("never sends both domain lists: the deny list wins", () => {
    const params = buildAnthropicRequest(
      request(opus55(), {
        serverTools: [
          { kind: "webSearch", allowedDomains: ["a.example"], blockedDomains: ["b.example"] },
        ],
      }),
      { firstParty: true },
    );
    const search = params.tools?.find((entry) => entry.name === "web_search");
    expect(search).toMatchObject({ blocked_domains: ["b.example"] });
    expect(search).not.toHaveProperty("allowed_domains");
  });

  it("sends the native tools even when the request has no client tools", () => {
    const params = buildAnthropicRequest(request(opus55(), { tools: [] }), { firstParty: true });
    expect(toolNames(params)).toEqual(["web_search", "web_fetch"]);
  });
});

const searchUse = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "arcturn release notes" },
};
const searchResult = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: [
    {
      type: "web_search_result",
      url: "https://docs.example/notes",
      title: "Release notes",
      encrypted_content: "enc-1",
      page_age: null,
    },
  ],
};
const searchError = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_2",
  content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
};
// A search the dynamic-filtering variant ran from inside its own code execution.
const filteredUse = {
  type: "server_tool_use",
  id: "srvtoolu_3",
  name: "web_search",
  input: { query: "x" },
  caller: { type: "code_execution_20260120", tool_id: "srvtoolu_0" },
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "endTurn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: "anthropic/claude-opus-5-5",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: 2,
  };
}

const served = (block: Record<string, unknown>) =>
  ({ type: "serverTool", provider: "anthropic", block }) as const;

describe("replaying the server's web blocks", () => {
  const history = [
    userMessage("look it up"),
    assistant([
      served(searchUse),
      served(searchResult),
      served(searchError),
      { type: "text", text: "Found it." },
    ]),
    userMessage("thanks"),
  ];

  it("replays them verbatim while the request carries the native search", () => {
    const params = buildAnthropicRequest(request(opus55(), { messages: history }), {
      firstParty: true,
    });
    expect(params.messages[1]).toEqual({
      role: "assistant",
      content: [searchUse, searchResult, searchError, { type: "text", text: "Found it." }],
    });
  });

  it("drops them, together, when the request does not carry it", () => {
    for (const params of [
      buildAnthropicRequest(request(opus55(), { messages: history, serverTools: [] }), {
        firstParty: true,
      }),
      buildAnthropicRequest(request(bedrockOpus(), { messages: history })),
    ]) {
      expect(params.messages[1]).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "Found it." }],
      });
    }
  });

  it("replays code-execution-driven blocks only to the dynamic variant", () => {
    const messages = [userMessage("q"), assistant([served(filteredUse), served(searchUse)])];
    const dynamic = buildAnthropicRequest(request(opus55(), { messages }), { firstParty: true });
    expect(dynamic.messages[1]?.content).toEqual([filteredUse, searchUse]);
    const basic = buildAnthropicRequest(request(vertexOpus(), { messages }));
    expect(basic.messages[1]?.content).toEqual([searchUse]);
  });
});

function streamingClient(turns: unknown[][]) {
  let call = 0;
  const create = vi.fn(async (_params: unknown) => {
    const events = turns[Math.min(call++, turns.length - 1)] ?? [];
    return (async function* () {
      for (const event of events) yield event as RawMessageStreamEvent;
    })();
  });
  const client = { messages: { create }, beta: { messages: { create } } };
  return { client: client as unknown as AnthropicClientLike, create };
}

describe("a paused web-search turn", () => {
  it("is carried whole, and its continuation replays the paused blocks first", async () => {
    const paused: unknown[] = [
      { type: "message_start", message: { id: "m1", model: "claude-opus-5-5", usage: {} } },
      { type: "content_block_start", index: 0, content_block: { ...searchUse, input: {} } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(searchUse.input) },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: searchError },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
    const { client, create } = streamingClient([paused]);
    const provider = createAnthropicProvider({ client });
    const first = terminal(await collect(provider.stream(request(opus55())))).message;
    expect(first.stopReason).toBe("pauseTurn");
    expect(first.content).toEqual([served(searchUse), served(searchError)]);

    // The core loop re-sends the conversation unchanged after a pause.
    await collect(
      provider.stream(request(opus55(), { messages: [userMessage("look it up"), first] })),
    );
    const resent = create.mock.calls[1]?.[0] as { messages: unknown[]; tools: unknown[] };
    expect(resent.messages.at(-1)).toEqual({
      role: "assistant",
      content: [searchUse, searchError],
    });
    expect(resent.tools).toContainEqual(expect.objectContaining({ type: "web_search_20260209" }));
  });
});
