---
name: design-review
description: Draft a design record with cited constraints, attack it from three independent lanes, pause for a person's decision, then transcribe it. No step approves anything.
continueOnError: false
budgetUsd: 20
stepTimeoutMs: 1800000
---
Run it as `/workflow design-review <the brief: what you want to build or
change, and the constraint you actually care about>`.

This pipeline contains no step with authority to approve a design. The gate is
the pause at stage 3 — a person answering a question the engine recorded — and
stage 4 exists only to transcribe a decision that person already made. Nothing
here marks a record accepted on a model's judgment, and `VERDICT: ADVISORY` is
the only verdict value in the pack.

Stage 1 is the only write-lane step, which is also why the run fails
immediately under plan mode: plan mode has no write lane, so the pipeline stops
at the first step needing one, before a token is spent, rather than producing
three stages of review of a document that was never written.

Stage 2's three branches are disjoint by construction rather than by partition.
None of them is on the write lane — `codebase-critic` holds no mutating tool at
all, while `invariant-oracle` and `impact-analyst` hold `bash` with neither
`write` nor `edit` — so no branch can land a change and there is nothing for
two branches to collide over. Each re-derives from the tree instead of trusting
the record spliced into its prompt, and each role file says so.

The stage-3 gate sits on a read-lane role deliberately. `design-lead` has no
worktree and no way to write a file, so declining to resume leaves nothing
behind from the gate itself. Stage 1's design record is on disk because you
asked for it and is marked `Proposed`; the question and the packet framing it
leave no artifact at all.

One consequence of the pause is worth knowing before reading stage 4: when a
person answers, the engine replaces stage 3's output text with that answer, so
stage 4 never receives the packet. It receives the answer and the run journal,
and re-reads the design record from disk. That is not a limitation being worked
around — it is why the transcribing stage structurally cannot paraphrase the
evidence it is recording a decision about.

1. @design-author Mode DESIGN. Write the design record for the brief below into this repository's existing design or ADR directory, or into `docs/design/` when it has none: read the modules the brief touches before writing a line, give every constraint a path:line or a phrase quoted verbatim from the brief and file the rest under `Assumed — unconfirmed`, evidence every rejected alternative from a reverted commit, a deleted module or the author's own words or state plainly that there are none, and declare each invariant as a predicate carrying the exact command, lint rule id, test name or grep that would decide it. You have no shell, so write no transcript and no measured number. Status is `Proposed`, and end by naming the file path you wrote. Brief: {{input}}
2. Three independent lanes over the record below, none of them on the write lane:
   - @codebase-critic Mode CRITIQUE. If the record below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise open the files the record names and review the code, not the record's description of it: check every cited constraint against the line it cites, hunt the seams the design crosses and the error paths it implies, and name what this tree already handles that the design does not mention. Every blocker carries a path:line; every finding you cannot address becomes a question for the author, and you print the downgrade count. Record: {{prev}}
   - @invariant-oracle If the record below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise take each declared invariant and its candidate check, run the check at the seed commit, then plant the smallest plausible violation of that invariant in your worktree and run the check again to find out whether it bites, then restore and confirm the baseline returned. Report each invariant as PROVEN, VIOLATED-AT-HEAD, RUNS-ONLY or NO-ORACLE with the verbatim command and real exit code for every run, and never as satisfied. Record: {{prev}}
   - @impact-analyst If the record below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise enumerate every surface the design changes that something else could hold onto — exported symbols, routes, CLI flags, config keys, environment variables, wire and file formats, table and column names, event names, feature flags — search for each one with a command you paste alongside its hit count, classify every hit, rank the consumers by whether a break announces itself at compile time or silently at runtime, and end with the recall bound naming the classes your searches cannot reach and what would close each gap. Record: {{prev}}
3. @design-lead If any lane report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise assemble the review packet from the three reports: quote or cite by id, never paraphrase, keep oracle-backed claims strictly above judgment, print counts for PROVEN, VIOLATED, RUNS-ONLY, NO-ORACLE and NOT-CHECKED including the zeros, carry every recall bound forward verbatim, and end with the DECISION-REQUEST block naming who decides and what becomes irreversible. Then, only if the evidence genuinely leaves the choice open, emit exactly one ORG-ASK line carrying the whole question with its options and their costs on that single line; if the evidence settles it, say so and stop rather than pausing a run for the sake of a gate. Brief: {{input}} Lanes: {{prev}}
4. [tier:build] @design-author Mode DECISION. Read the design record you wrote in stage 1 from disk and write it back whole with a Decision section appended, changing no other section: quote the human's answer below verbatim in a fenced block, quote the question exactly as the run journal records it on the `asked:` line, add at most one line of reading labelled as yours, and record the run id or `not established in this session` rather than a plausible-looking one. Set the status to `Accepted (human)` only if a verbatim answer is present and it decides the record's open question; otherwise leave it `Proposed` and write `DECISION: none recorded in this run`. You do not have the packet, so cite it rather than reconstructing it, and end the record with what is still open, who owns it and what becomes irreversible when they decide. Decision: {{prev}} Run: {{journal}}
