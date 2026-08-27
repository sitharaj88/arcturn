---
name: mobile-baseline
description: Establish what a mobile repository is, whether this machine can build it, and where it stands on accessibility — then pause for a person before writing the baseline they will be held to.
continueOnError: false
budgetUsd: 25
stepTimeoutMs: 1800000
---
Run it as `/workflow mobile-baseline <what you are standing up or taking over,
and the constraint you actually care about>`.

Stage 1 is a read-lane survey and it is the premise of everything after it, so
it is deliberately alone: three stages branching off a wrong detection is three
wrong reports that agree with each other, which reads like corroboration.

Stage 2's three branches are disjoint by lane and by subject. None of them can
write — `stack-surveyor` holds no mutating tool at all, and `toolchain-doctor`
and `a11y-auditor` hold `bash` with neither `write` nor `edit` — so no branch
can land a change and there is nothing for two branches to collide over. They
run against a worktree each, which is also why the accessibility branch may
install nothing and repair nothing: a fix applied inside a throwaway worktree
would be reported and then lost, which is worse than not applying it.

The gate at stage 3 is a person, not a role. A baseline document is the thing
a team is held to for a year, and the choices in it — target API levels, an
architecture direction, whether accessibility is a release gate — are not the
engine's to make. Stage 3 asks exactly one question and only when the evidence
genuinely leaves it open; when the evidence settles it, stage 3 says so and the
run continues without a pause.

Stage 4 is the only write-lane step in the pipeline, which is why the run fails
immediately under plan mode rather than after spending four stages: plan mode
has no write lane and the pipeline stops before a token is spent on a document
it could not save.

1. @stack-surveyor Establish what this repository actually is before anyone reasons about it. Report every platform that ships with the file that proves it, the three version numbers per native platform kept separate — compile, target and minimum — the architecture as it stands with a representative path:line for layering, state, navigation and dependency injection, and the module graph. Anything a file does not settle is UNKNOWN with the artifact that would settle it, never the ecosystem default. End with DETECTED and UNRESOLVED blocks. Brief: {{input}}
2. Three lanes over the survey below, none of them able to write:
   - @toolchain-doctor If the survey below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise answer whether this machine can build this repository right now. Run the doctor commands for every platform the survey detected, paste each command with its real exit code, and compare what is installed against what the repository pins rather than against the newest release — naming the file that carries each pin. Do not install, do not edit a config to make a check pass, and do not run a full build. End with BUILDABLE: yes, no or unproven and one line of reason. Survey: {{prev}}
   - @a11y-auditor If the survey below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise audit accessibility for every platform the survey detected. Run the dynamic audit that exists for this stack — Flutter meetsGuideline tests, Espresso AccessibilityChecks, XCUITest performAccessibilityAudit — and when the repository has none configured, report NO DYNAMIC AUDIT with the check that would add one rather than passing the static sweep off as an audit. Then sweep source for absent labels, unscalable text, undersized touch targets, colour-only information and accessibility opt-outs, pasting the searches you ran. Rank findings by what a person using a screen reader experiences, not by rule id. Emit no score, no percentage and no conformance verdict. End with CHECKED and NOT ESTABLISHED, both with counts. Survey: {{prev}}
   - @stack-surveyor Mode DEPENDENCY. If the survey below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise read the lockfiles the survey named and report what this app actually depends on: every third-party SDK with the lockfile line that pins it, which of them are analytics, ads, crash or attribution SDKs, which pull in native code, and which have not moved in over two years. Name the ones whose presence forces a privacy declaration. You have no shell, so report no advisory database you cannot read from a file in this tree, and mark every version you could not resolve UNKNOWN. Survey: {{prev}}
3. @stack-surveyor Mode GATE. If any report below carries an ORG-HALT line, re-emit it verbatim and stop. Otherwise assemble the decision packet from the three reports: cite each claim to the stage that made it, keep anything a command produced strictly above anything read from source, keep anything read from source strictly above judgment, and print counts for DETECTED, UNKNOWN, MISSING and NOT ESTABLISHED including the zeros. Carry every NOT ESTABLISHED line forward verbatim — those are the accessibility properties nothing in this run decided and they must survive into the document. Then, only if the evidence genuinely leaves the choice open, emit exactly one ORG-ASK line carrying the whole question with its options and their costs on that single line; if the evidence settles it, say so plainly and stop rather than pausing a run for the sake of a gate. Brief: {{input}} Reports: {{prev}}
4. @baseline-author Write the baseline document. Re-read the files the reports cite and confirm each line says what the report says before you record it. Split everything into two registers and blend them nowhere: Established, carrying its path:line or the stage whose command produced it, and Assumed — unconfirmed, carrying the check that would settle it. Propose against this tree rather than a template: where the repository already has a consistent pattern, record it and name what is inconsistent with it; where you propose a change, name the problem in this tree it solves with the path:line where that problem shows, and name what it costs. You have no shell, so cite measured numbers to the stage that measured them rather than restating them as your own. Carry the NOT ESTABLISHED block through verbatim under Open — owner needed. Write one file, into the repository's existing architecture or docs directory or docs/mobile-baseline.md when it has none, and end with the path and the count of lines under each register. Decision: {{prev}} Run: {{journal}}
