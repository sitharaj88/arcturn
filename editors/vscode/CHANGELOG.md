# Changelog

All notable changes to the Arcturn VS Code extension are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The extension and the `arcturn` CLI version separately: the CLI is the engine,
this is one of two front-ends onto it. Each release names the engine it needs.

## [0.3.0] — 2026-08-27

**Requires `arcturn` 0.4.0 or newer.** The panel speaks verbs no earlier engine
answers. Against an older one it still opens — the notice is a warning, never a
block — but history comes back empty and the command menu is bare.

### Added

- **A composer that does the work of the terminal.** Attach files, add context
  with `@`, and run the slash commands — all fourteen of them — from the panel
  instead of switching to a terminal to reach them.
- **The panel follows your editor.** The file you are looking at is offered as
  context, and a selection travels as a line range rather than the whole file.
  A file you merely have open is named, not sent: the model gets the path and
  reads it only if the turn needs it.
- **Session history, in the panel.** Earlier conversations are listed where you
  are working rather than behind a menu, and each row can be deleted.
- **A model picker**, populated by the engine's own catalog.
- **Markdown tables**, so a table an answer contains arrives as a table.
- **Edits shown as diffs.** An expanded `edit` shows the change it makes —
  removed lines above added ones — instead of the JSON that requested it.

### Changed

- **Permission requests are answered in the panel**, as a card beside the
  composer, rather than in a modal in the middle of the screen. Focus lands on
  Deny.
- **The transcript says who spoke by shape.** Your prompt sits in a card and
  the answer runs full width; the `YOU` / `ARCTURN` captions are gone, and the
  speaker is announced to screen readers instead.
- **A finished turn says how long it took**, and offers to copy the answer.
- The panel wears Arcturn's colour, and the composer bar is one send button
  whose state follows the run.

### Fixed

- **Reopening a session brought back an empty panel** — and, less visibly, an
  agent with no memory of the conversation, so the next thing you said was
  answered without any of it.
- **An open file was injected in full on every turn**, whether or not the
  question touched it.

## [0.2.0] — 2026-08-25

- The model picker's first outing, and the fix that stopped a picked model
  routing to the wrong provider.

## [0.1.0] — 2026-08-24

- First release: the Arcturn agent in a native sidebar, terminal integration,
  and honest cost accounting, driven by the same engine as the CLI.
