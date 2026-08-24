# Integrating the ACP adapter (`arcturn acp`)

Arcturn ships an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter in
`packages/cli/src/acp/`. ACP is the editor↔agent standard behind Zed's external agents,
the JetBrains AI plugin's agent bridge and Neovim clients — the "LSP moment" for coding
agents. Speaking it means arcturn drops into any of those editors without a bespoke plugin.

The adapter is complete and tested, but **not yet wired into the CLI**. This document
describes the wiring, what is deliberately unimplemented, and what registry submission
would require.

## What is here

| File | Role |
| --- | --- |
| `packages/cli/src/acp/protocol.ts` | Transport: JSON-RPC 2.0 codec + `AcpConnection` over injected streams |
| `packages/cli/src/acp/adapter.ts` | Semantics: `createAcpAgent(deps)` mapping arcturn's `AgentEvent` stream onto ACP |
| `packages/cli/src/acp/acp.test.ts` | 37 tests, all over in-memory duplex streams — no editor, no network |

Neither file imports `ArcturnRuntime`. `adapter.ts` takes a narrow `AcpAgentDeps` seam
(`prompt`, `abort`, plus optional `createSession` / `loadSession` / `createSessionId` /
`agentInfo`), which is what keeps it unit-testable against a scripted event array.

### Framing: NDJSON, not `Content-Length`

Worth flagging because it is the one place the adapter diverges from
`packages/cli/src/lsp/client.ts`. The [ACP transport
spec](https://agentclientprotocol.com/protocol/transports) says:

> Messages are delimited by newlines (`\n`), and **MUST NOT** contain embedded newlines.

So ACP's stdio transport is NDJSON, whereas LSP uses `Content-Length:` headers. The
incremental buffering *discipline* of `NdjsonFrameDecoder` is copied from the proven
`LspFrameDecoder` (buffer partial input, drain every frame a chunk completes, drop
undecodable bytes rather than wedging), but the delimiter differs. A
`ContentLengthFrameDecoder` is also exported and selectable via
`new AcpConnection({ framing: "content-length" })` for hosts bridging ACP over a
custom LSP-style transport; `ndjson` is the default and the only framing ACP defines
for stdio.

Two consequences for a `arcturn acp` subcommand:

- **`stdout` is reserved.** "The agent MUST NOT write anything to its `stdout` that is
  not a valid ACP message." Banners, the logo, warnings and `console.log` must all be
  redirected to `stderr` (which the spec explicitly permits for logging) or suppressed.
- Frames never contain a raw newline, because `JSON.stringify` escapes them.

## Wiring `arcturn acp` over a real runtime

Three new pieces are needed, all in files this adapter does not touch:

1. **`args.ts`** — an `AcpCommand { readonly kind: "acp" }` added to the `CliCommand`
   union, an `ACP_COMMAND_NAME = "acp"` constant, and a positional branch alongside the
   existing `serve` branch that sets `args.command = { kind: "acp" }` and `args.prompt = ""`.
2. **`main.ts`** — a `if (args.command?.kind === "acp") return runAcp(...)` early return,
   placed *before* any banner/logo printing, mirroring the `serve` branch at
   `main.ts:104`.
3. **`acp/run.ts`** (new) — the runtime bridge sketched below.

```ts
import { createAcpAgent } from "./adapter.js";
import { AcpConnection } from "./protocol.js";

export async function runAcp(runtime: ArcturnRuntime): Promise<void> {
  const connection = new AcpConnection({
    input: process.stdin,
    output: process.stdout,
    // stdout is protocol-only; diagnostics go to stderr.
    onError: (error) => process.stderr.write(`[acp] ${error.message}\n`),
  });

  // One arcturn Agent per ACP session.
  const agents = new Map<string, Agent>();

  const acp = createAcpAgent({
    agentInfo: { name: "arcturn", title: "Arcturn", version: PACKAGE_VERSION },

    createSession(_params, sessionId) {
      const agent = runtime.startNewSession();          // runtime.ts:522
      agents.set(sessionId, agent);
      // Route approvals through ACP's session/request_permission.
      runtime.setPermissionRequester(acp.permissionPrompt(sessionId)); // runtime.ts:477
    },

    async prompt(request, onEvent) {
      const agent = agents.get(request.sessionId);
      if (!agent) throw new Error(`Unknown session ${request.sessionId}`);
      const unsubscribe = agent.subscribe(onEvent);      // agent.ts:328
      try {
        await agent.prompt(request.text);                // agent.ts:347
      } finally {
        unsubscribe();
      }
    },

    abort(sessionId) {
      agents.get(sessionId)?.abort();                    // agent.ts:399
    },
  });

  acp.attach(connection);
  connection.listen();
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
}
```

`createAcpAgent` is deliberately unaware of all of this; the seam is the whole point.

Zed configuration once the subcommand exists (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "Arcturn": { "command": "arcturn", "args": ["acp"], "env": {} }
  }
}
```

## Protocol coverage

### Verified against the spec and implemented

Each shape below was read off the published spec pages, and the page is cited in the
TSDoc on the corresponding type in `adapter.ts`.

| Method | Direction | Source page |
| --- | --- | --- |
| `initialize` | client → agent | `/protocol/initialization` — `protocolVersion`, `clientCapabilities.fs.{readTextFile,writeTextFile}`, `clientCapabilities.terminal`, `clientInfo`; response `agentCapabilities.loadSession`, `agentCapabilities.promptCapabilities.{image,audio,embeddedContext}`, `agentInfo`, `authMethods` |
| `session/new` | client → agent | `/protocol/session-setup` — params `{ cwd, mcpServers[] }`, result `{ sessionId }` |
| `session/load` | client → agent | `/protocol/session-setup` — params `{ sessionId, cwd, mcpServers }`, result `null`, history replayed as `session/update` notifications first. **Registered only when the host supplies `deps.loadSession`**; otherwise `loadSession: false` is advertised and the method answers `-32601`. |
| `session/prompt` | client → agent | `/protocol/prompt-turn` — params `{ sessionId, prompt: ContentBlock[] }`, result `{ stopReason }` with `end_turn` / `cancelled` emitted |
| `session/update` | agent → client | `/protocol/prompt-turn`, `/protocol/tool-calls` — `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, and `user_message_chunk` (for load-replay) |
| `session/cancel` | client → agent (notification) | `/protocol/prompt-turn` — halts work, settles outstanding permission requests as `cancelled`, then answers the original `session/prompt` with `stopReason: "cancelled"` |
| `session/request_permission` | agent → client | `/protocol/tool-calls` — params `{ sessionId, toolCall: { toolCallId, … }, options[] }` with `PermissionOptionKind` ∈ `allow_once`/`allow_always`/`reject_once`/`reject_always`; result `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }` |

