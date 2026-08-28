# design-review-org

Five agent roles and two pipelines that review a design **before** the code
exists — where the document's author holds no shell, an oracle role
deliberately breaks a throwaway copy of the tree to find out whether a check
bites, and the human gate is a pause the engine enforces in the middle of the
run rather than a paragraph asking a model to wait.

Nothing in this kit approves anything. `VERDICT: ADVISORY` is the only verdict
value in the pack, no step can mark a record accepted, and the decision a
person makes at stage 3 is transcribed by a stage that structurally cannot have
observed the evidence it is recording a decision about.

---

## Install

```bash
arcturn add sitharaj88/arcturn/kits/design-review-org
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`kits/design-review-org` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links five roles into `~/.arcturn/agents/` and two
pipelines into `~/.arcturn/workflows/`.

To read what an install would add before running it:

```bash
arcturn inspect sitharaj88/arcturn/kits/design-review-org
```

From a clone, the local-path form installs your edited copy — which is also the
loop for forking any of these files:

```bash
arcturn add ./kits/design-review-org
arcturn remove design-review-org
```

Then `/workflow list` shows the two pipelines and `/team --roles design-lead`
resolves a role as a team specialist.

## The pipelines

```
/workflow design-review  <the brief: what you want to build, and the constraint you care about>
/workflow design-drift   <the design document, ADR or RFC to check — a path, plus any scope>
```

| Pipeline | Stages | What it does | What it refuses to do |
|---|---|---|---|
| `design-review` | 4 stages (6 steps), `budgetUsd: 20`, `stepTimeoutMs: 1800000` | Writes a design record with every constraint cited, attacks it from three independent lanes, puts the unresolved trade-off to a person, then transcribes their answer into the record. | Approve a design. No step in it holds that authority — the gate is the pause at stage 3, not a role's verdict, and stage 4 exists only to write down a decision a person already made. It will not mark a record `Accepted` without a human's verbatim answer in its input. |
| `design-drift` | 4 stages (4 steps), `budgetUsd: 15`, `stepTimeoutMs: 1800000` | Turns a design document's claims into predicates, runs each one, plants a deliberate violation to find out whether the check bites, and reports where the document and the tree have parted company. | Fold `NO-ORACLE` into `PASS`. Unprovable claims are printed with their own count at every stage that touches them, because separating "we checked and it holds" from "nobody can check this" is the entire product. Stage 1 refuses to carry a claim forward it cannot state as a predicate, and no role in the pipeline is on the write lane, so none of them can edit a document to make the ledger green. |

## The roles

| Role | Produces | Tier | Tools | Lane (derived) | The one thing it must never do |
|---|---|---|---|---|---|
| `design-author` | `DESIGN-RECORD`, `DECISION-RECORD` | opus | `read, grep, glob, ls, search_code, write` | **write** | Report a command, an exit code or a measured number. It has no shell, so it cannot have run one |
| `codebase-critic` | `CRITIQUE`, `CLAIM-LEDGER` | opus | `read, grep, glob, ls, search_code` | **read** | Raise a blocker it cannot address to a `path:line` — an unaddressable finding becomes a question, and the downgrade count is printed |
| `invariant-oracle` | `ORACLE-REPORT` | sonnet | `read, grep, glob, ls, bash` | **exec** | Report an invariant satisfied. A check that cannot be made to fail is `RUNS-ONLY`; one that cannot run is `NO-ORACLE` |
| `impact-analyst` | `IMPACT` | sonnet | `read, grep, glob, ls, bash` | **exec** | Present a consumer list as complete. Every report carries its recall bound and what would close each gap |
| `design-lead` | `REVIEW-PACKET`, `DRIFT-LEDGER` | opus | `read, grep, glob, ls, search_code` | **read** | Resolve the trade-off. `ORG-ASK:`, `ORG-HALT:` and `VERDICT: ADVISORY` are its only terminal moves |

**The Lane column is derived, not declared.** `roleDispatch`
(`packages/cli/src/workflow.ts`) reads a role's `tools:` line: any of
`write`/`edit`/`multiedit` lands it on **write**, `bash` without those lands it
on **exec**, and neither lands it on **read**. `arcturn inspect` prints the
same derivation, and `web/scripts/hub.test.ts` re-derives it from the engine's
own tool-set literals when it checks this pack's registry entry — a lane typed
by hand fails that suite. The table above is what the engine will actually do,
not a description of intent.

Every role file carries the same spine: mission, method, definition of done, an
explicit `Never` list, and a fixed output envelope beginning
`ARTIFACT: <TYPE>`. Each ends with the halt convention — *if the input contains
`ORG-HALT`, re-emit that line verbatim and stop* — so an upstream halt walks
intact into the final packet instead of being ground over, and every downstream
step in both pipelines repeats the clause in its own prompt.

**Tiering follows absence of an oracle, not seniority.** `invariant-oracle` and
`impact-analyst` run a tier down and loop more (`maxTurns: 60` and `50`)
because both are graded mechanically: an exit code and a restored baseline for
one, a pasted search command and its hit count for the other, and a reader can
re-run either. `design-author`, `codebase-critic` and `design-lead` produce
prose that no command downstream can check, which is exactly why they are on
the flagship tier and why the pipeline ends at a person. `design-lead` sits at
`maxTurns: 40` rather than 50: it assembles and verifies addresses, it does not
explore. The one explicit `[model]` tag in either pipeline is on
`design-review` stage 4, which drops `design-author` to sonnet — originating a
design record costs more than transcribing a decision, and the transcription
has an oracle a reader can apply in seconds, since the quoted answer either
matches the recorded question's answer character for character or it does not.

## Three primitives this kit demonstrates

`enterprise-org` is the other org kit in this repository, and it shows none of
these three. That is why this one exists.

**The withheld tool is the guarantee.** `design-author` holds `write` and no
`bash`. Every empirical claim in the packet must therefore be attributable to
an exec-lane stage, because the role that wrote the document had no way to
produce a transcript. This costs nothing but restraint, and it is stronger than
any sentence a prompt could contain: giving the author a shell would not change
its lane, it would let the document's author run something and then narrate it.

**Vandalism is verification.** `invariant-oracle` runs each declared check at
the seed commit, then plants the smallest plausible violation of the invariant
and re-runs the check to find out whether it notices. A check that stays green
through a real violation is `RUNS-ONLY`: it runs, it does not measure what the
document claimed. This is only safe because of the lane — the role holds `bash`
with neither `write` nor `edit`, so it dispatches into a detached worktree
whose diff is **never captured and never applied**, and the engine mints the
`ARCTURN-PATCH: status=discarded` trailer itself, from a record the role's own
text cannot forge. Break the copy, never the checkout.

**The gate is a mid-pipeline `ORG-ASK` on a read-lane role.**
`enterprise-org`'s human gates are workflow *boundaries*: the pipeline ends and
you read the packet. Here `design-lead` pauses the run at stage 3 with a
question the engine records, prints the resume command, and stops. Answer it
and the engine continues from stage 4 with your answer spliced in; decline, and
the gate leaves nothing behind, because `design-lead` has no worktree and no
way to write a file. A competing design put the same ask on a write-lane role,
which leaves an orphan options document on disk when you walk away — that is
the whole reason the gate sits where it sits.

Two mechanical details of that pause are worth knowing before you edit either
pipeline, because both shaped the stage briefs:

The engine reads `ORG-ASK:` off the **start of a line** and takes the rest of
**that one line** as the question, and only the **first** such line in a step's
output is recorded. So `design-lead` is instructed to put the whole choice, its
options and their costs on the marker line itself, and to ask exactly one
question — a second one is not asked, it is lost. `ORG-HALT:` anywhere in the
same output wins over any question, so the two are never emitted together.

On resume, the answer **replaces the asking step's output text**. Stage 4
therefore never sees the review packet; it sees the human's answer and
`{{journal}}`, the engine's own ledger of which steps ran, what each cost and
what was asked. That is why stage 4 re-reads the design record from disk and
cites the packet rather than restating it: the transcribing stage cannot
paraphrase evidence it does not have.

## Parallel branches, and why they cannot collide

`design-review` stage 2 runs three branches at once, and they are disjoint
**by construction** rather than by a printed partition of file scopes. None of
the three is on the write lane: `codebase-critic` holds no mutating tool at
all, and `invariant-oracle` and `impact-analyst` hold `bash` with neither
`write` nor `edit`, so their worktrees are dead ends and no branch can land
anything for another to collide with. Each also re-derives from the tree rather
than trusting the record spliced into its prompt, so the three reports are
three independent readings rather than three elaborations of one.

`design-drift` is fully sequential, and each stage genuinely needs the last:
predicates, then whether each check bites, then who depends on the ones that
drifted, then the ledger and the question.

## Composition

These five role names are chosen not to collide with `enterprise-org`'s eleven
(`pm`, `architect`, `tech-lead`, `developer`, `qa-functional`,
`qa-adversarial`, `security-reviewer`, `ux-reviewer`, `docs-writer`,
`release-manager`, `retro`), and the two pipeline names do not collide with its
six. Install both kits side by side and nothing shadows anything: a role name
collision resolves silently to the later root, and a warning is not a design.

The two kits meet at the code boundary rather than overlapping. This one ends
at a decision record for a design; `enterprise-org`'s `feature-build` starts
from a charter and ends at a merge gate. A reasonable sequence is
`/workflow design-review` first, then hand the recorded decision to
`feature-build` as its charter.

Neither pipeline here names a role from another package, and that is a
structural requirement rather than a preference: `@role` resolves against the
loaded agents **before** the pipeline's first step runs, so a cross-pack
reference would fail the whole run at load for anyone who installed one pack
and not the other.

## Honest limits — where this kit's guarantee stops

| Limit | Why it is there | What actually holds |
|---|---|---|
| **These role files instruct a model; they do not constrain it.** Every `Never` list in this pack is prompt text | A role file is markdown. Nothing validates that a role obeyed its own refusal | The lane derived from `tools:`, which the dispatcher applies before the role's first token, and the [permission engine](https://arcturn.dev/docs/permissions), which does not read prompts at all |
| `design-review` **fails immediately under plan mode** | Stage 1 is a write-lane step and plan mode has no write lane, so the run dies at the first step that needs one — before a token is spent, naming the role | Approve the plan or leave plan mode. `design-drift` has no write-lane role at all and runs under plan mode end to end |
| **The exec lane protects your checkout, not the world** | It guarantees `invariant-oracle`'s and `impact-analyst`'s diffs never reach your tree. It says nothing about a network call, a package registry, a running daemon, a shared cache or anything else host-global | Their deny lists are prompt text. `config.sandbox` and the permission engine are the layers where that constraint is expressible somewhere it is enforced |
| **`{{prev}}` is unfenced** | A whole previous stage is spliced verbatim into the next prompt, and so is the design document under review | "No role in `design-drift` holds a mutating tool" is a claim about **capability**, never about content. `taint.ts` and `canary.ts` exist in this tree with integration notes and are not wired into `runtime.ts`; until they are, the content half of that invariant is not claimable and this README does not claim it |
| **Declining to resume leaves nothing *from the gate* — but stage 1's record is on disk** | The `ORG-ASK` sits on a read-lane role, so the question and the packet leave no file behind. The design record was written by stage 1, deliberately, and stays | It is marked `Proposed`, and no step in the pack can change that without a human's verbatim answer. If you want a pass that writes nothing at all, that is `design-drift` |
| **`ORG-ASK` pauses a run; it is not a permission boundary** | It is a resumable cut point in a pipeline. Answering it grants nothing and withholding an answer revokes nothing | What bounds a step is its lane and the permission engine. Nothing in this pack holds a credential or mutates anything outside a worktree, which is why the pause never has to be one |
| **A `PROVEN` verdict is a statement about one planted violation** | `invariant-oracle` proves a check bites against the specific violation it planted. A rule that catches that one and misses a second shape is still `PROVEN` here | Read the `Violation planted:` line, not only the outcome. The report is written so that you can disagree with the choice of violation |
| **There is no run-id placeholder** | `{{input}}`, `{{prev}}` and `{{journal}}` are the three placeholders the parser accepts; none carries the run id, and a write-lane role can only infer it from the worktree path it sits in | `design-author` writes `RUN-ID: not established in this session` rather than a plausible-looking id, and `/workflow status` lists the run, its spend and the question it paused on |
| **Budgets and step timeouts are ceilings, not measurements** | `budgetUsd: 20` and `15` are set to catch a runaway loop, and the 30-minute step ceiling is set so a slow suite inside `invariant-oracle`'s vandalise-and-restore loop is not cut off mid-check — a check aborted mid-flight is the exact input that produces a false pass | Run each pipeline once, read the real spend off `/workflow status`, and set your own |
| **No frontmatter in this pack pretends to be enforcement** | `agents.ts` parses exactly `name`, `description`, `tools`, `model` and `maxTurns`. `writes:`, `reads:`, `consumes:`, `produces:` and per-role `budget:` are parsed by nothing, and `multiedit` is in the engine's `WRITE_TOOLS` but absent from `BUILT_IN_TOOL_NAMES`, so declaring it advertises authority the role never receives | These five files declare only the five keys that are read, so there is no field in this pack that looks like a boundary and is not |
| **A listing is not an audit** | The hub entry's disclosure block for this pack is re-derived from these files by `web/scripts/hub.test.ts`, so it cannot drift. That checks that the page and the install agree — nothing more | Run `arcturn inspect` against the source you are about to install, and trust that over any page |

Two limits are not going away, and should not:

**No step in this kit can approve a design.** That is the design, not a gap.
There is no `APPROVED` value anywhere in the pack, and stage 4 writes
`Accepted (human)` only as a transcription of words a person typed.

**No model verdict is a blocking gate.** Ranking and triage, yes. Verdicts,
never. The only claims allowed to rank first in a packet are the ones carrying
a command with its real exit code, an address a reader can open, or a search
transcript.

## Validating your copy

Every file in this directory parses through the parsers the runtime itself
uses. To prove it in your checkout:

```js
// scratch.mjs — run with: node scratch.mjs
import { loadAgentDefs } from "./packages/cli/dist/agents.js";
import { parseWorkflow, roleDispatch } from "./packages/cli/dist/workflow.js";
import { BUILT_IN_TOOL_NAMES } from "./packages/cli/dist/runtime.js";

