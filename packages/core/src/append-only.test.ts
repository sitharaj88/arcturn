/**
 * Append-only history: two consecutive outgoing requests from one session
 * must share a byte-identical prefix — the same `system`, the same `tools`,
 * and every earlier message unchanged — so the prompt cache keeps hitting and,
 * on the preserved-thinking models (Fable 5.1, Opus 5.5, Sonnet 5.5,
 * Haiku 5.5), every replayed thinking block stays bound to the prefix that
 * produced it. A prefix edit there is a 400 on an enforced account.
 */

import type {
  AssistantMessage,
  LLMRequest,
  Message,
  ModelSpec,
  StreamEvent,
  Tool,
  ToolResult,
} from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { createDeferredToolset } from "./deferred-tools.js";
import { MemorySessionStore } from "./session/memory-store.js";
import { createScriptedLLM, TEST_MODEL, textTurn, toolCallTurn } from "./test-helpers/fake-llm.js";
import { text } from "./util/content.js";

/** Claude Opus 5.5 as the catalog describes it: adaptive, first-party Anthropic. */
const OPUS_55: ModelSpec = {
  id: "anthropic/claude-opus-5-5",
  provider: "anthropic",
  model: "claude-opus-5-5",
  displayName: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: {
    tools: true,
    vision: true,
    thinking: true,
    caching: true,
    thinkingStyle: "adaptive",
  },
};

/** Claude Opus 5.5 behind Bedrock: adaptive, but no native tool search. */
const BEDROCK_OPUS_55: ModelSpec = {
  ...OPUS_55,
  id: "bedrock/anthropic.claude-opus-5-5",
  provider: "bedrock",
  model: "anthropic.claude-opus-5-5",
};

