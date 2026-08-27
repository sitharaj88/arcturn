---
name: bug-fix
description: Reproduce with a failing test, fix until green, review from fresh context, hand the human an evidence packet. Fully sequential — every stage builds on the last.
continueOnError: false
budgetUsd: 15
stepTimeoutMs: 1800000
---
The short pipeline for a reported bug. Stage 1 writes a test that FAILS at
HEAD — that failing test is what turns every later judgment into a mechanical
check. If it cannot produce a failing test, the run stops rather than
proceeding on a story. Run it as `/workflow bug-fix <the bug report, verbatim>`.

1. @qa-functional Reproduce this bug and write a regression test that FAILS against the current code. Import the real module under test — never copy or re-implement it. Run `npm test`, confirm the new test fails for the right reason, and report the failing output with its exit code. If you cannot make a test fail, the bug as described may not exist — say so and stop. Bug report: {{input}}
2. @developer A failing test now exists (below). Fix the production code so that test passes and every previously-passing test stays green. Use relative paths in this worktree. Run `npm test`, and report the real exit code and pass/fail counts — the same test that failed must now pass. Repro and failing test: {{prev}}
3. @qa-adversarial Review the fix below from a fresh reading of the diff (`git diff`). Confirm the reported bug is actually gone, then try to break the fix from a new angle and check nothing else regressed. Report findings with reproducing commands, or a clean pass. Fix: {{prev}}
4. [zai/glm-5.3] @tech-lead Assemble the evidence packet from the repro, the fix, and the review below. State the fail-before/pass-after result, list any findings, and recommend MERGE, MERGE-WITH-FIXES, or DO-NOT-MERGE with a one-line DECISION-REQUEST. Do not merge. Inputs: {{prev}}
