# Changelog

All notable changes to Arcturn are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Every package in this workspace is released together under one version number.
A change is listed once, under the surface it actually changes for you — the
CLI, the SDK, or the wire protocol.

## [Unreleased]

### Fixed

- **A dry-run permission prompt named a file you have never heard of.** The
  overlay rewrites a tool's `path` to the shadow copy before the tool runs, and
  `write` builds its own permission ask from the path it was handed — so under
  `--dry-run` the dialog read `Overwrite file
  /Users/…/.arcturn/overlays/01H…/src/app.ts`, and the "always allow" it offered
  would have persisted a rule scoped to a directory `/discard` deletes: a grant
  the user was told they made and did not. The ask is now restated in workspace
  terms — subject, description and suggested rule — on its way to the permission
  engine. Rule *enforcement* was never affected: the agent loop checks
  permissions against the raw path before any redirect, which is why a denied
  write never becomes a pending change.

- **`@`-mentions were never expanded on the serve path.** `expandMentions` ran
  in `--print` and the TUI and nowhere else, so a prompt arriving over
  `arcturn serve` was handed to the model verbatim: `@src/auth.ts` reached it as
  six words about a file rather than the file. Every remote client — the VS Code
  panel, `arcturn attach`, the browser page — was silently degraded, and nothing
  caught it because the returned promise resolved and the run completed; only
  the *content* was missing. The served agent now expands mentions against the
  session's `cwd` by calling the same function the TUI calls, not a second one.
  A mention that resolves outside the workspace — lexically, or through a
  symlink that leaves it — is refused rather than read, and the server now emits
  a `notice` saying so, because over the wire a mention that quietly did nothing
  was indistinguishable from one that worked.

- **A skill's arguments could name its substitution tokens.** `$ARGUMENTS` was
  substituted before `$SKILL_DIR` and `$CWD`, and the result was then scanned
  again — so an argument of `$SKILL_DIR/../../etc/passwd` came back with the
  skill folder's real absolute path spliced into it. Harmless enough while the
  only caller was a person typing into their own terminal; RFC 0005 §1.3 makes
  arguments remote-caller text, and remote text that can name substitution
  tokens is an injection channel that also discloses where the skill library
  lives. Expansion is now a single pass: a template's own tokens expand, and
  what they expand to is final. Affects `/name` in the terminal, the
  model-invoked `skill` tool and the serve path alike, since all three share one
  expander.

### Added

- **The dry-run review loop reaches a remote client, and the VS Code panel makes
  it the best thing the product does.** `--dry-run` sends every file edit to a
  shadow copy of the workspace and leaves your real files alone until a person
  has read the change; in a terminal that is `/diff`, then `/apply` or
  `/discard`. None of it was addressable over `arcturn serve`, so a remote client
  attached to a dry-run engine watched an agent that appeared to do nothing at
  all — and the panel's `/` menu could not honestly offer the three commands,
  because no verb carried them.

  **`pendingChanges`** lists what is waiting: per file, its workspace-relative
  path, whether it is added or modified, and its size before and after. The list
  carries **no content**; naming one file fetches the bytes an apply would write.
  That split is a payload decision taken against the 1 MiB bound `sessionHistory`
  established — a hundred-file refactor's patches are megabytes, its listing is
  about twenty kilobytes, and a review response must never be the frame that
  wedges the socket exactly when a reviewer needs it. A single file too large for
  the budget comes back marked `contentOmitted` rather than truncated: half a file
  in a diff editor is a false account of the change, and a reviewer would approve
  it. Read `dryRun` before you read the list — an engine that is not in dry-run
  mode answers `dryRun: false`, which is the opposite news from "nothing pending
  yet" and must not render as the same sentence.

  **`applyChanges`** lands them, and the selection is real: omit the paths to
  apply everything, or name a subset to land three files out of forty. That
  selectivity is a filter on the engine's own list, not a second write path —
  `Overlay.apply` gained an optional path argument and is still the one applier
  the terminal's `/apply` drives, with the same per-file symlink resolution that
  refuses a destination outside the workspace and the same temp-file-plus-rename
  that survives an interrupt. A path the engine did not just list refuses the
  **whole** request rather than applying the rest, which is also the entire
  confinement story for a selection: no client string ever becomes a write
  destination. Applying is not a way around a deny rule either — permissions are
  checked against the tool call's raw path before the overlay redirects anything,
  so a denied write never becomes a pending change.

  **`discardChanges`** throws them away. Irreversible: the shadow tree is the only
  record of that work. It carries no wire-level confirmation, matching
  `deleteSession` — a confirmation belongs where a person can read what they are
  losing, which is a native modal in the client naming the files.

  Both writes are **refused mid-run** with `sessionBusy`, and the check is wider
  than one session on purpose: `--dry-run` is a flag on the served process, so one
  `arcturn serve` has one shadow tree that every session it hosts writes into, and
  a run in flight anywhere on the engine blocks an apply asked for anywhere on it.
  Reading the list is not refused — `/diff` has never had a busy check, and a
  change set you can watch grow is useful rather than dangerous.

  `PROTOCOL_VERSION` stays `1`. `pendingChanges` degrades like `listModels` — it
  reads, so an older engine's refusal costs a client a view and nothing else — and
  the other two reject like `deleteSession`, which is the sharpest case in the
  batch: an apply reported as done that did not happen tells a reviewer their
  change landed while the file says otherwise, and a discard reported as done that
  did not happen leaves them certain their work is gone until the next apply lands
  it.

  **In VS Code**, a card above the composer appears the moment anything is
  pending — on screen rather than behind a command, because a pending change you
  have to remember to look for is one that gets applied unread. Clicking a file
  opens **VS Code's own diff editor**: your workspace file on the left, the
  pending content on the right, read-only. Apply and Discard are explicit buttons,
  discard raises a native modal naming what will be lost, and `/diff`, `/apply`
  and `/discard` now appear in the panel's `/` menu and the command palette,
  running the same controls. The extension never writes a workspace file itself —
  it asks the engine, which is the only version that inherits the symlink refusal
  and the mid-run guard.

