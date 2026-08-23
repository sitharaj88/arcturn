<p align="center">
  <h1 align="center">✦ &nbsp;Arcturn Agent Harness</h1>
  <p align="center"><strong>Every turn counts.</strong> The guiding star for coding agents.</p>
</p>

Arcturn is a modern, production-grade AI agent harness and coding agent. It keeps the
virtues of minimal harnesses — a small event-driven runtime, provider-agnostic AI
layer, tree-structured sessions, TypeScript extensibility — and ships as
first-class features everything they leave out:

- **MCP client built in** — connect stdio and HTTP Model Context Protocol servers; their tools, resources, and prompts just work.
- **Sub-agents** — spawn scoped child agents with their own tools and models; events stream back into the parent session.
- **Permission engine** — rule-based allow/deny/ask with session, project, and user scopes; `acceptEdits`, `plan`, and `yolo` modes.
- **Plan mode & todos** — structured task state that lives in the session tree.
- **Background processes** — long-running shell tasks with streamed output events.
- **Multi-provider AI** — Anthropic, OpenAI (Chat Completions *and* the Responses API), Google Gemini, and every OpenAI-compatible endpoint, with streaming, tool calls, thinking, prompt caching, and cost tracking. Each of those has been driven against its real endpoint, not just unit-tested. Bedrock, Vertex and Azure adapters ship too, but have never reached a live endpoint — the [provider table](https://arcturn.dev/docs/providers) says which is which, and why that distinction earned its own column.
- **Lifecycle hooks** — shell commands run at tool and session boundaries and can veto a `preToolUse` call before it ever executes.
- **Markdown skills** — drop a markdown file in `.arcturn/skills` and it's a slash command; frontmatter, `$ARGUMENTS`, `$SKILL_DIR`, no build step.
- **Checkpoints & `/rewind`** — every file edit is snapshotted first; `/rewind` restores files and forks the conversation back to any earlier turn.
- **@-mentions & images** — fuzzy `@file` completion injects file content or attaches images as vision blocks, scoped to the workspace.
- **Web search & bash sandbox** — a `websearch` tool backed by Brave or DuckDuckGo, plus an opt-in OS sandbox confining `bash`'s writes to the workspace.
- **LSP diagnostics** — real language-server errors and warnings appended to every write and edit, for TypeScript, Python, Go, and Rust.
- **Live model catalog** — `/model refresh` queries each provider's own model list and merges newly released models in without touching curated entries.
- **Workflows & agent organizations** — a numbered markdown file is a multi-stage pipeline: stages run in order, indented branches run in parallel, and `@role` dispatches a step to a named markdown agent with its own model, tools and turn ceiling. Three dispatch lanes decide what a step can touch: `read` (no worktree), `exec` (an isolated worktree whose diff is always discarded) and `write` (an isolated worktree whose diff is captured and applied). Reviewers structurally cannot land code.
- **Resumable runs** — every step's outcome is journalled before the run moves on, so `/workflow status` reads back what an interrupted run reached and `/workflow resume` re-enters it there, replaying completed steps from the journal instead of paying for them twice and probing each recorded patch before it could ever be applied a second time.
- **Human-in-the-loop gates** — a role that hits a genuine ambiguity emits `ORG-ASK:` and the run *pauses* rather than guessing or failing; you answer with `/workflow resume <run-id> <answer>` and it continues from that step. Per-run `budgetUsd:` and per-step `stepTimeoutMs:` ceilings bound the two things that actually run away.
- **Code index** — a BM25 index over the workspace powers a `search_code` tool that finds relevant code by meaning rather than by exact string, without shipping the repository to an embedding service.
- **Context engineering** — automatic compaction, context editing, tool-output offloading, and deferred tool schemas loaded on demand via `tool_search`, so a long session stays inside the window without losing what matters.

## Packages

| Package | Description |
|---------|-------------|
| `@arcturn/types` | Zero-dependency shared contracts (messages, events, tools, permissions, sessions, protocol) |
| `@arcturn/ai` | Unified multi-provider LLM streaming client with model catalog and retry |
| `@arcturn/core` | Agent runtime: event loop, steering, sessions, compaction, permissions, sub-agents |
| `@arcturn/tools` | Built-in tools: read, write, edit, bash (+background), grep, glob, ls, fetch |
| `@arcturn/mcp` | Model Context Protocol client bridge — internal, API may change in any release |
| `@arcturn/tui` | Terminal UI library with differential rendering — internal, API may change in any release |
| `@arcturn/index` | Token-optimized code index and BM25 semantic search — internal, API may change in any release |
| `@arcturn/protocol` | NDJSON wire protocol for server mode — internal, API may change in any release |
| `@arcturn/server` | WebSocket server exposing agent sessions to remote clients — internal, API may change in any release |
| `@arcturn/evals` | Task-level eval harness: real coding tasks with programmatic assertions (in-repo only, not published) |
| `arcturn` (CLI: `arcturn`) | The interactive coding agent, workflow engine, and agent-org runtime |

## Platform support

Arcturn runs on **macOS**, **Linux**, and **Windows** — CI builds and tests all three on
Node 20 and 22 (`.github/workflows/ci.yml`). Windows differences worth knowing:

- The `bash` tool and lifecycle hooks run commands through `%ComSpec%` (`cmd.exe` by
  default), not a POSIX shell, so agent-authored commands with POSIX idioms
  (`&&`-chained builtins, `$(...)`, single-quoted strings) may not run as written.
- The opt-in `sandbox: "workspace-write"` filesystem sandbox is macOS (`sandbox-exec`) and
  Linux (`bwrap`) only; on Windows it runs unconfined and says so explicitly rather than
  silently claiming confinement.
- Windows support is newer than macOS/Linux. If you hit a rough edge, **WSL2** is the
  smoothest path to the same POSIX shell and sandbox this project runs on day to day.

## Development

```bash
pnpm install
pnpm build     # build all packages
pnpm check     # lint + typecheck
pnpm test      # run all tests
```

Node.js ≥ 20 and pnpm ≥ 10 required. See [PLAN.md](PLAN.md) for architecture and roadmap.

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Sitharaj Seenivasan.
