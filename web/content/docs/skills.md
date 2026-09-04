---
title: Markdown skills
description: Add a slash command by dropping a markdown file on disk — no code, no build step.
section: Core concepts
order: 6.5
---

## Where skills live

Arcturn discovers skills in two roots, scanned in order: `~/.arcturn/skills` (user) then
`<cwd>/.arcturn/skills` (project). Each root recognizes two shapes:

- **`<root>/<name>.md`** — a single command. `<name>` (lowercased, with any character
  outside `[a-z0-9-]` stripped) becomes the command name.
- **`<root>/<name>/SKILL.md`** — a skill folder. The folder can hold other assets
  alongside `SKILL.md` — they're ignored by the loader itself, but the prompt body can
  reference them via `$SKILL_DIR`.

## Frontmatter and body

```markdown
---
name: changelog
description: Draft a changelog entry for the current diff
---
Summarize the staged git diff as a changelog entry in Keep a Changelog style.
Focus on: $ARGUMENTS
```

Only `description` and `name` are recognized in frontmatter; any other key is ignored.
Frontmatter is entirely optional — a file with no `---` fence is used whole as the
prompt template, and `name` then falls back to the filename or folder name.

## Template substitutions

Expanded when the command runs:

| Token | Expands to |
|---|---|
| `$ARGUMENTS` | The full text typed after the command name |
| `$1` .. `$9` | Positional words from `$ARGUMENTS`, splitting on whitespace (a `"quoted span"` counts as one word); a missing position becomes `""` |
| `$CWD` | The working directory the command runs in |
| `$SKILL_DIR` | The skill folder's absolute path (folder skills only) |

```markdown
---
name: pr-summary
---
Summarize PR #$1 for the $2 team. Full args: $ARGUMENTS
```

`/pr-summary 42 platform` expands `$1` to `42`, `$2` to `platform`, and `$ARGUMENTS` to
`42 platform`.

## Collisions

Roots are scanned user-first, project-second, so a project skill silently overrides a
user skill of the same name (reported as a warning naming both files) — a team can check
in a `.arcturn/skills/` directory that overrides personal skills without either side
crashing. A skill can never shadow a built-in command: `/help`, `/model`, `/rewind`, and
the rest of the built-ins always win a name collision, and the conflicting skill is
dropped with a warning instead.

## Running a skill headlessly

A skill is a slash command, so `arcturn -p "/<name> args"` runs it without a terminal:

```bash
arcturn -p "/commit-message auth" --permission-mode acceptEdits
```

The template is expanded exactly as it would be in the TUI and the result is run as an
ordinary prompt, which means headless skill runs behave like any other `-p` run: the
final assistant text goes to stdout, diagnostics (denied tools, errors) to stderr, exit
`0` on success and `1` when the run errors, and `--output-format json` streams one agent
event per line. `@`-mentions inside a skill body are *not* expanded — the body reaches
the model verbatim, as it does interactively.

A built-in command always wins a name collision, headless included: if you have a skill
named `help`, `arcturn -p "/help"` still runs the built-in `/help`.

## The model can reach these too

Everything on this page describes the *slash-command* path — a skill a person types.
The same discovered skill library is also exposed to the model itself as one ordinary
tool (`skill`), so it can pull a relevant skill into context mid-task without anyone
typing a command. See [Model-invoked skills](/docs/skill-tool) for how that indexing
works, why `description:` frontmatter is now load-bearing for discovery, the
`skills.modelInvoked` opt-out, and a security note on reviewing skills from cloned repos.

## Example layout

```
~/.arcturn/skills/review.md              → /review
<project>/.arcturn/skills/deploy/
├── SKILL.md                         → /deploy
└── checklist.md                     (referenced via $SKILL_DIR)
```

## Authoring guide

A skill is nothing more than a prompt template on disk. The whole authoring loop is:
write the markdown file, run the slash command, read what actually got sent. There is no
build step and no restart — the loader re-reads the roots each time skills are discovered.

**Start with the body, not the frontmatter.** Frontmatter is entirely optional; if you
don't need a custom `name` or a `description` for `/help`, skip the `---` fence and just
write the prompt. Add frontmatter once you actually need to override the filename-derived
name or want a one-liner to show up in the command list.

**Design for `$ARGUMENTS` before reaching for `$1`..`$9`.** Most skills are clearer when
the model receives the whole argument string and decides what to do with it — `$ARGUMENTS`
degrades gracefully to nothing when the user types no arguments. Reach for positional
`$1`, `$2` only when the command has a genuinely fixed shape (`/pr-summary 42 platform`),
since a missing position silently becomes `""` rather than erroring.

**Use `$SKILL_DIR` for anything bigger than the template itself.** A folder skill
(`<name>/SKILL.md`) can ship checklists, example output, or reference data alongside the
prompt, and point the model at them by absolute path — the loader never inspects those
files itself, so any format works.

