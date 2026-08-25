# Notes — @arcturn/server

Implementation notes, contract friction, and deliberate design choices recorded
while building the WebSocket server. Nothing in `packages/types` or any other
package was modified; every item below is a local work-around or a documented
choice made inside `packages/server/`.

## Transport: JSON WebSocket text frames, not `@arcturn/protocol`'s `FrameDecoder`

`FrameDecoder` (from `@arcturn/protocol`) implements NDJSON framing for
stream transports (e.g. stdio, TCP) where multiple JSON values can arrive
concatenated in one chunk and must be split on newlines. A `ws` connection
already delivers one complete message per `"message"` event — WebSocket's own
framing does the chunking — so there is nothing for `FrameDecoder` to do here;
using it would mean re-serializing each already-parsed `ws` message back to a
string, appending `"\n"`, and feeding it through a decoder whose only job
(finding the newline) is already done. `ws-server.ts` instead does
`JSON.parse` directly per message and reuses everything else from
`@arcturn/protocol`: `validateClientRequest`, `okResponse`, `errorResponse`,
`eventMessage`, and `ErrorCode`. `encodeFrame`/`isProtocolError` (framing
concerns) are unused, as intended.

## `authenticate` is not in the frozen `ClientRequest` union

The task requires optional shared-token auth where a connection's first frame
is `{ id, method: "authenticate", params: { token } }`. `ClientRequest` in
`packages/types/src/protocol.ts` has no `"authenticate"` method — the union is
frozen — so this is handled as a **pre-protocol** frame in `ws-server.ts`,
entirely outside `validateClientRequest`:

- `auth.ts` defines a local `AuthenticateFrame` type and `isAuthenticateFrame`
  type guard (structural, not derived from `@arcturn/types`).
- While a connection's `ConnectionState.authenticated` is `false`,
  `#handleMessage` routes every frame to `#handleAuthFrame` instead of
  `validateClientRequest`. Only a frame matching `AuthenticateFrame` shape
  *and* carrying the configured token flips `authenticated` to `true` and
  gets an `okResponse`; anything else (malformed JSON, wrong method, wrong or
  missing token) gets an `errorResponse` with `ErrorCode.invalidRequest` and
  the socket is closed with code `4401`.
- Token comparison uses `node:crypto`'s `timingSafeEqual` (`auth.ts`,
  `tokensMatch`), guarded for equal-length buffers first since
  `timingSafeEqual` throws on a length mismatch.
- If no `token` option is passed to `ArcturnServer`, `ConnectionState.authenticated`
  starts `true` and this whole path is skipped; sending an `authenticate`
  frame in that mode would hit the normal `validateClientRequest` path and be
  rejected as an unknown method (harmless, just not special-cased).

## `PermissionRequester` doesn't carry the request's id — same friction `core`'s NOTES.md documents, worked around again here

`@arcturn/core/NOTES.md` (item 2) already documents that
`PermissionRequester` takes `Omit<PermissionRequest, "id">`, so a requester
function cannot know which `PermissionRequest.id` it is being asked to
resolve; the engine emits the full request (with `id`) as a `permissionRequest`
event *before* invoking the requester, and overwrites whatever `requestId` the
requester's returned decision carries with its own generated id regardless.

`SessionHost` (`session-host.ts`, `#register`) needs that id to let
`handlePermissionDecision(sessionId, decision)` route a decision to the right
in-flight ask, and to include it in the `permissionRequest` event a WebSocket
client actually sees (which it does — the id is on the event, not hidden).
The wiring:

1. The agent-event listener (which also fans out to `observers`) watches for
   `permissionRequest` events. When one arrives, it **synchronously** creates
   the pending-decision `Promise`, timeout timer, and `pendingPermissions`
   map entry for that request's id, *before* fanning the event out to
   observers.
2. `agent.permissions.setRequester(...)` is wired to a small function that
   just pulls the *next* id off a FIFO queue (`pendingRequestIds`, pushed by
   the same listener) and returns the already-created pending `Promise`.

