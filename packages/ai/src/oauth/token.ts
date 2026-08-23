/**
 * Token endpoint plumbing shared by the PKCE and device flows.
 *
 * One place builds the request, one place parses the response, one place turns
 * an OAuth error body into an {@link OAuthError} — so the flows only decide
 * *which* grant to ask for.
 */

import { OAuthError, redactSecrets, summarizeBody } from "./errors.js";
import type { FetchLike, HttpRequestInit, OAuthTokens } from "./types.js";
import { defaultClock, globalFetch } from "./types.js";

/** How a token request encodes its parameters. */
export type TokenRequestFormat = "form" | "json";

/** A parsed OAuth response body, whatever encoding it arrived in. */
export type OAuthResponseBody = Record<string, unknown>;

/**
 * Parse an OAuth response body.
 *
 * Providers are inconsistent: RFC 6749 mandates JSON, but GitHub returns
 * `application/x-www-form-urlencoded` unless asked otherwise, and some proxies
 * return JSON with a wrong content type. Sniffing the payload handles all
 * three without trusting the header.
 *
 * @param text - The raw response body.
 * @returns The decoded key/value pairs; `{}` for an empty or unparsable body.
 */
export function parseOAuthBody(text: string): OAuthResponseBody {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as OAuthResponseBody;
      }
    } catch {
      // Fall through to the form-encoded reading.
    }
  }
  // Strict `key=value&key=value` shape only: an HTML error page containing an
  // `=` must not be mistaken for a token response.
  if (/^[\w.~%+-]+=[^&\s]*(?:&[\w.~%+-]+=[^&\s]*)*$/.test(trimmed)) {
    const out: OAuthResponseBody = {};
    for (const [key, value] of new URLSearchParams(trimmed)) out[key] = value;
    return out;
  }
  return {};
}

function readString(body: OAuthResponseBody, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(body: OAuthResponseBody, key: string): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Convert an OAuth error payload into an {@link OAuthError}.
 *
 * @returns The error, or `undefined` when the body carries no `error` field.
 */
export function oauthErrorFrom(
  body: OAuthResponseBody,
  context: { status?: number; provider?: string; fallback?: string },
): OAuthError | undefined {
  const code = readString(body, "error");
  if (!code) return undefined;
  const description =
    readString(body, "error_description") ?? readString(body, "message") ?? context.fallback ?? "";
  const suffix = description === "" ? "" : `: ${redactSecrets(description)}`;
  return new OAuthError(code, `${code}${suffix}`, {
    ...(context.status !== undefined ? { status: context.status } : {}),
    ...(context.provider !== undefined ? { provider: context.provider } : {}),
  });
}

/** A POST to an OAuth endpoint, before encoding. */
export interface OAuthRequest {
  url: string;
  params: Record<string, string>;
  /** Defaults to `"form"` (RFC 6749 §4.1.3). */
  format?: TokenRequestFormat;
  headers?: Record<string, string>;
  provider?: string;
  /** Literal secrets to scrub from any error raised for this request. */
  secrets?: readonly string[];
}

/** Injection seams for a single OAuth HTTP call. */
export interface OAuthRequestRuntime {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * POST an OAuth request and return the decoded body.
 *
 * A non-2xx response with a well-formed `error` field is *not* thrown here:
 * the device flow needs to inspect `authorization_pending` and `slow_down`
 * without exception handling. Callers use {@link oauthErrorFrom} to decide.
 * Transport failures and bodies that are neither JSON nor form-encoded do
 * throw, because no caller can make progress from them.
 *
 * @param request - Endpoint, parameters and encoding.
 * @param runtime - Injected fetch and abort signal.
 * @returns The decoded response body and its HTTP status.
 */
export async function postOAuthRequest(
  request: OAuthRequest,
  runtime: OAuthRequestRuntime = {},
): Promise<{ body: OAuthResponseBody; status: number; ok: boolean }> {
  const fetchImpl = runtime.fetch ?? globalFetch();
  const format = request.format ?? "form";
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type":
      format === "json" ? "application/json" : "application/x-www-form-urlencoded;charset=UTF-8",
    ...request.headers,
  };
  const body =
    format === "json"
      ? JSON.stringify(request.params)
      : new URLSearchParams(request.params).toString();

  const init: HttpRequestInit = { method: "POST", headers, body };
  if (runtime.signal) init.signal = runtime.signal;

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(request.url, init);
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const reason = redactSecrets(raw, request.secrets ?? []);
    throw new OAuthError("arcturn_http_error", `Request to ${request.url} failed: ${reason}`, {
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      cause,
    });
  }

  const text = await response.text();
  const parsed = parseOAuthBody(text);
  if (Object.keys(parsed).length === 0 && !response.ok) {
    throw new OAuthError(
      "arcturn_http_error",
      `${request.url} returned HTTP ${response.status}: ${summarizeBody(text, {
        ...(request.secrets ? { secrets: request.secrets } : {}),
      })}`,
      {
        status: response.status,
        ...(request.provider !== undefined ? { provider: request.provider } : {}),
      },
    );
  }
  return { body: parsed, status: response.status, ok: response.ok };
}

/**
 * Read an RFC 6749 §5.1 token response into {@link OAuthTokens}.
 *
 * `expires_in` is resolved against the injected clock immediately, so a token
 * that sat in a queue is not treated as fresher than it is.
 *
 * @param body - The decoded token response.
 * @param options - Clock and the previous tokens, whose refresh token is kept
 *   when the provider omits one (most do, on refresh).
 */
