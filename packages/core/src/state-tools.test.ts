import type { AgentEvent, PermissionDecision, PermissionRequest } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { MemorySessionStore } from "./session/memory-store.js";
import { createPlanTool, createTodoTool } from "./state-tools.js";
import { createScriptedLLM, TEST_MODEL, textTurn, toolCallTurn } from "./test-helpers/fake-llm.js";
import { contentText } from "./util/content.js";

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

describe("createTodoTool", () => {
  it("stores the list, emits todoUpdate and writes a state entry", async () => {
    const store = new MemorySessionStore();
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([
          {
            id: "c1",
            name: "todo",
            arguments: {
              todos: [
                { text: "design", status: "done" },
                { text: "build", status: "inProgress" },
                { text: "ship", status: "pending" },
              ],
            },
          },
        ]),
        textTurn("tracked"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createTodoTool()],
      cwd: "/work",
      sessionStore: store,
      sessionId: "s1",
    });
    const events = collect(agent);

    await agent.prompt("plan the work");

    expect(agent.todos.map((t) => t.text)).toEqual(["design", "build", "ship"]);
    expect(agent.todos.every((t) => t.id.length > 0)).toBe(true);

    const update = events.find((e) => e.type === "todoUpdate");
    if (update?.type !== "todoUpdate") throw new Error("missing todoUpdate");
    expect(update.todos).toHaveLength(3);

    const stateEntry = (await store.entries("s1")).find((e) => e.kind === "state");
    if (stateEntry?.kind !== "state") throw new Error("missing state entry");
    expect(stateEntry.todos).toHaveLength(3);

    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toContain("1/3 done");
  });

  it("replaces the whole list on each call and preserves supplied ids", async () => {
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([
          {
            id: "c1",
            name: "todo",
            arguments: { todos: [{ id: "keep", text: "a", status: "pending" }] },
          },
        ]),
        toolCallTurn([
          {
            id: "c2",
            name: "todo",
            arguments: { todos: [{ id: "keep", text: "a", status: "done" }] },
          },
        ]),
        textTurn("ok"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createTodoTool()],
      cwd: "/work",
    });

    await agent.prompt("go");
    expect(agent.todos).toEqual([{ id: "keep", text: "a", status: "done" }]);
  });

  it("rejects a bad status through schema validation without touching state", async () => {
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([
          { id: "c1", name: "todo", arguments: { todos: [{ text: "a", status: "wrong" }] } },
        ]),
        textTurn("ok"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createTodoTool()],
      cwd: "/work",
    });
    const events = collect(agent);

    await agent.prompt("go");

    expect(agent.todos).toHaveLength(0);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toContain("Invalid arguments");
  });

  it("rejects more than one in-progress item", async () => {
    const agent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([
          {
            id: "c1",
            name: "todo",
            arguments: {
              todos: [
                { text: "a", status: "inProgress" },
                { text: "b", status: "inProgress" },
              ],
            },
          },
        ]),
        textTurn("ok"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createTodoTool()],
      cwd: "/work",
    });
    const events = collect(agent);
    await agent.prompt("go");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toContain("at most one todo");
    expect(agent.todos).toHaveLength(0);
  });

  it("errors when it is not bound to an agent", async () => {
    const tool = createTodoTool();
    const result = await tool.execute(
      { todos: [] },
      {
        cwd: "/",
        signal: new AbortController().signal,
        requestPermission: async () => ({ requestId: "", behavior: "allow" }),
        onUpdate: () => undefined,
        sessionId: "s",
        toolCallId: "c",
      },
    );
    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain("not attached to an agent");
  });
});

describe("createPlanTool", () => {
  const planCall = (id = "c1") =>
    toolCallTurn([{ id, name: "plan", arguments: { plan: "1. do this\n2. do that" } }]);

  it("records a plan and emits planUpdate outside plan mode", async () => {
    const store = new MemorySessionStore();
    const agent = new Agent({
      llm: createScriptedLLM([planCall(), textTurn("noted")]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createPlanTool()],
      cwd: "/work",
      sessionStore: store,
      sessionId: "s1",
    });
    const events = collect(agent);

    await agent.prompt("plan it");

    expect(agent.plan).toContain("do this");
    const update = events.find((e) => e.type === "planUpdate");
    if (update?.type !== "planUpdate") throw new Error("missing planUpdate");
    expect(update.plan).toContain("do that");

    const stateEntry = (await store.entries("s1")).find(
      (e) => e.kind === "state" && e.plan !== undefined,
    );
    expect(stateEntry).toBeDefined();
    expect(agent.permissionMode).toBe("default");
  });

  it("leaves plan mode when the user approves", async () => {
    const requester = vi.fn(
      async (_request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> => ({
        requestId: "",
        behavior: "allow",
      }),
    );
    const agent = new Agent({
      llm: createScriptedLLM([planCall(), textTurn("executing")]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createPlanTool()],
      cwd: "/work",
      permissions: { mode: "plan" },
      onPermissionAsk: requester,
    });
    const events = collect(agent);

    await agent.prompt("plan it");

    expect(requester).toHaveBeenCalledTimes(1);
    expect(requester.mock.calls[0]?.[0]?.subject).toBe("exitPlanMode");
    expect(agent.permissionMode).toBe("default");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(false);
    expect(contentText(toolEnd.result.content)).toContain("approved");
  });

  it("stays in plan mode when the user rejects, and reports the feedback", async () => {
    const agent = new Agent({
      llm: createScriptedLLM([planCall(), textTurn("revising")]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createPlanTool()],
      cwd: "/work",
      permissions: { mode: "plan" },
      onPermissionAsk: async () => ({ requestId: "", behavior: "deny", message: "too broad" }),
    });
    const events = collect(agent);

    await agent.prompt("plan it");

    expect(agent.permissionMode).toBe("plan");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toContain("too broad");
  });

  it("switches to a configured mode on approval", async () => {
    const agent = new Agent({
      llm: createScriptedLLM([planCall(), textTurn("executing")]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createPlanTool({ approvedMode: "acceptEdits" })],
      cwd: "/work",
      permissions: { mode: "plan" },
      onPermissionAsk: async () => ({ requestId: "", behavior: "allow" }),
    });
    await agent.prompt("plan it");
    expect(agent.permissionMode).toBe("acceptEdits");
  });

  it("cannot be pre-approved by a blanket allow rule", async () => {
    const requester = vi.fn(
      async (): Promise<PermissionDecision> => ({ requestId: "", behavior: "deny" }),
    );
    const agent = new Agent({
      llm: createScriptedLLM([planCall(), textTurn("revising")]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createPlanTool()],
      cwd: "/work",
      permissions: {
        mode: "plan",
        rules: [{ tool: "*", specifier: "*", action: "allow", scope: "session" }],
      },
      onPermissionAsk: requester,
    });
    await agent.prompt("plan it");
    expect(requester).toHaveBeenCalledTimes(1);
    expect(agent.permissionMode).toBe("plan");
  });

  it("runs in plan mode even though other tools are blocked", async () => {
    const agent = new Agent({
      llm: createScriptedLLM([planCall(), textTurn("done")]),
      model: TEST_MODEL,
      systemPrompt: "s",
      tools: [createPlanTool(), createTodoTool()],
      cwd: "/work",
      permissions: { mode: "plan" },
      onPermissionAsk: async () => ({ requestId: "", behavior: "allow" }),
    });
    const events = collect(agent);
    await agent.prompt("plan it");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(false);
  });
});
