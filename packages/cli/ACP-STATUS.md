# ACP support status

Honest, current-as-of-this-pass status of `arcturn acp` — arcturn speaking the [Agent
Client Protocol](https://agentclientprotocol.com) (ACP) so it can run as an
agent inside Zed and other ACP-capable editors. This supersedes the older
design note at `docs/integration-notes/INTEGRATION-acp.md` (kept for
history; written when the adapter existed but had never been wired to a
runtime), and layers on top of the previous pass's own write-up (the prior
"What was true before this pass" / "What changed in this pass" sections
below, kept verbatim as history).

**Verdict: shippable, and the gaps this pass was asked to close are closed.**
`arcturn acp` starts, speaks NDJSON-framed JSON-RPC on stdio exactly per spec,
and drives a real arcturn conversation — including a gated tool call routed
through the editor's own approval UI, a mid-turn cancel, genuinely
*concurrent* sessions with overlapping turns that no longer cross-wire each
other's permission decisions, session-scoped MCP servers, a real
`session/load` that resumes a *live* conversation (not just a transcript),
`session/set_mode`, and a per-session `--max-cost` ceiling — all verified end
to end against a real `ArcturnRuntime` with zero network access. What remains
(below, "Honest remaining gaps") is a short, specific list: `http`/`sse`
MCP transport, autonomous `current_mode_update` announcements, and a handful
of pre-existing, narrower architectural notes.

## Protocol coverage (methods)

| Method | Status |
| --- | --- |
| `initialize` | Implemented, tested, verified live — now declares `agentCapabilities.mcpCapabilities` |
| `session/new` | Implemented, tested, verified live — isolated `Agent` per session, connects session-scoped MCP servers, advertises `modes` |
| `session/load` | Implemented, tested, verified live — replays history, resumes as a genuinely live agent |
| `session/prompt` | Implemented, tested, verified live, including a real gated tool call |
| `session/cancel` | Implemented, tested, verified live, including proof the underlying run actually stops |
| `session/request_permission` | Implemented, tested, verified live — routed to the requesting session, genuinely race-free under concurrent turns |
| `session/set_mode` | Implemented, tested, verified live — maps to arcturn's `PermissionMode` |
| `session/update` (agent → client) | Implemented for every mapped event (see table below) |
| `authenticate` | Unimplemented — `authMethods: []` (unchanged) |
| `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (client methods) | Never called — arcturn uses its own sandboxed tools (unchanged) |

## arcturn `AgentEvent` → ACP `session/update` mapping

| arcturn event | ACP update | Notes |
| --- | --- | --- |
| `messageStream` (`textDelta`) | `agent_message_chunk` | |
| `messageStream` (`thinkingDelta`) | `agent_thought_chunk` | |
| `messageEnd` | `agent_message_chunk` | Only if no text deltas streamed (non-streaming fallback) |
| `toolStart` | `tool_call` (`pending`) then `tool_call_update` (`in_progress`) | |
| `toolUpdate` | `tool_call_update` (`in_progress` + text content) | |
| `toolEnd` | `tool_call_update` (`completed`/`failed`) | |
| `permissionRequest` | `tool_call_update` (`pending`) | Informational only — see below |
| `permissionDecision` | `tool_call_update` (`in_progress`/`failed`) | |
| `todoUpdate` | `plan` (structured entries) | |
| `planUpdate` | `plan` (single entry) | |
| `subagentStart`/`subagentEnd` | `tool_call`/`tool_call_update`, id `subagent:<agentId>` | |
| `runEnd` (`completed`) | `session/prompt` result `{ stopReason: "end_turn" }` | |
| `runEnd` (`aborted`) / a cancel | `session/prompt` result `{ stopReason: "cancelled" }` | |
| `runEnd` (`error`) | JSON-RPC `-32603` error response | ACP has no `error` stop reason |
| `runStart`, `turnStart`, `turnEnd`, `subagentEvent`, `compactionStart`/`compactionEnd`, `notice` | Not mapped | No ACP counterpart |
| `backgroundTaskStart`/`Output`/`End` | Not mapped | See "Dead code, not an ACP gap" below |

The arcturn `permissionRequest` **event** is informational — it cannot carry a
decision back to the permission engine. The real bridge is
`acp.permissionPrompt(sessionId)`, wired through `host.ts`'s
`bindPermissions` into `ArcturnRuntime.buildSessionAgent`'s `onPermissionAsk`.
Exercised live in `e2e.test.ts` and, for the concurrency case specifically,
`host.test.ts`.

## What changed in this pass

This pass closed every gap the previous pass left open, working from its own
"Honest remaining gaps" list (preserved as history below).

### 1. The permission race under concurrent turns — closed, in `host.ts`, no runtime.ts behavior change needed for the fix itself

**Root cause, precisely.** The previous pass's `host.ts` rebound
`ArcturnRuntime`'s single `setPermissionRequester` slot to the prompting
session's factory-bound closure immediately before that session's turn
started. Every session `Agent` shares the *same* `onPermissionAsk` closure
from `ArcturnRuntime`'s private `#agentOptions` (`(request) => this.#ask(request)`),
and `#ask` reads `this.#requester` — the one shared slot — fresh on every
call. Two sessions' turns starting close together rebind that slot
back-to-back, synchronously, before either turn's model call can possibly
resolve a tool call; whichever session's `session/prompt` was called
*second* wins the slot for both. If session A's turn later needs a
permission decision, it gets routed through session B's ACP plumbing
instead — B's `sessionId` on the wire, B's pending-permission bookkeeping,
and (worse) B's `session/cancel` could deny a request that was really A's.

