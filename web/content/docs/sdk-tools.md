---
title: Custom tools
description: The Tool interface in full — schema, execute contract, ToolResult, abort signals — with a complete worked example.
section: Extend
order: 9.3
---

A tool is one object: a JSON-Schema definition the model sees, and an `execute`
function that does the work. This is the primary way to give an embedded agent
capabilities beyond the built-ins — a custom tool is *the* unit of extension.

## The `Tool` interface

From `packages/types/src/tools.ts`:

```text
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema; // Record<string, unknown> — a JSON Schema (2020-12 subset)
}

interface ToolResult {
  content: ToolResultContent[]; // TextContent | ImageContent
  isError?: boolean;
  /** Structured machine-readable payload stored on the ToolResultMessage. */
  details?: Record<string, unknown>;
}

interface ToolExecutionContext {
  cwd: string;
  /** Aborts when the user interrupts the run. */
  signal: AbortSignal;
  /** Ask the permission engine (may prompt the user) before a sensitive action. */
  requestPermission: PermissionRequester;
  /** Report incremental progress; safe to call many times. */
  onUpdate: (update: ToolUpdate) => void; // { text?: string; details?: Record<string, unknown> }
  sessionId: string;
  toolCallId: string;
}

interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}
```

The contract in one sentence: **`execute` must resolve with a `ToolResult` for every
expected outcome, including failure — `isError: true` is a normal return, not a
throw — and reject only for genuine programming errors** (a bug, not "the deploy
failed"). The loop treats a rejection as a bug: it's caught, but the resulting
`toolEnd` reads as a runtime failure rather than a clean tool-level error the model can
reason about and retry from.

## A complete worked example

```ts
import type { Tool } from "@arcturn/types";

const deployPreview: Tool = {
  definition: {
    name: "deploy_preview",
    description: "Deploy the current branch to a preview environment and return its URL.",
    parameters: {
      type: "object",
      properties: { env: { type: "string", enum: ["staging", "preview"] } },
      required: ["env"],
    },
  },
  async execute(input, ctx) {
    const decision = await ctx.requestPermission({
      toolName: "deploy_preview",
      toolCallId: ctx.toolCallId,
      subject: String(input.env),
      description: `Deploy this branch to ${input.env}`,
    });
    if (decision.behavior === "deny") {
      return { content: [{ type: "text", text: "Deploy declined." }], isError: true };
    }
    ctx.onUpdate({ text: "building…" });
    const url = await runDeploy(String(input.env), { signal: ctx.signal });
    return { content: [{ type: "text", text: `Deployed: ${url}` }], details: { url } };
  },
};

const agent = createAgent({ ...base, tools: [...tools, deployPreview] });
```

Walking through it:

- **`parameters` is the schema the model sees**, validated against the model's actual
  call before `execute` ever runs — a malformed call never reaches your code (see
  `validateToolInput` in `@arcturn/core`'s `schema.ts`).
- **`ctx.requestPermission`** routes through the same `PermissionEngine` every built-in
  tool uses. A rule, a mode, or a prior "always allow" can pre-approve this without ever
  prompting — see [Permissions from the SDK](/docs/sdk-permissions) for exactly how the
  request resolves.
- **`ctx.onUpdate`** streams progress as `toolUpdate` events — call it as many times as
  you like; it's fire-and-forget.
- **`ctx.signal`** is the run's `AbortSignal`. Pass it to anything cancelable
  (`fetch`, `child_process`, your own long-running call) so `agent.abort()` actually
  stops the work instead of merely stopping the agent from waiting on it.
- **`details`** rides on the `ToolResultMessage` alongside the human-readable `content`
  — the place for a machine-readable payload (a URL, an id, a diff) that a downstream
  consumer of the session (a UI, a log processor) wants without re-parsing text.

## Mixing tool sources

The model sees one flat toolbox regardless of where tools came from — mix custom
tools freely with `createDefaultTools()` and MCP-bridged tools:

```ts
import { createDefaultTools } from "@arcturn/tools";
import type { Tool } from "@arcturn/types";

declare const myCustomTools: Tool[]; // e.g. [deployPreview], plus mcpManager.tools()
const { tools: builtins } = createDefaultTools({ cwd });
const allTools = [...builtins, ...myCustomTools];
```

Swap the list at runtime with `agent.setTools(newTools)` — useful for adding an MCP
server's tools once it connects, or removing a tool mid-session.

## Error handling

Two different things can go wrong in a tool call, and they're handled differently:

- **An expected failure** (bad input the schema didn't catch, a downstream API
  returning 4xx, a file not found) → return `{ content: [...], isError: true }`. The
  model sees this as a normal tool result and can retry, ask a follow-up, or give up
  gracefully.
- **A programming error** (a null-pointer bug in your `execute`, an unhandled promise
  rejection) → let it throw or reject. The loop catches it, but the resulting
  `toolEnd` and the eventual `runEnd` (if the whole run can't continue) surface it as a
  failure rather than model-visible feedback — which is the right signal, because it's
  a bug in your tool, not something the model did wrong.

```ts
import { errorText } from "@arcturn/core";
import type { ToolExecutionContext, ToolResult } from "@arcturn/types";

async function execute(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const path = typeof input.path === "string" ? input.path : undefined;
  if (!path) {
    // Expected — the model sent something the schema alone couldn't reject.
    return { content: [{ type: "text", text: "path must be a string" }], isError: true };
  }
  try {
    const contents = await readSomething(path, ctx.signal);
    return { content: [{ type: "text", text: contents }] };
  } catch (error) {
    // Also expected: the read failed for an external reason. Report it, don't throw.
    return {
      content: [{ type: "text", text: `Could not read ${path}: ${errorText(error)}` }],
      isError: true,
    };
  }
}
```

## Hooks vs. permissions

Both `AgentHooks` and the permission engine can intervene around a tool call, but they
answer different questions:

- **Permissions** answer *"is this specific action allowed?"* — per-call, addressed to
  the user (or a rule standing in for one), and the vocabulary is allow/deny/ask. Only
  a tool that calls `ctx.requestPermission` is gated at all; nothing gates a tool from
  the outside.
- **Hooks** (`AgentOptions.hooks`) wrap *every* tool call unconditionally —
  `beforeToolCall` can block a call outright before it starts (for cases a permission
  rule can't express, like a regex over the raw command), and `afterToolCall` can
  observe or rewrite every result for audit logging. See
  [Advanced: hooks](/docs/sdk-advanced#hooks) for the full shape and an example.

The two compose: a hook can block a call before permissions are ever consulted, and a
tool's own `requestPermission` call still runs through the same engine either way.

## Bindable tools

`createSubagentTool`, `createTodoTool`, and `createPlanTool` (all from `@arcturn/core`)
implement an extra, optional `BindableTool` interface — a `bindAgent(controller)`
method the agent calls automatically when they appear in `tools`. You won't usually
implement this yourself; it exists so state tools can reach back into the owning
agent (to set todos, request plan approval, switch permission mode) without every
custom tool author needing that power. See [Advanced: sub-agents](/docs/sdk-advanced#sub-agents)
for `createSubagentTool` specifically.
