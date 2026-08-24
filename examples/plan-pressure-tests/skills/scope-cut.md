---
name: scope-cut
description: Order scope cuts by dependency read out of the import graph, every edge with its file:line — never by value, and no cut called safe without a named consumer.
---
Take a scope list somebody wrote and produce a cut order grounded in the repository's
own dependency edges. The list — a path in $CWD, or the items themselves one per line,
and it may be empty: $ARGUMENTS

If $ARGUMENTS is empty, or names a path that does not exist, say which and stop.

What this produces is an ordering by entanglement: what can come out alone, what drags
other items with it, and who stops being served in each case. What is *worth* keeping is
a different question, it belongs to the people who own the outcome, and section 5 hands
it back to them in writing.

## 0. Record the commit you are reading

```bash
git rev-parse --short HEAD
```

Every edge below is an edge at that commit. Print it in the header, because an import
graph is a fact with an expiry date.

## 1. Map each item to code

An item you cannot locate in the tree cannot be ordered by dependency at all. Map each
one to paths, exported symbols, a directory, a route, a config key or a feature-flag
name, and record **how** you mapped it — the search, not just the result.

Items you could not map go in their own list with the patterns you tried. They are not
ordered, they are not proposed as cuts, and they are never described as "probably
independent". An item nobody can find in the code is an item whose blast radius is
unknown, and unknown is a result.

## 2. Build the edge ledger, one line of evidence per edge

For each pair of mapped items, find the code that connects them:

```bash
rg -n '^\s*(import|from|require\(|use |#include|package )' <paths>
rg -n '<the exported symbol>' --glob '!**/{dist,build,node_modules,vendor}/**'
```

Print every edge as `from-file:line → to-item` with the import line quoted verbatim. An
edge you cannot cite to a line is not an edge; it is a suspicion, and it goes in the
unresolved list where a reader can see it is one.

Three kinds, kept apart because they carry different weight:

- **static import** — resolved to the target file. The only kind that carries an
  ordering guarantee, because removing the target breaks the source at build time.
- **package dependency** — a manifest entry (`package.json`, `pyproject.toml`, `go.mod`,
  a Gradle or Cargo file). Real but coarse: it links packages, not items.
- **unresolved** — dependency injection, a string-keyed registry, a dynamic import, a
  reflective load, a route table, a template reference, a config key read at runtime.
  These get their own section, marked unresolved, and they never enter the ordering as
  though they had been resolved.

## 3. Degrees, and what independence means here

For each mapped item, count in-degree (mapped items that import it) and out-degree (what
it imports). An item nothing imports is **independently removable — at this commit,
under the searches shown**. That qualifier is part of the claim, not decoration.

An item something imports cannot come out alone. Name every item that would have to come
out with it or be stubbed, and count them: that count is the item's cut cost.

## 4. The order

Leaves first, then by cut cost ascending. Every position must be walkable back to a
printed edge — a reader who disagrees with the order should be able to point at the line
that produced it.

**Ties are reported as ties.** Two items with the same cut cost are not ranked against
each other; print them at the same position and say so.

**The refusal.** You will not order by value, impact, user demand, revenue, strategic
importance or "what the team cares about" — not because those do not matter, they decide
the outcome, but because nothing in the repository grounds them. An order that mixes a
counted edge with an uncounted judgment reads as though both had been counted, and the
judgment inherits the authority the count earned. Where the graph leaves a choice open,
say so and hand it back in one sentence:

```
Items 3, 5 and 7 each come out with no edges to cut; which of them is worth keeping is
yours to order — the graph does not distinguish them.
```

## 5. Who notices the absence

Every item in the cut order names a consumer that stops being served, with a citation: a
route, a CLI command or flag, an exported symbol used elsewhere, a config key somebody
sets, a documented behaviour, a test, a scheduled job, a dashboard query.

**The refusal.** When you cannot name a consumer, you write `impact unknown — author
must supply`. You do not write "safe to cut", "no impact", "internal only" or "appears
unused". A search that found no callers is not proof there are none: dynamic dispatch, a
string-keyed lookup, a caller in another repository, a public interface somebody
vendored, a customer's script and a query a person runs by hand are all invisible to it.
Unknown impact is a real result and it belongs in the table, in the same column an
impact would have occupied.

## 6. Two things you never propose

- **Never a test, a check, a migration guard or an invariant as the thing to cut** to
  make another cut cheaper. That is not removing scope, it is removing the thing that
  would have told you the removal was wrong.
- **Never an edit.** This produces an order, not a patch. The items stay in the plan
  until a person takes them out, and that person will want the edge ledger open beside
  them while they do it.

## Output

Markdown, in this order:

```
SCOPE CUT — <plan title> · tree @ <sha>
Items: 12 · mapped 9 · unmapped 3
```

**Item map**

| # | Item | Maps to | How it was mapped |
|---|---|---|---|

**Edge ledger**

| From | To | Kind | Evidence |
|---|---|---|---|
| 4 (export view) | 2 (report model) | static import | `web/src/export.ts:11` — `import { Report } from "./report-model"` |

**Cut order**

| Order | Item | Cut cost | Must also come out or be stubbed | Who notices | Evidence for that consumer |
|---|---|---|---|---|---|
| 1 | 7 (CSV footer) | 0 | — | impact unknown — author must supply | no consumer found: `rg -n 'csvFooter' → 1 hit, its own definition` |

**Unresolved edges (n)**

| Between | Mechanism | Why a search cannot settle it |
|---|---|---|

**Unmapped items (n)**

| Item | Patterns searched | Hits |
|---|---|---|

**The ordering the graph cannot give you** — the one sentence from section 4.

Close with one line:

```
12 items · 9 mapped · 4 independently removable at this commit · 3 unresolved edges · 5 impacts unknown
```
