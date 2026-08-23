/**
 * Provider preset table.
 *
 * A preset is nothing more than a named, remembered `{ baseUrl, apiKeyEnv,
 * protocol }` triple for a well-known OpenAI-compatible or Anthropic-Messages
 * -compatible endpoint (Groq, DeepSeek, Fireworks, MiniMax, ...). It exists so
 * callers can write `presetSpec("groq", "llama-3.3-70b-versatile")` instead of
 * repeating a base URL and an env var name at every call site.
 *
 * Presets are a convenience, not a gate: any endpoint the reference harness (or anyone else)
 * supports still works without an entry here, by calling
 * {@link openaiCompatible} directly, or by hand-building a `ModelSpec` with
 * `provider: "anthropic-compatible"` for an Anthropic-Messages endpoint. This
 * table exists purely so the well-known ones are reachable by short name.
 *
 * Model ids passed to {@link presetSpec} (and the ones curated by
 * {@link registerPresetModels}) are passed through to the wire verbatim —
 * Arcturn never validates, rewrites, or namespaces them beyond the catalog id
 * prefix (`<preset>/<model>`).
 */

import type { ModelCapabilities, ModelSpec, ProviderId } from "@arcturn/types";
import {
  type OpenAICompatibleOptions,
  openaiCompatible,
  registerModel,
  wireExtendedPresets,
} from "./catalog.js";

/** Wire protocol a preset's endpoint speaks. */
export type PresetProtocol = "openai" | "anthropic";

/** A named, well-known OpenAI- or Anthropic-compatible endpoint. */
export interface ProviderPreset {
  /** Human-readable name, e.g. "Groq". */
  readonly label: string;
  /** Endpoint root passed straight to the underlying SDK's `baseURL`. */
  readonly baseUrl: string;
  /** Environment variable holding the API key. */
  readonly apiKeyEnv: string;
  /**
   * Which Arcturn provider adapter drives this endpoint: `"openai"` dispatches
   * through `openai-compatible` (Chat Completions), `"anthropic"` through
   * `anthropic-compatible` (the Messages API).
   */
  readonly protocol: PresetProtocol;
  /** Link to the provider's API documentation, where known. */
  readonly docsUrl?: string;
  /** Names of sibling presets covering another region or plan of this same service. */
  readonly regionalVariants?: readonly string[];
}

/**
 * Well-known OpenAI- and Anthropic-compatible endpoints, keyed by short name.
 *
 * Base URLs and env var names are sourced from each provider's own adapter
 * (reference: the reference harness's `packages/ai/src/providers/*.ts`), not from memory.
 * A handful of values the reference harness cannot express as a single static base URL (the
 * two Cloudflare gateways, which are scoped to an account id and — for the
 * AI Gateway — a gateway id) or that the reference harness does not list at all (LM Studio,
 * vLLM) are marked `// unverified:` on the affected field; see the module
 * report for the full list.
 */
