import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../serve/engine.js";
import {
  type ChatState,
  initialChatState,
  MAX_BLOCKS,
  reduceChat,
  type ToolBlock,
  toggleBlock,
  toViewModel,
} from "./chat-state.js";

function run(events: AgentEvent[], from: ChatState = initialChatState): ChatState {
  return events.reduce(reduceChat, from);
}

function tools(state: ChatState): ToolBlock[] {
  return state.blocks.filter((block): block is ToolBlock => block.kind === "tool");
}

function texts(state: ChatState): string[] {
  return state.blocks.filter((block) => block.kind === "text").map((block) => block.text);
}

const userPrompt: AgentEvent = {
  type: "runStart",
  sessionId: "s1",
  prompt: { role: "user", content: [{ type: "text", text: "list the files" }], timestamp: 1 },
};

describe("reduceChat — run lifecycle", () => {
  it("starts a run: the prompt is echoed and the session is marked running", () => {
    const state = run([userPrompt]);
    expect(state.running).toBe(true);
    expect(state.blocks[0]).toMatchObject({ kind: "user", text: "list the files" });
  });

  it("ends a run and stops running", () => {
    const state = run([userPrompt, { type: "runEnd", reason: "completed" }]);
    expect(state.running).toBe(false);
    expect(state.lastError).toBeUndefined();
  });

  it("records an errored run without throwing a stack at the user", () => {
    const state = run([
      userPrompt,
      { type: "runEnd", reason: "error", errorMessage: "model overloaded" },
    ]);
    expect(state.running).toBe(false);
    expect(state.lastError).toBe("model overloaded");
    expect(state.blocks.at(-1)).toMatchObject({ kind: "notice", level: "error" });
  });

  it("notes an aborted run", () => {
    const state = run([userPrompt, { type: "runEnd", reason: "aborted" }]);
    expect(state.blocks.at(-1)).toMatchObject({
      kind: "notice",
      text: expect.stringMatching(/abort/i),
    });
  });

  it("returns the same state object for an event that changes nothing", () => {
    const state = run([userPrompt]);
    expect(reduceChat(state, { type: "turnStart", turnIndex: 0 })).toBe(state);
    expect(reduceChat(state, { type: "compactionStart" })).toBe(state);
    expect(reduceChat(state, { type: "contextEdit", elidedCount: 2, charsSaved: 40 })).toBe(state);
  });
});

describe("reduceChat — streamed assistant text", () => {
  it("appends deltas into one growing text block", () => {
    const state = run([
      userPrompt,
      { type: "messageStream", event: { type: "textStart", blockIndex: 0 } },
      { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "Hel" } },
      { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "lo" } },
    ]);
    expect(texts(state)).toEqual(["Hello"]);
  });

  it("keeps two concurrent blocks apart by blockIndex", () => {
    const state = run([
      { type: "messageStream", event: { type: "textStart", blockIndex: 0 } },
      { type: "messageStream", event: { type: "textStart", blockIndex: 2 } },
      { type: "messageStream", event: { type: "textDelta", blockIndex: 2, delta: "second" } },
      { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "first" } },
    ]);
    expect(texts(state)).toEqual(["first", "second"]);
  });

  it("records the model the stream announced", () => {
    const state = run([{ type: "messageStream", event: { type: "start", model: "anthropic/x" } }]);
    expect(state.model).toBe("anthropic/x");
  });

  it("collapses thinking by default", () => {
    const state = run([
      { type: "messageStream", event: { type: "thinkingStart", blockIndex: 0 } },
      { type: "messageStream", event: { type: "thinkingDelta", blockIndex: 0, delta: "hmm" } },
    ]);
    expect(state.blocks[0]).toMatchObject({ kind: "thinking", text: "hmm", collapsed: true });
  });

  it("does not duplicate streamed content when messageEnd repeats it", () => {
    const state = run([
      { type: "messageStream", event: { type: "textStart", blockIndex: 0 } },
      { type: "messageStream", event: { type: "textDelta", blockIndex: 0, delta: "Hello" } },
      {
        type: "messageEnd",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "m",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "endTurn",
          timestamp: 1,
        },
      },
    ]);
    expect(texts(state)).toEqual(["Hello"]);
  });

  it("renders a non-streamed message from messageEnd alone", () => {
    const state = run([
      {
        type: "messageEnd",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "quietly" },
            { type: "text", text: "the answer" },
          ],
          model: "m",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "endTurn",
          timestamp: 1,
        },
      },
    ]);
    expect(texts(state)).toEqual(["the answer"]);
    expect(state.blocks[0]).toMatchObject({ kind: "thinking", collapsed: true });
  });
});

