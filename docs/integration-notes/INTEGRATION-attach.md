# `arcturn attach` — integration plan

`arcturn attach <url> [session]` connects this terminal to a running `arcturn serve`
instance and drives one of its sessions — "tmux for agents". Per the task's
hard rules **no existing file was edited**: `packages/cli/src/attach.ts` and
`packages/cli/src/attach.test.ts` are new and self-contained. This document
specifies the (not yet applied) changes to `packages/cli/package.json`,
`packages/cli/src/args.ts` and `packages/cli/src/main.ts` that wire it in,
mirroring the existing `serve`/`replay`/`audit` positional-command pattern
exactly, and records the protocol gaps hit along the way.

---

## 1. What already exists (`packages/cli/src/attach.ts`)

```ts
runAttach(options: RunAttachOptions): Promise<number>
```

```ts
interface RunAttachOptions {
  socket: WebSocketLike;      // injected transport — see §2
  token?: string;             // shared secret, when serve was started with one
  sessionId?: string;         // omit to reuse the newest / create one
  terminal?: Terminal;        // defaults to ProcessTerminal; TestTerminal in tests
  cwd?: string;               // only used when a session has to be created
  url?: string;               // display-only label for the status bar
  requestTimeoutMs?: number;  // defaults to 0 = deadlines DISABLED — see §5.1
  interruptWindowMs?: number; // double-Ctrl+C window (default 1500)
  streamThrottleMs?: number;  // live re-render throttle (default 60)
  glyphs?: GlyphSet;
}
```

Also exported: `AttachExitCode` (`ok: 0`, `disconnected: 1`,
`attachFailed: 2`) as both a const object and its value type.

**Behaviour**

- **Attach.** `authenticate()` → if `sessionId` is given, `openSession(id)`;
  otherwise `listSessions()` and `openSession` the newest by `createdAt`;
  if the server lists none, `createSession({ cwd })` **followed by
  `openSession`** — `ws-server.ts` only calls `#attachObserver` on
  `openSession`, so a created-but-not-opened session delivers no events.
- **Render.** Every inbound `AgentEvent` for the attached session goes
  through the existing `TranscriptFormatter` (`display.ts`) and is written to
  real scrollback with the same "empty the live region → `renderNow()` →
  write → restore" dance `interactive/app.ts` uses. Events for *other*
  session ids are dropped (one connection can observe several sessions).
- **Live region.** Streaming assistant text, the todo widget
  (`renderTodoWidget`), a spinner/elapsed activity line, the bordered
  `InputBox`/`PromptEditor`, and a `StatusBar` showing
  `✦ arcturn attach · <url> · <sessionId>` on the left and
  `<connecting|attached|closed> · <idle|running>` on the right.
- **Input.** Enter submits `prompt` when idle and `steer` while a run is
  active (running state is tracked from `runStart`/`runEnd` events). Esc
  aborts a live run, or clears a half-typed prompt. Ctrl+C interrupts a run,
  or exits on a second press inside the interrupt window. Ctrl+D on an empty
  buffer exits.
- **Permissions.** A `permissionRequest` event opens the *same*
  `permissionDialog` the local app uses (reused from
  `interactive/dialogs.ts`), and the answer is sent with
  `respondToPermission(sessionId, { requestId: request.id, … })`. A **full
  dialog is practical** — see §5.2. Anything still unanswered at exit is
  explicitly **denied** rather than dropped, because a dropped request would
  stall the remote run until the server's 5-minute auto-deny.
- **Shutdown.** Clean exit stops the TUI then closes the protocol client. A
  socket `close`/`error` mid-session prints
  `arcturn attach: connection to <url> closed (code N).` *after* the TUI stops
  (so it is the last thing on screen) and returns `AttachExitCode.disconnected`
  — it never hangs.

`InteractiveApp` is deliberately **not** reused: it reads
`runtime.agent.isRunning`, `runtime.metrics`, `runtime.extensions`, git
status and does local @-mention expansion, none of which a socket answers.
The transport-agnostic parts (`TranscriptFormatter`, `Dynamic`, `InputBox`,
`PromptEditor`, `renderTodoWidget`, `tailLines`, `permissionDialog`,
`planDialog`, `suggestRule`) are imported directly and unchanged.

