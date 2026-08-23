# Wiring COST GUARD into the CLI

This document is the integration recipe for `packages/cli/src/cost-guard.ts`
(new file, already in the tree with `cost-guard.test.ts`). Per the task's
hard rules, **no existing file was edited** to produce this feature — the
snippets below are exact instructions for whoever wires the guard into
`config.ts`, `args.ts`, `runtime.ts`, `main.ts` and `commands.ts`.

## What's already built

`packages/cli/src/cost-guard.ts` exports:

- `shouldAbortForCost(spentUsd: number, limitUsd: number): boolean` — pure
  threshold check. `limitUsd <= 0` (or non-finite) always returns `false`
  (disabled).
- `costLimitMessage(limitUsd: number): string` — the exact user-facing
  string: `` `Cost limit $X.XX reached; run aborted. Raise it with
  --max-cost or /cost limit.` ``.
- `createCostGuard(options: CostGuardOptions): CostGuard` — stateful wrapper
  with `onEvent(event: AgentEvent)` and `reset()`. It re-arms on every
  `runStart` event and calls `options.abort(message)` + `options.notify?.(message)`
  at most once per run, the first time `getCostUsd() >= limitUsd` is observed
  on a `turnEnd` event.

```ts
export interface CostGuardOptions {
  limitUsd: number | undefined;
  getCostUsd: () => number;
  abort: (reason: string) => void;
  notify?: (message: string) => void;
}
```

12 unit tests cover: no-op below threshold, fires exactly once at/above
threshold, disabled at `0`/`undefined`, ignores non-`turnEnd` events,
re-arms on `runStart`, and `reset()`.

## 1. `packages/cli/src/config.ts` — add `maxCostUsd` to `ArcturnConfig`

**Interface** (after `ArcturnConfig.sandbox`, line 59-60):

```ts
export interface ArcturnConfig {
  // …
  /** OS sandbox for foreground bash commands (default "off"). */
  sandbox: "off" | "workspace-write";
  /** USD ceiling on cumulative run cost; `0`/absent disables COST GUARD. */
  maxCostUsd?: number;
}
```

**`DEFAULT_CONFIG`** (line 84-93): leave `maxCostUsd` unset — an optional
field with no default line is equivalent to "disabled", consistent with how
`systemPromptAppend` is handled elsewhere in this file (see the merge logic
below). Do **not** add `maxCostUsd: 0` to the frozen default; `0` and
"absent" both mean disabled per `shouldAbortForCost`, so there is no need to
materialize a zero value that would print in `arcturn --list-models`-style
debug dumps of the config.

**`KNOWN_KEYS`** (line 97-107): add `"maxCostUsd"` to the set so the
unknown-key warning does not fire on a config file that sets it:

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
  "maxCostUsd",
]);
```

**`parseConfigFile`** (line 175-246): add a validated branch, following the
exact style of the `raw.thinking`/`raw.lsp` blocks right above it (insert
after the `raw.sandbox` block, before `raw.permissions`, around line 232):

```ts
if (raw.maxCostUsd !== undefined) {
  if (typeof raw.maxCostUsd === "number" && Number.isFinite(raw.maxCostUsd) && raw.maxCostUsd >= 0) {
    out.maxCostUsd = raw.maxCostUsd;
  } else {
    warnings.push(`${where}: "maxCostUsd" must be a non-negative number`);
  }
}
```

**`mergeConfig`** (line 254-275): `maxCostUsd` is optional-scalar, same
shape as `systemPromptAppend` — a higher layer's value wins, but only add
the key when something set it (keeps `ArcturnConfig` objects that never touched
cost guard structurally identical to today, which matters for existing
snapshot/equality tests elsewhere in the suite):

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
    ...((layer.maxCostUsd ?? base.maxCostUsd) !== undefined
      ? { maxCostUsd: layer.maxCostUsd ?? base.maxCostUsd }
      : {}),
  };
}
```

No change is needed in `applyEnv` (line 307-310) unless a `ARCTURN_MAX_COST_USD`
env override is wanted later — out of scope here since the task only asks
for the config key and the CLI flag.

## 2. `packages/cli/src/args.ts` — add `--max-cost <usd>`

**`CliArgs`** (line 61-92), after `maxTurns` (line 80-81):

```ts
export interface CliArgs {
  // …
  /** `--max-turns`: safety valve on loop iterations. */
  maxTurns?: number;
  /** `--max-cost <usd>`: COST GUARD ceiling; aborts the run once crossed. */
  maxCostUsd?: number;
  // …
}
```

**`VALUE_FLAGS`** (line 170-177): add `"--max-cost"`:

```ts
const VALUE_FLAGS = new Set([
  "--model",
  "--resume",
  "--permission-mode",
  "--cwd",
  "--max-turns",
  "--max-cost",
  "--output-format",
]);
```

