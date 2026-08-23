---
title: Lifecycle hooks
description: Run shell commands at tool and session boundaries, with veto power over tool calls before they run.
section: Core concepts
order: 5.5
---

## Configuring hooks

Declare shell commands under a `hooks` key in `.arcturn/config.json`, one array per
lifecycle point: `preToolUse`, `postToolUse`, `sessionStart`, `runEnd`.

```json
{
  "hooks": {
    "preToolUse": [
      { "command": "./.arcturn/hooks/guard-bash.sh", "matcher": "bash" }
    ],
    "postToolUse": [
      { "command": "./.arcturn/hooks/log-tool-use.sh", "timeoutMs": 5000 }
    ],
    "sessionStart": [
      { "command": "echo session started >> .arcturn/session.log" }
    ],
    "runEnd": [
      { "command": "./.arcturn/hooks/notify.sh" }
    ]
  }
}
```

Like permission rules, hooks accumulate across config layers — a hook in
`~/.arcturn/config.json` and one in `<project>/.arcturn/config.json` both fire, in layer order.

`matcher` restricts which tool a `preToolUse`/`postToolUse` hook fires for: omitted (or
on `sessionStart`/`runEnd`, which have no tool name) matches everything, an exact string
matches that tool only, and a trailing `*` is a prefix glob — `"mcp_*"` matches any
MCP-bridged tool. `timeoutMs` overrides the 10-second default before the hook process
(and everything it spawned) is killed.

## What a hook receives

The lifecycle event's JSON payload arrives on the hook's stdin as a single JSON object,
alongside `event` and `cwd` (added by the runner itself — `event, ...payload, cwd` in
that field order, though JSON key order carries no meaning):

| Event | Payload fields | When it fires |
|---|---|---|
| `preToolUse` | `toolName`, `input` (the tool call's raw arguments, unparsed) | Before a tool executes — the only event that can veto. |
| `postToolUse` | `toolName`, `input`, `resultText` (the tool result's text content blocks, concatenated), `isError` | After a tool executes (or is denied), for observability only. |
| `sessionStart` | `cwd` only | Once, when a session starts. |
| `runEnd` | `cwd` only | Once, when a run ends. |

Exact shape for a `bash` call, on stdin:

```json
{
  "event": "preToolUse",
  "toolName": "bash",
  "input": { "command": "rm -rf /tmp/scratch" },
  "cwd": "/Users/you/project"
}
```

And for the matching `postToolUse`:

```json
{
  "event": "postToolUse",
  "toolName": "bash",
  "input": { "command": "rm -rf /tmp/scratch" },
  "resultText": "removed '/tmp/scratch'",
  "isError": false,
  "cwd": "/Users/you/project"
}
```

`sessionStart` and `runEnd` payloads carry no tool-specific fields — a hook registered for
either always fires (matchers only restrict `preToolUse`/`postToolUse`, since there's no
tool name to match against). The runner spawns the command via `$SHELL -c "<command>"`
(falling back to `/bin/sh` if `$SHELL` is unset), so the hook script can be a one-liner or
a shebang'd file — either way it reads its payload from stdin, not from `argv` or an env
var.

## Vetoing a tool call

Only `preToolUse` hooks can block anything, and only the call they ran for:

| Hook exits with | Result |
|---|---|
| `0`, no JSON on stdout | allow |
| `0`, stdout is `{"decision":"deny","reason":"..."}` | deny, with that reason |
| `2` | deny, reason = trimmed stderr (or a generic fallback) |
| anything else — other codes, spawn failure, timeout | allow, with a warning |

A deny short-circuits: the wrapped tool never executes, and the model sees an error
result instead — `Blocked by preToolUse hook: <reason>`. `postToolUse`, `sessionStart`,
and `runEnd` hooks run for observability only; nothing they return can veto anything.

Within one event, hooks run sequentially in configured order — not concurrently — so the
first `"deny"` short-circuits the rest without wasting a process spawn on hooks that will
never matter. Hooks for *different* tool calls are independent: each `run()` call has its
own local stdout/stderr buffers, so two overlapping tool calls' hook output never
interleaves.

Hooks fail **open** by design — a broken script never wedges the agent. A timeout, a
non-zero/non-2 exit code, or a process that fails to spawn all resolve as `allow`, with a
warning surfaced rather than the run getting stuck:

| Hook exit / behavior | Warning text |
|---|---|
| Timeout (`timeoutMs`, default 10000) | `hook "<command>" timed out after <ms>ms and was killed (allowing)` |
| Non-zero, non-2 exit code | `hook "<command>" exited with code <code> (allowing)` |
| Failed to spawn | `hook "<command>" failed to start: <error> (allowing)` |
| Crashed after spawning | `hook "<command>" failed to run: <error> (allowing)` |

A timeout kills the whole process group, not just the direct child: the hook is spawned
`detached: true` so it becomes its own process-group leader, and the timeout handler
signals `-pid` (the negative pid) with `SIGKILL`, which reaches every descendant the hook
spawned — a hook that shells out to something slow cannot outlive its own timeout by
leaving an orphaned grandchild running.

## Example: block a dangerous command

```bash
#!/usr/bin/env bash
# .arcturn/hooks/guard-bash.sh — deny any bash call whose command contains "rm -rf"
payload="$(cat)"
command=$(printf '%s' "$payload" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c);
  process.stdin.on("end", () => {
    const p = JSON.parse(d);
    process.stdout.write(String(p.input?.command ?? ""));
  });
')

if [[ "$command" == *"rm -rf"* ]]; then
  echo "refusing to run a recursive rm" >&2
  exit 2
fi
exit 0
```

Register it against just the `bash` tool:

```json
{ "hooks": { "preToolUse": [{ "command": "./.arcturn/hooks/guard-bash.sh", "matcher": "bash" }] } }
```

Run it, try to trigger it, and the model gets back a blocked-tool result instead of a
shell that ever ran.

## Example: auto-format after every edit

A `postToolUse` hook can't veto, but it's the right place for side effects that should
happen after a successful write — formatting the file the model just touched, for
instance. Matching on both `write` and `edit` needs two entries, since `matcher` accepts
exactly one glob:

```bash
#!/usr/bin/env bash
# .arcturn/hooks/format-on-write.sh — run prettier on whatever file was just written
payload="$(cat)"
path=$(printf '%s' "$payload" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c);
  process.stdin.on("end", () => {
    const p = JSON.parse(d);
    process.stdout.write(String(p.input?.path ?? p.input?.file_path ?? ""));
  });
')

if [[ -n "$path" && -f "$path" ]]; then
  npx --no-install prettier --write "$path" >/dev/null 2>&1 || true
fi
exit 0
```

```json
{
  "hooks": {
    "postToolUse": [
      { "command": "./.arcturn/hooks/format-on-write.sh", "matcher": "write" },
      { "command": "./.arcturn/hooks/format-on-write.sh", "matcher": "edit" }
    ]
  }
}
```

The trailing `|| true` matters: a hook's own failure to format still resolves the hook
process with exit `0`, so it's reported as a plain `allow` rather than a spurious
"exited with code 1" warning on every file prettier doesn't understand.
