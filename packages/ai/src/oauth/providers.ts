/**
 * OAuth configuration for the providers Arcturn can sign into.
 *
 * Every endpoint URL and client id lives in the single {@link OAUTH_CONSTANTS}
 * block below. Those values are public (client ids for native/desktop apps are
 * not secrets — RFC 8252 §8.5 — and no client secret is stored anywhere here),
 * but they *do* change over time and could not be verified offline. Anything
 * wrong there is fixable at runtime through {@link configureOAuthProvider} or
 * the `ARCTURN_OAUTH_*` environment variables, without a code change.
 */

import type { ProviderId } from "@arcturn/types";
import { OAuthError, summarizeBody } from "./errors.js";
import { oauthErrorFrom, parseOAuthBody, type TokenRequestFormat, toEpochMs } from "./token.js";
import type { DerivedCredential, FetchLike, OAuthRuntime } from "./types.js";
import { defaultClock, globalFetch } from "./types.js";

/* ────────────────────────────────────────────────────────────────────────────
 * PROVIDER CONSTANTS — VERIFY BEFORE RELEASE
 *
 * Everything in this block is an external, provider-owned value that was NOT
 * verified against live documentation (this package is built offline). Each
 * entry must be checked against the provider's current developer docs before
 * shipping, and each is overridable at runtime — see `configureOAuthProvider`
 * and `applyOAuthEnvOverrides` — so a stale value never requires a release.
 *
 * None of these are secrets: they are public client identifiers and endpoint
 * URLs. No client secret is embedded, and none is required by any flow here
 * (all three providers are public clients using PKCE or the device grant).
 * ──────────────────────────────────────────────────────────────────────────── */
export const OAUTH_CONSTANTS = {
  githubCopilot: {
    /** Public client id GitHub publishes for editor/device integrations. VERIFY. */
    clientId: "Iv1.b507a08c87ecfe98",
    /** RFC 8628 device authorization endpoint. VERIFY. */
    deviceAuthorizationEndpoint: "https://github.com/login/device/code",
    /** OAuth token endpoint used for the device grant. VERIFY. */
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    /** Scopes requested for the device grant. VERIFY. */
    scopes: ["read:user"] as const,
    /**
     * Stage-2: trades the long-lived GitHub token for a short-lived Copilot API
     * token. This endpoint is an internal GitHub API and is the single most
     * likely constant to change. VERIFY.
     */
    apiTokenEndpoint: "https://api.github.com/copilot_internal/v2/token",
    /** Header values Copilot expects on API calls; the exact values are UNVERIFIED. */
    integrationId: "vscode-chat",
    editorVersion: "Arcturn/0.1.0",
    editorPluginVersion: "arcturn/0.1.0",
    /**
     * Default base URL for Copilot's OpenAI-compatible chat API, used when a
     * model spec sets none. The stage-2 response also reports an `endpoints.api`
     * value, which is authoritative and stored as credential metadata. VERIFY.
     */
    apiBaseUrl: "https://api.githubcopilot.com",
  },
  anthropic: {
    /** Public client id used by Anthropic's first-party CLI OAuth flow. VERIFY. */
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    /** Consent screen shown to a Claude subscriber. VERIFY. */
    authorizationEndpoint: "https://claude.ai/oauth/authorize",
    /** Token endpoint for the authorization-code and refresh grants. VERIFY. */
    tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
    /** Scopes requested. VERIFY. */
    scopes: ["org:create_api_key", "user:profile", "user:inference"] as const,
    /**
     * The token endpoint is believed to expect a JSON body rather than the
     * form encoding RFC 6749 mandates. VERIFY; flip to "form" if wrong.
     */
    tokenRequestFormat: "json" as TokenRequestFormat,
    /** Beta header that enables OAuth bearer auth on the Messages API. VERIFY. */
    betaHeader: "oauth-2025-04-20",
    /** Messages API version header. VERIFY against the current API docs. */
    apiVersion: "2023-06-01",
  },
  openaiCodex: {
    /** Public client id for the Codex CLI's ChatGPT sign-in. VERIFY. */
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    /** Consent screen shown to a ChatGPT subscriber. VERIFY. */
    authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
    /** Token endpoint for the authorization-code and refresh grants. VERIFY. */
    tokenEndpoint: "https://auth.openai.com/oauth/token",
    /** Scopes requested. VERIFY. */
    scopes: ["openid", "profile", "email", "offline_access"] as const,
    /**
     * The redirect URI is believed to be registered for an exact loopback port,
     * so the ephemeral-port default cannot be used. VERIFY the port and path;
     * set to `undefined` if the provider accepts any loopback port.
     */
    redirectPort: 1455,
    redirectPath: "/auth/callback",
    /**
     * Base URL for the API a ChatGPT-subscription token may call. HIGHLY
     * UNVERIFIED — a subscription token is not accepted by the public
     * `api.openai.com` endpoint, so this must be checked before release and is
     * expected to be overridden per model spec. VERIFY.
     */
    apiBaseUrl: "https://chatgpt.com/backend-api/codex",
  },
} as const;
/* ───────────────────────── end of unverified constants ─────────────────────── */

