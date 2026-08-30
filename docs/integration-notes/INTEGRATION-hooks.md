# Integration: lifecycle hooks

New files (already created, do not need edits):

- `packages/cli/src/hooks.ts`
- `packages/cli/src/hooks.test.ts`

This document describes the wiring needed elsewhere so the feature is
actually reachable. Nothing outside the two files above was touched.

## What `hooks.ts` exports

```ts
export type HookEvent = "preToolUse" | "postToolUse" | "sessionStart" | "runEnd";
export interface HookDefinition { command: string; matcher?: string; timeoutMs?: number; scope?: PermissionScope }
export interface HookConfig { preToolUse: HookDefinition[]; postToolUse: HookDefinition[]; sessionStart: HookDefinition[]; runEnd: HookDefinition[] }
export const EMPTY_HOOK_CONFIG: Readonly<HookConfig>;
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

export function parseHookConfig(raw: unknown, where: string, warnings: string[], scope?: PermissionScope): HookConfig;

export interface HookPayload { toolName?: string; input?: unknown; resultText?: string; isError?: boolean; [key: string]: unknown }
export interface PreToolUsePayload { toolName: string; input: unknown }
export interface PostToolUsePayload { toolName: string; input: unknown; resultText: string; isError: boolean }
export type SessionStartPayload = Record<string, unknown>;
export type RunEndPayload = Record<string, unknown>;

export interface HookRunResult { decision: "allow" | "deny"; reason?: string; warnings: string[] }
export interface CreateHookRunnerOptions { cwd: string; env?: NodeJS.ProcessEnv }
export interface HookRunner { run(event: HookEvent, payload?: HookPayload): Promise<HookRunResult> }

export function createHookRunner(config: HookConfig, opts: CreateHookRunnerOptions): HookRunner;
export function wrapToolsWithHooks(tools: Tool[], runner: HookRunner): Tool[];
```

`run()` never rejects: a hook that fails to spawn, times out, or exits with
an unrecognised code resolves fail-open (`decision: "allow"`) with a warning
string describing what happened, appended to the returned `warnings` array.
Only `preToolUse` hooks can produce `decision: "deny"` in a way that matters
— `wrapToolsWithHooks` is the only caller that acts on it — but `run()`
itself is generic over all four events (a `postToolUse`/`sessionStart`/
`runEnd` hook script that prints a deny JSON or exits 2 will still be
reported as `decision: "deny"` in the `HookRunResult`; it is the caller's
job to ignore that for events that cannot actually veto anything).

## 1. Config parsing (`packages/cli/src/config.ts`)

Today, a `"hooks"` key in `.arcturn/config.json` triggers
`` `${where}: unknown config key "hooks" (ignored)` `` because
`parseConfigFile`'s `KNOWN_KEYS` set doesn't include it. To wire it up:

1. Add `"hooks"` to `KNOWN_KEYS`.
2. Add `hooks: HookConfig` (or `hooks?: HookConfig`, see below) to the
   `ArcturnConfig` interface, importing `type { HookConfig }` from `./hooks.js`.
3. In `parseConfigFile`, add:
   ```ts
   if (raw.hooks !== undefined) {
     out.hooks = parseHookConfig(raw.hooks, where, warnings);
   }
   ```
   (import `parseHookConfig` from `./hooks.js`).
4. Decide the merge semantics in `mergeConfig`. Hooks are naturally
   *additive* across layers the same way `permissions` are (a user-level
   `sessionStart` hook and a project-level `preToolUse` hook should probably
   both fire), so the natural analogue of the existing
   `permissions: [...base.permissions, ...(layer.permissions ?? [])]` line is:
   ```ts
   hooks: {
     preToolUse: [...base.hooks.preToolUse, ...(layer.hooks?.preToolUse ?? [])],
     postToolUse: [...base.hooks.postToolUse, ...(layer.hooks?.postToolUse ?? [])],
     sessionStart: [...base.hooks.sessionStart, ...(layer.hooks?.sessionStart ?? [])],
     runEnd: [...base.hooks.runEnd, ...(layer.hooks?.runEnd ?? [])],
   },
   ```
   If a "later layer replaces entirely" semantic is preferred instead, use
   `layer.hooks ?? base.hooks` — but note that diverges from how
   `permissions` already behaves, which may surprise users.
5. Add `hooks: EMPTY_HOOK_CONFIG` (or four empty arrays) to `DEFAULT_CONFIG`,
   importing `EMPTY_HOOK_CONFIG` from `./hooks.js`.
6. `config.test.ts` will need a matching case (not created by this task —
   `hooks.test.ts` covers `parseHookConfig` itself in isolation, but
   `config.test.ts`'s "accepts a full document" / "warns about … unknown
   keys" tests assert exact key sets and will need `hooks` added to stay
   green).

## 2. Wiring into the running agent (`packages/cli/src/runtime.ts`)

`buildRuntime()` assembles the tool list around **line 685-696**:

```ts
const defaults = createDefaultTools({ cwd: paths.cwd });
const baseTools: Tool[] = [
  ...defaults.tools,
  createTodoTool(),
  createPlanTool(),
  createSubagentTool({ ... }),
  ...extensions.tools,
];
```

Right after this array is built (and before it's used for
`promptContext`/`ArcturnRuntime` construction), build a runner from
`config.hooks` and wrap:

```ts
import { createHookRunner, wrapToolsWithHooks } from "./hooks.js";
...
const hookRunner = createHookRunner(config.hooks, { cwd: paths.cwd, env });
const wrappedBaseTools = wrapToolsWithHooks(baseTools, hookRunner);
```