- **`/compact`, `/export`, `/mcp` and `/cost` reach a remote client.** The
  terminal has twenty-one slash commands; the wire exposed four, so the VS Code
  panel's `/` menu was almost empty. That was correct — RFC 0005 §1.3 lists only
  what a client can actually run, because a menu offering `/rewind` to a client
  with no rewind verb is a menu that lies — so this makes four more of them
  real rather than listing them anyway.

  **`compact`** drives `Agent.compact()`, the same method the terminal's
  `/compact` and the run loop's automatic threshold call. There is one
  compactor. It answers with a report rather than an acknowledgement — the token
  estimate before and after, and whether anything was folded at all — because a
  client that cannot say how much context it freed cannot tell a compaction that
  worked from one that found nothing old enough. Those two numbers are *quoted
  from the engine's own `compactionEnd` event*, not measured again, so the
  notification and the response that caused it cannot disagree. It is **refused
  mid-run** with `sessionBusy`: compaction rewrites the message array the run
  loop is iterating, so queueing would only move the hazard behind a promise and
  would race the loop's own automatic compaction. Abort, or wait for `runEnd`.

  **`exportSession`** renders the conversation as markdown or HTML and hands it
  back — **the engine writes nothing**. The terminal's `/export` drops a file
  next to the person who ran it; over a socket that would put the document on
  the engine's disk, which is the wrong machine for the person asking and an
  arbitrary-write primitive for anyone holding the serve token. The client
  saves it, and the suggested `filename` is a bare name the protocol client
  refuses if it carries a separator or `..`. Both renderers are the terminal's
  own, injected rather than reimplemented. The payload is bounded at 1 MiB —
  the wire's own backpressure threshold, the same budget `sessionHistory` uses
  — and over the cap the oldest messages are dropped and the document is
  **re-rendered**, so what arrives is a well-formed document rather than one cut
  through a tag, with `truncated` and `droppedMessages` saying so explicitly.

  **`mcpStatus`** reports the configured MCP servers: name, transport, whether
  each is connected, and its tool count. **Names and status only.** An MCP
  config is where a workspace keeps its secrets — a stdio server's `env` and
  `args`, an HTTP server's `url` and `Authorization` header, an OAuth bearer
  token — and none of it is on this wire; nor is a failed server's own error
  text, which is prose an MCP server wrote landing in a menu a person reads. The
  payload is four fields, built by naming them next to the config in
  `@arcturn/cli` and re-validated field by field on the way out of
  `@arcturn/server`, so a field added to the config tomorrow is absent by
  default rather than present until somebody notices.

  **`/cost` gets no verb, and that is the point.** Every figure it shows already
  rides the event stream a client subscribed to with `openSession` — `turnEnd`
  carries the usage and the price — so a verb would be a second, drifting source
  for numbers the client already holds. It is listed as a built-in because the
  question is "can a client carry this out", and one folding `turnEnd` can; in
  the VS Code panel it opens the cost breakdown that was already there.
  `/todos` stayed out: its data is equally reachable, but no client has a
  surface for it to *open* — todos are rendered continuously rather than
  summoned — and a menu row that does nothing when chosen is the thing this list
  exists to prevent.

  `PROTOCOL_VERSION` stays at `1`. `exportSession` and `mcpStatus` degrade like
  `listModels`: both read, so an older server's `invalidRequest` becomes
  `undefined` and a client shows nothing rather than something false. `compact`
  gets `deleteSession`'s treatment instead and **rejects** — a client told
  "fine" by a server that ignored it would report freed context that was never
  freed, keep filling the window, and hit the wall it had just asked to have
  moved.

