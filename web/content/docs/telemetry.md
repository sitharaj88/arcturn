---
title: Telemetry
description: Turn the AgentEvent stream into an OTel-shaped span tree and a metrics union, with zero required dependencies.
section: Reference
order: 12
---

## What it is

`@arcturn/core`'s telemetry module turns the `AgentEvent` stream any `Agent` already
emits into an OpenTelemetry-shaped span tree plus a stream of typed metrics. It imports
nothing from `@opentelemetry/api` — `TelemetryTracer`/`TelemetrySpan` are a **structural**
subset of OTel's `Tracer`/`Span` interfaces, so a real OTel tracer satisfies them with no
adapter, and a zero-dependency console tracer is included for when you don't have one.

```ts
import { Agent, createConsoleTelemetry, createTelemetryListener } from "@arcturn/core";

const agent = new Agent({ /* ... */ });

const tracer = createConsoleTelemetry(); // zero-dep default, writes to console.error
const unsubscribe = agent.subscribe(
  createTelemetryListener({
    tracer,
    onMetric(metric) {
      // forward to your metrics backend; called synchronously, and this callback
      // throwing never propagates into the agent's run.
    },
  }),
);

// later, tearing the agent/session down:
unsubscribe();
```

`Agent.subscribe` is the only integration point — no other wiring is required. The
listener itself never throws: every span, tracer, and `onMetric` call is wrapped, so a
broken tracer or a buggy metrics sink degrades telemetry, not the run it's observing.

## Span tree

```
run                              (runStart → runEnd)
└─ turn                          (turnStart → turnEnd)
   ├─ llm-stream                 (first messageStream event → messageEnd)
   └─ tool:<name>                (toolStart → toolEnd), one per toolCallId

subagent-run:<agentId>           (subagentStart → subagentEnd — its own full
│                                  run→turn→tool tree, namespaced by agentId;
│                                  currently always a root-level sibling, since
│                                  subagentEvent carries no parent turn/tool key)
└─ ...same shape, namespaced
```

Open spans are tracked by a `<agentId>:<kind>` key (or `<agentId>:tool:<toolCallId>` for
tool spans), each recording its parent key and its set of child keys. Two edge cases are
handled rather than thrown on:

- **Out-of-order or missing ends never crash telemetry.** Closing a span recursively
  force-closes any children still open under it — a `runEnd` that arrives while a
  `toolStart` never got its `toolEnd` still closes that tool span. An end event with no
  matching start is a silent no-op.
- **`llm-stream` opens lazily** on the first `messageStream` event after a turn starts, and
  is idempotent for the rest of that turn's stream — `messageEnd` closes it and records the
  finished message's model, finish reason, and usage.

`runEnd` with `reason: "error"` calls `setStatus({ code: "ERROR", message })` and
`recordException`; `"completed"`/`"aborted"` set `{ code: "OK" }`. Subagents synthesize
their own nested `runStart`/`runEnd` pair (namespaced by `agentId`) so a delegated
sub-agent gets its own complete tree with no extra wiring in `subagent.ts`.

## Attributes (OTel GenAI semantic conventions)

| Span / event | Attribute | Source |
|---|---|---|
| `run` | `session.id` | `runStart.sessionId` |
| `run` | `gen_ai.system` | constant `"arcturn"` |
| `run` (subagent) | `arcturn.agent_id` | `subagentStart.agentId` |
| `turn` | `arcturn.turn_index` | `turnStart.turnIndex` |
| `turn` | `gen_ai.usage.input_tokens` | `turnEnd.usage.inputTokens` |
| `turn` | `gen_ai.usage.output_tokens` | `turnEnd.usage.outputTokens` |
| `turn` | `gen_ai.usage.cache_read_tokens` | `turnEnd.usage.cacheReadTokens` |
| `turn` | `gen_ai.usage.cache_write_tokens` | `turnEnd.usage.cacheWriteTokens` |
| `turn` | `gen_ai.usage.thinking_tokens` | `turnEnd.usage.thinkingTokens` (when present) |
| `turn` | `gen_ai.usage.cost_usd` | `turnEnd.usage.costUsd` (when present) |
| `llm-stream` | `gen_ai.response.model` | `messageEnd.message.model` |
| `llm-stream` | `gen_ai.response.finish_reason` | `messageEnd.message.stopReason` |
| `llm-stream` | (usage attrs) | same `gen_ai.usage.*` set as `turn`, from `messageEnd.message.usage` |
| `tool:<name>` | `arcturn.tool.name` | `toolStart.toolName` |
| `tool:<name>` | `arcturn.tool.call_id` | `toolStart.toolCallId` |

