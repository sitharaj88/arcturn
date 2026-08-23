/**
 * Regression test for executing tool calls whose arguments were truncated.
 *
 * A response cut off by the output-token limit can still carry tool-call
 * arguments that parse — the provider layer completes a half-written JSON
 * object — so a call like `{"path":"x","content":"…","mode":"append"}` can
 * arrive as a schema-valid `{path, content}` with `mode` silently missing.
 * Running that overwrites a file the model meant to append to, so the loop
 * refuses the batch instead.
 */

import type { AssistantMessage, StreamEvent, Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { createScriptedLLM, TEST_MODEL, textTurn } from "./test-helpers/fake-llm.js";

/** A tool-call turn that ended because the model ran out of output tokens. */
function truncatedToolCallTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    model: TEST_MODEL.model,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "maxTokens",
    timestamp: Date.now(),
  };
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "toolCallStart", blockIndex: 0, id, name },
    { type: "toolCallDelta", blockIndex: 0, argumentsDelta: JSON.stringify(args) },
    { type: "toolCallEnd", blockIndex: 0, id, name, arguments: args },
    { type: "blockEnd", blockIndex: 0 },
    { type: "end", message },
  ];
}

function recordingTool(): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    definition: {
      name: "write",
      description: "Writes a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    async execute(input) {
      calls.push(input);
      return { content: [{ type: "text", text: "written" }] };
    },
  };
}

describe("tool calls truncated by the output limit", () => {
  it("does not execute them, and reports the reason to the model", async () => {
    const tool = recordingTool();
    const agent = new Agent({
      llm: createScriptedLLM([
        // Arguments parse, but `mode: "append"` was cut off before it arrived.
        truncatedToolCallTurn("c1", "write", { path: "/tmp/x", content: "data" }),
        textTurn("understood, retrying"),
      ]),
      model: TEST_MODEL,
      systemPrompt: "You are Arcturn.",
      tools: [tool],
      cwd: "/work",
      permissions: { mode: "yolo" },
    });

    const notices: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    await agent.prompt("write the file");

    expect(tool.calls).toEqual([]);
    const results = agent.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    const [result] = results;
    if (result?.role !== "toolResult") throw new Error("expected a tool result");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ truncatedArguments: true });
    expect(notices.join(" ")).toContain("output token limit");

    // The conversation stays well-formed, so the next turn can proceed.
    expect(agent.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(agent.finalText()).toBe("understood, retrying");
  });
});