- **Attachments and `resolveContext` on the wire protocol.** `prompt` takes an
  optional `attachments` array: a `file` becomes a context block headed with its
  path, an `image` becomes a vision block. A `file` is always named by path and
  never carries bytes — a file read by a client is a file the permission engine
  never saw — while inline data is accepted for an `image`, and only an image,
  because a pasted screenshot has no path and was never a workspace file. Every
  path attachment goes through the same workspace confinement a mention does,
  but a refused attachment is fatal rather than advisory: the client named that
  file, so running the turn without it would be the silent drop the feature
  exists to prevent. Total attachment bytes are capped at 1 MiB — the wire's own
  backpressure threshold, a quarter of the frame size above which `ws` closes
  the connection, and the same number `sessionHistory` budgets against.

  A prompt carrying an **image for a model without vision** is refused with the
  reason **before the turn is spent**, checked server-side at prompt time rather
  than trusted to a client that may be hostile, may be old, or may simply be
  looking at a stale catalog. An image *mention* on such a model degrades with a
  notice instead, exactly as the TUI has always degraded one.

  `resolveContext` answers what a mention would resolve to — path, byte count,
  whether it exists, whether it is inside the workspace — so a file picker can
  be honest rather than hopeful. It is read-only, and a query that fails
  confinement is answered without touching the filesystem at all, so it cannot
  become an oracle for the paths confinement exists to hide.

  `PROTOCOL_VERSION` stays at `1`. `resolveContext` degrades like `listModels`:
  an older server's `invalidRequest` becomes `undefined`, which is safe because
  the verb only reads. `prompt`'s `attachments` gets `deleteSession`'s treatment
  instead — an older server would recognise `prompt`, drop the field, and answer
  `ok`, spending the turn and telling the client everything was fine — so
  `ProtocolClient.prompt()` probes `resolveContext` once per session and refuses
  locally rather than sending attachments that would be dropped.

- **Permission state and permission mode on the wire protocol.**
  `permissionState` answers with the session's mode, the rules in force, and
  **the names of the tools the session holds** — the last being the whole of
  RFC 0005 §1.4: there is no verb for "can this engine reach the web", because
  the question is really "is `fetch` in the tool set", and a panel that renders
  a browse button without checking is implying a capability it never confirmed.
  Names only, never a tool's description or schema, and the full set the session
  was built with rather than the subset progressive disclosure is showing the
  model this turn.

  `setPermissionMode` switches between `default`, `acceptEdits`, `plan` and
  `yolo`, and answers with the resulting state so a client reads what the engine
  *is* rather than assuming it got what it asked for. **A mode is a request, not
  a grant:** a stored `deny` rule still wins over `yolo` set from here, exactly
  as it does for a local user, and this verb never edits a rule. It is refused
  mid-run with `sessionBusy` — a mode that changed halfway through a turn would
  not govern the ask already sitting in the client's modal, and `abort` is the
  better verb for stopping an agent now.

  `permissionDecision` grows an optional `scope`, so "allow once" and "allow for
  this session" are distinguishable at the moment of asking. **Nothing persists
  to disk from a remote client:** `"project"` and `"user"` are refused, and so is
  a client-authored `persistRule` carrying either, at three independent seams —
  a client's outbound validation, a server's inbound validation, and
  `SessionHost` itself, which an SDK embedder may reach through another
  transport entirely. A `"session"` allow makes the **engine** mint the rule from
  the `suggestedRule` it already offered, so a client chooses how long and never
  what. `arcturn attach` and the browser client now offer "allow for this
  session" on those terms; previously both sent a `project`-scoped rule that the
  server wrote into the user's own config file. The local TUI is unchanged.

  `PROTOCOL_VERSION` stays at `1`. `permissionState` degrades like `listModels`
  — it reads, so `undefined` costs a client a mode chip and nothing else.
  `setPermissionMode` gets `deleteSession`'s treatment and rejects instead: a
  client told "fine" by a server that ignored it would show a `plan` chip over
  an engine still in `yolo`, and a user who believes they restricted an agent
  they did not restrict is the one outcome a permission control may not produce.
  `permissionDecision`'s `scope` is a field, not a verb — an older server drops
  it and the allow lands as an allow-*once*, which narrows rather than widens.
- **`listCommands` on the wire protocol.** A client can now discover what a `/`
  could invoke: every markdown skill the workspace holds — name, sanitized
  description, and the absolute path it came from — plus the built-ins the wire
  can **actually** carry out. A menu offering `/rewind` to a client with no
  rewind verb is a menu that lies, so the built-ins are enumerated deliberately:
  `model`, `permissions`, `sessions` and `clear` are in because verbs back each
  of them; `rewind`, `compact`, `diff`/`apply`/`discard`, `export`, `theme`,
  `mcp`, `todos`, `cost`, `scout`, `help` and `exit` are out because none do.
  The list lives beside the server's dispatch table, which is what makes an
  entry true. Descriptions are sanitized with the same function that sanitizes
  them on the way to the model, because `<cwd>/.arcturn/skills` is a directory a
  cloned repository controls and those strings now reach a UI as well as a
  prompt. Execution stays `prompt` — a skill is prompt text, and a second
  execution path would give one skill two behaviours — and `prompt` now really
  runs one; see "a leading `/name`" below. Optional and additive:
  `PROTOCOL_VERSION` stays at `1`, and an older server's `invalidRequest`
  becomes `undefined`.
