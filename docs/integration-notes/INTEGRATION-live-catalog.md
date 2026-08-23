# Wiring the live model catalog into the orchestrator

This describes how another change (in `packages/ai/src/index.ts`, `packages/cli/src/commands.ts`,
`packages/cli/src/runtime.ts`, `packages/cli/src/paths.ts`) would wire up the new
`packages/ai/src/live-catalog.ts` module. **No existing file was edited to produce this
document** — it is a plan for whoever owns those files next, written against their current
contents.

## What was added

- `packages/ai/src/live-catalog.ts` — `discoverModels(presetId, options?)` and
  `refreshCatalog(presetIds, options)`, plus `LiveCatalogError`, `DiscoveredModel`,
  `CachedPresetEntry`, `RefreshOptions`, `RefreshResult`. Pure, no import-time side effects.
- `packages/ai/src/live-catalog.test.ts` — 15 tests, all fetch calls faked.

Neither file is exported from `packages/ai/src/index.ts` yet, and nothing calls them. Three
integration points close that gap.

## 1. Export from the `@arcturn/ai` package index

Add to `packages/ai/src/index.ts`, alongside the existing `presets.js` export block:

```ts
export {
  type CachedPresetEntry,
  discoverModels,
  type DiscoverOptions,
  type DiscoveredModel,
  LiveCatalogError,
  refreshCatalog,
  type RefreshOptions,
  type RefreshResult,
} from "./live-catalog.js";
```

This is the only change required inside `packages/ai`.

## 2. A cache file path under `~/.arcturn`

`packages/cli/src/paths.ts`'s `resolveArcturnPaths()` already builds a `ArcturnPaths` object rooted at
`~/.arcturn` (or `$ARCTURN_HOME`) with fields like `sessionsRoot`, `auth`, `userConfig`. Add a sibling
field the same way:

```ts
liveModelsCache: join(home, "live-models.json"),
```

`refreshCatalog` creates the file's directory on demand, so no extra bootstrap step is needed
beyond having this path available.

## 3. A `/model refresh` action in the CLI's model command

`packages/cli/src/commands.ts` (~lines 186–219) registers a single `model` slash command inside
`createBuiltInCommands()`: `/model <id>` sets the model directly via `runtime.setModel(args)`;
`/model` with no args opens a picker over `listModels()`. Give it a `refresh` subaction:

```ts
if (args.trim() === "refresh") {
  const presetIds = Object.keys(PROVIDER_PRESETS); // from @arcturn/ai
  const { registered, warnings } = await refreshCatalog(presetIds, {
    cacheFile: paths.liveModelsCache,
  });
  for (const warning of warnings) ui.warn(warning);
  ui.info(`Refreshed live catalog: ${registered.length} models known across ${presetIds.length} presets.`);
  return;
}
```

This needs `PROVIDER_PRESETS` and `refreshCatalog` imported from `@arcturn/ai` (both already
exported, or exported per step 1), and the command handler needs access to `paths` (already
threaded through the CLI's runtime/context — the same object `resolveArcturnPaths()` produces).
Restricting `presetIds` to presets whose `apiKeyEnv` is actually set (`listPresets().filter(p =>
p.keyPresent).map(p => p.name)`) avoids firing a network call, however cheap, for every provider
the user has no key for — `discoverModels` already returns `[]` for those, but skipping them
outright avoids the request/timeout entirely.

## 4. Optional: a silent background refresh at startup

`packages/cli/src/runtime.ts` has `registerBundledCatalog()` — idempotent (guarded by a
module-level flag), called once from `packages/cli/src/main.ts:77` and once from
`buildRuntime()` (`runtime.ts:625`). It currently registers the curated preset table and OAuth
providers synchronously before the CLI does anything else.

A background refresh should **not** block that path — discovery is a network call, and `arcturn`
must still start instantly with the curated catalog when offline or when the user just wants to
send one message. Fire it after startup, without awaiting:

```ts
export function registerBundledCatalog(): boolean {
  if (catalogRegistered) return false;
  catalogRegistered = true;
  registerPresetModels();
  registerOAuthProviderFactories();
  registerAnthropicOAuthProvider();

  // Best-effort, non-blocking: refresh the live catalog in the background so a
  // long-running session picks up new models without the user running
  // `/model refresh`. Never let a network hiccup surface as a startup error.
  void refreshCatalog(
    listPresets()
      .filter((p) => p.keyPresent)
      .map((p) => p.name),
    { cacheFile: resolveArcturnPaths().liveModelsCache },
  ).catch(() => {
    // Swallow: refreshCatalog already folds individual preset failures into
    // `warnings` and falls back to stale cache; a rejection here only happens
    // for cache-file I/O errors, which should not crash the CLI.
  });

  return true;
}
```

Because `registerBundledCatalog()` is idempotent and this call is fire-and-forget, it runs at
most once per process and never delays the first prompt. The default `maxAgeMs` (24h) means most
invocations skip the network entirely and just read the on-disk cache.

## Notes for the implementer

- `refreshCatalog` never overwrites a curated `ModelSpec` already registered by
  `registerPresetModels()` — call `registerPresetModels()` first (as `registerBundledCatalog()`
  already does) so curated entries win ties.
- `discoverModels` returns `[]` (not an error) for anthropic-protocol presets whose base URL
  shape is ambiguous (see the long comment in `live-catalog.ts`); only `vercel-gateway` among
  today's presets currently resolves to a real request there.
- `RefreshResult.warnings` are plain strings meant for a CLI log line or the `/model refresh`
  output, not structured errors — the background path above is expected to just drop them.