**Test the collision path deliberately.** If you're standardizing a skill across a team,
put the canonical version in `<project>/.arcturn/skills/` — it silently wins over anyone's
personal `~/.arcturn/skills/` copy of the same name, with a warning naming both files. A
skill can never out-rank a built-in command (`/help`, `/model`, `/rewind`, ...); the
conflicting skill is dropped with a warning instead of shadowing the built-in.

## Three worked examples

**1. A single-file command with positional arguments.**

```markdown
---
name: commit-message
description: Draft a conventional-commit message for the current diff
---
Look at the currently staged git diff (run `git diff --staged` yourself) and draft a
commit message in Conventional Commits style. Scope: $1. Extra context: $ARGUMENTS
```

`/commit-message auth "fixes the token refresh race"` expands `$1` to `auth` and
`$ARGUMENTS` to the full `auth "fixes the token refresh race"` string — deliberately
redundant with `$1` here, so the model still has the whole request even if it ignores the
scope hint.

**2. A folder skill that ships reference material via `$SKILL_DIR`.**

```
.arcturn/skills/release-notes/
├── SKILL.md
└── style-guide.md
```

```markdown
---
name: release-notes
description: Draft release notes for the given version, following house style
---
Read the style guide at $SKILL_DIR/style-guide.md and follow it exactly. Draft release
notes for version $1 by summarizing every commit since the previous tag. Audience: end
users, not contributors — omit anything purely internal (CI, tests, refactors).
```

The model reads `style-guide.md` itself (it's just a path); the loader never opens it, so
it can be markdown, JSON, a template, anything.

**3. A project-standard skill meant to override a personal one.**

```markdown
---
name: review
description: Team code-review checklist (overrides any personal /review skill)
---
Review the current diff against this team's checklist, in order:
1. Are all new public functions documented?
2. Does any new dependency need a license check?
3. Are error paths tested, not just the happy path?
4. Does this diff touch anything in `packages/*/src/security/`? If so, flag it explicitly
   for a second reviewer regardless of how small the change looks.

Report findings as a numbered list matching the checklist above; do not silently skip an
item that doesn't apply — say "N/A: <why>" instead.
```

Checked into `<project>/.arcturn/skills/review.md`, this wins the name collision against
anyone's personal `~/.arcturn/skills/review.md`, so `/review` means the same thing for
everyone working in the repo — with a warning (not a silent surprise) telling the
individual contributor that their personal skill was overridden.

## Synthesizing a skill from a run

Once a workflow run has finished cleanly, `arcturn skill synthesize <runId>` turns the
procedure it actually followed into a draft skill, instead of writing one by hand:

```bash
arcturn skill synthesize 20260902T072243-4dff73a1
```

This reads the run's journal (never its full transcript — no prompts, no reasoning, no
file contents leave the machine), builds a capped evidence packet of the workflow's name
and input plus each step's role, prompt, status, tool activity and last output, and hands
that to a small drafting sub-agent. The result is shown as a preview — nothing is written
yet. Add `--yes` to save it:

```bash
arcturn skill synthesize 20260902T072243-4dff73a1 --yes
```

It lands at `~/.arcturn/skills/<name>/SKILL.md` (or `<cwd>/.arcturn/skills/<name>/SKILL.md`
with `--scope project`) — the same layout every skill above uses, so it is a `/<name>`
slash command the moment it saves. Useful flags:

- `--name <n>` — save under a different name than the draft chose.
- `--scope user|project` — where to save it (default `user`).
- `--force` — synthesize from a run that did not finish `done`, or overwrite an existing
  skill of the same name (both are refused by default).
- `--share` — print a pre-filled GitHub issue proposing the draft for the hub. Nothing is
  ever sent on your behalf; the command only prints a link. It works with or without
  `--yes`: on a preview the link describes the *unsaved* draft (the notice on stderr says
  so, and the rerun it suggests keeps `--share`), and with `--yes` the same link is
  printed after the file lands.
- `--json` — emit `{name, path, saved, url?}` instead of prose. A preview adds the draft's
  bytes as `content` and reports `"saved": false`.

The interactive twin is `/skills synthesize <runId> [...]`, which shows the same draft and
asks for approval with a picker instead of `--yes`. The gate (a run must have finished
`done`, with no failed stage), the validation (a legal name, a non-empty body, no code
fence in the body, an 8 KiB cap) and the collision rule are identical on both paths.

A drafted skill's frontmatter carries two extra, informational keys — `source-run:` (the
run it came from) and `generated:` (an ISO timestamp) — alongside the usual `name:` and
`description:`. Both are ignored by the loader like any other unrecognized key, so a
synthesized skill behaves exactly like a hand-written one once saved.

## Related

- [Packages](/docs/packages) — how a skill travels to another machine: a folder of these
  files, installed with `arcturn add`, the commit pinned and the install recorded.
  `arcturn add sitharaj88/arcturn/kits/starter-skills` installs three worked ones
- [Model-invoked skills](/docs/skill-tool) — the same library handed to the model as a
  tool, why `description:` is load-bearing there, and how project-root skills are treated
- [Workflows](/docs/workflows) — the sibling feature for a scripted multi-step pipeline,
  sharing nothing with skills but a discovery pattern
