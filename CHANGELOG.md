# Changelog

All notable changes to Arcturn are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Every package in this workspace is released together under one version number.
A change is listed once, under the surface it actually changes for you — the
CLI, the SDK, or the wire protocol.

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/sitharaj88/arcturn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sitharaj88/arcturn/releases/tag/v0.1.0
