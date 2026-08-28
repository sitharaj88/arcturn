# cloud-posture-review

Two agent roles, one pipeline and one slash command for read-only cloud posture
and IAM review, where a check that could not run is `NOT-CHECKED` with its
reason rather than a `PASS`, and every artifact carries the count of checks that
did not run beside the count that did.

Nothing in this pack mutates infrastructure — not gated, out of scope, and for a
mechanical reason rather than a squeamish one: an `ORG-ASK` pauses a *run*, it is
not a permission boundary, and nothing about answering a paused workflow
un-deletes a bucket.

---

## Install

```bash
arcturn add sitharaj88/arcturn/kits/cloud-posture-review
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`kits/cloud-posture-review` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links two roles into `~/.arcturn/agents/`, one
pipeline into `~/.arcturn/workflows/` and one skill into `~/.arcturn/skills/`.

To read what an install would add before running it:

```bash
arcturn inspect sitharaj88/arcturn/kits/cloud-posture-review
```

From a clone, the local-path form installs your edited copy — which is also the
loop for forking any of these files:

```bash
arcturn add ./kits/cloud-posture-review
arcturn remove cloud-posture-review
```

Then `/exposure-check` is available in your session, `/workflow list` shows the
pipeline, and `/team --roles posture-scanner` resolves a role as a team
specialist.

## Before you run anything: READ-ONLY-PRINCIPAL

This is the pack's spine. Both roles reference this section by name, and the
pipeline halts at stage 1 rather than running without it.

**The credential you hand this pack is its only real boundary.** Everything else
in this README is a description of prompt text. The exec lane guarantees that a
role's diff never reaches your checkout; it guarantees nothing whatsoever about
an API call, because there is no lane in this engine between a role's `bash` and
a cloud control plane. So the boundary has to live where it can be enforced, and
that is in the permissions attached to the credential — enforced by the cloud
provider, which does not read prompts either.

### The credential contract, per cloud

| Cloud | Grant | Notes |
|---|---|---|
| **AWS** | `SecurityAudit` + `ViewOnlyAccess`, plus IAM Access Analyzer read permissions (`access-analyzer:List*`, `access-analyzer:Get*`) | `SecurityAudit` covers configuration reads; `ViewOnlyAccess` covers the enumeration the scope ledger needs. Access Analyzer reads are what `iam-least-privilege-analyst` needs for generated-policy and external-access findings. Add `iam:GenerateServiceLastAccessedDetails` and `iam:GetServiceLastAccessedDetails` if you want last-accessed evidence. |
| **Azure** | `Reader` + `Security Reader` | `Reader` at the scope you want enumerated — management group, subscription or resource group. `Security Reader` adds Defender for Cloud assessments and recommendations. |
| **GCP** | `roles/viewer` + `roles/iam.securityReviewer` | `roles/viewer` for resource enumeration; `roles/iam.securityReviewer` for IAM policy reads across the scope. Add `roles/recommender.iamViewer` for IAM recommender output. |

### The commands each role prints

Every artifact this pack produces opens with a `## Principal` block: the
disclosure command for the cloud in scope, and its real output, with credentials
redacted. Not a description of the principal — the command and what it printed.

```
AWS     aws sts get-caller-identity
Azure   az account show
GCP     gcloud auth list
        gcloud config get-value project
```

If that command fails, the run has no principal, every check afterwards is
unattributable, and stage 1 emits `ORG-HALT` instead of continuing. A posture
report with an unknown denominator is worse than no posture report, because it
is signable.

The scope enumeration is printed the same way and to the same standard: the
accounts, subscriptions or projects, the regions inside each, and the command
that enumerated them. A region list you assumed rather than retrieved is marked
assumed, by name. **An unenumerated scope is not an empty scope**, and a region
nobody listed is `NOT-CHECKED: region not enumerated`, never a clean row.

### Why this credential must be separate from anything that can deploy

Give this pack its own principal, in its own role or service account, with no
path to a deploying identity. Three reasons, none of them about trusting the
model:

**The blast radii are different.** A posture review reads broadly — every
service, every region, every account. A deploy credential writes narrowly but
destructively. A credential that does both has the union of two attack surfaces
and the intersection of neither's constraints, and the review is the half you
point at everything.