This ordering matters and is worth spelling out because it is *not* obvious
from the engine's public API alone: `PermissionEngine.check()` always emits
`permissionRequest` before calling `#resolve()`, and `#resolve()` only invokes
the requester if no rule/mode short-circuits first — so the pending slot must
be created at emit time (step 1), not at requester-invocation time, or a
decision arriving synchronously in the same tick as the event (only possible
for an in-process caller of `SessionHost` — real WebSocket clients always have
at least one tick of network I/O in between) would find no pending entry yet
and be silently dropped. An earlier version of this file created the pending
slot lazily inside the requester closure instead; it deadlocked
`session-host.test.ts`'s permission round-trip because the test's observer
callback called `handlePermissionDecision` synchronously from inside the same
`permissionRequest` event dispatch, before the requester (and therefore the
pending slot) had been created. Fixed by moving slot creation to step 1 above.
Test callers that resolve a decision from inside an event listener still need
to defer (e.g. `setTimeout(..., 0)`) to mirror a real client, since the
`permissionDecision` handling happens *within* the same synchronous listener
invocation that the event itself arrived on.

## `setModel`'s wire payload is a bare string; `Agent.setModel` needs a full `ModelSpec`

`ClientRequest`'s `setModel` carries only `{ sessionId, model: string }` (a
model id), but `Agent.setModel(model: ModelSpec)` needs the full spec — and a
`ModelSpec` is not decoration: `provider`, `baseUrl` and `apiKeyEnv` are what
decide which company's endpoint the session's next prompt, and the credential
that goes with it, are sent to. There is no model catalog in `packages/types`
or reachable from this package's frozen dependencies, so
`SessionHostOptions.resolveModel?: (modelId: string) => ModelSpec` is injected
by a composition root that has one (e.g. `@arcturn/ai` via `@arcturn/cli`'s
`createServeHost`).

**Without one, `SessionHost.setModel` refuses.** It used to synthesize a
minimal spec from the id — `provider: "anthropic"`, a 200k context window, no
capabilities — described here as "good enough to keep the session working, not
to price or size it correctly". That was wrong twice over. It was not a
sizing inaccuracy but a routing one: whatever id a client asked for, the next
request went to Anthropic. And it was silent — the only reason it ever
surfaced was a user whose `ANTHROPIC_API_KEY` happened to be dead, so a
mis-routed `setModel("zai-api/glm-5.3")` came back as a 401 in Anthropic's
error shape instead of quietly billing the wrong provider.

The default now throws rather than guessing. Deliberately a refusal and not a
required option: making `resolveModel` mandatory is satisfiable by a lie —
the cheapest way to quiet the compiler is to paste back the very synthesizer
being deleted — while a refusal has nothing to paste. It also keeps hosts that
never accept `setModel` (a client that only prompts) able to construct a
`SessionHost` at all. The compile-time check that requiredness would have
bought is instead bought by a test at the seam where the gap actually lived:
`packages/cli/src/serve.test.ts`'s "routes the next request to the provider
the id names", which drives a real `ArcturnServer` + real `ProtocolClient`
over real `ws` and asserts on which of two stub provider endpoints received
the HTTP request.

Two failure modes, two codes:

- No resolver wired — a wiring fault in the host process, not the client's
  doing — throws a plain `Error`, which `ws-server.ts`'s `mapError` reports as
  `ErrorCode.internal`, message naming `SessionHostOptions.resolveModel`.
- A wired resolver rejecting the id (unknown model, missing credentials) is
  the client's doing and becomes a `SessionHostError` with code
  `invalidRequest`, carrying the resolver's own message.

Either way the id is resolved *before* the live session is touched, so a
refusal leaves the session on the model it was already using — there is no
half-switched state.

## `sessionHistory` replays events, and had to project them from what is stored

`openSession` returns a `SessionHeader` and calls `#attachObserver`, which subscribes to
*future* events only. Nothing replayed the past, and `ProtocolClient` had no verb to ask for
it — so a client attaching to a session with hours of work in it could render an empty chat
and be telling the truth about everything it knew. `sessionHistory` closes that.

Two decisions worth recording:

**The payload is `AgentEvent`s, not a projected message list.** A `{ role, text }[]` would be
smaller, and it would force every client to grow a second transcript renderer — one deciding
all over again how a tool call, a denied permission, a compaction or a sub-agent reads, and
drifting from the live one the first time either side changed. Replaying the same events the
live stream carries means a client folds history through the identical reducer. The VS Code
panel's `reduceChat` needed no new branch to gain the feature, which is the argument made
concrete.

