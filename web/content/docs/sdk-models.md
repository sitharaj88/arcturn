---
title: Models & providers from the SDK
description: createClient, the model catalog, provider presets, failover chains, consensus panels, and custom endpoints.
section: Extend
order: 9.6
---

`@arcturn/ai` is the multi-provider LLM client the agent's `llm` option expects — one
`LLMClient` interface (`stream`/`complete`) dispatched to whichever provider adapter a
`ModelSpec.provider` names. See [Providers](/docs/providers) for the CLI-facing provider
list; this page is the SDK API.

## `createClient`

```ts
import { createClient } from "@arcturn/ai";

const llm = createClient(); // resolves API keys from process.env by default
```

`CreateClientOptions`:

| Field | Behavior |
|---|---|
| `apiKey` | Used for every provider unless a more specific option overrides it. |
| `apiKeys` | Per-provider keys, keyed by `ProviderId`. |
| `baseUrl` | Overrides the base URL for every request whose `ModelSpec` doesn't already set one. |
| `headers` | Extra HTTP headers merged into every provider request. |
| `env` | Environment map consulted for API keys; defaults to `process.env`. |
| `retry` | A `RetryOptions` object, or `false` to disable retries entirely. |
| `providers` | Replace an adapter wholesale — for tests, or a bespoke provider not in the registry. |
| `getAccessToken` | `(provider) => Promise<string>` — supplies bearer tokens for OAuth-authenticated providers instead of an API key. |

Adapters are constructed lazily and cached per provider/base-URL/key triple, so a
long-lived client reuses connections across requests. Dispatch failures (an unknown
provider, a missing key) surface as a normal terminal `error` `StreamEvent`, never a
thrown exception — the same "failures are data" contract the agent loop relies on.

## Resolving a model

Three functions, all from the shared catalog in `@arcturn/ai`:

```ts
import { getModel, presetModel, requireModel } from "@arcturn/ai";

requireModel("anthropic/claude-sonnet-5-5"); // throws on an unknown id
getModel("claude-sonnet-5-5"); // also matches by bare wire model name; undefined if unknown
presetModel("groq", "llama-3.3-70b-versatile"); // ad-hoc ModelSpec for a known preset, no registration needed
```

`getModel`/`requireModel` accept either a full catalog id (`"anthropic/claude-sonnet-5-5"`)
or a bare wire model name when it's unambiguous across the registry. Every well-known
preset — Groq, Cerebras, DeepSeek, Z.AI, Moonshot, MiniMax, OpenRouter, and more — is
reachable through `presetModel`/`getModel`/`requireModel` **with no registration step**:
the extended preset table wires itself into the catalog's lookup path on module load, and
a lookup miss pulls the whole table in on demand. `registerPresetModels()` still exists
for a host that wants everything registered eagerly (the CLI calls it so `--list-models`
shows the full catalog up front).

```ts
import { listModels, listModelsByProvider, registerModel } from "@arcturn/ai";

listModels(); // every registered ModelSpec, built-ins first
listModelsByProvider("anthropic");
registerModel({
  id: "internal/finetune-v3",
  provider: "openai-compatible",
  model: "finetune-v3",
  displayName: "Internal finetune v3",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  baseUrl: "https://models.internal.example.com/v1",
  apiKeyEnv: "INTERNAL_MODEL_API_KEY",
});
```

## Thinking levels and per-model capabilities

`ThinkingLevel` is `"off" | "low" | "medium" | "high" | "xhigh" | "max"`, lowest first, and
`THINKING_LEVELS` is the same list at runtime for validators and pickers. Three optional
`ModelCapabilities` fields say what a model does with it; each is inferred from the model id
when absent, so a spec you register by hand keeps working:

```ts
import { requireModel } from "@arcturn/ai";
import { THINKING_LEVELS } from "@arcturn/types";

const model = requireModel("anthropic/claude-sonnet-4-6");
model.capabilities.thinkingLevels; // ["low", "medium", "high", "max"] — no "xhigh"
model.capabilities.thinkingOff; // "omit"
model.capabilities.refusalFallback; // undefined — no server-side fallback offered
THINKING_LEVELS.includes("xhigh"); // true
```

- **`thinkingLevels`** — the levels above `"off"` the model accepts. A requested level it
  lacks is clamped *down* to the nearest one it has (`xhigh` on Sonnet 4.6 is sent as
  `high`), not sent and refused. OpenAI adapters clamp `xhigh`/`max` to `high`; Gemini to
  `HIGH` (a 32K thinking budget).
