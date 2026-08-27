---
name: timeout-budget
description: Trace the timeout chain from entry point to leaf and find where it is unbounded, inverted, or larger than the caller's patience.
---

Trace the timeout chain for `$ARGUMENTS` in `$CWD`, from the entry point down
to each leaf dependency, and report where the budget breaks.

**The shape of the problem.** Every request has a wall-clock budget it is
allowed. That budget has to be *spent down* the call chain — an outer 2s that
contains an inner 30s is not a budget, it is a lie the outer layer tells. And
a call with no timeout at all does not fail; it occupies a connection, a
thread or a task slot indefinitely, and the outage is in the caller.

## Build the chain

For the path named, list every hop in order: entry handler → service → client
→ dependency. For each hop record the timeout with its `path:line`, and
distinguish the kinds, because they are not the same number:

- **connect** timeout — establishing the socket
- **read / per-attempt** timeout — waiting for a response
- **total / deadline** — the whole operation including retries
- **the caller's own deadline**, if there is one

A per-attempt timeout of 5s with 3 retries is a 15s total plus backoff, and
that total is what the caller experiences. Report both.

## The four findings

1. **NO TIMEOUT** — anywhere in the chain. Report it as absent, never as the
   library default: the default is a fact about a resolved version, and a
   default reported as configuration reads as a decision somebody made. If you
   infer one, say you are inferring and name the lockfile line.
2. **INVERTED** — a callee's total exceeds its caller's timeout. The caller
   gives up while the work continues; the work is orphaned, and if the caller
   retries it now runs twice. This is where retry amplification is born.
3. **UNBUDGETED** — no deadline propagated. Each hop has its own timeout and
   nothing tracks the time already spent, so the worst case is the *sum* of
   every hop rather than a bound anybody chose. Check whether a context
   deadline, `grpc-timeout` header, or equivalent is passed down; usually
   nothing is.
4. **STARVING** — several dependencies behind one connection pool or
   semaphore, where the slowest can consume the capacity the others need.
   Report the pool size next to the slowest timeout, because their product is
   how long the whole pool can be held.

## What not to do

Do not recommend a number you cannot ground. "Set it to 3s" needs the observed
latency of that dependency — a dashboard, an SLO in the tree, a load-test
result. Without one, write `UNKNOWN — <what would measure it>` and give the
shape of the answer instead: this timeout must be under its caller's, and the
total including retries must be under the entry budget.

Do not recommend lowering a timeout without saying what it converts: a slow
success becoming a fast error is a real change to what users see, and someone
other than you should decide whether that is an improvement.

## Report

The chain as a table with each hop, kind, value and `path:line`. Then the four
findings, ranked by whether they can take down the caller rather than by how
deep they are.

End with `HOPS: <n> / NO TIMEOUT: <n> / INVERTED: <n>`, and the entry budget if
one exists in the tree at all — say plainly when none does, because that is
the finding under all the others.

Path: $ARGUMENTS
