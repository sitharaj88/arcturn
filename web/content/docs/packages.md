---
title: Packages
description: Install skills, agent roles, workflows, themes and MCP configs from a git repo or a folder — staged, commit-pinned, and fail-closed on executable code.
section: Core concepts
order: 6.7
---

A package is a directory — usually a git repository — carrying content Arcturn already
knows how to load. Skills, agent roles, workflows, themes, MCP server declarations,
extensions: all of it already works when you drop the files into `~/.arcturn` by hand.
A package is that same content with a name, a version, a resolvable source, and an
install that records exactly what it did.

```bash
arcturn add sitharaj88/arcturn/examples/starter-skills
```

That clones the repo, uses `examples/starter-skills` as the package root, writes the
resolved commit to `.arcturn-install.json`, and links three markdown files into
`~/.arcturn/skills/`. `/commit-message`, `/pr-description` and `/release-notes` work in
the next session. Nothing else happened — and the rest of this page is mostly about how
you can tell that from the outside.

## The seven kinds

| Kind | Format | Risk class | Installs into |
|---|---|---|---|
| Skill | markdown + frontmatter | prompt-injection surface | `~/.arcturn/skills/` |
| Agent role | markdown + frontmatter (`tools:` decides its lane) | capability surface | `~/.arcturn/agents/` |
| Workflow | numbered-markdown pipeline | orchestration — spends money | `~/.arcturn/workflows/` |
| Org kit | agents + workflows together | both of the above | both roots |
| MCP config | `mcp.json` servers block | remote capability surface | merged into `~/.arcturn/mcp.json` |
| Theme | JSON | none | `~/.arcturn/themes/` |
| Extension | JS/TS module | **arbitrary code execution** | `~/.arcturn/extensions/`, confirm-gated |

An org kit is not a seventh directory on disk — it is what you call a package that ships
`agents/` and `workflows/` together, so the roles and the pipelines that reference them
arrive and leave as one unit. [Agent organizations](/docs/agent-organizations) is the
page about what that combination *is*; this page is about how it travels.

The risk column is the important one, and it is not decoration. Six of these kinds are
text that Arcturn parses. One of them is code that Arcturn runs. The install path treats
them differently in every way that matters.

## Package layout

Everything is detected by convention:

```
my-pack/
├── arcturn.json          # optional manifest
├── skills/               # markdown skills          → ~/.arcturn/skills/
├── agents/               # markdown agent roles     → ~/.arcturn/agents/
├── workflows/            # markdown pipelines       → ~/.arcturn/workflows/
├── themes/               # *.json                   → ~/.arcturn/themes/
├── extensions/           # *.ts / *.js              → ~/.arcturn/extensions/  (gated)
└── mcp.json              # { "servers": { ... } }   → merged into ~/.arcturn/mcp.json
```

Every directory is optional. The simplest package that works is a folder of markdown
files with no manifest and no `skills/` directory at all — those root-level `.md` files
are read as skills, minus the ones that obviously are not (`readme.md`, `changelog.md`,
`license.md`, `contributing.md`, `code_of_conduct.md`, `security.md`).

### The manifest

`arcturn.json` is optional. It names the package and, where convention gets the wrong
answer, says explicitly what to install:

```json
{
  "name": "starter-skills",
  "description": "Three git-shaped skills that refuse to invent what the diff does not show.",
  "version": "0.1.0",
  "provides": {
    "skills": [
      "skills/commit-message.md",
      "skills/pr-description.md",
      "skills/release-notes.md"
    ]
  }
}
```

Two things about `provides` that the shape does not make obvious:

- **It overrides convention field by field, not wholesale.** Declaring `provides.skills`
  replaces skill detection only; `extensions/`, `themes/` and `mcp.json` are still found
  by convention. A manifest is not a way to hide a kind — omitting `extensions` from
  `provides` does not stop `extensions/` from being detected.
- **Each entry is one asset, not a directory to expand.** `"skills/commit-message.md"`
  links that file. `"skills"` would try to link the whole directory as a single entry
  named `skills`, which is not what you meant. List the files.

Manifest entries are resolved against the package root and checked to land inside it; an
entry that escapes, or that names a path which does not exist, is dropped with a warning
rather than failing the install.

