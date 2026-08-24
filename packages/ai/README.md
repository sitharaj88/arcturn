# `@arcturn/ai`

Unified, streaming, multi-provider LLM client for the [Arcturn](https://arcturn.dev)
agent harness. One `stream`/`complete` interface dispatched to whichever provider
adapter a model's `ModelSpec.provider` names — Anthropic, OpenAI, Google, Bedrock,
Vertex, and any OpenAI- or Anthropic-Messages-compatible endpoint via presets.

## What's in it

`src/index.ts` exports, among others:

- `createClient`, `resolveApiKey` — build an `LLMClient` resolving API keys from the
  environment (or your own `env` map).
- `getModel`, `requireModel`, `presetModel`, `listModels`, `registerModel` — the model
  catalog; well-known presets (Groq, DeepSeek, Cerebras, Z.AI, ...) resolve on demand.
- `createFailoverClient`, `streamFailover` — chain models/providers with failover.
- `createConsensusClient`, `compareMessages` — run a prompt across several models.
- `calculateCostUsd`, `addUsage`, `emptyUsage` — token/cost accounting.
- `discoverModels`, `refreshCatalog` — live catalog discovery for OpenAI-compatible
  endpoints; `oauth` (namespace) — PKCE and the loopback redirect listener, used by
  `arcturn mcp auth`. There is no subscription (OAuth) sign-in: that needs a client id
  each provider issues to its own product. Use an API key.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/ai": "workspace:*"`.

## Usage

```ts
import { createClient, requireModel } from "@arcturn/ai";

const client = createClient();
for await (const event of client.stream({
  model: requireModel("anthropic/claude-sonnet-4-5"),
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
})) {
  if (event.type === "textDelta") process.stdout.write(event.delta);
}
```

Every provider preset works with no registration step:

```ts
import { presetModel } from "@arcturn/ai";

const model = presetModel("zai", "glm-4.7"); // Groq, Cerebras, DeepSeek, ... likewise
```

Dispatch failures (an unknown provider, a missing key) surface as a normal terminal
`error` stream event, never a thrown exception.

## Docs

- [Models & providers from the SDK](https://arcturn.dev/docs/sdk-models) — `createClient`
  options, the catalog, presets, failover, and consensus panels in full.
- [Providers](https://arcturn.dev/docs/providers) — the CLI-facing provider list.
- [Embedding with the SDK](https://arcturn.dev/docs/sdk) — how this package fits with
  `@arcturn/core`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Sitharaj Seenivasan.
