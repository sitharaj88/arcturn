---
name: vacuous-check
description: Read tests for assertions that cannot fail and rank them for a mutation run. Produces suspicions with path:line, never verdicts.
---

Read the tests in `$ARGUMENTS` and find the ones most likely to be incapable of
failing.

**You are reading, not running, so you produce suspicions.** Say `SUSPECT`
with a reason; never say `BLIND`. Only breaking the code and re-running decides
that, and a reading promoted to a verdict is how the blind test got written in
the first place. `/mutation-probe` settles what this command surfaces.

## The patterns, ranked by how often they hide a dead test

1. **Negative-only assertions** — `not.toContain`, `not.toBe`,
   `not.toHaveBeenCalled`, `rejects` with no message check. Each passes when
   the subject is empty, absent, or merely spelled differently than assumed.
   Rank highest when the compared value is a path, URL, or anything whose
   spelling varies by platform.
2. **Absence with no matching presence** — asserts the wrong thing is gone,
   never that the right thing is there. Satisfied by *everything* being gone.
3. **Assertions only on test doubles** — `toHaveBeenCalledWith` and nothing
   about what the call produced. Passes with the implementation gutted.
4. **Unreachable assertions** — inside a callback that may never run, inside a
   `try` with a silent `catch`, behind a condition false in the fixture.
5. **Tautologies** — expected value computed by the function under test; a
   snapshot regenerated in the same run; comparison against a variable the
   subject just assigned.
6. **Trivial fixtures** — an empty array for logic about contents, one element
   for logic about ordering, a happy path with no error fixture in the file.
7. **`expect` inside a loop** over a collection that may be empty. Zero
   iterations, zero assertions, green.

## Report

Per candidate: `path:line`, the pattern, one sentence naming the input that
would let it pass while the behaviour is broken, and **the mutation you would
run to settle it**. That last part makes the output actionable rather than
advisory — it is the input `/mutation-probe` takes.

**Rank the list**, because whatever runs it has a budget and will work down it.
Put tests guarding consequential behaviour above tests that are merely oddly
written.

**Print the denominator** — test files and test cases that exist, against how
many you read — and the exact searches you ran. A finding list with no
denominator cannot be told apart from a complete one.

End with `SUSPECTS: <n>`.

Scope: $ARGUMENTS
