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
