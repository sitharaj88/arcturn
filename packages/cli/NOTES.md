# arcturn — implementation notes

Design decisions, friction with the packages this one composes, and known gaps. Nothing outside
`packages/cli/` was modified; every item below is a local work-around or a deliberate choice.

## Friction with other packages (worked around locally)

### 1. Small context windows make core compact on every turn

`shouldCompact(tokens, contextWindow)` in `@arcturn/core` computes
`threshold = contextWindow - DEFAULT_RESERVE_TOKENS (16 384)` and, when that is `<= 0`, returns
`tokens > 0`. Any model with a window at or below ~16k therefore triggers automatic compaction on
every single turn, and because a fresh conversation has no turn boundary to cut at, the user sees
`Nothing to compact: no turn boundary old enough to summarize.` before every response. This is easy
to hit with a local Ollama/llama.cpp model registered through an extension.

**Work-around:** `compactionOptionsFor(model)` in `src/runtime.ts` scales both knobs to the window
(`reserveTokens = clamp(0.15 × window, 1 024, 16 384)`,
`keepRecentTokens = clamp(0.4 × window, 2 048, 20 000)`) and is passed to every agent and sub-agent.
Large models keep core's defaults exactly.

**Suggested upstream fix:** make the defaults proportional to `contextWindow`, or have
`shouldCompact` return `false` when there is nothing compactable.

### 2. Compaction options are fixed at agent construction

`AgentOptions.compaction` cannot be changed afterwards, so `/model` (and `ArcturnRuntime.setModel`)
switches the model but leaves the compaction budget of the previous one in place until the next
`/clear` or resume. A `setCompaction()` on `Agent`, or reading the budget from the live model,
would fix it. In practice the clamp above only differs between very small and very large windows,
so the mismatch is harmless.

### 3. `PermissionRequester` cannot know the id it is answering

`PermissionRequester` receives `Omit<PermissionRequest, "id">` but `PermissionDecision` requires a
`requestId` (already recorded in `packages/core/NOTES.md`). Every requester here therefore returns
`requestId: ""` and relies on the engine overwriting it.

### 4. No event for a steering message

Steering text injected mid-run has no `AgentEvent` (also in `packages/core/NOTES.md`), so the
interactive app prints its own `› …  (steering the run)` line rather than rendering an event. If a
`userMessage` event is ever added, `TranscriptFormatter` should render it and the app should stop
printing it by hand.

### 5. `Editor` consumes `Ctrl+D`

`@arcturn/tui`'s `Editor` maps `Ctrl+D` to forward-delete, and `TUI.onKey` handlers only fire for
keys no component consumed — so "exit on `Ctrl+D` with an empty buffer" is unreachable from a global
handler. `PromptEditor` (`src/interactive/widgets.ts`) subclasses `Editor` and intercepts the key
before `super.handleInput`. An `EditorOptions.onEof` hook upstream would remove the subclass.

### 6. Enter is swallowed by the completion dropdown

With the dropdown open, `Editor` maps `Enter` to "accept completion", so typing `/help` + `Enter`
would complete rather than submit and every slash command would need two presses. The autocomplete
provider returns `[]` when the typed text is already the only match, which closes the dropdown and
lets `Enter` submit. A `submitOnExactMatch` option upstream would be cleaner.

### 7. `TUI` has no suspend/resume for scrollback

Per `packages/tui/NOTES.md`, content that scrolls off a frame is gone, and the advice is to print
transcript lines directly and keep only the live UI in the `TUI`. There is no API for "erase your
block, let me write, then repaint", so `InteractiveApp.flushScrollback()` builds one out of public
calls: `setComponents([])` + `renderNow()` makes the differential renderer erase its own block and
park the cursor at row 0 of it, the transcript is written there with `\r\n` line endings (raw mode
needs the CR), then the live components are restored and re-rendered. It works because the renderer
tracks its position relatively; a `tui.suspend()` / `tui.resume()` pair would be less subtle.

Related: `TUI.setComponents([])` does **not** clear an overlay, so the erase trick would compose a
frame containing the dialog. Transcript output is therefore queued while a modal is open and
flushed when it closes — which is also the behaviour you want.

### 8. `BackgroundTaskManager` emits no events

