/**
 * Amazon Bedrock model data.
 *
 * Bedrock exposes third-party models under AWS-owned model ids, optionally
 * behind a cross-region *inference profile* whose id carries a routing prefix
 * (`global.`, `us.`, `eu.`, `apac.`). Catalog ids are namespaced `bedrock/<model
 * id>` so both the bare id and its inference-profile variants can coexist.
 *
 * Pricing is us-east-1 on-demand USD per million tokens and changes often;
 * override any entry with `registerModel`.
 */

import type { ModelCapabilities, ModelCost, ModelSpec } from "@arcturn/types";

/** Provider id under which the Bedrock adapter is registered. */
export const BEDROCK_PROVIDER_ID = "bedrock";

/** Bearer-token environment variable Bedrock accepts in place of SigV4. */
export const BEDROCK_API_KEY_ENV = "AWS_BEARER_TOKEN_BEDROCK";

/**
 * Geography prefixes used by Bedrock cross-region inference profiles.
 *
 * `global.` is the dynamic-routing profile (no regional premium); the
 * geography prefixes are the CRIS regional endpoints, which carry a 10%
 * premium. `jp` is documented alongside `us`/`eu`/`apac` in Anthropic's
 * Bedrock model table.
 *
 * https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy#api-model-ids
 */
export const BEDROCK_INFERENCE_PROFILE_PREFIXES = [
  "us",
  "eu",
  "apac",
  "jp",
  "us-gov",
  "global",
] as const;

/** One of the {@link BEDROCK_INFERENCE_PROFILE_PREFIXES}. */
export type BedrockInferenceProfilePrefix = (typeof BEDROCK_INFERENCE_PROFILE_PREFIXES)[number];

/**
 * A {@link ModelSpec} carrying Bedrock-specific settings.
 *
 * The region travels in `ModelSpec.providerOptions`, which addresses the
 * service rather than the request and is part of the adapter's cache key.
 */
export interface BedrockModelSpec extends ModelSpec {
  providerOptions?: { region?: string } & Record<string, unknown>;
}

/** Options accepted by {@link bedrockModel}. */
export interface BedrockModelOptions {
  /** Catalog id; defaults to `bedrock/<modelId>`. */
  id?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelCost;
  capabilities?: Partial<ModelCapabilities>;
  /** Pin the AWS region for this model, overriding `AWS_REGION`. */
  region?: string;
}

const TOOLS_ONLY: ModelCapabilities = {
  tools: true,
  vision: false,
  thinking: false,
  caching: false,
};

const CLAUDE: ModelCapabilities = { tools: true, vision: true, thinking: true, caching: true };

const NOVA: ModelCapabilities = { tools: true, vision: true, thinking: false, caching: false };

/**
 * Build a {@link ModelSpec} for any Bedrock model id, inference profile id or
 * ARN that the catalog does not ship.
 *
 * The result is not registered; pass it to `registerModel` to make it
 * resolvable by id.
 *
 * @param modelId - Bedrock model id, e.g. `"amazon.nova-pro-v1:0"`, an
 *   inference profile id such as `"eu.anthropic.claude-sonnet-4-5-20250929-v1:0"`,
 *   or a provisioned-throughput ARN.
 * @param options - Context limits, pricing, capabilities and region overrides.
 */
export function bedrockModel(modelId: string, options: BedrockModelOptions = {}): BedrockModelSpec {
  const entry: BedrockModelSpec = {
    id: options.id ?? `${BEDROCK_PROVIDER_ID}/${modelId}`,
    provider: BEDROCK_PROVIDER_ID,
    model: modelId,
    displayName: options.displayName ?? modelId,
    contextWindow: options.contextWindow ?? 128_000,
    maxOutputTokens: options.maxOutputTokens ?? 4_096,
    capabilities: { ...TOOLS_ONLY, ...options.capabilities },
    apiKeyEnv: BEDROCK_API_KEY_ENV,
  };
  if (options.cost) entry.cost = options.cost;
  if (options.region) entry.providerOptions = { region: options.region };
  return entry;
}

/**
 * Derive the cross-region inference-profile variant of a Bedrock spec.
 *
 * @param spec - A spec whose `model` is a bare Bedrock model id.
 * @param prefix - Geography prefix, e.g. `"eu"`.
 */
export function bedrockInferenceProfile(
  spec: BedrockModelSpec,
  prefix: BedrockInferenceProfilePrefix,
): BedrockModelSpec {
  const model = `${prefix}.${spec.model}`;
  return {
    ...spec,
    id: `${BEDROCK_PROVIDER_ID}/${model}`,
    model,
    displayName: `${spec.displayName} (${prefix})`,
  };
}

/** Claude models offered through Bedrock. */
const CLAUDE_MODELS: readonly BedrockModelSpec[] = [
  bedrockModel("anthropic.claude-opus-4-5-20251101-v1:0", {
    displayName: "Claude Opus 4.5 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    capabilities: CLAUDE,
  }),
  bedrockModel("anthropic.claude-sonnet-4-5-20250929-v1:0", {
    displayName: "Claude Sonnet 4.5 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    capabilities: CLAUDE,
  }),
  bedrockModel("anthropic.claude-haiku-4-5-20251001-v1:0", {
    displayName: "Claude Haiku 4.5 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    capabilities: CLAUDE,
  }),
  bedrockModel("anthropic.claude-opus-4-1-20250805-v1:0", {
    displayName: "Claude Opus 4.1 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    capabilities: CLAUDE,
  }),
  bedrockModel("anthropic.claude-sonnet-4-20250514-v1:0", {
    displayName: "Claude Sonnet 4 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    capabilities: CLAUDE,
  }),
  bedrockModel("anthropic.claude-3-7-sonnet-20250219-v1:0", {
    displayName: "Claude Sonnet 3.7 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    capabilities: CLAUDE,
  }),
  bedrockModel("anthropic.claude-3-5-haiku-20241022-v1:0", {
    displayName: "Claude Haiku 3.5 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    capabilities: { ...CLAUDE, thinking: false },
  }),
];

