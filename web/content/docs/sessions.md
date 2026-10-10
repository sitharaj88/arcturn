---
title: Sessions, branching & compaction
description: The tree-structured session store, resuming, forking a branch, and token-aware compaction.
section: Core concepts
order: 8
---

## Everything is a tree

An arcturn session isn't a flat transcript — it's a tree. Every `SessionEntry` carries a
`parentId`, so appending after an older entry starts a new branch instead of overwriting
what came after it. This is what makes "resume from three turns ago and try a different
approach" a normal operation instead of something that destroys history.

```ts
type SessionEntry =
  | { kind: "message"; id; parentId; timestamp; message }
  | { kind: "compaction"; id; parentId; timestamp; summary; upToId; tokensBefore; tokensAfter; stripTailThinking? }
  | { kind: "label"; id; parentId; timestamp; label }
  | { kind: "state"; id; parentId; timestamp; todos?; plan?; model?; contextEdit? };
```

Four kinds of entry: a conversation `message`, a `compaction` (a summary that folds
everything up to `upToId` into itself), a `label` (a bookmark), and `state` (todos, plan,
or model changes — anything that isn't a message but needs to survive a resume). Two
fields exist so a resume sends the *same request* the live agent sent: a compaction entry's
`stripTailThinking` records that the kept tail was replayed without its thinking, and a
state entry's `contextEdit` (`{ elided, withholdThinking? }`) records one local
[context-editing pass](/docs/context-management#passes-and-the-ledger). Both matter on
models whose thinking is bound to the exact prefix that produced it.

Every entry an `Agent` appends gets a fresh id and a `parentId` set to whatever the
previous append's id was — so the tree isn't something a caller has to construct, it falls
out of the fact that every write records where it came from.

`label` is honest about being aspirational: the type exists, `materializeBranch` (below)
skips over it safely, and a test fixture can construct one — but nothing in the current CLI
ever appends one. There's no `/label` command yet. If you see `kind: "label"` in a session
file, something wrote it by hand or with the SDK directly, not arcturn itself.

## Storage

`JsonlSessionStore` from `@arcturn/core` persists each session as one `.jsonl` file: a
header line, then one JSON line per entry, appended in order. Writes to a single session
are serialized through an internal queue so concurrent appends never interleave —
important once background tasks and sub-agents can all be emitting events for the same
session at once.

```ts
import { JsonlSessionStore } from "@arcturn/core";

const store = new JsonlSessionStore({ dir: ".arcturn/sessions" });
```

`createAgent({ ..., sessionDir: ".arcturn/sessions" })` builds one of these for you.
`MemorySessionStore` is the same interface backed by memory, for tests or fully ephemeral
runs.

On disk, the CLI keeps this under `~/.arcturn/sessions/<cwdHash>/<sessionId>.jsonl` — one
directory per working directory (hashed, not the literal path), so `arcturn --continue` in
one repo never lists sessions started in another. `JsonlSessionStore.list()` returns every
session header in that directory, newest first; a missing or partially-written file is
skipped rather than failing the whole listing. `setTitle` rewrites the header line (through
a temp file plus rename, so a crash mid-write can't corrupt it) — that's how a session
picks up a human-readable title.

## Session titles

After an **interactive** session's first **completed** run, Arcturn makes one small LLM
call — on the `title` route, so it can be a cheap model (see
[Model routing](/docs/model-routing#route-kinds)) — and writes a short generated title
onto the header. That title is what `/sessions` and the startup splash's recent-sessions
block show instead of a bare session id. The call is fire-and-forget: a failed title never
breaks or slows a run, and a session is never re-titled — one attempt, first completed run
only. Sessions that already carry a title (resumed ones, sub-agent scratch sessions) are
left alone, and nothing retroactively scans old sessions: an untitled session from before
this feature keeps its first prompt as its label until the next time it completes a run
interactively. Only the interactive TUI titles sessions — `--print`, `serve` and `acp`
runs never make the extra call, because their provider-visible request streams are
contractual (cassettes, replay, request-count guarantees). Set `"sessionTitles": false`
in `.arcturn/config.json` to turn the call off entirely.

A crash mid-append leaves a torn last line. `entries()` recovers from that by dropping an
unparsable *final* line and returning everything before it; a parse failure anywhere
earlier in the file is treated as real corruption and throws.

## Branching

```ts
const entries = await store.entries(sessionId);       // everything, append order
const leaf = latestEntryId(entries);                    // the newest entry — default tip
const branch = pathToLeaf(entries, someOlderEntryId);   // root-first path to any entry
```

Resuming from the newest entry continues the conversation you'd expect. Resuming from an
**older** entry — passing `leafId` to `Agent.resume` — starts a **new branch** from that
point: everything after it on the original path is left alone, untouched, still walkable
by anyone resuming from its own leaf.

```ts
const agent = await Agent.resume({
  llm, model, systemPrompt, tools, cwd,
  sessionStore: store,
  sessionId,
  leafId: someOlderEntryId, // omit to resume the latest branch tip
});
```

`materializeBranch` replays a root-first entry list back into the conversation and state
an `Agent` needs to resume: messages (with compactions folded into a single synthetic
summary message), the current todos, the current plan, and the model in effect at that
point, plus the local context-editing ledger when passes were recorded
(`MaterializedBranch.contextEdit`), so the resumed agent sends the stubs the live one did.

## Message shapes you will meet in a stored session

Three shapes are newer than the user / assistant / tool-result trio:

- **`role: "system"`** — an operator message: text the harness, not you, said to the model.
  The turn-budget warning, a progress check, the silent-turn nudge and the stale-todo
  reminder are stored this way (`{ role: "system", content: TextContent[], timestamp }`).
  It is stored model-neutral and rendered at send time — natively where the model takes a
  mid-conversation `system` role, folded into the neighbouring user turn elsewhere; see
  [Providers](/docs/providers#mid-conversation-system-messages). `/export` renders each as
  an **Operator** section, and `arcturn serve` replays it as an info notice. Before this
  they were stored as `user` messages the user never typed.
- **`compaction` content** in an assistant message — `{ type: "compaction"; summary: string
  | null; encryptedContent: string | null }`: the provider compacted the conversation
  (`shape: "server"`), and the block is replayed to it verbatim. Exports show "The provider
  compacted the conversation here" with the summary folded away.
- **`serverTool` content** — `{ type: "serverTool"; provider; block }`: a block the
  provider ran itself, such as native tool search, kept as it arrived and replayed
  verbatim. Exports show a one-line "Server tool: …" note.

An assistant message may also carry `inputTransformations` when the provider reported
changing the request before running it (for example, setting aside a thinking block whose
prefix changed). Only a non-empty list is recorded.

## Resuming from the CLI

```bash
arcturn -c                    # --continue: resume the newest session for this cwd
arcturn -r <sessionId>        # --resume: resume a specific session by id
```

`--resume` and `--continue` are mutually exclusive — passing both is a parse error.
Both resume the session's *latest* branch tip; there's no `--leaf <id>` flag today, so
jumping to an older branch from the command line means going through `/rewind` once
you're already in the session (see [Checkpoints & /rewind](/docs/checkpoints)), which
forks the conversation at a chosen turn rather than continuing from the newest one.

Inside a running session, `/sessions` lists up to 50 stored sessions for the current
directory (newest first, each row showing its creation time and its
[generated title](#session-titles) — or its id, for sessions that never got one) and
resumes whichever one you pick — the interactive equivalent of `--resume`.

## Exporting a transcript

`/export [html] [--thinking]` writes the current conversation to
`arcturn-session-<yyyy-MM-dd-HHmm>.md` (or `.html` with the `html` argument) in the
working directory. `exportMarkdown`/`exportHtml` in `export.ts` are pure functions over
the message list — no session-store or filesystem access — so what gets written is
exactly what's in memory for the live agent, not a re-read of the JSONL file. Tool
results are capped at 200 lines each before a truncation marker, and `thinking` content
blocks are included only when `--thinking` is passed.

## Compaction

Long sessions eventually threaten to overflow the model's context window. Before that
happens, Arcturn replaces the older part of the conversation with a structured markdown
summary and keeps going — automatically, or on demand via `agent.compact()`.

The summarizer is prompted to preserve **everything a fresh agent would need to
continue**: file paths, identifiers, decisions made and why, outstanding problems — in
fixed sections (`Goal`, `Progress`, `Key decisions`, `Next steps`, `Critical context`, and
`Reasoning to carry forward`), not a vague paraphrase. The last one exists because the
transcript the summarizer reads omits the assistant's thinking: it records the hypotheses
being tested, what was ruled out and what was about to be tried.

### Shapes

`CompactionOptions.shape` (config key `compaction.shape`) chooses what is kept:

| `shape` | Result | Default for |
|---|---|---|
| `simple` | One summary replaces everything. Only a trailing run of user and operator messages — the new request — is kept. | Claude 4.6 and later on `anthropic`, `anthropic-compatible`, `bedrock`, `vertex`. |
| `keep-tail` | A summary plus roughly the most recent `keepRecentTokens` of turns, cut at a user-message boundary. On adaptive Claude the kept tail is replayed without its thinking. | Every other model. |
| `server` | The provider compacts (`compact_20260112`); arcturn replays the returned `compaction` block verbatim. `agent.compact()` says there is nothing to summarize locally. | Opt in; Claude API only. |

The reason for the split is [preserved thinking](/docs/providers#preserved-thinking): on
the newest Claude models a thinking block only validates against the exact prefix that
produced it, and a summary replaces that prefix. See
[Context management](/docs/context-management#layer-3-compaction) for the full argument.
`arcturn doctor` prints the shape in effect and why.

Tuning knobs (`AgentOptions.compaction`, or `CompactionOptions` directly):

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to disable automatic compaction entirely. |
| `reserveTokens` | `16384` | Headroom kept free in the context window. |
| `keepRecentTokens` | `20000` | Recent conversation preserved verbatim, uncompacted. |
| `model` | agent's current model | Model used for the summarization call itself. |
| `maxOutputTokens` | `4096` | Output budget for the summary. |
| `buildPrompt` | built-in | Replace the summarization prompt entirely. |
| `shape` | per model | `"simple"`, `"keep-tail"` or `"server"` — see above. |

Under `keep-tail` the cut point lands on a user-message boundary — never between an
assistant's tool call and its result — and no shape folds an open tool round (a tool call
still waiting on its result), so a compaction can never produce a conversation the model
would see as malformed. Compaction is recorded as its own `compaction` entry in the
session tree (with `tokensBefore` / `tokensAfter` for observability, and `stripTailThinking`
when a kept tail lost its thinking), so replaying the branch later reconstructs the exact
same folded state.

```ts
agent.subscribe((event) => {
  if (event.type === "compactionEnd") {
    console.log(`Compacted ${event.tokensBefore} → ${event.tokensAfter} tokens`);
  }
});

const compacted = await agent.compact(); // force it now, regardless of the threshold
```

### A refused turn

If the model declines a request (`stopReason: "refusal"`, see
[Providers](/docs/providers#refusals-and-server-side-fallbacks)), the assistant message is
recorded in the session like any other, with its `stopDetails`, and the turn ends — no
retry nudge, and any tool calls in it are stripped and never run. When the branch is next
sent to a provider that refused message is skipped rather than replayed, so a declined
request does not poison the conversation that follows it. A compaction whose summary the
model refuses fails with an error instead of installing the partial text as the summary;
the history it would have folded is left as it was.

## Related

- [Checkpoints & /rewind](/docs/checkpoints) — the file-restore side of branching: what
  actually changes on disk when you fork the conversation at an older turn.
- [Provenance & arcturn blame](/docs/provenance) — attributes each line of a file to the
  turn (and prompt) that wrote it, built on the same "everything traces to a turn" idea.
- [Replay & bisect](/docs/replay-bisect) — re-runs a session's prompts (`extractPrompts`
  walks the same entry list this page describes) against a live model or a cassette.
- [Audit & cost](/docs/audit-cost) — the accountability trail and spend accounting that
  ride alongside a session rather than living inside it.
- The [accountability feature page](/features/accountability) has a diagram of the tree
  shape and the same commands in context.