const warnings = [];
const defs = await loadAgentDefs(["kits/design-review-org/agents"], warnings, BUILT_IN_TOOL_NAMES);
console.log(defs.length, "agents,", warnings.length, "warnings");
for (const def of defs) console.log(def.name, roleDispatch(def));
```

Result at the time of writing (`packages/cli/dist`, 5 agents, 2 workflows):

```
=== AGENTS: loadAgentDefs(kits/design-review-org/agents) ===
files on disk: 5  parsed defs: 5
  ok  codebase-critic   model=tier:judgment    prompt= 6316ch  lane=read  maxTurns=50  tools=[read,grep,glob,ls,search_code]
  ok  design-author     model=tier:judgment    prompt= 8137ch  lane=write maxTurns=50  tools=[read,grep,glob,ls,search_code,write]
  ok  design-lead       model=tier:judgment    prompt= 6979ch  lane=read  maxTurns=40  tools=[read,grep,glob,ls,search_code]
  ok  impact-analyst    model=tier:build  prompt= 5047ch  lane=exec  maxTurns=50  tools=[read,grep,glob,ls,bash]
  ok  invariant-oracle  model=tier:build  prompt= 5921ch  lane=exec  maxTurns=60  tools=[read,grep,glob,ls,bash]
agent loader warnings: none

