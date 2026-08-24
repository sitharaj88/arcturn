---
name: complexity-gate
description: Tag the growth-rate candidates, measure this machine's noise floor, make one hypothesis into one change, and adjudicate it interleaved in one worktree.
continueOnError: false
budgetUsd: 15
stepTimeoutMs: 1800000
---
Run it as `/workflow complexity-gate <the scope: the module, path or entry
point you think is scaling badly, and the workload you care about>`.

The pipeline's most valuable output is a refusal to optimise. Stage 2 measures
the noise floor on your actual hardware and states the Amdahl ceiling of the
top hotspot, and when that ceiling sits at or below the floor it halts: nothing
you could change there is distinguishable from noise on this machine, so
nothing should be changed there. A halt is fatal rather than resumable, which
here is the correct shape — no answer from a person makes an unmeasurable
change measurable — and it short-circuits every later stage, so the write-lane
role is never dispatched at all. Not gated, not asked to behave: never given a
turn. That is a lane-level guarantee, not a prompt.

Stage 2 halts the same way when no harness can be built. A pipeline that
optimises against a fixture nobody could construct reports invented numbers,
and reporting nothing is strictly better.

Stage 3 is the only write-lane step in the pack, and it is worth knowing before
you run this that its diff is captured and replayed into your real checkout
when the step succeeds — so the change is in your tree before stage 4 has said
whether it did anything. It is one hypothesis, one change, uncommitted, and
stage 4 tells you whether to keep it.

Measurement and adjudication never sit in the role that wrote the change.
Stages 2 and 4 are the same measuring role and stage 3 is a different one, and
the split is checkable from the `tools:` lines rather than from anything either
role promises: the optimiser holds `write` and `edit`, the analyst holds
neither, and no prompt in this pipeline can move either of them.

Stage 4 reconstructs both arms of the comparison inside its own worktree and
interleaves them. It cannot reuse stage 2's baseline number, and the reason is
mechanical: every lane worktree is created from a commit and seeded with the
run's state under the checkout's own ignore rules, so build output, package
directories and every warm cache stay out. Each stage builds cold, with a
different cache state and different neighbours on the machine. Stage 4 rebuilds
the baseline by reversing the change record's own verbatim diff, which is why
stage 3 is required to paste it.

The run is fully sequential and each stage genuinely needs the last: candidates
with their n-sources, then a floor and a ceiling, then one change, then a
verdict against the floor. There are no parallel branches, so there is no
partition to state.

Under plan mode this pipeline fails at stage 1 before a token is spent. Every
step here dispatches on the exec or write lane and plan mode has neither, so
`/workflow` warns about all three roles up front and the first step is refused
rather than run. Approve the plan or leave plan mode. Under an ordinary
permission mode the same pre-flight warns that the run will stop for your
approval as those steps come.

The pipeline ends at a person, in a `DECISION-REQUEST` block rather than an
`ORG-ASK`. A question asked at the final stage buys nothing — there is no later
stage for an answer to be spliced into — and the engine replaces an asking
step's output text with the answer on resume, so pausing at the end would
overwrite the adjudication packet with a sentence. Nothing in this pipeline
merges, commits, tags or pushes anything.

1. @complexity-reviewer Review the scope below for growth-rate risk in this repository: enumerate the candidates by category, and for each one either derive its complexity as a path a reader can walk with every hop addressed to a file and line, or measure it with a scan at three or more sizes and paste the ratio table with its repeat counts, and make no complexity claim at all about a candidate you can do neither for. Find where n comes from for every candidate and cite the bound that caps it; a candidate whose n is provably bounded is dismissed with that bound quoted and its address, and a candidate with no bound you could find carries the patterns and paths that found none. Name no growth class the measurements do not separate. Scope: {{input}}
2. @perf-analyst Mode BASELINE. If the ledger below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise find or build a repeatable harness for the workload in the brief and, if no fixture can be built, emit ORG-HALT naming what was missing and stop rather than measuring something else. Measure this machine's noise floor first by running one build against itself, report the median with its spread and coefficient of variation, and turn it into a minimum detectable effect with the formula and its inputs printed. Then attribute the runtime by share with the command that produced each share, state the Amdahl ceiling of the top hotspot as the share it holds, and carry the top candidates forward by ledger id with their addresses. When that ceiling sits at or below the MDE you just measured, emit ORG-HALT naming both numbers and stop: there is nothing here worth changing. Brief: {{input}} Ledger: {{prev}}
3. @optimizer If the baseline below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise take the single hotspot the baseline ranks first, read the code at its address rather than trusting the description, and state one hypothesis as a sentence naming the operation, its address, its current cost and the transformation that changes it. Make that one change and nothing else, in as few files as the hypothesis needs, and paste the verbatim diff into your record so the next stage can reverse it. Run the correctness suite before and after and paste both commands with their real exit codes, weakening nothing to get green. Touch no benchmark, fixture, input size, repeat count or test; if the hypothesis cannot be tested without moving one of those, make no edit at all and emit ORG-HALT saying which. State no performance number. Baseline: {{prev}}
4. @perf-analyst Mode ADJUDICATE. If the change record below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise establish both arms inside your own worktree only: write the record's diff to a file, prove it reverses cleanly with git apply --check -R and paste that exit code, toggle between the arms with git apply -R and git apply inside that worktree alone, and report NOT-ADJUDICATED if the reversal fails rather than rebuilding a baseline by hand. Run the correctness suite on both arms and paste both exit codes, then measure them interleaved in one session at three or more sizes with a stated repeat count, reporting every arm as a median with its spread. Decide against the MDE you measured, not against zero: a delta at or below it is indistinguishable at this harness's resolution with the MDE quoted, sizes that cannot separate the competing growth classes are NOT-SEPARABLE-AT-THESE-SIZES naming the n that would decide, and a regression is reported with the same weight as an improvement. Close with the DECISION-REQUEST block naming who decides, what the evidence supports, and that the change is sitting uncommitted in the checkout. Brief: {{input}} Change record: {{prev}}
