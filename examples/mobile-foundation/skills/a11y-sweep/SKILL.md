---
name: a11y-sweep
description: Audit mobile accessibility by running the checks this stack has and naming what source cannot decide. Emits no score and no conformance verdict.
---

Audit the accessibility of `$ARGUMENTS` in `$CWD` — a screen, a module, or the
whole tree when nothing is named.

`$SKILL_DIR/checks.md` carries the per-stack commands, the search patterns and
the thresholds. Read it before you start and use the checks for the stack you
actually detect, rather than the ones you remember.

## The line this command will not cross

**Source can decide absence. Source cannot decide adequacy.**

Reading the tree settles *is anything there at all* — a control with no label,
a hardcoded size that will not scale, an undersized touch target, an image
with no alternative text. Find all of those.

Reading the tree cannot settle *whether a person can use this app with a
screen reader*. Focus order is a property of the rendered accessibility tree.
Whether a label means anything — "Button" against "Add AeroPress to basket" —
is a judgment about a running screen. Contrast is rendered pixels across
themes and states. Announcement quality, live regions and gesture
alternatives are all runtime facts.

So this command emits **no score, no percentage, and no conformance verdict**.
Those outputs confuse "the scanner found nothing" with "a person can use it",
and they get carried into a compliance conversation where they cannot be
defended. If asked for one, say why there isn't one.

## Do the runnable half first

Every mobile stack has a real automated audit, and most repositories have none
of it configured. Run the one that fits — Flutter's `meetsGuideline` tests,
Espresso's `AccessibilityChecks`, XCUITest's `performAccessibilityAudit`, the
React Native a11y ESLint plugin — and paste each command with its real exit
code.

Where the repository has none configured, that is the headline finding. Write
`NO DYNAMIC AUDIT` and print the test file that would add one. Do not fall
back to the static sweep and present the result as an audit.

Check the deployment target before promising an audit: `performAccessibilityAudit`
needs iOS 17, and below it the honest answer is that no automated dynamic
audit exists for that half of the app.

## Then sweep source

Use the patterns in `$SKILL_DIR/checks.md`, and **paste every search you ran**
so the reader can judge your recall rather than trusting it.

Report each finding as: `path:line`, then what a person using a screen reader
or a 200% font size actually experiences, then the smallest change that fixes
it — described, never applied. Rank by that experience, not by rule id. One
mislabelled primary action outranks forty decorative icons missing a null
label, and a rule-id ranking buries it.

An accessibility opt-out — `importantForAccessibility="no"`,
`accessibilityElementsHidden`, `excludeSemantics` — may be entirely correct.
Report it with the question "is there a reason next to this", not as a
violation.

## End with two blocks

`CHECKED` — what you ran, with commands and exit codes, and what the sweep
covered, with counts.

`NOT ESTABLISHED` — every accessibility property this run did not decide, each
with the device or manual check that would decide it. Focus order, label
meaningfulness, contrast in the themes that ship, and gesture alternatives
belong here unless you ran something that genuinely decided them.

This block is the most valuable thing the command produces and it is never
empty. A run that emits an empty one has a bug, not a perfect app.
