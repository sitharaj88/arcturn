/**
 * Authorization-code flow with PKCE (RFC 7636) over a loopback redirect
 * (RFC 8252 §7.3).
 *
 * The browser is never launched from here: {@link beginPkceAuthorization}
 * returns the URL and lets the caller decide how to present it (open it, print
 * it, show a QR code). That keeps this module free of platform shelling and
 * makes the whole flow testable.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthError } from "./errors.js";

/** Loopback host mandated by RFC 8252: never `localhost`, which can resolve off-box. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Default time a login may sit unanswered before the server gives up. */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

/** A PKCE verifier and its S256 challenge. */
export interface PkcePair {
  /** The high-entropy secret, sent only to the token endpoint. */
  verifier: string;
  /** `BASE64URL(SHA256(verifier))`, sent in the authorization request. */
  challenge: string;
  /** Always `"S256"`; the `plain` method is deliberately not supported. */
  method: "S256";
}

/** Base64url encoding (RFC 4648 §5) without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Generate a PKCE code verifier.
 *
 * @param byteLength - Entropy in bytes; 32 yields the 43-character verifier
 *   RFC 7636 §4.1 recommends. Must produce 43–128 characters.
 */
export function createCodeVerifier(byteLength = 32): string {
  if (byteLength < 32 || byteLength > 96) {
    throw new RangeError("PKCE verifier entropy must be between 32 and 96 bytes");
  }
  return base64UrlEncode(randomBytes(byteLength));
}

/**
 * Compute the S256 code challenge for a verifier.
 *
 * @param verifier - The code verifier, ASCII per RFC 7636 §4.1.
 * @returns `BASE64URL(SHA256(ASCII(verifier)))`.
 */
export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Generate a verifier plus its challenge. */
export function createPkcePair(byteLength = 32): PkcePair {
  const verifier = createCodeVerifier(byteLength);
  return { verifier, challenge: computeS256Challenge(verifier), method: "S256" };
}

/**
 * Generate an opaque `state` value.
 *
 * `state` is the CSRF defence for the redirect: the value handed to the
 * provider must come back unchanged, otherwise the callback was forged.
 */
export function createStateToken(byteLength = 32): string {
  return base64UrlEncode(randomBytes(byteLength));
}

/**
 * Constant-time comparison of two `state` values.
 *
 * Length differences short-circuit (they leak nothing an attacker cannot see
 * from the URL they crafted); equal-length values are compared without an
 * early exit.
 */
export function statesMatch(expected: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Parameters for {@link buildAuthorizationUrl}. */
export interface AuthorizationUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
  /** Provider-specific extras (`code`, `prompt`, `audience`, …). */
  extraParams?: Readonly<Record<string, string>>;
}

/**
 * Build the URL the user visits to approve the login.
 *
 * @returns An absolute URL carrying `response_type=code` and the S256 challenge.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.authorizationEndpoint);
  const query = url.searchParams;
  query.set("response_type", "code");
  query.set("client_id", params.clientId);
  query.set("redirect_uri", params.redirectUri);
  query.set("state", params.state);
  query.set("code_challenge", params.codeChallenge);
  query.set("code_challenge_method", "S256");
  if (params.scopes && params.scopes.length > 0) query.set("scope", params.scopes.join(" "));
  for (const [key, value] of Object.entries(params.extraParams ?? {})) query.set(key, value);
  return url.toString();
}

/** What the provider sent back to the loopback redirect. */
export interface CallbackResult {
  /** The authorization code, ready for the token exchange. */
  code: string;
  /** The `state` echoed by the provider; already verified against the expected value. */
  state: string;
}

/** Options for {@link startLoopbackServer}. */
export interface LoopbackServerOptions {
  /** The `state` the callback must echo. */
  state: string;
  /** Port to bind. `0` (the default) picks an ephemeral port. */
  port?: number;
  /** Redirect path. Defaults to `/callback`. */
  path?: string;
  /** How long to wait for the callback. Defaults to five minutes. */
  timeoutMs?: number;
  /** Body of the page shown in the browser after a successful login. */
  successHtml?: string;
  /** Aborts the wait (Ctrl-C from a CLI). */
  signal?: AbortSignal;
}

