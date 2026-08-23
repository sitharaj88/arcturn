/**
 * Turning a resolved OAuth token into the headers a provider's API expects.
 *
 * Both the Anthropic and OpenAI adapters accept a `headers` bag that is merged
 * into every request (`AnthropicProviderOptions.headers`,
 * `OpenAIProviderOptions.headers`), so this is the whole integration surface:
 * resolve a token, build headers, hand them to the adapter.
 *
 * Confidence is *not* uniform across these headers, and the uncertain parts are
 * called out rather than guessed silently:
 * - Anthropic: `Authorization: Bearer …` plus `anthropic-beta` and
 *   `anthropic-version` — the beta token's exact value is UNVERIFIED, and the
 *   Anthropic SDK also sends `x-api-key` when it was constructed with a key, so
 *   an OAuth client must be built with **no** API key (see NOTES-oauth.md).
 * - GitHub Copilot: bearer token plus `copilot-integration-id` and
 *   `editor-version`. The accepted values for those two are UNVERIFIED.
 * - OpenAI Codex: a plain bearer token. Whether an account-selection header is
 *   additionally required is UNVERIFIED.
 */

import type { ProviderId } from "@arcturn/types";
import { getOAuthProviderConfig, type OAuthProviderConfig } from "./providers.js";

/** Options for {@link oauthAuthHeaders}. */
export interface AuthHeaderOptions {
  /** Use this configuration instead of the registered one. */
  config?: OAuthProviderConfig;
  /** Headers merged in after the provider's, taking precedence. */
  extra?: Readonly<Record<string, string>>;
}

/**
 * Build the request headers that authenticate an API call with `token`.
 *
 * Falls back to a bare `Authorization: Bearer` for providers with no OAuth
 * configuration, which is correct for the large majority of OAuth-protected
 * APIs and is never wrong in a dangerous way.
 *
 * @param provider - Provider id the token belongs to.
 * @param token - The resolved access token (the stage-2 token for Copilot).
 * @param options - Configuration override and extra headers.
 * @returns Lowercase header names mapped to values, ready to merge into
 *   `CreateClientOptions.headers` or a provider adapter's `headers`.
 */
export function oauthAuthHeaders(
  provider: ProviderId,
  token: string,
  options: AuthHeaderOptions = {},
): Record<string, string> {
  const config = options.config ?? getOAuthProviderConfig(provider);
  const base = config ? config.apiHeaders(token) : { authorization: `Bearer ${token}` };
  return { ...base, ...options.extra };
}
