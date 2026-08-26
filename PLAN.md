# Arcturn (✦) — Master Plan

> Every turn counts. A production-grade agent harness: everything the minimal
> harnesses do, plus everything they chose not to build.

## Positioning

Minimal agent harnesses deliberately leave out MCP, sub-agents, permission
popups, plan mode, to-dos and background bash. Arcturn ships all of those as
first-class features while keeping the minimal-harness virtues: a small
event-driven runtime, provider-agnostic AI layer, tree-structured sessions, and
TypeScript extensibility.

**Differentiators**

1. **MCP client built in** — stdio + streamable-HTTP servers, tool/resource/prompt discovery.
2. **Sub-agents** — spawn scoped child agents with their own tool sets and budgets.
3. **Permission engine** — rule-based allow/deny/ask with session/project/user scopes.
4. **Plan mode & todos** — structured task state that persists in the session tree.
5. **Background processes** — long-running shell tasks with notification events.
6. **Official provider SDKs** — Anthropic / OpenAI(+compatible) / Google, robust streaming.
7. **Modern website** — Next.js landing + docs, dark/light, world-class design.

## Architecture (pnpm workspace, ESM, TS 5.x, Node ≥ 20)

```
packages/
  types      @arcturn/types      Zero-dep shared contracts: messages, events, tools,
                                   permissions, session tree, protocol schemas.
  ai         @arcturn/ai         Unified LLM layer over official SDKs; streaming,
                                   tool calls, thinking, model catalog, cost tracking.
  core       @arcturn/core       Agent runtime: event loop, steering/abort, session
                                   store (JSONL tree, branching), compaction, hooks,
                                   permission engine, sub-agents. This is the SDK.
  tools      @arcturn/tools      Built-ins: read, write, edit, bash (+background),
                                   grep, glob, ls, fetch, todo.
  mcp        @arcturn/mcp        MCP client integration (official SDK) → Arcturn tools.
  tui        @arcturn/tui        Terminal UI lib: differential renderer, components,
                                   markdown, input editor, autocomplete.
  protocol   @arcturn/protocol   JSON-RPC style wire protocol for server mode.
  server     @arcturn/server     WebSocket/HTTP server exposing sessions remotely.
  cli        arcturn (bin: arcturn)  Interactive coding agent: TUI app, print/JSON modes,
                                   extensions, skills, themes, config, plan mode.
web/                               Next.js + Tailwind landing page + docs.
```

Dependency flow: `types ← {ai, tools, mcp, tui, protocol}`; `core ← {types, ai}`;
`server ← {protocol, core}`; `cli ← everything`.

## Delivery phases

- **P0 (orchestrator)** — scaffold, configs, CI, contracts package (`types`). ✅ this doc
- **P1 (parallel)** — `ai` (opus), `core` (opus), `tui` (opus), `tools` (sonnet),
  `mcp` (sonnet), `protocol` (sonnet). All code against `types` contracts.
- **P2** — `cli` (opus) integrating core+tui+tools+mcp; `server` (sonnet).
- **P3** — website (sonnet), docs, README, integration tests, polish, release scripts.

Orchestrator (Fable) plans, reviews, integrates, and runs builds/tests between phases.

## Engineering standards

- ESM only, `NodeNext` resolution, strict TS, no `any` in public APIs.
- Vitest for tests; every package ships unit tests. Biome for lint/format.
- Apache-2.0, author Sitharaj Seenivasan. No AI co-author trailers in commits.
- GitHub Actions CI: install → build → check → test on Node 20/22.

## Status

All eleven packages and the website are built, tested and committed. As of
2026-08-23 the suite is 204 files / 3,847 tests, clean build + lint on Node
20/22 CI across Linux, macOS and Windows.