describe("reduceChat — tool calls", () => {
  it("shows arguments as they stream, before the call is complete", () => {
    const state = run([
      {
        type: "messageStream",
        event: { type: "toolCallStart", blockIndex: 0, id: "call-1", name: "bash" },
      },
      {
        type: "messageStream",
        event: { type: "toolCallDelta", blockIndex: 0, argumentsDelta: '{"command":"ls ' },
      },
      {
        type: "messageStream",
        event: { type: "toolCallDelta", blockIndex: 0, argumentsDelta: '-la"}' },
      },
    ]);
    const [tool] = tools(state);
    expect(tool?.name).toBe("bash");
    expect(tool?.argsText).toBe('{"command":"ls -la"}');
    expect(tool?.argsComplete).toBe(false);
    expect(tool?.collapsed).toBe(true);
  });

  it("merges the streamed row with the toolStart for the same call id", () => {
    const state = run([
      {
        type: "messageStream",
        event: { type: "toolCallStart", blockIndex: 0, id: "call-1", name: "bash" },
      },
      { type: "toolStart", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
    ]);
    expect(tools(state)).toHaveLength(1);
    expect(tools(state)[0]).toMatchObject({ status: "running", argsComplete: true });
  });

  it("streams tool progress and then the result", () => {
    const state = run([
      { type: "toolStart", toolCallId: "c", toolName: "bash", input: {} },
      { type: "toolUpdate", toolCallId: "c", update: { text: "line one\n" } },
      { type: "toolUpdate", toolCallId: "c", update: { text: "line two\n" } },
      {
        type: "toolEnd",
        toolCallId: "c",
        result: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 2,
        },
      },
    ]);
    expect(tools(state)[0]).toMatchObject({
      progress: "line one\nline two\n",
      result: "done",
      status: "ok",
    });
  });

  it("marks a failed tool call as an error", () => {
    const state = run([
      { type: "toolStart", toolCallId: "c", toolName: "bash", input: {} },
      {
        type: "toolEnd",
        toolCallId: "c",
        result: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          content: [{ type: "text", text: "no such file" }],
          isError: true,
          timestamp: 2,
        },
      },
    ]);
    expect(tools(state)[0]?.status).toBe("error");
  });

  it("ignores a toolEnd for a call it never saw start", () => {
    const state = run([
      {
        type: "toolEnd",
        toolCallId: "ghost",
        result: {
          role: "toolResult",
          toolCallId: "ghost",
          toolName: "bash",
          content: [],
          isError: false,
          timestamp: 2,
        },
      },
    ]);
    expect(tools(state)).toHaveLength(0);
  });
});

describe("reduceChat — permissions, todos and plans", () => {
  const request = {
    id: "req-1",
    toolName: "bash",
    toolCallId: "c",
    subject: "rm -rf /tmp/x",
    description: "Run a shell command",
  };

  it("marks the waiting tool row and counts the pending request", () => {
    const state = run([
      { type: "toolStart", toolCallId: "c", toolName: "bash", input: {} },
      { type: "permissionRequest", request },
    ]);
    expect(state.pendingPermissions).toBe(1);
    expect(tools(state)[0]?.status).toBe("awaitingPermission");
  });

  it("clears the row when the decision arrives", () => {
    const state = run([
      { type: "toolStart", toolCallId: "c", toolName: "bash", input: {} },
      { type: "permissionRequest", request },
      { type: "permissionDecision", decision: { requestId: "req-1", behavior: "allow" } },
    ]);
    expect(state.pendingPermissions).toBe(0);
    expect(tools(state)[0]?.status).toBe("running");
  });

  it("marks a denied call as denied", () => {
    const state = run([
      { type: "toolStart", toolCallId: "c", toolName: "bash", input: {} },
      { type: "permissionRequest", request },
      { type: "permissionDecision", decision: { requestId: "req-1", behavior: "deny" } },
    ]);
    expect(tools(state)[0]?.status).toBe("denied");
  });

  it("renders todos and the plan", () => {
    const state = run([
      { type: "todoUpdate", todos: [{ id: "1", text: "ship it", status: "inProgress" }] },
      { type: "planUpdate", plan: "1. read 2. write" },
    ]);
    expect(state.todos).toEqual([{ id: "1", text: "ship it", status: "inProgress" }]);
    expect(state.plan).toBe("1. read 2. write");
  });

  it("surfaces engine notices verbatim", () => {
    const state = run([{ type: "notice", level: "warn", text: "context is 90% full" }]);
    expect(state.blocks[0]).toMatchObject({
      kind: "notice",
      level: "warn",
      text: "context is 90% full",
    });
  });
});

describe("toggleBlock", () => {
  it("expands a collapsed thinking block and leaves everything else alone", () => {
    const before = run([
      { type: "messageStream", event: { type: "thinkingStart", blockIndex: 0 } },
    ]);
    const id = before.blocks[0]?.id ?? "";
    const after = toggleBlock(before, id);
    expect(after.blocks[0]).toMatchObject({ collapsed: false });
    expect(toggleBlock(after, id).blocks[0]).toMatchObject({ collapsed: true });
  });

  it("is a no-op for an unknown id", () => {
    const state = run([userPrompt]);
    expect(toggleBlock(state, "nope")).toBe(state);
  });
});

describe("bounded growth", () => {
  it("keeps the transcript bounded so a long session cannot grow without limit", () => {
    let state = initialChatState;
    for (let i = 0; i < MAX_BLOCKS + 50; i += 1) {
      state = reduceChat(state, { type: "notice", level: "info", text: `n${String(i)}` });
    }
    expect(state.blocks).toHaveLength(MAX_BLOCKS);
    expect(state.blocks.at(-1)).toMatchObject({ text: `n${String(MAX_BLOCKS + 49)}` });
  });

  it("truncates a huge tool result rather than posting megabytes to the webview", () => {
    const state = run([
      { type: "toolStart", toolCallId: "c", toolName: "bash", input: {} },
      {
        type: "toolEnd",
        toolCallId: "c",
        result: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "bash",
          content: [{ type: "text", text: "x".repeat(200_000) }],
          isError: false,
          timestamp: 2,
        },
      },
    ]);
    const result = tools(state)[0]?.result ?? "";
    expect(result.length).toBeLessThan(20_000);
    expect(result).toMatch(/truncated/);
  });
});

describe("toViewModel", () => {
  it("hands the webview only render state, never the reducer's bookkeeping", () => {
    const state = run([
      userPrompt,
      { type: "messageStream", event: { type: "textStart", blockIndex: 0 } },
    ]);
    const view = toViewModel(state);
    expect(Object.keys(view).sort()).toEqual([
      "blocks",
      "lastError",
      "model",
      "pendingPermissions",
      "plan",
      "running",
      "todos",
    ]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});
