---
name: hld-draft
description: Draft a high-level design as a scaffold with labelled holes — every constraint cited to a file:line or a quoted brief, everything else Assumed — unconfirmed.
---
Draft the skeleton of a high-level design for the work described below, against the
repository in $CWD. The brief — what you want built, and the constraint you care about —
as a path or as the text itself: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop. A design
document drafted from nothing is the shape this whole package exists to refuse.

## What this produces, and what it deliberately does not

This is the only command in the package that generates a document, and it survives on one
condition: **the output is a form, not a draft you could ship.** Every statement it cannot
ground is a labelled hole with the question that fills it. The holes are counted in the
header. A reader who opens it sees an unfinished form before they see a paragraph.

That is the whole design. The value of a design document is the author's thinking, and a
document that reads as considered gets reviewed as though somebody had considered it —
the reviewers argue with prose nobody wrote on purpose, and the decision that never got
made is the one that ships. So this command is deliberately worse to read than what you
would write. It is a structure with the gaps marked, produced in a few minutes, for the
person who has to do the thinking to work down.

Two things it does not do at all:

- **It does not choose between alternatives, or write an Alternatives Considered
  section.** That is `/adr-record`, which will not invent a rejected option either.
- **It does not draw a runtime or deployment topology.** `/arch-map` refuses that from
  source and this command has strictly less to go on.

## 1. Establish both inputs, and print what each one gave you

```bash
git rev-parse --short HEAD
```

Two sources of grounding, and there is no third:

| Source | Counts as | Written as |
|---|---|---|
| this repository | `cited` | `path:line` |
| the caller's brief | `stated in brief` | a verbatim quote, in their words |

Read the brief closely enough to quote it. Paraphrasing a brief into the design is how a
requirement acquires a precision nobody asked for: "should be fast" becomes "p99 under
200 ms" between one paragraph and the next, and the number is then argued about as though
somebody chose it.

Then read the tree for what already exists in the area the brief names — modules,
interfaces, data shapes, existing checks, prior ADRs:

```bash
ls doc/adr docs/adr docs/decisions docs/architecture/decisions 2>/dev/null
grep -rln "<the domain nouns from the brief>" --include='*.md' docs/ 2>/dev/null | head
```

A prior ADR that already decided part of this is the most valuable thing you will find.
Cite it and do not re-open it.

## 2. Constraints — the section that carries the discipline

Every Constraints line ends with one of two things: a `path:line`, or a verbatim quote
from the brief. **The first refusal:** a constraint with neither does not get written as a
constraint. It moves, in the words you would have written it in, to:

```
Assumed — unconfirmed
  A1  <the constraint, as you would have stated it>
      Ratify or replace: <the one question that settles it>
```

That section is a list a human has to work through, and every item is numbered so it can
be referred to in a review comment. It is not an appendix and it is not at the end — it
sits immediately under Constraints, because a reader deciding whether the design is sound
needs to know which of its inputs are real.

Four kinds of constraint and where each is legitimately found:

| Kind | Where it is grounded |
|---|---|
| technical | a `path:line` — an existing interface, a schema, a dependency, a platform floor |
| product | a verbatim quote from the brief |
| operational | a `path:line` in a runbook, an alert config, a deploy manifest, a CI job |
| regulatory or contractual | a quote from a document the caller supplied; **never from your own knowledge of a regulation** |

The last row has no exceptions. "GDPR requires…" and "PCI-DSS says…" written from memory
into a design document are the sentences most likely to be quoted back in a meeting where
nobody has the standard open.

## 3. No number the repo or the brief does not state

**The second refusal.** Latency, throughput, request rate, data volume, retention window,
concurrency, instance counts, cost, error budget, timeout, team size, timeline. If the
repository or the brief does not state it, you write:

```
<unstated> — would come from: <the artefact that states it: a dashboard, an SLO
document, a load test, a bill, the requester>
```

Not a plausible round number, not a range, not "on the order of". A capacity figure
invented to make a sentence complete is unfalsifiable by everyone who reads it afterwards
and it will be designed against.

Where the repository does state a number, cite it exactly: a timeout in a config, a page
size in a query, a rate limit in a gateway rule, a queue's max message size, a retention
setting. Those are the numbers the design is actually constrained by, and finding them is
worth more than any number you could invent.

## 4. Components: existing ones carry addresses, new ones carry a sentence

Every component in the design is one of two things, and it is labelled:

- **exists** — with `path:line` for where it lives, and one line on what it does today.
- **new** — with the verbatim sentence from the brief that asks for it.

A component in neither category is not in the design. If the shape seems to need
something the brief did not ask for and the tree does not have, that is a design
question, not a box:

```
Wanted component (nobody asked for this)
  <name> — what it would do, and why the current shape seems to need it
  Decide: does this exist under another name, is it in scope, or does the design change?
```

