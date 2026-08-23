/**
 * Shared contracts for the OAuth subsystem.
 *
 * Everything here is hand-rolled on top of `fetch`, `node:crypto` and
 * `node:http` — the subsystem pulls in no OAuth library. The injectable
 * {@link FetchLike}, {@link Clock} and {@link Sleeper} seams exist so the whole
 * subsystem can be exercised without a network, a real clock or a real timer.
 */

/** Milliseconds since the Unix epoch, as produced by `Date.now`. */
export type Clock = () => number;

/** Suspends for `ms`; injected so polling loops run instantly under test. */
export type Sleeper = (ms: number) => Promise<void>;

/** The subset of the global `Response` this subsystem reads. */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The subset of `RequestInit` this subsystem sends. */
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Structural view of the global `fetch`.
 *
 * Deliberately narrower than the DOM signature so tests can supply a plain
 * function without constructing `Headers`/`Request` objects.
 */
export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** Dependencies every network-touching OAuth helper accepts. */
export interface OAuthRuntime {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Defaults to `Date.now`. */
  now?: Clock;
  /** Defaults to a `setTimeout`-backed sleeper. */
  sleep?: Sleeper;
  /** Cancels an in-flight flow. */
  signal?: AbortSignal;
}

/**
 * A short-lived credential minted from a stored OAuth token.
 *
 * GitHub Copilot works this way: the device flow yields a long-lived GitHub
 * token which must then be exchanged for a Copilot API token that expires
 * within the hour. The stage-1 token is the durable one and lives in
 * {@link OAuthTokens.accessToken}; the stage-2 token lives here and is
 * re-minted on demand.
 */
export interface DerivedCredential {
  /** The token actually sent to the model API. */
  accessToken: string;
  /** Absolute expiry in ms since the epoch, when the provider reported one. */
  expiresAt?: number;
  /** Non-secret provider metadata returned alongside the token (endpoints, flags). */
  metadata?: Record<string, string>;
}

/** One provider's persisted OAuth credentials. */
export interface OAuthTokens {
  /** The stage-1 bearer token. Never log this. */
  accessToken: string;
  /** Present when the provider issued one; used to renew `accessToken`. */
  refreshToken?: string;
  /** Absolute expiry in ms since the epoch. Absent means "no known expiry". */
  expiresAt?: number;
  /** Scopes the provider actually granted, when it reported them. */
  scopes?: string[];
  /** Usually `"Bearer"`. Kept verbatim so odd providers round-trip. */
  tokenType: string;
  /** Stage-2 credential for two-stage providers such as GitHub Copilot. */
  derived?: DerivedCredential;
  /** Non-secret provider metadata (account id, API endpoint overrides). */
  metadata?: Record<string, string>;
}

/** Default clock/sleeper, resolved once so tests can override per call. */
export const defaultClock: Clock = () => Date.now();

/** Promise-returning `setTimeout`. The timer is unref'd so it never holds the process open. */
export const defaultSleep: Sleeper = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // `unref` exists on Node timers but not on the DOM's numeric handle.
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * The ambient `fetch`, as a {@link FetchLike}.
 *
 * @throws When the runtime has no global `fetch` (Node < 18 without a polyfill).
 */
export function globalFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new Error("No global fetch available; pass a `fetch` implementation explicitly");
  }
  return candidate as FetchLike;
}
