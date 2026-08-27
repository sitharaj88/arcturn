---
name: release-notes
description: Turn a commit range into user-facing release notes, separating breaking changes from features and fixes, every entry traceable to a real commit.
---
Write release notes for a commit range in $CWD. The range, which may be empty:
$ARGUMENTS

## Establish the range

Use the range the author gave, verbatim. Otherwise the range is "since the last tag":

```bash
git describe --tags --abbrev=0                        # the previous release
git log --no-merges --pretty='%h %s' <previous>..HEAD
git diff --stat <previous>..HEAD
```

If the repository has no tags and the author named no range, say so and ask for one. Do
not guess a starting point: a wrong start silently omits — or silently duplicates — a
release's worth of change, and nothing downstream will catch it.

Read the commit **bodies**, not only the subjects (`git log --no-merges <range>`).
`BREAKING CHANGE:` footers live there, and so does most of the reasoning. For any subject
you cannot translate into a user-facing statement, read that commit's diff
(`git show <sha> --stat`) before writing anything about it.

## Sort before writing

Every commit lands in exactly one bucket:

1. **Breaking changes** — anything an existing user must act on: a removed or renamed
   public API, a changed default, a dropped platform or runtime version, a config key
   that no longer works, an output format that changed shape.
2. **Features** — something a user can now do that they could not do before.
3. **Fixes** — behaviour that was wrong and is now right.
4. **Internal** — refactors, tests, CI, dependency bumps, docs. Real work, and not the
   body of user-facing notes: collapse it into one closing line with a count.

Breaking changes come first even when there is one of them and forty features. Someone
scanning the notes for what will break them should never have to scroll to find it.

## Write for the user, not for the log

A commit subject is written for a reviewer who has the diff open. A release note is
written for someone who does not and never will. Translate:

- `fix: guard against null token in refresh path` → "Fixed a crash when a session token
  expired mid-request."
- `feat: add --max-cost flag` → "You can now cap what a single run may spend with
  `--max-cost <usd>`; the run stops when it reaches the ceiling."

The rules that keep the notes true:

- **Every entry traces to a commit.** Cite the short SHA, and the PR number when the
  subject carries one. An entry you cannot attribute is an entry you invented — cut it.
- **Never fuse two commits into one claim** that neither supports on its own.
- **Migration steps must be derivable.** For each breaking change, give the concrete
  before and after. When the diff does not tell you what replaces the old behaviour,
  write "Migration: not derivable from the diff — author must supply" instead of
  inventing a plausible upgrade path. A wrong migration step costs far more than a
  missing one.
- **No version number, date or release name you were not given.** If the author did not
  name a version, leave the heading as `Unreleased`.
- **No performance or reliability numbers** unless a commit message or the diff states
  them. "Significantly faster" is not a measurement.

## Output

Markdown in Keep a Changelog shape, ready to paste into `CHANGELOG.md`:

```markdown
## <version, or Unreleased> — <date, if you were given one>

### Breaking changes
- ... (`abc1234`)

### Features
- ... (`def5678`)

### Fixes
- ... (`9abcdef`)
```

Omit any section that has no entries. Close with a single line naming what you left out
— "Also: 14 internal changes (refactors, tests, CI)" — so a reader can tell the notes
were filtered deliberately rather than compiled incompletely.
