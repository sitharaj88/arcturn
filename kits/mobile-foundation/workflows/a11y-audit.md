---
name: a11y-audit
description: A standalone accessibility audit that runs the checks a stack actually has, sweeps source for what source can decide, and ends with an explicit list of what it did not establish.
continueOnError: false
budgetUsd: 12
stepTimeoutMs: 1200000
---
Run it as `/workflow a11y-audit <the screen, flow or module to audit, or "all">`.

Two stages, and the second exists to stop the first from being read as more
than it is.

Nothing in this pipeline can write. `stack-surveyor` holds no mutating tool
and `a11y-auditor` holds `bash` with neither `write` nor `edit`, so no stage
can "fix" a finding. That is deliberate and it is the most important property
here: the characteristic accessibility regression is an auto-added label. It
silences the scanner, satisfies the lint rule, and leaves a person hearing
"image" where the price used to be. A pipeline that cannot apply a label
cannot produce that regression.

Stage 2 is not a summary. Its job is the `NOT ESTABLISHED` block: the
accessibility properties that source and CI cannot decide — focus order,
whether a label means anything, contrast in the themes that actually ship,
whether a custom gesture has a real alternative. Those need the rendered
accessibility tree or a person with a screen reader, and an audit that omits
them reads as a clean bill of health. The block is never empty, and if a run
ever produces an empty one, that is a bug in the run rather than a perfect app.

1. @stack-surveyor Establish which platforms ship and what the UI is written in, each with the file that proves it, and report the deployment targets separately from the compile and target versions. The oldest OS decides which accessibility APIs and which automated audits are even available, so it is the number that matters most here. Then locate the UI surface the brief names — screens, components, or the whole tree when the brief says all — and list the files, with a path:line each, that a sweep should cover. Anything a file does not settle is UNKNOWN with the artifact that would settle it. Brief: {{input}}
2. @a11y-auditor Audit the surface the survey below located, for every platform it detected. First run the dynamic audit this stack actually has — Flutter meetsGuideline tests over the semantics tree, Espresso AccessibilityChecks inside instrumentation tests, XCUITest performAccessibilityAudit on a deployment target that supports it, the RN eslint a11y plugin — pasting each command with its real exit code; where the repository has none configured, write NO DYNAMIC AUDIT and print the test that would add one rather than presenting the static sweep as an audit. Then sweep source for what source can decide: interactive elements with no accessible name, text sizes that defeat Dynamic Type or font scale, touch targets under 48dp or 44pt, information carried by colour alone, accessibility opt-outs with no reason beside them, and alternative text that is just the asset filename — pasting every search you ran so recall can be checked. Give each finding a path:line, what a person using a screen reader or a large font actually experiences, and the smallest change that would fix it, described and not applied. Rank by that experience rather than by rule id. Emit no score, no percentage and no conformance verdict. End with CHECKED and NOT ESTABLISHED, both carrying counts including zeros, and put focus order, label meaningfulness, shipped-theme contrast and gesture alternatives in the second block unless you ran something that genuinely decided them. Survey: {{prev}} Brief: {{input}}
