# Wiring deferred tool loading (progressive tool disclosure)

Integration recipe for `packages/core/src/deferred-tools.ts` (new file, already
in the tree with `deferred-tools.test.ts`). Per the task's rules no existing
file was edited — everything below is an exact instruction for whoever wires it
into `index.ts`, `agent.ts`, the runtime and the session layer.

The idea in one line: most tool schemas never go into the request. The model
sees a small always-active core (read/write/edit/bash/glob/grep/ls/todo/plan)
plus one built-in `tool_search` tool whose *description* carries a compact
`name — description` index of everything that is deferred; calling `tool_search`
activates the matches and their full schemas appear from the next turn onwards.

Why it pays: with ~60 tools at ~350 tokens of schema each, a run spends ~21k
tokens of context per request on tools it will never call. Deferring all but the
core turns that into ~3.5k of schemas plus ~60 index lines (~1.2k), and the
model pays the ~700-token activation round-trip only for tools it actually
wants.

---

## 1. What's already built

`packages/core/src/deferred-tools.ts` exports:

```ts
// --- constants -----------------------------------------------------------
const DEFAULT_ALWAYS_ACTIVE_TOOLS: readonly string[];  // read, write, edit, multi_edit,
                                                       // bash, glob, grep, ls, todo, plan
const DEFAULT_SEARCH_TOOL_NAME: string;                // "tool_search"

// --- types ---------------------------------------------------------------
interface DeferredToolsetOptions {
  tools: readonly Tool[];
  alwaysActive?: readonly string[];      // default: DEFAULT_ALWAYS_ACTIVE_TOOLS
  onActivate?: (names: string[]) => void; // newly activated names only
  searchToolName?: string;               // default: "tool_search"
  maxResults?: number;                   // default: 10, per query
}
interface ActivationReport { activated: string[]; alreadyActive: string[]; unknown: string[] }
interface DeferredToolsetSnapshot { activated: string[] }

// --- the toolset ---------------------------------------------------------
class DeferredToolset {
  constructor(options: DeferredToolsetOptions);
  readonly searchToolName: string;
  allTools(): Tool[];            // everything handed to the constructor, registration order
  activeTools(): Tool[];         // <- what the loop sends: active core + activated + tool_search
  deferredTools(): Tool[];       // currently withheld, registration order
  isActive(name: string): boolean;
  activate(names: readonly string[]): ActivationReport;   // never throws
  renderDeferredIndex(): string; // "name — description" per line; "" when nothing deferred
  searchTool(): Tool;            // stable object; its .definition refreshes on activation
  snapshot(): DeferredToolsetSnapshot;
  restore(snapshot: DeferredToolsetSnapshot): void;
}
function createDeferredToolset(options: DeferredToolsetOptions): DeferredToolset;
```

Add to `packages/core/src/index.ts` (alphabetical position, right after the
`compaction.js` block and before `hooks.js`):

```ts
export type {
  ActivationReport,
  DeferredToolsetOptions,
  DeferredToolsetSnapshot,
} from "./deferred-tools.js";
export {
  createDeferredToolset,
  DEFAULT_ALWAYS_ACTIVE_TOOLS,
  DEFAULT_SEARCH_TOOL_NAME,
  DeferredToolset,
} from "./deferred-tools.js";
```

### Why a closure and not `BindableTool`

`state.ts`'s `BindableTool` exists for tools that need a handle on the *agent*
(`emit`, `setTodos`, `requestPlanApproval`, permission mode). `tool_search`
needs none of that: its only state is "which tools are active", which belongs to
the toolset instance, not the agent, and must be readable by the host *before*
any agent exists (the host has to build the initial tool list from it). It is
also read by `LoopRuntime.getTools()` on every turn, which `bindAgent` has no
say over. So `DeferredToolset` owns the state and hands out a plain `Tool` whose
`execute` closes over the instance — `activeTools()` is the integration point,
not `bindAgent`.

`DeferredToolset` deliberately does **not** call `bindAgent` on the tools it
holds. `Agent.setTools()` already does that for whatever list it is given, and
the recommended wiring (§2) routes every activated tool through the agent, so
bindable tools keep working — see the caveat in §2 if you choose variant B.

