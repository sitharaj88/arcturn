---
title: Sub-agents, plan mode & todos
description: Delegate scoped work to child agents, and the structured plan/todo state tools.
section: Core concepts
order: 7
---

## Sub-agents

Real tasks are often too wide for one context window — "find every caller of this
function across the repo," "investigate why this test flakes," "read these five files
and summarize the relevant parts." Arcturn's `subagent` tool, from `createSubagentTool` in
`@arcturn/core`, lets the model delegate a self-contained piece of work to a scoped
child `Agent` with its own context window, tools, and model.

```ts
import { createSubagentTool } from "@arcturn/core";

const subagentTool = createSubagentTool({
  factory: (task) =>
    createAgent({
      llm,
      model: requireModel("anthropic/claude-haiku-4-5"), // cheaper model for delegated work
      systemPrompt: "You are a focused research sub-agent. Be thorough but concise.",
      tools: readOnlyTools, // give children a narrower tool set than the parent
      cwd: agent.cwd,
      permissions: { mode: "default" },
    }),
});

agent.setTools([...tools, subagentTool]);
```

The model calls it with a `task` (the complete instructions — a sub-agent cannot ask
follow-up questions, so state the task and the expected shape of the answer in full) and
an optional `description` for progress display.

What happens under the hood:

- The parent emits `subagentStart { agentId, task }`.
- The child's **entire event stream** re-publishes on the parent as
  `subagentEvent { agentId, event }` — a UI can render nested activity (the child's own
  tool calls, permission asks, even its own sub-agents) without knowing anything about
  what a sub-agent is.
- Aborting the parent's run cascades: the child is aborted too.
- When the child finishes, the parent emits `subagentEnd { agentId, resultText, isError }`
  and the tool call resolves with the child's final assistant text as its result.

Give every sub-agent its own tool instances — bindable tools (like `subagent`, `todo`,
and `plan` itself) hold a reference to whichever agent bound them last, so sharing one
instance between a parent and child causes state to leak across them.

## Named agents from markdown

Beyond the ad-hoc `factory` above, Arcturn discovers named agent specializations declaratively
from `.md` files, the same pattern as [skills](/docs/skills). `loadAgentDefs` (from
`packages/cli/src/agents.ts`) scans two roots in order — `~/.arcturn/agents` then
`<cwd>/.arcturn/agents` — and a project agent silently wins a name collision with a user
agent (reported as a warning naming both files).

```markdown
---
name: doc-reviewer
description: Reviews documentation for accuracy against source code
tools: read, grep, glob
model: anthropic/claude-haiku-4-5
---
You are a documentation accuracy reviewer. For every claim in the document, find the
corresponding source location and confirm it. Flag anything unverifiable or stale.
```

Recognized frontmatter, all optional:

| Key | Meaning |
|---|---|
| `name` | Defaults to the filename stem, normalized to `[a-z0-9-]`. |
| `description` | One-line summary shown to the model when it's choosing which agent to delegate to. |
| `tools` | A single line, either bare (`tools: read, grep, glob`) or YAML's inline flow sequence (`tools: [read, grep, glob]`, quoted items allowed). An unknown tool name (checked against the runtime's known tool set) is dropped with a warning rather than rejecting the whole file. |
| `model` | A model id, passed through uninterpreted — `agents.ts` itself never resolves it against the catalog. |

Everything after the frontmatter is the system prompt verbatim — no `$ARGUMENTS`-style
substitution, since a sub-agent's whole instructions come from the parent's `task`
argument at call time, not from typed arguments. An empty body is a malformed file and is
skipped with a warning, same as an empty skill body.

When the model calls `subagent` with an `agent` field, the parent resolves the name against
these loaded definitions (`runtime.ts`'s `createSubagent(task, def)`). The `agent` parameter
is only advertised to the model at all when at least one named agent is loaded — offering a
free-text field with nothing valid to put in it just invites the model to invent a plausible
name and fail the delegation.

### Precedence, narrowing, and inheritance

Three things a named agent's frontmatter controls, and exactly how each interacts with the
parent:

- **Tools narrow, never widen.** A non-`yolo` parent restricts children to an
  investigative tool set (read-only tools plus `fetch`, which still prompts through the
  parent) regardless of what the agent's `tools:` list says — delegating to a named agent
  can never be used to slip past a non-`yolo` parent's read-only restriction. A `tools:`
  list is intersected with what the permission mode already allows, so it can only shrink
  the set further.
- **Model precedence is agent → route → main.** The named agent's own `model:` wins if
  set (resolved via `resolveModelSpec`); otherwise the child gets `router.specFor("subagent")`
  — the `subagent` route described in [Model providers](/docs/providers#per-role-routing),
  which itself falls back to the main model if no `subagent` route is configured.
- **Permissions are inherited, not reset.** The child's permission rules are a copy of the
  parent's configured rules (`[...this.config.permissions]`), and its mode is `yolo` only
  if the parent's is — otherwise `default`. A deny the user configured on the parent cannot
  be sidestepped by delegating the same work to a sub-agent.

Everything else about a child follows the same shape as the ad-hoc case above:
`maxTurns` defaults to `SUBAGENT_MAX_TURNS` (64), overridable via `subagentMaxTurns` in
config — and the ceiling is announced, not sprung: with 9 turns left of the default 64,
the loop injects one user message telling the model to finish and deliver now, so a child
wraps up and reports instead of dying at the ceiling with its work done but undelivered
(the trip point, and the tight ceilings that get no warning, are in
[The wrap-up warning](/docs/sdk-agent-options#the-wrap-up-warning)). The child
shares the parent's `SessionStore` and working directory; and its cost
folds into the parent's running total the moment its `turnEnd` events arrive (via
`calculateCostUsd`), so `/cost` on the parent reflects everything its sub-agents spent too.

## Plan mode and todos

Two more state tools ship in `@arcturn/core`, both pure — they never touch the outside
world, only agent state, and both persist as a `state` entry in the session tree.

### `todo`

The model sends the **complete** todo list on every call — the list you send replaces
the stored one, not merges with it — with at most one item `inProgress` at a time:

```json
{ "todos": [
  { "text": "Add token bucket limiter", "status": "done" },
  { "text": "Write unit tests", "status": "inProgress" },
  { "text": "Update docs", "status": "pending" }
]}
```

Every call emits a `todoUpdate` event with the new list, so a UI can render live
progress without polling.

### `plan`

In any mode other than `plan`, calling `plan` just records the plan and emits
`planUpdate`. In `plan` mode specifically, it's the **only way out**: the tool asks the
configured permission requester directly (bypassing stored rules — a rule can't
pre-approve leaving plan mode) to show the user the plan text and get an explicit
approve/reject. On approval, the agent's permission mode switches to whatever
`approvedMode` was configured (`default` unless you override it) and execution tools
become available; on rejection, the agent stays in `plan` mode with the user's feedback
folded back into the conversation so it can revise.

```ts
import { createPlanTool, createTodoTool } from "@arcturn/core";

const tools = [
  ...createDefaultTools({ cwd }).tools,
  createTodoTool(),
  createPlanTool({ approvedMode: "acceptEdits" }),
];

agent.setPermissionMode("plan"); // start in plan mode — no mutation until a plan is approved
```

See [Permissions](/docs/permissions) for exactly how `plan` mode's enforcement (denying
every mutating tool) interacts with the `plan` tool's approval gate.
