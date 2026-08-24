---
name: pr-description
description: Write a PR description from the branch diff — what changed, why, and how it was actually verified, with unverified claims marked as unverified.
---
Write the pull-request description for the current branch in $CWD. The base branch, or
any framing the author wants included, is here and may be empty: $ARGUMENTS

## Read the branch first

```bash
git rev-parse --abbrev-ref HEAD
git merge-base HEAD origin/main        # or main, or master — whichever exists
git log --oneline --no-merges <base>..HEAD
git diff --stat <base>...HEAD
git diff <base>...HEAD
```

Use the base named in $ARGUMENTS when the author gave one; otherwise take the merge-base
against the repository's actual default branch. Note the three dots in `<base>...HEAD`:
they give you this branch's own changes, not everything that landed on the base since
the fork point. Two dots will show you other people's work and you will describe it as
yours.

If the branch has no commits on top of the base, say so and stop.

## The description

**Title** — one line, Conventional Commits style, at most 72 characters, describing the
branch as a whole rather than whatever its last commit happened to be.

**Summary** — two or three sentences: what this changes, for whom, and roughly how big
it is. This is what a reviewer reads before deciding how much time the review needs.

**What changed** — bullets grouped by area, each naming the real paths it touches. One
bullet per coherent change, not one per commit: fold the "fix typo" and "address review"
commits into the change they belong to. A reviewer should be able to read this list and
predict the file list.

**Why** — the reason the change exists: the bug being closed, the constraint that forced
the shape, the alternative that was rejected and what ruled it out. Where the branch
makes a non-obvious decision, defend it here. Where the diff does not tell you the
motive, ask the author for it rather than supplying a plausible one.

**How verified** — worth more than every other section combined, and the easiest to
fake. State only what was actually done:

- commands actually run, with their real output or exit status;
- tests added, named by file, and whether they were observed to fail before the change
  and pass after — that pair is the claim worth making, and only when both halves were
  genuinely observed;
- manual checks, described precisely enough that the reviewer can repeat them.

A test file appearing in the diff is evidence that a test was written, not evidence that
it passes. If nothing was run in this session, write "Not verified in this session" and
list the exact commands a reviewer should run. Never report a green result you did not
watch happen.

**Risk and rollback** — what breaks if this is wrong, who notices first, and how to undo
it: a revert, a flag, a config change. "Low risk: additive, no existing caller changes
behaviour" is a fine answer when it is true and you can point at the reason.

**Reviewer notes** — where to start reading, which hunks are mechanical, and any specific
question you want answered before approval.

Drop *Risk and rollback* or *Reviewer notes* when the branch genuinely does not need
them. Keep every other section. An empty header is noise — but so is a three-line
description for a three-hundred-line diff.

## Output

Markdown, ready to paste into the PR body. Everything you could not determine from the
branch — an unverifiable claim, a missing rationale, an issue number nobody gave you —
goes into one short `> **Author, please confirm:**` blockquote at the end, where it is
visible and cannot be mistaken for a finding.