---

## 2. The loop / agent edit

`runLoop` already re-reads `rt.getTools()` at the top of every turn (loop.ts
~line 427) *and* when resolving a tool call (~line 257). That is the entire hook
needed: point `getTools` at `DeferredToolset.activeTools()` and the loop
transparently sends a growing tool list. **No edit to `loop.ts` is required.**

### Variant A (recommended) — one optional field on `AgentOptions`

`packages/core/src/agent.ts`, in `AgentOptions`, directly after the `tools`
field:

```ts
  /** Tools offered to the model. Bindable tools are wired automatically. */
  tools?: Tool[];
  /**
   * Overrides {@link AgentOptions.tools} per turn, e.g. a
   * {@link DeferredToolset.activeTools} bound method for progressive tool
   * disclosure. Tools returned here must already be bound (pass the full set
   * through `tools` as well).
   */
  getTools?: () => Tool[];
```

Store it in the constructor next to `this.setTools(options.tools ?? [])`:

```ts
  #getTools: (() => Tool[]) | undefined;
  // ...
  this.setTools(options.tools ?? []);
  this.#getTools = options.getTools;
```

and change the single line in `#runtime()` (agent.ts ~line 499):

```ts
-      getTools: () => this.#tools,
+      getTools: () => this.#getTools?.() ?? this.#tools,
```

Host wiring then reads:

```ts
const deferred = createDeferredToolset({ tools: allTools });
const agent = new Agent({
  // ...
  tools: [...deferred.allTools(), deferred.searchTool()], // binds every bindable tool once
  getTools: () => deferred.activeTools(),                 // but only sends the active ones
});
```

Passing the *full* list to `tools` is what keeps `BindableTool`s (todo, plan,
subagent) bound even while deferred; `getTools` only narrows what is *sent*.

### Variant B (zero core edits) — push on activation

If you would rather not touch `agent.ts`, drive `setTools` from `onActivate`:

```ts
let agent: Agent;
const deferred = createDeferredToolset({
  tools: allTools,
  onActivate: () => agent?.setTools(deferred.activeTools()),
});
agent = new Agent({ /* ... */ tools: deferred.activeTools() });
```

This works because `onActivate` fires during tool execution and `getTools()` is
re-read at the start of the next turn. Caveat: `setTools` rebinds bindable tools
and *replaces* the list, so a host that mutates tools elsewhere (MCP reconnect,
`/tools` toggles) must funnel those through `DeferredToolset` too — rebuild the
toolset and `restore()` its snapshot. Variant A avoids that coupling.

---

## 3. Permissions

`tool_search` reads no files, runs nothing, and touches no network — it only
reveals schemas the host already chose to offer. Add it to the silent-allow list
so it never prompts. `packages/core/src/permissions.ts` line 45:

```ts
-export const DEFAULT_ALWAYS_ALLOW_TOOLS: readonly string[] = ["todo", "plan"] as const;
+export const DEFAULT_ALWAYS_ALLOW_TOOLS: readonly string[] = ["todo", "plan", "tool_search"] as const;
```

If you configured a custom `searchToolName`, add that name instead, or pass
`permissions.alwaysAllowTools` explicitly.

Security note: activation is **disclosure, not escalation**. An activated tool
still goes through the full permission engine on every call, exactly as if it
had never been deferred. Deferral is a context optimisation and must never be
described to users as a sandbox.

---

## 4. Session persistence

Activation is per-instance (per run/session). To make `--resume` keep the tools
the model already found, persist `snapshot()` and `restore()` it.

Cheapest route with no new session entry kind: reuse `state` entries. In
`packages/types/src/session.ts`, extend the `state` variant with one optional
field:

```ts
  | {
      kind: "state";
      id: string; parentId: string | null; timestamp: number;
      todos?: TodoItem[];
      plan?: string;
      model?: string;
+     activatedTools?: string[];
    };
```

