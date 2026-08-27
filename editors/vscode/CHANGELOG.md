# Changelog

All notable changes to the Arcturn VS Code extension are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The extension and the `arcturn` CLI version separately: the CLI is the engine,
this is one of two front-ends onto it. Each release names the engine it needs.

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
