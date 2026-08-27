---
name: failure-modes
description: Work every dependency through down, slow, wrong and partial, and say what actually happens in each — at a path:line, or as a question.
---

Take `$ARGUMENTS` in `$CWD` and work each of its dependencies through the four
ways it can fail.

`$SKILL_DIR/modes.md` carries the per-mode checklist and the language to
avoid. Read it first.

## Down is not the interesting one

Everybody designs for *down*. It fails fast, it announces itself, and there is
usually a `catch` around it.

**Slow is what takes systems down.** A dependency answering in 30s against a
caller that waits 60s, behind a pool of 20 connections, is an outage in the
caller — and the dependency never returned a single error. Requests that never
touch that dependency fail too, because the pool is gone. Spend most of your
attention here, and say explicitly what happens to the pool, the queue behind
it, and the unrelated traffic.

**Wrong is the one that stays broken.** A 200 with an empty body, a truncated
list, a stale cache read. Ask whether the code can tell this apart from a
legitimate result. An empty list from a failing search endpoint renders as "no
results" — a silent outage that looks exactly like an answer, and nobody pages
for it.

**Partial is the one with no fixture.** Half a batch written. A row committed
and its event not published. Page four of seven failing. This is where the
dual-write bugs live, and it is almost never tested because constructing it
requires breaking something mid-flight.

## Two rules

**No retry recommendation for an operation whose idempotency is unproven.**
Write `RETRY-UNSAFE` and name the check. A retry over a non-idempotent write is
a duplicate-effect bug that fires only on timeout — the case with no fixture.
Use `/retry-audit` to enumerate; only a run settles it.

**No circuit breaker recommendation without saying what the caller returns
while it is open.** A breaker with undefined open-state behaviour converts a
slow failure into a fast one and nothing else — and if it returns an empty
result, it has converted a slow failure into a silent wrong answer, which is
worse than what it replaced.

## Say what happens, not that it is handled

"Handled" is not a finding. Caught and rethrown, caught and logged, caught and
swallowed, and caught and returned-as-empty are four different behaviours with
four different consequences, and only one of them is handling. Point at the
line.

## Report

Per dependency: the four modes, what happens in each with a citation, and the
gap. Rank by **user-visible consequence**, not by likelihood — a rare mode that
silently corrupts outranks a common one that errors loudly.

End with `SILENT`, listing every path where a failure becomes a
plausible-looking answer rather than an error, and `UNKNOWN`, listing what
needs the running system to settle. The first list is what this command exists
to produce.

Target: $ARGUMENTS