Then in the host: on `onActivate`, append a `state` entry carrying
`deferred.snapshot().activated`; on resume, take the last `state` entry that has
`activatedTools` on the materialized branch and call
`deferred.restore({ activated })`. `restore()` drops names that no longer exist
(tool removed, MCP server gone) and deliberately does **not** fire `onActivate`,
so rehydration cannot loop back into a persist.

Branch semantics come free: because the snapshot rides on branch-scoped `state`
entries, rewinding to an earlier point restores the activation set as it was at
that point.

---

## 5. Config surface

Suggested keys for the CLI/config layer (none of them exist yet; this module
reads no config itself):

| key | type | default | effect |
| --- | --- | --- | --- |
| `tools.deferred.enabled` | boolean | `false` | wrap the tool list in a `DeferredToolset` at all |
| `tools.deferred.alwaysActive` | string[] | `DEFAULT_ALWAYS_ACTIVE_TOOLS` | names never deferred |
| `tools.deferred.maxResults` | number | `10` | cap on tools activated per `tool_search` call |
| `tools.deferred.searchToolName` | string | `"tool_search"` | rename if it collides with an MCP tool |

Recommended rollout: default `enabled` to `false`, turn it on automatically when
the tool count crosses a threshold (~25), and always keep MCP tools deferred —
they are the long tail that motivates the feature. A tool whose name collides
with `searchToolName` is dropped from the registry (first registration wins, and
the search tool always wins the name), so pick a distinctive name if you bridge
untrusted MCP servers.

---

## 6. Events / UI

No new `AgentEvent` type is needed — `tool_search` appears in the stream as a
normal `toolStart`/`toolEnd` pair. A UI that wants to surface disclosure can
either read `toolEnd.result.details` (shape: `{ activated, alreadyActive,
unknown, deferred }`, all `string[]`) or subscribe via `onActivate`:

```ts
const deferred = createDeferredToolset({
  tools: allTools,
  onActivate: (names) => runtime.notify("info", `Loaded ${names.length} tool(s): ${names.join(", ")}`),
});
```

Suggested TUI line: `⚒ tool_search → +web_search, +web_fetch (18 still deferred)`.

---

## 7. Behaviour contract the wiring can rely on

- `activeTools()` returns active tools in **registration order**, with
  `tool_search` last — always present, even when nothing is deferred, so a
  search issued in the same turn as the final activation still resolves.
- The `Tool` object from `searchTool()` is **stable by identity**; its
  `definition` getter recomputes the embedded index whenever activation changes.
  Read `.definition` per turn (the loop already does) rather than caching it.
- `activate()` never throws: unknown names land in `report.unknown`, already
  active names in `report.alreadyActive`, and `onActivate` fires only for
  genuinely new names.
- Every failure inside `tool_search` is an error-*value* `ToolResult`
  (`isError: true`): aborted signal, non-string `query`, non-string-array
  `select`, empty query with no `select`, zero matches, only-unknown `select`.
  The no-match and empty-query results re-print the deferred index so the model
  can retry with an exact name instead of guessing again.
- Matching is substring + token scoring over name and description, ties broken
  by name ascending — deterministic for a given tool list and query.
- Index lines use only the first line of a description, truncated to 160 chars.
  Write tool descriptions with a strong first sentence: under deferral, that
  sentence is *all* the model sees until it searches.

---

## 8. Risks worth stating out loud

1. **Prompt caching.** The tool list is part of the cached prefix; every
   activation invalidates it and the next request re-reads the full prefix. With
   Anthropic caching on, a chatty search pattern can cost more than it saves.
   Mitigate by keeping `alwaysActive` generous and `maxResults` >= 5 so one
   search covers a whole task.
2. **An extra round-trip per discovery.** A model that would have called
   `web_search` immediately now spends one turn searching. Tools used on most
   tasks belong in `alwaysActive`, not in the deferred tail.
3. **Description quality becomes load-bearing.** A deferred tool with a vague
   first sentence is effectively invisible. Audit MCP tool descriptions before
   enabling deferral over them.
4. **Very large indexes.** The index is not truncated (only each line is). At
   ~200 deferred tools the description itself becomes a multi-thousand-token
   block; a future `maxIndexEntries` + "search to see more" line would be the
   fix. Not built here.
