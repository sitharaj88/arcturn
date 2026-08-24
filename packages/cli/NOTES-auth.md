# Providers and presets — implementation notes

How the `@arcturn/ai` provider surface (Bedrock, Vertex, Azure, the OpenAI Responses API and the 35
named presets) is exposed through the CLI.

## Where it lives

| File | Change |
| --- | --- |
| `src/paths.ts` | `auth` path: `~/.arcturn/auth` (honours `ARCTURN_HOME`), used by MCP OAuth. |
| `src/args.ts` | `--list-providers`. |
| `src/runtime.ts` | `registerBundledCatalog()`, `formatProviderCatalog()`, `resolveModelSpec`. |
| `src/main.ts` | Dispatches `--list-providers`. |
| `src/index.ts` | Re-exports the public surface. |

## Nothing was missing from `@arcturn/ai`

Every symbol needed is reachable from the package root:

- `registerPresetModels`, `listPresets`, `presetSpec`, `PROVIDER_PRESETS` — named exports.
- `listProviderIds`, `DEFAULT_API_KEY_ENV`, `getModel`, `registerModel` — named exports.

One thing would be *nicer*, and is not a blocker: `PresetListing` carries no `baseUrl` or
`docsUrl`, so `--list-providers` cannot show the endpoint a preset resolves to without reaching
into `PROVIDER_PRESETS` directly. Adding both to `PresetListing` would let the listing stay on the
display-ready API.

## Decisions

### Preset models are registered by the CLI, not by importing `@arcturn/ai`

`registerPresetModels()` mutates the shared catalog, so it must run **before** any model id is
resolved and before any listing is rendered. `registerBundledCatalog()` in `src/runtime.ts` does it
once per process (returning `false` on later calls) and is called from `buildRuntime` *and* from the
`--list-models` / `--list-providers` branch in `main.ts` — the same reason extensions load before a
listing is printed: the list must enumerate exactly what `--model` accepts.

### Credentials are API keys

Every provider the CLI dispatches to authenticates with an API key resolved from the environment,
or with ambient cloud credentials (Bedrock's AWS provider chain, Vertex's application-default
credentials). `resolveModelSpec` checks the key up front so "you have no key" fails at startup with
the variable named, rather than mid-stream.

An embedder that holds a bearer token another way — an Entra ID token for Azure, say — passes its
own `getAccessToken` to `createClient`; the CLI wires none.

## Removed: subscription (OAuth) sign-in

`arcturn auth login|logout|status` and the `anthropic`, `openai-codex` and `github-copilot` OAuth
provider configurations were removed. They never worked. Each needs an OAuth client id that the
provider issues to its own product, and Arcturn has none — the ids that shipped belonged to other
vendors' CLIs, and no endpoint, scope or token format in that file had ever been checked against a
live provider. API keys are the supported path for a third-party tool.

MCP OAuth (`arcturn mcp auth <name>`, `arcturn mcp logout <name>`) is unaffected and still works:
it discovers the authorization server (RFC 8414) and registers a client dynamically (RFC 7591), so
it needs no hardcoded endpoint and no borrowed client id. It uses `oauth.createStateToken` and
`oauth.startLoopbackServer` from `@arcturn/ai`, which is all that namespace exports now.

## Known gaps

- **Preset models are curated, not exhaustive.** ~21 models across 11 presets are registered; the
  other 24 presets are reachable but carry no pre-registered model. `--model <preset>/<model>` only
  resolves for ids in the catalog, so reaching an unlisted model still needs an extension calling
  `presetSpec(preset, model, { register: true })`. A `--model-from-preset` flag, or resolving an
  unknown `<preset>/<model>` id through `presetSpec` on demand, would close that gap; it was left
  out because it would silently accept typos as valid model names.
- **Cloudflare presets need substitution.** `cloudflare-workers-ai` and `cloudflare-ai-gateway` have
  `{account_id}`/`{gateway_id}` placeholders in their base URLs; the listing shows them verbatim and
  the CLI offers no way to fill them in.
