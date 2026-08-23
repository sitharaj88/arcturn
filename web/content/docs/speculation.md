---
title: Speculative approval
description: While a permission prompt sits in front of you, the agent keeps working in a shadow overlay instead of sitting idle.
section: Core concepts
order: 5.25
---

## The idle problem

A permission prompt stops the agent dead: it asked to run something, and now it waits on
you. That's correct — nothing should touch disk before you say yes — but it also means
every second you take to answer is a second of pure idle time. Speculative approval closes
that gap: while the prompt sits in front of you, the agent keeps working *speculatively*.
Every file mutation it makes in the meantime lands in a shadow overlay keyed to that
pending request, never in the real workspace.

When you answer:

- **Approve** → the shadow is applied over the real workspace — the work done while you
  were deciding lands instantly, with no re-run.
- **Deny** → the shadow is thrown away and the workspace is bit-for-bit what it was before
  the agent guessed.

A speculation is exactly an [overlay](/docs/dry-run) whose fate is decided by a permission
answer — it's the same shadow-tree mechanism dry-run uses, inheriting the same symlink
confinement, atomic writes, and honest `{applied, errors}` reporting, applied to a single
pending request instead of a whole session.

## Four hard safety rules

These are the feature; everything else is plumbing.

1. **Never apply implicitly — fail closed.** Only an explicit approval writes anything to
   disk. A timeout, an abandoned request, a dropped connection, or process exit all
   discard. There is no code path from "nobody answered" to "the workspace changed," and
   a shadow tree left behind by a crash is inert — nothing ever scans for or resumes an
   orphaned speculation.
2. **Never speculate an irreversible side effect.** Only file mutations can be undone by
   throwing a directory away, so only `write` and `edit` are speculatable. Everything else
   — `bash`, `fetch`, `websearch`, any `mcp`-prefixed tool, sub-agents — is **blocked**
   outright for as long as a speculation is open: the tool's `execute()` is never called,
   and the model gets back an `isError` result telling it to wait for the approval. This
   is the sharpest edge of the design: a `bash` call that only touches files still can't
   run speculatively, because the wrapper has no way to know that in advance.
3. **Speculations are isolated from each other.** Each pending request gets its own
   overlay keyed by request id. A nested speculation materializes from the *real*
   workspace, never from an outer speculation's shadow — a guess is never built on top of
   another unapproved guess.
4. **Apply failures are surfaced, never swallowed.** Settling reuses the overlay's
   `{applied, errors}` shape verbatim and reports a partial apply as `"partial"`; it always
   resolves, never rejects, so a failed write can't take the session down.

## What's actually speculated

Only `write` and `edit` calls run speculatively — their entire effect is a file mutation,
so it's fully undoable by discarding the shadow. `read`, `grep`, `glob`, and `ls` keep
running untouched while a speculation is open: they observe, they don't mutate, so
there's nothing to roll back and no reason to block them. A `read` of a path with a
pending speculative write is served from the shadow, so the agent sees its own guessed
edit consistently within the same speculation — but `grep`/`glob` still see the real
tree, since they take patterns rather than a single resolved path.

## Config

```json
{ "speculation": false }
```

Default is `false` — opt-in, not opt-out. Turning it on changes what the agent is allowed
to do while a permission prompt is open, so it has to be a choice you make, not a
surprise a config default sprang on you.

## Interaction with dry-run

Speculation and dry-run both work by owning a shadow overlay, and they do **not** stack.
If both were on at once, the speculative overlay would sit outside dry-run's redirected
tree, and approving a speculation would write straight to the real workspace — exactly
what dry-run promises never happens. So dry-run wins: with `--dry-run` set, speculation is
disabled for the session regardless of the `speculation` config value, and you get a
warning saying so:

> Dry-run mode is on, so speculative approval is disabled for this session.

There's no benefit to combining them anyway — dry-run already defers every write to your
review, so there's nothing idle time would buy you.

## Honest limits

- A speculative edit is invisible to anything outside the tool wrapper — `grep`, `glob`,
  and any external process watching the filesystem see the real, unmodified tree until
  approval lands.
- Back-to-back permission prompts touching the *same* file aren't a good speculation
  target: the second prompt's speculation builds from the real workspace, so it can't see
  the first prompt's still-unapplied shadow edit.
- Nothing here reduces how often you're prompted — [permissions](/docs/permissions)
  decide that. Speculation only changes what happens *during* the wait.

## Related

- [Dry run & sandbox](/docs/dry-run) — the overlay mechanism speculation reuses, and why
  the two features refuse to stack.
- [Permissions](/docs/permissions) — what decides whether and how often a prompt appears
  in the first place.