## Three source shapes

| Shape | Example | Notes |
|---|---|---|
| GitHub shorthand | `sitharaj88/arcturn` | `owner/repo[/subdir][@ref]` — `sitharaj88/arcturn/examples/starter-skills@v0.1.0` |
| Git URL | `https://github.com/you/pack.git` | Anything `git clone` accepts; `#ref` or `@ref` to pin |
| Local path | `./my-pack`, `/abs/path` | Copied, not linked. A path that is itself a repo still gets its commit recorded |

A source that names a `@ref` — a tag, a branch, a commit — installs **pinned**, and
`arcturn update` will not move it. That is the point of naming one: a pinned package
changes when you change it and at no other time.

The `/subdir` component of a GitHub shorthand is resolved against the clone and checked
for containment before anything reads it, so `owner/repo/../../etc` is a rejected source,
not a traversal.

## What install actually does

In order:

1. **Resolve** the source into a kind, a location, an optional ref and a default name.
2. **Stage** it into a scratch directory under `~/.arcturn/packages/`. A git source is
   cloned here; a local path is copied here, minus `.git`. Nothing is written to your
   real roots yet.
3. **Resolve the commit** — the exact SHA, not the ref you asked for.
4. **Detect** what the staged tree provides: manifest first, convention for the rest.
5. **Confirm**, if and only if executable code was found. This is the gate described
   below. Declining here stops everything: the staging directory is removed and no root
   is touched.
6. **Materialise** — move the staged tree to `~/.arcturn/packages/<name>/` and link each
   detected asset into the root Arcturn scans.
7. **Record** `.arcturn-install.json` inside the package directory: name, source string
   as you typed it, resolved location, ref, pinned flag, subdir, commit, timestamps, and
   the exact list of what got linked.

That record is what makes the whole thing auditable. `arcturn packages` reads it,
`arcturn update` re-resolves from it, and `arcturn remove` uses its `provides` list to
unlink precisely what this package added and nothing else.

### Linking, and what happens on a collision

Each asset is linked into its root by **basename**: `skills/commit-message.md` becomes
`~/.arcturn/skills/commit-message.md`. A symlink where the filesystem allows one, a copy
where it does not — so on a symlinked install, editing the file under
`~/.arcturn/packages/` takes effect immediately, which is the local authoring loop.

**A package never clobbers a file that is already there.** If the destination exists and
is not already a symlink to this exact source, the entry is left alone, a warning names
it, and the install continues without it. The consequence worth knowing: that asset is
not in the install record either, so a later `arcturn remove` will not delete the file
that won — a collision cannot make one package's uninstall eat another package's, or
your own, work. Resolve it by renaming one side, or install with `--name` to keep the
packages distinct.

`mcp.json` is the exception to basename linking: its `servers` block is *merged* into
your `~/.arcturn/mcp.json` rather than replacing the file, and a server whose name is
already taken is skipped with a warning on the same principle.

## The security model

Installing a package that provides extensions means running someone else's JavaScript
with your full permissions the moment Arcturn next loads `~/.arcturn/extensions`.
Installing one that provides only skills, agents, workflows or themes carries no
code-execution risk at all. The registry treats those two cases as different in kind,
not different in degree.

**Executable code is confirm-gated and fails closed.** No extension file is linked
without an explicit, per-install "yes" from a confirmation that names the files
involved. That confirmation **defaults to a hard "no"** — an install path that forgot to
wire up a real prompt refuses rather than silently running code, and a non-TTY install
(CI, a pipe, a script) cannot give informed consent, so it declines. This does not
change because a package is listed on the hub.

**Declining installs nothing at all** — not even the package's skills. The whole install
is staged in a scratch directory and only materialised after any required confirmation
is granted, so "no" leaves your machine exactly as it was.

**`--yes` is the one way past that gate, and it is a decision, not a default.** It
pre-grants the confirmation, which is what makes a non-interactive install of a package
carrying extensions possible at all — a provisioning script has to be able to say yes
somehow. What it does not do is make the code safer, and it silences the one prompt that
would have told you the code was there. Run `arcturn inspect` before you put `--yes` in a
script, and read it again when you bump the ref.

