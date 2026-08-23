---
title: Project memory
description: Durable notes the agent writes for itself, read back into every later session's prompt.
section: Core concepts
order: 8.9
---

## The gap this fills

A static `ARCTURN.md` captures what you know up front. It cannot capture what the agent
*discovers mid-task* — "the flaky test is `foo.test.ts:42`, rerun with `--retry`," "this
repo's build script writes to `dist/` even on failure, don't trust its exit code alone."
Without somewhere to put facts like that, every new session relearns them from scratch.
The `memory` tool is that somewhere: small markdown notes the model writes for its own
future self, loaded back into the system prompt on the *next* session.

## Where notes live

One file per note, under `<cwd>/.arcturn/memory`, named `<slug>.md`:

```markdown
---
title: Flaky test workaround
---
`foo.test.ts:42` is flaky under load; rerun with `--retry 2`.
```

Only `title` is recognized in frontmatter — the parser is hand-rolled (no new dependency
for it), mirroring the same tiny fence format `skills.ts` uses. A slug is normalized to
`[a-z0-9-]`; anything the model supplies that looks like a path (`/`, `\`, `..`) is
rejected outright rather than sanitized, and the resolved path is re-checked against the
memory directory as a second layer of defense. Both checks mean a `memory` write never
requests permission — every path it can touch is confined to the memory directory by
construction, not by asking you.

Each note is capped at `MAX_MEMORY_NOTE_BYTES` — 8 KiB of UTF-8 — so a long finding has to
be summarized before it's saved, not dumped wholesale. Writes are atomic (temp file, then
rename), so a crash mid-write can't leave a half-written note behind.

## Under `--dry-run`

Memory writes are file writes like any other: under `--dry-run` they land in the shadow
overlay tree instead of the real `.arcturn/memory`, so `/diff` shows a new note the same
way it shows any other change, and `/discard` throws it away with everything else. Nothing
the agent "remembers" during a dry-run session survives past it unless you keep the run.

A scout or a served session rooted somewhere other than the main workspace resolves its
own memory directory from its own `cwd` rather than the main project's — a scout running
in a throwaway worktree writes notes into `<worktree>/.arcturn/memory`, not into your real
repository.

## How it reaches the prompt

Memories load once, at startup, alongside skills and named agents. `loadMemories` reads
every `.md` file in the directory (a missing directory is fine — no notes yet — and an
unreadable or empty-bodied file is skipped with a warning, never a hard failure) and
`formatMemoriesForPrompt` renders them newest-first into a `# Project memory` section,
placed after `# Environment` and before any specialized-agent listing. The rendering is
capped at `DEFAULT_MEMORY_PROMPT_MAX_CHARS` (4,000 characters) with a trailing
`…(truncated)` marker, the same truncation shape `ARCTURN.md` itself gets.

**This is not live.** The system prompt is built once, when the session starts. A note
the agent writes with `memory write` mid-session is not visible to itself until the *next*
session — nothing re-renders the prompt after a write. If the agent needs its own new note
within the same session, it already can: nothing stops it calling `memory list` again, the
same way it would re-read any file it just wrote.

## The tool

`memory` takes one `action`:

- **`write`** — `{ action: "write", content, slug?, title? }`. `slug` (validated,
  normalized) or `title` (used to derive a slug) is required; `content` is the note body.
  Returns `Saved memory "<slug>" (<title>).`
- **`list`** — no arguments. Returns each stored slug and title, e.g.
  `2 memories stored:\n- flaky-test-workaround: Flaky Test Workaround\n- …`.
- **`delete`** — `{ action: "delete", slug }`. Returns whether the note existed and was
  removed, or that there was nothing to delete.

There is no `edit`: to change a note, the model deletes and rewrites it, or you edit the
markdown file directly.

## Pruning

Nothing prunes automatically — a note stays until it's deleted. Two ways to remove one:

- Ask the agent to call `memory delete <slug>` (or just tell it a note is stale and let it
  decide).
- Edit or delete the file directly under `<cwd>/.arcturn/memory` — it's plain markdown,
  no database, no index to keep in sync.

Because memory is model-written rather than human-curated, it can drift from reality — a
file gets renamed, a workaround stops being needed. The system prompt says so explicitly
("Notes you recorded in earlier sessions… write more with the memory tool") but does not
independently verify anything; treat an old note as a hint to check, not as ground truth,
the same caution the prompt itself asks the model to exercise.

## Related

- [Markdown skills](/docs/skills) — the sibling `.md`-file mechanism this reuses the
  frontmatter format from.
- [Dry run & sandbox](/docs/dry-run) — where a memory write actually lands under
  `--dry-run`.
- [Sub-agents, plan mode & todos](/docs/sub-agents) — `todo` and `plan` are the other two
  state tools that ship alongside `memory`, both non-durable by contrast.
