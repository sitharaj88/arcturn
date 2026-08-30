---
title: Agent options reference
description: Every AgentOptions field — llm, model, tools, permissions, hooks, limits — with defaults and behavior.
section: Extend
order: 9.1
---

`AgentOptions` (and its extension `AgentResumeOptions`, used by `Agent.resume`) is the
entire construction surface of the runtime. This page documents every field, sourced
directly from `packages/core/src/agent.ts`. See [the SDK guide](/docs/sdk) for the map
of pages and [Events](/docs/sdk-events) for what an agent does once running.

## Required fields

| Field | Type | Behavior |
|---|---|---|
| `llm` | `LLMClient` | The streaming client every turn is sent through. Injected so `@arcturn/core` never depends on a specific provider — see [Models & providers](/docs/sdk-models) for `createClient`. |
| `model` | `ModelSpec` | The model used for turns, and — unless `compaction.model` overrides it — for the compaction summarization call too. |
| `systemPrompt` | `string \| (() => string)` | Sent as the request's `system`. A function is re-evaluated **before every turn**, not just once at construction — useful for a prompt that includes live state (open files, current time, todo count). |
| `cwd` | `string` | Working directory handed to every tool's `ToolExecutionContext`. |

```ts
const agent = createAgent({
  llm,
  model,
  systemPrompt: () => `You are a coding agent. cwd: ${cwd}. Time: ${new Date().toISOString()}`,
  cwd,
});
```

## Tools and permissions

| Field | Type | Default | Behavior |
|---|---|---|---|
| `tools` | `Tool[]` | `[]` | Offered to the model. `BindableTool`s in this list (the subagent/todo/plan tools from `@arcturn/core`) are automatically bound to the agent via `setTools`. |
| `permissions` | `PermissionEngineOptions` | `{ mode: "default" }` | Rules, mode, and allow-list overrides — see [Permissions from the SDK](/docs/sdk-permissions). |
| `onPermissionAsk` | `PermissionPrompt` | none | Called for any check rules don't settle. Passed through into `permissions.requester`, so setting both is redundant — `onPermissionAsk` wins. |
| `hooks` | `AgentHooks` | none | `beforeToolCall`/`afterToolCall` interceptors — see [Custom tools](/docs/sdk-tools#hooks-vs-permissions) and [Advanced](/docs/sdk-advanced#hooks). |
| `parallelTools` | `boolean` | `false` | Run one turn's tool calls concurrently instead of sequentially, one after another. |

## Session persistence

| Field | Type | Default | Behavior |
|---|---|---|---|
| `sessionStore` | `SessionStore` | none | Where session entries persist. Omit for an agent that never writes to disk. `createAgent({ sessionDir })` builds a `JsonlSessionStore` and passes it here for you. |
| `sessionId` | `string` | random | A stable id lets a caller predict the session file name before the first `prompt()`. |
| `title` | `string` | none | Stored on the session header when the session is first created (not updated after). |
| `messages` / `todos` / `plan` / `parentEntryId` | — | empty | Seed state, set automatically by `Agent.resume`; see [Sessions](/docs/sdk-sessions). Setting these by hand is only for advanced cases like replaying a cassette into a fresh conversation. |

```ts
import { JsonlSessionStore } from "@arcturn/core";

const store = new JsonlSessionStore({ dir: ".arcturn/sessions" });
const agent = createAgent({ ...base, sessionStore: store, sessionId: "release-notes-2026-08" });
```

## Turn behavior

| Field | Type | Default | Behavior |
|---|---|---|---|
| `maxTurns` | `number` | `200` | Ceiling on tool-call turns within one `prompt()` call. This is a runaway-loop backstop, not a budget — it's set high on purpose so a genuinely long task finishes. Lower it per run for a tight leash (e.g. in a sandboxed eval). Exhaustion ends the run as `runEnd { reason: "error" }`; `isTurnCeilingError(errorMessage)` from `@arcturn/core` tells that ending apart from a real failure. The ceiling is announced before it bites — see [The wrap-up warning](#the-wrap-up-warning). |
| `thinking` | `ThinkingLevel` (`"off" \| "low" \| "medium" \| "high"`) | `"off"` | Extended-thinking level, changeable at runtime with `agent.setThinking(level)`. |
| `compaction` | `CompactionOptions` | see below | Automatic-compaction tuning — full table in [Sessions & persistence](/docs/sdk-sessions#forcing-compaction). |
| `signal` | `AbortSignal` | none | An external signal; aborting it aborts the agent's current run the same way `agent.abort()` does. Useful when the host already has one abort controller per request. |

```ts
const controller = new AbortController();
const agent = createAgent({ ...base, signal: controller.signal, maxTurns: 12 });
setTimeout(() => controller.abort(), 30_000); // hard 30s ceiling on one prompt() call
```

### The wrap-up warning

The turn ceiling is invisible from inside a run, so the loop announces it. When a run's
remaining turns first drop to `turnWarningThreshold(maxTurns)` — exported from
`@arcturn/core`, so you can compute the trip point rather than restate the formula — the
loop appends one engine-authored user message telling the model to finish and emit its
final deliverable now, and emits a matching `warn` notice for the host. It fires at most
once per run, rides the next request without spending a turn of its own, and a run that
finishes well under its ceiling never sees it at all.

A very tight leash gets no warning: `turnWarningThreshold` returns `0` for
`maxTurns <= 2`. The threshold has a floor of 2, which for a ceiling that small would sit
at or above the ceiling itself and board the warning on the *first* request — telling a
one-shot classifier to wrap up before it has even read the prompt. So `maxTurns` of 1 or
2 behaves exactly as it always did: request 0 carries the user's prompt and nothing else.
The warning only ever fires once at least one turn has been spent, which is what makes
"remaining turns first drop to" a true description of it.

The injected note is a real `user` message on the same append path as anything you pass
to `prompt()`, so it is persisted to the `SessionStore` and replayed on resume. A host
that renders stored history will therefore show a `user` message the user never typed;
its text always begins `Turn budget:` if you want to style or filter it.

## What isn't here

Two things a reader might expect on `AgentOptions` and won't find:

- **No `apiKey`** — credentials live on the `LLMClient` you pass as `llm` (built by
  `createClient`), not on the agent. The agent never sees a key.
- **No `maxCostUsd`** — cost accounting exists (`calculateCostUsd` in `@arcturn/ai`,
  documented in [Advanced](/docs/sdk-advanced#cost-and-usage-accounting)), but nothing
  in `@arcturn/core` enforces a spend ceiling. A host that wants one reads
  `Usage.costUsd` off `turnEnd`/`toolEnd` events and calls `agent.abort()` itself.

## `Agent.resume`

`AgentResumeOptions` is `AgentOptions` plus two required fields and a request for
`createAgent`'s two-argument sugar — it's covered fully in
[Sessions & persistence](/docs/sdk-sessions#resuming-a-session):

```ts
import { Agent } from "@arcturn/core";

const resumed = await Agent.resume({
  ...base,
  sessionStore: store,
  sessionId,
  // leafId: olderEntryId, // omit to resume the newest branch tip
});
```