**Feature parity wave (2026-08-18).** Twelve features closing the gap analysis
against Claude Code / OpenCode, built by parallel sub-agents and
integrated centrally: lifecycle hooks with preToolUse veto (`hooks` config
key), file checkpoints + `/rewind` (restore files, fork the conversation),
@-file mentions with image attachment, markdown skills
(`~/.arcturn/skills`, `.arcturn/skills`), `websearch` tool (Brave/DDG), opt-in bash
sandbox (`sandbox: "workspace-write"`, sandbox-exec/bwrap), LSP diagnostics
after edits (`lsp: "on"`), live model catalog + `/model refresh`, `/export`
(markdown/HTML transcripts), custom theme files + `/theme`, git branch in the
status bar, `arcturn completions <shell>`, and stdin for `-p`. Docs pages added
for all of it.

**Adversarial review of the new seams (2026-08-18).** Three parallel reviewers
(security, correctness, UX) confirmed nine real defects, all fixed with
regression tests that were each verified to fail against the previous
behaviour: sub-agent writes bypassed checkpointing; `restore()` had no path
confinement; `@`-mentions could escape the workspace through a symlink and
buffered arbitrarily large files before capping; `sandbox: "workspace-write"`
was silently foreground-only (background bash now refuses rather than running
unsandboxed); `/rewind` lacked the in-flight-run guard its sibling commands
have; steering dropped `@`-mention/image expansion; transcript export could
misattribute a result when a tool-call id repeated; concurrent `/model refresh`
calls could drop a preset from the cache; and `--print` rejected piped stdin
before ever reading it (the parser now distinguishes a piped stdin from a
terminal). Print mode also expands mentions now, and the `@` dropdown closes on
an exact match so the first Enter submits.

**Provider coverage (complete).** Nine registered adapters — anthropic, openai,
openai-responses, google, bedrock, vertex, azure, openai-compatible,
anthropic-compatible — plus 35 named presets. This closes the gap against the reference harness's 47 provider
modules, which collapse onto ten wire protocols: Arcturn implements the three that
cover ~38 of them, adds the three enterprise clouds, and reaches the rest through
the two compatible-endpoint adapters.

An adversarial review of the cross-package seams found ten real defects (seven of
them permission-enforcement bypasses); all are fixed with regression tests that were
each verified to fail against the previous behaviour. See commit
"Fix ten security and correctness defects found in adversarial review".

**Innovation wave (2026-08-19).** Fifteen features built by parallel sub-agents and
integrated centrally, taking arcturn past parity into capabilities no other harness ships:

- *Safety*: dry-run overlay (`--dry-run`, `/diff` `/apply` `/discard` — mutations land in a
  shadow tree until approved), prompt-injection taint tracking (`taint: warn|confirm|deny`
  — a mutating call echoing fetched content is flagged, confirmed or refused), cost guard
  (`--max-cost`, `/cost limit`), audit receipts (`audit: true`, `arcturn audit`).
