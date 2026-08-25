# RFC 0004 — The VS Code extension

Status: accepted · Author: Sitharaj Seenivasan · 2026-08-24

## 0. One engine, two front-ends

The extension is a client of the Arcturn engine, never a second copy of it.
Every capability reaches VS Code through one of exactly two boundaries:

1. **The terminal** — the TUI running in a VS Code terminal, unchanged.
2. **The protocol** — `@arcturn/protocol`'s `ProtocolClient` speaking NDJSON
   over WebSocket to `arcturn serve`.

The failure mode this document exists to prevent is extension-only logic: a
feature that works in the sidebar but not the CLI, a second config file, a
private fork of permission handling. If a capability is not in the engine,
the extension does not have it — it gets added to the engine first, behind
the same tests, and the extension picks it up through the protocol.

State is shared because there is only one state: `~/.arcturn` auth, config,
sessions and packages. A session started in a terminal is resumable in the
sidebar and vice versa, because both are clients of the same session store.

## 1. What ships

### Stage 1 — presence (the terminal integration)

- **CLI provisioning.** On activation, resolve `arcturn` — the
  `arcturn.cliPath` setting first, then PATH. Missing → one notification
  offering `npm install -g arcturn`, run in an integrated terminal so the
  user sees exactly what executes. Never install silently. Version-check on
  every activation; offer the upgrade when the extension needs a newer engine.
- **Terminal command.** `Arcturn: Open` launches the TUI in a dedicated
  terminal (icon, name "Arcturn"). One terminal per workspace folder;
  re-invoking focuses the existing one.
- **@-mentions from the editor.** `Arcturn: Send Selection` and
  `Arcturn: Send File` type an `@file:line-line` mention into the Arcturn
  terminal. A code action on any diagnostic — "Fix with Arcturn" — sends the
  file, range and diagnostic text.
- **Settings**: `arcturn.cliPath`, `arcturn.defaultModel`,
  `arcturn.serve.enabled`, `arcturn.serve.port` (0 = ephemeral).

### Stage 2 — the native surface (the protocol client)

The sidebar is a `ProtocolClient` consumer. The client interface is already
shipped and the extension builds against it verbatim — `authenticate`,
`listSessions`, `createSession`, `openSession`, `prompt`, `steer`, `abort`,
`setModel`, `respondToPermission`, `onEvent`, `close` — and **nothing else**:
a sidebar feature that needs a verb this list lacks is an engine RFC, not an
extension hack.