**`{{prev}}` is unfenced, and this pipeline reads attacker-adjacent text.**
Resource tags, policy descriptions, bucket object names, module READMEs and
scanner output all flow into a later stage's prompt verbatim. This pack ships a
planted instance of exactly that — `validation/fixtures/misconfig-stack/README.md`
contains a runbook instructing its reader to remediate and apply. The refusal in
the roles' `Never` lists is prompt text; the credential that cannot apply
anything is not.

**A read-only principal is auditable in a way a prompt is not.** You can point
at the policy attached to it and say what it can do. You cannot point at a role
file and say the same, and this README will not pretend otherwise.

## The pipeline

```
/workflow posture-review  <the accounts, subscriptions or projects and the regions
                           you want reviewed, and the credential profile to use>
```

| Pipeline | Stages | What it does | What it refuses to do |
|---|---|---|---|
| `posture-review` | 5 stages (6 steps), `budgetUsd: 20`, `stepTimeoutMs: 2700000` | Establishes the principal and enumerates the scope, runs the configuration surface and the identity surface in parallel, turns observed access data into proposed narrowings, audits coverage, and hands a person a packet whose denominator is visible. | Proceed without a scope. Stage 1 `ORG-HALT`s when the disclosure command fails or the scope cannot be enumerated, and a fatal halt short-circuits every later stage. It refuses to summarise coverage from a previous stage's own count — stage 4 re-derives the denominator from the raw tool output. And no step in it holds authority to remediate, apply, deploy, tag, publish or push: not gated, absent. |

**Stage 4 is a coverage audit, and it is the stage this genre skips.** It does
not rank findings. It reconstructs the intended denominator from stage 1's
enumeration and from each tool's own report of what it scanned, and prints what
did *not* get checked, in which scope and region, and why — with the one thing
that would settle each gap. Every post-incident review needs that page and
almost no posture report contains it.

**The 45-minute step ceiling is load-bearing, not generous.** `stepTimeoutMs:
2700000` sits against a 10-minute default (`DEFAULT_WORKFLOW_STEP_TIMEOUT_MS`,
`packages/cli/src/workflow.ts`). A multi-region scan is exactly the step the
default cuts off mid-flight, and **a scan aborted mid-flight is the exact input
that produces a false PASS**: the regions it reached had not returned yet, the
regions it never reached returned nothing at all, and on a page those two are
the same blank. The roles are required to report a killed scan as
`NOT-CHECKED: scan aborted`; not killing it is the cheaper fix.

## The command

| Command | What it does | What it refuses to do |
|---|---|---|
| `/exposure-check` | Works out whether the resources you name are reachable from the internet, hop by hop — address, network path, resource policy, trust, service front door, DNS and CDN — with the read-only call that established each hop and its state as `PERMITS`, `BLOCKS` or `UNKNOWN`. | Conclude "not exposed". The verdict is "no public exposure found by the N checks listed below, in these regions, as this principal", with the count that did not run beside it. It refuses to fold a denied call into a negative — an `AccessDenied` on `s3:GetBucketPolicyStatus` is a row in the denial table meaning **unknown**, not private. It refuses to infer exposure from an IaC file, and where a file and the live API disagree it reports both as drift and picks neither. It will not probe: no `curl` at a suspected endpoint, no port scan, no DNS-resolve-then-connect. |

## The roles

| Role | Produces | Tier | Tools | Lane (derived) | The one thing it must never do |
|---|---|---|---|---|---|
| `posture-scanner` | `POSTURE-LEDGER` | sonnet | `read, grep, glob, ls, bash` | **exec** | Report a check that did not run as anything other than `NOT-CHECKED` with its reason. Permission denied, service not enabled, region not enumerated, tool absent, scan aborted — each is a named row with its verbatim evidence, never a `PASS` and never omitted. It also never writes a check id, control number, CVE or CVSS it did not read from real tool output this session |
| `iam-least-privilege-analyst` | `IAM-NARROWING-PROPOSAL` | sonnet | `read, grep, glob, ls, bash` | **exec** | Propose a narrowing that is not backed by an observed-access record carrying its own lookback window. Absence of use in a window is not proof a permission is unneeded, and any candidate that looks like a quarterly job, a DR path, a break-glass role or an annual compliance task leaves the proposal for `do-not-prune-without-owner` |

