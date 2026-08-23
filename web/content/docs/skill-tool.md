---
title: Model-invoked skills
description: The skill tool exposes the same skill library markdown skills use to the model itself, so it can reach for a skill mid-task without the user typing a slash command.
section: Core concepts
order: 6.6
---

## Two ways into the same skill library

[Markdown skills](/docs/skills) are discovered once — `~/.arcturn/skills` then
`<cwd>/.arcturn/skills`, project overriding user on a name collision — and that discovered
collection is exposed to arcturn in two independent ways:

- **As slash commands**, one per skill, for a *user* who already knows which skill they
  want and types `/name`.
- **As one ordinary tool named `skill`**, for the *model*, which can recognize mid-task
  that a skill applies and pull it into context without anyone having typed anything.

Both paths call the exact same `Skill.buildPrompt(args, cwd)` — the same `$ARGUMENTS`,
`$1`..`$9`, `$CWD`, `$SKILL_DIR` substitutions apply identically whether a human typed
`/name args` or the model called `skill({ name: "name", args: "args" })`. Nothing about
authoring a skill changes to support this — see [Markdown skills](/docs/skills) for the
file format itself; this page is only about the second entry point.

## How the model finds a skill

The `skill` tool's *description* is a fixed preamble plus one index line per skill that has
a non-empty `description:` in its frontmatter, sorted by name:

```text
Available skills:
changelog — Draft a changelog entry for the current diff
release-notes — Draft release notes for the given version, following house style
review — Team code-review checklist (overrides any personal /review skill)
```

That description is rebuilt from the live skill registry on every access — it's a getter,
not a fixed string computed once at startup — so if a future version of arcturn adds
hot-reloading of the skills directory, this index picks it up automatically with no change
to the tool itself.

## Why `description:` frontmatter is now load-bearing

A skill with **no** `description` frontmatter is silently omitted from that index. It's
still callable by exact name if the model already knows it (or a human types the matching
`/command`), but the model has no way to *discover* it was worth calling. Before this
feature, `description` only mattered for how a skill's one-liner showed up in `/help`; now
it's also the model's entire signal for "does this skill apply to what I'm doing right
now." Skill authors should treat the frontmatter `description:` line as a search index
entry, not decoration — write it the way you'd write a tool description: specific enough
that a model scanning fifty of these in a row can tell yours apart.

## Calling it

```json
{ "name": "release-notes", "args": "2.4.0" }
```

returns the fully-substituted skill body as the tool's text output, truncated at 8,000
characters by default with a trailing `…(truncated; …)` note if the body ran longer, plus
`details: { skill: "release-notes", chars: <length of the returned text> }`. An unknown
name comes back as `isError: true` with up to three suggested near-misses (substring
matches ranked above pure edit-distance guesses), or `No skills are currently loaded.` if
the registry is empty.

## `skills.modelInvoked` — the opt-out

```jsonc
// arcturn config — default shown
{
  "skills": { "modelInvoked": true }
}
```

On by default: the tool costs nothing when no skills are loaded (its description is just
the empty-state line), and being reachable without a typed command is the entire point of
the feature. Set `"skills": { "modelInvoked": false }` in `~/.arcturn/config.json` or
`<cwd>/.arcturn/config.json` if you want skills to stay a purely user-typed,
slash-command-only feature — the model will never see the `skill` tool at all in that mode,
and skills remain reachable exclusively via `/name`.

`skill` is a reserved built-in tool name — an extension or a markdown agent definition
cannot register a conflicting `skill` tool, the same protection every other built-in
already has.

## Security note: project skills are prompt content

A project-level skill (`<cwd>/.arcturn/skills/`) is markdown that becomes part of what the
model reads and can act on — for the model-invoked path just as much as for `/name`. The
model can now reach a project skill's instructions **without a user explicitly typing the
command that summons it**, which is a materially larger reachable surface than before this
feature existed: a skill that would previously only run when someone deliberately typed
`/review` can now be pulled in by the model itself in the middle of an unrelated task, the
same way it can decide to call any other tool.

Because of that, the index defends itself two ways. Every description is reduced to a
single sanitized line (first line only, control characters stripped, 160-char cap, and a
ceiling on the whole index) before it is embedded. And a **project-root skill's
description is never embedded at all**: it is listed as
`name — (project-provided skill; description withheld, call by name to load it)`, so a
cloned repository cannot plant instructions that ride in every request with no user
action. User-root skills (`~/.arcturn/skills`, files you authored) embed their sanitized
descriptions normally. A project skill's *body* still loads when the model calls it by
name — that is the same trust decision as typing `/name` yourself — which is why the
following still matters:

Treat a `.arcturn/skills/` directory in a cloned repository the same way you'd treat a
`.arcturn/agents/` or `.arcturn/hooks/` directory: it is instructions that will be executed
against your session, not passive documentation. **Review skills from a repository you
didn't author before working in it**, especially anything with a broad or vague
`description:` that would make it look attractive to a model searching for "something that
applies here."

## Related

- [Markdown skills](/docs/skills) — the discovery, frontmatter, and template-substitution
  rules this tool builds directly on top of; read that page first if you haven't authored
  a skill yet.
- [Deferred tools](/docs/deferred-tools) — a separate, unrelated opt-in feature for
  withholding *other* tool schemas until searched for. `skill` is not itself deferrable in
  a useful way: its whole value is that its description already *is* the compact index a
  deferred-tools system would otherwise need to reconstruct, so hiding it behind a second
  discovery layer only adds a round trip with no benefit.
