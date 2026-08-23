---
title: Editor integration (ACP)
description: Run Arcturn as an in-editor agent over the Agent Client Protocol.
section: Extend
order: 10.5
---

## What ACP is

The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) is an editor↔agent
standard — the same kind of role LSP plays for language servers, but for coding agents.
An ACP-capable editor spawns the agent as a subprocess and talks to it over stdio; the
agent streams back message text, tool calls, plan updates, and permission requests, and the
editor renders all of it in its own UI instead of a terminal. `arcturn acp` is Arcturn speaking
this protocol, implemented in `packages/cli/src/acp/`.

For which editors currently support ACP and how to point one at a binary, consult your
editor's own ACP client documentation — that configuration surface lives outside this
repository and changes independently of it. What follows is exactly what `arcturn acp`
implements and how it maps onto Arcturn's own agent model; nothing here is a claim about any
particular editor's UI.

## Starting it

```bash
arcturn acp
```

No flags are ACP-specific beyond the ones every Arcturn invocation accepts — `--cwd`,
`--model`, `--permission-mode`, `--max-turns`. `--max-cost` is *not* forwarded to the
top-level runtime's own guard (which only ever watches the interactive/`--print` agent,
never an ACP session); instead each ACP session gets its own independent cost ceiling
internally, mirroring `arcturn serve`'s per-session `--max-cost`.

`arcturn acp` writes only valid ACP frames to stdout — anything you'd want to log goes to
stderr instead, per the protocol's own requirement that stdout carry nothing but the wire
protocol.

## Framing

The stdio transport is **newline-delimited JSON (NDJSON)**, not the `Content-Length`
header framing LSP uses: each message is one line of JSON, and messages must not contain
embedded newlines. This is implemented by `packages/cli/src/acp/protocol.ts`'s
`AcpConnection` — a hand-rolled JSON-RPC 2.0 peer over an injected pair of byte streams —
independently of the LSP client's `Content-Length` decoder, because the two protocols
genuinely frame differently.

## One `Agent` per ACP session

`session/new` can be called more than once on the same connection — an editor may hold
several conversation threads open against one `arcturn acp` process. Each ACP session id maps
to its own independent Arcturn `Agent` (its own checkpoint store, own message history), built
via the runtime's `buildSessionAgent` — the same primitive `arcturn serve` uses to host several
concurrent sessions off one runtime. Nothing about one session's conversation state can
leak into another's.

Permission routing is genuinely per-session too: each session's agent is built with its own
`onPermissionAsk`, bound to that session's id at construction time and never shared, so two
sessions' turns can overlap without one session's approval prompt ever reaching the wrong
dialog.

## Lifecycle

```text
initialize → session/new → session/prompt → (session/update × N) → prompt response
```

