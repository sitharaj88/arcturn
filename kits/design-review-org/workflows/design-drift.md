---
name: design-drift
description: Turn a design document's claims into predicates, run them, prove each check bites, and report NO-ORACLE with a count instead of folding it into PASS.
continueOnError: false
budgetUsd: 15
stepTimeoutMs: 1800000
---
Run it as `/workflow design-drift <the design document, ADR or RFC to check —
a path, plus any scope you want it held to>`.

The product here is the distinction between "we checked and it holds" and
"nobody can check this". A drift report that prints PASS for both is worse than
no report, because it retires a question that was never asked. So `NO-ORACLE`
is printed with its own count at every stage that touches it, and it is never
folded into a pass.

Stage 1 refuses to carry a claim forward as prose. A sentence that cannot be
stated as a predicate over this repository goes to `Unstatable claims` with its
document address and the reason, and the count is printed — a ledger of
fourteen predicates from a document making forty claims is honest only when it
says so.

Stage 2 does the part every architecture-rule tool skips: it plants a
deliberate violation and checks that the rule notices. A check that passes both
before and after is `RUNS-ONLY` — it runs, it does not measure what the
document claimed — and that outcome is the most valuable line in the report.

No role in this pipeline is on the write lane. `codebase-critic` and
`design-lead` hold no mutating tool at all; `invariant-oracle` and
`impact-analyst` hold `bash` with neither `write` nor `edit`, so their diffs
are discarded and the engine mints their `ARCTURN-PATCH: status=discarded`
trailer itself. Nothing in this run can edit the document to make the ledger
green, or edit the code to make the document true. Both of those are decisions
a person makes after reading the ledger.

The pipeline ends at a person either way: a `DECISION-REQUEST` block naming who
decides, and an `ORG-ASK` line only when the drift leaves a genuine choice open
between amending the document and changing the code.

1. @codebase-critic Mode CLAIM-LEDGER. Walk the design document named below in order and turn every claim it makes about this repository into a predicate that is either true or false of the tree, each carrying the document address it came from and a candidate check — a command, a lint rule id, a test name or a grep — that would decide it. A claim you cannot state as a predicate is not carried forward as prose: put it under `Unstatable claims` with its address and one sentence on why, and print the count. Do not run anything and do not guess an outcome. Document and scope: {{input}}
2. @invariant-oracle If the ledger below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise run every predicate's candidate check at the seed commit, then plant the smallest plausible violation of that predicate in your worktree and run the check again to establish whether it bites, then restore and confirm the baseline returned. Classify each predicate as PROVEN, VIOLATED-AT-HEAD, RUNS-ONLY or NO-ORACLE, carry the verbatim command and real exit code for every run, describe every violation you planted, and never report a predicate satisfied on a check you did not run. Claim ledger: {{prev}}
3. @impact-analyst If the oracle report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise take every predicate the oracle marked VIOLATED-AT-HEAD, RUNS-ONLY or NO-ORACLE and enumerate what is relying on the documented behaviour: name the surfaces each drifted claim touches, search for each with a command you paste alongside its hit count, rank consumers by whether a break announces itself at compile time or silently at runtime, and end with the recall bound naming the classes your searches cannot reach and what would close each gap. Report nothing for the PROVEN predicates. Document: {{input}} Oracle report: {{prev}}
4. @design-lead If the report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise assemble the drift ledger for the document named in the brief: quote or cite by id and never paraphrase, print counts for PROVEN, VIOLATED, RUNS-ONLY, NO-ORACLE and NOT-CHECKED including the zeros, list every RUNS-ONLY and NO-ORACLE predicate individually with what would make it checkable, keep the unproven and the unprovable visibly out of the passing count, carry every recall bound forward verbatim, and end with the DECISION-REQUEST block naming who decides and what becomes irreversible. Emit one ORG-ASK line only where drift leaves a real choice between amending the document and changing the code, with both options and their costs on that single line. Document: {{input}} Impact: {{prev}}
