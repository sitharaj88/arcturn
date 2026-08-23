/**
 * Device authorization grant (RFC 8628).
 *
 * Two steps the caller drives separately: ask for a user code, show it, then
 * poll. Splitting them is what lets a CLI print the code and the URL *before*
 * the (potentially minutes-long) poll begins.
 */

import { OAuthError } from "./errors.js";
import {
  type OAuthRequestRuntime,
  oauthErrorFrom,
  postOAuthRequest,
  type TokenRequestFormat,
  toOAuthTokens,
} from "./token.js";
import type { Clock, OAuthTokens, Sleeper } from "./types.js";
import { defaultClock, defaultSleep } from "./types.js";

/** The `grant_type` for a device-code token request (RFC 8628 §3.4). */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Polling interval assumed when the provider omits `interval` (RFC 8628 §3.2). */
export const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;

/** Extra seconds added to the interval on `slow_down` (RFC 8628 §3.5). */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** What the device authorization endpoint returned, for display to the user. */
export interface DeviceAuthorization {
  /** Secret handle used when polling. Never show or log this. */
  deviceCode: string;
  /** Short code the user types, e.g. `WDJB-MJHT`. */
  userCode: string;
  /** URL the user opens to enter the code. */
  verificationUri: string;
  /** URL with the code pre-filled, when the provider offers one. */
  verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Seconds to wait between polls. */
  interval: number;
}

/** Endpoint details for a device flow. */
export interface DeviceFlowConfig {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes?: readonly string[];
  format?: TokenRequestFormat;
  headers?: Readonly<Record<string, string>>;
  extraParams?: Readonly<Record<string, string>>;
  provider?: string;
}

/** Injected clock, sleeper, fetch and abort signal for a device flow. */
export interface DeviceFlowRuntime extends OAuthRequestRuntime {
  now?: Clock;
  sleep?: Sleeper;
}

function requireString(
  body: Record<string, unknown>,
  key: string,
  provider: string | undefined,
): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new OAuthError(
      "arcturn_bad_response",
      `Device authorization response is missing "${key}"`,
      provider !== undefined ? { provider } : {},
    );
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Request a device code and a user code (RFC 8628 §3.1–3.2).
 *
 * @param config - Endpoints, client id and scopes.
 * @param runtime - Injected fetch/abort signal.
 * @returns The codes and the URL to display, plus the polling parameters.
 * @throws {OAuthError} When the provider rejects the request or omits a
 *   mandatory field.
 */
export async function requestDeviceAuthorization(
  config: DeviceFlowConfig,
  runtime: DeviceFlowRuntime = {},
): Promise<DeviceAuthorization> {
  const params: Record<string, string> = {
    client_id: config.clientId,
    ...config.extraParams,
  };
  if (config.scopes && config.scopes.length > 0) params.scope = config.scopes.join(" ");

  const { body, status, ok } = await postOAuthRequest(
    {
      url: config.deviceAuthorizationEndpoint,
      params,
      ...(config.format !== undefined ? { format: config.format } : {}),
      ...(config.headers !== undefined ? { headers: { ...config.headers } } : {}),
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
    },
    runtime,
  );

  const error = oauthErrorFrom(body, {
    status,
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
  });
  if (error) throw error;
  if (!ok) {
    throw new OAuthError(
      "arcturn_http_error",
      `Device authorization request failed with HTTP ${status}`,
      { status, ...(config.provider !== undefined ? { provider: config.provider } : {}) },
    );
  }

  const authorization: DeviceAuthorization = {
    deviceCode: requireString(body, "device_code", config.provider),
    userCode: requireString(body, "user_code", config.provider),
    verificationUri: requireString(body, "verification_uri", config.provider),
    expiresIn: optionalNumber(body, "expires_in") ?? 900,
    interval: Math.max(1, optionalNumber(body, "interval") ?? DEFAULT_DEVICE_INTERVAL_SECONDS),
  };
  const complete = body.verification_uri_complete;
  if (typeof complete === "string" && complete !== "") {
    authorization.verificationUriComplete = complete;
  }
  return authorization;
}

/** Options for {@link pollDeviceToken}. */
export interface DevicePollOptions {
  /** Called before each poll with the interval about to be honoured, in seconds. */
  onPoll?: (info: { attempt: number; intervalSeconds: number }) => void;
  /** Hard cap on attempts, as a guard against a provider that never terminates. */
  maxAttempts?: number;
}

/**
 * Poll the token endpoint until the user approves (RFC 8628 §3.4–3.5).
 *
 * The RFC's error handling is implemented exactly:
 * - `authorization_pending` — keep waiting at the current interval.
 * - `slow_down` — add five seconds to the interval, then keep waiting.
 * - `expired_token` — the user took too long; fail.
 * - `access_denied` — the user refused; fail.
 * - anything else — fail with the provider's code.
 *
 * The first poll happens *after* one interval, since the user cannot possibly
 * have approved before the code was shown.
 *
 * @param config - The same config used for {@link requestDeviceAuthorization}.
 * @param authorization - The device authorization being polled.
 * @param runtime - Injected fetch, clock and sleeper; no real timers are needed.
 * @param options - Poll callback and attempt cap.
 * @returns The granted tokens.
 * @throws {OAuthError} `expired_token`, `access_denied`, or the provider's code.
 */
export async function pollDeviceToken(
  config: DeviceFlowConfig,
  authorization: DeviceAuthorization,
  runtime: DeviceFlowRuntime = {},
  options: DevicePollOptions = {},
): Promise<OAuthTokens> {
  const now = runtime.now ?? defaultClock;
  const sleep = runtime.sleep ?? defaultSleep;
  const deadline = now() + authorization.expiresIn * 1000;
  const maxAttempts = options.maxAttempts ?? 1_000;

  let intervalSeconds = Math.max(1, authorization.interval);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (runtime.signal?.aborted) {
      throw new OAuthError("arcturn_cancelled", "The device login was cancelled", {
        ...(config.provider !== undefined ? { provider: config.provider } : {}),
      });
    }

    options.onPoll?.({ attempt, intervalSeconds });
    await sleep(intervalSeconds * 1000);

    if (now() > deadline) {
      throw new OAuthError(
        "expired_token",
        `The device code for ${config.provider ?? "this provider"} expired before it was approved`,
        { ...(config.provider !== undefined ? { provider: config.provider } : {}) },
      );
    }

    const { body, status, ok } = await postOAuthRequest(
      {
        url: config.tokenEndpoint,
        params: {
          grant_type: DEVICE_CODE_GRANT_TYPE,
          client_id: config.clientId,
          device_code: authorization.deviceCode,
          ...config.extraParams,
        },
        ...(config.format !== undefined ? { format: config.format } : {}),
        ...(config.headers !== undefined ? { headers: { ...config.headers } } : {}),
        ...(config.provider !== undefined ? { provider: config.provider } : {}),
        secrets: [authorization.deviceCode],
      },
      runtime,
    );

    const errorCode = typeof body.error === "string" ? body.error : undefined;
    if (errorCode === "authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
      continue;
    }

    const error = oauthErrorFrom(body, {
      status,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
    });
    if (error) throw error;
    if (!ok) {
      throw new OAuthError("arcturn_http_error", `Device token poll failed with HTTP ${status}`, {
        status,
        ...(config.provider !== undefined ? { provider: config.provider } : {}),
      });
    }
    return toOAuthTokens(body, { now });
  }

  throw new OAuthError(
    "expired_token",
    `Gave up polling for ${config.provider ?? "this provider"} after ${maxAttempts} attempts`,
    { ...(config.provider !== undefined ? { provider: config.provider } : {}) },
  );
}
