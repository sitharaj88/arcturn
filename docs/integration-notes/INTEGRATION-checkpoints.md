# Wiring CHECKPOINTS/REWIND into Arcturn

This is a recipe, not a patch. `packages/cli/src/checkpoints.ts` and its test
are the only files this work added; nothing below has been applied to
`runtime.ts`, `commands.ts`, `packages/core`, or anywhere else. It documents
exactly where and how a follow-up change should wire the two together.

## What `checkpoints.ts` provides

```ts
import { createCheckpointStore, wrapToolsWithCheckpoints } from "./checkpoints.js";

const store = createCheckpointStore(dir); // dir: caller-chosen, see below
const turnId = await store.beginTurn(label); // one per user-prompt boundary
// ... tools call store.snapshot(absolutePath) before mutating a file ...
const turns = await store.listTurns(); // [{ id, label, timestamp, fileCount }]
const { restored, deleted, errors } = await store.restore(turnId);
```

`wrapToolsWithCheckpoints(tools, store)` returns a new tool array where the
tools named `"write"` and `"edit"` snapshot their target file (resolved via
`resolvePath(ctx.cwd, input.path)`, imported from `@arcturn/tools`, the
exact same resolution `write.ts`/`edit.ts` use) before delegating to the
original `execute`. Every other tool is returned unchanged (same reference).
A `snapshot()` failure never blocks the tool call — see the TSDoc on
`wrapToolsWithCheckpoints` and `CheckpointStore.snapshot` in `checkpoints.ts`.

Both `@arcturn/tools` and `@arcturn/types` are already dependencies of
`packages/cli`, so nothing new needs to be added to `package.json`.

## 1. Where `runtime.ts` should wrap tools

`buildRuntime()` currently assembles the tool list once, in one place
(`packages/cli/src/runtime.ts`, inside `buildRuntime`):

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

`baseTools` is stored once on `ArcturnRuntime` (`this.#baseTools`) and reused by
every agent the runtime creates afterwards (`#agentOptions()` builds
`tools: [...this.#baseTools, ...this.#mcpTools]` for each new/resumed
`Agent`). **Do not wrap at the `baseTools` call site above.** A checkpoint
store is scoped to one session directory (see §2), but `baseTools` is built
once for the whole runtime, before any session id is known, and is reused
across `startNewSession()` / `resumeSession()` calls that each pick a
*different* session id. Wrapping there would freeze the checkpoint store to
whichever session happened to be current at `buildRuntime()` time.

Instead, wrap where tools are assembled **per agent**, i.e. inside
`ArcturnRuntime#agentOptions()` (and thus `#createAgent()`), right where
`tools: [...this.#baseTools, ...this.#mcpTools]` is currently written:

```ts
// Inside ArcturnRuntime#agentOptions(overrides), after computing sessionId:
const checkpointStore = createCheckpointStore(
  join(this.paths.home, "checkpoints", sessionId),
);
this.#checkpoints = checkpointStore; // keep a handle for the /rewind command
return {
  ...,
  tools: wrapToolsWithCheckpoints([...this.#baseTools, ...this.#mcpTools], checkpointStore),
  ...
};
```

This needs `agentOptions()`/`#createAgent()` to know the session id **before**
constructing the `Agent`, which today they don't for a brand-new session (the
`Agent` constructor calls `createSessionId()` itself when
`options.sessionId` is omitted — see `packages/core/src/agent.ts`). The fix
is for `ArcturnRuntime` to pre-generate the id and pass it explicitly:

```ts
import { createSessionId } from "@arcturn/core"; // already exported from the package index

#createAgent(overrides: { sessionId?: string }): Agent {
  const sessionId = overrides.sessionId ?? createSessionId();
  return new Agent(this.#agentOptions({ ...overrides, sessionId }));
}
```

`createSessionId` is already exported from `@arcturn/core`'s `index.ts`, so
this needs no new dependency either. With this change, every agent the
runtime ever creates — new, resumed, or rewound (see §3) — has a
predictable, pre-known session id, and its checkpoint store directory
(`~/.arcturn/checkpoints/<sessionId>`) can be created up front.

`attachMcpTools()` also calls `this.agent.setTools(...)` directly; that call
site would need the same `wrapToolsWithCheckpoints(..., this.#checkpoints)`
treatment so MCP tool refreshes don't drop checkpointing.

## 2. Storage location

Per the design, the store directory is `~/.arcturn/checkpoints/<sessionId>`,
i.e. `join(paths.home, "checkpoints", sessionId)` using the `ArcturnPaths` from
`packages/cli/src/paths.ts` (`paths.home` is `~/.arcturn` / `$ARCTURN_HOME`). This
mirrors how `paths.sessions` buckets session `.jsonl` files, but keyed by the
literal session id rather than a cwd hash, since a checkpoint history only
ever makes sense for one specific session's timeline.

