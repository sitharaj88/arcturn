---
name: test-audit
description: Find the tests that cannot fail, prove it by breaking the code under them, and only then strengthen — with the mutation as the specification.
continueOnError: false
budgetUsd: 30
stepTimeoutMs: 2400000
---
Run it as `/workflow test-audit <the module, directory or suite to audit>`.

A green suite is a claim, and this pipeline is about the fact that almost
nobody checks it. A test that runs, asserts and passes may assert nothing —
and it is worse than no test, because it holds the slot a real test would take
and reports success from there indefinitely.

Stage 1 reads and ranks. It produces **suspicions**, never verdicts: only a run
can decide whether a test is blind, and stage 1 has no shell. Its real output
is the ordering, because stage 2 has a budget and works down the list.

Stage 2's two branches both hold `bash` with neither `write` nor `edit`, so
each gets a worktree and neither can land a change. They are disjoint by
question rather than by file: the oracle asks *can this test fail at all*, the
detective asks *does this test's result depend on something other than the
code*. A test can be blind and stable, or sharp and flaky, and the two
findings need different fixes.

Stage 3 is a person. Strengthening a test changes what a team is allowed to
merge, and a blind test that has been green for two years may be guarding
behaviour somebody deliberately stopped caring about. The engine does not get
to decide which of those it is.

Stage 4 is the only write-lane step, so the run fails immediately under plan
mode rather than after three stages it could not save. It holds `write` and
`edit` but no `bash` — deliberately, because the one thing this pack exists to
prevent is a stage declaring its own output verified. It writes the test and
names the command that would confirm it; it cannot run it.

1. @assertion-critic Read the tests for the target below and rank the ones most likely to be incapable of failing. Report each as SUSPECT with a path:line, the pattern it matches, one sentence naming the input that would let it pass while the behaviour is broken, and the specific mutation you would suggest to settle it. Weight negative-only assertions, absence with no matching presence, assertions only on test doubles, unreachable assertions, tautologies, and expects inside loops over collections that may be empty. Say SUSPECT and never BLIND — only a run decides that. Print the denominator: how many test files and test cases exist against how many you read, and the exact searches you ran. Target: {{input}}
2. Two questions over the ranked list below, neither able to write:
   - @mutation-oracle If the list below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise work down it in order until the budget runs out. For each test: run it alone and record the command and exit code, then mutate the smallest thing in the source it names — invert a comparison, drop a clause, return the input unchanged, no-op a function — paste the diff, run the identical command again, record the exit code, restore, and confirm the baseline returned. Report PROVEN, BLIND or NO-ORACLE for each with both exit codes, and never the word "covered". Repair nothing. End with the count probed against the count that exist. Candidates: {{prev}}
   - @flake-detective If the list below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise find the tests in this target whose result depends on something other than the code under test. Establish each across runs rather than from one failure: repeat the test alone, reorder or shuffle the file, isolate it completely, vary the seed where the runner takes one. Paste every command and every exit code. Name the mechanism — shared temp directory, wall-clock assertion, unawaited promise, fixed port, a global mock another test installed, an ordering assumption over a Set, a deletion racing its own cleanup — because "flaky" is not something a reader can act on. Add no retry, quarantine nothing, skip nothing. End with FLAKY, PROBED and SUITE counts. Target: {{input}} Candidates: {{prev}}
3. @assertion-critic Mode GATE. If either report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise assemble the packet: list every BLIND verdict with its mutation and both exit codes, keep anything a run produced strictly above anything read, and print counts for PROVEN, BLIND, NO-ORACLE, FLAKY and NOT-PROBED including the zeros. For each BLIND test state plainly what it currently asserts and what it fails to assert. Then, only if the evidence genuinely leaves it open, emit exactly one ORG-ASK line carrying the whole question with its options and their costs on that single line — the question worth asking is usually which blind tests are guarding behaviour anybody still wants, since a test green for two years may be protecting a decision that was reversed. If the evidence settles it, say so and stop rather than pausing for the sake of a gate. Target: {{input}} Reports: {{prev}}
4. @test-author Strengthen the tests the decision below approves. For each one the mutation in the oracle's report is your specification: the new assertion must fail against that exact mutation, and you write down the mutation, what the old assertion did while it was applied, and what the new one does instead. Prefer adding the positive assertion beside the negative one, asserting the effect rather than the call, making a trivial fixture non-trivial, and pinning a length before a loop. Do not delete a blind test and call it fixed, do not add a snapshot in place of an assertion, and do not touch the source under test. Read any file before you overwrite it. You have no shell, so run nothing and claim nothing passes: end with the files you changed, a WOULD-CATCH line per test naming the mutation it now fails against, and the exact command a reader should run to confirm it. Decision: {{prev}} Run: {{journal}}
