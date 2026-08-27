---
name: adr-record
description: Record one architecture decision as Proposed, with rejected alternatives only where the author supplied them or the repo shows they were tried.
---
Write an architecture decision record for a decision somebody has already made. The
decision, plus whatever the author wants to supply — the options they weighed, the
thread it was settled in, the paths it touches: $ARGUMENTS

If $ARGUMENTS is empty, say so and stop. An ADR written from an empty prompt is a
record of nothing. The four questions this command needs answered are listed at the
end of this file; asking them is the correct output.

## What is load-bearing in an ADR, and what is scaffolding

An ADR exists so that the person who inherits this codebase can find out **why** it
looks like this without finding the people. Exactly two things carry that weight: the
forces that made a decision necessary, and the options that lost. The rest of any ADR
template is scaffolding around those two.

Both are things you can be told or can read. Neither is something you may supply. The
whole discipline of this command is keeping them apart from the prose around them, and
labelling the gap where a real ADR would have had one.

`$SKILL_DIR/madr-template.md` and `$SKILL_DIR/nygard-template.md` are the two shapes,
as complete files. Read the one you are going to use before you write anything, so the
structure comes from a file rather than from a recollection of what ADRs look like.

## 1. Decide whether there is a decision to record

Before anything else, settle whether this change decided something. Three conditions,
all of them:

1. **Two live options.** At least one alternative was genuinely available — not a
   strawman, not an option ruled out by a constraint nobody could change.
2. **A consequence that outlives the change.** Reversing it later costs more than
   writing the code again: a data shape, a public interface, a dependency, a
   deployment boundary, an operational surface someone will be paged about.
3. **A force that made it necessary.** A requirement, a limit, a failure, a deadline,
   a compliance rule, a cost — something outside personal preference.

**The first refusal.** When the change fails any of these, you do not open a record.
Write instead:

```
No decision to record — <the one condition it fails>
What this change is: <one line>
What would make it an ADR: <the specific missing condition>
```

Renaming a module, adding a field to an existing shape, following a convention already
established by an earlier ADR, upgrading a dependency inside its own major version, and
"we picked the only library that does this" are all changes with no decision behind
them. An ADR for each of those is a directory nobody reads six months later, and it
makes the records that do matter cost more to find.

If the caller insists after that answer, record it — and put the sentence
`This record was opened at the author's instruction; the decision test above failed on
<condition>.` at the top. Do not silently drop the finding.

## 2. Find the repository's own ADR shape

```bash
ls doc/adr docs/adr docs/decisions docs/architecture/decisions adr 2>/dev/null
find . -path ./node_modules -prune -o -iname '*adr*' -name '*.md' -print 2>/dev/null | head -30
grep -rln "^## Status\|^status:\|^## Context and Problem Statement" --include='*.md' . | head -20
```

| What you find | What you do |
|---|---|
| Existing records | Match them exactly — heading set, numbering width, filename slug style, front matter or not. Name the file you matched. |
| A template file in the repo | Use it, and say which path. The repo's template outranks both files in `$SKILL_DIR`. |
| Nothing | Use `$SKILL_DIR/madr-template.md`, and say that no existing record was found and which globs you searched. |

Nygard's shorter form (`$SKILL_DIR/nygard-template.md`) is right when the repo's
existing records are already that shape, or when the caller asks for it. Do not migrate
a repository from one shape to the other as a side effect of recording one decision.

Take the number from the directory, never from a guess:

```bash
ls <adr-dir> | sort | tail -5
```

The next number is one past the highest that exists. If two records already share a
number, say so — that is a finding about the directory, not something to route around
by picking a third.

## 3. Build the alternatives ledger — this is the skill

An ADR's rejected options are the part a later reader cannot reconstruct and the part a
model is most likely to invent, because every ADR template has a section shaped like a
hole and the plausible fillings are cheap. Three real options with pros and cons appear
under the heading whether or not anybody ever considered them.

**Two sources are admissible, and there is no third.**

| Source | Recorded as | Requires |
|---|---|---|
| The author told you | `stated by author` | their own words, quoted verbatim from `$ARGUMENTS` or from a document they pointed you at |
| The repo shows it was tried | `tried in-tree` | a commit sha, a deleted path, or a `path:line` |

Repo evidence means the tree carries a trace of the approach having existed:

```bash
git log --oneline -20 --grep='revert' -i
git log --diff-filter=D --name-only --oneline -- '<area>' | head -40
git log --oneline --all -S'<library, class or symbol name>'
git log -p --oneline -- go.sum package-lock.json Gemfile.lock | grep -n '<package>'
grep -rn "we tried\|used to\|previously\|instead of\|replaced\|migrated from\|no longer" \
  --include='*.md' --include='*.go' --include='*.ts' --include='*.py' . | head -40
grep -rn "TODO\|NOTE\|HACK\|XXX" --include='*.*' . | grep -i '<the approach>' | head -20
```

A reverted commit, a deleted module, a dependency that entered and left the lockfile, a
branch that was never merged, and a comment naming the approach and why it went away
are all evidence. Each one enters the ledger with its address: the sha, the path, or the
`path:line`.

**The second refusal.** Anything with neither source does not become an option with a
short paragraph attached. Under Considered Options you write exactly:

```
Alternatives not evidenced — author must supply.
  What I searched: <the commands above, as run, with their hit counts>
  What I would need: the options you actually weighed, and one line each on why they lost.
```

That line is not a failure of the record. It is the record telling its reader that the
alternatives section is empty because nobody has filled it, which is a different fact
from a decision having been made without alternatives — and the two are indistinguishable
once a model has written three plausible ones.

