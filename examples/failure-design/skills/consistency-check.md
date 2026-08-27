---
name: consistency-check
description: Find dual writes, transaction boundaries that do not cover what they appear to, and read-after-write assumptions that the storage does not guarantee.
---

Examine `$ARGUMENTS` in `$CWD` for the places where the code assumes more
consistency than the storage actually gives it.

**The premise.** Most data-integrity bugs are not race conditions in the
clever sense. They are two writes that were meant to happen together, a
transaction that ends earlier than the code reads, or a read that assumes it
will see a write that has not replicated yet.

## Dual writes

Find every place two systems are written in one logical operation — database
plus queue, database plus cache, database plus a third-party API, two tables
in different databases, a row plus a file.

For each, ask what happens when the second one fails: the first is already
committed, and nothing brings it back. Report the resulting state
concretely — "the order exists and the payment event was never published, so
fulfilment never runs" — rather than as "inconsistency".

Then name what is actually in place, if anything: an outbox table, a
transactional publish, a reconciliation job, a saga with compensation. **A
retry around the pair is not a fix** — it re-runs the first write too, and now
you have the duplicate problem on top of the partial one.

## Transaction boundaries

For each transaction: where does it open, where does it commit, and is
everything the code *assumes* is atomic actually inside it? Look for these,
each with a `path:line`:

- A read taken before the transaction and used inside it
- An external call inside a transaction — it holds the row locks for the
  duration of somebody else's outage
- An `after-commit` side effect that is not actually after commit
- A check-then-act split across the boundary: read, decide, write, with
  another transaction free to run in between

Name the **isolation level** if the code or config sets one, at its
`path:line`. If nothing sets it, say so and name the engine's default as an
inference rather than a finding — the default differs across engines and
managed configurations, and it decides whether the check-then-act above is a
bug.

## Read-after-write

Find reads that assume they will see a write that just happened: a read
replica after a primary write, a cache read after invalidation, a search index
after an update, an eventually-consistent object store, a queue consumer
reading a row its producer just wrote.

For each, say what the user sees when the read loses the race — usually a
just-created thing appearing not to exist, which is reported as data loss.

## Claims not available here

- **"Exactly once."** It does not exist across a network boundary. What exists
  is at-least-once with idempotent handling, or at-most-once with loss. Say
  which the code implements. If a comment or document claims exactly-once,
  that contradiction is a finding, cited.
- **"Atomic"** where two systems are involved, unless there is a real
  distributed transaction and you can point at it.
- An ordering guarantee from a queue that does not give one — partitioned
  topics order within a partition only, and the partition key is the thing to
  report.

## Report

Per finding: `path:line`, the interleaving or failure that produces the bad
state, the bad state in concrete terms, and what is in place today. Rank by
whether the result is silent — a wrong answer nobody notices outranks an error
somebody sees.

End with `DUAL WRITES: <n> / BOUNDARY: <n> / READ-AFTER-WRITE: <n>` and an
`UNKNOWN` block naming what needs the running system to settle.

Scope: $ARGUMENTS