export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = Object.freeze({
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    protocol: "openai",
    docsUrl: "https://console.groq.com/docs",
  },
  deepseek: {
    label: "DeepSeek",
    // the reference harness's own adapter uses "https://api.deepseek.com" (no /v1); Arcturn
    // drives OpenAI-compatible endpoints through the raw `openai` SDK, which
    // joins `baseURL + "/chat/completions"` without inserting a version
    // segment, so the /v1 form (DeepSeek's documented alternate base) is
    // required here.
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    protocol: "openai",
    docsUrl: "https://api-docs.deepseek.com",
  },
  together: {
    label: "Together AI",
    baseUrl: "https://api.together.ai/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.together.ai",
  },
  cerebras: {
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    protocol: "openai",
    docsUrl: "https://inference-docs.cerebras.ai",
  },
  nvidia: {
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.api.nvidia.com",
  },
  huggingface: {
    label: "Hugging Face",
    baseUrl: "https://router.huggingface.co/v1",
    apiKeyEnv: "HF_TOKEN",
    protocol: "openai",
    docsUrl: "https://huggingface.co/docs/inference-providers",
  },
  baseten: {
    label: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    apiKeyEnv: "BASETEN_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.baseten.co",
  },
  fireworks: {
    label: "Fireworks AI",
    // No /v1: the Anthropic SDK appends "/v1/messages" itself, matching
    // Fireworks' documented Anthropic-Messages-compatible base.
    baseUrl: "https://api.fireworks.ai/inference",
    apiKeyEnv: "FIREWORKS_API_KEY",
    protocol: "anthropic",
    docsUrl: "https://docs.fireworks.ai",
  },
  moonshot: {
    label: "Moonshot AI",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    protocol: "openai",
    docsUrl: "https://platform.moonshot.ai/docs",
    regionalVariants: ["moonshot-cn"],
  },
  "moonshot-cn": {
    label: "Moonshot AI (China)",
    baseUrl: "https://api.moonshot.cn/v1",
    // Same env var as "moonshot": the reference harness's moonshotai-cn adapter reuses it.
    apiKeyEnv: "MOONSHOT_API_KEY",
    protocol: "openai",
    docsUrl: "https://platform.moonshot.cn/docs",
    regionalVariants: ["moonshot"],
  },
  // Z.AI exposes two endpoints and picking the wrong one 404s: the coding
  // plan's path (`zai`, matching the reference implementation) and the general
  // pay-as-you-go API (`zai-api`). A 401 from api.z.ai was observed against the
  // latter, confirming the path; use it unless you are on a coding plan.
  zai: {
    label: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.z.ai",
    regionalVariants: ["zai-cn", "zai-api"],
  },
  "zai-api": {
    label: "Z.AI (general API)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.z.ai",
    regionalVariants: ["zai", "zai-cn"],
  },
  "zai-cn": {
    label: "Z.AI Coding (China)",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKeyEnv: "ZAI_CODING_CN_API_KEY",
    protocol: "openai",
    docsUrl: "https://open.bigmodel.cn/dev/api",
    regionalVariants: ["zai", "zai-api"],
  },
  qwen: {
    label: "Qwen Token Plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_TOKEN_PLAN_API_KEY",
    protocol: "openai",
    docsUrl: "https://help.aliyun.com/zh/model-studio",
    regionalVariants: ["qwen-cn", "qwen-individual"],
  },
  "qwen-cn": {
    label: "Qwen Token Plan (China)",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_TOKEN_PLAN_CN_API_KEY",
    protocol: "openai",
    docsUrl: "https://help.aliyun.com/zh/model-studio",
    regionalVariants: ["qwen"],
  },
  "qwen-individual": {
    label: "Qwen Token Plan (Individual)",
    // Same region/base as "qwen"; the reference harness's individual-plan adapter is a
    // distinct billing plan against the same compatible-mode endpoint.
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_TOKEN_PLAN_API_KEY",
    protocol: "openai",
    docsUrl: "https://help.aliyun.com/zh/model-studio",
    regionalVariants: ["qwen"],
  },
  xiaomi: {
    label: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKeyEnv: "XIAOMI_API_KEY",
    protocol: "openai",
    regionalVariants: ["xiaomi-ams", "xiaomi-cn", "xiaomi-sgp"],
  },
  "xiaomi-ams": {
    label: "Xiaomi MiMo Token Plan (Amsterdam)",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    apiKeyEnv: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    protocol: "openai",
    regionalVariants: ["xiaomi"],
  },
  "xiaomi-cn": {
    label: "Xiaomi MiMo Token Plan (China)",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    apiKeyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    protocol: "openai",
    regionalVariants: ["xiaomi"],
  },
  "xiaomi-sgp": {
    label: "Xiaomi MiMo Token Plan (Singapore)",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    apiKeyEnv: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    protocol: "openai",
    regionalVariants: ["xiaomi"],
  },
  "ant-ling": {
    label: "Ant Ling",
    baseUrl: "https://api.ant-ling.com/v1",
    apiKeyEnv: "ANT_LING_API_KEY",
    protocol: "openai",
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/anthropic",
    apiKeyEnv: "MINIMAX_API_KEY",
    protocol: "anthropic",
    docsUrl: "https://www.minimax.io/platform/document",
    regionalVariants: ["minimax-cn"],
  },
  "minimax-cn": {
    label: "MiniMax (China)",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiKeyEnv: "MINIMAX_CN_API_KEY",
    protocol: "anthropic",
    docsUrl: "https://platform.minimaxi.com/document",
    regionalVariants: ["minimax"],
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    protocol: "openai",
    docsUrl: "https://openrouter.ai/docs",
  },
  "vercel-gateway": {
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    protocol: "anthropic",
    docsUrl: "https://vercel.com/docs/ai-gateway",
  },
  "cloudflare-workers-ai": {
    label: "Cloudflare Workers AI",
    // unverified: the reference harness's adapter has no static base URL — it authenticates
    // with CLOUDFLARE_API_KEY *and* an account id (CLOUDFLARE_ACCOUNT_ID) and
    // builds the URL from both at request time. This is Cloudflare's public,
    // documented OpenAI-compatible path shape; replace {account_id} before
    // use, e.g. via `presetSpec("cloudflare-workers-ai", model, { id: ... })`
    // and overriding baseUrl on the result.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    apiKeyEnv: "CLOUDFLARE_API_KEY",
    protocol: "openai",
    docsUrl: "https://developers.cloudflare.com/workers-ai",
  },
  "cloudflare-ai-gateway": {
    label: "Cloudflare AI Gateway",
    // unverified: same as above, plus a per-gateway id (CLOUDFLARE_GATEWAY_ID).
    // {account_id} and {gateway_id} must be substituted before use.
    baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat",
    apiKeyEnv: "CLOUDFLARE_API_KEY",
    protocol: "anthropic",
    docsUrl: "https://developers.cloudflare.com/ai-gateway",
  },
  opencode: {
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen",
    apiKeyEnv: "OPENCODE_API_KEY",
    protocol: "anthropic",
    docsUrl: "https://opencode.ai/docs/zen",
  },
  "opencode-go": {
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    protocol: "openai",
    docsUrl: "https://opencode.ai/docs/go",
  },
  "kimi-coding": {
    label: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding",
    apiKeyEnv: "KIMI_API_KEY",
    protocol: "anthropic",
  },
  mistral: {
    label: "Mistral",
    // the reference harness speaks Mistral's proprietary "conversations" API, which Arcturn has
    // no adapter for; this is Mistral's separate, documented OpenAI-compatible
    // Chat Completions base.
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.mistral.ai",
  },
  xai: {
    label: "xAI",
    // the reference harness drives xAI through the OpenAI Responses API; this is xAI's
    // separate, documented OpenAI-compatible Chat Completions base.
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.x.ai",
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    protocol: "openai",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
  },
  lmstudio: {
    label: "LM Studio",
    // unverified: not one of the reference harness's providers; this is the LM Studio
    // community's well-known default local server address and port.
    baseUrl: "http://localhost:1234/v1",
    // unverified: LM Studio does not require a real key by default; the env
    // var name below is a Arcturn convention, not a documented LM Studio setting.
    apiKeyEnv: "LMSTUDIO_API_KEY",
    protocol: "openai",
    docsUrl: "https://lmstudio.ai/docs/app/api",
  },
  vllm: {
    label: "vLLM",
    // unverified: not one of the reference harness's providers; this is vLLM's well-known
    // default `vllm serve` address and port.
    baseUrl: "http://localhost:8000/v1",
    // unverified: vLLM's OpenAI-compatible server accepts any bearer token by
    // default; the env var name below is a Arcturn convention.
    apiKeyEnv: "VLLM_API_KEY",
    protocol: "openai",
    docsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
  },
});

