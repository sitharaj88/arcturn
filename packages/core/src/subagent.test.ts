import type { AgentEvent, Tool, ToolResult } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { LARGE_CONTENT_RULE } from "./large-content.js";
import { createSubagentTool } from "./subagent.js";
import { createScriptedLLM, TEST_MODEL, textTurn, toolCallTurn } from "./test-helpers/fake-llm.js";
import { contentText, text } from "./util/content.js";

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

function childAgent(script: Parameters<typeof createScriptedLLM>[0], tools: Tool[] = []): Agent {
  return new Agent({
    llm: createScriptedLLM(script),
    model: TEST_MODEL,
    systemPrompt: "You are a sub-agent.",
    tools,
    cwd: "/work",
    permissions: { mode: "yolo" },
  });
}

describe("createSubagentTool", () => {
  // Regression: a live run had the model invent `agent: "general"` because the
  // schema advertised a free-text `agent` field with nothing valid to put in
  // it — and the description itself used the word "general". An unusable
  // parameter must not be offered at all.
  it("omits the agent parameter entirely when no named agents exist", () => {
    const tool = createSubagentTool({ factory: () => ({}) as never });
    const properties = tool.definition.parameters.properties as Record<string, unknown>;
    expect(properties.agent).toBeUndefined();
    expect(JSON.stringify(tool.definition)).not.toContain("general");
  });

  it("advertises the agent parameter as an enum of the real names", () => {
    const tool = createSubagentTool({
      factory: () => ({}) as never,
      agentNames: ["reviewer", "tester"],
    });
    const properties = tool.definition.parameters.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >;
    expect(properties.agent?.enum).toEqual(["reviewer", "tester"]);
    // The names are inline, not behind a "see the system prompt" indirection.
    expect(properties.agent?.description).toContain("reviewer, tester");
  });

  it("runs a child agent and returns its final text", async () => {
    const factory = vi.fn(() => childAgent([textTurn("the answer is 42")]));
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([
          {
            id: "c1",
            name: "subagent",
            arguments: { task: "find the answer", description: "search" },
          },
        ]),
        textTurn("relayed"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "You are the parent.",
      tools: [createSubagentTool({ factory })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);

    await parent.prompt("delegate this");

    expect(factory).toHaveBeenCalledWith("find the answer", undefined);
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toBe("the answer is 42");
    expect(toolEnd.result.isError).toBe(false);
  });

  it("wraps the child's events on the parent stream", async () => {
    const child = childAgent(
      [toolCallTurn([{ id: "k1", name: "peek", arguments: {} }]), textTurn("child finished")],
      [
        {
          definition: { name: "peek", description: "peek", parameters: { type: "object" } },
          async execute(): Promise<ToolResult> {
            return { content: [text("peeked")] };
          },
        },
      ],
    );
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: { task: "look around" } }]),
        textTurn("done"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [createSubagentTool({ factory: () => child })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);

    await parent.prompt("go");

    const start = events.find((e) => e.type === "subagentStart");
    const end = events.find((e) => e.type === "subagentEnd");
    if (start?.type !== "subagentStart" || end?.type !== "subagentEnd") {
      throw new Error("missing subagent lifecycle events");
    }
    expect(start.task).toBe("look around");
    expect(end.agentId).toBe(start.agentId);
    expect(end.resultText).toBe("child finished");
    expect(end.isError).toBe(false);

    const wrapped = events.filter((e) => e.type === "subagentEvent");
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.every((e) => e.type === "subagentEvent" && e.agentId === start.agentId)).toBe(
      true,
    );

    const innerTypes = wrapped.map((e) => (e.type === "subagentEvent" ? e.event.type : ""));
    expect(innerTypes).toContain("runStart");
    expect(innerTypes).toContain("toolStart");
    expect(innerTypes).toContain("toolEnd");
    expect(innerTypes).toContain("runEnd");

    // Lifecycle ordering: start, then every child event, then end.
    const startIndex = events.indexOf(start);
    const endIndex = events.indexOf(end);
    expect(
      events.every((e, i) => e.type !== "subagentEvent" || (i > startIndex && i < endIndex)),
    ).toBe(true);
  });

  it("forwards the child's text as progress updates", async () => {
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: { task: "summarize" } }]),
        textTurn("done"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [createSubagentTool({ factory: () => childAgent([textTurn("partial result")]) })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);
    await parent.prompt("go");

    const update = events.find((e) => e.type === "toolUpdate");
    if (update?.type !== "toolUpdate") throw new Error("missing toolUpdate");
    expect(update.update.text).toBe("partial result");
  });

  it("marks a failed child run as an error result", async () => {
    const child = new Agent({
      llm: createScriptedLLM([
        [
          { type: "start", model: "test-model" },
          {
            type: "error",
            error: { kind: "network", message: "child exploded" },
            message: {
              role: "assistant",
              content: [],
              model: "test-model",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "error",
              errorMessage: "child exploded",
              timestamp: 1,
            },
          },
        ],
      ]),
      model: TEST_MODEL,
      systemPrompt: "child",
      cwd: "/work",
    });
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: { task: "do it" } }]),
        textTurn("recovered"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [createSubagentTool({ factory: () => child })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);

    await parent.prompt("go");

    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toContain("child exploded");
    const end = events.find((e) => e.type === "subagentEnd");
    expect(end).toMatchObject({ isError: true });
  });

  it("cascades an abort from the parent to the child", async () => {
    let parent!: Agent;
    const child = childAgent([textTurn("never seen")]);
    const childEvents = collect(child);
    const slowChildFactory = () => {
      // Abort the parent as soon as the child starts its run.
      child.subscribe((event) => {
        if (event.type === "runStart") parent.abort();
      });
      return child;
    };
    parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: { task: "long job" } }]),
        textTurn("unreachable"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [createSubagentTool({ factory: slowChildFactory })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);

    await parent.prompt("go");

    expect(childEvents.at(-1)).toMatchObject({ type: "runEnd", reason: "aborted" });
    expect(events.at(-1)).toMatchObject({ type: "runEnd", reason: "aborted" });
  });

  it("reports a factory failure as an error result", async () => {
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: { task: "impossible" } }]),
        textTurn("ok"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [
        createSubagentTool({
          factory: () => {
            throw new Error("no budget left");
          },
        }),
      ],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);
    await parent.prompt("go");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(toolEnd.result.isError).toBe(true);
    expect(contentText(toolEnd.result.content)).toContain("no budget left");
  });

  it("briefs the child on writing large files, without disturbing its task", async () => {
    // A delegated child is where this bites hardest: it is usually the one
    // asked to *produce* the document, it reasons alone, and a turn it ends
    // without emitting the call reaches the parent as an empty result with no
    // explanation. So the rule travels with the task rather than depending on
    // whatever system prompt the host happened to hand the child.
    const child = childAgent([textTurn("done")]);
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: { task: "write the ADR" } }]),
        textTurn("ok"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [createSubagentTool({ factory: () => child })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });

    await parent.prompt("go");

    const brief = contentText(child.messages[0]?.content ?? []);
    expect(brief).toContain("write the ADR");
    expect(brief).toContain(LARGE_CONTENT_RULE);
    // The task comes first and is untouched — the rule is an appendix to it,
    // never a preamble the child has to read past to find its instructions.
    expect(brief.startsWith("write the ADR")).toBe(true);
  });

  it("rejects an empty task through schema validation", async () => {
    const parent = new Agent({
      llm: createScriptedLLM([
        toolCallTurn([{ id: "c1", name: "subagent", arguments: {} }]),
        textTurn("ok"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "parent",
      tools: [createSubagentTool({ factory: () => childAgent([textTurn("x")]) })],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });
    const events = collect(parent);
    await parent.prompt("go");
    const toolEnd = events.find((e) => e.type === "toolEnd");
    if (toolEnd?.type !== "toolEnd") throw new Error("missing toolEnd");
    expect(contentText(toolEnd.result.content)).toContain("/task is required");
  });
});