function bigTool(name: string, size: number): Tool {
  return {
    definition: {
      name,
      description: `${name} returns a large blob.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(): Promise<ToolResult> {
      return { content: [text(name.repeat(Math.ceil(size / name.length)).slice(0, size))] };
    },
  };
}

function plainTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(): Promise<ToolResult> {
      return { content: [text(`${name} ran`)] };
    },
  };
}

/** A tool-calling turn whose final message also carries a signed thinking block. */
function thinkingToolTurn(id: string, name: string, args: Record<string, unknown> = {}) {
  const events = toolCallTurn([{ id, name, arguments: args }]);
  const end = events.at(-1);
  if (end?.type === "end") {
    end.message = {
      ...end.message,
      content: [
        { type: "thinking", thinking: `why ${id}`, signature: `sig-${id}` },
        ...end.message.content,
      ],
    };
  }
  return events;
}

/** Comparable view of what a request sends ahead of its messages. */
function head(request: LLMRequest): string {
  return JSON.stringify({ system: request.system, tools: request.tools ?? [] });
}

/**
 * Assert `next` extends `previous`: the same system and tools, and every
 * message `previous` sent re-sent byte for byte at the same position.
 */
function expectAppendOnly(previous: LLMRequest, next: LLMRequest, label: string): void {
  expect(head(next), `${label}: system/tools changed`).toBe(head(previous));
  expect(next.messages.length, `${label}: history shrank`).toBeGreaterThanOrEqual(
    previous.messages.length,
  );
  for (let index = 0; index < previous.messages.length; index++) {
    expect(JSON.stringify(next.messages[index]), `${label}: messages[${index}] was rewritten`).toBe(
      JSON.stringify(previous.messages[index]),
    );
  }
}

function expectAllAppendOnly(requests: readonly LLMRequest[]): void {
  for (let index = 1; index < requests.length; index++) {
    expectAppendOnly(requests[index - 1]!, requests[index]!, `request ${index}`);
  }
}

describe("append-only outgoing history", () => {
  it("never rewrites an already-sent tool result when context editing elides it", async () => {
    // Eight 3K-char results against a 6K trigger and one kept turn: the old
    // engine re-decided elision on every request, so each request stubbed out
    // the result the previous one had sent in full.
    const tool = bigTool("blob", 3_000);
    const script: StreamEvent[][] = [];
    for (let i = 0; i < 8; i++)
      script.push(toolCallTurn([{ id: `c${i}`, name: "blob", arguments: {} }]));
    script.push(textTurn("done"));
    const llm = createScriptedLLM(script);
    const agent = new Agent({
      llm,
      model: TEST_MODEL,
      systemPrompt: "sys",
      tools: [tool],
      cwd: "/work",
      permissions: { mode: "yolo" },
      contextEditing: {
        keepRecentTurns: 1,
        maxTotalToolResultChars: 6_000,
        minCharsPerPass: 9_000,
      },
    });

    await agent.prompt("go");

    expect(llm.requests.length).toBe(9);
    // Elision did happen — this is not a test that context editing is off.
    const last = llm.requests.at(-1)!;
    expect(
      last.messages.some(
        (message) => message.role === "toolResult" && message.details?.contextElided === true,
      ),
    ).toBe(true);
    // Every consecutive pair outside a recorded elision pass is append-only.
    const passes = new Set(
      agent.contextEditPasses.map((pass) => pass.requestIndex).filter((index) => index > 0),
    );
    for (let index = 1; index < llm.requests.length; index++) {
      if (passes.has(index)) continue;
      expectAppendOnly(llm.requests[index - 1]!, llm.requests[index]!, `request ${index}`);
    }
    // And a pass is a rare, deliberate event, not one per request.
    expect(passes.size).toBeLessThan(llm.requests.length - 2);
  });

  it("keeps the prefix across a steering message and a ceiling warning", async () => {
    const tool = plainTool("echo");
    const script = Array.from({ length: 5 }, (_, i) =>
      toolCallTurn([{ id: `c${i}`, name: "echo", arguments: {} }]),
    );
    const llm = createScriptedLLM(script);
    const agent = new Agent({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      tools: [tool],
      cwd: "/work",
      permissions: { mode: "yolo" },
      maxTurns: 4,
    });
    let steered = false;
    agent.subscribe((event) => {
      if (event.type === "toolStart" && !steered) {
        steered = true;
        agent.steer("user says: also check the tests");
      }
    });

    await agent.prompt("loop");

    expectAllAppendOnly(llm.requests);
    // The user's own steering stays a user message …
    const steeredMessage = agent.messages.find(
      (message) =>
        message.role === "user" &&
        message.content.some((part) => part.type === "text" && part.text.startsWith("user says")),
    );
    expect(steeredMessage).toBeDefined();
    // … while the harness's warning travels on the operator channel.
    const warning = agent.messages.find((message) =>
      message.content.some(
        (part) => part.type === "text" && "text" in part && part.text.startsWith("Turn budget:"),
      ),
    );
    expect(warning?.role).toBe("system");
  });

  it("sends the same tool set before and after a native tool_search activation", async () => {
    // First-party Anthropic, 4.5+: every tool goes out from the first request,
    // the deferred ones with deferLoading, so activation changes nothing.
    const toolset = createDeferredToolset({
      tools: [plainTool("read"), plainTool("deploy"), plainTool("rollback")],
      alwaysActive: ["read"],
    });
    // The server found `deploy`; the model calls it in the same message.
    const found = toolCallTurn([{ id: "d1", name: "deploy", arguments: {} }]);
    const end = found.at(-1);
    if (end?.type === "end") {
      end.message = {
        ...end.message,
        content: [
          {
            type: "serverTool",
            provider: "anthropic",
            block: {
              type: "server_tool_use",
              id: "srv1",
              name: "tool_search_tool_bm25",
              input: { query: "deploy" },
            },
          },
          {
            type: "serverTool",
            provider: "anthropic",
            block: {
              type: "tool_search_tool_result",
              tool_use_id: "srv1",
              content: {
                type: "tool_search_tool_search_result",
                tool_references: [{ type: "tool_reference", tool_name: "deploy" }],
              },
            },
          },
          ...end.message.content,
        ],
      };
    }
    const llm = createScriptedLLM([found, textTurn("deployed")]);
    const agent = new Agent({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      tools: toolset.allTools(),
      getTools: (model) => toolset.toolsFor(model),
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    agent.on("messageEnd", (event) => toolset.observe(event.message));

    await agent.prompt("ship it");

    expect(llm.requests).toHaveLength(2);
    expectAllAppendOnly(llm.requests);
    const tools = llm.requests[0]!.tools ?? [];
    // arcturn's own search tool is not sent next to the server's.
    expect(tools.map((tool) => tool.name)).toEqual(["read", "deploy", "rollback"]);
    expect(tools.map((tool) => tool.deferLoading === true)).toEqual([false, true, true]);
    // The deferred tool ran, and the activation is on arcturn's record.
    const result = agent.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ toolName: "deploy", isError: false });
    expect(toolset.snapshot().activated).toEqual(["deploy"]);
  });

  it("resumes with the elided stubs and the activated tools it ended with", async () => {
    const store = new MemorySessionStore();
    const sessionId = "s-resume";
    const build = () =>
      createDeferredToolset({
        tools: [plainTool("read"), bigTool("dump", 3_000), plainTool("deploy")],
        alwaysActive: ["read", "dump"],
      });
    const first = build();
    const script: StreamEvent[][] = [
      toolCallTurn([{ id: "t1", name: "tool_search", arguments: { select: ["deploy"] } }]),
    ];
    for (let i = 0; i < 4; i++) script.push(thinkingToolTurn(`c${i}`, "dump"));
    script.push(textTurn("first run done"));
    const llm1 = createScriptedLLM(script);
    const options = {
      model: BEDROCK_OPUS_55,
      systemPrompt: "sys",
      cwd: "/work",
      permissions: { mode: "yolo" as const },
      sessionStore: store,
      sessionId,
      contextEditing: { keepRecentTurns: 1, maxTotalToolResultChars: 4_000, minCharsPerPass: 1 },
    };
    const agent1 = new Agent({
      ...options,
      llm: llm1,
      tools: first.allTools(),
      getTools: (model) => first.toolsFor(model),
    });
    await agent1.prompt("work");
    // Elision did happen in the first run, and a tool was activated.
    expect(agent1.contextEditPasses.length).toBeGreaterThan(0);
    expect(first.snapshot().activated).toEqual(["deploy"]);
    const leaf = agent1.leafEntryId!;

    // What the live agent sends next …
    await agent1.prompt("continue");
    const live = llm1.requests.at(-1)!;

    // … and what a new process sends from the session file alone, with a
    // fresh toolset rebuilt from the transcript.
    const second = build();
    const llm2 = createScriptedLLM([textTurn("resumed")]);
    const agent2 = await Agent.resume({
      ...options,
      llm: llm2,
      tools: second.allTools(),
      getTools: (model) => second.toolsFor(model),
      leafId: leaf,
    });
    second.replay(agent2.messages);
    await agent2.prompt("continue");
    const resumed = llm2.requests[0]!;

    expect(head(resumed)).toBe(head(live));
    expect(resumed.messages.length).toBe(live.messages.length);
    // Every message but the new prompt (whose timestamp differs) is identical:
    // the same stubs, the same withheld thinking, the same order.
    for (let index = 0; index < live.messages.length - 1; index++) {
      expect(JSON.stringify(resumed.messages[index]), `messages[${index}]`).toBe(
        JSON.stringify(live.messages[index]),
      );
    }
    expect(
      live.messages.some(
        (message) => message.role === "toolResult" && message.details?.contextElided === true,
      ),
    ).toBe(true);
  });
});

describe("keep-tail thinking", () => {
  it("is never replayed after a summary it predates", async () => {
    const tool = plainTool("echo");
    const llm = createScriptedLLM([
      thinkingToolTurn("a", "echo"),
      textTurn("first done"),
      thinkingToolTurn("b", "echo"),
      textTurn("second done"),
      textTurn("summary of the work"),
      textTurn("after"),
    ]);
    const agent = new Agent({
      llm,
      model: { ...OPUS_55, provider: "bedrock" },
      systemPrompt: "sys",
      tools: [tool],
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { enabled: false, shape: "keep-tail", keepRecentTokens: 1 },
    });
    await agent.prompt("first");
    await agent.prompt("second");
    await agent.compact();
    await agent.prompt("third");

    const assistants = agent.messages.filter(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    const replayed = llm.requests
      .at(-1)!
      .messages.filter((message): message is AssistantMessage => message.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    for (const message of replayed as Message[]) {
      if (message.role !== "assistant") continue;
      expect(message.content.some((block) => block.type === "thinking")).toBe(false);
    }
  });
});
