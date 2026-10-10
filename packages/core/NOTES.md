# @arcturn/core — implementation notes

Design decisions, contract friction and deliberate gaps recorded while building the
runtime. Nothing in `packages/types` was modified; every item below is a local
work-around or a documented choice.

## Contract friction (worked around locally, `types` untouched)

1. **No `PermissionEngineOptions` in `types`.** `AgentOptions.permissions` is typed
   against a core-owned `PermissionEngineOptions` (`src/permissions.ts`). If the
   contract package ever grows one, the two should be reconciled.

2. **`PermissionRequester` takes `Omit<PermissionRequest, "id">` but
   `PermissionDecision` requires a `requestId`.** A requester therefore cannot know
   the id it is answering. The engine works around this by generating the id,
   emitting the full `PermissionRequest` on the event stream, and **overwriting**
   `decision.requestId` with its own id after the requester returns. Hosts can put
   anything (e.g. `""`) in that field.

3. **No event for a user message that is not the run prompt.** `runStart` carries
   the prompt, `messageEnd` carries assistant messages and `toolEnd` carries tool
   results, but steering messages injected mid-run have no event of their own. They
   appear in `agent.messages` and in the session file; UIs that need to render them
   live must diff `messages` or subscribe to the session store. A
   `userMessage` event in `AgentEvent` would close this gap.

4. **`SessionEntry` has no "run boundary" kind.** Runs are inferred from message
   roles. `kind: "label"` is accepted and replayed but the runtime never writes one.

5. **`ToolExecutionContext` has no handle on the owning agent.** Tools that own
   agent state (todo, plan, subagent) need one, so core adds a local
   `BindableTool` interface (`src/state.ts`): a tool may expose
   `bindAgent(controller)`, and `Agent.setTools()` calls it. Plain `Tool`s are
   untouched, so the contract still holds. Bindable tool instances must not be
   shared between agents — the last `bindAgent` wins.

6. **`AssistantMessage.usage` has no per-turn/aggregate distinction.** `turnEnd`
   reports the turn's own usage; callers that want a running total should sum it
   (`addUsage` is exported for that).

## Deliberate behavioural choices

- **Event order.** `runStart → turnStart → messageStream* → messageEnd →
  (toolStart → permissionRequest/permissionDecision → toolUpdate* → toolEnd)* →
  turnEnd → … → runEnd`. `turnEnd` is emitted *after* the turn's tool batch, so a
  turn covers the model response and the work it caused.

- **Errors are data.** `Agent.prompt()` resolves for every runtime failure and
  reports it as `runEnd { reason: "error", errorMessage }`. The single exception is
  calling `prompt()` while a run is in flight, which throws — that is a caller bug,
  not a runtime failure. Use `steer()` instead.

- **`maxTurns` (default 64) ends the run with `reason: "error"`** plus a `notice`,
  rather than `"completed"`: the model did not finish, and callers checking
  `runEnd.reason` should see that.

- **Aborts never leave dangling tool calls.** If a stream is interrupted after the
  model emitted tool calls, core appends synthetic `isError` tool results
  ("Aborted by the user.") for every unanswered call, so the next request is still
  a valid conversation. Incomplete tool calls (a `toolCallStart` with no
  `toolCallEnd`) are dropped from the partial assistant message entirely.

- **Read-only tools are allowed by default.** After rules are evaluated and before
  the mode checks, `read`/`grep`/`glob`/`ls`/`fetch` resolve to `allow`. Prompting
  for every file read makes `default` mode unusable in practice. An explicit
  `deny` rule still wins, and the list is configurable via
  `permissions.readOnlyTools`.

- **No requester means deny.** With no `onPermissionAsk` and no matching rule, a
  check is denied with an explanatory message rather than being assumed safe.
  Headless callers should set `permissions.mode: "yolo"` or supply rules.

- **Permission precedence.** scope (`session` > `project` > `user`) → specificity
  (exact specifier > glob > wildcard, exact tool > `*`) → `deny` wins a tie →
  array order. `plan` mode is checked *before* rules, so no stored rule can
  unblock a mutating tool while planning.