- **A leading `/name` runs the skill, on `prompt` and on `steer`.** `listCommands`
  told a client which skills exist, but the serve path did not expand the command
  it offered: a client that sent `/review` reached a model holding seven literal
  characters, which it might notice and pick up through the model-invoked `skill`
  tool, or might not. A menu whose entries mostly do nothing is the menu RFC 0005
  §3 forbids. A prompt beginning with `/name [args]` is now replaced by that
  skill's body before the model sees anything, substituted by the very same
  `Skill.buildPrompt` the terminal's `/name` and the `skill` tool already use.

  It follows the terminal's rules, including where they say "leave this alone":
  only a *leading* `/name` counts, and a skill body's own `@mentions` are **not**
  expanded — mention expansion is for the text a person typed, and a skill in
  `<cwd>/.arcturn/skills` is a file a cloned repository controls, which would
  otherwise be able to pull `@.env` into a prompt on the strength of someone
  running `/review`. An unrecognised `/name` is **refused** with the nearest
  names suggested and no turn spent, rather than forwarded as prose: a model
  reading `/reviw the auth module` answers *something*, and a user cannot tell
  that from a command that ran. A built-in is refused the same way, naming the
  verb that runs it. One deliberate divergence from the terminal, which treats
  every leading slash as a command: a name here must look like a name
  (`[A-Za-z0-9-]+`), so `/etc/hosts has the wrong entry` is sent as the prose it
  is. A skill is addressed by name against what the engine discovered, never by
  path, so nothing on this route reaches the filesystem.

  `steer` expands identically, and became `Promise<void>` on `SessionHost` to do
  it (the wire has always awaited it, so nothing about the protocol changed);
  steers are chained per session so that the newly-async expansion cannot queue
  two of them in the order their filesystem reads finished rather than the order
  they were sent.
  The terminal steers the *expanded* body when a run is in flight, and a command
  that meant one thing on an idle session and another on a busy one would be the
  same menu lying at a harder moment to notice. That also closes the other half
  of the mention bug below: `@auth.ts` in a steer was never expanded either.
- **`sessionHistory` on the wire protocol.** A client can now ask a server for a
  session's stored conversation, so a panel that attaches to a session it never
  watched can render it. `openSession` subscribes to *future* events and replays
  nothing — that gap is why opening a session from the VS Code history list
  showed an empty chat. The result replays the same `AgentEvent`s the live
  stream carries, deliberately rather than a projected message list: a client
  folds history through the *same* reducer it already runs on live events, so a
  transcript rebuilt from disk and one watched as it happened cannot drift.
  Only the active branch is replayed, so a rewound session never shows a
  conversation the agent will not continue. The payload is bounded — 1 MiB of
  events or 1000 events, whichever binds first, keeping the newest and cutting
  at a turn boundary — and reports `truncated`/`droppedEvents` explicitly, so a
  client says "earlier messages are not shown" instead of quietly starting
  mid-conversation. Additive and optional: `PROTOCOL_VERSION` stays at `1`, and
  `ProtocolClient.sessionHistory()` turns an older server's `invalidRequest`
  into `undefined`.
- **`deleteSession` on the wire protocol.** A client can now permanently delete
  a session. The **engine** performs the deletion — a client unlinking the file
  itself could not see a session still live in the server's memory, nor know
  whether a run was in flight. A session running a turn is refused with
  `sessionBusy`; a live but idle one is deleted and evicted in the same
  operation, and every connection observing it is sent a final `notice` event
  saying so before its subscription is dropped. The store is deleted from
  before the eviction, so a store failure leaves the session intact rather than
  telling clients it was deleted. Unlike `listModels`, an older server's
  `invalidRequest` is **not** translated into success — nothing was deleted —
  and `isUnsupportedMethodError` is exported so a client can say "this engine
  is too old" rather than quoting `Unknown method`.
- **`SessionStore.delete(sessionId)`.** A new *optional* method on the store
  contract, implemented by `JsonlSessionStore` and `MemorySessionStore`.
  Optional so an existing third-party store keeps compiling; a host wired with
  one that lacks it refuses to delete rather than guessing which files to
  unlink.
- **The VS Code panel shows a session's past conversation.** Attaching to a
  session now fetches its history and folds it through the existing transcript
  reducer, so opening one from the history list renders what was said instead
  of an empty chat. A truncated replay is announced in the transcript rather
  than silently omitted. Against an engine without `sessionHistory` the panel
  behaves exactly as it did before.
- **The VS Code panel can delete a session.** Confirmed first by a native modal
  naming the session and saying the deletion cannot be undone; the deletion
  itself goes through the engine's `deleteSession` verb, and the extension never
  touches a session file. Deleting the session on screen opens a fresh one, so
  the composer still goes somewhere real.