**`--skills-only` is the way to take the text and leave the code.** It skips extension
detection at the linking step entirely. The extension files still land on disk under
`~/.arcturn/packages/<name>/`, inert, but are never linked into `~/.arcturn/extensions`,
so the loader never scans them and no confirmation is needed.

**Names are traversal-proofed twice.** A package name is validated against
`[a-z0-9._-]` *and* checked to resolve inside `~/.arcturn/packages` before any write —
by charset and by absolute-path containment, because either check alone has been the
bug in someone else's registry. The same containment check applies to a shorthand's
`/subdir` against the clone.

**git is spawned argv-style, never as a shell string**, through the same injectable seam
the rest of the codebase uses; and a caller-supplied ref beginning with `-` is rejected
outright, because `git checkout <ref>` with a ref that is really a flag is a command
injection wearing a version number.

**The commit is pinned.** `.arcturn-install.json` records the exact resolved SHA, so an
install is reproducible and a package that changed under you is visible rather than
mysterious. There is no auto-update: `arcturn update` is a command a person runs.

### What the non-executable kinds still are

"No code execution" is not "no risk", and the honest version of each is short:

- **A skill is a prompt template.** It cannot execute. It is read into a model's context,
  which makes it a prompt-injection surface — text from a package you installed becomes
  text the model treats as instruction. Skills discovered in a project root are
  additionally withheld from the model-facing index by description; see
  [Model-invoked skills](/docs/skill-tool).
- **An agent role is a capability declaration.** Installing one executes nothing;
  *running* one does. Its `tools:` line decides which of the three lanes it dispatches
  on — read, exec or write — and that lane is computed from the tools, not from what the
  role's prose claims about itself. Read the `tools:` line, not the description.
  [Agent organizations](/docs/agent-organizations) has the lane rules.
- **A workflow spends money.** It is markdown, it executes nothing on install, and a run
  of it can call a dozen models. Its `budgetUsd` is the ceiling it declares; `--max-cost`
  is the ceiling you impose regardless.
- **An MCP config points at somebody's server.** Merging it grants no local execution and
  a great deal of remote capability. See [MCP](/docs/mcp).

Under all of it, the real boundary on what any of this can touch is the
[permission engine](/docs/permissions), which reads rules and not prompts.

## Inspect before you install

`arcturn inspect <source>` is the install's counterpart: it resolves and stages the
package exactly as an install would — same resolver, same commit pinning — links
nothing, and prints what installing it *would* add.

```
$ arcturn inspect sitharaj88/arcturn/examples/enterprise-org

enterprise-org — github: sitharaj88/arcturn/examples/enterprise-org @ main
staged at 4f1c2ab · nothing linked, nothing written outside the staging directory

AGENTS (11)
  lane   role               budget  tools
  read   architect           $2.50  read grep glob ls search_code
  read   pm                  $0.40  read grep glob ls
  read   tech-lead           $1.50  read grep glob ls search_code
  read   ux-reviewer         $0.60  read grep glob ls
  exec   qa-adversarial      $1.50  read grep glob ls bash
  exec   release-manager     $0.50  read grep glob ls bash
  exec   retro               $1.00  read grep glob ls bash
  exec   security-reviewer   $1.50  read grep glob ls bash
  write  developer           $3.00  read write edit bash grep glob ls
  write  docs-writer         $0.80  read write edit bash grep glob ls
  write  qa-functional       $1.00  read write edit bash grep glob ls

WORKFLOWS (6)
  workflow          stages  budget  roles
  bug-fix                4     $15  developer qa-adversarial qa-functional tech-lead
  docs-pass              6     $12  docs-writer pm qa-adversarial tech-lead
  feature-build          4     $25  architect developer qa-adversarial
                                    security-reviewer tech-lead
  refactor-guard         7     $30  architect developer qa-adversarial qa-functional
                                    tech-lead
  release-check          5     $20  qa-adversarial release-manager
  security-audit         5     $20  architect developer qa-adversarial
                                    security-reviewer tech-lead

SKILLS (0)   THEMES (0)   MCP SERVERS (0)

EXTENSIONS (0)
  No executable code. This package links markdown only.

Nothing was installed. To install:
  arcturn add sitharaj88/arcturn/examples/enterprise-org
```

