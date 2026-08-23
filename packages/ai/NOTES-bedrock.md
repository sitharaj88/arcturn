# Bedrock adapter — wiring and contract notes

Scratch notes for the Amazon Bedrock adapter. `src/index.ts` was intentionally
not touched; everything below is a request for the owner of that file.

## 1. Exports to add to `src/index.ts`

```ts
export {
  BEDROCK_REGION_ENV_VARS,
  BEDROCK_RESERVED_OPTION_KEYS,
  type BedrockEnv,
  type BedrockModelFamily,
  type BedrockProviderOptions,
  type BedrockRegionSource,
  type BedrockRuntimeClientLike,
  bedrockAnthropicEventStream,
  bedrockCacheKey,
  bedrockModelFamily,
  buildConverseRequest,
  checkBedrockCredentials,
  converseEventStream,
  createBedrockProvider,
  mapConverseStopReason,
  normalizeBedrockModelId,
  parseConverseUsage,
  toBedrockError,
  toConverseMessages,
  toConverseSystem,
  toConverseToolConfig,
} from "./providers/bedrock.js";
export {
  BEDROCK_API_KEY_ENV,
  BEDROCK_INFERENCE_PROFILE_PREFIXES,
  BEDROCK_MODELS,
  BEDROCK_PROVIDER_ID,
  type BedrockInferenceProfilePrefix,
  type BedrockModelOptions,
  type BedrockModelSpec,
  bedrockInferenceProfile,
  bedrockModel,
} from "./providers/bedrock-models.js";
```

The two user-facing ones are `bedrockModel()` (build a spec for any model id,
inference profile or ARN the catalog does not ship) and `createBedrockProvider()`.
`bedrockModel()` deliberately does **not** self-register: `catalog.ts` imports
`bedrock-models.ts`, so calling `registerModel` from there would create an import
cycle. Callers do `registerModel(bedrockModel("cohere.command-r-plus-v1:0"))`.

## 2. Contract friction

### `ModelSpec` has no home for a region

The brief specifies the region comes from `spec.providerOptions?.region`, but the
frozen `ModelSpec` has no `providerOptions` field (only `LLMRequest` does). The
adapter therefore declares

```ts
export interface BedrockModelSpec extends ModelSpec {
  providerOptions?: { region?: string } & Record<string, unknown>;
}
```

and reads the bag off the spec through a downcast. This is the same shape the
Vertex adapter needs for project/location, so a shared
`providerOptions?: Record<string, unknown>` on `ModelSpec` would serve both.

### `providerOptions` is a single untyped bag

`LLMRequest.providerOptions` is merged verbatim into the wire payload by the
Anthropic adapter, so adapter-only keys would leak onto the request. Bedrock
reserves `region` and `family` (see `BEDROCK_RESERVED_OPTION_KEYS`) and strips
them before delegating. A split between "adapter options" and "wire passthrough"
in the contract would remove the need for a reserved-key list.

### No `usage` event before the first token on Converse

`ConverseStream` reports token counts only in the trailing `metadata` event, so
unlike Anthropic there is no early `usage` event with the input-token count. The
terminal message is correct; only mid-stream cost display is affected.

## 3. Behaviour decisions worth reviewing

- **Region is required, never guessed.** `resolveBedrockRegion` returns
  `undefined` rather than defaulting to `us-east-1`: a silent default would sign
  against the wrong region and quietly fail model-access checks.
  `checkBedrockCredentials` turns that into a pre-flight `invalidRequest`, and it
  is the *only* thing it rejects — profiles, SSO sessions and IAM roles are
  invisible here, so a missing static key is never treated as an error.
- **`cacheKeyOf` includes the region and the family**, so two regions never share
  a client and the Claude/Converse clients stay distinct.
- **Claude on Bedrock reuses `providers/anthropic.ts` wholesale**
  (`toAnthropicMessages`, `buildAnthropicRequest`, `anthropicEventStream`), so
  thinking signatures, cache breakpoints, tool schemas and stop reasons behave
  identically on both backends. Only the error classification is Bedrock's.
- **Catalog size.** Claude and Nova entries are generated with their `us.`/`eu.`/
  `apac.` inference-profile variants (Claude 4.x requires an inference profile
  for on-demand throughput), which adds ~44 entries. If that is too much, drop
  `withProfiles()` in `bedrock-models.ts` and let users call
  `bedrockInferenceProfile()`.
- **Pricing** is us-east-1 on-demand and drifts; `registerModel` overrides it.

## 4. One edit outside the Bedrock files

`src/client.test.ts` used `provider: "bedrock"` as its example of an
*unregistered* provider ("rejects unknown providers"). Registering the real
adapter invalidated that test, so the placeholder was changed to
`"not-a-provider"`. No assertion or behaviour changed.
