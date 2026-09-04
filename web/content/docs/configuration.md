---
title: Configuration
description: Every config key, default, and env var — file locations, scope, and precedence.
section: Start
order: 2
---

## File locations and precedence

Configuration is layered JSON, merged with later layers winning:

```text
built-in defaults
  → ~/.arcturn/config.json          (user scope)
  → <cwd>/.arcturn/config.json      (project scope, skipped if cwd is the user root)
  → ARCTURN_MODEL environment variable
```

Most keys simply overwrite (project beats user, env beats both). Three are different:

- **`permissions`** accumulates across layers instead of replacing — a user rule and a
  project rule can both apply. See [Permissions](/docs/permissions) for the rule schema
  and how the four permission modes interact with it.
- **`hooks`** also accumulates — a user-level hook and a project-level hook both fire for
  the same lifecycle event. See [Lifecycle hooks](/docs/hooks).
- **`permissionMode`** is clamped: a project layer may only *narrow* it, never widen it.
  From narrowest to widest the modes are `plan` → `default` → `acceptEdits` → `yolo`, so a
  repository asking for `plan` is honored while one asking for `yolo` when you are at
  `default` is ignored with a warning. Otherwise a checked-in config would switch off your
  permission prompts for anyone who cloned the repository. To run a project at a wider mode
  deliberately, set it in your own `~/.arcturn/config.json` or pass `--permission-mode`,
  which wins over both layers in either direction.

A malformed or unreadable config file is a warning, never a crash: Arcturn falls back to
the layers it could read. An unrecognized top-level key is likewise a warning (`unknown
config key "..." (ignored)`), not a hard failure — so a typo doesn't stop the CLI from
starting, and upgrading Arcturn never breaks on an older config written for a newer key.

Override where the user directory itself lives with `ARCTURN_HOME` (default `~/.arcturn`).

## Config key reference

Every key `.arcturn/config.json` accepts, in both user and project files:

