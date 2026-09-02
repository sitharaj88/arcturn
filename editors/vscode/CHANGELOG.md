# Changelog

All notable changes to the Arcturn VS Code extension are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The extension and the `arcturn` CLI version separately: the CLI is the engine,
this is one of two front-ends onto it. Each release names the engine it needs.

## [0.4.0] — 2026-09-02

**Requires `arcturn` 0.4.0 or newer; 0.5.9 unlocks ceiling raise and the
parked-step diagnosis below.**

### A parked run says why, and can be told to spend more

- **The diagnosis rides the question.** When a workflow step parks — it hit a
  role's turn ceiling, or failed outright — the run card now shows what the
  model actually emitted on its last turn under the question itself: model,
  stop reason, block shapes, and the tail of its reasoning when the turn was
  silent. The same fact a terminal park prints; previously the panel showed
  only the 160-character question and left the rest to the session JSONL.
- **"Raise ceiling…"**, offered only when both halves agree: the engine
  advertised `capabilities.ceilingRaise` (`arcturn serve
  --allow-ceiling-raise`) *and* this specific park is the shape a raise
  applies to. The number is collected in a native input box, never in the
  webview — validated as a positive integer greater than the ceiling that
  tripped — because a raise spends the *operator's* money or turns, and this
  extension does not get to make that decision quietly. Pressing it sends the
  same `resumeWorkflow` verb the Answer button already uses, with `raise <n>`
  as the answer. Without the capability, the panel behaves exactly as before:
  Answer, and nothing else.

### Fixed

- The hub walkthrough said "Thirteen" kits; the registry has grown to
  fourteen. The copy is checked against `registry/*.json` in CI now, so it
  cannot drift silently again.

## [0.3.0] — 2026-08-29

**Requires `arcturn` 0.4.0 or newer; 0.5.3 unlocks the mid-run permission chip.**
The extension manages the engine for you from here on.

### The engine installs itself

- **It provisions at startup, in the background.** Activation registers its
  commands and returns; finding, installing or updating the engine happens
  while the editor finishes opening. The first thing you run finds a ready
  CLI instead of triggering an install mid-sentence. Nothing is awaited on
  the activation path.
- **Missing CLI, no setting pinned?** The extension types `npm install -g
  arcturn` into a terminal you can watch, and says so — no dialog to answer
  first. A broken `arcturn.cliPath` still gets the message naming the setting,
  because an install cannot repair a typo.
- **Four open windows are not four `npm install` runs.** The install claim
  lives in profile-wide state with a five-minute expiry, so exactly one
  window starts an install and a cancelled one does not wedge the feature.
- **Once a day it asks npm** whether a newer engine exists, and upgrades the
  same way when one does. The check is throttled through workspace state (a
  window reload is not a registry hit), it is the extension's only network
  request, and every failure is silence.
- **`arcturn.cli.autoUpdate`** (default on) turns both behaviours off in one
  place; with it off, every install and upgrade is offered as a question.
- An engine pinned by `arcturn.cliPath` is never auto-installed over — pinned
  means pinned.

### A home screen that knows you

- The welcome screen's generic starter prompts are gone. In their place:
  **Pick up where you left off** — your three most recent sessions as
  one-click resume buttons; two starters that earn their spot (*Review my
  uncommitted changes*, *Write a commit message*); **Past two weeks** — a
  fourteen-day session-activity strip drawn from data the panel already
  had, one validated brand-hue series with per-day tooltips and a
  screen-reader summary; and a hint line teaching the three gestures worth
  knowing (⌘⌥K, @-attach with drag-from-anywhere, /).

### The panel wears the brand

- The chat sidebar is repainted in Arcturn's own amber — with a separate,
  darker accent for light themes, and everything handed back to the theme
  under high contrast and forced colors. Primary buttons, links, the running
  tool, the permission card, the current-model badge, focus rings, text
  selection and the turn-settled sweep all speak with one voice now; pass,
  fail and danger keep their own colours, because a state is not an identity.
- The permission card borders on the brand at full strength — it is the
  strongest thing the panel says — and its Allow button matches.
- Scrollbars are the theme's own sliders, thin and rounded, instead of the
  browser's default furniture.

## [0.2.0] — 2026-08-29

**Requires `arcturn` 0.4.0 or newer; 0.5.0 unlocks everything.** Every feature
below degrades politely against an older engine — a message naming the
terminal command that does the same job, never a block — but scout
comparisons, MCP resources and prompts, and in-editor MCP authorization need
the 0.5.0 verbs.

### Getting started

- **A walkthrough** (Help → Welcome → "Get started with Arcturn"): install the
  engine, point it at a model, ask something, install a kit, connect a server —
  in the order the failures actually happen, saying the things that surprise
  people. The open file is *named*, not sent; nothing is written without a
  prompt; a key exported in one terminal does not reach an already-running
  engine.

