# mobile-foundation

Four roles, two pipelines and four commands for the part of mobile work that
happens before and around the code: can this machine build it, what is the
architecture actually, is it usable by someone who cannot see it, and what will
the store reject.

Its companion pack, [`mobile-ground-truth`](../mobile-ground-truth), answers
four in-flight questions — API availability, crash triage, upgrade impact,
privacy declarations. This one is the groundwork underneath them.

Every command here is built around something it will not say. `/env-doctor`
will not call an environment ready without the doctor output behind it.
`/arch-baseline` will not propose a pattern it cannot tie to a `path:line` in
your tree. `/a11y-sweep` will not emit a score, a percentage or a conformance
verdict. `/release-gate` will not recall a store's current target-API
requirement from memory. The drafting half of each of these is easy, and every
one of these outputs is read by someone who will stop looking once they have
it — which is why the refusal is the product.

## Install

```bash
arcturn add sitharaj88/arcturn/examples/mobile-foundation
```

Read what it would add first:

```bash
arcturn inspect sitharaj88/arcturn/examples/mobile-foundation
```

From a clone, `arcturn add ./examples/mobile-foundation` works too, which is
also the loop for editing your own copy. `arcturn remove mobile-foundation`
uninstalls; `arcturn update mobile-foundation` re-fetches.

## The commands

| Command | Answers | Refuses |
|---|---|---|
| `/env-doctor` | Whether this machine can build this repo, from real doctor commands with real exit codes, comparing what is installed against what the repo **pins** | Certifying an environment it did not run. Installing or repairing anything — a mismatch quietly fixed is one you meet again on the next machine. Ends `BUILDABLE: yes / no / unproven`, and absence of an error never means `yes` |
| `/arch-baseline` | What the layering, state flow, navigation, DI and module graph actually are, each with a `path:line` — then a baseline proposed against that | Proposing from a template. Every proposal names the problem **in this tree** it solves, with the line where it shows, and what it costs. A proposal with no named cost has not been thought about |
| `/a11y-sweep` | Runs the dynamic audit this stack has, then sweeps source for absent labels, unscalable text, undersized targets and colour-only information — each ranked by what a person actually experiences | A score, a percentage, or a conformance verdict. See below — this is the whole design |
| `/release-gate` | What the manifests, permissions, signing config and privacy declarations in this tree would get rejected for | Saying a build is signed, compliant or ready — none of which a source read can establish. Store requirements it cannot read from a file are `UNKNOWN` with where to check, never a number from memory |

## The pipelines

`/workflow mobile-baseline <what you are standing up or taking over>` — survey,
then three disjoint read/exec lanes over it (toolchain, accessibility,
dependencies), then a pause for a person, then one write-lane stage that
records the result. Six steps, $25 ceiling.

`/workflow a11y-audit <screen, flow, or "all">` — survey, then the audit.
Two steps, $12 ceiling.

**One role can write, and it goes last.** `baseline-author` holds `write`;
nothing else in the pack holds `write` or `edit`. Every stage before it can be
wrong on paper with nothing changed on disk, and under plan mode
`mobile-baseline` fails at the first write-lane step — before a token is spent
— rather than after producing four stages of report it could not save.

## Why the accessibility audit cannot fix anything

`a11y-auditor` holds `bash` but neither `write` nor `edit`, so it dispatches on
the exec lane: it can run the audit and it structurally cannot apply a change.
That is the most deliberate decision in this pack.

The characteristic accessibility regression is an **auto-added label**. It
silences the scanner, satisfies the lint rule, and leaves a person hearing
"image" where the price used to be. Findings get better when a human writes
the label; scores get better when a machine does. A role that cannot write
cannot produce that regression.

## Source can decide absence. Source cannot decide adequacy.

Reading a tree settles *is anything there at all* — a control with no label, a
hardcoded size that will not scale, a 24dp touch target, an image whose
alternative text is its filename. Those are real, cheap, and worth finding.

Reading a tree cannot settle *whether a person can use the app with a screen
reader*. Focus order is a property of the rendered accessibility tree, not of
source order. Whether a label means anything — "Button" against "Add AeroPress
to basket" — is a judgment about a running screen. Contrast is rendered pixels
across themes, states and dark mode.

So `/a11y-sweep` ends with two blocks, always both, always with counts:
`CHECKED` (what ran, with exit codes) and `NOT ESTABLISHED` (every property
this run did not decide, each with the device or manual check that would).
**The second block is never empty** — a run producing an empty one has a bug,
not a perfect app.

Most accessibility tooling blurs this line and hands back a number. The number
then travels to a compliance conversation where nobody can defend it.

## Run what is runnable

Every stack has a real automated audit and almost no repository has it
configured. `$SKILL_DIR/checks.md` carries the exact commands, patterns and
thresholds per stack:

- **Flutter** — `meetsGuideline(androidTapTargetGuideline)`,
  `iOSTapTargetGuideline`, `labeledTapTargetGuideline`, `textContrastGuideline`.
  Real assertions over the semantics tree, running in CI with no device.
- **Android** — `AccessibilityChecks.enable()` inside Espresso, plus lint. If
  there are no instrumentation tests there is no dynamic coverage, whatever
  lint says.
- **iOS** — `performAccessibilityAudit()` in XCUITest, iOS 17+. Below that
  deployment target the honest answer is that no automated dynamic audit
  exists.
- **React Native** — the a11y ESLint plugin, and the two native audits above,
  because RN renders native views.

Where none is configured, that is the headline finding: `NO DYNAMIC AUDIT`,
with the test that would add one printed.

## Stack-agnostic by detection, not by packaging

There is no iOS pack and no Android pack, for the same reason
`mobile-ground-truth` has none: a React Native, Flutter or KMP repository **is**
an iOS repository and an Android repository. Every role detects what it is
looking at from files — `pubspec.yaml`, `Podfile.lock`,
`gradle/libs.versions.toml`, `package.json`, `*.xcodeproj` — and reports what
it detected and which file said so, precisely so you can catch it being wrong.

`stack-surveyor` keeps the three version numbers apart that most wrong mobile
answers collapse into one: what the code **compiles** against, what the
manifest **targets**, and the oldest OS that **runs** it. The third decides
whether a symbol is safe to call.

## Author & Support

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