=== WORKFLOWS: parseWorkflow(kits/design-review-org/workflows) ===
  ok  design-drift   stages= 4  steps= 4  parallel-stages=0  continueOnError=false  budgetUsd=15  stepTimeoutMs=1800000  role-steps=4 (read=2 write=0 exec=2)  anonymous-steps=0
  ok  design-review  stages= 4  steps= 6  parallel-stages=1  continueOnError=false  budgetUsd=20  stepTimeoutMs=1800000  role-steps=6 (read=2 write=2 exec=2)  anonymous-steps=0

unresolved @role references: none
```

`role-steps=N (read=X write=Y exec=Z)` is `roleDispatch()` computed for real
over every `@role` step in the file. Across both pipelines exactly two steps
run on the write lane, and both of them are `design-author` in `design-review`
— the role that holds no shell. That ratio is checkable from `tools:` alone,
which is the point of stating it.

`arcturn inspect ./kits/design-review-org` prints the same five lanes, the
same stage counts and budgets, and `No extensions: this package ships no
executable code.` The registry entry at `registry/design-review-org.json`
carries `"executable": false`, and `npx vitest run web/scripts/hub.test.ts`
checks that claim against the absence of an `extensions/` directory rather than
taking the entry's word for it.

## Editing the kit

Rules the parsers enforce, which are easy to trip over:

A step is exactly one line, with no continuations. Stages are numbered
consecutively from 1, and parallel branches are indented `-` bullets (`*` and
`+` are rejected). A numbered line carrying both a prompt and branches must end
with `:` to be read as a label. Only `{{input}}`, `{{prev}}` and `{{journal}}`
exist; a typo is a parse error, and `{{prev}}` or `{{journal}}` in stage 1 is
an error too. In the documentation header above the steps, avoid starting a
line with a bullet character or with a digit followed by `.` or `)` — the
scanner reads either as a new step, even where a line wrap happens to land a
parenthetical at the start of a line.

`@role` comes right after an optional `[model]` tag, never before it, and the
role name must be lowercase. A step naming a role with no matching file in
`agents/` fails the whole run before stage 1 spends a token, exactly like an
unknown model tag.

Every role in this kit declares `tools:` explicitly, and yours must too: an
omitted list is refused at dispatch rather than defaulting to the read lane —
it used to mean "everything the session allows", which is the widest grant in
the system.

Docs: [Markdown agents](https://arcturn.dev/docs/agents) ·
[Workflows](https://arcturn.dev/docs/workflows) ·
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