*The transcript above is illustrative — the field set is the specified disclosure block
(lanes, tools, budgets, stage counts, role dependencies, executable files), and the
values are the real ones from the kit in `examples/enterprise-org`. Exact column
formatting will differ.*

Read that output as three claims you are being asked to check:

**The lane column is computed, not declared.** It is the same dispatch the engine uses
at run time, derived from each role's `tools:` line — `write`/`edit`/`multiedit` land a
role on **write**, `bash` alone lands it on **exec**, neither lands it on **read**. Seven
of these eleven roles carry `bash`; only three of those seven also carry write access.
A role that describes itself as a read-only reviewer while carrying `edit` shows up here
as `write`, and the table is what is true.

**The budget column is per-role and per-turn, not a total.** The eleven ceilings sum to
$14.30, and that number means nothing on its own — it is not what any run costs. The
numbers that bound spend are the workflows' own ceilings and your `--max-cost`.

**The zero rows are the load-bearing ones.** `EXTENSIONS (0)` is the line that says this
package will link no code and ask you no confirmation question. On a package where that
line is not zero, it names every file, and the install stops to ask.

The same disclosure fields are what a hub listing renders, from the same code path, so
the page you read and the install you run cannot describe two different packages.

## Authoring

`arcturn new skill|agent|workflow <name>` scaffolds a valid file with the frontmatter
the parsers actually require, into the project root or the user root. From there the
loop needs no publish step:

```bash
arcturn new skill triage          # scaffold
$EDITOR .arcturn/skills/triage.md # edit
arcturn inspect ./my-pack         # read what an install would do
arcturn add ./my-pack             # install your own directory
```

A local-path install is a copy, so re-run `arcturn add` after edits — or edit the file
under `~/.arcturn/packages/<name>/` directly, which a symlinked install picks up with no
reinstall at all.

Project scope wins over user scope for skills, agents and workflows alike, so a team
standardising a variant checks it into `<project>/.arcturn/`, and it silently overrides
anyone's installed personal copy with a warning naming both files.

## Publishing to the hub

The hub on arcturn.dev has no backend, no accounts, and no upload endpoint. The repo is
the registry of record:

1. Put your package in a public git repository. It can be the whole repo or a subdirectory.
2. Open a pull request adding one JSON entry under `registry/` — name, kinds, source as a
   GitHub shorthand, description, maintainer, and the disclosure block (the same fields
   `arcturn inspect` prints).
3. The site builds `/hub` from those entries at export time: a page per asset with its
   README, the one-line install command, and the disclosure table.

Curation by pull request *is* the moderation model, and calling it that is more useful
than calling it a review process. It scales exactly as far as maintainer attention does;
it is what every module registry ran on early, and it is what will be revisited when it
saturates rather than before. What it is not is a safety guarantee: a listed package gets
no relaxation of the extensions gate, and `arcturn inspect` is worth running on a hub
listing for the same reason it is worth running on a stranger's URL.

The generated `index.json` is the API. A future `arcturn search` reads that same file —
which is why the disclosure block is a required field in the entry and not a courtesy.

## Command summary

| Command | What it does |
|---|---|
| `arcturn add <source> [--name x] [--skills-only] [--yes]` | Install a package |
| `arcturn inspect <source>` | Stage and disclose; install nothing |
| `arcturn packages` | List what is installed, with pinned commits |
| `arcturn update [name]` | Re-fetch one package, or every one of them; a pinned package reports and does not move |
| `arcturn remove <name>` | Unlink exactly what that package added |
| `arcturn new skill\|agent\|workflow <name>` | Scaffold a valid file |

`/add`, `/packages`, `/remove` and `/update` are the same operations inside the TUI. See
the [CLI reference](/docs/cli-reference) for flags and exit codes.

## Related

- [Markdown skills](/docs/skills) — the format packages most often carry, and how a skill
  file is parsed
- [Agent organizations](/docs/agent-organizations) — what an org kit's roles and lanes
  mean once installed
- [Workflows](/docs/workflows) — the pipeline format, its budgets, and its failure
  semantics
- [Permissions](/docs/permissions) — the real boundary underneath every kind on this page
- [MCP](/docs/mcp) — what a merged `mcp.json` server actually grants