| Key | Type | Default | Notes |
|---|---|---|---|
| `model` | `string \| string[]` | `"anthropic/claude-sonnet-4-5"` | An array is a failover chain: first entry primary, later ones tried on overload/rate-limit/unreachable. |
| `permissionMode` | `"default" \| "acceptEdits" \| "plan" \| "yolo"` | `"default"` | Starting permission mode. A project layer may only narrow it (see above). See [Permissions](/docs/permissions). |
| `permissions` | `PermissionRule[]` | `[]` | Accumulates across layers. See [Permissions](/docs/permissions). |
| `thinking` | `"off" \| "low" \| "medium" \| "high"` | `"off"` | Extended-thinking level for `thinking`-capable models. |
| `theme` | `string` | `"dark"` | `"dark"`, `"light"`, or a custom theme file name under `~/.arcturn/themes` / `<cwd>/.arcturn/themes`. |
| `ui` | `"screen" \| "inline"` | `"screen"` | `"screen"` is the full-screen, alternate-screen TUI; `"inline"` is the classic bottom-of-scrollback block. |
| `systemPromptAppend` | `string` | *(none)* | Extra text appended verbatim to the system prompt. |
| `hooks` | `HookConfig` | `{}` | Lifecycle hooks. Accumulates across layers. See [Lifecycle hooks](/docs/hooks). |
| `lsp` | `"off" \| "on"` | `"off"` | Language-server diagnostics after `write`/`edit`. See [LSP diagnostics](/docs/lsp). |
| `sandbox` | `"off" \| "workspace-write"` | `"off"` | OS filesystem sandbox for `bash`'s foreground commands. See [Tools](/docs/tools#filesystem-sandbox-for-bash). |
| `maxCostUsd` | `number ≥ 0` | *(unset = no limit)* | Abort a run once it has cost this many USD. Same guard as `--max-cost`. |
| `maxTurns` | `integer > 0` | `200` (core default) | Turn ceiling for a run. Same guard as `--max-turns`. Shortly before the ceiling bites, the run is warned in-conversation so it wraps up and delivers instead of being cut off mid-work — see [The wrap-up warning](/docs/sdk-agent-options#the-wrap-up-warning) for the trip point, and for why a ceiling of 1 or 2 gets no warning at all. |
| `subagentMaxTurns` | `integer > 0` | `64` | Turn ceiling for one delegated sub-agent or scout. |
| `requestStallTimeoutMs` | `integer ≥ 0` | `120000` | Abort a streaming LLM request that emits **no event** for this long — a stalled/dead socket, not a slow one — and retry or fail it over as a transient network error. **Not** a total-duration cap: a long, actively streaming turn (extended thinking, a big response) is never interrupted, because the timer resets on every event. `0` disables the guard. |
| `verify` | `string \| VerifyConfig` | *(unset)* | Command run after edits; failures are fed back to the model. String is sugar for `{ command }`. See below. |
| `audit` | `boolean` | `false` | Record an append-only audit trail per session. See [Audit trail](/docs/audit-cost) and `arcturn audit`. |
| `insights` | `boolean` | `true` | Keep the local insights ledger (`~/.arcturn/insights/`) — parks, silent turns, step failures, run costs. Names and numbers only; no prompts, reasoning, paths or content. `false` writes nothing at all. See [Insights](/docs/insights). |
| `retro` | `{ auto?, model? }` | `{ auto: true }` | `auto` controls whether `/workflow` prints the retro hint after a run with a park, a failed step or a retried step; `model` overrides the model `arcturn retro`'s read-only sub-agent runs on (default: the configured `judgment` tier, else the subagent route). See [Retro](/docs/retro). |
| `brain.enabled` | `boolean` | `true` | Build, inject and expose the distilled repository map every agent reads. `false` builds nothing, injects nothing and does not register the `brain` tool. See [Project brain](/docs/brain). |
| `brain.autoRefresh` | `boolean` | `true` | Refresh the brain — and distil that run's lessons into `runs.md` — after a workflow run reaches a terminal status. Paused runs are skipped. |
| `brain.maxChars` | `integer > 0` | `6000` | Character budget for the fenced brain block injected into system prompts. |
| `brain.maxDirs` | `integer > 0` | `40` | How many directories get their own note. Busiest first; a directory over 80 files is split one level deeper, to a depth of three. |
| `brain.model` | `string` | *(unset)* | Catalog id or `tier:<name>` for the read-only distiller sub-agent. Unset uses the `fast` tier when `route.tiers.fast` is configured, else the `subagent` route. |
| `provenance` | `boolean` | `false` | Record reasoning-level provenance so `arcturn blame <file>` can explain a line. See [Provenance](/docs/provenance). |
| `dryRun` | `boolean` | `false` | Route file mutations to a shadow copy for review instead of the real tree. Same as `--dry-run`. See [Dry-run mode](/docs/dry-run). |
| `speculation` | `boolean` | `false` | Keep editing speculatively while a permission prompt is open. |
| `route` | `RouterConfig` | `{}` | Per-role model overrides (`main`, `subagent`, `compaction`, `title`). See below. |
| `skills.synthesisModel` | `string` | *(unset)* | Catalog id or `tier:<name>` the `arcturn skill synthesize` / `/skills synthesize` drafting sub-agent uses. Unset uses the `fast` tier when `route.tiers.fast` is configured, else the `subagent` route. See [Synthesizing a skill from a run](/docs/skills#synthesizing-a-skill-from-a-run). |
| `providers` | `Record<string, ProviderEntry>` | `{}` | Extra provider endpoints — a gateway, a vLLM cluster, Ollama elsewhere — reachable as `<name>/<model>`. Merged key-wise with the **user** layer winning, unlike `route`. A project-declared entry is inert until approved. See below and [Providers](/docs/providers#from-configuration). |
| `sessionTitles` | `boolean` | `true` | Generate a session title with one small LLM call (on the `title` route) after an interactive session's first completed run. `false` turns the call off. See [Sessions](/docs/sessions#session-titles). |
| `taint` | `"off" \| "warn" \| "confirm" \| "deny"` | `"warn"` | How to treat a mutating call that echoes untrusted fetched content. See [Injection defense](/docs/injection-defense). |
| `canary` | `"off" \| "warn" \| "deny"` | `"off"` | How to treat an outbound call carrying a planted canary token. See [Injection defense](/docs/injection-defense). |
| `canaries` | `string[]` | *(unset)* | Literal values that must never leave this machine; concatenates across layers. |
| `consensus` | `{ models: string[], sampleRate?, similarityThreshold? }` | *(unset)* | Cross-check sampled turns against extra models; costs one extra call per listed model per sampled turn. |

In `"screen"` mode the transcript scrolls inside the app: mouse wheel, PgUp/PgDn, and — while
the view is scrolled up — Home and End; sending a prompt returns to the live tail. A pure
vertical scroll is painted by moving the terminal's own rows (a DECSTBM scroll region) rather
than repainting the screen, which is what keeps a flick smooth on a slow connection. If your
terminal misrenders it, `ARCTURN_NO_SCROLL_REGION=1` turns that shortcut off and every frame
takes the plain row diff.

Any key not in this table is rejected with a warning and ignored — there is no silent
extension surface beyond `systemPromptAppend`.

### `verify`

```json
{ "verify": "pnpm test" }
```

```json
{
  "verify": {
    "command": "pnpm typecheck",
    "globs": ["*.ts", "*.tsx"],
    "timeoutMs": 60000,
    "runOn": "edit"
  }
}
```

- `command` — shell command, run in the runtime's working directory through the
  platform's shell: `/bin/sh -c` on macOS/Linux, `%ComSpec% /d /s /c` (`cmd.exe` by
  default) on Windows. See [Platform support](/docs/getting-started#platform-support) for
  what that means for a command written with POSIX syntax. `command` is **not portable
  across the two shells** — neither is a [lifecycle hook](/docs/hooks)'s command, for the
  same reason. `.arcturn/config.json` is plain JSON with no per-platform branching, so a
  config checked in for a team that develops on both macOS/Linux and Windows can't put a
  shell one-liner straight in `command`; point it instead at something that *is* portable
  — an `npm`/`pnpm` script (`"pnpm verify"`, with the platform-specific part inside
  `package.json`) or a Node script invoked directly (`"node scripts/verify.mjs"`).
- `globs` — restricts which edited paths trigger the command. This is a simple
  suffix/segment check, not full glob syntax: a leading `*` (`"*.ts"`) matches a path
  *ending with* the rest of the pattern; anything else matches the whole path, a trailing
  path suffix, or an exact path segment. There is no `**` and no mid-pattern `*`. Omitted
  or empty matches every edited path.
- `timeoutMs` — defaults to 60000 (60s).
- `runOn` — `"edit"` (default: runs after every successful `write`/`edit`) or `"manual"`.

A passing verify appends nothing to the tool result (quiet on green); a failing one
appends the failure, roughly the trailing 40 lines, so the model sees its own breakage on
the very next turn. It never turns a successful `write`/`edit` into a failure.

### `route`

Route a cheaper model to work that doesn't need the flagship:

```json
{
  "route": {
    "subagent": "anthropic/claude-haiku-4-5",
    "compaction": "anthropic/claude-haiku-4-5",
    "title": "anthropic/claude-haiku-4-5"
  }
}
```

Each of `main`, `subagent`, `compaction`, `title` is an independent model id. An absent
key falls back to `main`'s route, and an absent `main` falls back to whatever model the
session is actually running (typically what `--model` resolved to). A stale or typo'd id
never throws or blocks startup — it falls back to the main model and surfaces a warning.

You don't have to edit this block by hand: `/model route --auto` picks a cheaper
same-provider model and writes `route.subagent` and `route.compaction` into your user
config (merging into the existing block), and `/model route <kind> <id>` /
`/model route clear [kind]` manage single keys. See
[Model routing](/docs/model-routing) for the full precedence.

## Provider API keys

Arcturn resolves an API key for a model in this order:

1. A per-provider key passed explicitly to the client.
2. A shared explicit key passed to the client.
3. The model spec's own `apiKeyEnv`, if it names one.
4. The provider's default environment variable.
5. Provider-specific fallback variables.

**A model declared in a `providers` config block skips that ladder entirely.** Such a spec
is registered *key-exclusive*: its `apiKeyEnv` is the only variable consulted, and an unset
one means no key rather than a fall-through to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` or to
an explicit client-wide key. A file that names an endpoint and a credential gets exactly
the credential it named.

The default variables per provider:

| Provider | Default env var | Fallbacks |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_AUTH_TOKEN` |
| `openai` | `OPENAI_API_KEY` | — |
| `google` | `GOOGLE_API_KEY` | `GEMINI_API_KEY`, `GOOGLE_GENAI_API_KEY` |
| `openai-compatible` | `OPENAI_API_KEY` | — |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=...
```

An API key is the only credential Arcturn takes for a model provider. There is no
subscription sign-in — see
[Model providers](/docs/providers#subscription-sign-in-is-not-supported).

## The model catalog

Arcturn ships a curated catalog of `ModelSpec`s — context window, max output tokens, cost
per million tokens, and capability flags (`tools`, `vision`, `thinking`, `caching`) — for
every model it supports out of the box, keyed as `<provider>/<model>`:

```text
anthropic/claude-opus-4-5
anthropic/claude-sonnet-4-5
anthropic/claude-haiku-4-5
openai/gpt-5.1
openai/gpt-5.1-codex
google/gemini-3-pro-preview
google/gemini-2.5-flash
```

Pick one on the command line (`arcturn --model anthropic/claude-sonnet-4-5`), in-session
(`/model openai/gpt-5.1`), or in code via `requireModel(id)` from `@arcturn/ai`.
Switching models mid-session is recorded as a `state` entry in the session tree, so
resuming later restores the model you were using. `arcturn --list-models` prints the full
catalog and exits; `arcturn --list-providers` prints every provider and preset endpoint.

## OpenAI-compatible endpoints

Any endpoint that speaks the OpenAI chat-completions wire format — a local model server,
a self-hosted gateway, a third-party router — works as an `openai-compatible` provider,
and an Anthropic-Messages endpoint works as `anthropic-compatible`.

Declare one in the `providers` config key:

```jsonc
{
  "providers": {
    "mycorp": {
      "baseUrl": "https://llm.corp.internal/v1",
      "apiKeyEnv": "MYCORP_LLM_KEY",
      "protocol": "openai",
      "label": "MyCorp Gateway",
      "models": [{ "model": "llama-70b", "contextWindow": 128000 }]
    }
  }
}
```

Ids are namespaced `<name>/<model>`, so `arcturn --model mycorp/llama-70b` works and the
entry shows up in `--list-models`, `--list-providers`, `/model` and `arcturn doctor`.
Omitting `models` is fine: ids then pass through to the wire verbatim.

`apiKeyEnv` is **required for a remote endpoint** (a loopback one may omit it and is then
contacted with no credential), `baseUrl` must be `https:` (or loopback `http:`) and free of
control characters, and a project file may not name a variable holding a credential you
keep for another service — including any built-in preset's, compared case-insensitively. A
project-declared endpoint is also parsed-but-inert until you approve it once.
[Providers](/docs/providers#from-configuration) has the full rule list, and
[Permissions](/docs/permissions#provider-endpoints-from-a-project-config) has the consent
model.

Registering from code still works and still wins: `openaiCompatible({ model, baseUrl,
apiKeyEnv })` in `@arcturn/ai` — see [Embedding with the SDK](/docs/sdk) — runs after the
config block, so an extension can override a config entry. Once registered, either way
behaves like any other catalog entry, with the same cost/context-window bookkeeping.

## Command-line flags

Every flag `arcturn` accepts. Long flags may be written `--flag value` or `--flag=value`;
boolean flags accept a `--no-` prefix.

| Flag | Alias | Takes | Description |
|---|---|---|---|
| `--print` | `-p` | — | Non-interactive: run to completion, print the final assistant message, exit. |
| `--output-format <fmt>` | | `text \| json` | With `--print`: `text` (default) prints the final message; `json` emits NDJSON of every agent event. Requires `--print`. |
| `--model <id>` | `-m` | value | Model to use (see `--list-models`). |
| `--continue` | `-c` | — | Resume the most recent session in this directory. Mutually exclusive with `--resume`. |
| `--resume <sessionId>` | `-r` | value | Resume a specific session. |
| `--permission-mode <mode>` | | `default \| acceptEdits \| plan \| yolo` | Starting permission mode. |
| `--cwd <dir>` | | value | Working directory for tools, config, and sessions. |
| `--no-mcp` | | — | Do not start any configured MCP servers. |
| `--max-turns <n>` | | integer > 0 | Stop a run after n model turns. |
| `--max-cost <usd>` | | number > 0 | Abort the run once it has cost this much. |
| `--dry-run` / `--no-dry-run` | | — | Send file edits to a shadow copy; review with `/diff`. |
| `--host <iface>` | | value | With `serve`: interface to bind (default `127.0.0.1`). |
| `--port <n>` | | 0–65535 | With `serve`: port to bind (default `7717`). |
| `--token <secret>` | | value | With `serve`: shared auth token (generated if omitted). |
| `--web` | | — | With `serve`: also serve the browser client. |
| `--web-port <n>` | | 0–65535 | Port for the browser client (0 or omitted picks one). |
| `--web-origin <origin>` | | value, repeatable | Extra browser origin allowed to open a socket. Repeat to allow several. |
| `--cassette <file>` | | value | With `bisect`: the VCR recording to compare against. |
| `--record <file>` | | value | Record this run's model and tool calls to a cassette. |
| `--list-models` | | — | Print the model catalog and exit. |
| `--list-providers` | | — | Print every provider and preset endpoint, and exit. |
| `--help` | `-h` | — | Show help. |
| `--version` | `-v` | — | Print the version. |

Positional commands (`arcturn <command> ...`) take the place of a prompt: `auth`,
`completions`, `replay`, `audit`, `insights`, `blame`, `bisect`, `serve`, `acp`, `attach`. See `arcturn
--help` for each, and [Sessions](/docs/sessions), [Replay & bisect](/docs/replay-bisect),
[Provenance](/docs/provenance), and [Audit trail](/docs/audit-cost) for the ones owned by
other pages.

Anything not recognized as a flag or a positional command becomes prompt text — including
everything after a literal `--`.

## Other environment variables

| Variable | Effect |
|---|---|
| `ARCTURN_MODEL` | Overrides the configured model (wins over every config layer). |
| `ARCTURN_HOME` | Overrides `~/.arcturn` as the user-scope root. |
| `BRAVE_API_KEY` | Used by the `websearch` tool when present; falls back to scraping DuckDuckGo otherwise. |

## MCP config

MCP servers are declared in a JSON file shaped `{ "servers": { ... } }`, read from
`~/.arcturn/mcp.json` merged with `<cwd>/.arcturn/mcp.json` — see [MCP](/docs/mcp) for the
full schema and `${ENV_VAR}` expansion rules.

## Extended thinking

`thinking` (config key) or `--thinking <level>` is not currently a CLI flag — set it via
`.arcturn/config.json`'s `thinking` key (`off`, `low`, `medium`, `high`) to control how
much extended reasoning a `thinking`-capable model does before it answers or calls a tool.
This maps to the `ThinkingLevel` type shared by every provider adapter, so the same
setting works regardless of which model you're running.

## Compaction

Arcturn automatically compacts the conversation before it would overflow the model's
context window — by default it keeps roughly the most recent 20,000 tokens verbatim and
folds everything older into a structured markdown summary, reserving 16,384 tokens of
headroom. All of it is tunable; see [Sessions](/docs/sessions#compaction) for the knobs
and how a compaction is recorded in the session tree.

## Writing a permission rule or setting from code

`persistSetting(key, value, scope, paths)` and `persistPermissionRule(rule, paths)` in
`@arcturn/cli`'s config module write one key or one rule back to the right file for its
scope (`"project"` → `<cwd>/.arcturn/config.json`, otherwise `~/.arcturn/config.json`) —
this is what the TUI's "always allow" permission prompt and `/config` commands call under
the hood. Session-scoped permission rules are intentionally never written to disk: they
live only in the running process's permission engine.
