# MADR template

The Markdown Any Decision Record shape, complete, with the rule for every field that
`/adr-record` cannot fill from evidence. Copy the block under "The template" into the
new record and work down it.

This file is data. Nothing in this folder is executable, nothing here runs at install
time, and the commands printed below are for a human or an agent to run in a session —
which is what makes their output evidence rather than recollection.

Use this shape when the repository has no existing records, or when its existing records
already carry `## Context and Problem Statement`. When the repository has its own
template file, that file wins over this one.

---

## The template

```markdown
---
status: "proposed"
date: <YYYY-MM-DD, from `date -u +%F` or the commit being recorded>
decision-makers: <names the author supplied, or empty>
consulted: <names the author supplied, or empty>
informed: <names the author supplied, or empty>
---

# ADR-<NNNN> — <short present-tense title: the problem and the chosen solution>

## Context and Problem Statement

<Two to four sentences. What is true that makes a decision necessary, and what question
is being decided. Every factual sentence is followed by its address — `path:line`, a
command with its output, or a verbatim quote from the author's brief.>

Assumed — unconfirmed:
- <each unsourced statement the context needs, with the question that would settle it>

## Decision Drivers

- <force, with its address>
- <force, with its address>

## Considered Options

1. <option> — stated by author | tried in-tree (`<sha>` / `<path>` / `<path:line>`)
2. <option> — stated by author | tried in-tree (`<sha>` / `<path>` / `<path:line>`)

<When neither source exists for any option, this section is exactly these three lines
and nothing else:>

Alternatives not evidenced — author must supply.
  What I searched: <commands, with hit counts>
  What I would need: the options you weighed, and one line each on why they lost.

## Decision Outcome

Chosen option: "<option>", because <the driver it satisfies that the others do not,
with the driver's address>.

<Where the decision is already implemented, cite it: `path:line`.>

### Consequences

Good:
- <what gets better, and the observable that shows it — a build step, a runtime
  behaviour, an interface, a cost, an on-call surface>

Bad:
- <what gets worse, same rule>

Harder to reverse:
- <what this closes off, and what reopening it would cost>

Consequences dropped as unobservable: <N>

### Confirmation

<How compliance with this decision is checked. Name a command, a test id, a lint rule,
a CI job or a type. If nothing checks it, write:>

No check exists for this decision. `/fitness-function "<the rule as a predicate>"`
is the command that would build one and prove it bites.

## Pros and Cons of the Options

### <option 1>

- Good, because <…>
- Bad, because <…>

<An option the author supplied without rationale carries exactly one line:>

rationale not supplied

## More Information

- Supersedes: ADR-<NNNN>  <or omit>
- Related: <paths, issues, records — each an address, not a description>
- Deciders: <names, or `not established`>
```

---

## Field rules

| Field | Filled from | When it cannot be filled |
|---|---|---|
| `status` | fixed | Always `proposed`. `/adr-record` writes no other value. |
| `date` | `date -u +%F`, or `git log -1 --format=%ad --date=short <sha>` | Never from what you believe the date to be. |
| `decision-makers` | names the author supplied, or commit trailers on the cited evidence | `not established` — never a role title, never inferred from `git log` over the area. |
| `consulted` / `informed` | the author | left empty. An empty field is honest; a populated one is a claim about who was in the room. |
| Context | `path:line`, command output, or a verbatim quote from the brief | the sentence moves to `Assumed — unconfirmed` with its question. |
| Decision Drivers | same as Context | a driver with no address is not a driver; drop it. |
| Considered Options | author statement, or in-tree trace | the three-line `Alternatives not evidenced` block. |
| Consequences | an observable per line | drop it and add one to the drop count. |
| Confirmation | a command, test id, lint rule, CI job or type | the `No check exists` block naming `/fitness-function`. |

## Numbering and filenames

```bash
ls <adr-dir> | sort | tail -5
```

`NNNN-kebab-case-title.md`, zero-padded to whatever width the directory already uses.
The next number is one past the highest that exists. Two records already sharing a
number is a finding to report, not something to route around by taking a third.

## Where this shape comes from

MADR is a community template maintained at `adr.github.io/madr`. The section set above
is the long form; the short form drops Decision Drivers, Pros and Cons, and More
Information. Match whichever form the repository's existing records already use, and do
not migrate a directory from one form to the other while recording a single decision.

Do not copy a version number or a schema URL out of this file into a record. If you need
to state which MADR revision a repository follows, read it off the repository's own
records or its template file.
