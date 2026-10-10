/**
 * Provider-native web search and fetch from the CLI side: the `websearch` /
 * `webfetch` config keys, the domain filter derived from host-shaped
 * permission rules, the client wrapper that puts `serverTools` on a request
 * (and, through the adapter, takes the client tool it replaces off it), and
 * the transcript and export rendering of the server's blocks.
 */

import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { type AnthropicClientLike, createAnthropicProvider, requireModel } from "@arcturn/ai";
import { ColorLevel, setColorLevel } from "@arcturn/tui";
import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  PermissionRule,
  ToolDefinition,
} from "@arcturn/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, parseConfigFile } from "./config.js";
import { TranscriptFormatter } from "./display.js";
import { exportMarkdown } from "./export.js";
import {
  describeServerTools,
  hostOfSpecifier,
  nativeWebServerTools,
  serverToolPlanner,
  withServerTools,
} from "./server-tools.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

beforeEach(() => {
  setColorLevel(ColorLevel.None);
});

function parse(raw: unknown) {
  const warnings: string[] = [];
  const parsed = parseConfigFile(raw, "user", "cfg", warnings);
  return { parsed, warnings: warnings.join("\n") };
}

function rule(tool: string, specifier: string, action: PermissionRule["action"]): PermissionRule {
  return { tool, specifier, action, scope: "user" };
}

describe("websearch / webfetch config", () => {
  it("reads the provider and maxUses", () => {
    const { parsed, warnings } = parse({
      websearch: { provider: "anthropic", maxUses: 4 },
      webfetch: { provider: "builtin" },
    });
    expect(parsed.websearch).toEqual({ provider: "anthropic", maxUses: 4 });
    expect(parsed.webfetch).toEqual({ provider: "builtin" });
    expect(warnings).toBe("");
  });

  it("warns about and drops invalid values", () => {
    const { parsed, warnings } = parse({
      websearch: { provider: "google", maxUses: 0 },
      webfetch: "anthropic",
    });
    expect(parsed.websearch).toBeUndefined();
    expect(parsed.webfetch).toBeUndefined();
    expect(warnings).toContain('"websearch.provider" must be "anthropic" or "builtin"');
    expect(warnings).toContain('"webfetch" must be an object');
    const maxUses = parse({ websearch: { provider: "anthropic", maxUses: -2 } });
    expect(maxUses.parsed.websearch).toEqual({ provider: "anthropic" });
    expect(maxUses.warnings).toContain('"websearch.maxUses" must be a positive whole number');
  });
});

describe("host-shaped permission specifiers", () => {
  it("reads an origin, a bare host and a subdomain wildcard", () => {
    expect(hostOfSpecifier("https://docs.example.com")).toBe("docs.example.com");
    expect(hostOfSpecifier("https://docs.example.com:8443")).toBe("docs.example.com");
    expect(hostOfSpecifier("Docs.Example.com")).toBe("docs.example.com");
    expect(hostOfSpecifier("https://*.example.com")).toBe("example.com");
    expect(hostOfSpecifier("*.example.com")).toBe("example.com");
  });

  it("refuses anything the API would not take as a plain hostname", () => {
    for (const specifier of [
      undefined,
      "*",
      "https://example.com/docs/*",
      "https://exa*mple.com",
      "localhost",
      "http://127.0.0.1",
      "com",
      "git *",
    ]) {
      expect(hostOfSpecifier(specifier)).toBeUndefined();
    }
  });
});