---

## 2. Required dependency (not applied): `ws`

`attach.ts` itself needs **no new dependency** — the socket is injected as a
`WebSocketLike`, exactly like `createProtocolClient` does, and the tests
drive it with an in-memory fake. But **`main.ts` must construct a real
socket**, and `packages/cli/package.json` does not declare `ws` today (only
`@arcturn/server` does, as a transitive dep). Add to
`packages/cli/package.json`:

```json
  "dependencies": {
    "ws": "^8.21.3"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1"
  }
```

Match `packages/server/package.json`'s versions exactly so pnpm dedupes to
one copy. Relying on the transitive hoist would work by accident on a
hoisted install and break under `node-linker=isolated` / pnpm's default
strictness, so declare it.

`ws`'s `WebSocket` satisfies `WebSocketLike` structurally with no adapter
(`on("message"|"open"|"close"|"error", …)`, `send(string)`, `close()`,
`readyState`) — that is why `WebSocketLike` is the Node `EventEmitter` shape
rather than the browser `onmessage` shape.

---

## 3. `args.ts` changes (not applied)

Mirror the `replay`/`audit` blocks exactly.

**a. Command type** — next to `ReplayCommand`:

```ts
/** A parsed `attach <url> [sessionId]` command. */
export interface AttachCommand {
  /** Command family. */
  readonly kind: "attach";
  /** `ws://host:port` of a running `arcturn serve`. */
  readonly url: string;
  /** Session to attach to; omitted means "newest, or create one". */
  readonly sessionId?: string;
}
```

**b. Union** — add to `CliCommand`:

```ts
export type CliCommand =
  | AuthCommand
  | CompletionsCommand
  | ReplayCommand
  | AuditCommand
  | ServeCommand
  | AttachCommand;