- *Capability*: provider failover chains (`model: [primary, fallback]`, switching mid-run
  but only before tokens stream), markdown sub-agents (`.arcturn/agents/*.md`), project memory
  (a `memory` tool writing `.arcturn/memory/`, reloaded into the next session's prompt), the
  `symbols` tool (LSP document/workspace symbols), model router (cheap models for
  sub-agents and compaction), verify loop (tests run after edits, failures fed back).
- *Reach*: `arcturn serve` finally wires the dormant server+protocol packages to the CLI
  (token auth, non-loopback binds refused without one), a protocol client for `arcturn attach`,
  `arcturn replay` (re-run a session on another model and diff behaviour), and inline terminal
  images (kitty/iTerm graphics).

`ArcturnRuntime.buildSessionAgent()` was added so each served session gets its own checkpoint
store — without it two concurrent sessions shared one and `/rewind` could restore another
session's files.

**Adversarial review of the innovation wave (2026-08-19).** Two reviewers (security,
correctness) confirmed 17 real defects, every one fixed with a regression test verified to
fail against the previous behaviour. The security half: `/apply` could write outside the
workspace through an in-workspace symlink; served sessions and sub-agents both escaped the
audit trail entirely; the WebSocket upgrade had no `Origin` check, so any web page could
drive a loopback `arcturn serve`; `SessionHost.createSession` took the client's `cwd`
unvalidated (which also escaped `--dry-run`); the `memory` tool was neither a taint sink
nor overlay-aware, making a one-shot injection permanent; and taint missed both
`bash curl` laundering and scheme-less exfil hosts. The correctness half: `/cost limit`
was silently inert (a destructured getter, plus no guard at all when no ceiling was set
at startup), abort notices went to a channel drained once at startup, `/model` left the
router's cached routes stale, the audit log was pinned to the first session id, failover
billed the chain head's price rather than the answering model's, checkpoints snapshotted
files a `preToolUse` hook had denied, and `blockEnd` prematurely committed a failover
attempt.

**Innovation wave (2026-08-19).** Ten features no other harness ships, built by parallel
sub-agents and integrated centrally:

- *Debugging*: VCR deterministic record/replay (byte-identical, no provider/network/fs),
  `arcturn bisect` (binary-searches a session for the turn behaviour diverged), `arcturn blame`
  (which turn and what evidence produced each line).
- *Safety*: speculative approval (work continues in a shadow while a prompt is open;
  fails closed, and discards rather than misattributes when prompts overlap), canary
  exfiltration detection (exact match on user-registered secrets = proof, not heuristic),
  `/permissions suggest` (repeated decisions become a proposed rule, never auto-applied).
- *Economics*: `/cost preview` (ranges from your own history; refuses to price unpriced
  models), consensus panels (model disagreement as the signal for where a human should
  look), each member billed at its own rate.
- *Exploration*: `/scout A | B` (parallel throwaway worktrees), semantic `/rewind <query>`
  (refuses to jump when ambiguous).

**Adversarial review (2026-08-19, two reviewers, 24 defects — all fixed with regression
tests verified to fail first).** The sharpest findings were features that were *present but
unreachable*: the canary guard watched a generated token nobody had ever seen (now watches
user-registered values, with a warning when none are configured), and speculation could
never shelter a byte because arcturn ran tools sequentially (parallel execution is now enabled
with it). Security fixes: MCP tools bypassed the speculation and canary wraps entirely; a
manifest blob id was an arbitrary-file-read primitive in `arcturn blame`; provenance filed the
new session's records under the outgoing session id; scouts escaped their worktree through
the `memory` tool; sub-agents skipped the outermost replay wrapper and inverted the
hooks/checkpoints order; replay ran the user's real lifecycle hooks (there is now a
first-class `replay` mode); permission request ids collided within a millisecond;
`.env`-shaped paths were persisted verbatim. Accounting fixes: consensus and sub-agent
spend were invisible to `--max-cost`, and the panel multiplier billed sampled-out turns.

**Workflows and agent organizations (2026-08-20 → 08-23).** A numbered markdown
file is now a multi-stage pipeline, and each step can be dispatched to a named
markdown role with its own model, tools and turn ceiling. The design problem was
never orchestration; it was authority. Three dispatch lanes solve it, derived
from the tools a role declares rather than from what its description claims:
`read` (no worktree), `exec` (isolated worktree, diff *always* discarded) and
`write` (isolated worktree, diff captured and applied). That distinction came
out of a live failure — four roles declared `writes: none` and had their diffs
auto-applied anyway, because `bash` is a write primitive wearing a read costume.
Worktrees are seeded from the run's starting commit with every already-applied
patch replayed in, so a reviewer reads what the pipeline produced rather than
untouched HEAD; before that, reviewers were verifying code that did not contain
the change. Confinement is enforced by permission rules where deny beats `yolo`,
not by prompt. A runnable ten-role, six-pipeline kit ships in
`examples/enterprise-org/`, and RFC 0001 records the design.