/** Provider ids driven by each {@link PresetProtocol}. */
const PROTOCOL_PROVIDER: Readonly<Record<PresetProtocol, ProviderId>> = {
  openai: "openai-compatible",
  anthropic: "anthropic-compatible",
};

/**
 * Build a {@link ModelSpec} for a {@link PROVIDER_PRESETS} entry.
 *
 * The resulting id is namespaced `<preset>/<model>`, the base URL and API key
 * env var come from the preset, and the provider id is chosen from the
 * preset's {@link PresetProtocol} (`"openai"` → `openai-compatible`,
 * `"anthropic"` → `anthropic-compatible`). The model id is passed through
 * to the wire exactly as given.
 *
 * @throws When `preset` is not a name in {@link PROVIDER_PRESETS}; the
 *   message lists every valid preset name.
 */
export function presetSpec(
  preset: string,
  model: string,
  options: OpenAICompatibleOptions = {},
): ModelSpec {
  const entry = PROVIDER_PRESETS[preset];
  if (!entry) {
    const valid = Object.keys(PROVIDER_PRESETS).sort().join(", ");
    throw new Error(`Unknown provider preset: "${preset}". Valid presets: ${valid}`);
  }

  const { register, ...rest } = options;
  const built = openaiCompatible(entry.baseUrl, model, {
    id: `${preset}/${model}`,
    apiKeyEnv: entry.apiKeyEnv,
    displayName: `${entry.label} ${model}`,
    ...rest,
  });
  const spec: ModelSpec = { ...built, provider: PROTOCOL_PROVIDER[entry.protocol] };
  if (register) registerModel(spec);
  return spec;
}

