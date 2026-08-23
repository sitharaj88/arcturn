# Vertex AI & Azure OpenAI adapters — implementation notes

New files: `src/providers/vertex.ts`, `src/providers/azure.ts` and their
colocated tests. Appended-to: `src/providers/builtins.ts` (two
`registerProviderFactory` calls in marked blocks) and `src/catalog.ts` (one
marked Vertex block plus `...VERTEX_MODELS` in `BUILT_IN`). Nothing else was
touched.

## index.ts wiring (please add)

```ts
export {
  AZURE_API_KEY_ENV,
  AZURE_API_VERSION_ENV,
  AZURE_DEFAULT_API_VERSION,
  AZURE_ENDPOINT_ENV,
  type AzureConfig,
  type AzureEnv,
  type AzureModelOptions,
  type AzureModelSpec,
  type AzureProviderOptions,
  type AzureSpecOptions,
  azureCacheKey,
  azureModel,
  azureStreamRequest,
  checkAzureCredentials,
  createAzureProvider,
  resolveAzureConfig,
} from "./providers/azure.js";
export {
  checkVertexCredentials,
  createVertexProvider,
  resolveVertexConfig,
  VERTEX_DEFAULT_LOCATION,
  VERTEX_LOCATION_ENV,
  VERTEX_PROJECT_ENV,
  VERTEX_SCOPE,
  type VertexConfig,
  type VertexEnv,
  type VertexFamily,
  type VertexModelOptions,
  type VertexModelSpec,
  type VertexProviderOptions,
  type VertexSpecOptions,
  vertexCacheKey,
  vertexFamily,
  vertexModel,
} from "./providers/vertex.js";
```

`azureModel` and `vertexModel` are the two entry points hosts actually need;
the rest is for tests, diagnostics and bespoke wiring.

## Contract friction

### 1. `ModelSpec` has no `providerOptions`
Both backends are addressed by coordinates that are neither an API key nor a
base URL — a GCP project and location, an Azure endpoint/deployment/api-version.
`ProviderRegistration.cacheKeyOf` and `checkCredentials` only ever see a
`ModelSpec`, so the data has to live on the spec, but `ModelSpec` is frozen.

**Workaround:** both adapters read an optional `providerOptions` bag off the
spec through a widened type (`VertexModelSpec`, `AzureModelSpec`) and the
`vertexModel()` / `azureModel()` builders populate it. Structurally this is just
an extra property on a plain object, so nothing in the frozen contract changes,
but a hand-written spec literal needs the widened type to typecheck.
`LLMRequest.providerOptions` is deliberately *not* used for this: it is spread
onto the wire payload by `buildGoogleRequest` / `buildOpenAIRequest` /
`buildAnthropicRequest`, so routing data placed there would leak into the
request body.

**Suggested contract change:** `providerOptions?: Record<string, unknown>` on
`ModelSpec` — the same gap the Bedrock adapter hit for its region.

### 2. The catalog invariant requires an `apiKeyEnv`
`catalog.test.ts` asserts every built-in entry has a truthy `apiKeyEnv`, but
Vertex has no API key at all: it authenticates with application-default
credentials. The entries name `GOOGLE_APPLICATION_CREDENTIALS` to satisfy the
invariant and the adapter ignores whatever `resolveApiKey` returns for it. If
the invariant is relaxed (Bedrock has the same problem), drop the field.

### 3. `ProviderPrecheckFailure` has no "misconfigured" kind
A missing GCP project or Azure endpoint is neither an auth failure nor a bad
request — it is missing configuration. Both are reported as `invalidRequest`,
which at least makes them non-retryable.

### 4. `checkCredentials` is synchronous
Vertex can discover its project from ambient credentials, but only
asynchronously (`GoogleAuth#getProjectId`). The precheck therefore uses the sync
sources only (spec `providerOptions`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`,
`ANTHROPIC_VERTEX_PROJECT_ID`) and treats a set `GOOGLE_APPLICATION_CREDENTIALS`
as proof that a project exists, because the key file carries `project_id`. The
real discovery happens once per provider instance at call time.

## Design decisions

- **Vertex is a router, not a third converter.** Gemini requests go straight
  through `googleEventStream`, Claude requests through `anthropicEventStream`;
  neither converter, tool-call accumulator nor usage normaliser is duplicated.
  The family is inferred from the model name (`claude*` → Anthropic SDK) and can
  be pinned with `providerOptions.family` for model-garden ids that do not
  follow the convention.
- **Azure sends the OpenAI dialect.** `azureStreamRequest` relabels the spec as
  `provider: "openai"` before handing it to `buildOpenAIRequest`, so Azure gets
  `max_completion_tokens` and `reasoning_effort` rather than the compatible-
  gateway `max_tokens`. The original spec is still what `assembleStream` sees,
  so `AssistantMessage.model` remains the catalog id.
- **Azure addresses a deployment.** `spec.model` *is* the deployment unless
  `providerOptions.deployment` overrides it, and the resolved deployment is what
  goes in the request body and the URL path. Because a deployment can be named
  anything, the "reasoning models reject temperature" check runs against both
  the deployment name and the catalog model name, and drops the temperature if
  either says no.
- **One provider instance, many models.** Vertex clients are memoised per
  family/project/location and Azure clients per endpoint/deployment/version, so
  a client cached by `createClient` under one `cacheKeyOf` still serves several
  deployments without rebuilding SDK clients.
- **Credential failures without an HTTP status are re-classified.**
  `AnthropicVertex` wraps a failed Google token exchange in a connection error,
  which `toAIError` would otherwise call `unknown` and the retry layer would
  keep retrying. `vertex.ts` upgrades those to `kind: "auth"` by message.
- **Entra ID and API keys are mutually exclusive** (the Azure SDK throws when
  given both), so the registry only converts `ctx.getAccessToken` into an
  `azureADTokenProvider` when no API key resolved.
- **Default Azure API version is `2024-10-21`** (GA, streaming tool calls).
  Reasoning deployments may need a newer preview version — set
  `AZURE_OPENAI_API_VERSION` or `providerOptions.apiVersion`.

## Caveats

- Vertex **express mode** (a Vertex API key instead of ADC) is not wired: the
  adapter ignores `ctx.apiKey` entirely. `ctx.getAccessToken` is likewise unused
  on Vertex, since ADC already refreshes its own tokens.
- The two Google SDKs pin an older `google-auth-library` major than this package
  declares, so `googleAuthOptions` crosses each SDK boundary through a
  structural cast. Behaviour is unaffected; only the type identity differs.
- Vertex Claude prices mirror the first-party list and Gemini-on-Vertex mirrors
  AI Studio. Both drift; `registerModel` overrides any entry.
- `getModel("gemini-2.5-pro")` still resolves to `google/gemini-2.5-pro`: the
  bare-name fallback scans in registration order and the first-party entries
  come first. Vertex entries must be addressed by their full catalog id.
