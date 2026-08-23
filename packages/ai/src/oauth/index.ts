/**
 * OAuth sign-in for `@arcturn/ai`.
 *
 * Lets a user authenticate with a subscription they already pay for — a Claude
 * plan, a ChatGPT plan, a GitHub Copilot seat — instead of pasting an API key.
 *
 * Two entry points matter:
 *
 * ```ts
 * // 1. A CLI drives the login.
 * const store = new FileOAuthTokenStore();
 * const session = await beginLogin("anthropic", { store });
 * if (session.flow === "pkce") console.log("Open:", session.authorizationUrl);
 * else console.log(`Open ${session.verificationUri} and enter ${session.userCode}`);
 * await session.complete();
 *
 * // 2. The client resolves tokens per request.
 * const client = createClient({ getAccessToken: createAccessTokenResolver(store) });
 * ```
 *
 * The resolver has exactly the shape `CreateClientOptions.getAccessToken` and
 * `ProviderFactoryContext.getAccessToken` declare:
 * `(provider: ProviderId) => Promise<string>`.
 */

import type { ProviderId } from "@arcturn/types";
import { DEFAULT_API_KEY_ENV } from "../catalog.js";
import {
  type DeviceAuthorization,
  type DeviceFlowConfig,
  pollDeviceToken,
  requestDeviceAuthorization,
} from "./device-flow.js";
import { OAuthError } from "./errors.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  createStateToken,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  type LoopbackServer,
  startLoopbackServer,
} from "./pkce.js";
import {
  exchangeSecondStageCredential,
  getOAuthProviderConfig,
  type OAuthProviderConfig,
  requireOAuthProviderConfig,
} from "./providers.js";
import {
  DEFAULT_EXPIRY_SKEW_MS,
  type OAuthTokenStore,
  type SecondStageExchanger,
  type TokenRefresher,
} from "./store.js";
import { exchangeAuthorizationCode, refreshAccessToken } from "./token.js";
import type { Clock, FetchLike, OAuthTokens, Sleeper } from "./types.js";

export {
  DEFAULT_DEVICE_INTERVAL_SECONDS,
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorization,
  type DeviceFlowConfig,
  type DeviceFlowRuntime,
  type DevicePollOptions,
  pollDeviceToken,
  requestDeviceAuthorization,
  SLOW_DOWN_INCREMENT_SECONDS,
} from "./device-flow.js";
export {
  OAuthError,
  type OAuthErrorCode,
  REDACTED,
  redactSecrets,
  summarizeBody,
} from "./errors.js";
export { type AuthHeaderOptions, oauthAuthHeaders } from "./headers.js";
export {
  type AuthorizationUrlParams,
  base64UrlEncode,
  buildAuthorizationUrl,
  type CallbackResult,
  computeS256Challenge,
  createCodeVerifier,
  createPkcePair,
  createStateToken,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  LOOPBACK_HOST,
  type LoopbackServer,
  type LoopbackServerOptions,
  type PkcePair,
  splitCodeAndState,
  startLoopbackServer,
  statesMatch,
} from "./pkce.js";
export {
  ANTHROPIC_OAUTH_PROVIDER,
  applyOAuthEnvOverrides,
  configureOAuthProvider,
  exchangeSecondStageCredential,
  GITHUB_COPILOT_PROVIDER,
  getOAuthProviderConfig,
  listOAuthProviders,
  OAUTH_CONSTANTS,
  OAUTH_ENV_PREFIX,
  type OAuthFlowKind,
  type OAuthProviderConfig,
  OPENAI_CODEX_PROVIDER,
  registerOAuthProvider,
  requireOAuthProviderConfig,
  resetOAuthProviders,
  type SecondStageConfig,
} from "./providers.js";
export {
  ANTHROPIC_OAUTH_PROVIDER_ID,
  type ResolvedAuth,
  registerAnthropicOAuthProvider,
  registerOAuthProviderFactories,
} from "./register.js";
export {
  AUTH_DIR_MODE,
  AUTH_FILE_MODE,
  BaseOAuthTokenStore,
  DEFAULT_EXPIRY_SKEW_MS,
  defaultAuthDirectory,
  FileOAuthTokenStore,
  type FileOAuthTokenStoreOptions,
  isExpiring,
  MemoryOAuthTokenStore,
  mergeRefreshedTokens,
  type OAuthTokenStore,
  providerFileName,
  type SecondStageExchanger,
  type TokenRefresher,
  type ValidAccessTokenOptions,
} from "./store.js";
export {
  type AuthorizationCodeExchange,
  exchangeAuthorizationCode,
  type OAuthRequest,
  type OAuthRequestRuntime,
  type OAuthResponseBody,
  oauthErrorFrom,
  parseOAuthBody,
  postOAuthRequest,
  type RefreshGrant,
  refreshAccessToken,
  type TokenRequestFormat,
  toEpochMs,
  toOAuthTokens,
} from "./token.js";
export type {
  Clock,
  DerivedCredential,
  FetchLike,
  HttpRequestInit,
  HttpResponse,
  OAuthRuntime,
  OAuthTokens,
  Sleeper,
} from "./types.js";
export { defaultClock, defaultSleep, globalFetch } from "./types.js";

