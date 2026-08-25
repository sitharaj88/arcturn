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

- **`Overlay.apply`/`discard` take an optional path subset, and there is still only one applier.**
  The wire's `applyChanges` lets a reviewer land three files out of forty, which is what an editor
  makes natural. That selectivity is a *filter* on the existing `changes()` list, not a second
  write path: the symlink resolution that refuses a destination outside the workspace and the
  temp-file-plus-rename that survives an interrupt are the same lines whether the call came from
  `/apply` in a terminal or from a socket. A second applier would have been a second place to
  forget the symlink check, and the difference would only ever show up on somebody's disk. A full
  apply with no errors still empties the shadow tree, exactly as `/apply` does; a partial one does
  not, because the copies that did not land *are* the pending changes.

- **The overlay restates a redirected tool's permission ask in workspace terms.** Rule enforcement
  does not depend on this — `loop.ts` checks permissions against the tool call's raw `path` before
  the overlay redirects anything, so a denied write never reaches `execute` and never becomes a
  pending change. What this fixes is the *second* ask a tool makes for itself: `write` calls
  `ctx.requestPermission` with the path it was handed, which under dry run is the shadow copy, so
  the prompt named a file under `~/.arcturn/overlays/<session>/` that the user has never heard of
  and the "always allow" it offered would have persisted a rule scoped to a directory `/discard`
  deletes. `wrapToolsWithOverlay` now maps the subject, the description and the suggested
  specifier back to the real workspace path on the way to the engine. The write still goes to the
  shadow copy.

## The serve path's delegation adapters narrow where the caps are

`serve-background.ts` and `serve-org-memory.ts` exist for the reason `serve-mcp.ts` does:
the decision about what a remote caller may ask for is made next to the thing that would
grant it.

- `serve-background.ts` turns `BackgroundAgentManager.start(options)` into
  `BackgroundAgentRegistry.start(task)`. Everything a background agent is capped by — the
  read-only tool set plus `fetch`, `subagent` removed, permission mode `default` never
  `yolo`, the served workspace, the concurrency cap — is a manager default applied to a
  `start()` that did not override it, and this adapter is a `start()` that cannot. It also
  reuses `formatBackgroundTranscript` and `backgroundAdoption` rather than re-rendering or
  re-wording, so a transcript and an adoption read the same in a terminal and over a socket.
- `serve-org-memory.ts` exposes `read`, `propose` and `revoke`, and **not** `approve` or
  `add`. `status: "proposed"` is written literally at the `addOrgMemoryEntry` call site,
  not threaded from a parameter, because there is no parameter. `setOrgMemoryStatus(store,
  id, "active")` — the call `/org memory approve` makes — appears nowhere in that file and
  must not: an active entry is standing instruction text in later runs, and an engine
  cannot tell a frame a person clicked from a frame an agent sent.

Both are reached through `runtime.paths`, which is now shared by four serve features
(checkpoints, workflows, background agents, org memory).

## Gaps / follow-ups

- `/team` and `/scout` are not reachable over `arcturn serve`. `/team` needs an owner lease
  in its records (constructing a `TeamManager` marks another live process's running team
  `interrupted`) and a mid-run guard on `merge`/`discard` before any verb can be honest;
  `/scout` needs durable records before there is anything to list or cancel. See
  `web/content/docs/teams.md#from-a-remote-client`.
- A background agent's spend is folded into neither `/cost` nor `--max-cost`
  (`recordExternalCost` is called for scouts and teams, not for `/bg`), so a
  remotely-started agent is uncapped in dollars exactly as a locally-started one is.
- `serve-org-memory.ts` is read-modify-write over the store file, as every `/org memory`
  invocation already is, so a serve process and a terminal writing at once can lose one
  edit. A lock in one of two writers is not a lock; the fix belongs in `org-memory.ts`.

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

## `serve-rewind.ts`: the recording half and the reading half are one object

`buildSessionAgent` created a checkpoint store per served session and then dropped the
reference. The manifest was being written and nothing could read it back, and nothing
recorded which transcript entry each turn began at — so a served session had file snapshots
and no way to offer them, which is why `/rewind` was unreachable from a remote client for as
long as it was.

`createServeRewind` owns both halves from one map: `serve.ts` hands its store to
`buildSessionAgent` *and* wires the same object as `SessionHost`'s `checkpoints`. That is the
`resolveModel`/`modelCatalog` rule applied before it bit — two stores rooted at the same
directory would list turns nobody recorded and restore blobs nobody wrote, and the symptom
would be a rewind that silently did nothing.

It also does the bookkeeping `CheckpointStore` cannot: the store records *files* and has no
idea which conversation entry a turn began at. `track()` subscribes each agent's `runStart`,
reads `agent.leafEntryId` **synchronously** (the event fires before the user message is
appended, so it still names the pre-turn branch tip — reading it after the await would fork
to a point after the prompt that started it), and opens the checkpoint with the same 60-char
label the TUI uses. The forked agent is tracked too: a rewind that quietly stopped recording
would disable rewinding, and the user would find out the next time they needed it.

## `planRestore` exists so a picker can be honest