- **`thinkingOff`** — a `ThinkingOffStyle`: how `"off"` is spelled on the wire. `"omit"`
  (leave `thinking` out; Claude 4.6–4.8 and budget-era models), `"disabled"` (Sonnet 5,
  Haiku 5.5), `"betweenTools"` (Sonnet 5.5, `{type: "between_tools"}`), or `"lowEffort"`
  (Fable 5 / 5.1, Opus 5, Opus 5.5: thinking cannot be disabled, so `thinking` is left out
  and `effort: "low"` is sent).
- **`refusalFallback`** — the provider can re-run a declined request on another model
  server-side. Only consulted when the host opts in with
  `AnthropicProviderOptions.fallbacks: "default"`; see
  [Providers](/docs/providers#refusals-and-server-side-fallbacks).

The Anthropic adapter also exports the helpers it builds requests with, for hosts that
assemble their own: `anthropicThinkingParams(spec, level, maxTokens)`,
`anthropicThinkingOff(spec)`, `anthropicEffort(spec, level)`, the constants
`ANTHROPIC_THINKING_EFFORT` and `ANTHROPIC_FALLBACK_BETA`, and the types `AnthropicEffort`,
`AnthropicThinkingParam`, `AnthropicThinkingParams`, `AnthropicRequestParams` and
`AnthropicStreamOptions`. `ANTHROPIC_THINKING_BUDGETS` gained `xhigh` (49,152) and `max`
(65,536) for the budget-era models.

## Refusals and `StopDetails`

A provider's decline is a finished turn with its own stop reason, not an `error`:

```ts
import type { AssistantMessage, StopDetails } from "@arcturn/types";

function describe(message: AssistantMessage): string | undefined {
  if (message.stopReason !== "refusal") return undefined;
  const details: StopDetails | undefined = message.stopDetails;
  return details?.category ?? "declined"; // category is provider-defined, and may be null
}
```

`StopReason` is `"endTurn" | "toolCalls" | "maxTokens" | "pauseTurn" | "refusal" | "aborted" | "error"`.
`pauseTurn` is a provider pausing mid-turn after a server-side tool (native tool search);
the loop continues it by re-sending the conversation unchanged, so an SDK consumer only
sees it on the `messageEnd` event, never as a run's final state.
`stopDetails` is `{ category: string | null; explanation?: string }` and is present only
when the stop reason is `refusal`, and only when the provider said anything. Branch on
`stopReason`; treat `category` as informational — it is an open set (`cyber`, `bio`, … on
Claude; the filter's own name elsewhere) and `null` is a valid value. Anthropic's
`stop_reason: "refusal"`, OpenAI's `content_filter` (both APIs), Gemini's safety-class
finish reasons and Bedrock Converse's `content_filtered` / `guardrail_intervened` all arrive
this way.

If you call `llm.complete()` yourself rather than going through the agent loop, check
`stopReason` on the result: the agent loop ends the turn on a refusal and strips any tool
calls from it, but a bare `complete()` hands you the message as the provider sent it.

## Any OpenAI-compatible endpoint, without a preset name

`presetSpec`/`presetModel` cover the well-known services; `openaiCompatible` builds a
`ModelSpec` for literally any OpenAI-compatible Chat Completions endpoint — self-hosted
vLLM, a proxy, an endpoint with no preset entry at all:

```ts
import { openaiCompatible } from "@arcturn/ai";

const model = openaiCompatible("https://my-vllm-host:8000/v1", "my-local-model", {
  displayName: "My local model",
  contextWindow: 32_000,
  apiKeyEnv: "MY_VLLM_API_KEY",
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
  register: true, // add it to the catalog so getModel() finds it later
});
```

For an Anthropic-Messages-compatible endpoint (some providers speak this instead of
Chat Completions — Fireworks, MiniMax, OpenCode), hand-build a `ModelSpec` with
`provider: "anthropic-compatible"` and a `baseUrl` instead — or call `providerSpec(name,
{ label, baseUrl, apiKeyEnv, protocol: "anthropic" }, model)`, which is `presetSpec` for a
record that is not in the preset table and does the protocol→provider mapping and
`<name>/<model>` namespacing for you.

**If you are not embedding, you do not need any of this.** A `providers` block in
`~/.arcturn/config.json` declares the same endpoint from configuration and reaches the
wire down this same `providerSpec` path — see
[Providers § From configuration](/docs/providers#from-configuration). The SDK path stays
for hosts that build their catalog in code, and it still wins: the CLI applies the config
block *before* it loads extensions, so a `registerModel` call can override a config entry.

## Failover chains

`createFailoverClient` wraps an ordered list of clients (or `{ client, model }` pairs)
so a retryable failure — rate limit, overload, network error, never an auth failure or
an abort — transparently retries on the next link, **only while no output has streamed
yet**. Once a single token has reached the consumer, the turn is committed to that model:
switching after that would splice two half-answers together.

```ts
import { createClient, createFailoverClient, requireModel } from "@arcturn/ai";

const client = createClient();
const failover = createFailoverClient(
  [
    { client, model: requireModel("anthropic/claude-sonnet-5-5") },
    { client, model: requireModel("openai/gpt-4o") },
  ],
  { onFailover: (from, to, error) => log(`failing over: ${error.kind}`) },
);
```

Because arcturn keeps conversation state external to the client, failover can happen
mid-conversation — each attempt is just another `stream(request)` call over the same
messages. Pass `failover` as `AgentOptions.llm` and the agent never knows more than one
model is involved.

## Consensus panels

`createConsensusClient` runs the same turn on two or three models concurrently and
reports **disagreement** as a signal, not a gate. The primary streams through to the
consumer verbatim with no added latency; secondaries run in the background and are
folded into a `ConsensusVerdict` delivered to `onVerdict` after the primary's stream
ends — possibly after the consumer's own loop has already finished.

```ts
import { createClient, createConsensusClient, requireModel } from "@arcturn/ai";

const client = createClient();
const panel = createConsensusClient(
  [
    { client, model: requireModel("anthropic/claude-sonnet-5-5") },
    { client, model: requireModel("openai/gpt-4o") },
  ],
  {
    sampleRate: 0.2, // one turn in five; consensus costs roughly 2x on those turns
    onVerdict: (verdict) => {
      if (verdict.agreement === "divergent") {
        log(`models disagree: ${verdict.details.join("; ")}`);
      }
    },
  },
);
```

Worth stating plainly since the module itself does: **a panel of N models bills roughly
N times the tokens of a normal turn**, every sampled turn. `sampleRate` (default `1`)
trades signal for cost; omitting `onVerdict` disables the panel entirely — secondaries
are never called, because a verdict nobody reads isn't worth paying for. Only the
primary's usage reaches the stream's normal `usage` events; `verdict.usageByModel` is
the only place secondary spend is visible, so a host enabling consensus should account
for it separately. `agreement` is `"divergent"` only when the models chose **different
tool calls** — the highest-signal axis — `"partial"` for same actions but different
wording (or no comparable secondary at all), and `"full"` for real agreement.

## Structured output, task budgets and native web tools

Three more optional `ModelCapabilities` fields, each inferred from the model id when absent:

- **`structuredOutput`** — the model takes a JSON schema for its reply (`LLMRequest.responseFormat`).
  Claude 4.5+ and Opus 4.1 on Anthropic, Bedrock-Claude and Vertex-Claude; every OpenAI,
  Azure and Responses model; Gemini 2.5+. A compatible endpoint or a Bedrock Converse model
  has it only when its spec declares it. `supportsStructuredOutput(spec)` asks.
- **`taskBudget`** — the model paces itself against `LLMRequest.taskBudget` (beta
  `task-budgets-2026-03-13`). First-party Anthropic only: Opus 4.7+, Fable/Mythos 5+,
  Sonnet 5.5, Haiku 5.5; not Sonnet 5. `supportsTaskBudget(spec)` asks, and
  `TASK_BUDGET_MIN_TOKENS` is 20,000.
- **`webTools`** — which provider-native web tools the model and platform take, used with
  `LLMRequest.serverTools` (`{ kind: "webSearch" | "webFetch" | "advisor", … }`).

The CLI builds a workflow contract's schema with `contractToJsonSchema` (in its
`contracts.ts`; it is not a library export). The provider helpers `anthropicStructuredOutputModel`,
`anthropicTaskBudgetModel`, `geminiVersion`, `isStrictSchema`, `isOpenAIStrictSchema`,
`strictSchemaCost`, `createStrictBudget`, `withoutAdditionalProperties`,
`openAIStructuredOutputs` and `openAISchemaName` are exported for hosts that build their own
requests. When the advisor tool ran, `Usage.advisor` lists each advisor's tokens and
`costUsd` includes them.

## Cost accounting

```ts
import { calculateCostUsd } from "@arcturn/ai";

const dollars = calculateCostUsd(model, usage); // undefined when the spec has no cost table
```

See [Advanced: cost and usage accounting](/docs/sdk-advanced#cost-and-usage-accounting)
for where `usage` and `costUsd` show up on events and messages.

A model with no `cost` table is never priced as $0 — `costUsd` is simply absent. That
includes models found by `/model refresh` and the current Claude generation on Vertex. On a
refusal-fallback turn the message is priced at the model that answered, and the figure is a
floor: tokens a declined attempt spent are not added.
