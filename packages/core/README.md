# `@arcturn/core`

The [Arcturn](https://arcturn.dev) agent runtime: event loop, sessions, compaction,
permissions, and sub-agents. This is the SDK — `@arcturn/core` is what the `arcturn`
CLI is built on, just without a terminal in front of it.

## What's in it

`src/index.ts` exports, among others:

- `Agent` / `createAgent` — one agent per session; `createAgent` wires up a
  `JsonlSessionStore` when you pass `sessionDir`. `runLoop` is the underlying event loop.
- `PermissionEngine`, `matchRules`, `matchSpecifier`, `globToRegExp`, `DEFAULT_*_TOOLS`,
  plus the path-comparison policy they use (`defaultCaseInsensitivePaths`, `isPathLike`)
  — path specifiers are matched with either separator and folded to the filesystem's own
  case rules, commands and URLs verbatim.
- `compactMessages`, `shouldCompact`, `estimateTokens` — compaction helpers.
- `JsonlSessionStore`, `MemorySessionStore`, and session-tree helpers (`buildTree`,
  `materializeBranch`, `pathToLeaf`, ...).
- `createPlanTool`, `createTodoTool`, `createSubagentTool` — built-in state/delegation
  tools, plus content helpers (`userMessage`, `toolResultMessage`, `contentText`, ...).

Everything is provider-agnostic: `Agent` takes an injected `LLMClient` (from
`@arcturn/types`), a tool list, and optional session/permission/compaction wiring.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/core": "workspace:*"`.

## Usage

```ts
import { createAgent } from "@arcturn/core";
import { createClient, requireModel } from "@arcturn/ai";
import { createDefaultTools } from "@arcturn/tools";

const llm = createClient(); // resolves API keys from the environment
const { tools } = createDefaultTools({ cwd: process.cwd() });

const agent = createAgent({
  llm,
  model: requireModel("anthropic/claude-sonnet-4-5"),
  systemPrompt: "You are a focused, careful coding agent.",
  tools,
  cwd: process.cwd(),
  sessionDir: ".arcturn/sessions", // omit for an unpersisted, in-memory agent
  permissions: { mode: "default" },
});

await agent.prompt("Add input validation to the signup handler");
console.log(agent.finalText());
```

`agent.prompt()` resolves once the model stops calling tools, is aborted, or errors — it
never rejects on a runtime failure; subscribe to its event stream to observe failures.

## Docs

- [Embedding with the SDK](https://arcturn.dev/docs/sdk) — mental model and package overview.
- [Agent options](https://arcturn.dev/docs/sdk-agent-options) / [Events](https://arcturn.dev/docs/sdk-events) / [Permissions](https://arcturn.dev/docs/sdk-permissions) / [Sessions](https://arcturn.dev/docs/sdk-sessions)
- [Advanced: sub-agents, MCP, VCR, hooks](https://arcturn.dev/docs/sdk-advanced)

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
