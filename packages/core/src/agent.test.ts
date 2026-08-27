import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEvent,
  Message,
  PermissionDecision,
  StreamEvent,
  Tool,
  ToolExecutionContext,
  ToolResult,
} from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, createAgent } from "./agent.js";
import type { AgentHooks } from "./hooks.js";
import { JsonlSessionStore } from "./session/jsonl-store.js";
import { MemorySessionStore } from "./session/memory-store.js";
import { createTodoTool } from "./state-tools.js";
import {
  createScriptedLLM,
  TEST_MODEL,
  textTurn,
  toolCallTurn,
  usage,
} from "./test-helpers/fake-llm.js";
import { contentText, text } from "./util/content.js";

interface EchoTool extends Tool {
  calls: Array<Record<string, unknown>>;
}

function echoTool(overrides: Partial<Tool["definition"]> = {}): EchoTool {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    definition: {
      name: "echo",
      description: "Echo a value back.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      ...overrides,
    },
    async execute(input): Promise<ToolResult> {
      calls.push(input);
      return { content: [text(`echo:${String(input.value)}`)] };
    },
  };
}

function baseOptions(script: StreamEvent[][], tools: Tool[] = []) {
  return {
    llm: createScriptedLLM(script),
    model: TEST_MODEL,
    systemPrompt: "You are Arcturn.",
    tools,
    cwd: "/work",
    permissions: { mode: "yolo" as const },
  };
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function record(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

describe("Agent run loop", () => {
  it("runs a multi-turn tool-calling conversation to completion", async () => {
    const tool = echoTool();
    const agent = new Agent(
      baseOptions(
        [
          toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }], "working on it"),
          toolCallTurn([{ id: "c2", name: "echo", arguments: { value: "b" } }]),
          textTurn("all done"),
        ],
        [tool],
      ),
    );
    const events = record(agent);

    await agent.prompt("do the thing");

    expect(tool.calls).toEqual([{ value: "a" }, { value: "b" }]);
    expect(agent.isRunning).toBe(false);
    expect(agent.finalText()).toBe("all done");

    // No `permissionRequest` here: this agent runs in yolo mode, so the user
    // is never actually asked. Each check still reports its `permissionDecision`.
    const structural = types(events).filter((type) => type !== "messageStream");
    expect(structural).toEqual([
      "runStart",
      "turnStart",
      "messageEnd",
      "toolStart",
      "permissionDecision",
      "toolEnd",
      "turnEnd",
      "turnStart",
      "messageEnd",
      "toolStart",
      "permissionDecision",
      "toolEnd",
      "turnEnd",
      "turnStart",
      "messageEnd",
      "turnEnd",
      "runEnd",
    ]);

    const runEnd = events.at(-1);
    expect(runEnd).toMatchObject({ type: "runEnd", reason: "completed" });

    const roles = agent.messages.map((message) => message.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(events.some((event) => event.type === "messageStream")).toBe(true);
  });

  it("passes the system prompt, tools and thinking level to the client", async () => {
    const tool = echoTool();
    const llm = createScriptedLLM([textTurn("ok")]);
    const prompt = vi.fn(() => "dynamic prompt");
    const agent = new Agent({
      llm,
      model: TEST_MODEL,
      systemPrompt: prompt,
      tools: [tool],
      cwd: "/work",
      thinking: "medium",
      permissions: { mode: "yolo" },
    });

    await agent.prompt("hi");

    const request = llm.requests[0]!;
    expect(request.system).toBe("dynamic prompt");
    expect(request.tools?.map((t) => t.name)).toEqual(["echo"]);
    expect(request.thinking).toBe("medium");
    expect(request.model).toBe(TEST_MODEL);
    expect(request.signal).toBeDefined();
    expect(prompt).toHaveBeenCalled();
  });

  it("reports stream failures as data on runEnd", async () => {
    const llm = createScriptedLLM([
      [
        { type: "start", model: "test-model" },
        {
          type: "error",
          error: { kind: "overloaded", message: "server busy" },
          message: {
            role: "assistant",
            content: [],
            model: "test-model",
            usage: usage(0, 0),
            stopReason: "error",
            errorMessage: "server busy",
            timestamp: 1,
          },
        },
      ],
    ]);
    const agent = new Agent({
      llm,
      model: TEST_MODEL,
      systemPrompt: "s",
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = record(agent);

    await expect(agent.prompt("hi")).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "runEnd",
      reason: "error",
      errorMessage: "server busy",
    });
  });

  it("turns a thrown stream into an error run", async () => {
    const agent = new Agent({
      llm: {
        // biome-ignore lint/correctness/useYield: the stream fails before yielding anything.
        async *stream() {
          throw new Error("socket hang up");
        },
        async complete() {
          throw new Error("unused");
        },
      },
      model: TEST_MODEL,
      systemPrompt: "s",
      cwd: "/work",
    });
    const events = record(agent);
    await agent.prompt("hi");
    expect(events.at(-1)).toMatchObject({ reason: "error", errorMessage: "socket hang up" });
  });

  it("stops at maxTurns", async () => {
    const tool = echoTool();
    const script = Array.from({ length: 5 }, (_, i) =>
      toolCallTurn([{ id: `c${i}`, name: "echo", arguments: { value: String(i) } }]),
    );
    const agent = new Agent({ ...baseOptions(script, [tool]), maxTurns: 2 });
    const events = record(agent);

    await agent.prompt("loop");
    expect(tool.calls).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "runEnd", reason: "error" });
    expect(events.some((e) => e.type === "notice" && e.text.includes("maximum of 2"))).toBe(true);
    // Exhaustion is a pause, not a dead end: the session is intact and
    // another prompt continues from here, so the message must say so.
    const notice = events.find((e) => e.type === "notice" && e.text.includes("maximum of 2"));
    const noticeText = notice?.type === "notice" ? notice.text : "";
    expect(noticeText).toMatch(/continue|--max-turns/);
    // A role agent inside a pipeline has no one to "send another message":
    // the message must also say how to raise a delegated agent's budget,
    // not just how to continue an interactive session.
    expect(noticeText).toMatch(/maxTurns/);
    expect(noticeText).toMatch(/subagentMaxTurns/);
    expect(noticeText).toMatch(/delegated/);
  });

  it("refuses a second concurrent prompt", async () => {
    const tool = echoTool();
    const agent = new Agent(
      baseOptions(
        [toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]), textTurn("ok")],
        [tool],
      ),
    );
    const running = agent.prompt("first");
    await expect(agent.prompt("second")).rejects.toThrow(/already running/);
    await running;
  });
});

