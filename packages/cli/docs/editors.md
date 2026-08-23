# Running arcturn inside an editor (ACP)

`arcturn acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) — a JSON-RPC 2.0 protocol, framed as newline-delimited JSON over
stdio, that lets an editor drive a coding agent as a subprocess. It's the
same idea as the Language Server Protocol, but for agents instead of
language servers: implement ACP once and any ACP-capable editor (Zed today;
JetBrains and Neovim clients exist too) can run you without a bespoke
plugin.

This page covers what ACP is in just enough depth to configure it, exactly
how to register `arcturn acp` as a custom agent in Zed, and — honestly — what
works today versus what doesn't yet. For the full protocol-coverage audit,
see [`ACP-STATUS.md`](../ACP-STATUS.md).

## How it works, briefly

An ACP-capable editor spawns your agent as a child process and talks to it
over that process's `stdin`/`stdout`. Every line is one JSON-RPC message; the
editor is the "client", your agent is the "agent". The exchange for one
conversation turn looks like:

1. **`initialize`** (client → agent) — protocol version and capability
   negotiation. arcturn answers with its own capabilities (`loadSession: true`,
   `promptCapabilities`, `mcpCapabilities`, no image/audio yet) and
   identifies itself.
2. **`session/new`** (client → agent) — the editor asks for a fresh
   conversation, giving a working directory and, optionally, MCP servers to
   bridge in for just this session. arcturn mints a session id, builds an
   isolated agent for it, connects any `mcpServers` given, and returns the
   available permission modes alongside the session id.
3. **`session/prompt`** (client → agent) — the editor sends the user's
   message. arcturn streams the whole turn back as **`session/update`**
   notifications (assistant text, tool calls and their status, plan
   updates) while it runs, then answers the original request with a
   `stopReason` once the turn ends.
4. **`session/request_permission`** (agent → client) — when a tool call
   needs approval (writing a file, running a shell command, ...), arcturn asks
   the *editor* instead of a terminal prompt, so the approval UI is native
   to wherever you're working. This is genuinely per-session — see
   "Concurrent sessions" below.
5. **`session/set_mode`** (client → agent, at any point) — switch a
   session's permission posture (`plan` / `default` / `acceptEdits` /
   `yolo`) from the editor's own mode picker, no restart needed.
6. **`session/load`** (client → agent) — reopen a session arcturn has
   previously stored, replaying its history into the editor and resuming it
   as a genuinely live conversation (the model remembers it, not just the
   transcript view).
7. **`session/cancel`** (client → agent, at any point) — stop the turn early
   (e.g. the user hit "Stop" in the editor).

Because the transport is stdio, **`arcturn acp` writes nothing to `stdout`
except protocol messages** — no banner, no logs. Diagnostics go to `stderr`,
which the spec explicitly permits for logging.

## Registering arcturn in Zed

Zed's external-agent configuration lives under the `agent_servers` key in
`settings.json` (`agent: open settings` → **External Agents**, or edit the
file directly: `zed: open settings`).

### If `arcturn` is installed and on your `PATH`

```json
{
  "agent_servers": {
    "Arcturn": {
      "type": "custom",
      "command": "arcturn",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

### Running a local build of this repo instead

If you're working from a checkout of this repo rather than an installed
`arcturn`, point `command` at Node and the built entry point directly:

```json
{
  "agent_servers": {
    "Arcturn (dev)": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/arcturn/packages/cli/dist/main.js", "acp"],
      "env": {}
    }
  }
}
```

Build it first: `pnpm --filter arcturn build` from the repo root. `args`
must be exactly `["acp"]` (or `[".../main.js", "acp"]` for the dev form,
optionally followed by the startup flags below) — `arcturn acp` takes no
positional arguments after `acp`.

### Credentials

arcturn expects provider credentials already available in the environment (or
via `arcturn auth login <provider>` beforehand) — ACP's `authenticate` method
isn't implemented (`authMethods: []`), so there is no editor-driven login
flow yet. If your shell environment isn't what Zed's subprocess inherits,
set the key(s) arcturn needs under `env` in the config above, e.g.:

```json
"env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
```

### Options at startup

`arcturn acp` accepts a handful of the same global flags as any other arcturn
invocation, applied once for the whole `arcturn acp` process:

- `--cwd <dir>` — working directory for tools, config and sessions. Zed
  itself also sends a `cwd` with every `session/new`, which arcturn session
  agents are built against; `--cwd` mainly matters for where `arcturn acp`
  resolves its own config/credentials from before the first session exists.
- `--model <id>` — override the configured model.
- `--permission-mode <mode>` — `default` (ask for anything not read-only,
  the default), `acceptEdits`, `yolo`, or `plan`. This is only the *starting*
  mode now — the editor's own mode picker can switch it per session
  afterwards via `session/set_mode` (see below); this flag just sets what a
  brand-new session opens in.
- `--max-turns <n>` — safety valve on model-loop iterations, applied to
  every session.
- `--max-cost <usd>` — abort a session's turn once *that session's own*
  cumulative spend crosses this ceiling. Each ACP session gets its own
  independent budget of this amount, not a combined one across every open
  thread — see [`ACP-STATUS.md`](../ACP-STATUS.md) for why a shared ceiling
  isn't what a multi-thread editor session wants anyway.

Add any of these to `args`, e.g. `["acp", "--permission-mode", "acceptEdits", "--max-cost", "5"]`.

### Session-scoped MCP servers

If your editor lets you attach MCP servers to a specific conversation
thread (ACP's `session/new`/`session/load` `mcpServers` field), arcturn connects
them for that session and makes their tools available to it — on top of
whatever `arcturn acp`'s own project/user MCP config already provides globally.
Only the `stdio` transport (a `command`/`args`/`env` you'd otherwise put in
an MCP config file) is wired up today; `http`/`sse`-transport session
servers are not yet, which is exactly what `initialize`'s
`mcpCapabilities: { http: false, sse: false }` tells the editor.

## What works today

Verified end to end against a real arcturn runtime (see `ACP-STATUS.md` for the
exact tests) — not just unit-tested in isolation:

- `initialize` → `session/new` → `session/prompt` → a full stream of
  `session/update` notifications → the `session/prompt` response.
- Assistant text streaming (`agent_message_chunk`) and reasoning
  (`agent_thought_chunk`).
- Tool calls with live status (`tool_call` → `tool_call_update`:
  pending/in_progress/completed/failed), including real file/shell tools.
- Gated tool calls routed through Zed's own permission UI via
  `session/request_permission`, with "allow once" / "always allow" /
  "reject" / "always reject" all mapped onto arcturn's permission engine
  (including persisting an "always allow" choice as a rule).
- `session/cancel` genuinely stopping an in-flight turn — including one
  blocked waiting on an unanswered permission prompt — not just reporting
  `cancelled` while work continues underneath.
- Todo-list and plan updates surfaced in Zed's Plan panel.
- **Multiple concurrent conversation threads**, each with its own isolated
  arcturn agent, history, MCP connections and permission routing — including
  under genuinely *overlapping* turns (two threads each mid-turn, each
  needing a permission decision at the same time): each decision reaches the
  thread that actually asked, never the other one. Earlier revisions of this
  integration rebound one shared permission slot per turn, which only held
  up as long as turns never truly overlapped; that slot is gone now — every
  session's `Agent` carries its own.
- **`session/load`** — reopening a session arcturn stored earlier replays its
  history into the editor's transcript *and* resumes it as a live
  conversation: the next message you send still has the model's memory of
  everything before the reload, not just a cosmetic transcript.
- **`session/set_mode`** — switch a session between `plan` / `default` /
  `acceptEdits` / `yolo` from the editor's own mode picker, mid-conversation,
  no restart.
- **Session-scoped MCP servers** (`stdio` transport) that the editor offers
  via `session/new`/`session/load`'s `mcpServers`.
- **`--max-cost`**, enforced independently per session.

## What doesn't work yet

Full detail and reasoning in [`ACP-STATUS.md`](../ACP-STATUS.md#honest-remaining-gaps).
In short:

- **`http`/`sse`-transport session-scoped MCP servers.** Only `stdio` is
  wired; `initialize` honestly declares `mcpCapabilities: { http: false, sse: false }`.
- **No inline diff review for edits.** The editor gets the final text via
  `tool_call`'s content-block variant, not a `diff` block to review before
  it lands.
- **`session/load`'s resumed agent shares tool wiring with `arcturn acp`'s own
  singleton agent** (hooks, checkpoints, taint, canary) rather than getting
  a fully independent set the way a brand-new `session/new` agent does — a
  narrow, pre-existing architectural gap (also documented on `arcturn serve`'s
  `ServableRuntime`), not something this pass could close without expanding
  its authorized `runtime.ts` edit scope. In practice this only matters if
  you `write`/`edit` a file inside a *reloaded* session while `arcturn acp`'s
  own top-level agent is doing something else at the exact same moment.
- **Autonomous mode changes aren't announced.** If arcturn's plan-mode exit gate
  switches a session's mode mid-turn (approving a plan takes it out of
  `plan` mode), the editor isn't told via `current_mode_update` — arcturn's
  event stream has no event carrying that transition yet. `session/set_mode`
  itself (the editor-driven direction) works fully.
- `authenticate` is unimplemented (`authMethods: []`) — credentials must
  already be in the environment or set up via `arcturn auth` first.
- No image/audio prompt content, no editor-served unsaved-buffer contents
  (arcturn reads from disk), no terminal integration for background/long-running
  commands.

None of these block the core "chat with arcturn, watch it edit files and run
commands, approve or deny as it goes, reload a thread later" workflow —
they're the honest edges.
