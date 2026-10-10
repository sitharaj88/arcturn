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

/**
 * What a request must say for thinking level `"off"` to mean off on a model.
 *
 * "Leave `thinking` out" stopped being a safe answer once models started
 * thinking by default: on Haiku 5.5 or Sonnet 5 omitting it *runs* adaptive
 * thinking, and on Fable 5.1 or Opus 5.5 thinking cannot be turned off at all.
 *
 * - `"omit"` — leave `thinking` out; the model then runs without it (Claude
 *   4.6–4.8, and every budget-era model).
 * - `"disabled"` — send `thinking: {type: "disabled"}`, because omitting it
 *   would think (Sonnet 5, Haiku 5.5).
 * - `"betweenTools"` — send `thinking: {type: "between_tools"}`, the lowest
 *   setting on a model that rejects `disabled` (Sonnet 5.5).
 * - `"lowEffort"` — thinking cannot be switched off: leave `thinking` out and
 *   send the lowest effort instead (Fable 5/5.1, Opus 5.5, and Opus 5, whose
 *   `disabled` carries documented failure modes).
 *
 * Optional: adapters infer it from the model id when absent.
 */
export type ThinkingOffStyle = "omit" | "disabled" | "betweenTools" | "lowEffort";

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
  /** How thinking level `"off"` is spelled on this model; see {@link ThinkingOffStyle}. */
  thinkingOff?: ThinkingOffStyle;
  /**
   * The thinking levels above `"off"` this model accepts, lowest first. A
   * requested level the model lacks is clamped down to the nearest one it has
   * (`xhigh` on Sonnet 4.6 is sent as `high`) rather than sent and refused.
   * Absent means "infer from the model id"; only adaptive (effort-steered)
   * models are clamped, since budget models map every level to a token count.
   */
  thinkingLevels?: readonly Exclude<ThinkingLevel, "off">[];
  /**
   * The provider can re-run a request its safety classifiers declined on
   * another model, server-side (Anthropic's `fallbacks: "default"`). Only
   * consulted when the host opted in; absent means no.
   */
  refusalFallback?: boolean;
  /**
   * The model accepts a `role: "system"` message appended mid-conversation
   * (see `SystemMessage`). Absent means "infer from the model id": Claude
   * Opus 4.8 / 5 / 5.5, Fable 5 / 5.1 (and Mythos) and Sonnet 5.5 say yes;
   * Sonnet 5 and everything older say no, and the adapter folds the message
   * into a user turn instead. An adapter that learns otherwise from a 400
   * stops sending it for the rest of the process.
   */
  systemMessages?: boolean;
  /**
   * The model can constrain its reply to a JSON schema (`LLMRequest.responseFormat`).
   * Absent means "infer from the provider and model id": Claude 4.5 and later,
   * every current OpenAI model, Gemini 2.5 and later say yes; an
   * OpenAI-compatible or Anthropic-compatible endpoint says no unless declared,
   * since many such servers reject the field outright.
   */
  structuredOutput?: boolean;
  /**
   * The model paces itself against a task budget (`LLMRequest.taskBudget`,
   * Anthropic beta `task-budgets-2026-03-13`). Absent means "infer from the
   * model id": Opus 4.7 / 4.8 / 5 / 5.5, Fable 5 / 5.1, Sonnet 5.5 and Haiku
   * 5.5 on the first-party API say yes; Sonnet 5 says no.
   */
  taskBudget?: boolean;
  /**
   * Which provider-native web tools the model takes (`LLMRequest.serverTools`
   * entries of kind `webSearch` / `webFetch`); see {@link NativeWebTools}.
   * Absent means "infer from the provider and model id": on the first-party
   * Claude API, Opus and Sonnet 4.6 and later say `"dynamic"` and other Claude
   * 4+ models `"basic"`; Vertex says `"basicSearch"`; Bedrock and every
   * gateway say `"none"` unless they declare otherwise.
   */
  webTools?: NativeWebTools;
}

/**
 * The provider-native web tools a model takes.
 *
 * - `"dynamic"` — Anthropic `web_search_20260209` + `web_fetch_20260209`
 *   (dynamic filtering: the server runs code over results itself).
 * - `"basic"` — `web_search_20250305` + `web_fetch_20250910`.
 * - `"basicSearch"` — `web_search_20250305` only (Vertex AI has no fetch).
 * - `"none"` — neither; the client-side tools stay.
 */
export type NativeWebTools = "dynamic" | "basic" | "basicSearch" | "none";

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

/**
 * Portable thinking depth, lowest to highest.
 *
 * `xhigh` and `max` exist on the current Claude generation (Opus 4.7+, every
 * 5.x model); an adapter whose model lacks a level clamps it to the nearest
 * one below rather than sending a value the provider rejects.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every {@link ThinkingLevel}, lowest first — for validators and pickers. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