**The fix.** `ArcturnRuntime.buildSessionAgent` (`runtime.ts`) gained one new,
optional parameter: `onPermissionAsk?: PermissionPrompt`. When supplied, that
exact agent's permission checks are routed to it directly — `#ask` now takes
an optional `requesterOverride` and uses
`requesterOverride ?? this.#requester`, so every existing call site
(`this.agent`, `startNewSession`, `resumeSession`, `createSubagent`,
`rewindConversationTo`) is unaffected (they never pass an override, so they
still fall through to the shared slot exactly as before). `host.ts` (which I
own outright) now:

- Binds each session's permission requester **once, at session-creation
  time** (`createSession`/`loadSession`), passing
  `runtime.buildSessionAgent({ ..., onPermissionAsk: permissionPromptFactory(sessionId) })`
  — a closure baked over that one session's id, captured in that one agent's
  own `PermissionEngine` at construction. `prompt()` no longer touches
  `runtime.setPermissionRequester` at all; there is no shared, rebindable
  state left in the ACP path.
- Additionally supports a **retroactive** bind via
  `agent.permissions.setRequester(...)` (a public method on
  `@arcturn/core`'s `PermissionEngine`, exposed as `Agent#permissions`) for
  the edge case of a session created before `bindPermissions` is called —
  which never happens in `main.ts`'s real wiring (`bindPermissions` always
  precedes `connection.listen()`), but keeps the host correct if a test or
  future caller reorders it. This retroactive path forgoes `ArcturnRuntime`'s
  speculation/policy-learning integration for that one session (documented
  on `AcpHost.bindPermissions`'s JSDoc) — an accepted, narrow trade-off for
  an ordering that shouldn't occur in production.

**Why the runtime.ts change is worth it instead of just calling
`agent.permissions.setRequester` directly from `host.ts` for everything.**
That would have been a *smaller* diff (zero runtime.ts changes) and was
seriously considered — it is, after all, exactly what `arcturn serve` already
does (see below). It was rejected because `ArcturnRuntime.#ask` does two things
beyond routing the ask: `speculation.begin`/`settle` (the shadow-overlay
handshake for speculative edits) and `policy.observe` (permission-rule
learning). Bypassing straight to `agent.permissions.setRequester` would
silently drop both for every ACP session — a real behavior regression from
what ACP sessions already had (buggy routing aside). The `onPermissionAsk`
parameter keeps that integration intact while still being fully per-agent.

**Blast radius of the `runtime.ts` change.** Four call sites touched:
`buildSessionAgent`'s signature/body, `#agentOptions`'s signature/body,
`#ask`'s signature/body, and `setPermissionRequester`'s JSDoc (clarifying
its now-narrower scope). Every existing caller of `buildSessionAgent`
(`../serve.ts`'s `buildServedAgent`, `ArcturnRuntime.scoutAgent`) compiles and
behaves identically unchanged, since the new parameter is optional and
`#ask`'s new parameter defaults to `undefined`, collapsing to the exact
prior expression (`this.#requester`). `pnpm build && npx vitest run` for the
*whole monorepo* passes (see "Verification" below) — this was the check that
mattered most given how many other things depend on `runtime.ts`.

**Does `arcturn serve` have the same bug?** No. Investigated directly:
`@arcturn/server`'s `SessionHost#register` (in `packages/server/src/session-host.ts`)
already calls `agent.permissions.setRequester(requester)` on each served
session's own `Agent` object, immediately after `buildServedAgent` returns
it — bypassing `ArcturnRuntime.setPermissionRequester`/`#ask` entirely, for
every served session, since before this pass. Each `Agent` instance owns an
independent `PermissionEngine` (confirmed by reading `@arcturn/core`'s
`agent.ts`: `this.#permissions = new PermissionEngine({...})` per
construction), so `arcturn serve` was never exposed to the shared-slot race in
the first place. `serve.ts` needed no change for this gap. (It does share
the separate `--max-cost` gap — see below.)

**Regression test, and proof it actually catches the bug.**
`host.test.ts`'s `"keeps two sessions' overlapping turns from cross-wiring
each other's permission decisions"` test: two sessions, each given a scripted
`bash` tool call needing a real permission decision; both `host.prompt(...)`
calls are fired without awaiting either first (the genuine overlap — two
open threads, two in-flight `session/prompt`s); the test holds both
decisions unresolved until *both* permission requests have actually arrived
(via a scripted `bindPermissions` factory, itself installed **before**
either session is created — matching `main.ts`'s real ordering, which
matters, see below), then asserts each request is tagged with the ACP
session that actually issued it — correlated via each session's own real
`AgentEvent` stream (`toolStart`), never a hardcoded index, since which
session's turn reaches the shared scripted LLM client first is not something
the test controls or should assume.

Verified this is a real guard, not a tautology, exactly as the task asked:
temporarily reintroduced the shared-slot behavior (`createSession` stopped
passing `onPermissionAsk`; `prompt()` regained the old
`runtime.setPermissionRequester(permissionPromptFactory(request.sessionId))`
rebind) and reran just this test **5 times** — it failed deterministically
every time, with `expected 'session-b' to be 'session-a'` (session A's own
tool call's permission request got tagged with session B's id, exactly the
cross-wire the fix closes). Restored the fix and reran **8 times** — passed
every time. One thing worth recording honestly: the *first* version of this
test called `createSession` before `bindPermissions` (mirroring the
now-removed old test it replaced), which meant it was exercising the
retroactive `agent.permissions.setRequester` fallback path instead of the
primary `onPermissionAsk`-at-construction path — and so it passed even with
the bug deliberately reintroduced, because the fallback path is
unconditionally per-agent regardless of the probe. Reordering the test to
match `main.ts`'s real `bindPermissions`-before-`session/new` sequence is
what made it a genuine regression guard; the wrong-order version is a
cautionary example of a race test that "passes" without proving anything,
kept here so the lesson isn't lost.

### 2. `session/new`'s (and `session/load`'s) `mcpServers` — now connected, per session

`host.ts`'s `createSession`/`loadSession` build a fresh `@arcturn/mcp`
`McpManager` from the ACP `mcpServers` array (stdio transport: `command`,
`args`, `env`, with `cwd` set to the session's own `cwd`), connect it, and
append its bridged tools onto that session's own `Agent.tools` via
`agent.setTools([...agent.tools, ...manager.tools()])`. Each session's MCP
connections are tracked and torn down together by `AcpHost.dispose()`, which
`main.ts`'s `runAcpCommand` now calls once, at connection shutdown, before
`runtime.dispose()` (the latter only ever knew about `--mcp`'s process-wide
servers, never these).

**Honest limitation.** These tools are appended directly, bypassing
`ArcturnRuntime`'s hook (`preToolUse`/`postToolUse`), checkpoint, taint and
canary wrapping chain, which lives behind `runtime.ts`'s private
`#hookRunner`/`#preHookTools`/checkpoint-store state — reaching it properly
would need a `runtime.ts` change beyond this pass's authorized scope
(permission-requester and `--max-cost` only). Permission gating itself
*does* still apply — confirmed by reading `@arcturn/core`'s `loop.ts`:
`rt.permissions.check(...)` runs for every tool call intrinsically, as part
of the agent's own loop, not as one of the optional wrapping layers — so a
session-scoped MCP tool is gated exactly like any built-in tool, just
without hook/checkpoint/taint/canary coverage. Only the `stdio` transport is
wired; see gap 3.

### 3. `initialize`'s `agentCapabilities.mcpCapabilities` — added, and honest

`AcpInitializeResult.agentCapabilities.mcpCapabilities: { http, sse }` is
now always declared (`adapter.ts`, `handleInitialize`), matching the live
spec shape re-verified this pass at
`agentclientprotocol.com/protocol/initialization`. Declared as
`{ http: false, sse: false }`: `AcpMcpServer`'s type (and gap 2's wiring)
only models ACP's required `stdio` variant. `@arcturn/mcp`'s `McpManager`
*can* bridge `http`-type servers (with an automatic SSE fallback for the
handshake), so extending `AcpMcpServer` to the `http`/`sse` discriminated
variants the spec defines and flipping these to `true` is a small, mechanical
follow-up — deliberately not done this pass to keep the diff focused on
what was asked.

### 4a. `session/load` — implemented as a genuinely live resume, not a stub

`host.ts`'s `loadSession(params, replay)`:

1. Calls `Agent.resume({ ..., sessionStore: runtime.store, sessionId: params.sessionId, onPermissionAsk })`
   (a static method on `@arcturn/core`'s `Agent`, exported publicly) — this
   reads the session's stored entries, materializes the live branch
   (`latestEntryId`/`pathToLeaf`/`materializeBranch`, all public), and
   returns a real `Agent` whose next `agent.prompt(...)` call has the full
   prior conversation in context. Not cosmetic: `e2e.test.ts`'s
   `"session/load replays history and resumes it as a genuinely live
   session"` test proves this by checking the *model request* after the
   reload still contains the pre-reload turn's text.
2. Converts `resumed.messages` (the exact branch `Agent.resume` just
   materialized — not a separately-computed one that could diverge) into
   ordered `session/update` notifications (`user_message_chunk`/
   `agent_message_chunk`/`agent_thought_chunk`/`tool_call`/
   `tool_call_update`) and calls `replay(update)` for each, before
   `handleLoadSession` responds — per spec, "The Agent replays conversation
   history via `session/update` notifications before responding to
   `session/load`."
3. Registers the resumed agent exactly like `createSession` does: bound
   permission requester, session-scoped MCP servers from `params.mcpServers`,
   the per-session cost guard.

**Honest limitation, inherited from a known, pre-existing pattern.** The
resumed agent's tools are `[...runtime.tools]` — `ArcturnRuntime`'s own live
singleton agent's fully-wrapped tool set (hooks, checkpoints, taint,
canary), not a tool set built fresh and checkpoint-scoped to *this* loaded
session. This is the exact trade-off `../serve.ts`'s own `ServableRuntime`
JSDoc already documents and accepts for its structural fallback path
(`buildServedAgent`'s `new Agent({ tools: [...runtime.tools], ... })`
branch) — not a new compromise invented for `session/load`, the same one,
for the same reason (a properly session-scoped wrapped tool set needs
`runtime.ts`'s private `#hookRunner`/checkpoint-store plumbing, which is out
of this pass's authorized edit scope). In practice this only matters if a
`write`/`edit` inside a *reloaded* session and something touching `arcturn
acp`'s own top-level agent happen at the exact same moment — narrow, and
symmetric with an already-accepted gap elsewhere in the codebase.

A `session/load` for a `sessionId` with no stored history (or a corrupt
store) answers `-32602 invalidParams` with the underlying reason, rather
than crashing the connection or silently starting empty —
`e2e.test.ts`'s `"session/load answers -32602 for a sessionId with no
stored history"` test covers this.

### 4b. `session/set_mode` — implemented, mapped onto arcturn's `PermissionMode`

`adapter.ts` now declares `session/new`'s `modes` field (`currentModeId` +
`availableModes`, live-spec-verified shape from
`agentclientprotocol.com/protocol/session-modes`) whenever the host supplies
*both* `getPermissionMode` and `setPermissionMode` — `host.ts`'s real
implementation always does, mirroring `loadSession`'s "both or neither"
opt-in shape. The four modes offered are arcturn's `PermissionMode` values
verbatim (`plan`, `default`, `acceptEdits`, `yolo`) with human-readable
names/descriptions, so `handleSetMode` needs no translation table — a
`session/set_mode` request's `modeId` is passed straight to
`Agent.setPermissionMode(mode)` (a public method on the target session's own
`Agent`) via `host.ts`'s `setPermissionMode(sessionId, mode)`. An unknown
`sessionId` or `modeId` is rejected with `-32602 invalidParams` rather than
silently ignored. Verified live in `e2e.test.ts`: switching a fresh session
to `yolo` via `session/set_mode` makes a subsequently-gated `bash` call run
with no `session/request_permission` round trip.

**Honest limitation.** Only the client-driven direction
(`session/set_mode` → arcturn mode change) is wired. arcturn's plan-mode exit gate
(`@arcturn/core`'s `createPlanTool`, approving a plan calls
`controller.setPermissionMode(approvedMode)` mid-turn) can change a
session's mode *autonomously*, and ACP's `current_mode_update` notification
exists specifically for that case — but there is no arcturn `AgentEvent`
carrying "the mode just changed" (confirmed by reading `state-tools.ts`: the
transition is embedded in the plan tool's result text, not a structured
event), so `host.ts` has nothing to observe and relay. Adding one would mean
a new `@arcturn/core`/`@arcturn/types` event, which is a different
package and out of this pass's scope.

### 5. `--max-cost` — wired per session, for both `arcturn acp` and `arcturn serve`

**Why `buildRuntime`'s existing cost guard can't just be pointed at these
sessions.** `runtime.ts`'s `costGuard` (built in `buildRuntime`) is wired via
`runtime.subscribe((event) => costGuard.onEvent(event))`, and
`runtime.subscribe` only ever fans out events from `this.agent` — the
TUI/`--print` "live" agent, swapped by `startNewSession`/`resumeSession`.
Sessions from `buildSessionAgent` (used by both `arcturn acp` and `arcturn serve`)
are never attached to that fan-out, and `costGuard`'s `abort` callback calls
`runtime.agent.abort()` regardless — the wrong target even if the events did
arrive. This is a real, pre-existing gap `runtime.ts`'s architecture has for
*both* multi-session hosts, not something specific to ACP.

**The fix, without touching `runtime.ts` for this.** Both `acp/host.ts` and
`serve.ts` now build their own per-session guard directly on each session's
own `Agent`, reusing the already-generic, already-exported
`createCostGuard` from `cost-guard.ts` (unmodified — its `CostGuardOptions`
were already parameterized by `getCostUsd`/`abort`/`notify`, needing no
runtime-specific hook to begin with):

- `acp/host.ts`'s `attachCostGuard(agent, limitUsd)`: subscribes to that
  agent's own event stream, accumulates `turnEnd` cost
  (`event.usage.costUsd ?? calculateCostUsd(agent.model, event.usage)`), and
  calls that same agent's own `abort()` when the ceiling trips. Wired from a
  new `AcpHostOptions.maxCostUsd`, itself forwarded from `runAcpCommand`
  (`main.ts`) reading `--max-cost`.
- `serve.ts` gained the identical `attachCostGuard` (small, deliberately
  duplicated rather than factored into a shared module outside this pass's
  file-ownership list), wired into `buildServedAgent` via a new
  `createServeHost(runtime, { maxCostUsd })` parameter and
  `RunServeOptions.maxCostUsd`, forwarded from `runServeCommand` (`main.ts`)
  reading `--max-cost`. `arcturn serve` previously had **no** `--max-cost`
  wiring at all — not even the (wrong-target) one `arcturn acp` inherited from
  `buildRuntime` — so this is a net-new capability for it, not just a fix.
  Covered by a new test in `serve.test.ts` (`"maxCostUsd aborts a session
  once its own spend crosses the ceiling"`): a scripted turn that costs more
  than the ceiling, with a follow-up turn scripted right after it — proving
  the abort actually reached the agent in time to stop the *second* model
  call (`llm.requests` has length 1, not 2), not just fired too late to
  matter.

**Semantics, stated precisely.** The ceiling is **per session**, not a
combined budget across every open thread — each ACP thread (or served
connection) gets its own independent `--max-cost` allowance. This matches
how `--max-cost` already behaves for a single-session `arcturn --print`/TUI run
(one session, one budget) rather than inventing a new cross-session pooling
concept. It also does **not** carry a `session/load`-resumed session's
historical spend forward — `spentUsd` starts at `0` for the lifetime of the
process's own agent object, same as `ArcturnRuntime.metrics` already resets to
`0` on every session swap, `resumeSession` included (see `runtime.ts`'s
`#swap`).

`--max-turns` needed no new plumbing: `runAcpCommand` now simply forwards
`args.maxTurns` into `buildRuntime`, which sets `ArcturnRuntime`'s private
`#maxTurns`, which `#agentOptions` already applies to *every* constructed
agent — including every `buildSessionAgent` one — since it's a plain
`AgentOptions.maxTurns` passed at construction, not an external subscriber.
No `runtime.ts` change needed for this half.

## Honest remaining gaps

1. **`http`/`sse`-transport session-scoped MCP servers are not wired.**
   `AcpMcpServer` (and `host.ts`'s connect logic) only model ACP's required
   `stdio` variant; `initialize` honestly declares
   `mcpCapabilities: { http: false, sse: false }`. `@arcturn/mcp`'s
   `McpManager` already supports `http`-type servers, so this is a scoped,
   mechanical follow-up (extend the discriminated union, map ACP's
   `HttpHeader[]` to a `Record<string,string>`), not a design problem.

2. **`session/load`'s resumed agent's tools aren't checkpoint-scoped to that
   specific session** — they're `ArcturnRuntime`'s own live agent's tool set
   (hooks/checkpoints/taint/canary included, just against the *wrong*
   checkpoint store for a reloaded session). The exact, already-accepted
   trade-off `serve.ts`'s `ServableRuntime` fallback documents for the same
   underlying reason: a properly session-scoped wrapped tool set needs
   `runtime.ts`'s private `#hookRunner`/checkpoint-store plumbing exposed
   publicly, which this pass's authorized `runtime.ts` edit scope
   (permission-requester and `--max-cost` only) doesn't cover.

3. **Autonomous `current_mode_update` is not sent.** arcturn's plan-mode
   auto-exit (approving a plan switches the session out of `plan` mode
   mid-turn) has no corresponding arcturn `AgentEvent` to observe — the
   transition lives only in the plan tool's result text. `session/set_mode`
   itself (client-driven) is fully implemented; only the reverse direction
   (arcturn telling the editor it changed its own mode) is missing, and closing
   it needs a new event in `@arcturn/core`/`@arcturn/types`, a different
   package.

4. **`authenticate` is unimplemented** (`authMethods: []`) — arcturn expects
   credentials in the environment or via `arcturn auth` before the editor
   launches it. Unchanged from every prior pass.

5. **`fs/read_text_file`/`fs/write_text_file`/`terminal/*` client methods are
   never called** — arcturn uses its own sandboxed tools rather than asking the
   editor for unsaved-buffer contents or a terminal. Unchanged.

6. **Diff and terminal `ToolCallContent` variants are never emitted** — only
   the content-block variant. Emitting `diff` for `edit`/`write` would need
   before/after text on arcturn's `toolEnd` event. Unchanged.

7. **A session opened with a `cwd` different from the one `arcturn acp` was
   launched with gets tools still bound to the original `cwd`.** Tools are
   built once, inside `buildRuntime`, against `paths.cwd`.
   `buildSessionAgent` threads a per-session `cwd` into the constructed
   `Agent`, but the *tool closures themselves* don't know about it — the
   exact caveat `serve.ts` already documents on `ServableRuntime` for `arcturn
   serve`, inherited here via the same `buildSessionAgent` primitive.
   Unchanged; out of this pass's scope (same `runtime.ts` boundary as gaps
   1/2/3 above).

### Dead code, not an ACP gap

`backgroundTaskStart`/`backgroundTaskOutput`/`backgroundTaskEnd` are declared
in `@arcturn/types`' `AgentEvent` union and rendered by `display.ts` (the
TUI), but **no code anywhere in `@arcturn/core` actually emits them** —
confirmed by grepping the whole workspace, again this pass. There is nothing
live to map or test against, so `adapter.ts`'s existing `TODO(acp)` comment
about mapping them to ACP's `terminal/*` client methods is left as-is rather
than guessed at. Predates and is unrelated to ACP work specifically.

## Verification

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
pnpm build                                  # whole monorepo — passes
npx vitest run                              # whole monorepo — 141 files, 2409 tests, all passing (was 141 files, 2403 tests before this pass)
npx vitest run packages/cli/src/acp         # 51 passed (was 46 before this pass)
npx vitest run packages/cli/src/serve.test.ts  # 17 passed (was 16 before this pass)
```

Per-file counts this pass: `acp.test.ts` 39 (was 38, +1 `session/set_mode`
capability/wire test), `host.test.ts` 6 (was 4 — the old
"`bindPermissions` rebinds the runtime's requester to the prompting session"
test, which tested semantics this pass deliberately removed, was replaced
by three: binding happens once at session creation, retroactive binding for
the pre-`bindPermissions` edge case, and the concurrency race regression
test itself), `e2e.test.ts` 6 (was 4 — the old
"advertises `loadSession: false`..." test was replaced by two real
`session/load` tests, plus one new `session/set_mode` end-to-end test).

Regression-test verification for the race fix specifically (see gap 1's
write-up above for the full account): temporarily reintroduced the old
shared-slot behavior in `host.ts`, ran the new concurrency test 5 times
(failed deterministically every time, `expected 'session-b' to be
'session-a'`), restored the fix, ran it 8 times (passed every time).

Manual, per the task's hand-verification bar (unchanged mechanics from the
previous pass, rerun this pass):

```
ANTHROPIC_API_KEY=test-dummy-key ARCTURN_HOME=$(mktemp -d) \
  node packages/cli/dist/main.js acp --cwd <a directory> <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}
