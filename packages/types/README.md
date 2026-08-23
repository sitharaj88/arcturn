# `@arcturn/types`

Shared type contracts for the [Arcturn](https://arcturn.dev) agent harness. This package
ships **type declarations only** — no runtime code, no dependencies. Every other Arcturn
package (and any SDK consumer) imports these types instead of redefining them.

## What's in it

`src/index.ts` re-exports everything from:

- `ai.js` — provider-facing message/content types used by the LLM client.
- `events.js` — the `AgentEvent` union the agent loop streams.
- `mcp.js` — Model Context Protocol wire types.
- `messages.js` — `Message`, tool call/result content, and related shapes.
- `models.js` — `ModelSpec`, `ModelCapabilities`, `ProviderId`.
- `permissions.js` — permission rule and decision types.
- `protocol.js` — types shared with `@arcturn/protocol`'s wire format, including
  `PROTOCOL_VERSION`.
- `session.js` — `SessionStore` and session-tree types.
- `tools.js` — the `Tool`, `ToolDefinition`, `ToolExecutionContext`, and `ToolResult`
  interfaces every tool implements.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/types": "workspace:*"`.

## Usage

```ts
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";

const echo: Tool = {
  name: "echo",
  description: "Echo the input text back.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute(input: { text: string }, _ctx: ToolExecutionContext): Promise<ToolResult> {
    return { content: [{ type: "text", text: input.text }] };
  },
};
```

## Docs

- [Custom tools](https://arcturn.dev/docs/sdk-tools) — the full `Tool` interface, worked
  example, and error handling.
- [Embedding with the SDK](https://arcturn.dev/docs/sdk) — how this package fits with
  `@arcturn/core`, `@arcturn/ai`, `@arcturn/tools`, and `@arcturn/mcp`.

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
