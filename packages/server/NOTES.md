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

## A `file` attachment's `range`: clamped at the reader, refused at the boundary, probed on the wire

Three decisions worth writing down, because each of them could plausibly have gone the
other way.

**The clamp lives at the reader, not at the validator.** `validatePromptAttachment` rejects
only ranges that cannot *mean* anything — `start` below 1, `end` before `start`, a bound
that is not a whole number. It puts no ceiling on `end`, so `{ start: 1, end: 10_000_000 }`
is a valid frame. That looks permissive until you ask what it would cost: the engine never
reads more of a file than the file, and `readContextFile`'s 2 MiB per-file ceiling and
2000-line / 200 KiB inline cap already bound that, so an absurd `end` is exactly as
expensive as attaching the file with no range at all. There is no resource argument for a
boundary refusal, and there *is* an argument against one: a select-to-end, or a file edited
since the selection was taken, produces an over-long range routinely, and failing the turn
over an ordinary editor gesture would be a worse trade than clamping and saying so.

**A `start` past the end is refused, and that asymmetry is deliberate.** An over-long `end`
has an obvious honest answer (the rest of the file, reported as clamped). An over-long
`start` does not: the only thing to clamp to would be the file's tail, which is a
*different selection* than the one the client named. Substituting one silently is the exact
failure a range exists to prevent, so it is a `ContextRefusedError` — fatal, like every
other attachment refusal, since the client named those lines.

**The old-engine probe grew a second question and no second round trip.**
`ProtocolClient.prompt` already probed `resolveContext` once per session, because
`attachments` is a new field on an old verb and an engine that drops it answers `ok` after
spending the turn. `range` is that same hazard one level down and strictly worse: an engine
with `resolveContext` but no notion of ranges drops the field and sends the model the
*whole file*, which is not a smaller version of what was asked for — it is a different
prompt at a cost the user did not choose. The fix is that the existing probe now carries a
range, and `ContextResolution.range` echoes it back. The echo is a statement about the
parameter and not about the path, which is why it is answered for a directory (the probe
queries `"."`) and for a path outside the workspace: `resolveContext` stats and never
reads, so it cannot say whether a range *fits*, and inventing an answer would make the
field mean two things.

## A file *named* rather than sent, and why it is a kind and not a flag

The VS Code panel's ambient chip attached the file you had open as `{ kind: "file", path }`,
so the engine read it whole and every turn carried it — 2,161 lines of
`packages/protocol/src/client.ts` is about 22,600 input tokens a turn; 7,251 lines of
`packages/cli/src/workflow.ts` is about 81,200 — for a file nobody asked about. Three
things were wrong with that at once, and only the third is usually noticed: the agent
already has a `read` tool, so this paid to duplicate something it could fetch; the cost
recurred whether or not the question touched the file; and the user never asked for it.

The fix is a third `PromptAttachment` kind, `fileReference`, which names the path and sends
none of the bytes. What the model gets is one line — no fenced body, no `(attached file)`
heading, no trailing colon, because those three are what a block *with* content looks like
and a reference that borrowed one would be a reference the model answers from.

**It is a kind rather than `{ kind: "file", mode: "reference" }`, and the deciding reason
is the fallback.** An engine that predates a `mode` field validates the attachment, drops
the field it does not know, and injects the whole file — silently, every turn, at the
user's expense. That is not a degraded version of the feature; it is the exact bug the
feature exists to remove, reintroduced by its own fallback, and it is unacceptable however
loudly it is documented. An engine that predates a *kind* cannot make that mistake:
`validatePromptAttachment` already refuses anything outside its enum, so the frame is
rejected and no turn is spent. **The safe outcome is a property of the spelling, not of a
client remembering to probe** — which is the one structural improvement this has over the
`range` case, where the probe *is* the only thing standing between the user and the bill.
Two smaller reasons agree: a reference is a different object (no bytes, so no truncation,
no image branch, and no `LineRange` — "reference the file, but only lines 12–40" means
nothing), and the two are billed differently, which a reader should see without consulting
a second field.

