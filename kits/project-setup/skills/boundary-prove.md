---
name: boundary-prove
description: Prove an architecture check fails when the rule is broken, by planting a violation and running it. BITES, TOOTHLESS or NO-ORACLE — never "configured".
---

Decide whether the architecture checks in `$CWD` actually fail when their rules
are broken. Argument names a rule or a config; nothing means all of them.

**Why this exists.** A `dependency-cruiser` config whose glob matches no file
passes. A lint rule scoped to a directory that was renamed passes. A script
never wired into the test command passes. Each of them is green forever while
the architecture rots, and the green is read as evidence — which makes a check
that cannot fail worse than no check at all.

## Per rule, and it must be every rule

1. **Baseline.** Run the check exactly as the project defines it — the script,
   not a command you composed. Record it and its exit code. Already failing is
   `NO-ORACLE`; planting a violation under a red check teaches nothing.
2. **Plant the smallest violation the rule names.** If the rule says the domain
   may not import UI, add that one import to a real domain file. Paste the diff.
3. **Re-run the identical command.** Record the exit code.
4. **Restore, and confirm the baseline returned.** Say that it did — a dirty
   tree contaminates every judgment after it.

Do all of them. A config with four rules where only the first bites is
three-quarters decoration, and that ratio is the finding.

## The verdicts

- **`BITES`** — went red on the violation. Name the rule, the import you
  planted, both exit codes.
- **`TOOTHLESS`** — stayed green while the rule was broken. Name why: a glob
  matching nothing, a severity at `warn`, a path alias the tool cannot resolve,
  a script no test command invokes.
- **`NO-ORACLE`** — could not establish either. Say what stopped you.

**"Configured" is not a verdict**, and neither is "the config looks correct" —
a reading is what produced the toothless check in the first place.

## Also: does it run where it matters

A rule that bites locally and is not in the test or CI script is a rule nobody
runs twice. Report where the check is invoked from, read from the manifest or
the workflow file, and say plainly when the answer is nowhere.

## Change nothing

Restore every file you touched and say you did. Do not fix a toothless rule
here — describe the fix and leave it, because a rule repaired by whatever just
proved it toothless is a change nobody reviewed.

End with `BITES: <n> / TOOTHLESS: <n> / NO-ORACLE: <n> / RULES: <n>`, all four,
so one proven rule cannot read as a proven architecture.

Scope: $ARGUMENTS