`backgroundTaskStart` / `Output` / `End` exist in the contract, and `TranscriptFormatter` renders
them, but `@arcturn/tools` never emits them (noted in `packages/core/NOTES.md` too). Background
bash tasks are therefore only visible through the `bash` tool's own result. The formatter code is
ready for the day the events appear.

### 9. `createDefaultTools` has no read-only subset

Sub-agents get a read-only tool set by filtering the parent's tools against
`DEFAULT_READ_ONLY_TOOLS` from `@arcturn/core`. That couples two packages through a name list; a
`readOnly: Tool[]` field on `DefaultTools` would be more honest.

## Deliberate choices

- **The runtime owns the agent, not the other way round.** `/clear` and `/sessions` replace the
  `Agent`, so the UI subscribes to `ArcturnRuntime.subscribe()` — a stable subscription that is
  re-attached to each new agent — instead of `agent.subscribe()`.

- **Extensions load before the model is resolved.** Otherwise an extension calling `registerModel()`
  could never provide the model named by `--model`, because resolution would already have failed.

- **Arcturn's own packages are aliased for extensions.** Extension modules live in `~/.arcturn` or
  `<cwd>/.arcturn`, where a bare `@arcturn/ai` import cannot resolve. `arcturnPackageAliases()` maps them
  to the absolute files this build already loaded, which also guarantees one module instance — so an
  extension mutating the model catalog mutates the catalog the CLI reads. Non-Arcturn bare imports still
  resolve relative to the extension file, so an extension needing third-party packages must live
  inside a directory with its own `node_modules`.

- **`bash` "allow always" widens to a command prefix.** The runtime suggests an exact-subject rule,
  which is right for a path and useless for a command. `suggestRule()` rewrites bash subjects to
  `<first word> *`; every other tool keeps the runtime's suggestion.

- **Session-scoped rules are never written to disk.** `persistPermissionRule` returns `undefined`
  for them; "allow always" from the dialog is explicitly `project` scope.

- **Sessions are bucketed by a hash of the working directory** (`~/.arcturn/sessions/<sha256(cwd)[0..16]>`),
  so `--continue` can only ever pick up work started in the same place.

- **`--print` denies rather than asks.** A headless run has nobody to prompt, so a check that
  reaches the requester is denied with a message the model can act on, plus one hint per
  tool+subject on stderr. Exit code is `0` only for `runEnd.reason === "completed"`.

- **stdout stays clean in `--print`.** Text mode writes only the final assistant message; JSON mode
  writes only NDJSON events. Notices, denials and errors go to stderr.

- **Interactive mode refuses a non-TTY stdout** (exit `2`) rather than rendering escape sequences
  into a pipe, and points at `--print`.

- **Streaming is throttled, not per-token.** Markdown is re-rendered at most every 60 ms while text
  streams; the live block is clipped to its tail so a long answer cannot push the editor off screen.

- **`Ctrl+C` is contextual:** it interrupts a run; twice in a row while idle it exits. `Esc`
  interrupts a run or clears the editor. `Ctrl+D` exits on an empty buffer only.

- **The transcript formatter is the single renderer of events**, shared by the TUI and available to
  programmatic users, so a new event type only needs handling in one place.

## Gaps / follow-ups

- `/compact` and `/clear` refuse while a run is in flight instead of interrupting it first.
- `--resume` accepts any session id, including one recorded in a different directory; the store is
  per-directory so it will simply not be found.
- Prompt history is per-process; it is not persisted between runs.
- No `@`-completion for file paths in the editor — only `/` for commands.
- Images are accepted by the contracts but there is no way to attach one from the CLI.
- `--print` has no stdin mode (`echo … | arcturn -p`); the prompt must be an argument.
- MCP resources and prompts are not surfaced (`McpManager.listResources` / `listPrompts` exist);
  `/mcp` only reports connection state and tool counts.
- The theme is `dark`/`light` only; `createTheme` from `@arcturn/tui` is not exposed to config or
  extensions yet.
- `src/test-helpers/` (the scripted `LLMClient` and the scratch-directory helpers) is excluded from
  the build, so it is not part of the published API. If the server package wants the same fake
  client it should move somewhere shared.