**Nothing here was recorded, so it has to be projected** (`session-history.ts`). The store
holds `SessionEntry` values — the resulting messages — never the token stream that produced
them, so a replayed assistant turn is one `messageEnd` where a live client saw a
`messageStream` per delta. Two rules keep the projection honest: every string comes from the
entry that carried it, and only event types the live stream also emits are used. A stored
`label`, or a `state` entry's `model`, is therefore dropped rather than given a shape a client
has never seen — which is also what makes the "no new class of data on the wire" claim true
rather than hopeful. Only the *active branch* is replayed (`pathToLeaf(entries,
latestEntryId(entries))`, the same thing `Agent.resume` materializes), so a rewound session
does not show a user a conversation the agent will never continue.

The cap is 1 MiB of serialized events and 1000 events, whichever binds first, keeping the
newest and cutting at a `runStart` boundary. The byte figure is `ws-server.ts`'s own
`DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` and a quarter of `DEFAULT_MAX_PAYLOAD_BYTES` — a
history response is *essential* traffic (`#send` never drops it), so it must not be the frame
that wedges a socket. The count bound exists because bytes are what the wire pays and element
count is what a client's reducer pays; 1000 is ~2.5× the 400-block ceiling the richest client
in this repo trims its transcript to, so it never bites first for a client that would have
rendered them all. `truncated`/`droppedEvents` are reported explicitly rather than left
derivable, because a transcript that quietly starts mid-conversation reads as the whole
conversation.

It is a separate verb rather than part of `openSession` for three reasons: `openSession`'s
result is a `SessionHeader` that every existing client validates as one (changing it would
need a `PROTOCOL_VERSION` bump), a client re-attaching after a reconnect often does not want
the replay again, and a separately-requested payload is one a client can skip.

## `deleteSession` needed a store method that did not exist, and it is optional on purpose

Nothing in the CLI deleted a session before this — `git grep` for a delete/prune/cleanup
routine over `packages/` found none — so there was no existing path to reuse and
`SessionStore.delete(sessionId)` was added. It is **optional** on the interface because
`sdk-sessions.md` invites users to write their own `SessionStore`, and making it required
would break every one that exists. `JsonlSessionStore` and `MemorySessionStore` both
implement it.

`SessionHost.deleteSession` therefore refuses — a plain `Error`, reported as
`ErrorCode.internal` — when a store is configured but cannot delete, rather than reaching
around it to unlink a path it guessed. That is the same call `setModel` makes without a
`resolveModel`, for the same reason: the store is the only thing that knows where its
sessions live.

Ordering is deliberate and is the part most likely to be got wrong by a later edit:

1. Refuse a **running** session (`sessionBusy`) before touching anything.
2. Delete from the **store**.
3. **Evict** the live session last — deny pending permission asks, `abort()` (belt and
   braces: another connection could have started a run in the gap), push a final
   `{ type: "notice", level: "warn" }` to every observer, unsubscribe, drop it from
   `#sessions`.

Evicting first would mean telling every attached client "this was deleted" and then
discovering the store could not delete it — a lie that leaves the session on disk. Done this
way, a store failure surfaces as an error with the session intact and still re-openable.

**Known limitation: the busy check is per-process.** `isRunning` is read off the live `Agent`
in *this* host, so a session running in a different process against the same
`~/.arcturn/sessions` directory — a TUI in another terminal, a second `arcturn serve` — is not
seen and is not refused. Deleting one is loud rather than silent: the other process's next
`JsonlSessionStore.append` raises `SessionStoreError` with `notFound` and its run ends with an
error, instead of quietly writing to a file nobody will read. Fixing it properly needs a lock
or a liveness marker in the session directory, which does not exist today and is not something
this verb should invent on its own.

The final `notice` is an ordinary `AgentEvent`, not a new `ServerMessage` kind: a client
renders it with whatever it already does for engine diagnostics, and no wire shape had to be
added for a case that happens once per session ever. `ws-server.ts` then clears the session
from **every** connection's `observedSessions` map — the host has already dropped the
subscriptions, so what is left is this server's own bookkeeping, which would otherwise keep a
dead unsubscribe closure alive for the life of each socket.

