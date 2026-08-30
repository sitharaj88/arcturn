/** Model catalog contracts. */

export type ProviderId = "anthropic" | "openai" | "google" | "openai-compatible" | (string & {});

export interface ModelCost {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * How a provider configures thinking on a model.
 *
 * - `"budget"` — the legacy fixed token budget (Anthropic's
 *   `thinking: {type: "enabled", budget_tokens: N}`).
 * - `"adaptive"` — the model decides when and how deeply to think, steered by
 *   an effort level (Anthropic's `thinking: {type: "adaptive"}` plus
 *   `output_config.effort`).
 *
 * Optional: adapters that can infer the style from the model id do so when it
 * is absent, so existing specs need no change.
 */
export type ThinkingStyle = "budget" | "adaptive";

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  /** Extended thinking / reasoning support. */
  thinking: boolean;
  caching: boolean;
  /**
   * Which thinking request shape this model accepts. Absent means "let the
   * adapter infer it from the model id", which is the right default for
   * catalog entries and ad-hoc specs alike.
   */
  thinkingStyle?: ThinkingStyle;
}

export interface ModelSpec {
  /** Catalog key, e.g. "anthropic/claude-sonnet-5". */
  id: string;
  provider: ProviderId;
  /** Provider-side model name sent over the wire. */
  model: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  cost?: ModelCost;
  capabilities: ModelCapabilities;
  /** Override API base URL (required for openai-compatible). */
  baseUrl?: string;
  /**
   * Environment variable holding the API key, e.g. "ANTHROPIC_API_KEY".
   *
   * Absent for providers that authenticate from ambient credentials — an AWS
   * profile or role, Google application-default credentials — where there is
   * no single variable to name.
   */
  apiKeyEnv?: string;
  /**
   * {@link apiKeyEnv} is the ONLY credential this spec may ever be given.
   *
   * Ordinarily `apiKeyEnv` is the first name in a chain: key resolution falls
   * back to the provider's default variable (`OPENAI_API_KEY` for every
   * `openai-compatible` spec, `ANTHROPIC_API_KEY` for every
   * `anthropic-compatible` one) and then to that provider's alternates, which
   * is right for a spec written in code by whoever owns the process.
   *
   * It is wrong for a spec built from a *configuration file*, where the
   * endpoint and the credential were chosen by different people. An entry
   * naming a variable the user does not have set would otherwise resolve to
   * the user's real first-party key and put it on the wire to whatever host
   * the file named — and the consent dialog would have said, truthfully, that
   * the credential was a variable the user knows they lack. Set this and the
   * named variable is the whole answer: present, it is used; absent, there is
   * no key, no fallback and no borrowing from an explicit client-wide
   * `apiKey`/`apiKeys` either, since neither was chosen for this endpoint.
   *
   * The marker travels with the spec rather than living at one call site
   * because every consumer re-resolves: `createClient` resolves again per
   * dispatch, so a key passed at resolution time alone would not hold.
   */
  apiKeyEnvExclusive?: boolean;
  /**
   * Provider-specific *routing* configuration: which endpoint, deployment,
   * region or project this model lives in. Examples: `{ region }` for Bedrock,
   * `{ project, location }` for Vertex, `{ endpoint, deployment, apiVersion }`
   * for Azure.
   *
   * This is deliberately distinct from `LLMRequest.providerOptions`, which is
   * merged into the request body: values here address the *service* and must
   * never be spread onto the wire payload. They are read while selecting and
   * caching an adapter, so they are part of the model's identity.
   */
  providerOptions?: Record<string, unknown>;
}

export type ThinkingLevel = "off" | "low" | "medium" | "high";