`session/cancel` can cut a turn short at any point; `session/load` resumes a session
created earlier, replaying its history as `session/update` notifications before the load
response — when the host supports it (see below, it's opt-in).

### `initialize`

Negotiates the protocol version (`arcturn acp` implements major version `1`; it responds with
whichever is lower between what the client requested and what it supports) and declares
capabilities:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": false, "sse": false }
  },
  "agentInfo": { "name": "arcturn", "title": "Arcturn", "version": "0.1.0" },
  "authMethods": []
}
```

- `image`/`audio` prompt capabilities are declined — Arcturn's own prompt seam doesn't yet
  accept multimodal user content from this path, so advertising them would be dishonest.
- `embeddedContext` is `true`: an ACP `resource` content block with inlined text is
  flattened into the prompt as `<file uri="...">...</file>`.
- `mcpCapabilities` are both `false`: `session/new`'s `mcpServers` field only accepts the
  required `stdio` variant today; Arcturn's own MCP manager can bridge `http`/`sse` transports
  in other contexts, but the ACP session-scoped wiring doesn't yet route through that path.
- `authMethods` is empty — Arcturn authenticates out of band (environment variables, config
  files), so a client should proceed straight to `session/new` with no login step.

The editor's own `clientCapabilities` (`fs.readTextFile`, `fs.writeTextFile`, `terminal`,
and the optional `elicitation` / `session.configOptions` sub-capabilities) are parsed and
kept for the life of the connection, and mirrored onto every session opened on it. Nothing
acts on them yet — Arcturn makes no `fs/*` or `terminal/*` call today — but a bridge that
adds one can check what this editor actually serves instead of calling blind. Capabilities
the schema marks unstable (`plan`, `auth`, `nes`, `positionEncodings`) are kept verbatim
rather than modelled.

### `session/new`

Requires `cwd`; accepts an optional `mcpServers` list (stdio-only, per the capability
above) that the session connects for the lifetime of that one conversation. If the host
implements mode support (see below), the response also carries the current permission mode
and every mode the client can switch to.

### `session/prompt` and streaming

The editor sends prompt content blocks (`text`, `resource`, `resource_link` — `image`/
`audio` are declined at `initialize`, so not sent); Arcturn flattens them to plain text and
runs one turn, translating every Arcturn `AgentEvent` into ordered `session/update`
notifications:

| Arcturn event | ACP `session/update` |
|---|---|
| `messageStream` (`textDelta`) | `agent_message_chunk` |
| `messageStream` (`thinkingDelta`) | `agent_thought_chunk` |
| `toolStart` | `tool_call` (`pending`), then immediately `tool_call_update` (`in_progress`) |
| `toolUpdate` | `tool_call_update` with the incremental text |
| `toolEnd` | `tool_call_update` (`completed` or `failed`), with content/`rawOutput` |
| `permissionRequest` | `tool_call_update` (`pending`) |
| `permissionDecision` | `tool_call_update` (`in_progress` on allow, `failed` on deny) |
| `todoUpdate` | `plan`, one entry per todo (`done`→`completed`, `inProgress`→`in_progress`, else `pending`) |
| `planUpdate` | `plan`, a single entry — Arcturn's `plan` tool is one free-text markdown plan, not ACP's structured checklist, so this is the closest honest fit |
| `subagentStart` / `subagentEnd` | `tool_call` / `tool_call_update`, kind `think`, id `subagent:<agentId>` |
| `turnEnd` | `usage_update` — `used` (this turn's prompt + completion tokens), `size` (the session model's context window), `cost` (cumulative session USD), when the host can size the session |
| *(no event — polled)* | `current_mode_update`, when the agent changed its own permission mode (see [Session modes](#session-modes)) |
| `runEnd` | Resolves the `session/prompt` response's `stopReason` (see the table below) |

Events with no verified ACP counterpart (`runStart`, `turnStart`, `subagentEvent`,
compaction/background-task/notice events) are dropped rather than mapped
to something invented. A tool call's `kind` (for the client's icon) comes from
`toolKindFor`: `read`/`ls` → `read`; `write`/`edit` → `edit`; `grep`/`glob` → `search`;
`bash` → `execute`; `fetch`/`websearch` → `fetch`; `task`/`agent`/`plan`/`todo` → `think`;
anything else → `other`.

### Stop reasons

ACP defines five `stopReason` values. Arcturn returns four of them, and only where its own
runtime genuinely makes the distinction:

| ACP `stopReason` | When Arcturn returns it |
|---|---|
| `cancelled` | `session/cancel` arrived, or the run ended with reason `aborted` |
| `max_turn_requests` | The agent loop hit its turn ceiling (`--max-turns`). The loop reports this as a `runEnd` *error*, so the adapter recognises the message it composes; the session is intact and another prompt continues it, which is exactly what this stop reason means |
| `max_tokens` | The turn's final assistant message stopped on the model's output limit |
| `end_turn` | Everything else, including a normally completed run |
| `refusal` | **Never.** Nothing in Arcturn's runtime models a refusal — the assistant stop reasons are `endTurn`, `toolCalls`, `maxTokens`, `aborted`, `error` — so a refusal arrives as ordinary `end_turn` text rather than a claim the adapter cannot back up |

A `runEnd` error that is *not* the turn ceiling is not a stop reason at all: it becomes a
JSON-RPC error response on `session/prompt`, because it really is a failure.

## Permissions

Arcturn's `permissionRequest` **event** is one-directional — it cannot carry a decision back
into the engine. The actual bridge is a `PermissionPrompt` function
(`acp.permissionPrompt(sessionId)`) bound to each session's agent, which turns a gated tool
call into a real `session/request_permission` request to the editor:

```json
{
  "sessionId": "sess_1",
  "toolCall": { "toolCallId": "tc_1", "title": "bash: npm test", "kind": "execute" },
  "options": [
    { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "allow-always", "name": "Always allow", "kind": "allow_always" },
    { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" },
    { "optionId": "reject-always", "name": "Always reject", "kind": "reject_always" }
  ]
}
```

The editor's response selects one option or reports `{ "outcome": { "outcome": "cancelled" } }`;
an `-always` choice is persisted as a session-scoped permission rule when the tool call
suggested one. `session/cancel` settles every pending permission request for that session
with a denial before the turn ends, per spec.

## Session modes

`session/new`'s `modes` and `session/set_mode` are wired to Arcturn's own `PermissionMode`
values one-to-one, so there's no translation table to keep in sync:

| ACP mode id | Arcturn permission mode | Description shown to the editor |
|---|---|---|
| `plan` | `plan` | Read-only: no tool that could change state may run. |
| `default` | `default` | Prompts before any tool that writes, executes, or fetches. |
| `acceptEdits` | `acceptEdits` | Auto-approves file writes and edits; other gated tools still prompt. |
| `yolo` | `yolo` | Auto-approves every gated tool call without prompting. |

Mode support is opt-in on the host side: it only appears (`session/new`'s `modes` field,
`session/set_mode` registered at all) when the host supplies both a mode getter and a mode
setter.

Changes the *agent* makes to its own mode are announced with a `current_mode_update`
notification (`{ "sessionUpdate": "current_mode_update", "currentModeId": "acceptEdits" }`).
Arcturn has exactly one such trigger today: approving a plan through the `plan` tool takes
the agent out of `plan` mode mid-turn. No `AgentEvent` reports that, so the adapter
reconciles the host's current mode after every event of a turn and notifies on a change.

A change the editor itself requested with `session/set_mode` is deliberately *not* echoed
back — the spec describes `current_mode_update` as how the agent tells the client about
changes it made itself, and the client already knows about its own.

## `session/load`

Optional, and only registered when the host provides it — the honest default, since
replaying history requires host-side transcript storage the adapter itself doesn't own.
When implemented, the spec requires the agent to replay the session's conversation as
`session/update` notifications *before* responding to `session/load`, resuming a live
conversation (the same `Agent`, able to continue the turn) rather than a read-only
transcript view.

## What's intentionally not implemented

- **`authenticate`** — no auth methods are advertised (`authMethods: []`), so there's
  nothing for this method to do yet.
- **`fs/read_text_file`, `fs/write_text_file`, `terminal/*`** — these are *client* methods
  in the ACP spec (the editor offers them to the agent); Arcturn uses its own sandboxed
  `read`/`write`/`bash` tools instead of calling back into the editor for file or terminal
  access. What the editor advertises for them is captured at `initialize` but not yet
  consulted. **Roadmap:** bridging `fs/read_text_file` is the one worth having, because it
  is the only way the agent can see a buffer the user has edited but not saved — today it
  reads what is on disk. That is a known gap, not a decision.
- **`elicitation/create`** — the spec's way for an agent to ask the user a structured
  question (a form, or a URL to visit) outside a permission prompt. Arcturn's only
  user-facing question is a tool-permission decision, which `session/request_permission`
  already covers.
- **`available_commands_update`** — Arcturn's slash commands are a TUI construct, not
  something the agent offers the editor as a command palette, so there is nothing honest to
  advertise here yet.
- **`config_option_update` / `session/set_config_option`, `session_info_update`** — Arcturn
  exposes no per-session config options over ACP beyond permission modes, and does not name
  or re-title sessions, so neither update would ever carry anything.
- **`http`/`sse` MCP transport** in `session/new`'s `mcpServers` — only `stdio` is wired
  through today; see the `mcpCapabilities` note above.

Everything in this list is absent because Arcturn has nothing real to put behind it, not
because the protocol was skimmed. `usage_update`, `current_mode_update` and the full
`stopReason` set *are* implemented, as described above.

## Testing without an editor

Because the adapter (`packages/cli/src/acp/adapter.ts`) takes a narrow dependency seam
(`AcpAgentDeps`) rather than importing the runtime directly, it can be driven by anything
that can speak NDJSON JSON-RPC over a pair of streams — including a scripted test harness,
which is how `packages/cli/src/acp/acp.test.ts` and `e2e.test.ts` exercise the whole
`initialize` → `session/new` → `session/prompt` → `session/update`* → response lifecycle
against a real `ArcturnRuntime` with no network access.