/** Amazon Nova models, served through the Converse API. */
const NOVA_MODELS: readonly BedrockModelSpec[] = [
  bedrockModel("amazon.nova-premier-v1:0", {
    displayName: "Amazon Nova Premier",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    cost: { input: 2.5, output: 12.5 },
    capabilities: { ...NOVA, thinking: true },
  }),
  bedrockModel("amazon.nova-pro-v1:0", {
    displayName: "Amazon Nova Pro",
    contextWindow: 300_000,
    maxOutputTokens: 5_120,
    cost: { input: 0.8, output: 3.2 },
    capabilities: NOVA,
  }),
  bedrockModel("amazon.nova-lite-v1:0", {
    displayName: "Amazon Nova Lite",
    contextWindow: 300_000,
    maxOutputTokens: 5_120,
    cost: { input: 0.06, output: 0.24 },
    capabilities: NOVA,
  }),
  bedrockModel("amazon.nova-micro-v1:0", {
    displayName: "Amazon Nova Micro",
    contextWindow: 128_000,
    maxOutputTokens: 5_120,
    cost: { input: 0.035, output: 0.14 },
    capabilities: TOOLS_ONLY,
  }),
];

/** Models reachable only through the Converse API, with no profile variants. */
const OTHER_MODELS: readonly BedrockModelSpec[] = [
  bedrockModel("meta.llama3-3-70b-instruct-v1:0", {
    displayName: "Llama 3.3 70B Instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    cost: { input: 0.72, output: 0.72 },
    capabilities: TOOLS_ONLY,
  }),
  bedrockModel("meta.llama4-maverick-17b-instruct-v1:0", {
    displayName: "Llama 4 Maverick 17B",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    cost: { input: 0.24, output: 0.97 },
    capabilities: { ...TOOLS_ONLY, vision: true },
  }),
  bedrockModel("meta.llama4-scout-17b-instruct-v1:0", {
    displayName: "Llama 4 Scout 17B",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    cost: { input: 0.17, output: 0.66 },
    capabilities: { ...TOOLS_ONLY, vision: true },
  }),
  bedrockModel("mistral.mistral-large-2407-v1:0", {
    displayName: "Mistral Large 2 (24.07)",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    cost: { input: 2, output: 6 },
    capabilities: TOOLS_ONLY,
  }),
  bedrockModel("mistral.pixtral-large-2502-v1:0", {
    displayName: "Pixtral Large (25.02)",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    cost: { input: 2, output: 6 },
    capabilities: { ...TOOLS_ONLY, vision: true },
  }),
  bedrockModel("deepseek.r1-v1:0", {
    displayName: "DeepSeek-R1",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    cost: { input: 1.35, output: 5.4 },
    capabilities: { tools: false, vision: false, thinking: true, caching: false },
  }),
  bedrockModel("amazon.titan-text-premier-v1:0", {
    displayName: "Amazon Titan Text Premier",
    contextWindow: 32_000,
    maxOutputTokens: 3_072,
    cost: { input: 0.5, output: 1.5 },
    capabilities: { tools: false, vision: false, thinking: false, caching: false },
  }),
];

/** Prefixes generated for the families that AWS routes cross-region. */
const PROFILE_PREFIXES: readonly BedrockInferenceProfilePrefix[] = ["us", "eu", "apac"];

/**
 * Model ids that also have a `global.` inference profile.
 *
 * Global routing is the recommended default (dynamic routing, no regional
 * premium) but it is not offered for every model, so this mirrors the `global`
 * column of Anthropic's Bedrock model table rather than being generated
 * blanket-fashion. Models absent here — Opus 4.1, Sonnet 3.7, Haiku 3.5 — have
 * no global profile, and a `global.`-prefixed id for them would not resolve.
 *
 * https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy#api-model-ids
 */
const GLOBAL_PROFILE_MODELS: ReadonlySet<string> = new Set([
  "anthropic.claude-opus-4-5-20251101-v1:0",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-sonnet-4-20250514-v1:0",
]);

function withProfiles(models: readonly BedrockModelSpec[]): BedrockModelSpec[] {
  const out: BedrockModelSpec[] = [];
  for (const model of models) {
    out.push(model);
    if (GLOBAL_PROFILE_MODELS.has(model.model)) {
      out.push(bedrockInferenceProfile(model, "global"));
    }
    for (const prefix of PROFILE_PREFIXES) out.push(bedrockInferenceProfile(model, prefix));
  }
  return out;
}

/**
 * Every built-in Bedrock spec: bare model ids plus the `global.` (where AWS
 * offers one) and `us.`/`eu.`/`apac.` inference-profile variants for the
 * Claude and Nova families.
 *
 * Claude Opus 5, Sonnet 5, Fable 5, Opus 4.8 and Opus 4.7 are deliberately
 * absent. Anthropic's Bedrock docs state they have no ARN-versioned model ids
 * and are served by the Messages-API Bedrock endpoint rather than the
 * `bedrock-runtime` integration this adapter speaks, and the docs table
 * renders their ids with footnote markers attached, so no id string could be
 * read cleanly. Register them explicitly with `bedrockModel()` once the exact
 * ids and Bedrock rate card are confirmed.
 */
export const BEDROCK_MODELS: readonly BedrockModelSpec[] = [
  ...withProfiles(CLAUDE_MODELS),
  ...withProfiles(NOVA_MODELS),
  ...OTHER_MODELS,
];
