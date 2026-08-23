---
title: Sessions & persistence from the SDK
description: JsonlSessionStore and MemorySessionStore, resuming a branch, forking, and forcing compaction from code.
section: Extend
order: 9.5
---

[Sessions, branching & compaction](/docs/sessions) covers the tree model conceptually.
This page is the code: constructing a store, resuming, branching, and driving
compaction directly from `@arcturn/core`.

## The two stores

Both implement the same `SessionStore` interface from `@arcturn/types`
(`create`, `open`, `append`, `entries`, `branch`, `list`, `setTitle`):

```ts
import { JsonlSessionStore, MemorySessionStore } from "@arcturn/core";

const disk = new JsonlSessionStore({ dir: ".arcturn/sessions" }); // one .jsonl file per session
const memory = new MemorySessionStore(); // plain in-process maps — tests, ephemeral runs
```

`createAgent({ ..., sessionDir })` builds a `JsonlSessionStore` for you and passes it as
`sessionStore`; passing `sessionStore` directly (to `new Agent(...)` or `createAgent`)
works with either implementation, or your own `SessionStore`.

`JsonlSessionStore` serializes writes per session through an internal queue, so
concurrent appends — background tasks and sub-agents can all be emitting events for the
same session at once — never interleave their bytes. `create` fails with
`SessionStoreError` (`code: "exists"`) if the id is already taken, and `SessionStoreError`
(`code: "invalidId"`) if the id contains anything outside `[A-Za-z0-9._-]+`.

## Resuming a session

```ts
import { Agent } from "@arcturn/core";

const resumed = await Agent.resume({
  ...base,
  sessionStore: store,
  sessionId,
  // leafId: olderEntryId, // omit to resume the newest branch tip
});

await resumed.prompt("Continue where we left off");
```

`Agent.resume` reads every entry for `sessionId`, walks the path to `leafId` (or the
newest entry when omitted), and reconstructs conversation, todos, plan, and the model in
effect at that point via `materializeBranch` — then constructs a normal `Agent` seeded
with that state. The resumed agent's `leafEntryId` starts at the branch tip it resumed
from, so its very next appended entry becomes that node's child.

## Branching

Passing an **older** `leafId` doesn't rewrite anything — it starts a new branch from
that point. Everything after it on the original path stays exactly where it was, still
reachable by resuming from its own leaf:

```ts
import { latestEntryId, pathToLeaf } from "@arcturn/core";

const entries = await store.entries(sessionId); // everything, append order
const tip = latestEntryId(entries); // the newest entry — default resume point
const rootFirst = pathToLeaf(entries, someOlderEntryId); // root-first path to any entry
```

`buildTree(entries)` turns the flat, append-order entry list into an explicit
parent/child `SessionTree`, and `leafEntries(entries)` returns every entry that has no
children — the set of branch tips a "pick a session to resume" UI would list.

## Forcing compaction

Compaction runs automatically before a turn when the conversation crosses the
configured threshold (`AgentOptions.compaction`), and on demand:

```ts
const compacted = await agent.compact(); // true when history was folded into a summary
```

`agent.compact()` throws if a run is in flight — compact between prompts, not during
one. It returns `false` (with a `notice` event, not an error) when there's nothing old
enough to fold: the cut point always lands on a user-message boundary, so a
conversation with no completed turn yet has nothing safe to compact.

| `CompactionOptions` field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to disable automatic compaction; `agent.compact()` still works. |
| `reserveTokens` | `16384` | Headroom kept free in the context window before compaction triggers. |
| `keepRecentTokens` | `20000` | Recent conversation preserved verbatim, never folded. |
| `model` | agent's current model | Model used for the summarization call itself — can be a cheaper model than the one driving turns. |
| `maxOutputTokens` | `4096` | Output budget for the summary. |
| `buildPrompt` | built-in | Replace the summarization prompt entirely. |

The summary is recorded as its own `compaction` session entry (`summary`, `upToId`,
`tokensBefore`, `tokensAfter`), so a later resume reconstructs the exact folded state —
compaction is a tree node like any other, not a destructive rewrite.

```ts
agent.on("compactionEnd", (event) => {
  log(`Compacted ${event.tokensBefore} → ${event.tokensAfter} tokens`);
});
```

## Estimating context usage

```ts
console.log(agent.estimatedTokens); // rough token count of the current conversation
```

`estimateTokens` (also exported directly from `@arcturn/core`) is the same estimator
`shouldCompact` uses internally to decide whether a turn needs to trigger compaction
first — useful for a status bar that wants to show "approaching context limit" before
the agent itself acts on it.

## What isn't SDK-exposed

[Checkpoints & /rewind](/docs/checkpoints) — the automatic pre-edit file snapshots and
`/rewind` — are implemented entirely in `packages/cli/src`, on top of the session tree
primitives documented here. There's no `@arcturn/core` API for them today: a host that
wants equivalent behavior would need to snapshot files itself (e.g. from a `write`/`edit`
tool's permission check or a `beforeToolCall` hook) and drive branching through
`Agent.resume`'s `leafId`, the same mechanism `/rewind` uses.
