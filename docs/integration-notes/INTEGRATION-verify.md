# Wiring the VERIFY LOOP into the CLI

This document is the integration recipe for `packages/cli/src/verify.ts`
(new file, already in the tree with `verify.test.ts`). Per the task's hard
rules, **no existing file was edited** to produce this feature — the
snippets below are exact instructions for whoever wires verify into
`config.ts`, `runtime.ts` and (optionally) `commands.ts`.

## What's already built

`packages/cli/src/verify.ts` exports:

- `VerifyConfig` — `{ command: string; globs?: string[]; timeoutMs?: number; runOn?: "edit" | "manual" }`.
- `VerifyResult` — `{ ok: boolean; exitCode: number | null; output: string }`,
  `output` tail-capped to `DEFAULT_VERIFY_TAIL_LINES` (40) lines.
- `matchesGlob(path, glob)` — the "simple suffix/segment match, no dep"
  matcher: a leading `*` pattern (`"*.ts"`) matches on suffix; anything else
  matches on exact path, trailing path suffix, or an exact path segment.
  No `**`, no mid-pattern `*`.
- `createVerifier(config, { cwd, env? }): Verifier` — `Verifier` has:
  - `maybeRun(editedPath): Promise<VerifyResult | null>` — resolves `null`
    without spawning anything when `config.runOn === "manual"` or `globs`
    is non-empty and doesn't match `editedPath`. Otherwise runs
    `config.command` through `resolveShell` (`@arcturn/tools`) in `cwd` —
    `/bin/sh -c <command>` on macOS/Linux, `%ComSpec% /d /s /c "<command>"`
    (`cmd.exe` by default) on Windows, which has no `/bin/sh` to fall back
    to. `command` is therefore **not portable across the two shells**: a
    verify command that has to run on both platforms needs to be written for
    both (`pnpm test` is fine, `FOO=1 pnpm test` is not — that's POSIX-only
    env-var syntax). Killing a timed-out run terminates the whole process
    tree (mirroring `hooks.ts`/`tools/bash.ts`) after
    `config.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS` (60s default).
  - `runNow(): Promise<VerifyResult>` — runs the command unconditionally,
    ignoring `globs`/`runOn`. This is the hook a `/verify` slash command
    uses (see step 3).
  - Concurrent calls to either method while a run is already in flight
    resolve to *that same* run instead of spawning a second process — the
    debounce the task asked for. It clears once the run settles, so the
    next non-overlapping call spawns fresh.
