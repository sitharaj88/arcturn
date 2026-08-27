# Nygard template

The original five-section decision record — Title, Status, Context, Decision,
Consequences — complete, with the rule for every field that `/adr-record` cannot fill
from evidence.

This file is data. Nothing in this folder is executable, nothing here runs at install
time, and the commands below are printed for a human or an agent to run in a session.

Use this shape when the repository's existing records already carry `## Status` /
`## Context` / `## Decision` / `## Consequences`, or when the caller asks for it. It is
the right shape for a team that writes many small records: there is no options section
to leave half-filled, which removes the most inviting hole in the MADR form.

The trade is real and worth stating: the losing options live inside Context here, in
prose, so the discipline that keeps them evidenced has to be applied by the writer
rather than by the heading. `/adr-record` applies the same two-source rule either way.

---

## The template

```markdown
# <NNNN>. <short present-tense title naming the decision>

Date: <YYYY-MM-DD, from `date -u +%F` or the commit being recorded>

## Status

Proposed

Accepted by: not established — acceptance is a person's act, recorded outside this command

<When this record replaces an earlier one, add both lines and say in the report that the
earlier record needs its own edit:>

Supersedes: <NNNN>. <title>

## Context

<Present tense, value-neutral, describing forces rather than the choice. Two to five
sentences. Every factual sentence carries its address — `path:line`, a command with its
real output, or a verbatim quote from the author's brief.>

<The options that lost belong here, each with its source:>

Also considered: <option> — stated by author | tried in-tree (`<sha>` / `<path>`), and
lost because <the driver it failed, with that driver's address>.

<When no option has either source:>

Alternatives not evidenced — author must supply.
  What I searched: <commands, with hit counts>
  What I would need: the options you weighed, and one line each on why they lost.

Assumed — unconfirmed:
- <each unsourced statement the context needs, with the question that would settle it>

## Decision

We will <the change, in the active voice, naming what becomes true of the code>.

<Where it is already implemented, cite it: `path:line`.>

## Consequences

<What becomes easier, what becomes harder, and what becomes expensive to reverse. One
observable per line — a build step, a runtime behaviour, an interface other teams move
to, a migration someone runs, an on-call surface, a cost that appears somewhere.>

Easier:
- <…>

Harder:
- <…>

Harder to reverse:
- <…>

Consequences dropped as unobservable: <N>

## Confirmation

<A command, test id, lint rule, CI job or type that checks the decision holds. If
nothing checks it:>

No check exists for this decision. `/fitness-function "<the rule as a predicate>"`
is the command that would build one and prove it bites.
```

---

## Field rules

| Section | Filled from | When it cannot be filled |
|---|---|---|
| Status | fixed | Always `Proposed`, whatever the state of the code, plus the `Accepted by` line. |
| Date | `date -u +%F`, or `git log -1 --format=%ad --date=short <sha>` | Never from memory. |
| Context | `path:line`, command output, or a verbatim quote from the brief | the sentence moves under `Assumed — unconfirmed` with its question. |
| Context: also considered | author statement, or in-tree trace (`<sha>`, deleted path, `path:line` comment) | the three-line `Alternatives not evidenced` block. |
| Decision | one paragraph, active voice | if you cannot state it in one paragraph, the record is covering more than one decision — split it. |
| Consequences | an observable per line | drop it and add one to the drop count. |

## Status values this template accepts

`Proposed`, `Superseded by <NNNN>`, `Deprecated`. `/adr-record` writes only the first.

`Accepted` and `Rejected` are values a person writes, in a commit with their name on it.
That restriction is not a property of Nygard's form — his original moves records from
proposed to accepted freely — it is this package's rule, because nothing here decides
anything.

## Numbering and filenames

```bash
ls <adr-dir> | sort | tail -5
```

`NNNN-kebab-case-title.md`, zero-padded to whatever width the directory already uses.
Nygard's original convention numbers from `0001` and never reuses a number, including
for records that were later superseded — a gap in the sequence would itself be a
missing record.

## Where this shape comes from

Michael Nygard's 2011 post "Documenting Architecture Decisions" defined these five
sections, and the `adr-tools` command line implements them. Match the repository's
existing records rather than this file where the two differ, and name the record you
matched in your output.
