# Notes on @arcturn/tools

Decisions and workarounds made while implementing against the frozen
`@arcturn/types` contracts, without editing that package.

## Contract observations (no changes needed, just notes)

- `PermissionRequest["suggestedRule"]` is typed as `Omit<PermissionRule, "scope">`,
  which includes the **required** `action` field (not just `tool`/`specifier`).
  Every `requestPermission` call in this package sets `suggestedRule.action: "allow"`
  since the suggested rule is always "allow future matches like this one".
- `Tool.execute`'s JSDoc says it "must resolve ... and only reject on programming
  errors." I took this literally: every expected failure (missing file, denied
  permission, invalid regex, timeout, abort, non-2xx fetch, etc.) is returned as
  `{ isError: true, content: [...] }`, never a thrown/rejected promise. In
  particular, an aborted `ctx.signal` produces an `isError` result quickly rather
  than a rejection.
- `ToolExecutionContext` has no `model` field and no render/UI hooks (unlike the
  reference implementations, which is much richer — theming, TUI
  components, constrained sampling, etc.). This package intentionally has zero
  rendering/formatting concerns; it only implements `definition` + `execute`.

## Design choices left unspecified by the task brief

- **`createDefaultTools` return shape.** The brief says it should return "the
  full Tool[] plus individual exports and the BackgroundTaskManager." Since a
  bare `Tool[]` would make it impossible for a caller to poll/kill background
  bash tasks (there's no separate "bash_output" tool in the brief), I return an
  object: `{ tools: Tool[], read, write, edit, bash, grep, glob, ls, fetch,
  backgroundTasks }`. `tools` is the array for feeding into an agent loop; the
  named fields are the same instances for direct access. Each `createDefaultTools()`
  call builds fresh tool instances and a fresh `BackgroundTaskManager`, so
  multiple sessions/agents don't share background-task state.
- Each tool module also exports its own `createXTool()` factory (e.g.
  `createReadTool`, `createBashTool`) for callers who want a subset of tools
  without building the whole default set.
- **Bash timeout clamping vs. erroring.** `timeoutMs` above the 600s max is
  silently clamped rather than rejected, to keep the tool ergonomic for callers
  that pass a generous default.
- **Bash shell (update — no longer hardcoded `/bin/sh`).** Foreground and
  background commands alike are spawned via `resolveShell()` (`./shell.ts`),
  which is `/bin/sh -c <command>` on macOS/Linux and `%ComSpec% /d /s /c
  "<command>"` (`cmd.exe` by default) on Windows — there is no `/bin/sh` to
  fall back to there. The tool's own `definition.description` names the
  resolved shell so the model writes commands for the platform it's actually
  running on (or the sandboxed invocation from `sandbox.ts` — see below,
  macOS/Linux only). Foreground timeout/abort kills the whole process tree
  (`terminateProcessTree`, detached-process-group on POSIX / `taskkill /T` on
  win32), bounded by a short drain (`FOREGROUND_KILL_DRAIN_MS`) so a survivor
  holding the stdio pipes open can't stall the tool call past the timeout.
- **Background process-group kill (update).** The earlier note above about no
  process-group kill for background tasks is now resolved:
  `BackgroundTaskManager.start` spawns with `detached: true` (so the child is
  its own process group leader — pgid equals pid on POSIX), and `kill(taskId)`
  signals the whole group via `process.kill(-pid, "SIGTERM")`, then
  `process.kill(-pid, "SIGKILL")` after a `BACKGROUND_KILL_GRACE_MS` (2s) grace
  period if it's still running. `killProcessGroup` falls back to a direct
  `proc.kill(signal)` if the negative-pid signal throws (e.g. the process
  already exited). This only applies to `background: true` tasks; foreground
  commands are still a single `spawn` + direct `child.kill`, unchanged.
- **`websearch`.** Read-only like `read`/`grep`/`glob`/`ls`: never calls
  `ctx.requestPermission`. This mirrors the brief's explicit instruction, even
  though the query text is sent to a third-party host (Brave or DuckDuckGo) —
  unlike `fetch`, whose module doc explains it *does* gate on permission for
  exactly that reason. If this package's permission stance changes later,
  `@arcturn/core`'s `DEFAULT_READ_ONLY_TOOLS` (`packages/core/src/permissions.ts`)
  would need `"websearch"` added for `plan` mode to treat it as non-mutating;
  out of scope here since it's outside `packages/tools`. DuckDuckGo HTML
  parsing is done with two regexes (`result__a` anchors, `result__snippet`
  anchors) matched by document order and paired by nearest-following-snippet,
  no HTML-parser dependency. DuckDuckGo's anchors route through
  `//duckduckgo.com/l/?uddg=<encoded>`, which is unwrapped back to the real
  target URL.
- **Bash sandbox (`sandbox.ts`).** `createBashTool`'s new `sandbox` option
  (`"off"` default, `"workspace-write"`) only wraps *foreground* commands —
  background tasks are unsandboxed regardless, since the brief scoped this to
  "the foreground command". On darwin it shells out to `/usr/bin/sandbox-exec
  -p <profile>`; the profile denies all file writes then re-allows them under
  three roots (cwd, `os.tmpdir()`, `$HOME/.arcturn`). On linux it uses `bwrap` if
  found on `PATH` (`--ro-bind / /` plus `--bind` for the same three roots,
  `--share-net`). Any other platform, or the binary missing, runs unsandboxed
  and prepends `SANDBOX_UNAVAILABLE_NOTE` to the result text. All profile/argv
  construction (`buildSandboxExecProfile`, `buildSandboxExecArgv`,
  `buildBwrapArgv`, `escapeSandboxProfilePath`, `commandExistsOnPath`) is pure
  and independently tested; `resolveSandboxInvocation` is the impure decision
  function, parameterized by an injectable `SandboxProbe` so tests can exercise
  every platform/availability branch without needing the real binaries.
  **Symlink gotcha found while testing on macOS:** `sandbox-exec` resolves
  `subpath` against the *canonicalized* filesystem path, and `os.tmpdir()` /
  `mkdtemp()` results live under `/var/...`, which is itself a symlink to
  `/private/var/...` on macOS — embedding the literal `/var/...` path in the
  profile makes every write inside it fail. `resolveSandboxInvocation` runs
  each root through `probe.realpathSync` (falling back to the original path if
  resolution throws, e.g. the directory doesn't exist yet) before building the
  profile/argv. Verified against the real `sandbox-exec` binary (present on
  the dev/CI darwin machine this was built on) in
  `sandbox.test.ts`/`bash-sandbox.test.ts`'s `describe.runIf(hasRealSandboxExec)`
  blocks, gated on `existsSync("/usr/bin/sandbox-exec")` so the suite still
  passes on machines without it (Linux CI, hardened images, etc.).
- **`edit` uniqueness/diff.** Implemented a small from-scratch LCS-based unified
  diff generator (`src/diff.ts`) rather than depending on an external `diff`
  package (not in the preinstalled dependency list). For files where
  `oldLines.length * newLines.length` exceeds 4,000,000 cells, it falls back to
  a single "replace everything" hunk instead of running the full O(n·m) DP, to
  avoid pathological memory/time use on huge files. Exact-substring matching
  only (no fuzzy/whitespace-insensitive matching like some reference tools) —
  the brief only asked for exact `oldText`/`newText` semantics.
- **`grep`.** Pure-JS recursive walk when no `glob` filter is given; delegates
  to `tinyglobby` for candidate file listing when a `glob` filter is supplied
  (still pure-JS regex matching against file contents either way). Binary
  detection is a NUL-byte sniff over the first 8000 bytes.
- **`read` image support.** Limited to the four extensions named in the brief
  (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`) mapped to their MIME types by file
  extension only (no magic-byte sniffing), since the brief didn't ask for a
  general image-detection utility.
- **`fetch` HTML stripping.** Regex-based tag stripping + a small named/numeric
  HTML entity decoder, as requested ("simple regex-based tag strip + entity
  decode"). Not a full HTML parser, so pathological/malformed markup can leak
  odd whitespace, but it's adequate for turning typical pages into readable text.

## Environment

- `@types/node` is `^24.10.1` at the workspace root (hoisted), which is what
  makes global `fetch`, `AbortController`, and `AbortSignal.any` available
  under `NodeNext`/`ES2023` without a `"dom"` lib entry. Nothing added to this
  package's `package.json` — relying on the existing hoisted install, per the
  "never edit package.json" rule.
