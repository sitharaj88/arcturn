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
their key set. To check that a key actually *works* — not just that it is set — run
`arcturn doctor`: it probes every configured endpoint with a one-token completion and prints a
per-endpoint verdict, telling a rejected key apart from an empty balance or a key that belongs
on a sibling endpoint (a coding-plan key pointed at `zai-api` answers "insufficient balance";
doctor says to try `zai`).

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
arcturn --model zai/glm-5.3-flash    # coding plan, fast tier
arcturn --model zai/glm-5.3          # coding plan, flagship
arcturn --model zai-api/glm-5.2      # general API
```

Z.AI is split deliberately: `zai` is the coding-plan path and `zai-api` the general
pay-as-you-go API. They are different URLs, and the wrong one 404s.

The curated GLM lineup, verified against both endpoints on 2026-09-02:

| Model | Coding plan (`zai`, `zai-cn`) | General API (`zai-api`) | Context / max out |
| --- | --- | --- | --- |
| `glm-5.3-flash` | yes — 3x the plan quota of GLM-5.3 | $0.15 / $0.50 per MTok | 1M / 131,072 |
| `glm-5.3` | yes | $1.40 / $4.40 | 1M / 131,072 |
| `glm-5.2`, `glm-5.1`, `glm-5` | auto-routed to `glm-5.3` | $1.40 / $4.40 (`glm-5`: $1.00 / $3.20) | 1M / 131,072 |
| `glm-5-turbo` | yes | $1.20 / $4.00 | 200K / 131,072 |
| `glm-4.7` | yes | $0.60 / $2.20 | 200K / 131,072 |
| `glm-4.7-flashx` | no — billed separately | $0.07 / $0.40 | 200K / 131,072 |
| `glm-4.7-flash` | yes | free | 200K / 131,072 |
| `glm-4.6` | yes | $0.60 / $2.20 | 200K / 131,072 |
| `glm-4.6v` (vision) | yes | $0.30 / $0.90 | 128K / 32,768 |
| `glm-4.6v-flash` (vision) | yes | free | 128K / 32,768 |

Three things in that table are load-bearing:

- **The coding plan carries no prices, on purpose.** It is a subscription, so a per-token
  figure for `zai/*` is not a number that exists; cost surfaces say "your plan covers it"
  rather than `$0.00`, which would read as free. The side effect is that
  `/model route --auto` never fires for a coding-plan main — it only picks candidates
  that publish a cost. Name the cheap tier yourself: `"cheap": "zai/glm-5.3-flash"`.
- **`glm-5.2`, `glm-5.1` and `glm-5` are not distinct models on the coding endpoint.**
  Asking for one returns a response stamped `model: "glm-5.3"`. They are listed under
  `zai-api` only, where they bill as themselves.
- **The vision pair caps output at 32,768 tokens**, a quarter of the text models'. They
  are the only image-capable models a plan-only key can reach, but they are not a drop-in
  substitute for GLM-5.3 on long output.

Prices are USD per million tokens (input / output) from Z.AI's rate card and are recorded
at **list** price — GLM-5.3-Flash runs at half these until 2026-09-09, and baking a
promotion into the catalog would leave every install under-reporting spend the day it
lapses.

Nothing here is a gate. Any endpoint works without a preset, from configuration or from
code.

### From configuration

A `providers` block in `~/.arcturn/config.json` declares an endpoint of your own — an
enterprise gateway (LiteLLM, a vLLM cluster, an internal proxy), Ollama on a non-default
host. It is the same `{ baseUrl, apiKeyEnv, protocol }` triple a preset is, and it builds
its specs through the same function, so ids are namespaced `<name>/<model>` exactly as
presets are:

```jsonc
{
  "providers": {
    "mycorp": {
      "baseUrl": "https://llm.corp.internal/v1",
      "apiKeyEnv": "MYCORP_LLM_KEY",   // REQUIRED
      "protocol": "openai",            // "openai" | "anthropic", default "openai"
      "label": "MyCorp Gateway",
      "models": [                      // optional; absent = ids pass through verbatim
        { "model": "llama-70b", "contextWindow": 128000, "maxOutputTokens": 8192,
          "capabilities": { "tools": true }, "cost": { "input": 0, "output": 0 } }
      ]
    }
  }
}
```

```bash
arcturn --model mycorp/llama-70b
```

Every rule below drops the offending entry with a warning; nothing throws, and a bad entry
never takes its siblings with it.

- **The variable it names is the only credential it gets.** A spec built from a `providers`
  block is registered *key-exclusive*: `apiKeyEnv` is resolved and nothing else — no
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` provider default, no per-provider alternate, no
  client-wide key. Name a variable you do not have set and the session refuses, naming the
  provider, the variable and the file that declared it. It never starts on a borrowed key,
  and that holds for both protocols and for your own file as much as for a project's.
- **`apiKeyEnv` is required for a remote endpoint**, so the credential choice is visible in
  the file and reviewable in a diff. **A loopback endpoint may omit it**, and is then
  contacted with no credential at all — that is how you declare Ollama, LM Studio or a
  local vLLM:

  ```jsonc
  { "providers": { "ollama-host": { "baseUrl": "http://localhost:11434/v1" } } }
  ```

  A loopback entry that *does* name a variable is held to it: the endpoint expects a key,
  so an unset one is an error naming the variable rather than a silent substitute.
- **`https:` only**, except `http://localhost` (and `127.0.0.1`, `::1`) for a local
  runtime. An API key sent in the clear to a remote host is a leaked credential.
- **The name may not collide** with a preset or a registered provider id — no shadowing.
- **A base URL still carrying a `{placeholder}`** is dropped rather than dialled.
- **A base URL containing a control character is refused** (C0, DEL, C1), and what is
  stored is the normalized `new URL(...).href`, not the string as typed. `URL` is not a
  filter here — it strips tab/LF/CR and percent-encodes ESC — and this value is printed
  into the terminal prompt that asks whether to trust the endpoint.
- **A project file may not name a variable holding a credential you keep for someone
  else.** The rule is the set, not a list: every first-party default and alternate, every
  one of the built-in provider presets' `apiKeyEnv` values (derived from the preset table,
  so adding a preset extends the rule automatically), the ambient-credential variables, and
  anything beginning `AWS_`. Comparison is case-insensitive, because `process.env` is
  case-insensitive on Windows. Your own `~/.arcturn/config.json` may name any of them —
  proxying Anthropic through LiteLLM is a real setup — but no repository you cloned has a
  reason to ask for a key you hold for somebody else.
- **Declared `models[]` entries are validated, not trusted.** `cost.input`/`cost.output`
  must be finite and non-negative — `--max-cost` sums them, and a negative rate would earn
  budget on every turn — and each `capabilities` field is checked by name and type, with a
  bad or unknown one dropped and warned about rather than cast through. Besides the four
  booleans and `thinkingStyle`, an entry may declare `thinkingOff` (`"omit"`, `"disabled"`,
  `"betweenTools"` or `"lowEffort"` — how "off" is sent), `thinkingLevels` (the effort levels
  the model accepts; a requested level it lacks is clamped down) and `refusalFallback`. A
  gateway has no catalog id for the adapter to infer these from, so a gateway serving
  Sonnet 5.5 under its own name needs `"thinkingOff": "betweenTools"` or it will think by
  default.

A declaration in `~/.arcturn/config.json` is your own file and is trusted. **A declaration
in a project's `.arcturn/config.json` is inert until you approve it** — see
[Provider endpoints from a project config](/docs/permissions#provider-endpoints-from-a-project-config),
including [what that gate is not](/docs/permissions#what-this-gate-is-not): it stops a
repository that declares an endpoint in *data*, and is not a boundary against one that can
execute code, since project hooks and project extensions run with no gate today.

`arcturn --list-providers` shows every declared endpoint with its state; `arcturn doctor`
reports one you have not enabled as `not enabled` and never probes it.

### From code

```ts
import { openaiCompatible } from "@arcturn/ai";

openaiCompatible("https://my-endpoint.example/v1", "my-model", {
  apiKeyEnv: "MY_API_KEY",
  register: true,
});
```

An extension's `registerModel` runs *after* the config block is applied, so code can
override an entry a config file declared. Data never overrides code.

## Resolving a model id

`getModel(id)` (from `packages/ai/src/catalog.ts`) accepts two shapes: a full catalog id
(`"anthropic/claude-opus-5-5"`) or a bare wire model name (`"claude-opus-5-5"`) when that
name is unambiguous across every registered spec. A miss triggers the extended-preset
world to register itself once (lazily, so a fresh process never pays for the whole preset
table unless something actually needs it), then retries the lookup. `requireModel(id)` is
the same lookup but throws `Unknown model: <id>` instead of returning `undefined` — the CLI
uses it anywhere a missing model should stop the run rather than silently degrade.
`registerModel(spec)` overrides or extends the catalog at runtime — the mechanism
`presetSpec({ register: true })` and `refreshCatalog` both use internally, and the same one
available to embedders who want to register a private endpoint.

## Failover chains

A model string can be an array instead of a single id — `["anthropic/claude-sonnet-5-5",
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
    { client, model: requireModel("anthropic/claude-sonnet-5-5") },
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
    { client, model: requireModel("anthropic/claude-sonnet-5-5") },
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
| `compaction` | Summarizing history when the context window fills — lossy by design already. Consumed by every agent's compaction call only when a `compaction` route is explicitly configured; otherwise every agent compacts with its own model, even while a `route.main` override stands. |
| `title` | Session-title suggestions — a few words, generated after a session's first completed run. |

All four kinds are live: `subagent` drives delegated work, `compaction` picks the
summarizer model, and `title` picks the model that names a session for `/sessions`. Config
shape (`RouterConfig`): each key is an optional model id string. `main` absent means
"use the fallback model" (typically whatever `--model` resolved to); `subagent` /
`compaction` / `title` absent means "use whatever `main` resolves to". Resolution is lazy
and cached per kind — nothing resolves until `router.specFor(kind)` is actually called — and
a bad id (unknown model, deregistered preset, typo) is caught rather than thrown: the kind
falls back to the router's fallback model and a warning is recorded via `router.warnings()`,
because a stale model id in a config file must never be the reason Arcturn fails to start.
`router.rebind(newFallback)` clears the cache and adopts a new fallback — call it after the
session's main model changes, or routes that defaulted to the old one keep resolving to it.

You don't have to write the config by hand: `/model route` prints the effective routes,
and `/model route --auto` finds the cheapest same-vendor (same id namespace before the
`/`), tool-capable model with published pricing that undercuts a priced main model, and
routes `subagent` and `compaction` to it — applied live and saved
to your user config in one step. See
[Model routing](/docs/model-routing#cost-rationale-and-model-route---auto).

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
until a curated entry supersedes it — except that the Anthropic Models API reports
`max_input_tokens` (the context window) and `max_tokens` (the output cap) for every model,
and when it does, those replace the defaults, so a brand-new Claude is sized by what
Anthropic says rather than a 128K guess. A model found this way is still unpriced: limits
are read from the listing, a price never is, and cost reads as unknown rather than $0.

Discovery speaks whichever protocol the preset uses: OpenAI-protocol presets are queried
at `<baseUrl>/models` with a bearer token; Anthropic-protocol presets are queried at
`<baseUrl>/v1/models` with `x-api-key` — but only when the preset's base URL is a bare
origin with no path segment of its own, since several Anthropic-protocol presets already
end in something like `/anthropic` or `/coding` for the Messages endpoint, and guessing a
model-listing path onto that would be just that — a guess. A preset whose refresh fails
falls back to its last cached result (with a warning) rather than dropping its models
for that round.

## Claude models and what changed with the 5.5 generation

The curated Anthropic entries, newest first within each family (every one a 1M-token
context window and 128K output; prices are per million tokens):

| Model | Input / output | Cache read | Notes |
|---|---|---|---|
| `anthropic/claude-fable-5-1` | $10 / $50 | $0.25 | Server-side refusal fallback available. |
| `anthropic/claude-fable-5` | $10 / $50 | $1 | |
| `anthropic/claude-opus-5-5` | $4 / $20 | $0.20 | Server-side refusal fallback available. |
| `anthropic/claude-opus-5` | $5 / $25 | $0.50 | Server-side refusal fallback available. |
| `anthropic/claude-opus-4-8`, `-4-7`, `-4-6` | $5 / $25 | $0.50 | Opus 4.6 has no `xhigh` thinking level. |
| `anthropic/claude-sonnet-5-5` | $2 / $10 | $0.20 | The default model. Server-side refusal fallback available. |
| `anthropic/claude-sonnet-5` | $2 / $10 | $0.20 | |
| `anthropic/claude-sonnet-4-6` | $3 / $15 | $0.30 | No `xhigh`. |
| `anthropic/claude-haiku-5-5` | $0.10 / $0.50 | $0.01 | |

Claude Haiku 5.5's rate is the one for prompts of 100K tokens or fewer; longer prompts bill
at $0.50 / $2.50. The catalog carries a single rate per model, so a cost estimate for a very
long Haiku prompt is a floor. `arcturn --list-models` prints the full catalog, including
older generations that remain selectable.

**Bedrock has not caught up.** The Claude 5.x and Opus 4.7+ models on AWS are served by
Bedrock's Messages-API (Mantle) endpoint, and Arcturn's Bedrock adapter still speaks the
older `bedrock-runtime` API, so no catalog entries exist for them — shipping ones that
would answer with a 400 seemed worse than shipping none. Moving the adapter is a planned
follow-up. **Vertex** lists the same Claude ids under their bare first-party names, but
unpriced: Google Cloud bills on its own rate card, which Arcturn has not verified, so spend
on those models reads as cost unknown rather than borrowing Anthropic's price.

## Refusals and server-side fallbacks

A model can decline a request outright. Arcturn treats that as its own outcome rather than
an error or an empty reply: the assistant message ends with `stopReason: "refusal"` and a
`stopDetails` of `{ category, explanation? }`. The turn ends cleanly — there is no "turn
returned nothing" nudge that would re-send the declined request, any tool calls in the
refused message are stripped and never run, a refused message is skipped when history is
replayed to the provider, and a compaction whose summary is refused throws instead of
installing a fragment as the summary.

Each provider's own wording maps onto it, and `category` carries the provider's word for why:

| Provider | Becomes a refusal | `category` |
|---|---|---|
| Anthropic | `stop_reason: "refusal"` | the `stop_details` category (`cyber`, …), or `null` |
| OpenAI (Chat Completions and Responses) | `content_filter` | `content_filter` |
| Google | `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY` | the filter name |
| Bedrock Converse | `content_filtered`, `guardrail_intervened` | the filter name |

You see it as "The model declined this request (cyber): <explanation>" in the TUI, the
transcript and the web UI. See [Programmatic events](/docs/sdk-events#refusals) for the
event shape and [CLI reference](/docs/cli-reference) for what `--print` does.

For models the Claude API can re-run on a fallback after a decline, there is an opt-in:

```json
{ "providers": { "anthropic": { "fallbacks": "default" } } }
```

It is **off by default**. With it on, requests to a model that supports it (today Fable 5.1,
Opus 5.5, Opus 5 and Sonnet 5.5) go through the Anthropic beta surface with the
`server-side-fallback-2026-07-01` beta and `fallbacks: "default"`; when the first model
declines, the API answers the turn with a fallback model and the message is stamped with
the model that actually answered. It is never sent to Claude Haiku 5.5, which has no
server-side fallback. Billing follows the answering model — see
[Audit trail & cost accounting](/docs/audit-cost). From code, the same switch is
`AnthropicProviderOptions.fallbacks`.

## Preserved thinking

On Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block's signature is
bound to the exact prefix that produced it — the system prompt, the tool set and every
earlier message. Replay the block after any of those changed and the API treats it as
invalid:

- **Enforced accounts** — those created on or after 2026-08-31 — get a **400**.
- **Other accounts** go through. With the controls below on, the API still reports that an
  enforced account would have been refused (`thinking_mismatch_allowed`), which arcturn
  shows as a warning.

Arcturn's answer is not to catch the 400 but to never send a changed prefix: tool-result
elision, compaction, tool-search activation and operator messages all append now. See
[Why history is append-only](/docs/context-management#why-history-is-append-only). The
same property keeps the prompt cache warm on every model, which is why the machinery runs
for all Claude models on adaptive thinking (4.6 and later) and not only the four enforced
ones.

### `thinkingBinding`

```jsonc
{ "providers": { "anthropic": { "thinkingBinding": "drop_block" } } }
```

From code: `AnthropicProviderOptions.thinkingBinding` /
`CreateClientOptions.thinkingBinding`. First-party `anthropic` only — the compatible,
Bedrock and Vertex adapters ignore it. It sends the `thinking-binding-controls-2026-08-01`
beta and, on every request with thinking on,
`thinking.block_binding.prefix_mismatch_behavior`:

| Value | A mismatched block |
|---|---|
| `"error"` | The request fails. Use it in CI, where a history edit is a bug to find. |
| `"drop_block"` | The API drops the unusable block and the request continues. |

Setting it also makes `contextEditing.mode` default to `auto`, since asking for the
controls is asking for an append-only history. `arcturn doctor` lists the setting.

### What you will see

What the API reports in `input_transformations` becomes a notice (`inputTransformationNotices`
in `@arcturn/core`), and `AssistantMessage.inputTransformations` keeps the non-empty list:

| Notice | Level | Meaning |
|---|---|---|
| `prefix_binding_mismatch` (`thinking_dropped`) | warn | The conversation before a thinking block changed after the block was produced. Arcturn keeps history append-only, so **this is a bug in arcturn** — the notice says so. Report it with the session. |
| `thinking_mismatch_allowed` | warn | The same mismatch on an account that is not enforced. The request went through; an enforced account would have been refused. |
| `model_binding_mismatch` (`thinking_dropped`) | info | You switched models (`/model`, a fallback) and the new model cannot read the old model's thinking. Expected. |

Separately, if the `system` prompt or tool set differs between two requests in one run —
an MCP server attached, a deferred-tool activation on a model without native tool search —
the agent says so once, and stops replaying the earlier thinking it just invalidated.

Not verified live: the streaming shape of `input_transformations` on `message_delta`, and
`block_binding` sent alongside the `lowEffort` adaptive spelling.

## Mid-conversation system messages

The harness occasionally needs to say something to the model that is not you: a turn-budget
warning, a progress check, a nudge after a silent turn, a stale-todo reminder. These are
stored as `role: "system"` messages (`SystemMessage`) and **rendered per provider at send
time**, so a `/model` switch re-renders the same history correctly:

| Provider / model | Rendered as |
|---|---|
| Anthropic — Opus 4.8, 5, 5.5; Fable 5, 5.1; Sonnet 5.5 | A native `role: "system"` message. |
| Anthropic — Sonnet 5, Haiku 5.5 | Folded into the neighbouring user turn as a `<system-reminder>` block. |
| OpenAI and Azure — Chat Completions | Native `system` message. |
| OpenAI — Responses | A `developer` item. |
| Google | Folded into the user turn, text prefixed `[operator]`. |
| Bedrock | Folded, as for Sonnet 5. |
| OpenAI-compatible gateways | Folded: a `<system-reminder>`-shaped user message. |

Where a model takes the native role, Anthropic still only allows it after a user turn and
last or before an assistant turn — never first — so a message that would land elsewhere is
folded instead. The same history always renders the same bytes.

Support is inferred from the model id. From code, a `ModelSpec` whose
`capabilities.systemMessages` is set overrides that inference; it is not a
`.arcturn/config.json` capability key today, so a gateway serving one of these models
under a string arcturn does not recognise gets the folded form.

If an API refuses the role anyway, arcturn recognises the 400 by its wording, marks that
model unsupported for the rest of the process, and retries the request once folded.

This channel carries operator authority, so it is for harness-authored text only. Anything
a tool, a file or another agent produced is data and goes in a tool result or user message.
In the SDK, `agent.steer("text")` stays a **user** message; `agent.steer(text, { from:
"operator" })` is the opt-in. See [Agent options](/docs/sdk-agent-options#steering-from-the-host).

Not verified live: the exact wording of the 400 for an unsupported role, and Bedrock
accepting `role: "system"` (it is folded today, so nothing depends on it).

## Server-side context management

`compaction.shape: "server"` and `contextEditing.mode: "server"` hand compaction and
tool-result clearing to the Claude API itself (`compact_20260112` and
`clear_tool_uses_20250919`), so arcturn sends the history as it is and the provider shapes
its own view of it. `compaction` blocks the provider returns, and server-tool blocks such as
native tool search, stream in and are replayed verbatim. The adapter turns on whichever
beta headers a request needs (`compact-2026-01-12`, `context-management-2025-06-27`,
`thinking-binding-controls-2026-08-01`).

Bedrock and Vertex have no beta surface here: a request asking for server-side context
management is refused with a clear error before it is sent, and `thinkingBinding` is never
sent to them. Their local, append-only paths work as everywhere else. `anthropic-compatible`
gateways are sent the request but whether a given gateway forwards the beta is up to it.

Not verified live: the streaming shapes of `compaction_delta` and `server_tool_use` deltas.

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

const direct = getModel("anthropic/claude-sonnet-5-5");
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