export function toOAuthTokens(
  body: OAuthResponseBody,
  options: { now?: () => number; previous?: OAuthTokens } = {},
): OAuthTokens {
  const now = (options.now ?? defaultClock)();
  const accessToken = readString(body, "access_token");
  if (!accessToken) {
    throw new OAuthError("arcturn_bad_response", "Token response contained no access_token");
  }
  const tokens: OAuthTokens = {
    accessToken,
    tokenType: readString(body, "token_type") ?? "Bearer",
  };

  const refreshToken = readString(body, "refresh_token") ?? options.previous?.refreshToken;
  if (refreshToken) tokens.refreshToken = refreshToken;

  const expiresIn = readNumber(body, "expires_in");
  if (expiresIn !== undefined && expiresIn > 0) {
    tokens.expiresAt = now + Math.floor(expiresIn * 1000);
  } else {
    // Some providers report an absolute epoch-seconds expiry instead.
    const expiresAt = readNumber(body, "expires_at");
    if (expiresAt !== undefined && expiresAt > 0) tokens.expiresAt = toEpochMs(expiresAt);
  }

  const scope = readString(body, "scope");
  if (scope) {
    tokens.scopes = scope.split(/[\s,]+/).filter((entry) => entry !== "");
  } else if (options.previous?.scopes) {
    tokens.scopes = [...options.previous.scopes];
  }

  if (options.previous?.metadata) tokens.metadata = { ...options.previous.metadata };
  return tokens;
}

/**
 * Normalise an expiry that may be in seconds or milliseconds.
 *
 * Values below 1e12 are seconds (year 33658 in ms, but 2001 in seconds), which
 * is the standard heuristic and safe for any realistic token lifetime.
 */
export function toEpochMs(value: number): number {
  return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
}

/** Parameters for an authorization-code exchange. */
export interface AuthorizationCodeExchange {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** Echoed back by providers that bind the code to the `state`. */
  state?: string;
  format?: TokenRequestFormat;
  extraParams?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  provider?: string;
}

/**
 * Trade an authorization code for tokens (RFC 7636 §4.5).
 *
 * @throws {OAuthError} When the provider rejects the code.
 */
export async function exchangeAuthorizationCode(
  exchange: AuthorizationCodeExchange,
  runtime: OAuthRequestRuntime & { now?: () => number } = {},
): Promise<OAuthTokens> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: exchange.clientId,
    code: exchange.code,
    redirect_uri: exchange.redirectUri,
    code_verifier: exchange.codeVerifier,
    ...exchange.extraParams,
  };
  if (exchange.state !== undefined) params.state = exchange.state;

  const { body, status, ok } = await postOAuthRequest(
    {
      url: exchange.tokenEndpoint,
      params,
      ...(exchange.format !== undefined ? { format: exchange.format } : {}),
      ...(exchange.headers !== undefined ? { headers: { ...exchange.headers } } : {}),
      ...(exchange.provider !== undefined ? { provider: exchange.provider } : {}),
      secrets: [exchange.code, exchange.codeVerifier],
    },
    runtime,
  );

  const error = oauthErrorFrom(body, {
    status,
    ...(exchange.provider !== undefined ? { provider: exchange.provider } : {}),
  });
  if (error) throw error;
  if (!ok) {
    throw new OAuthError("arcturn_http_error", `Token exchange failed with HTTP ${status}`, {
      status,
      ...(exchange.provider !== undefined ? { provider: exchange.provider } : {}),
    });
  }
  return toOAuthTokens(body, runtime.now ? { now: runtime.now } : {});
}

/** Parameters for a refresh-token grant. */
export interface RefreshGrant {
  tokenEndpoint: string;
  clientId: string;
  previous: OAuthTokens;
  format?: TokenRequestFormat;
  extraParams?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  provider?: string;
  scopes?: readonly string[];
}

/**
 * Renew an access token (RFC 6749 §6).
 *
 * @throws {OAuthError} `arcturn_refresh_failed` when no refresh token is stored, or
 *   the provider's own error code when it refuses the grant. The failure is
 *   surfaced rather than swallowed: the caller must be able to tell the user to
 *   log in again.
 */
export async function refreshAccessToken(
  grant: RefreshGrant,
  runtime: OAuthRequestRuntime & { now?: () => number } = {},
): Promise<OAuthTokens> {
  const refreshToken = grant.previous.refreshToken;
  if (!refreshToken) {
    throw new OAuthError(
      "arcturn_refresh_failed",
      `No refresh token stored for ${grant.provider ?? "this provider"}; sign in again`,
      grant.provider !== undefined ? { provider: grant.provider } : {},
    );
  }

  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: grant.clientId,
    refresh_token: refreshToken,
    ...grant.extraParams,
  };
  if (grant.scopes && grant.scopes.length > 0) params.scope = grant.scopes.join(" ");

  const { body, status, ok } = await postOAuthRequest(
    {
      url: grant.tokenEndpoint,
      params,
      ...(grant.format !== undefined ? { format: grant.format } : {}),
      ...(grant.headers !== undefined ? { headers: { ...grant.headers } } : {}),
      ...(grant.provider !== undefined ? { provider: grant.provider } : {}),
      secrets: [refreshToken],
    },
    runtime,
  );

  const error = oauthErrorFrom(body, {
    status,
    ...(grant.provider !== undefined ? { provider: grant.provider } : {}),
  });
  if (error) throw error;
  if (!ok) {
    throw new OAuthError("arcturn_refresh_failed", `Token refresh failed with HTTP ${status}`, {
      status,
      ...(grant.provider !== undefined ? { provider: grant.provider } : {}),
    });
  }
  return toOAuthTokens(body, {
    ...(runtime.now ? { now: runtime.now } : {}),
    previous: grant.previous,
  });
}
