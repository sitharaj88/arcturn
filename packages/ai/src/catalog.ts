/**
 * Curated model catalog.
 *
 * Entries carry context limits, pricing and capability flags so the runtime can
 * budget tokens and estimate cost without a network round-trip. Pricing changes
 * often; {@link registerModel} lets a host override or extend any entry.
 */

import type { ModelCapabilities, ModelSpec, ProviderId } from "@arcturn/types";
// --- Bedrock: catalog data lives in providers/bedrock-models.ts ---
import { BEDROCK_MODELS } from "./providers/bedrock-models.js";

export { calculateCostUsd } from "./cost.js";

const FULL: ModelCapabilities = { tools: true, vision: true, thinking: true, caching: true };
const NO_THINK: ModelCapabilities = { tools: true, vision: true, thinking: false, caching: true };
/** Claude 4.6 and later: adaptive thinking steered by effort, no token budget. */
const ADAPTIVE: ModelCapabilities = { ...FULL, thinkingStyle: "adaptive" };
/** Claude 4.5 and earlier: extended thinking with an explicit token budget. */
const BUDGET_THINKING: ModelCapabilities = { ...FULL, thinkingStyle: "budget" };

/** Environment variables consulted when a spec does not name one. */
export const DEFAULT_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
  "openai-responses": "OPENAI_API_KEY",
  "anthropic-compatible": "ANTHROPIC_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  // bedrock and vertex authenticate from ambient credentials (the AWS provider
  // chain, Google application-default credentials), so they name no key here.
};

/** Extra environment variables tried, in order, per provider. */
export const FALLBACK_API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_GENAI_API_KEY"],
};

function spec(
  provider: ProviderId,
  model: string,
  displayName: string,
  contextWindow: number,
  maxOutputTokens: number,
  cost: ModelSpec["cost"],
  capabilities: ModelCapabilities,
): ModelSpec {
  const entry: ModelSpec = {
    id: `${provider}/${model}`,
    provider,
    model,
    displayName,
    contextWindow,
    maxOutputTokens,
    capabilities,
    apiKeyEnv: DEFAULT_API_KEY_ENV[provider] ?? "OPENAI_API_KEY",
  };
  if (cost) entry.cost = cost;
  return entry;
}

