# Integration notes: `@arcturn/tools` upgrade

This upgrade lives entirely in `packages/tools/` (new `websearch` tool, an
optional `bash` filesystem sandbox, and a background-task process-group kill
fix). Nothing outside `packages/tools/` was touched. The three steps below are
what a follow-up change to `packages/cli/` would need to wire the new surface
into the actual CLI; none of them are required for `packages/tools/` itself to
build/test cleanly.

## 1. Register `websearch` as a built-in tool name

`packages/cli/src/runtime.ts` has a `BUILT_IN_TOOL_NAMES` list (around line 85)
that extensions may not shadow:

```ts
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "ls",
  "fetch",
  "todo",
  "plan",
  "subagent",
];
```

Add `"websearch"` to this array. `createDefaultTools()` (from
`@arcturn/tools`, already imported in `runtime.ts`) now includes the
`websearch` tool in its returned `tools` array automatically — see
`packages/tools/src/index.ts` — so no other wiring is needed for the tool
itself to reach the agent loop. This is purely about keeping the "extensions
can't shadow a built-in" invariant accurate.

## 2. Glyph for `websearch`

`packages/cli/src/glyphs.ts` keys a per-tool glyph in both `FANCY_GLYPHS.tools`
and `ASCII_GLYPHS.tools` (falling back to `toolDefault` for anything missing).
Add a `websearch` entry to both:

```ts
// FANCY_GLYPHS.tools
websearch: "⌖",   // suggested: a "target/crosshair" glyph, distinct from fetch's "⤓"

// ASCII_GLYPHS.tools
websearch: "?",
```

`⌖` (U+2316, POSITION INDICATOR) reads reasonably as "search/locate" and is
distinct from every glyph already in use. Any other single-glyph pick works
equally well — the only hard constraint is that it not collide with an
existing entry in `FANCY_GLYPHS.tools`/`ASCII_GLYPHS.tools`.

## 3. Threading a `sandbox` config key into `createBashTool`

`packages/tools/src/index.ts`'s `createDefaultTools()` already accepts and
forwards a `sandbox` option:

```ts
export interface CreateDefaultToolsOptions {
  cwd?: string;
  sandbox?: BashSandboxMode; // "off" | "workspace-write", forwarded to createBashTool
}
```

So the only remaining wiring is in `packages/cli/`:

1. **`packages/cli/src/config.ts`** — add a field to `ArcturnConfig` (declared
   around line 38, alongside `model`/`permissionMode`/`thinking`/`theme`),
   e.g.:

   ```ts
   /** Filesystem sandbox applied to bash's foreground commands. */
   sandbox?: BashSandboxMode; // import from "@arcturn/tools"
   ```

   and thread it through the same merge logic used for `theme`/`thinking`
   (config file layers → CLI flag override), defaulting to `"off"` so
   existing installs see zero behavior change.

2. **`packages/cli/src/runtime.ts`** — the single call site is:

   ```ts
   const defaults = createDefaultTools({ cwd: paths.cwd });
   ```

   (around line 692, right before `baseTools` is assembled). Change it to:

   ```ts
   const defaults = createDefaultTools({ cwd: paths.cwd, sandbox: config.sandbox });
   ```

No other call site constructs a `bash` tool — `createSubagentTool`'s
sub-agents go through `runtimeRef.createSubagent`, which itself flows back
through the same `createDefaultTools` path, so a sub-agent naturally inherits
whatever sandbox mode the parent runtime resolved.

### Optional: `websearch` and permission modes

`websearch` intentionally never calls `ctx.requestPermission` (see
`packages/tools/NOTES.md`), matching the brief's instruction to treat it like
the other read-only tools. `@arcturn/core`'s `DEFAULT_READ_ONLY_TOOLS`
(`packages/core/src/permissions.ts`) currently lists only
`["read", "grep", "glob", "ls"]` and is consulted by the permission engine's
`plan` mode to decide what's safe to run without prompting. If `plan` mode
should also allow `websearch` (it can't mutate anything, but it does send the
query to a third party — the same tradeoff `fetch` makes differently), add
`"websearch"` there. This is a `packages/core/` change and out of scope for
this pass, called out here only so it isn't lost.

## What shipped in `packages/tools/`

- **`src/websearch.ts`** (+ `src/websearch.test.ts`, 15 tests) — new
  `websearch` tool. Brave Search API when `BRAVE_API_KEY` is set, DuckDuckGo
  HTML scraping otherwise (regex-based, no HTML-parser dependency). Every
  failure mode (network error, non-2xx, zero results) returns an
  `isError: true` `ToolResult`; nothing throws. 15s timeout via
  `AbortSignal.any`. No `ctx.requestPermission` call, matching `read`/`grep`/
  `glob`/`ls`.
- **`src/sandbox.ts`** (+ `src/sandbox.test.ts` 20 tests, plus 8 tests in the
  new `src/bash-sandbox.test.ts` exercising it through `createBashTool`) — the
  `bash` tool's new `sandbox?: "off" | "workspace-write"` option (default
  `"off"`, zero behavior change). darwin uses `sandbox-exec -p <profile>`;
  linux uses `bwrap` when it's on `PATH`; anything else runs unsandboxed with
  `SANDBOX_UNAVAILABLE_NOTE` prepended to the output. All profile/argv
  builders are pure and exported (`buildSandboxExecProfile`,
  `buildSandboxExecArgv`, `buildBwrapArgv`, `escapeSandboxProfilePath`,
  `commandExistsOnPath`); `resolveSandboxInvocation` is the impure decision
  function, parameterized by an injectable `SandboxProbe` for testing every
  platform/availability branch without needing the real sandboxing binaries.
  Real `sandbox-exec` execution (including an actual denied-write and
  actual-allowed-write end-to-end check) is exercised too, gated behind
  `existsSync("/usr/bin/sandbox-exec")` so the suite still passes on machines
  without it.
- **`src/bash.ts`** — background tasks (`background: true`) now spawn
  `detached: true` and `BackgroundTaskManager.kill()` signals the whole
  process group (`process.kill(-pid, "SIGTERM")`, then `SIGKILL` after a 2s
  grace period, `BACKGROUND_KILL_GRACE_MS`) instead of killing only the
  immediate child. A new timing-tolerant test in `src/bash.test.ts` starts a
  background task that itself forks a grandchild (`sleep 30 &`), confirms the
  grandchild is alive, kills the task, and polls (up to grace-period-plus-slack)
  for the grandchild to actually die.
- **`src/index.ts`** — exports `createWebSearchTool` (+ its result-parsing
  helpers and detail types) and the `sandbox.ts` surface; `createDefaultTools`
  now returns a `websearch` tool alongside the existing eight, and forwards a
  new `sandbox` option to `createBashTool`.

## Verification

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/tools   # 13 files, 107 tests, all passing
npx tsc -p packages/tools/tsconfig.json --noEmit   # clean
npx biome check packages/tools/src   # clean
```