**The Lane column is derived, not declared.** `roleDispatch`
(`packages/cli/src/workflow.ts`) reads a role's `tools:` line: any of
`write`/`edit`/`multiedit` lands it on **write**, `bash` without those lands it
on **exec**, and neither lands it on **read**. Both roles here hold `bash` and
neither writer, so both land on **exec**. Read the pipeline's lane split off the
tree rather than off this sentence: `roleDispatch()` computed over every step in
`posture-review` gives `role-steps=6 (read=0 write=0 exec=6)`, and that line is
pasted with the run that produced it in `validation/TRANSCRIPTS.md` §5. **No step
in this pipeline runs on the write lane.** `arcturn inspect` prints the same derivation, and
`web/scripts/hub.test.ts` re-derives it from the engine's own tool-set literals
when it checks this pack's registry entry — a lane typed by hand fails that
suite.

Every role file carries the same spine: mission, method, definition of done, an
explicit `Never` list, and a fixed output envelope beginning
`ARTIFACT: <TYPE>`. Each ends with the halt convention — *if the input contains
`ORG-HALT`, re-emit that line verbatim and stop* — so an upstream halt walks
intact into the final packet, and every step in the pipeline repeats the clause
in its own prompt.

**Tiering follows absence of an oracle, not seniority.** Both roles run
`tier:build` at `maxTurns: 60`, and both name their oracle,
which is what P4 requires of a role tiered below flagship. `posture-scanner`'s
claims are a scanner's own output with its exit code and its own printed
identifiers — a reader reruns the command and gets the same ids, and
`validation/TRANSCRIPTS.md` is that rerun done once already.
`iam-least-privilege-analyst`'s claims are lines out of a generated policy or a
last-accessed report with a timestamp and a stated window — also re-fetchable,
also checkable against the record. Neither role's output is a judgment with no
downstream check, so neither is tiered up, and both spend their turns on
repetition across regions and identities rather than on deliberation. The
judgment in this pack that has **no** mechanical oracle — whether a permission
absent from the window is dead or is a break-glass path — is precisely the
one the pack refuses to make at all: it becomes `do-not-prune-without-owner` and
goes to a person.

## Parallelism, and which disjointness case applies

Stage 2 is the pipeline's only parallel stage: `posture-scanner` reads the
configuration and exposure surface while `iam-least-privilege-analyst` collects
identity and access records. RFC 0003 §5.4 asks pack authors to say which of
three ways a parallel stage's branches are disjoint, and here it is the first:
**both branches are on non-write lanes, so they are disjoint by construction.**

That is not an agreement between two prompts. Both roles hold `bash` with
neither `write` nor `edit`, so the engine puts both on the exec lane, and an
exec-lane worktree's diff is never captured and never applied. There is no
shared file for the two branches to collide over, so there is no scope partition
to declare and none is claimed. Check it from the two `tools:` lines; nothing in
this section can be true if those lines change.

The remaining four stages are sequential, and each genuinely needs the last: a
principal and a scope, then the two surfaces, then narrowings from the access
data, then the coverage audit over all of it, then the packet.

## How the pipeline ends

