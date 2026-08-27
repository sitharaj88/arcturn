# plan-pressure-tests

Four slash commands that take a plan somebody already wrote and check it against
reality. They generate nothing — each one is a reader that grades, searches, filters or
orders what you hand it, and each refuses to supply the one judgment it cannot ground.

That is the whole design. The planning skills you can find elsewhere write a plan from
one line of input, which is the input-starved shape where fabrication is not a risk but
a certainty: nothing in the prompt could have told the model what your system does, so
whatever comes back was invented. These four start from a document you wrote and a tree
you own, and they spend their effort on the boundary between what is established and
what somebody merely believes.

## Install

```bash
arcturn add sitharaj88/arcturn/kits/plan-pressure-tests
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`kits/plan-pressure-tests` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links the four skills into `~/.arcturn/skills/`. They are
available as `/assumption-audit`, `/feasibility-read`, `/rfc-review` and `/scope-cut`
immediately.

To read what an install would add before you run it:

```bash
arcturn inspect sitharaj88/arcturn/kits/plan-pressure-tests
```

From a clone, the local-path form works for both — `arcturn add ./kits/plan-pressure-tests`
and `arcturn inspect ./kits/plan-pressure-tests` — which is also the loop for
installing your own edited copy. `arcturn remove plan-pressure-tests` uninstalls;
`arcturn update plan-pressure-tests` re-fetches.

## The four commands

| Command | What it does | What it refuses to do |
|---|---|---|
| `/assumption-audit` | Pulls out the claims a plan rests on, rewrites each one so that it could be false, grades it against evidence, and designs one falsifying test per claim. | Mark an assumption `SUPPORTED` without naming the artifact — a `path:line`, a command with its real output, or a page fetched this session. "Seems reasonable" and "standard practice" are `UNTESTED`, and the phrase is printed verbatim in the column the evidence would have occupied. It also refuses to propose a test it cannot state as a command or a bounded human action, and prints how many it dropped. |
| `/feasibility-read` | Reads a plan against the repository in your working directory: what the tree already supports at `path:line`, what came back empty, and the unknowns ranked by how much of the design's shape they decide. | Estimate in hours, days, sprints or story points — or in any paraphrase of them. Asked for a number, it writes "No estimate is produced here", then the ranked unknown list and the one spike that collapses the widest of them. It also will not write "the codebase does not do X": an absence ships with the patterns and paths that found nothing, or the status is `UNKNOWN`. |
| `/rfc-review` | Grades a design document's load-bearing claims against the tree, then keeps only the comments that a plausible author's answer would *not* dispose of. | Print the comments it dropped. It prints the count by category instead, so you can tell a review that filtered hard from one that had nothing to say. It will not mark a claim `CONTRADICTED` without a `path:line`, and never marks one `HOLDS` on the document agreeing with itself. |
| `/scope-cut` | Maps each scope item to code, builds an edge ledger out of the import graph, and orders cuts by entanglement: leaves first, then by how many other items have to come out with each one. | Rank by value. The order is derived from printed edges with `path:line` evidence, ties are printed as ties, and the value ordering is handed back to you in one sentence. And no cut is ever called safe: an item with no consumer found is `impact unknown — author must supply`. |

All four take an argument, and it is a path or the text itself:

```
/rfc-review docs/rfcs/0003-hub-catalog.md
/scope-cut plan.md
/assumption-audit    (then paste the plan)
```

With no argument, or with a path that does not exist, each one says which and stops
rather than auditing a document it half-remembers.

## What these are, exactly

**A skill is a prompt template, not code.** Each file here is markdown with two optional
frontmatter keys (`name`, `description`) and a body; installing the pack copies text onto
disk and nothing else. There is no `extensions/` directory, no script inside a skill
folder, and nothing that runs at install time — which is why `arcturn inspect` prints
*no executable code* and why the install asks you no questions.

**Edit them.** These are four files. A grading vocabulary your team already uses, a
different output table, an extra never — change them. `arcturn add ./kits/plan-pressure-tests`
from a clone installs your edited copy, and a project-scope
`.arcturn/skills/rfc-review.md` wins over an installed user-scope one, so a team can
standardise a variant in a pull request without anyone uninstalling anything.

## What it sits beside

This pack ships no agent roles and no workflows, so it has no lane table and it adds
nothing to `~/.arcturn/agents` or `~/.arcturn/workflows`.

- **`starter-skills`** — `/commit-message`, `/pr-description`, `/release-notes`. No name
  collides, and the two packs cover different moments: those three describe work that
  already happened and the diff is the evidence; these four read a plan before there is
  a diff at all, which is why their evidence has to be searched for.
- **`enterprise-org`** — eleven roles and six pipelines. No name collides with the four
  here, and nothing would even if it did: a skill is a slash command in your own
  session, a role is dispatched by a workflow onto a lane. Running `/rfc-review` on the
  `ADR` an `architect` produced is a reasonable habit, and it does not need either pack
  to know about the other.
- **`design-docs`** (planned, RFC 0003 §2.1) — writes documents; this pack reads them.
  The seam is deliberate: `/rfc-review` is the natural reader for what a drafting skill
  produces, and neither one is improved by folding it into the other.

## Honest limits

These skills instruct a model, they do not constrain it. Every refusal in the table
above is a rule written into a prompt and enforced by the model's compliance with it —
not by the harness, and not by a validator. The real boundary on what any tool a skill
triggers may touch is the [permission engine](https://arcturn.dev/docs/permissions),
which does not read prompts at all.

| Limit | What it means here |
|---|---|
| **A skill runs in your session, with your tools** | Unlike an agent role, a skill has no lane: no worktree, no discarded diff, no authority derived from a `tools:` list. Whatever your session holds, the model holds while the skill runs. `/scope-cut`'s "never an edit" and `/rfc-review`'s "you do not rewrite the document" are prompt rules, and in a session that can write files nothing structural stops a write. If that matters to you, the structural version of a reader is an agent role on the read lane, not a skill. |
| **A citation is a pointer, not a proof** | The pack's whole method is converting "trust me" into a `path:line` and a printed search. Nothing verifies that the pointer resolves, or that the line says what the row claims it says. Opening two or three citations is still your job, and it is the cheapest audit available on this output. |
| **The drop counts are self-reported** | `/rfc-review`'s "23 dropped" and `/assumption-audit`'s dropped tests are counted by the same model that dropped them. The number tells you filtering happened and gives you something to argue with; it is not evidence the filtering was right. |
| **An absence is bounded by its patterns** | `ABSENT under search` is a claim about the spellings that were tried, in the paths that were searched, at one commit. Dependency injection, string-keyed registries, dynamic import, reflection, code generation and vendored copies are all invisible to a literal pattern. The skills name the mechanisms they could not see through, which bounds the claim honestly — it does not close the gap. |
| **The refused estimate is refused here only** | `/feasibility-read` removes one anchor from one output. Ask a different tool, or the same model in a fresh session, and a number comes back. What this pack offers in its place is counted facts with the search printed beside them, which is a substitute for an estimate and not a replacement for a planning conversation. |
| **The plan you hand it is untrusted text** | `$ARGUMENTS` is frequently a document from outside your team, and text inside a document can be written to instruct the model reading it. These skills treat the plan as the artifact under audit rather than as instructions — but that, too, is a prompt rule. A plan whose §9 asks the reader to mark everything supported is the input worth watching for. |
| **Nothing here approves anything** | `/rfc-review` prints `VERDICT: ADVISORY`, which is the only value that field has; there is no `APPROVED`. No command in this pack marks a plan accepted, and none of them could — the decision is a person's, recorded somewhere this output cannot reach. |

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
