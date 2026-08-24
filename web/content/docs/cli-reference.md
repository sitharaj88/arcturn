---
title: CLI reference
description: Every command-line flag and every slash command in one place, with what each is actually for.
section: Reference
order: 10.95
---

Everything Arcturn accepts, in one place. The pages linked from each entry are where the
reasoning lives; this is the index you come back to when you know the feature exists and
want the exact spelling.

## Invocation

```bash
arcturn                              # interactive TUI in the current directory
arcturn "fix the flaky retry test"   # TUI, seeded with a first prompt
arcturn -p "summarise src/auth.ts"   # run once, print the answer, exit
cat notes.md | arcturn -p            # piped stdin becomes the prompt
cat ctx.txt | arcturn -p "explain"   # piped stdin becomes leading context
```

With `-p` and a prompt argument, Arcturn waits briefly for piped input and then proceeds
without it. That matters when a parent process — CI, a Makefile, `subprocess.run` — leaves
an inherited stdin open that never closes; waiting for EOF there would hang forever.

## Flags

| Flag | What it does |
|---|---|
| `-p`, `--print` | Non-interactive: run to completion, print the final message, exit |
| `--output-format <fmt>` | With `--print`: `text` (default) or `json` (NDJSON of every agent event) |
| `-m`, `--model <id>` | Model to use — see `--list-models` and [Model providers](/docs/providers) |
| `-c`, `--continue` | Resume the most recent session in this directory |
| `-r`, `--resume <id>` | Resume a specific session — see [Sessions](/docs/sessions) |
| `--permission-mode <m>` | `default`, `acceptEdits`, `plan` or `yolo` — see [Permissions](/docs/permissions) |
| `--cwd <dir>` | Working directory for tools, config and sessions |
| `--no-mcp` | Do not start any configured MCP servers — see [MCP](/docs/mcp) |
| `--max-turns <n>` | Stop a run after n model turns |
| `--max-cost <usd>` | Abort the run once it has cost this much — see [Cost & audit](/docs/audit-cost) |
| `--dry-run` | Send file edits to a shadow copy; review with `/diff` — see [Dry run](/docs/dry-run) |
| `--trace` | Write one JSON line per finished telemetry span to stderr — see [Telemetry](/docs/telemetry) |
| `--list-models` | Print the model catalog and exit |
| `--list-providers` | Print every provider and preset endpoint, and exit |
| `-h`, `--help` · `-v`, `--version` | Usage, version |

`--host`, `--port` and `--token` apply to `arcturn serve`; `--cassette` applies to
`arcturn bisect`.

**`--max-cost` and `--max-turns` are the two worth reaching for by default.** An agent that
loops on a failure it cannot fix spends real money doing it, and a ceiling turns "I checked
my bill on Friday" into "the run stopped."

## Subcommands

| Command | What it does |
|---|---|
| `arcturn mcp add\|remove\|list\|get <name>` | Manage MCP server declarations — see [MCP](/docs/mcp) |
| `arcturn mcp auth <name>` · `mcp logout <name>` | Authorize an OAuth MCP server in the browser; delete its stored credentials |
| `arcturn add <source>` | Install a package of skills, agents, workflows or themes — see [Packages](/docs/packages) |
| `arcturn inspect <source>` | Stage a package and print what installing it *would* add; installs nothing |
| `arcturn packages` | List installed packages with their pinned commits |
| `arcturn update [name]` | Re-fetch one package, or all of them; a package pinned to a ref never moves |
| `arcturn remove <name>` | Uninstall a package, unlinking exactly what it added |
| `arcturn new skill\|agent\|workflow <name>` | Scaffold a valid asset file with the frontmatter the parsers require |
| `arcturn mcp-serve` | Expose Arcturn *as* an MCP server — see [MCP server](/docs/mcp-server) |
| `arcturn serve` | WebSocket server over the NDJSON protocol — see [Server mode](/docs/server-mode) |
| `arcturn completions <shell>` | Print a bash, zsh or fish completion script |
| `arcturn blame` · `arcturn replay` · `arcturn bisect` | Provenance and replay — see [Provenance](/docs/provenance) and [Replay & bisect](/docs/replay-bisect) |

