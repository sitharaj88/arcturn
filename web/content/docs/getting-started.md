---
title: Getting started
description: Install Arcturn and run your first agent session.
section: Start
order: 1
---

## What Arcturn is

Arcturn (✦) is an open-source, TypeScript agent harness and interactive coding agent. Its
runtime is a small, event-driven core — one `Agent` per session, one `AgentEvent` stream
out — and everything a real deployment eventually needs (MCP, sub-agents, permissions,
plan mode, background tasks, multi-provider AI) ships as first-class features instead of
homework you write yourself.

You can use Arcturn two ways:

- **As a CLI** — `arcturn`, an interactive terminal coding agent. This page covers the CLI.
- **As an SDK** — `@arcturn/core`, the same runtime embedded in your own product. See
  [Embedding with the SDK](/docs/sdk).

## Requirements

- **Node.js ≥ 20**
- **pnpm** if you're building from source (the monorepo is a pnpm workspace).
- An API key for at least one provider: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
  `GOOGLE_API_KEY` (`GEMINI_API_KEY` also works). See
  [Configuration](/docs/configuration) for the full precedence order and
  OpenAI-compatible endpoints.

## Platform support

Arcturn runs natively on **macOS**, **Linux**, and **Windows**; CI builds and tests all
three (`.github/workflows/ci.yml`) on Node 20 and 22. A few things vary by platform:

