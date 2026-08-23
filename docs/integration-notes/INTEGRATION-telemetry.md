# Integration notes: OpenTelemetry-compatible telemetry

`packages/core/src/telemetry.ts` (+ `telemetry.test.ts`) is a
self-contained, dependency-free module — no existing file was touched to
build it. It turns the `AgentEvent` stream a subscribed `Agent` already
emits into an OTel-shaped span tree plus a metrics callback. This document
is the exact wiring for whoever picks it up next.

## 1. Exports

```ts
// --- structural OTel-compatible contracts -------------------------------
interface TelemetrySpanStatus { code: "UNSET" | "OK" | "ERROR"; message?: string }

interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException?(error: unknown): void;
  setStatus?(status: TelemetrySpanStatus): void;
  end(endTime?: number): void;
}

interface TelemetrySpanOptions {
  attributes?: Record<string, string | number | boolean>;
  startTime?: number;
}

interface TelemetryTracer {
  startSpan(name: string, options?: TelemetrySpanOptions): TelemetrySpan;
}

function otelTracer(tracer: TelemetryTracer): TelemetryTracer;  // identity pin, see §4

// --- metrics --------------------------------------------------------------
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

// --- the bridge -------------------------------------------------------------
interface TelemetryListenerOptions {
  tracer: TelemetryTracer;
  onMetric?: (metric: AgentMetric) => void;
  now?: () => number;                       // clock override, default Date.now
}
function createTelemetryListener(options: TelemetryListenerOptions): AgentEventListener;

// --- zero-dep default tracer -------------------------------------------------
function createConsoleTelemetry(sink?: (line: string) => void): TelemetryTracer;
```

