# Integrating append-only history

On Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block's
signature is bound to the exact prefix that produced it: the system prompt, the
tool set and every earlier message. An account created on or after 2026-08-31
gets a 400 when a replayed block's prefix has changed; other accounts are let
through. The same property is what the prompt cache runs on — a cached prefix
only hits when every earlier byte is identical.

Until the 2026-10-10 "append-only history" wave Arcturn rewrote that prefix in
four places. This note records what each one does now, the seams it crosses,
and what was left undone. The code is in the tree; nothing here is a wiring
recipe still to apply.

"Adaptive Anthropic" below is one predicate, `isAdaptiveAnthropic(spec)` in
`packages/core/src/model-traits.ts`: a thinking-capable model whose
`thinkingStyle` is `adaptive` (declared, or inferred from a Claude 4.6+ id) on
`anthropic`, `anthropic-compatible`, `bedrock` or `vertex`. It is deliberately
broader than the four enforced models; dropping thinking once at a boundary
costs little on the others, and the same defaults keep the cache warm.

## The four rewrites

| Rewrite | Append-only form | Where |
|---|---|---|
| Per-request tool-result elision | Batched, recorded passes; or the provider clears results | `core/src/context-edit.ts`, `agent.ts` |
| Keep-tail compaction | `simple` shape by default; tail thinking stripped under `keep-tail`; or the provider compacts | `core/src/compaction.ts` |
| `tool_search` activation growing `tools` | Native tool search: the array never changes | `core/src/deferred-tools.ts`, `ai/src/providers/anthropic.ts` |
| Operator text injected as user turns | `SystemMessage`, rendered per provider at send time | `types/src/messages.ts`, `core/src/util/content.ts`, each adapter |

### 1. Context editing: passes and a ledger

The old `editContext` comment claimed cache stability. It was wrong. Its
decisions are monotonic — a position elided once is elided identically for ever
after — but the `keepRecentTurns` boundary advances with every assistant
message, so each request stubbed a result the previous request had sent in full.
Monotonic is not append-only. The comment now says so.

What runs instead, in `mode: "local"` (the default):

- `planContextEditPass` decides whether a pass is due. It is due only when it
  would save at least `minCharsPerPass` (default 50,000) characters, and it
  elides everything then eligible in one go.
- A `ContextEditLedger` holds the tool-call ids sent as stubs and the assistant
  messages whose thinking is withheld. Every request is rendered from the
  ledger, so between passes consecutive requests share their whole prefix and
  new results pass through untouched.
- On adaptive Anthropic a pass sets `withholdThinking: "afterFirstElided"`:
  every assistant message after the first touched result stops replaying its
  thinking, because that thinking was produced over the unedited result.
- Each pass is appended to the session as a `state` entry carrying
  `contextEdit: ContextEditRecord` (`{ elided, withholdThinking? }`).
  `materializeBranch` replays them into `MaterializedBranch.contextEdit`
  (`{ elided, withheldThinking: number[] }`) and `Agent.resume` applies it, so a
  resumed agent sends the request the live one would have. Without the record a
  resume would send full results where the original sent stubs.
- The `contextEdit` event fires once per pass; `agent.contextEditPasses` lists
  them.

`mode: "server"` sends the history unedited with `clear_tool_uses_20250919`
(beta `context-management-2025-06-27`) and lets the provider clear results. That
is not a history edit at all, because the provider checks the conversation as it
was sent. `mode: "auto"` is `server` on adaptive Anthropic reached through
`anthropic` or `anthropic-compatible`, `local` everywhere else. Bedrock and
Vertex refuse a server request before it is sent
(`supportsServerContextManagement`). Setting `providers.anthropic.thinkingBinding`
defaults the mode to `auto` (`contextEditingFor` in `cli/src/config.ts`).

### 2. Compaction: three shapes

`CompactionOptions.shape` is `simple`, `keep-tail` or `server`.
`resolveCompactionShape` picks `simple` on adaptive Anthropic and `keep-tail`
elsewhere unless configured.

- `simple` folds the whole history into one summary. Only a trailing run of user
  and system messages — the new request, which carries no thinking — survives
  (`findSimpleCutPoint`). Nothing that a signature check could object to is
  replayed.
- `keep-tail` is the old behaviour. On adaptive Anthropic the kept tail is
  replayed through `withoutThinking`, and the compaction entry records
  `stripTailThinking: true`; a turn that was nothing but thinking is dropped.
  `CompactionResult.keptIndices` maps stripped copies back to their original
  entries so a later compaction's `upToId` still names the right one.
- `server` sends `compact_20260112` (beta `compact-2026-01-12`). Arcturn never
  summarizes locally and replays the returned `compaction` block verbatim.
  `agent.compact()` reports that there is nothing to summarize locally.

No shape folds an open tool round (`hasPendingToolRound`). The summarizer prompt
gained a "Reasoning to carry forward" section because its transcript omits the
assistant's thinking and none of it survives the summary otherwise.

### 3. Deferred tools: native tool search

`DeferredToolset.toolsFor(model)` takes the native path when
`hasNativeToolSearch(spec)` — provider `anthropic`, Claude 4.5 or later. Every
tool is returned in registration order, the deferred ones through a stable
wrapper that sets `ToolDefinition.deferLoading` (`defer_loading: true` on the
wire; the wrapper is cached so requests stay byte-identical). The adapter adds
`tool_search_tool_bm25_20251119`, and arcturn's own `tool_search` is not sent.

