# `@arcturn/tools`

The built-in tool set for the [Arcturn](https://arcturn.dev) agent harness: `read`,
`write`, `edit`, `bash`, `grep`, `glob`, `ls`, `fetch`, and `websearch`. Each tool
implements the `Tool` interface from `@arcturn/types`, so they compose with any custom
tools you add.

## What's in it

`src/index.ts` exports:

- `createDefaultTools(options)` — the one-call entry point. Returns `{ tools, read,
  write, edit, bash, grep, glob, ... }`: the full array plus each tool individually.
- Individual factories: `createReadTool`, `createWriteTool`, `createEditTool`,
  `createBashTool`, `createGrepTool`, `createGlobTool`, `createLsTool`,
  `createFetchTool`, `createWebSearchTool`.
- `BackgroundTaskManager` — tracks long-running background `bash` processes.
- Sandbox helpers for the `bash` tool: `resolveSandboxInvocation`,
  `buildSandboxExecProfile` (macOS `sandbox-exec`), `buildBwrapArgv` (Linux
  `bubblewrap`), `defaultSandboxProbe`.
- `resolvePath` — the shared cwd-relative path resolution every tool uses.

Every tool resolves relative paths against `ToolExecutionContext.cwd` at execution time,
not at construction time.

## Install

Arcturn is not yet published to npm. Until it is, use it from a clone of the monorepo as
a pnpm workspace package:

```bash
git clone https://github.com/sitharaj88/arcturn.git && cd arcturn
pnpm install && pnpm -r build
```

Then depend on it from another workspace package: `"@arcturn/tools": "workspace:*"`.

## Usage

```ts
import { createDefaultTools } from "@arcturn/tools";
import { createAgent } from "@arcturn/core";
import { createClient, requireModel } from "@arcturn/ai";

const llm = createClient();
const { tools } = createDefaultTools({ cwd: process.cwd() });

const agent = createAgent({
  llm,
  model: requireModel("anthropic/claude-sonnet-4-5"),
  systemPrompt: "You are a focused, careful coding agent.",
  tools,
  cwd: process.cwd(),
});
```

Mix in your own tools or MCP-bridged tools freely — the model sees no difference:
`createAgent({ llm, model, tools: [...tools, ...myCustomTools], cwd })`.

## Docs

- [Custom tools](https://arcturn.dev/docs/sdk-tools) — the `Tool` interface, a worked example, and how permissions gate `execute`.
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
