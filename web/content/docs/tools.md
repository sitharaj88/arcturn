---
title: Tools
description: The built-in tool set — read, write, edit, bash, grep, glob, ls, fetch, websearch — parameters, output, and limits.
section: Core concepts
order: 4
---

## The built-in set

`@arcturn/tools` ships nine tools, built once per agent via `createDefaultTools`:

```json
{ "read": "…", "write": "…", "edit": "…", "bash": "…", "grep": "…", "glob": "…", "ls": "…", "fetch": "…", "websearch": "…" }
```

| Tool | Permission? | What it does |
|---|---|---|
| `read` | No | Read a file, optionally a line range, or (for large files) an auto-generated declaration outline. |
| `write` | Yes | Create or overwrite a file. |
| `edit` | Yes | Apply an exact find-and-replace edit to an existing file. |
| `bash` | Yes | Run a shell command, in the foreground or the background. |
| `grep` | No | Recursively search file contents by regular expression. |
| `glob` | No | Find files by glob pattern, sorted newest-first. |
| `ls` | No | List a directory. |
| `fetch` | Yes | HTTP GET a URL and return readable text. |
| `websearch` | No | Search the web and return a numbered list of results. |

Two more state tools — `todo` and `plan` — ship from `@arcturn/core` rather than
`@arcturn/tools`, because they mutate agent state instead of the outside world; see
[Sub-agents](/docs/sub-agents) for `plan` mode and delegation. Every tool's permission
decision, when it needs one, ultimately runs through the [permission
engine](/docs/permissions) — this page covers what each tool asks for and does once
allowed. `sandbox` (a filesystem jail for `bash`, see below), `dryRun` (route file
mutations to a shadow tree — see [Dry-run mode](/docs/dry-run)), and `taint`/`canary`
(injection defenses — see [Injection defense](/docs/injection-defense)) all layer on top
of these tools without changing their parameters.

```bash
# equivalent to: import { createDefaultTools } from "@arcturn/tools";
```

`createDefaultTools({ cwd, sandbox })` returns `{ tools, read, write, edit, bash, grep,
glob, ls, fetch, websearch, backgroundTasks }` — call it once per agent, since it hands
back a fresh `BackgroundTaskManager` per call, so two agents never share background task
state.

Two features change what actually reaches the model on top of these definitions, without
changing any tool's parameters: an oversized *result* from any of these tools (`bash` and
MCP tools especially) can be written to a file and replaced with a stub — see
[Context management](/docs/context-management) — and, opt-in, most tool *schemas* can be
withheld from the request entirely until the model asks for them via `tool_search` — see
[Deferred tools](/docs/deferred-tools).

## `read`

Reads a file, or, for large files, a structural outline instead of the body.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Absolute or relative to the working directory. |
| `offset` | number | no | 1-indexed starting line. Default 1. Forces literal-line mode. |
| `limit` | number | no | Max lines returned. Default **2000**. Forces literal-line mode. |
| `outline` | boolean | no | Force (`true`) or suppress (`false`) an outline. Ignored if `offset`/`limit` given. |

- Text output is formatted like `cat -n`: right-padded line number, tab, text. Individual
  lines are truncated past **2000 characters**.
- Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) are returned as base64-encoded
  image content blocks instead of text.
- Files at or above **16,384 bytes** auto-outline: instead of the body, `read` returns a
  structural declaration list (kind, name, signature, line number) so a large file never
  floods context. Passing `offset` or `limit` always returns literal lines and skips the
  outline regardless of size; an outline attempted but unavailable (unrecognized language,
  minified content, no declarations found) silently falls back to a truncated body.
- Output past the line limit is followed by `[Showing lines A-B of N. Use offset=B+1 to
  continue reading.]`.
- Requires no permission — reading is always allowed.

## `write`

Creates or overwrites a file, including any missing parent directories.

| Parameter | Type | Required |
|---|---|---|
| `path` | string | yes |
| `content` | string | yes |

Always requests permission first (`Create file <path>` or `Overwrite file <path>`), with
a suggested "always allow" rule scoped to the parent directory (`<dir>/**`). On success,
returns `Created <path> (N bytes).` or `Updated <path> (N bytes).`.

## `edit`

Exact substring replacement in an existing file.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | File must already exist — `edit` never creates one. |
| `oldText` | string | yes | Must match file contents verbatim, including whitespace. |
| `newText` | string | yes | Must differ from `oldText`. |
| `replaceAll` | boolean | no | Replace every occurrence instead of requiring a unique match. |