The server's matches arrive as `tool_search_tool_result` blocks inside
`serverTool` content. `observe(message)` reads their `tool_references` back into
the activation record — `nativeToolSearchMatches` — marking them native-only, so
they stay `defer_loading` and the tool set never moves. `snapshot().native`
carries the native subset. `replay(messages)` rebuilds the record from a
transcript, arcturn's own `tool_search` results and the provider's alike, and is
what a resume uses; the old behaviour was to forget activations.
`AgentOptions.deferredTools` wires `toolsFor`, `observe` and `replay`;
`getTools(model)` is the lower-level hook.

On every other model the original mechanism runs and an activation grows the
tool set. That is a prefix edit at the very top of the conversation, so the
agent withholds every earlier thinking block (removing a leading run is valid),
records it as `withholdThinking: "all"`, and says so once.

### 4. Operator messages

`SystemMessage` (`role: "system"`, `content: TextContent[]`, `timestamp`,
reserved `clearAt?: "nextUserMessage"`) joins the `Message` union.
`operatorMessage()` builds one. The turn-budget warning, `progressCheck`
notices, the silent-turn nudge and the stale-todo reminder use it; the loop
still emits the matching `notice`.

It is stored model-neutral and rendered when a request is built:

| Target | Rendering |
|---|---|
| Anthropic Opus 4.8 / 5 / 5.5, Fable 5 / 5.1, Sonnet 5.5 | native `role: "system"` |
| Anthropic Sonnet 5, Haiku 5.5, Bedrock, OpenAI-compatible gateways | folded into the neighbouring user turn as a `<system-reminder>` block |
| OpenAI / Azure Chat | native |
| OpenAI Responses | a `developer` item |
| Google | folded, prefixed `[operator]` (`GOOGLE_OPERATOR_PREFIX`) |

On Anthropic the placement is decided from the converted sequence: native only
after a user turn and last or before an assistant turn, never first; the rest
fold. The same history renders the same bytes. Support is inferred from the id
(`ModelCapabilities.systemMessages` wins when set). If the API answers with an
unsupported-role 400, `isSystemRoleUnsupportedError` recognises it by wording,
`markSystemMessagesUnsupported` marks the model for the process, and the request
is retried once folded.

`agent.steer(input, { from })` defaults to `"user"`. The CLI's `/steer`, the
protocol's `steer`, skill steering and background-agent adoption all carry
user-typed or untrusted text; a plain string stays a user message so such text
cannot gain operator authority. `{ from: "operator" }` is text-only (anything
else throws) and exists for a host speaking for itself. Tool output, file
contents and another agent's reply must never ride that channel.

## Telling the API what we did

`providers.anthropic.thinkingBinding: "error" | "drop_block"` sends beta
`thinking-binding-controls-2026-08-01` and
`thinking.block_binding.prefix_mismatch_behavior`. The API reports what it
changed in `input_transformations` (read from `message_start` and from the final
`message_delta`; the later list replaces the earlier). Non-empty lists land on
`AssistantMessage.inputTransformations`, and `inputTransformationNotices` turns
them into notices: `prefix_binding_mismatch` is a warn and says it is a bug in
arcturn; `thinking_mismatch_allowed` is the same on an unenforced account;
`model_binding_mismatch` after a `/model` switch is info. The loop reports and
never retries — the same body would be changed the same way.

## What each surface shows

- `arcturn doctor` prints the compaction shape, context-editing mode and
  thinking binding with a reason for each (`historyShapeEntries`), and warns
  where a configured server shape cannot run on the session model.
- `arcturn export` renders an Operator section per system message, a "the
  provider compacted the conversation here" note with the summary folded, and a
  one-line server-tool note, in Markdown and HTML.
- `arcturn serve` replays a stored system message as an `info` notice, which is
  what the live loop emitted for it.
- Server blocks (`compaction`, `server_tool_use`, `*_tool_result`) are assembled
  whole in the stream and replayed verbatim; a fallback boundary drops the
  abandoned attempt's server-tool blocks but keeps a compaction block.

## Known gaps

- **Bedrock and Vertex** get no `thinkingBinding`, server compaction or server
  tool-result clearing; the last two are refused before the request is sent.
- **A resume across midnight is a head change**, because the system prompt
  embeds the date; earlier thinking is withheld once with an info notice.
- **Elision stubs are re-rendered from the ledger**, not stored byte for byte,
  so a release that rewords the stub text shifts a resumed prefix once.
- **`input_transformations` notices are not audited.**
- **Haiku 5.5 and Sonnet 5 fold** system messages. The brief and the skill docs
  disagree on Haiku 5.5; folding is safe either way.
- **Not verified live:** the streaming shapes of `compaction_delta`, of
  `server_tool_use` input deltas and of `input_transformations` on
  `message_delta`; the exact wording of the unsupported-system-role 400; Bedrock
  accepting `role: "system"`; `defer_loading` plus BM25 discovering tools; and
  `block_binding` alongside the `lowEffort` adaptive spelling. The tests cover
  each against documented shapes, not the API.