/** Which grant a provider uses. */
export type OAuthFlowKind = "pkce" | "device";

/** Stage-2 credential exchange, for providers whose API token is not the OAuth token. */
export interface SecondStageConfig {
  /** Endpoint that mints the short-lived API token. */
  endpoint: string;
  /** HTTP method. Defaults to `"GET"`. */
  method?: "GET" | "POST";
  /** Builds the `Authorization` header value from the stage-1 token. */
  authorization: (stage1Token: string) => string;
  /** Extra request headers. */
  headers?: Readonly<Record<string, string>>;
  /** Response field carrying the token. Defaults to `"token"`. */
  tokenField?: string;
  /** Response field carrying the expiry (epoch seconds or ms). Defaults to `"expires_at"`. */
  expiryField?: string;
}

/** Everything needed to sign into one provider and to authenticate its API calls. */
export interface OAuthProviderConfig {
  /** Provider id, matching {@link ProviderId} used by the model catalog. */
  provider: ProviderId;
  /** Human-readable name for CLI prompts. */
  displayName: string;
  /** Which grant to run. */
  flow: OAuthFlowKind;
  /** Public OAuth client id. */
  clientId: string;
  /** Required when `flow` is `"pkce"`. */
  authorizationEndpoint?: string;
  /** Required when `flow` is `"device"`. */
  deviceAuthorizationEndpoint?: string;
  /** Token endpoint for the code/device/refresh grants. */
  tokenEndpoint: string;
  /** Scopes requested at authorization time. */
  scopes: readonly string[];
  /** Encoding for token requests. Defaults to `"form"`. */
  tokenRequestFormat?: TokenRequestFormat;
  /** Extra query parameters on the authorization URL. */
  authorizationParams?: Readonly<Record<string, string>>;
  /** Extra body parameters on every token request. */
  tokenParams?: Readonly<Record<string, string>>;
  /** Extra headers on every token request. */
  tokenHeaders?: Readonly<Record<string, string>>;
  /** Fixed loopback port, when the provider registered an exact redirect URI. */
  redirectPort?: number;
  /** Loopback redirect path. Defaults to `/callback`. */
  redirectPath?: string;
  /** Present when the API token is not the OAuth token (GitHub Copilot). */
  secondStage?: SecondStageConfig;
  /**
   * Headers to attach to model API calls once a token is resolved.
   *
   * @param token - The resolved bearer token (stage-2 when `secondStage` is set).
   */
  apiHeaders: (token: string) => Record<string, string>;
}

/** Provider id for the GitHub Copilot subscription login. */
export const GITHUB_COPILOT_PROVIDER = "github-copilot";
/** Provider id for the Claude subscription login; matches the API-key provider id. */
export const ANTHROPIC_OAUTH_PROVIDER = "anthropic";
/** Provider id for the ChatGPT/Codex subscription login. */
export const OPENAI_CODEX_PROVIDER = "openai-codex";

function githubCopilotConfig(): OAuthProviderConfig {
  const c = OAUTH_CONSTANTS.githubCopilot;
  return {
    provider: GITHUB_COPILOT_PROVIDER,
    displayName: "GitHub Copilot",
    flow: "device",
    clientId: c.clientId,
    deviceAuthorizationEndpoint: c.deviceAuthorizationEndpoint,
    tokenEndpoint: c.tokenEndpoint,
    scopes: [...c.scopes],
    // GitHub answers with form encoding unless the Accept header asks otherwise;
    // `postOAuthRequest` always sends `accept: application/json` and the parser
    // copes with either, so this is belt and braces.
    tokenHeaders: { accept: "application/json" },
    secondStage: {
      endpoint: c.apiTokenEndpoint,
      method: "GET",
      authorization: (stage1) => `token ${stage1}`,
      headers: {
        accept: "application/json",
        "editor-version": c.editorVersion,
        "editor-plugin-version": c.editorPluginVersion,
        "user-agent": c.editorPluginVersion,
      },
      tokenField: "token",
      expiryField: "expires_at",
    },
    apiHeaders: (token) => ({
      // UNVERIFIED: Copilot's chat endpoint is OpenAI-compatible but expects
      // these integration headers alongside the bearer token.
      authorization: `Bearer ${token}`,
      "copilot-integration-id": c.integrationId,
      "editor-version": c.editorVersion,
      "editor-plugin-version": c.editorPluginVersion,
    }),
  };
}