- **The shell under `bash` and lifecycle hooks.** On macOS/Linux, commands run through
  `/bin/sh -c` (or your `$SHELL` for hooks, which are your own scripts). On Windows there
  is no `/bin/sh`, so they run through `%ComSpec%` (`cmd.exe` by default) instead of a
  POSIX shell — see the [`bash` tool](/docs/tools#bash). This is a real behavior
  difference, not a shim: an agent-authored command with POSIX idioms — single-quoted
  strings, `$(...)`, heredocs, `ls -la`-style flag bundling — will often fail under
  `cmd.exe` with "is not recognized", the same as it would if you typed it there yourself.
  Arcturn does not translate between shells; the model is told which shell it's running
  under so it can write commands for the platform it's actually on.
- **The OS filesystem sandbox (`sandbox: "workspace-write"`) is macOS and Linux only.**
  There is no Windows backend to fall back to, and Arcturn never pretends otherwise — see
  [Dry run & sandbox](/docs/dry-run#the-os-sandbox) for exactly what note appears in a
  command's output when you ask for it there.
- **Windows support is newer than macOS/Linux and gets less real-world mileage.** If you
  hit a rough edge, **WSL2** is the smoothest path to the same POSIX shell and sandbox
  backend (`bwrap`, if available) this project is developed against day to day — install
  Arcturn inside your WSL2 distro exactly as on Linux.

## Install

```bash
npm install -g arcturn
```

Node 20 or newer. `pnpm add -g arcturn` and `bun add -g arcturn` work the same way, and
`npx arcturn` runs it without installing anything.

### From source

To work on Arcturn itself, or to run an unreleased commit, build it from a clone:

```bash
git clone https://github.com/sitharaj88/arcturn.git
cd arcturn
pnpm install
pnpm -r build
```

Then link the CLI binary onto your `PATH`:

```bash
cd packages/cli
pnpm link --global
```

That builds `packages/cli/dist/main.js` (the file `bin.arcturn` points at in
`packages/cli/package.json`) and exposes it as the `arcturn` command — the same binary the
published package installs, built from whatever commit you have checked out.

## Signing in

Two ways to authenticate a provider, and you can mix them across providers:

**API key** — export the environment variable for whichever provider you're using and
Arcturn finds it automatically:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**No subscription sign-in.** There is no way to use a Claude, ChatGPT or Copilot plan
instead of an API key — that needs an OAuth client id each provider issues to its own
product, and Arcturn has none. See
[Model providers](/docs/providers#subscription-sign-in-is-not-supported).

## Run it

```bash
cd your-project
arcturn
```

Arcturn starts an interactive session rooted at your current working directory. Every tool
call — reading a file, editing one, running a shell command — is scoped to that
directory. Type a prompt and press enter:

```text
✦ arcturn · claude-sonnet-4-5 · ~/projects/api
› add input validation to the /signup handler
```

The first time Arcturn needs to write a file or run a shell command, it asks for
permission (unless you've configured a rule — see [Permissions](/docs/permissions)):

```text
⚠ Permission required — edit src/routes/signup.ts
  a  allow    d  deny    A  always allow src/**.ts
```

From here the model streams its reasoning and tool calls, the TUI renders each one as it
happens, and the transcript is saved as a session — see [Sessions](/docs/sessions) for how
that's stored and how branching/compaction work.

## Resuming a session

```bash
arcturn -c              # resume the most recent session started in this directory
arcturn --resume <id>   # resume a specific session by id
```

`-c`/`--continue` and `-r <id>`/`--resume` are mutually exclusive. Sessions are bucketed
per working directory (a hash of the absolute path), so `-c` only ever offers sessions
that were started from the same project root.

## Non-interactive use

For scripting and CI, run one prompt to completion and exit:

```bash
arcturn -p "summarize the diff since main"
```

```bash
cat question.txt | arcturn -p   # prompt piped on stdin instead of as an argument
```

`-p`/`--print` requires either a prompt argument or piped stdin — with an interactive
terminal and no prompt, it errors immediately rather than hanging.

By default `--print` prints the final assistant message as plain text to stdout. Pass
`--output-format json` to instead emit the agent's full event stream as newline-delimited
JSON — one `AgentEvent` object per line, the same shape used by the SDK and
[server mode](/docs/server-mode):

```bash
arcturn -p "list every TODO comment in src/" --output-format json
```

```json
{"type":"turnStart","turn":1}
{"type":"toolCallStart","toolCallId":"tc_1","toolName":"grep","input":{"pattern":"TODO"}}
{"type":"toolCallEnd","toolCallId":"tc_1","result":{"content":[{"type":"text","text":"…"}]}}
{"type":"runEnd","reason":"completed"}
```

`--output-format json` requires `--print` — it's rejected otherwise. In non-interactive
mode there is no user to answer a permission prompt: any check that would normally ask is
denied automatically, with a note on stderr explaining which flag (`--permission-mode
acceptEdits` or `--permission-mode yolo`) would have allowed it. Diagnostics always go to
stderr, so piping stdout stays clean data either way.

## Choosing a model

```bash
arcturn --model anthropic/claude-sonnet-4-5
arcturn --model openai/gpt-5.1
arcturn --model google/gemini-3-pro-preview
```

Or switch mid-session with `/model <id>`. Model ids are `<provider>/<model>` — see
[Configuration](/docs/configuration) for the full catalog and how to point at a
self-hosted, OpenAI-compatible endpoint. `arcturn --list-models` prints the catalog and
exits; `arcturn --list-providers` prints every provider and preset endpoint.

## Where files land

Everything Arcturn persists lives under one user directory, `~/.arcturn` by default
(override with `ARCTURN_HOME`), plus an optional per-project directory, `<cwd>/.arcturn`:

| Path | What's there |
|---|---|
| `~/.arcturn/config.json` | User-scope settings and permission rules. |
| `<cwd>/.arcturn/config.json` | Project-scope settings, merged over the user file. |
| `~/.arcturn/mcp.json`, `<cwd>/.arcturn/mcp.json` | MCP server declarations, merged. |
| `~/.arcturn/extensions/`, `<cwd>/.arcturn/extensions/` | Extension modules (`.ts`/`.js`). |
| `~/.arcturn/auth/` | OAuth credentials written by `arcturn mcp auth`. |
| `~/.arcturn/sessions/<hash>/` | Session transcripts, bucketed per working directory. |
| `~/.arcturn/live-models.json` | Cache for live model discovery. |

See [Configuration](/docs/configuration) for the complete key-by-key reference and layer
precedence.

## Where to go next

- [Model providers](/docs/providers) — every backend, how to authenticate, and which paths
  have been verified against a live endpoint.
- [Configuration](/docs/configuration) — every config key, default, and env var.
- [Tools](/docs/tools) — what the built-in tools do and how they report back.
- [@-mentions & images](/docs/mentions) — reference files and images from the prompt.
- [LSP diagnostics](/docs/lsp) — language-server errors and warnings after an edit.
- [Permissions](/docs/permissions) — rules, scopes, and the four permission modes.
- [Lifecycle hooks](/docs/hooks) — run shell commands around tool calls, with veto power.
- [MCP](/docs/mcp) — connect external tool servers.
- [Markdown skills](/docs/skills) — add slash commands by dropping a markdown file.
- [Packages](/docs/packages) — install skills, agent roles and workflows from a repo with
  `arcturn add`, and read what an install would do before running it.
- [Sessions](/docs/sessions) — the session tree, branching, and compaction.
- [Checkpoints & /rewind](/docs/checkpoints) — undo file changes and fork the conversation.
- [Dry-run mode](/docs/dry-run) — send file mutations to a shadow tree for review first.
- [Architecture](/docs/architecture) — how the packages fit together.
- [CLI reference](/docs/cli-reference) — every flag, subcommand and slash command, in one
  place.
