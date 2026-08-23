# `@arcturn/mcp`

> **Internal to the arcturn CLI. Published so `arcturn` resolves; its API may change in any release without a major version bump.** Embedders should depend on [`@arcturn/core`](https://www.npmjs.com/package/@arcturn/core) and [`@arcturn/ai`](https://www.npmjs.com/package/@arcturn/ai), whose surfaces are the ones the SDK documents.

Model Context Protocol client bridge for the [Arcturn](https://arcturn.dev) agent
harness. `McpManager` connects to a set of configured servers and bridges their tools
into ordinary `Tool[]` from `@arcturn/types` — the model sees no difference between an
MCP tool and a built-in one.

## What's in it

`src/index.ts` exports:

- `McpManager`, `McpManagerOptions` — connects to configured servers, exposes
  `.tools()`, `.status()`, `.connect()`, `.close()`, and change events
  (`McpToolsChangedEvent`, `McpResourcesChangedEvent`, `McpPromptsChangedEvent`,
  `McpResourceUpdatedEvent`).
- `loadMcpConfig`, `McpConfigError` — reads and validates an MCP config file.
- `McpToolBridge`, `mcpToolFullName`, `sanitizeMcpName`, `toolResultFromMcp` — the
  lower-level bridge from an MCP tool definition to a `Tool`.
- `listResources`, `readResource`, `listPrompts`, `getPrompt`, `listResourceTemplates` —
  the rest of MCP beyond tools.
- OAuth support: `McpOAuthProvider`, `createMcpOAuthState`, `McpAuthRequiredError`,
  `isMcpAuthRequiredError`, `MemoryMcpOAuthStorage`, `DEFAULT_MCP_REDIRECT_URL`.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/mcp": "workspace:*"`.

## Usage

```ts
import { loadMcpConfig, McpManager } from "@arcturn/mcp";
import { createAgent } from "@arcturn/core";

const config = await loadMcpConfig([".arcturn/mcp.json"]);
const manager = new McpManager(config);
await manager.connect(); // connects every configured server concurrently

const mcpTools = manager.tools(); // Tool[] — concatenate with your other tools
const agent = createAgent({ /* ...base options */ tools: [...mcpTools] });

manager.onToolsChanged((event) => {
  // A server's tool list changed live — rebuild the agent's tool set to match.
  agent.setTools([...mcpTools, ...manager.tools()]);
});
```

Per-server failures are isolated — one bad server never prevents the others from
connecting. `manager.status()` reports each server's connection state
(`"disconnected" | "connecting" | "connected" | "failed"`) plus a `toolCount` or
`error`. Call `manager.close()` to tear every connection down.

## Docs

- [Advanced: sub-agents, MCP, VCR, hooks](https://arcturn.dev/docs/sdk-advanced) — the full MCP client usage section.
- [MCP](https://arcturn.dev/docs/mcp) — the config file schema `loadMcpConfig` reads.
- [Embedding with the SDK](https://arcturn.dev/docs/sdk) — how this fits with `@arcturn/core`.

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