`CheckpointStore.restore` used to compute the affected paths and the confinement decision
inline. A remote picker has to show what a choice costs *before* it is made, and computing
that separately would eventually show a file count the restore disagreed with — visible only
on somebody's disk.

So `restore` is now `planRestore` plus the writes: one function decides which paths are in
range and which the `restoreRoot` refuses, and both callers read it. `OUTSIDE_RESTORE_ROOT`
is a single constant for the same reason — a preview and its outcome must not word the same
refusal differently.

## `serve-workflows.ts`: three rules, and the one thing it refuses to half-build

The serve path's four workflow verbs reach the *same* `workflow.ts` the slash command
does — same `discoverWorkflows`, same `parseWorkflow`, same `roleDispatch`, same
`runWorkflow` loop, same `createRuntimeRunStep`, same `createRuntimeWriteLane`, same run
journal. Nothing there is re-implemented. Three decisions are this module's own:

1. **The lane shown is the lane derived.** A catalog row's `roles[].lane` comes from
   `roleDispatch` over the role file's declared `tools:`, and a role the host has not
   loaded is `"unknown"` while one with no `tools:` line is `"undeclared"`. Both fail the
   run before it spends anything, so rounding either down to `"read"` would tell a person
   a pipeline is harmless when the truth is that nobody can say.
2. **A wire budget only ever lowers.** `resolveRunBudget` refuses a request above the
   file's own rather than clamping it, and names both figures. Clamping would be safe and
   dishonest: `listWorkflows` already published the file's ceiling, so the refusal is
   actionable, and a client that asked for $500 and silently got $15 would render a
   ceiling it did not get. The lowered ceiling reaches the engine as a *spread copy* of
   the parsed workflow, so `runWorkflow`'s own `workflow.budgetUsd` check stays the only
   place a budget is enforced.
3. **The permission posture only narrows.** A served run inherits the engine's own mode —
   which is what a person at a terminal in that workspace would get — composed with the
   *calling session's* through `stricterMode`. A remote caller can set their session's
   mode but not the engine's, so the composition can only ever be stricter than a local
   run.

### The thing that is stated rather than half-built

A workflow step's permission asks go to the **runtime's** requester, not the calling
session's. `arcturn serve` installs none on the runtime (each *session* agent gets its own
at `SessionHost.#register`), so `ArcturnRuntime.#ask` fails closed and denies. In practice
a write- or exec-lane role reaches its tools over the wire only on an engine already in
`yolo`, exactly as under `--print`.

The fix that was rejected: `ArcturnRuntime.createSubagent` takes no `onPermissionAsk`
override, so routing those asks to the caller would mean holding
`setPermissionRequester` for the length of a run — a process-wide mutation that races
every other session the same engine is hosting. An honest closed failure beats a racy
feature, and this one errs in the safe direction.

### Narration is `notice`, and the wire has no `WorkflowEvent`

`WorkflowEvent` is deliberately its own union with no `AgentEvent` counterpart (stages,
branches and skips have none), and it stays off the wire. The serve path narrates through
`reportWorkflowEvent` — the *same* function the TUI narrates with — into `notice` events
on the calling session's stream, plus the sub-agent republication `createRuntimeRunStep`
already does through its `emit`. So a panel and a terminal show the same sentences for the
same run, and no second event channel was invented.

The one place the two surfaces differ is the run's final text: the terminal prints all of
it, and the wire caps it at `WORKFLOW_RESULT_TEXT_MAX_CHARS` (64 KiB) because one `notice`
is one WebSocket frame and `ws-server.ts` treats a megabyte of buffered output as
backpressure. What is cut is said to be cut, and the whole of it is still in the run's own
directory.

### `runtime.emit` is finally wired — on this path

`WorkflowCommandRuntime.emit` has existed since the live-region work and `ArcturnRuntime`
never implemented it, so in the terminal a workflow step's child agent is not republished
today. The serve path passes an `emit` straight into `createRuntimeRunStep`, so over the
wire it is. That is not a fix to the TUI gap; it is the same seam, used.

### A run id is a path segment, and `isSafeRunId` treats it as one

`join(runsRoot, runId)` names the directory `workflowStatus` reads and
`resumeWorkflow` appends to, and the id arrives from a client. A token holder
already has a shell, so this is not the wall that keeps them out — but a verb
that joins a client string onto a root without checking it is how a *later*
caller with less authority inherits a traversal, and this repository has shipped
that shape once already.

The check is on the **shape** (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `.`/`..`) rather
than on a resolved path, because the shape is something this module owns: ids
are minted by `createRunId` and `20260825T134500-a1b2c3d4` has no reason to hold
a separator. It refuses rather than sanitising, on the rule the rest of the file
keeps — a rewritten id would read a *different* run than the caller named.

The two verbs answer differently on purpose, and it is the same split as
everywhere else: `workflowStatus` degrades, so it answers zero rows (an in-band
`invalidRequest` would be read as "this engine is too old"); `resumeWorkflow`
does not, so it refuses loudly — and it is the one that would have *appended* to
whatever directory the id named.