- **The VS Code composer is a composer.** The panel exposed a model chip and
  nothing else; it now surfaces the verbs above it, and reads as one control
  rather than a text box with buttons bolted on — attach and context on the
  left, model and mode as chips, send and stop on the right, judged at 300px.

  **`@` opens a context picker.** Typing `@` fuzzy-matches workspace files
  through VS Code's own index (so your `files.exclude` is respected without the
  extension owning a second exclude list), and every row shown has been through
  `resolveContext` — so the size on it is the engine's byte count, not a guess,
  and a path the engine will refuse says why before you press enter. Picking one
  turns it into a removable chip above the composer and **takes the `@…` back
  out of the box**: the engine expands mentions *and* injects attachments, so
  leaving the text in would send the same file twice and the chip row would stop
  being the whole truth about what the prompt carries. Drag-and-drop from the
  explorer or the OS, a native Attach dialog, and pasting an image all land in
  that same set — the one the next `prompt` actually sends. A pasted image
  travels as bytes, because a paste has no path; the panel checks its type
  against the engine's own allowlist first, so a chip that appears is a chip
  that will send.

  **`/` opens the command menu** from `listCommands`: the workspace's skills
  first, each with its description and the file it came from, then the
  built-ins. Enter inserts a skill and leaves you to add an argument —
  execution stays `prompt`, per RFC 0005 §1.3 — while a built-in opens the
  panel surface that already runs it, so `/model` opens the model list rather
  than sending the model a message about wanting a different model. A built-in
  this panel has no surface for is not listed at all, which is RFC 0005 §3's
  rule applied a second time on the client's own terms.

  **A permission mode chip** shows `default` / `acceptEdits` / `plan` / `yolo`
  with one line saying what each grants, `yolo`'s included — that a deny rule in
  your config still wins. The chip **never moves on your click**: it moves when
  the engine's answer says the mode changed, so a refusal cannot leave the panel
  claiming a restriction that is not in force. An engine too old for
  `setPermissionMode` says exactly that instead of degrading, and a mode change
  attempted mid-run says the run is in flight rather than failing silently.

  **The empty state names what this engine can do**, built from
  `permissionState.tools` — including whether it can reach the web. If `fetch`
  and `websearch` are both absent the panel says nothing about browsing and
  shows no button for it; no capability is implied by an affordance.

  **Permission requests stay native modals**, which is a security property and
  not a style choice, and the "allow always" button is now **"Allow for this
  session"** — the only scope this wire has ever accepted. It said "always" and
  meant "until this session ends".

## [0.3.0] — 2026-08-25

### Added

- **`listModels` on the wire protocol.** A client can now ask a server for its
  model catalog — the same models `arcturn --list-models` prints, from the same
  source — instead of guessing from the ids one session happened to announce.
  The response carries, per model, its id, display name, provider, context
  window, max output tokens, pricing, the *name* of the environment variable it
  authenticates with, and whether that credential is present. Two distinctions
  are preserved on the wire rather than papered over: a model with no published
  price has no `cost` field at all (`$0` is reserved for models that really are
  free), and `credentials` is `"present" | "absent" | "unknown"`, where
  `"unknown"` means the server genuinely cannot tell — ambient AWS or Google
  credentials, or a local OpenAI-compatible endpoint that needs no key. **The
  key value itself is never sent.** The verb is additive and optional:
  `PROTOCOL_VERSION` stays at `1`, an older server rejects the call with an
  ordinary `invalidRequest`, and `ProtocolClient.listModels()` turns that one
  rejection into `undefined` so a newer client degrades instead of failing.
- **The VS Code model picker is populated.** It now lists the engine's whole
  catalog with context window, price and credential status per row, models you
  hold a key for first, the model in use pinned to the top — and still keeps
  `arcturn.defaultModel`, the ids the session announced, and the free-text
  entry. Against an engine without `listModels` it silently behaves exactly as
  it did before.

### Changed

- **One mark, every surface.** The favicon and PWA icons, the apple-touch
  icon, the VS Code extension and activity-bar icons, and the CLI's
  terminal-art mark now all draw the Turn Arc — the orbital arc with the
  four-point star at its open end that the website already wears — at an icon
  weight tuned to stay legible at 16px. The old star-over-arc mark is retired
  everywhere it appeared.

### Removed

- **Subscription (OAuth) sign-in — `arcturn auth login`, `auth logout` and
  `auth status` — along with the `anthropic`, `openai-codex` and
  `github-copilot` OAuth provider configurations.** They never worked. A
  sign-in needs an OAuth client id the provider issues to the application
  making the request; Arcturn has none, and the ids that shipped belonged to
  other vendors' tools. No endpoint, scope or token format in that file had
  ever been checked against a live provider, so the feature could not be fixed
  by correcting a URL — it needed a credential no one had issued. Set the
  provider's API key environment variable instead; `arcturn --list-providers`
  names the variable for every provider and preset. The
  `anthropic-oauth`, `github-copilot` and `openai-codex` provider ids are gone
  with it, as are `~/.arcturn/auth/<provider>.json` credential files (delete
  any left behind; nothing reads them) and the `ARCTURN_OAUTH_*` environment
  overrides.
