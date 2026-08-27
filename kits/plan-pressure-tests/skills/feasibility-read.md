---
name: feasibility-read
description: Read a plan against this repository — what the tree supports at file:line, what searches came back empty with their patterns, and the unknowns. No estimate.
---
Read a plan against the repository in $CWD and report three things: what the tree
already supports, what it does not, and what nobody knows yet. The plan — a path, or
the text itself, and it may be empty: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop.

## 0. Record the commit you are reading

Every claim below is a claim about one state of one tree. Print which:

```bash
git rev-parse --short HEAD
git status --porcelain
```

If the working tree is dirty, say so in the header. "The tree does not do X" is a much
weaker sentence about a disk nobody else has than about a commit everybody has.

## 1. Decompose the plan into capabilities the code must have

Not tasks — capabilities. Each one is a single thing the code must be able to do,
written so that a search can settle it: "there is a way to refresh an OAuth token
without a browser", "the CLI can stream a response body incrementally", "config is
readable before the logger is constructed". A capability you cannot state that way is
not a feasibility question yet; it is an unknown, and it belongs in section 3.

Work from the plan's own text. Capabilities the plan does not need are not your subject,
however interesting the code is.

## 2. Settle each capability by search, and print the search

Four statuses:

| Status | Means |
|---|---|
| `PRESENT` | You opened the code and it does this. Cite `path:line`. |
| `PARTIAL` | It does part of this. Cite `path:line` and name the missing piece precisely. |
| `ABSENT under search` | You ran searches and they came back empty. Print them. |
| `UNKNOWN` | A search cannot settle it. Say why, and what would. |

**The refusal.** You will not write "the codebase does not do X". What you write is what
you ran and what came back:

```
ABSENT under: rg -n --glob '!**/dist/**' 'refreshToken|refresh_token' packages/  → 0 hits
              rg -n -i 'oauth' packages/                                        → 7 hits,
              all in packages/cli/src/auth.test.ts (fixtures)
```

An absence claim ships with the search that found nothing, in the output, where a reader
can run it. If you did not run a search, the status is UNKNOWN — never ABSENT.

Bound the recall while you are at it, because it is not symmetric: a hit you read is
proof, and a miss is only the absence of proof under the patterns you happened to
choose. Dependency injection, string-keyed registries, dynamic import, reflection,
code generation, re-exports through an index file, and a vendored copy under a different
name all hide a capability from a literal pattern. Where a capability is likely to be
hidden that way, say which mechanism you could not see through, and prefer a second
search shaped differently — by symbol, by config key, by dependency manifest — over one
more spelling of the first.

## 3. The unknowns, ranked by spread

An unknown is a question whose answer changes the **shape** of the work, not its amount.
Rank by spread: the distance between the cheapest world the answer opens and the most
expensive one. Name both worlds concretely, in work rather than in time:

> If the client already streams, this is one adapter behind the existing interface. If
> it does not, it is a second transport and every caller's error handling changes.

Do not rank by likelihood, and do not collapse a spread into a midpoint. The midpoint of
two different designs is not a design.

## 4. Name one spike, and only one

The spike that collapses the widest spread. Give four things: the question in one
sentence, the concrete steps or commands, what each possible result would mean, and the
stopping condition — you are done when the question is answered, or when you can state
exactly what makes it unanswerable here.

Say in the output that the spike's code is thrown away and the answer is the
deliverable. Code you intend to keep was never a spike; it is the first draft of the
work, and it needs the review the work gets.

Do not set a timebox. A timebox is a decision made with information this reading does
not have, and a timebox that arrives inside a feasibility report reads as an estimate
with a different haircut.

## 5. What this skill does not produce

**The refusal.** You will not produce an estimate in hours, days, weeks, sprints, story
points, t-shirt sizes, or any paraphrase of them — "quick", "trivial", "a big lift",
"a couple of days of work", "should be simple". When $ARGUMENTS asks for a number, the
first line of the output is exactly:

```
No estimate is produced here. What follows is the unknown list, ranked, and the one
spike that collapses the widest of them.
```

and then you write the rest of the output as specified. Do not soften the refusal by
giving the number with a caveat attached; the number is what survives the caveat.

The reason is mechanical rather than modest. A number written here becomes the anchor
every later number is adjusted from, and anchors move on details that carry no
information at all — including the unit the question happened to be asked in. A wrong
number that arrives with an evidence trail is more durable than no number, because the
trail makes it read as considered.

What you may report instead, because each of these has a search behind it: the count of
call sites you found and the search that found them; the number of files you read that
would have to change; whether a public interface is inside the blast radius; and which
unknown has to be settled before any of those counts is stable. Those are measurements,
and a measurement with its method beside it is the substitute this skill offers for the
number it will not write.

## Output

Markdown, in this order:

```
FEASIBILITY READ — <plan title>
Plan: <path> | pasted text · Tree: <repo> @ <sha><, working tree dirty>
```

**Already in the tree**

| # | Capability the plan needs | Status | Evidence |
|---|---|---|---|
| 1 | refresh a token with no browser round trip | PARTIAL | `packages/cli/src/auth.ts:88` refreshes; the device-code path at :140 opens a browser |

**Searches that came back empty**

| # | Claim tested | Patterns | Paths | Hits | What could still hide it |
|---|---|---|---|---|---|

**Unknowns, ranked by spread**

| # | Question | Cheapest answer | Most expensive answer | What settles it |
|---|---|---|---|---|

**The spike** — question, steps, what each result means, stopping condition, and the
line that the code is thrown away.

**Recall bound** — one short paragraph: what these searches structurally cannot see in
this repository, named per mechanism rather than as a general disclaimer.

Close with one line:

```
11 capabilities · 4 present · 2 partial · 3 absent under search · 2 unknown · no estimate produced
```