Nothing here imports `@opentelemetry/api`. `TelemetryTracer`/`TelemetrySpan`
are a **structural subset** of OTel's `Tracer`/`Span` — a real
`tracer.startSpan(name, options)` call matches this module's call site
exactly (this module never passes OTel's third `context` argument, and only
ever reads `attributes`/`startTime` off the options object, both of which
exist on OTel's own `SpanOptions`). So in the common case you can pass a real
OTel `Tracer` to `createTelemetryListener({ tracer })` with **no cast and no
adapter**. `otelTracer()` is provided only as a fixed, documented spot to
widen the type if a particular `@opentelemetry/api` version's TS types are
stricter than this structural interface (e.g. `startSpan` typed with a
required third parameter) — `otelTracer(realTracer)` is a same-value
type-only pin, not a runtime shim.

## 2. Wiring into an `Agent`

```ts
import { Agent } from "@arcturn/core";
import { createTelemetryListener, createConsoleTelemetry } from "@arcturn/core";
// or, with the real SDK: import { trace } from "@opentelemetry/api";

const agent = new Agent({ /* ... */ });

const tracer = createConsoleTelemetry();      // zero-dep default
// const tracer = otelTracer(trace.getTracer("arcturn"));   // real OTel, when available

const unsubscribe = agent.subscribe(
  createTelemetryListener({
    tracer,
    onMetric(metric) {
      // forward to your metrics backend; called synchronously, never throws
      // into the agent even if this callback itself throws.
    },
  }),
);

// later, when the agent/session is torn down:
unsubscribe();
```

`Agent.subscribe` already exists (`packages/core/src/agent.ts`) and returns
an unsubscribe function — no change needed there. The listener never throws:
every span/tracer/`onMetric` call is wrapped, so a broken tracer or a buggy
metrics sink degrades telemetry, not the run.

## 3. Span hierarchy

```
run                              (runStart → runEnd)
└─ turn                          (turnStart → turnEnd)
   ├─ llm-stream                 (first messageStream event → messageEnd)
   └─ tool:<name>                (toolStart → toolEnd), one per toolCallId
subagent-run:<agentId>           (subagentStart → subagentEnd; itself a "run"
│                                  span, nested wherever subagentStart arrives
│                                  — currently always as a root-level sibling,
│                                  since subagentEvent does not carry a
│                                  parent turn/tool key)
└─ ...same tree, namespaced by agentId
```

Implementation notes for anyone extending this:

- Open spans are tracked in a `Map<string, OpenSpan>` keyed by a
  `<agentId>:<kind>` (or `<agentId>:tool:<toolCallId>`) string, each node
  recording its parent key and a `Set` of child keys.
- **Out-of-order / missing ends are handled, not thrown on.** Closing a span
  recursively force-closes any children still open under it (e.g. `runEnd`
  arriving with a `toolStart` never followed by `toolEnd` still ends the tool
  span). A `toolEnd`/`turnEnd` with no matching start is a silent no-op.
- `messageStream` opens the `llm-stream` span lazily on the **first** event
  after a turn starts and is idempotent for the rest of that turn's stream
  events (checked via `spans.has`); `messageEnd` closes it and records the
  finished message's model/finish-reason/usage.
- `runEnd` with `reason: "error"` sets `{ code: "ERROR", message: errorMessage }`
  via `setStatus` and calls `recordException` with the error message;
  `"completed"`/`"aborted"` set `{ code: "OK" }`.
- Subagents: `subagentStart`/`subagentEnd` synthesize a nested `runStart`/
  `runEnd` call (namespaced by `agentId`) so a subagent gets its own full
  run→turn→tool tree; `subagentEvent` unwraps and replays its inner
  `AgentEvent` under that same namespace. `Agent`'s existing subagent
  plumbing (`packages/core/src/subagent.ts`) already emits these three event
  types with no changes needed here.

## 4. Attribute mapping (OTel GenAI semantic conventions)

| Span / event | Attribute | Source |
| --- | --- | --- |
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

`gen_ai.usage.*` and `gen_ai.response.*` match OTel's GenAI semantic
convention names as of the last incubating spec seen in training; the
`arcturn.*` names are this project's own namespace for identifiers OTel's
GenAI conventions don't define (turn index, agent id, tool call id). If a
future OTel spec revision renames these, update this table and the
`setUsageAttributes`/`openSpan` call sites in `telemetry.ts` together — they
are the only two places attribute names are set.

## 5. Metrics

Delivered synchronously via `onMetric` as the corresponding `AgentEvent`
lands — one `tokens` metric per `turnEnd` (reads `Usage` from
`packages/types/src/messages.ts`: `inputTokens`/`outputTokens`/
`cacheReadTokens`/`cacheWriteTokens`/`costUsd`), one `toolDuration` metric
per `toolEnd` (wall-clock from the matching `toolStart`, using the `now()`
override if supplied), an additional `toolError` metric when that
`toolEnd`'s result `isError`, and one `runDuration` metric per `runEnd`
(wall-clock from `runStart`, tagged with `reason`). Subagent metrics carry
`agentId` so a consumer can separate root-run metrics (`agentId` absent)
from nested subagent metrics.

`onMetric` is optional — omit it to use `createTelemetryListener` purely as
a span bridge.

## 6. `createConsoleTelemetry` — zero-dep default tracer

```ts
const tracer = createConsoleTelemetry();                        // console.error
const tracer = createConsoleTelemetry((line) => logFile.write(line + "\n"));
```

Each finished span is written as **one JSON line**:

```json
{"name":"tool:read","startTime":1699999000000,"endTime":1699999000042,"durationMs":42,"attributes":{"arcturn.tool.name":"read","arcturn.tool.call_id":"call_abc"},"status":{"code":"OK"}}
```

`end()` is idempotent (a second call is a no-op) and a throwing `sink` never
propagates — same never-throw guarantee as the listener itself.

### CLI `--trace` flag wiring (not built here, for the CLI owner)

```ts
// wherever the CLI builds its Agent (e.g. runtime.ts's Agent construction)
import { createTelemetryListener, createConsoleTelemetry } from "@arcturn/core";

if (cliFlags.trace) {
  const tracer = createConsoleTelemetry((line) => process.stderr.write(`${line}\n`));
  runtime.agent.subscribe(createTelemetryListener({ tracer }));
}
```

Add `--trace` to the CLI's flag parser (wherever `--resume`/`--model` are
defined) as a boolean; when set, wire the snippet above right after the
`Agent` is constructed, before the first `runStart`. No other file needs to
change for the flag to work — `createConsoleTelemetry`'s default sink
(`console.error`) is also a reasonable fallback if the flag is wired without
an explicit sink.

## 7. Passing a real `@opentelemetry/api` tracer

```ts
import { trace } from "@opentelemetry/api";
import { createTelemetryListener, otelTracer } from "@arcturn/core";

const tracer = otelTracer(trace.getTracer("arcturn", "0.1.0"));
agent.subscribe(createTelemetryListener({ tracer, onMetric: sendToYourMetricsBackend }));
```

This is opt-in and requires the consuming application (not `@arcturn/core`,
per the no-new-dependencies rule) to have `@opentelemetry/api` installed.
Arcturn's own `package.json` gains no new dependency from this feature.