describe("the native web tools a session asks for", () => {
  it("asks for nothing on the builtin provider", () => {
    expect(nativeWebServerTools({}, []).tools).toEqual([]);
    expect(nativeWebServerTools({ websearch: { provider: "builtin" } }, []).tools).toEqual([]);
  });

  it("derives the domain lists from host-shaped fetch and websearch rules", () => {
    const { tools, notices } = nativeWebServerTools(
      {
        websearch: { provider: "anthropic", maxUses: 6 },
        webfetch: { provider: "anthropic" },
      },
      [
        rule("fetch", "https://docs.example.com", "allow"),
        rule("fetch", "https://example.com/private/*", "allow"),
        rule("websearch", "*.news.example", "allow"),
        rule("bash", "git *", "allow"),
      ],
    );
    expect(tools).toEqual([
      { kind: "webSearch", replaces: "websearch", maxUses: 6, allowedDomains: ["news.example"] },
      { kind: "webFetch", replaces: "fetch", allowedDomains: ["docs.example.com"] },
    ]);
    expect(notices).toEqual([]);
  });

  it("prefers the deny list when both kinds exist, and says so once", () => {
    const { tools, notices } = nativeWebServerTools({ webfetch: { provider: "anthropic" } }, [
      rule("fetch", "https://docs.example.com", "allow"),
      rule("fetch", "https://evil.example", "deny"),
      rule("websearch", "spam.example", "deny"),
    ]);
    expect(tools).toEqual([
      {
        kind: "webFetch",
        replaces: "fetch",
        blockedDomains: ["evil.example", "spam.example"],
      },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("web_fetch");
    expect(notices[0]).toContain("deny");
  });
});

describe("what a rule the native tool cannot express does to it", () => {
  const both = {
    websearch: { provider: "anthropic" as const },
    webfetch: { provider: "anthropic" as const },
  };

  it("table: only DENY rules fill blocked_domains and only ALLOW rules fill allowed_domains", () => {
    const cases: Array<{
      rules: PermissionRule[];
      fetch: { allowedDomains?: string[]; blockedDomains?: string[] };
    }> = [
      { rules: [rule("fetch", "a.example", "allow")], fetch: { allowedDomains: ["a.example"] } },
      { rules: [rule("fetch", "a.example", "deny")], fetch: { blockedDomains: ["a.example"] } },
      { rules: [rule("fetch", "a.example", "ask")], fetch: {} },
      { rules: [rule("websearch", "a.example", "allow")], fetch: {} },
      { rules: [rule("websearch", "a.example", "deny")], fetch: { blockedDomains: ["a.example"] } },
      { rules: [rule("fetch", "*.a.example", "deny")], fetch: { blockedDomains: ["a.example"] } },
    ];
    for (const { rules, fetch } of cases) {
      const entry = nativeWebServerTools(both, rules).tools.find(
        (tool) => tool.kind === "webFetch",
      );
      expect(entry).toMatchObject(fetch);
      expect(
        Object.keys(entry ?? {})
          .filter((key) => key.endsWith("Domains"))
          .sort(),
      ).toEqual(Object.keys(fetch).sort());
    }
  });

  it("does not ask for a native tool whose client tool is denied outright", () => {
    const { tools, notices } = nativeWebServerTools(both, [
      { tool: "fetch", action: "deny", scope: "user" },
    ]);
    expect(tools.map((tool) => tool.kind)).toEqual(["webSearch"]);
    expect(notices.join(" ")).toContain("fetch");
  });

  it("says so when a deny rule is not a bare host and so cannot limit the native tool", () => {
    const { notices } = nativeWebServerTools(both, [
      rule("fetch", "https://evil.example/private/*", "deny"),
    ]);
    expect(notices.join(" ")).toContain("evil.example/private");
  });

  it("never sends a list the API rejects: a deny list over 64 hosts drops the native tool", () => {
    const many = Array.from({ length: 70 }, (_, i) => rule("fetch", `h${i}.example`, "deny"));
    const { tools, notices } = nativeWebServerTools(both, many);
    expect(tools.find((tool) => tool.kind === "webFetch")).toBeUndefined();
    expect(notices.join(" ")).toContain("64");
    const allows = Array.from({ length: 70 }, (_, i) => rule("fetch", `h${i}.example`, "allow"));
    const fetch = nativeWebServerTools(both, allows).tools.find((tool) => tool.kind === "webFetch");
    expect(fetch && "allowedDomains" in fetch ? fetch.allowedDomains?.length : 0).toBe(64);
  });
});

function def(name: string): ToolDefinition {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

function recordingClient(): { client: LLMClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  const client: LLMClient = {
    async *stream(request) {
      requests.push(request);
      yield { type: "start", model: request.model.id };
    },
    async complete() {
      throw new Error("unused");
    },
  };
  return { client, requests };
}

describe("the server-tool wrapper", () => {
  const web = nativeWebServerTools(
    { websearch: { provider: "anthropic" }, webfetch: { provider: "anthropic" } },
    [],
  ).tools;

  it("asks only for the native tools whose client tool this request offers", async () => {
    const { client, requests } = recordingClient();
    const wrapped = withServerTools(client, serverToolPlanner({ web }));
    const model = requireModel("anthropic/claude-opus-5-5");
    for await (const _ of wrapped.stream({
      model,
      messages: [],
      tools: [def("read"), def("websearch")],
    })) {
      // drain
    }
    // A plan-mode or role-restricted request without `fetch` gets no web_fetch.
    for await (const _ of wrapped.stream({ model, messages: [], tools: [def("read")] })) {
      // drain
    }
    expect(requests[0]?.serverTools).toEqual([{ kind: "webSearch", replaces: "websearch" }]);
    expect(requests[1]?.serverTools).toBeUndefined();
  });

  it("takes the client tools off the wire where the native ones go", async () => {
    const create = vi.fn(async (_params: unknown) =>
      (async function* () {
        for (const event of [
          { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: {} } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
          { type: "message_stop" },
        ]) {
          yield event as unknown as RawMessageStreamEvent;
        }
      })(),
    );
    const sdk = { messages: { create }, beta: { messages: { create } } };
    const provider = createAnthropicProvider({ client: sdk as unknown as AnthropicClientLike });
    const wrapped = withServerTools(provider, serverToolPlanner({ web }));
    await wrapped.complete({
      model: requireModel("anthropic/claude-opus-5-5"),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
      tools: [def("read"), def("websearch"), def("fetch")],
    });
    const sent = create.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(sent.tools.map((tool) => tool.name)).toEqual(["read", "web_search", "web_fetch"]);
  });
});

describe("a runtime with websearch on the anthropic provider", () => {
  it("asks for the native search on the main agent's requests, and notes the dropped allow list", async () => {
    const scratch = await makeScratch();
    const llm = fakeLLM([{ text: "ok" }]);
    const parsed = parseConfigFile(
      {
        model: "anthropic/claude-opus-5-5",
        websearch: { provider: "anthropic", maxUses: 3 },
        permissions: [
          { tool: "websearch", specifier: "docs.example.com", action: "allow" },
          { tool: "fetch", specifier: "https://evil.example", action: "deny" },
        ],
      },
      "user",
      "cfg",
      [],
    );
    const runtime = await buildTestRuntime(scratch, [], {
      llm,
      config: { ...DEFAULT_CONFIG, ...parsed },
    });
    try {
      await runtime.agent.prompt("search something");
      expect(llm.requests[0]?.serverTools).toEqual([
        { kind: "webSearch", replaces: "websearch", maxUses: 3, blockedDomains: ["evil.example"] },
      ]);
      expect(runtime.warnings.join("\n")).toContain("only the deny list (evil.example)");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("a paused native web search, end to end", () => {
  it("is continued by the loop, its blocks replayed to the same native tool", async () => {
    const use = { type: "server_tool_use", id: "srv1", name: "web_search", input: {} };
    const result = {
      type: "web_search_tool_result",
      tool_use_id: "srv1",
      content: [
        { type: "web_search_result", title: "T", url: "https://t.example", encrypted_content: "e" },
      ],
    };
    const turns: unknown[][] = [
      [
        { type: "message_start", message: { id: "m1", model: "claude-opus-5-5", usage: {} } },
        { type: "content_block_start", index: 0, content_block: use },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"query":"q"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: result },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "pause_turn" },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ],
      [
        { type: "message_start", message: { id: "m2", model: "claude-opus-5-5", usage: {} } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ],
    ];
    let call = 0;
    const create = vi.fn(async (_params: unknown) => {
      const events = turns[Math.min(call++, turns.length - 1)] ?? [];
      return (async function* () {
        for (const event of events) yield event as unknown as RawMessageStreamEvent;
      })();
    });
    const sdk = { messages: { create }, beta: { messages: { create } } };
    const scratch = await makeScratch();
    const parsed = parseConfigFile(
      { model: "anthropic/claude-opus-5-5", websearch: { provider: "anthropic" } },
      "user",
      "cfg",
      [],
    );
    const runtime = await buildTestRuntime(scratch, [], {
      llm: createAnthropicProvider({ client: sdk as unknown as AnthropicClientLike }),
      config: { ...DEFAULT_CONFIG, ...parsed },
      permissionMode: "yolo",
    });
    try {
      await runtime.agent.prompt("search");
      expect(create).toHaveBeenCalledTimes(2);
      const second = create.mock.calls[1]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
        tools: Array<{ name: string; type?: string }>;
      };
      expect(second.messages.at(-1)).toEqual({
        role: "assistant",
        content: [{ ...use, input: { query: "q" } }, result],
      });
      const names = second.tools.map((tool) => tool.name);
      expect(names).toContain("web_search");
      expect(names).not.toContain("websearch");
    } finally {
      await runtime.dispose();
    }
  });
});

const searchTurn: AssistantMessage = {
  role: "assistant",
  model: "anthropic/claude-opus-5-5",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: "endTurn",
  timestamp: 1,
  content: [
    {
      type: "serverTool",
      provider: "anthropic",
      block: {
        type: "server_tool_use",
        id: "s1",
        name: "web_search",
        input: { query: "arcturn release" },
      },
    },
    {
      type: "serverTool",
      provider: "anthropic",
      block: {
        type: "web_search_tool_result",
        tool_use_id: "s1",
        content: [
          {
            type: "web_search_result",
            title: "Arcturn 0.6",
            url: "https://example.com/0.6",
            encrypted_content: "x",
          },
          {
            type: "web_search_result",
            title: "Changelog",
            url: "https://example.com/log",
            encrypted_content: "y",
          },
        ],
      },
    },
    {
      type: "serverTool",
      provider: "anthropic",
      block: {
        type: "server_tool_use",
        id: "s2",
        name: "web_fetch",
        input: { url: "https://x.example" },
      },
    },
    {
      type: "serverTool",
      provider: "anthropic",
      block: {
        type: "web_fetch_tool_result",
        tool_use_id: "s2",
        content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
      },
    },
    { type: "text", text: "Here is what I found." },
  ],
};

describe("rendering the server's web blocks", () => {
  it("pairs each call with its result: titles and URLs, or the error code", () => {
    expect(describeServerTools(searchTurn.content)).toEqual([
      {
        name: "web_search",
        subject: "arcturn release",
        results: ["Arcturn 0.6 — https://example.com/0.6", "Changelog — https://example.com/log"],
      },
      { name: "web_fetch", subject: "https://x.example", error: "url_not_accessible" },
    ]);
  });

  it("shows them in the transcript as tool rows", () => {
    const text = new TranscriptFormatter({ markdown: false })
      .format({ type: "messageEnd", message: searchTurn })
      .join("\n");
    expect(text).toContain("web_search");
    expect(text).toContain("arcturn release");
    expect(text).toContain("2 results");
    expect(text).toContain("Arcturn 0.6 — https://example.com/0.6");
    expect(text).toContain("web_fetch");
    expect(text).toContain("url_not_accessible");
    expect(text).toContain("Here is what I found.");
  });

  it("exports them with the query and the results", () => {
    const markdown = exportMarkdown([searchTurn]);
    expect(markdown).toContain("web_search");
    expect(markdown).toContain("arcturn release");
    expect(markdown).toContain("Arcturn 0.6 — https://example.com/0.6");
    expect(markdown).toContain("url_not_accessible");
  });
});
