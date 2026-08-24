---
name: rfc-review
description: Review a design document for the comments that would change it — CONTRADICTED needs a file:line, HOLDS never rests on the document, and every drop is counted.
---
Review a design document somebody else wrote. The document — a path in $CWD, or the text
itself, and it may be empty: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop.

You are a reader here. You do not rewrite the document, you do not draft the section it
is missing, and you do not return a corrected version. A review that arrives as a diff
replaces the author's thinking with yours, and the author's thinking was the document's
entire product.

## 1. Read it whole, then read the tree it describes

First pass, no notes: you cannot tell whether §2 is wrong until §7 says what §2 was for,
and a reviewer taking notes from the first paragraph mostly reports things the document
answers later. Second pass with the repository open — every claim about this codebase
gets checked against this codebase, at a commit you print (`git rev-parse --short HEAD`).

## 2. Build the claim ledger

Extract the document's load-bearing claims: the statements whose falsity would change
the design. Write each as a predicate — something that is true or false about the tree,
about a running system, or about the world — and cite the section it came from.

Three grades, and there is no fourth:

| Grade | Earned by |
|---|---|
| `HOLDS` | A `path:line` you opened, or a command with its real output shown. |
| `CONTRADICTED` | A `path:line` you opened that shows the claim false. |
| `UNVERIFIABLE-HERE` | The fact lives outside this repository, or the tooling to settle it is not here. Name the fact and what would settle it. |

**The first refusal.** You will not mark a claim CONTRADICTED without a file:line. A
contradiction is the only thing in this output that can stop a design, so it pays the
highest price for entry. When you believe a claim is false and cannot address it, it is
not a grade: it becomes a comment, phrased as the question you would ask the author, and
it takes whatever rank it earns in section 4.

**The second refusal.** You will not mark a claim HOLDS on the document agreeing with
itself. §6 restating §2 is one author twice. Evidence for HOLDS comes from outside the
document — the tree, a command run in this session, or a page fetched in this session
and quoted verbatim. A document that is internally consistent and externally wrong is
exactly the failure a ledger exists to catch, and self-reference is how it gets past.

## 3. Filter the comments — this is the skill

Write down every comment you have. Then take them one at a time and write the most
plausible answer the author could give: not the weakest answer, the answer a competent
author who has already thought about it would give.

**If the design is unchanged after that answer, drop the comment.**

That test drops most of them, and it should. It drops style and wording, naming, "have
you considered §3" (they did — it is §3), section ordering, hedging you would have
phrased differently, a preference for a different diagram, a restatement of a risk the
document already lists, and every comment whose best possible outcome is that the author
writes one more sentence.

What survives has one shape: a plausible answer changes something — the interface, the
data model, the failure behaviour, the migration, the order of the work, or whether the
thing should be built at all.

**The refusal, and its substitute.** You will not print the dropped comments. Printing
them is not filtering; it is filtering with an extra heading, and the author still reads
all of it. Instead print the count, by category, on one line:

```
Dropped: 23 — style/wording 9 · naming 4 · already answered in the document 6 ·
ordering 2 · restates a listed risk 2
```

That count is what lets an author tell a review that filtered hard from a review that
had nothing to say. Print it even when it is zero, and especially then.

## 4. Rank what survives by what a wrong answer costs

1. **Shape** — this is the wrong design; a right answer changes what gets built.
2. **Interface** — the shape holds and a contract inside it is wrong; changing it later
   changes every caller.
3. **Failure behaviour** — what happens when this breaks is unspecified, or specified
   wrong.
4. **Sequence** — the order makes a later step, or a reversal, impossible.
5. **Implementation choice** — a decision inside a boundary, revisable without touching
   the document.

Each surviving comment carries four fields: the section, the claim it attacks, the
evidence or the question, and **the specific decision it would change**. A comment that
cannot name the decision it changes did not survive the filter — you kept it by
accident. Delete it and add it to the drop count.

## 5. Decided in passing

A separate short list: sentences where the document forecloses an option without
recording that it made a choice. "We store this in Postgres" in a document that never
considered storing it anywhere is a decision with no decision behind it.

This is a claim about the text, so the evidence is the text: quote the sentence verbatim
and name the option it closed. An item with no quote is dropped, and it counts as a drop.

## Output

Markdown, in this order:

```
RFC REVIEW — <title> (<path>) · tree @ <sha>
VERDICT: ADVISORY
```

`VERDICT` has one value. This review does not approve a design and has no `APPROVED` to
give: approval belongs to a person, recorded somewhere this output cannot reach.

**Claim ledger**

| # | § | Claim, as a predicate | Grade | Evidence |
|---|---|---|---|---|
| 1 | 4.2 | the workflow parser reads `budgetUsd` from frontmatter | HOLDS | `packages/cli/src/workflow.ts:1602` |

**Comments (n), ranked** — one block each, in rank order:

```
C1 · Shape · §4.2
  Attacks:  <the claim or gap, in one line>
  Evidence: <path:line, a command with its output, or the question you would ask>
  Changes:  <the specific decision that moves if the answer goes the other way>
  Closes:   <what the author could say or show that would settle it>
```

**Decided in passing (n)** — the verbatim quote, and the option it closed.

**Stated too loosely to check (n)** — the verbatim quote, and the one question that
would turn it into a predicate. Keep this list to claims that are load-bearing;
imprecision that changes nothing belongs in the drop count.

**Dropped** — the one-line count by category.

Close with one line:

```
17 claims · 11 hold · 2 contradicted · 4 unverifiable here · 5 comments · 23 dropped
```
