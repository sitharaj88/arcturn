# Wiring DRY-RUN OVERLAY MODE into the CLI

This document is the integration recipe for `packages/cli/src/overlay.ts`
(new file, already in the tree with `overlay.test.ts`). Per the task's hard
rules, **no existing file was edited** to produce this feature — the snippets
below are exact instructions for whoever wires the overlay into `config.ts`,
`args.ts`, `runtime.ts` and `commands.ts`.

"Plan mode for files": with dry-run on, every `write`/`edit` lands in a shadow
copy of the workspace, the agent reads its own pending edits back, and at the
end the user sees **one** aggregate diff and applies or discards it.

## What's already built

`packages/cli/src/overlay.ts` exports:

- `createOverlay({ cwd, dir }): Overlay` — `dir` is the shadow root; the
  integration passes `~/.arcturn/overlays/<sessionId>`. The directory is created
  lazily, so an overlay nothing was written through leaves no trace on disk.
- `Overlay`:
  - `redirect(absPath): string` — `<cwd>/src/a.ts` → `<dir>/src/a.ts`,
    preserving the relative structure. **Paths outside `cwd` are returned
    unchanged**: the overlay only shelters the workspace. Redirecting
    `/etc/hosts` or `~/.ssh/config` would silently swallow a write the user
    never asked to sandbox (and would require inventing a mapping for an
    arbitrary absolute path), so those keep going where the tool intended and
    the permission engine stays the thing that gates them. `cwd` itself is a
    directory, not a sheltered file, so only strict descendants map in.
  - `materialize(absPath): Promise<void>` — copies the real file into the
    shadow on first touch. No-op when the path is not sheltered, when a shadow
    copy already exists (pending edits are never clobbered), or when the real
    file does not exist (a brand-new file is simply created in the shadow).
  - `changes(): Promise<OverlayChange[]>` — every shadow file that differs
    from its real counterpart, sorted by path:
    `{ path, kind: "added" | "modified", before: string | null, after: string }`.
    `path` is the **real** workspace path. A materialized-but-never-edited file
    is byte-identical and is therefore not a change. `[]` when the shadow tree
    does not exist yet.
  - `diff(): Promise<string>` — one unified diff across every change, paths
    relative to `cwd`, 3 lines of context, own LCS implementation (no dep, with
    the same 4M-cell "treat the file as wholly replaced" fallback
    `packages/tools/src/diff.ts` uses). Added files diff against `--- /dev/null`.
    Each file's body is capped at `MAX_DIFF_LINES_PER_FILE` (200) followed by a
    `... diff truncated: N more lines for <path>` marker. `""` when nothing is
    pending.
  - `apply(): Promise<{ applied: string[]; errors: { path, message }[] }>` —
    writes each change back over the real file via temp-file + rename in the
    destination directory, so an interrupted apply cannot leave a half-written
    file. One path failing does not stop the others. The shadow tree is left in
    place; call `discard()` after if you want it emptied.
  - `discard(): Promise<void>` — `rm -rf` on the shadow tree; safe when it was
    never created.
- `wrapToolsWithOverlay(tools, overlay): Tool[]` — wraps `write`, `edit` and
  `read`; every other tool is returned as the exact same object.
  - `write`/`edit`: `materialize(realPath)` first, then execute with
    `{ ...input, path: shadowPath }`. The real file is never opened for writing.
  - `read`: rewritten **only when a shadow copy already exists**, so the agent
    sees its own pending edits and falls through to the real file for
    everything it has not touched. `read` never materializes — that would fill
    the overlay with identical copies for no benefit.
  - A `materialize` failure does **not** un-redirect the write. Falling back to
    the real path would break the dry-run promise exactly when something is
    already wrong; the tool instead fails visibly (`edit` → "File not found").
- `formatOverlayDiff(label, before, after)` and `MAX_DIFF_LINES_PER_FILE`, for
  a UI that wants to render one file at a time.