**`ContextResolution.attachmentKinds` is the probe, and it buys the message, not the
safety.** The client refuses a `fileReference` locally when the kind is not advertised,
because "this arcturn engine is older than file references… Upgrade the engine, or turn off
the client's open-file context" is a sentence a person can act on where `PromptAttachment.kind
must be one of "file" | "image"` reads like a client bug. Absent `attachmentKinds` means an
engine older than the field, which a client reads as the two kinds that shipped — never as
"no kinds at all", which would also block the attachments that do work.

**Why refuse rather than quietly drop the reference and send the prompt anyway.** Dropping
narrows rather than widens — the model told less, the user billed less — which is the test
`permissionDecision`'s `scope` passes when it degrades silently. It is refused anyway for
two reasons. The panel that attached it *said so on screen*: the chip row above the
composer is the whole truth about what the next message carries, and a silently-dropped
reference makes that row a lie, which is the same failure class as the mention bug that
started all of this. And it is now one rule three times at one seam — attachments, ranges,
references — where a third different answer is how a seam stops having a rule.

The refusal is per-kind, so plain attachments and ranges keep working against that engine.
And the layer above it does not sit and wait to be refused: the panel reads
`attachmentKinds` off the `resolveContext` round trip it already makes per settled caret
and shows **no** ambient chip at all, announcing why once per connection. That is the rule
`refreshAmbient` already applied to an engine with no `resolveContext` — "a chip whose file
could never be sent is worse than none" — extended one engine-generation, not a fourth
answer bolted on. The one thing neither layer will do is fall back to `{ kind: "file" }`.

**An explicit attachment is never downgraded, at any size.** A `@`-attached 2 MB file is a
file somebody asked for, and handing the model a path instead would be the same dishonesty
pointed the other way — plus it would make one `@src/big.ts` mean two different things on
two different days as the file grew. The existing ceilings still bind and still report
themselves: truncation with a marker at 2000 lines / 200 KiB, refusal with both numbers at
the 2 MiB per-file ceiling, and refusal naming the attachment that did not fit at
`PROMPT_ATTACHMENT_MAX_BYTES`.

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

## `agentFactory` alone must know how to resume a session — and is now *told* when to

`SessionHost` has no `AgentOptions` (llm, system prompt, tools, ...) of its
own — only `agentFactory: (opts) => Agent | Promise<Agent>`. So
`SessionHost.openSession` for a session that isn't currently live in this
process (but is known to `sessionStore`) calls the *same* `agentFactory` with
the existing `sessionId`/`cwd`, trusting the factory to decide whether to
build a fresh `Agent` or `Agent.resume()` from the shared store (since the
factory closure is the composition root and is the only thing with access to
full `AgentOptions`, including which `SessionStore` instance to resume from).
`SessionHost` itself never calls `Agent.resume` or inspects session entries —
it only tracks liveness, header bookkeeping (when it has its own
`sessionStore` reference), and event fan-out. Solving it *here* would mean
`SessionHost` reaching into `Agent` construction concerns it isn't given (no
LLM client, no system prompt, no tools); that's the factory's job by design.

Two things changed once the documented contract was actually exercised, and
both were the difference between "the factory may resume" and "the factory
*can*":

1. **The return type.** It was a bare `Agent`. Rebuilding a stored branch
   means reading the session file, which is asynchronous, so the only thing a
   synchronous factory could do with an existing session id was start it over.
   `arcturn serve` did exactly that for as long as this note claimed
   otherwise: every re-attach was a blank chat, and the model was asked to
   continue a conversation it had never been shown. A promise is allowed now,
   and `createSession`/`openSession` await it.
2. **`AgentFactoryOptions.resume`.** A factory cannot tell the two calls apart
   by looking at the store: a brand-new session and a session whose file has
   no entries yet read identically, and probing races the `create` that is
   about to happen (`createSession` builds the agent *before* writing the
   header, so a failed build leaves no orphan session). This host knows which
   verb it is serving, so it says so. Ignoring the flag is still allowed and
   is exactly the old behaviour.

`openSession` also dedupes concurrent opens (`#opening`). Attaching is no
longer a `Map.get` away from done, so two clients opening one session in the
same tick would otherwise each get an agent — two live agents over one session
file, one of them unreachable but still appending. An in-flight open counts as
live; the second caller waits for the first caller's agent. A *failed* open is
forgotten rather than remembered, so the next attempt is tried rather than
replayed.

