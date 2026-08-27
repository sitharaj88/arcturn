# failure-design

The design packs in this hub cover writing a design, reviewing it, pressure-
testing a plan and watching complexity grow. None of them cover what happens
when a dependency answers slowly.

This one does, and it is built around a single asymmetry: **"add a retry" is
the cheapest thing to say in a review and, over a non-idempotent write, it is a
duplicate-charge bug.** It fires only when the first attempt succeeded and the
response was lost — a timeout — which is exactly the case that has no fixture.
So it reads as hardening in review and behaves as a defect in production.

Retry safety here is decided by **running the operation twice**, never by
reading it, and no later stage may soften that verdict.

## Install

```bash
arcturn inspect sitharaj88/arcturn/examples/failure-design   # read first
arcturn add     sitharaj88/arcturn/examples/failure-design
```

## The commands

| Command | Answers | Refuses |
|---|---|---|
| `/retry-audit` | Every retry in the tree, its **effective** attempt count across all layers, and whether the operation underneath is safe to run twice | Treating an idempotency key as proof. It is only worth something if the receiver enforces uniqueness and the check-then-write is atomic |
| `/timeout-budget` | The timeout chain hop by hop — where it is absent, inverted, unbudgeted or starving a shared pool | Reporting a library default as configuration. Recommending a number it cannot ground in a measurement |
| `/failure-modes` | Every dependency through down, **slow**, wrong and partial, with what actually happens at a `path:line` | The word "handled" — caught-and-rethrown, caught-and-logged, caught-and-swallowed and returned-as-empty are four behaviours and one word |
| `/consistency-check` | Dual writes, transaction boundaries that end earlier than the code assumes, read-after-write races | "Exactly once." It does not exist across a network boundary, and a document claiming it is a finding |

## The pipeline

`/workflow failure-review <service, module or design>` — map, then two disjoint
branches (prove what is retry-safe / work the four modes), then a person, then
one write-lane stage. Four stages, $28 ceiling.

## Slow is the mode that takes systems down

Everybody designs for *down*. It fails fast and announces itself.

A dependency answering in 30s, against a caller waiting 60s, behind a pool of
20, is an outage **in the caller** — and the dependency never returned an
error. Requests that never touch it fail too, because the pool is gone. Pool
size × timeout is how long the whole pool can be held by one slow dependency,
and almost nobody computes it.

*Wrong* is the mode that stays broken: an empty list from a failing search
endpoint renders as "no results". A silent outage that looks exactly like an
answer, and nobody pages for it.

*Partial* is the mode with no fixture: a row committed and its event not
published.

## Two structural decisions

**The oracle cannot fix what it finds.** `idempotency-oracle` holds `bash` with
neither `write` nor `edit`. It drives the operation twice in its own worktree —
including the case that matters, where the first attempt *committed* and the
caller gave up — and reports `PROVEN-IDEMPOTENT`, `NOT-IDEMPOTENT` or
`NO-ORACLE`. There is no "should be fine".

**The author cannot soften the verdict.** `resilience-author` may record a
retry as safe only where the oracle proved it, and must carry the proof inline.
Everywhere else the record says `RETRY-UNSAFE — unproven` and names the check.
The whole reason this pack has an oracle is that reading has already produced
the wrong answer here, repeatedly.

## Multiply your retries

Client 3 × gateway 3 × mesh 3 is **27 attempts** at a service that is already
struggling. `/retry-audit` reports the product, because the individual counts
each look reasonable and nobody adds them up. Retries hide in SDK defaults (AWS
and GCP clients retry out of the box), sidecar policies, broker redelivery and
job-runner `attempts:` — not just the loop somebody wrote.

## Author & Support

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