20 unit tests cover: redirect mapping and outside-cwd/sibling-prefix/cwd-itself
passthrough; materialize copying once and never clobbering pending edits;
materialize no-op for an absent file and an unsheltered path; write-through
leaving the real file untouched; edit reading the materialized copy; read
seeing the shadow and falling back to the real file; unsheltered writes going
straight to disk; `changes()` added-vs-modified with correct `before`/`after`
and ignoring identical copies; `diff()` shape for add + modify and its
truncation marker; `apply()` writing back, reporting a per-path error while
still applying the rest, and leaving nothing pending afterwards; `discard()`
removing the tree and being safe when absent; and non-write/edit/read tools
passing through by reference.

## 1. `packages/cli/src/config.ts` — add `dryRun`

**Interface** (next to `audit`, currently line ~66):

```ts
export interface ArcturnConfig {
  // …
  /**
   * Dry-run overlay: file mutations go to a shadow copy of the workspace
   * instead of the real one, reviewed with /diff and resolved with
   * /apply or /discard (default `false`).
   */
  dryRun: boolean;
}
```

**`DEFAULT_CONFIG`** (line ~92): add `dryRun: false,` — a required boolean with
a default, exactly like `audit`.

**`KNOWN_KEYS`** (line ~107): add `"dryRun"`.

**`parseConfigFile`** (next to the `raw.audit` block, line ~287):

```ts
if (raw.dryRun !== undefined) {
  if (typeof raw.dryRun === "boolean") out.dryRun = raw.dryRun;
  else warnings.push(`${where}: "dryRun" must be a boolean`);
}
```

**`mergeConfig`** (line ~325): `dryRun: layer.dryRun ?? base.dryRun,` — a
scalar the higher layer replaces, like `audit`/`lsp`/`sandbox`.

No `applyEnv` change (no `ARCTURN_DRY_RUN` was requested; add one there if wanted).

## 2. `packages/cli/src/args.ts` — `--dry-run`

- `CliArgs`: `/** \`--dry-run\`: route file mutations to a shadow workspace. */ dryRun: boolean;`
- `defaultArgs()`: `dryRun: false,`
- The flag takes no value, so nothing goes in `VALUE_FLAGS`. Add two cases next
  to `--mcp`/`--no-mcp` (line ~285), which is the established shape for a
  negatable boolean:

```ts
case "--dry-run":
  args.dryRun = boolValue;
  break;
case "--no-dry-run":
  args.dryRun = false;
  break;
```

- Help text (line ~400ish, with the other flags):
  `  --dry-run                     Route file writes to a shadow workspace; review with /diff.`
- `main.ts` passes it into `buildRuntime` alongside the other overrides:
  `...(args.dryRun ? { dryRun: true } : {})`.

## 3. `packages/cli/src/runtime.ts` — construct and wrap

Import next to the checkpoints import (line ~70):

```ts
import { createOverlay, type Overlay, wrapToolsWithOverlay } from "./overlay.js";
```

`BuildRuntimeOptions` gains `/** \`--dry-run\`: shadow every file mutation. */ dryRun?: boolean;`
and `ArcturnRuntimeInit` gains `overlay: Overlay | undefined;` next to `lsp`.
`ArcturnRuntime` gains the public field next to `lsp`:

```ts
/** Dry-run shadow workspace when dry-run mode is on, else undefined. */
readonly overlay: Overlay | undefined;
```

set from `init.overlay` in the constructor next to `this.lsp = init.lsp;`.

### 3a. Create it

The overlay is per **invocation**, not per session, so build it in
`buildRuntime` right after `initialSessionId` is minted (line ~884, where the
audit log is built from the same id):

```ts
const initialSessionId = createSessionId();
const audit = config.audit ? createAuditLog(auditFilePath(paths, initialSessionId)) : undefined;
const dryRun = options.dryRun ?? config.dryRun;
const overlay = dryRun
  ? createOverlay({ cwd: paths.cwd, dir: join(paths.home, "overlays", initialSessionId) })
  : undefined;
```

Deliberately **not** re-created in `#agentOptions` the way the checkpoint store
is: `/clear` and `/sessions` mint a new session id, and pending file changes
should not silently vanish because the conversation was cleared. One overlay
lives for the whole `arcturn` process, and `/apply`/`/discard` are the only things
that resolve it.