Same rule for interfaces and data shapes. An operation on an interface is written only
when the brief asks for it or the tree already has it. An invented endpoint set — five
plausible REST verbs for a resource nobody specified — is the most confidently wrong
paragraph these documents contain, and it reviews as though it were considered.

## 5. Invariants must name their check

An invariant is a statement that must stay true as the system changes. It is worth
writing only if something can tell you it stopped being true.

**The third refusal.** Every invariant names a check: a command, a test id, a lint rule, a
type, a database constraint, a CI job. An invariant with no named check is **deleted from
the design** and filed under:

```
Wanted invariants (no oracle yet)
  W1  <the invariant, as a predicate>
      Would be checked by: <what kind of check, if you can name the kind>
```

That section is the input to `/fitness-function`, which turns a predicate into a check and
then proves it fails on a deliberate violation — the difference between an invariant a
document asserts and an invariant something enforces. Say so at the bottom of the section,
with the command, so the next step is on the page.

An invariant list where every item names a check is the strongest part of a design
document. An invariant list where nothing does is a list of hopes, and separating the two
is worth more than either half.

## 6. Risks: a trigger and an observable, or it is dropped

A risk with no trigger and no observable is a mood. Each one carries:

```
R1  <what goes wrong>
    Trigger:    <the condition under which it happens>
    Observable: <what you would see — a metric, a log line, a failed request, a support ticket>
    If it happens: <the response, or `unplanned`>
```

**The fourth refusal.** Risks you cannot give a trigger and an observable are dropped and
counted:

```
Risks dropped as unobservable: 3
```

Print the count even when it is zero. "Scope creep", "performance may degrade" and
"integration may be harder than expected" are the three that get dropped from almost every
draft, and their absence is the improvement.

## 7. Count the holes, and put the count in the header

The last thing you do is count what is unresolved, because that number is what stops the
document being mistaken for a finished one:

```
Holes: 14  (assumptions 6 · unstated numbers 5 · wanted invariants 2 · wanted components 1)
```

Print it in the header block, not at the end. When the count is low, say why — a design
grounded in an existing subsystem with a specific brief legitimately has few holes, and
that is a different fact from a draft that stopped looking.

## The refusals

- **It will not invent a constraint.** Neither a `path:line` nor a quote from the brief
  means the line moves to `Assumed — unconfirmed`, numbered, with the question that
  ratifies it.
- **It will not write a number the repo and the brief do not state.** It writes
  `<unstated>` and names the artefact that would state it.
- **It will not keep an invariant with no named check.** It deletes it from the design and
  files it under `Wanted invariants (no oracle yet)`, which is `/fitness-function`'s input.
- **It will not name a component that neither exists nor was asked for.** It raises it as
  a `Wanted component` and asks whether the design changes.
- **It will not write an Alternatives Considered section**, and it will not mark anything
  decided. `Status: DRAFT — not reviewed, not accepted` is the only status it writes;
  recording a decision is `/adr-record`, and accepting one is a person's act.

## Output

Markdown, and it opens with the honest header so nobody has to read down to find the
gaps:

```
HLD DRAFT — <title from the brief>
STATUS: DRAFT — not reviewed, not accepted. This is a form, not a design.
Holes: <N>  (assumptions <a> · unstated numbers <b> · wanted invariants <c> · wanted components <d>)
Brief: <path, or "pasted text">   ·   Tree @ <sha>
Grounded in: <N> citations (<M> path:line · <K> quotes from the brief)
```

Then, in this order:

1. **Problem** — what is being solved, in the brief's own words, quoted.
2. **Constraints** — each with `path:line` or a quote.
3. **Assumed — unconfirmed** — numbered `A1…`, each with its ratifying question.
4. **Scope** — in scope, out of scope, and `not stated in the brief` as a third column
   that is usually the longest one.
5. **Components** — `exists` with addresses, `new` with the sentence that asked for them.
6. **Wanted components** — the ones the shape seems to need that nobody asked for.
7. **Interfaces and data** — only operations and fields the brief or the tree evidences.
8. **Invariants** — each with its named check.
9. **Wanted invariants (no oracle yet)** — numbered `W1…`, with the `/fitness-function`
   line under them.
10. **Numbers** — a table of every quantity the design depends on: value, source
    (`path:line`, brief quote, or `<unstated>`), and what would establish the unstated
    ones.
11. **Risks** — trigger, observable, response — and the dropped count.
12. **Open questions for the requester** — every `A`, `W` and `<unstated>` gathered into
    one list a person can answer in one sitting. This is the section the document is for.

Close with one line:

```
14 holes · 22 citations · 6 assumptions to ratify · 5 numbers to supply · 2 invariants with no oracle
```

Anything that is not marked is still a draft. Say that, in those words, as the last line.
