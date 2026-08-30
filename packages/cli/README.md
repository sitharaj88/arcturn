# arcturn

**Every turn counts.** The interactive coding agent of the [Arcturn](../../README.md)
harness — a minimal core, plus MCP, sub-agents, permission prompts, plan mode, todos and
background processes.

`arcturn` is the flagship package: it composes `@arcturn/core` (the runtime),
`@arcturn/ai` (providers), `@arcturn/tools` (built-ins), `@arcturn/mcp` (MCP client) and
`@arcturn/tui` (terminal UI) into the `arcturn` binary.

```bash
pnpm add -g arcturn      # or: pnpm --filter arcturn build && node packages/cli/dist/main.js
export ANTHROPIC_API_KEY=sk-ant-...
arcturn
```

---

## Usage

```
arcturn [options] [prompt...]        start the interactive TUI
arcturn -p "prompt" [options]        run once, print the answer, exit
```

```bash
arcturn                                        # interactive, empty prompt
arcturn "add tests for src/parser.ts"          # interactive, starts with this prompt
arcturn -p "what does src/index.ts export?"    # non-interactive, prints the answer
arcturn -p "list the TODOs" --output-format json | jq -c 'select(.type=="toolStart")'
arcturn --continue "now write the tests"       # resume the newest session here
arcturn --model openai/gpt-5.1 --permission-mode acceptEdits
```

### Flags

| Flag | Description |
| --- | --- |
| `-p`, `--print` | Non-interactive: run to completion, print the final assistant message to stdout, exit `0`/`1`. |
| `--output-format <fmt>` | With `--print`: `text` (default) or `json` — every `AgentEvent` as NDJSON on stdout. |
| `-m`, `--model <id>` | Model to use. See `--list-models`. Accepts a catalog id (`anthropic/claude-opus-4-5`) or an unambiguous wire name (`claude-opus-4-5`). |
| `-c`, `--continue` | Resume the most recent session started in this directory. |
| `-r`, `--resume <sessionId>` | Resume a specific session. |
| `--permission-mode <mode>` | `default` · `acceptEdits` · `plan` · `yolo`. |
| `--cwd <dir>` | Working directory for tools, project config and session bucketing. |
| `--no-mcp` | Do not start any configured MCP servers. |
| `--max-turns <n>` | End a run after `n` model turns. |
| `--list-models` | Print the model catalog and exit. |
| `--list-providers` | Print every registered provider and every named preset endpoint (with its API-key variable and whether it is set), then exit. |
| `-h`, `--help` · `-v`, `--version` | Usage / version. |

Long flags accept both `--model x` and `--model=x`. Everything after `--` is prompt text.

### Commands

`arcturn --help` lists every positional command (`completions`, `replay`, `audit`, `blame`,
`bisect`, `serve`, `acp`, `attach`, `mcp …`, and the package verbs).

A command is recognised only as the **first word before `--`**, so `arcturn -- replay abc` and
`arcturn "replay is broken"` are still prompts. `--help` and `--version` win over any command.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (or the interactive session was closed). |
| `1` | The run ended with `reason: "error"` or was aborted. |
| `2` | Usage error, unknown/unusable model, or `stdout` is not a TTY without `--print`. |

### Permission modes

| Mode | Behaviour |
| --- | --- |
| `default` | Read-only tools run freely; anything that changes state asks first. |
| `acceptEdits` | File edits are auto-approved; shell commands still ask. |
| `plan` | Nothing mutating runs until a plan is presented and approved. |
| `yolo` | Everything is approved. Use in a container, not on your laptop. |

In `--print` mode there is nobody to ask, so any prompt that reaches the user is **denied** with an
explanation the model can act on, and a one-line hint goes to stderr. Pick a mode or add rules.

---

## Providers

`arcturn --list-providers` is the discovery surface: it prints every registered adapter, every named
preset endpoint — with the environment variable that holds its key and a `✓`/`✗` for whether that
variable is set **right now**.

### Adapters

