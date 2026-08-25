# Changelog

All notable changes to Arcturn are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Every package in this workspace is released together under one version number.
A change is listed once, under the surface it actually changes for you — the
CLI, the SDK, or the wire protocol.

## [Unreleased]

Nothing yet.

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
