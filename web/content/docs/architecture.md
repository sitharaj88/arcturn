---
title: Architecture
description: The package map — how types, ai, core, tools, mcp, tui, protocol, server, and cli fit together — plus one turn traced end to end.
section: Reference
order: 11
---

## Monorepo layout

Arcturn is a pnpm workspace, ESM throughout, TypeScript 5.x targeting Node ≥ 20:

```text
packages/
  types      @arcturn/types      Zero-dep shared contracts: messages, events, tools,
                                    permissions, session tree, protocol schemas.
  ai         @arcturn/ai         Unified LLM layer over official provider SDKs
                                    (Anthropic, OpenAI, Google, Bedrock, Vertex);
                                    streaming, tool calls, thinking, model catalog, cost.
  core       @arcturn/core       Agent runtime: event loop, steering/abort, session
                                    store (JSONL tree, branching), compaction, hooks,
                                    permission engine, sub-agents, state tools. This
                                    is the SDK.
  tools      @arcturn/tools      Built-ins: read, write, edit, bash (+background),
                                    grep, glob, ls, fetch, websearch.
  index      @arcturn/index      Token-optimized code index and hybrid (BM25 +
                                    structural + PageRank) search, used for repo maps.
  mcp        @arcturn/mcp        MCP client integration (official SDK) → Arcturn tools.
  tui        @arcturn/tui        Terminal UI lib: differential renderer, components,
                                    markdown, input editor, autocomplete.
  protocol   @arcturn/protocol   JSON-RPC-style wire protocol for server mode.
  server     @arcturn/server     WebSocket/HTTP server exposing sessions remotely.
  cli        arcturn (bin: arcturn)  Interactive coding agent: TUI app, print/JSON modes,
                                    extensions, skills, themes, config, plan mode, LSP.
  evals      @arcturn/evals      Evaluation harness for scoring agent runs.
website/                           This site — Astro + Tailwind landing page and docs.
```

## Dependency flow

Read from each package's own `package.json`:

```text
types    ← (zero-dep — everyone else's shared contracts)
ai       ← types
core     ← types
tools    ← types              (+ tinyglobby)
index    ← types
mcp      ← types              (+ @modelcontextprotocol/sdk)
protocol ← types
tui      ← (zero-dep on @arcturn/* — a standalone terminal UI lib)
server   ← types, protocol, core
cli      ← types, ai, core, index, mcp, protocol, server, tools, tui
evals    ← types, ai, core, arcturn (the cli package)
```

`@arcturn/types` is the load-bearing package: zero runtime dependencies, just the
shared contracts — `Message`, `AgentEvent`, `Tool`, `PermissionRule`, `SessionEntry`,
`ModelSpec`, the protocol's `ClientRequest`/`ServerMessage` — that every other package
codes against. Nothing downstream of it needs to know how another package is
implemented, only what shape it produces and consumes.

`@arcturn/core` depends only on `types` — it has no idea `tools`, `mcp`, `ai`, or `tui`
exist as concrete packages; it takes an `LLMClient` and a `Tool[]` as injected
interfaces. Tools, MCP-bridged tools, and the terminal UI are all just consumers of
`core`'s public surface (`Agent`, `AgentEvent`, `Tool`), assembled together by whoever's
embedding it — the `cli` package, your own SDK usage, or `server`. `cli` is the one
package that depends on nearly everything: it's the composition root.

## Why it's shaped this way

- **The runtime never imports a provider SDK.** `Agent` takes an injected `LLMClient`
  from `@arcturn/ai`; core has no `import "@anthropic-ai/sdk"` anywhere. Swap providers,
  mock the client in tests, or add a new one entirely without touching the runtime.
- **The runtime never imports a UI.** Every observable thing — streaming tokens, tool
  progress, permission prompts, todo/plan changes, sub-agent activity — is one
  `AgentEvent` union. The TUI renders it to a terminal; the server re-emits it over a
  WebSocket; your own app can render it however it wants. It's the same stream in every
  case, described once in `@arcturn/types`.
- **Sessions are a tree, not a log.** `SessionEntry.parentId` makes branching a
  structural property of storage instead of a feature bolted onto a linear transcript —
  see [Sessions](/docs/sessions).
- **Everything minimal harnesses call "an extension you write yourself" is a package, not
  a pattern.** MCP, sub-agents, permissions, and plan/todo state are shipped, tested
  packages with their own contracts in `types`, not documentation telling you how to
  build them.

## How the CLI composes the runtime

`packages/cli` is glue, not logic: it builds the pieces `@arcturn/core` needs and hands
them to `createAgent`.

1. **Config** (`config.ts`) — load and merge `~/.arcturn/config.json` and
   `<cwd>/.arcturn/config.json` into an `ArcturnConfig`. See
   [Configuration](/docs/configuration).
