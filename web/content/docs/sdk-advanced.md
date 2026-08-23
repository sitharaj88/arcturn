---
title: "Advanced: sub-agents, MCP, VCR, hooks"
description: Delegating to child agents, bridging MCP tools, recording/replaying deterministic sessions, and cost accounting.
section: Extend
order: 9.7
---

## Sub-agents

`createSubagentTool` (from `@arcturn/core`) is a `BindableTool` that lets the model
delegate a self-contained task to a child `Agent` with its own context window. The
child's entire event stream is re-published on the parent as
`subagentStart`/`subagentEvent`/`subagentEnd` — see
[Events](/docs/sdk-events#sub-agent-events-are-nested-not-flattened).

```ts
import { createSubagentTool } from "@arcturn/core";

const subagent = createSubagentTool({
  factory: (task, agentName) => {
    // Build a fresh child agent per call — its own tools, model, and budget.
    // Never share a bindable tool instance between a parent and its child.
    return createAgent({
      ...base,
      sessionStore: undefined,
      systemPrompt: agentName === "researcher" ? "You research; you never edit files." : systemPrompt,
      maxTurns: 20,
    });
  },
  agentNames: ["researcher"], // advertises an `agent` enum param; omit for one default kind
});

const agent = createAgent({ ...base, tools: [...tools, subagent] });
```

Points worth knowing:

- **`factory` is called once per delegation**, not once total — build the child fresh
  every time so state never leaks between tasks.
- **Aborting the parent cascades to the child**: the tool listens on the parent's
  `AbortSignal` and calls `child.abort()`.
- **The child cannot ask questions back** — the tool description says as much, and it's
  worth keeping in your own task-writing prompts: state the task and the expected shape
  of the answer in full, because there's no back-and-forth.
- **`agentNames`** controls whether the `agent` parameter is advertised at all. An empty
  list (the default) omits it entirely — advertising a free-text field with nothing
  concrete to put in it just invites the model to invent a value like `"general"`.

## MCP client usage

`@arcturn/mcp`'s `McpManager` connects to a set of configured servers and bridges their
tools into ordinary `Tool[]` — the model sees no difference between an MCP tool and a
built-in one.

```ts
import { loadMcpConfig, McpManager } from "@arcturn/mcp";

const config = await loadMcpConfig([".arcturn/mcp.json"]);
const manager = new McpManager(config);
await manager.connect(); // connects every configured server concurrently

const mcpTools = manager.tools(); // Tool[] — concatenate with your other tools
const agent = createAgent({ ...base, tools: [...tools, ...mcpTools] });

manager.onToolsChanged((event) => {
  // A server's tool list changed live — rebuild the agent's tool set to match.
  agent.setTools([...tools, ...manager.tools()]);
});
```

Per-server failures are isolated — one bad server never prevents the others from
connecting, and `manager.status()` reports each server's `McpServerConnectionState`
(`"disconnected" | "connecting" | "connected" | "failed"`) plus a `toolCount` or
`error` string. `manager.listResources()`/`readResource()`/`listPrompts()`/`getPrompt()`
expose the rest of MCP beyond tools, scoped to one server or all connected servers.
Call `manager.close()` to tear every connection down. See [MCP](/docs/mcp) for the
config file schema `loadMcpConfig` reads.

## VCR: recording and replaying a session

VCR mode is genuinely SDK-only today: `packages/cli/src/vcr.ts` implements it, but the
CLI itself exposes **no flag** to turn recording on — there is no `arcturn --record`.
It's also not re-exported through `@arcturn/cli`'s public entry point, so reaching it
from outside this monorepo currently means importing the module by its built path
(`@arcturn/cli/dist/vcr.js`) rather than a stable package export. Treat this as an
internal capability you can build on inside the workspace, not a published API yet.

What it does: a *cassette* is one JSONL file holding every side of a session arcturn
doesn't control — every LLM turn's stream events, and every tool call's result.
Recording is a transparent wrapper that passes calls through to the real provider and
real tools while teeing the outcome to disk. Replay serves those outcomes back **without
ever touching the network or the filesystem** — a replayed tool's `execute` is never
invoked at all, so replaying a session that ran `bash rm -rf` deletes nothing.

```text
// record
const recorder = createCassetteRecorder(".arcturn/cassettes/run.jsonl");
const llm = recordingClient(realClient, recorder);
const tools = wrapToolsWithRecorder(baseTools, recorder);
// ... run the agent with { llm, tools } ...
await recorder.close();

// replay — no provider, no network, no filesystem effects
const cassette = await loadCassette(".arcturn/cassettes/run.jsonl");
const llm = replayingClient(cassette);
const tools = replayTools(baseTools, cassette);
// ... run the agent again; cassette.stats() reports what diverged ...
```

Interactions are matched by a content hash of what caused them (`requestKey` /
`toolKey`), not position — inserting an earlier turn doesn't shift every later lookup
by one. Repeats of the same key are legitimate (reading the same file twice) and are
served in recorded order via a `seq` counter. `cassette.stats()` after a replay reports
`misses` and `unused` entries — a non-empty `unused` list is the signal that a run
diverged from its recording, which is what a bisection tool built on this would key off
of.

## Hooks

`AgentOptions.hooks` (an `AgentHooks`) wraps every tool call unconditionally — for cases
a permission rule can't express, like inspecting the raw command text, or centralized
audit logging:

```ts
const agent = createAgent({
  ...base,
  hooks: {
    beforeToolCall(call) {
      if (call.toolName === "bash" && /rm\s+-rf\s+\//.test(String(call.input.command))) {
        return { action: "block", reason: "Refusing a recursive root delete." };
      }
    },
    afterToolCall(call, result) {
      auditLog.write({ ...call, isError: result.isError });
    },
  },
});
```

`beforeToolCall` runs before schema validation and the permission gate; returning
nothing (or `{ action: "allow" }`) proceeds, optionally with rewritten `input`;
`{ action: "block", reason }` short-circuits before the tool ever runs, and the model
sees that reason as the tool's result. `afterToolCall` runs for every call including
blocked, denied, and failed ones, and can return a replacement `ToolResultMessage` — or
nothing to keep the original. Both may be sync or return a `Promise`. This is the same
shape [Lifecycle hooks](/docs/hooks) describes for the CLI's shell-command hooks — the
SDK version is in-process functions instead of spawned processes, with no timeout to
configure because there's no subprocess to time out.

## Cost and usage accounting

Every `AssistantMessage` and the `turnEnd` event carry a `Usage`:

```ts
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number; // present when the model's ModelSpec.cost is known
}
```

```ts
agent.on("turnEnd", (event) => {
  log(`turn ${event.turnIndex}: ${event.usage.inputTokens} in / ${event.usage.outputTokens} out`);
});
```

`calculateCostUsd(spec, usage)` (from `@arcturn/ai`, see
[Models & providers](/docs/sdk-models#cost-accounting)) derives `costUsd` from a
`ModelSpec.cost` table — per-million-token rates for input, output, cache read, and
cache write, with cache rates falling back to the input rate when a provider doesn't
price them separately. `addUsage`/`emptyUsage` (exported from both `@arcturn/core` and
`@arcturn/ai`) fold multiple `Usage` records together for a running session total.
There is no built-in spend ceiling in `@arcturn/core` — see
[Agent options: what isn't here](/docs/sdk-agent-options#what-isnt-here) for the
reasoning and the pattern for building one yourself.