Fails with a clear error if the file doesn't exist, `oldText` isn't found, or (without
`replaceAll`) `oldText` matches more than once — the model is told the occurrence count
and asked to add more context or pass `replaceAll: true`. On success, requests permission
(subject: the file path, suggested rule allowing that exact path) and returns a unified
diff alongside the replacement count.

## `bash`

Runs a shell command through the platform's shell: `/bin/sh -c` on macOS/Linux, or
`%ComSpec%` (`cmd.exe` by default) on Windows, which has no `/bin/sh` to fall back to.
This is a real behavior difference, not a shim — the tool's own `description` names the
shell it's running under so the model writes commands for the platform it's actually on;
POSIX idioms (single-quoted strings, `$(...)`, heredocs) fail under `cmd.exe` the same as
they would if you typed them there yourself. See
[Platform support](/docs/getting-started#platform-support). Stdout and stderr are merged.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `command` | string | yes | |
| `timeoutMs` | number | no | Foreground only. Default **120,000ms** (120s), capped at **600,000ms** (600s). |
| `background` | boolean | no | Start the command and return a `taskId` immediately instead of blocking the turn. |

Always requests permission first, with a suggested rule allowing the command's first word
followed by a wildcard (e.g. `git *`). Output is truncated to roughly the trailing **50KB**
either way. Non-zero exit codes mark the result as an error, and the exit code is always
appended: `[Exit code: N]`.

### Background bash

```json
{ "command": "npm run build:watch", "background": true }
```

The `BackgroundTaskManager` spawns the command detached, as its own process group leader,
buffers merged stdout/stderr (same ~50KB trailing cap), and exposes poll/kill/list
operations. The runtime surfaces `backgroundTaskStart` / `backgroundTaskOutput` /
`backgroundTaskEnd` events as the command runs, so a UI — or the model, on its next turn —
can check in without blocking. Killing a task sends `SIGTERM` to its whole process group,
then `SIGKILL` after a **2 second** grace period if it hasn't exited. Background commands
are never sandboxed (see below) — requesting `background: true` while `sandbox` is
`"workspace-write"` is refused outright rather than silently running unsandboxed.

## `grep`

Pure-JS recursive regex content search — no dependency on system `grep`.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string | yes | JavaScript regex source, no surrounding slashes. |
| `path` | string | no | Directory to search. Defaults to cwd. |
| `glob` | string | no | Restrict which files are searched, e.g. `**/*.ts`. |
| `caseInsensitive` | boolean | no | |
| `contextLines` | number | no | Lines of context before/after each match. Default 0. |

Skips `.git` and `node_modules`, and skips files that sniff as binary (a NUL byte in the
first 8000 bytes). Capped at **200 matches** total, after which results are truncated with
a note to narrow the pattern, path, or glob. Each match line is formatted
`path:N:text` (or `path-N-text` for context lines), joined by `--` between match blocks.
Requires no permission.

## `glob`

Finds files by glob pattern via `tinyglobby`.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `pattern` | string or string[] | yes | One or more glob patterns. |
| `path` | string | no | Base directory. Defaults to cwd. |

Skips `.git` and `node_modules`. Results are sorted **most-recently-modified first** and
capped at **500 results**. Requires no permission.

## `ls`

Lists a directory's contents.

| Parameter | Type | Required |
|---|---|---|
| `path` | string | no (defaults to cwd) |

Directories are suffixed `/`; files show a human-readable size (`B`/`KB`/`MB`/`GB`).
Sorted directories-first, then alphabetically. Capped at **500 entries**. Requires no
permission.

## `fetch`

HTTP GET a URL and return its content as readable text.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Must be `http:` or `https:`. |
| `maxBytes` | number | no | Default **102,400** (100KB). |

Redirects are followed. HTML responses (`content-type: text/html`) have tags stripped and
entities decoded down to readable plain text. A 30 second timeout applies. Always requests
permission first, with the subject and suggested "always allow" rule scoped to the URL's
**origin** (not the full URL), so allowing one fetch to `https://api.example.com/v1/x`
covers future fetches to that origin.

## `websearch`

Searches the web and returns numbered results.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | |
| `maxResults` | number | no | Default **5**, capped at **10**. |

Uses the Brave Search API when `BRAVE_API_KEY` is set:

```bash
export BRAVE_API_KEY=...
```

Without a key, falls back to scraping DuckDuckGo's HTML results page — no key required,
no extra setup. Output is `title — url` per result with an indented snippet underneath. A
15 second timeout applies. `websearch` never calls `ctx.requestPermission` — it can't
mutate anything, so it runs in every permission mode without a prompt.

## Background tasks and todos, together

`bash`'s background mode and the `todo` tool (from `@arcturn/core`, described above) are
meant to be used together: the model starts a long build or test watcher in the
background, records it as an in-progress todo, and checks the task's output on a later
turn instead of blocking the whole session on it. Neither tool talks to the other
directly — the model is what threads a `taskId` through the todo text if it wants to.

## Filesystem sandbox for bash

Set `sandbox` to `"workspace-write"` in `.arcturn/config.json` (default `"off"`) to have
the OS itself deny writes outside a small set of roots for `bash`'s **foreground**
commands — the working directory, the OS temp directory, and `$HOME/.arcturn`. Reads,
network access, and process spawning are untouched; only file writes are restricted.

```json
{ "sandbox": "workspace-write" }
```

The backend is platform-specific:

| Platform | Mechanism |
|---|---|
| macOS | `sandbox-exec -p <profile>`, denying `file-write*` outside the writable roots |
| Linux | `bwrap`, with `/` bound read-only and the writable roots bound read-write |
| Anything else, or a missing binary | Runs unsandboxed |

When sandboxing was requested but couldn't be applied — no `bwrap` on `PATH`, an
unsupported platform — the command still runs, and a
`note: sandbox requested but unavailable on this platform` line is prepended to its
output so the gap is visible rather than silent. Background commands are never sandboxed
(see above). Full permission-mode interaction is covered in
[Permissions](/docs/permissions); dry-run and taint/canary defenses that also touch tool
output are covered in [Dry-run mode](/docs/dry-run) and
[Injection defense](/docs/injection-defense) respectively.

## The `Tool` contract

Every tool — built-in, MCP-bridged, or one you write — implements the same shape from
`@arcturn/types`:

```json
{ "definition": { "name": "…", "description": "…", "parameters": "JsonSchema" }, "execute": "fn(input, ctx) -> ToolResult" }
```

`ToolExecutionContext` is what the runtime hands every tool call: `cwd`, `signal` (aborts
on user interrupt), `requestPermission` (ask before a sensitive action), `onUpdate`
(stream incremental progress), `sessionId`, `toolCallId`.

A `ToolResult` carries rendered content plus an optional `details` payload for UIs that
want structured data instead of parsing text: `content` (array of text/image blocks),
`isError` (optional), `details` (optional, arbitrary structured data — every built-in tool
above populates one, e.g. `EditToolDetails { path, replacements, diff }`).

Tools should resolve with `isError: true` for expected failures (a missing file, a
non-zero exit code) and only reject the promise for genuine programming errors — the
runtime turns a rejection into a `notice` event, not a clean tool result the model can
react to.

## Permission subjects

Tools don't talk to the permission engine directly for the *decision* — that's the
runtime's job — but they do report a **subject**: the specific thing being acted on
(a command, a path, a URL), which the permission engine matches rule specifiers against.
`defaultSubject` reads it from whichever of these keys the tool's input carries first:
`command`, `file_path`, `filePath`, `path`, `url`, `pattern`, `query`, `target`. That's
why a rule like `{ tool: "bash", specifier: "git *", action: "allow" }` matches any bash
call whose `command` starts with `git `. See [Permissions](/docs/permissions) for the
full rule schema, scopes, and the four permission modes.

## Writing your own tool

A custom tool is just an object matching the `Tool` interface — add it to the `tools`
array passed to `createAgent`:

```json
{
  "definition": {
    "name": "deploy",
    "description": "Deploy the current branch to the staging environment.",
    "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
  }
}
```

Its `execute(input, ctx)` calls `ctx.requestPermission({ toolName, toolCallId, subject,
description })`, checks `decision.behavior === "allow"`, does the work, and returns a
`ToolResult`. See [Embedding with the SDK](/docs/sdk) for a full runnable example.

For tools that need to read or mutate agent state (todos, plan, permission mode) rather
than the outside world, implement `BindableTool` instead — its `bindAgent(controller)`
hook receives an `AgentStateController` the first time the tool is attached to an agent.
`createTodoTool` and `createPlanTool` in `@arcturn/core` are the reference
implementations: see [Sub-agents](/docs/sub-agents) for how `plan` mode uses this to gate
execution on user approval.