### 3b. Wrap order

Insert the overlay wrap in `buildRuntime`'s wrap chain (lines 893-903), between
verify and hooks:

```ts
const lsp = config.lsp === "on" ? createLspManager({ cwd: paths.cwd }) : undefined;
const toolsWithSymbols = lsp ? [...baseTools, createSymbolsTool(lsp)] : baseTools;
const lspTools = lsp ? wrapToolsWithLsp(toolsWithSymbols, lsp) : toolsWithSymbols;
// Verify runs the project's check command against the REAL tree, which the
// overlay is deliberately not changing — so in dry-run it would report on
// code the model did not write. Skip it rather than lie. (See "verify" below.)
const verifier = config.verify && !overlay
  ? createVerifier(config.verify, { cwd: paths.cwd, env })
  : undefined;
if (config.verify && overlay) {
  warnings.push("Dry-run mode is on; the verify command is disabled until you /apply.");
}
const verifiedTools = verifier ? wrapToolsWithVerify(lspTools, verifier) : lspTools;
const overlaidTools = overlay ? wrapToolsWithOverlay(verifiedTools, overlay) : verifiedTools;
const hookedTools = wrapToolsWithHooks(overlaidTools, hookRunner);
```

The resulting onion, outermost first:

```
wrapToolsWithCheckpoints   (per-agent, in #agentOptions — sees the REAL path)
  └─ wrapToolsWithHooks         (preToolUse can veto; matchers see the REAL path)
      └─ wrapToolsWithOverlay   (rewrites input.path -> shadow path)
          └─ wrapToolsWithVerify    (disabled in dry-run, see above)
              └─ wrapToolsWithLsp   (sees the SHADOW path, reads pending content)
                  └─ raw write/edit/read
```

Why each boundary sits where it does:

- **Inside hooks.** A `preToolUse` matcher on `write`'s path (`src/**`,
  `*.env`, …) must match the file the user thinks is being written, not
  `~/.arcturn/overlays/<id>/src/…`. Hooks wrapping outside the overlay means every
  existing hook config keeps working verbatim in dry-run mode, and a `deny`
  short-circuits before the overlay ever materializes anything.
- **Inside checkpoints.** `wrapToolsWithCheckpoints` wraps per-agent in
  `#agentOptions`, outermost of everything, so it snapshots the *real* file's
  pre-image at the moment the model decided to change it. That is exactly the
  pre-image `/rewind` needs **after** an `/apply`, so dry-run and rewind
  compose instead of fighting. During the run itself the snapshots are
  redundant (nothing real is mutated) but cheap and content-addressed.
- **Outside LSP.** `lsp/wrap.ts` re-reads `resolvePath(ctx.cwd, input.path)`
  after a successful edit. With the overlay outside it, `input.path` is already
  the shadow path, so diagnostics are computed on the **pending** content —
  which is the whole point of dry-run. Caveat: the shadow file lives outside
  the project root, so a language server may not apply the project's
  `tsconfig.json`/settings to it and diagnostics can be noisier than usual. If
  that noise is worse than staleness for a given project, swap the two wraps —
  LSP then reads the untouched real file and reports pre-edit diagnostics.
  Nothing else in this document depends on that ordering.
- **Outside verify** (and disabled anyway). `verifier.maybeRun` spawns the
  project's command in the real `cwd`; with the workspace untouched it would
  cheerfully pass on code the model never wrote. Reporting "verify passed" for
  an unapplied change is worse than not running it, hence the skip + warning
  above. The natural follow-up is running verify once from the `/apply`
  command, after the writes land.

### 3c. Sub-agents and MCP

`createSubagent` filters `this.#baseTools`, which is the already-wrapped
`hookedTools` list, so a sub-agent's `write`/`edit` is sheltered by the same
overlay with no extra wiring.

`attachMcpTools` re-wraps only with hooks and checkpoints, matching what
`wrapToolsWithLsp`/`wrapToolsWithVerify` already do. An MCP filesystem server
therefore writes to the **real** tree in dry-run mode. That is the same class
of hole as `bash` (below); if you want MCP covered too, add
`wrapToolsWithOverlay` inside `attachMcpTools` — it only touches tools literally
named `write`/`edit`/`read`, so it is a no-op for everything else.

