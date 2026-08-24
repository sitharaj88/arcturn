/**
 * OAuth building blocks for `@arcturn/ai`.
 *
 * What lives here is the provider-agnostic half of an authorization-code flow:
 * PKCE (RFC 7636) and the one-shot loopback redirect listener RFC 8252 §7.3
 * requires. There is no provider table, no client id and no endpoint URL in
 * this package — those belong to whoever runs the flow.
 *
 * The one caller in this repository is `arcturn mcp auth`, which authorizes a
 * remote MCP server: the MCP SDK discovers the authorization server (RFC 8414)
 * and registers a client dynamically (RFC 7591), and this module supplies the
 * `state` value and the listener the redirect comes back to.
 *
 * ```ts
 * import { oauth } from "@arcturn/ai";
 *
 * const state = oauth.createStateToken();
 * const listener = await oauth.startLoopbackServer({ state });
 * // … send the user to an authorization URL carrying `listener.redirectUri` …
 * const { code } = await listener.waitForCallback();
 * await listener.close();
 * ```
 *
 * Arcturn has no subscription sign-in of its own: signing in with a Claude,
 * ChatGPT or Copilot plan needs an OAuth client id that each provider issues to
 * its own product, and Arcturn has none. API keys are the supported path.
 */

export { OAuthError, type OAuthErrorCode, REDACTED, redactSecrets } from "./errors.js";
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