No cleanup/GC is implemented here. A follow-up should prune
`~/.arcturn/checkpoints/<id>` when its session is deleted, the same way session
files themselves are (or aren't) pruned today — check `JsonlSessionStore`
callers for the existing retention policy before adding one.

## 3. Calling `beginTurn()` at the user-prompt boundary

`Agent.prompt()` (`packages/core/src/agent.ts`) emits a `runStart` event
**before** it appends the new user message to the session:

```ts
const prompt = userMessage(input);
this.#emit({ type: "runStart", sessionId: this.#sessionId, prompt });
// ... only afterwards: await this.#appendMessage(prompt) ...
```

Event listeners run synchronously at `#emit()` time, so a `runStart`
listener observes `agent.leafEntryId` still pointing at the *pre-turn*
branch tip — exactly the id needed for the conversation half of a rewind
(§4). Subscribe at the `ArcturnRuntime` level (`runtime.subscribe`, not
`agent.subscribe`) because that subscription is the one documented to
survive `startNewSession()`/`resumeSession()` swaps:

```ts
runtime.subscribe(async (event) => {
  if (event.type !== "runStart") return;
  const preTurnLeafId = runtime.agent.leafEntryId; // must be read synchronously, here
  const label = firstNChars(textOf(event.prompt), 60);
  const turnId = await runtime.checkpoints.beginTurn(label);
  turnIndex.record(turnId, { sessionId: event.sessionId, leafId: preTurnLeafId });
});
```

(`runtime.checkpoints` and `turnIndex` are both new surface a follow-up
would add — see §4 for why the `{sessionId, leafId}` side-table is needed
and cannot live inside `checkpoints.ts` itself.)

Steered messages (`Agent.steer()`) do **not** get a `runStart` event of
their own — they're folded into the run already in progress. That is
intentional here: a steering message augments the current turn rather than
starting a new one, so it should not begin a new checkpoint turn either.

## 4. The `/rewind` command surface

A slash command follows the shape in `packages/cli/src/commands.ts`
(`SlashCommand`: `{ name, description, run(context) }`, where `context` is
`{ runtime, ui, args, commands }`). Sketch:

```ts
const rewindCommand: SlashCommand = {
  name: "rewind",
  description: "Restore files and conversation to an earlier turn.",
  async run({ runtime, ui }) {
    const turns = await runtime.checkpoints.listTurns();
    const choice = await ui.select(
      "Rewind to…",
      [...turns].reverse().map((t) => ({
        value: t.id,
        label: new Date(t.timestamp).toLocaleTimeString(),
        description: `${t.label} (${t.fileCount} file${t.fileCount === 1 ? "" : "s"})`,
        data: t,
      })),
    );
    if (!choice) return;

    const { restored, deleted, errors } = await runtime.checkpoints.restore(choice.id);
    for (const e of errors) ui.notice("error", `${e.path}: ${e.message}`);
    ui.notice("info", `Restored ${restored.length}, deleted ${deleted.length} file(s).`);

    const link = turnIndex.lookup(choice.id); // see below
    await runtime.rewindConversationTo(link.sessionId, link.leafId); // new ArcturnRuntime method
  },
};
```

### Files vs. conversation: two independent operations, joined by one lookup

`checkpoints.ts` only ever hands back a `turnId` (an opaque, checkpoint-store
local id) from `beginTurn()`/`listTurns()`. It intentionally knows nothing
about `SessionEntry` ids — that keeps it independent of `@arcturn/core`, as
required. So `/rewind` needs a small side-table mapping
`turnId -> { sessionId, leafId }`, populated exactly once per turn at the
`runStart` hook in §3, where both ids are available simultaneously. Two
implementation options for a follow-up:

- **In-memory only**, scoped to the `ArcturnRuntime` instance. Simple, but a
  restart loses the ability to fork the conversation for turns from a
  previous process (file-restore via `checkpoints.ts` alone still works,
  since that reads its own durable manifest).
- **Durable side-file**, e.g. append `{turnId, sessionId, leafId}\n` to
  `~/.arcturn/checkpoints/<sessionId>/session-links.jsonl` next to (but not
  inside) the checkpoint manifest. Rebuildable at load time by reading that
  file back into the in-memory map. This is the recommended approach if
  `/rewind` needs to work across restarts.
- **Fallback with no side-table**: match by timestamp. `store.listTurns()`
  gives each turn's `timestamp`; `sessionStore.entries(sessionId)` gives
  every `SessionEntry`, each with its own `timestamp`. The entry
  immediately preceding the checkpoint turn's timestamp is a reasonable
  `leafId` guess. Less precise (steering, clock skew) — only use this if a
  durable side-table is out of scope for the follow-up.

### Forking the conversation (`packages/core`'s session tree)

`SessionEntry`s form a tree via `parentId` (see `packages/types/src/session.ts`
and `packages/core/src/session/tree.ts`). Rewinding is a **fork**, not a
destructive rewrite: nothing already on disk in the session's `.jsonl` file
is deleted. `Agent.resume({ sessionStore, sessionId, leafId })` already
implements exactly this — "pointing at an older entry starts a new branch
from there" (its own TSDoc). Two cases:

- `leafId` is a real entry id (rewinding to some turn after the session's
  first message): call `Agent.resume({ ...options, sessionStore: runtime.store, sessionId, leafId })`
  and swap the result into the runtime the same way `resumeSession()` does
  today (that method already does `Agent.resume` + `this.#swap(next)` —
  `#swap` is private, so add a sibling method, e.g.
  `rewindConversationTo(sessionId, leafId)`, following the same pattern as
  `resumeSession()`).
- `leafId` is `null` (rewinding to *before* the session's very first
  message — `store.beginTurn()` was called for turn 1 while
  `agent.leafEntryId` was still `null`): `Agent.resume`'s `leafId` option is
  typed `string | undefined`, and `undefined` means "default to the newest
  entry", not "empty branch". For this case, construct a fresh `Agent`
  directly instead of going through `Agent.resume`: same `sessionId`, empty
  `messages`/`todos`/`plan`, and `parentEntryId: null` — i.e. the same shape
  `ArcturnRuntime#createAgent({})` already produces for a brand-new session,
  just reusing the existing `sessionId` rather than minting a new one.

Either way, subsequent turns append as children of `leafId` in the *same*
session file — the pre-rewind branch (later turns that existed before the
rewind) is left completely intact and still reachable by resuming that
`sessionId` with the old, later `leafId`. This mirrors the file side: a
rewind does not erase anything, it only changes what the *current* view
(branch tip / working tree) is.

### Ordering and safety notes for the command implementation

- Call `store.restore(turnId)` before forking the conversation, not after:
  if `restore()` reports `errors`, the command can warn the user before
  the conversation is switched away from the turn that could explain them.
- `restore()` is a direct, synchronous-feeling disk mutation the moment it's
  awaited — there is no "preview" step. A real `/rewind` command should
  confirm with the user first (`ui.select`/a yes-no prompt) before calling
  it, especially since it can delete files (`deleted` in the result).
- Because rewinding is non-destructive on the conversation side but
  *is* destructive on disk (old file content is overwritten in place, not
  just hidden behind a branch pointer), consider calling
  `store.beginTurn("before rewind")` + snapshotting every currently-tracked
  path immediately before `restore()` runs. That turns the "future" state
  (the one being rewound away from) into its own checkpoint, so a user can
  rewind forward again later. `checkpoints.ts` does not do this
  automatically — it only snapshots inside `wrapToolsWithCheckpoints`, which
  only fires on `write`/`edit` calls, not on an explicit `/rewind`. This is
  left to the command implementation to decide.
- `BUILT_IN_TOOL_NAMES` in `runtime.ts` already lists `"write"` and `"edit"`
  as the two mutating built-ins; `wrapToolsWithCheckpoints` intentionally
  hard-codes exactly those two names rather than importing that list, to
  keep `checkpoints.ts` free of any dependency on `runtime.ts`. If a future
  built-in tool starts mutating files, both lists need updating together.

## Summary of the follow-up work (not done here)

1. `runtime.ts`: pre-generate `sessionId` via `createSessionId()` from
   `@arcturn/core` in `#createAgent`; build a `CheckpointStore` per session
   id under `~/.arcturn/checkpoints/<sessionId>`; wrap tools with
   `wrapToolsWithCheckpoints` at every tool-assembly site (`#agentOptions`,
   `attachMcpTools`); expose the current store (e.g. `runtime.checkpoints`)
   and a `rewindConversationTo(sessionId, leafId)` method mirroring
   `resumeSession()`.
2. Somewhere the runtime is driven from (`print.ts`, `interactive/app.ts`, or
   inside `ArcturnRuntime` itself): subscribe to `runStart` and call
   `beginTurn()` there, recording the `{turnId -> sessionId, leafId}` link
   (in-memory or durable side-file per §4).
3. `commands.ts`: register a `/rewind` `SlashCommand` per the sketch in §4,
   including a confirmation step before calling `restore()`.
