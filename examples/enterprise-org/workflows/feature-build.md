---
name: feature-build
description: Plan, implement with tests, review from fresh context, and hand the human an evidence packet. Sequential where work depends on prior work; parallel only for independent review.
continueOnError: false
stepTimeoutMs: 1800000
budgetUsd: 25
---
A reliable feature pipeline. Writes are single-threaded — one role owns the
change and its tests, so no stage waits on code a parallel stage has not
written yet. Only review is parallel, because reviewers are independent.
Run it as `/workflow feature-build <what to build, in full>`.

1. @architect Read the repository for yourself, then produce a short design for this request: the exact endpoints/functions to add or change, the data shapes, the edge cases that must be handled, and a numbered list of acceptance criteria a test could check. Prefer the smallest change that satisfies the request. If the request is ambiguous, state the single most defensible interpretation and proceed under it, marked ASSUMPTION. Reserve `ORG-ASK:` for the case where every reading you can defend would send the whole pipeline down the wrong path and only a person can pick — that pauses the run for a human answer and resumes from this step, so it costs a wait, not the work. Request: {{input}}
2. @developer Implement the design below in this worktree: write the production code AND a test file that checks every acceptance criterion, using relative paths only. Run `npm test` and report its real exit code and the pass/fail counts — do not claim a result you did not run. If tests fail, fix the code until they pass or you have a specific reason they cannot. Emit a short summary of what changed and the final test result. Design: {{prev}}
3. Independent review, from a fresh reading of the diff:
   - @qa-adversarial Review the change described below from a fresh reading of the diff (`git diff`), not from this text. Try to make it fail: malformed input, boundary values, concurrency, the cases the acceptance criteria did not name. Run whatever probes you need in your worktree. Report each real finding with the exact command that reproduces it; if you find nothing, say so plainly. Change: {{prev}}
   - @security-reviewer Audit the change described below from a fresh reading of the diff. Look for injection, unvalidated input reaching a sink, resource exhaustion, and anything a hostile caller could exploit. Report each finding with evidence, or report a clean pass. Change: {{prev}}
4. [zai/glm-5.3] @tech-lead Assemble the merge-gate packet from the implementation summary and the two reviews below. State the final test result, list every review finding by severity, and give a clear recommendation: MERGE, MERGE-WITH-FIXES (naming them), or DO-NOT-MERGE (naming the blocker). End with a one-line DECISION-REQUEST telling the human exactly what they are approving. Do not merge anything yourself. Inputs: {{prev}}