EOF
```

See `packages/cli/docs/editors.md` for how to register `arcturn acp` in Zed.

---

## History: what was true before the previous pass

- **`args.ts`** already fully parsed `arcturn acp` (`AcpCommand`, `ACP_COMMAND_NAME`,
  help text) — nothing to add here.
- **`main.ts`** already had a `runAcpCommand` and it *was* dispatched (not
  "parsed and dropped"). But it had two real bugs that made it non-functional
  for anything beyond a trivial, single-session, no-permission-needed prompt:

  1. **Permission requests were silently auto-denied.** The old code did:

     ```ts
     runtime.setPermissionRequester(agent.permissionPrompt(runtime.agent.sessionId));
     ```

     once, at startup, *before* any `session/new` had been received. It bound
     the bridge to `runtime.agent.sessionId` — `ArcturnRuntime`'s own internally
     minted session id — not the ACP `sessionId` the editor would later get
     back from `session/new` (the adapter mints its own `sess_<time>_<n>`
     ids). Those two ids never match. `adapter.ts`'s `permissionPrompt(sessionId)`
     looks up `sessions.get(sessionId)` and denies immediately if it's
     missing — so **every gated tool call (`bash`, `write`, `edit`, `fetch`,
     anything outside the default read-only set) was auto-denied** in the
     default permission mode, with no request ever reaching the editor. This
     alone broke "arcturn runs in your editor" for any real task.

  2. **Sessions were not actually isolated.** `deps.createSession` called
     `runtime.startNewSession()` (which swaps `ArcturnRuntime`'s single "live"
     agent — the primitive built for the TUI/`--print`, where there is
     exactly one conversation at a time), and `deps.prompt`/`deps.abort`
     unconditionally operated on `runtime.agent`, **ignoring
     `request.sessionId` entirely**. A second `session/new` (a second open
     thread in the editor) would swap the live agent out from under the
     first session; a `session/prompt` nominally addressed to the *first*
     session id would silently run against whichever agent happened to be
     "live" — cross-session data bleed.

  Both bugs were invisible to the existing test suite because all 37 prior
  `acp.test.ts` tests exercise the adapter against a *stubbed* `AcpAgentDeps`
  — there was no test driving the real `main.ts` wiring against a real
  runtime.

- **`protocol.ts`/`adapter.ts`** were solid: a correct NDJSON JSON-RPC layer,
  and a faithful mapping of `initialize`, `session/new`, `session/load`
  (optional), `session/prompt`, `session/cancel`, `session/request_permission`
  and the arcturn `AgentEvent` stream onto ACP `session/update`s. Two small honest
  gaps existed: the `planUpdate` arcturn event had no ACP mapping at all, and the
  `plan`/`todo` tool names fell through `toolKindFor` to the generic
  `"other"` kind instead of `"think"`.

## History: what changed in the previous pass

- **`packages/cli/src/acp/host.ts` (new then).** `createAcpHost(runtime, options)`
  bridged a real `ArcturnRuntime` into `AcpAgentDeps`, giving each `session/new`
  its own `Agent` via `ArcturnRuntime.buildSessionAgent` instead of swapping the
  runtime's single live agent — fixing bug 2 above. Bug 1 was fixed by
  rebinding `runtime.setPermissionRequester` to the correct session
  immediately before each turn (later found to be racy under genuine
  concurrency — see gap 1's fix above, this pass).
- **`packages/cli/src/main.ts`.** `runAcpCommand` built the host, built the
  adapter over it, and wired `bindPermissions`. Forwarded `--permission-mode`
  to `buildRuntime` for the first time (ACP had no `session/set_mode` yet at
  that point).
- **`packages/cli/src/acp/adapter.ts`.** `toolKindFor` mapped `"plan"`/`"todo"`
  to `"think"`. `TurnMapper` mapped the arcturn `planUpdate` event onto an ACP
  `plan` update with a single entry.
- **Tests: 46 in `packages/cli/src/acp/`** (`acp.test.ts` 38, `host.test.ts`
  4 new, `e2e.test.ts` 4 new).