function anthropicConfig(): OAuthProviderConfig {
  const c = OAUTH_CONSTANTS.anthropic;
  return {
    provider: ANTHROPIC_OAUTH_PROVIDER,
    displayName: "Claude subscription (Anthropic)",
    flow: "pkce",
    clientId: c.clientId,
    authorizationEndpoint: c.authorizationEndpoint,
    tokenEndpoint: c.tokenEndpoint,
    scopes: [...c.scopes],
    tokenRequestFormat: c.tokenRequestFormat,
    apiHeaders: (token) => ({
      // With OAuth the `x-api-key` header must be absent; the bearer token
      // replaces it and the beta header opts the request into OAuth auth.
      authorization: `Bearer ${token}`,
      "anthropic-beta": c.betaHeader,
      "anthropic-version": c.apiVersion,
    }),
  };
}

function openaiCodexConfig(): OAuthProviderConfig {
  const c = OAUTH_CONSTANTS.openaiCodex;
  return {
    provider: OPENAI_CODEX_PROVIDER,
    displayName: "ChatGPT subscription (OpenAI Codex)",
    flow: "pkce",
    clientId: c.clientId,
    authorizationEndpoint: c.authorizationEndpoint,
    tokenEndpoint: c.tokenEndpoint,
    scopes: [...c.scopes],
    redirectPort: c.redirectPort,
    redirectPath: c.redirectPath,
    apiHeaders: (token) => ({ authorization: `Bearer ${token}` }),
  };
}

function builtinConfigs(): OAuthProviderConfig[] {
  return [githubCopilotConfig(), anthropicConfig(), openaiCodexConfig()];
}

const configs = new Map<string, OAuthProviderConfig>();

function seed(): void {
  configs.clear();
  for (const config of builtinConfigs()) configs.set(String(config.provider), config);
}
seed();

/** Every provider that can be signed into, sorted. */
export function listOAuthProviders(): ProviderId[] {
  return [...configs.keys()].sort();
}

/** The configuration for one provider, or `undefined` when it has none. */
export function getOAuthProviderConfig(provider: ProviderId): OAuthProviderConfig | undefined {
  return configs.get(String(provider));
}

/**
 * The configuration for one provider.
 *
 * @throws {OAuthError} `arcturn_no_credentials` when the provider has no OAuth
 *   support, naming the ones that do.
 */
export function requireOAuthProviderConfig(provider: ProviderId): OAuthProviderConfig {
  const config = getOAuthProviderConfig(provider);
  if (!config) {
    throw new OAuthError(
      "arcturn_no_credentials",
      `${provider} does not support OAuth sign-in. Providers that do: ${listOAuthProviders().join(", ")}`,
      { provider: String(provider) },
    );
  }
  return config;
}

/** Register (or wholly replace) a provider configuration. */
export function registerOAuthProvider(config: OAuthProviderConfig): void {
  configs.set(String(config.provider), config);
}

/**
 * Patch one provider's configuration at runtime.
 *
 * The escape hatch for a constant in {@link OAUTH_CONSTANTS} that a provider
 * has since changed: a host can correct the endpoint or client id from its own
 * config file without waiting for a Arcturn release.
 *
 * @param provider - The provider to patch.
 * @param overrides - Fields to replace.
 * @returns The merged configuration.
 */
export function configureOAuthProvider(
  provider: ProviderId,
  overrides: Partial<Omit<OAuthProviderConfig, "provider">>,
): OAuthProviderConfig {
  const current = requireOAuthProviderConfig(provider);
  const merged: OAuthProviderConfig = { ...current, ...overrides, provider: current.provider };
  configs.set(String(provider), merged);
  return merged;
}

/** Restore the built-in configurations, discarding every runtime override. */
export function resetOAuthProviders(): void {
  seed();
}

/** Environment variable prefix for per-provider overrides. */
export const OAUTH_ENV_PREFIX = "ARCTURN_OAUTH_";

