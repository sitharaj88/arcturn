/**
 * OpenTelemetry-compatible observability bridge for the {@link AgentEvent} stream.
 *
 * Arcturn never depends on `@opentelemetry/api`; instead this module defines
 * minimal structural interfaces ({@link TelemetryTracer}, {@link TelemetrySpan})
 * shaped so a real OTel `Tracer`/`Span` satisfies them without an adapter in
 * the common case (see the recipe for the one method signature that needs a
 * shim). `createTelemetryListener` turns an `AgentEventListener` into a span
 * tree — run > turn > (tool | llm-stream), with subagent runs nested as child
 * spans — plus an optional metrics callback for token/duration/error counts.
 *
 * `createConsoleTelemetry` is a zero-dependency `TelemetryTracer` that prints
 * one JSON line per finished span, so telemetry works out of the box without
 * any OTel SDK wired in (e.g. behind a CLI `--trace` flag).
 */

import type { AgentEvent, AgentEventListener, Usage } from "@arcturn/types";

/**
 * A span's terminal status. Mirrors the shape of `@opentelemetry/api`'s
 * `SpanStatus` (`{ code: SpanStatusCode; message?: string }`) structurally —
 * `code` here uses the same three names as `SpanStatusCode` so passing a real
 * `SpanStatusCode` value works unmodified.
 */
export interface TelemetrySpanStatus {
  code: "UNSET" | "OK" | "ERROR";
  message?: string;
}

/**
 * Structural subset of `@opentelemetry/api`'s `Span` that this module needs.
 * A real OTel `Span` satisfies this as-is: `setAttribute`, `recordException`,
 * `setStatus` and `end` all match its public signatures.
 */
export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException?(error: unknown): void;
  setStatus?(status: TelemetrySpanStatus): void;
  end(endTime?: number): void;
}

/** Options accepted by {@link TelemetryTracer.startSpan}. */
export interface TelemetrySpanOptions {
  /** Attributes to set on the span at creation time. */
  attributes?: Record<string, string | number | boolean>;
  /** Start timestamp (epoch ms). Defaults to "now" for most implementations. */
  startTime?: number;
}

/**
 * Structural subset of `@opentelemetry/api`'s `Tracer`.
 *
 * A real OTel `Tracer.startSpan(name, options?, context?)` satisfies this
 * directly — this module never passes a third argument, and the second
 * argument only ever uses the `attributes`/`startTime` fields OTel's own
 * `SpanOptions` also defines. No adapter is required to pass a real tracer
 * here; `otelTracer` exists only for callers who want a fixed spot to widen
 * an OTel `Tracer` (e.g. cast away extra required options) if their SDK
 * version's types are stricter than this interface.
 */
export interface TelemetryTracer {
  startSpan(name: string, options?: TelemetrySpanOptions): TelemetrySpan;
}

/**
 * Identity-adapter for a real `@opentelemetry/api` `Tracer`.
 *
 * Because {@link TelemetryTracer} is a structural subset of OTel's `Tracer`,
 * no runtime shimming is needed — this simply documents and pins the cast at
 * one call site instead of scattering `as unknown as TelemetryTracer` through
 * calling code.
 *
 * @param tracer - Any object satisfying OTel's `Tracer` shape (or this
 *   module's {@link TelemetryTracer} shape already).
 */
export function otelTracer(tracer: TelemetryTracer): TelemetryTracer {
  return tracer;
}

/** Per-turn token usage, reported once a turn's usage is known. */
export interface TokenMetric {
  type: "tokens";
  sessionId: string;
  agentId?: string;
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

/** Wall-clock duration of one tool call. */
export interface ToolDurationMetric {
  type: "toolDuration";
  sessionId: string;
  agentId?: string;
  toolName: string;
  toolCallId: string;
  durationMs: number;
  isError: boolean;
}

/** Emitted once per tool call that ends in error, in addition to the duration metric. */
export interface ToolErrorMetric {
  type: "toolError";
  sessionId: string;
  agentId?: string;
  toolName: string;
  toolCallId: string;
}

/** Wall-clock duration of one run, from `runStart` to `runEnd`. */
export interface RunDurationMetric {
  type: "runDuration";
  sessionId: string;
  agentId?: string;
  durationMs: number;
  reason: "completed" | "aborted" | "error";
}

/** Metrics derived from the event stream and delivered via `onMetric`. */
export type AgentMetric = TokenMetric | ToolDurationMetric | ToolErrorMetric | RunDurationMetric;

/** Options for {@link createTelemetryListener}. */
export interface TelemetryListenerOptions {
  /** Tracer used to open/close spans. */
  tracer: TelemetryTracer;
  /** Receives derived metrics as they become available. Errors are caught and ignored. */
  onMetric?: (metric: AgentMetric) => void;
  /** Clock used for span timestamps and duration metrics. Defaults to `Date.now`. */
  now?: () => number;
}

interface OpenSpan {
  span: TelemetrySpan;
  kind: "run" | "turn" | "tool" | "llmStream";
  startedAt: number;
  /** Child span keys, so ending a span can force-close dangling children. */
  children: Set<string>;
  parentKey: string | undefined;
}

const GEN_AI_SYSTEM = "gen_ai.system";

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // Telemetry must never disturb the agent run.
  }
}

