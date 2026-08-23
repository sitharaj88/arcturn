# OAuth subsystem — implementation notes

Everything lives under `packages/ai/src/oauth/`. No existing file was modified,
no dependency was added, and no package outside `@arcturn/ai` was touched.

- `types.ts` — shared contracts (`OAuthTokens`, `DerivedCredential`, `FetchLike`,
  `Clock`, `Sleeper`) and the injectable defaults.
- `errors.ts` — `OAuthError` plus `redactSecrets` / `summarizeBody`.
- `token.ts` — token-endpoint plumbing: request encoding, response parsing,
  authorization-code exchange, refresh grant.
- `store.ts` — `OAuthTokenStore`, `FileOAuthTokenStore` (0600/0700),
  `MemoryOAuthTokenStore`, and the shared `getValidAccessToken`.
- `pkce.ts` — S256 PKCE, `state`, and the loopback redirect listener.
- `device-flow.ts` — RFC 8628 device authorization grant.
- `providers.ts` — the provider config registry and the constants block.
- `headers.ts` — resolved token → API auth headers.
- `register.ts` — optional `ProviderFactory` registrations for the OAuth-only
  backends.
- `index.ts` — `createAccessTokenResolver`, `beginLogin`, `logout`, and the
  public re-exports.

---

## 1. Constants that MUST be verified against live provider docs before release

Every one of these is in the single block at the top of
`src/oauth/providers.ts` (`OAUTH_CONSTANTS`). They are public values — client
ids for native/desktop apps and endpoint URLs, per RFC 8252 §8.5 — and **no
client secret is embedded anywhere**. But this package was built offline and
none of them could be checked, and provider endpoints do rotate. Verify each
against the provider's current developer documentation:

### github-copilot

| Constant | Value | What to check |
| --- | --- | --- |
| `clientId` | `Iv1.b507a08c87ecfe98` | GitHub's public editor-integration client id |
| `deviceAuthorizationEndpoint` | `https://github.com/login/device/code` | RFC 8628 endpoint |
| `tokenEndpoint` | `https://github.com/login/oauth/access_token` | device-grant token endpoint |
| `scopes` | `["read:user"]` | minimum scope Copilot accepts |
| `apiTokenEndpoint` | `https://api.github.com/copilot_internal/v2/token` | **highest risk** — internal API, most likely to move |
| `integrationId` | `vscode-chat` | accepted `Copilot-Integration-Id` values |
| `editorVersion` / `editorPluginVersion` | `Arcturn/0.1.0`, `arcturn/0.1.0` | whether Copilot rejects unknown editor identifiers |
| `apiBaseUrl` | `https://api.githubcopilot.com` | default chat base URL (stage-2 `endpoints.api` overrides it) |

### anthropic

| Constant | Value | What to check |
| --- | --- | --- |
| `clientId` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | public client id for the subscription flow |
| `authorizationEndpoint` | `https://claude.ai/oauth/authorize` | consent screen |
| `tokenEndpoint` | `https://console.anthropic.com/v1/oauth/token` | code + refresh grants |
| `scopes` | `org:create_api_key user:profile user:inference` | which are actually required |
| `tokenRequestFormat` | `"json"` | whether the endpoint wants JSON or standard form encoding — flip to `"form"` if wrong |
| `betaHeader` | `oauth-2025-04-20` | the `anthropic-beta` token that enables bearer auth |
| `apiVersion` | `2023-06-01` | current `anthropic-version` |

### openai-codex

| Constant | Value | What to check |
| --- | --- | --- |
| `clientId` | `app_EMoamEEZ73f0CkXaXp7hrann` | public client id for the ChatGPT sign-in |
| `authorizationEndpoint` | `https://auth.openai.com/oauth/authorize` | consent screen |
| `tokenEndpoint` | `https://auth.openai.com/oauth/token` | code + refresh grants |
| `scopes` | `openid profile email offline_access` | which are required |
| `redirectPort` / `redirectPath` | `1455`, `/auth/callback` | whether an exact loopback redirect is registered (if any port is allowed, set `redirectPort` to `undefined` and the ephemeral default takes over) |
| `apiBaseUrl` | `https://chatgpt.com/backend-api/codex` | **highest risk** — a subscription token is not accepted by `api.openai.com`; expect this to need a per-model `baseUrl` |