Then pass `wrappedBaseTools` (not `baseTools`) into `ArcturnRuntime`'s
constructor/`#baseTools` field. Because `createSubagent()` and
`#agentOptions()` both derive their tool lists from `this.#baseTools`
(see lines 470-501 and 512-534), wrapping once here automatically covers
sub-agents too — no separate wrapping needed there.

MCP tools are attached separately, in `attachMcpTools()` (line ~465):

```ts
attachMcpTools(tools: Tool[]): void {
  this.#mcpTools = [...tools];
  this.agent.setTools([...this.#baseTools, ...this.#mcpTools]);
}
```

Since `#baseTools` is already hook-wrapped, MCP tools are the one gap: wrap
them too, e.g. by storing the `HookRunner` on the `ArcturnRuntime` instance (a
new private field, set once in the constructor from the same `hookRunner`
built in `buildRuntime`) and changing this method to
`this.#mcpTools = wrapToolsWithHooks(tools, this.#hookRunner);`. Without
this, hooks configured with a matcher like `"mcp_*"` would silently never
fire.

`sessionStart` and `runEnd` are not tool wrapping at all — they're whole-run
lifecycle events with no natural home in `wrapToolsWithHooks`. Reasonable
call sites:
- `sessionStart`: once per `ArcturnRuntime` construction (end of `buildRuntime`,
  or the top of `ArcturnRuntime`'s constructor), `await hookRunner.run("sessionStart", { cwd: paths.cwd })`.
  Any warnings it returns should flow into the same `warnings: string[]`
  array `buildRuntime` already threads through and returns.
- `runEnd`: in `dispose()` (line ~504), before or after the MCP manager is
  closed — e.g. `await hookRunner.run("runEnd", {})`. `dispose()` doesn't
  currently return anything meaningful; if `runEnd` warnings need
  surfacing, that's a small signature change to `dispose()` or a fire-and
  -forget with `console.error` for warnings, whichever matches how the CLI
  already reports post-hoc warnings elsewhere (see `warnings.push(...)` in
  `buildRuntime` and how `main.ts`/`print.ts` print them).

## 3. Package surface (`packages/cli/src/index.ts`)

Add a new export block (alphabetically, hooks.ts sorts between format.ts and
interactive/index.ts, so right before the `interactive/index.js` block):

```ts
export {
  createHookRunner,
  type CreateHookRunnerOptions,
  DEFAULT_HOOK_TIMEOUT_MS,
  EMPTY_HOOK_CONFIG,
  type HookConfig,
  type HookDefinition,
  type HookEvent,
  type HookPayload,
  type HookRunner,
  type HookRunResult,
  parseHookConfig,
  type PostToolUsePayload,
  type PreToolUsePayload,
  type RunEndPayload,
  type SessionStartPayload,
  wrapToolsWithHooks,
} from "./hooks.js";
```

## Notes on the design, for whoever wires this in

- **Veto protocol** (Claude Code convention, implemented exactly):
  exit 0 with no stdout JSON → allow; exit 0 with stdout JSON
  `{"decision":"deny","reason":"..."}` → deny with that reason; exit code 2
  → deny, reason = trimmed stderr (or a generic fallback if stderr is
  empty); anything else (other exit codes, spawn failure, timeout) → allow,
  with a warning string pushed onto `HookRunResult.warnings` — hooks fail
  open by design so a broken script cannot wedge the agent.
- **Matcher glob**: only a trailing `*` is special (prefix match, e.g.
  `"mcp_*"`); anything else is an exact tool-name match; omitted matches
  every tool. Matchers are ignored for `sessionStart`/`runEnd` (no
  `toolName` exists for those events).
- **Process tree kill on timeout**: hook processes are spawned with
  `detached: true` so they're their own process-group leader; on timeout the
  runner sends `SIGKILL` to `-pid` (the whole group), not just the direct
  child, so grandchildren the hook itself spawned die too. Covered by
  `hooks.test.ts`'s "kills the whole process tree on timeout" test, which
  spawns a real grandchild and asserts it never gets to run its delayed
  side effect.
- **Ordering / concurrency**: within one `run()` call, matching hooks run
  sequentially and the first `"deny"` short-circuits the rest. Two
  concurrent `run()` calls (e.g. two tool calls in flight, or a tool call
  racing a background event) never share mutable state — each spawn has its
  own local stdout/stderr buffers — so they cannot interleave each other's
  output or decisions. Covered by a concurrency test in `hooks.test.ts`.
- **`postToolUse` cannot veto**: `wrapToolsWithHooks` always executes the
  real tool and returns its (possibly `isError`) result unchanged; the
  `postToolUse` hook's own `HookRunResult` is intentionally not surfaced to
  the caller beyond whatever the runner already logs.
- **Errors are not swallowed**: if a wrapped tool's `execute()` throws (a
  programming error per the `Tool` contract in `packages/types/src/tools.ts`
  — expected failures should already come back as `isError: true` results,
  not throws), `wrapToolsWithHooks`'s wrapper does not catch it; the promise
  rejection propagates to the same place an unwrapped tool's rejection would
  have gone. `postToolUse` simply never runs in that case.
- **No new dependencies**: hook processes are spawned with
  `node:child_process`, matching the pattern already used in
  `packages/tools/src/bash.ts` (foreground run + timeout + kill).

## Verifying

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/hooks.test.ts
npx tsc -p packages/cli/tsconfig.json --noEmit
```

Both currently pass (16/16 tests, clean typecheck) against `hooks.ts` in
isolation. Re-run the full `packages/cli` test suite plus
`packages/cli/src/config.test.ts` after wiring step 1 above, since that step
touches `config.ts`'s existing exhaustive-key assertions.
