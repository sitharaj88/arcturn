# Providers, presets and `arcturn auth` — implementation notes

How the new `@arcturn/ai` surface (Bedrock, Vertex, Azure, the OpenAI Responses API, the 35 named
presets and OAuth subscription auth) is exposed through the CLI. Nothing outside `packages/cli/`
was modified.

## What was added

| File | Change |
| --- | --- |
| `src/paths.ts` | New `auth` path: `~/.arcturn/auth` (honours `ARCTURN_HOME`). |
| `src/args.ts` | `--list-providers`, plus positional `auth login/logout/status` parsing. |
| `src/auth.ts` | **New.** `runAuthCommand` and the status/expiry rendering. |
| `src/runtime.ts` | `registerBundledCatalog()`, `formatProviderCatalog()`, OAuth-aware `resolveModelSpec`, `getAccessToken` wired into `createClient`. |
| `src/main.ts` | Dispatches `--list-providers` and the `auth` command. |
| `src/index.ts` | Re-exports the new public surface. |

## Nothing was missing from `@arcturn/ai`

Every symbol needed is reachable from the package root:

- `registerPresetModels`, `listPresets`, `presetSpec`, `PROVIDER_PRESETS` — named exports.
- `listProviderIds`, `DEFAULT_API_KEY_ENV`, `getModel`, `registerModel` — named exports.
- `registerOAuthProviderFactories`, `registerAnthropicOAuthProvider` — named exports.
- Everything else OAuth (`beginLogin`, `logout`, `createAccessTokenResolver`,
  `FileOAuthTokenStore`, `MemoryOAuthTokenStore`, `listOAuthProviders`,
  `getOAuthProviderConfig`, `applyOAuthEnvOverrides`, `OAuthError`, `OAUTH_CONSTANTS`,
  `ANTHROPIC_OAUTH_PROVIDER_ID`, and the `OAuthTokens` / `LoginSession` / `BeginLoginOptions`
  types) — through the namespace export `export * as oauth from "./oauth/index.js"`, used here as
  `import { oauth } from "@arcturn/ai"` with `oauth.Foo` in both value and type position.

Two things would be *nicer*, neither is a blocker:

1. `oauth` being a namespace means every reference is qualified (`oauth.OAuthTokenStore`). Flat
   re-exports of at least `OAuthTokenStore`, `OAuthTokens` and `beginLogin` would read better at
   call sites.
2. `PresetListing` carries no `baseUrl` or `docsUrl`, so `--list-providers` cannot show the endpoint
   a preset resolves to without reaching into `PROVIDER_PRESETS` directly. Adding both to
   `PresetListing` would let the listing stay on the display-ready API.

## Decisions

### Preset models are registered by the CLI, not by importing `@arcturn/ai`

`registerPresetModels()` mutates the shared catalog, so it must run **before** any model id is
resolved and before any listing is rendered. `registerBundledCatalog()` in `src/runtime.ts` does it
once per process (returning `false` on later calls) and is called from `buildRuntime` *and* from the
`--list-models` / `--list-providers` branch in `main.ts` — the same reason extensions load before a
listing is printed: the list must enumerate exactly what `--model` accepts.

It also registers the OAuth-only adapters (`github-copilot`, `openai-codex`, `anthropic-oauth`),
which `@arcturn/ai` deliberately leaves out of `registerBuiltinProviders()` because they always
fail a precheck without a token. With `getAccessToken` now always wired, that precheck passes as
soon as the user has signed in, so registering them unconditionally is correct here.

### `resolveModelSpec` no longer demands an API key from OAuth-only providers

The pre-flight key check is skipped when the provider has an OAuth configuration **and** no default
API-key environment variable (`github-copilot`, `openai-codex`), or is `anthropic-oauth`. Providers
that accept either credential — `anthropic` — keep the check, so "you have no key and no token"
still fails at startup with the variable named rather than mid-stream.

### `auth` is a positional command with deliberately narrow recognition

Only the first positional **before `--`** can start a command, so `arcturn -- auth login x` and
`arcturn "auth login is broken"` remain prompts. When a command is recognised the prompt is cleared and
the `--print`-needs-a-prompt / `--resume`-vs-`--continue` checks are skipped; `--help` and
`--version` still win because `main` handles them first. The provider name is validated at parse
time against `oauth.listOAuthProviders()`, so a typo exits `2` before any config, extension or
network work happens.

### Login never opens a browser

`beginLogin` returns as soon as there is something to show. The CLI prints the authorization URL
(PKCE) or the verification URI plus user code (device flow) and then awaits `complete()`, which
works over SSH and in a container. `SIGINT` aborts an `AbortController` passed into the flow, so
`Ctrl+C` releases the loopback port, cancels the session and exits `130` with nothing written.
An external `signal` (the programmatic path) replaces the `SIGINT` handler rather than adding to it.

### Status prints no token material

`collectAuthStatus` reads only presence, `expiresAt` and the provider's registered metadata; the
rendered row is `<provider> <state> <displayName> (<flow>) · <expiry>`. A test asserts that neither
the access nor the refresh token — nor the strings `sk-`, `rt-`, `access token` or `refresh` —
appears anywhere in the output.

### The unverified-endpoints caveat prints once, always

Every `arcturn auth` invocation ends with `UNVERIFIED_ENDPOINTS_NOTE`, including failures (a stale
endpoint is the likeliest cause of one). `--list-providers` carries a one-line version of the same
warning. `applyOAuthEnvOverrides(env)` runs at the start of every auth command and inside
`buildRuntime`, so a `ARCTURN_OAUTH_*` correction takes effect with no code change.

## Known gaps

- **No `/auth` slash command.** Sign-in is a terminal-blocking flow that wants the whole screen, so
  it stayed out of the TUI. `/model` still works with an OAuth-backed model once signed in.
- **No revocation.** `logout` deletes the local file only; `@arcturn/ai` verifies no revocation
  endpoint for any provider. The message says so.
- **Preset models are curated, not exhaustive.** ~21 models across 11 presets are registered; the
  other 24 presets are reachable but carry no pre-registered model. `--model <preset>/<model>` only
  resolves for ids in the catalog, so reaching an unlisted model still needs an extension calling
  `presetSpec(preset, model, { register: true })`. A `--model-from-preset` flag, or resolving an
  unknown `<preset>/<model>` id through `presetSpec` on demand, would close that gap; it was left
  out because it would silently accept typos as valid model names.
- **Cloudflare presets need substitution.** `cloudflare-workers-ai` and `cloudflare-ai-gateway` have
  `{account_id}`/`{gateway_id}` placeholders in their base URLs; the listing shows them verbatim and
  the CLI offers no way to fill them in.
