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
2. **Context editing** (`packages/core/src/context-edit.ts`) — runs on every outgoing LLM
   request, after the fact. Old tool results already sitting in history get their content
   replaced with a one-line stub for that request only; the stored history is untouched.
   On by default.
3. **Compaction** (see [Sessions, branching & compaction](/docs/sessions)) — the backstop.
   It pays for a summarization call and rewrites history into a synthetic summary when the
   other two aren't enough. On by default, and unaffected by either of the above: it
   measures the raw, unedited message list.

The ordering matters: offloading shrinks what a result *is* at the source. Context editing
shrinks what an already-large history *sends* on a given turn, without touching the
history itself. Compaction is the only one of the three that actually rewrites what's
stored. Each is strictly cheaper than the next, so arcturn tries them in that order before
a run ever needs the expensive one.

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

## Layer 2: context editing

Context editing runs immediately before every LLM request. For tool results old enough to
fall outside the trailing window, it replaces the result's *content* with a one-line stub
(`[context-edited: the "read" result (5000 characters) was elided …]`) while leaving the
message itself — role, `toolCallId`, `toolName`, `isError`, timestamp — in place. The
`toolCall`/`toolResult` pairing survives structurally, so the request stays well-formed;
only the text got smaller.

```jsonc
// arcturn config — default shown
{
  "contextEditing": {
    "enabled": true,                     // effectively on even if this key is never set
    "keepRecentTurns": 3,                // trailing turns kept verbatim, never elided
    "minCharsToElide": 1000,             // never stub out something already small
    "maxTotalToolResultChars": 100000,   // editing only starts once history crosses this
    "protectToolNames": ["todo", "plan"] // never elided, regardless of age or size
  }
}
```

**On the actual default, precisely:** the CLI only forwards a `contextEditing` block to
the agent when a config file sets one — but the core resolver
(`resolveContextEditOptions`) defaults `enabled` to `true` on its own whenever the option
is left `undefined`. The net effect is that context editing is on by default with no
config file at all, the same as offloading; you don't need to write `contextEditing` into
a config to get it. Setting `"contextEditing": { "enabled": false }` is how you actually
turn it off.

`protectToolNames` **replaces** the default `["todo", "plan"]` list rather than extending
it — a host that adds `protectToolNames` and forgets to repeat `"todo"`/`"plan"` loses
that protection.

If a result was already offloaded (`details.offloaded === true` with a `details.path`),
the elision stub points at that file instead of telling the model to re-run the tool — the
two features compose without either importing the other; the contract between them is
purely structural (a `details` shape), so wiring order doesn't matter.

Every request that elides something emits a `contextEdit` event:

```ts
{ type: "contextEdit"; elidedCount: number; charsSaved: number }
```

which the CLI renders as a dim status line: `Context edited: 4 old tool results elided
(~120k chars saved)`.

### The cache-stability guarantee

Anthropic's prompt cache only hits when every earlier message in a request is
byte-identical to the previous request. Context editing is built to never break that
silently:

- **Elision is monotonic.** Once a tool result crosses into the elided range, it stays
  elided, identically, forever after — the eligibility boundary (`index <
  findElisionBoundary(...)`) only advances as new messages are appended, never retreats.
- **The decision is local.** Whether one result gets elided depends only on its own tool
  name, size, and position — never a rank or a shared budget — so something growing
  elsewhere in the conversation can't flip an earlier decision.
- **The trigger only grows.** It's measured against the raw, ever-growing history total,
  so it fires at most once per position and never toggles back off.

The cost you *do* pay: the turn a message first crosses the boundary, the cached prefix
from that point on is invalidated and rewritten once. That's inherent to the feature, not
a bug — raise `keepRecentTurns` or `minCharsToElide` to make it rarer, or set
`enabled: false` to avoid it entirely. The one rule that keeps the whole guarantee valid:
**always pass the raw conversation in, and use the returned array only for the outgoing
request — never store it back as history.** Arcturn's own wiring does exactly that: the
edited array is built fresh per request and never written back to the session.

Nothing about editing changes what's on disk. The stored session — and therefore
`--resume`, export, and replay — keeps the full, original tool output; only the outgoing
request is shaped.

## How they compose with compaction

Compaction ([Sessions, branching & compaction](/docs/sessions)) measures the same
`this.#messages` history that context editing leaves untouched — it has no visibility into
what got elided for a given request, by design. That's intentional layering: editing
shaves the *request*, which pushes the point where compaction's own token threshold fires
further out, but it never removes a message, so compaction's threshold math keeps working
exactly as it does with editing off. Compaction remains the eventual backstop; editing just
makes it fire later, and offloading (by keeping individual results small in the first
place) makes editing itself trigger less often.

Sensible default posture: leave all three on. Turn context editing off only if you need a
history where every request is byte-for-byte auditable against a fixed tool-result view —
for example, a policy that inspects the *full* transcript on the wire on every call, not
just the stub.

## Related

- [Sessions, branching & compaction](/docs/sessions) — compaction, the backstop these two
  layers exist to delay.
- [Tools](/docs/tools) and [Custom tools](/docs/sdk-tools) — `ToolResult.details` is the
  shared vocabulary offload and context editing use to hand data to each other.
- [Deferred tools](/docs/deferred-tools) — a fourth, complementary lever: fewer tool
  *schemas* in the request in the first place, rather than smaller tool *results*.
