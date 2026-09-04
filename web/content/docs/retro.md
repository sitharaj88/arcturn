---
title: Retro
description: Self-improving kits — after a run, a read-only agent reads the journal and proposes edits to the kit's prompts and stages, as a diff you approve before it lands.
section: Core concepts
order: 8.961
---

## The lesson a run already paid for and never wrote down

A [parked step](/docs/workflows#a-failed-step-is-a-question-not-a-tombstone) already tells
you a lot: which role, which turn it stalled on, what it spent its turns doing, what the
model's last turn looked like. What it does not do is turn that into a fix. Somebody reads
the park, understands that `@reviewer` spent 77 of its 80 turns reading and never got to the
write, and edits `reviewer.md` by hand to say so more forcefully — and the next kit that
ships the same mistake pays for the same diagnosis again.

`arcturn retro <runId>` closes that loop. It reads one run's durable journal and its
insights ledger — exactly the evidence a person would open a session file to find — and
asks a small, read-only agent for the **smallest edits** to the kit files that run actually
exercised: the workflow `.md` and every `@role` agent file a step dispatched to. What you
approve is a unified diff, shown before anything happens, and it is never applied without
an explicit yes.

```text
arcturn retro 2026-09-03T11-02-00Z-a1b2c3d4              # preview only, prints and stops
arcturn retro 2026-09-03T11-02-00Z-a1b2c3d4 --apply --yes  # lands it after validation
/retro 2026-09-03T11-02-00Z-a1b2c3d4 [--apply]             # the same thing, in a session
```

## Edit blocks, not a model-written diff

The model is never asked to write a diff. It replies with **edit blocks** — search and
replace, no line numbers, no hunk headers, no counts:

```text
<<<<<<< EDIT agents/reviewer.md
You are the reviewer. Read the change and leave comments.
=======
You are the reviewer. Read the change and leave comments.
Write review.md within your first 20 turns; do not keep reading after that.
>>>>>>> END
```

This is the whole reliability story of the feature. A hand-authored unified diff is
fragile in two ways at once: it needs line arithmetic the model has no way to check, and
it needs context lines that match the file byte for byte. Get either wrong — one drifted
space, one miscounted `@@` — and `git apply` refuses the entire patch, findings and all.
An edit block carries no arithmetic, so the only thing it can get wrong is the text; and
the text is right in front of it, because **the packet now carries the full content of
every editable file** rather than a few thousand characters of each.

Arcturn resolves each block itself:

- the path must be one of the run's own editable files, spelled exactly as listed;
- the search text must appear in that file **exactly once** — first as an exact match
  (LF or CRLF), then, failing that, as a line match that ignores trailing whitespace;
- a block that matches zero times or more than once refuses the whole proposal, reporting
  every failing block with its count and the nearest real line in the file quoted back.

Blocks that resolve are applied in memory, in order — several may touch the same file —
and then Arcturn **renders the unified diff itself** from the before and after texts, with
three lines of context and hunk headers computed rather than guessed. `git apply --check`
still runs, now as a self-check of Arcturn's own rendering before the diff is ever shown.

`--json` reports both halves: `diff` is the rendered patch, and `edits` lists
`{path, matched: true}` for each block that resolved.

## One correction turn

If any block fails to match, the retro agent gets exactly **one** follow-up turn, in the
same sub-agent so the file content it was shown is still in its own history. The follow-up
quotes each failing block, the reason it failed, and the nearest text actually in the file,
and asks for the complete corrected set — which is then resolved from scratch.

A second failure is the end of it: the findings still print (the diagnosis is worth keeping
even when the fix is not), nothing is written, and the command exits 1.

## Progress, because this takes minutes

A retro is one long model call over a large packet. It prints its phases to **stderr** as
they start, so an `--json` stdout stays pure JSON:

```text
retro: reading run 20260902T103911-65235651 (14 steps, 8 roles)
retro: 9 editable files, 71 KB of prompts
retro: asking zai/glm-5.3-flash — this usually takes a few minutes
retro: still thinking (1m)
retro: still thinking (2m)
retro: 6 findings, 3 edits across 3 files
```

`retro: still thinking (Nm)` repeats once a minute for as long as the model is working, and
a correction turn announces itself too. In a session, `/retro` prints the same lines as
notices.

## What it reads, and what it never touches

The evidence packet is built from the same sources [Insights](/docs/insights) already
enforces a whitelist over — nothing here is a new leak:

- the run header: workflow name, truncated input, the models it ran on;
- per step: id, role, status, attempts, failure kind, its activity (turns and tool
  counts), the *shape* of its last turn (never a reasoning tail), duration, cost when
  priced, and a short tail of its final text;
- the matching `park`, `silent-turn` and `progress-warning` events from the local
  insights ledger, when `insights` is on.

**Editable files are discovered from the run, not guessed.** They are exactly the
workflow `.md` named on the run's manifest, plus the `@role` agent file for every role a
step in it dispatched to — resolved through the same `~/.arcturn/agents` /
`<project>/.arcturn/agents` roots the engine itself uses. When the workflow lives inside an
installed kit (`~/.arcturn/packages/<name>/`), the package name is read from its
`.arcturn-install.json` and shown alongside the file list. Nothing outside that set is ever
proposed.

**Every file is anchored on the tree it came from.** A run draws its kit files from two
independent trees — `~/.arcturn` for the workflow, home roles and installed kit packages,
and `<cwd>/.arcturn` for roles a repository ships — so retro never derives a root from
where the files happen to sit. It renders, checks and applies **one patch per tree**, each
inside that tree: `git apply` runs in `~/.arcturn` or in `<cwd>/.arcturn`, and the scratch
copy is created there. Edit blocks name a home file by its path under `~/.arcturn`
(`agents/reviewer.md`) and a project file with a `project/` prefix
(`project/agents/local-reviewer.md`), so the two can never collide. A file whose realpath
resolves outside both trees — a symlinked role file, say — is dropped from the editable set
with a warning, at discovery and again immediately before anything is written.

Deriving the root instead (the longest shared prefix of the file set) is what this replaced:
one role from each tree pushed that prefix above both, so `git apply --check` and the
scratch directory landed in `$HOME` — or in `/`, when the checkout sat on another top-level
directory.

The whole packet is capped at about 60,000 characters, and the file half of it is shared
out by need: a file shorter than its fair share takes only what it needs and hands the rest
back, so one enormous role file cannot squeeze the others down to stubs. When a file still
does not fit it is **labelled as truncated in the packet itself**, with its real length and
an instruction that edits may only be proposed inside the text shown — never a silent cut,
which is precisely how the first version of this feature ended up proposing edits to text
it had never seen.

## Validation, before you ever see a diff

A proposal is rejected, not applied, unless every one of these holds:

- every edit block names a path in the run's own editable set, and matches exactly once;
- every file it touches still resolves inside the tree that declared it;
- the rendered diff creates, deletes, renames nothing, and carries no binary hunk;
- `git apply --check` accepts it cleanly against the files exactly as they are on disk
  right now.

A rejected proposal still prints the findings, with the reason it was refused, and touches
nothing.

## Approval

Preview only — no `--apply` — always exits after printing findings, the diff and a risk
paragraph, and changes nothing. `--apply` lands it, but only after a yes:

- **Interactively** (`/retro <runId> --apply`), a picker asks "Apply this patch to N
  file(s)?" — the same modal `/remove` and `/add` use for their own irreversible actions.
- **Non-interactively** (`-p`, or the top-level `arcturn retro` binary), a picker cannot be
  shown. `--apply` without `--yes` prints everything and stops with the exact command that
  would apply it; `--apply --yes` applies without asking.

Every touched file is written atomically — a temporary copy, then a rename over the
original — so a crash mid-apply can never leave a file half-patched. `retro.md` is saved
beside the run's own journal afterward: the findings, the diff, whether it was applied, and
when.

## The auto-offer

`/workflow` prints a one-line hint after any run that had a park, a failed step, or a step
that needed more than one attempt:

```text
retro: this run had 2 parks — `arcturn retro 2026-09-03T11-02-00Z-a1b2c3d4` proposes prompt fixes
```

Turn it off with:

```json
{ "retro": { "auto": false } }
```

`retro.model` overrides the model the retro's read-only sub-agent runs on. Left unset, it
uses the configured `judgment` [model tier](/docs/configuration#per-role-models) when one
is configured, and the ordinary subagent route otherwise — the same precedence a workflow
role's own `model: tier:judgment` follows.

## Related

- [Workflows](/docs/workflows) — the pipeline format, and why a failed step parks instead of dying
- [Insights](/docs/insights) — the ledger a retro reads alongside the journal
- [Configuration](/docs/configuration) — the `retro` key, and its neighbours