**Reliability layer (2026-08-22 → 08-23).** Every step's outcome is written to a
durable journal before the run advances, which makes `/workflow status` and
`/workflow resume` real: an interrupted run reports the stage it reached, its
turns and its spend, and resuming replays completed steps from the journal
rather than re-executing them — every recorded patch probed with `git apply
--check --reverse` first, because double-apply is the worst outcome in this
threat model. Runs are bounded in both dimensions that actually run away: a
per-step `stepTimeoutMs:` and a per-run `budgetUsd:`. The LLM stall guard is a
per-*event* idle timeout rather than a duration cap, so a slow-but-progressing
stream is never killed while a stalled one is, and a stall is classified as a
network fault so it retries and fails over. A role that hits a genuine ambiguity
emits `ORG-ASK:` and the run pauses for a human answer instead of guessing or
failing; `ORG-HALT:` remains the fatal form.

**Cross-platform (2026-08-21, corrected 2026-08-23).** Windows is a supported
target. The original entry here claimed "verified in CI rather than assumed" —
which was false, because the repository had never been pushed and CI had never
run. The first real run (2026-08-23) failed 54 Windows tests and 1 macOS test,
and the failures decomposed into ten real platform bugs, a set of tests that
assumed POSIX, and environment artefacts (git autocrlf, EBUSY teardown). The
bugs included: grep/glob handing the model host-separator paths that round-trip
as broken JSON (`"src\new.ts"` is valid JSON containing a newline); the
`/dev/null` carve-out missing on Windows so the bash wall refused the commonest
redirect there is; the toolchain-path exemption not existing at all on Windows;
LSP servers unspawnable because npm installs them as `.cmd` shims CreateProcess
cannot execute; Win32 trailing-dot stripping walking a path past the `.arcturn`
zone wall; and a case-sensitive grep filter that disclosed `.ARCTURN/**`
contents on any case-folding volume — that last one live on macOS too. All
fixed; the matrix referees what a macOS machine can only simulate. The lesson
is the same one the provider table taught: "verified" is a word for things that
have actually run. Windows specifics: shell resolution is platform-aware, path comparison
normalizes separators, and permission path matching folds case on
case-insensitive filesystems — probed at runtime, not inferred from the platform
name. That last one was a live security bug: `.ENV` walked straight past a
`**/.env` deny rule on macOS.

**Website rebuilt (2026-08-20).** The Astro site was retired and replaced with
Next.js 16 + Tailwind v4, static-exported to 41 docs pages and a product front
end. Full light/dark theming landed in the CLI at the same time, including the
terminal canvas itself via OSC 11 — the background is owned by the theme rather
than inherited from whatever the emulator happened to be set to.

## Remaining follow-ups

**Closed (2026-08-26): the read side of the symlink door.** `loop.ts` no longer
matches rules against a lexical subject. It awaits `resolveSubject`
(`packages/core/src/permissions.ts`), which routes a path argument through
core's own `resolveSubjectPath` (`packages/core/src/subject-path.ts`) — the
same "rewrite exactly the case that lies" semantics the tools already use for
`write`/`edit`, duplicated rather than imported because core and tools are
siblings and neither dependency edge is worth one function. The two copies are
held to byte-identical answers by a conformance test in
`packages/cli/src/symlink-subject.security.test.ts`, which also proves the
bytes: `deny read <secrets>/**` now refuses `read("keys/id_rsa")` through a
`keys -> <secrets>` link, and the key does not reach the model. `defaultSubject`
stays synchronous and pure, so `display.ts`, `audit.ts` and `provenance.ts`
still draw a line without touching the filesystem. Resolving a subject *moves*
it, so the pre-resolution spelling is still offered to `deny` rules and to
nothing else (`PermissionCheck.alternateSubjects`): what is refused after this
change is a superset of what was refused before it. Resolution failure degrades
to the lexical subject rather than refusing — a file that does not exist yet is
the normal argument to `write` — and a dangling link is followed by name, so
nothing that actually redirects bytes can fail to resolve. Known limit, tested
and recorded: the subject is canonical, so a rule written against a symlinked
*prefix* (macOS `/var` vs `/private/var`) does not match it — as it did not
before either.