### The editor as a surface

- **Edit the selection in place** (`Cmd+Alt+K` / `Ctrl+Alt+K`). Select lines,
  say what should change, see the proposal as a diff, apply or discard. The
  turn is read-only and the *editor* makes the edit: undo is one entry,
  declining costs nothing, and the change cannot reach outside the selection.
- **Review your changes into the Problems panel.** The uncommitted diff is
  reviewed by the engine and findings land as real diagnostics — clickable,
  with severity, picked up by the existing *Fix with Arcturn* quick fix. Review,
  click, fix, review again, without leaving the editor.
- **A commit message button in the Source Control view.** The staged diff (or
  the working tree when nothing is staged), plus your repository's own recent
  subjects for style, through the engine's Conventional Commits prompt. The
  message lands in the input box for you to edit; nothing is committed.
- **Failed commands are offered, quietly.** A command that exits non-zero
  lights a status-bar item — no toast — and clicking it puts the command, exit
  code and output tail into the composer as a ready question. Ctrl-C, typos and
  successes never trigger it; the next success clears it.

### New panels

- **The Hub**, in the bottom panel: every kit from arcturn.dev/hub — workflows,
  skills, and roles with their tool lanes — browsable offline from a bundled
  catalog, with one-click install and an honest installed/partial/available
  state derived from what the engine actually answers to.
- **Background agents**, beside it: start fire-and-forget work, watch it
  without polling forever (the tree stops asking when nothing is running), get
  told once when something finishes, and fold its findings back into the chat.
- The chat keeps the activity-bar sidebar to itself; both trees live in a
  panel tab next to Terminal and Problems, and can be dragged anywhere.

### Riding the 0.5.0 engine

- **Scout comparisons in the diff editor.** Run competing approaches in
  throwaway worktrees and read each result as side-by-side diffs rather than
  patch text; hand the winning approach to the agent as findings.
- **MCP resources and prompt templates.** Attach what a server publishes — the
  engine reads it at prompt time, inside the same byte budget a file gets —
  preview it as plain text, and run a server's prompt template through an
  argument form into the composer.
- **Authorize OAuth MCP servers from the editor**, including over Remote-SSH,
  devcontainers and Codespaces: the editor catches the redirect through its own
  URI handler, and tokens never leave the engine.

### Sessions

- **A model pick now sticks.** Selecting a model writes `arcturn.defaultModel`,
  so new sessions, engine restarts and window reloads start on it. A session
  reopened from history keeps its own model, deliberately.
- **Export the conversation** as markdown or HTML, saved where you choose.
- **Rewind from the palette**: pick a checkpoint, confirm the same modal the
  panel shows, restore. (Asked for as a Timeline-pane integration; that VS Code
  API is still proposal-only, and this is the closest stable surface.)

## [0.1.0] — 2026-08-27

First release.

**Requires `arcturn` 0.4.0 or newer.** Against an older engine the panel still
opens — the notice is a warning, never a block — but session history comes back
empty and the command menu is bare.

### The panel

- **The Arcturn agent in a native sidebar**, driven by the same engine as the
  CLI. One engine, two front-ends: a session started in the terminal can be
  opened here, and the reverse.
- **A composer that does the work of the terminal.** Attach files, add context
  with `@`, and run the slash commands — all fourteen of them — instead of
  switching to a terminal to reach them.
- **Permission requests are answered in the panel**, as a card beside the
  composer rather than a modal in the middle of the screen. Focus lands on
  Deny.
- **Session history, in the panel** rather than behind a menu, with each row
  deletable, and a model picker populated by the engine's own catalog.
- **Rich transcript.** Markdown including tables; code folded behind its line
  count with a copy button; an expanded `edit` drawn as a diff — removed lines
  above added ones — rather than the JSON that requested it.
- **The speaker is carried by shape**: your prompt in a card, the answer full
  width, and the name announced to screen readers rather than captioned. A
  finished turn says how long it took and offers to copy the answer.

### Context

- **The panel follows your editor.** The file you are looking at is offered as
  context, and a selection travels as a line range rather than the whole file.
- **A file you merely have open is named, not sent.** The model receives the
  path and reads it only if the turn needs it — an open file is not worth tens
  of thousands of tokens a turn on a question that never touches it.

### Terminal and cost

- **Terminal integration**: run the CLI in a VS Code terminal with the
  workspace's own environment, resolved from your login shell so a `PATH` set
  in `.zshrc` is found.
- **Honest cost accounting.** A model with no published price reads as unknown
  rather than as $0.00, because a free-looking run is worse than an unpriced
  one.