**`parseArgs` switch** (line 240-303): add a case mirroring `--max-turns`
(line 292-299), but validating `> 0` as a float rather than an integer:

```ts
case "--max-cost": {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: "--max-cost must be a positive number" };
  }
  args.maxCostUsd = parsed;
  break;
}
```

**`helpText`** (line 350-395): add a line near `--max-turns` (line 375):

```
      --max-turns <n>           Stop a run after n model turns.
      --max-cost <usd>          Abort a run once cumulative cost reaches $usd.
```

## 3. `packages/cli/src/runtime.ts` — construct and subscribe the guard

**`BuildRuntimeOptions`** (line 680-708), add next to `maxTurns` (line 695):

```ts
/** Maximum model turns per run (`--max-turns`). */
maxTurns?: number;
/** COST GUARD ceiling in USD (`--max-cost`, or config `maxCostUsd`). */
maxCostUsd?: number;
```

**`buildRuntime`** (function starts line 719): the resolved config is
already in scope as `config` by this point (see line 731-739), and
`options.maxTurns ?? undefined` is folded into the `ArcturnRuntime` constructor
call at line 820-838 the same way `--max-turns` overrides `config` — there
is no `config.maxTurns` today, but `maxCostUsd` should follow the same
"CLI flag wins over config" precedence used for `model`/`permissionMode`
(line 766, 774):

```ts
const maxCostUsd = options.maxCostUsd ?? config.maxCostUsd;
```

Place this right after `const permissionMode = options.permissionMode ?? config.permissionMode;`
(line 774).

Then, **after** `const runtime = new ArcturnRuntime({ … }); runtimeRef = runtime;`
(line 820-839) and **before** the `sessionId`/`resumeSession` block (line
841), wire the guard:

```ts
import { createCostGuard } from "./cost-guard.js"; // new import at the top of runtime.ts

// …

if (maxCostUsd !== undefined && maxCostUsd > 0) {
  const guard = createCostGuard({
    limitUsd: maxCostUsd,
    getCostUsd: () => runtime.metrics.costUsd,
    abort: () => runtime.agent.abort(),
    notify: (message) => runtime.warnings.push(message),
  });
  runtime.subscribe((event) => guard.onEvent(event));
}
```

Notes on this call site:

- `runtime.subscribe` (defined line 404-414ish, right after the `tools`
  getter) is the *session-surviving* subscription — unlike `agent.subscribe`,
  it keeps working across `/clear` and session swaps because `ArcturnRuntime`
  re-attaches its listener set to whichever `Agent` is live (`#swap`,
  line 627-632, and `#attach`, line 634-636). That means the guard does not
  need to be re-created when `startNewSession`/`/clear` replaces
  `runtime.agent` — exactly what "re-arm on `runStart`" already handles
  per-run, and a fresh `Agent` still emits `runStart` first.
- `abort: () => runtime.agent.abort()` matches the existing `Agent.abort()`
  signature (`packages/core/src/agent.ts:399`, takes no arguments, is
  idempotent — calling it when nothing is running is a no-op via the
  optional-chained `this.#abort?.abort()`).
- `notify` here pushes into `runtime.warnings`, which the TUI and `--print`
  path already surface (see `main.ts:127`, `for (const warning of
  runtime.warnings) …`). A TUI-specific integration may instead want to
  route `notify` through a `notice` event or `ui.notice("warn", message)` —
  either works since `CostGuardOptions.notify` is just `(message: string) =>
  void`.
- Guard against `maxCostUsd === 0` explicitly even though
  `shouldAbortForCost` already treats `0` as disabled — the `if` above keeps
  a disabled run from paying the (tiny) cost of an extra subscription.

## 4. `packages/cli/src/main.ts` — thread `--max-cost` through

`buildRuntime` is called at line 107-114. Add one line next to `maxTurns`
(line 111):

```ts
const runtime = await buildRuntime({
  ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
  ...(args.model === undefined ? {} : { model: args.model }),
  ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
  ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
  ...(args.maxCostUsd === undefined ? {} : { maxCostUsd: args.maxCostUsd }),
  ...(args.resume === undefined ? {} : { resume: args.resume }),
  continueSession: args.continueSession,
});
```

## 5. `packages/cli/src/commands.ts` — `/cost limit <usd>` subaction

The `cost` command is defined at line 481-499. Today it takes no
arguments (`run({ ui, runtime })`); slash commands that do take arguments
elsewhere in this file receive an `args` array in their `run` context (see
`skillCommand`'s handler in `runtime.ts:882`, or check the
`ExtensionCommand`/built-in-command run signature used by other
argument-taking built-ins in this file for the exact param name/type before
copying this sketch verbatim).

