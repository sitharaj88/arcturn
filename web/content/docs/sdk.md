---
title: Embedding with the SDK
description: Use @arcturn/core to embed the same runtime that powers the arcturn CLI in your own product.
section: Extend
order: 9
---

## `@arcturn/core` is the SDK

There's no separate embedding API — `@arcturn/core` *is* what the `arcturn` CLI is built
on. Everything documented here is exactly what powers the terminal app, just without a
terminal in front of it. The TUI, the HTTP server (see [Server mode](/docs/server-mode)),
and `--json`/`--print` output are all just different consumers of the same `Agent`,
subscribing to the same event stream.

The runtime is split across five packages, each usable on its own:

| Package | What it is |
|---|---|
| `@arcturn/types` | Shared contracts — `AgentEvent`, `Tool`, `ModelSpec`, `Message`, `SessionStore`, permission types. No runtime code. |
| `@arcturn/core` | The `Agent`, the permission engine, session persistence, compaction, sub-agents, the state tools (`todo`, `plan`). |
| `@arcturn/ai` | The multi-provider LLM client: `createClient`, the model catalog, failover, consensus, cost accounting. |
| `@arcturn/tools` | The built-in tool set: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`, `fetch`, `websearch`. |
| `@arcturn/mcp` | An MCP client — connects to configured servers and bridges their tools into ordinary `Tool` objects. |

### Installing today

None of these are published to npm yet. Inside this repository they're plain pnpm
workspace packages, so anything in `packages/*/src` is reachable by workspace protocol
dependency (`"@arcturn/core": "workspace:*"`) from another package in the same
workspace, or by pointing a `file:` dependency at a built `packages/*` directory from
outside it. Every package needs to be built first — the SDK ships compiled JS plus
`.d.ts` files under each package's `dist/`, not source.

## The mental model

An `Agent` is options in, events out, final text on demand:

```ts
import { createAgent } from "@arcturn/core";
import { createClient, requireModel } from "@arcturn/ai";
import { createDefaultTools } from "@arcturn/tools";

const llm = createClient(); // resolves API keys from the environment — see Configuration
const { tools } = createDefaultTools({ cwd: process.cwd() });

const agent = createAgent({
  llm,
  model: requireModel("anthropic/claude-sonnet-4-5"),
  systemPrompt: "You are a focused, careful coding agent.",
  tools,
  cwd: process.cwd(),
  sessionDir: ".arcturn/sessions", // omit for an unpersisted, in-memory agent
  permissions: { mode: "default" },
});

await agent.prompt("Add input validation to the signup handler");
console.log(agent.finalText());
```

`createAgent` is a thin convenience over `new Agent(...)`: pass `sessionDir` and it wires
up a `JsonlSessionStore` for you; omit it for an agent that never persists. `agent.prompt()`
resolves once the model stops calling tools, is aborted, or errors — it **never rejects**
on a runtime failure; see [Events](/docs/sdk-events) for how that failure surfaces instead.

Every provider preset works with no registration step — `presetModel` and `getModel`
resolve the extended catalog on demand:

```ts
import { presetModel } from "@arcturn/ai";

const model = presetModel("zai", "glm-4.7"); // Groq, Cerebras, DeepSeek, … likewise
```

## Where the rest of this lives

The SDK surface is too wide for one page. It's split by concern:

- **[Agent options](/docs/sdk-agent-options)** — every `AgentOptions` field, with
  defaults and behavior: `llm`, `model`, `systemPrompt`, `tools`, `permissions`,
  `hooks`, `maxTurns`, `thinking`, `compaction`, `parallelTools`, `signal`, and the
  session-seeding fields used when resuming.
- **[Events](/docs/sdk-events)** — the full `AgentEvent` union, `subscribe` vs `on`,
  the exhaustiveness pattern, and the "a run never rejects" semantics in detail.
- **[Custom tools](/docs/sdk-tools)** — the `Tool` interface, a complete worked
  example, error handling, and how permissions gate a tool's `execute`.
- **[Permissions from the SDK](/docs/sdk-permissions)** — `PermissionEngine`, rule
  resolution, modes, wiring a `PermissionRequester`/`PermissionPrompt`, and the
  plan-mode exit gate.
- **[Sessions & persistence](/docs/sdk-sessions)** — `JsonlSessionStore` and
  `MemorySessionStore`, resuming, branching, and forcing compaction from code.
- **[Models & providers](/docs/sdk-models)** — `createClient`, the model catalog,
  provider presets, failover chains, consensus panels, and custom OpenAI-compatible
  endpoints.
- **[Advanced: sub-agents, MCP, VCR, hooks](/docs/sdk-advanced)** — delegating to
  child agents, bridging MCP tools, recording/replaying deterministic cassettes, and
  cost/usage accounting.

For the concepts that exist independent of any particular API (what plan mode *is*,
what compaction *does*), see the [Core concepts](/docs/permissions) docs — the SDK
pages here link back to them and focus on the code.
