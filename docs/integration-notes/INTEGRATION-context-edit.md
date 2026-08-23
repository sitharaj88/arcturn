# Wiring context editing into the agent loop

Integration recipe for `packages/core/src/context-edit.ts` (new file, already
in the tree with `context-edit.test.ts`). Per the task's rules no existing file
was edited — everything below is an exact instruction for whoever wires it in.

The idea in one line: before each LLM request, replace the *content* of old
tool results with a one-line stub (`[context-edited: the "read" result (5000
characters) was elided …]`) while leaving the messages themselves in place, so
`toolCall`/`toolResult` pairing survives, the model can re-run the tool or read
the offloaded file if it needs the data, and the prompt cache stays warm.

Context editing is the cheap intervention that runs *before* compaction ever
becomes necessary: compaction pays for a summarization call and rewrites
history; this is a pure, synchronous, allocation-only transform of the outgoing
request.

---

## 1. What's already built

`packages/core/src/context-edit.ts` exports:

```ts
// --- constants ---------------------------------------------------------
const DEFAULT_KEEP_RECENT_TURNS = 3;
const DEFAULT_MIN_CHARS_TO_ELIDE = 1_000;
const DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS = 100_000;
const DEFAULT_PROTECTED_TOOL_NAMES: readonly string[];   // ["todo", "plan"]
const ELIDED_DETAIL_KEY = "contextElided";               // details marker

// --- types -------------------------------------------------------------
interface ElisionInfo {
  toolName: string; originalChars: number; isError: boolean; offloadPath?: string;
}
interface ContextEditOptions {
  enabled?: boolean;                    // default true
  keepRecentTurns?: number;             // default 3
  minCharsToElide?: number;             // default 1000
  maxTotalToolResultChars?: number;     // default 100000
  protectToolNames?: readonly string[]; // default ["todo", "plan"]
  renderStub?: (info: ElisionInfo) => string;
}
interface ResolvedContextEditOptions { /* same fields, all required */ }
interface ContextEditResult { messages: Message[]; elidedCount: number; charsSaved: number }

// --- functions ---------------------------------------------------------
function resolveContextEditOptions(options?: ContextEditOptions): ResolvedContextEditOptions;
function editContext(messages: readonly Message[], options: ResolvedContextEditOptions): ContextEditResult;
function shouldEditContext(messages: readonly Message[], options?: ContextEditOptions): boolean;
function findElisionBoundary(messages: readonly Message[], keepRecentTurns?: number): number;
function toolResultChars(content: readonly ToolResultContent[]): number;
function totalToolResultChars(messages: readonly Message[]): number;
function isElided(message: Message): boolean;
function renderElisionStub(info: ElisionInfo): string;
```

Facts the wiring depends on:

- `editContext` is **pure** — the input array and every message in it are left
  untouched; edited messages are shallow copies with a new `content` array.
- It is **self-gating**: it applies the `maxTotalToolResultChars` trigger and
  the `enabled` flag itself, returning `{ messages: [...input], elidedCount: 0,
  charsSaved: 0 }` when either says no. Callers may call it unconditionally;
  `shouldEditContext` exists for hosts that want to log/report the transition
  separately.
- It is **synchronous and non-throwing**, so there is nothing to abort — no
  `AbortSignal` parameter. Call it after the loop's existing `rt.signal.aborted`
  check and nothing changes about abort behaviour.
- It is **idempotent**: stubs carry `details.contextElided === true` and are
  never re-elided.
- An elided result keeps `role`, `toolCallId`, `toolName`, `isError`,
  `timestamp` and `structuredContent`; `details` gains
  `{ contextElided: true, elidedChars: <n> }`.
- Offload awareness: when a result carries `details.offloaded === true` and a
  string `details.path`, the stub points the model at that file instead of
  telling it to re-run the tool. No import from the offload feature — the
  contract is purely structural, so wiring order between the two features does
  not matter.

### The cache-stability guarantee (read before changing any default)

The Anthropic provider stamps `cache_control` on the last message
(`packages/ai/src/providers/anthropic.ts`), so the cached prefix only hits when
every earlier message is byte-identical to the previous request. This module
guarantees monotonic elision — *once a position is elided it is elided
identically for ever after* — as long as the caller obeys one rule:

> **Always pass the raw conversation, and use the returned array only for the
> outgoing request. Never store it back as history.**

Three properties give the guarantee (the file's doc comment has the full
argument, `context-edit.test.ts` has the property tests):

1. eligibility is `index < findElisionBoundary(messages, keepRecentTurns)`, and
   that boundary can only advance as messages are appended;
2. the per-message decision is local (tool name, own size) — never a rank or a
   shared budget, so growth elsewhere cannot flip an earlier decision;
3. the trigger is measured on the raw history, whose tool-result total only
   grows, so it fires exactly once and never toggles back off.

The cost you *do* pay: on the turn a message first crosses the boundary, the
cached prefix is invalidated from that point on and re-written once. That is
inherent to context editing. Raising `keepRecentTurns` or `minCharsToElide`
makes it rarer; setting `enabled: false` avoids it entirely.

---

## 2. `packages/types/src/events.ts` — one union member

Add to the `AgentEvent` union, next to the compaction events:

```ts
  | { type: "compactionStart" }
  | { type: "compactionEnd"; summary: string; tokensBefore: number; tokensAfter: number }
  | { type: "contextEdit"; elidedCount: number; charsSaved: number }   // <-- add this line
```

Nothing else in `types` changes. Every existing `switch` over `AgentEvent` that
is exhaustive must gain a `contextEdit` arm — as of writing that is the CLI's
event renderer and the ACP/serve bridges; the compiler will point at each one.
A UI can safely ignore it or render a dim one-liner, e.g.
`context edited: 4 tool results elided, ~120k chars saved`.

