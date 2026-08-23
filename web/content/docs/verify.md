---
title: Verify loop
description: Run a build/test/lint command after every edit and feed a failure straight back to the model.
section: Core concepts
order: 4.65
---

## What it does

After the model edits a file, an optionally-configured check command (tests, a typecheck,
a lint pass) runs, and if it fails, the failure is fed back as part of the *same* tool
result — the same way [LSP diagnostics](/docs/lsp) get appended — so the model sees its
own breakage on the very next turn and can self-correct without you having to point it
out.

This never turns a successful `write`/`edit` into a failure: a verify command that fails
only *appends* a notice to the already-successful result. A passing verify appends
nothing at all — quiet on green — and a command that doesn't apply to the edited path
(`globs` didn't match, or `runOn: "manual"`) simply never runs.

## Config

```json
{
  "verify": "pnpm test"
}
```

A bare string is sugar for `{ command: "pnpm test" }` — no `globs`, so it runs after every
successful `write`/`edit`. The full shape:

```json
{
  "verify": {
    "command": "pnpm typecheck",
    "globs": ["*.ts", "*.tsx"],
    "timeoutMs": 30000,
    "runOn": "edit"
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `command` | — (required) | Run via `/bin/sh -c <command>` in the runtime's `cwd`. |
| `globs` | none (matches everything) | Restricts which edited paths trigger this command. |
| `timeoutMs` | `DEFAULT_VERIFY_TIMEOUT_MS` = 60,000 | Kills the command (and its whole process tree) if it runs longer. |
| `runOn` | `"edit"` | `"edit"` runs automatically after every matching write/edit; `"manual"` never runs automatically. |

Only one verify command is configured at a time — there's no array of checks to run in
sequence or in parallel; if you need several, wrap them in one shell command
(`"pnpm typecheck && pnpm lint"`).

### Glob matching is deliberately not real globbing

`globs` entries are matched with a simple suffix/segment check, not full glob syntax:

- A pattern starting with `*` (`"*.ts"`) matches when the edited path ends with the rest
  of the pattern (`".ts"`).
- Any other pattern matches when it equals the whole path, is a trailing path suffix
  (`"src/foo.ts"` matches `.../src/foo.ts`), or names one of the path's segments exactly
  (`"src"` matches anything under a `src/` directory).

There is no `**` and no mid-pattern `*`. This covers the common cases (extension filters,
directory filters) without pulling in a glob library for a feature that's checking one
path at a time.

## When it triggers, and the debounce

Verify wraps only the `write` and `edit` tools. After each *successful* call, the
wrapper calls `verifier.maybeRun(absolutePath)`, which resolves to `null` (no run) when
`runOn` is `"manual"`, or when `globs` is non-empty and none of them match the edited
path.

Concurrent calls to `maybeRun` (or `runNow`) while a run is already in flight resolve to
the *same* run rather than spawning a second process — so several edits landing in one
turn coalesce into a single verify invocation instead of racing N copies of your test
suite. The in-flight promise clears once it settles, so the next, non-overlapping call
spawns a fresh process.

## What the model sees on failure

The exact text appended to the tool result:

```text
verify failed (exit <exitCode or "null">):
<tail of stdout+stderr>
```

Output is capped to the trailing `DEFAULT_VERIFY_TAIL_LINES` = 40 lines. On a timeout,
the exit code reported is `null` and the tail carries an explicit
`[verify command timed out after <timeoutMs>ms and was killed]` marker. The kill itself
targets the whole process group (`SIGKILL`, detached process group; falling back to
killing just the child if that fails) — a test runner that spawns its own children
doesn't survive a timeout by orphaning them.

## Interplay with LSP diagnostics

Verify and [LSP diagnostics](/docs/lsp) are independent wrap layers, not coupled to each
other — each inspects only its own tool result. They compose by wrap order: LSP wraps
innermost, verify wraps just outside it, so the model sees the fast, per-file LSP
diagnostics first and the slower (up to 60 seconds by default) verify command's verdict
last, in the same turn. LSP catches the kind of thing a language server knows about a
single file instantly; verify catches whatever your build/test/lint pipeline knows that
LSP can't — cross-file breakage, a failing assertion, a lint rule LSP doesn't enforce.

## Interplay with dry-run

Under `--dry-run`, verify is disabled for the session rather than pointed at the shadow
overlay tree — checking an untouched real workspace while edits land somewhere else would
just produce a false pass or a stale failure, so it doesn't run at all. Combine dry-run
with the checkpoint/`/diff` flow described in [Dry run & sandbox](/docs/dry-run), and run
verify for real once you commit the changes.

## Honest limits

- One command only — no per-check parallelism, no independent pass/fail per check; if any
  part of the pipeline fails, the whole command's exit code is what's reported.
- The glob matcher is intentionally not a real glob engine (see above) — don't reach for
  `**` patterns, they won't do what you expect.
- There's no dedicated `/verify` slash command shipped today — the only way verify runs is
  automatically, after a matching `write`/`edit`. A `runOn: "manual"` check has no
  built-in trigger to invoke it from the UI yet; it's reachable only through
  `Verifier.runNow()` in code.

## Related

- [LSP diagnostics](/docs/lsp) — the sibling wrap layer verify's failure message sits
  alongside in the same tool result.
- [Dry run & sandbox](/docs/dry-run) — why verify stands down under `--dry-run` instead
  of running against the shadow tree.