## Mention expansion is injected, not implemented here — and the bug that made it necessary

`expandMentions` lives in `@arcturn/cli`, because that is where the TUI and
`--print` have always called it. Which is precisely why RFC 0005 §0 lists this
as a *bug* rather than a gap: `SessionHost.prompt` used to hand `text` straight
to `Agent.prompt`, so a prompt arriving over the wire reached the model as
`@src/auth.ts` — six words about a file — while the identical prompt typed into
the TUI reached it as the file. Every remote client was silently degraded, and
nobody noticed because the TUI is where mentions were tested.

The fix could have been a second expander in this package. It is not, and the
reason is the same one `resolveModel`/`modelCatalog` learned: two
implementations of one rule agree right up until they do not, and RFC 0005 §1.1
asks the served path to inherit "the strictest existing rule rather than a new
one". So `SessionHostOptions.contextResolver` is an *injection* — `prompt-context.ts`
defines the shape, `@arcturn/cli`'s `createContextResolver` supplies the real one,
and that one calls the very `expandMentions` the TUI calls.

The consequence worth writing down: a `SessionHost` built **without** a
`contextResolver` is still the old engine. It passes `text` through verbatim.
That is deliberate (a host assembled by hand still runs) but it means the fix is
only real where `createServeHost` does the wiring, which is why the end-to-end
proof lives in `packages/cli/src/serve.test.ts` against a real provider rather
than here against a stub.

## Two refusals with different blast radii, and why they are not the same refusal

RFC 0005 §1.1 says an attachment the model cannot use is "refused with the
reason, never silently dropped", and also that the served path expands mentions
"exactly as the TUI does". Those pull in opposite directions for the same fact —
an image on a text-only model, a path outside the workspace — so `SessionHost`
splits on **who asked for it**:

- An **attachment** is a thing the client named. Running the turn without it is
  the silent drop, so it is fatal: `invalidRequest`, before `agent.prompt` is
  reached, no turn spent, nothing appended to the session.
- A **mention** is one token inside prose a person typed. The TUI carries on
  (the token stays in the text, the file is simply not read), so the served path
  carries on too — but emits a `notice` naming what it refused, which is the
  half the served path was missing. A remote user could not previously tell a
  refusal from a mention that worked.

`ResolvedImage.source` is what carries that distinction out of the resolver, and
it exists for no other reason.

## The vision check is server-side on purpose

`SessionHost.prompt` reads `session.agent.model.capabilities.vision` itself
rather than trusting a client to have called `listModels` first. Two reasons,
and only the second is about hostility: a client holding the serve token has no
obligation to check, and an *honest* client written before RFC 0005 does not
know it should. The server is the only party that always knows which model the
session is on right now — `setModel` may have moved it since the client last
looked — so it is the only place the answer cannot be stale.

## Context resolution opened a busy window, and `LiveSession.starting` closes it

Worth recording because it was a *regression this change introduced*, caught by
two tests that already existed. `SessionHost.prompt` used to reach
`agent.prompt()` synchronously, so `Agent.isRunning` flipped before the returned
promise was handed back — which is what made "a second `prompt` is
`sessionBusy`" and "`deleteSession` refuses a running session" true. Expanding
mentions is filesystem I/O, so `prompt` now `await`s first, and in that window
the agent is still idle.

Two requests can arrive in it, and both used to be answered wrongly: a second
`prompt` sailed past the busy check and failed deep inside `Agent` with a raw
`Error` (mapped to `internal`, not `sessionBusy`), and a `deleteSession` deleted
a session that was about to start appending to its own file — precisely the
thing that check exists to prevent.

`LiveSession.starting` is claimed synchronously, before the first `await`, and
released in a `finally` so a refused prompt cannot wedge the session. `isBusy()`
is the pair, and both the prompt path and `deleteSession` consult it.

One window remains and is not closed here: `abort()` during the resolve does
nothing, because `Agent.abort()` on an idle agent is a no-op, so a client that
aborts between accepting a prompt and starting its run will still see the run
begin. It is a few milliseconds of `stat`/`readFile` wide.

## `PROMPT_ATTACHMENT_MAX_BYTES` is `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES`, deliberately