`ToolCallStatus` (`pending`/`in_progress`/`completed`/`failed`), `ToolKind`
(`read`/`edit`/`delete`/`move`/`search`/`execute`/`think`/`fetch`/`other`),
`StopReason` (`end_turn`/`max_tokens`/`max_turn_requests`/`refusal`/`cancelled`) and
`ToolCallContent` (content / diff / terminal) are all typed from the spec's own
enumerations.

### arcturn → ACP event mapping

| arcturn `AgentEvent` | ACP output |
| --- | --- |
| `messageStream` → `textDelta` | `agent_message_chunk` |
| `messageStream` → `thinkingDelta` | `agent_thought_chunk` |
| `messageEnd` | `agent_message_chunk` **only** if no text deltas were streamed (fallback for non-streaming hosts) |
| `toolStart` | `tool_call` (`status: "pending"`, `kind`, `title`, `rawInput`, `locations`) followed by `tool_call_update` → `in_progress` |
| `toolUpdate` | `tool_call_update` with `in_progress` + a text content block |
| `toolEnd` | `tool_call_update` → `completed` / `failed`, with content and `rawOutput` |
| `permissionRequest` | `tool_call_update` → `pending` (the spec's "awaiting approval" state) |
| `permissionDecision` | `tool_call_update` → `in_progress` (allow) / `failed` (deny) |
| `todoUpdate` | `plan` with mapped entry statuses |
| `subagentStart` / `subagentEnd` | `tool_call` / `tool_call_update` with `kind: "think"`, id `subagent:<agentId>` |
| `runEnd` `completed` | `session/prompt` → `{ stopReason: "end_turn" }` |
| `runEnd` `aborted`, or a cancel | `session/prompt` → `{ stopReason: "cancelled" }` |
| `runEnd` `error` | JSON-RPC `-32603` error response to `session/prompt` (ACP has no `error` stop reason) |

Note that the arcturn `permissionRequest` **event** cannot carry a decision back to the
permission engine — it is informational. The real bridge is
`acp.permissionPrompt(sessionId)`, which returns a arcturn `PermissionPrompt` to hand to
`runtime.setPermissionRequester`. Both paths are implemented and tested.

### Unimplemented

Named explicitly rather than guessed at; each has a matching `TODO(acp)` in the source.

- **`authenticate`** — the adapter advertises `authMethods: []`, since arcturn authenticates
  out of band via env vars. If arcturn ever gains an editor-drivable login, this method and
  non-empty `authMethods` entries must be added.
- **`session/set_mode`** and the `current_mode_update` notification — the `AcpSessionUpdate`
  union types `current_mode_update` (verified at `/protocol/session-modes`) but no
  `availableModes` are advertised and no handler is registered, so arcturn's
  `PermissionMode` (`default`/`acceptEdits`/`yolo`/`plan`) is not yet exposed as ACP
  session modes. This is the highest-value gap: it would put arcturn's plan mode in the
  editor's mode picker.
- **`fs/read_text_file`, `fs/write_text_file`, `terminal/*`** — these are *client*
  methods the agent may call. Arcturn uses its own sandboxed `read`/`write`/`edit`/`bash`
  tools, so it never calls them. The client's advertised capabilities are received
  during `initialize` but currently ignored. Honouring them would let the editor serve
  unsaved buffer contents, which is a real correctness win over reading from disk.
- **Image and audio prompt blocks** — `promptCapabilities.{image,audio}` are advertised
  as `false` because the `AcpAgentDeps.prompt` seam takes flattened text. The raw
  `blocks` are passed through on `AcpPromptRequest.blocks`, so a host can opt in.
  `resource` blocks with inlined text *are* supported (`embeddedContext: true`) and are
  flattened into `<file uri="…">…</file>`; `resource_link` blocks become `@uri` mentions.
- **Diff and terminal tool-call content** — `AcpToolCallContent` types all three
  variants, but only the content-block variant is emitted. Emitting `diff` for arcturn's
  `edit`/`write` tools would give editors inline diff review; that needs the
  before/after text on the arcturn `toolEnd` event.
- **Unmapped arcturn events** — `runStart`, `turnStart`, `turnEnd`, `subagentEvent`,
  `compactionStart`/`compactionEnd`, `backgroundTask*`, `notice` and `planUpdate` have
  no verified ACP counterpart and are dropped. `backgroundTask*` should map onto the
  ACP `terminal/*` client methods once arcturn exposes a terminal id for them; `notice`
  should go to `stderr` once the CLI bridge exists.
- **Streamable HTTP transport** — listed as draft/undefined on the spec's transports
  page, so only stdio is implemented.
- **`_meta`** — the spec reserves a `_meta` property on every payload for extensions.
  The adapter neither emits nor reads it.

## Registering in the ACP agent registry

To have arcturn listed as an ACP agent that editors can discover:

1. **Ship the `arcturn acp` subcommand** (above) with `stdout` fully reserved for protocol
   traffic. This is the blocking prerequisite.
2. **Interop-test against a real client.** Zed's external-agent config (shown above) is
   the fastest loop; `@agentclientprotocol`'s reference client and schema also allow
   validating payloads against the published JSON schema. The 37 unit tests cover the
   shapes this adapter *believes* in — they cannot catch a spec drift.
3. **Pin a protocol version.** `ACP_PROTOCOL_VERSION` is `1`; `initialize` negotiates
   down to the client's number when it asks for an older one. Bumping the spec version
   should be a deliberate, tested change.
4. **Open a PR against `agentclientprotocol/agent-client-protocol`** adding arcturn to the
   agents list, with the install command (`npm i -g arcturn`), the launch command
   (`arcturn acp`), the capability matrix from the table above, and a link to this document.
5. **Declare capabilities honestly.** `loadSession` is `false` unless a host supplies
   transcript replay; `promptCapabilities.image`/`audio` are `false`. Over-declaring is
   worse than under-declaring: clients branch on these.
6. **Document the auth story** — arcturn expects provider API keys in the environment before
   the editor launches it, since `authMethods` is empty.

## Verification

```
npx vitest run packages/cli/src/acp     # 37 passed
npx tsc -p packages/cli/tsconfig.json --noEmit
npx biome check packages/cli/src/acp
```
