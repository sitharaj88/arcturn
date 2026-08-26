---
title: Server mode
description: Expose Arcturn sessions to remote clients over a typed WebSocket protocol.
section: Extend
order: 10
---

## Why a server mode

The same `Agent` that runs in the CLI or in your own process can run behind a server and
be driven remotely — a web UI, a mobile app, a teammate's editor — all talking the same
typed protocol. `@arcturn/protocol` defines the wire format; `@arcturn/server`'s
`ArcturnServer` implements a WebSocket server around a `SessionHost` that speaks it. The
CLI wires this together as `arcturn serve`, described below; for driving Arcturn *from inside
an editor* rather than a browser or a custom client, see [Editor integration (ACP)](/docs/acp)
instead — it's a different protocol with a different threat model.

## Starting a server

```bash
arcturn serve
#  listening on ws://127.0.0.1:54217
#  token: 9f2c1a7e4b3d0f6a8c5e2b1d9f4a7c3e
#  attach with: arcturn attach ws://127.0.0.1:54217 --token 9f2c1a7e4b3d0f6a8c5e2b1d9f4a7c3e
```

Flags, from `packages/cli/src/args.ts`:

| Flag | Meaning |
|---|---|
| `--host <iface>` | Interface to bind. Defaults to `127.0.0.1`. |
| `--port <n>` | Port to bind. Omitted (or `0`) picks an OS-assigned ephemeral port. |
| `--token <secret>` | Shared auth token. Omitted auto-generates one; `--token ""` explicitly disables auth (loopback binds only — see below). |
| `--web` | Also serve the browser client over a second HTTP listener. |
| `--web-port <n>` | Port for the browser client. Omitted picks one. |
| `--web-origin <origin>` | Extra browser origin allowed to open the WebSocket. Repeatable. |
| `--max-cost <usd>` | USD ceiling applied independently to *each* served session. |

`arcturn attach ws://host:port [--token ...]` drives a session hosted by another `arcturn
serve` from a second terminal.

## Threat model

Read this before binding anything other than loopback. A connection that completes
authentication (or, when no token is configured, *any* connection) gets **full tool
execution as the user running `arcturn serve`** — the same `bash`, `write`, `edit`, and network
tools the local CLI has, gated by the same permission rules. Holding the token is
equivalent to holding a shell as that user for anything the configured permission mode
allows.

- `arcturn serve` speaks plain `ws://`, never `wss://`. Prefer binding loopback and
  tunnelling (an SSH port-forward, Tailscale, etc.) over exposing a non-loopback interface
  directly.
- **A token is generated even on loopback**, whenever one isn't supplied. A same-machine
  login with no token at all would let any other local user, process, browser tab, or
  malware connect and get full tool execution too — loopback narrows the attack surface to
  "this machine," but doesn't make every process on it trustworthy.
- **Binding a non-loopback interface with no token is a hard refusal.** Passing `--token
  ""` (explicitly disabling auth) on anything other than `127.0.0.1` / `localhost` / `::1`
  throws before the runtime is even built: `Refusing to bind <host> without a token: anyone
  who can reach this port would get full tool execution as this user.` There is no flag to
  force past this.
- Treat the token like a credential: don't log it, leave it unquoted in shell history, or
  send it over an unencrypted channel to an untrusted network.
- **Binding a non-loopback interface prints a one-line stderr warning** every time, right
  after the URL: `serving unencrypted ws:// on a non-loopback interface; anyone with the
  token has full tool execution as your user`. It doesn't block the bind (unlike the
  no-token case above) — it's a reminder for the loopback-and-tunnel setup this doc
  recommends.

## DoS limits

A handful of bounds keep one connection from degrading the server for everyone else
(`packages/server/src/ws-server.ts`, `session-host.ts`) — all overridable via constructor
options for embedders, though `arcturn serve` itself does not yet expose flags for them:

| Limit | Default | Behavior past the limit |
|---|---|---|
| Max WebSocket frame size (`maxPayloadBytes`) | 4 MiB | `ws` closes the connection with code 1009. The largest legitimate frame is one streamed event (a `messageStream`/`toolEnd` chunk), never a whole file — tools stream file contents in bounded chunks upstream. |
| Max concurrent connections (`maxConnections`) | 32 | A new connection is closed with code 1013 ("try again later") before it can authenticate. |
| Max concurrent live sessions (`maxSessions`, on `SessionHost`) | 16 | `createSession`/`openSession` (for a session not already live) reject with `error.code: "invalidRequest"` — the same code used for every other client-caused capacity/validation refusal on this wire. |
| Heartbeat interval | 30s | Every connection is pinged on this interval; one that hasn't ponged back since the previous tick is presumed dead and terminated, which also unsubscribes it from whatever sessions it was observing. |
| Backpressure threshold (`backpressureThresholdBytes`) | 1 MiB | Once a connection's outbound buffer exceeds this, further session-event pushes to it are dropped (not queued) rather than growing memory without bound; responses to that connection's own requests still go out. |
| Backpressure sustained window (`backpressureSustainedMs`) | 15s | A connection that stays over the backpressure threshold for this long — essential sends included — is presumed stuck and terminated outright. |

## Authenticating a connection

When a server has a token configured, the *first* frame a client sends over the socket
must be:

```json
{ "id": "0", "method": "authenticate", "params": { "token": "9f2c1a7e4b3d0f6a8c5e2b1d9f4a7c3e" } }
```

Anything else as the first frame — a `listSessions` call, a malformed frame, a wrong token
— closes the connection with an error rather than proceeding. A server with no token
configured (only reachable via an explicit loopback `--token ""`) accepts any first frame
normally.

## Wire protocol

Every message is one of two shapes:

```json
// Client → server (a request)
{ "id": "1", "method": "listSessions" }
{ "id": "2", "method": "createSession", "params": { "cwd": "/repo", "model": "anthropic/claude-sonnet-4-5" } }
{ "id": "3", "method": "openSession", "params": { "sessionId": "sess_abc" } }
{ "id": "4", "method": "prompt", "params": { "sessionId": "sess_abc", "text": "add a test" } }
{ "id": "5", "method": "steer", "params": { "sessionId": "sess_abc", "text": "also update the changelog" } }
{ "id": "6", "method": "abort", "params": { "sessionId": "sess_abc" } }
{ "id": "7", "method": "permissionDecision", "params": { "sessionId": "sess_abc", "decision": { "requestId": "req_1", "behavior": "allow" } } }
{ "id": "8", "method": "setModel", "params": { "sessionId": "sess_abc", "model": "openai/gpt-4o" } }
{ "id": "9", "method": "listModels" }
{ "id": "10", "method": "sessionHistory", "params": { "sessionId": "sess_abc" } }
{ "id": "11", "method": "deleteSession", "params": { "sessionId": "sess_abc" } }
{ "id": "12", "method": "resolveContext", "params": { "sessionId": "sess_abc", "query": "src/auth.ts" } }
{ "id": "13", "method": "permissionState", "params": { "sessionId": "sess_abc" } }
{ "id": "14", "method": "setPermissionMode", "params": { "sessionId": "sess_abc", "mode": "plan" } }
{ "id": "15", "method": "listCommands" }
{ "id": "16", "method": "compact", "params": { "sessionId": "sess_abc" } }
{ "id": "17", "method": "exportSession", "params": { "sessionId": "sess_abc", "format": "markdown" } }
{ "id": "18", "method": "mcpStatus" }
{ "id": "19", "method": "pendingChanges", "params": { "sessionId": "sess_abc" } }
{ "id": "20", "method": "applyChanges", "params": { "sessionId": "sess_abc", "paths": ["src/app.ts"] } }
{ "id": "21", "method": "discardChanges", "params": { "sessionId": "sess_abc" } }
{ "id": "22", "method": "listCheckpoints", "params": { "sessionId": "sess_abc" } }
{ "id": "23", "method": "rewindTo", "params": { "sessionId": "sess_abc", "checkpointId": "turn_7", "confirmation": "3f9c…" } }
{ "id": "24", "method": "backgroundAgents" }
{ "id": "25", "method": "startBackgroundAgent", "params": { "task": "fix the flaky retry test" } }
{ "id": "26", "method": "cancelBackgroundAgent", "params": { "id": "bg-a1b2c3d4" } }
{ "id": "27", "method": "adoptBackgroundAgent", "params": { "sessionId": "sess_abc", "id": "bg-a1b2c3d4" } }
{ "id": "28", "method": "orgMemory" }
{ "id": "29", "method": "proposeOrgMemory", "params": { "role": "developer", "text": "this repo's vitest needs --run" } }
{ "id": "30", "method": "revokeOrgMemory", "params": { "id": "m4c1e9" } }
{ "id": "31", "method": "listWorkflows" }
{ "id": "32", "method": "runWorkflow", "params": { "sessionId": "sess_abc", "name": "ship-fix", "input": "the retry test flakes" } }
{ "id": "33", "method": "workflowStatus", "params": { "runId": "20260825-a1b2c3" } }
{ "id": "34", "method": "resumeWorkflow", "params": { "sessionId": "sess_abc", "runId": "20260825-a1b2c3", "answer": "per-tenant" } }
```

```json
// Server → client
{ "kind": "response", "id": "4", "result": { "accepted": true } }
{ "kind": "response", "id": "9", "error": { "code": "sessionNotFound", "message": "Session sess_xyz does not exist" } }
{ "kind": "event", "sessionId": "sess_abc", "event": { "type": "toolStart", "toolCallId": "tc_1", "toolName": "bash", "input": { "command": "npm test" } } }
{ "kind": "sessions", "sessions": [{ "sessionId": "sess_abc", "cwd": "/repo", "title": "add a test" }] }
```

Every request carries a client-chosen `id`; the matching response echoes it back, so a
client can correlate requests and responses over one persistent connection without
head-of-line blocking. Everything else the server pushes — every `AgentEvent` for every
session the client has open — arrives as `{ kind: "event", sessionId, event }`, the exact
same `AgentEvent` union `agent.subscribe(...)` sees locally. One event model, whether the
agent is in your process or across the network.

Error codes (`ErrorCode` from `@arcturn/protocol`) include `invalidRequest`,
`sessionNotFound`, and `sessionBusy`, among others — check `error.code` rather than
pattern-matching `error.message`, since the message text is not a stable contract.

## Request/response walkthrough

A typical session, client-initiated:

1. `{ method: "createSession", params: { cwd, model } }` → server creates an `Agent`,
   responds with a session id.
2. `{ method: "prompt", params: { sessionId, text } }` → server calls `agent.prompt(text)`;
   the response acknowledges receipt, and the actual work streams back as `event`
   messages (`runStart`, `toolStart`, `messageStream`, ... `runEnd`) as it happens.
3. If the run needs a permission decision, the server emits an `event` carrying
   `permissionRequest`; the client resolves it with
   `{ method: "permissionDecision", params: { sessionId, decision } }`.
4. `{ method: "steer", params: { sessionId, text } }` injects a message mid-run, exactly
   like `agent.steer()` locally — including the mention and `/name` expansion `prompt`
   gets, so the same text means the same thing whether the session was busy or idle.
5. `{ method: "abort", params: { sessionId } }` cancels the in-flight run.

## The model catalog

`listModels` answers with every model this server can be switched to — the same catalog
`arcturn --list-models` prints, from the same source. It takes no params and touches no
session: the catalog belongs to the server, not to a conversation. It exists so a client
can render a real model picker instead of guessing from the ids one session happened to
announce.