Two related refusals in the same place. You do not manufacture pros and cons for an
option the author supplied without them: the option is listed with `rationale not
supplied`. And you do not write a status-quo option ("do nothing") unless somebody
actually proposed it or the tree shows it holding, because a strawman in the losing
column makes the decision look more considered than it was.

## 4. Context: forces, each with an address

Every sentence in Context is one of three things, and it is labelled as such if it is
not the first:

- **Cited** — a `path:line` in this repo, a command with its real output, or a verbatim
  quote from the brief the author supplied.
- **Stated by author** — quoted from `$ARGUMENTS`, in their words, not paraphrased into
  something tidier.
- **Assumed — unconfirmed** — everything else, gathered into one list at the end of the
  section, each with the question that would settle it.

No number that is not cited. Traffic, latency, size, cost, team size, deadline: if the
repo or the author did not state it, it does not appear, and `<unstated>` appears in its
place with the source that would state it. A capacity figure invented to make the
Context read well is the single most quotable sentence in a document nobody checks.

## 5. Decision, and consequences with observables

Decision is one paragraph in the active voice, naming what will be true of the code.
Where the decision is already implemented, cite it: `path:line`.

Consequences are the second half of what a later reader needs, and they are as easy to
pad as alternatives. **Every consequence names something observable** — a build step
that changes, a runtime behaviour, an on-call surface, a migration someone has to run,
an interface other teams have to move to, a cost that appears somewhere. "Improves
maintainability", "increases flexibility" and "better separation of concerns" name
nothing and are deleted.

**The third refusal.** A consequence you cannot attach an observable to is dropped, and
the drop is counted:

```
Consequences dropped as unobservable: 4
```

Print that count even when it is zero, so a reader can tell a record that filtered from
one that had nothing to filter.

Split the consequences honestly: what gets better, what gets worse, and what becomes
harder to reverse. A consequences list with nothing in the second and third columns has
not been written yet.

## 6. Status is `Proposed`

**The fourth refusal.** You write `Status: Proposed` and no other value. Not `Accepted`,
not `Approved`, not `Adopted` — including when the code is already merged, when the
author says it was decided last week, and when the record is being written to document
something that has been running in production for a year.

The substitute is two lines in the record:

```
Status: Proposed
Accepted by: not established — acceptance is a person's act, recorded outside this command
```

and, where the repository shows how acceptance is done here (an earlier record's
`Accepted` line, a `CODEOWNERS` entry over the ADR directory, a review rule in
`CONTRIBUTING.md`), one line naming it with its `path:line`. If the repository shows
nothing, say that too.

Marking a record accepted is a decision, and nothing in this package decides. A merged
pull request changing `Proposed` to `Accepted` is a person doing it, with their name on
it, which is the thing an ADR's status field is for.

Where a record supersedes an earlier one, add `Supersedes: ADR-NNNN` — and say in your
output that the earlier record's own `Superseded by` line is a second edit a person has
to make, because leaving one half of that pair is how an ADR directory starts lying.

## 7. Date, deciders, and the metadata nobody checks

- **Date** comes from a command you ran (`date -u +%F`), or from the commit you are
  recording (`git log -1 --format=%ad --date=short <sha>`). Never from what you believe
  today's date to be.
- **Deciders** are names the author gave you or names in the commit trailers of the
  evidence you cited. Never a role title standing in for a person, never a name inferred
  from `git log` over the area. Unsupplied is `Deciders: not established`.
- **Tags, consulted, informed** are left empty rather than filled plausibly. An empty
  field is honest; a populated one is a claim about who was in the room.

## The refusals

- **It will not invent a rejected alternative.** With no author statement and no in-tree
  trace, Considered Options carries `Alternatives not evidenced — author must supply`
  plus the searches that came back empty.
- **It will not write `Accepted`.** Every record it produces says `Status: Proposed` and
  names acceptance as a person's act, whatever the state of the code.
- **It will not open a record for a change that decided nothing.** It writes
  `No decision to record` with the condition that failed and what would make it an ADR.
- **It will not write a consequence with no observable**, or a number the repo and the
  brief do not state. The first is dropped and counted; the second is `<unstated>` with
  the source that would state it.

## Output

Report first, record second, so a reader sees the gaps before the prose:

```
ADR-<NNNN> — <title>
Status: Proposed
Template: MADR | Nygard | <repo template path>  — matched to <path> | no existing records found
File: <adr-dir>/<NNNN>-<slug>.md — written | not written (say which, and why)
Decision test: passes | opened at author's instruction, failed on <condition>
```

Then the record itself, in the template's shape.

Then an **Evidence appendix**, which is the part that makes the record auditable:

| Element | Source | Address |
|---|---|---|
| Context: "the queue drops messages above 4 KB" | cited | `src/queue/publish.go:118` |
| Option: SQS FIFO | stated by author | quoted from the brief |
| Option: local disk spool | tried in-tree | reverted in `a91f0c2`, deleted `src/spool/` |

Close with **Not established** — every element the record needed and did not get, each
with the one question or command that would get it, and this line when it applies:

```
Consequences dropped as unobservable: N
```

If Not established is empty, say so explicitly. A reader has to be able to tell a
complete record from a truncated one.

## The four questions

When `$ARGUMENTS` is empty, or when the decision is stated but the alternatives are not,
ask these and stop:

1. What did you decide, in one sentence?
2. What else was genuinely on the table, and why did each one lose?
3. What forced the decision — which requirement, limit, failure or cost?
4. What gets worse because of it, and who notices?

Question 2 is the one this command cannot answer for you, and it is the reason the
record is worth writing.