/** Capability/context/pricing facts for one curated model within a preset. */
interface CuratedModel {
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: ModelCapabilities;
  readonly cost?: ModelSpec["cost"];
}

const TOOLS: ModelCapabilities = { tools: true, vision: false, thinking: false, caching: false };
const TOOLS_CACHE: ModelCapabilities = { ...TOOLS, caching: true };
const TOOLS_THINK: ModelCapabilities = { ...TOOLS, thinking: true };
const TOOLS_VISION_THINK: ModelCapabilities = { ...TOOLS, vision: true, thinking: true };

/**
 * A curated, deliberately small set of notable models per preset.
 *
 * Sourced from each provider's public model documentation, not from the reference harness's
 * generated `*.models.ts` catalogs (those read from a `data/*.json` file that
 * is gitignored in the reference checkout and was not available to source
 * from). Pricing is omitted throughout: none could be confirmed confidently
 * against a current, authoritative source, and a wrong price is worse than an
 * absent one.
 */
const CURATED_MODELS: Readonly<Record<string, readonly CuratedModel[]>> = Object.freeze({
  groq: [
    {
      model: "llama-3.3-70b-versatile",
      displayName: "Llama 3.3 70B Versatile",
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      capabilities: TOOLS,
    },
    {
      model: "llama-3.1-8b-instant",
      displayName: "Llama 3.1 8B Instant",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
    {
      model: "moonshotai/kimi-k2-instruct",
      displayName: "Kimi K2 Instruct (Groq)",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      capabilities: TOOLS,
    },
  ],
  deepseek: [
    {
      model: "deepseek-chat",
      displayName: "DeepSeek-V3 (chat)",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS_CACHE,
    },
    {
      model: "deepseek-reasoner",
      displayName: "DeepSeek-R1 (reasoner)",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      capabilities: { ...TOOLS_CACHE, thinking: true },
    },
  ],
  together: [
    {
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      displayName: "Llama 3.3 70B Instruct Turbo",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
    {
      model: "deepseek-ai/DeepSeek-V3",
      displayName: "DeepSeek-V3 (Together)",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
  ],
  cerebras: [
    {
      model: "llama-3.3-70b",
      displayName: "Llama 3.3 70B (Cerebras)",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
    {
      model: "qwen-3-32b",
      displayName: "Qwen3 32B (Cerebras)",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS_THINK,
    },
  ],
  mistral: [
    {
      model: "mistral-large-latest",
      displayName: "Mistral Large",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
    {
      model: "codestral-latest",
      displayName: "Codestral",
      contextWindow: 256_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
  ],
  xai: [
    {
      model: "grok-4",
      displayName: "Grok 4",
      contextWindow: 256_000,
      maxOutputTokens: 32_768,
      capabilities: TOOLS_VISION_THINK,
    },
    {
      model: "grok-4-fast",
      displayName: "Grok 4 Fast",
      contextWindow: 2_000_000,
      maxOutputTokens: 32_768,
      capabilities: TOOLS_VISION_THINK,
    },
  ],
  fireworks: [
    {
      model: "accounts/fireworks/models/deepseek-v3",
      displayName: "DeepSeek-V3 (Fireworks)",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS,
    },
    {
      model: "accounts/fireworks/models/kimi-k2-instruct",
      displayName: "Kimi K2 Instruct (Fireworks)",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      capabilities: TOOLS,
    },
  ],
  moonshot: [
    {
      model: "kimi-k2-0711-preview",
      displayName: "Kimi K2 0711 Preview",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: TOOLS_CACHE,
    },
    {
      model: "moonshot-v1-128k",
      displayName: "Moonshot v1 128k",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      capabilities: TOOLS,
    },
  ],
  // Coding-plan lineup as of 2026-08: GLM-5.3 (launched 2026-08-14), GLM-5
  // Turbo and GLM-4.7; requests for GLM-5.2/5.1 are auto-routed to 5.3 on this
  // endpoint, so they are not listed here. GLM-4.6 is kept for older plans.
  zai: [
    {
      model: "glm-5.3",
      displayName: "GLM-5.3 (coding plan)",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-5-turbo",
      displayName: "GLM-5 Turbo (coding plan)",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-4.7",
      displayName: "GLM-4.7 (coding plan)",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-4.6",
      displayName: "GLM-4.6 (coding plan)",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
  ],
  // The general pay-as-you-go endpoint, which is what a key from Z.AI's
  // console reaches. Registered separately because the coding-plan path above
  // is a different URL and rejects general keys. GLM-5.3 is deliberately
  // absent: as of 2026-08-18 its general-API access is still rolling out
  // (coding plan only) — it can be used by id once Z.AI lists it, since preset
  // model ids pass through verbatim.
  "zai-api": [
    {
      model: "glm-5.3",
      displayName: "GLM-5.3",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-5.1",
      displayName: "GLM-5.1",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-5",
      displayName: "GLM-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-5.2",
      displayName: "GLM-5.2",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-5-turbo",
      displayName: "GLM-5 Turbo",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-4.7",
      displayName: "GLM-4.7",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-4.7-flash",
      displayName: "GLM-4.7 Flash (free)",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
    {
      model: "glm-4.6",
      displayName: "GLM-4.6",
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      capabilities: TOOLS_THINK,
    },
  ],
  qwen: [
    {
      model: "qwen3-max",
      displayName: "Qwen3 Max",
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      capabilities: TOOLS_THINK,
    },
    {
      model: "qwen-plus",
      displayName: "Qwen Plus",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      capabilities: TOOLS_THINK,
    },
  ],
  minimax: [
    {
      model: "MiniMax-M2",
      displayName: "MiniMax M2",
      contextWindow: 204_800,
      maxOutputTokens: 16_384,
      capabilities: TOOLS_THINK,
    },
  ],
});

/**
 * Register {@link CURATED_MODELS} into the shared catalog via {@link presetSpec}.
 *
 * Safe to call more than once: every registration overwrites the same catalog
 * id, so repeated calls neither duplicate entries nor throw.
 *
 * @returns Every {@link ModelSpec} registered, in preset-then-model order.
 */
export function registerPresetModels(): ModelSpec[] {
  const registered: ModelSpec[] = [];
  for (const [preset, models] of Object.entries(CURATED_MODELS)) {
    for (const curated of models) {
      registered.push(
        presetSpec(preset, curated.model, {
          displayName: curated.displayName,
          contextWindow: curated.contextWindow,
          maxOutputTokens: curated.maxOutputTokens,
          capabilities: curated.capabilities,
          ...(curated.cost ? { cost: curated.cost } : {}),
          register: true,
        }),
      );
    }
  }
  return registered;
}

/** A read-only environment map, defaulting to `process.env`. */
type PresetEnv = Record<string, string | undefined>;

function processEnv(): PresetEnv {
  const globalProcess = (globalThis as { process?: { env?: PresetEnv } }).process;
  return globalProcess?.env ?? {};
}

/** Display-ready summary of one preset, for a `arcturn providers` command. */
export interface PresetListing {
  /** Short name, e.g. `"groq"`. */
  readonly name: string;
  readonly label: string;
  readonly protocol: PresetProtocol;
  readonly apiKeyEnv: string;
  /** Whether {@link ProviderPreset.apiKeyEnv} is set (non-empty) in `env`. */
  readonly keyPresent: boolean;
}

/**
 * List every {@link PROVIDER_PRESETS} entry, display-ready, sorted by name.
 *
 * @param env - Environment consulted for key presence. Defaults to `process.env`.
 */
export function listPresets(env: PresetEnv = processEnv()): PresetListing[] {
  return Object.entries(PROVIDER_PRESETS)
    .map(([name, entry]) => ({
      name,
      label: entry.label,
      protocol: entry.protocol,
      apiKeyEnv: entry.apiKeyEnv,
      keyPresent: Boolean(env[entry.apiKeyEnv]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Loading this module wires the extended preset world into the catalog's
// lookups: `presetModel` and `getModel` resolve any preset on demand, so an
// SDK user never needs an explicit registration call. The CLI still calls
// `registerPresetModels()` eagerly so `--list-models` shows everything.
wireExtendedPresets({
  resolve: (preset, model, options) => presetSpec(preset, model, options),
  registerAll: () => void registerPresetModels(),
});