Same 1 MiB `SESSION_HISTORY_MAX_BYTES` uses, and the same argument run inbound
instead of outbound. `sessionHistory` budgeted against the threshold so an
essential outbound frame could never be the one that wedges the socket; an
inline-image `prompt` is the inbound mirror — 1 MiB of attachment bytes is about
1.37 MiB of base64, comfortably inside `DEFAULT_MAX_PAYLOAD_BYTES` (4 MiB),
above which `ws` closes the connection with 1009 and the client learns nothing
about why. It also bounds what a path attachment makes this server read off
disk, which never crosses the wire at all. One ceiling for both costs, because a
client should not have to know which it is paying.

## The wire's scope wall is enforced three times, and that is not redundancy

RFC 0005 §1.2 is one sentence — "Nothing persists to disk from a remote client"
— and it is enforced at three seams:

1. `@arcturn/protocol`'s `validateClientRequest`, on the way **out** of a
   client. A `scope: "project"` never reaches a socket, so a UI bug fails
   immediately with a message saying where such a rule does live rather than
   costing a round trip to be told the same thing.
2. The same function, on the way **in** to a server. A client that skips the
   client library gets the identical refusal.
3. `SessionHost.handlePermissionDecision` itself.

The third is the one that looks redundant and is not. `SessionHost` is a public
API: the SDK docs invite an embedder to wire it to their own transport, and if
the wall lived only in frame validation, a host that spoke anything other than
this WebSocket protocol would silently regain the ability to write a user's
config from a remote decision. A rule this important may not depend on which
door a decision came through.

## "Allow for this session" is a duration, never a rule

The wire could have let a client send the `persistRule` it wanted. It does not:
`scope: "session"` makes `SessionHost` build the rule from the request's own
`suggestedRule`, which is why `PendingPermission` now holds the
`PermissionRequest` it is waiting on.

The difference is the blast radius of a compromised or buggy client. Given a
client-authored rule, the widest thing a decision could grant is whatever that
client cared to write — `{ tool: "*", action: "allow" }` for one `bash` ask.
Given a duration, the widest thing it can grant is the rule the engine already
computed for the tool call it already made. The client chose *when to stop*, not
*what to allow*.

A consequence worth stating: a request with no `suggestedRule` is not
repeatable (the engine offers one only for a call with a real subject), and
asking for `"session"` on one is **refused** rather than downgraded to an
allow-once. A client told "yes" for a session it did not get would keep offering
the button and never find out.

## `setPermissionMode` refuses mid-run; the TUI's `/permissions` does not

A deliberate asymmetry, and the only place this package's behaviour is
*narrower* than the terminal's.

`Agent.setPermissionMode` is a single field assignment, so there is no torn
state to protect — each permission check reads the mode when it runs, exactly as
it does locally. What there is, is a **pending ask**: an ask already sitting in a
remote client's modal was raised under the old regime and will be resolved under
it, whatever the mode says by the time the answer arrives. "I switched to plan
and it still wrote the file" is a reachable complaint, and refusing with
`sessionBusy` removes the whole class of it. It also makes RFC 0005 §2's "takes
effect on the next turn" literally true rather than approximately.

The counter-argument — that a safety control should work while things are going
wrong — does not survive contact with `abort`, which stops the run outright and
is strictly stronger than switching to `plan`. A client that wants to stop an
agent has the better verb already, and the mode change succeeds the moment the
run ends.

The local user keeps the mid-run change because they are watching the transcript
scroll and know exactly which tool call their change landed before. A remote
client with a queued modal does not. The cost is real and is paid in
`attach.ts`: the plan-exit gate's "approve and auto-accept edits" is raised
mid-run, so it still cannot be expressed remotely, and the user is told why.

## `permissionState.tools` is the whole of RFC 0005 §1.4

There is no verb for "can this engine reach the web", and the RFC is explicit
that there should not be: the question is really "is `fetch` in the tool set".
Two properties of that field are load-bearing and easy to lose:

- **Names only.** `validatePermissionState` copies the array one string at a
  time, so a tool *description* — untrusted text from an extension or an MCP
  server — cannot ride along into a UI. A spread would have made that a matter
  of discipline instead of a matter of types.