## 3. `packages/core/src/agent.ts` — options, field, and the prepare hook

**3a. `AgentOptions`** — add next to `compaction`:

```ts
  /** Automatic-compaction tuning. */
  compaction?: CompactionOptions;
  /** Tool-result context editing applied to each outgoing request. */
  contextEditing?: ContextEditOptions;          // <-- add
```

and the import:

```ts
import {
  type ContextEditOptions,
  editContext,
  resolveContextEditOptions,
} from "./context-edit.js";
```

**3b. Field + constructor** — mirror the compaction pair:

```ts
  readonly #contextEdit: ResolvedContextEditOptions;   // with the other readonly fields
  // ...
  this.#contextEdit = resolveContextEditOptions(options.contextEditing);   // next to #compaction
```

**3c. Implement the new `LoopRuntime` member** in the object literal returned by
the private `#runtime(signal)` method (the one that already defines
`beforeTurn`, around line 511):

```ts
      prepareMessages: (messages) => {
        const result = editContext(messages, this.#contextEdit);
        if (result.elidedCount > 0) {
          this.#emit({
            type: "contextEdit",
            elidedCount: result.elidedCount,
            charsSaved: result.charsSaved,
          });
        }
        return result.messages;
      },
```

Note what this deliberately does **not** do: it never writes `result.messages`
back into `this.#messages` and never persists a session entry. The stored
session keeps the full tool output — elision only shapes what is sent to the
provider — which is what keeps `--resume`, export and replay lossless, and what
keeps the cache guarantee in section 1 valid.

## 4. `packages/core/src/loop.ts` — two edits

**4a. `LoopRuntime`** — add the member next to `beforeTurn`:

```ts
  /** Runs before every LLM call; the agent uses it to auto-compact. */
  beforeTurn(): Promise<void>;
  /** Shapes the outgoing message list (context editing). Must not mutate history. */
  prepareMessages(messages: readonly Message[]): Message[];   // <-- add
```

**4b. Request assembly** in `runLoop`, replacing the `messages` line:

```ts
    const request: LLMRequest = {
      model,
      system: rt.getSystemPrompt(),
      messages: rt.prepareMessages(rt.messages),   // was: [...rt.messages]
      ...
    };
```

`prepareMessages` already returns a fresh array in every path (including the
no-op one), so dropping the spread is correct, not a shared-array hazard.

Ordering matters and is already right: `rt.beforeTurn()` (auto-compaction) runs
earlier in the iteration, so on a compaction turn the editing pass sees the
freshly compacted history. Compaction has already invalidated the cache on that
turn, so there is no extra cost.

**Any other implementer of `LoopRuntime`** must add the member. The identity
implementation is the correct default:

```ts
  prepareMessages: (messages) => [...messages],
```

At the time of writing `Agent.#runtime` (section 3c) is the only in-tree
implementer — `runLoop` is called from exactly one place — so section 3c plus
section 4 is the complete change; the compiler lists any implementer added
since.

## 5. `packages/core/src/index.ts` — exports

Add after the compaction block, keeping the file's alphabetical-ish grouping:

```ts
export type {
  ContextEditOptions,
  ContextEditResult,
  ElisionInfo,
  ResolvedContextEditOptions,
} from "./context-edit.js";
export {
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS,
  DEFAULT_MIN_CHARS_TO_ELIDE,
  DEFAULT_PROTECTED_TOOL_NAMES,
  editContext,
  ELIDED_DETAIL_KEY,
  findElisionBoundary,
  isElided,
  renderElisionStub,
  resolveContextEditOptions,
  shouldEditContext,
  toolResultChars,
  totalToolResultChars,
} from "./context-edit.js";
```

## 6. Config surface

`contextEditing` reaches the `Agent` the same way `compaction` does. For the
CLI/config layer, the recommended user-facing shape (all optional, all
defaulted by `resolveContextEditOptions`):

```jsonc
{
  "contextEditing": {
    "enabled": true,              // false disables the feature entirely
    "keepRecentTurns": 3,         // trailing assistant turns kept verbatim
    "minCharsToElide": 1000,      // never stub out a small result
    "maxTotalToolResultChars": 100000,  // editing starts only past this total
    "protectToolNames": ["todo", "plan"]
  }
}
```

Guidance for whoever writes the config validation:

- `protectToolNames` **replaces** the default list, it does not extend it. A
  host that adds its own state-like tool must repeat `"todo"` and `"plan"`.
  Keep it in sync with `isStateToolName` in `state-tools.ts` if that list grows.
- `keepRecentTurns: 0` makes every tool result eligible (nothing is protected by
  recency); negative values behave the same. Reject negatives at the config
  layer if you want a friendlier error.
- `renderStub` is intentionally **not** part of the JSON config — it is a
  programmatic escape hatch for embedders only.
- Sensible pairing with compaction: leave both on. Editing shaves the request
  and pushes the compaction threshold further out; it never removes a message,
  so `estimateTokens`/`shouldCompact` (which measure `this.#messages`, the
  *unedited* history) keep working exactly as they do today. Compaction is
  therefore still the eventual backstop, just later.

## 7. What is intentionally not built here

- **No session-entry rewriting.** Elision is request-shaping only; the JSONL
  session keeps full tool output.
- **No token-based budget.** Characters, not tokens: the decision must be a
  cheap local function, and a shared token budget would break the monotonicity
  guarantee in section 1.
- **No un-elision.** Recovery is by design the model's job — re-run the tool, or
  read `details.path` when the offload feature saved the output.