- **From `@arcturn/ai`'s `oauth` namespace**: `beginLogin`, `logout`,
  `createAccessTokenResolver`, the provider registry (`listOAuthProviders`,
  `getOAuthProviderConfig`, `requireOAuthProviderConfig`,
  `registerOAuthProvider`, `configureOAuthProvider`, `resetOAuthProviders`,
  `applyOAuthEnvOverrides`, `OAUTH_CONSTANTS`), the token stores
  (`FileOAuthTokenStore`, `MemoryOAuthTokenStore`, `BaseOAuthTokenStore`), the
  token exchange (`exchangeAuthorizationCode`, `refreshAccessToken`,
  `postOAuthRequest`), the device flow, and the provider factories
  `registerOAuthProviderFactories` and `registerAnthropicOAuthProvider`. What
  remains is the provider-agnostic half — PKCE and the loopback redirect
  listener. From `@arcturn/cli`: `runAuthCommand`, `createAuthStore`,
  `collectAuthStatus`, `formatAuthStatus`, `formatExpiry`, `AuthCommand` and
  `AUTH_ACTIONS`.

**MCP OAuth is unaffected and continues to work.** `arcturn mcp auth <name>`
and `arcturn mcp logout <name>` are a different mechanism: the server's
authorization server is discovered at runtime (RFC 8414) and a client is
registered dynamically (RFC 7591), so there is no hardcoded endpoint and no
borrowed client id. It keeps using `oauth.createStateToken` and
`oauth.startLoopbackServer`, and `~/.arcturn/auth/mcp-<server>.json` is
untouched.

### Fixed

- **Switching models over the wire sent the next request to the wrong
  provider.** Reported from the VS Code extension: picking `zai-api/glm-5.3`
  came back `401 authentication_error` — in Anthropic's error shape, for a
  model that is not Anthropic's. Every `setModel` a server received behaved
  this way, whichever id was asked for, and switching back to the model the
  session started on did not undo it.

  `arcturn serve` handed its `SessionHost` a model catalog, so a remote picker
  saw the real list, but never handed it the resolver that turns a chosen id
  into a provider, an endpoint and a credential. The `setModel` verb carries
  only a bare id, so without a resolver the server built a stand-in spec from
  the id alone — and that stand-in named Anthropic. The id on screen was
  always correct; only the routing was wrong. The user who found this had a
  dead `ANTHROPIC_API_KEY`, which is the only reason it surfaced as a 401
  rather than as prompts and a key quietly going to a provider they had not
  chosen.

  `arcturn serve` now resolves a `setModel` id through the same catalog and
  the same environment `--list-models` and the `listModels` verb read, so what
  a picker offers and what a pick does are one thing. And a server built
  without a resolver no longer invents one: `setModel` is refused with an
  error the client can read. An id that cannot be resolved — an unknown model,
  or one whose API key is not set — is reported as an `invalidRequest` naming
  the reason, and the session stays on the model it was already using.

  `arcturn attach` and the browser client never sent `setModel`, and starting
  a session with `--model` always resolved properly; neither was affected.

## [0.2.0] — 2026-08-24

### The package ecosystem

- **`arcturn add`, `inspect`, `packages`, `update` and `remove`** manage
  packages of skills, agent roles, workflows, themes and MCP servers from a
  git URL, an `owner/repo[/subdir][@ref]` shorthand, or a local path. Installs
  are staged, commit-pinned, and linked file by file; `remove` unlinks exactly
  what `add` added. Executable code never links without a per-install
  confirmation that names the files, and off a TTY it declines rather than
  assuming consent.
- **`arcturn inspect` is disclosure before trust**: the same resolver as
  `add` with the linking taken out. It prints the agent lanes the engine
  would derive, workflow budgets, skills and executable files an install
  would add — and adds none of them. `--json` emits the machine-readable
  disclosure the hub is built from.
- **`arcturn new skill|agent|workflow`** scaffolds an asset file that
  round-trips through the real parsers, so the frontmatter is right on the
  first save.
- **A curated pack catalog** ships in the repository under `examples/` and is
  published at arcturn.dev/hub — seven packs, thirty-two assets, each built
  around a refusal that was watched firing against real fixtures before it
  shipped.

### Fixed

