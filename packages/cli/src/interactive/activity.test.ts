import type { AgentEvent, AssistantMessage, StreamEvent, Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { ROOT_STREAM, SubagentTracker, TokenMeter, ToolCallProgressTracker } from "./activity.js";

/** A usage snapshot carrying `output` cumulative output tokens. */
function usage(output: number): Usage {
  return { inputTokens: 10, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** A top-level `usage` stream event. */
function usageEvent(output: number): AgentEvent {
  return { type: "messageStream", event: { type: "usage", usage: usage(output) } };
}

/** Wrap an event as a sub-agent's republished event. */
function fromSubagent(agentId: string, event: AgentEvent): AgentEvent {
  return { type: "subagentEvent", agentId, event };
}

describe("TokenMeter", () => {
  it("banks each message once even though providers re-send the running total", () => {
    const meter = new TokenMeter();
    // Anthropic emits usage at `message_start` and again at every
    // `message_delta`, each carrying the cumulative total for the message.
    meter.observe(ROOT_STREAM, 4);
    meter.observe(ROOT_STREAM, 120);
    meter.observe(ROOT_STREAM, 900);
    expect(meter.total).toBe(900);
  });

  it("adds messages together across message boundaries", () => {
    const meter = new TokenMeter();
    meter.observe(ROOT_STREAM, 900);
    meter.endMessage(ROOT_STREAM);
    meter.observe(ROOT_STREAM, 50);
    meter.observe(ROOT_STREAM, 300);
    expect(meter.total).toBe(1200);
  });

  it("meters concurrent streams independently", () => {
    const meter = new TokenMeter();
    meter.observe(ROOT_STREAM, 100);
    meter.observe("child", 40);
    meter.observe(ROOT_STREAM, 250);
    meter.observe("child", 700);
    expect(meter.total).toBe(950);
    expect(meter.streamTotal("child")).toBe(700);
    expect(meter.streamTotal(ROOT_STREAM)).toBe(250);
  });

  it("treats a shrinking snapshot as the start of a new message", () => {
    const meter = new TokenMeter();
    meter.observe(ROOT_STREAM, 900);
    meter.observe(ROOT_STREAM, 12); // next message, no `messageEnd` seen
    expect(meter.total).toBe(912);
  });

  it("ignores repeated and non-positive snapshots", () => {
    const meter = new TokenMeter();
    meter.observe(ROOT_STREAM, 300);
    meter.observe(ROOT_STREAM, 300);
    meter.observe(ROOT_STREAM, 0);
    meter.observe(ROOT_STREAM, Number.NaN);
    expect(meter.total).toBe(300);
  });

  it("zeroes every stream on reset", () => {
    const meter = new TokenMeter();
    meter.observe("child", 500);
    meter.reset();
    expect(meter.total).toBe(0);
    expect(meter.streamTotal("child")).toBe(0);
  });
});

describe("SubagentTracker", () => {
  it("counts tokens a sub-agent spends, not just the parent's own", () => {
    const meter = new TokenMeter();
    const tracker = new SubagentTracker(meter, () => 1_000);
    tracker.handle(usageEvent(500));
    tracker.handle({ type: "subagentStart", agentId: "a1", task: "write the tests" });
    tracker.handle(fromSubagent("a1", usageEvent(20_000)));
    // Previously only the parent's 500 was counted, so a run that delegated
    // everything reported a fraction of what it actually spent.
    expect(meter.total).toBe(20_500);
    expect(tracker.active[0]?.tokens).toBe(20_000);
  });

  it("keeps counting after a sub-agent finishes", () => {
    const meter = new TokenMeter();
    const tracker = new SubagentTracker(meter, () => 1_000);
    tracker.handle({ type: "subagentStart", agentId: "a1", task: "recon" });
    tracker.handle(fromSubagent("a1", usageEvent(9_000)));
    tracker.handle({ type: "subagentEnd", agentId: "a1", resultText: "ok", isError: false });
    expect(tracker.active).toHaveLength(0);
    expect(meter.total).toBe(9_000);
  });

  it("follows nesting to any depth", () => {
    const meter = new TokenMeter();
    const tracker = new SubagentTracker(meter, () => 1_000);
    tracker.handle({ type: "subagentStart", agentId: "a1", task: "outer" });
    tracker.handle(fromSubagent("a1", { type: "subagentStart", agentId: "a2", task: "inner" }));
    tracker.handle(fromSubagent("a1", fromSubagent("a2", usageEvent(700))));
    expect(meter.total).toBe(700);
    const inner = tracker.active.find((agent) => agent.id === "a2");
    expect(inner?.depth).toBe(1);
    expect(inner?.tokens).toBe(700);
  });

  it("reports what each sub-agent is doing, including its own todo progress", () => {
    const meter = new TokenMeter();
    const tracker = new SubagentTracker(meter, () => 1_000);
    tracker.handle({ type: "subagentStart", agentId: "a1", task: "map the\n  quiz topics" });
    tracker.handle(
      fromSubagent("a1", {
        type: "todoUpdate",
        todos: [
          { text: "one", status: "done" },
          { text: "two", status: "inProgress" },
          { text: "three", status: "pending" },
        ],
      }),
    );
    tracker.handle(
      fromSubagent("a1", { type: "toolStart", toolCallId: "c1", toolName: "bash", input: {} }),
    );
    const [agent] = tracker.active;
    expect(agent?.task).toBe("map the quiz topics");
    expect(agent?.activity).toBe("bash");
    expect(agent?.toolCalls).toBe(1);
    expect(agent?.todos).toEqual({ done: 1, total: 3 });
  });

  it("does not let a sub-agent's todos overwrite the parent's", () => {
    const meter = new TokenMeter();
    const tracker = new SubagentTracker(meter, () => 1_000);
    tracker.handle({ type: "subagentStart", agentId: "a1", task: "child" });
    tracker.handle({ type: "todoUpdate", todos: [{ text: "parent item", status: "pending" }] });
    expect(tracker.active[0]?.todos).toBeUndefined();
  });

  it("orders live sub-agents oldest first", () => {
    const meter = new TokenMeter();
    let clock = 1_000;
    const tracker = new SubagentTracker(meter, () => clock);
    tracker.handle({ type: "subagentStart", agentId: "a1", task: "first" });
    clock = 2_000;
    tracker.handle({ type: "subagentStart", agentId: "a2", task: "second" });
    expect(tracker.active.map((agent) => agent.id)).toEqual(["a1", "a2"]);
  });
});

describe("ToolCallProgressTracker", () => {
  /** A top-level stream event. */
  function streamed(event: StreamEvent): AgentEvent {
    return { type: "messageStream", event };
  }

  /** An assistant message, as carried by `messageEnd`. */
  function assistantMessage(): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      model: "test",
      usage: usage(0),
      stopReason: "endTurn",
      timestamp: 0,
    };
  }

  it("reports the tool name and a growing character count while arguments stream", () => {
    const tracker = new ToolCallProgressTracker();
    expect(tracker.progress).toBeUndefined();

    tracker.handle(streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" }));
    expect(tracker.progress).toEqual({ name: "write", chars: 0, count: 1 });

    tracker.handle(
      streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta: "x".repeat(9) }),
    );
    expect(tracker.progress?.chars).toBe(9);
    tracker.handle(
      streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta: "y".repeat(11) }),
    );
    expect(tracker.progress).toEqual({ name: "write", chars: 20, count: 1 });
  });

  it("aggregates parallel tool calls under the most recent name", () => {
    const tracker = new ToolCallProgressTracker();
    tracker.handle(streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "read" }));
    tracker.handle(streamed({ type: "toolCallStart", blockIndex: 1, id: "c2", name: "grep" }));
    tracker.handle(streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta: "aaa" }));
    tracker.handle(streamed({ type: "toolCallDelta", blockIndex: 1, argumentsDelta: "bb" }));
    expect(tracker.progress).toEqual({ name: "grep", chars: 5, count: 2 });

    // One finishing leaves the other's own count behind, not the sum.
    tracker.handle(streamed({ type: "blockEnd", blockIndex: 1 }));
    expect(tracker.progress).toEqual({ name: "read", chars: 3, count: 1 });
  });

  it("clears when the call ends, when the tool starts running and at message end", () => {
    const closers: AgentEvent[] = [
      streamed({ type: "toolCallEnd", blockIndex: 0, id: "c1", name: "write", arguments: {} }),
      { type: "toolStart", toolCallId: "c1", toolName: "write", input: {} },
      { type: "messageEnd", message: assistantMessage() },
    ];
    for (const closer of closers) {
      const tracker = new ToolCallProgressTracker();
      tracker.handle(streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" }));
      tracker.handle(streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta: "args" }));
      expect(tracker.progress).toBeDefined();
      tracker.handle(closer);
      expect(tracker.progress).toBeUndefined();
    }
  });

  it("leaves no ghost when a run is torn down mid-arguments", () => {
    const tracker = new ToolCallProgressTracker();
    tracker.handle(streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" }));
    tracker.handle(streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta: "half" }));
    tracker.handle({ type: "runEnd", reason: "aborted" });
    expect(tracker.progress).toBeUndefined();
  });

  it("ignores sub-agent tool calls, which have rows of their own", () => {
    const tracker = new ToolCallProgressTracker();
    tracker.handle(
      fromSubagent(
        "child",
        streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" }),
      ),
    );
    expect(tracker.progress).toBeUndefined();
  });
});
