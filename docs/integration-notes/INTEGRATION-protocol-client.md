# Integration: the protocol client (`arcturn attach`'s transport)

`packages/protocol` could frame, build and validate wire messages, but
nothing in the repo *spoke* the protocol as a client — `ArcturnServer` had no
counterpart. This adds one:

| File | What it is |
| --- | --- |
| `packages/protocol/src/client.ts` | `createProtocolClient(socket, options)` — the client half of the wire protocol |
| `packages/protocol/src/client.test.ts` | 43 tests, all driven against an in-memory fake socket (no network) |

Both files are new. Nothing existing was edited, so two small changes are
still needed to make this live: the barrel exports (§1) and the CLI command
that constructs a socket (§2).

## 0. What it does

`ProtocolClient` mirrors `SessionHost`'s method surface so remote code reads
like local code:

```ts
const client = createProtocolClient(socket, { token });
await client.authenticate();                       // no-op without a token
const sessions = await client.listSessions();      // SessionHeader[]
const header = await client.createSession({ cwd }); // or openSession(id)
const stop = client.onEvent((sessionId, event) => render(event));
await client.prompt(header.sessionId, "explain this repo");
await client.steer(id, "…"); await client.abort(id); await client.setModel(id, "opus");
await client.respondToPermission(id, { requestId, behavior: "allow" });
const catalog = await client.listModels();         // ModelCatalog | undefined
stop(); client.close();
```

`listModels` is the one **optional** verb: a server older than it answers
`invalidRequest` ("Unknown method"), which this client translates into
`undefined` — "no catalog here" — so a caller degrades instead of failing.
Every other failure still rejects. `PROTOCOL_VERSION` was deliberately not
bumped for it; see `web/content/docs/server-mode.md`.

Every call resolves from the matching `response` frame and rejects with a
typed error: `ProtocolRequestError` (server `ErrorCode`), `ProtocolTimeoutError`
(30s default, configurable), `ProtocolClosedError` (socket closed/errored),
`ProtocolVersionMismatchError`, or a plain `ProtocolClientError` for an
unusable payload. All carry a `code` — either a server `ErrorCode` value or a
`ClientErrorCode` value — so callers branch on `error.code` without caring
which side failed.

## 1. `packages/protocol/src/index.ts` — exports to add

Insert this block directly **above** the `./framing.js` exports (this is the
position and ordering Biome's import/export sorting produces — verified by
running `biome check --write` on the resulting file, which made no changes):

```ts
export { PROTOCOL_VERSION } from "@arcturn/types";
+export type {
+  ProtocolClient,
+  ProtocolClientOptions,
+  ProtocolEventListener,
+  WebSocketLike,
+} from "./client.js";
+export {
+  ClientErrorCode,
+  createProtocolClient,
+  DEFAULT_REQUEST_TIMEOUT_MS,
+  ProtocolClientError,
+  ProtocolClosedError,
+  ProtocolRequestError,
+  ProtocolTimeoutError,
+  ProtocolVersionMismatchError,
+} from "./client.js";
 export type { FrameDecoderOptions, ProtocolError } from "./framing.js";
```

`ClientErrorCode` is a const-plus-type pair (same shape as `ErrorCode`), so
the value export carries the type too.

## 2. `arcturn attach` in the CLI

### 2a. `packages/cli/package.json` — add the `ws` dependency

`ws` is deliberately **not** a dependency of `@arcturn/protocol`: that
package stays dependency-free apart from `@arcturn/types`, which is why the
socket is injected rather than constructed (§3). The CLI is where a real
socket gets created, so `ws` belongs there — the same version the server
already pins:

```jsonc
"dependencies": {
  "@arcturn/protocol": "workspace:*",
  // …
  "ws": "^8.21.3"
},
"devDependencies": {
  "@types/ws": "^8.18.1"
}
```

### 2b. `packages/cli/src/args.ts` — an `attach` command

Mirror the `serve` command that already exists (`SERVE_COMMAND_NAME`,
`--host/--port/--token`). `attach` needs a URL and a token:

```ts
/** A parsed `attach` command. */
export interface AttachCommand {
  readonly kind: "attach";
  /** `ws://host:port` to connect to. */
  readonly url: string;
  /** `--token`: shared secret matching the server's. */
  readonly token?: string;
  /** `--session`: session id to open instead of creating a new one. */
  readonly sessionId?: string;
}

export const ATTACH_COMMAND_NAME = "attach";
```

Help text, alongside the existing `serve` line:

```
  attach <url>                  Drive a session on a `arcturn serve` host.
```

`arcturn serve` defaults to port 7717, so `arcturn attach` should default a bare host
argument to `ws://<host>:7717`.

### 2c. `packages/cli/src/attach.ts` — constructing the socket

The client adopts an already-constructed socket and **queues outbound frames
until the socket's `"open"` event**, so there is no connect handshake to
await — hand over the socket immediately after `new WebSocket(...)`:

