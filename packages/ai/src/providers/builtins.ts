/**
 * Registration of the adapters that ship with Arcturn.
 *
 * Kept apart from `client.ts` so adding a backend never means editing dispatch
 * code: a new adapter is a new file plus one entry here.
 */

import { DEFAULT_API_KEY_ENV } from "../catalog.js";
import { createAnthropicProvider } from "./anthropic.js";
import { azureCacheKey, checkAzureCredentials, createAzureProvider } from "./azure.js";
// --- Bedrock ---
import { bedrockCacheKey, checkBedrockCredentials, createBedrockProvider } from "./bedrock.js";
// --- end Bedrock ---
import { createGoogleProvider } from "./google.js";
import { createOpenAIProvider } from "./openai.js";
import { registerOpenAIResponsesProvider } from "./openai-responses.js";
import {
  type ProviderFactoryContext,
  type ProviderPrecheckFailure,
  registerProviderFactory,
} from "./registry.js";
import { checkVertexCredentials, createVertexProvider, vertexCacheKey } from "./vertex.js";

/**
 * Placeholder credential for endpoints that require no authentication.
 *
 * Local runtimes — Ollama, LM Studio, vLLM — accept any value, but both
 * vendor SDKs throw at construction when the key is absent entirely, so a
 * compatible endpoint with no key configured needs *something* here.
 */
const NO_CREDENTIAL_REQUIRED = "not-required";

/** Options shared by the SDK-backed adapters. */
function shared(ctx: ProviderFactoryContext, fallbackApiKey?: string) {
  const apiKey = ctx.apiKey ?? fallbackApiKey;
  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
    ...(ctx.headers ? { headers: ctx.headers } : {}),
  };
}

/** Reports a missing API key, naming the environment variable to set. */
function requireApiKey(ctx: ProviderFactoryContext): ProviderPrecheckFailure | undefined {
  if (ctx.apiKey) return undefined;
  const envVar =
    ctx.spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV[ctx.spec.provider] ?? "the provider API key env var";
  return { kind: "auth", message: `No API key for ${ctx.spec.provider}; set ${envVar}` };
}

/** Reports a compatible-endpoint spec that forgot its base URL. */
function requireBaseUrl(flavor: string) {
  return (ctx: ProviderFactoryContext): ProviderPrecheckFailure | undefined => {
    if (!ctx.baseUrl) {
      return {
        kind: "invalidRequest",
        message: `Model ${ctx.spec.id} is ${flavor} but has no baseUrl`,
      };
    }
    // A spec that names an API key variable expects one. Falling through to the
    // placeholder credential would send a bogus key and surface the provider's
    // 401 instead of telling the user which variable to set. Specs with no
    // apiKeyEnv are the genuinely keyless local runtimes, and pass.
    if (ctx.spec.apiKeyEnv && !ctx.apiKey) {
      return {
        kind: "auth",
        message: `No API key for ${ctx.spec.id}; set ${ctx.spec.apiKeyEnv}`,
      };
    }
    return undefined;
  };
}

let registered = false;

/** Register every built-in adapter. Idempotent. */
export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;

  registerProviderFactory({
    id: "anthropic",
    factory: (ctx) => createAnthropicProvider(shared(ctx)),
    checkCredentials: requireApiKey,
  });

  registerProviderFactory({
    id: "google",
    factory: (ctx) => createGoogleProvider(shared(ctx)),
    checkCredentials: requireApiKey,
  });

  registerProviderFactory({
    id: "openai",
    factory: (ctx) => createOpenAIProvider(shared(ctx)),
    checkCredentials: requireApiKey,
  });

  // OpenAI's current API surface, alongside the Chat Completions adapter above.
  registerOpenAIResponsesProvider();

  registerProviderFactory({
    id: "openai-compatible",
    factory: (ctx) => createOpenAIProvider(shared(ctx, NO_CREDENTIAL_REQUIRED)),
    // Third-party endpoints are the point here, so the base URL is required
    // while the key is not: local runtimes like Ollama need no credential.
    checkCredentials: requireBaseUrl("openai-compatible"),
  });

  registerProviderFactory({
    id: "anthropic-compatible",
    factory: (ctx) => createAnthropicProvider(shared(ctx, NO_CREDENTIAL_REQUIRED)),
    checkCredentials: requireBaseUrl("anthropic-compatible"),
  });

  // --- Vertex AI ----------------------------------------------------------
  // Credentials are ambient (application-default), so nothing but the headers
  // is threaded through; the project and location come off the model spec.
  registerProviderFactory({
    id: "vertex",
    factory: (ctx) => createVertexProvider(ctx.headers ? { headers: ctx.headers } : {}),
    cacheKeyOf: (spec) => vertexCacheKey(spec),
    checkCredentials: (ctx) => checkVertexCredentials(ctx),
  });
  // --- end Vertex AI ------------------------------------------------------

  // --- Azure OpenAI -------------------------------------------------------
  // The OAuth token store, when the host wired one, becomes the Entra ID token
  // provider. Azure rejects a key and a token together, so it is only used when
  // no API key resolved.
  registerProviderFactory({
    id: "azure",
    factory: (ctx) => {
      const getAccessToken = ctx.getAccessToken;
      return createAzureProvider({
        ...(ctx.apiKey !== undefined ? { apiKey: ctx.apiKey } : {}),
        ...(ctx.headers ? { headers: ctx.headers } : {}),
        ...(ctx.apiKey === undefined && getAccessToken
          ? { azureADTokenProvider: () => getAccessToken("azure") }
          : {}),
      });
    },
    cacheKeyOf: (spec) => azureCacheKey(spec),
    checkCredentials: (ctx) => checkAzureCredentials(ctx),
  });
  // --- end Azure OpenAI ---------------------------------------------------

  // --- Bedrock ------------------------------------------------------------
  // Credentials are ambient (the AWS provider chain: env, profiles, SSO, IAM
  // roles), so only the region is checked up front. The region is part of the
  // cache key: two regions are two different endpoints and signing scopes.
  registerProviderFactory({
    id: "bedrock",
    factory: (ctx) => createBedrockProvider({ ...shared(ctx), spec: ctx.spec }),
    cacheKeyOf: (spec) => bedrockCacheKey(spec),
    checkCredentials: (ctx) => checkBedrockCredentials(ctx),
  });
  // --- end Bedrock --------------------------------------------------------
}