- **The VS Code extension could not see your shell's environment, and did not
  say so when that killed the engine.** Two defects, one user report ("I can't
  select a model; it says no API key found"), reproduced against a real
  GUI-launched editor.

  A macOS or Linux app started from the Dock, Spotlight or a desktop launcher
  inherits `launchd`'s (or the session's) environment, not the user's login
  shell — so `PATH` has no `/opt/homebrew/bin` and `ANTHROPIC_API_KEY` does not
  exist. `arcturn serve` then resolved its model, found no credential, printed
  two lines to stderr and exited before announcing an address. The extension
  captured that stderr and threw it away short of the screen: the sidebar card
  said only "The Arcturn engine stopped" with a *Reconnect* button that could
  only fail again, and a sidebar command invoked from the palette returned
  silently, which looked like an empty model picker.

  - **The failure is now visible, in the engine's own words.** `serve`'s exit
    carries a structured failure (reason, exit status, redacted stderr) that
    becomes a card with the engine's stderr quoted verbatim and the buttons
    that are actually useful for it — *Show Log*, *Choose a Model*, *Set CLI
    Path*, *Install CLI*, *Retry*. The same text goes to the Output channel,
    reachable from the new **Arcturn: Show Log** command, and a palette command
    that cannot run raises exactly one error notification instead of nothing.
    The token stays redacted everywhere, including in the structured failure.
  - **The extension now resolves your real environment.** On first engine start
    — never at activation — it runs `vscode.env.shell` as an interactive login
    shell, reads its environment, and uses it for `arcturn serve`, for finding
    the `arcturn` binary on `PATH`, and for the `--version` probe. Per-shell
    flags for zsh/bash, sh/dash, fish, nushell, tcsh and pwsh; five-second
    deadline; a successful read cached for the window, a *failed* one dropped
    and re-attempted when you reconnect; falls back to VS Code's own
    environment with a diagnostic that says what you lose. The shell is asked
    for `env -0`, so variables are NUL-separated: a newline inside a value
    cannot be misread as declaring a new variable, which would otherwise let
    anything able to set one environment variable set any of them — `PATH`
    included, and `PATH` decides which `arcturn` binary runs. An `env` that
    does not accept `-0` makes the probe refuse rather than guess.
    VS Code's own variables always win, and
    `PATH` is merged with the shell's entries first. Nothing from that
    environment is ever logged — the diagnostic carries a shell path, a count
    and a duration, and credential-shaped values are registered with the log's
    redactor as a second line of defence. Skipped on Windows, where a GUI
    process already inherits the user's environment.

- **`grep` handed a file path answered "No matches found"** — the walker
  swallowed `ENOTDIR` and searched nothing, a silent false negative a model
  reads as evidence of absence. A file root now searches that file. Found by
  a live validation run, not by the 4,300-test suite — recorded accordingly.
- **Unknown cost rendered as `$0.00`.** Model entries with no published
  pricing folded to zero at every accumulation point, so the footer and
  `/cost` claimed a session was free when the truth was "unpriced". The
  session now counts unpriced turns; totals render as `$1.24` only when
  complete, `$1.24+` when partly priced, and `n/a` when nothing was — in the
  footer, `/cost`, `/team` and scout reports. `--max-cost` enforcement is
  unchanged: the cap still counts every dollar it can observe, and `/cost`
  now says so.
- **Z.AI general-API models are priced** from the provider's published rate
  card, quoted in the source with its retrieval date. The coding-plan presets
  stay unpriced on purpose — they are subscriptions, and a per-token price is
  not a number that exists; `/cost` says which plan covers them instead.

## [0.1.0] — 2026-08-23

The first public release. Arcturn is a coding agent you run in a terminal and
the TypeScript harness it is built on, and both are in this release: everything
the CLI does, an embedder can do through `@arcturn/core` and `@arcturn/ai`.

### The agent runtime

- **Event-driven agent loop** with mid-turn steering, structured todos, and plan
  mode. Every event an embedder needs is streamed, not just the final message —
  `agent.subscribe()` sees tool calls, thinking, and partial text as they happen.
- **Tree-structured sessions** persisted as JSONL. A session is a tree, not a
  list, so `/rewind` restores files *and* forks the conversation back to any
  earlier turn instead of destroying what came after.
- **Checkpoints** taken before every file edit, which is what makes that rewind
  safe to reach for.
- **Sub-agents** with their own tools, model and turn ceiling; their events
  stream back into the parent session and their cost folds into its accounting.
- **Compaction and context editing**, plus tool-output offloading and deferred
  tool schemas loaded on demand through `tool_search`, so a long session stays
  inside the window without silently dropping what mattered.
- **Background processes** — long-running shell tasks with streamed output,
  reaped with the step that started them.

### Permissions and safety

- **Rule-based permission engine** with allow/deny/ask decisions resolved across
  session, project and user scopes, and four modes: `default`, `plan`,
  `acceptEdits` and `yolo`. Deny beats `yolo`, always — that ordering is what
  lets a workflow confine a role to its worktree.
- **Case-insensitive path matching on case-insensitive filesystems**, probed at
  runtime rather than assumed from the platform. Without it, `.ENV` walks past a
  `**/.env` deny rule on macOS and Windows.
- **Lifecycle hooks** — shell commands at tool and session boundaries, able to
  veto a `preToolUse` call before it executes.
- **Opt-in OS sandbox** confining `bash` writes to the workspace.

### Workflows and agent organizations

- **Markdown workflows.** A numbered list is a pipeline: top-level items are
  stages run in order, indented bullets are branches run in parallel, `{{input}}`
  and `{{prev}}` thread text through, and `[tag]` selects the model per step. The
  grammar is strict — every malformed line is a parse error naming its number.
- **Named roles.** `@role` dispatches a step to a markdown agent with its own
  system prompt, tools, model and `maxTurns`, resolved in a pre-flight pass over
  the whole file so a typo in stage 6 fails before stage 1 spends a token.