// Context limits and max output: docs.../about-claude/models/overview
// Pricing (base input / 5m cache write / cache hit / output):
// docs.../about-claude/pricing#model-pricing
const ANTHROPIC_MODELS: readonly ModelSpec[] = [
  spec(
    "anthropic",
    "claude-opus-5",
    "Claude Opus 5",
    1_000_000,
    128_000,
    { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    ADAPTIVE,
  ),
  spec(
    "anthropic",
    "claude-sonnet-5",
    "Claude Sonnet 5",
    1_000_000,
    128_000,
    // $2/$10 was introductory at launch and is now the standard price; the
    // scheduled rise to $3/$15 was cancelled. (pricing page, Sonnet 5 note)
    { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    ADAPTIVE,
  ),
  spec(
    "anthropic",
    "claude-fable-5",
    "Claude Fable 5",
    1_000_000,
    128_000,
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    ADAPTIVE,
  ),
  spec(
    "anthropic",
    "claude-opus-4-5",
    "Claude Opus 4.5",
    200_000,
    64_000,
    { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    BUDGET_THINKING,
  ),
  spec(
    "anthropic",
    "claude-sonnet-4-5",
    "Claude Sonnet 4.5",
    200_000,
    64_000,
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    BUDGET_THINKING,
  ),
  spec(
    "anthropic",
    "claude-haiku-4-5",
    "Claude Haiku 4.5",
    200_000,
    64_000,
    { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    BUDGET_THINKING,
  ),
  spec(
    "anthropic",
    "claude-opus-4-1",
    "Claude Opus 4.1",
    200_000,
    32_000,
    { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    FULL,
  ),
  spec(
    "anthropic",
    "claude-sonnet-4",
    "Claude Sonnet 4",
    200_000,
    64_000,
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    FULL,
  ),
  spec(
    "anthropic",
    "claude-3-5-haiku-latest",
    "Claude Haiku 3.5",
    200_000,
    8_192,
    { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    NO_THINK,
  ),
];

// GPT-5.6: context/output limits from developers.openai.com/api/docs/models/<id>,
// pricing from developers.openai.com/api/docs/pricing. That table splits every
// price into short- and long-context tiers; the catalog carries one rate per
// model, so these are the short-context (base) rates. Requests past the
// short-context threshold bill higher than the estimate — roughly 2x input,
// 1.5x output — so treat cost guards on very long GPT-5.6 prompts as a floor.
const OPENAI_MODELS: readonly ModelSpec[] = [
  spec(
    "openai",
    "gpt-5.6-sol",
    "GPT-5.6 Sol",
    1_050_000,
    128_000,
    { input: 5, output: 30, cacheRead: 0.5 },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5.6-terra",
    "GPT-5.6 Terra",
    1_050_000,
    128_000,
    { input: 2, output: 12, cacheRead: 0.2 },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5.6-luna",
    "GPT-5.6 Luna",
    1_050_000,
    128_000,
    { input: 0.2, output: 1.2, cacheRead: 0.02 },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5.1",
    "GPT-5.1",
    400_000,
    128_000,
    { input: 1.25, output: 10, cacheRead: 0.125 },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5.1-codex",
    "GPT-5.1 Codex",
    400_000,
    128_000,
    { input: 1.25, output: 10, cacheRead: 0.125 },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5",
    "GPT-5",
    400_000,
    128_000,
    {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
    },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5-mini",
    "GPT-5 mini",
    400_000,
    128_000,
    {
      input: 0.25,
      output: 2,
      cacheRead: 0.025,
    },
    FULL,
  ),
  spec(
    "openai",
    "gpt-5-nano",
    "GPT-5 nano",
    400_000,
    128_000,
    {
      input: 0.05,
      output: 0.4,
      cacheRead: 0.005,
    },
    FULL,
  ),
  spec("openai", "o3", "o3", 200_000, 100_000, { input: 2, output: 8, cacheRead: 0.5 }, FULL),
  spec(
    "openai",
    "o4-mini",
    "o4-mini",
    200_000,
    100_000,
    { input: 1.1, output: 4.4, cacheRead: 0.275 },
    FULL,
  ),
  spec(
    "openai",
    "gpt-4.1",
    "GPT-4.1",
    1_047_576,
    32_768,
    { input: 2, output: 8, cacheRead: 0.5 },
    NO_THINK,
  ),
  spec(
    "openai",
    "gpt-4.1-mini",
    "GPT-4.1 mini",
    1_047_576,
    32_768,
    { input: 0.4, output: 1.6, cacheRead: 0.1 },
    NO_THINK,
  ),
  spec(
    "openai",
    "gpt-4o",
    "GPT-4o",
    128_000,
    16_384,
    { input: 2.5, output: 10, cacheRead: 1.25 },
    NO_THINK,
  ),
];

/**
 * The same OpenAI models, reachable through the Responses API adapter.
 *
 * `openai-responses` is a registered provider and the docs list it beside
 * `openai`, but it shipped with no catalog entries — and the CLI resolves
 * `--model` against the catalog, so the adapter was unreachable to everyone
 * except an embedder calling `registerModel` themselves. 900 lines of working
 * code that no user could select, advertised as if they could.
 *
 * Derived from {@link OPENAI_MODELS} rather than written out again: the two
 * surfaces serve the same model names with the same limits and the same
 * prices, so duplicating the literals would only create two things to keep in
 * step. Anything true of `openai/x` is true of `openai-responses/x` except the
 * wire format, which is the adapter's business, not the catalog's.
 */
const OPENAI_RESPONSES_MODELS: readonly ModelSpec[] = OPENAI_MODELS.map((base) =>
  spec(
    "openai-responses",
    base.model,
    `${base.displayName} (Responses)`,
    base.contextWindow,
    base.maxOutputTokens,
    base.cost,
    base.capabilities,
  ),
);

// Gemini 3.x: token limits from ai.google.dev/gemini-api/docs/models/<id>,
// paid-tier pricing from ai.google.dev/gemini-api/docs/pricing.
const GOOGLE_MODELS: readonly ModelSpec[] = [
  spec(
    "google",
    "gemini-3.7-flash",
    "Gemini 3.7 Flash",
    1_048_576,
    65_536,
    // Promotional rate through 2026-12-31; doubles to $1.50/$7.50/$0.15 on
    // 2027-01-01. Re-check, or override with registerModel, after that date.
    { input: 0.75, output: 3.75, cacheRead: 0.075 },
    FULL,
  ),
  spec(
    "google",
    "gemini-3.5-flash",
    "Gemini 3.5 Flash",
    1_048_576,
    65_536,
    { input: 1.5, output: 9, cacheRead: 0.15 },
    FULL,
  ),
  spec(
    "google",
    "gemini-3.5-flash-lite",
    "Gemini 3.5 Flash Lite",
    1_048_576,
    65_536,
    // Text/image/video input rate; audio input is priced separately.
    { input: 0.3, output: 2.5, cacheRead: 0.03 },
    FULL,
  ),
  spec(
    "google",
    "gemini-3-pro-preview",
    "Gemini 3 Pro",
    1_048_576,
    65_536,
    { input: 2, output: 12, cacheRead: 0.2 },
    FULL,
  ),
  spec(
    "google",
    "gemini-2.5-pro",
    "Gemini 2.5 Pro",
    1_048_576,
    65_536,
    { input: 1.25, output: 10, cacheRead: 0.31 },
    FULL,
  ),
  spec(
    "google",
    "gemini-2.5-flash",
    "Gemini 2.5 Flash",
    1_048_576,
    65_536,
    { input: 0.3, output: 2.5, cacheRead: 0.075 },
    FULL,
  ),
  spec(
    "google",
    "gemini-2.5-flash-lite",
    "Gemini 2.5 Flash Lite",
    1_048_576,
    65_536,
    { input: 0.1, output: 0.4, cacheRead: 0.025 },
    FULL,
  ),
];

// --- Vertex AI --------------------------------------------------------------
// Vertex is addressed by GCP project and location and authenticated with
// application-default credentials, so there is no API key: `apiKeyEnv` names the
// ADC key-file variable purely to satisfy the catalog invariant, and the adapter
// ignores whatever it resolves to. Azure ships no entries at all — deployment
// names are per-tenant, so use `azureModel()` from providers/azure.ts. Prices
// track the first-party lists; `registerModel` overrides any of them.
//
// No Claude 5 or Gemini 3.x entries here: Google Cloud is partner-operated
// with its own rate card (cloud.google.com/vertex-ai/generative-ai/pricing),
// and that page could not be read to confirm the numbers. Carrying first-party
// prices for a partner-billed model would silently mis-budget every request,
// so those variants are left to `registerModel` until the rates are verified.

function vertexSpec(
  model: string,
  displayName: string,
  contextWindow: number,
  maxOutputTokens: number,
  cost: ModelSpec["cost"],
): ModelSpec {
  const entry: ModelSpec = {
    id: `vertex/${model}`,
    provider: "vertex",
    model,
    displayName,
    contextWindow,
    maxOutputTokens,
    capabilities: FULL,
    apiKeyEnv: "GOOGLE_APPLICATION_CREDENTIALS",
  };
  if (cost) entry.cost = cost;
  return entry;
}

const VERTEX_MODELS: readonly ModelSpec[] = [
  vertexSpec("gemini-2.5-pro", "Gemini 2.5 Pro (Vertex)", 1_048_576, 65_536, {
    input: 1.25,
    output: 10,
    cacheRead: 0.31,
  }),
  vertexSpec("gemini-2.5-flash", "Gemini 2.5 Flash (Vertex)", 1_048_576, 65_536, {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.075,
  }),
  vertexSpec("claude-opus-4-5@20251101", "Claude Opus 4.5 (Vertex)", 200_000, 64_000, {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  }),
  vertexSpec("claude-sonnet-4-5@20250929", "Claude Sonnet 4.5 (Vertex)", 200_000, 64_000, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  }),
  vertexSpec("claude-haiku-4-5@20251001", "Claude Haiku 4.5 (Vertex)", 200_000, 64_000, {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  }),
];
// --- end Vertex AI ----------------------------------------------------------

const BUILT_IN: readonly ModelSpec[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...OPENAI_RESPONSES_MODELS,
  ...GOOGLE_MODELS,
  ...VERTEX_MODELS,
  // --- Bedrock ----------------------------------------------------------------
  ...BEDROCK_MODELS,
  // --- end Bedrock ------------------------------------------------------------
];

const registry = new Map<string, ModelSpec>();
for (const entry of BUILT_IN) registry.set(entry.id, entry);

/** Every known model, built-ins first then user registrations. */
export function listModels(): ModelSpec[] {
  return [...registry.values()];
}

/** Models belonging to one provider. */
export function listModelsByProvider(provider: ProviderId): ModelSpec[] {
  return listModels().filter((entry) => entry.provider === provider);
}

/* ---------------------------------------------------------------------------
 * The extended preset world (Groq, Z.AI, Cerebras, …) lives in presets.ts,
 * which installs these hooks when it loads. Lookups fall back to them on a
 * miss, so SDK users get every preset with no explicit registration call —
 * `presetModel("zai", "glm-4.7")` and `getModel("zai/glm-4.7")` just work.
 * ------------------------------------------------------------------------ */

let extendedPresetResolve:
  | ((preset: string, model: string, options: OpenAICompatibleOptions) => ModelSpec)
  | undefined;
let extendedPresetRegisterAll: (() => void) | undefined;
let extendedPresetsRegistered = false;

/** @internal Installed by presets.ts at module load; not part of the API. */
export function wireExtendedPresets(hooks: {
  resolve: (preset: string, model: string, options: OpenAICompatibleOptions) => ModelSpec;
  registerAll: () => void;
}): void {
  extendedPresetResolve = hooks.resolve;
  extendedPresetRegisterAll = hooks.registerAll;
}

/** Pull the extended preset catalog into the registry, once per reset. */
function registerExtendedPresetsOnce(): boolean {
  if (extendedPresetsRegistered || extendedPresetRegisterAll === undefined) return false;
  extendedPresetsRegistered = true;
  extendedPresetRegisterAll();
  return true;
}

/**
 * Resolve a model.
 *
 * Accepts a catalog id (`"anthropic/claude-opus-4-5"`) or a bare wire model
 * name (`"claude-opus-4-5"`) when that name is unambiguous.
 */
export function getModel(id: string): ModelSpec | undefined {
  const direct = registry.get(id);
  if (direct) return direct;
  const byWireName = listModels().find((entry) => entry.model === id);
  if (byWireName) return byWireName;
  // Unknown id: the extended presets may not be in the registry yet.
  if (registerExtendedPresetsOnce()) return getModel(id);
  return undefined;
}

/** Like {@link getModel} but throws when the id is unknown. */
export function requireModel(id: string): ModelSpec {
  const found = getModel(id);
  if (!found) throw new Error(`Unknown model: ${id}`);
  return found;
}

/**
 * Register or override a model spec.
 *
 * @returns The stored spec, so callers can chain straight into a request.
 */
export function registerModel(model: ModelSpec): ModelSpec {
  registry.set(model.id, model);
  return model;
}

/** Remove a registration; built-ins can be restored with {@link resetCatalog}. */
export function unregisterModel(id: string): boolean {
  return registry.delete(id);
}

/** Restore the catalog to its built-in contents. Intended for tests. */
export function resetCatalog(): void {
  registry.clear();
  for (const entry of BUILT_IN) registry.set(entry.id, entry);
  // The extended presets re-register lazily on the next miss.
  extendedPresetsRegistered = false;
}

/** Options accepted by {@link openaiCompatible}. */
export interface OpenAICompatibleOptions {
  /** Catalog id; defaults to `<host>/<model>`. */
  id?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelSpec["cost"];
  capabilities?: Partial<ModelCapabilities>;
  /** Environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Register the resulting spec in the catalog. */
  register?: boolean;
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^api\./, "").replace(/\.(com|ai|dev|io|net)$/, "");
  } catch {
    return "openai-compatible";
  }
}

/**
 * Build an ad-hoc {@link ModelSpec} for any OpenAI-compatible endpoint
 * (Groq, Mistral, Ollama, OpenRouter, xAI, DeepSeek, vLLM, ...).
 *
 * @param baseUrl - Endpoint root, e.g. `"https://api.groq.com/openai/v1"`.
 * @param model - Wire model name.
 */
export function openaiCompatible(
  baseUrl: string,
  model: string,
  options: OpenAICompatibleOptions = {},
): ModelSpec {
  const label = hostLabel(baseUrl);
  const entry: ModelSpec = {
    id: options.id ?? `${label}/${model}`,
    provider: "openai-compatible",
    model,
    displayName: options.displayName ?? `${label} ${model}`,
    contextWindow: options.contextWindow ?? 128_000,
    maxOutputTokens: options.maxOutputTokens ?? 8_192,
    capabilities: {
      tools: true,
      vision: false,
      thinking: false,
      caching: false,
      ...options.capabilities,
    },
    baseUrl,
  };
  if (options.cost) entry.cost = options.cost;
  if (options.apiKeyEnv) entry.apiKeyEnv = options.apiKeyEnv;
  if (options.register) registerModel(entry);
  return entry;
}

/** Well-known OpenAI-compatible endpoints, for convenience. */
export const OPENAI_COMPATIBLE_ENDPOINTS: Readonly<
  Record<string, { baseUrl: string; apiKeyEnv: string }>
> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1", apiKeyEnv: "OLLAMA_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY" },
};

/**
 * Build a spec for one of the {@link OPENAI_COMPATIBLE_ENDPOINTS} presets.
 *
 * @throws When the preset name is unknown.
 */
export function presetModel(
  preset: keyof typeof OPENAI_COMPATIBLE_ENDPOINTS | string,
  model: string,
  options: OpenAICompatibleOptions = {},
): ModelSpec {
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[preset];
  if (!endpoint) {
    // Not one of the static endpoints: try the extended preset table.
    if (extendedPresetResolve) return extendedPresetResolve(preset, model, options);
    throw new Error(`Unknown OpenAI-compatible preset: ${preset}`);
  }
  return openaiCompatible(endpoint.baseUrl, model, {
    id: `${preset}/${model}`,
    apiKeyEnv: endpoint.apiKeyEnv,
    ...options,
  });
}
