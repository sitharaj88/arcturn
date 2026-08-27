---
name: flake-hunt
description: Find tests whose result depends on order, timing, seed or shared state — established across runs, with the mechanism named.
---

Find the tests in `$ARGUMENTS` whose result depends on something other than the
code under test.

**Why this matters more than the minutes it wastes.** A flaky suite teaches a
team to press re-run. Once that reflex exists, a genuine regression gets
pressed through it too — the suite has stopped being evidence, and that is the
real cost.

## Establish it, do not observe it once

A single failure is not a finding. Run it out:

- **Repeat** — the test alone, N times, same command. Record every exit code,
  not a summary.
- **Reorder** — reverse the file, or use the runner's shuffle. A test that
  passes alone and fails after its neighbour has an order dependency, and
  **the neighbour is the finding**.
- **Isolate** — run it completely alone. Passing only alongside its file means
  it depends on shared state something else installed.
- **Reseed** — where the runner takes a seed, vary it.
- **Squeeze** — where there is a timeout or a sleep, run under load and find
  out whether the margin was real.

Paste every command and every exit code. A rate is a claim about runs, so the
runs belong in the output.

## Name the mechanism

"Flaky" is not actionable. The finding is *why*, and each of these has a
different fix:

- a shared temp directory reused across tests
- an assertion against wall-clock time or `Date.now()`
- an unawaited promise, so the assertion runs before the effect
- a hardcoded port, or a server not torn down
- a global or module-level mock installed by one test and relied on by another
- an ordering assumption over a `Set`, a `Map`, or object key order
- a filesystem operation racing its own cleanup on a platform that defers
  deletion — `ENOTEMPTY` on Windows is this, and the fix is retries on the
  removal rather than a retry on the test
- a real network call, a real DNS lookup, or a real clock

## Change nothing

Add no retry, quarantine nothing, skip nothing. **A retry converts a visible
defect into an invisible one**, and the invisible one is exactly what trains
the re-run reflex this command exists to remove.

## Report

Per test: `path:line`, the mechanism, the runs that establish it with commands
and exit codes, and the smallest change that removes the dependency —
described, not applied.

`STABLE` is a claim too: N consecutive passes, under which conditions. Never
from a single run.

End with `FLAKY: <n> / PROBED: <n> / SUITE: <n>` — all three, so a small probe
cannot be read as a clean suite.

Scope: $ARGUMENTS
