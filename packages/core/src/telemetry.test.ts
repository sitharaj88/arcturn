import type { AgentEvent, Usage } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentMetric,
  createConsoleTelemetry,
  createTelemetryListener,
  otelTracer,
  type TelemetrySpan,
  type TelemetrySpanOptions,
  type TelemetryTracer,
} from "./telemetry.js";

function usage(partial?: Partial<Usage>): Usage {
  return {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  };
}

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: string; message?: string };
  exception?: unknown;
  ended: boolean;
  endTime?: number;
  startTime?: number;
}

/** In-memory tracer that records every span for assertions. */
function createRecordingTracer(): { tracer: TelemetryTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: TelemetryTracer = {
    startSpan(name: string, options?: TelemetrySpanOptions): TelemetrySpan {
      const record: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        ended: false,
        startTime: options?.startTime,
      };
      spans.push(record);
      return {
        setAttribute(key, value) {
          record.attributes[key] = value;
        },
        recordException(error) {
          record.exception = error;
        },
        setStatus(status) {
          record.status = status;
        },
        end(endTime) {
          record.ended = true;
          record.endTime = endTime;
        },
      };
    },
  };
  return { tracer, spans };
}

describe("createTelemetryListener", () => {
  it("opens and closes a run span across runStart/runEnd", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "sess-1",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("run");
    expect(spans[0]?.attributes["session.id"]).toBe("sess-1");
    expect(spans[0]?.ended).toBe(false);

    listener({ type: "runEnd", reason: "completed" });
    expect(spans[0]?.ended).toBe(true);
    expect(spans[0]?.status?.code).toBe("OK");
  });

  it("sets error status and records exception on runEnd reason=error", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "runEnd", reason: "error", errorMessage: "boom" });

    expect(spans[0]?.status).toEqual({ code: "ERROR", message: "boom" });
    expect(spans[0]?.exception).toBe("boom");
  });

  it("nests turn spans under the run span and closes them on turnEnd", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "turnStart", turnIndex: 0 });
    expect(spans).toHaveLength(2);
    expect(spans[1]?.name).toBe("turn");
    expect(spans[1]?.attributes["arcturn.turn_index"]).toBe(0);

    listener({ type: "turnEnd", turnIndex: 0, usage: usage() });
    expect(spans[1]?.ended).toBe(true);
    expect(spans[1]?.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(spans[1]?.attributes["gen_ai.usage.output_tokens"]).toBe(20);
  });

  it("nests tool spans under the current turn and records tool attributes", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "turnStart", turnIndex: 0 });
    listener({ type: "toolStart", toolCallId: "call-1", toolName: "read", input: {} });

    const toolSpan = spans.find((s) => s.name === "tool:read");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes["arcturn.tool.name"]).toBe("read");
    expect(toolSpan?.attributes["arcturn.tool.call_id"]).toBe("call-1");

    listener({
      type: "toolEnd",
      toolCallId: "call-1",
      result: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: 0,
      },
    });
    expect(toolSpan?.ended).toBe(true);
    expect(toolSpan?.status?.code).toBe("OK");
  });

  it("marks a tool span errored when the result isError", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "toolStart", toolCallId: "c1", toolName: "bash", input: {} });
    listener({
      type: "toolEnd",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [],
        isError: true,
        timestamp: 0,
      },
    });

    const toolSpan = spans.find((s) => s.name === "tool:bash");
    expect(toolSpan?.status?.code).toBe("ERROR");
  });

  it("opens an llm-stream span on first messageStream event and closes on messageEnd", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "turnStart", turnIndex: 0 });
    listener({ type: "messageStream", event: { type: "start", model: "test-model" } });
    listener({ type: "messageStream", event: { type: "textStart", blockIndex: 0 } });

    const streamSpans = spans.filter((s) => s.name === "llm-stream");
    expect(streamSpans).toHaveLength(1); // only one span opened across repeated stream events

    listener({
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [],
        model: "test-model",
        usage: usage({ inputTokens: 5, outputTokens: 7 }),
        stopReason: "endTurn",
        timestamp: 0,
      },
    });

    expect(streamSpans[0]?.ended).toBe(true);
    expect(streamSpans[0]?.attributes["gen_ai.response.model"]).toBe("test-model");
    expect(streamSpans[0]?.attributes["gen_ai.response.finish_reason"]).toBe("endTurn");
  });

  it("force-ends dangling child spans when the run ends without explicit closes", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "turnStart", turnIndex: 0 });
    listener({ type: "toolStart", toolCallId: "c1", toolName: "bash", input: {} });
    // No toolEnd, no turnEnd — runEnd should still close everything.
    listener({ type: "runEnd", reason: "aborted" });

    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("namespaces subagent events into their own nested run span tree", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "root",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "subagentStart", agentId: "sub-1", task: "do a thing" });

    const subRun = spans.find((s) => s.name === "subagent-run:sub-1");
    expect(subRun).toBeDefined();
    expect(subRun?.attributes["arcturn.agent_id"]).toBe("sub-1");

    const toolStart: AgentEvent = {
      type: "toolStart",
      toolCallId: "sc1",
      toolName: "grep",
      input: {},
    };
    listener({ type: "subagentEvent", agentId: "sub-1", event: toolStart });
    const subTool = spans.find((s) => s.name === "tool:grep");
    expect(subTool).toBeDefined();
    expect(subTool?.ended).toBe(false);

    listener({ type: "subagentEnd", agentId: "sub-1", resultText: "done", isError: false });
    expect(subRun?.ended).toBe(true);
    expect(subTool?.ended).toBe(true); // dangling child closed when the subagent run ends

    // Root run is unaffected.
    listener({ type: "runEnd", reason: "completed" });
    const rootRun = spans.find((s) => s.name === "run");
    expect(rootRun?.ended).toBe(true);
  });

  it("marks a subagent run errored when subagentEnd reports isError", () => {
    const { tracer, spans } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "root",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "subagentStart", agentId: "sub-2", task: "t" });
    listener({ type: "subagentEnd", agentId: "sub-2", resultText: "oops", isError: true });

    const subRun = spans.find((s) => s.name === "subagent-run:sub-2");
    expect(subRun?.status?.code).toBe("ERROR");
  });

  it("never throws even when the tracer throws", () => {
    const throwingTracer: TelemetryTracer = {
      startSpan() {
        throw new Error("tracer exploded");
      },
    };
    const listener = createTelemetryListener({ tracer: throwingTracer });

    expect(() =>
      listener({
        type: "runStart",
        sessionId: "s",
        prompt: { role: "user", content: [], timestamp: 0 },
      }),
    ).not.toThrow();
    expect(() => listener({ type: "turnStart", turnIndex: 0 })).not.toThrow();
    expect(() => listener({ type: "runEnd", reason: "completed" })).not.toThrow();
  });

  it("never throws when a span's methods throw", () => {
    const badSpan: TelemetrySpan = {
      setAttribute() {
        throw new Error("boom");
      },
      end() {
        throw new Error("boom");
      },
      setStatus() {
        throw new Error("boom");
      },
      recordException() {
        throw new Error("boom");
      },
    };
    const tracer: TelemetryTracer = { startSpan: () => badSpan };
    const listener = createTelemetryListener({ tracer });

    expect(() =>
      listener({
        type: "runStart",
        sessionId: "s",
        prompt: { role: "user", content: [], timestamp: 0 },
      }),
    ).not.toThrow();
    expect(() => listener({ type: "runEnd", reason: "error", errorMessage: "x" })).not.toThrow();
  });

  it("survives an out-of-order toolEnd with no matching toolStart", () => {
    const { tracer } = createRecordingTracer();
    const listener = createTelemetryListener({ tracer });
    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    expect(() =>
      listener({
        type: "toolEnd",
        toolCallId: "ghost",
        result: {
          role: "toolResult",
          toolCallId: "ghost",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: 0,
        },
      }),
    ).not.toThrow();
  });

  it("uses a custom clock for span timing", () => {
    const { tracer, spans } = createRecordingTracer();
    let t = 1000;
    const now = () => t;
    const listener = createTelemetryListener({ tracer, now });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    t = 1500;
    listener({ type: "runEnd", reason: "completed" });

    expect(spans[0]?.startTime).toBe(1000);
    expect(spans[0]?.endTime).toBe(1500);
  });
});