**None of these requires a code change to fix.** Two escape hatches exist:

```ts
configureOAuthProvider("anthropic", { tokenEndpoint: "https://…" });
```

and, for zero-code deployment fixes, `applyOAuthEnvOverrides()` reads
`ARCTURN_OAUTH_<PROVIDER>_CLIENT_ID`, `…_AUTHORIZATION_ENDPOINT`, `…_TOKEN_ENDPOINT`,
`…_DEVICE_ENDPOINT` and `…_SCOPES` (provider id upper-cased, non-alphanumerics
becoming `_`, so `github-copilot` → `ARCTURN_OAUTH_GITHUB_COPILOT_*`).

## 2. Things I am unsure about beyond the constants

- **Anthropic and `x-api-key`.** The Anthropic SDK sends `x-api-key` whenever it
  was constructed with a key. An OAuth client must be constructed with **no**
  API key, otherwise both credentials go out and the request is likely refused.
  `register.ts` does this (`anthropicAdapter` passes no `apiKey`), but a host
  that wires OAuth headers into `createClient({ headers })` while an
  `ANTHROPIC_API_KEY` is present in the environment will send both.
- **Copilot header conventions.** `Copilot-Integration-Id`, `Editor-Version` and
  `Editor-Plugin-Version` are sent because Copilot is known to require editor
  identification, but the accepted values are unverified.
- **Codex account selection.** Some ChatGPT-subscription endpoints want an
  account/workspace header. `oauthAuthHeaders(provider, token, { extra })` exists
  for that; nothing is sent by default rather than guessing a header name.
- **Revocation.** `logout()` deletes local credentials only. No revocation
  endpoint is verified for any provider, so the provider-side grant survives; the
  JSDoc says so.

## 3. Wiring needed in files I was not allowed to touch

### `src/index.ts` (package entry point)

Nothing is exported from the package root yet. Suggested addition:

```ts
export * from "./oauth/index.js";
```

or, if the root prefers explicit named exports, at minimum:

`beginLogin`, `logout`, `createAccessTokenResolver`, `oauthAuthHeaders`,
`FileOAuthTokenStore`, `MemoryOAuthTokenStore`, `BaseOAuthTokenStore`,
`defaultAuthDirectory`, `OAuthError`, `redactSecrets`,
`listOAuthProviders`, `getOAuthProviderConfig`, `requireOAuthProviderConfig`,
`configureOAuthProvider`, `registerOAuthProvider`, `applyOAuthEnvOverrides`,
`resetOAuthProviders`, `OAUTH_CONSTANTS`, `registerOAuthProviderFactories`,
`registerAnthropicOAuthProvider`, `startLoopbackServer`, `createPkcePair`,
`computeS256Challenge`, `requestDeviceAuthorization`, `pollDeviceToken`,
plus the types `OAuthTokens`, `OAuthTokenStore`, `OAuthProviderConfig`,
`LoginSession`, `PkceLoginSession`, `DeviceLoginSession`,
`AccessTokenResolverOptions`, `BeginLoginOptions`, `DerivedCredential`,
`FetchLike`, `Clock`, `Sleeper`.

A namespaced export (`export * as oauth from "./oauth/index.js"`) would also
work and keeps the root surface small.

### `src/providers/builtins.ts`

Left untouched deliberately. `github-copilot` and `openai-codex` cannot be
dispatched without a token, so registering them unconditionally would add two
providers that always fail a precheck. They are registered on demand by
`registerOAuthProviderFactories()` from `src/oauth/register.ts`; a host that
wants them always available can call it next to `registerBuiltinProviders()`, or
that call can be added inside the builtins OAuth block later.