describe("steering", () => {
  it("injects queued text after the current tool batch", async () => {
    const tool = echoTool();
    const agent = new Agent(
      baseOptions(
        [
          toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]),
          textTurn("acknowledged"),
        ],
        [tool],
      ),
    );

    agent.subscribe((event) => {
      if (event.type === "toolStart") agent.steer("actually, do it differently");
    });

    await agent.prompt("start");

    const roles = agent.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
    expect(contentText(agent.messages[3]!.content)).toBe("actually, do it differently");
  });

  it("continues the run when steering arrives after a text-only turn", async () => {
    const agent = new Agent(baseOptions([textTurn("first answer"), textTurn("second answer")]));
    let steered = false;
    agent.subscribe((event) => {
      if (event.type === "messageEnd" && !steered) {
        steered = true;
        agent.steer("one more thing");
      }
    });

    await agent.prompt("hello");

    const roles = agent.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    expect(agent.finalText()).toBe("second answer");
  });

  it("delivers a message steered while idle on the next run", async () => {
    const agent = new Agent(baseOptions([textTurn("one"), textTurn("two")]));
    agent.steer("also do this");
    await agent.prompt("go");

    // The queued message follows the prompt rather than being dropped: steer()
    // promises idle messages are kept for the next run.
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    const texts = agent.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.map((part) => ("text" in part ? part.text : "")).join(""));
    expect(texts).toEqual(["go", "also do this"]);
  });

  it("does not replay a steered message on a later run", async () => {
    const agent = new Agent(baseOptions([textTurn("one"), textTurn("two")]));
    agent.steer("once");
    await agent.prompt("first");
    await agent.prompt("second");
    const userTexts = agent.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.map((part) => ("text" in part ? part.text : "")).join(""));
    expect(userTexts).toEqual(["first", "once", "second"]);
  });
});

