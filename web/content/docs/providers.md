---
title: Model providers
description: Every model backend Arcturn can drive, and how to authenticate with each.
section: Start
order: 3
---

## One interface, every backend

Arcturn drives every model through a single `LLMClient` interface, so a provider change is a
`--model` flag rather than a code change. Adapters register themselves into a provider
registry, which is why adding a backend never touches dispatch code.

Nine providers are registered out of the box. The last column is the one worth reading
first — it separates what has been driven against a live endpoint from what has only been
built and unit-tested:

| Provider id | What it drives | Credentials | Verified live |
|---|---|---|---|
| `anthropic` | Claude, direct | `ANTHROPIC_API_KEY` | ✅ Claude Haiku 4.5 |
| `openai` | GPT, Chat Completions | `OPENAI_API_KEY` | ✅ GPT-5 nano |
| `openai-responses` | GPT, Responses API | `OPENAI_API_KEY` | ✅ GPT-5 nano |
| `google` | Gemini, direct | `GOOGLE_API_KEY` | ✅ Gemini 3.5 Flash Lite |
| `openai-compatible` | Any OpenAI-shaped endpoint | Per endpoint | ✅ Z.AI GLM, 170+ sessions |
| `anthropic-compatible` | Any Anthropic-Messages endpoint | Per endpoint | ✅ canonical Messages API |
| `bedrock` | Claude, Nova, Llama, Mistral, Titan on AWS | AWS provider chain | ⚠️ not yet |
| `vertex` | Gemini and Claude on Google Cloud | Application-default credentials | ⚠️ not yet |
| `azure` | GPT on Azure OpenAI | `AZURE_OPENAI_API_KEY` or Entra ID | ⚠️ not yet |

The two compatible adapters matter more than they look: most third-party inference services
speak one of those two protocols, so Arcturn reaches them without a bespoke adapter each.

### What "verified live" means, and why the column exists

A ✅ means a real request went to that provider's real endpoint and came back correct across
four things: streaming text, a tool call whose result is fed back and answered from on a
second turn, usage and cost accounting that matches the published rates, and — where the
provider supports it — a thinking block.

The column exists because every one of those live runs found a bug that a green test suite
could not. Anthropic's found a `--print` that hung forever on an inherited stdin, which is
the exact shape CI uses. Google's found tool calling broken outright: Gemini signs the tool
*call*, not just the thinking that led to it, and rejected every second turn with a 400
until the signature was carried back. OpenAI's found the Responses adapter documented here
but impossible to select, because it shipped with no catalog entries.

None of those were reachable by unit tests, and two were in features these docs advertised
as working. So a ⚠️ is not a claim that an adapter is broken — the code is implemented,
reviewed and unit-tested, and `bedrock` and `azure` reuse stream translation that the ✅
rows exercise. It is a claim about what has been *demonstrated*, and given the hit rate
above, the honest distinction is worth more to you than a longer list of ticks.

One honest qualification on the two compatibility adapters. Each was verified against a
single implementation of its protocol — `openai-compatible` against Z.AI's GLM endpoints
across 170-odd real sessions, `anthropic-compatible` against a canonical Messages API. That
proves the adapter's own request shaping, streaming, tool assembly and accounting; it does
not prove any particular third-party service, which may deviate in its own way.

The three unverified cloud backends need an AWS account with model access, a GCP project
with application-default credentials, or an Azure deployment respectively — which is why
they are the ones still outstanding. If you run Arcturn against one, the result is worth
reporting either way.

## Cloud backends

**AWS Bedrock** authenticates through the standard AWS provider chain, so profiles, SSO,
environment variables and IAM roles all work with no extra configuration. Claude models
route through the Bedrock Anthropic SDK; everything else goes through ConverseStream.

