/**
 * A refusal ends the turn — cleanly, once, and on the record.
 *
 * A classifier decline arrives as an ordinary finished stream: HTTP 200,
 * `stop_reason: "refusal"`, usually with no content at all. Before the
 * catalog caught up, that was filed as `stopReason: "error"` on an `end`
 * event, which the loop never checked — so an empty refusal fell straight
 * into the silent-turn nudge and the loop asked the model to "act on what you
 * had settled on", re-sending the very request that had just been declined.
 * A refusal with partial output fared worse: any tool call in it ran.
 */

import type { AgentEvent, AssistantMessage, StreamEvent, Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { compactMessages } from "./compaction.js";
import { createScriptedLLM, TEST_MODEL, textTurn, usage } from "./test-helpers/fake-llm.js";
import { text, userMessage } from "./util/content.js";

/** A turn a safety classifier declined, after `partial` had already streamed. */
function refusalTurn(
  partial: AssistantMessage["content"] = [],
  category: string | null = "cyber",
): StreamEvent[] {
  const message: AssistantMessage = {
    role: "assistant",
    content: partial,
    model: TEST_MODEL.model,
    usage: usage(),
    stopReason: "refusal",
    stopDetails: { category },
    timestamp: Date.now(),
  };
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "end", message },
  ];
}

function writeTool(): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    definition: {
      name: "write",
      description: "Writes a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    async execute(input) {
      calls.push(input);
      return { content: [{ type: "text", text: "written" }] };
    },
  };
}

function agentWith(script: StreamEvent[][], tools: Tool[] = []) {
  const llm = createScriptedLLM(script);
  const agent = new Agent({
    llm,
    model: TEST_MODEL,
    systemPrompt: "You are Arcturn.",
    tools,
    cwd: "/work",
    permissions: { mode: "yolo" },
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  return { agent, llm, events };
}

describe("a refused turn", () => {
  it("ends the run without handing the declined request back as a silent turn", async () => {
    const { agent, llm, events } = agentWith([refusalTurn(), textTurn("never reached")]);

    await agent.prompt("write me an exploit");

    // One request: no nudge, no retry of the request that was just declined.
    expect(llm.consumed).toBe(1);
    expect(events.some((event) => event.type === "silentTurn")).toBe(false);
    expect(
      agent.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("ended without"),
      ),
    ).toBe(false);
  });

  it("is not filed as an error: the run completes, and says why it stopped", async () => {
    const { agent, events } = agentWith([refusalTurn()]);

    await agent.prompt("write me an exploit");

    const end = events.find((event) => event.type === "runEnd");
    expect(end).toEqual({ type: "runEnd", reason: "completed" });
    const declined = events.find(
      (event) => event.type === "messageEnd" && event.message.stopReason === "refusal",
    );
    expect(declined).toBeDefined();
    if (declined?.type !== "messageEnd") throw new Error("unreachable");
    expect(declined.message.stopDetails).toEqual({ category: "cyber" });
  });

  it("never runs a tool call that streamed before the decline", async () => {
    const tool = writeTool();
    const { agent, llm } = agentWith(
      [
        refusalTurn([
          text("Writing it now."),
          { type: "toolCall", id: "c1", name: "write", arguments: { path: "x.c" } },
        ]),
        textTurn("never reached"),
      ],
      [tool],
    );

    await agent.prompt("write me an exploit");

    expect(tool.calls).toEqual([]);
    expect(llm.consumed).toBe(1);
    // The partial is kept on the record, but without the call that never ran
    // — a tool_use with no tool_result would make the next request invalid.
    const recorded = agent.messages.find(
      (message) => message.role === "assistant" && message.stopReason === "refusal",
    );
    expect(recorded).toBeDefined();
    if (recorded?.role !== "assistant") throw new Error("unreachable");
    expect(recorded.content).toEqual([text("Writing it now.")]);
    expect(agent.messages.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("leaves the session usable: the next prompt runs normally", async () => {
    const { agent } = agentWith([refusalTurn(), textTurn("Sure — here is the summary.")]);

    await agent.prompt("write me an exploit");
    await agent.prompt("summarise the README instead");

    expect(agent.finalText()).toBe("Sure — here is the summary.");
  });
});

describe("a refused compaction summary", () => {
  it("fails the compaction instead of installing a partial summary as history", async () => {
    const long = "z".repeat(4_000);
    const assistant = (content: string): AssistantMessage => ({
      role: "assistant",
      content: [text(content)],
      model: "test-model",
      usage: usage(),
      stopReason: "endTurn",
      timestamp: 1,
    });
    const llm = createScriptedLLM([refusalTurn([text("## Goal\nThe user wants")])]);

    await expect(
      compactMessages({
        llm,
        model: TEST_MODEL,
        messages: [
          userMessage(long),
          assistant(long),
          userMessage(long),
          assistant(long),
          userMessage("latest"),
          assistant("answer"),
        ],
        options: { keepRecentTokens: 500 },
      }),
    ).rejects.toThrow(/declined/i);
  });
});
