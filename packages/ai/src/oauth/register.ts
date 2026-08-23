/**
 * Provider-registry adapters for the OAuth-only backends.
 *
 * `github-copilot` and `openai-codex` are not in the built-in registration set,
 * because they cannot be dispatched with an API key at all — they only work
 * once someone has signed in. Registering them is therefore opt-in: a host
 * calls {@link registerOAuthProviderFactories} after wiring a token store.
 *
 * ### Why the client is built per request
 *
 * `ProviderFactory` is synchronous (`(ctx) => LLMClient`) but
 * `ProviderFactoryContext.getAccessToken` is asynchronous, and the token it
 * returns has to land in a header the adapter is constructed with. The factory
 * therefore returns a thin `LLMClient` that resolves the token when a request
 * starts and builds (and caches) the real adapter behind it. That also means a
 * refreshed token is picked up automatically, without recreating the client.
 */

import type { LLMClient, LLMRequest, ProviderId, StreamEvent } from "@arcturn/types";
import { AIErrorException, toAIError } from "../errors.js";
import { MessageAssembler } from "../internal/stream.js";
import { createAnthropicProvider } from "../providers/anthropic.js";
import { createOpenAIProvider } from "../providers/openai.js";
import {
  type ProviderFactoryContext,
  type ProviderPrecheckFailure,
  registerProviderFactory,
} from "../providers/registry.js";
import { oauthAuthHeaders } from "./headers.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  GITHUB_COPILOT_PROVIDER,
  OAUTH_CONSTANTS,
  OPENAI_CODEX_PROVIDER,
} from "./providers.js";

/** What an adapter needs once the token has been resolved. */
export interface ResolvedAuth {
  /** The bearer token itself, for SDKs that own the `Authorization` header. */
  token: string;
  /** Base URL from the spec, the client override, or the provider default. */
  baseUrl: string | undefined;
  /** Every OAuth header, `authorization` included. */
  headers: Record<string, string>;
  /** The same headers minus `authorization`, for SDKs that set it themselves. */
  headersWithoutAuthorization: Record<string, string>;
}

/** Builds the underlying adapter once the auth headers are known. */
type AdapterFactory = (auth: ResolvedAuth) => LLMClient;

/**
 * Wrap an adapter so its bearer token is resolved per request.
 *
 * The built adapter is cached against the token it was built with, so a stable
 * token means one adapter and one connection pool, while a refresh transparently
 * produces a new one.
 */
function tokenScopedClient(
  ctx: ProviderFactoryContext,
  provider: ProviderId,
  build: AdapterFactory,
  defaultBaseUrl?: string,
): LLMClient {
  let cachedToken: string | undefined;
  let cached: LLMClient | undefined;

  const resolve = async (): Promise<LLMClient> => {
    if (!ctx.getAccessToken) {
      throw new AIErrorException({
        kind: "auth",
        message: `No OAuth token source configured for ${provider}; pass getAccessToken to createClient`,
      });
    }
    const token = await ctx.getAccessToken(provider);
    if (cached && cachedToken === token) return cached;
    const headers = { ...ctx.headers, ...oauthAuthHeaders(provider, token) };
    const { authorization: _authorization, ...headersWithoutAuthorization } = headers;
    cached = build({
      token,
      baseUrl: ctx.baseUrl ?? defaultBaseUrl,
      headers,
      headersWithoutAuthorization,
    });
    cachedToken = token;
    return cached;
  };

  // Token resolution failures must surface as a terminal `error` event, exactly
  // as dispatch failures do in `createClient`.
  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    let client: LLMClient;
    try {
      client = await resolve();
    } catch (err) {
      const error = toAIError(err, request.signal);
      yield { type: "start", model: request.model.id };
      yield {
        type: "error",
        error,
        message: new MessageAssembler(request.model).finalize("error", error.message),
      };
      return;
    }
    yield* client.stream(request);
  }

  return {
    stream,
    async complete(request: LLMRequest) {
      const client = await resolve();
      return client.complete(request);
    },
  };
}