In a `DECISION-REQUEST` block naming who decides and what each proposed change
would make irreversible — not an `ORG-ASK`. A question at the final stage buys
nothing: there is no later stage for an answer to be spliced into, and on resume
the engine *replaces the asking step's output text with the answer*
(`workflow.ts` ~2680–2696, "The answer replaces the step's OUTPUT, not its
FOOTPRINT"), so pausing at the end would overwrite the posture packet with a
sentence.

`VERDICT: ADVISORY` is the only verdict value in the pack. There is no
`APPROVED` anywhere in it — `grep -rn 'APPROVED' agents skills workflows
arcturn.json` exits `1`, and that check is in `validation/TRANSCRIPTS.md` §5. Nothing here clears,
authorises, remediates or applies anything.

## Composition

`iac-plan-review` is this pack's sibling in wave 3 and the two are designed to
sit side by side. Its role is `terraform-plan-reviewer`, its skills are
`/plan-explain` and `/drift-report`, and its pipeline is `iac-change-review`.
None of those collides with `posture-scanner`,
`iam-least-privilege-analyst`, `/exposure-check` or `posture-review`, and
nothing in either pack references a role from the other — `@role` resolves
against the loaded agents **before** a pipeline's first step runs, so a
cross-pack reference would fail the whole run at load for anyone who installed
one pack and not the other.

The two packs divide the domain along the line that matters here: **`iac-plan-review`
reads intent, this pack reads the world.** A plan says what Terraform believes
will happen; an API says what is actually configured right now. `/exposure-check`
refuses to answer from HCL for exactly that reason, and where a file and an API
disagree it reports the disagreement as drift rather than choosing — which is
also why `/drift-report` lives in the other pack and this one does not duplicate
it. They share the no-mutation spine from RFC 0003 §2.4 and state it in the same
words; `iac-plan-review` states its half as `NO-APPLY-CONTRACT`, this one states
its half as `READ-ONLY-PRINCIPAL` above.

These names collide with nothing else in the catalog either. Not with
`enterprise-org`'s eleven roles (`pm`, `architect`, `tech-lead`, `developer`,
`qa-functional`, `qa-adversarial`, `security-reviewer`, `ux-reviewer`,
`docs-writer`, `release-manager`, `retro`), not with `design-review-org`'s five
(`design-author`, `codebase-critic`, `invariant-oracle`, `impact-analyst`,
`design-lead`), not with `complexity-guard`'s three (`complexity-reviewer`,
`optimizer`, `perf-analyst`). `posture-review` collides with none of the ten
other pipeline names in the catalog, and `/exposure-check` with none of the
fourteen other skill names across `starter-skills`, `plan-pressure-tests`,
`mobile-ground-truth`, `design-docs`, `complexity-guard` and `iac-plan-review`.
Install them all side by side and nothing shadows anything: a name collision
resolves silently to the later root, and a warning is not a design.

Where the other kits meet this one:

**`enterprise-org`**'s `security-reviewer` reviews code and a threat model; this
pack reviews a running account. Neither reads the other's evidence, and the one
place they should meet is a person holding both.

**`complexity-guard`**'s discipline is the same one in a different domain: a
growth class is only named when the measurements exclude every other, and here a
check is only `PASS` when it ran. `NOT-SEPARABLE-AT-THESE-SIZES` and
`NOT-CHECKED` are the same refusal wearing different words.

**`plan-pressure-tests`**' `/feasibility-read` ends by naming the one spike worth
running. A `posture-review` over a single account is frequently that spike, and
its coverage audit is what tells you whether the spike answered anything.

## Shipped honestly incomplete

Three things a full version of this pack would have, named here rather than
omitted:

**No CSPM tool is bundled or assumed.** The pack runs whatever you have and
reports the rest as `NOT-CHECKED: tool absent`. It does not ship a check
catalogue of its own, because a check list nobody has run against a real account
is exactly the fabricated coverage the pack exists to prevent. On the machine
this pack was validated on, `checkov`, `prowler`, `tfsec`, `aws`, `az` and
`terraform` are all absent — and that transcript is in
`validation/TRANSCRIPTS.md` §2 as the fixture rather than as an apology.

**The IAM half has never met a real last-accessed report.** The
`WINDOW-UNSTATED` rule, the `do-not-prune-without-owner` flag and the
service-level-versus-action-level distinction are all written and none has been
exercised against live access data, because that needs a credential this
validation did not use. `validation/TRANSCRIPTS.md` lists each as
unexercised-pending-credential.

**No Kubernetes, no SaaS posture, no data-classification surface.** The roles
speak the three hyperscalers' control planes. A cluster's RBAC, an identity
provider's app grants and a data store's classification are three more surfaces
with three more oracles, and adding a role to a shipped pack is a smaller change
than a new pack.

## Honest limits — where this kit's guarantee stops