- `wrapToolsWithVerify(tools, verifier): Tool[]` — wraps `write`/`edit`
  exactly like `lsp/wrap.ts` wraps them: after a **successful** execute, it
  calls `verifier.maybeRun(absolutePath)`; a failing result appends
  `` `\n\nverify failed (exit N):\n<tail>` `` to the result's last text
  block. A passing verify, a `null` (didn't apply), or a tool result that
  was already `isError` all leave the result byte-for-byte unchanged — a
  passing/skipped verify is silent, and a failing verify never turns a
  success into a failure.

17 unit tests cover: pass appends nothing, fail appends the tail (stdout
and stderr both captured), glob mismatch → `null` (no run, asserted via a
side-effecting counter script), `runOn: "manual"` never auto-runs but
`runNow()` does, timeout kills the whole process tree (same grandchild-marker
trick as `hooks.test.ts`), output is tail-capped, concurrent calls coalesce
into one process (both at the `Verifier` level and through
`wrapToolsWithVerify` with two simultaneous edits), non-write/edit tools
pass through as the exact same object, and a tool result that was already
`isError` skips verify entirely.

## 1. `packages/cli/src/config.ts` — add `verify` to `ArcturnConfig`

**Interface** (after `ArcturnConfig.sandbox`, currently lines 58-60):

```ts
export interface ArcturnConfig {
  // …
  /** OS sandbox for foreground bash commands (default "off"). */
  sandbox: "off" | "workspace-write";
  /**
   * Verify loop: a check command run after a successful write/edit. A bare
   * string is sugar for `{ command }` (runs on every edit, no glob filter).
   * Absent disables the verify loop entirely.
   */
  verify?: VerifyConfig | string;
}
```

Add the import at the top, next to the `hooks.js` import (line 23):

```ts
import { type VerifyConfig, parseVerifyConfig } from "./verify.js";
```

(`parseVerifyConfig` is a small new export this step assumes gets added to
`verify.ts` in a follow-up — see the note at the end of this section. It was
**not** added by this task because the task's file list is exactly
`verify.ts` + `verify.test.ts`, and folding config-shape validation into
`verify.ts` would blur that boundary; call it out as the one piece of glue
code the integrator still has to write.)

**`DEFAULT_CONFIG`** (lines 84-93): leave `verify` unset, same treatment as
`systemPromptAppend` — an optional field with no default line means
"disabled", and `ArcturnConfig` objects that never touch verify stay
structurally identical to today.

**`KNOWN_KEYS`** (lines 97-107): add `"verify"`:

```ts
const KNOWN_KEYS = new Set([
  "model",
  "permissionMode",
  "permissions",
  "thinking",
  "theme",
  "systemPromptAppend",
  "hooks",
  "lsp",
  "sandbox",
  "verify",
]);
```

**`parseConfigFile`** (lines 175-246): add a validated branch after the
`raw.sandbox` block and before `raw.permissions` (around line 232),
following the same "warn and drop" style as every other block in this
function:

```ts
if (raw.verify !== undefined) {
  if (typeof raw.verify === "string" && raw.verify.length > 0) {
    out.verify = raw.verify;
  } else if (isRecord(raw.verify) && typeof raw.verify.command === "string" && raw.verify.command.length > 0) {
    const v: VerifyConfig = { command: raw.verify.command };
    if (Array.isArray(raw.verify.globs)) {
      v.globs = raw.verify.globs.filter((g): g is string => typeof g === "string");
    }
    if (typeof raw.verify.timeoutMs === "number" && raw.verify.timeoutMs > 0) {
      v.timeoutMs = Math.floor(raw.verify.timeoutMs);
    }
    if (raw.verify.runOn === "edit" || raw.verify.runOn === "manual") {
      v.runOn = raw.verify.runOn;
    }
    out.verify = v;
  } else {
    warnings.push(`${where}: "verify" must be a command string or an object with a "command"`);
  }
}
```

This is exactly the shape `parseVerifyConfig` (mentioned above) should
encapsulate, so `config.ts` doesn't grow ad hoc validation for a type it
doesn't own — prefer extracting the block above into
`export function parseVerifyConfig(raw: unknown, where: string, warnings: string[]): VerifyConfig | undefined`
inside `verify.ts` and calling that single function from `config.ts`,
mirroring how `parseHookConfig` in `hooks.ts` is called from `config.ts`
rather than reimplemented there.

**`mergeConfig`** (lines 254-275): `verify` is optional-scalar like
`systemPromptAppend`/the cost-guard's `maxCostUsd` — a higher layer fully
replaces the lower layer's value (it is not accumulated like `permissions`
or `hooks`, since "run this one command" doesn't compose the way "run every
configured hook" does):

```ts
export function mergeConfig(base: ArcturnConfig, layer: Partial<ArcturnConfig>): ArcturnConfig {
  return {
    model: layer.model ?? base.model,
    permissionMode: layer.permissionMode ?? base.permissionMode,
    permissions: [...base.permissions, ...(layer.permissions ?? [])],
    thinking: layer.thinking ?? base.thinking,
    theme: layer.theme ?? base.theme,
    lsp: layer.lsp ?? base.lsp,
    sandbox: layer.sandbox ?? base.sandbox,
    hooks: { /* unchanged */ },
    ...((layer.systemPromptAppend ?? base.systemPromptAppend)
      ? { systemPromptAppend: layer.systemPromptAppend ?? base.systemPromptAppend }
      : {}),
    ...((layer.verify ?? base.verify) !== undefined
      ? { verify: layer.verify ?? base.verify }
      : {}),
  };
}
```

No `applyEnv` change needed (no `ARCTURN_VERIFY` env override requested).

## 2. `packages/cli/src/runtime.ts` — construct and wrap

Add the import next to the LSP imports (lines 69-70):

```ts
import { createVerifier, wrapToolsWithVerify } from "./verify.js";
```

**Normalize the bare-string sugar and build the verifier**, right after the
`lsp`/`lspTools` lines in `buildRuntime` (currently lines 803-809):

```ts
const hookRunner = createHookRunner(config.hooks, { cwd: paths.cwd, env });
// LSP wraps innermost (append diagnostics to successful edits); verify
// wraps just outside LSP so the model sees quick diagnostics first and the
// (slower, up to 60s) check command's verdict last; hooks wrap outside
// both (a preToolUse deny skips everything); checkpoints wrap per-agent on
// top in #agentOptions.
const lsp = config.lsp === "on" ? createLspManager({ cwd: paths.cwd }) : undefined;
const lspTools = lsp ? wrapToolsWithLsp(baseTools, lsp) : baseTools;
const verifyConfig: VerifyConfig | undefined =
  typeof config.verify === "string" ? { command: config.verify } : config.verify;
const verifier = verifyConfig ? createVerifier(verifyConfig, { cwd: paths.cwd, env }) : undefined;
const verifiedTools = verifier ? wrapToolsWithVerify(lspTools, verifier) : lspTools;
const hookedTools = wrapToolsWithHooks(verifiedTools, hookRunner);
```

(`VerifyConfig` needs importing as a type alongside the value imports above.)

Then pass `hookedTools` into the `ArcturnRuntime` constructor exactly as today
(line ~830, `baseTools: hookedTools` — unchanged, since `hookedTools` now
already includes the verify wrap).

**Scope note, matching LSP's own choice**: like `wrapToolsWithLsp`,
`wrapToolsWithVerify` is applied only to `baseTools` in `buildRuntime`, not
to the tools rebuilt in `attachMcpTools` (lines 495-503) or
`createSubagent` (lines 505-541). MCP tools essentially never expose a
`write`/`edit`-shaped `path` input the way built-ins do, and sub-agents
reuse `this.#baseTools`, which is already the fully-wrapped
(`hookedTools`) list closed over from `buildRuntime` — so a sub-agent's
edits already trigger verify through the same wrapped tool objects, no
extra wiring needed there.

**Expose the verifier for a manual `/verify` command** (see step 3): add a
field to `ArcturnRuntime` next to `lsp` (around line 342-343):

```ts
/** Verify loop when `verify` is configured, else undefined. */
readonly verifier: Verifier | undefined;
```

set it in the constructor next to `this.lsp = init.lsp;` (line 378), add
`verifier: Verifier | undefined` to `ArcturnRuntimeInit` (next to `lsp`, line
305), and pass `verifier` through in the `new ArcturnRuntime({ … })` call
alongside `lsp` (~line 832).

## 3. `packages/cli/src/commands.ts` — `/verify` manual command (sketch)

Only relevant when some `VerifyConfig` is active (`runtime.verifier !==
undefined`); otherwise the command should say so and return. Insert next to
the `cost`/`todos` commands (around line 480, matching their exact shape —
`run({ ui, runtime })`, `source: "built-in"`):

```ts
{
  name: "verify",
  description: "Run the configured verify command now",
  source: "built-in",
  async run({ ui, runtime }) {
    if (!runtime.verifier) {
      ui.notice("info", "No verify command configured (see the \"verify\" config key).");
      return;
    }
    ui.print("Running verify…");
    const result = await runtime.verifier.runNow();
    if (result.ok) {
      ui.print(`verify passed (exit ${result.exitCode}).`);
      return;
    }
    ui.notice("error", `verify failed (exit ${result.exitCode ?? "null"}):\n${result.output}`);
  },
}
```

This calls `runNow()`, which — per `verify.ts`'s own dedupe rule — coalesces
onto an already-in-flight run if the model happens to be mid-edit
(`wrapToolsWithVerify`'s automatic `maybeRun`) at the same moment, so a user
mashing `/verify` while the agent is writing never double-runs the command.

## Wrap-order interaction, summarized

```
raw tool (write/edit)
  └─ wrapToolsWithLsp        (innermost: appends "lsp diagnostics:" text)
      └─ wrapToolsWithVerify (appends "verify failed (exit N):" text)
          └─ wrapToolsWithHooks   (preToolUse can veto before any of the above run;
                                    postToolUse sees the fully-annotated text)
              └─ wrapToolsWithCheckpoints (outermost, per-agent: snapshots the
                                            file *before* any of the above execute)
```

Consequences worth calling out explicitly:

- A `preToolUse` hook that denies the call means **neither** LSP nor verify
  ever run — `wrapToolsWithHooks`'s `preToolUse` short-circuit
  (`hooks.ts:454-456`) happens before it calls the wrapped (LSP+verify)
  tool's `execute` at all.
- `postToolUse` hooks (`hooks.ts:460-465`) see `resultText` that already
  includes both the LSP diagnostics suffix and the verify-failure suffix,
  since hooks wrap outermost of the four. A hook matching on result text
  (e.g. grepping for `"verify failed"`) works out of the box with no
  changes to `hooks.ts`.
- Checkpoints snapshot the file's *pre-edit* state regardless of what LSP or
  verify later append — `wrapToolsWithCheckpoints` runs before the tool's
  `execute` is even called (it wraps per-agent in `#agentOptions`, outside
  everything built in `buildRuntime`), so `/rewind` is unaffected by this
  feature.
- Both LSP and verify only look at `result.isError` and `input.path` on the
  *tool's own* result — since verify wraps *outside* LSP here, verify's
  `result.isError` check is reading a result that has already had
  diagnostics text appended (never `isError`, since LSP never flips that
  flag either) — so verify still runs normally after a clean edit with
  diagnostics attached. If a project instead wants tests to run before
  diagnostics text is appended (e.g. to keep the LSP suffix as strictly the
  last thing the model reads), swap the two `wrapToolsWith*` calls' order in
  step 2 — nothing else in this document depends on the specific ordering
  between LSP and verify, only on both being inside hooks and outside
  checkpoints.

## Files delivered by this task

- `packages/cli/src/verify.ts` — `VerifyConfig`, `VerifyResult`,
  `CreateVerifierOptions`, `Verifier`, `matchesGlob`, `createVerifier`,
  `wrapToolsWithVerify`. Zero new deps, zero edits to existing files.
- `packages/cli/src/verify.test.ts` — 17 Vitest cases.
- This file.

## Verification run

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/verify.test.ts   # 17 passed
npx tsc -p packages/cli/tsconfig.json --noEmit   # clean (test files are excluded
                                                  # from this project by its own
                                                  # tsconfig; verify.ts and
                                                  # verify.test.ts were also
                                                  # checked directly with Biome)
npx biome check packages/cli/src/verify.ts packages/cli/src/verify.test.ts  # clean
```