- **The full set, not the disclosed subset.** Under progressive tool disclosure
  `Agent.tools` is still everything the session was built with, while the model
  sees a facade that changes per turn. A capabilities line driven by the facade
  would flicker for reasons no user could explain.

## The built-in command list lives here, not in `@arcturn/cli`

`REMOTE_REACHABLE_BUILT_IN_COMMANDS` names commands that are *defined* in
`@arcturn/cli`, which looks backwards until you ask what makes an entry true:
not "does this command exist" but "can the verbs on this wire carry it out".
This package implements the verbs. Keeping the list next to `ws-server.ts`'s
dispatch table means the question "does a built-in become reachable now?" gets
asked when a verb is added, and the list breaks here — rather than in somebody's
menu — when one is removed.

## `SessionHostOptions` has two more optional fields than the task brief's minimal list

The brief specifies `{ agentFactory, sessionStore?, defaultCwd }`. Two more
optional fields were added, both additive/backward-compatible:

- `permissionTimeoutMs?: number` (default 5 minutes) — the brief explicitly
  calls for "a configurable timeout, default 5 min → deny", and this is the
  only place to configure it.
- `resolveModel?: (modelId: string) => ModelSpec` — see above. Optional to
  pass, but `setModel` refuses without it rather than inventing a spec.
- `sessionHistoryLimits?: { maxBytes?; maxEvents? }` — bounds on what
  `SessionHost.sessionHistory()` returns; see above. Injectable so a test can
  prove the cap actually cuts without writing a megabyte of conversation first.
- `modelCatalog?: () => ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>` —
  what `SessionHost.listModels()` (and therefore the `listModels` wire verb)
  answers with. Injected for the same reason as `resolveModel`: the catalog
  lives in `@arcturn/ai`, which this package does not depend on, so the CLI
  supplies it (`createServeHost` → `modelCatalogEntries()`, the same source
  `--list-models` renders). Without it the host answers `[]` rather than
  inventing entries. Whatever the source returns is re-validated against the
  wire contract on the way out, so a host cannot leak a field the contract
  does not define — a credential value being the one that matters.

## `agentFactory` alone must know how to resume a session

`SessionHost` has no `AgentOptions` (llm, system prompt, tools, ...) of its
own — only `agentFactory: (opts: { sessionId; cwd; model? }) => Agent`. So
`SessionHost.openSession` for a session that isn't currently live in this
process (but is known to `sessionStore`) calls the *same* `agentFactory` with
the existing `sessionId`/`cwd`, trusting the factory to decide whether to
build a fresh `Agent` or `Agent.resume()` from the shared store (since the
factory closure is the composition root and is the only thing with access to
full `AgentOptions`, including which `SessionStore` instance to resume from).
`SessionHost` itself never calls `Agent.resume` or inspects session entries —
it only tracks liveness, header bookkeeping (when it has its own
`sessionStore` reference), and event fan-out. This means a composition root
that wants transparent resume-after-restart must build its `agentFactory` to
check the store itself; a factory that just does `new Agent(...)` on every
call will silently start a fresh, empty conversation for a previously-existing
`sessionId` rather than resuming it. Documented rather than solved in this
package because solving it would mean `SessionHost` reaching into `Agent`
construction concerns it isn't given (no LLM client, no system prompt, no
tools) — that's the factory's job by design.

## `SessionHost.prompt()` resolves only once the run completes