function setUsageAttributes(span: TelemetrySpan, usage: Usage): void {
  span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  span.setAttribute("gen_ai.usage.cache_read_tokens", usage.cacheReadTokens);
  span.setAttribute("gen_ai.usage.cache_write_tokens", usage.cacheWriteTokens);
  if (usage.thinkingTokens !== undefined) {
    span.setAttribute("gen_ai.usage.thinking_tokens", usage.thinkingTokens);
  }
  if (usage.costUsd !== undefined) {
    span.setAttribute("gen_ai.usage.cost_usd", usage.costUsd);
  }
}

/**
 * Build an {@link AgentEventListener} that projects the event stream onto an
 * OTel-shaped span hierarchy (run > turn > tool | llm-stream) and, when
 * `onMetric` is supplied, a stream of {@link AgentMetric} values.
 *
 * Subscribe it with `agent.subscribe(listener)`. Every event is handled
 * defensively: a missing or out-of-order end closes whatever is open rather
 * than throwing, and any exception from the tracer or `onMetric` is caught so
 * telemetry can never break the run it is observing.
 *
 * @param options - Tracer, optional metric sink, and optional clock.
 * @returns A listener suitable for `agent.subscribe`.
 */
export function createTelemetryListener(options: TelemetryListenerOptions): AgentEventListener {
  const { tracer, onMetric, now = () => Date.now() } = options;
  const spans = new Map<string, OpenSpan>();
  // sessionId of the outermost run, used to label metrics from nested
  // subagent runs (which have their own sessionId already, but namespace by
  // agentId so a listener can tell subagent metrics apart from the root's).
  let currentSessionId = "";

  function emitMetric(metric: AgentMetric): void {
    if (!onMetric) return;
    safeCall(() => onMetric(metric));
  }

  function openSpan(
    key: string,
    name: string,
    kind: OpenSpan["kind"],
    parentKey: string | undefined,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    const startedAt = now();
    let span: TelemetrySpan | undefined;
    safeCall(() => {
      span = tracer.startSpan(name, { startTime: startedAt, attributes });
    });
    if (!span) return;
    spans.set(key, { span, kind, startedAt, children: new Set(), parentKey });
    if (parentKey) {
      spans.get(parentKey)?.children.add(key);
    }
  }

  /** End a span (and recursively any children still open under it). */
  function closeSpan(
    key: string,
    endAt: number,
    status?: TelemetrySpanStatus,
    error?: unknown,
  ): void {
    const open = spans.get(key);
    if (!open) return;
    spans.delete(key);
    for (const childKey of [...open.children]) {
      closeSpan(childKey, endAt);
    }
    if (open.parentKey) {
      spans.get(open.parentKey)?.children.delete(key);
    }
    safeCall(() => {
      if (error !== undefined) open.span.recordException?.(error);
      if (status) open.span.setStatus?.(status);
      open.span.end(endAt);
    });
  }

  function keyFor(agentPrefix: string, suffix: string): string {
    return agentPrefix ? `${agentPrefix}:${suffix}` : suffix;
  }

  // agentId is the namespace prefix used for nested subagent events, "" for
  // the root run.
  function handle(event: AgentEvent, agentId: string): void {
    const runKey = keyFor(agentId, "run");
    const turnKey = keyFor(agentId, "turn");
    const streamKey = keyFor(agentId, "llmStream");

    switch (event.type) {
      case "runStart": {
        currentSessionId = event.sessionId || currentSessionId;
        openSpan(runKey, agentId ? `subagent-run:${agentId}` : "run", "run", undefined, {
          "session.id": event.sessionId,
          [GEN_AI_SYSTEM]: "arcturn",
          ...(agentId ? { "arcturn.agent_id": agentId } : {}),
        });
        break;
      }
      case "runEnd": {
        const open = spans.get(runKey);
        const startedAt = open?.startedAt ?? now();
        const endAt = now();
        const status: TelemetrySpanStatus | undefined =
          event.reason === "error"
            ? { code: "ERROR", message: event.errorMessage }
            : { code: "OK" };
        closeSpan(runKey, endAt, status, event.reason === "error" ? event.errorMessage : undefined);
        emitMetric({
          type: "runDuration",
          sessionId: currentSessionId,
          agentId: agentId || undefined,
          durationMs: endAt - startedAt,
          reason: event.reason,
        });
        break;
      }
      case "turnStart": {
        openSpan(turnKey, "turn", "turn", runKey, {
          "arcturn.turn_index": event.turnIndex,
        });
        break;
      }
      case "turnEnd": {
        const usage = event.usage;
        const open = spans.get(turnKey);
        safeCall(() => open && setUsageAttributes(open.span, usage));
        closeSpan(turnKey, now(), { code: "OK" });
        emitMetric({
          type: "tokens",
          sessionId: currentSessionId,
          agentId: agentId || undefined,
          turnIndex: event.turnIndex,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
        });
        break;
      }
      case "messageStream": {
        if (!spans.has(streamKey)) {
          const parentKey = spans.has(turnKey) ? turnKey : runKey;
          openSpan(streamKey, "llm-stream", "llmStream", parentKey);
        }
        break;
      }
      case "messageEnd": {
        const open = spans.get(streamKey);
        const message = event.message;
        safeCall(() => {
          if (!open) return;
          open.span.setAttribute("gen_ai.response.model", message.model);
          open.span.setAttribute("gen_ai.response.finish_reason", message.stopReason);
          setUsageAttributes(open.span, message.usage);
        });
        const status: TelemetrySpanStatus =
          message.stopReason === "error"
            ? { code: "ERROR", message: message.errorMessage }
            : { code: "OK" };
        closeSpan(
          streamKey,
          now(),
          status,
          message.stopReason === "error" ? message.errorMessage : undefined,
        );
        break;
      }
      case "toolStart": {
        const toolKey = keyFor(agentId, `tool:${event.toolCallId}`);
        const parentKey = spans.has(turnKey) ? turnKey : runKey;
        openSpan(toolKey, `tool:${event.toolName}`, "tool", parentKey, {
          "arcturn.tool.name": event.toolName,
          "arcturn.tool.call_id": event.toolCallId,
        });
        break;
      }
      case "toolEnd": {
        const toolKey = keyFor(agentId, `tool:${event.toolCallId}`);
        const open = spans.get(toolKey);
        const endAt = now();
        const startedAt = open?.startedAt ?? endAt;
        const status: TelemetrySpanStatus = event.result.isError
          ? { code: "ERROR" }
          : { code: "OK" };
        closeSpan(toolKey, endAt, status);
        emitMetric({
          type: "toolDuration",
          sessionId: currentSessionId,
          agentId: agentId || undefined,
          toolName: event.result.toolName,
          toolCallId: event.toolCallId,
          durationMs: endAt - startedAt,
          isError: event.result.isError,
        });
        if (event.result.isError) {
          emitMetric({
            type: "toolError",
            sessionId: currentSessionId,
            agentId: agentId || undefined,
            toolName: event.result.toolName,
            toolCallId: event.toolCallId,
          });
        }
        break;
      }
      case "subagentStart": {
        handle(
          {
            type: "runStart",
            sessionId: event.agentId,
            prompt: { role: "user", content: [], timestamp: now() },
          },
          event.agentId,
        );
        break;
      }
      case "subagentEvent": {
        handle(event.event, event.agentId);
        break;
      }
      case "subagentEnd": {
        handle(
          {
            type: "runEnd",
            reason: event.isError ? "error" : "completed",
            errorMessage: event.isError ? event.resultText : undefined,
          },
          event.agentId,
        );
        break;
      }
      default:
        break;
    }
  }

  return (event: AgentEvent) => {
    safeCall(() => handle(event, ""));
  };
}