Still open, and the other half of the same audit: a rule wall only ever sees
the argument `defaultSubject` picks, so `grep`'s `glob:` and `glob`'s
`pattern:` choose files nobody checked. That needs the tool to confine its
collected file set to the realpath of the root the subject named — which
reverses a deliberate decision in `walk()`'s doc comment and is the owner's
call to make.

Hooks fail open by design, documented in `hooks.md` and agreed by the code and
its tests: a `preToolUse` hook that exits non-zero, prints garbage or hangs
lets the call through. Every other guarantee in this repo is structural; this
one asks nicely. The shape of a fix is an opt-in `failClosed` per hook rather
than flipping a published contract.


`isUnsupportedMethodError` reads every server-sent `invalidRequest` as "this
peer predates the verb", so a legitimate refusal — an unknown run id, an
unknown background-agent id, a missing exporter — collapses into "the engine
is too old" and a client hides a whole surface over a typo. Three separate
verbs hit this independently and each worked around it by answering an empty
result instead of refusing. That is the right per-verb answer, but the shared
predicate is the defect: it needs a distinguishable code (or an error field)
so a refusal and an absence stop being one piece of news.

Delegation, left unexposed deliberately and needing CLI work first:
`/scout` has no durable record at all, so there is nothing to list or cancel.
`/bg` spend is not folded into `--max-cost`.

**Narrowed (2026-08-26): the cross-process ownership gap is closed.** A team
and a background-agent record now carry `ownerPid`, and both `#load`
implementations leave a record alone when that pid is still alive
(`process-liveness.ts`). This was worse than a mislabel: `TeamManager#load`
also set `needsRecovery`, and `recover()` — awaited by `start`, `merge` and
`discard` — captures each worktree's diff and then *deletes* it, so a serve
process merely constructing a manager beside a terminal could tear down the
live team's worktrees mid-edit. A record with no pid (written by an older
build) still reads as "gone", which is the old behaviour and correct for the
case it was always right about. What remains: this is an ownership *stamp*,
not a lease — nothing renews it, so a dead owner whose pid the OS has reused
leaves its worktrees un-recovered until that number frees up (a leak, where
the old behaviour was a deletion), and there is still no mid-run guard
stopping the *owning* process's own `merge`/`discard` from racing a member
that is still writing. Cross-process *cancellation* is also still absent: a
serve process cannot cancel a terminal's live background agent, because
`cancel()` needs the in-process `AbortController` the owner holds. It now
returns `false` for the right reason rather than because the record was
silently relabelled.

A workflow step's permission asks go to the runtime's requester rather than
the calling session's, and `arcturn serve` installs none, so they fail closed.
Routing them would mean holding `setPermissionRequester` for a whole run — a
process-wide mutation racing every other hosted session — so it is recorded
rather than half-fixed.


**Narrowed (2026-08-26).** The core resolver now exists:
`Agent.resume` takes an optional `resolveModel(id)` and applies `state.model`
through it, and `ArcturnRuntime.resumeSession` passes the catalog plus adopts
the model onto the runtime itself (so the compaction budget and the cost
readout agree with the provider that answers). An explicit `--model` still
wins — `runtime.modelPinned`. `--continue`, `--resume` and `/sessions` are
all fixed. What remains is **`arcturn serve` only**: `openSession` builds its
agent through `buildSessionAgent`, not `Agent.resume`, so a re-attached served
session is still a silent model change. The fix is to route the same
`#adoptStoredModel` read into the session-agent path — but a served runtime
hosts many sessions off one `runtime.model`, so it cannot simply assign to it
the way the single-session terminal does; the model has to travel on the
session agent instead. Recorded rather than half-fixed for that reason.

Two hazards in `/rewind`'s coverage, characterised while writing the
round-trip suite and deliberately not fixed:

- Only `write` and `edit` are wrapped (`CHECKPOINTED_TOOL_NAMES`), so a
  `bash`-driven mutation — `mv`, `rm`, `sed -i`, a build script — is invisible
  to the manifest. The bad case is not "the rewind misses it": it is that a
  rewind can *destroy* data it never captured. Agent writes `b.txt` (recorded
  absent) and then `mv a.txt b.txt`; a rewind deletes `b.txt` because the
  manifest says it never existed, and `a.txt` was never snapshotted, so both
  are gone. Catching it needs either a snapshot hook on `bash` (which cannot
  know the paths in advance) or a pre-turn worktree diff.
- `entries()` on a session with an unparsable line anywhere except the last
  throws for the WHOLE session, so a single garbled byte mid-file costs every
  message ever stored in it. The torn-write case that used to reach this is
  fixed (`#prepareAppend` drops a torn tail before appending, so a partial
  write can no longer be demoted to mid-file corruption), but genuine
  corruption still has no partial-read path. An honest reader would surface
  the entries it *could* parse alongside a count of the ones it could not,
  which is a `SessionStore` interface change and so is recorded here.

Two live agents on one session id — `arcturn serve` and a terminal, reachable
today — silently fork it. Each holds its own in-memory branch tip, so their
appends become sibling branches off the node they last shared, and a default
resume follows the *last appended* entry: whichever process wrote most
recently owns the whole history and the other's turns become an unreachable
branch. Nothing warns, in either process. The bytes are safe — `O_APPEND`
keeps whole lines whole, proved by a 24-way concurrent append test — so this
is purely a tip-ownership problem, and the fix is an owner lease on the
session file (the same shape `/team` needs, per the delegation note above)
rather than anything in the writer. Pinned by
`session/round-trip.test.ts` → "silently forks when two live agents append
from the same tip", which asserts today's exact behaviour so a fix has
something to turn red.


Engine gaps surfaced by the VS Code extension build (RFC 0004), each routed
around in the extension per the one-engine rule and owed a proper fix here:

- `createSession` over the wire does not subscribe the connection to events
  (`ws-server.ts` attaches the observer only on `openSession`); every client
  must know to call both. Either subscribe on create or document it loudly.
- `arcturn serve` accepts the auth token only on argv (visible in `ps`) and
  echoes it on its own stdout attach hint. Add `--token-fd` or an env var,
  and stop printing the secret the flag exists to protect.

**Done (2026-08-25): the `listModels` protocol verb.** The gap that used to sit
here — "a client cannot render the model catalog without inventing one, so the
extension's picker runs on announced ids plus free text" — is closed. The wire
carries a `listModels` request answering `{ models: [...] }`, one entry per
registered model with id, display name, context window, pricing, the *name* of
its API-key variable and a three-valued `credentials` flag; `arcturn serve`
sources it from the same `modelCatalogEntries()` that `--list-models` prints,
so there is no second list to drift. Two honesty rules are on the wire, not
just in the renderer: an absent `cost` means the price is unknown and not
`$0`, and `credentials: "unknown"` ("the server cannot tell" — ambient AWS or
Google credentials, or a keyless local endpoint) is distinct from `"absent"`.
The key value itself never leaves the server. `PROTOCOL_VERSION` stays at `1`:
the verb is additive and optional, an older server rejects it with an ordinary
`invalidRequest` that `ProtocolClient.listModels()` turns into `undefined`, and
the VS Code picker degrades to exactly its old behaviour on that. A bump would
instead have severed every existing pair, since `SessionHeader.version` is
validated as `1` at both ends.