/** A running loopback redirect listener. */
export interface LoopbackServer {
  /** The redirect URI to register in the authorization request. */
  readonly redirectUri: string;
  /** The bound port; useful when an ephemeral port was requested. */
  readonly port: number;
  /**
   * Resolves with the verified callback parameters.
   *
   * Repeated calls return the same promise. Rejects with an {@link OAuthError}
   * on `arcturn_state_mismatch`, `arcturn_timeout`, `arcturn_cancelled` or the provider's
   * own error code.
   */
  waitForCallback(): Promise<CallbackResult>;
  /** Stop listening. Idempotent, and safe to call after the promise settles. */
  close(): Promise<void>;
}

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem">
<h1>Signed in</h1><p>You can close this tab and return to your terminal.</p>
</body></html>`;

const FAILURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem">
<h1>Sign-in failed</h1><p>Return to your terminal for details.</p>
</body></html>`;

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The page is static and self-contained; forbid everything else.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(html);
}

/**
 * Split Anthropic's `code#state` callback form.
 *
 * Some providers append the state to the code with a `#` separator instead of
 * sending a separate `state` query parameter. Splitting here means the caller
 * never has to know which shape arrived.
 */
export function splitCodeAndState(rawCode: string): { code: string; state?: string } {
  const hash = rawCode.indexOf("#");
  if (hash < 0) return { code: rawCode };
  const code = rawCode.slice(0, hash);
  const state = rawCode.slice(hash + 1);
  return state === "" ? { code } : { code, state };
}

/**
 * Bind a one-shot loopback redirect listener.
 *
 * @param options - The expected `state`, plus port/path/timeout overrides.
 * @returns The listener, its redirect URI and the promise for the callback.
 */
export async function startLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const path = options.path ?? "/callback";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const successHtml = options.successHtml ?? DEFAULT_SUCCESS_HTML;

  let settle: ((result: CallbackResult) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let settled = false;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Nothing may observe the rejection until `waitForCallback` is called; attach
  // a no-op handler so an early failure is never an unhandled rejection.
  result.catch(() => undefined);

  const resolveOnce = (value: CallbackResult): void => {
    if (settled) return;
    settled = true;
    settle?.(value);
  };
  const rejectOnce = (error: Error): void => {
    if (settled) return;
    settled = true;
    fail?.(error);
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== path) {
      // Browsers probe /favicon.ico; answering 404 must not end the flow.
      sendHtml(response, 404, FAILURE_HTML);
      return;
    }

    const query = url.searchParams;
    const errorCode = query.get("error");
    if (errorCode) {
      sendHtml(response, 400, FAILURE_HTML);
      const description = query.get("error_description") ?? "";
      rejectOnce(
        new OAuthError(errorCode, description === "" ? errorCode : `${errorCode}: ${description}`),
      );
      return;
    }

    const rawCode = query.get("code");
    if (!rawCode) {
      sendHtml(response, 400, FAILURE_HTML);
      rejectOnce(
        new OAuthError("arcturn_bad_response", "Authorization callback carried no code parameter"),
      );
      return;
    }

    const split = splitCodeAndState(rawCode);
    const state = query.get("state") ?? split.state;
    if (!statesMatch(options.state, state ?? undefined)) {
      // CSRF defence: a callback whose state does not match was not started by
      // us, so the code is never exchanged.
      sendHtml(response, 400, FAILURE_HTML);
      rejectOnce(
        new OAuthError(
          "arcturn_state_mismatch",
          "Authorization callback state did not match; the login was discarded",
        ),
      );
      return;
    }

    sendHtml(response, 200, successHtml);
    resolveOnce({ code: split.code, state: options.state });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? 0;
  const redirectUri = `http://${LOOPBACK_HOST}:${port}${path}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // Kill idle keep-alive sockets, otherwise `close` waits for the browser.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  function onAbort(): void {
    rejectOnce(new OAuthError("arcturn_cancelled", "The login was cancelled"));
  }

  const timer = setTimeout(() => {
    rejectOnce(
      new OAuthError(
        "arcturn_timeout",
        `Timed out after ${timeoutMs}ms waiting for the authorization callback`,
      ),
    );
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  // The listener is one-shot: whichever way the promise settles, stop listening.
  const finished = result.then(
    async (value) => {
      await close();
      return value;
    },
    async (error: unknown) => {
      await close();
      throw error;
    },
  );
  finished.catch(() => undefined);

  return {
    redirectUri,
    port,
    waitForCallback: () => finished,
    close,
  };
}
