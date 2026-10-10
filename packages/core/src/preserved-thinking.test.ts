/**
 * The append-only shapes behind preserved thinking: compaction shapes,
 * server-side context management, the operator channel, the provider's
 * `input_transformations` report, and the session file carrying all of it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  AssistantMessage,
  Message,
  ModelSpec,
  StreamEvent,
  Tool,
  ToolResult,
} from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import {
  compactMessages,
  findSimpleCutPoint,
  hasPendingToolRound,
  resolveCompactionShape,
} from "./compaction.js";
import {
  ContextEditLedger,
  explainContextEditMode,
  planContextEditPass,
  resolveContextEditOptions,
} from "./context-edit.js";
import { createDeferredToolset } from "./deferred-tools.js";
import { inputTransformationNotices } from "./loop.js";
import { JsonlSessionStore } from "./session/jsonl-store.js";
import { materializeBranch } from "./session/tree.js";
import {
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
  usage,
} from "./test-helpers/fake-llm.js";
import { contentText, operatorMessage, text, userMessage } from "./util/content.js";

const ADAPTIVE: ModelSpec["capabilities"] = {
  tools: true,
  vision: true,
  thinking: true,
  caching: true,
  thinkingStyle: "adaptive",
};

const OPUS_55: ModelSpec = {
  id: "anthropic/claude-opus-5-5",
  provider: "anthropic",
  model: "claude-opus-5-5",
  displayName: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  capabilities: ADAPTIVE,
};

const GPT: ModelSpec = {
  id: "openai/gpt-5",
  provider: "openai",
  model: "gpt-5",
  displayName: "GPT-5",
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  capabilities: { tools: true, vision: true, thinking: true, caching: false },
};

function plainTool(name: string, body = `${name} ran`): Tool {
  return {
    definition: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(): Promise<ToolResult> {
      return { content: [text(body)] };
    },
  };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: "m",
    usage: usage(0, 0),
    stopReason: content.some((block) => block.type === "toolCall") ? "toolCalls" : "endTurn",
    timestamp: 1,
  };
}

function result(id: string, body: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [text(body)],
    isError: false,
    timestamp: 1,
  };
}

const thinking = (id: string) =>
  ({ type: "thinking", thinking: `why ${id}`, signature: `sig-${id}` }) as const;
const call = (id: string) =>
  ({ type: "toolCall", id, name: "read", arguments: { path: id } }) as const;

describe("compaction shapes", () => {
  it("defaults to simple on adaptive Claude and keep-tail elsewhere", () => {
    expect(resolveCompactionShape({}, OPUS_55)).toBe("simple");
    expect(resolveCompactionShape({}, { ...OPUS_55, provider: "bedrock" })).toBe("simple");
    expect(resolveCompactionShape({}, TEST_MODEL)).toBe("keep-tail");
    expect(resolveCompactionShape({}, GPT)).toBe("keep-tail");
    // An explicit shape always wins.
    expect(resolveCompactionShape({ shape: "keep-tail" }, OPUS_55)).toBe("keep-tail");
  });

  it("simple replaces the whole history and replays nothing earlier", async () => {
    const history: Message[] = [
      userMessage("one"),
      assistant([thinking("a"), call("a")]),
      result("a", "x".repeat(500)),
      assistant([thinking("b"), { type: "text", text: "done with one" }]),
      userMessage("two"),
    ];
    const llm = createScriptedLLM([textTurn("## Goal\nthe summary")]);
    const compacted = await compactMessages({ llm, model: OPUS_55, messages: history });

    expect(compacted?.shape).toBe("simple");
    // The summary, then only the new user turn — no turn, no thinking from before.
    expect(compacted?.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(contentText(compacted!.messages[1]!.content)).toBe("two");
    expect(JSON.stringify(compacted?.messages)).not.toContain("sig-");
    // The summarizer was told the reasoning is not in its input.
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain("Reasoning to carry forward");
  });

  it("never cuts through a tool round, in either local shape", () => {
    const open: Message[] = [userMessage("go"), assistant([thinking("a"), call("a")])];
    expect(hasPendingToolRound(open)).toBe(true);
    expect(findSimpleCutPoint(open)).toBe(0);
    const closed: Message[] = [...open, result("a", "ok")];
    expect(hasPendingToolRound(closed)).toBe(false);
    expect(findSimpleCutPoint(closed)).toBe(closed.length);
  });

  it("keep-tail on adaptive Claude strips the kept tail's thinking but keeps its calls", async () => {
    const history: Message[] = [
      userMessage("x".repeat(400)),
      assistant([{ type: "text", text: "y".repeat(400) }]),
      userMessage("recent"),
      assistant([thinking("r"), call("r")]),
      result("r", "ok"),
    ];
    const llm = createScriptedLLM([textTurn("## Goal\nsummary")]);
    const compacted = await compactMessages({
      llm,
      model: OPUS_55,
      messages: history,
      options: { shape: "keep-tail", keepRecentTokens: 1 },
    });
    expect(compacted?.stripTailThinking).toBe(true);
    const kept = compacted!.messages.find(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(kept?.content.map((block) => block.type)).toEqual(["toolCall"]);
    // The stored history it came from is untouched.
    expect((history[3] as AssistantMessage).content[0]?.type).toBe("thinking");
    // Elsewhere the tail is kept verbatim.
    const plain = await compactMessages({
      llm: createScriptedLLM([textTurn("## Goal\nsummary")]),
      model: TEST_MODEL,
      messages: history,
      options: { keepRecentTokens: 1 },
    });
    expect(plain?.stripTailThinking).toBe(false);
    expect(JSON.stringify(plain?.messages)).toContain("sig-r");
  });

  it("server compacts on the provider: the request asks, nothing is summarized locally", async () => {
    const llm = createScriptedLLM([textTurn("one"), textTurn("two")]);
    const agent = new Agent({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { shape: "server" },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await agent.prompt("hello");
    expect(llm.requests[0]?.contextManagement).toEqual({ compact: true });
    expect(await agent.compact()).toBe(false);
    expect(llm.requests).toHaveLength(1);
    await expect(
      compactMessages({
        llm,
        model: OPUS_55,
        messages: agent.messages,
        options: { shape: "server" },
      }),
    ).rejects.toThrow(/provider compacts/);
  });
});

describe("server compaction blocks survive the session file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-compaction-block-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("round-trips the compaction block verbatim through JSONL and back onto the request", async () => {
    const block = {
      type: "compaction",
      summary: "server summary",
      encryptedContent: "opaque==",
    } as const;
    const turn = textTurn("after compaction");
    const end = turn.at(-1);
    if (end?.type === "end")
      end.message = { ...end.message, content: [block, ...end.message.content] };
    const store = new JsonlSessionStore({ dir });
    const first = new Agent({
      llm: createScriptedLLM([turn]),
      model: OPUS_55,
      systemPrompt: "sys",
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { shape: "server" },
      sessionStore: store,
      sessionId: "s",
    });
    await first.prompt("long work");

    const llm = createScriptedLLM([textTurn("resumed")]);
    const second = await Agent.resume({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { shape: "server" },
      sessionStore: new JsonlSessionStore({ dir }),
      sessionId: "s",
    });
    await second.prompt("next");
    const replayed = llm.requests[0]!.messages.find(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    expect(replayed?.content[0]).toEqual(block);
  });

  it("round-trips a system message and replays a kept tail without its thinking", async () => {
    const store = new JsonlSessionStore({ dir });
    const llm = createScriptedLLM([
      textTurn("first"),
      (() => {
        const events = toolCallTurn([{ id: "c1", name: "echo", arguments: {} }]);
        const end = events.at(-1);
        if (end?.type === "end") {
          end.message = { ...end.message, content: [thinking("c1"), ...end.message.content] };
        }
        return events;
      })(),
      textTurn("second"),
      textTurn("## Goal\nsummary"),
    ]);
    const agent = new Agent({
      llm,
      model: { ...OPUS_55, provider: "vertex" },
      systemPrompt: "sys",
      tools: [plainTool("echo")],
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { enabled: false, shape: "keep-tail", keepRecentTokens: 1 },
      sessionStore: store,
      sessionId: "t",
    });
    await agent.prompt("one");
    agent.steer("operator says hi", { from: "operator" });
    await agent.prompt("two");
    expect(await agent.compact()).toBe(true);

    const branch = materializeBranch(await store.branch("t", agent.leafEntryId!));
    expect(branch.messages.map((message) => message.role)).toEqual(
      agent.messages.map((message) => message.role),
    );
    expect(JSON.stringify(branch.messages)).not.toContain("sig-c1");
    expect(JSON.stringify(agent.messages)).not.toContain("sig-c1");
    const operator = branch.messages.find((message) => message.role === "system");
    expect(operator).toMatchObject({
      role: "system",
      content: [{ type: "text", text: "operator says hi" }],
    });
  });
});

describe("context editing", () => {
  it("passes are batched: nothing until a pass would save minCharsPerPass", () => {
    const options = resolveContextEditOptions({
      keepRecentTurns: 1,
      maxTotalToolResultChars: 0,
      minCharsPerPass: 5_000,
    });
    const ledger = new ContextEditLedger();
    const history: Message[] = [
      userMessage("go"),
      assistant([call("a")]),
      result("a", "a".repeat(3_000)),
      assistant([call("b")]),
      result("b", "b".repeat(3_000)),
    ];
    expect(planContextEditPass(history, ledger, options, false)).toBeUndefined();
    history.push(assistant([call("c")]), result("c", "c".repeat(3_000)));
    const pass = planContextEditPass(history, ledger, options, true);
    expect(pass?.record).toEqual({ elided: ["a", "b"], withholdThinking: "afterFirstElided" });
    ledger.apply(pass!.record, history);
    // Applied once, it is not planned again; the stubs render identically.
    expect(planContextEditPass(history, ledger, options, true)).toBeUndefined();
    const once = JSON.stringify(ledger.render(history, options));
    expect(JSON.stringify(ledger.render(history, options))).toBe(once);
  });

  it("withholds the thinking produced after the first result a pass rewrites", () => {
    const options = resolveContextEditOptions({ keepRecentTurns: 1, maxTotalToolResultChars: 0 });
    const early = assistant([thinking("a"), call("a")]);
    const later = assistant([thinking("b"), call("b")]);
    const history: Message[] = [
      userMessage("go"),
      early,
      result("a", "a".repeat(3_000)),
      later,
      result("b", "small"),
      assistant([{ type: "text", text: "end" }]),
    ];
    const ledger = new ContextEditLedger();
    ledger.apply({ elided: ["a"], withholdThinking: "afterFirstElided" }, history);
    const rendered = ledger.render(history, options);
    expect(JSON.stringify(rendered[1])).toContain("sig-a");
    expect(JSON.stringify(rendered[3])).not.toContain("sig-b");
    expect(contentText((rendered[2] as Message & { role: "toolResult" }).content)).toContain(
      "context-edited",
    );
  });

  it("server mode sends tool-result clearing and leaves the history unedited", async () => {
    const script: StreamEvent[][] = [];
    for (let i = 0; i < 4; i++)
      script.push(toolCallTurn([{ id: `c${i}`, name: "big", arguments: {} }]));
    const llm = createScriptedLLM(script);
    const agent = new Agent({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      tools: [plainTool("big", "z".repeat(4_000))],
      cwd: "/work",
      permissions: { mode: "yolo" },
      contextEditing: {
        mode: "server",
        keepRecentTurns: 1,
        maxTotalToolResultChars: 0,
        minCharsPerPass: 1,
      },
    });
    await agent.prompt("go");
    for (const request of llm.requests) {
      expect(request.contextManagement).toEqual({
        clearToolUses: true,
        protectTools: ["todo", "plan"],
      });
      expect(JSON.stringify(request.messages)).not.toContain("context-edited");
    }
    expect(agent.contextEditPasses).toEqual([]);
  });

  it("auto picks server only for adaptive Claude on the Messages API", () => {
    expect(explainContextEditMode({ mode: "auto" }, OPUS_55).mode).toBe("server");
    expect(explainContextEditMode({ mode: "auto" }, { ...OPUS_55, provider: "bedrock" }).mode).toBe(
      "local",
    );
    expect(explainContextEditMode({ mode: "auto" }, GPT).mode).toBe("local");
    expect(explainContextEditMode({}, OPUS_55).mode).toBe("local");
    expect(explainContextEditMode({ enabled: false, mode: "server" }, OPUS_55).mode).toBe("off");
  });
});

describe("the operator channel", () => {
  it("sends user steering as the user and operator steering as a system message", async () => {
    const llm = createScriptedLLM([
      toolCallTurn([{ id: "c1", name: "echo", arguments: {} }]),
      textTurn("ok"),
    ]);
    const agent = new Agent({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      tools: [plainTool("echo")],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    agent.on("toolStart", () => {
      agent.steer("the user typed this");
      agent.steer("the host says this", { from: "operator" });
    });
    await agent.prompt("go");
    const roles = llm.requests[1]!.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "user", "system"]);
    expect(() => agent.steer([text("blocks")], { from: "operator" })).toThrow(TypeError);
  });

  it("operatorMessage builds a text-only system message", () => {
    expect(operatorMessage("hi", 5)).toEqual({
      role: "system",
      content: [{ type: "text", text: "hi" }],
      timestamp: 5,
      nonce: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });
});

describe("input transformations", () => {
  it("names the path of a prefix mismatch and calls it a bug in arcturn", () => {
    const [notice] = inputTransformationNotices([
      { type: "thinking_dropped", path: "messages.5.content.0", reason: "prefix_binding_mismatch" },
    ]);
    expect(notice?.level).toBe("warn");
    expect(notice?.text).toContain("messages.5.content.0");
    expect(notice?.text).toContain("bug in arcturn");
  });

  it("ignores what it does not recognise and says nothing for an empty list", () => {
    expect(inputTransformationNotices([])).toEqual([]);
    expect(inputTransformationNotices(undefined)).toEqual([]);
    expect(inputTransformationNotices([{ type: "something_new", path: "x", reason: "y" }])).toEqual(
      [],
    );
  });

  it("reports a model-binding drop after /model at info level, without a retry", async () => {
    const dropped = textTurn("answer on the new model");
    const end = dropped.at(-1);
    if (end?.type === "end") {
      end.message = {
        ...end.message,
        inputTransformations: [
          {
            type: "thinking_dropped",
            path: "messages.1.content.0",
            reason: "model_binding_mismatch",
          },
        ],
      };
    }
    const llm = createScriptedLLM([textTurn("first"), dropped]);
    const agent = new Agent({
      llm,
      model: OPUS_55,
      systemPrompt: "sys",
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await agent.prompt("one");
    agent.setModel({ ...OPUS_55, id: "anthropic/claude-sonnet-5-5", model: "claude-sonnet-5-5" });
    await agent.prompt("two");

    expect(llm.requests).toHaveLength(2);
    const notices = events.filter(
      (event): event is Extract<AgentEvent, { type: "notice" }> =>
        event.type === "notice" && event.text.includes("model_binding_mismatch"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("info");
    expect(notices[0]?.text).toContain("messages.1.content.0");
    // The report rides on the stored message too.
    const last = agent.messages.at(-1) as AssistantMessage;
    expect(last.inputTransformations?.[0]?.reason).toBe("model_binding_mismatch");
  });
});

describe("deferred tools on arcturn's own path", () => {
  it("says once that activation reset the cache, and stops replaying earlier thinking", async () => {
    const toolset = createDeferredToolset({
      tools: [plainTool("read"), plainTool("deploy")],
      alwaysActive: ["read"],
    });
    const search = toolCallTurn([
      { id: "s1", name: "tool_search", arguments: { select: ["deploy"] } },
    ]);
    const end = search.at(-1);
    if (end?.type === "end")
      end.message = { ...end.message, content: [thinking("s1"), ...end.message.content] };
    const llm = createScriptedLLM([search, textTurn("done")]);
    const bedrock: ModelSpec = {
      ...OPUS_55,
      provider: "bedrock",
      model: "anthropic.claude-opus-5-5",
    };
    const agent = new Agent({
      llm,
      model: bedrock,
      systemPrompt: "sys",
      tools: toolset.allTools(),
      getTools: (model) => toolset.toolsFor(model),
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await agent.prompt("deploy");

    // Arcturn's path: the set grew …
    expect(llm.requests[1]?.tools?.map((tool) => tool.name)).toContain("deploy");
    expect(llm.requests[0]?.tools?.map((tool) => tool.name)).not.toContain("deploy");
    // … so the thinking produced under the old set is not replayed …
    expect(JSON.stringify(llm.requests[1]?.messages)).not.toContain("sig-s1");
    // … and the user hears why, once.
    expect(
      events.filter((event) => event.type === "notice" && event.text.includes("tool set changed")),
    ).toHaveLength(1);
  });

  it("keeps natively found tools deferred across a snapshot and restore", () => {
    const tools = [plainTool("read"), plainTool("deploy"), plainTool("rollback")];
    const toolset = createDeferredToolset({ tools, alwaysActive: ["read"] });
    toolset.observe(
      assistant([
        {
          type: "serverTool",
          provider: "anthropic",
          block: {
            type: "tool_search_tool_result",
            tool_use_id: "srv",
            content: {
              type: "tool_search_tool_search_result",
              tool_references: [{ type: "tool_reference", tool_name: "deploy" }],
            },
          },
        },
      ]),
    );
    const before = toolset.toolsFor(OPUS_55).map((tool) => JSON.stringify(tool.definition));
    const rebuilt = createDeferredToolset({ tools, alwaysActive: ["read"] });
    rebuilt.restore(toolset.snapshot());
    expect(rebuilt.toolsFor(OPUS_55).map((tool) => JSON.stringify(tool.definition))).toEqual(
      before,
    );
    // A model without native search sees the activation as an ordinary tool.
    expect(rebuilt.toolsFor(GPT).map((tool) => tool.definition.name)).toEqual([
      "read",
      "deploy",
      "tool_search",
    ]);
  });
});