2. **Tools** (`@arcturn/tools`'s `createDefaultTools`) — the nine built-ins, plus
   MCP-bridged tools from any configured server, plus `todo`/`plan` from `@arcturn/core`.
   If `lsp: "on"`, `write`/`edit` are wrapped with LSP diagnostics
   ([LSP diagnostics](/docs/lsp)); if `verify` is set, they're wrapped with the verify
   loop too.
3. **LLM client** (`@arcturn/ai`) — resolve the configured model id to a `ModelSpec` and
   build the matching provider client, with API keys or OAuth credentials from the
   environment or `~/.arcturn/auth/`.
4. **Agent** (`@arcturn/core`'s `createAgent`) — wire config, tools, and the LLM client
   into one `Agent`, with a `JsonlSessionStore` rooted at
   `~/.arcturn/sessions/<hash-of-cwd>/`.
5. **Front end** — the TUI subscribes to `agent.subscribe(listener)` and renders every
   `AgentEvent`; `-p`/`--print` mode does the same but writes text or NDJSON to stdout
   instead (see [Getting started](/docs/getting-started#non-interactive-use)); `serve`
   mode re-emits the same events over a WebSocket via `@arcturn/protocol`.

Nothing in step 4 or in `@arcturn/core` knows which of those front ends is listening —
that's the point of the event stream being the entire interface.

## One turn, traced end to end

What actually happens between typing a prompt and seeing a result, for a prompt that
edits a file:

1. **Prompt submission.** The TUI (or `-p`) calls `agent.prompt(text)`. `@`-mentions in
   the text are expanded first — file content appended, images attached — see
   [@-mentions & images](/docs/mentions). The agent emits `runStart`, appends a
   `UserMessage` to the conversation, and persists it as a session entry.
2. **Compaction check.** Before calling the model, the agent checks whether the
   conversation is close to the context window and, if so, compacts older history into a
   summary first (`compactionStart`/`compactionEnd` events) — see
   [Sessions](/docs/sessions#compaction).
3. **Model call.** The loop (`runLoop` in `@arcturn/core`) streams a turn from the
   injected `LLMClient`, emitting incremental `text`/`thinking`/tool-call delta events as
   they arrive so the TUI can render tokens live.
4. **Tool call dispatch.** When the model's turn includes a tool call (say, `edit`), the
   loop resolves lifecycle hooks first (`preToolUse` — can block the call outright), emits
   `toolStart`, then validates the tool's arguments against its JSON Schema.
5. **Permission gate.** The loop computes a `subject` for the call (for `edit`, the file
   path) and asks the `PermissionEngine` to `check()` it. Resolution order: tools in
   `alwaysAllowTools` (`todo`, `plan`) pass silently; `plan` mode denies anything outside
   the read-only tools (`read`, `grep`, `glob`, `ls`); stored rules are matched
   session > project > user, most-specific first; read-only tools are allowed outright;
   `yolo` allows everything and `acceptEdits` auto-allows `write`/`edit`/`multiedit`;
   anything still unresolved is asked via the injected `PermissionPrompt` — which is what
   actually shows the TUI's permission prompt, or auto-denies in `-p` mode. See
   [Permissions](/docs/permissions) for the full rule schema and mode table.
6. **Tool execution.** If allowed, the loop builds a `ToolExecutionContext` (`cwd`,
   abort `signal`, a scoped `requestPermission` the tool can call again for finer-grained
   decisions, an `onUpdate` progress sink, `sessionId`, `toolCallId`) and calls
   `tool.execute(input, ctx)`. `edit` itself makes the actual file write here, having
   already computed and validated the replacement. If `lsp`/`verify` wrapped the tool,
   diagnostics or a check-command failure are appended to the result now — see
   [LSP diagnostics](/docs/lsp) and [Configuration](/docs/configuration#verify).
7. **Result and events.** `postToolUse` hooks run, the loop emits `toolEnd` with the full
   `ToolResultMessage`, and the result is appended to the conversation as a tool-result
   message and persisted as a session entry.
8. **Repeat or finish.** The loop keeps streaming turns — feeding tool results back to the
   model, dispatching further tool calls — until the model responds without a tool call,
   `maxTurns` is hit, the run is aborted, or an unrecoverable error occurs. It then emits
   `runEnd` with the reason.
9. **Render and persist.** Every event along the way was already streamed to whichever
   front end subscribed — the TUI updates its differential-rendered transcript live, `-p
   --output-format json` had already written each event as an NDJSON line, `serve` had
   already forwarded each one over the WebSocket. Nothing is buffered and replayed after
   the fact; the render and the run happen concurrently, driven by the same
   `AgentEvent` stream. The full turn is now durable in the session's JSONL file, ready
   for `-c`/`--resume`, `arcturn replay`, `arcturn blame`, or `arcturn audit`.

## Engineering standards

- ESM only, `NodeNext` module resolution, `strict` TypeScript, no `any` in public APIs.
- Vitest for tests — every package ships unit tests alongside its source.
- Biome for lint and format.
- Apache-2.0 license.