| Limit | Why it is there | What actually holds |
|---|---|---|
| **These role files instruct a model; they do not constrain it.** Every `Never` list in this pack is prompt text | A role file is markdown. Nothing validates that a role obeyed its own refusal, really ran the command it pasted, or reported the check it skipped | The lane derived from `tools:`, which the dispatcher applies before the role's first token, and the [permission engine](https://arcturn.dev/docs/permissions), which does not read prompts at all — plus, for this pack specifically, the read-only principal in `READ-ONLY-PRINCIPAL` above |
| **The exec lane protects your checkout, not the world** — and a cloud pack is where that gap is widest in the whole catalog | It guarantees both roles' diffs never reach your tree. It says nothing about an API call. A shell that cannot write a file can still call a control plane, and no lane sits between the two | The credential. That is the entire answer, it is why `READ-ONLY-PRINCIPAL` is the first section a reader hits, and it is why this pack asks for a principal separate from anything that can deploy |
| **`ORG-ASK` is not a permission boundary** | It pauses a *run* at a resumable cut point. Nothing about answering a paused workflow un-deletes a bucket, and a mutation already issued has already landed | This pipeline contains no mutating step to gate. Not gated — absent. The authority is not withheld by a prompt; no step in it holds the authority in the first place |
| **`{{prev}}` is unfenced, and this pipeline's inputs are attacker-adjacent** | A whole previous stage is spliced verbatim into the next prompt — including resource tags, policy descriptions, object names, module READMEs and scanner output, none of which your organisation necessarily wrote | "Neither role holds a writer" is a claim about **capability**, never about content. `taint.ts` and `canary.ts` exist in this tree with integration notes and are not wired into `runtime.ts`; until they are, the content half of that invariant is not claimable and this README does not claim it. The credential is what holds |
| **A `NOT-CHECKED` count is only as honest as the denominator** | The scanner reports what it set out to check. A check it never conceived of is not in either column — an unknown unknown does not become a `NOT-CHECKED` row by being unknown | Stage 4 re-derives the denominator from stage 1's enumeration and from each tool's own report of what it scanned, rather than from a previous stage's self-count. That closes the gap between enumerated-and-not-checked and never-enumerated. It does not close the gap between the tools' check catalogues and everything that could be wrong, and nothing in this pack does |
| **An exit code is not a finding count, in either direction** | Measured, not asserted: `trivy config` over this pack's own fixture returns 19 failures at exit `0`, and over a scope whose only Terraform file sits in a mode-`000` directory it returns `Detected config files num=0` at exit `0` even with `--exit-code 1` set. A failed check and a clean check produced the same exit status and nearly the same table | The roles read each tool's own report of what it scanned and compare the target count against the enumerated scope. Both transcripts are in `validation/TRANSCRIPTS.md` §1 and §3, with their exit codes |
| **Absence of use is not absence of need, and this pack cannot resolve the difference** | Quarterly jobs, DR paths, break-glass roles and annual compliance tasks all show zero use inside any observable window. A role with *zero* use across the whole window is the one most likely to be break-glass | The candidate leaves the proposal and becomes `do-not-prune-without-owner` with the trigger that matched and the search that found it. That is a refusal to answer, handed to a person, not a lower-confidence answer |
| **A posture snapshot is one principal, at one moment, in the regions it enumerated** | A resource created a minute later, a policy changed by a console session, a region nobody listed, a service linked role in an account outside the scope — none of them is in the artifact, and none of their absence is a finding | Every artifact prints the principal, the enumerated scope, the regions and the timestamp, and closes with a sentence bounding the claim to exactly those. Re-run it; do not reuse last quarter's |
| **Budgets and step timeouts are ceilings, not measurements** | `budgetUsd: 20` is set to catch a runaway loop, not derived from a real run. The 45-minute step ceiling is load-bearing rather than generous, for the false-PASS reason above | Run the pipeline once against your own scope, read the real spend off `/workflow status`, and set your own. An organisation with many accounts will need both raised |
| **No frontmatter in this pack pretends to be enforcement** | `agents.ts` parses exactly `name`, `description`, `tools`, `model` and `maxTurns`. `writes:`, `reads:`, `consumes:`, `produces:` and per-role `budget:` are parsed by nothing, and `multiedit` is in the engine's `WRITE_TOOLS` but absent from `BUILT_IN_TOOL_NAMES`, so declaring it advertises authority the role never receives | Both role files declare only the five keys that are read, so there is no field in this pack that looks like a boundary and is not |
| **A listing is not an audit** | The hub entry's disclosure block is re-derived from these files by `web/scripts/hub.test.ts`, so it cannot drift. That checks that the page and the install agree — nothing more | Run `arcturn inspect` against the source you are about to install, and trust that over any page |
| **The refusals in this pack have been checked as text, not watched firing** | `validation/deny-list-check.md` proves every mutation the planted fixture asks for is named in both `Never` sections. It proves nothing about whether a model obeys them | RFC 0003 §5.6 calls a refusal nobody has watched fire an `UNPROVEN CHECK`. `validation/TRANSCRIPTS.md` ends with a clause-by-clause table of what is exercised and what is unexercised-pending-credential, and this pack holds itself to the standard it holds its own output to |