`Agent.prompt()` itself resolves at `runEnd` (completed, aborted, or error —
see `core`'s NOTES.md: "errors are data"). `SessionHost.prompt()` forwards
that promise as-is rather than resolving immediately after kicking the run
off. Consequence: a WebSocket client's `response` frame for a `"prompt"`
request arrives only when the run ends, not as an immediate ack — clients
that want an immediate ack should treat the `runStart` event (which arrives
right away, since it's emitted synchronously inside `Agent.prompt` before any
`await`) as one. This was chosen for the simplest possible 1:1 mapping onto
`Agent.prompt`'s existing contract; nothing about the wire protocol requires
either choice. It does not block other traffic on the same connection —
`ws-server.ts` dispatches each incoming frame via a fire-and-forget async
handler (`ws.on("message", (data) => { void this.#handleMessage(...) })`), so
a slow-to-resolve `prompt` response never delays another request's response
(this is exactly what makes the `sessionBusy` concurrent-prompt test able to
get its own quick response while the first prompt is still running).

## `listSessions`'s wire response uses the generic `response` envelope, not the dedicated `"sessions"` `ServerMessage` kind

`ServerMessage` has both a generic `{ kind: "response"; id; result }` (used
for every request/response pair here) and a separate
`{ kind: "sessions"; sessions }` kind with no `id`. The latter reads like an
unprompted broadcast/push notification (e.g. "the session list changed"), not
a reply correlated to a specific request id. Since the task only asks for
`listSessions` as a request/response RPC, `ws-server.ts` replies with
`okResponse(request.id, { sessions })`; the `sessionsMessage` builder and the
`"sessions"` `ServerMessage` variant are consequently unused by this package.
Nothing in the task brief calls for unprompted session-list push
notifications, so this was not implemented — flagging in case a future
feature (e.g. multi-client session-list sync) wants it.

## Errors before authentication and before request validation always use `id: ""`

`ClientRequest.id` and the `response` `ServerMessage`'s `id` are both plainly
typed `string` — there's no `id: null`/optional-id allowance for "this failure
happened before we could read an id" (the standard JSON-RPC escape hatch).
Malformed JSON obviously has no readable `id`; an unauthenticated non-auth
frame might structurally have an `id` field, so `requestId()` (a small local
helper) opportunistically extracts a string `id` when present and falls back
to `""` otherwise. Clients should not rely on matching `""` responses to a
specific request — treat an empty-id error response as connection-level
diagnostics, not a correlated reply.

## `@types/ws` / `ws` resolved without any local declaration file

The task allowed for a local `.d.ts` shim under `src/` if `ws`'s types didn't
resolve via the root devDependency. They resolved cleanly
(`node_modules/.pnpm/@types+ws@8.18.1` is linked into
`packages/server/node_modules/@types/ws`, and `ws@8.21.3` likewise into
`packages/server/node_modules/ws`), so no shim was needed.

## Test helpers

`src/test-helpers/` (excluded from the build by `tsconfig.json`'s
`"exclude": ["src/**/*.test.ts", "src/**/test-helpers/**"]`) contains a
from-scratch scripted `LLMClient` (`fake-llm.ts`: `createScriptedLLM`,
`createGatedLLM`, `textTurn`, `toolCallTurn`) and a minimal permission-gated
`Tool` (`tools.ts`: `createGuardedTool`) — written independently rather than
importing `@arcturn/core`'s internal `src/test-helpers/fake-llm.ts`, per the
task's constraint against depending on another package's test helpers.
`createGatedLLM` exists specifically to make the `sessionBusy` concurrency
tests deterministic: its single scripted turn blocks on an internal gate
`Promise` until the test calls `release()`, so a test can assert a second
`prompt()` call is rejected as busy *while the first is provably still
running*, without relying on timing.

## Everything the task asked to cover, and where

- End-to-end create → prompt → runStart/messageStream/runEnd over a real `ws`
  connection: `ws-server.test.ts`, first test.
- Invalid JSON / invalid request frames get error responses, connection
  survives: `ws-server.test.ts`, "responds with an error, and keeps the
  connection open, ...".
- `sessionBusy` on concurrent prompt: `session-host.test.ts` (host-level, via
  `createGatedLLM`) and `ws-server.test.ts` (wire-level).
- Permission ask round trip (toolCall stream → `permissionRequest` frame →
  client `permissionDecision` → tool proceeds/denied): both an allow and a
  deny path in `ws-server.test.ts`, plus the host-level round trip and an
  auto-deny-on-timeout case in `session-host.test.ts`.
- Auth accept/reject, and rejecting a non-auth first frame:
  `ws-server.test.ts`.
- Multi-client observing the same session both receive events:
  `ws-server.test.ts`, "fans out one session's events to multiple observing
  connections".
- Graceful stop (closes connections, releases the port, a fresh server can
  rebind): `ws-server.test.ts`, last test; `SessionHost.dispose()` (aborts
  runs, denies pending asks without severing already-attached observers, so a
  run's tail — e.g. a final `runEnd`) is exercised directly in
  `session-host.test.ts`.
