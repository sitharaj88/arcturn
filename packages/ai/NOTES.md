# @arcturn/ai — implementation notes

Issues found while implementing against the frozen `@arcturn/types` contracts,
plus decisions a reviewer should be aware of. Nothing in `packages/types` was
modified; every item below is worked around locally.

## Contract gaps worked around locally

### 1. `StreamEvent` cannot carry a thinking signature
`ThinkingContent.signature` must round-trip (Anthropic rejects unsigned thinking
blocks; Gemini needs `thoughtSignature` for reasoning continuity), but the
`StreamEvent` union has no event for it and `thinkingDelta` only carries text.

**Workaround:** adapters emit an internal `{ type: "thinkingSignature", blockIndex,
signature, replace? }` event on the *provider* event channel
(`ProviderStreamEvent` in `src/internal/stream.ts`). `assembleStream` applies it
to the assembler and never forwards it, so the public event sequence stays
exactly as typed while the terminal `AssistantMessage` keeps its signatures.
Anthropic chunks signatures across several `signature_delta`s so the default is
append; Google sends the whole value, so it uses `replace: true`.

**Suggested contract change:** add
`{ type: "thinkingSignature"; blockIndex: number; signature: string }` to
`StreamEvent`, or an optional `signature` field on `thinkingDelta`.

### 2. `StreamEvent` cannot carry a stop reason before `end`
Adapters learn the stop reason mid-stream (`message_delta`, `finish_reason`,
`finishReason`) but the only place to put it is the terminal message.

**Workaround:** an internal `{ type: "stop"; stopReason; errorMessage? }` provider
event, also filtered out by `assembleStream`.

### 3. `ToolCallContent` has no signature field
Gemini attaches `thoughtSignature` to `functionCall` parts, and OpenRouter
attaches `reasoning_details` to tool calls. Neither can be stored on
`ToolCallContent`, so both are **dropped**. Multi-turn reasoning continuity is
therefore slightly weaker on Gemini 3 when the turn ends in a tool call.

**Suggested contract change:** optional `signature?: string` on `ToolCallContent`.

### 4. No representation for Anthropic `redacted_thinking`
`ThinkingContent` has no "redacted" flag, but the opaque `data` blob must be
replayed verbatim or the conversation breaks.

**Workaround:** stored as `{ type: "thinking", thinking: "", signature:
"redacted:<data>" }`. `toAnthropicMessages` recognises the `redacted:` prefix
(exported as `REDACTED_THINKING_PREFIX`) and re-emits a `redacted_thinking`
block. The prefix is namespaced enough that a real signature cannot collide with
it, but a `redacted?: boolean` on `ThinkingContent` would be cleaner.

### 5. `TextContent` has no signature field
Gemini can attach a `thoughtSignature` to a *non-thought* text part. There is
nowhere to keep it, so it is dropped.

### 6. `Usage` has no reasoning-token breakdown
Anthropic (`output_tokens_details.thinking_tokens`), OpenAI
(`completion_tokens_details.reasoning_tokens`) and Google (`thoughtsTokenCount`)
all report reasoning tokens. They are folded into `outputTokens` and the
breakdown is discarded. An optional `reasoningTokens?: number` would let UIs
show it.

### 7. `AIError` has no `contextOverflow` kind
Prompt-too-long errors are deterministic and should trigger compaction rather
than a retry. They currently land in `invalidRequest` (non-retryable, which is at
least correct behaviour) but the runtime cannot distinguish them.

## Design decisions

- **Abort is an `end`, not an `error`.** `AbortSignal` produces a terminal `end`
  event whose message has `stopReason: "aborted"`, preserving whatever content
  streamed so far. `AIError.kind === "aborted"` exists, but surfacing an abort as
  an `error` would force every consumer to special-case a user action. An
  already-aborted signal short-circuits: `start` then `end`, with no provider call.
- **`message` on `start` and `AssistantMessage.model` are the catalog id**
  (`"anthropic/claude-opus-4-5"`), not the provider wire name. The catalog id is
  what `getModel` round-trips, so downstream cost/limit lookups work directly.
- **Unsigned thinking is dropped when replaying to Anthropic**, not downgraded to
  assistant text. Downgrading (what the reference implementation does) preserves
  context after an abort but rewrites the transcript so the model "said" its own
  reasoning. Dropping keeps the transcript honest; the thinking is still visible
  in the session log.
- **Retries only fire before any content reaches the consumer.** Once a
  `textDelta`/`toolCall*` event has been yielded, a mid-stream failure is passed
  through as an `error` rather than silently replaced by a different answer.
  Exactly one `start` is emitted across all attempts.
- **SDK-level retries are disabled** (`maxRetries: 0`) in all three adapters,
  because the OpenAI and Anthropic SDK backoff timers ignore `AbortSignal`.
  `streamWithRetry` replaces them with an abortable sleep.
- **`retryAfterMs` above `maxRetryAfterMs` (default 60s) stops the retry loop**
  rather than sleeping. A long rate-limit window should surface to the user.
- **Provider quirks that are API-level rules are hardcoded** (Anthropic thinking
  vs. temperature, `max_completion_tokens` vs. `max_tokens`); everything
  model-specific lives in the catalog as data. `providerOptions` is spread last
  and overrides anything the builders computed.

## Usage-accounting conventions

The three providers disagree, and getting this wrong silently mis-reports every
call. Arcturn's convention is that `inputTokens`, `cacheReadTokens` and
`cacheWriteTokens` are **additive** (no double counting) and `outputTokens`
includes reasoning tokens.