### 3d. Permission prompts show shadow paths

`write`/`edit` build their permission `subject`, description and
`suggestedRule` from the path they receive — which in dry-run is the shadow
path. Two honest fixes, pick one:

1. **Display mapping (recommended).** In the permission dialog, if
   `runtime.overlay` is set and the subject starts with `runtime.overlay.dir`,
   render `join(runtime.cwd, relative(runtime.overlay.dir, subject))` instead.
   The rule that gets persisted is still shadow-scoped, so also rewrite the
   `suggestedRule.specifier` the same way before persisting.
2. **Session rule.** Seed `config.permissions` with session-scoped
   `{ tool: "write" | "edit", specifier: "<overlayDir>/**", action: "allow" }`
   when dry-run is on. Simpler, but it removes the per-file prompt — defensible
   because nothing real is being mutated, and every change still has to survive
   the `/diff` review before it touches disk. Do **not** do this silently;
   print a notice at startup.

## 4. `packages/cli/src/commands.ts` — `/diff`, `/apply`, `/discard`

All three are inert without an overlay. Insert next to `/rewind` (line ~365),
matching its exact shape (`run({ ui, runtime })`, `source: "built-in"`):

```ts
{
  name: "diff",
  description: "Show the file changes pending in dry-run mode",
  source: "built-in",
  async run({ ui, runtime }) {
    const overlay = runtime.overlay;
    if (!overlay) {
      ui.notice("info", "Dry-run mode is off; changes are written straight to disk.");
      return;
    }
    const changes = await overlay.changes();
    if (changes.length === 0) {
      ui.notice("info", "No pending changes.");
      return;
    }
    const added = changes.filter((c) => c.kind === "added").length;
    ui.print(await overlay.diff());
    ui.print(
      `${changes.length} file${changes.length === 1 ? "" : "s"} pending ` +
        `(${added} added, ${changes.length - added} modified). ` +
        "/apply to write them, /discard to throw them away.",
    );
  },
},
{
  name: "apply",
  description: "Write the pending dry-run changes to the real workspace",
  source: "built-in",
  async run({ ui, runtime }) {
    const overlay = runtime.overlay;
    if (!overlay) {
      ui.notice("info", "Dry-run mode is off; there is nothing to apply.");
      return;
    }
    if (runtime.agent.isRunning) {
      ui.notice("warn", "A run is in progress; press Esc to interrupt it before applying.");
      return;
    }
    const changes = await overlay.changes();
    if (changes.length === 0) {
      ui.notice("info", "No pending changes.");
      return;
    }
    const choice = await ui.select(`Apply ${changes.length} file change(s)?`, [
      { value: "apply", label: "Apply to the workspace", data: true },
      { value: "cancel", label: "Cancel", data: false },
    ]);
    if (choice !== true) return;
    const result = await overlay.apply();
    for (const failure of result.errors) ui.notice("error", `${failure.path}: ${failure.message}`);
    ui.notice("info", `Applied ${result.applied.length} file(s), ${result.errors.length} failed.`);
    // Only clear the shadow tree when everything landed, so a partial failure
    // keeps the un-applied edits reviewable and retryable.
    if (result.errors.length === 0) await overlay.discard();
  },
},
{
  name: "discard",
  description: "Throw away the pending dry-run changes",
  source: "built-in",
  async run({ ui, runtime }) {
    const overlay = runtime.overlay;
    if (!overlay) {
      ui.notice("info", "Dry-run mode is off; there is nothing to discard.");
      return;
    }
    const changes = await overlay.changes();
    if (changes.length === 0) {
      ui.notice("info", "No pending changes.");
      return;
    }
    const choice = await ui.select(`Discard ${changes.length} file change(s)?`, [
      { value: "discard", label: "Discard them", data: true },
      { value: "cancel", label: "Keep them", data: false },
    ]);
    if (choice !== true) return;
    await overlay.discard();
    ui.notice("info", `Discarded ${changes.length} pending file change(s).`);
  },
},
```

