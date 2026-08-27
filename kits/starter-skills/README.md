# starter-skills

Three git-shaped slash commands for the moments where an agent is most tempted to make
something up: writing a commit message, describing a pull request, and turning a commit
range into release notes.

Each one is built around a refusal. `commit-message` will not invent a Conventional
Commits scope the staged paths do not name. `pr-description` will not report a test
result nobody watched. `release-notes` will not write a migration step the diff does not
support. Those refusals are the reason the pack exists — the drafting part is easy, and
every one of these outputs is read by someone who cannot check it against the diff.

## Install

```bash
arcturn add sitharaj88/arcturn/kits/starter-skills
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`kits/starter-skills` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links the three skills into `~/.arcturn/skills/`. They are
available as `/commit-message`, `/pr-description` and `/release-notes` immediately.

To read what an install would add before running it:

```bash
arcturn inspect sitharaj88/arcturn/kits/starter-skills
```

From a clone, the local-path form works too — `arcturn add ./kits/starter-skills` —
which is also the loop for editing your own copy. `arcturn remove starter-skills`
uninstalls; `arcturn update starter-skills` re-fetches.

## The skills

| Command | What it does | What it refuses to do |
|---|---|---|
| `/commit-message` | Reads `git diff --staged` and drafts one Conventional Commits message: type derived from what the diff does, scope derived from the changed paths. | Invent a scope. Files spanning unrelated areas get `fix: ...`, never `fix(core): ...` — a made-up scope is a claim about the codebase that `git log --grep` will act on. |
| `/pr-description` | Reads `<base>...HEAD` and writes title, summary, what changed, why, how verified, risk and rollback, reviewer notes. | Fake the *how verified* section. A test file in the diff is evidence a test was written, not that it passes; with nothing run, it writes "Not verified in this session" and lists the commands. |
| `/release-notes` | Turns a commit range into Keep a Changelog notes with breaking changes first, then features, then fixes, internals collapsed to a count. | Invent a migration path. A breaking change whose replacement is not in the diff gets "Migration: not derivable from the diff — author must supply". |

All three take arguments. `/commit-message JIRA-4412 the token refresh race` passes the
author's context through — the skill uses it for the issue reference and the framing, and
still follows the diff wherever the two disagree. `/release-notes v0.1.0..HEAD` sets the
range explicitly; with no argument it derives one from the last tag, and stops rather
than guessing when there is no tag to derive from.

## What these are, exactly

**A skill is a prompt template, not code.** Each file here is markdown with two optional
frontmatter keys (`name`, `description`) and a body; installing the pack copies text onto
disk and nothing else. Nothing in this directory executes, has a build step, or runs at
install time — that is why the pack installs with no confirmation prompt, unlike a package
carrying `extensions/`.

The consequence worth stating plainly: these skills instruct a model, they do not
constrain it. When `/commit-message` says it will not invent a scope, that is a rule
written into a prompt, enforced by the model's compliance with the prompt — not by the
harness, and not by a validator. The skill improves the odds and gives you the exact
sentence to check against; reading the output is still your job. The parts you *can*
rely on are structural: a skill cannot execute, and the real boundary on what any tool it
triggers may touch is the [permission engine](https://arcturn.dev/docs/permissions),
which does not read prompts at all.

**Edit them.** These are three files. Conventional Commits types your team does not use,
a `How verified` section your PR template already covers, a changelog shape that is not
Keep a Changelog — change them. `arcturn add ./kits/starter-skills` from a clone
installs your edited copy, and a project-scope `.arcturn/skills/commit-message.md` wins
over an installed user-scope one, so a team can standardise a variant without anyone
uninstalling anything.

Docs: [Markdown skills](https://arcturn.dev/docs/skills) ·
[Packages](https://arcturn.dev/docs/packages)

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