```bash
export AWS_REGION=us-east-1
arcturn --model bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

**Google Vertex** uses application-default credentials — `gcloud auth application-default
login`, a service-account JSON in `GOOGLE_APPLICATION_CREDENTIALS`, or workload identity.

```bash
export GOOGLE_CLOUD_PROJECT=my-project
arcturn --model vertex/gemini-2.5-pro
```

**Azure OpenAI** addresses a *deployment*, not a model name — the deployment you created in
your resource is what goes on the wire.

```bash
export AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com
export AZURE_OPENAI_API_KEY=...
arcturn --model azure/my-deployment
```

Region, project and deployment live in `ModelSpec.providerOptions`, which addresses the
service. That is deliberately separate from `LLMRequest.providerOptions`, which is merged
into the request body — routing data must never leak into a payload.

## Presets

A preset is a remembered `{ baseUrl, apiKeyEnv, protocol }` triple for a well-known
endpoint, so you can name it instead of repeating a URL — `presetSpec("groq", "llama-3.3-70b-versatile")`
instead of hand-building an `openaiCompatible()` call. Presets are a convenience, not a
gate: they resolve lazily (`getModel`/`presetModel` pull in the whole table on first miss,
via `wireExtendedPresets` in `packages/ai/src/catalog.ts`), so nothing needs an explicit
registration call to be reachable by id. Run `arcturn --list-providers` to see which ones have
their key set.

All 35 presets, from `packages/ai/src/presets.ts`:

| Preset | Protocol | Base URL | Key env var |
|---|---|---|---|
| `groq` | openai | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `deepseek` | openai | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `together` | openai | `https://api.together.ai/v1` | `TOGETHER_API_KEY` |
| `cerebras` | openai | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `nvidia` | openai | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `huggingface` | openai | `https://router.huggingface.co/v1` | `HF_TOKEN` |
| `baseten` | openai | `https://inference.baseten.co/v1` | `BASETEN_API_KEY` |
| `fireworks` | anthropic | `https://api.fireworks.ai/inference` | `FIREWORKS_API_KEY` |
| `moonshot` | openai | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` |
| `moonshot-cn` | openai | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
| `zai` (coding plan) | openai | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` |
| `zai-api` (general API) | openai | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` |
| `zai-cn` (coding, China) | openai | `https://open.bigmodel.cn/api/coding/paas/v4` | `ZAI_CODING_CN_API_KEY` |
| `qwen` | openai | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-cn` | openai | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `qwen-individual` | openai | same base as `qwen` | `QWEN_TOKEN_PLAN_API_KEY` |
| `xiaomi` | openai | `https://api.xiaomimimo.com/v1` | `XIAOMI_API_KEY` |
| `xiaomi-ams` | openai | `https://token-plan-ams.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| `xiaomi-cn` | openai | `https://token-plan-cn.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| `xiaomi-sgp` | openai | `https://token-plan-sgp.xiaomimimo.com/v1` | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| `ant-ling` | openai | `https://api.ant-ling.com/v1` | `ANT_LING_API_KEY` |
| `minimax` | anthropic | `https://api.minimax.io/anthropic` | `MINIMAX_API_KEY` |
| `minimax-cn` | anthropic | `https://api.minimaxi.com/anthropic` | `MINIMAX_CN_API_KEY` |
| `openrouter` | openai | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `vercel-gateway` | anthropic | `https://ai-gateway.vercel.sh` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | openai | `.../accounts/{account_id}/ai/v1` (unverified shape) | `CLOUDFLARE_API_KEY` |
| `cloudflare-ai-gateway` | anthropic | `.../v1/{account_id}/{gateway_id}/compat` (unverified shape) | `CLOUDFLARE_API_KEY` |
| `opencode` (Zen) | anthropic | `https://opencode.ai/zen` | `OPENCODE_API_KEY` |
| `opencode-go` (Go) | openai | `https://opencode.ai/zen/go/v1` | `OPENCODE_API_KEY` |
| `kimi-coding` | anthropic | `https://api.kimi.com/coding` | `KIMI_API_KEY` |
| `mistral` | openai | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `xai` | openai | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `ollama` | openai | `http://localhost:11434/v1` | `OLLAMA_API_KEY` (local; any value works) |
| `lmstudio` | openai | `http://localhost:1234/v1` (unverified — LM Studio convention) | `LMSTUDIO_API_KEY` (unverified) |
| `vllm` | openai | `http://localhost:8000/v1` (unverified — vLLM convention) | `VLLM_API_KEY` (unverified) |

