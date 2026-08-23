# Integration: git status in the status bar

New files (already created, do not need edits):

- `packages/cli/src/git-status.ts`
- `packages/cli/src/git-status.test.ts`

This document describes the wiring needed elsewhere so the feature is
actually visible in the TUI. Nothing outside the two files above was
touched.

## What `git-status.ts` exports

```ts
export interface GitStatus { branch: string; dirty: boolean; detached: boolean }
export interface GitExecResult { stdout: string; stderr: string }
export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<GitExecResult>;
export interface GitStatusTrackerOptions { ttlMs?: number; execFn?: ExecFn }
export interface GitStatusTracker {
  current(): GitStatus | undefined;
  refresh(): Promise<GitStatus | undefined>;
}

export function createGitStatusTracker(
  cwd: string,
  options?: GitStatusTrackerOptions,
): GitStatusTracker;
```

Behaviour to rely on:

- `current()` is synchronous and **never spawns a process** — it just
  returns whatever `refresh()` last resolved (or `undefined` before the
  first successful `refresh()`). Safe to call on every render.
- `refresh()` spawns `git symbolic-ref --short -q HEAD` (falling back to
  `git rev-parse --short HEAD`, marking `detached: true`) and a capped
  `git status --porcelain --untracked-files=no -z` for the dirty bit, each
  with a 2s timeout. Not a repo, `git` missing, or a timeout all resolve to
  `undefined` — and that negative result is cached for `ttlMs` (default
  `5000`) the same as a positive one, so a non-repo `cwd` doesn't re-spawn
  `git` on every call.
- Concurrent `refresh()` calls made while a fetch is in flight share the
  same promise; no extra spawns.

Nothing here reads config or talks to any other arcturn module, so there is no
`config.ts`/`DEFAULT_CONFIG` change needed — this is purely a status-bar
data source.

## 1. Instantiate the tracker (`packages/cli/src/interactive/app.ts`)

The `App` class already holds long-lived per-session state next to
`#status: StatusBar` (around line 90) and constructs it in the same region
the constructor sets up `this.#status = new StatusBar(...)` (around line
175). Add a sibling field and construct the tracker with the runtime's
working directory (the class already reads `this.#runtime.cwd` elsewhere,
e.g. in `#displayCwd()`):

```ts
import { createGitStatusTracker, type GitStatusTracker } from "../git-status.js";

// field, alongside `#status`:
readonly #gitStatus: GitStatusTracker;

// constructor, alongside `this.#status = new StatusBar(...)`:
this.#gitStatus = createGitStatusTracker(this.#runtime.cwd);
```

No new dependency and no config plumbing: the default `ttlMs` (5000) and
real `execFn` (spawning `git` via `execFile`) are fine for interactive use.

## 2. Render the segment (`#refresh()`, ~line 314)

`#refresh()` builds `this.#status.setOptions({ left: [...], right: [...] })`
today as:

```ts
left: [
  { text: `${this.#glyphs.brand} arcturn`, style: "statusBarAccent" },
  { text: runtime.model.displayName },
  { text: runtime.permissionMode },
],
```

Append a git segment **after the mode segment** (last in the `left` group),
reading only `this.#gitStatus.current()` — never call `refresh()` from
inside `#refresh()`, since `#refresh()` runs synchronously on every
resize/event and must not spawn a process per render:

```ts
left: [
  { text: `${this.#glyphs.brand} arcturn`, style: "statusBarAccent" },
  { text: runtime.model.displayName },
  { text: runtime.permissionMode },
  ...this.#gitSegment(),
],
```

with a small helper next to `#contextSegment()` (~line 338):

```ts
/** The git branch/dirty status segment, omitted entirely when unknown (not a repo yet, or still loading). */
#gitSegment(): StatusSegment[] {
  const status = this.#gitStatus.current();
  if (!status) return [];
  const marker = status.dirty ? "*" : "";
  const text = status.detached ? `${status.branch}${marker}` : `${status.branch}${marker}`;
  return [{ text, style: status.dirty ? "warning" : undefined }];
}
```

(`StatusSegment` is already imported from `@arcturn/tui` wherever
`StatusBar`/`StatusBarOptions` are imported today; add it to that import if
it isn't already there. If detached HEAD should be visually distinguished
from a branch, prefix with e.g. `↯ ` or wrap in parens — cosmetic, no
functional requirement from `git-status.ts` itself.)

## 3. Drive `refresh()` (spawns happen here, not in `#refresh()`)

Call `void this.#gitStatus.refresh().then(() => this.#refresh())` (fire and
forget — a stale git segment for a few seconds is harmless, and `refresh()`
never throws) from three places:

1. **`runStart`** — in the `#onEvent` switch (~line 389, the
   `case "runStart":` block). A run is about to touch files; kick a refresh
   so the dirty marker catches up promptly once the run finishes.
2. **`runEnd`** — in the same switch (~line 416, `case "runEnd":`). This is
   the most important trigger: the agent likely just wrote files, so the
   dirty marker and (rarely) the branch should reflect that as soon as the
   run completes, not up to 5s later.
3. **A slow interval**, alongside the existing `#spinnerTimer` machinery
   (`#startSpinner`/`#stopSpinner`, ~line 447) or as its own
   `setInterval(() => { void this.#gitStatus.refresh().then(() => this.#refresh()); }, 15_000)`
   set up once (e.g. where `this.#unsubscribeResize` is wired, ~line 204)
   and cleared on teardown. This is the catch-all for branch/dirty changes
   that happen outside a arcturn run (the user switching branches or editing
   files in another terminal). Since `refresh()` is a no-op read of the
   cache within its TTL, and the tracker's own 5s TTL already caps real
   spawns, a 10–15s interval is a reasonable default — well above the
   tracker's TTL so each tick actually triggers a fresh spawn.

Do not call `refresh()` from inside the render path (`#refresh()`,
`#renderActivity`, etc.) — only from these event/interval hooks. That
keeps every render cheap (`current()` only) while still refreshing on the
events that actually change git state.

## Verification already run for the new files

- `npx vitest run packages/cli/src/git-status.test.ts` — 9 tests pass (8
  synchronous fake-`execFn` cases plus 1 real-`git` case gated behind a
  `git --version` probe, skipped silently when `git` is unavailable).
- `npx tsc -p packages/cli/tsconfig.json --noEmit` — no errors attributable
  to `git-status.ts`/`git-status.test.ts` (the run surfaces pre-existing,
  unrelated `packages/cli/src/themes.ts` errors from before this change).
- `npx biome check packages/cli/src/git-status.ts packages/cli/src/git-status.test.ts` — clean.
