# mobile-ground-truth

Four slash commands for the mobile questions an agent is most likely to answer
confidently and wrongly: is this API available to me, what crashed, what does this
upgrade break, and what does this app collect.

Each one is built around a refusal. `/api-check` will not tell you when an API landed
from memory. `/crash-triage` will not read a stack trace whose symbols it could not
prove belong to the build that crashed. `/upgrade-impact` will not hand back an upstream
changelog. `/privacy-declarations` will not declare a data type the code does not
evidence. The drafting half of each of these is easy, and every one of these outputs is
read by someone who cannot check it — which is exactly why the refusal is the product.

## Install

```bash
arcturn add sitharaj88/arcturn/examples/mobile-ground-truth
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`examples/mobile-ground-truth` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links the four skills into `~/.arcturn/skills/`. They are
available as `/api-check`, `/crash-triage`, `/upgrade-impact` and
`/privacy-declarations` immediately.

To read what an install would add before running it:

```bash
arcturn inspect sitharaj88/arcturn/examples/mobile-ground-truth
```

From a clone, the local-path form works too — `arcturn add ./examples/mobile-ground-truth` —
which is also the loop for editing your own copy. `arcturn remove mobile-ground-truth`
uninstalls; `arcturn update mobile-ground-truth` re-fetches.

## The commands

| Command | What it does | What it refuses to do |
|---|---|---|
| `/api-check` | Answers whether an API exists in the SDK you build against **and** whether it runs on the oldest OS you ship to, citing a path:line on this machine or a page fetched this session. | Answer from memory. With neither kind of evidence the verdict is `UNVERIFIED` plus the exact lookup command, and it stops — no "probably iOS 17, verify before shipping". It also never prints the compile answer alone; both answers or neither. |
| `/crash-triage` | Classifies the termination reason, proves the symbols match the shipped build, reads frames at the shipped commit, and produces a ranked hypothesis with the observation that would kill each one. | Diagnose an unsymbolicated or identity-mismatched trace, at all. It writes `UNSYMBOLICATED` or `IDENTITY-UNPROVEN`, names the missing artifact and the check that would prove the match, and stops. It produces a hypothesis, never a fix. |
| `/upgrade-impact` | Intersects what changed upstream with what this repository actually touches, preferring the compiler's own deprecation output to any external list. | List a breaking change it cannot tie to an occurrence here — those are dropped and counted. It never marks a dependent compatible from memory (`UNKNOWN` plus the command that would settle it), and it says on line one when it could not read the migration guide. |
| `/privacy-declarations` | Drafts `PrivacyInfo.xcprivacy` and Play Data safety inputs from linked SDKs' own manifests and first-party call sites, with the search patterns printed. | Declare a data type the code does not evidence, or write "no data collected" while a linked analytics or ads SDK contradicts it — that contradiction is raised as a blocking question and left open. It never states the app is compliant, and its last line says why. |

All four take arguments: `/api-check Live Activities`, `/crash-triage ./reports/12f4.ips
build 5821`, `/upgrade-impact okhttp 5.0.0`, `/privacy-declarations the free tier target`.

## Stack-agnostic by detection, not by packaging

There is no iOS pack and no Android pack here, because a React Native, Flutter or KMP
repository **is** an iOS repository and an Android repository, and splitting these four
commands across four packages would give you four copies of the same refusals to keep in
sync. Every command detects what it is looking at from files — `Podfile.lock`,
`Package.resolved`, `gradle/libs.versions.toml`, `pubspec.lock`, `package.json` — reports
what it detected and which file said so, and answers per platform that actually ships the
symbol. Detection is stated in the output precisely so you can catch it being wrong.

## Two of these are folder skills

`api-check` and `crash-triage` are `<name>/SKILL.md` folders with a sibling reference
file, and they are the first of that shape in this repository:

```
skills/api-check/SKILL.md              → /api-check
skills/api-check/lookup-map.md         → $SKILL_DIR/lookup-map.md
skills/crash-triage/SKILL.md           → /crash-triage
skills/crash-triage/symbolication.md   → $SKILL_DIR/symbolication.md
```

The loader takes the **folder** name as the command name and `SKILL.md` as the body; the
sibling file is never loaded as a skill of its own. The body reaches it through
`$SKILL_DIR`, which expands to the folder's absolute path at invocation time, so the
lookup tables are a file on disk rather than something the model recalls — which is the
same discipline the commands themselves are built on.

**Both reference files are data.** Markdown tables and command sets, no scripts. This
package ships no `extensions/` and no executable file of any kind, which is why
`executable: false` in its registry entry is literally true and why it installs with no
confirmation prompt. Putting a script inside a skill folder would land executable code on
your disk without even the confirmation `extensions/` triggers; `$SKILL_DIR` carries data
here, deliberately and permanently.

## What this installs next to

Four skills. No agent roles, no workflows, no MCP servers, no themes. Nothing here
collides with `starter-skills`' three commands or with `enterprise-org`'s eleven roles
and six pipelines, so all three install side by side; `arcturn inspect` on any of them
prints the full list before you commit to it.

The composition worth knowing: `/crash-triage` produces a hypothesis and stops, which is
exactly the input `enterprise-org`'s `bug-fix` pipeline wants — a failing-test-first
pipeline whose first stage has somewhere to start. That hand-off is a person copying a
hypothesis into a pipeline, not an automatic one, and there is no pipeline in this
package that could make it automatic.

## Honest limits

Where this package's guarantee stops. Every row is a real seam, not a disclaimer.

| Limit | Why it is real | What you can rely on instead |
|---|---|---|
| **These instruct a model, they do not constrain it** | Every refusal here is a rule written in a prompt, enforced by the model's compliance with the prompt. "It will not answer from memory" improves the odds and gives you the exact sentence to check the output against; it is not a validator | A skill cannot execute. The real boundary on what any tool a skill triggers may touch is the [permission engine](https://arcturn.dev/docs/permissions), which does not read prompts at all |
| **These are skills, so they run in your session with your tools** | This package installs no agent roles, so it gets no lane: there is no isolated worktree and no discarded diff behind any of these commands. If your session holds write tools, the model holds them while running these | The permission engine, and reading the output. An agent role's exec lane is the structural version of this guarantee, and none of these four is one |
| **Running a build for evidence touches host-global state** | `/upgrade-impact` and `/api-check` are at their strongest when a real build runs, and a Gradle daemon, DerivedData, `adb` device state, a simulator, package caches and the login keychain are all outside any checkout. A lane would not protect these either — the exec lane guarantees a role's diff never reaches your tree, and says nothing about the world | Run them on a machine where that is acceptable, and read what the commands say they ran |
| **`/api-check` answers about the SDK on *this* machine** | The compile verdict is derived from the toolchain installed here. When CI builds with a different Xcode or `compileSdk`, the answer is about your laptop | The output names the SDK path it read, so the mismatch is visible rather than silent |
| **"Fetched this session" needs a session that can fetch** | Half the evidence rule is a documentation page retrieved now. In a session with no fetch tool, that half is unavailable | Everything falls back to on-disk evidence or to `UNVERIFIED`. That degradation is the designed behaviour, not a failure |
| **Grep has a recall bound** | `/upgrade-impact` and `/privacy-declarations` find call sites by pattern. Reflection, DI graphs, string-keyed registries, generated and obfuscated code are invisible to that method | Both commands print their patterns and carry a `NOT VISIBLE TO THIS METHOD` section. Read it as part of the result, not as boilerplate |
| **`/crash-triage` cannot recover an artifact nobody archived** | If the dSYM, `mapping.txt`, source map or `.symbols` file for a shipped build was not kept, that build's crashes are not diagnosable from the trace | The command says so and produces no hypothesis. The finding is a build-pipeline finding, and the fix is archiving symbols per build |
| **`/privacy-declarations` reads code, not your company** | What your servers do with what arrives, what your vendor contracts say, which jurisdictions your users are in and what a store's current policy text requires are all outside this repository | The draft, its evidence, and its open contradictions. The compliance question belongs to a person who can answer it |
| **A listing is not an audit** | This package's registry entry is a claim about files, checked by a reviewer once and by `web/scripts/hub.test.ts` against this tree | `arcturn inspect <source>` re-derives the same table from the code that would actually be installed. Trust that over any page |

## What is deliberately not here

- **A release org.** Four roles and two pipelines for store readiness and SDK-deadline
  upgrades were designed and deferred: they need Xcode, an Android SDK and a real store
  artifact to validate against, and the one write-lane role's most likely outcome in this
  domain is a patch refusal against `project.pbxproj`. Named here rather than silently
  omitted; when there is a tree to validate them on, they become roles added to a pack.
- **Device interaction as evidence.** Screenshots, accessibility snapshots and "I tapped
  through it and it worked" are not an oracle, so no command here treats them as one.
- **Per-migration commands.** A `swift6-migration` or `target-sdk-36` command is an
  upstream changelog wearing a slash-command hat, and it rots on the next release.
  `/upgrade-impact` takes the version as an argument instead.

**Edit them.** These are four files and two tables. A lockfile your team does not use, an
output block your tracker cannot ingest, a symbolication path your CI writes somewhere
else — change them. `arcturn add ./examples/mobile-ground-truth` from a clone installs
your edited copy, and a project-scope `.arcturn/skills/api-check/SKILL.md` wins over an
installed user-scope one, so a team can standardise a variant without anyone
uninstalling anything.

Docs: [Markdown skills](https://arcturn.dev/docs/skills) ·
[Packages](https://arcturn.dev/docs/packages)

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](../../LICENSE). © 2026 Sitharaj Seenivasan.