/** Fails a provider that has neither an OAuth token source nor an API key. */
function requireOAuth(provider: ProviderId) {
  return (ctx: ProviderFactoryContext): ProviderPrecheckFailure | undefined =>
    ctx.getAccessToken
      ? undefined
      : {
          kind: "auth",
          message:
            `${provider} is OAuth-only. Run \`arcturn auth login ${provider}\` and pass ` +
            "getAccessToken to createClient.",
        };
}

/** Default API base URLs, all sourced from the single constants block. */
const apiBaseUrls = {
  githubCopilot: OAUTH_CONSTANTS.githubCopilot.apiBaseUrl,
  openaiCodex: OAUTH_CONSTANTS.openaiCodex.apiBaseUrl,
};

/**
 * OpenAI-compatible adapter.
 *
 * The token goes in as the SDK's `apiKey`, not as a header: the OpenAI SDK
 * builds its own `Authorization: Bearer` and would override a header of the
 * same name. The remaining OAuth headers (Copilot's integration ids) are passed
 * through as default headers.
 */
const openAIAdapter: AdapterFactory = (auth) =>
  createOpenAIProvider({
    apiKey: auth.token,
    ...(auth.baseUrl !== undefined ? { baseUrl: auth.baseUrl } : {}),
    headers: auth.headersWithoutAuthorization,
  });

/**
 * Anthropic adapter with **no** API key, so the SDK omits `x-api-key` and the
 * `Authorization: Bearer` header from {@link oauthAuthHeaders} is what
 * authenticates the request.
 */
const anthropicAdapter: AdapterFactory = (auth) =>
  createAnthropicProvider({
    ...(auth.baseUrl !== undefined ? { baseUrl: auth.baseUrl } : {}),
    headers: auth.headers,
  });

let registered = false;

/**
 * Register the OAuth-only provider adapters. Idempotent.
 *
 * Registers `github-copilot` (OpenAI-compatible wire format) and
 * `openai-codex`. `anthropic` deliberately keeps its API-key registration:
 * OAuth there is an alternative credential for the same adapter, selected by
 * {@link registerAnthropicOAuthProvider} under a separate provider id when a
 * host wants both available at once.
 */
export function registerOAuthProviderFactories(): void {
  if (registered) return;
  registered = true;

  registerProviderFactory({
    id: GITHUB_COPILOT_PROVIDER,
    factory: (ctx) =>
      tokenScopedClient(ctx, GITHUB_COPILOT_PROVIDER, openAIAdapter, apiBaseUrls.githubCopilot),
    checkCredentials: requireOAuth(GITHUB_COPILOT_PROVIDER),
  });

  registerProviderFactory({
    id: OPENAI_CODEX_PROVIDER,
    factory: (ctx) =>
      tokenScopedClient(ctx, OPENAI_CODEX_PROVIDER, openAIAdapter, apiBaseUrls.openaiCodex),
    checkCredentials: requireOAuth(OPENAI_CODEX_PROVIDER),
  });
}

/** Provider id under which the OAuth-authenticated Anthropic adapter registers. */
export const ANTHROPIC_OAUTH_PROVIDER_ID = "anthropic-oauth";

/**
 * Register an Anthropic adapter that authenticates with a Claude subscription.
 *
 * Registered under `anthropic-oauth` rather than `anthropic` so a host can keep
 * API-key access working; point a model spec's `provider` at it to use the
 * subscription. The adapter is constructed with **no** API key, so the SDK never
 * sends `x-api-key` alongside the bearer token.
 *
 * @param options - `tokenProvider` selects which stored credential is used;
 *   defaults to `"anthropic"`, matching what {@link beginLogin} persists.
 */
export function registerAnthropicOAuthProvider(options: { tokenProvider?: ProviderId } = {}): void {
  const tokenProvider = options.tokenProvider ?? ANTHROPIC_OAUTH_PROVIDER;
  registerProviderFactory({
    id: ANTHROPIC_OAUTH_PROVIDER_ID,
    factory: (ctx) => tokenScopedClient(ctx, tokenProvider, anthropicAdapter),
    checkCredentials: requireOAuth(ANTHROPIC_OAUTH_PROVIDER_ID),
  });
}