### CLI (`@arcturn/cli`, not touched)

The subsystem is designed to be driven by three commands:

```ts
const store = new FileOAuthTokenStore();          // ~/.arcturn/auth, 0700/0600
const session = await beginLogin(provider, { store });
// arcturn auth login <provider>
if (session.flow === "pkce") {
  print(`Open: ${session.authorizationUrl}`);      // caller opens the browser
} else {
  print(`Open ${session.verificationUri} and enter ${session.userCode}`);
}
await session.complete();

// arcturn auth logout <provider>
await logout(provider, store);

// arcturn auth status
await store.list();
```

and then `createClient({ getAccessToken: createAccessTokenResolver(store) })`.
The "not signed in" error names `arcturn auth login <provider>`; if the CLI uses
different wording, pass `loginCommand` to `createAccessTokenResolver`.

## 4. Contract friction found against the frozen types

1. **`ProviderFactory` is synchronous, `getAccessToken` is asynchronous.**
   `ProviderFactory = (ctx) => LLMClient` cannot await
   `ctx.getAccessToken(provider)`, but the token has to reach the adapter as a
   constructor-time header. Worked around in `register.ts` by returning a thin
   `LLMClient` that resolves the token inside `stream`/`complete` and caches the
   real adapter against the token value. *Suggested contract change:*
   `ProviderFactory` returning `LLMClient | Promise<LLMClient>`.

2. **`ProviderFactoryContext` has no store handle.** An adapter can obtain a
   token but not the metadata stored beside it — notably Copilot's
   `endpoints.api`, which the stage-2 response reports and which should override
   the base URL. Today that value is persisted as credential metadata and
   ignored by the adapter, which falls back to the constant. *Suggested change:*
   let `getAccessToken` resolve to `{ token, baseUrl?, headers? }`, or add an
   optional `getProviderMetadata`.

3. **`AIError.kind` has no "not signed in" kind.** Missing credentials map onto
   `auth`, which is correct but indistinguishable from "the key was rejected", so
   a caller cannot tell "run the login command" from "your token was revoked"
   without string matching. *Suggested change:* an optional
   `code?: string` on `AIError`.

4. **`ProviderId` is `(string & {})`**, so a typo in a provider id is not a type
   error anywhere in this subsystem. `requireOAuthProviderConfig` compensates at
   runtime by listing the providers that do support OAuth.

5. **`ModelSpec` has `apiKeyEnv` but no auth-mode field.** There is no declared
   way for a spec to say "this model authenticates by OAuth", so the choice is
   encoded in `provider` (`anthropic` vs `anthropic-oauth`). *Suggested change:*
   an optional `auth?: "apiKey" | "oauth"` on `ModelSpec`.

## 5. Security posture

- Credential files are written through a temp file and `rename`, created `0600`
  and `chmod`ed `0600` afterwards (a pre-existing looser file is tightened, and
  `umask` cannot loosen them). The directory is `mkdir`ed `0700` and `chmod`ed
  `0700` on every write.
- No `console.*` call exists anywhere in `src/oauth/`.
- Every message built from a provider response goes through `redactSecrets`,
  which strips `access_token` / `refresh_token` / `id_token` / `device_code` /
  `client_secret` / `code_verifier` / `token` fields (JSON, form and header
  forms), recognisable token shapes (`gh[pousr]_…`, `sk-…`, JWTs) and any
  literal secret the caller passes in. `OAuthError`'s constructor redacts its
  own message, so a redaction cannot be forgotten at a call site.
- `state` is compared with `timingSafeEqual`, and a mismatched callback is
  discarded without exchanging the code.
- PKCE is S256-only; the `plain` method is not implemented.
- The loopback listener binds `127.0.0.1` (never `localhost`, which can resolve
  off-box) and serves a static page with `default-src 'none'`.