Two limits are not going away, and should not:

**No step in this kit decides anything.** Stage 5 ends in a `DECISION-REQUEST`
naming who decides and what becomes irreversible. Nothing here remediates,
applies, deploys, tags, publishes or pushes, and there is no verdict value in
the pack other than `ADVISORY`.

**No model judgment is a blocking claim.** Only an identifier a tool printed
with the command that printed it, or a record with its stated lookback window,
is allowed to rank. Everything else is labelled as a reading — including the
readings these roles write about their own results.

## Validating your copy

Every file in this directory parses through the parsers the runtime itself uses,
and this pack ships the proof rather than the claim. `validation/TRANSCRIPTS.md`
carries every command run against this tree with its verbatim output and exit
code: the loader round-trip, `arcturn inspect`, a real scanner run producing 19
real check ids, six real `command not found` transcripts standing in for
`NOT-CHECKED: tool absent`, a real scan failure that returns exit `0`, and the
deny-list check that found a gap on its first run.

To re-run the round-trip yourself:

```bash
node packages/cli/dist/main.js inspect ./kits/cloud-posture-review
```

Expected, and pasted verbatim in `validation/TRANSCRIPTS.md` §5: two roles on the
exec lane, `posture-review` at 5 stages and `$20`, one skill, zero warnings, and
`No extensions: this package ships no executable code.` The registry entry at
`registry/cloud-posture-review.json` carries `"executable": false`, and
`npx vitest run web/scripts/hub.test.ts` checks that claim against the absence of
an `extensions/` directory rather than taking the entry's word for it.

**The validation directory ships no executable file.** RFC 0003 §5.2 verifies
`executable: false` by grepping the pack for any `.js`, `.ts`, `.sh` or `.py`,
skill folders included — so the deny-list check lives in `deny-list-check.md` as
a command you copy rather than as a script the grep would find. The fixtures are
Terraform and markdown, and `validation/fixtures/misconfig-stack/` is never
initialised, planned or applied by anything in this pack: it references the AWS
provider and exists purely to be read statically.

## Editing the kit

Rules the parsers enforce, which are easy to trip over:

A step is exactly one line, with no continuations. Stages are numbered
consecutively from 1, and parallel branches are indented `-` bullets (`*` and
`+` are rejected). A numbered line carrying both a prompt and branches must end
with `:` to be read as a label — stage 2 in `posture-review` is that shape. Only
`{{input}}`, `{{prev}}` and `{{journal}}` exist; a typo is a parse error, and
`{{prev}}` or `{{journal}}` in stage 1 is an error too. In the documentation
header above the steps, avoid starting a line with a bullet character or with a
digit followed by `.` or `)` — the scanner reads either as a new step.

`@role` comes right after an optional `[model]` tag, never before it, and the
role name must be lowercase. A step naming a role with no matching file in
`agents/` fails the whole run before stage 1 spends a token, exactly like an
unknown model tag.

Both roles declare `tools:` explicitly, and yours must too: an omitted list is
refused at dispatch rather than defaulting to the read lane — it used to mean
"everything the session allows", which is the widest grant in the system. If you
add a role, re-run `arcturn inspect` and confirm it reports no warnings; a
dropped tool name is a warning rather than an error, and `multiedit` is the one
this catalog trips on.

If you add `write` or `edit` to either role, you have moved it to the write lane
and the pipeline's one derived guarantee — that no step here can change your
checkout — is gone. Nothing in the prompt text will tell you; `arcturn inspect`
will.

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
