---
title: Checkpoints & /rewind
description: Automatic pre-edit file snapshots, and a non-destructive way back to any earlier turn.
section: Core concepts
order: 8.5
---

## What gets snapshotted, and when

Before a `write` or `edit` call touches a file for the first time in the current turn,
Arcturn records that file's content — or its absence, if it didn't exist yet. Later calls to
the same path in the same turn are no-ops, so what survives is always the state from
*just before* the turn's first change to it.

Storage lives at `~/.arcturn/checkpoints/<sessionId>/`:

```text
manifest.jsonl   append-only log of turn / file / error records
blobs/<sha256>   content-addressed file snapshots
```

A snapshot failure — a permission error reading the file, say — is written to the
manifest as an error record instead of being thrown, so a checkpoint problem never
blocks the `write`/`edit` call that triggered it.

## Only write and edit are checkpointed

`wrapToolsWithCheckpoints` only wraps the tools named in `CHECKPOINTED_TOOL_NAMES` —
`write` and `edit`. A `bash` call that mutates a file (`sed -i`, `mv`, a build script that
regenerates output, `git checkout` overwriting a tracked file) leaves no snapshot at all.
`/rewind` restores exactly what it recorded, nothing more — a file changed only through
`bash` is invisible to it and won't come back. This is the sharpest edge of the feature:
"checkpoint" means "before write/edit," not "before any mutation."

## Rewinding

Run `/rewind` with no argument and you get a picker: **"Rewind to the start of…"**, one
row per turn, newest first, each showing the turn's local time and its label (the first
~44 characters of the prompt that began it), with a description of how many files changed
after that point — `"3 files changed after this point"`.

`/rewind <query>` skips straight to a confirmation when the query confidently matches one
turn and clearly beats the runner-up: `Rewind to "rate-limit the login route"?` with
**Yes, rewind here** (labelled with what matched and a reminder that it restores and
deletes files and can't be undone) or **Show all turns instead**. A query that doesn't
match confidently falls back to the full picker, ranked by relevance, with a note that no
confident match was found — rewinding deletes files, so a guess is not an acceptable
default.

Once a turn is chosen, arcturn:

1. **Restores files.** For that turn and every turn after it, each touched path's
   *earliest* snapshot in the range is applied — files get their pre-change content
   written back, and files that didn't exist yet at that point are deleted. The result
   prints as `Restored <n> files, deleted <n>.`
2. **Forks the conversation.** Arcturn's session tree is exactly this kind of thing: every
   entry has a `parentId`, so pointing at an older entry starts a **new branch** from
   there rather than rewriting history. Nothing already on disk in the session's
   transcript is deleted — the turns you rewound past are still reachable by resuming
   the session at their (now non-current) leaf. On success this prints `Conversation
   forked back to that turn.`

If the turn predates the current process — resumed from an earlier session with no
in-memory link to its conversation leaf — only the files are restored; you get `Files
restored. The conversation link for this turn predates this process, so the transcript
was left in place.` rather than a guessed fork point.

## Interplay with dry-run

Checkpoints wrap *outside* the dry-run overlay: the snapshot is taken from the real path
on the real disk, before the wrapped `write`/`edit` call runs, regardless of where that
call's actual mutation lands. Under `--dry-run`, mutations are redirected to a shadow
tree — `arcturn`'s own docs on dry-run cover this — so the real file on disk never
changes, but the checkpoint manifest still records a snapshot for it every time. In
practice this makes `/rewind` a safe no-op during a dry-run session: there's nothing on
the real filesystem to restore, because nothing on the real filesystem was touched.
Review a dry-run's actual changes with `/diff` against the shadow tree, not with
`/rewind`.

## Non-destructive by design

Rewinding is deliberately *not* "undo": it's a branch, the same way resuming an older
session entry is (see [Sessions](/docs/sessions)). File content that gets overwritten by
a restore is a real disk mutation, but the conversation side never loses anything —
every branch stays walkable by resuming its own leaf. That combination is what makes
`/rewind` safe to reach for mid-task instead of something you only do as a last resort.

## Related

- [Sessions, branching & compaction](/docs/sessions) — the tree that `/rewind` forks;
  read this for what a "branch" actually is under the hood.
- [Provenance & arcturn blame](/docs/provenance) — a sibling store with the same
  content-addressed-blob shape, but for *why* a line exists rather than restoring it.
- [Replay & bisect](/docs/replay-bisect) — a different way to go back in time: re-run
  prompts instead of restoring files.
- The [accountability feature page](/features/accountability) shows `/rewind`'s picker
  and confirmation flow end to end.
