---
title: Events reference
description: Every AgentEvent variant, when it fires, subscribe vs on<T>, and the runs-never-reject semantics.
section: Extend
order: 9.2
---

Everything an `Agent` does is observable through one subscription — this is what the
TUI, the server, and `--json` mode all consume. `AgentEvent` is defined in
`@arcturn/types` (`packages/types/src/events.ts`) as one discriminated union; this page
documents every variant.

## Subscribing

```ts
const off = agent.subscribe((event) => {
  if (event.type === "toolEnd") {
    console.log(event.result.isError ? "✗" : "✓", event.toolCallId);
  }
});
// off() to unsubscribe
```

`agent.on(type, listener)` is sugar over `subscribe` for one event, with the payload
pre-narrowed — no `switch` needed:

```ts
const off = agent.on("toolEnd", (event) => {
  console.log(event.result.isError ? "failed" : "ok");
});
```

Listener exceptions are swallowed by the agent — one bad subscriber can never break a
run. Both forms return the same kind of unsubscribe function.

## The full event table

| `type` | Payload | Fires when |
|---|---|---|
| `runStart` | `sessionId`, `prompt` (the `Message`) | Once, at the start of every `agent.prompt()` call. |
| `turnStart` | `turnIndex` | Before each turn's LLM call — turn 0 is the first. |
| `messageStream` | `event` (a raw `StreamEvent` from `@arcturn/types`) | Re-emitted verbatim for every token/delta the provider streams, for UIs that render token-by-token. |
| `messageEnd` | `message` (`AssistantMessage`) | Once a turn's assistant message is complete. |
| `toolStart` | `toolCallId`, `toolName`, `input` | Just before a tool call executes (after schema validation and the permission gate pass). |
| `toolUpdate` | `toolCallId`, `update` (`ToolUpdate`: `text?`, `details?`) | Whenever a running tool calls `ctx.onUpdate(...)` — zero or more times per call. |
| `toolEnd` | `toolCallId`, `result` (`ToolResultMessage`) | Once a tool call finishes, including blocked, denied, or thrown-and-caught calls. |
| `permissionRequest` | `request` (`PermissionRequest`) | Only when a check reaches the configured requester — never for a check a rule already settled. |
| `permissionDecision` | `decision` (`PermissionDecision`) | Exactly once per permission check, however it resolved (rule, mode, or requester). |
| `todoUpdate` | `todos` (`TodoItem[]`) | Whenever the `todo` tool replaces the list. |
| `planUpdate` | `plan` (`string`) | Whenever the `plan` tool records a new plan. |
| `subagentStart` | `agentId`, `task` | When the `subagent` tool starts a child agent. |
| `subagentEvent` | `agentId`, `event` (a nested `AgentEvent`) | For every event the child agent emits — the child's whole stream, namespaced. |
| `subagentEnd` | `agentId`, `resultText`, `isError` | When the child agent's `prompt()` call settles. |
| `backgroundTaskStart` | `taskId`, `command` | A `bash` call with `background: true` starts. |
| `backgroundTaskOutput` | `taskId`, `chunk` | Incremental stdout/stderr from a background task. |
| `backgroundTaskEnd` | `taskId`, `exitCode` (`number \| null`) | A background task exits. |
| `compactionStart` | — | Compaction begins, automatic or via `agent.compact()`. |
| `compactionEnd` | `summary`, `tokensBefore`, `tokensAfter` | Compaction finishes — `summary` is `""` when nothing was folded. |
| `turnEnd` | `turnIndex`, `usage` (`Usage`) | After each turn's tool calls (if any) are done and before the next turn starts, or before `runEnd`. |
| `runEnd` | `reason` (`"completed" \| "aborted" \| "error"`), `errorMessage?` | Exactly once per `prompt()` call, always — see below. |
| `notice` | `level` (`"info" \| "warn" \| "error"`), `text` | Non-fatal diagnostics: a stale todo reminder, "nothing to compact", a compaction failure. |

## `runEnd` and the never-rejects guarantee

`agent.prompt()` resolves when the model stops calling tools, the run is aborted, or a
runtime error occurs — **it never rejects on a runtime failure**. The outcome is always
reported through a terminal `runEnd` event instead:

```ts
agent.on("runEnd", (event) => {
  switch (event.reason) {
    case "completed":
      break; // normal
    case "aborted":
      break; // agent.abort() was called, or the external signal fired
    case "error":
      console.error(event.errorMessage); // a real failure — model, provider, or a thrown hook
      break;
  }
});
```

This is deliberate: a host built around `subscribe` should never need a `try`/`catch`
around `prompt()` to find out what happened — the same channel that reported every
`toolStart` also reports the run's fate. `errorMessage` is only present when
`reason === "error"`.

## Exhaustiveness and narrowing

`AgentEvent` is a discriminated union on `type`, so a `switch` over it is fully checked
by the compiler — there is deliberately no constants object or enum duplicating the
type strings. Two patterns worth using:

```ts
import type { AgentEvent } from "@arcturn/types";

// Exhaustiveness: adding a new event type to arcturn breaks this switch at
// compile time until you decide what to do with it.
function handle(event: AgentEvent): void {
  switch (event.type) {
    // ...every case...
    default:
      event satisfies never;
  }
}
```

```ts
import type { AgentEventType } from "@arcturn/types";

// AgentEventType names the union of every event type string, for your own signatures.
function logType(type: AgentEventType): void {
  log(type);
}
```

## Sub-agent events are nested, not flattened

A `subagentEvent` wraps the child's *entire* event stream, including its own
`subagentEvent`s if it delegates further — `event.event` is itself a full `AgentEvent`.
A UI that wants a flat timeline needs to recurse:

```ts
import type { AgentEvent } from "@arcturn/types";

function flatten(event: AgentEvent, depth = 0): void {
  trace(depth.toString(), event.type);
  if (event.type === "subagentEvent") flatten(event.event, depth + 1);
}
```

See [Advanced: sub-agents](/docs/sdk-advanced#sub-agents) for how the child agent
producing these events is constructed.