/**
 * A zero-dependency {@link TelemetryTracer} that renders each finished span
 * as one JSON line, so telemetry works without any OTel SDK installed.
 *
 * Intended as the default backend behind a CLI `--trace` flag: wire
 * `createConsoleTelemetry(line => process.stderr.write(line + "\n"))` (or any
 * other sink) into `createTelemetryListener({ tracer })`.
 *
 * @param sink - Receives one finished-span JSON line at a time. Defaults to
 *   `console.error` — pass an explicit sink (e.g. a file writer) to avoid it.
 */
export function createConsoleTelemetry(sink?: (line: string) => void): TelemetryTracer {
  const write = sink ?? ((line: string) => console.error(line));
  return {
    startSpan(name, options) {
      const attributes: Record<string, string | number | boolean> = { ...options?.attributes };
      const startTime = options?.startTime ?? Date.now();
      let status: TelemetrySpanStatus = { code: "UNSET" };
      let exception: string | undefined;
      let ended = false;
      return {
        setAttribute(key, value) {
          attributes[key] = value;
        },
        recordException(error: unknown) {
          exception = error instanceof Error ? (error.stack ?? error.message) : String(error);
        },
        setStatus(next) {
          status = next;
        },
        end(endTime) {
          if (ended) return;
          ended = true;
          const finishedAt = endTime ?? Date.now();
          const record: Record<string, unknown> = {
            name,
            startTime,
            endTime: finishedAt,
            durationMs: finishedAt - startTime,
            attributes,
            status,
          };
          if (exception !== undefined) record.exception = exception;
          safeCall(() => write(JSON.stringify(record)));
        },
      };
    },
  };
}
