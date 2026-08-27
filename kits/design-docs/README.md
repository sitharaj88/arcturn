# design-docs

Four slash commands for the writing a repository asks for before code: the decision
record, the architecture map, the architectural rule that has to hold, and the design
sketch. Each one refuses to assert what the tree does not show, and the refusals are
what the package is — an ADR that will not invent the options that lost, a map with no
edge that is not a resolved import, a fitness function that is not called enforcing until
it has been watched failing, and a design draft that comes out as a form with its holes
counted in the header.

Three of the four generate nothing you could mistake for prose. The fourth is the one
document generator in this catalog, and it ships with a section below saying when not to
use it.

## Install

```bash
arcturn add sitharaj88/arcturn/kits/design-docs
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`kits/design-docs` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links the four skills into `~/.arcturn/skills/`. They are
available as `/adr-record`, `/arch-map`, `/fitness-function` and `/hld-draft`
immediately.

To read what an install would add before you run it:

```bash
arcturn inspect sitharaj88/arcturn/kits/design-docs
```

From a clone, the local-path form works for both — `arcturn add ./kits/design-docs`
and `arcturn inspect ./kits/design-docs` — which is also the loop for installing your
own edited copy. `arcturn remove design-docs` uninstalls; `arcturn update design-docs`
re-fetches.

## The four commands

| Command | What it does | What it refuses to do |
|---|---|---|
| `/adr-record` | Writes an architecture decision record in the shape the repository already uses, with the context cited to `path:line`, the consequences tied to observables, and every element's source listed in an evidence appendix. | Invent a rejected alternative. Options come from what the author supplied, quoted, or from what the tree shows was genuinely tried — a reverted commit, a deleted module, a dependency that left the lockfile, a comment naming the approach. With neither, Considered Options reads `Alternatives not evidenced — author must supply` and prints the searches that came back empty. It writes `Status: Proposed` and never `Accepted`, whatever the state of the code. And it declines to open a record at all for a change that decided nothing: it writes `No decision to record` with the condition that failed. |
| `/arch-map` | Builds a module map from the import graph: an edge ledger where every row carries the statement verbatim, the `path:line` it was read at, and the file the specifier resolved to — then draws only what the ledger backs. | Put a node or an edge on the diagram without a resolved import behind it. Dynamic imports, DI containers, reflection, service loaders and string-keyed registries go under `Edges I could not resolve statically`, dashed and labelled `unverified`, or absent with their site still listed. It will not draw a runtime or deployment topology from source — that section says `NOT DERIVABLE FROM SOURCE` and names what would show it — and it prints its own recall bound as `resolved / statements found`, never as a percentage of "the architecture". |
| `/fitness-function` | Turns one architectural rule into a check for your stack, runs it on HEAD, plants a deliberate violation to find out whether the check notices, restores the tree, and hands back the check plus every transcript. | Report a check as `ENFORCING` on anything less than both transcripts — a failing run against the planted violation and a passing run after the revert. Short of that the output is headed `UNPROVEN CHECK` naming which transcript is missing. It will not weaken the rule to reach green: a HEAD that already violates it is `HEAD-VIOLATES` with the violating paths listed verbatim from the tool, and the allowlist is written out as a proposal with an empty owner field for a person to fill. It will not plant a violation in a dirty tree. |
| `/hld-draft` | Drafts a high-level design as a structure with labelled holes: constraints cited, assumptions numbered for ratification, invariants that name their check, risks that name a trigger and an observable, and a hole count in the header. | Invent a constraint — one with neither a `path:line` nor a verbatim quote from the brief moves to `Assumed — unconfirmed` with the question that settles it. It writes no latency, throughput, capacity or cost number the repo or the brief does not state; those are `<unstated>` plus the artefact that would state them. An invariant with no named check is deleted from the design and filed under `Wanted invariants (no oracle yet)`. It writes no Alternatives Considered section and no status but `DRAFT`. |

All four take an argument:

```
/adr-record we're moving the outbox from Postgres to SQS; Kafka lost on ops cost
/arch-map src/
/fitness-function the domain must not import infrastructure
/hld-draft docs/briefs/outbox.md
```

With no argument, or with a path that does not exist, each one says which and stops.

This package installs four skills and nothing else. No agent roles, no workflows, no MCP
servers, no themes — so it adds nothing to `~/.arcturn/agents` or `~/.arcturn/workflows`
and it has no lane table. Lanes belong to agent roles; a skill runs in your own session,
which is the first row of the honest-limits table below.

## Two of these are folder skills

`adr-record` and `fitness-function` are `<name>/SKILL.md` folders with sibling reference
files, reached from the body through `$SKILL_DIR`:

```
skills/adr-record/SKILL.md                          → /adr-record
skills/adr-record/madr-template.md                  → $SKILL_DIR/madr-template.md
skills/adr-record/nygard-template.md                → $SKILL_DIR/nygard-template.md
skills/arch-map.md                                  → /arch-map
skills/fitness-function/SKILL.md                    → /fitness-function
skills/fitness-function/recipe-dependency-cruiser.md   JS / TS
skills/fitness-function/recipe-archunit.md             JVM
skills/fitness-function/recipe-import-linter.md        Python
skills/fitness-function/recipe-deptrac.md              PHP
skills/fitness-function/recipe-go-arch-lint.md         Go, plus a `go list` fallback
skills/fitness-function/recipe-ci-grep.md              any stack, no tool required
skills/hld-draft.md                                 → /hld-draft
```

The loader takes the **folder** name as the command name and `SKILL.md` as the body; the
sibling files are never loaded as skills of their own. Two ADR templates as complete files
mean the record's shape comes from a file rather than from a recollection of what ADRs
look like. Six recipes mean `/fitness-function` knows what each tool's exit codes mean,
which setting stops it going green on an empty rule set, what its allowlist mechanism is,
and which shapes to plant against — none of which a model reliably recalls per tool, and
all of which decide whether the check bites.

**Every reference file is data.** Markdown, tables, and configuration printed in fenced
blocks for you to put in your own repository. There is no `extensions/` directory and no
executable file of any kind in this package — no `.sh`, `.js`, `.ts` or `.py` anywhere,
skill folders included — which is why `executable: false` in the registry entry is
literally true and why the install asks you no questions. A script inside a skill folder
would land executable code on your disk without even the confirmation `extensions/`
triggers; `$SKILL_DIR` carries data here, deliberately and permanently.

## What this sits beside, and where it deliberately overlaps

Two of these four do a job an agent role in `design-review-org` also does. That is not an
oversight and the seam is worth stating rather than leaving you to find it.

**`/adr-record` is the solo path to the artifact `design-review`'s stage 4 produces.**
Run the pipeline and you get a design record written by `design-author`, attacked by three
independent lanes, paused at a person's decision, and then written back with that person's
verbatim answer in it — status `Accepted (human)` only because a human's words are in the
input. Run `/adr-record` and you get the same kind of file from your own session in a
minute, with the same two-source rule on alternatives and the same evidence appendix — and
`Status: Proposed`, always, because there is no engine-enforced pause in a slash command
and therefore no human answer to transcribe. Use the command when a decision has already
been made and needs recording. Use the pipeline when the decision has not been made and
you want it attacked first.

**`/fitness-function` writes the checks `invariant-oracle` proves.** Both plant a
deliberate violation and re-run the check, because a check nobody has watched fail is not
evidence of anything. The difference is where the vandalism happens: `invariant-oracle`
holds `bash` with neither `write` nor `edit`, so the engine dispatches it into a detached
worktree whose diff is never captured and mints the `ARCTURN-PATCH: status=discarded`
trailer itself. `/fitness-function` is a skill — it runs in your session, in your
checkout, with your tools — so it plants the violation in your working tree and reverts
it with `git checkout --`. That is why it refuses to plant at all unless
`git status --porcelain` is empty, and it is the strongest reason to prefer the role over
the command when you have a pipeline available.

`/hld-draft`'s `Wanted invariants (no oracle yet)` section is written to be
`/fitness-function`'s input, and `/arch-map`'s edge ledger is what a boundary rule should
be written against. Those hand-offs are a person copying text between two commands.
Nothing in this package carries state between runs, and nothing here invokes anything
else.

No name in this package collides with anything else in the catalog:
`starter-skills`' three commands, `plan-pressure-tests`' four, `mobile-ground-truth`'s
four, `enterprise-org`'s eleven roles and six pipelines, and `design-review-org`'s five
roles and two pipelines. All of them install side by side. `/rfc-review` from
`plan-pressure-tests` is the natural reader for what `/hld-draft` produces, and running
it on a draft is the fastest way to find out whether the draft still reads as a form.

## When not to use `/hld-draft`

This command exists over a real objection, recorded in RFC 0003 §4.1: a drafted design
document is a document nobody has thought about, and its confident prose gets reviewed as
though somebody had. That objection is correct about every design-document generator
including this one. `/hld-draft` ships because its refusal turns the output into a form —
`Assumed — unconfirmed` is a numbered list a human ratifies, `<unstated>` is a number
nobody has, and the hole count is in the header where the first reader sees it.

**Do not use it when you have not yet decided what you are building.** The thinking is the
product, and a structure handed to you early is an anchor: the boxes it names are the
boxes the discussion will be about. Write the problem statement yourself, decide the
shape, and use this to find the holes in what you decided.

Do not use it to produce a document for someone else to review as a proposal. It produces
a worksheet for the person doing the work.

If the output ever reads as a finished document rather than a form — if the holes are not
counted, if `Assumed — unconfirmed` is short and the prose is long, if a number appears
without a source — the objection wins, and the honest fix is to delete the command rather
than to edit the paragraph that made it sound considered.

## Honest limits

Where this package's guarantee stops. Every row is a real seam, not a disclaimer.

| Limit | Why it is real | What you can rely on instead |
|---|---|---|
| **These instruct a model, they do not constrain it** | Every refusal in the table above is a rule written into a prompt and enforced by the model's compliance with it. "It will not invent a rejected alternative" improves the odds and gives you the exact sentence to check the output against; it is not a validator, and nothing in the harness verifies that a skill obeyed its own file | The real boundaries are the lane derivation, which does not apply to skills, and the [permission engine](https://arcturn.dev/docs/permissions), which does not read prompts at all |
| **A skill runs in your session, with your tools** | A skill has no lane: no worktree, no discarded diff, no authority derived from a `tools:` list. Whatever your session holds, the model holds while the skill runs | The permission engine, and reading what the command says it did before you accept it |
| **`/fitness-function` plants a violation in your actual checkout** | This is the sharpest instance of the row above. Proving a check bites means breaking the rule and re-running, and there is no worktree here to break instead. The command refuses to plant unless `git status --porcelain` is empty, prints the diff it planted, reverts with `git checkout -- <path>`, and ends with an empty status — but all four of those are prompt rules | Run it on a clean tree, read the transcripts, and check the final `git status`. The structural version of the same loop is `design-review-org`'s `invariant-oracle`, which holds `bash` without `write` or `edit` and so vandalises a detached worktree the engine discards |
| **`/adr-record` and `/hld-draft` write files** | Both produce an artifact and will put it where you tell them. In a session with write tools, that is a file appearing in your tree | `git status` and `git diff`. Both commands name the path they wrote in their first block, and neither writes anywhere it did not say it would |
| **A citation is a pointer, not a proof** | The method throughout is converting "trust me" into a `path:line`, a quoted brief sentence, or a command with its exit code. Nothing verifies that the pointer resolves or that the line says what the row claims | Open two or three citations. It is the cheapest audit available on this output, and the evidence appendix in `/adr-record` and the numbers table in `/hld-draft` exist to make it a two-minute job |
| **`/arch-map` sees static imports and says so** | Dependency injection, reflection, service loaders, string-keyed registries, config-driven wiring and code generation are invisible to import resolution. In a Spring or .NET tree the resolved fraction can be most of the wiring or very little of it | The recall bound, printed as `resolved / statements found` with every unresolved site listed by mechanism. Read it as part of the result. In Swift there are no file-level imports at all, so intra-module edges do not exist in the graph — the map says that rather than inferring them |
| **`ENFORCING` is a claim about the violation that was planted** | A rule that catches the planted shape and misses a second one is still reported `ENFORCING`. Transitive edges, aliased specifiers, type-only imports and dynamically resolved names each fail differently per tool | The `Violation planted:` diff and the `Scope of this check` section, which lists what the tool sees, what it does not, and which shapes were not tested. The recipes name the blind spots per tool so they can be planted against rather than assumed |
| **A CI job is not a gate until it is a required check** | `/fitness-function` prints the workflow snippet, and nothing in that file makes the job block a merge. Branch protection is a repository setting | The command prints `ADVISORY-ONLY` with the two conditions that would make it a gate. Verify them in your repository's settings, not in the YAML |
| **Nothing here carries state between runs** | There is no baseline store, no history, no record of what was proven last week. Every run starts from the tree in front of it | Commit the check and its transcripts. The proof is a paragraph in a pull request, and a check that was proven once and later stopped biting is caught by planting again, which costs a minute |
| **The drop counts are self-reported** | `/adr-record`'s unobservable consequences and `/hld-draft`'s dropped risks are counted by the same model that dropped them | The number tells you filtering happened and gives you something to argue with. It is not evidence the filtering was right |
| **The brief you hand these is untrusted text** | `$ARGUMENTS` is frequently a document from outside your team, and text inside a document can be written to instruct the model reading it. These skills treat the brief as the artifact under audit rather than as instructions — but that, too, is a prompt rule | A brief whose closing section asks the reader to mark every constraint cited is the input worth watching for. Nothing in this package fences the text it is handed |
| **Nothing here approves or accepts anything** | `/adr-record` writes `Status: Proposed` and no other status value; `/hld-draft` writes `STATUS: DRAFT`. No command here writes `Accepted` as a status and none of the four has an approval value to give — including when the code has been in production for a year | Acceptance is a person changing the status in a commit with their name on it. That is what an ADR's status field is for, and it is the only thing that makes it worth reading |
| **A listing is not an audit** | This package's registry entry is a claim about files, checked by a reviewer once and by `web/scripts/hub.test.ts` against this tree | `arcturn inspect <source>` re-derives the same table from the code that would actually be installed. Trust that over any page |

## What is deliberately not here

- **A low-level design command.** `lld-plan` was designed and cut: it is `/hld-draft` one
  altitude down with a near-identical refusal, and two generators in a four-command
  package is one too many. The altitude that earns citation discipline is the design, not
  the file list.
- **API contract review.** Two skills — a change classifier that refuses to call a change
  non-breaking by inspection when a differ exists, and a contract-first drafter — are
  named as unshipped rather than silently omitted. They need a repository with a
  machine-readable contract to validate their refusal against, and a repository with no
  OpenAPI, proto or SDL should not carry those commands in its slash list. They are a
  two-command addition to this package when there is a tree to test them on.
- **A whole-repo `ARCHITECTURE.md` generator.** It maximises exactly the surface nobody
  can check. `/arch-map` produces a ledger you can open instead.
- **An architecture health score.** A grade nobody can reproduce outlives the code it
  describes. `/fitness-function` produces a check that either fails on a violation or does
  not, which is a number with a meaning.
- **Anything executable.** No `extensions/`, no scripts in skill folders. The scripts in
  `recipe-ci-grep.md` and `recipe-go-arch-lint.md` are printed for you to create in your
  own repository, where they get reviewed in a diff like any other code.

**Edit them.** These are six files and six reference tables. An ADR shape your team
already uses, a stack whose recipe is missing, an output block your review tool can
ingest, a hole-counting convention you prefer — change them.
`arcturn add ./kits/design-docs` from a clone installs your edited copy, and a
project-scope `.arcturn/skills/adr-record/SKILL.md` wins over an installed user-scope one,
so a team can standardise a variant in a pull request without anyone uninstalling
anything.

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