Re-attaching to a session that **is** already live returns its header and
rebuilds nothing. That is not an optimization: the live agent may be mid-turn,
holding steering messages, a pending permission ask and a conversation not yet
appended to the store. Re-resuming from disk would drop all of it, and the
*second* client — a second editor window opening the same session — would be
the one that caused it, invisibly, for the first.

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

## `/name` expansion lives in `@arcturn/cli`, and why `steer` became async

RFC 0005 §1.3 keeps command execution on `prompt`: a skill is prompt text, and
a `runCommand` verb would give one skill two behaviours. Closing the gap
therefore meant expanding a leading `/name` somewhere on the prompt path, and
the choice of *where* was already made by §1.1's mention expansion — the
knowledge (what a skill is, how `$ARGUMENTS`/`$SKILL_DIR` substitute) lives in
`@arcturn/cli`, this package cannot depend on it, so it arrives through the
injected `ContextResolver`. `SessionHost` did not gain a line for commands: it
already called `contextResolver.buildPrompt`, and `createContextResolver` now
resolves a command there before it resolves a mention.

What *is* in this package is `REMOTE_BUILT_IN_COMMAND_VERBS`, next to
`REMOTE_REACHABLE_BUILT_IN_COMMANDS` and for the same reason: a client that
sends `/model` as prompt text has to be told to call `setModel` instead, and
"which verbs make this command real" is the question membership in that list is
already decided by. Answering it in two places is how a menu entry and its
error message come to name different verbs. A test in `permissions-wire.test.ts`
holds the two exports to the same set of names.

`SessionHost.steer` changed from a synchronous hand-off to `Promise<void>`, and
now routes through the same `#buildPromptContent` as `prompt`. Two reasons, one
of them the point of the change:

1. The terminal's `skillCommand` steers the **expanded** skill body when a run
   is in flight (`runtime.ts`). A serve path that expanded `/review` on `prompt`
   but queued the literal text on `steer` would be the lying menu §3 forbids,
   lying only while a run happens to be active — the hardest kind to notice.
2. It closes §1.1's other half at the same time: mentions were never expanded on
   `steer` either, so `@auth.ts` meant the file when the session was idle and six
   words about a file when it was busy.

`steer` is a request/response verb and the protocol client has always awaited
it, so nothing on the wire changed; `ws-server.ts` awaits the call so a refusal
comes back as that request's error rather than an unhandled rejection.

Making it async opened a hazard worth naming, because it is the same one
`LiveSession.starting` already guards for `prompt`: `ws-server.ts` dispatches a
connection's frames concurrently (`void this.#handleMessage(...)`), so two
steers sent back to back — one naming a file, one plain text — reached
`Agent.steer` in whichever order their filesystem reads finished, which for a
mention-plus-plain pair was reliably backwards. A queue that reorders is not a
queue. `LiveSession.steerTail` chains them per session. `prompt` cannot share
that mechanism: it *rejects* a second caller as `sessionBusy` rather than making
it wait, which is right for a turn and wrong for a steer.

## `compact` refuses mid-run and quotes the event it just caused

Two decisions worth writing down, because both had a plausible alternative.

**Refuse, not queue.** `Agent.compact()` throws while a run is in flight,
because compaction splices the message array the run loop is iterating. So
queueing would not avoid the hazard, only defer it — and it would race the
loop's *own* automatic compaction, which can fire in the same window with
different bounds and a different cut point. It would also settle at a moment the
client cannot observe, which makes the before/after numbers describe a
conversation that has since moved on. `sessionBusy` is the same answer
`setPermissionMode` and `deleteSession` give, from the same underlying fact:
some operations have no correct meaning halfway through a turn.

The busy check is `isBusy()` (agent running **or** `LiveSession.starting`),
which is `deleteSession`'s check rather than `setPermissionMode`'s narrower
`agent.isRunning`. A mode only takes effect at the next turn, so a prompt that
has been accepted but is still resolving its context is harmless to it. A
compaction landing in that window would rewrite the array the run is about to
iterate, which is exactly what `starting` exists to prevent.

**Quote the event, do not measure again.** A compaction emits
`compactionEnd { tokensBefore, tokensAfter }` on the stream every attached
client is already reading. The verb answers with *those two numbers*, captured
by a listener attached for the duration of the call, rather than measuring its
own pair — because two sources for one number is how a notification and the
response that caused it come to disagree, which is the same argument
`built-in-commands.ts` makes for not adding a `cost` verb.