describe("abort", () => {
  it("aborts mid-stream and settles dangling tool calls", async () => {
    const tool = echoTool();
    let agent!: Agent;
    const llm = createScriptedLLM(
      [toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }], "thinking")],
      {
        onEvent: (event) => {
          if (event.type === "textDelta") agent.abort();
        },
      },
    );
    agent = new Agent({
      llm,
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [tool],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = record(agent);

    await agent.prompt("go");

    expect(events.at(-1)).toMatchObject({ type: "runEnd", reason: "aborted" });
    expect(tool.calls).toHaveLength(0);
    // No assistant tool call is left without a matching result.
    const callIds = agent.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m.role === "assistant" ? m.content : []))
      .filter((block) => block.type === "toolCall")
      .map((block) => block.id);
    const resultIds = agent.messages
      .filter((m) => m.role === "toolResult")
      .map((m) => (m.role === "toolResult" ? m.toolCallId : ""));
    expect(callIds.every((id) => resultIds.includes(id))).toBe(true);
  });

  it("aborts mid-tool and records an error result", async () => {
    let agent!: Agent;
    const slowTool: Tool = {
      definition: {
        name: "slow",
        description: "Never finishes on its own.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      async execute(_input, ctx: ToolExecutionContext): Promise<ToolResult> {
        agent.abort();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("interrupted");
      },
    };
    agent = new Agent(
      baseOptions(
        [
          toolCallTurn([
            { id: "c1", name: "slow", arguments: {} },
            { id: "c2", name: "slow", arguments: {} },
          ]),
          textTurn("never reached"),
        ],
        [slowTool],
      ),
    );
    const events = record(agent);

    await agent.prompt("go");

    expect(events.at(-1)).toMatchObject({ type: "runEnd", reason: "aborted" });
    const results = agent.messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.role === "toolResult" && m.isError)).toBe(true);
    expect(JSON.stringify(results[1])).toContain("Aborted");
  });

  it("cascades an external signal", async () => {
    const controller = new AbortController();
    const llm = createScriptedLLM([textTurn("hello")], {
      onTurn: () => controller.abort(),
    });
    const agent = new Agent({
      llm,
      model: TEST_MODEL,
      systemPrompt: "s",
      cwd: "/work",
      signal: controller.signal,
    });
    const events = record(agent);
    await agent.prompt("go");
    expect(events.at(-1)).toMatchObject({ reason: "aborted" });
  });
});