```ts
import { createProtocolClient, ProtocolClosedError } from "@arcturn/protocol";
import { WebSocket } from "ws";

export async function runAttach(command: AttachCommand): Promise<number> {
  const socket = new WebSocket(command.url);
  const client = createProtocolClient(socket, {
    ...(command.token === undefined ? {} : { token: command.token }),
    onProtocolError: (error) => process.stderr.write(`arcturn: ${error.message}\n`),
  });

  try {
    // Resolves once the server accepts the token; rejects with a
    // ProtocolClosedError if the connection never came up (ECONNREFUSED,
    // wrong port), or a ProtocolRequestError if the token was rejected.
    await client.authenticate();

    client.onEvent((sessionId, event) => {
      // Same AgentEvent stream the local runtime renders — reuse display.ts.
      renderEvent(sessionId, event);
    });

    const header =
      command.sessionId === undefined
        ? await client.createSession({ cwd: process.cwd() })
        : await client.openSession(command.sessionId);

    // openSession/createSession + openSession is what subscribes this
    // connection to the session's events server-side.
    await client.openSession(header.sessionId);
    await client.prompt(header.sessionId, await readUserPrompt());
    return 0;
  } catch (error) {
    if (error instanceof ProtocolClosedError) {
      process.stderr.write(`arcturn: connection to ${command.url} failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    client.close();
  }
}
```

Notes for whoever writes the real command:

- **Permission prompts** arrive as `AgentEvent`s of type `permissionRequest`;
  answer them with
  `client.respondToPermission(sessionId, { requestId: event.request.id, behavior })`.
  The server ignores decisions for unknown/expired request ids, so a late
  answer is harmless.
- **`prompt()` resolves when the run ends**, not when it is accepted —
  `SessionHost.prompt` awaits `agent.prompt(text)`. A long run can therefore
  exceed the default 30s request deadline: pass a larger `requestTimeoutMs`
  (or `0` to disable the deadline entirely) for an interactive attach, and
  treat the `runStart` event as the ack. This is the single most important
  thing to get right when wiring the interactive TUI in.
- **Ctrl-C** should call `client.abort(sessionId)` (a separate request, which
  still gets through while `prompt` is outstanding), not `client.close()`.
- `client.close()` rejects everything still in flight with a
  `ProtocolClosedError`; it is idempotent and safe in a `finally`.

## 3. Design decisions worth knowing

### `WebSocketLike` is the Node `EventEmitter` shape

```ts
export interface WebSocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}
```

`on(...)` rather than browser-style `onmessage`/`onclose` properties, because
that is the API of the `ws` package the server already depends on and uses
throughout `ws-server.ts` (`ws.on("message", …)`, `ws.on("close", …)`). A real
`ws` `WebSocket` satisfies this structurally with **no adapter** — verified
both by a compile-time assignability test against a restatement of
`@types/ws`'s declaration, and by actually running the client against a live
`ArcturnServer` (§4).

Listener payloads are typed `unknown` because `ws` delivers
`Buffer | ArrayBuffer | Buffer[]`; the client normalizes all of those (plus
plain `string`) to text itself, mirroring the server's `rawDataToUtf8`.

`readyState` is optional: a socket that does not report one is assumed open,
which is what lets a plain in-memory fake drive the client with no handshake
simulation. A real `ws` socket reports `0` (CONNECTING), so frames queue until
`"open"` and then flush in order.

If a caller ever wants Node's *global* `WebSocket` (browser-style) instead,
the adapter is small and needs no change here:

```ts
function toWebSocketLike(socket: globalThis.WebSocket): WebSocketLike {
  return {
    get readyState() { return socket.readyState; },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === "message") socket.addEventListener("message", (e) => listener(e.data));
      else if (event === "close") socket.addEventListener("close", (e) => listener(e.code));
      else if (event === "error") socket.addEventListener("error", (e) => listener(e));
      else socket.addEventListener("open", () => listener());
    },
  } as WebSocketLike;
}
```

### No `FrameDecoder` on this path

`framing.ts` implements NDJSON reassembly for *stream* transports, where a
frame's bytes may be split or coalesced arbitrarily. WebSocket preserves
message boundaries, and `ArcturnServer` sends `ws.send(JSON.stringify(message))`
with **no trailing newline** — feeding that to `FrameDecoder` would buffer
forever waiting for a `"\n"` that never arrives. So each inbound message is
parsed as exactly one JSON document, and each outbound request is sent as
`JSON.stringify(request)` (not `encodeFrame`), which is what the server's
`JSON.parse(rawDataToUtf8(data))` expects. This matches the reasoning already
recorded at the top of `ws-server.ts`.

### The `authenticate` frame really is first

`ArcturnServer` closes any connection whose first frame is not `authenticate`
(code 4401) when a token is configured. The client therefore starts the
handshake **eagerly in the constructor** when `options.token` is set, and
every other request `await`s that handshake before it is enqueued — so
nothing can overtake it even if the caller never calls `authenticate()`
explicitly. A failed handshake rejects the gated requests with the server's
own error rather than a vague "socket closed".

`authenticate` is not a member of the frozen `ClientRequest` union (see the
server's `auth.ts`), so it is the one outbound frame that skips
`validateClientRequest`. Every other outbound frame is validated against the
same contract the server enforces, so a bad call fails locally with a precise
message instead of costing a round trip — and, when unauthenticated, a
dropped connection.

### Protocol version

The wire has **no explicit version handshake today** — `PROTOCOL_VERSION` is
exported but never appears in a frame. The client does what it can without
server changes:

- it sends `protocolVersion: PROTOCOL_VERSION` inside the `authenticate`
  frame's `params`. Today's `isAuthenticateFrame` ignores unknown fields, so
  this is inert but gives a future server something to negotiate against;
- if an `authenticate` response ever carries a numeric `protocolVersion` that
  differs, the handshake rejects with `ProtocolVersionMismatchError`. A
  response with no version is read as compatible (today's server sends none);
- a `SessionHeader` stamped with a `version` other than `1` rejects the same
  way, because a header this client cannot interpret is an incompatibility,
  and saying so beats a vague `SessionHeader.version must be 1` validation
  failure.

Closing the gap properly is a server-side change (echo `protocolVersion` in
the `authenticate` result — see §5).

## 4. Verification

```
npx vitest run packages/protocol/src/client.test.ts   # 43 passed
npx tsc -p packages/protocol/tsconfig.json --noEmit   # clean
npx biome check packages/protocol/src/client.ts packages/protocol/src/client.test.ts  # clean
```

The package `tsconfig.json` excludes `*.test.ts`, so the test file was
additionally type-checked through a throwaway config that includes it — it is
clean too (this caught two real typing bugs Vitest could not: the fake
socket's `on` was looser than `WebSocketLike`, and `.catch((e: X) => e)`
widened the error type to `X | <resolve type>`).

Unit coverage: request framing for every method; out-of-order response
correlation; error responses carrying `ErrorCode`; timeout (rejects *and*
drops the pending entry, so a late response is reported as unroutable rather
than double-settling); close and socket-error rejecting all pending;
authenticate-first ordering and gating; event fan-out with unsubscribe and a
throwing listener; malformed inbound frames (bad JSON, wrong shapes, unknown
kinds, undecodable payload types) reported rather than thrown; Buffer /
Buffer[] / ArrayBuffer decoding including multi-byte UTF-8 split across a
`Buffer[]`; queue-until-open; response payload validation and version
mismatch.

**No end-to-end test is committed**, per the brief's condition: `ws` is a
dependency of `packages/server` only, and pnpm's strict layout means it does
not resolve from `packages/protocol` (which has no `devDependencies` at all).
Adding it would mean editing `packages/protocol/package.json`, which was out
of scope.

It was still verified end-to-end out-of-tree: a throwaway script in the
session scratchpad wired the built client to a **real `ArcturnServer`** on an
ephemeral loopback port with a stub `SessionHost` agent, over a real `ws`
socket, with token auth on. All of it passed —

```
✓ authenticate handshake over real ws
✓ createSession -> b1047569-…   ✓ openSession   ✓ listSessions -> 1 session
✓ event fan-out: runStart, notice, runEnd       ✓ unsubscribe stops delivery
✓ setModel / steer / abort / permissionDecision all ack
✓ error response -> ProtocolRequestError sessionNotFound
✓ server shutdown -> ProtocolClosedError
```

— which is what proves the `on()` socket shape, the queue-until-open path,
Buffer payload decoding and the auth-first ordering against the real server
rather than only against the fake. If `ws` is later added to
`packages/protocol`'s devDependencies, that script is worth promoting into
`client.test.ts` verbatim.

## 5. Follow-ups (deliberately out of scope)

1. **Reconnect.** This client drives one socket for its lifetime; a closed
   socket is terminal. Automatic reconnection — backoff, re-`authenticate`,
   re-`openSession` for every previously observed session, and a policy for
   requests that were in flight when the link dropped (they reject today, and
   `prompt` is not idempotent, so blind replay would be wrong) — belongs in a
   wrapper above this client, not inside it.
2. **A real version handshake.** Have `ArcturnServer` echo
   `protocolVersion: PROTOCOL_VERSION` in the `authenticate` result; the
   client already checks it. Note that today a server with **no** token never
   exchanges an `authenticate` frame at all, so there is no place to
   negotiate — a version-bearing `hello` frame would be the fuller fix.
3. **`kind: "sessions"` pushes** are validated and then dropped: the current
   server only ever answers `listSessions` with a `response`, so there is no
   subscriber to route them to. If the server starts pushing session-list
   updates, add an `onSessions(listener)` to the client.
4. **`wss://`.** `arcturn serve` speaks plain `ws://`; the client passes whatever
   URL the CLI builds. TLS support is a server-side and CLI-flag concern.