It is also the only honest option available. `Agent.estimatedTokens` anchors on
the last assistant message's *reported* usage — what the provider charged for
the pre-compaction prompt — and that anchor survives the rewrite, so reading it
before and after mostly returns the same number for a compaction that genuinely
halved the conversation. The engine already knows this: `compactMessages` pairs
the metered "before" with a character-estimated "after", because nobody has
metered the new prompt yet. (The terminal's `/compact` prints the anchored
number on both sides and therefore usually prints it unchanged. That is a TUI
display issue, not this verb's, and it is not fixed here.)

The same listener captures the `notice` the agent emits when nothing was folded,
which is what `CompactionSummary.reason` carries. `Agent.compact()` answers
`false` for two quite different outcomes — no turn boundary old enough, and a
summarizer that failed — and distinguishes them only in that notice; re-deriving
the distinction here would mean a second copy of the cut-point rule.

## `exportSession` returns a document because the server's disk is the wrong disk

The terminal's `/export` writes a file. This verb deliberately does not, and the
reason is not tidiness: an engine that writes a file wherever a remote client
asks is an arbitrary-write primitive for anyone holding the serve token, and
even used honestly it puts the document on a machine the person asking will
never look at. RFC 0005 §1.2 already says nothing persists to disk from a remote
client; this is that rule applied to transcripts. The content comes back, the
client saves it, and `filename` is a bare name that `validateSessionExport`
refuses if it carries a separator or `..` — nothing the engine sends may steer a
client's save dialog somewhere the person did not choose.

The renderers are injected (`SessionHostOptions.transcriptExporter`) for the
reason `contextResolver` and `modelCatalog` are: `exportMarkdown`/`exportHtml`
live in `@arcturn/cli` and are what `/export` already calls. Both halves —
render and `suggestFilename` — travel in one object, following the rule
`createServeHost` learned when `resolveModel` and `modelCatalog` were split and
drifted: a document and the name it is offered under are one feature, and wiring
half of it produces a `.md` file full of HTML.

`session-export.ts` owns only the part the wire is responsible for: the 1 MiB
budget (the same `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` `session-history.ts`
uses, for the reason stated there) and the trimming. Over the cap, the **oldest
messages are dropped and the document is re-rendered** rather than the string
being cut — a byte-count cut would hand a client HTML sliced through a tag. It
is a loop rather than arithmetic because only the renderer knows what a message
costs: a tool result is line-truncated, a thinking block may be omitted
entirely. Unlike `SessionHistoryLimits` there is no element-count bound, because
a client folds history through a reducer and pays per event but writes an export
to a file and pays only in bytes.

## `mcpStatus` carries four fields, and the omissions are the feature

An `McpConfig` holds a stdio server's `env` and `args`, an HTTP server's `url`
and its `Authorization` header, and the `auth: "oauth"` flag behind which a
bearer token is minted. The wire carries `{ name, transport, state, toolCount? }`
and nothing else.

The projection lives in `@arcturn/cli` (`serve-mcp.ts`), not here, and that is
deliberate: the decision about what leaves a process is best made next to the
secret, where it can be reviewed. `@arcturn/mcp` gained one narrow accessor for
it — `McpManager.transports()`, which returns the config's `type` discriminant
per server and nothing adjacent to it — rather than a `config()` getter that
would hand callers the credentials to be trusted with.

Then `validateMcpStatus` copies the same four fields out by name again on the
way out of this package. Two independent narrow gates on the payload with the
most to leak; a field added to `McpServerConfig` or `McpServerStatus` tomorrow
is absent by default rather than present until somebody notices. It is the same
mechanism `validatePermissionState` uses to keep `tools` carrying names and only
names.

Two things the terminal's `/mcp` shows that this does not:

- **The failure reason.** `McpServerStatus.error` is prose an MCP server or its
  transport wrote, and this payload feeds a `/` menu a person reads and clicks.
  Same class of string as a tool description, same rule.
- **A liveness ping.** `/mcp` pings each connected server with a 1.5s timeout
  because a person at a prompt can afford to wait. A request/response verb
  cannot add one dead server's timeout to every round trip, and a second
  liveness field beside `state` would give a client two answers to one question.
  `McpServerSummary.state` says in its own doc that it is an observation rather
  than a guarantee.

## `cost` is listed as a built-in with no verb behind it, on purpose

`built-in-commands.ts` excluded `todos` and `cost` on the grounds that both read
state a client already receives on the event stream, and that a verb duplicating
an event feed would be a second, drifting source. That argument is still right,
and no `cost` verb was added.

What changed is which question the list answers. "Can a client carry this
command out" is not "is there a verb named after it": `openSession` subscribes a
connection to the session's events, `turnEnd` carries the usage and the price,
and a client folding those has everything `/cost` shows. So the command is
listed and `REMOTE_BUILT_IN_COMMAND_VERBS` names `openSession` for it — the verb
that makes the data reachable. That widened the map's meaning slightly from
"invoked by" to "answered by", which is why `serve-commands.ts`'s refusal
sentence now reads "on this wire it is answered by …" rather than "run it with
…": "run it with openSession" would be advice nobody could follow.

`todos` stayed out, and for the *other* half of the rule rather than the same
one. Its data is equally reachable (`todoUpdate`), but a built-in earns a menu
entry by naming something a client can then **do**, and the only client with a
`/` menu — the VS Code panel — renders todos continuously in its plan card.
There is no surface for `/todos` to open, so the row would do nothing when
chosen. It goes in the day a client grows somewhere for it to lead; that is a
one-line change in two files.

## The dry-run review verbs are session-scoped over a server-scoped shadow tree

`pendingChanges`, `applyChanges` and `discardChanges` all take a `sessionId`, and the thing
they act on is not per-session at all. `--dry-run` is a flag on the served **process**:
`buildRuntime` creates one `Overlay` rooted at the served workspace, and every agent
`buildSessionAgent` mints gets the same overlay-wrapped tool set. Two sessions on one
`arcturn serve` write into one shadow tree, and an apply asked for by either of them lands
whatever both of them wrote.

The `sessionId` is kept anyway, for two reasons that are not decoration. It is what makes
`sessionNotFound` answerable, matching every other session-scoped verb; and it is what the
refusals are phrased against, which is the difference between "a run is in flight" and "a
run is in flight *in session X*, which is not the one you are looking at".

The consequence is `#requireIdleWorkspace`, which is **wider** than
`setPermissionMode`'s busy check on purpose. A permission mode belongs to one agent, so
that check reads one agent's `isRunning`. A shadow tree belongs to the process, so "is it
safe to write this tree back to disk" is not a question one session's `isRunning` can
answer, and the check walks every live session. The message names which one is busy so the
answer is actionable rather than mysterious.

If the runtime ever grows a per-session overlay — which it would need to for two clients to
review independently — this is the paragraph that has to change, and the check narrows.

## `DryRunOverlay` is a structural interface, not an import

`@arcturn/server` does not depend on `@arcturn/cli`, and the applier this feature must use
lives there: `Overlay.apply` is the function the TUI's `/apply` drives, with the
temp-file-plus-rename and the per-file symlink resolution that keeps a write from landing
outside the workspace. Reimplementing any of that here would have been a second applier,
which is a second place for the symlink check to be forgotten — and the difference would
only ever show up on somebody's disk.

So `dry-run.ts` declares the smallest structural interface a real `Overlay` satisfies with
no adapter (`cwd`, `changes`, `apply`, `discard`) and `createServeHost` passes
`runtime.overlay` straight in. `redirect` and `materialize` are deliberately not on it —
they are the tool-wrapping half and have no business on a review surface — and neither is
`diff`, because the wire carries content rather than a rendering.

The same injection shape `contextResolver` and `modelCatalog` use, for the same reason, and
with the same one-injection rule: all three verbs read this single reference, because a
list built from one overlay and an apply run against another would land changes nobody
reviewed.

## `pendingChanges` answers where the others refuse

An engine with no overlay is not an error condition for `pendingChanges` — it answers
`{ dryRun: false, changes: [] }`. `applyChanges` and `discardChanges` on the same engine
refuse with `invalidRequest`.

The asymmetry is the shape of the question. `pendingChanges` asks *what is waiting*, and
"nothing is ever held back here, your edits already landed" is a true, useful and quite
different answer from "nothing is waiting yet" — a client that cannot tell those apart will
tell one group of users the reassuring one. Apply and discard are commands, and a command
with nothing to command is refused.

It also keeps the read cheap enough for a panel to poll on load without an error path.

## Why the list carries no content, and why an oversized file is withheld rather than cut

`SESSION_HISTORY_MAX_BYTES` set the precedent: 1 MiB, which is `ws-server.ts`'s own
`DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` and a quarter of the 4 MiB frame cap. A response
answering the client's own request is essential traffic and is never dropped by the
backpressure policy, which is exactly why it must not be the frame that wedges the socket.

A hundred-file refactor's patches are megabytes. A hundred-file *listing* is about twenty
kilobytes. So the list is bounded metadata and the bytes are fetched one file at a time,
which is also the only granularity a diff editor ever renders.

Where this deliberately diverges from `sessionHistory` is the oversized single file.
Dropping the oldest events from a transcript leaves every surviving event true; half a file
rendered in a diff editor is a false account of the change, and a reviewer would approve
it. So the content is withheld, `contentOmitted: true` says it was, and the client tells
the user to review that one in a terminal.

## There is no `before` on the wire, and that is a correctness choice

The obvious payload for a review is `{ before, after }`. It is wrong here, because
`Overlay.apply` writes `after` over the real file **whole** — it does not apply a patch
against a snapshot — and `bash` is not wrapped by the overlay, so the real tree can change
under a dry run.

That makes the honest left-hand side of "what will this file become" *the file as it stands
at apply time*, not a snapshot the engine took when the client happened to ask. A `before`
on the wire would let a client render a diff against one thing while the engine applied
against another, and the gap between them is exactly where an unreviewed change hides. The
VS Code panel therefore diffs a `file:` URI (live) against the engine's `after` (fixed),
and the wire is half the size for it.

## `rewindTo` is the one destructive verb with a wire-level confirmation

`deleteSession` set the discipline and `discardChanges` kept it: no two-phase token. The
confirmation belongs where a person can read what they are losing — a native modal in the
client — and a handshake would be state the engine had to keep, expire and evict.

`rewindTo` takes one anyway, and the difference is not "it is more dangerous". It is that
**its parameters do not name what it destroys.** A `deleteSession` names its session; a
`discardChanges` selection names its files, spelled as the engine just listed them. A
`rewindTo` names an opaque turn id, and the files it deletes are derived from a manifest
that grows with every turn — so a client that rendered "this deletes 2 files", let a run
append three more, and then sent the id would rewind something nobody was shown.

So `CheckpointEntry.confirmation` is a **digest of the plan**, not a nonce. `checkpointConfirmation`
hashes the sorted, workspace-relative restore and delete sets plus whether the conversation
forks; `rewindTo` recomputes it and compares. No server state, nothing to expire, nothing to
evict — which is why it can be *required* without becoming the handshake `deleteSession`
refused. It is a drift detector, not a capability: a client already holding the serve token
can call `listCheckpoints` for any confirmation it likes, so collision resistance is the only
property that has to hold, and 128 bits is generous for that.

## The busy check is `deleteSession`'s, not `applyChanges`'

`applyChanges` widened its refusal to *every* live session because `--dry-run` is a flag on
the process: one shadow tree, shared, so no single session's `isRunning` can answer "is it
safe to write this tree back".

A checkpoint store is not shared. There is one per session, rooted at that session's own
working directory, so `rewindTo` refuses on `isBusy(session)` — the wider-than-`isRunning`
check that also covers a prompt still resolving its context, which is `deleteSession`'s and
`compact`'s. What two served sessions genuinely share is the workspace, and they already
write it concurrently through ordinary tool calls; that is a property of running two agents
in one directory rather than something this verb introduces.

## A fork swaps the agent and keeps the observers

`SessionHost.#swapAgent` is the second door into a live session's identity, and it exists
only for this verb. It moves the two things a session *is* — the event subscription that
fans out to observers, and the permission requester — onto the forked agent, and leaves the
observers themselves in place: a rewind is not a delete, the same connections are still
attached to the same session id, and dropping their subscriptions would silently stop the
transcript they are watching. What they get instead is a `notice` before any new event can
arrive, so a client that was not the one asking learns the conversation moved.

`#permissionRequester` was factored out of `#register` for this: a requester built in two
places is a requester that can be built two ways.

## `sessionHistory` replays the *live agent's* branch

`projectSessionEvents` walked to the newest appended entry, which is right for a session
read off disk and wrong for the moments right after a fork: `rewindTo` resumes an agent at
an older entry and **writes nothing**, so until that agent's next turn the newest entry in
the file is the tip of the branch the fork just walked away from. Replaying that would hand
a client the pre-rewind conversation and call it the transcript — a `rewindTo` that moved
the files and silently did not move the transcript.

So `buildSessionHistory` takes an optional leaf and `SessionHost.sessionHistory` passes
`live.agent.leafEntryId` when the session is live. That is what the function's own doc
already promised ("only the active branch is replayed"); it just was not true for the one
case that creates an inactive branch.

## Delegation: `/bg` is a registry, `/team` and `/scout` are not — and that decided it

`background-agents.ts` and `org-memory.ts` are projections over injected managers, the
shape `dry-run.ts` established. What is worth writing down is why only two of the four
delegation surfaces got one.

**`/bg` had everything a verb needs.** A durable record per agent, written atomically, with
a status, a cost and a task on it; a `list`/`get`/`cancel`/`transcript` API on a manager
that is already memoized per runtime; and a spawn path whose defaults *are* the caps. That
last part is what made `startBackgroundAgent` safe to expose at all: the wire narrows the
manager's `start(options)` to `start(task)` at the `BackgroundAgentRegistry` seam, so a
remote caller cannot widen the tool set, the permission mode, the working directory or the
model, because the type has nowhere to put them. The cap is not a promise in a comment; it
is the absence of a parameter, and `delegation-wire.test.ts` proves it on the filesystem.

**`/team` had two blockers, neither of them protocol-shaped.**

1. `TeamManager`'s constructor rewrites every record still `"running"` to `"interrupted"`,
   on the (correct, for a terminal) assumption that a fresh manager is a fresh process.
   `arcturn serve` breaks that assumption, so a "read-only" `teamStatus` verb would mark
   another live process's team dead on its first call. There is no read that is actually a
   read until a record carries an owner lease. **Fixed** in `ecb8836` and extended
   here: `ownerPid` plus a renewed `ownerHeartbeatAt` in `BackgroundAgentManager`.
   A second manager leaves a live owner's record alone, and a record whose owner
   crashed — or whose pid was reused — goes stale within a minute.
2. `merge` and `discard` write to the user's checkout (`git apply`; deleting the patch that
   is the only copy of a member's work) and neither refuses mid-run. Every write verb here
   answers `sessionBusy` rather than racing; there is nothing to answer with until the
   manager can be asked whether a team is still going.

**`/scout` has no durable state at all** — worktrees are destroyed in a `finally` and the
report is printed text — so there is nothing to list and nothing to cancel. A start verb
would block for minutes and be unreportable, which is the verb shape this package refuses.

`built-in-commands.ts` records the same three decisions next to the menu they govern.

## The one hazard `/bg` inherits, stated plainly

A background-agent manager corrects a `"running"` record to `"interrupted"` at load, for
the same process-assumption reason `TeamManager` does. `arcturn serve` constructing one at
startup is therefore a third process adopting the directory: a terminal's live `/bg` can be
reported `interrupted` until its owning manager next persists it. It self-heals, the
terminal's own view is never wrong, and it is not new — two terminals already do it — but
`arcturn serve` makes it reachable more often. The fix was an owner lease in the record,
and it has since been built: see `background-agents.ts`'s `ownerPid` and
`ownerHeartbeatAt`. What follows describes the problem as it stood.
in `@arcturn/cli`, not here.

## Why an unknown background-agent id is an empty list rather than a refusal

Because `backgroundAgents` degrades. `isUnsupportedMethodError` reads *every* server-sent
`invalidRequest` as "this peer is older than the verb", because that is the only thing the
wire can tell it — so an engine that refused a mistyped id would make a client hide its
whole background-agent surface. `pendingChanges` keeps the same discipline by answering
`dryRun: false` instead of erroring on a read. `cancelBackgroundAgent` and
`adoptBackgroundAgent` *do* refuse an unknown id, and may, because neither degrades.

## Workflows: an injection, not an implementation

`listWorkflows`, `runWorkflow`, `workflowStatus` and `resumeWorkflow` are answered by a
`WorkflowService` this package defines (`workflows.ts`) and `@arcturn/cli` implements
(`serve-workflows.ts`), on exactly the terms `dryRunOverlay` and `mcpStatus` are injected.

The reason is stronger here than for either of those. The workflow engine is 7,000 lines
of `@arcturn/cli`: a strict parser, a lane classifier that reads a role's declared
`tools:`, a stage loop with a per-step deadline and a run-scope budget, a seeded-worktree
write lane, and an append-only run journal under `~/.arcturn/workflow-runs`. A second
implementation living behind the socket would parse the same file differently, derive a
different lane for the same role, and write a second journal into the same directory — and
a panel would then be showing a pipeline the terminal has never run.

One injection, four verbs, and it stays one for the reason `createServeHost` records after
the `resolveModel`/`modelCatalog` pair drifted apart: a catalog built from one workflow
root and a run started against another would run a pipeline nobody was shown.

## `runWorkflow` answers on acceptance, and that is not fire-and-forget

`SessionHost.prompt` awaits the whole run, and `ws-server.ts` awaits it in turn, so
`prompt`'s response arrives when the run ends. That is right for one turn and wrong for a
pipeline: `stepTimeoutMs` alone defaults to ten minutes *per step*, and
`ProtocolClient`'s own request deadline defaults to 30 seconds. A `runWorkflow` shaped
like `prompt` would hand every default-configured client a `ProtocolTimeoutError` for a
run that is spending money perfectly happily — a worse lie than the one the
non-degradability rule exists to prevent, because it reports failure for work that is
succeeding.

So the verb answers with a `WorkflowRunHandle` as soon as the engine has accepted the run,
and the outcome rides the session's event stream. The two halves of "is this honest" are
kept separately: the verb is **not degradable** (an older engine's `invalidRequest`
rejects, so nobody is told "started" by an engine that ignored them), and the run id in the
handle names a directory the implementation writes a manifest into *before* the response
goes out, so "started" is a claim the client can go and check.

`AcceptedWorkflowRun.settled` exists for one thing only, and it is not a second answer to
"what happened": it tells this host when the session is free to start another pipeline.
Without it, one finished run would leave `#workflowRuns` holding a controller forever and
the session would answer `sessionBusy` to every later `runWorkflow` — a session wedged by a
pipeline that ended an hour ago.

## The busy check is about the transcript, not about corruption

`runWorkflow` and `resumeWorkflow` refuse with `sessionBusy` when the session is mid-turn
**or** already running a pipeline. A workflow's steps are their own agents, so nothing
would actually corrupt; what would break is legibility. That session's event stream is the
only place either run is visible, and two pipelines narrating into one transcript is a
transcript nobody can read. The refusal hands a client something to do — wait, or open a
second session — rather than producing a mess it cannot untangle afterwards.

`deleteSession` refuses for a session with a run in flight for a sharper reason: one of its
steps may be applying a patch to the user's checkout at that moment, and deleting the
session would silence the only stream reporting it.

`abort` cancels both halves, and `dispose`/`#evict` sweep every controller. A Stop button
that only reached the session's own agent while a pipeline kept spending would be the worst
kind of unresponsive.

## `#workflowRuns` is on the host, not on `LiveSession`

A run is scoped to one session but is not part of what a session *is*, and the map answers
two questions that live at the host: "may this session start another pipeline" and "what
does `abort` on this session have to cancel besides the agent's turn". Keeping it here also
meant `LiveSession` — a shape three concurrent workstreams were editing — did not have to
grow a field.

## Why an unknown run id is an empty list rather than a refusal

The same trap `/bg` fell into, found the same way: `isUnsupportedMethodError` treats *any*
`invalidRequest` as "this engine does not know the verb", and
`ProtocolClient.workflowStatus` degrades on it. A read that refused in-band would therefore
be collapsed to `undefined` by every client, making "no such run here" and "this engine is
too old" one piece of news. Zero rows for a *named* run is unambiguous on its own — only
the listing form can legitimately be empty — and it is the rule `pendingChanges` already
keeps by answering `dryRun: false` instead of erroring.

The first version of this verb refused, and the wire test caught it: `workflowStatus`
resolved `undefined` for a run id the engine had never heard of.
