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
   like `agent.steer()` locally.
5. `{ method: "abort", params: { sessionId } }` cancels the in-flight run.

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
