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
      { "kind": "file",  "path": "src/auth.ts" },
      { "kind": "image", "path": "docs/screenshot.png" },
      { "kind": "image", "data": "iVBORw0KGgo…", "mimeType": "image/png" }
    ]
} }
```

A `file` becomes a context block headed with its path and the word `(attached file)`, so
the model can tell attached context from the user's own words. An `image` becomes a vision
block.

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
      { "name": "clear", "description": "Start a fresh session", "kind": "builtin" }
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
`createSession` and `openSession` are. Left out, each for the same reason — no verb carries
it — are `rewind`, `compact`, `diff`/`apply`/`discard`, `export`, `theme`, `mcp`, `todos`,
`cost`, `scout`, `help` (a client renders its own from this list) and `exit` (a client
closes its own socket). The list lives in `@arcturn/server`, next to the dispatch table
that decides what is true.

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
`deleteSession`, `resolveContext`, `permissionState`, `setPermissionMode` and
`listCommands` did not bump it — nor did `prompt`'s optional
`attachments` field or `permissionDecision`'s optional `scope`, which an older server
validates and drops. An older
server rejects the new verb with an ordinary `invalidRequest` response the newer client
handles, and an older client simply never sends it — both halves keep working.

**Optional is not the same as degradable**, and the two questions are decided separately.
A `ProtocolClient` translates an older server's `invalidRequest` into `undefined` only
where the shrug is true: `listModels`, `sessionHistory`, `resolveContext`,
`permissionState` and `listCommands` all read, so a client that gets nothing shows nothing
and has lost only a view. `deleteSession` and `setPermissionMode` reject instead. For the
delete, "fine" would mean a session that was never deleted; for the mode it is worse — a
panel told "fine" would show a `plan` chip over an engine still in `yolo`, and a user who
believes they restricted an agent they did not restrict is the one outcome a permission
control may not produce. `permissionDecision`'s `scope` is a field rather than a verb: an
older server drops it and the allow lands as an allow-*once*, which narrows rather than
widens — the only direction a permission field may move silently.

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
