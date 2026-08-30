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

requireModel("anthropic/claude-sonnet-4-5"); // throws on an unknown id
getModel("claude-sonnet-4-5"); // also matches by bare wire model name; undefined if unknown
presetModel("groq", "llama-3.3-70b-versatile"); // ad-hoc ModelSpec for a known preset, no registration needed
```

`getModel`/`requireModel` accept either a full catalog id (`"anthropic/claude-sonnet-4-5"`)
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
    { client, model: requireModel("anthropic/claude-sonnet-4-5") },
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
    { client, model: requireModel("anthropic/claude-sonnet-4-5") },
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

## Cost accounting

```ts
import { calculateCostUsd } from "@arcturn/ai";

const dollars = calculateCostUsd(model, usage); // undefined when the spec has no cost table
```

See [Advanced: cost and usage accounting](/docs/sdk-advanced#cost-and-usage-accounting)
for where `usage` and `costUsd` show up on events and messages.
