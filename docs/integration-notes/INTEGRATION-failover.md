# Integrating provider failover

`packages/ai/src/failover.ts` adds `createFailoverClient` — an `LLMClient` that
wraps an ordered chain of models and transparently fails over from the primary
to the next model when a *retryable* error hits **before any output streams**.
It is a sibling of `withRetry` (`packages/ai/src/retry.ts`): retry re-tries the
same model, failover moves to a different one. They compose — wrap each link
with retries, then chain the links with failover.

Nothing in `client.ts`, `catalog.ts`, or `index.ts` was modified. To ship this,
add one export line and a few lines of wiring in the CLI runtime, described
below.

## Public surface (already implemented)

```ts
export type FailoverLink = LLMClient | { client: LLMClient; model?: ModelSpec };

export interface FailoverOptions {
  shouldFailover?: (error: AIError) => boolean;              // default: transient only
  onFailover?: (from: number, to: number, error: AIError) => void;
}

export function createFailoverClient(
  links: readonly FailoverLink[],
  options?: FailoverOptions,
): LLMClient;

export function defaultShouldFailover(error: AIError): boolean;
export function streamFailover(links, request, options?): AsyncIterable<StreamEvent>;
```

### Why this shape (chain of `{ client, model }`, not `LLMClient[]` of models)

Model selection in arcturn is **per-request**: the `ModelSpec` rides on
`LLMRequest.model`, and `createClient()` in `packages/ai/src/client.ts` dispatches
each request to the adapter named by `request.model.provider` (see the `resolve`
+ `dispatch` closures). A bare `LLMClient` therefore carries *no* model of its
own — it answers whatever `request.model` says.

So a failover chain of **models** cannot be expressed as N pre-bound clients
unless each client rewrites `request.model`. `createFailoverClient` accepts a
`FailoverLink` union to cover both readings:

- **`{ client, model }`** — the pair form. The link overrides `request.model`
  with its `ModelSpec` for that attempt (`{ ...request, model }`). This is the
  real "fallback chain of models": one shared `createClient()` instance serves
  every link, each swapping in a different spec. **Use this for the CLI.**
- **bare `LLMClient`** — streams `request.model` unchanged. Useful when the
  links are genuinely different clients (e.g. two base URLs / key sets for the
  same model), or in tests.

## The one invariant to preserve: no failover after output

Failover only happens while the current attempt has produced **no content**
(`textDelta` / `thinkingDelta` / tool-call events). Once a single content event
has reached the consumer, the turn is committed to that model; a later error is
surfaced unchanged instead of switching, because splicing two half-answers would
corrupt the assistant message. `start`, `usage`, and `blockEnd` are structural
and do **not** count as output — the leading `start` is held until an attempt
commits, and pre-commit `usage` is buffered, so exactly one `start` is emitted
(carrying the id of the model that actually answers) and a failed-over turn
leaks nothing. This mirrors `streamWithRetry`'s `produced` guard, extended
across models.

Exhausting the chain surfaces the **last** error as the terminal `error` event.

## Runtime wiring (`packages/cli/src/runtime.ts`)

Today the runtime resolves a single model and builds one client
(`resolveModelSpec` + `createClient`, around lines 766-773):

```ts
const model = resolveModelSpec(options.model ?? config.model, env);
const llm =
  options.llm ??
  createClient({ env, getAccessToken: oauth.createAccessTokenResolver(authStore) });
```

### 1. Accept `model` as a string OR an array

`config.model` is typed `string` in `packages/cli/src/config.ts` (line 43), and
`--model` maps to `options.model?: string`. Widen both to `string | string[]`:

- `config.ts`: `model: string | string[]`, and in the parser (around line 191)
  accept an array of non-empty strings as well as a single string.
- The `--model` flag: allow repetition (`--model a --model b`) or a
  comma-separated value, collecting into `string[]`.

The **first** entry is the primary; the rest are fallbacks in order.

### 2. Build the chain with `resolveModelSpec` / `getModel` per entry

`resolveModelSpec` (line 162) already turns one id into a validated `ModelSpec`
(it wraps `getModel` and checks the API key). Map it over the chain:

```ts
import { createFailoverClient } from "@arcturn/ai";

const modelIds = toArray(options.model ?? config.model);   // string | string[] -> string[]
const specs = modelIds.map((id) => resolveModelSpec(id, env));
const model = specs[0];                                     // primary drives compaction/UI

const base =
  options.llm ??
  createClient({ env, getAccessToken: oauth.createAccessTokenResolver(authStore) });

const llm =
  specs.length === 1
    ? base
    : createFailoverClient(
        specs.map((spec) => ({ client: base, model: spec })),
        {
          onFailover: (from, to, err) =>
            ui.notice(
              "warn",
              `${specs[from].displayName} failed (${err.kind}); switching to ${specs[to].displayName}.`,
            ),
        },
      );
```

`llm` and `model` then flow unchanged into `ArcturnRuntimeInit` / `ArcturnRuntime`
(fields at lines 298 & 297) and on to every `new Agent({ llm, model, ... })`
(lines ~520 & ~591). The Agent never knows failover exists — it just streams.

Notes:
- Keep `model = specs[0]` as the "current" model: `compactionOptionsFor(model)`
  (line 267) and the cost readout in `#onEvent` (line 662) should track the
  primary's context window / pricing. Per-turn cost is still accurate because
  the terminal `end`/`error` message carries the *answering* model's id and
  priced usage.
- `resolveModelSpec` throws `ModelResolutionError` for an unknown id or a
  missing key, so a bad fallback entry fails fast at startup, exactly like the
  primary does today.
- Each link shares the single `base` client, so adapters stay cached per
  provider/key (the `createClient` cache) — no extra connections.

### 3. Compose with retry (optional but recommended)

`createClient` already wraps its dispatch in `withRetry` unless `retry: false`.
So `base` retries transient errors per model *first*; only when retries are
exhausted does the terminal `error` event reach the failover layer, which then
moves to the next model. The layering is: `failover( retry( dispatch ) )` — no
extra code needed, it falls out of using `createClient()` as `base`.

### 4. UI hook (`onFailover` -> notice)

The runtime's UI exposes `notice(level, text)`
(`packages/cli/src/commands.ts` line 39, `"info" | "warn" | "error"`). Wire
`onFailover` straight to `ui.notice("warn", ...)` as shown above so the user
sees "switching to <fallback>" inline, the same channel already used for other
runtime warnings (e.g. line 891). `from`/`to` are indices into `specs`, so
`specs[from].displayName` / `specs[to].displayName` give friendly names.

## Config example

```jsonc
{
  // primary first, then fallbacks in order
  "model": [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-4o",
    "google/gemini-2.0-flash"
  ]
}
```

CLI equivalent: `arcturn --model anthropic/claude-sonnet-4-5 --model openai/gpt-4o`.

## Test coverage

`packages/ai/src/failover.test.ts` (16 tests, all passing) asserts: fails over
on overloaded/rateLimit/network before output; does **not** fail over after
output started; does **not** fail over on auth / invalidRequest / aborted (even
with a permissive `shouldFailover`); exhausts the chain and surfaces the last
error; `onFailover` fires with the right `(from, to, error)` indices; per-link
model override so `start`/`end` carry the answering model; pre-commit usage is
buffered/discarded on failover; defensive handling of a client that *throws*;
and `complete()` returns the answering link's terminal message.

Verify:

```bash
npx vitest run packages/ai/src/failover.test.ts
npx tsc -p packages/ai/tsconfig.json --noEmit
```