Sketch — replace the single `run` with one that branches on a `limit`
subaction, persisting via the existing `persistSetting` helper
(`config.ts:401-419`, already generic over `keyof ArcturnConfig` so
`persistSetting("maxCostUsd", value, scope, runtime.paths)` needs no new
plumbing):

```ts
{
  name: "cost",
  description: "Show token usage and cost for this session, or set the cost ceiling",
  source: "built-in",
  async run({ ui, runtime, args }) {
    const [sub, value] = args ?? [];
    if (sub === "limit") {
      if (value === undefined) {
        const current = runtime.config.maxCostUsd;
        ui.print(
          current === undefined || current <= 0
            ? "No cost limit set. Usage: /cost limit <usd>"
            : `Cost limit: ${formatCost(current)}`,
        );
        return;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        ui.notice("error", "/cost limit needs a positive number, e.g. /cost limit 2.50");
        return;
      }
      // Persisting only updates the config file + in-memory config; the
      // guard subscribed in buildRuntime reads maxCostUsd once at startup
      // (see runtime.ts step 3), so a live /cost limit change needs the
      // guard's `limitUsd` to come from a mutable ref (e.g. wrap it in
      // `{ current: maxCostUsd }` and read `.current` in getCostUsd's
      // sibling closure) rather than the captured `const maxCostUsd` shown
      // above, OR simplest: expose `runtime.setMaxCostUsd(n)` that both
      // persists and updates a mutable field the guard closes over.
      await persistSetting("maxCostUsd", parsed, "user", runtime.paths);
      ui.print(`Cost limit set to ${formatCost(parsed)}. Takes effect on the next run.`);
      return;
    }
    const { usage, costUsd, turns } = runtime.metrics;
    ui.print([
      `Session ${runtime.agent.sessionId}`,
      `  model      ${runtime.model.displayName} (${runtime.model.id})`,
      `  turns      ${turns}`,
      `  input      ${formatTokens(usage.inputTokens)}`,
      `  output     ${formatTokens(usage.outputTokens)}`,
      `  cache      ${formatTokens(usage.cacheReadTokens)} read · ${formatTokens(usage.cacheWriteTokens)} write`,
      `  total      ${formatTokens(totalTokens(usage))}`,
      `  cost       ${formatCost(costUsd)}`,
      `  context    ${formatTokens(runtime.agent.estimatedTokens)} / ${formatTokens(runtime.model.contextWindow)}`,
      ...(runtime.config.maxCostUsd ? [`  limit      ${formatCost(runtime.config.maxCostUsd)}`] : []),
    ]);
  },
}
```

**Important caveat called out in the sketch's comment**: because
`createCostGuard` in step 3 captures `limitUsd` at `buildRuntime` time (a
plain number, not a getter), a `/cost limit <usd>` issued mid-session will
persist to disk and update `runtime.config.maxCostUsd` for the *next*
process launch, but will **not** retroactively change the ceiling the
already-constructed guard is enforcing unless the integrator either:

1. Changes `CostGuardOptions.limitUsd` usage in `runtime.ts` to read from a
   mutable holder (e.g. `runtime.config.maxCostUsd` directly, re-read on
   every `onEvent` call — trivial since `createCostGuard`'s `options.limitUsd`
   is read fresh inside `onEvent` already, so passing a *closure* —
   `limitUsd: undefined` is not an option since the field is a value, not a
   function; the simplest real fix is to change `CostGuardOptions.limitUsd`
   to accept `number | (() => number | undefined)` — is a follow-up to
   `cost-guard.ts`, not covered by this task's "new files only" constraint,
   so flag it for the next PR), or
2. Documents `/cost limit` as "effective next run" (simplest, matches the
   sketch's own printed message above).

Given the "no existing files touched" constraint on this task, wiring
choice 1 vs 2 is left to whoever implements this integration.

## Files delivered by this task

- `packages/cli/src/cost-guard.ts` — `shouldAbortForCost`, `costLimitMessage`,
  `createCostGuard` (+ `CostGuardOptions`/`CostGuard` types). Zero new deps,
  zero edits to existing files.
- `packages/cli/src/cost-guard.test.ts` — 12 Vitest cases.
- This file.

## Verification run

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/cost-guard.test.ts   # 12 passed
npx tsc -p packages/cli/tsconfig.json --noEmit       # clean (test files are
                                                      # excluded from this
                                                      # project by its own
                                                      # tsconfig; cost-guard.ts
                                                      # and cost-guard.test.ts
                                                      # were additionally
                                                      # typechecked standalone
                                                      # with the same strict
                                                      # compiler options and
                                                      # produced no errors)
npx biome check packages/cli/src/cost-guard.ts packages/cli/src/cost-guard.test.ts  # clean
```