A few notes worth calling out because they are easy to get wrong:

- **Z.AI is three presets, not one.** `zai` is the coding-plan path; `zai-api` is the
  general pay-as-you-go API at a different URL entirely; `zai-cn` is the coding plan on
  the China endpoint with its own key env var (`ZAI_CODING_CN_API_KEY`). Picking the wrong
  one 404s or 401s — `zai-api` was confirmed by observing a 401 (not a 404) from
  `api.z.ai`, meaning the path is right and only the key was missing.
- **DeepSeek needs `/v1`.** DeepSeek's own SDK omits it, but Arcturn drives OpenAI-compatible
  endpoints through the raw `openai` client, which appends `/chat/completions` with no
  version segment inserted — so the base URL must include `/v1` itself.
- **Cloudflare's two presets have templated base URLs.** Both `cloudflare-workers-ai` and
  `cloudflare-ai-gateway` embed `{account_id}` (and, for the AI Gateway, `{gateway_id}`) —
  there is no single static base URL, so substitute your own before use, e.g. by overriding
  `baseUrl` on the `ModelSpec` `presetSpec` returns.
- **`lmstudio` and `vllm` are marked unverified.** Neither is a provider the reference
  implementation ships; their base URLs and key env var names are community conventions
  (LM Studio's default local port, `vllm serve`'s default port), not values sourced from a
  first-party adapter.

Model ids pass through verbatim, so anything the endpoint serves works:

```bash
export ZAI_API_KEY=...
arcturn --model zai/glm-5.3        # coding plan
arcturn --model zai-api/glm-5.2    # general API
```

Z.AI is split deliberately: `zai` is the coding-plan path and `zai-api` the general
pay-as-you-go API. They are different URLs, and the wrong one 404s.

Nothing here is a gate. Any endpoint works without a preset:

```ts
import { openaiCompatible } from "@arcturn/ai";

openaiCompatible("https://my-endpoint.example/v1", "my-model", {
  apiKeyEnv: "MY_API_KEY",
  register: true,
});
```

## Resolving a model id

`getModel(id)` (from `packages/ai/src/catalog.ts`) accepts two shapes: a full catalog id
(`"anthropic/claude-opus-4-5"`) or a bare wire model name (`"claude-opus-4-5"`) when that
name is unambiguous across every registered spec. A miss triggers the extended-preset
world to register itself once (lazily, so a fresh process never pays for the whole preset
table unless something actually needs it), then retries the lookup. `requireModel(id)` is
the same lookup but throws `Unknown model: <id>` instead of returning `undefined` — the CLI
uses it anywhere a missing model should stop the run rather than silently degrade.
`registerModel(spec)` overrides or extends the catalog at runtime — the mechanism
`presetSpec({ register: true })` and `refreshCatalog` both use internally, and the same one
available to embedders who want to register a private endpoint.

## Failover chains

A model string can be an array instead of a single id — `["anthropic/claude-sonnet-4-5",
"openai/gpt-4o"]` — which builds a fallback chain via `createFailoverClient` in
`packages/ai/src/failover.ts`. Each link is tried in order; an attempt that fails
*before any content has streamed* hands off to the next link, so the caller sees one
continuous stream even though a different model produced the answer.

The one rule that matters: **failover only happens before output starts.** The moment a
single `textDelta`, `thinkingDelta`, or tool-call event reaches the consumer, the turn is
committed to that model — a later error surfaces unchanged rather than triggering a
switch, because splicing two half-answers together would corrupt the message. Structural
events (`start`, `usage`, `blockEnd`) don't count as output and don't commit a turn; the
leading `start` is held back until an attempt actually commits, so exactly one `start`
event is ever emitted, naming whichever model actually answered.