**Done (2026-08-26): line ranges, on the wire and in the mention grammar.** The
gap that used to sit here — "`@file:12-34` line-range mentions: `findMentionTokens`
treats the whole run as a path, so the suffix defeats content injection" — is
closed, together with the reason it mattered. A `file` attachment now carries an
optional `range: { start, end }`, **1-based and inclusive at both ends**, so a
client that knows the user has lines 12–40 selected can say so instead of
sending an 800-line file and hoping; and `@src/auth.ts:12-34` (plus `:12` for
one line, plus the quoted `@"my notes.md":12-34` whose asymmetry this entry
predicted) means exactly the same thing. One convention, two spellings, and
one reader: both hand a `LineRange` to `readContextFile`, so an excerpt
inherits the confinement, the size caps and the truncation marker a whole file
already had. The injected block states that it is an excerpt and which lines it
covers; an `end` past the file is clamped *and reported*, a `start` past it is
refused rather than answered with the file's tail, and the wire rejects only
ranges that cannot mean anything (`start < 1`, `end < start`, a non-integer).
`resolveContext` takes and echoes a `range`, which turns the probe
`ProtocolClient.prompt` already ran into a capability check — so an engine that
would drop the field and send the whole file is caught locally, at no extra
round trip. `PROTOCOL_VERSION` stays at `1` on `listModels`' terms.

Contracts v2 (from packages/ai/NOTES.md): optional thinking `signature` on StreamEvent
and ToolCallContent — needed for full reasoning continuity on Gemini tool turns and to
avoid the internal-event workaround; a `contextOverflow` AIError kind so the runtime can
route overflow to compaction instead of treating it as an invalid request; a
reasoning-token field on Usage.

Other: `closeSession`
on SessionHost so long-lived servers release agents (packages/server); serialize
`JsonlSessionStore.setTitle` through the write queue; compaction options are fixed at
construction, so `/model` keeps the previous budget until `/clear`; surface MCP
resources and prompts as CLI @-mentions; stdin input for `-p`.

**Published (2026-08-23).** arcturn@0.1.0 and its nine workspace packages are
live on npm under the `arcturn` org, shipped by the manual-dispatch release
workflow with provenance attestation after a six-leg green matrix. npm's
automated review held `@arcturn/ai` and `@arcturn/core` for roughly forty
minutes after the upload — the other eight served immediately — and a
clean-prefix install test (`npm install -g arcturn`, then a real tool-calling
session through the published binary) passed once the hold cleared. Still not
done: standalone binaries.

**First live-provider run: done (2026-08-18).** Arcturn completed real multi-turn sessions
against Z.AI's GLM-4.6 through the `zai-api` preset — including a tool-calling run where
the model invoked `read`, received the result, and answered from it (`runEnd: completed`,
two turns, real token usage including cache reads). This validates the OpenAI-compatible
streaming path end to end: SSE parsing, tool-call assembly, tool execution, result
feedback, and the second turn.

**First-party adapters proven (2026-08-23).** One live run per provider family, each
covering streaming, a tool call whose result is fed back and answered on a second turn,
and cost accounting checked against the published rates. Anthropic on Claude Haiku 4.5,
Google on Gemini 3.5 Flash Lite, OpenAI on GPT-5 nano through *both* surfaces — Chat
Completions and the Responses API. Total spend under two cents.

All three found a bug no test suite had. Anthropic's: `--print` read stdin to EOF whenever
it was not a TTY, so an inherited pipe — every CI runner, Makefile and `spawn()` — hung
forever, before emitting a single event. Google's: Gemini signs the tool *call*, not only
the thinking that led to it, and rejects the follow-up turn with a 400 without the
signature back, so multi-turn tool use had never once completed. This repo had filed that
under "Contracts v2 · reasoning continuity" as a fidelity nicety; it was a total feature
failure. OpenAI's: the Responses adapter was registered, documented and unit-tested, and
had no catalog entries, so `--model openai-responses/...` answered `Unknown model` — 929
lines nobody could select.

The lesson is worth keeping: all three were reachable only by talking to a real endpoint,
and two were in features the docs advertised as working.

The `anthropic-compatible` adapter was verified the same way, pointed at a canonical
Messages API with the same key: full tool round trip, $0.0014. Each compatibility adapter is
therefore proven against exactly one implementation of its protocol — `openai-compatible`
against Z.AI across 170-odd sessions — which proves the adapter, not any given third-party
service.

