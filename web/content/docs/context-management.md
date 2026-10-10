---
title: Context management
description: Tool-output offloading, tool-result context editing, and how both compose with compaction as a backstop.
section: Core concepts
order: 8.1
---

## Three layers, three timescales

Arcturn keeps a run inside its context window with three mechanisms that fire at
different times and cost different amounts:

1. **Offloading** (`packages/core/src/offload.ts`) — runs the moment a tool result comes
   back, before it ever enters the conversation. An oversized result is written to disk
   and replaced with a stub. On by default.
2. **Context editing** (`packages/core/src/context-edit.ts`) — old tool results already
   sitting in history have their content replaced with a one-line stub, either by arcturn
   in rare recorded passes or by the provider, server-side. The stored history is
   untouched. On by default.
3. **Compaction** (see [Sessions, branching & compaction](/docs/sessions)) — the backstop.
   It pays for a summarization call and replaces history with a summary when the other two
   aren't enough. On by default, and unaffected by either of the above: it measures the
   raw, unedited message list.

The ordering matters: offloading shrinks what a result *is* at the source. Context editing
shrinks what an already-large history *sends*. Compaction is the only one of the three
that discards history. Each is strictly cheaper than the next, so arcturn tries them in
that order before a run ever needs the expensive one. All three are built so the outgoing
conversation only grows at the end — see [Why history is append-only](#why-history-is-append-only).

## Layer 1: tool-output offloading

When a tool answers with more text than is worth spending context on, arcturn writes the
**whole** answer to a file and hands the model a stub — head, tail, exact byte/line
counts, and the absolute path — instead of truncating the output or letting it eat half
the window. The stub tells the model to `read` or `grep` the file rather than re-run the
tool.

Wired as the innermost tool wrapper, closest to `execute()`, inside every other wrapper
(LSP, verify, taint, canary, hooks). That's deliberate: anything an outer wrapper *adds* to
a result — an LSP diagnostic, a `[taint] WARNING:` line — stays inline where the model
reads it, because offloading only ever sees (and can only shrink) what came back from the
tool itself.

```jsonc
// arcturn config — default shown
{
  "offload": "on",                 // "off" to disable entirely
  "offloadLimits": {
    "maxChars": 16000,             // combined text length that triggers an offload
    "keepHead": 4000,              // excerpt kept from the start
    "keepTail": 1000,              // excerpt kept from the end
    "exclude": ["read"]            // tool names never offloaded
  }
}
```

`read` is excluded by default: it already self-limits (2,000-line cap, per-line
truncation, auto-outline past 16 KB), it's the very tool the stub tells the model to use,
and offloading a file read would write a second copy of a file already on disk. Add other
self-bounding tools (`ls`, a paginated MCP tool) to `exclude` for the same reason — but
leave `bash`, `grep`, and MCP tools offloadable; they're the actual source of runaway
output.

Files land under `<home>/offload/<sessionId>/`, outside the project working directory —
deliberately not under `cwd`, since offloaded output is machine state, not something to
commit or see in `git status`. The directory is created lazily on first offload, so a
session that never overflows leaves no trace, and nothing in the module deletes files —
retention is a host-level decision, the same as `checkpoints/`.

A write failure (`ENOSPC`, `EACCES`, a bad directory) falls back to returning the original,
untruncated result rather than losing the data or throwing — the worst case is the same as
having offload off. `read` requires no permission, so the round trip works even for a
read-only sub-agent.

## Why history is append-only

On Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block's signature is
bound to the exact prefix that produced it: the system prompt, the tool set and every
earlier message. Replay the block after any of those changed and an account created on or
after 2026-08-31 gets a 400; an account the check does not enforce is let through, and the API
reports that an enforced one would have refused. The same property is what makes the prompt cache work — a cached prefix only
hits when every earlier byte is identical — so a rewrite of already-sent history costs you
the cache on every model and the thinking on these.

Arcturn used to rewrite that prefix in four places. Each now only appends:

| What rewrote the prefix | What it does now |
|---|---|
| Per-request tool-result elision | Batched, recorded **passes**; between passes the history is identical to what was sent. See [Layer 2](#layer-2-context-editing). |
| Keep-tail compaction | Defaults to a **simple** shape on Claude with adaptive thinking: one summary, nothing earlier replayed. See [Layer 3](#layer-3-compaction). |
| `tool_search` activation growing the `tools` array | On first-party Anthropic, the provider's **native** tool search keeps the array fixed. See [Deferred tools](/docs/deferred-tools#native-tool-search). |
| Operator text injected as user turns | Stored as **system messages** and rendered per model; the harness no longer impersonates you. See [Providers](/docs/providers#mid-conversation-system-messages). |

Where a rewrite is unavoidable — a pass, a compaction, a changed tool set — arcturn stops
replaying the thinking the rewrite invalidated rather than sending a block the API will
reject, and tells you when it happens.

## Layer 2: context editing

Context editing replaces the *content* of tool results that have fallen outside the
trailing window with a one-line stub
(`[context-edited: the "read" result (5000 characters) was elided …]`), leaving the
message itself — role, `toolCallId`, `toolName`, `isError`, timestamp — in place. The
`toolCall`/`toolResult` pairing survives structurally, so the request stays well-formed;
only the text got smaller. The stored session keeps the full output; `--resume`, export and
replay see it.

```jsonc
// arcturn config — default shown
{
  "contextEditing": {
    "enabled": true,                     // effectively on even if this key is never set
    "mode": "local",                     // "local" | "server" | "auto"
    "keepRecentTurns": 3,                // trailing turns kept verbatim, never elided
    "minCharsToElide": 1000,             // never stub out something already small
    "maxTotalToolResultChars": 100000,   // editing only starts once history crosses this
    "minCharsPerPass": 50000,            // a local pass must save at least this much
    "protectToolNames": ["todo", "plan"] // never elided, regardless of age or size
  }
}
```

**On the actual default, precisely:** the CLI only forwards a `contextEditing` block to
the agent when a config file sets one — but the core resolver
(`resolveContextEditOptions`) defaults `enabled` to `true` on its own whenever the option
is left `undefined`. Context editing is on by default with no config file at all, the same
as offloading. `"contextEditing": { "enabled": false }` turns it off.

`protectToolNames` **replaces** the default `["todo", "plan"]` list rather than extending
it — a host that adds `protectToolNames` and forgets to repeat `"todo"`/`"plan"` loses
that protection.

If a result was already offloaded (`details.offloaded === true` with a `details.path`),
the elision stub points at that file instead of telling the model to re-run the tool.

### Modes

| `mode` | Who clears old results | Notes |
|---|---|---|
| `local` (default) | Arcturn, in recorded passes (below). | Works on every provider. |
| `server` | The provider (Anthropic `clear_tool_uses_20250919`, beta `context-management-2025-06-27`). | The request goes out with the history unedited; the provider checks the conversation as it was sent, so this is not a history edit at all. Claude API only — `anthropic`, and `anthropic-compatible` if the gateway forwards the beta. Bedrock and Vertex refuse the request with a clear error before it is sent. |
| `auto` | `server` on Claude with adaptive thinking (4.6 and later) through `anthropic` or `anthropic-compatible`; `local` everywhere else. | Setting `providers.anthropic.thinkingBinding` makes this the default when you did not choose a mode. |

`arcturn doctor` prints the mode in effect and why, and warns when a configured `server`
mode cannot run on the session model.

### Passes, and the ledger

A per-request rewrite — "elide whatever is past the boundary right now" — is not
append-only, even though it is monotonic: the `keepRecentTurns` boundary moves forward
every turn, so each request would stub out a result the previous request sent in full. The
earlier version of this module said that made the cache stable. It did not, and that claim
is withdrawn.

Local mode edits in **passes** instead. A pass is a deliberate, recorded prefix edit:

- It fires only when it would save at least `minCharsPerPass` characters (default
  50,000), so it is a rare event — one cache reset per batch — rather than one per request.
- It elides everything then eligible, in one go.
- Where thinking is bound to the prefix (Claude with adaptive thinking), it also stops
  replaying the thinking of every assistant message after the first result it touched,
  since those blocks were produced over the unedited results.
- It is written to the session as a `state` entry carrying `contextEdit: { elided,
  withholdThinking? }` — the ids of the tool calls whose results are now stubs. A resume
  rebuilds the same **ledger** from those entries and re-sends exactly the request the live
  agent sent. Without that record a resumed session would send full results where the
  original sent stubs, and the cache and the thinking would both miss.

Between passes the ledger re-sends the same stubs byte for byte and lets new results
through untouched. The `contextEdit` event fires once per pass:

```ts
{ type: "contextEdit"; elidedCount: number; charsSaved: number }
```

which the CLI renders as a dim status line: `Context edited: 4 old tool results elided
(~120k chars saved)`. `agent.contextEditPasses` counts them. Raise `minCharsPerPass` to
make passes rarer; raise `keepRecentTurns` or `minCharsToElide` to make each one touch less.

The one rule that keeps this valid: **always pass the raw conversation in, and use the
returned array only for the outgoing request — never store it back as history.** Arcturn's
own wiring does exactly that.

## Layer 3: compaction

Compaction ([Sessions, branching & compaction](/docs/sessions#compaction)) is the
backstop: it pays for a summarization call and rewrites history. It measures the raw,
unedited message list, so editing never confuses its threshold math.

Because it rewrites history, the shape matters on a model whose thinking is bound to that
history. `compaction.shape` picks one of three:

| `shape` | What survives | Default for |
|---|---|---|
| `simple` | One summary replaces the whole history. Only a trailing run of user and operator messages — the new request, which carries no thinking — is kept. | Claude 4.6 and later (every 5.x model) on `anthropic`, `anthropic-compatible`, `bedrock` or `vertex`. |
| `keep-tail` | A summary plus the most recent `keepRecentTokens` of turns, verbatim. On adaptive Claude the kept tail's thinking is stripped. | Every other model. |
| `server` | The provider compacts (Anthropic `compact_20260112`, beta `compact-2026-01-12`). Arcturn never summarizes locally and replays the returned `compaction` block verbatim. | Never the default; Claude API only. |

Why `simple` is the default on adaptive Claude: under `keep-tail` the kept turns were
produced with the now-summarized history present in front of them, so their thinking no
longer matches what the model would be shown. Stripping it works, but it keeps recent turns
whose reasoning is gone, whereas `simple` replays nothing that a signature check could
still object to. To make up for what any
summary loses, the summarizer prompt has a "Reasoning to carry forward" section: the
transcript it reads omits the assistant's thinking, so it records the hypotheses being
tested, what was ruled out and why, and what was about to be tried.

No shape cuts through an open tool round: an assistant turn whose tool call is still
waiting on its result is never folded, and `agent.compact()` says "Not compacting now: a
tool call is still waiting on its result." instead of producing a malformed history.

```jsonc
{ "compaction": { "shape": "simple" } }   // "simple" | "keep-tail" | "server"
```

## How they compose

Offloading shrinks what a result *is* at the source. Context editing shrinks what an
already-large history *sends*, in rare recorded passes or server-side. Compaction is the
only one that discards history, so it comes last; each is cheaper than the next, and
arcturn tries them in that order. Editing pushes the point where compaction's own token
threshold fires further out, but it never removes a message, so that threshold math
behaves exactly as it does with editing off.

Sensible default posture: leave all three on. Turn context editing off only if you need a
history where every request is byte-for-byte auditable against a fixed tool-result view —
for example, a policy that inspects the *full* transcript on the wire on every call, not
just the stub.

### What can still reset the prefix

Arcturn keeps its own edits append-only; it cannot stop everything else. A changed system
prompt or tool set between requests — an MCP server attached mid-session, a config edit
that adds a tool, a deferred-tool activation on a model without native tool search —
restarts the cache from the top. The agent notices this in-process and says so once, and
withholds the earlier thinking that change invalidated. It does not see a change that
happened *between* runs: a resume whose tool set differs from the one the session ended
with is not detected.

## Related

- [Sessions, branching & compaction](/docs/sessions) — compaction, the backstop these two
  layers exist to delay.
- [Tools](/docs/tools) and [Custom tools](/docs/sdk-tools) — `ToolResult.details` is the
  shared vocabulary offload and context editing use to hand data to each other.
- [Deferred tools](/docs/deferred-tools) — a fourth, complementary lever: fewer tool
  *schemas* in the request in the first place, rather than smaller tool *results*.
- [Providers](/docs/providers#preserved-thinking) — which models bind thinking to the
  prefix, and the `thinkingBinding` opt-in.