| Provider  | Wire behaviour | Normalisation applied |
| --------- | -------------- | --------------------- |
| Anthropic | `input_tokens` excludes cache; `output_tokens` includes thinking | pass through; only overwrite fields the provider actually reported, so a proxy omitting `input_tokens` in `message_delta` cannot zero out the `message_start` value |
| OpenAI    | `prompt_tokens` **includes** cached tokens; `completion_tokens` includes reasoning | `input = prompt − cacheRead − cacheWrite` |
| Google    | `promptTokenCount` **includes** cache; `candidatesTokenCount` **excludes** thoughts | `input = prompt − cached`, `output = candidates + thoughts` |

## Dependencies not available

- **No streaming-JSON parser** (`partial-json` or similar). `src/internal/json.ts`
  implements the fallback ladder by hand: `JSON.parse` → escape raw control
  characters and dangling backslashes → close open structures and drop a
  truncated trailing token → `{}`. It never throws. This is sufficient for
  tool-argument recovery but is not a general partial-JSON parser.
- No HTTP mocking library; all provider tests inject a structural fake client
  (`AnthropicClientLike`, `OpenAIClientLike`, `GoogleClientLike`). Zero network
  calls, zero API keys.

## Provider-specific caveats

- **Anthropic:** four cache breakpoints are available; three are used (system
  prompt, last tool, last block of the last user turn). `tool_result` blocks are
  re-ordered to the front of a merged user turn, as the API requires. A stream
  that ends without `message_stop` raises a `network`-kind error so the retry
  layer picks it up.
- **OpenAI-compatible:** reasoning is read from the first non-empty of
  `reasoning_content`, `reasoning`, `reasoning_text` (some gateways send two
  copies). Tool calls are keyed by both `index` and `id` because gateways omit
  one or the other. `stream_options.include_usage` can be disabled via
  `createOpenAIProvider({ includeUsage: false })` for gateways that reject it.
  The full dialect table for `reasoning_effort` (OpenRouter's nested `reasoning`
  object, DeepSeek's `thinking`, Qwen's `enable_thinking`, ...) is *not*
  implemented — use `providerOptions` for those until a compat table exists.
- **Google:** the SDK does not accept a custom `fetch`; only
  `httpOptions.baseUrl` / `headers`. When `baseUrl` is set, `apiVersion: ""` is
  also sent or the SDK appends `/v1beta` to an already-versioned URL. Gemini
  streams tool arguments whole, so `toolCallStart`/`toolCallDelta`/`toolCallEnd`
  are synthesised back to back for parity with the other providers. Function-call
  ids are only sent for Gemini 3+; ids Arcturn invented are prefixed `arcturn-` and are
  never echoed back to the API.

## Pricing caveat

`src/catalog.ts` prices are best-effort as of the implementation date and will
drift. `registerModel()` overrides any entry, and `calculateCostUsd` returns
`undefined` when a spec has no `cost`, so a stale price can always be corrected
by the host without touching this package.

## 2026-10-10 — the catalog catches up (5.5 generation)

Worked around rather than fixed, each with the reason and the way out:

- **`between_tools` is missing from the pinned SDK.** `@anthropic-ai/sdk`
  0.117.1 types `ThinkingConfigParam` as `enabled | disabled | adaptive`, but
  Sonnet 5.5 turns thinking off only with `{type: "between_tools"}`.
  `AnthropicThinkingParam` / `AnthropicRequestParams` (providers/anthropic.ts)
  add it locally. 0.133.0 ships `ThinkingConfigBetweenTools`; on that bump the
  local union can go. Everything else this wave needed — `stop_details`,
  `display`, the `xhigh`/`max` effort literals, beta `fallbacks: "default"` —
  is already in 0.117.1, so the SDK was not bumped.
- **Refusal fallbacks stream beta-only shapes.** `fallback` content blocks and
  `usage.iterations` are read through small structural types rather than the
  beta SDK types, because `AnthropicClientLike` streams the GA event type. The
  adapter turns them into two internal provider events: `fallbackBoundary`
  (the assembler drops the declining model's thinking and unfinished tool
  calls, which the docs say to omit when echoing the turn back — so the
  `fallback` block itself never needs echoing) and `servedBy` (the message is
  stamped with, and priced at, the model that answered).
- **A fallback turn's `costUsd` is a floor.** Top-level `usage` covers only
  the attempt that produced the message, and is priced at the answering
  model. Tokens a declined attempt spent appear only in `usage.iterations`,
  and whether a decline is billed depends on its refusal category, which the
  client cannot settle — so they are not added.
- **Bedrock does not get the new generation yet.** The adapter speaks
  `bedrock-runtime` through `AnthropicBedrock`; the 5.x / 4.7+ models are
  served by the Messages-API (Mantle) endpoint under ids
  `anthropic.claude-fable-5-1`, `anthropic.claude-opus-5-5`,
  `anthropic.claude-sonnet-5-5`, `anthropic.claude-haiku-5-5` (and
  `anthropic.claude-opus-5`, `-sonnet-5`, `-fable-5`, `-opus-4-8`,
  `-opus-4-7`). Shipping catalog entries the adapter cannot serve would
  advertise a path that 400s; moving to `AnthropicBedrockMantle` is the
  follow-up that unlocks them.
- **Vertex entries are unpriced.** Google Cloud bills on its own rate card,
  which could not be read; the current Claude generation ships under its bare
  id with no `cost`, so spend reads "unknown" rather than a borrowed rate.
- **OpenAI `xhigh`/`max` clamp to `high`.** The catalog does not record which
  OpenAI models accept an effort above `high`. Gemini clamps the same way
  (its scale tops out at `HIGH` / a 32K budget).
- **A refused turn's partial output is not replayed.** `toAnthropicMessages`
  skips assistant messages whose `stopReason` is `refusal`; the core loop
  already strips their tool calls, so no `tool_result` is left dangling.