- **Three dispatch lanes**, decided by what a role's tools imply rather than by
  what its description claims: `read` (no worktree), `exec` (an isolated worktree
  whose diff is *always* discarded) and `write` (an isolated worktree whose diff
  is captured and applied). A reviewer structurally cannot land code.
- **Seeded worktrees.** A later stage's worktree is built from the run's starting
  commit with every patch the run has already applied replayed into it, so a
  reviewer reads what the pipeline actually produced rather than untouched HEAD.
- **Resumable runs.** Each step's outcome is journalled before the run moves on.
  `/workflow status` reads an interrupted run back — stage reached, turns, spend,
  and why it stopped — and `/workflow resume` re-enters it there, replaying
  completed steps from the journal and probing every recorded patch with
  `git apply --check --reverse` so nothing lands twice.
- **Human-in-the-loop gates.** A role that hits a real ambiguity emits `ORG-ASK:`
  and the run pauses instead of guessing; `/workflow resume <run-id> <answer>`
  continues from that step with the answer in context. `ORG-HALT:` remains the
  fatal form, for what no answer can fix.
- **Bounded runs.** `stepTimeoutMs:` caps a single step, `budgetUsd:` caps a
  whole run's cumulative spend, and a role's `maxTurns:` is enforced as a hard
  ceiling clamped to the session's own.
- **A runnable enterprise kit** in `examples/enterprise-org/` — ten roles and six
  pipelines that parse cleanly through the real parsers, documented alongside an
  honest account of what is enforced and what is still convention.

### Models and providers

- **Multi-provider AI**: Anthropic, OpenAI (Chat Completions *and* the Responses
  API), Google Gemini, every OpenAI-compatible endpoint, plus Bedrock, Vertex,
  Azure and any Anthropic-Messages endpoint — with streaming, tool calls,
  thinking, prompt caching and cost tracking across all of them.
- **Six of those are verified against live endpoints**, not merely unit-tested:
  Anthropic, Google, OpenAI on both surfaces, and both compatibility adapters.
  Each run covered streaming, a tool call whose result is fed back and answered
  on a second turn, and cost accounting checked against published rates. The
  compatibility adapters were each verified against one implementation of their
  protocol — Z.AI for `openai-compatible`, a canonical Messages API for
  `anthropic-compatible` — which proves the adapter rather than any particular
  third-party service. Bedrock, Vertex and Azure are implemented but have never
  reached a live endpoint; the provider table marks which is which rather than
  presenting one undifferentiated list.
- **Model routing** with tiers and per-route fallback, and a live catalog:
  `/model refresh` queries each provider's own model list and merges newly
  released models in without touching curated entries.
- **A per-event idle timeout** rather than a total duration cap, so a slow but
  progressing stream is never killed while a genuinely stalled one is — and a
  stall is classified as a network fault, so it retries and fails over.

### Tools and editing

- **Built-in tools**: read, write, edit, bash (with background execution), grep,
  glob, ls, fetch and websearch (Brave or DuckDuckGo).
- **Code index** — a BM25 index over the workspace behind a `search_code` tool,
  so relevant code is found by meaning without shipping the repository to an
  embedding service.
- **LSP diagnostics** appended to every write and edit, for TypeScript, Python,
  Go and Rust.
- **@-mentions and images** — fuzzy `@file` completion injects file content or
  attaches images as vision blocks, scoped to the workspace.
- **Markdown skills** — a markdown file in `.arcturn/skills` is a slash command:
  frontmatter, `$ARGUMENTS`, `$SKILL_DIR`, no build step. Skill descriptions from
  the project are sanitized before they reach a prompt.

### Interoperability

- **MCP client built in** — stdio and HTTP Model Context Protocol servers, with
  OAuth 2.1 for remote HTTP servers; their tools, resources and prompts just work.
- **Server mode** — a WebSocket server over an NDJSON wire protocol, exposing
  agent sessions to remote clients.

### Terminal UI

- **Differential rendering** with a frame composer, so a busy run stays
  responsive instead of blocking on TTY writes.
- **Full light and dark theming**, including the terminal canvas itself via
  OSC 11 — the background is owned by the theme rather than inherited from
  whatever the emulator happened to be set to.
- **Live tool-call progress**, streamed while arguments are still arriving.

### Platform support

Linux, macOS and Windows, on Node 20 and 22, with a six-leg CI matrix building
and testing all of them. That matrix earned its keep before this release ever
shipped: its first real run failed 54 tests on Windows and surfaced ten genuine
platform bugs the POSIX suites could not see — model-facing paths carrying the
host separator, a `/dev/null` redirect refused as a workspace escape, language
servers unspawnable because npm ships them as `.cmd` shims. All fixed, with the
matrix as referee. Shell resolution, path handling and case sensitivity are
resolved per platform at runtime.

[Unreleased]: https://github.com/sitharaj88/arcturn/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sitharaj88/arcturn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sitharaj88/arcturn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sitharaj88/arcturn/releases/tag/v0.1.0