function envKey(provider: ProviderId, suffix: string): string {
  return `${OAUTH_ENV_PREFIX}${String(provider)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

/**
 * Apply `ARCTURN_OAUTH_*` environment overrides to every registered provider.
 *
 * For provider `github-copilot` the variables are
 * `ARCTURN_OAUTH_GITHUB_COPILOT_CLIENT_ID`, `…_AUTHORIZATION_ENDPOINT`,
 * `…_TOKEN_ENDPOINT`, `…_DEVICE_ENDPOINT` and `…_SCOPES` (space or comma
 * separated). This is the zero-code fix for a rotated endpoint.
 *
 * @param env - Environment to read. Defaults to `process.env`.
 * @returns The providers that were changed.
 */
export function applyOAuthEnvOverrides(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
): ProviderId[] {
  const changed: ProviderId[] = [];
  for (const provider of listOAuthProviders()) {
    const overrides: Partial<Omit<OAuthProviderConfig, "provider">> = {};
    const clientId = env[envKey(provider, "CLIENT_ID")];
    if (clientId) overrides.clientId = clientId;
    const authorization = env[envKey(provider, "AUTHORIZATION_ENDPOINT")];
    if (authorization) overrides.authorizationEndpoint = authorization;
    const token = env[envKey(provider, "TOKEN_ENDPOINT")];
    if (token) overrides.tokenEndpoint = token;
    const device = env[envKey(provider, "DEVICE_ENDPOINT")];
    if (device) overrides.deviceAuthorizationEndpoint = device;
    const scopes = env[envKey(provider, "SCOPES")];
    if (scopes) overrides.scopes = scopes.split(/[\s,]+/).filter((entry) => entry !== "");
    if (Object.keys(overrides).length === 0) continue;
    configureOAuthProvider(provider, overrides);
    changed.push(provider);
  }
  return changed;
}

/**
 * Mint the stage-2 credential for a two-stage provider.
 *
 * GitHub Copilot is the motivating case: the device grant yields a durable
 * GitHub token, which must be traded for a Copilot API token that expires
 * within the hour. The result is cached in the token store and re-minted on
 * expiry, so this runs at most once per token lifetime.
 *
 * @param config - The stage-2 endpoint description.
 * @param stage1Token - The stored OAuth access token.
 * @param runtime - Injected fetch/clock/abort signal.
 * @returns The short-lived credential plus any non-secret metadata returned
 *   with it (Copilot reports its API endpoints this way).
 * @throws {OAuthError} `arcturn_exchange_failed` when the endpoint refuses or
 *   answers with something unusable.
 */
export async function exchangeSecondStageCredential(
  config: SecondStageConfig,
  stage1Token: string,
  runtime: OAuthRuntime & { provider?: string } = {},
): Promise<DerivedCredential> {
  const fetchImpl: FetchLike = runtime.fetch ?? globalFetch();
  const now = runtime.now ?? defaultClock;
  const provider = runtime.provider;

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(config.endpoint, {
      method: config.method ?? "GET",
      headers: {
        accept: "application/json",
        ...config.headers,
        authorization: config.authorization(stage1Token),
      },
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new OAuthError(
      "arcturn_exchange_failed",
      `Could not reach ${config.endpoint}: ${reason}`,
      {
        ...(provider !== undefined ? { provider } : {}),
        cause,
      },
    );
  }

  const text = await response.text();
  const body = parseOAuthBody(text);
  const error = oauthErrorFrom(body, {
    status: response.status,
    ...(provider !== undefined ? { provider } : {}),
  });
  if (error) throw error;

  if (!response.ok) {
    throw new OAuthError(
      "arcturn_exchange_failed",
      `${config.endpoint} returned HTTP ${response.status}: ${summarizeBody(text, {
        secrets: [stage1Token],
      })}`,
      { status: response.status, ...(provider !== undefined ? { provider } : {}) },
    );
  }

  const tokenField = config.tokenField ?? "token";
  const rawToken = body[tokenField];
  if (typeof rawToken !== "string" || rawToken === "") {
    throw new OAuthError(
      "arcturn_exchange_failed",
      `${config.endpoint} returned no "${tokenField}" field`,
      { ...(provider !== undefined ? { provider } : {}) },
    );
  }

  const credential: DerivedCredential = { accessToken: rawToken };
  const expiryField = config.expiryField ?? "expires_at";
  const rawExpiry = body[expiryField];
  if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
    credential.expiresAt = toEpochMs(rawExpiry);
  } else if (typeof rawExpiry === "string" && Number.isFinite(Number(rawExpiry))) {
    credential.expiresAt = toEpochMs(Number(rawExpiry));
  } else if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in)) {
    credential.expiresAt = now() + Math.floor(body.expires_in * 1000);
  }

  // Copilot reports its API host under `endpoints.api`; keep it, it is not secret.
  const endpoints = body.endpoints;
  if (endpoints !== null && typeof endpoints === "object") {
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(endpoints as Record<string, unknown>)) {
      if (typeof value === "string") metadata[`endpoint.${key}`] = value;
    }
    if (Object.keys(metadata).length > 0) credential.metadata = metadata;
  }

  return credential;
}