/** Injected dependencies shared by the login helpers and the resolver. */
export interface OAuthDependencies {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Defaults to `Date.now`. */
  now?: Clock;
  /** Defaults to a `setTimeout` sleeper. */
  sleep?: Sleeper;
  /** Cancels the flow. */
  signal?: AbortSignal;
}

/** Options for {@link createAccessTokenResolver}. */
export interface AccessTokenResolverOptions extends OAuthDependencies {
  /** Expiry skew. Defaults to {@link DEFAULT_EXPIRY_SKEW_MS}. */
  skewMs?: number;
  /**
   * Renders the command that signs a provider in, used in the "not signed in"
   * error. Defaults to `arcturn auth login <provider>`.
   */
  loginCommand?: (provider: ProviderId) => string;
  /** Use this configuration instead of the registered one. */
  config?: OAuthProviderConfig;
}

function defaultLoginCommand(provider: ProviderId): string {
  return `arcturn auth login ${String(provider)}`;
}

/** Build the refresher for a provider, or `undefined` when it has no OAuth config. */
function refresherFor(
  config: OAuthProviderConfig | undefined,
  deps: OAuthDependencies,
): TokenRefresher | undefined {
  if (!config) return undefined;
  return (provider, current) =>
    refreshAccessToken(
      {
        tokenEndpoint: config.tokenEndpoint,
        clientId: config.clientId,
        previous: current,
        provider: String(provider),
        ...(config.tokenRequestFormat !== undefined ? { format: config.tokenRequestFormat } : {}),
        ...(config.tokenParams !== undefined ? { extraParams: config.tokenParams } : {}),
        ...(config.tokenHeaders !== undefined ? { headers: config.tokenHeaders } : {}),
      },
      {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
}

/** Build the stage-2 exchanger, or `undefined` for single-stage providers. */
function exchangerFor(
  config: OAuthProviderConfig | undefined,
  deps: OAuthDependencies,
): SecondStageExchanger | undefined {
  const secondStage = config?.secondStage;
  if (!secondStage) return undefined;
  return (provider, current) =>
    exchangeSecondStageCredential(secondStage, current.accessToken, {
      provider: String(provider),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
}

/**
 * Rephrase "nothing stored" / "token expired" as something a user can act on.
 *
 * The message names the exact command to run and the API-key alternative, so a
 * failure mid-stream is self-explanatory. Every other failure keeps the
 * provider's own (already redacted) wording.
 */
function toActionableError(
  provider: ProviderId,
  error: unknown,
  loginCommand: (provider: ProviderId) => string,
): unknown {
  if (!(error instanceof OAuthError)) return error;
  if (error.code !== "arcturn_no_credentials" && error.code !== "arcturn_token_expired") {
    return error.toAIErrorException();
  }
  const envVar = DEFAULT_API_KEY_ENV[String(provider)];
  const alternative = envVar ? ` Alternatively set ${envVar} to use an API key.` : "";
  const lead =
    error.code === "arcturn_no_credentials"
      ? `Not signed in to ${provider}.`
      : `The stored ${provider} credentials have expired and could not be renewed.`;
  return new OAuthError(
    error.code,
    `${lead} Run \`${loginCommand(provider)}\` to sign in.${alternative}`,
    { provider: String(provider) },
  ).toAIErrorException();
}

/**
 * Build the `getAccessToken` callback `createClient` expects.
 *
 * Resolution per call: read the store, refresh the stage-1 token when it is
 * expired or inside the skew window, mint or reuse the stage-2 token for
 * two-stage providers, and return the token to put in the `Authorization`
 * header. Concurrent calls for one provider share a single refresh.
 *
 * @param store - Where credentials live.
 * @param options - Injected clock/fetch, skew and the login command to name in
 *   errors.
 * @returns A resolver matching `CreateClientOptions.getAccessToken`.
 */
export function createAccessTokenResolver(
  store: OAuthTokenStore,
  options: AccessTokenResolverOptions = {},
): (provider: ProviderId) => Promise<string> {
  const loginCommand = options.loginCommand ?? defaultLoginCommand;

  return async (provider: ProviderId): Promise<string> => {
    const config = options.config ?? getOAuthProviderConfig(provider);
    const refresh = refresherFor(config, options);
    const exchange = exchangerFor(config, options);
    try {
      return await store.getValidAccessToken(provider, {
        skewMs: options.skewMs ?? DEFAULT_EXPIRY_SKEW_MS,
        ...(refresh ? { refresh } : {}),
        ...(exchange ? { exchange } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (error) {
      throw toActionableError(provider, error, loginCommand);
    }
  };
}

/** Options shared by both login flows. */
export interface BeginLoginOptions extends OAuthDependencies {
  /** Persist the tokens here when the login completes. */
  store?: OAuthTokenStore;
  /** Use this configuration instead of the registered one. */
  config?: OAuthProviderConfig;
  /** Override the requested scopes. */
  scopes?: readonly string[];
  /** How long the loopback listener waits. Defaults to five minutes. */
  timeoutMs?: number;
  /** Body of the browser page shown after a successful PKCE login. */
  successHtml?: string;
  /** Called before each device-flow poll, for a spinner or a countdown. */
  onPoll?: (info: { attempt: number; intervalSeconds: number }) => void;
}

/** Fields common to every login session. */
interface LoginSessionBase {
  provider: ProviderId;
  /** Finish the login: exchange or poll, persist, and return the tokens. */
  complete(): Promise<OAuthTokens>;
  /** Abandon the login and release the loopback port, if any. */
  cancel(): Promise<void>;
}

/** A browser-based authorization-code login awaiting its redirect. */
export interface PkceLoginSession extends LoginSessionBase {
  flow: "pkce";
  /** The URL the user must open. Present it; do not assume a browser exists. */
  authorizationUrl: string;
  /** The loopback redirect URI registered in the request. */
  redirectUri: string;
  /** The CSRF `state`; exposed for diagnostics only. */
  state: string;
}

/** A device-code login awaiting user approval. */
export interface DeviceLoginSession extends LoginSessionBase {
  flow: "device";
  /** URL the user opens on any device. */
  verificationUri: string;
  /** URL with the code pre-filled, when offered. */
  verificationUriComplete?: string;
  /** The code the user types. */
  userCode: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds between polls, before any `slow_down`. */
  interval: number;
}

/** Whatever {@link beginLogin} started, discriminated by `flow`. */
export type LoginSession = PkceLoginSession | DeviceLoginSession;

async function persist(
  store: OAuthTokenStore | undefined,
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<void> {
  if (store) await store.set(provider, tokens);
}

/**
 * Run the stage-2 exchange at login time, so a broken Copilot seat is reported
 * during `login` rather than on the first model call. The stage-1 token is
 * already persisted when this runs, so a failure here never costs the user
 * their sign-in.
 */
async function attachSecondStage(
  config: OAuthProviderConfig,
  tokens: OAuthTokens,
  deps: OAuthDependencies,
): Promise<OAuthTokens> {
  if (!config.secondStage) return tokens;
  const derived = await exchangeSecondStageCredential(config.secondStage, tokens.accessToken, {
    provider: String(config.provider),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  return { ...tokens, derived };
}

async function beginPkceLogin(
  config: OAuthProviderConfig,
  options: BeginLoginOptions,
): Promise<PkceLoginSession> {
  if (!config.authorizationEndpoint) {
    throw new OAuthError(
      "arcturn_bad_response",
      `${config.provider} is configured for PKCE but has no authorizationEndpoint`,
      { provider: String(config.provider) },
    );
  }

  const pkce = createPkcePair();
  const state = createStateToken();
  const server: LoopbackServer = await startLoopbackServer({
    state,
    port: config.redirectPort ?? 0,
    path: config.redirectPath ?? "/callback",
    timeoutMs: options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
    ...(options.successHtml !== undefined ? { successHtml: options.successHtml } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: config.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri: server.redirectUri,
    state,
    codeChallenge: pkce.challenge,
    scopes: options.scopes ?? config.scopes,
    ...(config.authorizationParams !== undefined
      ? { extraParams: config.authorizationParams }
      : {}),
  });

  return {
    flow: "pkce",
    provider: config.provider,
    authorizationUrl,
    redirectUri: server.redirectUri,
    state,
    async complete(): Promise<OAuthTokens> {
      const callback = await server.waitForCallback();
      const granted = await exchangeAuthorizationCode(
        {
          tokenEndpoint: config.tokenEndpoint,
          clientId: config.clientId,
          code: callback.code,
          codeVerifier: pkce.verifier,
          redirectUri: server.redirectUri,
          state: callback.state,
          provider: String(config.provider),
          ...(config.tokenRequestFormat !== undefined ? { format: config.tokenRequestFormat } : {}),
          ...(config.tokenParams !== undefined ? { extraParams: config.tokenParams } : {}),
          ...(config.tokenHeaders !== undefined ? { headers: config.tokenHeaders } : {}),
        },
        {
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      await persist(options.store, config.provider, granted);
      const withDerived = await attachSecondStage(config, granted, options);
      if (withDerived !== granted) await persist(options.store, config.provider, withDerived);
      return withDerived;
    },
    cancel: () => server.close(),
  };
}

async function beginDeviceLogin(
  config: OAuthProviderConfig,
  options: BeginLoginOptions,
): Promise<DeviceLoginSession> {
  if (!config.deviceAuthorizationEndpoint) {
    throw new OAuthError(
      "arcturn_bad_response",
      `${config.provider} is configured for the device flow but has no deviceAuthorizationEndpoint`,
      { provider: String(config.provider) },
    );
  }

  const flowConfig: DeviceFlowConfig = {
    deviceAuthorizationEndpoint: config.deviceAuthorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint,
    clientId: config.clientId,
    scopes: options.scopes ?? config.scopes,
    provider: String(config.provider),
    ...(config.tokenRequestFormat !== undefined ? { format: config.tokenRequestFormat } : {}),
    ...(config.tokenParams !== undefined ? { extraParams: config.tokenParams } : {}),
    ...(config.tokenHeaders !== undefined ? { headers: config.tokenHeaders } : {}),
  };

  const runtime = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const authorization: DeviceAuthorization = await requestDeviceAuthorization(flowConfig, runtime);

  const session: DeviceLoginSession = {
    flow: "device",
    provider: config.provider,
    verificationUri: authorization.verificationUri,
    userCode: authorization.userCode,
    expiresIn: authorization.expiresIn,
    interval: authorization.interval,
    async complete(): Promise<OAuthTokens> {
      const granted = await pollDeviceToken(
        flowConfig,
        authorization,
        runtime,
        options.onPoll ? { onPoll: options.onPoll } : {},
      );
      await persist(options.store, config.provider, granted);
      const withDerived = await attachSecondStage(config, granted, options);
      if (withDerived !== granted) await persist(options.store, config.provider, withDerived);
      return withDerived;
    },
    // Nothing to release: the device flow holds no local resource.
    cancel: () => Promise.resolve(),
  };
  if (authorization.verificationUriComplete !== undefined) {
    session.verificationUriComplete = authorization.verificationUriComplete;
  }
  return session;
}

/**
 * Start a login for one provider.
 *
 * Returns as soon as there is something to show the user — an authorization URL
 * or a user code — and leaves `complete()` to the caller, so a CLI can render
 * the instructions before blocking. No browser is launched from here.
 *
 * @param provider - `"anthropic"`, `"github-copilot"`, `"openai-codex"`, or any
 *   provider registered through {@link registerOAuthProvider}.
 * @param options - Store to persist into, plus injected dependencies.
 * @returns The pending session, discriminated by `flow`.
 * @throws {OAuthError} When the provider has no OAuth configuration, or the
 *   device authorization request fails.
 */
export async function beginLogin(
  provider: ProviderId,
  options: BeginLoginOptions = {},
): Promise<LoginSession> {
  const config = options.config ?? requireOAuthProviderConfig(provider);
  return config.flow === "device"
    ? beginDeviceLogin(config, options)
    : beginPkceLogin(config, options);
}

/**
 * Forget a provider's stored credentials.
 *
 * Local only: the provider-side grant is not revoked, because no revocation
 * endpoint is verified for any of the built-in providers. Users who want the
 * grant gone must also remove the app from their provider account.
 *
 * @param provider - The provider to sign out of.
 * @param store - The store holding the credentials.
 * @returns `true` when something was removed.
 */
export function logout(provider: ProviderId, store: OAuthTokenStore): Promise<boolean> {
  return store.delete(provider);
}