**`arcturn add` never links a package's executable code without being told to.** A package
carrying `extensions/` stops for a per-install confirmation that names the files, and off
a TTY — CI, a pipe, a script — it declines rather than assuming consent. `--yes` is how
you grant that consent up front, and `--skills-only` is how you take the package's
markdown and leave its code on disk unlinked. `arcturn inspect` is the same resolver with
the linking taken out: it prints the agent lanes, workflow budgets and executable files an
install would add, and adds none of them — run it before you reach for `--yes`.

## Slash commands

Typed inside the interactive TUI.

### Session and context

| Command | What it does |
|---|---|
| `/help` | List the available commands |
| `/clear` | Start a fresh session |
| `/compact` | Summarise the conversation to free up context — see [Context management](/docs/context-management) |
| `/sessions` | Resume an earlier session in this directory — see [Sessions](/docs/sessions) |
| `/rewind` | Restore to an earlier turn; `/rewind <query>` jumps by intent — see [Checkpoints](/docs/checkpoints) |
| `/export` | Export the conversation to markdown or HTML |
| `/todos` | Show the current todo list |
| `/exit` | Quit Arcturn |

`/rewind` restores files *and* forks the conversation, rather than truncating it. The
session is a tree, so the branch you rewound away from is still there.

### Models, cost and appearance

| Command | What it does |
|---|---|
| `/model` | Switch the model; `/model refresh` re-queries each provider's own list |
| `/cost` | Show usage and cost; also `limit <usd>`, `preview [steps]` |
| `/theme` | Switch the colour theme |
| `/permissions` | Show rules and mode; also `suggest` |
| `/mcp` | Show MCP server status |

### Changes

| Command | What it does |
|---|---|
| `/diff` | Show pending dry-run changes |
| `/apply` | Apply pending dry-run changes to the workspace |
| `/discard` | Throw away pending dry-run changes |

These three are the [dry-run](/docs/dry-run) loop: with `--dry-run`, edits land in a shadow
copy until you have read them.

### Packages

| Command | What it does |
|---|---|
| `/add <source>` | Install a package: `/add <source> [--name x] [--skills-only]` — see [Packages](/docs/packages) |
| `/packages` | List installed packages |
| `/remove <name>` | Uninstall a package |
| `/update [name]` | Re-fetch a package, or every one of them |

The same four operations as `arcturn add|packages|remove|update`, against the same
`~/.arcturn/packages` and the same fail-closed confirmation for executable code. The
shell verbs exist so an install can happen in CI or a setup script; the slash commands
exist so it can happen without leaving a session.

### Delegation

| Command | What it does |
|---|---|
| `/bg <task>` | Run a task in the background; `/bg`, `logs\|cancel\|adopt <id>` — see [Teams](/docs/teams) |
| `/team <goal>` | Run a team of agents on one goal; `status\|cancel\|merge\|discard [id]` |
| `/scout <a> \| <b>` | Explore approaches in parallel worktrees — see [Scouts](/docs/scouts) |
| `/workflow <name> [args]` | Run a scripted multi-step workflow — see [Workflows](/docs/workflows) |
| `/workflow list` | List discovered workflows |
| `/workflow status [runId]` | What a run reached, its spend and turns, and why it stopped |
| `/workflow resume <runId> [answer]` | Re-enter an interrupted run, or answer an `ORG-ASK:` |
| `/org memory` | Inspect per-role lessons injected into later runs — see [Agent organizations](/docs/agent-organizations) |
| `/org memory add\|propose\|approve\|revoke\|rm` | Edit that store |

The distinction between `/bg`, `/team`, `/scout` and `/workflow` is what each is *for*:
`/bg` is one task off-thread, `/team` is several agents on one goal with a merge step,
`/scout` is competing approaches you pick between, and `/workflow` is a scripted pipeline
whose shape you decided in advance. [Teams](/docs/teams) compares the first three;
[Workflows](/docs/workflows) covers the last.

`/org memory` entries are inert until a person approves them — a proposed entry is never
injected into a role's prompt. That gate exists because a memory entry becomes standing
instruction text in later runs, which is not something a model should be able to grant
itself.

## Related

- [Getting started](/docs/getting-started) — installation and first run
- [Packages](/docs/packages) — what `add`, `inspect`, `update` and `remove` install, and the
  gate that stands in front of executable code
- [Configuration](/docs/configuration) — everything settable in `.arcturn/config.json`
- [Model providers](/docs/providers) — every backend, credentials, and which are verified live
- [Permissions](/docs/permissions) — what each `--permission-mode` actually grants
