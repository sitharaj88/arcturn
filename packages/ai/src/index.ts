/**
 * `@arcturn/ai` — a unified, streaming, multi-provider LLM client.
 *
 * ```ts
 * import { createClient, requireModel } from "@arcturn/ai";
 *
 * const client = createClient();
 * for await (const event of client.stream({
 *   model: requireModel("anthropic/claude-sonnet-4-5"),
 *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
 * })) {
 *   if (event.type === "textDelta") process.stdout.write(event.delta);
 * }
 * ```
 */

export {
  calculateCostUsd,
  DEFAULT_API_KEY_ENV,
  FALLBACK_API_KEY_ENV,
  getModel,
  listModels,
  listModelsByProvider,
  OPENAI_COMPATIBLE_ENDPOINTS,
  type OpenAICompatibleOptions,
  openaiCompatible,
  presetModel,
  registerModel,
  requireModel,
  resetCatalog,
  unregisterModel,
} from "./catalog.js";
export {
  type CreateClientOptions,
  createClient,
  type EnvSource,
  resolveApiKey,
} from "./client.js";
export {
  type ConsensusLink,
  type ConsensusOptions,
  type ConsensusVerdict,
  compareMessages,
  createConsensusClient,
} from "./consensus.js";
export { addUsage, emptyUsage } from "./cost.js";
export {
  AIErrorException,
  createAIError,
  isRetryableError,
  parseRetryAfterMs,
  toAIError,
} from "./errors.js";
export {
  createFailoverClient,
  defaultShouldFailover,
  type FailoverLink,
  type FailoverOptions,
  streamFailover,
} from "./failover.js";
export {
  DEFAULT_REQUEST_STALL_TIMEOUT_MS,
  type IdleTimeoutOptions,
  type ScheduleTimeout,
  streamWithIdleTimeout,
  withIdleTimeout,
} from "./idle-timeout.js";
export { parseToolArguments } from "./internal/json.js";
export {
  assembleStream,
  completeFromStream,
  type EmittedStreamEvent,
  MessageAssembler,
  type ProviderStreamEvent,
} from "./internal/stream.js";
export {
  type CachedPresetEntry,
  type DiscoveredModel,
  type DiscoverOptions,
  discoverModels,
  LiveCatalogError,
  type RefreshOptions,
  type RefreshResult,
  refreshCatalog,
} from "./live-catalog.js";
// --- Subscription (OAuth) authentication ---
export * as oauth from "./oauth/index.js";
export {
  registerAnthropicOAuthProvider,
  registerOAuthProviderFactories,
} from "./oauth/register.js";
export {
  listPresets,
  PROVIDER_PRESETS,
  type PresetListing,
  type PresetProtocol,
  type ProviderPreset,
  presetSpec,
  registerPresetModels,
} from "./presets.js";
export {
  ANTHROPIC_THINKING_BUDGETS,
  type AnthropicClientLike,
  type AnthropicProviderOptions,
  anthropicEventStream,
  buildAnthropicRequest,
  createAnthropicProvider,
  mapAnthropicStopReason,
  REDACTED_THINKING_PREFIX,
  toAnthropicMessages,
} from "./providers/anthropic.js";
export * from "./providers/azure.js";
// --- Cloud and enterprise backends ---
export * from "./providers/bedrock.js";
export * from "./providers/bedrock-models.js";
export { registerBuiltinProviders } from "./providers/builtins.js";
export {
  buildGoogleRequest,
  createGoogleProvider,
  GOOGLE_THINKING_BUDGETS,
  type GoogleClientLike,
  type GoogleProviderOptions,
  googleEventStream,
  mapGoogleFinishReason,
  parseGoogleUsage,
  SYNTHETIC_TOOL_ID_PREFIX,
  supportsToolCallIds,
  toGoogleContents,
} from "./providers/google.js";
export {
  buildOpenAIRequest,
  createOpenAIProvider,
  mapOpenAIFinishReason,
  OPENAI_REASONING_EFFORT,
  type OpenAIClientLike,
  type OpenAIProviderOptions,
  openaiEventStream,
  parseOpenAIUsage,
  supportsTemperature,
  toOpenAIMessages,
} from "./providers/openai.js";
export * from "./providers/openai-responses.js";
export {
  getProviderFactory,
  listProviderIds,
  type ProviderFactory,
  type ProviderFactoryContext,
  type ProviderPrecheckFailure,
  type ProviderRegistration,
  registerProviderFactory,
  unregisterProviderFactory,
} from "./providers/registry.js";
export * from "./providers/vertex.js";
export {
  abortableSleep,
  computeBackoffDelay,
  DEFAULT_RETRY_OPTIONS,
  type RetryAttemptInfo,
  type RetryOptions,
  streamWithRetry,
  withRetry,
} from "./retry.js";
export { downgradeImages, hasImageContent } from "./vision.js";