```json
// Client → server
{ "id": "9", "method": "listModels" }

// Server → client
{
  "kind": "response",
  "id": "9",
  "result": {
    "models": [
      {
        "id": "anthropic/claude-sonnet-5",
        "provider": "anthropic",
        "displayName": "Claude Sonnet 5",
        "contextWindow": 1000000,
        "maxOutputTokens": 128000,
        "cost": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": 2.5 },
        "apiKeyEnv": "ANTHROPIC_API_KEY",
        "credentials": "present"
      }
    ]
  }
}
```

`id` is what `setModel` accepts. `cost` is USD per million tokens, and **its absence means
the price is unknown, not zero** — a model that genuinely costs nothing reports
`{ "input": 0, "output": 0 }`, and a model nobody has published a rate for reports no
`cost` at all. Rendering the missing case as `$0.00` tells the user something false; say
"pricing unknown" instead, which is exactly what `--list-models` prints.

`credentials` is three-valued, because a picker is only useful if it can say which models
you can actually run:

| Value | Meaning |
| --- | --- |
| `"present"` | The server found a key for this model in its own environment. |
| `"absent"` | The model names an environment variable and it is not set — the server would refuse to start a session on it. |
| `"unknown"` | The server cannot tell from the environment alone: the model names no variable (ambient AWS or Google credentials), or it is an `openai-compatible` endpoint that may need no key at all. |

`apiKeyEnv` is the *name* of that variable, so a client can tell the user what to set. The
value is never on the wire, and the entry carries nothing else: `@arcturn/protocol`'s
`validateModelCatalog` copies out only the fields above, at both ends.