By default (`defaultShouldFailover`), only transient errors trigger a switch: `rateLimit`,
`overloaded`, and `network`. `auth`, `invalidRequest`, `aborted`, and `unknown` never do —
a bad API key or a malformed request fails identically on every link, and a user abort is
the user's own intent, so burning through the whole chain on either would be pointless.
Override the policy, or observe every switch, with `FailoverOptions`:

```ts
import { createFailoverClient, requireModel } from "@arcturn/ai";

const failover = createFailoverClient(
  [
    { client, model: requireModel("anthropic/claude-sonnet-4-5") },
    { client, model: requireModel("openai/gpt-4o") },
  ],
  { onFailover: (from, to, error) => console.warn(`failing over: ${error.kind}`) },
);
```

## Consensus: cross-checking models for disagreement

Where failover treats multiple providers as redundancy, `createConsensusClient`
(`packages/ai/src/consensus.ts`) treats them as an uncertainty signal: run the same turn
on two or three independently trained models and treat *disagreement* — especially over
which tool calls to make — as the place a human should look. Asking a model "are you sure?"
is close to worthless, since the same weights produce the confidence report as the answer;
running a second model is not.

The primary (`links[0]`) streams through to the consumer **verbatim** — same events, same
order, no added latency to the first token. Secondaries run concurrently, buffered to
completion, and the verdict is delivered out-of-band through `onVerdict` after the
primary's stream ends — never gating the turn on agreement. `onVerdict` fires at most once
per `stream()` call and never before the primary's terminal event.

```ts
import { createConsensusClient, requireModel } from "@arcturn/ai";

const panel = createConsensusClient(
  [
    { client, model: requireModel("anthropic/claude-sonnet-4-5") },
    { client, model: requireModel("openai/gpt-4o") },
  ],
  {
    sampleRate: 0.2, // one turn in five; consensus costs 2x on those turns
    similarityThreshold: 0.6, // DEFAULT_SIMILARITY_THRESHOLD
    onVerdict: (v) => {
      if (v.agreement === "divergent") console.warn(`models disagree: ${v.details.join("; ")}`);
    },
  },
);
```

Config shape (`ConsensusOptions`):

| Field | Default | Meaning |
|---|---|---|
| `onVerdict` | none | Required for the panel to run at all — omitting it means secondaries are never called, since a verdict nobody reads isn't worth paying for. |
| `sampleRate` | `1` (every turn) | Fraction of turns that run the panel. `0.1` samples one turn in ten; sampled-out turns cost exactly one model and emit no verdict — absence of a verdict is not agreement. |
| `similarityThreshold` | `0.6` | Minimum word-overlap similarity for `"full"` agreement once tool calls already match. Kept low deliberately: two models answering correctly routinely share only 60–70% of their words. |
| `random` | `Math.random` | Injectable for deterministic sampling in tests. |

`agreement` is `"full"` (tool calls match and text similarity clears the threshold),
`"partial"` (tool calls match but text diverges, or no secondary was available to compare
against), or `"divergent"` (the models chose *different tool calls* — the highest-signal
finding). Comparison happens once, on the final assembled message: `toolCallsMatch` diffs
names/order/canonicalized-JSON arguments (call ids and key order ignored); `textSimilarity`
is a cheap Jaccard word-overlap over concatenated text blocks (thinking blocks excluded).
`usageByModel` is the only way to price a panel correctly — only the primary's usage reaches
the consumer's normal `usage` stream events, so a host that turns consensus on must surface
secondary spend separately. **This multiplies token spend by N** on every sampled turn;
there is no way around that cost, only ways to bound it (`sampleRate`, or simply not
supplying `onVerdict`).

## Per-role routing

`createModelRouter` (`packages/cli/src/router.ts`) lets four different call sites use four
different models instead of hard-coding one flagship everywhere:

| `RouteKind` | What it's for |
|---|---|
| `main` | The main conversation loop. |
| `subagent` | Delegated sub-agent work — often mechanical, so a cheaper model is fine. |
| `compaction` | Summarizing history when the context window fills — lossy by design already. |
| `title` | Session-title suggestions — a few words. |

Config shape (`RouterConfig`): each key is an optional model id string. `main` absent means
"use the fallback model" (typically whatever `--model` resolved to); `subagent` /
`compaction` / `title` absent means "use whatever `main` resolves to". Resolution is lazy
and cached per kind — nothing resolves until `router.specFor(kind)` is actually called — and
a bad id (unknown model, deregistered preset, typo) is caught rather than thrown: the kind
falls back to the router's fallback model and a warning is recorded via `router.warnings()`,
because a stale model id in a config file must never be the reason Arcturn fails to start.
`router.rebind(newFallback)` clears the cache and adopts a new fallback — call it after the
session's main model changes, or routes that defaulted to the old one keep resolving to it.

## Live model catalog

The curated catalog above is hand-maintained, which means it goes stale the moment a
provider ships a new generation. `/model refresh` complements it with a best-effort
query of each preset's own "list models" endpoint — for whichever presets already have
an API key set — and registers anything new it finds into the same runtime catalog,
without ever touching or overwriting a curated entry:

```
/model refresh
```

Results are cached at `~/.arcturn/live-models.json` for 24 hours, so this doesn't hit the
network on every invocation — a fresh cache entry is reused as-is. A model discovered
this way that isn't in the curated table gets conservative defaults (128k context
window, 8,192 max output tokens, `tools: true`, `vision`/`thinking`/`caching: false`)
until a curated entry supersedes it.

Discovery speaks whichever protocol the preset uses: OpenAI-protocol presets are queried
at `<baseUrl>/models` with a bearer token; Anthropic-protocol presets are queried at
`<baseUrl>/v1/models` with `x-api-key` — but only when the preset's base URL is a bare
origin with no path segment of its own, since several Anthropic-protocol presets already
end in something like `/anthropic` or `/coding` for the Messages endpoint, and guessing a
model-listing path onto that would be just that — a guess. A preset whose refresh fails
falls back to its last cached result (with a warning) rather than dropping its models
for that round.

## Subscription sign-in is not supported

You cannot point Arcturn at a Claude, ChatGPT or GitHub Copilot subscription. Signing in
with one requires an OAuth client id that each provider issues to its own product, and
Arcturn has none. Use an API key.

An earlier release shipped `arcturn auth login` for those three providers. It never
completed a sign-in — the client ids belonged to other vendors' tools and no endpoint or
scope in it had been checked against a live provider — so it was removed rather than left
in the help text as something that might work.

[MCP OAuth](/docs/mcp) (`arcturn mcp auth <name>`) is a different mechanism and does work:
it discovers the authorization server and registers a client dynamically, so it needs no
hardcoded endpoint and no borrowed client id.

## Choosing a model in code

```ts
import { createClient, getModel, presetSpec, bedrockModel } from "@arcturn/ai";

const llm = createClient();

const direct = getModel("anthropic/claude-sonnet-4-5");
const viaPreset = presetSpec("groq", "llama-3.3-70b-versatile");
const onAws = bedrockModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0", {
  providerOptions: { region: "us-east-1" },
});
```

Costs are tracked per request when a model's pricing is known; where a price could not be
sourced confidently it is omitted rather than guessed, so `costUsd` is simply absent.

## Related

- [Model routing](/docs/model-routing) — the config-and-precedence reference behind the
  per-role routes above: what each route kind resolves to, and which layer wins.
- [Configuration](/docs/configuration) — where `model`, `route` and provider credentials
  sit among every other key, and how session, project and user layers combine.
- [Audit trail & cost accounting](/docs/audit-cost) — what the per-request cost above adds
  up to across a whole session, and the `--max-cost` ceiling that stops it.
