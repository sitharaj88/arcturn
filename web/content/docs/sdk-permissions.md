---
title: Permissions from the SDK
description: PermissionEngine, rules, modes, the PermissionRequester callback, and the plan-mode exit gate — wired from code.
section: Extend
order: 9.4
---

[Permissions](/docs/permissions) covers the rule model, modes, and resolution order
conceptually. This page is the SDK angle: what `@arcturn/core` exports, and how to wire
a real approval UI into `onPermissionAsk`.

## What `createAgent` builds for you

`AgentOptions.permissions` (a `PermissionEngineOptions`) plus `onPermissionAsk`
construct a `PermissionEngine` internally — most hosts never construct one directly:

```ts
const agent = createAgent({
  ...base,
  permissions: {
    mode: "default",
    rules: [{ tool: "bash", specifier: "git *", action: "allow", scope: "user" }],
  },
  onPermissionAsk: async (request) => {
    const approved = await showApprovalDialog(request); // your UI
    return { requestId: request.id, behavior: approved ? "allow" : "deny" };
  },
});
```

`onPermissionAsk` and `permissions.requester` are the same slot — `onPermissionAsk`
takes precedence when both are set, so most code only ever sets `onPermissionAsk`.

## `PermissionEngineOptions`

| Field | Type | Default | Behavior |
|---|---|---|---|
| `mode` | `PermissionMode` | `"default"` | `"default" \| "acceptEdits" \| "yolo" \| "plan"` — see [Permissions](/docs/permissions#modes). |
| `rules` | `PermissionRule[]` | `[]` | Seed rules, evaluated in scope-then-specificity order — same schema as the config file's `permissions.rules`. |
| `requester` | `PermissionPrompt` | none | `(request: PermissionRequest) => Promise<PermissionDecision>`. With none configured, anything not settled by a rule or mode is **denied**, not assumed safe. |
| `onPersistRule` | `(rule: PermissionRule) => void \| Promise<void>` | none | Called whenever a decision carries a `persistRule`, so a host can write it to durable storage (e.g. the project's config file). |
| `readOnlyTools` | `string[]` | `["read", "grep", "glob", "ls"]` | Overrides `DEFAULT_READ_ONLY_TOOLS` — tools allowed to run in `plan` mode and without prompting in `default` mode. |
| `editTools` | `string[]` | `["write", "edit", "multiedit"]` | Overrides `DEFAULT_EDIT_TOOLS` — tools `acceptEdits` mode auto-approves. The default's third entry is a [reserved name no package registers](/docs/tools#multiedit-reserved-and-currently-inert), so only `write` and `edit` are reachable through it today. |
| `alwaysAllowTools` | `string[]` | `["todo", "plan"]` | Overrides `DEFAULT_ALWAYS_ALLOW_TOOLS` — pure state tools that pass silently, with no event emitted at all. |

`fetch` is deliberately **not** in the read-only default: it reads nothing local but can
send data to an arbitrary host, so it's gated like a mutating tool.

## Building a `PermissionEngine` directly

For a host that manages permissions outside of one `Agent` (a shared engine across
several agents, or a dry-run "would this be allowed" check), construct one yourself and
pass it as `AgentOptions.permissions`... actually `AgentOptions.permissions` takes
options, not an engine instance — `Agent` always builds its own. To reuse rule logic
standalone, use the exported matching functions directly:

```ts
import { matchRules } from "@arcturn/core";
import type { PermissionRule } from "@arcturn/types";

const rules: PermissionRule[] = [
  { tool: "bash", specifier: "git *", action: "allow", scope: "user" },
  { tool: "bash", specifier: "git push *", action: "deny", scope: "project" },
];

const winner = matchRules(rules, "bash", "git push origin main");
console.log(winner?.action); // "deny" — a more specific deny outranks a broader allow
```

`matchSpecifier(specifier, subject)` exposes the three specifier forms standalone —
command prefix (`"git *"`), path glob (`"src/**/*.ts"`), and exact string — useful for
previewing what a rule would match before it's added.

## The requester contract

Two related callback shapes exist, and it's worth being precise about which is which:

- **`PermissionRequester`** — `(request: Omit<PermissionRequest, "id">) => Promise<PermissionDecision>`.
  This is what `ToolExecutionContext.requestPermission` is: called *from inside a tool*,
  which has no request id yet — the engine assigns one.
- **`PermissionPrompt`** — `(request: PermissionRequest) => Promise<PermissionDecision>`.
  This is `AgentOptions.onPermissionAsk`: the host-level callback, which receives the
  full request including `id`, so a host resolving decisions asynchronously (over a
  socket, say) can correlate each decision with the request it answers.

```ts
const requester = async (request: {
  id: string;
  toolName: string;
  toolCallId: string;
  subject: string;
  description: string;
  suggestedRule?: { tool: string; specifier?: string; action: "allow" | "deny" | "ask" };
}) => {
  const approved = await showApprovalDialog(request);
  return {
    requestId: request.id,
    behavior: (approved ? "allow" : "deny") as "allow" | "deny",
    // Offer "always allow" using the tool's own suggested specifier:
    ...(approved && request.suggestedRule
      ? { persistRule: { ...request.suggestedRule, scope: "project" as const } }
      : {}),
  };
};
```

`suggestedRule` is filled in by tools that call `requestPermission` with a sensible
default specifier already chosen — that's the `[A] always allow src/**.ts` prompt in the
terminal. A UI can offer the same shortcut by attaching `persistRule` to an approving
decision; it's written back via `onPersistRule`.

## Plan mode's exit gate, from the SDK

`plan` mode denies every mutating tool outright — the only way out is the `plan` tool
(`createPlanTool` from `@arcturn/core`), which, while the agent is in `plan` mode, asks
the requester directly (bypassing rules and modes — a stored rule must not be able to
pre-approve leaving plan mode) and switches the mode itself on approval:

```ts
import { createPlanTool, createTodoTool } from "@arcturn/core";

const agent = createAgent({
  ...base,
  permissions: { mode: "plan" },
  tools: [...tools, createTodoTool(), createPlanTool({ approvedMode: "default" })],
  onPermissionAsk: async (request) => {
    const approved = await showApprovalDialog(request);
    return { requestId: request.id, behavior: approved ? "allow" : "deny" };
  },
});
```

Switch modes at runtime with `agent.setPermissionMode(mode)` — the same call the `/mode`
CLI command makes.

## Runtime rule management

```ts
agent.addPermissionRule({ tool: "write", specifier: "src/**/*.ts", action: "allow", scope: "session" });
agent.permissions.clearRules("session"); // drop everything added this session
console.log(agent.permissionMode); // current PermissionMode
```

`agent.permissions` exposes the live `PermissionEngine`, so a host UI can also call
`evaluate(toolName, subject)` to preview what a call would resolve to (`"allow" | "deny" | "ask"`)
without actually triggering a request.