Two further UI touches worth having (both optional, neither needs `overlay.ts`
to change):

- Status line: `runtime.overlay ? "dry-run" : ""` next to the permission mode,
  plus the pending-file count from `changes()`, so nobody forgets the mode is on.
- Exit: if pending changes exist when the user quits, prompt once —
  the shadow tree survives under `~/.arcturn/overlays/<sessionId>` either way, but
  nothing re-attaches to it on the next launch (see "Not covered", below).

## The `bash` boundary — read this before shipping

**`bash` is not wrapped, and a shell command still mutates the real workspace.**
This is a documented boundary of dry-run mode, not a silent hole:

- `bash` takes a command string, not a `path`. Making it honour the overlay
  would mean either running every command with `cwd` pointed at the shadow tree
  — which breaks the instant a command touches anything the shadow does not
  contain (`node_modules`, `.git`, config, binaries) — or parsing shell to find
  writes, which cannot be done correctly. Neither is a trade worth making
  silently.
- So: `sed -i`, `npm install`, `git checkout`, `> file`, `rm`, a formatter, a
  codegen script — all hit the real tree, immediately and irreversibly by
  `/discard`. `/rewind` (checkpoints) is unaffected and remains the recovery
  path for those, since checkpoints wrap outermost.
- `grep` and `glob` are likewise unwrapped: they **read** the real tree, so the
  agent's search results are stale with respect to its own pending edits (a
  newly added file will not appear in `glob`, and `grep` matches pre-edit
  content). Only `read` is overlay-aware.

Make this visible in three places, all outside `overlay.ts`:

1. **System prompt** — append when dry-run is on (via
   `collectSystemPromptContext`'s `append`, so it needs no new plumbing):

   > Dry-run mode is ON. Your `write` and `edit` changes go to a shadow copy of
   > the workspace and are reviewed by the user before they are applied; `read`
   > shows you your pending edits. `bash`, `grep` and `glob` operate on the
   > real, unmodified workspace — do not use shell commands to modify files,
   > and expect search results to predate your edits.

2. **Startup notice** — one line naming the mode and the `/diff` command.
3. **Permission prompt for `bash`** — when `runtime.overlay` is set, prefix the
   description with `(dry-run does NOT cover bash — this runs for real)`.

## Not covered by this task

- **No resume.** Nothing re-attaches to `~/.arcturn/overlays/<id>` on the next
  launch; a killed process leaves an orphan tree. A cleanup sweep (drop
  overlay directories older than N days, next to whatever prunes checkpoints)
  and an optional `--resume-overlay <sessionId>` are the natural follow-ups.
- **Text only.** `changes()`/`diff()`/`apply()` read and write UTF-8.
  `materialize` copies bytes faithfully, so a binary file survives a
  round-trip untouched *if the agent does not edit it*; an edited binary would
  be re-encoded on apply. The built-in `write`/`edit` tools are text-only
  anyway, so this only matters for an extension tool named `write`.
- **No deletions.** The overlay models added and modified files; there is no
  "shadow tombstone" for a deleted one, because no built-in tool deletes files
  (deletion happens via `bash`, which is outside the boundary anyway).

## Files delivered by this task

- `packages/cli/src/overlay.ts` — `Overlay`, `OverlayChange`,
  `OverlayApplyError`, `OverlayApplyResult`, `CreateOverlayOptions`,
  `createOverlay`, `wrapToolsWithOverlay`, `formatOverlayDiff`,
  `MAX_DIFF_LINES_PER_FILE`. Zero new deps, zero edits to existing files.
- `packages/cli/src/overlay.test.ts` — 20 Vitest cases.
- This file.

## Verification run

```
cd /Users/sitharaj/Documents/ai_agent_harness/arcturn
npx vitest run packages/cli/src/overlay.test.ts   # 20 passed
npx tsc -p packages/cli/tsconfig.json --noEmit    # clean
npx biome check packages/cli/src/overlay.ts packages/cli/src/overlay.test.ts  # clean
```
