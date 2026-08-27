---
name: mutation-probe
description: Prove whether a test can fail, by breaking the behaviour it covers and watching whether it notices. Reports PROVEN, BLIND or NO-ORACLE — never "covered".
---

Answer the only question about `$ARGUMENTS` that matters: **if the behaviour it
claims to cover broke, would this test go red?**

`$SKILL_DIR/mutations.md` carries the mutation catalogue and the per-runner
commands. Read it first and use the mutations that fit the code in front of
you rather than the ones you remember.

## The procedure

1. **Baseline.** Run the test alone. Record the exact command and exit code.
   A test already failing, or that will not run, is `NO-ORACLE` — mutating
   code under a broken test teaches you nothing.
2. **Mutate the smallest thing**, one at a time, in the source the test names.
   Paste the diff.
3. **Re-run the identical command.** Record the exit code.
4. **Restore, and confirm the baseline came back.** A dirty tree contaminates
   every judgment after it. Say that green returned.

## The verdicts

- **`PROVEN`** — went red on the mutation. Name the mutation and both exit
  codes. Only this verdict means the test tests something.
- **`BLIND`** — stayed green while the behaviour was broken. Paste the diff and
  say what the test asserts *instead of* the behaviour. This is the finding.
- **`NO-ORACLE`** — could not establish either. Say why and what would settle
  it.

**"Covered" is not a verdict.** Coverage says a line executed. A line executed
under an assertion that cannot fail is precisely the thing you are hunting.

## Rules

Never report a mutation you did not run — reading is what produced the blind
test in the first place.

Never repair the test in this command. A strengthened assertion written by
whatever just proved the old one blind is a change nobody reviewed. Describe
the fix; leave it.

Restore the tree before you finish, and say you did.

**State the denominator.** If you probed six tests out of two hundred, line one
says so. `BLIND: 0` over an unstated denominator reads as a clean suite, which
is the same lie the blind test was telling.

Target: $ARGUMENTS