Still unproven: Bedrock, Vertex and Azure have never reached their endpoints — each needs a
cloud account (AWS model access, a GCP project with application-default credentials, an
Azure deployment) rather than an API key, which is why they are the ones outstanding. Their
stream translation is partly covered by the runs above (`azure` reuses `openaiEventStream`,
`vertex` reuses both `anthropicEventStream` and `googleEventStream`); `bedrock` shares none
of it and is the largest genuinely untested surface.

**Subscription OAuth: removed, not verified (2026-08-25).** The unverified-endpoint concern
recorded here is resolved by deletion. `arcturn auth login|logout|status` and the `anthropic`,
`openai-codex` and `github-copilot` OAuth provider configurations are gone. They had never
completed a sign-in, and they could not be made to: each needs an OAuth client id the provider
issues to its own product, and the ids in the file belonged to other vendors' tools. Verifying
the endpoints would not have helped. API keys are the supported path for a third-party tool, and
shipping a login that has never succeeded contradicted this project's own honest-limits rule.
MCP OAuth (`arcturn mcp auth`) is unaffected and still works — it uses RFC 8414 discovery and
RFC 7591 dynamic client registration, so it needs no hardcoded endpoint and no borrowed client
id.


## Orchestration follow-ups, characterised not fixed (2026-08-26)

Found while re-testing workflows/teams/scouts/background agents on **effects**
rather than return values (`packages/cli/src/orchestration-effects.test.ts`).
Three defects were fixed with red-first tests — the cross-process ownership
rewrite above, a run's baseline being re-read on resume (which made
`/workflow resume` fail to seed the next worktree for any pipeline whose
earlier stage had written anything), and `stop` journal lines having no writer
at all. What is left is recorded rather than half-done:

- **The `stop` vocabulary is only partly written.** `runWorkflow` now records
  `cost-ceiling` when its `budgetUsd:` ceiling trips, `cancelled` on an
  interrupt and `error` for a step failure that stops the pipeline, so
  `/workflow status` finally renders the `stopped:` line it has always been
  able to read. `repeated-transient` and `deterministic-failure` still have no
  writer: distinguishing them needs the per-step `WorkflowFailureKind` (which
  `createRuntimeRunStep` computes and then drops) carried onto
  `WorkflowStepResult` and back up to the stage loop. `turn-ceiling` and
  `run-deadline` have no writer because they have no *mechanism* — there is a
  per-role `maxTurns` and a per-step `stepTimeoutMs`, but nothing run-level for
  either, so those two members of the union describe a feature that does not
  exist.

- **A team member gets no org memory.** `createRuntimeRunStep` is the single
  injection point (`workflow.ts`), so an approved entry for `@developer`
  reaches that role in a `/workflow` step and not in a `/team` member running
  the same role — `buildMemberPrompt` embeds `brief.role.systemPrompt`
  verbatim and `team.ts` never mentions memory. Wiring it means deciding
  whether a team supervisor's decomposition prompt should see it too, which is
  a design call, not a patch.

- **Nothing proves the production wiring passes `orgMemory`.** The injector is
  now tested end to end — store → `loadOrgMemoryInjector` →
  `createRuntimeRunStep` → the `system` string the provider is actually sent —
  but both production call sites (`createWorkflowCommands`,
  `serve-workflows.ts`) pass the option by hand, and deleting either line would
  leave the suite green. Note also that `createWorkflowCommands` spreads
  `options.step` *after* `orgMemory`, so an embedder passing an explicitly
  `undefined` `orgMemory` key disables memory silently. That precedence is
  consistent with the rest of the escape hatch, so it is written down rather
  than reversed.

- **Cancelling a team member, a scout or a background agent kills no process.**
  All three are in-process agents driven by an `AbortController`; the only OS
  processes any of them spawn are `git`. So "assert the pid is gone" has no
  subject there. It does on the workflow lanes, where a role's `bash` starts
  real detached process groups — that one is now proved by exceeding
  `stepTimeoutMs` and asserting `kill(pid, 0)` fails.