describe("tool execution", () => {
  it("rejects invalid arguments without executing the tool", async () => {
    const tool = echoTool();
    const agent = new Agent(
      baseOptions(
        [
          toolCallTurn([{ id: "c1", name: "echo", arguments: { wrong: 1 } }]),
          textTurn("recovered"),
        ],
        [tool],
      ),
    );
    const events = record(agent);

    await agent.prompt("go");

    expect(tool.calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toContain("Invalid arguments");
    expect(contentText(toolEnd.result.content)).toContain("/value is required");
    expect(toolEnd.result.details?.validationErrors).toBeDefined();
    // The run keeps going so the model can correct itself.
    expect(agent.finalText()).toBe("recovered");
  });

  it("reports unknown tools", async () => {
    const agent = new Agent(
      baseOptions(
        [toolCallTurn([{ id: "c1", name: "nope", arguments: {} }]), textTurn("ok")],
        [echoTool()],
      ),
    );
    const events = record(agent);
    await agent.prompt("go");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toContain('Unknown tool "nope"');
    expect(contentText(toolEnd.result.content)).toContain("echo");
  });

  it("converts a rejected tool into an error result", async () => {
    const boom: Tool = {
      definition: { name: "boom", description: "throws", parameters: { type: "object" } },
      async execute(): Promise<ToolResult> {
        throw new Error("kaboom");
      },
    };
    const agent = new Agent(
      baseOptions(
        [toolCallTurn([{ id: "c1", name: "boom", arguments: {} }]), textTurn("ok")],
        [boom],
      ),
    );
    const events = record(agent);
    await agent.prompt("go");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toContain("kaboom");
  });

  it("wires the execution context and forwards progress updates", async () => {
    let seen: ToolExecutionContext | undefined;
    const probe: Tool = {
      definition: { name: "probe", description: "reports ctx", parameters: { type: "object" } },
      async execute(_input, ctx): Promise<ToolResult> {
        seen = ctx;
        ctx.onUpdate({ text: "halfway", details: { pct: 50 } });
        return { content: [text("done")], details: { ok: true } };
      },
    };
    const agent = new Agent(
      baseOptions(
        [toolCallTurn([{ id: "c1", name: "probe", arguments: {} }]), textTurn("ok")],
        [probe],
      ),
    );
    const events = record(agent);

    await agent.prompt("go");

    expect(seen?.cwd).toBe("/work");
    expect(seen?.sessionId).toBe(agent.sessionId);
    expect(seen?.toolCallId).toBe("c1");
    expect(typeof seen?.requestPermission).toBe("function");
    const update = events.find((e) => e.type === "toolUpdate");
    expect(update).toMatchObject({
      type: "toolUpdate",
      toolCallId: "c1",
      update: { text: "halfway" },
    });
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.details).toEqual({ ok: true });
  });

  it("runs tool calls sequentially by default and in parallel on request", async () => {
    const order: string[] = [];
    const makeTool = (name: string): Tool => ({
      definition: { name, description: name, parameters: { type: "object" } },
      async execute(): Promise<ToolResult> {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:end`);
        return { content: [text(name)] };
      },
    });
    const calls = [
      { id: "c1", name: "one", arguments: {} },
      { id: "c2", name: "two", arguments: {} },
    ];

    const sequential = new Agent(
      baseOptions([toolCallTurn(calls), textTurn("ok")], [makeTool("one"), makeTool("two")]),
    );
    await sequential.prompt("go");
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);

    order.length = 0;
    const parallel = new Agent({
      ...baseOptions([toolCallTurn(calls), textTurn("ok")], [makeTool("one"), makeTool("two")]),
      parallelTools: true,
    });
    await parallel.prompt("go");
    expect(order).toEqual(["one:start", "two:start", "one:end", "two:end"]);
  });
});

describe("permissions in the loop", () => {
  it("denies a tool call and feeds the reason back to the model", async () => {
    const tool = echoTool();
    const requester = vi.fn(
      async (): Promise<PermissionDecision> => ({
        requestId: "",
        behavior: "deny",
        message: "not allowed here",
      }),
    );
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]),
        textTurn("understood"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [tool],
      cwd: "/work",
      onPermissionAsk: requester,
    });
    const events = record(agent);

    await agent.prompt("go");

    expect(tool.calls).toHaveLength(0);
    expect(requester).toHaveBeenCalledTimes(1);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toBe("not allowed here");
    expect(types(events)).toContain("permissionRequest");
    expect(types(events)).toContain("permissionDecision");
  });

  it("persists an approved rule for the rest of the session", async () => {
    const tool = echoTool();
    const requester = vi.fn(
      async (): Promise<PermissionDecision> => ({
        requestId: "",
        behavior: "allow",
        persistRule: { tool: "echo", specifier: "*", action: "allow", scope: "session" },
      }),
    );
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]),
        toolCallTurn([{ id: "c2", name: "echo", arguments: { value: "b" } }]),
        textTurn("done"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [tool],
      cwd: "/work",
      onPermissionAsk: requester,
    });

    await agent.prompt("go");

    expect(tool.calls).toHaveLength(2);
    expect(requester).toHaveBeenCalledTimes(1);
    expect(agent.permissions.rules).toHaveLength(1);
  });

  it("blocks mutating tools while in plan mode", async () => {
    const tool = echoTool({ name: "write" });
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "write", arguments: { value: "x" } }]),
        textTurn("okay, planning instead"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [tool],
      cwd: "/work",
      permissions: { mode: "plan" },
    });
    const events = record(agent);

    await agent.prompt("go");

    expect(tool.calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toContain("Plan mode");
  });
});

describe("hooks", () => {
  it("mutates tool input before execution", async () => {
    const tool = echoTool();
    const hooks: AgentHooks = {
      beforeToolCall: (call) => ({ action: "allow", input: { ...call.input, value: "mutated" } }),
    };
    const agent = new Agent({
      ...baseOptions(
        [
          toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "original" } }]),
          textTurn("ok"),
        ],
        [tool],
      ),
      hooks,
    });
    const events = record(agent);

    await agent.prompt("go");

    expect(tool.calls).toEqual([{ value: "mutated" }]);
    const toolStart = events.find((e) => e.type === "toolStart");
    expect(toolStart).toMatchObject({ input: { value: "mutated" } });
  });

  it("blocks a tool call", async () => {
    const tool = echoTool();
    const hooks: AgentHooks = {
      beforeToolCall: () => ({ action: "block", reason: "policy says no", details: { rule: "x" } }),
    };
    const agent = new Agent({
      ...baseOptions(
        [toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]), textTurn("ok")],
        [tool],
      ),
      hooks,
    });
    const events = record(agent);

    await agent.prompt("go");

    expect(tool.calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toContain("policy says no");
    expect(toolEnd.result.details).toMatchObject({ blocked: true, rule: "x" });
  });

  it("replaces the result afterwards", async () => {
    const tool = echoTool();
    const hooks: AgentHooks = {
      afterToolCall: (_call, result) => ({ ...result, content: [text("redacted")] }),
    };
    const agent = new Agent({
      ...baseOptions(
        [
          toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "secret" } }]),
          textTurn("ok"),
        ],
        [tool],
      ),
      hooks,
    });
    await agent.prompt("go");
    const result = agent.messages.find((m) => m.role === "toolResult");
    expect(result && contentText(result.content)).toBe("redacted");
  });

  it("sees blocked and failed calls too", async () => {
    const after = vi.fn((_call: unknown, result: unknown) => result as never);
    const hooks: AgentHooks = {
      beforeToolCall: () => ({ action: "block", reason: "nope" }),
      afterToolCall: after,
    };
    const agent = new Agent({
      ...baseOptions(
        [toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]), textTurn("ok")],
        [echoTool()],
      ),
      hooks,
    });
    await agent.prompt("go");
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("sessions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-core-agent-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("persists the conversation as a chain of entries", async () => {
    const store = new JsonlSessionStore({ dir });
    const tool = echoTool();
    const agent = new Agent({
      ...baseOptions(
        [toolCallTurn([{ id: "c1", name: "echo", arguments: { value: "a" } }]), textTurn("done")],
        [tool],
      ),
      sessionStore: store,
      sessionId: "run-1",
      title: "test run",
    });

    await agent.prompt("go");

    const entries = await store.entries("run-1");
    expect(entries.map((e) => e.kind)).toEqual(["message", "message", "message", "message"]);
    expect(entries[0]?.parentId).toBeNull();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.parentId).toBe(entries[i - 1]?.id);
    }
    expect((await store.open("run-1")).title).toBe("test run");
    expect(agent.leafEntryId).toBe(entries.at(-1)?.id);
  });

  it("resumes a session and keeps appending to the same branch", async () => {
    const store = new MemorySessionStore();
    const first = new Agent({
      ...baseOptions([textTurn("first answer")]),
      sessionStore: store,
      sessionId: "s1",
    });
    await first.prompt("hello");

    const resumed = await Agent.resume({
      ...baseOptions([textTurn("second answer")]),
      sessionStore: store,
      sessionId: "s1",
    });
    expect(resumed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    await resumed.prompt("again");
    expect(resumed.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const entries = await store.entries("s1");
    expect(entries).toHaveLength(4);
    expect(entries[2]?.parentId).toBe(entries[1]?.id);
  });

  it("branches when resuming from an older entry", async () => {
    const store = new MemorySessionStore();
    const first = new Agent({
      ...baseOptions([textTurn("answer one"), textTurn("answer two")]),
      sessionStore: store,
      sessionId: "s1",
    });
    await first.prompt("question one");
    await first.prompt("question two");

    const entries = await store.entries("s1");
    expect(entries).toHaveLength(4);
    const branchPoint = entries[1]!.id;

    const branched = await Agent.resume({
      ...baseOptions([textTurn("alternative answer")]),
      sessionStore: store,
      sessionId: "s1",
      leafId: branchPoint,
    });
    expect(branched.messages).toHaveLength(2);
    await branched.prompt("a different follow-up");

    const all = await store.entries("s1");
    expect(all).toHaveLength(6);
    expect(all[4]?.parentId).toBe(branchPoint);

    const original = await store.branch("s1", all[3]!.id);
    const alternative = await store.branch("s1", all[5]!.id);
    expect(original.map((e) => e.id)).toEqual(entries.map((e) => e.id));
    expect(alternative.map((e) => e.id)).toEqual([
      entries[0]!.id,
      entries[1]!.id,
      all[4]!.id,
      all[5]!.id,
    ]);
  });

  it("works without a session store", async () => {
    const agent = new Agent(baseOptions([textTurn("no persistence")]));
    await agent.prompt("hi");
    expect(agent.finalText()).toBe("no persistence");
  });

  it("createAgent wires a JSONL store from a directory", async () => {
    const agent = createAgent({
      ...baseOptions([textTurn("stored")]),
      sessionDir: dir,
      sessionId: "s2",
    });
    await agent.prompt("hi");
    const entries = await new JsonlSessionStore({ dir }).entries("s2");
    expect(entries).toHaveLength(2);
  });
});

describe("model and state accessors", () => {
  it("exposes and updates the model", async () => {
    const store = new MemorySessionStore();
    const agent = new Agent({
      ...baseOptions([textTurn("ok")]),
      sessionStore: store,
      sessionId: "s1",
    });
    expect(agent.model).toBe(TEST_MODEL);
    await agent.prompt("hi");

    const other = { ...TEST_MODEL, id: "test/other", model: "other" };
    agent.setModel(other);
    expect(agent.model.id).toBe("test/other");

    agent.setThinking("high");
    expect(agent.thinking).toBe("high");
    agent.setPermissionMode("acceptEdits");
    expect(agent.permissionMode).toBe("acceptEdits");
  });

  it("never lets a throwing listener break a run", async () => {
    const agent = new Agent(baseOptions([textTurn("fine")]));
    agent.subscribe(() => {
      throw new Error("bad listener");
    });
    const seen: AgentEvent[] = [];
    agent.subscribe((event) => seen.push(event));

    await agent.prompt("hi");
    expect(seen.at(-1)).toMatchObject({ type: "runEnd", reason: "completed" });
  });

  it("unsubscribes cleanly", async () => {
    const agent = new Agent(baseOptions([textTurn("fine")]));
    const seen: AgentEvent[] = [];
    const off = agent.subscribe((event) => seen.push(event));
    off();
    await agent.prompt("hi");
    expect(seen).toHaveLength(0);
  });
});

describe("compaction inside the loop", () => {
  const filler = (label: string): Message => ({
    role: "user",
    content: [text(`${label} ${"x".repeat(2_000)}`)],
    timestamp: 1,
  });

  it("auto-compacts before a turn once the window fills", async () => {
    const tinyModel = { ...TEST_MODEL, contextWindow: 1_200 };
    const llm = createScriptedLLM([
      textTurn("## Goal\ncompacted goal\n\n## Next steps\nkeep going"),
      textTurn("after compaction"),
    ]);
    const store = new MemorySessionStore();
    const agent = new Agent({
      llm,
      model: tinyModel,
      systemPrompt: "s",
      cwd: "/work",
      sessionStore: store,
      sessionId: "s1",
      permissions: { mode: "yolo" },
      compaction: { reserveTokens: 100, keepRecentTokens: 200 },
      messages: [filler("one"), filler("two"), filler("three")],
    });
    const events = record(agent);

    await agent.prompt("what next?");

    const kinds = types(events);
    expect(kinds).toContain("compactionStart");
    expect(kinds).toContain("compactionEnd");
    const end = events.find((e) => e.type === "compactionEnd");
    if (end?.type !== "compactionEnd") throw new Error("missing compactionEnd");
    expect(end.summary).toContain("compacted goal");
    expect(end.tokensAfter).toBeLessThan(end.tokensBefore);

    expect(JSON.stringify(agent.messages[0])).toContain("compacted-history");
    expect(agent.finalText()).toBe("after compaction");

    const entries = await store.entries("s1");
    const compaction = entries.find((e) => e.kind === "compaction");
    expect(compaction).toBeDefined();
    if (compaction?.kind !== "compaction") throw new Error("wrong kind");
    expect(compaction.summary).toContain("compacted goal");
    expect(compaction.upToId).toBeTruthy();
  });

  it("does not compact while the window has room", async () => {
    const agent = new Agent(baseOptions([textTurn("no need")]));
    const events = record(agent);
    await agent.prompt("hi");
    expect(types(events)).not.toContain("compactionStart");
  });

  it("supports manual compaction and refuses while running", async () => {
    const llm = createScriptedLLM([
      textTurn("first"),
      textTurn("## Goal\nmanual summary"),
      textTurn("second"),
    ]);
    const agent = new Agent({
      llm,
      model: TEST_MODEL,
      systemPrompt: "s",
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { keepRecentTokens: 10 },
      messages: [filler("one"), filler("two")],
    });

    await agent.prompt("go");
    const before = agent.messages.length;
    await expect(agent.compact()).resolves.toBe(true);
    expect(agent.messages.length).toBeLessThan(before);
    expect(JSON.stringify(agent.messages[0])).toContain("manual summary");

    const running = agent.prompt("again");
    await expect(agent.compact()).rejects.toThrow(/while the agent is running/);
    await running;
  });

  it("reports a compaction failure as a notice without breaking the run", async () => {
    const tinyModel = { ...TEST_MODEL, contextWindow: 1_200 };
    const llm = createScriptedLLM([
      [
        { type: "start", model: "test-model" },
        {
          type: "error",
          error: { kind: "network", message: "summarizer down" },
          message: {
            role: "assistant",
            content: [],
            model: "test-model",
            usage: usage(0, 0),
            stopReason: "error",
            errorMessage: "summarizer down",
            timestamp: 1,
          },
        },
      ],
      textTurn("continued anyway"),
    ]);
    const agent = new Agent({
      llm,
      model: tinyModel,
      systemPrompt: "s",
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { reserveTokens: 100, keepRecentTokens: 200 },
      messages: [filler("one"), filler("two"), filler("three")],
    });
    const events = record(agent);

    await agent.prompt("go");

    expect(events.some((e) => e.type === "notice" && e.text.includes("Compaction failed"))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ reason: "completed" });
    expect(agent.finalText()).toBe("continued anyway");
  });

  it("can be disabled", async () => {
    const tinyModel = { ...TEST_MODEL, contextWindow: 1_200 };
    const agent = new Agent({
      llm: createScriptedLLM([textTurn("no compaction")]),
      model: tinyModel,
      systemPrompt: "s",
      cwd: "/work",
      permissions: { mode: "yolo" },
      compaction: { enabled: false },
      messages: [filler("one"), filler("two"), filler("three")],
    });
    const events = record(agent);
    await agent.prompt("go");
    expect(types(events)).not.toContain("compactionStart");
  });
});

describe("stale todos", () => {
  /** Drive one run that leaves `text` in progress, and collect its events. */
  async function runLeavingTodo(status: "inProgress" | "done") {
    const todo = createTodoTool();
    const agent = createAgent({
      ...baseOptions(
        [
          toolCallTurn([
            {
              id: "t1",
              name: "todo",
              arguments: { todos: [{ text: "Dispatch audit agents", status }] },
            },
          ]),
          textTurn("All done."),
        ],
        [todo],
      ),
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));
    await agent.prompt("audit the site");
    return { agent, events };
  }

  it("warns when a completed run leaves a todo in progress", async () => {
    // Regression: a run that finished with an item still `inProgress` said
    // nothing, so the list the user watches reported finished work as stalled.
    const { events } = await runLeavingTodo("inProgress");

    const notice = events.find(
      (event) => event.type === "notice" && event.text.includes("still marked in progress"),
    );
    expect(notice).toBeDefined();
    expect(notice && notice.type === "notice" && notice.level).toBe("warn");
    // The warning must precede runEnd, so a UI rendering events in order shows
    // it against the run that caused it.
    expect(events.indexOf(notice!)).toBeLessThan(
      events.findIndex((event) => event.type === "runEnd"),
    );
  });

  it("says nothing when every todo was closed out", async () => {
    const { events } = await runLeavingTodo("done");
    expect(
      events.some(
        (event) => event.type === "notice" && event.text.includes("still marked in progress"),
      ),
    ).toBe(false);
  });

  it("reminds the model on the next run so it can correct the list", async () => {
    const { agent } = await runLeavingTodo("inProgress");
    await agent.prompt("carry on");

    const reminder = agent.messages.find(
      (message) =>
        message.role === "user" &&
        contentText(message.content).includes("was left in progress when the previous run ended"),
    );
    expect(reminder).toBeDefined();
  });

  it("stops reminding once the list is corrected, and never repeats within a run", async () => {
    // The reminder recurs while the condition does — a list still wrong after
    // another run is still worth flagging — but it must clear the moment the
    // model closes the item out, or it becomes nagging the user cannot silence.
    const todo = createTodoTool();
    const agent = createAgent({
      ...baseOptions(
        [
          toolCallTurn([
            {
              id: "t1",
              name: "todo",
              arguments: { todos: [{ text: "Dispatch audit agents", status: "inProgress" }] },
            },
          ]),
          textTurn("stopping early"),
          toolCallTurn([
            {
              id: "t2",
              name: "todo",
              arguments: { todos: [{ text: "Dispatch audit agents", status: "done" }] },
            },
          ]),
          textTurn("now finished"),
          textTurn("nothing left to do"),
        ],
        [todo],
      ),
    });

    await agent.prompt("audit the site");
    await agent.prompt("carry on");

    const afterCorrection: AgentEvent[] = [];
    agent.subscribe((event) => afterCorrection.push(event));
    await agent.prompt("anything else?");

    const reminders = agent.messages.filter(
      (message) =>
        message.role === "user" &&
        contentText(message.content).includes("was left in progress when the previous run ended"),
    );
    // One for the run that ended stale, and none afterwards.
    expect(reminders).toHaveLength(1);
    expect(
      afterCorrection.some(
        (event) => event.type === "notice" && event.text.includes("still marked in progress"),
      ),
    ).toBe(false);
  });
});

describe("agent.on", () => {
  it("delivers only the requested event type, narrowed, and unsubscribes", async () => {
    const agent = createAgent({
      llm: createScriptedLLM([textTurn("hello"), textTurn("again")]),
      model: TEST_MODEL,
      systemPrompt: "test",
      cwd: "/tmp",
    });
    const ends: string[] = [];
    const all: string[] = [];
    agent.subscribe((event) => all.push(event.type));
    const off = agent.on("runEnd", (event) => ends.push(event.reason));
    await agent.prompt("hi");
    expect(ends).toEqual(["completed"]);
    expect(all.length).toBeGreaterThan(ends.length);
    off();
    await agent.prompt("again");
    expect(ends).toEqual(["completed"]);
  });
});
