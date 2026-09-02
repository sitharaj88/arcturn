/**
 * Regression test for a turn that delivers nothing.
 *
 * Observed on 2026-09-02 in a `rag-setup` run: a write-lane agent reasoned for
 * 69,786 characters, closed its thinking with "Numbers coherent. Compose.",
 * and ended the turn — `stopReason: "endTurn"`, no text, no tool call, no
 * file. It was not truncation and not the turn ceiling; the model simply
 * skipped the act it had just decided on. The loop read that silence as a
 * finished answer and returned `completed`, and the step that depended on the
 * ADR built on a void.
 *
 * A turn like that now gets handed straight back, once.
 */

import type { AgentEvent, AssistantMessage, StreamEvent, Tool } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent.js";
import { producedNothingVisible, SILENT_TURN_NUDGE } from "./loop.js";
import { createScriptedLLM, TEST_MODEL, textTurn, usage } from "./test-helpers/fake-llm.js";

/**
 * A turn that reasons and then stops without saying or doing anything.
 *
 * @param reasoning - What the model thought before going quiet.
 * @param stopReason - `endTurn` for the observed glitch, `maxTokens` for
 *   reasoning that ate the whole output budget.
 */
function silentTurn(
  reasoning: string,
  stopReason: AssistantMessage["stopReason"] = "endTurn",
): StreamEvent[] {
  const message: AssistantMessage = {
    role: "assistant",
    content: reasoning === "" ? [] : [{ type: "thinking", thinking: reasoning }],
    model: TEST_MODEL.model,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
  return [
    { type: "start", model: TEST_MODEL.model },
    ...(reasoning === ""
      ? []
      : ([
          { type: "thinkingStart", blockIndex: 0 },
          { type: "thinkingDelta", blockIndex: 0, delta: reasoning },
          { type: "blockEnd", blockIndex: 0 },
        ] as StreamEvent[])),
    { type: "end", message },
  ];
}

/** A turn whose only text block is blank — output in shape, not in substance. */
function whitespaceTurn(): StreamEvent[] {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "   \n\t " }],
    model: TEST_MODEL.model,
    usage: usage(),
    stopReason: "endTurn",
    timestamp: Date.now(),
  };
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "textStart", blockIndex: 0 },
    { type: "textDelta", blockIndex: 0, delta: "   \n\t " },
    { type: "blockEnd", blockIndex: 0 },
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

function agentWith(script: StreamEvent[][], tools: Tool[] = []): Agent {
  return new Agent({
    llm: createScriptedLLM(script),
    model: TEST_MODEL,
    systemPrompt: "You are Arcturn.",
    tools,
    cwd: "/work",
    permissions: { mode: "yolo" },
  });
}

function nudges(agent: Agent): number {
  return agent.messages.filter(
    (message) =>
      message.role === "user" &&
      JSON.stringify(message.content).includes("ended without producing anything"),
  ).length;
}

describe("producedNothingVisible", () => {
  const message = (content: AssistantMessage["content"]): AssistantMessage => ({
    role: "assistant",
    content,
    model: TEST_MODEL.model,
    usage: usage(),
    stopReason: "endTurn",
    timestamp: Date.now(),
  });

  it("is true for no content at all", () => {
    expect(producedNothingVisible(message([]))).toBe(true);
  });

  it("is true for reasoning alone — thinking is not a deliverable", () => {
    expect(producedNothingVisible(message([{ type: "thinking", thinking: "Now write." }]))).toBe(
      true,
    );
  });

  it("is true for a blank text block", () => {
    expect(producedNothingVisible(message([{ type: "text", text: "  \n " }]))).toBe(true);
  });

  it("is false as soon as one character of text lands", () => {
    expect(producedNothingVisible(message([{ type: "text", text: "ok" }]))).toBe(false);
  });
});