`gen_ai.*` names track OTel's GenAI semantic conventions as of when this module was
written; `arcturn.*` is this project's own namespace for identifiers the GenAI conventions
don't define (turn index, agent id, tool call id). If a future OTel spec revision renames
the `gen_ai.*` fields, `telemetry.ts`'s `setUsageAttributes`/`openSpan` call sites are the
only two places that need to change.

## Metrics

```ts
type AgentMetric =
  | { type: "tokens"; sessionId: string; agentId?: string; turnIndex: number;
      inputTokens: number; outputTokens: number; cacheReadTokens: number;
      cacheWriteTokens: number; costUsd?: number }
  | { type: "toolDuration"; sessionId: string; agentId?: string; toolName: string;
      toolCallId: string; durationMs: number; isError: boolean }
  | { type: "toolError"; sessionId: string; agentId?: string; toolName: string;
      toolCallId: string }
  | { type: "runDuration"; sessionId: string; agentId?: string; durationMs: number;
      reason: "completed" | "aborted" | "error" };
```

Delivered synchronously through `onMetric` as the corresponding event lands: one `tokens`
metric per `turnEnd`, one `toolDuration` metric per `toolEnd` (wall-clock time from the
matching `toolStart`, honoring the `now` override), an additional `toolError` metric
whenever that same `toolEnd`'s result carries `isError`, and one `runDuration` metric per
`runEnd` (wall-clock from `runStart`, tagged with the terminal `reason`). Subagent metrics
carry `agentId` so a consumer can separate root-run metrics (`agentId` absent) from nested
subagent metrics. `onMetric` is entirely optional — omit it to use
`createTelemetryListener` purely as a span bridge.

## `createConsoleTelemetry` — the zero-dependency default tracer

```ts
const tracer = createConsoleTelemetry();                        // sink: console.error
const tracer = createConsoleTelemetry((line) => logFile.write(line + "\n"));
```

Each finished span is written as one JSON line:

```json
{"name":"tool:read","startTime":1699999000000,"endTime":1699999000042,"durationMs":42,"attributes":{"arcturn.tool.name":"read","arcturn.tool.call_id":"call_abc"},"status":{"code":"OK"}}
```

`end()` is idempotent — a second call is a no-op — and a throwing sink never propagates,
matching the listener's own never-throw guarantee.

## CLI: `--trace`

```bash
arcturn --trace
```

Writes one JSON line per finished span to **stderr**, so `--print` output on stdout stays
clean and pipeable. It subscribes at the runtime level (`runtime.subscribe`, not
`agent.subscribe`), which is why the subscription survives `/clear` and session swaps
within one process instead of needing to be re-attached per agent. There's a matching
`--no-trace` to force it off if a config or alias would otherwise enable it.

## Wiring a real OpenTelemetry tracer

```ts
import { trace } from "@opentelemetry/api";
import { createTelemetryListener, otelTracer } from "@arcturn/core";

const tracer = otelTracer(trace.getTracer("arcturn", "0.1.0"));
agent.subscribe(createTelemetryListener({ tracer, onMetric: sendToYourMetricsBackend }));
```

In the common case you can pass a real OTel `Tracer` straight to `createTelemetryListener({
tracer })` with no cast — this module's call site only ever reads `attributes`/`startTime`
off the options object and never passes OTel's third `context` argument, both of which
match OTel's own `SpanOptions` exactly. `otelTracer()` exists only as a fixed, documented
spot to widen the type if a particular `@opentelemetry/api` version's TypeScript types are
stricter than this structural interface (for example, a `startSpan` typed with a required
third parameter) — it's a same-value type-only pin, not a runtime shim.

This path is opt-in and requires your own application — not `@arcturn/core` — to have
`@opentelemetry/api` installed. Arcturn's own `package.json` gains no dependency from the
telemetry feature either way.

## Related

- [SDK: events](/docs/sdk-events) — the full `AgentEvent` union this module consumes.
- [Advanced: hooks](/docs/sdk-advanced#hooks) — a different way to observe every tool call,
  with the power to block one; telemetry only ever observes.