> **Amendment (2026-08-25).** The model picker below was the first feature to
> hit that rule, and it was resolved the way this section prescribes: the
> engine gained a `listModels` verb (see
> [Server mode](/docs/server-mode#the-model-catalog)), and the list above is
> now that list plus `listModels`. The verb is optional — an engine that
> predates it answers `invalidRequest` and the client resolves `undefined` —
> so the extension still runs against an older `arcturn serve`.
>
> **Amendment (2026-08-25, second).** The sessions view hit it twice more.
> Opening a session from the history list showed an *empty chat*: `openSession`
> subscribes to future events and replays nothing, and the panel had no verb to
> ask what was already said. Reconstructing it extension-side — reading
> `~/.arcturn/sessions` directly — is exactly what §0 forbids, so the engine
> gained **`sessionHistory`** instead (see
> [Server mode](/docs/server-mode#replaying-a-session)); it replays
> `AgentEvent`s so the panel's existing reducer builds the transcript with no
> new client logic. Deleting a session had the same shape and a sharper edge —
> an extension that unlinked the file itself could not see a session still live
> in the engine, nor refuse one mid-run — so the engine gained
> **`deleteSession`** (see
> [Server mode](/docs/server-mode#deleting-a-session)). Both are optional and
> additive; `PROTOCOL_VERSION` stays `1`. The frozen list above is now that
> list plus `listModels`, `sessionHistory` and `deleteSession`.

> **Amendment (2026-08-25, workflows).** The rule held again, for the largest
> feature yet to hit it. A markdown workflow — a numbered list that is real
> control flow, an `@role` per step with its own tools and its own lane,
> `budgetUsd` capping a run, `ORG-ASK:` stopping it for a person — was
> terminal-only, and a panel attached to an engine full of pipelines could not
> see that they existed. Reading `.arcturn/workflows` extension-side and
> deriving a role's lane there is exactly what §0 forbids, and it would have
> been the worst version of it: the lane is the sentence that says whether a
> pipeline can rewrite your checkout, and a second derivation of it would be a
> second answer to that question. So the engine gained **`listWorkflows`**,
> **`runWorkflow`**, **`workflowStatus`** and **`resumeWorkflow`** (see
> [Server mode](/docs/server-mode#workflows)), answered by the same engine
> `/workflow` drives. All four are optional and additive; `PROTOCOL_VERSION`
> stays `1`. The two reads degrade, the two that start work do not.
>
> The panel follows a run on the session event stream it is already subscribed
> to — a workflow's progress arrives as the same `notice` events the terminal
> prints — so no second channel was added to satisfy a client, which is the
> other half of what §0 is for.

- **Server lifecycle.** The extension spawns `arcturn serve` per workspace on
  a loopback ephemeral port with a generated token, hands the token to the
  client via the URL fragment, and never writes it to logs, settings or
  globalState. Serve dying → sidebar shows a reconnect card, never a stack
  trace.
- **Chat view.** A webview: streamed assistant text, tool calls as collapsible
  rows with live arguments, thinking collapsed by default, todos rendered.
  Prompt box supports mid-turn steering (`steer`) and abort.
- **Permission dialogs.** `permissionRequest` events surface as native VS Code
  modals naming the tool and its arguments; the answer goes back through
  `respondToPermission`. The dialog renders what the engine sent — it never
  re-derives or paraphrases the request.
- **Cost in the status bar.** Live session spend from usage events, honest per
  RFC-current behavior: `$0.42`, `$0.42+` when partly priced, `n/a` when the
  model publishes no pricing. Click → a cost breakdown quick-pick.
- **Model picker.** Quick-pick fed by the engine's catalog (`listModels`) —
  context window, price and credential presence per row — plus any model the
  session announced, `arcturn.defaultModel`, and a free-text entry; switch via
  `setModel`.
- **Sessions view.** `listSessions` for this cwd; open, resume, or start new.

### Non-goals (this RFC)

Marketplace publication (user-triggered, like npm releases), bundling the CLI
inside the VSIX (provisioning covers it; revisit if telemetry shows drop-off),
JetBrains (same client, later), ACP changes (Zed is already served), and any
write path that bypasses the engine's permission rules.

## 2. Layout and ownership

`editors/vscode/` — a workspace package, `"private": true` so `pnpm publish
-r` never touches it. Biome and the root vitest config cover it like any
other package. Bundled with esbuild to one `dist/extension.js`; packaged with
`@vscode/vsce`; icon derived from `web/public/icon-512.png`.

Two builders, disjoint ownership, one declared seam:

- **Builder A — the shell.** `package.json` manifest (activation events
  narrow, never `*`), activation, CLI provisioning, terminal integration,
  mentions and code action, settings, keybindings, esbuild + vsce config,
  README (footer per project convention), tests for all of it.
- **Builder B — the client surface.** `src/serve/` (server lifecycle + token
  handling), `src/sidebar/` (chat webview, permission bridge, cost status
  bar, model picker, sessions view), tests for all of it — including
  `ProtocolClient` driven through a fake `WebSocketLike`, which the protocol
  package's structural typing makes dependency-free.
- **The seam.** B exports `activateSidebar(context, resolveCli): Disposable`
  from `src/sidebar/index.ts`; A calls it exactly once, gated on
  `arcturn.serve.enabled`. Neither builder edits the other's files.

## 3. Industrial-standard is a checklist, not an adjective

- Strict TypeScript, zero `any` beyond what `biome` already tolerates; biome
  clean; every behavior with a test that was watched failing first.
- Webview hardened: strict CSP, no remote content, `retainContextWhenHidden`
  off unless measured necessary, all messages validated at the boundary.
- The serve token is treated as a credential (per `serve.ts`'s own doc): held
  in memory, redacted from any error path.
- Activation cost: no protocol connection, no server spawn, until the user
  opens the sidebar or runs a command.
- Accessibility: every command reachable from the palette; webview usable
  with keyboard alone; theme-aware (VS Code tokens, light and dark).
- `vsce package` succeeds from a clean checkout and the VSIX is the CI
  artifact; publish is a human's click, per this repository's release law.
- The extension never writes to `~/.arcturn` config; it reads engine state
  through the engine.

## 4. Acceptance

Stage 1 demo: open folder → notification installs CLI → `Arcturn: Open` →
select code → send with range → fix lands in TUI. Stage 2 demo: sidebar chat
streams a tool call, a permission modal answers it, the status bar ticks real
dollars, and killing the serve process shows a reconnect card. Both run from
a VSIX installed into stock VS Code.