describe("a turn that delivered nothing", () => {
  it("is handed back once, and the model then does the work it had decided on", async () => {
    const tool = writeTool();
    const agent = agentWith(
      [
        silentTurn("The ADR is settled. Now write."),
        [
          { type: "start", model: TEST_MODEL.model },
          { type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" },
          {
            type: "toolCallEnd",
            blockIndex: 0,
            id: "c1",
            name: "write",
            arguments: { path: "docs/adr.md", content: "# ADR" },
          },
          { type: "blockEnd", blockIndex: 0 },
          {
            type: "end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "c1",
                  name: "write",
                  arguments: { path: "docs/adr.md", content: "# ADR" },
                },
              ],
              model: TEST_MODEL.model,
              usage: usage(),
              stopReason: "toolCalls",
              timestamp: Date.now(),
            },
          },
        ],
        textTurn("ADR written to docs/adr.md"),
      ],
      [tool],
    );

    const notices: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });

    await agent.prompt("write the ADR");

    // The whole point: the file that would not have been written, is.
    expect(tool.calls).toEqual([{ path: "docs/adr.md", content: "# ADR" }]);
    expect(agent.finalText()).toBe("ADR written to docs/adr.md");
    expect(nudges(agent)).toBe(1);
    expect(notices.join(" ")).toContain("without any output");
  });

  it("does not tell the model what to answer, only that nothing arrived", () => {
    // The model had already decided what to do — it failed to deliver, not to
    // reason. A nudge that supplied content would be putting words in its
    // mouth and would corrupt whatever the step actually owed its caller.
    expect(SILENT_TURN_NUDGE).toContain("no text and no tool call");
    expect(SILENT_TURN_NUDGE).toContain("If the work is genuinely finished");
  });

  it("names the shape a silent turn usually died on: a whole file in one call", () => {
    // The commonest thing to go quiet on is a thirty-kilobyte document the
    // model meant to hand to a single `write`. Handing the turn back without
    // saying that gets the same silence again — which is exactly what four
    // real runs did. Telling it *how* to deliver is not telling it *what*.
    expect(SILENT_TURN_NUDGE).toContain("fill one section per edit");
  });

  it("gives up after a second silence rather than spending the whole budget", async () => {
    const agent = agentWith([silentTurn("thinking"), silentTurn("still thinking")]);
    const silences: Extract<AgentEvent, { type: "silentTurn" }>[] = [];
    agent.subscribe((event) => {
      if (event.type === "silentTurn") silences.push(event);
    });
    await agent.prompt("write the ADR");
    // Both silences are reported, and the report says which one was nudged:
    // that is the count a host needs to say "this model goes quiet, and the
    // nudge recovers it N% of the time".
    expect(silences).toEqual([
      { type: "silentTurn", turnIndex: 0, nudged: true, model: TEST_MODEL.id },
      { type: "silentTurn", turnIndex: 1, nudged: false, model: TEST_MODEL.id },
    ]);

    // One nudge, one retry, then the loop accepts the answer it is given.
    expect(nudges(agent)).toBe(1);
    expect(agent.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(agent.finalText()).toBe("");
  });

  it("nudges a turn whose reasoning consumed the entire output budget", async () => {
    const agent = agentWith([silentTurn("...", "maxTokens"), textTurn("here is the answer")]);
    await agent.prompt("write the ADR");

    expect(nudges(agent)).toBe(1);
    expect(agent.finalText()).toBe("here is the answer");
  });

  it("nudges a turn that streamed no content whatsoever", async () => {
    const agent = agentWith([silentTurn(""), textTurn("recovered")]);
    await agent.prompt("write the ADR");

    expect(nudges(agent)).toBe(1);
    expect(agent.finalText()).toBe("recovered");
  });

  it("treats a whitespace-only answer as nothing", async () => {
    const agent = agentWith([whitespaceTurn(), textTurn("the real answer")]);
    await agent.prompt("write the ADR");

    expect(nudges(agent)).toBe(1);
    expect(agent.finalText()).toBe("the real answer");
  });

  it("does not spend the last permitted turn on a nudge", async () => {
    // A silence on the final turn used to become a turn-ceiling error after
    // the nudge — "raise maxTurns" for a model that emits nothing. The run
    // ends as what it is: a completed run that delivered nothing, which the
    // workflow's void gate then names correctly.
    const agent = new Agent({
      llm: createScriptedLLM([silentTurn("thinking"), textTurn("never reached")]),
      model: TEST_MODEL,
      systemPrompt: "You are Arcturn.",
      tools: [],
      cwd: "/work",
      permissions: { mode: "yolo" },
      maxTurns: 1,
    });
    const notices: string[] = [];
    agent.subscribe((event) => {
      if (event.type === "notice") notices.push(event.text);
    });
    await agent.prompt("write the ADR");
    expect(nudges(agent)).toBe(0);
    expect(agent.finalText()).toBe("");
    expect(notices.join(" ")).not.toContain("maximum of");
  });

  it("leaves a turn that said something alone", async () => {
    const agent = agentWith([textTurn("done")]);
    await agent.prompt("write the ADR");

    expect(nudges(agent)).toBe(0);
    expect(agent.finalText()).toBe("done");
  });

  it("re-arms after a productive turn, so a later silence is caught too", async () => {
    const tool = writeTool();
    const agent = agentWith(
      [
        silentTurn("first void"),
        [
          { type: "start", model: TEST_MODEL.model },
          { type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" },
          {
            type: "toolCallEnd",
            blockIndex: 0,
            id: "c1",
            name: "write",
            arguments: { path: "a.md", content: "x" },
          },
          { type: "blockEnd", blockIndex: 0 },
          {
            type: "end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "c1",
                  name: "write",
                  arguments: { path: "a.md", content: "x" },
                },
              ],
              model: TEST_MODEL.model,
              usage: usage(),
              stopReason: "toolCalls",
              timestamp: Date.now(),
            },
          },
        ],
        silentTurn("second void"),
        textTurn("finally"),
      ],
      [tool],
    );

    await agent.prompt("write the ADR");

    // Two separate glitches, two separate rescues — the once-only guard is
    // against consecutive silence, not against a long run having two bad turns.
    expect(nudges(agent)).toBe(2);
    expect(agent.finalText()).toBe("finally");
  });
});