`listModels` is **optional and additive**. A server built before it existed answers
`{ "code": "invalidRequest", "message": "Unknown method: \"listModels\"" }` and keeps the
connection open, so `ProtocolClient.listModels()` translates that one rejection into
`undefined` — "this server has no catalog" — and a client degrades to whatever it did
before. Every other failure still rejects, so a broken catalog is never mistaken for an
old server. Adding it did **not** bump `PROTOCOL_VERSION`; see [Versioning](#versioning).

## Replaying a session

`openSession` subscribes your connection to a session's **future** events and replays
nothing. `sessionHistory` is what answers "what was already said" — the verb a client needs
to render a conversation it did not watch happen.

```json
// Client → server
{ "id": "10", "method": "sessionHistory", "params": { "sessionId": "sess_abc" } }

// Server → client
{
  "kind": "response",
  "id": "10",
  "result": {
    "sessionId": "sess_abc",
    "events": [
      { "type": "runStart", "sessionId": "sess_abc", "prompt": { "role": "user", "content": [{ "type": "text", "text": "add a test" }], "timestamp": 1 } },
      { "type": "messageEnd", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Done." }], "model": "anthropic/claude-sonnet-5", "usage": { "inputTokens": 12, "outputTokens": 3, "cacheReadTokens": 0, "cacheWriteTokens": 0 }, "stopReason": "endTurn", "timestamp": 2 } },
      { "type": "runEnd", "reason": "completed" }
    ],
    "truncated": false,
    "droppedEvents": 0
  }
}
```

**It replays `AgentEvent`s, not a message list.** That is the whole design: a client folds
history through the *same* reducer it already runs on `{ kind: "event" }` frames, so a
transcript rebuilt from disk and one watched live are the same code path and cannot drift.
A projected `{ role, text }[]` would have been smaller and would have forced every client
to grow a second renderer deciding all over again how a tool call, a denied permission or a
compaction reads.

It is a faithful projection, not a recording. Only the resulting messages were stored, never
the token stream that produced them, so a replayed assistant turn arrives as one
`messageEnd` where a live client saw a `messageStream` per delta. Two rules keep it honest:
every string comes from the stored entry that carried it, and only event types the live
stream also emits are used — a stored `label`, or a state entry's `model`, is dropped rather
than given a shape no client has ever seen. So the replay can never put a class of data on
the wire that watching the session live would not already have shown the same client.

Only the **active branch** is replayed — the path from the root to the newest entry, exactly
what `Agent.resume` materializes. A session that was rewound has abandoned branches in its
file, and replaying those would show a conversation the agent itself will never continue.

**It is bounded, and it says so.** The payload is capped at 1 MiB of serialized events and
1000 events, whichever binds first, keeping the newest and cutting at a turn boundary. 1 MiB
is not a round number picked for looking reasonable: it is the server's own backpressure
threshold — the point at which it already treats a connection as congested — and a quarter of
the 4 MiB frame cap above which `ws` closes the socket. A history response is *essential*
traffic and so is never dropped by the backpressure policy, which is exactly why it must not
be the frame that wedges the socket.

When the cap bites, `truncated` is `true` and `droppedEvents` says how many were dropped from
the oldest end. **A client that sees `truncated` must tell the user earlier messages are not
shown**; a transcript that quietly starts mid-conversation reads as the whole conversation,
which is the silent wrong answer this field exists to prevent.

`sessionHistory` is **optional and additive**, on the same terms as `listModels`: an older
server answers `invalidRequest` and `ProtocolClient.sessionHistory()` translates that one
rejection into `undefined`, leaving a client to show the empty transcript it showed before.
Safe to translate because the verb only reads — `undefined` costs a caller a transcript, not
a guarantee. It did **not** bump `PROTOCOL_VERSION`; see [Versioning](#versioning).

## Deleting a session

```json
// Client → server
{ "id": "11", "method": "deleteSession", "params": { "sessionId": "sess_abc" } }

// Server → client
{ "kind": "response", "id": "11", "result": { "ok": true } }
```

Permanent: the header, every entry, and the file behind them. There is no trash and no undo.

The **engine** owns the deletion. A client unlinking the `.jsonl` itself would be a second
implementation of session storage living outside the process that owns it: it could not see a
session still live in the server's memory, and it could not know whether a run was in flight.

- **A session running a turn is refused** with `sessionBusy`. Abort the run first. Deleting
  the file out from under an agent still appending to it is not a thing to do quietly.
- **A live but idle session is deleted and evicted** from the server in the same operation.
  Every connection observing it is sent a final
  `{ "type": "notice", "level": "warn", "text": "Session … was deleted." }` on that session's
  event stream *before* its subscription is dropped — an ordinary event, so a client renders
  it with whatever it already does for engine diagnostics rather than needing a new frame kind.
- **The store goes first, the eviction second.** Telling every attached client "this was
  deleted" and then discovering the store could not delete it would be a lie that leaves the
  session on disk. Done this way, a store failure surfaces as an error with the session intact.
- A `SessionStore` that does not implement the optional `delete(sessionId)` makes the server
  **refuse**, loudly, rather than guess at which files back it — the same refusal `setModel`
  makes without a `resolveModel`.

`deleteSession` is optional and additive too, but a client must **not** read an older server's
`invalidRequest` as success — nothing was deleted. `ProtocolClient.deleteSession()` therefore
rejects rather than degrading; `isUnsupportedMethodError(error)` from `@arcturn/protocol` is
how a client tells "this engine is too old" from "this session is busy".

## Context: mentions and attachments

A `prompt`'s (and a `steer`'s) `text` is **not** passed to the model verbatim. The server
expands `@path` mentions against the session's `cwd` first, using the same `expandMentions`
the TUI and `--print` call — so `@src/auth.ts` reaches the model as the file, not as six words about a
file. Before this existed, that expansion ran only in the local CLI, and every remote
client was silently degraded; see RFC 0005 §0.

A mention may name a **line range** — `@src/auth.ts:12-34`, or `@src/auth.ts:12` for a
single line — in which case only those lines are injected, headed as an excerpt. It is the
same feature, the same convention and the same reader as a `file` attachment's `range`;
see [Attachments](#attachments).

One exception, covered under [Commands](#commands): a prompt that *is* a command — one
beginning with `/name` — expands into that skill's body instead, and the body's own
mentions are left alone. A prompt is either a command or it is prose, never both.

A mention that resolves outside the workspace is **refused, not read** — lexically, and
again after symlinks are resolved, so a link inside the workspace cannot lead out of it.
The refusal is not fatal: the token stays in the text and the run proceeds, exactly as the
TUI behaves, but the server now emits a `notice` event naming what it would not read, so a
remote user is told rather than left wondering.

### Attachments

`prompt` takes an optional `attachments` array:

```json
{ "id": "13", "method": "prompt", "params": {
    "sessionId": "sess_abc",
    "text": "what changed here?",
    "attachments": [
      { "kind": "file",          "path": "src/auth.ts" },
      { "kind": "fileReference", "path": "src/session.ts" },
      { "kind": "image",         "path": "docs/screenshot.png" },
      { "kind": "image", "data": "iVBORw0KGgo…", "mimeType": "image/png" }
    ]
} }
```

A `file` becomes a context block headed with its path and the word `(attached file)`, so
the model can tell attached context from the user's own words. An `image` becomes a vision
block. A `fileReference` becomes one line naming the path and nothing else — see
[Naming a file without sending it](#naming-a-file-without-sending-it).

#### A selection, not the whole file

A `file` attachment takes an optional `range`, so a client that knows the user has lines
12–40 highlighted can say so instead of sending an 800-line file and hoping:

```json
{ "kind": "file", "path": "src/auth.ts", "range": { "start": 12, "end": 40 } }
```

**Lines are 1-based and both ends are inclusive.** `{ "start": 12, "end": 40 }` means what
a person means by "lines 12 to 40" — 29 lines, the first being line 12 and the last being
line 40 — and one line is `{ "start": 7, "end": 7 }`. This is deliberately the convention
`@src/auth.ts:12-34` speaks and the one every editor's gutter shows. A client built on a
**0-based** editor API (VS Code's `Selection.start.line`, Monaco, most tree-sitter ranges)
must add one to each end before sending; an off-by-one here is invisible in the result,
because the model simply reads a shifted window and answers confidently.

Only the *coordinates* travel. The engine opens the file under the same confinement,
applies the same caps, and slices — one reader, and the read still happens where the
permission engine can see it. A range is accepted for `kind: "file"` only: an image has no
lines, so a range on one is **refused**, not ignored.

The injected block says it is an excerpt and which lines it holds, so the model does not
answer as though it had seen the file:

```text
src/auth.ts (attached file) — excerpt, lines 12-14 of 60; the rest of the file was not read:
```

An `end` past the last line is **clamped, and the clamp is reported** — a select-to-end, or
a file edited since the selection was taken, produces one routinely:

```text
src/auth.ts (attached file) — excerpt, lines 58-60 of 60; 58-10000000 was requested, but the
file ends at line 60, so the range was clamped; the rest of the file was not read:
```

A `start` past the last line is **refused**, not clamped: there is no excerpt to clamp to,
and quietly substituting the file's tail would hand the model a different selection than
the one the client named. So is a range against an empty file.

There is no upper bound on `end` beyond "a whole number", because there is nothing to
bound: the engine never reads more of a file than the file, so `1–10,000,000` costs exactly
what attaching that file with no range costs, and the 2 MiB per-file ceiling, the 2000-line
/ 200 KiB inline cap and the total attachment budget all still apply. What *is* rejected on
the wire is a range that cannot mean anything — `start` below 1, `end` before `start`, or a
bound that is not a whole number. Those are client bugs, and clamping one would mean
inventing an intent nobody expressed.

An excerpt is charged against the total budget for **what was actually read**, so attaching
three lines of a 300 KiB file costs three lines.

#### Naming a file without sending it

Not every file a client knows about is a file the user asked a question about. An editor
panel knows which file is **open** — the VS Code sidebar's ambient chip is exactly that —
and that is worth telling a model, because "explain this function" only means something if
the model knows which file is on screen.

It is not worth the file. Attaching `packages/protocol/src/client.ts` (2,161 lines) as
contents costs about 22,600 input tokens *per turn*; `packages/cli/src/workflow.ts` (7,251
lines) costs about 81,200. At `zai-api/glm-5.2` input rates that is $0.63 and $2.27 over
twenty turns, spent on a file the user never asked about, on every turn, whether or not the
question touches it. The agent has a `read` tool. A path is enough for it to decide, and it
pays for the file only on the turns where the answer is yes.

So there is a third kind:

```json
{ "kind": "fileReference", "path": "src/session.ts" }
```

The engine confines the path exactly as it confines an attachment, stats it, and injects
**one line**:

```text
src/session.ts (referenced file — the client named this path as relevant context; its
contents were not read and are not included here. Use the read tool to open it if this turn
needs it.)
```

No fenced block, no `(attached file)` heading, no trailing colon — those three are what a
context block *with* content looks like, and a reference that borrowed any of them would be
a reference the model answers from.

**The engine still owns it.** A reference is a path, never bytes, and a client still never
reads a file (RFC 0005 §3). It goes through the same workspace confinement, and the refusal
is fatal on the same terms: outside the workspace, or not a regular file, refuses the
prompt. It is stat'ed for one reason — telling a model that `src/session.ts` is in play
when nothing is there sends it to spend a `read` on nothing and then reason about the
absence. It is charged against the total attachment budget for the line it actually
produces, which is about 190 bytes rather than the file's 80 KiB.

**Why a kind and not `{ "kind": "file", "mode": "reference" }`.** Three reasons, the third
of which decides it:

1. It is a different object, not a `file` with a switch. A reference has no bytes, so it
   cannot be truncated, cannot be an image, and cannot carry a `range` — a selection *is*
   the request for an excerpt, and "reference the file, but only lines 12–40" means
   nothing. A `mode` field makes that contradiction representable; a kind makes it
   unspellable. (A `range` on a `fileReference` is refused on the wire, with a message
   saying to send `kind: "file"` with that range instead.)
2. The two are billed differently, and a reader should see which one it has without
   consulting a second field.
3. **The absent-field default points the wrong way.** An engine that predates a `mode`
   field validates the attachment, drops the field it does not know, and injects the
   **whole file** — silently, every turn, at the user's expense: precisely the bug the
   kind exists to remove, reintroduced by its own fallback. An engine that predates a
   *kind* cannot make that mistake: its validator already refuses anything outside
   `"file" | "image"`, so the frame is rejected and no turn is spent. See
   [`resolveContext`](#resolvecontext).

**A selection is still a selection.** A client that knows which lines are highlighted knows
what the user meant and should send `{ "kind": "file", "path", "range" }`: the excerpt is
small, precise, and unambiguously the thing they pointed at. A reference is for the file
they merely have open.

**An explicit attachment is never downgraded to a reference, however large it is.** The
user asked for that file; quietly handing the model a path instead is the same species of
dishonesty pointed the other way, and it would make one `@src/big.ts` mean two different
things on two different days as the file grew. The honest mechanism for "too big" already
exists and already reports itself: the 2000-line / 200 KiB inline cap truncates with a
marker, the 2 MiB per-file ceiling refuses with both numbers, and the 1 MiB total budget
refuses naming the attachment that did not fit.

The `:12-34` suffix on a mention means exactly the same thing, read by the same reader:
`@src/auth.ts:12-34` (and `@src/auth.ts:12` for one line, and `@"my notes.md":12-34` for a
path with spaces) injects that excerpt rather than the whole file. A suffix whose numbers
cannot mean a range is not treated as one, and the whole run stays a path — which is also
how a file genuinely named `notes:12-34` still resolves.

**A `file` is always a path, never bytes.** RFC 0005 §3 puts every file read inside the
engine: a file read by a client is a file the permission engine never saw, and a client
that sent bytes would be doing exactly that. Inline `data` is accepted for `image` and only
for `image` — a pasted screenshot has no path, was never a workspace file, and so has no
confinement to bypass. Its media type must be one of `image/png`, `image/jpeg`, `image/gif`
or `image/webp`.

Every path attachment goes through the same workspace confinement a mention does, but the
refusal is **fatal** rather than advisory: the client named that file, so running the turn
without it would be the silent drop this verb exists to prevent. The server answers
`invalidRequest` and no turn is spent.

Total attachment bytes for one prompt are capped at **1 MiB** — deliberately
`DEFAULT_BACKPRESSURE_THRESHOLD_BYTES`, the same number `sessionHistory` budgets against,
and a quarter of the 4 MiB frame cap above which `ws` closes the connection with 1009. One
MiB of attachment bytes is about 1.37 MiB of base64, so a request that respects the budget
can never be the request that kills the socket. The cap is on the total, not per item: ten
files of 200 KiB is the same load as one of 2 MiB.

### Images and models that cannot see

A prompt carrying an **image attachment** for a model without vision is refused, with the
reason, **before the turn is spent**:

```json
{ "kind": "response", "id": "13", "error": { "code": "invalidRequest",
  "message": "GPT-4o-mini cannot see images, so docs/screenshot.png cannot be sent to it. …" } }
```

The check is **server-side, at prompt time**, and deliberately not left to the client. A
client cannot be trusted to make it: a hostile one holding the serve token would not, and
an honest older one does not know it should. The server knows the session's current model
and its capability flags, so it is the only place the answer is always right.

An image **mention** on a text-only model degrades instead of refusing — a `notice`, the
mention still in the text, the run proceeding — because that is what the TUI does with an
incidental `@screenshot.png`, and the served path is meant to behave the same way.

### `resolveContext`

```json
{ "id": "12", "method": "resolveContext", "params": { "sessionId": "sess_abc", "query": "src/auth.ts" } }
```

```json
{ "kind": "response", "id": "12", "result": {
    "query": "src/auth.ts",
    "path": "/repo/src/auth.ts",
    "relativePath": "src/auth.ts",
    "inWorkspace": true,
    "exists": true,
    "bytes": 4213,
    "kind": "file"
} }
```

This is what makes a file picker honest rather than hopeful: a client can show what will
actually be injected, and its size, before anyone presses send. It is **read-only** —
nothing is attached, no turn starts — and a query that fails confinement is answered
without the server touching the filesystem at all, so the verb cannot be turned into an
oracle for the paths confinement exists to hide. Such a path reports `inWorkspace: false`,
`exists: false` and `bytes: 0` because the server *did not look*, which is not the same
answer as "there is nothing there".

`resolveContext` also takes the optional `range` a `file` attachment takes, and **echoes it
back** on the result:

```json
{ "id": "12", "method": "resolveContext", "params": {
    "sessionId": "sess_abc", "query": "src/auth.ts", "range": { "start": 12, "end": 40 } } }
```

The echo is a statement about the *parameter*, not about the file: it says this engine
understood the range, which is exactly what a client needs to know before it trusts a
ranged attachment not to arrive as a whole file. It does **not** say the range fits — this
verb stats and never reads, and a file's line count cannot be known without reading it.
Whether the range fits is answered at prompt time, in the injected block or in a refusal.

Every answer also carries `attachmentKinds`, which is a statement about the **engine**
rather than about the path in the query:

```json
{ "kind": "response", "id": "12", "result": {
    "query": "src/auth.ts", "path": "/repo/src/auth.ts", "relativePath": "src/auth.ts",
    "inWorkspace": true, "exists": true, "bytes": 4300, "kind": "file",
    "attachmentKinds": ["file", "fileReference", "image"] } }
```

It rides on `resolveContext` because that verb is already the one a client calls before it
attaches anything, and a capability handshake of its own would be a second round trip to
learn one fact. **Absent means "this engine predates the field"**, which a client reads as
`["file", "image"]` — the two kinds that shipped with `attachments` — and never as "no
kinds at all". It says what the engine will *accept*, not what it will permit for a given
path: a listed kind is still confined, still budgeted, and still refusable at prompt time.
And it is not licence to swap one kind for another — a `fileReference` an engine cannot
take is a prompt that gets refused, not one that quietly ships the whole file instead.

`resolveContext` is **optional and additive**, on the same terms as `listModels`:
`ProtocolClient.resolveContext()` translates an older server's `invalidRequest` into
`undefined`, which is safe because the verb only reads — `undefined` costs a caller a
preview, never a guarantee.

`prompt`'s `attachments` field gets the **opposite** treatment, and for `deleteSession`'s
reason. It is a new *parameter* on an old verb, so an older server recognises `prompt`,
validates it, drops the field it does not know, and answers `ok` — the turn is spent, the
model never saw the file, and the client was told everything was fine. So
`ProtocolClient.prompt()` probes `resolveContext` once per session before sending any
attachment and **rejects locally** when the engine has no such verb. Nothing is sent, and
nothing is silently dropped.

A `file` attachment's `range` is the same argument one level down, and it degrades *worse*:
an engine that has `resolveContext` but predates ranges validates the attachment, drops the
field, and sends the model the **whole file** while answering `ok` — a client asking about
lines 12–40 of an 800-line file would be billed for all 800 and told nothing. The one probe
answers all three questions: it carries a range, and the echo above is how an engine that
understands ranges says so. A ranged attachment to an engine that does not is rejected
locally, with nothing sent, and no extra round trip is spent finding out.

`kind: "fileReference"` is the third, and it is the one case where the **spelling** does
the work rather than the probe. Had it been `{ "kind": "file", "mode": "reference" }`, an
older engine would drop the unknown field and inject the whole file — which is the
81,200-token outcome the kind exists to prevent, arriving silently because the engine is
old. As a *kind*, an older engine's own validator refuses it: `PromptAttachment.kind must
be one of "file" | "image"`, the frame is rejected, and no turn is spent. The bad fallback
is not merely avoided, it is unreachable. The client still refuses locally when
`attachmentKinds` omits the kind, for two smaller reasons: the message ("this arcturn
engine is older than file references… Upgrade the engine, or turn off the client's
open-file context") is one a person can act on where a wire-enum complaint reads like a
client bug, and it saves the round trip.

**Why refuse rather than quietly drop the reference and send anyway.** Dropping it would
narrow rather than widen — the model told less, never more; the user billed less, never
more — which is the test `permissionDecision`'s `scope` passes when it degrades silently.
It is refused anyway, for two reasons. A client that attached a reference has a surface
that *said so*: the VS Code chip's whole design principle is that the row above the
composer is the truth about what the next message carries, and a silently-dropped reference
makes that row a lie — the same failure class as the mention bug that started all of this.
And it is the third instance of one rule at one seam (attachments, ranges, references),
where a third different answer is how a seam stops having a rule.

The cost is bounded, and the two halves fit together rather than fighting: the refusal is
per-*kind*, so plain attachments and ranges keep working against that engine, and a client
that can *see* the engine is too old should not offer the affordance in the first place.
The VS Code panel does exactly that — it reads `attachmentKinds` off the round trip it
already makes, shows **no** ambient chip, and says so once per connection. That is not a
new rule either; it is the one that already governs an engine with no `resolveContext` at
all: a chip whose file could never be sent is worse than none. What neither layer will do
is fall back to `{ "kind": "file" }`, which would be 81,200 tokens the user did not ask for
because their engine is old.

## Permissions

A client that cannot say which permission mode it is running under has to imply one, and
an implied permission mode is the kind of thing users act on. Two verbs close that, and a
third field makes a permission modal offer the choice people actually want.

### `permissionState`

```json
{ "id": "13", "method": "permissionState", "params": { "sessionId": "sess_abc" } }
```

```json
{
  "kind": "response",
  "id": "13",
  "result": {
    "sessionId": "sess_abc",
    "mode": "default",
    "rules": [{ "tool": "bash", "specifier": "rm *", "action": "deny", "scope": "user" }],
    "tools": ["bash", "edit", "fetch", "glob", "grep", "read", "websearch", "write"]
  }
}
```

Session-scoped, because a mode and a rule set belong to one agent rather than to the
server. Read it as a whole: `mode` is what was granted, `rules` is what the mode cannot
talk its way past, and `tools` is the outer bound on both.

**`tools` is how a client learns whether this engine can reach the web.** There is no
`canBrowse` verb and there will not be one — the question is really "is `fetch` in the tool
set", and a panel that renders a browse button without checking is implying a capability
it never confirmed. The list is names only: never a tool's description or schema, which
are the model's business and would put an extension's or an MCP server's prose onto a wire
that feeds a UI. It is also the **full** set the session holds, not the subset progressive
disclosure is showing the model this turn — a capabilities line that flickered between
turns would be worse than none.

### `setPermissionMode`

```json
{ "id": "14", "method": "setPermissionMode", "params": { "sessionId": "sess_abc", "mode": "yolo" } }
```

Answers with the resulting `permissionState`, so a client reads what the engine *is* rather
than assuming it got what it asked for.

**A mode is a request, not a grant.** The engine's resolution order is unchanged: stored
rules are step 3 and modes are step 5, so a `deny` rule still wins over `yolo` — set from
here exactly as it does when a local user picks the mode in `/permissions`. A client that
sets a mode is granted nothing the permission engine would not grant the person at the
terminal, and this verb **never edits a rule**.

**Refused mid-run** with `sessionBusy`. A mode that changed halfway through a turn would
split that turn across two policies — an ask already sitting in the client's modal would
settle under the old rules while the next call in the same turn settled under the new, and
nothing in the transcript would say which was which. Refusing is what makes "takes effect
on the next turn" literally true. A client that wants to stop an agent *now* has a better
tool than a mode chip: `abort` ends the run outright, and the mode change succeeds
immediately afterwards.

This is a deliberate asymmetry with the terminal, where `/permissions` will change the mode
mid-run: a local user is watching the transcript scroll and knows exactly which tool call
their change landed before. A remote client with a queued modal does not.

Note for operators: this verb lets a token holder raise the mode as far as `yolo`, which is
the same reach a local user has (see [Threat model](#threat-model) — holding the token is
already equivalent to a shell for whatever the configured mode allows). Rules remain the
wall that no mode crosses, so a `deny` in your config is the control that actually confines
a served session.

### `permissionDecision` grows a `scope`

```json
{
  "id": "7",
  "method": "permissionDecision",
  "params": {
    "sessionId": "sess_abc",
    "decision": { "requestId": "req_1", "behavior": "allow" },
    "scope": "session"
  }
}
```

- **`scope` omitted** — allow once.
- **`scope: "session"`** — allow for the rest of this session. The **engine** mints the
  rule, from the `suggestedRule` it put on the request; a client says *how long*, never
  *what*. Offer this button only when the request carries a `suggestedRule` — that field is
  how the engine reports the request is repeatable — because asking for `"session"` on a
  request without one is refused rather than quietly downgraded to an allow-once.
- **`scope: "project"` or `"user"`** — **refused**, `invalidRequest`. So is a
  `decision.persistRule` carrying either scope.

Those two are the scopes that get written into a `config.json` a person owns, and nothing
on this socket writes one. A session-scoped rule reaches the engine's in-memory rule list
and dies with the process. The refusal is enforced in three places rather than documented
in one: `@arcturn/protocol` validates it on the way out of a client (so a UI bug fails
before a round trip), validates it again on the way into a server, and `SessionHost`
enforces it independently — because it is a public API that an SDK embedder wires to its
own transport, and a rule this important may not depend on which door a decision came
through.

A refused decision leaves the ask **pending**, so the client can re-send a legal one and
the turn continues.

`arcturn attach` and the browser client both offer "allow for this session" on these terms;
neither can write a rule to your config any more. The local TUI is unchanged — a person at
their own terminal still persists a project rule, which is exactly the distinction being
drawn.

## Commands

```json
{ "id": "15", "method": "listCommands" }
```

```json
{
  "kind": "response",
  "id": "15",
  "result": {
    "commands": [
      { "name": "review", "description": "Review the diff", "kind": "skill", "source": "/repo/.arcturn/skills/review.md" },
      { "name": "model", "description": "Switch the model", "kind": "builtin" },
      { "name": "permissions", "description": "Show the permission mode and rules, and switch mode", "kind": "builtin" },
      { "name": "sessions", "description": "Resume an earlier session in this directory", "kind": "builtin" },
      { "name": "clear", "description": "Start a fresh session", "kind": "builtin" },
      { "name": "compact", "description": "Summarise the conversation to free up context", "kind": "builtin" },
      { "name": "export", "description": "Download the conversation as markdown or HTML", "kind": "builtin" },
      { "name": "mcp", "description": "Show MCP server status", "kind": "builtin" },
      { "name": "diff", "description": "Show pending dry-run changes", "kind": "builtin" },
      { "name": "apply", "description": "Apply pending dry-run changes to the workspace", "kind": "builtin" },
      { "name": "discard", "description": "Throw away pending dry-run changes", "kind": "builtin" },
      { "name": "cost", "description": "Show this session's usage and cost", "kind": "builtin" }
    ]
  }
}
```

Skills first, alphabetically, then built-ins — the order a `/` menu wants, sorted
server-side so every client's menu agrees. A server property, not a session one: skills are
discovered from the served workspace and the user's home. A skill whose name collides with
a listed built-in is neither listed nor runnable under that name, matching the terminal,
where the built-in is registered first and the skill is skipped with a warning.

**Only built-ins a client can actually run are listed.** A menu offering `/rewind` to a
client with no rewind verb is a menu that lies. `model` is here because `listModels` and
`setModel` are; `permissions` because `permissionState` and `setPermissionMode` are;
`sessions` because `listSessions`, `openSession` and `sessionHistory` are; `clear` because
`createSession` and `openSession` are; `compact`, `export` and `mcp` because the verbs
described below carry them; and `diff`, `apply` and `discard` because `pendingChanges`,
`applyChanges` and `discardChanges` do.

Those last three are listed **whether or not this engine happens to be running
`--dry-run`**, and that is deliberate: the truth condition for this list is "can the wire
carry this command out", not "is there anything for it to do right now". A `/diff` against
an engine with no shadow tree answers *this engine is not running under --dry-run* — the
same sentence the terminal's `/diff` prints, from the same fact. Withholding the entries
instead would make a panel's menu differ from a terminal's by engine mode, which is the
divergence the one-engine rule exists to prevent.

`cost` is here for a different reason, and it is worth stating plainly: there is **no
`cost` verb**, and there will not be one. Every figure the terminal's `/cost` shows already
rides the event stream a client subscribed to with `openSession` — `turnEnd` carries the
usage and the price — so a verb would be a second, drifting source for numbers the client
is already holding. The truth condition for this list is "can a client carry this command
out", and a client folding `turnEnd` can.

Left out, each for its own reason: `rewind` (no verb restores a checkpoint), `theme` (a
terminal concern), `scout` (no verb), `help` (a client renders its own from this list),
`exit` (a client closes its own socket), and `todos` — whose data rides the event stream
exactly as `cost`'s does, but which no client has a surface to *open*, since a todo list is
rendered continuously rather than summoned. The list lives in `@arcturn/server`, next to
the dispatch table that decides what is true.

Where a wire client reaches only part of what the terminal command does, the description
promises only the part that works: `/permissions suggest` persists a learned rule locally,
and that half is refused on this wire by design.

**Execution stays `prompt`.** A skill is prompt text; there is no `runCommand` verb and
there will not be one, because a second execution path would give one skill two behaviours
that could drift apart. Sending `{ method: "prompt", params: { text: "/review the auth
module" } }` is how a client runs a listed skill, and the server expands it before the
model sees anything: the leading `/name` is replaced by that skill's body, with
`$ARGUMENTS`, `$1`..`$9`, `$CWD` and `$SKILL_DIR` substituted by the very same
`Skill.buildPrompt` the terminal's `/name` and the model-invoked `skill` tool use. The
`skill` tool is not a substitute for this: that is the model *noticing* text and choosing
to act on it, which is not a command running. `steer` expands identically, so a command
sent mid-run means what it means when the session is idle.

Four rules govern the expansion:

- **Only a leading `/name`.** `explain what /review does` is prose and is sent as prose.
- **A name is `[A-Za-z0-9-]+`**, ended by whitespace or the end of the line — the charset a
  skill name is normalized into. `/etc/hosts has the wrong entry` is therefore prose too:
  the terminal treats every leading slash as a command because a completion menu is open
  as you type, and a chat composer is where paths get sent instead. This is the one place
  the serve path knowingly diverges from the terminal, and it diverges by refusing less.
- **An unrecognised `/name` is refused**, with `invalidRequest`, the nearest names as a
  suggestion, and no turn spent. It is never forwarded as literal text: a model reading
  `/reviw the auth module` answers *something*, and the user cannot tell that from a
  command that ran. A built-in is refused the same way, naming the verb that actually runs
  it — `/model` says to call `setModel`, which is what `kind: "builtin"` means in the list
  above.
- **A skill body's own `@mentions` are not expanded.** The body reaches the model as
  written, exactly as in the terminal. This is deliberate twice over: a skill in
  `<cwd>/.arcturn/skills` is a file a cloned repository controls, and expanding its
  mentions would let that repository pull `@.env` into a prompt on the strength of someone
  running `/review`. Mention expansion is for the text a *person* typed.

A skill is addressed by **name**, never by path — the name is matched against what the
engine discovered under its own skill roots, so no `..`, absolute path or symlink in a
`prompt` reaches the filesystem through this route, and a markdown file outside those roots
is not reachable at all. Arguments are not re-scanned for substitution tokens either: an
argument of `$SKILL_DIR/../../etc/passwd` stays exactly that text rather than expanding
into the skill folder's real absolute path.

Skill descriptions are **sanitized** before they reach a client — first line only, control
characters collapsed, length-capped — using the same function that sanitizes them on the
way to the model, because `<cwd>/.arcturn/skills` is a directory a cloned repository
controls. `source` travels with each skill so a menu can show where it came from rather
than implying it.

## Compacting a conversation

```json
{ "id": "16", "method": "compact", "params": { "sessionId": "sess_abc" } }
```

```json
{
  "kind": "response",
  "id": "16",
  "result": { "sessionId": "sess_abc", "compacted": true, "tokensBefore": 142380, "tokensAfter": 21044 }
}
```

There is **one compactor**. This verb drives `Agent.compact()` — the same method the
terminal's `/compact` calls and the same one the run loop calls when it crosses the
automatic threshold — so a conversation summarised over the wire is folded at the same turn
boundary, with the same options, into the same `compaction` session entry.

The result is a report rather than an acknowledgement. Read `compacted` first: `false` is a
*successful* answer meaning nothing was folded, and it arrives with a `reason` saying which
kind of nothing it was — there was no turn boundary old enough, or the summarizer failed.
Those two call for different responses, and neither is an error.

```json
{
  "kind": "response",
  "id": "16",
  "result": {
    "sessionId": "sess_abc", "compacted": false, "tokensBefore": 4120, "tokensAfter": 4120,
    "reason": "Nothing to compact: no turn boundary old enough to summarize."
  }
}
```

The token pair is **quoted from the engine's own `compactionEnd` event**, not measured
again here. Every attached client already receives that event, and two sources for one pair
of numbers is how a notification and the response that caused it come to disagree.

**Refused mid-run**, with `sessionBusy`. Compaction rewrites the message array the run loop
is iterating — `Agent.compact()` throws while running for exactly that reason — so queueing
would only move the hazard behind a promise, would race the loop's own automatic
compaction, and would settle at a moment the client cannot observe, making the reported
numbers describe a conversation that had since moved on. Abort the run, or wait for
`runEnd`. This is the same refusal `setPermissionMode` and `deleteSession` make.

**Not degradable.** A client told "fine" by a server that ignored this would report freed
context that was never freed, keep filling the window, and hit the wall it had just asked
to have moved. An older server's `invalidRequest` rejects like any other failure; test it
with `isUnsupportedMethodError` if you want to say "this engine is too old" rather than
quoting `Unknown method`.

## Exporting a conversation

```json
{ "id": "17", "method": "exportSession", "params": { "sessionId": "sess_abc", "format": "markdown", "includeThinking": false } }
```

```json
{
  "kind": "response",
  "id": "17",
  "result": {
    "sessionId": "sess_abc",
    "format": "markdown",
    "filename": "arcturn-session-2026-08-25-1200.md",
    "content": "# Arcturn Session\n\n…",
    "messageCount": 42,
    "truncated": false,
    "droppedMessages": 0
  }
}
```

**The engine writes nothing.** The terminal's `/export` drops a file next to the person who
ran it; over a socket that same behaviour would put a file on the *engine's* disk — the
wrong machine for the person asking, and an arbitrary-write primitive dressed up as a
convenience for anyone holding the serve token. So the content comes back and the client
saves it. `filename` is a **name**, never a path, and the protocol client rejects one
carrying a separator or `..`.

Both renderers are the terminal's own `exportMarkdown` and `exportHtml`, injected into the
server rather than reimplemented, so a transcript cannot look one way in a terminal and
another over a socket. `format` is `"markdown"` (default) or `"html"`; `includeThinking`
is `/export --thinking`, off by default.

The payload is **bounded at 1 MiB** — `ws-server.ts`'s own backpressure threshold, and a
quarter of the frame size above which `ws` closes the connection with 1009, the same budget
`sessionHistory` uses and for the same reason: a response to the client's own request is
essential traffic the backpressure policy never drops, so it must not be the frame that
wedges the socket. Over the cap, the **oldest messages are dropped and the document is
re-rendered** from what is left, so what arrives is always a well-formed document rather
than one cut off mid-tag, and `truncated`/`droppedMessages` say so explicitly. A client
that sees `truncated: true` must tell the user that earlier messages are missing.

Requires an **open** session: this renders the conversation the agent is holding in memory,
so `openSession` first. It is deliberately *not* refused mid-run — the terminal's `/export`
is not either, and an export taken mid-turn is a true snapshot of a conversation still in
progress.

Degrades like `listModels`: it only reads, so an older server's `invalidRequest` becomes
`undefined` and a client offers no export. An engine assembled without a transcript
renderer at all refuses with `invalidRequest` too, and so reaches a client as the same
`undefined` — the collapse `resolveContext` already has for a missing resolver, and
coherent for the same reason: "this engine has no exporter" and "this engine predates the
verb" are one piece of news, and the answer to both is to offer no export.

## MCP server status

```json
{ "id": "18", "method": "mcpStatus" }
```

```json
{
  "kind": "response",
  "id": "18",
  "result": {
    "servers": [
      { "name": "files", "transport": "stdio", "state": "connected", "toolCount": 11 },
      { "name": "issues", "transport": "http", "state": "failed" }
    ]
  }
}
```

**Names and status. Nothing else.** An MCP config is where a workspace keeps its secrets —
a stdio server's `env` and `args`, an HTTP server's `url` and its `Authorization` header,
the OAuth bearer token minted at connect time — and none of it is on this wire. Neither is
a failed server's own error text: that is prose an MCP server wrote, and this payload lands
in a menu a person reads and clicks, so it gets the treatment `permissionState.tools`
already gets for tool names. A person who needs to know *why* a server failed reads the
engine's log.

That narrowness is structural rather than a redaction pass. The projection is built by
naming four fields, in `@arcturn/cli` next to the config the credentials live in; the
server then re-validates with `validateMcpStatus`, which copies the same four out by name
again and checks two of them against closed enumerations. A field added to `McpServerConfig`
tomorrow is absent by default rather than present until somebody notices.

`state` is what the engine last **observed**, not a live probe. The terminal's `/mcp` pings
each connected server with a short timeout, because a person standing at a prompt can
afford to wait; a request/response verb cannot add one dead server's timeout to every
client's round trip, and a second liveness field beside `state` would give a client two
answers to one question. Treat `"connected"` as "the engine believes it is connected".

`toolCount` is present only for a connected server: a `0` on a disconnected one would be
indistinguishable from a connected server that offers no tools.

Not session-scoped — MCP servers belong to the server process. Degrades like `listModels`:
an older server's `invalidRequest` becomes `undefined`, and a client shows no listing
rather than an empty one, because "this engine has no MCP servers" and "this engine cannot
tell me" are different news.

## Reviewing a dry run

[`--dry-run`](/docs/dry-run) reroutes every `write`/`edit` into a shadow copy of the
workspace and leaves the real files alone until a person has read the change. In a terminal
that is `/diff`, then `/apply` or `/discard`. Three verbs put the same loop on the wire, so
a remote client attached to a dry-run engine can see what is waiting instead of watching an
agent that appears to do nothing.

```json
{ "id": "19", "method": "pendingChanges", "params": { "sessionId": "sess_abc" } }
```

```json
{
  "kind": "response",
  "id": "19",
  "result": {
    "sessionId": "sess_abc",
    "dryRun": true,
    "changes": [
      { "path": "src/app.ts", "absolutePath": "/repo/src/app.ts", "kind": "modified", "bytes": 2140, "previousBytes": 1988 },
      { "path": "src/new.ts", "absolutePath": "/repo/src/new.ts", "kind": "added", "bytes": 412, "previousBytes": 0 }
    ],
    "truncated": false,
    "droppedChanges": 0
  }
}
```

**Read `dryRun` before you read `changes`.** An engine that is not in dry-run mode answers
`dryRun: false` with an empty list, and that is the opposite news from a dry-run session
with nothing pending yet: one means *nothing is being held back — your edits already
landed*, the other means *nothing has been written yet*. A client that renders both as
"nothing to review" tells one group of users something false.

### Metadata now, bytes per file

The list carries **no content at all**. Ask for one file's content by naming it:

```json
{ "id": "19", "method": "pendingChanges", "params": { "sessionId": "sess_abc", "path": "src/app.ts" } }
```

and that row comes back with an `after` field holding exactly what an apply would write.

The split is a payload decision, taken against the 1 MiB bound [`sessionHistory`
established](#replaying-a-session) — which is `ws-server.ts`'s own backpressure threshold
and a quarter of the frame size above which `ws` closes the connection with 1009. A
hundred-file refactor's patches are megabytes; a hundred-file *listing* is about twenty
kilobytes. Shipping every patch would make the review response the frame that wedges the
socket exactly when a reviewer most needs it, so the bytes are fetched one file at a time —
which is also the only granularity a diff editor ever renders. The list is additionally
capped at 1000 rows, and `truncated` / `droppedChanges` say so out loud when it bites.

A single file whose content exceeds the budget comes back with `contentOmitted: true` and
no `after`. It is **withheld rather than truncated**: dropping the oldest events from a
transcript still leaves every surviving event true, but half a file rendered in a diff
editor is a false account of the change, and a reviewer would approve it.

There is deliberately no `before`. An apply is a whole-file write, not a patch — the engine
writes `after` over the real file and never diffs against a snapshot — and `bash` is not
wrapped by the overlay, so the real tree can change under a dry run. The honest left-hand
side of "what will this file become" is therefore the file as it stands at apply time, not
a snapshot the engine took earlier. A client diffs against the workspace file it already
has.

There is no `"deleted"` kind either: the overlay wraps `write`, `edit` and `read`, and none
of them removes a file, so a dry run cannot hold a deletion back.

### Applying

```json
{ "id": "20", "method": "applyChanges", "params": { "sessionId": "sess_abc", "paths": ["src/app.ts"] } }
```

```json
{
  "kind": "response",
  "id": "20",
  "result": { "sessionId": "sess_abc", "applied": ["src/app.ts"], "failed": [], "remaining": 1 }
}
```

**The selection is real, not decorative.** Omit `paths` to land everything; name a subset —
spelled exactly as `PendingChange.path` reported it — to land part of it. Under the hood
this is the *same* `Overlay.apply` the terminal's `/apply` drives, given a path filter;
there is no second applier on this path and there must not be one, because a second applier
is a second place for the symlink check below to be forgotten.

A name that is not currently pending refuses the **whole** request rather than applying the
rest. A reviewer who selected four files and silently got three has been handed a status
that was correct about the wrong set.

That refusal is also the entire confinement story for a selection: the server matches
`paths` against the rows it just produced and then hands the overlay *its own* absolute
paths. A `..`, an absolute path, a drive letter or a URL arriving on the wire matches
nothing and is refused; no client string ever becomes a write destination.

Two further guarantees are inherited rather than re-implemented, because the engine's own
overlay does the writing:

- **Each file is written via a temp file plus rename** in its destination directory, so an
  interrupted apply cannot leave a half-written file.
- **Each destination has its existing ancestors resolved through symlinks** and checked
  against the workspace root before a byte is written. `bash` is unwrapped under dry run, so
  an agent really can create `ln -s /etc /repo/src/escape` mid-run; a pending change whose
  real destination resolves outside the workspace is refused per file with `resolves outside
  the workspace (symlink); refused` and reported in `failed`. See [Symlink-safe
  apply](/docs/dry-run#symlink-safe-apply).

A per-file failure does not fail the request: the rest still land and the ones that did not
are named, which is what `/apply` does in the terminal. `remaining` is counted by re-reading
the shadow tree rather than by subtraction, so it cannot drift from what a later
`pendingChanges` will say.

**Applying is not a way around a deny rule.** Permissions are checked in the agent loop
against the tool call's *raw* path, before the overlay redirects anything — so a rule
denying `write` under `secrets/**` is matched against the real workspace file, the write
never runs, and there is no pending change for anyone to apply. Dry run changes where an
allowed write *goes*; it does not change whether it was allowed.

### Discarding

```json
{ "id": "21", "method": "discardChanges", "params": { "sessionId": "sess_abc" } }
```

**Irreversible.** The shadow tree is the only record of that work. `paths` selects a subset
on exactly `applyChanges`' terms; omitted, the whole tree goes.

There is no wire-level confirmation, and that is [`deleteSession`'s
discipline](#deleting-a-session) rather than an omission: a confirmation belongs where a
person can read what they are losing — a native modal in the client, naming the files —
rather than as a two-phase token the engine keeps state for. What the engine owns is the
refusal a client cannot make for itself.

### Refused mid-run

Both `applyChanges` and `discardChanges` answer `sessionBusy` while a turn is in flight,
matching `setPermissionMode` and `deleteSession`. Writing the shadow tree back to disk while
the agent is still writing into it is a race with the user's files on one side.

The check is **wider than one session**, and the reason is worth stating plainly: `--dry-run`
is a flag on the served *process*, so one `arcturn serve` has one shadow tree that every
session it hosts writes into. A run in flight anywhere on the engine blocks an apply asked
for anywhere on it, and the refusal names which session is busy.

`pendingChanges` is **not** refused mid-run. It only reads, `/diff` has never had a busy
check either, and a change set you can watch grow is useful rather than dangerous.

### Against an engine that is not in dry-run mode

`pendingChanges` answers `dryRun: false`, as above. `applyChanges` and `discardChanges`
refuse with `invalidRequest` and say why — "This engine is not running under `--dry-run`, so
nothing is being held back: file edits reached the workspace as they were made" — which is
the same thing the terminal's `/apply` prints for a session with no overlay.

## Rewinding to a checkpoint

Before a `write` or `edit` touches a file for the first time in a turn, the engine snapshots
that file's content — or its absence. `/rewind` restores those snapshots and forks the
conversation back to the same point; see [Checkpoints & /rewind](/docs/checkpoints) for the
storage and its sharpest edge (a file changed only through `bash` was never snapshotted and
will not come back).

That loop was reachable only from a terminal. `built-in-commands.ts` named `/rewind` as *the*
example of a command RFC 0005 §1.3 forbids listing, because no verb carried it. Two verbs now
do, and `/rewind` is listed.

### What a picker is told, before it offers anything

```json
{ "id": "22", "method": "listCheckpoints", "params": { "sessionId": "sess_abc" } }
```

```json
{
  "sessionId": "sess_abc",
  "available": true,
  "truncated": false,
  "droppedCheckpoints": 0,
  "checkpoints": [
    {
      "id": "turn_7",
      "label": "add rate limiting to the login route",
      "timestamp": 1787678419635,
      "fileCount": 3,
      "deleteCount": 1,
      "files": ["src/auth.ts", "src/limiter.ts", "test/limiter.test.ts"],
      "truncatedFiles": false,
      "forksConversation": true,
      "confirmation": "3f9c1d0ab7e24c5f8a1b2c3d4e5f6071"
    }
  ]
}
```

Read-only. Every row carries **the plan a rewind to it would apply**, not a summary of what
happened during that turn: `fileCount` is the union of the earliest snapshot per path from
that turn to the end of the manifest, which is a number a client cannot compute for itself.
`deleteCount` is split out because "3 files changed" and "3 files deleted" are not the same
sentence, and a modal that folded them would let somebody approve the second while reading
the first. Paths are workspace-relative and `/`-separated, the spelling `PendingChange.path`
already uses.

`forksConversation: false` means the engine can restore the files but not move the transcript
— a turn resumed from disk has snapshots but no in-memory record of the entry it began at.
The terminal says so rather than guessing a fork point; this reports the same fact so a client
can say it *before* the user commits.

`available: false` means this engine keeps no checkpoints at all. Kept apart from an empty
list on purpose, exactly as [`pendingChanges`' `dryRun` flag is](#reviewing-a-dry-run):
"nothing has been checkpointed yet" and "nothing is ever checkpointed here" are opposite
pieces of news.

### Rewinding

```json
{ "id": "23", "method": "rewindTo", "params": { "sessionId": "sess_abc", "checkpointId": "turn_7", "confirmation": "3f9c1d0ab7e24c5f8a1b2c3d4e5f6071" } }
```

```json
{
  "sessionId": "sess_abc",
  "checkpointId": "turn_7",
  "restored": ["src/auth.ts", "src/limiter.ts"],
  "deleted": ["test/limiter.test.ts"],
  "failed": [],
  "conversationForked": true
}
```

**The most destructive verb on this wire**: it writes files and it deletes files, and the
terminal's own confirmation says so out loud — "restores and deletes files; cannot be undone".

The restorer is the engine's own checkpoint store, the same object the TUI's `/rewind` drives.
There is no second restorer: `@arcturn/server` never touches a file on this path, and a
restore is confined to the session's working directory — which `createSession` already
confined to the served workspace. A manifest record outside it is **reported in `failed` and
skipped**, never written, and it never appears in a row's `files` either, because that list is
what *would* happen rather than what was recorded.

### Why this one verb echoes a confirmation

`deleteSession` and `discardChanges` deliberately carry no wire-level confirmation, and that
argument still holds: the confirmation belongs in a native modal where a person can read what
they are losing, not in a two-phase token the engine keeps state for.

`rewindTo` takes one anyway, because it differs in exactly the way that matters: **its
parameters do not name what it destroys.** A `deleteSession` names its session; a
`discardChanges` selection names its files as the engine just listed them. A `rewindTo` names
an opaque turn id, and the files it deletes come from a manifest that grows with every turn.
A client that displayed "this deletes 2 files", let a run append three more, and then sent the
id would rewind something nobody was shown.

So `confirmation` is a **digest of the plan**, copied from the row the client rendered. The
engine recomputes the plan and compares; a mismatch is `invalidRequest` naming the drift, and
the answer is to re-list. No server state, no expiry, nothing to evict — which is why it can
be required without becoming the handshake `deleteSession` refused.

### Refused mid-run

`sessionBusy`, on `deleteSession`'s wider check rather than `setPermissionMode`'s narrower
one: a prompt that has been accepted but is still resolving its context has not started the
agent yet, and a restore landing there would rewrite files the run is about to read *and* fork
the conversation it is about to append to. The TUI already refuses this — "A run is in
progress; press Esc to interrupt it before rewinding" — and this is the same refusal, phrased
for a client that can act on it.

Not widened to every live session the way `applyChanges` is, and the difference is real: one
`--dry-run` shadow tree is shared by the whole process, whereas a checkpoint store belongs to
one session and is rooted at that session's own working directory.

### After a rewind

The conversation is forked and the host swaps the session's agent in place. Every connection
attached to the session — not just the one that asked — is sent a `notice` saying so, and the
transcript is re-read with [`sessionHistory`](#replaying-a-session), which now replays the
branch the live agent is on rather than the newest entry in the file. There is no second
transcript path.

Nothing already in the session file is deleted: a rewind is a branch, exactly as resuming an
older entry is.

## Background agents

`/bg <task>` starts a whole child conversation off the foreground thread, with its own
session, its own tool loop and a durable JSON record under
`~/.arcturn/background-agents/records/`. None of that rides a session's event stream, so
before these verbs a remote client attached to a busy engine could not tell that four
agents were running, what they had cost, or what they had said.

Four verbs, matching the terminal's four subverbs one for one:

```json
{ "id": "22", "method": "backgroundAgents" }
{ "id": "23", "method": "backgroundAgents", "params": { "id": "bg-a1b2c3d4" } }
{ "id": "24", "method": "startBackgroundAgent", "params": { "task": "fix the flaky retry test" } }
{ "id": "25", "method": "cancelBackgroundAgent", "params": { "id": "bg-a1b2c3d4" } }
{ "id": "26", "method": "adoptBackgroundAgent", "params": { "sessionId": "sess_abc", "id": "bg-a1b2c3d4" } }
```

None of them is session-scoped except `adoptBackgroundAgent`, which has to name the
conversation it is delivering into. Background agents belong to the engine, so
`backgroundAgents` is shaped like `mcpStatus` rather than like `permissionState`.

### Metadata now, one transcript at a time

`backgroundAgents` with no `id` answers with one row per agent, newest first, and **no
transcripts**:

```json
{
  "agents": [
    {
      "id": "bg-a1b2c3d4",
      "sessionId": "sess_child",
      "task": "fix the flaky retry test",
      "modelId": "anthropic/claude-sonnet-4-5",
      "status": "done",
      "createdAt": 1787000000000,
      "startedAt": 1787000000120,
      "endedAt": 1787000042000,
      "elapsedMs": 41880,
      "costUsd": 0.18,
      "finalText": "The retry helper reset its backoff on every call…"
    }
  ],
  "truncated": false,
  "droppedAgents": 0
}
```

Both the rows and the strings in them are bounded, and both bounds are reported or stated
rather than silent. `task`, `finalText` and `error` are **previews**, capped at 1000
characters: `finalText` is model output and unbounded at the source, so a listing of a
hundred agents that carried every answer in full would be the megabytes-long frame that
wedges a socket exactly when somebody is trying to find out what their agents did. A client
that wants the whole answer does not read it from there — the transcript carries the
conversation, and `adoptBackgroundAgent` delivers the complete text into a session without
it ever crossing that field. The listing itself keeps the newest 200 rows (a manager
remembers every agent it ever started) and says `truncated` and `droppedAgents` when it
drops the older ones, because a list that silently stops reads as the whole list.

With an `id`, that one row also carries a `transcript`: the lines `/bg logs` prints, from
the same renderer, bounded at 1 MiB and truncated **from the front** — the interesting end
of an unattended run is the end. `truncated` and `droppedLines` say so rather than leaving
it to be inferred.

`status` is `running | done | failed | cancelled | interrupted`. There is no `queued`: an
agent waiting behind the concurrency cap reports `running`, and the way to tell is that
`startedAt` is absent. `interrupted` means the record was still `running` when a manager
loaded it from disk — the process that owned it exited without finishing.

An `id` that names nothing answers with an **empty list**, not an error. That is a
contract requirement rather than a courtesy: this verb degrades like `listModels`, and a
client cannot tell a server-sent `invalidRequest` for a typo from one for an unknown
method, so refusing would make a mistyped id look like an engine too old to have the
feature and hide the whole surface.

### What a remotely-started agent is capped by

`startBackgroundAgent` spends money, and its entire containment is that **it carries
nothing but the task**. There is no `tools`, no `permissionMode`, no `cwd`, no `model` —
not in the request type, not in the validator, and not in the interface the engine hands
its manager. So a background agent started over this wire runs under exactly what a `/bg`
typed at the terminal runs under:

| Cap | Value | Set by |
|---|---|---|
| Permission mode | `default`, never `yolo` | the manager's default |
| Tools | read-only plus `fetch`; `subagent` always removed | the manager's filter for a non-`yolo` mode |
| Permission asks | denied — there is nobody to ask | no requester is attached to an unattended agent |
| Working directory | the served workspace | the manager's default, refreshed from the runtime |
| Model | the engine's current model | the manager's default, refreshed from the runtime |
| Concurrency | 3 at a time, the rest queue FIFO | `DEFAULT_CONCURRENCY` |

The practical shape of that: a background agent started over the wire **cannot write a
file or run a shell command**, and cannot start further background agents or sub-agents.
`packages/cli/src/delegation-wire.test.ts` asserts it on the filesystem — the agent is
scripted to call `write`, and the file is not there afterwards.

What is *not* capped is spend: `arcturn serve --max-cost` bounds each served session's own
agent and does not reach a background agent, exactly as `/bg` at a terminal is not bounded
by `--max-cost` either. That is parity, not safety; see the note at the end of this
section.

### Adopting a result

`adoptBackgroundAgent` delivers a finished agent's answer into a live session. The engine
composes the message — naming the agent, its task and its outcome, with the same function
the terminal's `/bg adopt` uses — and chooses how to deliver it: `steer` when the session
is mid-run, a fresh `prompt` when it is idle. The result says which happened, because the
two are observably different and a client that rendered them the same would show a message
appearing at a moment it cannot explain.

**The text is delivered unexpanded.** No `@`-mention in it is resolved and no leading
`/name` is expanded. That mirrors the terminal, and it is load-bearing rather than
incidental: a background agent's final text is written by a model, so expanding mentions
would let a child that wrote `@.env` in its answer make the parent read the file on the
strength of somebody clicking "adopt". `prompt` expands the mentions a *person* typed.
This is not that.

Refused for an agent that is still running, for one that produced no output, and for a
session that is not live.

### One manager, one records directory

The engine hands these verbs its **own** background-agent manager — the same instance a
`/bg` in a terminal sharing the process would reach, with the same queue and the same
concurrency cap. There is no second registry.

That has a consequence worth knowing about. A manager corrects any record still `running`
to `interrupted` when it loads the records directory, because a fresh manager is normally
a fresh process and a live agent would have been reported by the manager that started it.
`arcturn serve` is another process: an engine serving a workspace where a *separate*
terminal is running `/bg` adopts the same directory at startup and will report that
terminal's live agent as `interrupted` until the owning manager next persists it. The
terminal's own view is never wrong, and the record repairs itself — but a panel can show a
stale `interrupted` in the window between. Fixing it needs an owner lease in the record,
which is a change to the manager rather than to this wire.

## Org memory

`/org memory` is a small, durable, per-role set of one-line lessons that are appended to
that role's **system prompt** on later workflow runs. An `active` entry is therefore
standing instruction text: text the model reads, every run, with no user action at all.
Entries are `proposed` or `active`, and only `active` ones are ever rendered.

Three verbs:

```json
{ "id": "27", "method": "orgMemory" }
{ "id": "28", "method": "proposeOrgMemory", "params": { "role": "developer", "text": "this repo's vitest needs --run" } }
{ "id": "29", "method": "revokeOrgMemory", "params": { "id": "m4c1e9" } }
{ "id": "30", "method": "revokeOrgMemory", "params": { "id": "m4c1e9", "remove": true } }
```

`orgMemory` answers with every entry — proposed and active alike — sorted by role and then
by id, plus the `warnings` the store's own bounds produced on read. Read the warnings: an
empty `entries` from a store that was refused for exceeding its byte ceiling is a different
fact from an empty store, and only the warnings tell them apart.

`proposeOrgMemory` files an entry with `origin: "remote"`, so a person deciding whether to
approve it can see that it arrived over a socket rather than being typed at the keyboard.
The store's own bounds apply — one line, at most 160 characters, no `ORG-ASK:`/`ORG-HALT:`/
`ARCTURN-PATCH:` marker, no fence delimiter — and over-long text is **refused, not
truncated**, because clipping can invert a lesson. The refusal names the bound that was
broken, and is passed through to the client rather than flattened into "invalid request".

`revokeOrgMemory` demotes an `active` entry back to `proposed`, or with `remove: true`
deletes it outright (irreversible; confirm with the user first, the way a discard is
confirmed). Both answer with the store as it now stands.

### There is no verb that approves one, and there will not be

The gate on `proposed → active` is a person at the machine typing `/org memory approve`.
This wire has no counterpart, and neither does `/org memory add`, which files an
already-active entry because a person typed it.

The reason is not that the caller is untrustworthy. A caller holding the serve token
already has full tool execution as this user (see [Threat model](#threat-model)) and could
do considerably worse than write a JSON file. The reason is **who is asserting**. The gate
exists because an entry becoming standing instruction text is, in the CLI reference's
words, "not something a model should be able to grant itself" — and an engine cannot tell a
frame a person clicked from a frame an agent sent. `/org memory add` is live precisely
*because* a person typed it at their own keyboard, and that fact does not survive a socket.

This is the same answer [`permissionDecision`'s `scope`](#permissiondecision-grows-a-scope)
already gives: a decision made over the wire may not outlive its session, because a rule
that does is written by a person in their own config file. An org-memory entry outlives the
session in exactly that sense — it is the next run's instructions.

Proposing, revoking and deleting are allowed because of their **direction**: each can only
reduce or leave unchanged what a later run is told. Approving is the only one that adds.

What a client should build on this is the queue: show what is waiting, show its `origin`,
and show the one command that approves it. A person then reads the sentence before it
becomes an instruction, which is what the gate was for.

The proof that the gate holds is not a status field. `packages/cli/src/delegation-wire.test.ts`
proposes an entry over a real socket and then asks `loadOrgMemoryInjector` — the function
`workflow.ts` calls to build a role's system prompt — what that role would be told. It is
told nothing. Only after a local approve does the lesson appear.

## Workflows

[Workflows](/docs/workflows) are the feature this wire was quietest about for the longest.
A markdown file's numbered list is real control flow: each stage runs in order, an `@role`
dispatches to a named agent with its own tools and its own **lane**, `budgetUsd` caps what
the whole run may spend, `stepTimeoutMs` caps a step, and an `ORG-ASK:` line stops the
pipeline and waits for a person. A remote client attached to an engine full of pipelines
could not see that any of them existed.

Four verbs close that, and they split the way every other group on this wire splits —
`listWorkflows` and `workflowStatus` read, `runWorkflow` and `resumeWorkflow` start work
that spends money.

### The catalog, and the lane it derives

```json
{ "id": "31", "method": "listWorkflows" }
```

```json
{
  "kind": "response",
  "id": "31",
  "result": {
    "workflows": [
      {
        "name": "ship-fix",
        "description": "Reproduce, patch and review one bug report",
        "source": "/repo/.arcturn/workflows/ship-fix.md",
        "stages": 3,
        "steps": 4,
        "budgetUsd": 15,
        "stepTimeoutMs": 1800000,
        "roles": [
          { "name": "auditor", "lane": "read" },
          { "name": "runner", "lane": "exec" },
          { "name": "developer", "lane": "write" }
        ]
      }
    ]
  }
}
```

`lane` is the whole payload's reason for existing, and it is the value **the engine
derives** — `roleDispatch` over the role file's declared `tools:`, the same function the
dispatcher itself calls — not what the role's prose claims about itself. A reviewer whose
description says "read-only" and whose `tools:` line says `read, edit` is reported
`write`, because `write` is what will happen.

Two of the five values are not lanes at all; they are the two honest shapes of *nobody can
say*:

| `lane` | What it means |
| --- | --- |
| `read` | No write tool and no shell. Cannot execute, cannot touch a file. |
| `exec` | Declares `bash` and no write tool. Runs in a throwaway worktree; its diff is never captured. |
| `write` | Declares `write`, `edit` or `multiedit`. Its patch is applied to your checkout when its step succeeds. |
| `unknown` | The step names a role this engine has not loaded. The run fails pre-flight. |
| `undeclared` | The role loaded but declares no `tools:`. Dispatch refuses it. |

Reporting either of the last two as `read` would be the one wrong answer: it would tell a
person a pipeline is harmless when the truth is that it cannot run at all.

Not session-scoped — a workflow is a file the served workspace holds, so this is shaped
like `listModels`.

### Running one

```json
{ "id": "32", "method": "runWorkflow",
  "params": { "sessionId": "sess_abc", "name": "ship-fix", "input": "the retry test flakes" } }
```

```json
{
  "kind": "response",
  "id": "32",
  "result": {
    "runId": "20260825-a1b2c3",
    "workflow": "ship-fix",
    "sessionId": "sess_abc",
    "stages": 3,
    "steps": 4,
    "budgetUsd": 15,
    "stepTimeoutMs": 1800000,
    "resumed": false
  }
}
```

**This spends real money, and a write-lane role's patch lands in your checkout the moment
its step succeeds.** It is the most consequential verb on this wire.

It answers on **acceptance**, not on completion. `prompt` resolves when the run ends, and
that is right for one turn; a pipeline is minutes to hours, past every sane request
deadline (`ProtocolClient`'s own default is 30 seconds), so a `runWorkflow` that answered
at the end would hand a client a timeout for a run that is spending money perfectly
happily. The response is therefore the accepted run — its id, its shape, and the ceilings
in force — and the run itself is followed on the session's event stream.

### `budgetUsd` may only ever lower the ceiling

The workflow file's own `budgetUsd:` is the authority. A caller may pass a **smaller**
number to bound this one run harder:

```json
{ "id": "32", "method": "runWorkflow",
  "params": { "sessionId": "sess_abc", "name": "ship-fix", "budgetUsd": 5 } }
```

A larger one is refused — `invalidRequest`, naming both figures — rather than silently
clamped:

```text
Workflow "ship-fix" sets budgetUsd: 15.00 in its own frontmatter, and a run started over
the wire may only lower that ceiling — $500.00 would raise it. Ask for $15.00 or less, or
edit /repo/.arcturn/workflows/ship-fix.md.
```

Refusing rather than clamping is deliberate. `listWorkflows` already published the file's
ceiling, so the refusal is actionable; and a client told "fine" that got a different
ceiling would render a number the engine is not enforcing. `0` and negatives are refused
at the wire boundary for the opposite reason: `0` means "disabled" to the cost guard, so a
"ceiling" of zero would widen an otherwise-bounded run.

Nothing else here can be raised either, and none of it has a parameter. The file's
`stepTimeoutMs`, each role's `maxTurns`, each role's declared `tools:` and the engine's
permission rules all bind exactly as they do for the person at the terminal.

### Following a run: no second channel

A run narrates onto **the session's own event stream** — the one the client already
subscribed to with `openSession`:

- Each progress event becomes the same `notice` the terminal prints, from the same
  function (`reportWorkflowEvent`). Stage starts, step starts with their lane, an applied
  patch, a step that paused for a human, the run's own report and its final text.
- Each step republishes its child agent onto that stream as a namespaced sub-agent, so a
  client's existing sub-agent rows light up with no new logic.

There is deliberately no workflow event channel and no `WorkflowEvent` on the wire. The
durable half is `workflowStatus`, which reads the run journal the engine already writes —
not a second record kept for the wire.

The run's final text is capped at 64 KiB on the way onto the stream, and what is cut is
*said* to be cut; the whole of it is still in the run's own directory under
`~/.arcturn/workflow-runs/<runId>/`.

### What a run reached

```json
{ "id": "33", "method": "workflowStatus", "params": { "runId": "20260825-a1b2c3" } }
```

```json
{
  "kind": "response",
  "id": "33",
  "result": {
    "runs": [
      {
        "runId": "20260825-a1b2c3",
        "workflow": "ship-fix",
        "state": "paused",
        "stage": 3,
        "stageCount": 3,
        "stepsDone": 3,
        "stepsTotal": 4,
        "spentUsd": 2.41,
        "turns": 9,
        "startedAt": 1756137600000,
        "updatedAt": 1756137780000,
        "questions": [
          { "stepId": "3", "question": "per-tenant or per-user sessions?" }
        ],
        "steps": [
          { "id": "1", "stage": 1, "status": "done", "tokens": 4200 },
          { "id": "2", "stage": 2, "status": "done", "agent": "developer", "patch": "applied" },
          { "id": "3", "stage": 3, "status": "paused", "agent": "lead" }
        ]
      }
    ]
  }
}
```

Two shapes, one verb, on `pendingChanges`' terms: **`runId` omitted** is every recent run
as a summary row, **`runId` given** is that one run plus its per-step breakdown. A listing
is a menu and must stay small; the step rows are what a person opens one run to read.

Not session-scoped, deliberately: runs live under the served home, so a run started in a
terminal is exactly as legible here as one started over the wire — and a client can see
the run it is about to resume without having started it.

`state` is the one-glance answer, and two of its values are the reason it is not just a
status: `stalled` is a run whose newest journal line is older than its own step deadline
(the process writing it is gone), and `resumable` is one that stopped without a terminal
line. Collapsing either into `running` would tell a person to keep waiting for a run
nothing is running.

A `runId` this engine has no journal for answers **zero rows**, not an error. That is not
a softening: `isUnsupportedMethodError` reads every `invalidRequest` as "this engine does
not know the verb", so a read that refused in-band would be indistinguishable from an
older engine and a client would degrade it to `undefined`. It is the same rule
`pendingChanges` keeps by answering `dryRun: false` instead of erroring.

### The `ORG-ASK` gate, answered from a client

A role that hits a real ambiguity emits a line beginning `ORG-ASK:` and the engine stops
the run at a resumable cut point. Over this wire that is three things happening at once: a
`notice` on the session stream (`Step 3 paused for a human answer: …`), a `paused` state
on `workflowStatus`, and a `questions` array carrying every question the stage raised — a
*stage* pauses, not a step, so a parallel stage whose branches each ask owes an answer for
each of them.

```json
{ "id": "34", "method": "resumeWorkflow",
  "params": { "sessionId": "sess_abc", "runId": "20260825-a1b2c3", "answer": "per-tenant" } }
```

Resume is not a re-run: completed steps are replayed from the journal rather than executed
again, and a write-lane patch that already landed is probed with `git apply --check
--reverse` before anything decides to apply it twice. That property belongs to the engine
and is reached through this verb rather than re-implemented behind it.

Resuming a paused run **without** an `answer` is refused with "needs an answer, not a
nudge" and the questions are re-surfaced on the stream — which is what the terminal's bare
`/workflow resume <runId>` does, and what lets a client offer "remind me" and "here is my
answer" as the two different things they are.

### Refused while the session is busy

`runWorkflow` and `resumeWorkflow` answer `sessionBusy` when the session is mid-turn **or
already running a pipeline**. Not because the two would corrupt each other — a workflow's
steps are their own agents — but because that session's event stream is the only place
either is visible, and two pipelines narrating into one transcript is a transcript nobody
can read. `deleteSession` refuses for a session with a run in flight for a sharper reason:
one of its steps may be applying a patch to your checkout at that moment.

`abort` cancels both halves. A client's Stop button is one control, and a pipeline that
kept spending after it was pressed — because the button only ever reached the session's
own agent — would be the worst kind of unresponsive.

### What a remotely-started run is capped by

Everything a local one is, and one thing more:

- The workflow file's own `budgetUsd:` and `stepTimeoutMs:`, unchanged — and a wire budget
  can only lower the first.
- Each role's declared `tools:`, which is what decides its lane. There is no parameter for
  it and there will not be one.
- Each role's `maxTurns`, clamped by the session's own `subagentMaxTurns`.
- The engine's permission mode, composed with the **calling session's**: a run gets the
  *stricter* of the two, so a client that put its session in `plan` cannot get a write or
  exec lane out of an engine whose own mode is looser. The composition only ever narrows.

And the one worth stating plainly rather than half-building: a workflow step's permission
asks go to the **runtime's** requester, not to the calling session's. `arcturn serve`
installs no requester on the runtime (each *session* agent gets its own), so an ask raised
by a step fails closed and denies. In practice a write- or exec-lane role reaches its
tools over the wire only on an engine already running in `yolo`, exactly as it would under
`--print`. Routing those asks to the calling session would mean mutating the runtime's
shared requester slot for the length of a run, which races every other session the same
engine is hosting; the honest failure is better than the racy feature, and it errs closed.

### Degradation

`listWorkflows` and `workflowStatus` degrade to `undefined` on the `listModels` precedent —
both read, and a client that gets nothing offers no workflow menu and no run view, which
is exactly true. `runWorkflow` and `resumeWorkflow` do **not**: a client told "started" by
an engine that ignored the request believes a review pipeline ran and merges on a verdict
nobody produced, and an `ORG-ASK` answer that silently went nowhere leaves a run paused
forever while the person who answered believes it is moving. Both reject.

## Reconnecting

`{ method: "openSession", params: { sessionId } }` re-attaches to a session that already
exists in the server's `SessionStore` — the same JSONL-backed tree described in
[Sessions](/docs/sessions) — so a client that drops its connection can reconnect and
resume exactly where it left off, replaying `listSessions` to discover what's available.

## The browser client

`--web` starts a second, deliberately tiny HTTP listener (`packages/cli/src/web/server.ts`)
whose entire vocabulary is `GET / → the page`: one self-contained, unauthenticated static
document that speaks the same WebSocket protocol from a phone or a second machine.

It is unauthenticated because it is inert on its own — **it never serves the token.** The
credential reaches the browser only from the person opening it: as a URL fragment
(`#token=...`, which browsers never send to any server) or typed into the page's own
prompt. A `?token=...` query parameter is deliberately **not** accepted, even as a
fallback — unlike a fragment, a query string *is* sent to a server (access logs, proxies,
browser history sync), which would break the "never sent to a server" invariant this
page depends on. The WebSocket handshake, not the page load, is what actually
authenticates.

The response carries a strict Content-Security-Policy: `default-src 'none'`, no external
origin reachable at all, inline style/script pinned to a per-response nonce, and
`connect-src` narrowed to WebSocket URLs on the exact host the page was requested from
(`connect-src ws://<host>:* wss://<host>:*`, taken from the request's `Host` header).
`form-action 'none'` specifically stops a broken script from ever falling back to a real
form submission that would put the token in a URL. A `Permissions-Policy:
camera=(), microphone=(), geolocation=()` header denies those APIs outright, even though
the page never asks for them — belt-and-suspenders against a future markup mistake.

Because a browser always stamps `Origin` on a WebSocket upgrade and `ArcturnServer` rejects
any origin it wasn't explicitly given, `runServe` computes the allowed set
(`webClientOrigins`) before starting the socket: loopback names always, the bound address
when it's concrete, every non-internal IPv4 interface when the bind is a wildcard host (the
"open it from my phone" case) — and anything passed via `--web-origin`, since a tunnel
hostname or a reverse-proxy name can't be guessed from the bind address.

## Versioning

`PROTOCOL_VERSION` (currently `1`, from `@arcturn/types`) is bumped whenever the wire format
changes in a way old clients can't safely ignore. A server and client should agree on it
during connection setup; a server built against a newer protocol version should be
prepared to reject or degrade for an older client rather than silently misbehave.

Adding an *optional* verb is not such a change, and `listModels`, `sessionHistory`,
`deleteSession`, `resolveContext`, `permissionState`, `setPermissionMode`,
`listCommands`, `compact`, `exportSession`, `mcpStatus`, `pendingChanges`,
`applyChanges`, `discardChanges`, `listCheckpoints`, `rewindTo`, `listWorkflows`,
`runWorkflow`, `workflowStatus` and `resumeWorkflow` did not bump it — nor did
`prompt`'s optional
`attachments` field (or a `file` attachment's optional `range`), `resolveContext`'s
optional `range` and `attachmentKinds`, or `permissionDecision`'s optional `scope`, all of
which an older server validates and drops. Nor did `attachments`' third *kind*,
`fileReference` — an older server refuses the frame outright, which is a rejection a newer
client handles and, for this one, the only acceptable outcome: dropping the unknown kind
back to `file` would mean the engine injecting a whole file the user never asked for. An older
server rejects the new verb with an ordinary `invalidRequest` response the newer client
handles, and an older client simply never sends it — both halves keep working.

**Optional is not the same as degradable**, and the two questions are decided separately.
A `ProtocolClient` translates an older server's `invalidRequest` into `undefined` only
where the shrug is true: `listModels`, `sessionHistory`, `resolveContext`,
`permissionState`, `listCommands`, `exportSession`, `mcpStatus`, `pendingChanges` and
`listCheckpoints` all
read, so a client that gets nothing shows nothing and has lost only a view. `deleteSession`,
`setPermissionMode`, `compact`, `applyChanges`, `discardChanges` and `rewindTo` reject
instead. For the
delete, "fine" would mean a session that was never deleted; for the mode it is worse — a
panel told "fine" would show a `plan` chip over an engine still in `yolo`, and a user who
believes they restricted an agent they did not restrict is the one outcome a permission
control may not produce. For `compact`, "fine" would mean context a client reports as freed
and then keeps filling. `applyChanges` and `discardChanges` are the sharpest pair of the
set, because they fail in opposite directions and both directions are bad: an apply
reported as done that did not happen tells a reviewer their change landed while the file
on disk says otherwise — and their next move is to discard the shadow tree that held the
only copy — while a discard reported as done that did not happen leaves them certain their
pending work is gone right up until the next apply lands it. `rewindTo` is sharper still,
and it is the reason the rule is stated as "what would a shrug claim" rather than "is this
new": a rewind reported as done that did not happen tells a user their files went back to a
state they never returned to, so they carry on building on code they believe they discarded.
`permissionDecision`'s `scope` is a field rather than a verb: an
older server drops it and the allow lands as an allow-*once*, which narrows rather than
widens — the only direction a permission field may move silently.

The delegation verbs split the same way, and the split is worth reading because both
halves are here. `backgroundAgents` and `orgMemory` **read**, so an older engine's
`invalidRequest` becomes `undefined` and a client shows no background-agent surface and no
memory queue — which is also the honest answer for an engine that has a verb but no manager
or store wired, since to a client those are one piece of news. `startBackgroundAgent`,
`cancelBackgroundAgent`, `adoptBackgroundAgent`, `proposeOrgMemory` and `revokeOrgMemory`
**reject**, each for its own version of the same reason: a start that did not happen leaves
a client polling forever for an agent nothing is producing; a cancel that did not happen
leaves a person believing they stopped spending money they are still spending; an adopt
that did not happen shows a turn that never started; a propose that did not happen shows a
queue of suggestions that do not exist; and a revoke that did not happen leaves a person
believing a lesson has stopped reaching their roles' prompts while it still does.

The workflow verbs split the same way a fourth time, and they are the clearest
illustration of why the question is decided per verb rather than per feature — one
feature, four verbs, two answers. `listWorkflows` and `workflowStatus` **read**, so an
older engine's `invalidRequest` becomes `undefined` and a client offers no workflow menu
and no run view. `runWorkflow` and `resumeWorkflow` **reject**: they start work that
spends real money and can apply a write-lane role's patch to your checkout, so a client
told "started" by an engine that ignored the request believes a review pipeline ran and
merges on a verdict nobody produced — and an `ORG-ASK` answer that silently went nowhere
leaves a run paused forever while the person who answered believes it is moving. It is
also why `workflowStatus` answers an unknown run id with zero rows rather than an
`invalidRequest`: a read that refused in-band would be read by
`isUnsupportedMethodError` as "this engine is too old" and shrugged away.

A bump, by
contrast, breaks in both directions: `SessionHeader.version` is stamped `1` and validated
as `1`, and the protocol client raises `ProtocolVersionMismatchError` for any header or
handshake advertising a different number. Raising it to announce a feature neither side
needs to negotiate would sever every existing client/server pair.

## Known limitation: shared tools and checkpoints

`createServeHost` builds each served session's `Agent` fresh, but when the host runtime
doesn't supply a `buildSessionAgent` override, tools and the system prompt are read *once*
from the runtime's own snapshot and shared across every served session — including its
checkpoint store. Practically: `write`/`edit` calls from served sessions still work, but
their checkpoints land in the runtime's own checkpoint directory rather than each served
session's own, so `/rewind`-style recovery does not cleanly isolate concurrently served
sessions from each other. A real `ArcturnRuntime` (as opposed to a minimal test stub) does
supply `buildSessionAgent` and avoids this; it's called out here because it's the one gap
worth knowing about before running several concurrent served sessions against one process.

The same gap decides whether the rewind verbs work at all. `createServeHost` wires
`listCheckpoints`/`rewindTo` only when the runtime supplies both `buildSessionAgent` and a
conversation fork; a runtime without them answers `available: false`, which is the honest
answer for a host that keeps no per-session checkpoints rather than an empty picker.