`Verified` records whether the adapter has been driven against the provider's real
endpoint — streaming, a tool call answered on a second turn, and cost accounting — not
merely unit-tested. See [Model providers](https://arcturn.dev/docs/providers) for why that
distinction is called out.

| Provider id | Backend | Credentials | Verified |
| --- | --- | --- | --- |
| `anthropic` | Claude, Messages API | `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | ✅ Haiku 4.5 |
| `openai` · `openai-responses` | Chat Completions / the Responses API | `OPENAI_API_KEY` | ✅ GPT-5 nano, both surfaces |
| `google` | Gemini | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) | ✅ Gemini 3.5 Flash Lite |
| `openai-compatible` · `anthropic-compatible` | Any endpoint speaking either wire format | whatever the spec's `apiKeyEnv` names | ✅ both — Z.AI GLM and a canonical Messages API |
| `azure` | Azure OpenAI deployments | `AZURE_OPENAI_API_KEY` | ⚠️ not yet |
| `bedrock` | AWS Bedrock | ambient AWS credentials (profile, role, env) | ⚠️ not yet |
| `vertex` | Google Vertex AI | ambient Google application-default credentials | ⚠️ not yet |

### Presets

A **preset** is a remembered `{ base URL, API key variable, wire protocol }` triple for a well-known
endpoint, so `--model <preset>/<model>` is all you need:

```bash
export GROQ_API_KEY=gsk_...
arcturn --model groq/llama-3.3-70b-versatile -p "explain this repo"

export DEEPSEEK_API_KEY=sk-...
arcturn --model deepseek/deepseek-reasoner
```

Around twenty curated models across these presets are registered at startup and show up in
`--list-models`. Any *other* model the endpoint serves works too — the id after the `/` is passed to
the wire verbatim — as long as something registers it (an extension calling `presetSpec(preset,
model, { register: true })` from `@arcturn/ai`).

| Preset | Provider | Protocol | API key variable |
| --- | --- | --- | --- |
| `ant-ling` | Ant Ling | openai | `ANT_LING_API_KEY` |
| `baseten` | Baseten | openai | `BASETEN_API_KEY` |
| `cerebras` | Cerebras | openai | `CEREBRAS_API_KEY` |
| `cloudflare-ai-gateway` | Cloudflare AI Gateway | anthropic | `CLOUDFLARE_API_KEY` |
| `cloudflare-workers-ai` | Cloudflare Workers AI | openai | `CLOUDFLARE_API_KEY` |
| `deepseek` | DeepSeek | openai | `DEEPSEEK_API_KEY` |
| `fireworks` | Fireworks AI | anthropic | `FIREWORKS_API_KEY` |
| `groq` | Groq | openai | `GROQ_API_KEY` |
| `huggingface` | Hugging Face | openai | `HF_TOKEN` |
| `kimi-coding` | Kimi For Coding | anthropic | `KIMI_API_KEY` |
| `lmstudio` | LM Studio (local) | openai | `LMSTUDIO_API_KEY` |
| `minimax` · `minimax-cn` | MiniMax | anthropic | `MINIMAX_API_KEY` · `MINIMAX_CN_API_KEY` |
| `mistral` | Mistral | openai | `MISTRAL_API_KEY` |
| `moonshot` · `moonshot-cn` | Moonshot AI | openai | `MOONSHOT_API_KEY` |
| `nvidia` | NVIDIA NIM | openai | `NVIDIA_API_KEY` |
| `ollama` | Ollama (local) | openai | `OLLAMA_API_KEY` |
| `opencode` · `opencode-go` | OpenCode Zen / Go | anthropic · openai | `OPENCODE_API_KEY` |
| `openrouter` | OpenRouter | openai | `OPENROUTER_API_KEY` |
| `qwen` · `qwen-cn` · `qwen-individual` | Qwen Token Plan | openai | `QWEN_TOKEN_PLAN_API_KEY` · `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `together` | Together AI | openai | `TOGETHER_API_KEY` |
| `vercel-gateway` | Vercel AI Gateway | anthropic | `AI_GATEWAY_API_KEY` |
| `vllm` | vLLM (local) | openai | `VLLM_API_KEY` |
| `xai` | xAI | openai | `XAI_API_KEY` |
| `xiaomi` · `xiaomi-ams` · `xiaomi-cn` · `xiaomi-sgp` | Xiaomi MiMo | openai | `XIAOMI_API_KEY` · `XIAOMI_TOKEN_PLAN_*_API_KEY` |
| `zai` · `zai-api` · `zai-cn` | Z.AI | openai | `ZAI_API_KEY` · `ZAI_CODING_CN_API_KEY` |

`--list-providers` is authoritative; the table above is a summary. The two Cloudflare presets need
`{account_id}` (and `{gateway_id}`) substituted into their base URL before use, and the local
runners (`lmstudio`, `ollama`, `vllm`) assume the project's default port.

---

## Authentication

### API keys

The usual path: export the variable the provider names and pick a model. Arcturn checks the key **before
the first request**, so a missing one is a startup error naming the exact variable, not a 401 halfway
through a run.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
arcturn --model anthropic/claude-sonnet-4-5
```

`bedrock` and `vertex` are the exceptions: they authenticate from ambient cloud credentials (an AWS
profile or role, Google application-default credentials) and fail at call time instead.

### Subscription sign-in is not supported

There is no way to point Arcturn at a Claude, ChatGPT or GitHub Copilot subscription. Signing in
with one needs an OAuth client id that each provider issues to its own product, and Arcturn has
none. An earlier release shipped `arcturn auth login` for those three; it never completed a sign-in
and has been removed rather than left in the help text. Use an API key.

`arcturn mcp auth <name>` is a different mechanism and does work — see [MCP servers](#mcp-servers).

---

## Interactive mode

```
✦ arcturn 0.1.0
  Claude Sonnet 4.5 · default · /work/repo
  /help for commands · Ctrl+D to exit

› refactor the parser
● read  src/parser.ts
  ⎿ 240 lines
● edit  src/parser.ts
  ⎿ src/parser.ts
    @@ -18,7 +18,7 @@
    -  const tokens = input.split(" ");
    +  const tokens = tokenize(input);

Done — `parse()` now uses the shared tokenizer.

  ☑ read the parser      ◐ swap in tokenize()      ☐ update the tests
⠋ working · 12s · 1.4k tokens · esc to interrupt
› ▏
arcturn  Claude Sonnet 4.5  default                             $0.04  ctx 8%
```

Finished transcript lines are printed straight to the terminal, so they land in real scrollback and
survive scrolling, resizing and `tmux` copy mode. Only the live region — the streaming reply, the
todo checklist, the activity line, the editor and the status bar — is owned by the renderer.

### Keys

| Key | Action |
| --- | --- |
| `Enter` | Submit. While a run is in flight the text becomes a **steering** message injected after the current tool batch. |
| `Shift+Enter` / `Alt+Enter` / `Ctrl+J` | Newline. |
| `/` | Open the command palette (`Tab` completes, `Enter` accepts). |
| `Esc` | Abort the running turn; otherwise clear the editor. |
| `Ctrl+C` | Abort the run; twice in a row while idle exits. |
| `Ctrl+D` | Exit (on an empty buffer; otherwise forward-delete). |
| `↑` / `↓` | Prompt history / list navigation. |
| `Ctrl+A` `Ctrl+E` `Ctrl+W` `Ctrl+K` `Ctrl+U` `Ctrl+Y` `Ctrl+Z` | Readline-style editing. |

### Slash commands

| Command | Description |
| --- | --- |
| `/help` | List every command, including those added by extensions. |
| `/model [id]` | Switch models — with an id directly, or through a filterable picker. |
| `/clear` | Start a fresh session and clear the screen. |
| `/compact` | Summarise the conversation to free up context. |
| `/sessions` | Pick an earlier session in this directory and resume it. |
| `/permissions` | Show the active rules and switch permission mode. |
| `/mcp` | MCP server status and tool counts. |
| `/todos` | The current todo list. |
| `/cost` | Tokens, cost and context usage for this session. |
| `/exit` | Quit. |

### Dialogs

A permission request opens a modal with the tool, its subject and three choices: **Allow once**,
**Allow always (project)** — which writes a rule to `<cwd>/.arcturn/config.json` — and **Deny**, which
tells the model why. For `bash` the "always" rule is widened to a command prefix (`git *`), so
approving `git status` never approves `rm -rf`.

In plan mode the `plan` tool opens the approval gate: **Approve**, **Approve and auto-accept edits**
(switches to `acceptEdits`), or **Keep planning**.

---

## Configuration

Two JSON files, merged in this order over the built-in defaults:

1. `~/.arcturn/config.json` — user scope (override the root with `ARCTURN_HOME`)
2. `<cwd>/.arcturn/config.json` — project scope

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5",
  "permissionMode": "default",          // default | acceptEdits | plan | yolo
  "thinking": "off",                    // off | low | medium | high
  "theme": "dark",                      // dark | light
  "systemPromptAppend": "Always run pnpm check before saying you are done.",
  "permissions": [
    { "tool": "bash", "specifier": "git *", "action": "allow" },
    { "tool": "bash", "specifier": "rm *", "action": "deny" },
    { "tool": "write", "specifier": "src/**", "action": "allow" }
  ]
}
```

Scalars from the project file win; `permissions` **accumulate** across both files, and each rule is
tagged with the scope of the file it came from. Precedence when two rules match:
scope (`session` > `project` > `user`) → specificity (exact > glob > wildcard) → `deny` wins a tie.

A malformed file is a warning, not a crash: Arcturn reports it and falls back to the layers it could
read. Unknown keys are reported and ignored.

| Environment variable | Effect |
| --- | --- |
| `ARCTURN_MODEL` | Overrides `model` from every config file. |
| `ARCTURN_HOME` | Overrides `~/.arcturn`. |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` · `GOOGLE_API_KEY` | Provider credentials (plus `ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY` fallbacks). |
| One variable per preset | See [Providers](#providers) or run `arcturn --list-providers`. |

### Other locations

| Path | Contents |
| --- | --- |
| `~/.arcturn/sessions/<hash-of-cwd>/*.jsonl` | Session transcripts, bucketed per working directory. |
| `~/.arcturn/mcp.json`, `<cwd>/.arcturn/mcp.json` | MCP servers (merged, project wins per server name). |
| `~/.arcturn/extensions/`, `<cwd>/.arcturn/extensions/` | Extension modules. |
| `~/.arcturn/auth/mcp-<server>.json` | OAuth credentials from `arcturn mcp auth` (`0600` in a `0700` directory). |
| `ARCTURN.md` at the repository root | Project instructions, inlined verbatim into the system prompt. |

### MCP servers

```jsonc
// <cwd>/.arcturn/mcp.json
{
  "servers": {
    "fs":     { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "github": { "type": "http",  "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }
  }
}
```

`${ENV_VAR}` references are expanded from the environment. Tools appear to the model as
`mcp__<server>__<tool>`. A server that fails to start is reported by `/mcp` and never blocks the
rest. `--no-mcp` skips the whole thing.

---

## Extensions

Drop a `.ts` or `.js` module into `~/.arcturn/extensions/` or `<cwd>/.arcturn/extensions/`. TypeScript works
with no build step ([jiti](https://github.com/unjs/jiti) transpiles on load). A directory containing
`index.ts`/`index.js` counts as one extension; dotfiles, `_`-prefixed files and `.d.ts` are skipped.

Each module **default-exports one function** taking a `ArcturnExtensionApi`:

```ts
// <cwd>/.arcturn/extensions/review.ts
import { registerModel } from "@arcturn/ai";
import type { ArcturnExtensionApi } from "arcturn";

export default function (api: ArcturnExtensionApi): void {
  // 1. A tool the model can call.
  api.registerTool({
    definition: {
      name: "changed_files",
      description: "List files changed against the main branch.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(_input, ctx) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("git", ["diff", "--name-only", "main"], {
        cwd: ctx.cwd,
      });
      return { content: [{ type: "text", text: stdout || "(no changes)" }] };
    },
  });

  // 2. A slash command. `ctx` is the live CommandContext: runtime, ui, args.
  api.registerCommand("review", "Review the diff against main", async (ctx) => {
    ctx.ui.notice("info", "Reviewing…");
    await ctx.runtime.agent.prompt("Review the diff against main and list real bugs only.");
  });

  // 3. Observe the agent event stream. "*" receives every AgentEvent.
  api.on("toolStart", (event) => {
    if (event.type === "toolStart" && event.toolName === "bash") {
      api.log(`running: ${String(event.input.command)}`);
    }
  });

  // 4. Register an extra model — the catalog is shared, so `--model` sees it.
  registerModel({
    id: "groq/llama-3.3-70b",
    provider: "openai-compatible",
    model: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B (Groq)",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    capabilities: { tools: true, vision: false, thinking: false, caching: false },
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
  });

  // 5. Read the resolved configuration.
  if (api.config.permissionMode === "yolo") api.log("living dangerously");
}
```

### `ArcturnExtensionApi`

| Member | Description |
| --- | --- |
| `registerTool(tool)` | Add a `Tool`. A name that clashes with a built-in or another extension is reported and dropped. |
| `registerCommand(name, description, handler)` | Add a slash command (leading `/` optional). Built-ins cannot be shadowed. |
| `on(event, listener)` | Subscribe to an `AgentEvent["type"]`, or `"*"` for all of them. |
| `log(message)` | Emit an informational line. |
| `config` · `cwd` · `version` · `file` | The merged config, the working directory, the CLI version and this module's path. |

Extensions are isolated: a module that throws on load, a bad registration or a listener that throws
becomes a warning printed at startup — the rest keep working. Arcturn's own packages
(`@arcturn/*`, `arcturn`) resolve by name from anywhere; other bare imports resolve relative to
the extension file.

---

## Programmatic use

The same assembly logic the CLI runs on is exported, so a server or an SDK user can reuse it:

```ts
import { buildRuntime, connectMcp, runPrint } from "arcturn";

const runtime = await buildRuntime({
  cwd: process.cwd(),
  model: "anthropic/claude-sonnet-4-5",
  permissionMode: "acceptEdits",
});
await connectMcp(runtime);

runtime.subscribe((event) => {
  if (event.type === "toolStart") console.log("tool:", event.toolName);
});

const { text, exitCode } = await runPrint({ runtime, prompt: "summarise src/index.ts" });
await runtime.dispose();
```

`buildRuntime` accepts an `llm` client, so a test harness can drive the whole stack with a scripted
model and never touch the network. Also exported: `loadConfig`, `ArcturnRuntime`, `CommandRegistry`,
`TranscriptFormatter`, `InteractiveApp`, `loadExtensions` and the `ArcturnExtensionApi` types.

The provider surface is exported too — `formatProviderCatalog(env)` and
`registerBundledCatalog()` (idempotent: registers the preset models) — whose environment and
filesystem dependencies are injectable.

`registerConfiguredProviders({ config, paths, confirm })` applies a config file's
`providers` block to the catalog, so an embedder gets the same config-declared endpoints
the CLI does. It is **not** latched: a second call with a different config replaces the
first call's registrations rather than adding to them, which is what `serve` and background
agents running several working directories in one process need. `confirm` gates
project-layer declarations and defaults to a hard `() => false`; pass
`terminalProviderConfirm` only from a host that owns a real terminal, and nothing else.
See [Permissions](https://arcturn.dev/docs/permissions#provider-endpoints-from-a-project-config).

---

## Development

```bash
pnpm --filter arcturn build
npx vitest run packages/cli
node packages/cli/dist/main.js --help
node packages/cli/dist/main.js --list-models
node packages/cli/dist/main.js --list-providers
node packages/cli/dist/main.js mcp --help
```

Every test is headless: no real TTY (the TUI runs against `TestTerminal`), no network and no API
keys — the MCP OAuth tests bind a loopback listener on an ephemeral port and drive the redirect
themselves, so no browser flow or credential is ever touched. Implementation notes and known rough
edges live in [`NOTES.md`](./NOTES.md); the provider and preset wiring is covered in
[`NOTES-auth.md`](./NOTES-auth.md).

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

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
