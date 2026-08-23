---
title: Deferred tools
description: Progressive tool disclosure — withhold most tool schemas until the model asks for them via tool_search.
section: Core concepts
order: 6.2
---

## The problem this solves

Every tool schema handed to the model costs context on every single turn, whether or not
that tool is ever called. At roughly 60 tools and ~350 tokens of schema each, a run can
spend on the order of 21k tokens per request on tool definitions it never touches. Deferred
tools shrinks that: the model sees a small always-active core plus one built-in
`tool_search` tool, and everything else stays withheld — described only by a one-line
index — until the model explicitly asks for it.

**Off by default.** Unlike offloading and context editing, this is opt-in:

```jsonc
// arcturn config
{
  "deferredTools": {
    "enabled": true,                 // default false
    "alwaysActive": ["read", "write", "edit", "bash", "glob", "grep", "ls", "todo", "plan"],
    "maxResults": 10,                // cap on tools activated per tool_search call
    "searchToolName": "tool_search"  // rename if it collides with an MCP tool
  }
}
```

`alwaysActive` defaults to the core editing/inspection loop — `read`, `write`, `edit`,
`multi_edit`, `bash`, `glob`, `grep`, `ls`, `todo`, `plan` — plus `skill` when the
model-invoked [skill tool](/docs/skill-tool) is on: its description *is* a compact index,
so deferring it would turn skills into a two-round-trip discovery. Setting your own
`alwaysActive` replaces this whole list.

Two things about that default list are worth knowing before you keep it. `multi_edit` names
no tool — nothing in the harness registers it, in that spelling or as `multiedit`, so the
entry is inert and is skipped like any name matching no tool; see [the reserved
name](/docs/tools#multiedit-reserved-and-currently-inert). And
[`search_code`](/docs/code-search) is *not* on the list, so with deferral on, the offline
code index costs one `tool_search` round trip before the model can reach it — add it to your
own `alwaysActive` if the work is search-heavy.

Activation state is **per process**: each agent keeps its own disclosure set (one served
session's `tool_search` never changes another session's tool list), an MCP reconnect
carries the live agent's activations forward, and after `--resume` the model pays one
`tool_search` round trip to re-discover what it needs — activations are deliberately not
persisted into the session file. `tool_search` itself never prompts, but only because the
runtime that created it vouches for it by exact name; a third-party tool merely *named*
`tool_search` is rejected as a reserved-name collision and gets no silent pass.

## How disclosure works

`tool_search`'s own *description* carries a compact `name — description` index of
everything currently deferred. The model reads that index for free (it's the tool's
description, always present), decides a deferred tool is relevant, and calls
`tool_search({ query, select? })`. Matched tools activate — their full schemas appear from
that point on — and stay active for the rest of the session; `tool_search`'s `.definition`
getter recomputes the embedded index on every access, so the index a UI or the model reads
is always current.

Matching is substring + token scoring over each tool's name and description, ties broken
by name ascending, so the same query against the same tool list always returns the same
matches. Index lines use only the **first line** of a description, truncated to 160
characters — a deferred tool with a weak opening sentence is effectively invisible until
someone searches for it by something other than its own words, which is why description
quality becomes load-bearing under deferral in a way it wasn't before.

Every failure path inside `tool_search` — an aborted signal, a non-string query, an empty
query with nothing selected, zero matches, an unrecognized name in `select` — returns as
an error-*value* `ToolResult` (`isError: true`), never a thrown exception, and the
no-match / empty-query cases re-print the deferred index so the model can retry with an
exact name instead of guessing blind again.

## Disclosure, not a sandbox

This is the one thing worth stating without qualification: **deferral only changes what's
in the request, not what's allowed.** An activated tool goes through exactly the same
permission engine, on every call, as if it had never been deferred — `read`/`write`
approval rules, sandbox confinement, hook gating, all of it, unchanged. Deferred tools is a
context-budget optimization; it grants the model *awareness* of a capability sooner or
later, never *access* it wouldn't otherwise have. Never describe it to users as a security
boundary — it isn't one, and treating it as one is the wrong mental model for what it's
doing.

## The prompt-cache tradeoff

The tool list is part of the cached prefix. Every activation invalidates that cache and the
next request re-reads the full prefix from scratch — so a chatty search pattern (the model
searching once per tool it needs, across many small queries) can cost more in cache misses
than the deferred schemas would have cost if just sent up front. Two knobs mitigate this:

- Keep `alwaysActive` generous — anything used on most tasks belongs there, not in the
  deferred tail, because a tool the model would have called immediately now costs one extra
  round-trip to discover.
- Keep `maxResults` at 5 or higher so one search can resolve a whole task's worth of tools
  in a single activation instead of several.

Turn deferral on when the tool count is large enough that the schema tax outweighs the
occasional extra round-trip — a good rule of thumb is somewhere past ~25 tools, especially
once MCP servers are in the mix, since MCP tools are the long tail that motivates this
feature in the first place.

## Related

- [Code search](/docs/code-search) — `search_code`, the always-registered tool that is *not*
  in the `alwaysActive` default and so pays a discovery round trip under deferral.
- [Context management](/docs/context-management) — the sibling levers for tool *results*
  (offloading, context editing) rather than tool *schemas*.
- [Custom tools](/docs/sdk-tools) — the `Tool` interface deferred tools wraps; nothing
  about writing a tool changes under deferral.
- [Permissions from the SDK](/docs/sdk-permissions) — the engine every activated tool still
  passes through, unconditionally.
