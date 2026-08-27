---
name: assumption-audit
description: Grade the assumptions a plan rests on — SUPPORTED only with a file:line, a command's real output, or a page fetched this session; everything else is UNTESTED.
---
Audit the assumptions a plan depends on. The plan — a path in $CWD, or the plan text
itself, and it may be empty: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop. This
skill grades one artifact and has to be able to quote it; there is no auditing "the
plan" in general and no auditing a document from memory.

Read the whole thing before extracting anything. An assumption in §2 is often
established in §7, and a first pass that grades as it reads will report the author's
own answers as gaps.

## 1. Extract the assumptions

An assumption is a claim the plan depends on and does not establish. Every plan carries
more of them than it lists, and the ones it lists are rarely the dangerous ones — a
claim the author knew to write down is a claim the author already examined.

Where they hide:

- verbs of certainty — *will*, *simply*, *just*, *obviously*, *already*, *of course*;
- unquantified comparatives — "faster", "at scale", "lightweight", "cheap";
- capacity in the passive voice — "can be handled", "is supported", "is straightforward";
- any sentence whose subject is someone outside the room — "users will", "the vendor
  supports", "ops can", "the team knows";
- a number with no source, and a name with no owner.

**State each one so it can be false.** Rewrite until a specific observation would
falsify it:

- "the queue is fast enough" → "enqueue p99 stays under 50 ms at three times today's
  peak volume"
- "we can reuse the auth client" → "the existing auth client refreshes a token with no
  browser round trip"
- "users want this" → "at least one of the last five support threads asks for it"

A claim you cannot rewrite this way is a preference, not an assumption. Preferences go
in their own list at the end, ungraded. Never grade a preference: an unfalsifiable claim
with a status beside it is the worst line in any document, because it borrows the
authority of every line that earned one.

Group each by where its evidence would have to come from — **this repository** (what the
code does), **data you already hold** (logs, metrics, an export), **outside** (a person,
a customer, a vendor, a regulator), or **the future** (a schedule, something someone else
ships). The group predicts the cost of the test and tells the reader which assumptions
nobody in the room can settle.

## 2. Grade each one, and never grade it from the plan

Three statuses, and there is no fourth:

| Status | Earned by |
|---|---|
| `SUPPORTED` | An artifact you can point at: `path/to/file.ts:412`, a command with its real output shown, or a URL you fetched in this session with the sentence quoted verbatim. |
| `CONTRADICTED` | The same kind of artifact, showing the claim is false. |
| `UNTESTED` | Everything else. |

The plan is not evidence for the plan. A later section that asserts the assumption, a
diagram that draws it, a bullet that repeats it in different words — none of that moves
a row off UNTESTED. Evidence comes from outside the artifact under audit.

**The refusal.** You will not write SUPPORTED without naming the artifact in the
Evidence column. When the only thing on offer is judgment — "seems reasonable",
"standard practice", "everyone does it this way", "the team is confident" — the status
is UNTESTED and the Evidence column carries that phrase verbatim, in quotes, with its
section number, in the same column a file:line would have occupied. The reader has to
see what was offered instead of evidence, in the place they were looking for evidence.

Never invent the artifact. A file:line you did not open, a command output you did not
run, a page you did not fetch this session: each one turns the audit into the thing it
exists to catch, and it is undetectable to everyone downstream.

## 3. Rank by what collapses, not by what is likely

For each assumption, name what stops working if it turns out false, and cite the plan's
own sections. Order the table by that blast radius — the number of plan items that
depend on the assumption — with the count and the section numbers shown.

Do not rank by likelihood. A likelihood you assign is a second assumption wearing a
percentage, and it will be read as the audited kind.

## 4. Design tests that can fail

A test earns its place only if some result exists that would make you abandon the
assumption. Write that result down *before* you write the test; if you cannot name it,
what you have designed is a demonstration, and you are running it to feel better.

Each test is one of exactly two shapes:

- **A command** — the exact line, the directory it runs in, and the output that would
  falsify. `rg -c 'retryOnConflict' src/` is a test. "Investigate the retry path" is not.
- **A bounded human action** — who does it, what they do, what they would have to see or
  hear for the assumption to be false, and what artifact comes back (a transcript, a
  screenshot, a row count, a written answer). "Talk to users" is not one. "Ask the three
  customers who filed #4412 whether they would keep the old flow, and record each
  answer" is.

Prefer the cheap test that can produce a falsifying result over the thorough one that
cannot. A test designed to confirm passes for reasons unrelated to the assumption.

**The refusal.** You will not propose a test you cannot state in one of those two
shapes. An assumption whose test you cannot write goes under `Untestable as written`,
with the reason and the fact that would have to exist before a test could be designed —
and the number of those drops is printed in the closing line. A reader must be able to
tell an audit that filtered hard from an audit that ran out of ideas.

## 5. The premortem pass — a pass, not a second deliverable

Before writing the output, run one round of prospective hindsight. Fix a date far enough
out that the plan has been fully carried out. Assert as established fact that it failed —
not "might fail", *failed* — and write the reasons someone would give at that meeting,
quickly and without filtering. Asserting the failure rather than imagining it is the
whole technique: a mind explaining a fact it has been handed generates specific causes,
where a mind assessing a risk generates hedges.

Then map each reason back to an assumption on your list. A reason that maps to nothing
is an assumption you missed: add it in falsifiable form and grade it like the rest.

The reasons themselves are not output. A second list of ways things could go wrong is
padding beside a graded ledger, and the ledger is the deliverable.

## Output

Markdown, in this order, and nothing before it:

```
ASSUMPTION AUDIT — <plan title>
Source: <path> (<n> lines) | pasted text (<n> lines)
Tree: <output of `git rev-parse --short HEAD`>, if any claim was checked against code
```

**Assumptions, ordered by what fails if they are false**

| # | Assumption (falsifiable form) | Evidence would live | If false | Status | Evidence |
|---|---|---|---|---|---|
| 1 | enqueue p99 stays under 50 ms at 3x peak | data you hold | §3 and §5.2 stop — 2 of 9 items | UNTESTED | "standard practice" (§3, para 2) |

**Tests worth running** — ordered to match the table above.

| # | Tests assumption | Command, or bounded human action | Result that would falsify | What comes back |
|---|---|---|---|---|

**Untestable as written (n)** — one line each: the assumption, and the fact that would
have to exist before a test could be written.

**Preferences, not assumptions (n)** — quoted, ungraded, no status column.

Close with one line and nothing after it:

```
9 assumptions · 2 supported · 1 contradicted · 6 untested · 3 tests dropped as unstatable
```

No summary of the plan's merits and no recommendation to proceed. An audit that ends in
a verdict is an audit whose grades stopped mattering three lines earlier.