```

**c. Command name constant** — next to `SERVE_COMMAND_NAME`:

```ts
/** First positional that switches into attach-command parsing. */
export const ATTACH_COMMAND_NAME = "attach";
```

**d. Parse block** — insert alongside the other command blocks in
`parseArgs`, after the `serve` block:

```ts
  if (positional[0] === ATTACH_COMMAND_NAME && commandCandidates > 0) {
    const url = positional[1];
    if (url === undefined || positional.length > 3) {
      return { ok: false, error: "attach needs a server URL and an optional session id" };
    }
    if (!/^wss?:\/\//.test(url)) {
      return { ok: false, error: `attach needs a ws:// or wss:// URL, got "${url}"` };
    }
    const sessionId = positional[2];
    args.command = {
      kind: "attach",
      url,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    args.prompt = "";
    return { ok: true, args };
  }
```

No new flag is needed: `--token` already exists on `CliArgs` (documented as
"With serve: shared auth token"), and `attach` reuses it — the same secret on
both ends. Widen that TSDoc comment to "With serve/attach". `--cwd` is also
reused (only relevant when `attach` has to create a session).

**e. Help text** — in the usage block, next to the `serve` line:

```
  attach <url> [session]        Drive a remote `arcturn serve` session from this terminal.
```

and under options, widen:

```
      --token <secret>          With serve: shared auth token (generated if omitted).
                                With attach: the token to present.
```

**f. `completions.ts`** — its `subcommands` spec currently enumerates only
`auth` (`serve`/`replay`/`audit` are not there either), so nothing is
strictly required. If subcommand completion is ever filled in, `attach`
belongs in the same list, with no fixed `children` (its arguments are a URL
and a session id).

---

## 4. `main.ts` changes (not applied)

**a. Imports:**

```ts
import WebSocket from "ws";
import { runAttach } from "./attach.js";
```

**b. Dispatch** — next to the `serve` branch in `main()`:

```ts
  if (args.command?.kind === "attach") {
    return runAttachCommand(args.command, args);
  }
```

**c. Runner** — next to `runServeCommand`:

```ts
/**
 * Drive a remote `arcturn serve` session.
 *
 * The socket is constructed here (and only here): `attach.ts` takes an
 * injected `WebSocketLike` so it stays testable without a network.
 *
 * @param command - The parsed `attach <url> [session]` command.
 * @param args - Parsed command line, for `--token` and `--cwd`.
 */
async function runAttachCommand(command: AttachCommand, args: CliArgs): Promise<number> {
  let socket: WebSocket;
  try {
    // Throws synchronously on a malformed URL; a refused connection instead
    // surfaces as an "error" event, which runAttach reports and exits on.
    socket = new WebSocket(command.url);
  } catch (error) {
    process.stderr.write(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  return runAttach({
    socket,
    url: command.url,
    ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
    ...(args.token === undefined ? {} : { token: args.token }),
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
  });
}
```

Add `AttachCommand` to the existing `import type { CliArgs, … } from "./args.js"`.

Notes:

- The socket may be handed over **while still CONNECTING** — the protocol
  client queues frames until `"open"`. No `await` on the handshake here.
- `runServeCommand` already prints
  `attach with: arcturn attach ws://… --token …`, so the message it emits is
  correct once this lands; no change needed there.
- Nothing is registered on `SIGINT`: the TUI owns Ctrl+C (double-press to
  exit), matching `runInteractive`.

**d. Optional export** — `packages/cli/src/index.ts` re-exports the public
CLI surface (it does not currently export `runServe`, so this is genuinely
optional). To make the attach client embeddable, add:

```ts
export { AttachExitCode, runAttach, type RunAttachOptions } from "./attach.js";
```

---

## 5. Protocol gaps and forced design choices

### 5.1 `prompt()` spans the whole run — deadlines must be disabled

`SessionHost.prompt` awaits the agent, so the `prompt` **response frame does
not arrive until the run ends**. With `createProtocolClient`'s default
30s `requestTimeoutMs`, every real prompt would reject with a
`ProtocolTimeoutError` mid-run. `attach.ts` therefore constructs its client
with `requestTimeoutMs: 0` (deadline disabled) and treats the inbound
`runStart` event as the acknowledgement; the `prompt()` promise is only
watched so a genuine rejection can be shown as a notice.

**Gap:** the wire cannot distinguish "prompt accepted" from "run finished" —
one response frame carries both. A future revision should either answer
`prompt` immediately with `{ ok: true }` (the run's completion is already
observable as `runEnd`) or add an explicit `accepted` notification. Until
then, no attach client can use a per-request deadline for `prompt`, which
also means a genuinely wedged server is indistinguishable from a long run.

### 5.2 Permission requests — a full dialog *is* possible

Good news, contrary to the brief's fallback plan: the `permissionRequest`
event carries the complete `PermissionRequest` **including its `id`**, and
`respondToPermission(sessionId, decision)` sends `decision.requestId` back,
which `SessionHost.handlePermissionDecision` matches against its
`pendingPermissions` map. So the client shows the same modal
`permissionDialog` the local app shows — Allow once / Allow always / Deny —
with exact correlation even when several asks are outstanding. No degraded
inline prompt was needed, and no request is ever silently dropped
(unanswered ones are denied at exit).

Two smaller gaps inside this area:

- **`persistRule` scope.** "Allow always" sends
  `persistRule: { …suggestRule(request), scope: "project" }`. That rule is
  persisted **on the server's machine**, against the served session's
  project — correct, but worth knowing: an attaching user writes permission
  rules into the *host's* `.arcturn/` config, not their own.
- **Plan mode's "approve and auto-accept edits" cannot be expressed.** The
  local app answers that choice by calling
  `runtime.setPermissionMode("acceptEdits")`. `ClientRequest` has
  `setModel` but **no `setPermissionMode`**, so the attach client approves
  the plan once and prints a warning saying auto-accept is unavailable
  remotely. Fix: add
  `{ id, method: "setPermissionMode"; params: { sessionId; mode: PermissionMode } }`
  to `ClientRequest`, a `SessionHost.setPermissionMode`, a `ws-server.ts`
  dispatch case, and a `ProtocolClient.setPermissionMode`.

### 5.3 No reconnection, and no session-scoped unsubscribe

`createProtocolClient` explicitly does not reconnect: a closed socket is
terminal. `attach.ts` therefore exits `1` with a clear message instead of
silently freezing. Reconnect-and-resubscribe (the thing that would make this
truly tmux-like — detach, close the laptop, re-attach) needs either client
retry logic or a protocol-level resume. Relatedly there is no
`closeSession`/`unsubscribe` method, so a client that opens several sessions
receives all their events for the connection's lifetime; `attach.ts` filters
by `sessionId` client-side.

### 5.4 No slash commands, cost or context telemetry

The local status bar shows `formatCost(runtime.metrics.costUsd)` and
`ctx N%` from `agent.estimatedTokens`. Neither crosses the wire: `AgentEvent`
carries `turnEnd.usage` per turn but no running cost, and no message reports
the model's context window or the session's total tokens. The attach status
bar therefore shows connection/run state instead. Adding a `sessionStatus`
server push (model display name, permission mode, cost, estimated tokens,
context window) would close this and is the single highest-value protocol
addition for the attach experience.

Slash commands (`/model`, `/clear`, `/rewind`, …) are also absent: they are
`CommandRegistry` operations against a local `ArcturnRuntime`. `setModel` is the
only one the wire can express today; it is deliberately **not** bound to a
key in this first client rather than shipping a half-populated `/` menu.

### 5.5 `listSessions` returns no activity hint

Choosing "the newest session" uses `SessionHeader.createdAt`, which is
*creation* time, not last-activity time. Attaching after a long-running older
session was resumed picks the wrong one. `SessionHeader` would need a
`lastActiveAt` (or the server a `sessions` push with live state) to do
better.

### 5.6 `serve`'s own known limitation still applies

Per `serve.ts`'s TSDoc, served sessions currently share one tool snapshot and
checkpoint store built against the runtime's own `cwd`. Nothing in `attach`
changes that; a session created over the wire with a different `cwd` still
gets tools rooted at the server's original working directory.

---

## 6. Tests (`packages/cli/src/attach.test.ts`)

15 tests, all in memory — a `FakeSocket implements WebSocketLike` (the same
approach as `packages/protocol/src/client.test.ts`) plus `TestTerminal`. No
TTY, no network, no `ws`.

| Group | Test |
| --- | --- |
| attaching | opens the session it was given |
| attaching | authenticates before anything else when a token is given |
| attaching | attaches to the newest listed session when none is named |
| attaching | creates a session when the server lists none, then opens it |
| attaching | exits non-zero with a message when the server rejects the session |
| rendering | renders a scripted event sequence through the `TranscriptFormatter` |
| rendering | ignores events for a session it is not attached to |
| input | sends a `prompt` frame when a line is submitted while idle |
| input | sends a `steer` frame instead while a run is active |
| input | aborts the remote run on Esc |
| input | exits 0 on a second Ctrl+C and closes the client |
| permissions | answers a permission request with a correlated `permissionDecision` |
| permissions | denies a still-open permission request on exit rather than hanging the run |
| disconnection | exits non-zero with a clear message when the socket closes mid-session |
| disconnection | exits non-zero when the socket errors |

## 7. Verification

```
$ npx vitest run packages/cli/src/attach.test.ts
 ✓ packages/cli/src/attach.test.ts (15 tests) 167ms
 Test Files  1 passed (1)
      Tests  15 passed (15)

$ npx tsc -p packages/cli/tsconfig.json --noEmit   # clean
$ npx biome check packages/cli/src/attach.ts packages/cli/src/attach.test.ts
Checked 2 files in 74ms. No fixes applied.
```

Both new files typecheck and lint against the package as it stands today —
the `ws` dependency in §2 is needed only by the `main.ts` wiring in §4, not
by `attach.ts` itself.