- **Path specifiers are matched the way the filesystem matches them.** Both `/` and
  `\` are separators in a glob (so `**/.env` denies `C:\repo\.env`, and `C:\repo\*`
  cannot widen into a subtree), and a path comparison folds case wherever the
  filesystem does — probed once against the real filesystem, not guessed from
  `process.platform`, because a stock macOS is case-insensitive too. Commands and
  URLs stay byte-exact: `argv` is case-sensitive everywhere. Override per call with
  `matchSpecifier(spec, subject, { caseInsensitivePaths, kind })`, or per engine with
  `new PermissionEngine({ caseInsensitivePaths })`.

- **The plan-mode exit gate bypasses rules.** `createPlanTool` calls
  `PermissionEngine.ask()` directly rather than `check()`, so a blanket
  `{ tool: "*", action: "allow" }` rule cannot silently approve leaving plan mode.
  `todo` and `plan` are in `alwaysAllowTools` and are never gated or announced.

- **The loop gates every tool call** using a subject derived from well-known
  argument names (`command`, `file_path`, `path`, `url`, `pattern`, `query`,
  `target`; see `defaultSubject`). Tools may also call `ctx.requestPermission`
  themselves for a finer subject; decisions are cached per `toolCallId + subject`
  for the duration of that call, so the two paths never double-prompt.

- **Hook order.** `beforeToolCall` runs *before* `toolStart` is emitted, so the
  event shows the effective (possibly rewritten) input. Rewritten input is then
  schema-validated like any other. `afterToolCall` sees every result, including
  blocked, denied, invalid-argument and failed calls.

- **Compaction leaves two consecutive user messages.** The summary is its own
  synthetic user message and the kept tail starts at a user message (the only cut
  point that can never split an assistant tool call from its results). Providers
  that require strictly alternating roles must merge them in the `ai` layer.

- **A failed summarization is non-fatal.** It emits a `notice` (level `error`) and
  a `compactionEnd` with an empty summary and unchanged token counts, then the run
  continues with the uncompacted history.

- **Token estimation is deliberately cheap**: the last assistant message that
  reported real usage anchors the count, and everything after it is estimated at
  ~4 characters per token. No tokenizer, no provider dependency.

## Gaps / follow-ups

- `parallelTools` is implemented but off by default; there is no per-tool opt-in
  (e.g. "read-only tools may run concurrently") yet.
- Compaction never re-compacts an existing summary; a very long session
  accumulates one summary plus tail, which is fine in practice but unbounded in
  theory.
- `JsonlSessionStore.setTitle` rewrites the whole file through a temp file and a
  rename. Fine for interactive use, not for very large sessions.
- The scripted `LLMClient` used by the tests lives in `src/test-helpers/fake-llm.ts`
  and is excluded from the build by `tsconfig.json`, so it is not part of the
  published API. If other packages want it, it needs to move out of
  `test-helpers/` and be exported from `src/index.ts`.
- `backgroundTask*` events exist in the contract but belong to the `tools`
  package; core neither emits nor interprets them.

## Append-only history (preserved thinking)

- **The outgoing prefix only grows.** On Claude Fable 5.1, Opus 5.5, Sonnet
  5.5 and Haiku 5.5 a thinking block is bound to the exact prefix that
  produced it, so every deliberate rewrite of already-sent history is
  recorded and replayed: local context editing runs in rare *passes*
  (`planContextEditPass` + `ContextEditLedger`, persisted as `state` entries
  with `contextEdit`), and a pass stops replaying the thinking produced over
  the results it rewrote. The old `editContext` claim of cache stability was
  wrong — its boundary moved every turn — and is corrected in its comment.
- **"Adaptive Anthropic" is the one predicate** (`isAdaptiveAnthropic`:
  thinking-capable, `thinkingStyle: "adaptive"` declared or inferred from a
  Claude 4.6+ id, on anthropic / anthropic-compatible / bedrock / vertex). It
  picks simple compaction by default, strips a kept tail's thinking, and
  withholds thinking at a pass. That is broader than the four enforced
  models; dropping thinking once at a boundary costs little on the others.
- **A changed `system`/`tools` head withholds every earlier thinking block**
  (removing a leading run is valid) and says so once. This catches arcturn's
  own deferred-tool path, MCP attach, and a system prompt that changed. The
  head's fingerprint (system + non-deferred tools) is written to the session
  as a `state` entry whenever it changes, so a resume compares against it: a
  removed MCP server or a new day's system prompt withholds instead of
  replaying thinking the API would refuse. A `defer_loading` tool that is
  merely *added* is not a head change (the cached prefix and the binding both
  ignore it); one that was there and is gone or edited is.
- **State entries written from the synchronous request-shaping path** (a pass,
  the head, `setModel`) are stamped at once and settled by the next awaited
  append, so a failed write fails that append instead of leaving later entries
  parented on an entry that never reached the file.
- **`pauseTurn` is a stop, not an end.** The provider paused a server-side
  tool loop; the loop re-sends the conversation unchanged (no steering, no
  nudge between a server tool and its continuation), up to
  `MAX_CONSECUTIVE_PAUSES`, then ends the run with a notice.
- **Nothing model-authored rides the operator channel.** The stale-todo
  reminder counts the unfinished items instead of quoting them: the todo text
  is the model's, and may have been planted by a tool result.
- **`steer()` stays the user's.** The brief suggested turning a string steer
  into an operator message; the CLI's `/steer`, the protocol's `steer`, skill
  steering and background-agent adoption all carry user-typed or untrusted
  text, so the default is unchanged and `{ from: "operator" }` opts in.
  Untrusted text (tool output, another agent's reply) must never ride the
  operator channel.
- **Native tool search keeps the set fixed.** `DeferredToolset.toolsFor` sends
  every tool on first-party Anthropic 4.5+, the deferred ones `deferLoading`,
  without arcturn's `tool_search`; server activations land on the record via
  `observe` and stay deferred (`snapshot().native`), so the set never moves.
  `replay` rebuilds activations from a transcript on resume.
