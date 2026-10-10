# Integrating refusals

A model can decline a request: Anthropic's classifiers end a turn with
`stop_reason: "refusal"`, OpenAI's filters with `content_filter`, Gemini with
`SAFETY` and its relatives, Bedrock Converse with `content_filtered` or
`guardrail_intervened`. Until the 2026-10-10 "catalog catches up" wave Arcturn had
no word for that. A refusal arrived as an `endTurn` with little or no text, the
loop treated "the model said nothing" as a delivery glitch, and nudged the model
to try again — which re-sent exactly the request that had just been declined.

This note records the seams a refusal now crosses. Nothing here is a wiring
recipe still to apply; the code is in the tree, and the reasoning below is why it
has this shape.

## Public surface

```ts
// @arcturn/types
export type StopReason = "endTurn" | "toolCalls" | "maxTokens" | "pauseTurn" | "refusal" | "aborted" | "error";

export interface StopDetails {
  category: string | null; // the provider's word: "cyber", "bio", "content_filter", "safety", …
  explanation?: string;
}

// AssistantMessage gains:
stopDetails?: StopDetails; // only when stopReason === "refusal", and only if the provider said anything
```

`refusal` is a *finished* turn, not a failed one. It is not an `error`, it is not
retryable as-is, and the run that contains it ends with `runEnd` reason
`"completed"`. Consumers branch on `stopReason`; `category` is an open set and
`null` is a permanent, valid value, so it is informational only and no category is
ever invented.

## Provider mapping

| Provider | Native signal | `category` |
|---|---|---|
| Anthropic | `stop_reason: "refusal"` + `stop_details` | `stop_details.category` (may be `null`) |
| OpenAI Chat Completions, Responses | `content_filter` | `content_filter` |
| Google | `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY` | the finish-reason name |
| Bedrock Converse | `content_filtered`, `guardrail_intervened` | the signal's name |

A refused message keeps whatever partial output the provider streamed.

## Why the loop ends the turn

`packages/core/src/loop.ts` handles a refusal before the empty-turn nudge can see
it:

- **No nudge.** The nudge exists for deliveries that went wrong (reasoning ate the
  budget, the model stopped silent). A refusal is the provider's answer, so
  asking again only repeats the question. The turn ends and the run completes.
- **Tool calls are stripped.** A tool call in a declined message is the partial
  output of a request that was refused; it never runs. Stripping it from the
  recorded message also means no `tool_use` is left without a `tool_result`,
  which would make every later request to the provider invalid.
- **Replay skips it.** `toAnthropicMessages` leaves assistant messages whose
  `stopReason` is `refusal` out of the history it sends, so a refused turn is not
  replayed (and not used as a prefill) on the next request.
- **Compaction refuses to install a fragment.** `compaction.ts` throws when the
  summary came back refused, rather than recording half a sentence as the summary
  of the history it folds.

## What each surface shows

- **TUI, transcript, web** — `refusalLine()` in `display.ts`: "The model declined
  this request (cyber): <explanation>". With no category the parenthetical is
  omitted; with no explanation the line ends in a full stop.
- **`--print`, text mode** — stdout has whatever text arrived (possibly none), so
  stderr gets `arcturn: the model declined this request (cyber).` — the same
  sentence, lower-cased after the prefix. `-p` exits `1` on a refusal (the caller asked for work and got none).
- **`--print --output-format json`** — `messageEnd` carries `stopReason:
  "refusal"` and `stopDetails`.
- **ACP** — `session/prompt` returns `stopReason: "refusal"`; the adapter no
  longer maps it to `end_turn`.

## Server-side fallbacks (opt-in)

For the models that offer it (`ModelCapabilities.refusalFallback`: Fable 5.1,
Opus 5.5, Opus 5, Sonnet 5.5), the Claude API can re-run a declined request on
another model in the same call. It is off by default. `providers.anthropic.fallbacks:
"default"` in `.arcturn/config.json` (`AnthropicProviderOptions.fallbacks` from
code) sends those requests through the beta Messages surface with the
`server-side-fallback-2026-07-01` beta and `fallbacks: "default"`. It is never sent
to Haiku 5.5, which has no server-side fallback.

The adapter reads the beta-only shapes through small structural types and turns
them into two internal events: `fallbackBoundary` — the declining model's thinking
and unfinished tool calls are dropped, as the API says to when echoing the turn
back, so the `fallback` block itself never needs echoing — and `servedBy`, which
stamps the message with the model that answered. Billing follows that model; an
answering model not in the catalog reads as cost unknown.

## Known gaps

- **The cost of a fallback turn is a floor.** Top-level `usage` covers only the
  attempt that produced the message. Tokens a declined attempt spent appear only
  in `usage.iterations`, and whether a decline is billed depends on its category,
  which the client cannot settle — so they are not added.
- **Other `complete()` callers do not look at `stopReason`.** Git-message
  generation (`git.ts`), session titles and the team planner call the client
  directly; a refusal there is read as ordinary text.
- **OpenAI refusal text is not surfaced.** Only the `content_filter` finish
  reason is mapped; refusal text deltas the Responses API streams are not.