describe("createTelemetryListener metrics", () => {
  it("emits a tokens metric on turnEnd", () => {
    const { tracer } = createRecordingTracer();
    const onMetric = vi.fn<(m: AgentMetric) => void>();
    const listener = createTelemetryListener({ tracer, onMetric });

    listener({
      type: "runStart",
      sessionId: "sess",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "turnStart", turnIndex: 2 });
    listener({
      type: "turnEnd",
      turnIndex: 2,
      usage: usage({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.01,
      }),
    });

    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tokens",
        sessionId: "sess",
        turnIndex: 2,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.01,
      }),
    );
  });

  it("emits toolDuration and toolError metrics for a failed tool call", () => {
    const { tracer } = createRecordingTracer();
    const onMetric = vi.fn<(m: AgentMetric) => void>();
    let t = 0;
    const listener = createTelemetryListener({ tracer, onMetric, now: () => t });

    listener({
      type: "runStart",
      sessionId: "sess",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    t = 10;
    listener({ type: "toolStart", toolCallId: "c1", toolName: "bash", input: {} });
    t = 60;
    listener({
      type: "toolEnd",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [],
        isError: true,
        timestamp: 0,
      },
    });

    const calls = onMetric.mock.calls.map((c) => c[0]);
    const duration = calls.find((m) => m.type === "toolDuration") as AgentMetric & {
      type: "toolDuration";
    };
    expect(duration.durationMs).toBe(50);
    expect(duration.isError).toBe(true);
    const error = calls.find((m) => m.type === "toolError");
    expect(error).toBeDefined();
  });

  it("does not emit a toolError metric on success", () => {
    const { tracer } = createRecordingTracer();
    const onMetric = vi.fn<(m: AgentMetric) => void>();
    const listener = createTelemetryListener({ tracer, onMetric });

    listener({
      type: "runStart",
      sessionId: "sess",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "toolStart", toolCallId: "c1", toolName: "bash", input: {} });
    listener({
      type: "toolEnd",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [],
        isError: false,
        timestamp: 0,
      },
    });

    expect(onMetric.mock.calls.some((c) => c[0].type === "toolError")).toBe(false);
  });

  it("emits a runDuration metric with the run's reason", () => {
    const { tracer } = createRecordingTracer();
    const onMetric = vi.fn<(m: AgentMetric) => void>();
    let t = 0;
    const listener = createTelemetryListener({ tracer, onMetric, now: () => t });

    listener({
      type: "runStart",
      sessionId: "sess",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    t = 200;
    listener({ type: "runEnd", reason: "aborted" });

    const runMetric = onMetric.mock.calls.map((c) => c[0]).find((m) => m.type === "runDuration");
    expect(runMetric).toEqual(
      expect.objectContaining({ type: "runDuration", durationMs: 200, reason: "aborted" }),
    );
  });

  it("swallows exceptions thrown by onMetric", () => {
    const { tracer } = createRecordingTracer();
    const onMetric = vi.fn(() => {
      throw new Error("consumer bug");
    });
    const listener = createTelemetryListener({ tracer, onMetric });

    listener({
      type: "runStart",
      sessionId: "sess",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    expect(() => listener({ type: "runEnd", reason: "completed" })).not.toThrow();
    expect(onMetric).toHaveBeenCalled();
  });

  it("labels metrics from a subagent run with its agentId", () => {
    const { tracer } = createRecordingTracer();
    const onMetric = vi.fn<(m: AgentMetric) => void>();
    const listener = createTelemetryListener({ tracer, onMetric });

    listener({
      type: "runStart",
      sessionId: "root",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "subagentStart", agentId: "sub-1", task: "t" });
    listener({
      type: "subagentEvent",
      agentId: "sub-1",
      event: { type: "toolStart", toolCallId: "sc1", toolName: "grep", input: {} },
    });
    listener({
      type: "subagentEvent",
      agentId: "sub-1",
      event: {
        type: "toolEnd",
        toolCallId: "sc1",
        result: {
          role: "toolResult",
          toolCallId: "sc1",
          toolName: "grep",
          content: [],
          isError: false,
          timestamp: 0,
        },
      },
    });

    const duration = onMetric.mock.calls.map((c) => c[0]).find((m) => m.type === "toolDuration");
    expect(duration).toEqual(expect.objectContaining({ agentId: "sub-1", toolName: "grep" }));
  });
});

describe("createConsoleTelemetry", () => {
  it("writes one JSON line per finished span with duration and attributes", () => {
    const lines: string[] = [];
    const tracer = createConsoleTelemetry((line) => lines.push(line));
    const span = tracer.startSpan("test-span", { startTime: 1000, attributes: { foo: "bar" } });
    span.setAttribute("baz", 42);
    span.end(1250);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.name).toBe("test-span");
    expect(parsed.durationMs).toBe(250);
    expect(parsed.attributes).toEqual({ foo: "bar", baz: 42 });
    expect(parsed.status).toEqual({ code: "UNSET" });
  });

  it("records status and exception before ending", () => {
    const lines: string[] = [];
    const tracer = createConsoleTelemetry((line) => lines.push(line));
    const span = tracer.startSpan("err-span");
    span.recordException?.(new Error("kaboom"));
    span.setStatus?.({ code: "ERROR", message: "kaboom" });
    span.end();

    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.status).toEqual({ code: "ERROR", message: "kaboom" });
    expect(String(parsed.exception)).toContain("kaboom");
  });

  it("is idempotent: calling end twice writes only one line", () => {
    const lines: string[] = [];
    const tracer = createConsoleTelemetry((line) => lines.push(line));
    const span = tracer.startSpan("dup");
    span.end();
    span.end();

    expect(lines).toHaveLength(1);
  });

  it("integrates end-to-end with createTelemetryListener", () => {
    const lines: string[] = [];
    const tracer = createConsoleTelemetry((line) => lines.push(line));
    const listener = createTelemetryListener({ tracer });

    listener({
      type: "runStart",
      sessionId: "s",
      prompt: { role: "user", content: [], timestamp: 0 },
    });
    listener({ type: "turnStart", turnIndex: 0 });
    listener({ type: "turnEnd", turnIndex: 0, usage: usage() });
    listener({ type: "runEnd", reason: "completed" });

    expect(lines).toHaveLength(2); // turn span, then run span
    const names = lines.map((l) => JSON.parse(l).name);
    expect(names).toEqual(["turn", "run"]);
  });

  it("swallows a throwing sink without disturbing the caller", () => {
    const tracer = createConsoleTelemetry(() => {
      throw new Error("sink is broken");
    });
    const span = tracer.startSpan("x");
    expect(() => span.end()).not.toThrow();
  });
});

describe("otelTracer", () => {
  it("returns the same tracer instance unchanged", () => {
    const { tracer } = createRecordingTracer();
    expect(otelTracer(tracer)).toBe(tracer);
  });
});
