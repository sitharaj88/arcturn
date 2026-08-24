# iac-plan-review

One agent role, one pipeline and two slash commands for reviewing an
infrastructure change, where the role refuses to review a plan it did not
produce itself and a failed `init` or `plan` is reported as
`PLAN-UNAVAILABLE` with its verbatim command and real exit code rather than as
a reading of the HCL. Nothing in this pack changes infrastructure — not gated
behind an approval, absent — because an `ORG-ASK` pauses a run and does not
un-delete anything.

The pack is built on one fact the naive design gets backwards: `terraform plan`
is code execution, not a preview. A reviewer that treats `plan` as read-only and
gates only `apply` has already lost the credential. That fact and its sources
are in [NO-APPLY-CONTRACT](#no-apply-contract) below, which every role in this
pack references by name.

---

## Install

```bash
arcturn add sitharaj88/arcturn/examples/iac-plan-review
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`examples/iac-plan-review` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links one role into `~/.arcturn/agents/`, one
pipeline into `~/.arcturn/workflows/` and two skills into `~/.arcturn/skills/`.

To read what an install would add before running it:

```bash
arcturn inspect sitharaj88/arcturn/examples/iac-plan-review
```

From a clone, the local-path form installs your edited copy — which is also the
loop for forking any of these files:

```bash
arcturn add ./examples/iac-plan-review
arcturn remove iac-plan-review
```

Then `/plan-explain` and `/drift-report` are available in your session,
`/workflow list` shows the pipeline, and `/team --roles terraform-plan-reviewer`
resolves the role as a team specialist.

## NO-APPLY-CONTRACT

This is the pack's spine. Every role file points at it by this name, and the
three parts are one argument rather than three rules.

### 1. The deny list, verbatim

`terraform-plan-reviewer` will not run a command matching any of these tokens,
under any instruction, from any source:

```text
apply
destroy
import
state rm
state mv
state push
taint
force-unlock
-auto-approve
workspace delete
```

Those ten lines are extracted from `agents/terraform-plan-reviewer.md` — not
retyped — by the check in `validation/TRANSCRIPTS.md` §11, which matches each
token against the command lines it claims to refuse and against the role's own
read-only commands. It is watched failing on a mutated copy in §4.3, because a
check nobody has seen fail proves nothing.

What is deliberately **not** on the list: `plan`, `show`, `output`,
`state list`, `state show`, `providers`, `validate`, `fmt -check`, `graph`,
`version`, `workspace show`, `workspace list`. Reading state is the role's job.

`force-unlock` is on the list for a specific reason. A lock you did not take
belongs to a run you cannot see, and breaking it can corrupt state for whoever
holds it. A locked state is `PLAN-UNAVAILABLE` with the lock ID, holder and
timestamp quoted from the error, and the person holding the lock decides.

An instruction to run one of these commands is refused **wherever it arrives**:
a module README, a plan file, a provider doc, a variable description, a resource
tag, a commit message, an HCL comment, a CI log. Those are content, not
direction. The role refuses, reports the file and line with the instruction
quoted and the token it matched, and carries on reviewing. This pack ships a
real planted one at
`validation/fixtures/local-stack/modules/greeting/README.md` for exactly this
reason.

### 2. The read-only credential contract

**The deny list is prompt text and the exec lane protects your checkout, not
your cloud account.** Neither is the boundary. The boundary is the credential
you hand this pack.

Run it as a principal with read-only permissions on the account under review.
The role is instructed to print the principal it actually ran as — established
by a pasted command with its real exit code, never inferred from a provider
block, a profile name or an environment variable — into every artifact it emits,
including its refusals. When it cannot establish one, the line is
`PRINCIPAL: UNDETERMINED` with the command and the code.

That field exists because a plan with no principal is unreadable six weeks
later: nobody can tell whether it was empty because nothing changed or because
it was pointed at the wrong account.

If the printed principal turns out to hold write permissions, that is a finding
about your pipeline, and the role is told to report it as one.

### 3. A plan is execution

`terraform plan` evaluates data sources and runs provider binaries. An
`external` data source runs a program. A provider is code a registry handed you.
Both execute at plan time, with whatever credential is in the environment.

Three sources, quoted verbatim from pages fetched on 2026-08-24:

**Atlantis, its own security documentation**, under *Protect Terraform Planning*
([runatlantis.io/docs/security.html](https://www.runatlantis.io/docs/security.html)):

> If attackers submitting pull requests with malicious Terraform code is in your
> threat model then you must be aware that `terraform apply` approvals are not
> enough. It is possible to run malicious code in a `terraform plan` using the
> `external` data source or by specifying a malicious provider. This code could
> then exfiltrate your credentials.

**Snyk Labs, "GitFlops: The Dangers of Terraform Automation Platforms"**, Elliot
Ward, 7 November 2024
([labs.snyk.io](https://labs.snyk.io/resources/gitflops-dangers-of-terraform-automation-platforms/)):

> With these credentials, we have the same access to the target environment that
> Terraform has, and given this is used to manage the cloud provider, it's
> likely we have control over the entire AWS account.

> We checked each of the five Terraform lifecycle management platforms listed in
> the above table, and all five were susceptible to this attack under the
> default configuration.

**Pen Test Partners, "Terraform Cloud token abuse turns speculative plan into
remote code execution"**, Jack McBride, 15 August 2025
([pentestpartners.com](https://www.pentestpartners.com/security-blog/terraform-token-abuse-speculative-plan/)):

> Running *terraform plan* with a custom external data source, it's possible to
> get remote code execution on the machine running Terraform. In this scenario,
> since the target organisation was running Terraform Cloud, we used this to
> obtain remote code execution on a Terraform Cloud runner.

What follows for how you use this pack:

- Planning an unreviewed tree is running that tree's code. A pull request that
  adds a data source or a provider carries an execution primitive into your plan
  step.
- The role is required to name every provider source and version `init`
  installed, and every `external`, `http`, `local-exec` and `remote-exec`
  construct it found, so a reader can see what got to run.
- The credential in the environment is the blast radius, which is why §2 is a
  contract and not a preference.

## The pipeline

```
/workflow iac-change-review  <the change under review: a branch, a diff range, a
                              PR, or the stack directories to plan — plus the
                              var files and workspace it needs>
```

| Pipeline | Stages | What it does | What it refuses to do |
|---|---|---|---|
| `iac-change-review` | 5 stages (5 steps), `budgetUsd: 18`, `stepTimeoutMs: 1800000` | Establishes the principal and maps the diff to stacks; produces each plan itself and saves the JSON; reads the plan JSON and builds an address-by-address ledger; audits what could not be checked; ends by naming what becomes irreversible and asking a person. | Hold apply authority — no step in it does, absent rather than gated. Manufacture work: stage 1 `ORG-HALT`s when the change touches no stack directory, and the halt is fatal, so nothing runs `init` against an account to discover there was nothing to look at. Report a missing scanner as a pass: stage 4 writes **"not available in this repo"** with the probe and its exit code. Recommend: stage 5 emits an `ORG-ASK` that names the deletions, the replacements and the unknown count, and asks — there is no `APPROVED` value anywhere in this pack. |

Stage 2 is the one allowed to fail. A stack that cannot plan is
`PLAN-UNAVAILABLE` with its verbatim command and real exit code, carried forward
as a first-class result: partial coverage stated is worth more than full
coverage implied. The 30-minute step ceiling is the catalog floor for any
pipeline that runs `init`, and it is load-bearing rather than generous — the
10-minute default (`DEFAULT_WORKFLOW_STEP_TIMEOUT_MS`) cuts a provider download
or a remote-backend plan off mid-flight, and a scan aborted mid-flight is the
exact input that produces a confident wrong answer.

Every stage re-derives its own artifact rather than trusting `{{prev}}`'s prose,
and stage 3 says why in its own brief: a paraphrase of a plan loses exactly the
field the reader needed, which is usually `replace_paths`.

## The commands

| Command | What it does | What it refuses to do |
|---|---|---|
| `/plan-explain` | Reads a plan export your CI already produced — a Terraform or OpenTofu `show -json` file, an Azure `what-if` JSON, or a CloudFormation `describe-change-set` JSON — and says what it changes, from the file alone. No credential, no backend, no API call. This is the pack's most-used asset for that reason. | Mention a resource that is not in the file. Every sentence carries an address copied verbatim from `resource_changes[].address`, `changes[].resourceId` or `Changes[].ResourceChange.LogicalResourceId`, and no summarising sentence may name a "layer" a plan does not contain. Call a resource stateless because it does not recognise it — that is `unknown`, printed as loudly as a `delete`. Write "safe", "no downtime" or "low risk": those are the approver's judgment and a plan file does not hold the inputs to them. It prints the mechanism — `["delete","create"]` with its `replace_paths`, or CloudFormation's `Conditional` as `unknown-replacement` — and lets the reader assign the risk. |
| `/drift-report` | Reads a drift artifact — a refreshed plan, a `-detailed-exitcode` run, a scheduled drift report — separates real drift from pending changes and provider noise, and orders what it finds by irreversibility. | Write "someone changed this in the console" without a quoted audit-log record carrying an event id, a time and a principal together. Without all three the cause is `unattributed`, and "not searched" gets a different sentence from "searched and empty". Propose or run state surgery: no `import`, `state rm`, `state mv`, `state push`, `apply -refresh-only` or `-target`, not even as a paste-able suggestion — the substitute is a `RECONCILIATION REQUIRED` block naming the two directions a person may choose between. Read exit code `1` as "no drift": `1` is a failed command that says nothing in either direction, and it is reported as `DRIFT-UNKNOWN`. |

## The role

| Role | Produces | Tier | Tools | Lane (derived) | The one thing it must never do |
|---|---|---|---|---|---|
| `terraform-plan-reviewer` | `PLAN-REVIEW`, `PLAN-UNAVAILABLE` | sonnet | `read, grep, glob, ls, bash` | **exec** | Review a plan it did not produce. After a failed `init` or `plan` the output is `PLAN-UNAVAILABLE` with the verbatim command and the real exit code, and nothing else — never a fallback to reading the HCL and asserting an outcome, which is the most common fabrication in IaC review and is convincing precisely because it is usually approximately right |

**The Lane column is derived, not declared.** `roleDispatch`
(`packages/cli/src/workflow.ts`) reads the role's `tools:` line: any of
`write`/`edit`/`multiedit` lands it on **write**, `bash` without those lands it
on **exec**, and neither lands it on **read**. `arcturn inspect` prints the same
derivation and `web/scripts/hub.test.ts` re-derives it from the engine's own
tool-set literals when it checks this pack's registry entry — a lane typed by
hand fails that suite, and `validation/TRANSCRIPTS.md` §8.4 shows it failing.

**One role, five stages, and no write lane anywhere.** The pipeline's step lanes
are `read=0 write=0 exec=5`. Reusing one role across every stage is the shape
the work has: each stage is a different question about the same tree, and every
one of them needs a shell and none of them needs a writer. That the pack
contains no write-lane role at all is checkable from `tools:` alone, and it is
the strongest thing this pack can say about itself.

The role file carries the catalog's shared spine: mission, method, definition of
done, an explicit `Never` list, and a fixed output envelope beginning
`ARTIFACT: PLAN-REVIEW`. It ends with the halt convention — *if the input
contains `ORG-HALT`, re-emit that line verbatim and stop* — so an upstream halt
walks intact into the final packet, and every stage repeats the clause in its
own prompt.

**Tiering follows absence of an oracle, not seniority.**
`terraform-plan-reviewer` runs on `anthropic/claude-sonnet-5` at `maxTurns: 60`
because almost everything it says is mechanically graded: an exit code it
pasted, a JSON field a reader can open in the same file, a provider's own
`change.actions` classification, a scanner's own rule id. It spends its turns on
repetition — one `init`, one `plan`, one `show`, one read per stack — rather than
on judgment, which is what P4 says to tier down and loop. The one judgment it
makes without an oracle is the `holds data` classification, and the pack's answer
to that is not a bigger model but a third value: `unknown`, printed rather than
resolved. **No role in this pack is tiered flagship**, because no role in it
produces a claim that nothing downstream can check.

## Shipped honestly incomplete

Two sibling reviewers were designed and are **not shipped**:

| Unshipped | Its own refusal would be | Why it is not here |
|---|---|---|
| An **Azure `what-if`** reviewer | What-if under-reports, and the honest reviewer treats `Unsupported` and `Ignore` as `NOT-EVALUATED` rather than as `NoChange` | It needs a real repo of Azure Bicep or ARM templates to validate that refusal against, and we have not run one |
| A **CloudFormation change-set** reviewer | `Replacement: Conditional` genuinely means unknown, and a reviewer that flattens it to "no replacement" has told the reader something the service did not say | It needs a real CloudFormation tree, and we have not run one |

Naming them here rather than omitting them is the point. Adding a role to a
shipped pack is a smaller change than shipping a new pack, and that is where
they go when someone has the tree to test them on.

`/plan-explain` already accepts both dialects, because reading an export needs
no credential — but see the honest-limits table: those two branches are
**unexercised**. The only dialect this pack has validated against a real file is
Terraform/OpenTofu `show -json`.

## Composition

`iac-plan-review` and **`cloud-posture-review`** are the catalog's two cloud
packs (RFC 0003 §2.4) and are designed to sit side by side. They share the
no-mutation spine and split the work cleanly:

- **This pack reads a plan.** It answers "what does this change do", before the
  change exists, from a file the tool produced.
- **`cloud-posture-review` reads an account.** It answers "what is true right
  now", from live API responses, and its rule is that a check that did not run
  is `NOT-CHECKED` and never PASS.

Nothing collides. That pack's roles are `posture-scanner` and
`iam-least-privilege-analyst`, its skill is `/exposure-check`, and its pipeline
is `posture-review`. This pack's role is `terraform-plan-reviewer`, its skills
are `/plan-explain` and `/drift-report`, and its pipeline is
`iac-change-review`. None of those five names appears in `enterprise-org`'s
eleven roles (`pm`, `architect`, `tech-lead`, `developer`, `qa-functional`,
`qa-adversarial`, `security-reviewer`, `ux-reviewer`, `docs-writer`,
`release-manager`, `retro`), in `design-review-org`'s five (`design-author`,
`codebase-critic`, `invariant-oracle`, `impact-analyst`, `design-lead`), in
`complexity-guard`'s three, or among the skill names shipped by
`starter-skills`, `plan-pressure-tests`, `design-docs` and
`mobile-ground-truth`. Install them all side by side and nothing shadows
anything: a name collision resolves silently to the later root, and a warning is
not a design.

`iac-change-review` names no role from another package, and that is structural
rather than stylistic: `@role` resolves against the loaded agents **before** the
pipeline's first step runs, so a cross-pack reference would fail the whole run at
load for anyone who installed one pack and not the other.

Where the packs meet in practice:

- Run `iac-change-review` on the change and `posture-review` on the account, and
  where the plan and the live account disagree you have drift — which is
  `/drift-report`'s input, and which `/exposure-check` reports as drift rather
  than picking a side.
- **`design-review-org`**'s `invariant-oracle` proves a check bites by planting a
  violation; this pack does the same to itself in
  `validation/fixtures/local-stack/modules/greeting/README.md`, and watches the
  deny-list check fail on a mutated copy before trusting it to pass.
- **`enterprise-org`**'s `security-reviewer` reviews application code; this pack
  reviews the plan that provisions what it runs on. Neither reads the other's
  artifact.

## Validating your copy

Everything in `validation/` was really run, on 2026-08-24, and
`validation/TRANSCRIPTS.md` holds the verbatim output and every exit code:

| Fixture | What it is | What it establishes |
|---|---|---|
| `fixtures/local-stack/` | A stack of `null_resource`, `local_file` and `random_pet` — no cloud provider, no credential, no backend | `tofu init`, `plan -out` and `show -json` all really ran (exit 0), producing `fixtures/plan.json` |
| `fixtures/plan.json` | The real plan JSON, `format_version 1.2`, `terraform_version 1.12.6`, 5 resource changes | `/plan-explain`'s contract checked by hand: all five addresses exist in `resource_changes[].address`, the fields it reads are present, and the counts sum to `len(resource_changes)` |
| `fixtures/broken-stack/` | A module source that does not exist | `tofu init` and `tofu plan` both exit `1` for real — the `PLAN-UNAVAILABLE` refusal has a trigger that fires |
| `fixtures/local-stack/modules/greeting/README.md` | A real prompt-injection instruction planted in a module the stack actually uses | The §5.6 planted-instruction fixture. The deny list is extracted from the agent file and the planted command recovered by grep; all 10 denied commands match, all 7 read-only commands pass, and the check exits `1` on a mutated deny list |

```bash
arcturn inspect ./examples/iac-plan-review
npx vitest run web/scripts/hub.test.ts
```

`arcturn inspect` prints zero warnings, the exec lane derived from `tools:`,
`5 stages, 5 steps, $18`, both skills, and `No extensions: this package ships no
executable code.` The registry entry at `registry/iac-plan-review.json` carries
`"executable": false`, and the suite checks that claim against the absence of an
`extensions/` directory rather than taking the entry's word for it.

The pack ships no `.sh` file for the deny-list check for that reason: its source
is reproduced in `validation/TRANSCRIPTS.md` §11, to be saved outside the pack
and run.

## Honest limits — where this pack's guarantee stops

| Limit | Why it is there | What actually holds |
|---|---|---|
| **These files instruct a model; they do not constrain it.** Every `Never` list and the whole deny list are prompt text | A role file is markdown. Nothing validates that a role obeyed its own refusal, really ran the command it pasted, or did not run one it said it would not | The lane derived from `tools:`, applied by the dispatcher before the role's first token, and the [permission engine](https://arcturn.dev/docs/permissions), which does not read prompts at all. **The real boundaries are the lane derivation and the permission engine; the text is a hope until one of those enforces it** |
| **The exec lane protects your checkout, not your cloud account** — and this is the widest version of that gap in the catalog | The lane guarantees the role's diff never reaches your tree. It says nothing about an API call, and a provider talks to the same account from inside a discarded worktree as from anywhere else. A refresh writes to remote state | The read-only principal in [NO-APPLY-CONTRACT §2](#2-the-read-only-credential-contract). That is the boundary. `config.sandbox` and the permission engine are where a command-level constraint is expressible somewhere it is enforced |
| **`ORG-ASK` is not a permission boundary** | It pauses a *run* at a resumable cut point. Answering it does not un-delete an S3 bucket, and declining to answer does not roll anything back | Nothing in this pack can delete a bucket, because no step holds the authority — the deny list plus a `tools:` line with no writer. The ask is a question at the end of a review, not a gate on an action |
| **`{{prev}}` is unfenced** | A whole previous stage is spliced verbatim into the next prompt — including plan JSON, provider output and whatever a module README said | "No role here holds a writer" is a claim about **capability**, never about content. `taint.ts` and `canary.ts` exist in this tree with integration notes and are not wired into `runtime.ts`; until they are, the content half is not claimable and this README does not claim it |
| **The deny list has been checked as text, not watched firing in a live run** | `validation/TRANSCRIPTS.md` §4 proves every token matches the commands it claims to refuse, including the planted one, and §4.3 proves the check itself bites. It does not prove a model refuses | RFC 0003 §5.6 is not satisfied until a reviewer has watched a live run meet the planted instruction and refuse it. That run is the harness operator's, and until it has fired this pack's own standard calls the refusal an `UNPROVEN CHECK` |
| **The validation ran with no cloud credential at all** | `aws` and `az` are not installed on the validating machine; both probes exit `127` | Only the `PRINCIPAL: UNDETERMINED` branch has fired. A printed authenticated principal, an enumerated cloud scope, a real remote backend, a real state lock and a real audit-log record are all listed as unexercised-pending-credential in `TRANSCRIPTS.md` §10, one row each |
| **No replacement has been read from a real plan** | The fixture stack has no prior state, so its plan is five creates: `change.replace_paths`, `action_reason` and `resource_drift[]` are absent from every element | The replacement and drift paths are specified and unexercised. `TRANSCRIPTS.md` §2 says so per field rather than implying coverage |
| **`/plan-explain`'s Azure and CloudFormation branches are unexercised** | No file of either dialect was available; producing one needs a real repo of that dialect | The same reason the sibling reviewers ship unshipped. The only dialect validated against a real file is Terraform/OpenTofu `show -json` |
| **A plan describes the state as it was when it ran** | Between plan and apply, state drifts, a provider version moves, another pipeline runs. A plan JSON is a claim about a moment | Both skills close by bounding the claim to the file and the moment, and `/drift-report` exists because the gap is real. Neither can detect a change made after the file was written |
| **`unknown` is frequent, and that is the honest output** | Whether a resource holds data is a judgment with no oracle in the plan file. The pack's answer is a third value rather than a confident guess | A run with many `unknown` rows is a correct run, not a failed one. The count is printed at the top precisely so it cannot be skimmed past |
| **A policy scanner's absence is reported, not compensated for** | Stage 4 writes "not available in this repo" for every tool that is not installed. It does not substitute its own judgment for the missing scanner | On the validating machine six of seven tools were absent, each with a real `command -v` exit code. Install the scanners you want covered; the pack will not pretend to be them |
| **Budgets and step timeouts are ceilings, not measurements** | `budgetUsd: 18` is set to catch a runaway loop, and 1,800,000 ms is the catalog floor for a pipeline that runs `init`. Neither number was measured against a real run | Run the pipeline once, read the real spend off `/workflow status`, and set your own |
| **No frontmatter in this pack pretends to be enforcement** | `agents.ts` parses exactly `name`, `description`, `tools`, `model` and `maxTurns`. `writes:`, `reads:`, `consumes:`, `produces:` and per-role `budget:` are parsed by nothing, and `multiedit` is in the engine's `WRITE_TOOLS` but absent from `BUILT_IN_TOOL_NAMES`, so declaring it advertises authority the role never receives | The role file declares only the five keys that are read. There is no field in this pack that looks like a boundary and is not |
| **A listing is not an audit** | The hub entry's disclosure block is re-derived from these files by `web/scripts/hub.test.ts`, so it cannot drift from the tree. That checks that the page and the install agree — nothing more | Run `arcturn inspect` against the source you are about to install, and trust that over any page |

Two limits are not going away, and should not:

**No step in this pack decides anything.** `VERDICT: ADVISORY` is the only
verdict value in it, there is no `APPROVED` anywhere, and the pipeline ends in a
question naming exactly what becomes irreversible. Nothing here applies,
destroys, imports, unlocks or merges.

**No model judgment is a blocking claim.** Only a command with its real exit
code, a field a reader can open in the plan file, or a rule id quoted from real
tool output is allowed to rank first. Everything else is labelled as a reading —
including the readings these files write about their own results.

## Editing the pack

Rules the parsers enforce, which are easy to trip over:

A step is exactly one line, with no continuations. Stages are numbered
consecutively from 1, and parallel branches are indented `-` bullets (`*` and
`+` are rejected). A numbered line carrying both a prompt and branches must end
with `:` to be read as a label. Only `{{input}}`, `{{prev}}` and `{{journal}}`
exist; a typo is a parse error, and `{{prev}}` or `{{journal}}` in stage 1 is an
error too. In the documentation header above the steps, avoid starting a line
with a bullet character or with a digit followed by `.` or `)` — the scanner
reads either as a new step.

`@role` comes right after an optional `[model]` tag, never before it, and the
role name must be lowercase. A step naming a role with no matching file in
`agents/` fails the whole run before stage 1 spends a token.

The role declares `tools:` explicitly and yours must too: an omitted list is
refused at dispatch rather than defaulting to the read lane — it used to mean
"everything the session allows", which is the widest grant in the system.

If you change `terraform-plan-reviewer`'s tools, check what you did to its lane
before you commit it. Adding `write` or `edit` moves it to the write lane and
its diff starts reaching your checkout; dropping `bash` moves it to read and it
can no longer produce a plan at all, which turns the pack's central refusal into
its only behaviour.

If you edit the deny list, re-run the check in `validation/TRANSCRIPTS.md` §11
against the planted fixture, and mutate it once to watch it fail before you
trust it to pass.

Docs: [Markdown agents](https://arcturn.dev/docs/agents) ·
[Workflows](https://arcturn.dev/docs/workflows) ·
[Markdown skills](https://arcturn.dev/docs/skills) ·
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
