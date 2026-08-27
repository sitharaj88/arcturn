# RFC 0003 — The hub catalog

**Status:** Draft · **Author:** Sitharaj Seenivasan · **Date:** 2026-08-24
**Depends on:** RFC 0002 (the ecosystem, the asset taxonomy, disclosure before trust)

RFC 0002 built the shelf. This RFC decides what goes on it.

Five domain surveys — planning and research, mobile, cloud, data structures
and algorithms, software architecture — came back with thirteen candidate
packs and roughly a hundred candidate assets. This document cuts that to
**seven packs and thirty-two assets** across three build waves, states the
law each surviving asset was held to, and records every rejection with its
reasoning. The rejected list is longer than the catalog. That is the point:
the catalog's value is what is not in it.

The two packs that already exist — `starter-skills` (three skills) and
`enterprise-org` (eleven roles, six pipelines) — are the bar, not the
baseline. Everything below is measured against them.

---

## 1. The catalog thesis

The community agent-asset scene has converged on volume as the product:
"771 professional skills across 35 professions", "160+ DevOps skills",
"46 skills / 27 agents / 35 commands" for mobile alone. Snyk's ToxicSkills
scan of 3,984 published skills found 13.4% carrying a critical-level issue
and prompt injection in 36% of them. Volume is not a moat; it is a liability
someone else has already taken on.

Arcturn's advantage is that it has **lanes**. A role's authority is computed
from its declared `tools:` by `roleDispatch` (`packages/cli/src/workflow.ts`:
`WRITE_TOOLS = {write, edit, multiedit}` → write; else `bash` → exec; else
read), the same function the hub's own test suite re-parses out of the engine
source. No other harness can make a structural claim about a markdown file.
Every principle below exists to convert that advantage into content.

A future pack author can be held to these six.

### P1 — The refusal is the asset

The unit that earns an asset is a refusal, not a capability. An asset must be
able to complete its stated job and *decline to answer* under a named
condition, and the file must say which condition and what it writes instead.
`commit-message` will not invent a scope; it writes `fix:` with no scope.
`pr-description` will not fake a How-verified section; it writes "Not verified
in this session" and lists the commands. That shape — *the refusal names its
substitute* — is the test.

The corollary is the quality law's sharp edge: **an asset that generates
content on demand and cannot refuse anything is not an asset.** This kills
tutorial skills (`jetpack-compose`, `api-design-patterns`, `coroutines-patterns`),
role personas whose authority is a job title, and every "expert consultant"
chatmode. A careful senior deletes those in week two, and week two is the
horizon this catalog is designed for.

A pack of four assets with four different refusals beats a pack of twenty
with one.

### P2 — Authority comes from `tools:`, and a withheld tool is the guarantee

A guarantee stated in a prompt is a hope. A guarantee derived from `tools:` is
printed by `arcturn inspect`, re-derived by `web/scripts/hub.test.ts`, and
enforced by the dispatcher before the role's first token.

Pack authors must reason in the withheld direction, not the granted one:

- A reviewer that must *run* something and must not *change* anything gets
  `bash` with none of `write`/`edit` — the exec lane, whose diff is never
  captured and whose `ARCTURN-PATCH: status=discarded` trailer the engine mints
  itself from a record the role's own text cannot forge.
- A role that must *write a document* and must never *narrate a command it
  claims to have run* gets `write` and **no `bash`**. Any transcript in its
  output is then unbacked by construction. This is the strongest single move
  in the whole catalog and it costs nothing but restraint.
- `fetch` and `websearch` are in neither tool set, so a role holding them
  lands on the read lane — untrusted intake with no worktree and no shell,
  structurally.

Three fields that look like enforcement and are not, and which **no README and
no registry entry in this catalog may describe as boundaries**: `writes:` /
`reads:` / `consumes:` / `produces:` (parsed by nothing — `agents.ts`
recognises only `name`, `description`, `tools`, `model`, `maxTurns`);
per-role `budget:` (wired through the engine, not yet parsed from
frontmatter, so always absent in production); and `multiedit` (in the engine's
`WRITE_TOOLS` but absent from `BUILT_IN_TOOL_NAMES` in `runtime.ts:142`, so
declaring it advertises authority the role never receives — never declare it).
`symbols` is real but LSP-dependent and degrades silently; read-lane roles
declare `search_code` instead, as `enterprise-org` already does.

### P3 — An oracle outranks a judgment, and NOT-CHECKED is a result

Every asset must sort its own output into two bins and keep them visibly
apart: claims backed by something mechanical — a file:line a reader can open,
a command with its real exit code, a scanner rule id, a differ's own change
class, a ratio table — and claims that are model judgment. Only the first bin
may block, rank first, or be called a finding.

The second half of this principle is the one the wild never ships: **a check
that did not run is reported as NOT-CHECKED, never as PASS and never omitted.**
"No findings" and "no coverage" must not look the same on a page a person
signs. An absence claim ships with the search that found nothing. A verdict
the data cannot separate is `NOT-SEPARABLE`, not rounded to the scarier class.
An unpriced resource is `UNPRICED`, not `$0`. An unsymbolicated frame gets no
diagnosis at all.

This is also the answer to the citation problem that dominates any asset with
network access: frontier research agents hold link validity above 94% while
factual support for the cited claim runs 39–77%, and accuracy degrades roughly
42% as search depth scales while the links keep looking fine. A working link is
precisely the artifact that manufactures false confidence. Quote it verbatim
from a page fetched in this session, or mark it `UNSOURCED`.

### P4 — Tier by absence of an oracle, not by seniority

`enterprise-org`'s rule, restated because every new pack gets it backwards on
the first pass. A role graded by exit codes runs cheap and loops (raise
`maxTurns`, lower the tier). A role whose output nothing downstream can check
gets the flagship *and* a human gate. A build runner is the cheapest role in a
mobile pack; a role deciding "are these the real options" is the most
expensive. Seniority in the job title is not a signal.

### P5 — No asset decides; the gate is a boundary the engine enforces

No pack in this catalog contains a step with authority to merge, tag, push,
publish, deploy, submit to a store, apply infrastructure, purchase a
commitment, or mark a decision Accepted — **not because a prompt asks nicely,
but because no step in any pipeline holds that authority.** Advisory artifacts
carry a `VERDICT:` field with exactly one value, `ADVISORY`; there is no
`APPROVED`.

Two engine markers do the gating, and the difference matters. `ORG-HALT:` is
fatal. `ORG-ASK:` pauses the run at a resumable cut point; on resume the
engine continues from the *next* stage with the human's answer spliced in, and
the answer **replaces the asking step's output text** while any patch record it
produced survives (`workflow.ts` ~2680–2696: "The answer replaces the step's
OUTPUT, not its FOOTPRINT"). Both are read off the text by the engine, not by
the downstream prompt, so a role cannot ask a question the next stage ignores.

Design consequence for pack authors: put the ORG-ASK on a **read-lane** role
wherever the choice allows it. A write-lane role that asks leaves its artifact
on disk if you decline to resume; a read-lane role that asks leaves nothing.

And a gate that always pauses is theatre. A team learns to click through it.
Pause when there is a genuine question and let a fact be a fact.

### P6 — Every pack names where its own guarantee stops

The honest-limits table is a required section, not a nicety, and it inherits
`starter-skills`' sentence: *these instruct a model, they do not constrain it.*
Three limits recur across this catalog and each pack that touches them must
state its own:

- **The exec lane protects your checkout, not the world.** It guarantees a
  role's diff never reaches your tree. It says nothing about an API call, and
  nothing about host-global state — simulators, `adb` device state, the Gradle
  daemon, DerivedData, the login keychain, a cloud account. A cloud pack's real
  boundary is the read-only principal you hand it; a mobile pack's is a
  teardown rule it can only promise.
- **`{{prev}}` is unfenced.** It splices a whole previous stage verbatim, so a
  capability invariant ("no role holds both untrusted intake and a mutating
  tool") is a claim about capability, never about content. `taint.ts` and
  `canary.ts` exist in this tree with integration notes and tests and are not
  wired into `runtime.ts`; until they are, no pack may claim the content half.
- **A listing is not an audit,** and third-party disclosure is unverified by
  machine. `registry/README.md` says so; pack READMEs must not imply otherwise.

---

## 2. The catalog

**Seven new packs. Thirty-two installed assets: 16 skills, 11 agent roles,
5 workflows.** With `starter-skills` and `enterprise-org` the registry holds
nine entries. That is the whole catalog, and it is meant to be readable in one
sitting — the same reason `registry/README.md` says two honest entries beat ten
padded ones.

Effort tiers: **S** = pure markdown skills, no reference assets, one afternoon.
**M** = folder skills with `$SKILL_DIR` assets, or three-to-five roles with one
pipeline. **L** = five roles plus two pipelines, or anything needing a real
external toolchain to validate against.

Every pack ships as `kits/<pack-name>/` with an `arcturn.json` manifest
declaring `provides`, and is listed by `registry/<pack-name>.json` whose
disclosure block is derived, never typed.

### 2.1 Planning and research

#### `plan-pressure-tests` — S

*Four slash commands that take a plan somebody already wrote and check it
against reality, each refusing to supply the judgment it cannot ground.*

| Kind | Name | The refusal |
|---|---|---|
| skill | `assumption-audit` | Never marks an assumption SUPPORTED without naming the artifact — a file:line, a command plus its real output, or a URL fetched this session. "Seems reasonable" and "standard practice" are UNTESTED, printed in the same column evidence would occupy. Refuses to propose a test it cannot state as a command or a bounded human action, and reports the drops. |
| skill | `feasibility-read` | Never estimates in hours, days, sprints or story points. A caller who asks for a number gets the ranked unknown list and the one spike that collapses the widest one. Second refusal: never asserts "the codebase does not do X" without printing the grep/glob patterns that found nothing. |
| skill | `rfc-review` | A comment qualifies only if a plausible answer to it would change the design; style, naming and "have you considered §3" are dropped, **and the drop count is reported** so the author can tell filtering from running out of ideas. Never marks a claim CONTRADICTED without a file:line, never HOLDS on the document agreeing with itself. |
| skill | `scope-cut` | Never ranks by value. Orders by dependency and independence read out of the import graph, prints every edge with its evidence, and hands the value ordering back in one sentence. Every proposed cut names who notices the absence; when it cannot, the item is "impact unknown — author must supply", never a safe cut. |

Every asset here is a **reader**, not a writer. The market ships planning
skills that generate plans from one line of input — the input-starved shape
where fabrication is guaranteed. These four generate nothing. Pure markdown,
no roles, no pipelines, installs with no confirmation, and a team can fork any
one of the four in a PR.

#### `design-docs` — M

*Four commands for the writing a repository asks for before code, each
refusing to assert what the tree does not show.* (Cross-domain merge: the
architecture survey's document pack, minus the assets the planning survey
correctly indicted.)

| Kind | Name | The refusal |
|---|---|---|
| skill (folder) | `adr-record` | Will not invent rejected alternatives. Alternatives come from what the author supplied or what the repo shows was genuinely tried — a reverted commit, a deleted module, a comment naming the approach. Everything else is "Alternatives not evidenced — author must supply". Status is written `Proposed`, never `Accepted`. Declines to open a record for a change that decided nothing. `$SKILL_DIR` carries the MADR and Nygard templates so the shape is a file, not a recollection. |
| skill | `arch-map` | No node and no edge reaches the diagram unless the ledger backs it with a resolved import at file:line. Dynamic imports, DI wiring, reflection and string-keyed registries go under "Edges I could not resolve statically", dashed and labelled `unverified` or absent. Will not draw a runtime or deployment topology from source alone. States its own recall bound. |
| skill (folder) | `fitness-function` | Will not report a check as enforcing until it has been observed to FAIL on a deliberate violation and PASS on HEAD, with both transcripts shown; otherwise the output is headed `UNPROVEN CHECK`. Will not weaken the rule to make it green — a HEAD that already violates it is a finding with the violating paths listed, and the allowlist is a human's decision. `$SKILL_DIR` carries per-stack recipes (dependency-cruiser, ArchUnit, import-linter, Deptrac, go-arch-lint, the CI-grep fallback). |
| skill | `hld-draft` | Will not invent a constraint. Every Constraints line carries a file:line or a quoted phrase from the requester's brief; a constraint with neither goes under `Assumed — unconfirmed` for a human to ratify. No latency, throughput, capacity or cost number the repo or the brief does not state. An invariant with no named check is deleted and filed under `Wanted invariants (no oracle yet)`. |

`fitness-function` is the pack's centre of gravity and, across all five
surveys, exists nowhere in the wild: the literature tells you to write the
architectural rule and no tool proves the rule bites. `hld-draft` is the one
asset in this catalog that generates a document, and it survives only because
its refusal turns the output into a scaffold with labelled holes rather than
confident prose — the tension with the planning survey's "never draft the RFC"
position is real and is recorded in §4.

#### `design-review-org` — L

*Five roles and two pipelines that move the enterprise-org pattern upstream of
code, where the author has no shell and the human gate is a pause the engine
enforces.* (Cross-domain merge: absorbs the planning survey's `decide`
pipeline, which was the same pipeline with a worse gate placement.)

| Kind | Name | Lane (derived) | The refusal |
|---|---|---|---|
| agent | `design-author` | **write** — `read, grep, glob, ls, search_code, write` | **Has no `bash`, so it cannot have run anything** — any transcript in a document it wrote is unattributable by construction. Never a constraint without a citation, never an invented rejected alternative, and never `Accepted` on an ADR except carrying the human's verbatim ORG-ASK answer and the run id. |
| agent | `codebase-critic` | **read** — `read, grep, glob, ls, search_code` | No finding without an address: a finding that cannot name file:line is downgraded from blocker to a question for the author. Novelty is not a finding unless it can name the concrete cost. `VERDICT:` has one value, `ADVISORY`. |
| agent | `invariant-oracle` | **exec** — `read, grep, glob, ls, bash` | An invariant it could not run, or could run but could not make fail, is never reported satisfied — it is `NO-ORACLE` or `RUNS-ONLY`, both first-class outcomes. Every verdict carries the verbatim command and exit code; "the check passes" with no transcript is not an allowed output. |
| agent | `impact-analyst` | **exec** — `read, grep, glob, ls, bash` | Never presents a consumer list as complete. Every report carries its recall bound and names what it could not enumerate — dynamic dispatch, DI wiring, reflection, cross-process and cross-repo callers — and what would close each gap. |
| agent | `design-lead` | **read** — `read, grep, glob, ls, search_code` | Never resolves the trade-off: `ORG-ASK:` or `ORG-HALT:` is its only terminal move. Never paraphrases a finding into the packet (quote it or cite its id). Never presents an UNPROVEN invariant as proven, a NO-ORACLE one as absent, or a skipped stage as passed. |
| workflow | `design-review` | 4 stages, `budgetUsd: 20`, `stepTimeoutMs: 1800000` | Contains no step with authority to approve a design. The gate is the pause at stage 3, not a role's verdict; stage 4 exists only to transcribe a decision a person already made. |
| workflow | `design-drift` | 4 stages, `budgetUsd: 15`, `stepTimeoutMs: 1800000` | `NO-ORACLE` is printed with a count and never folded into PASS — distinguishing "we checked and it holds" from "nobody can check this" is the entire product. Stage 1 refuses to extract a claim it cannot state as a predicate. No role in the pipeline is on the write lane, so none can edit a doc to make the ledger green. |

Three primitives `enterprise-org` does not demonstrate, which is why this is
the wave-1 org kit:

1. **The withheld tool as the guarantee.** `design-author` holds `write` and
   no `bash`. Every empirical claim in the packet must therefore be
   attributable to an exec-lane stage.
2. **Vandalism as verification.** `invariant-oracle` deliberately breaks the
   tree to prove a check bites, on a lane whose diff is never captured. The
   exec lane is what makes that safe rather than reckless.
3. **The ORG-ASK pause as the load-bearing gate.** `enterprise-org`'s human
   gates are workflow *boundaries* — the pipeline ends and you read the packet.
   Here the gate is mid-pipeline, and it is placed on `design-lead` (read lane)
   specifically so that declining to resume leaves nothing on disk. The
   planning survey's competing design put the ask on a write-lane role, which
   leaves an orphan `.options.md` behind; that is why this one won the merge.

### 2.2 Mobile

#### `mobile-ground-truth` — M

*Four commands for the mobile questions an agent is most likely to answer
confidently and wrongly.*

| Kind | Name | The refusal |
|---|---|---|
| skill (folder) | `api-check` | Never answers from model memory. Every AVAILABLE verdict cites a path:line on this machine or a doc fetched this session; with neither, the verdict is `UNVERIFIED` plus the exact lookup command, and it stops. Never invents a "since version N". Never reports AVAILABLE without also reporting the deployment-target/`minSdk` floor check — "it compiles" and "it runs on the oldest OS you ship" are two answers and it always gives both. `$SKILL_DIR/lookup-map.md` holds the per-ecosystem table of where pinned versions and sources live. |
| skill (folder) | `crash-triage` | Will not diagnose an unsymbolicated or identity-mismatched trace — full stop, with the missing artifact named and the identity check (`dwarfdump --uuid`, the `mapping.txt` for that exact versionCode, the Hermes map for that bundle commit) that would prove the match. Never names a line it did not read **at the shipped commit**. Never converts a `0x8badf00d` watchdog or a jetsam OOM into "a crash in X". Produces a hypothesis, never a fix. `$SKILL_DIR/symbolication.md` carries the per-platform command sets. |
| skill | `upgrade-impact` | Never lists a breaking change it cannot tie to a real occurrence in this repo — a regurgitated upstream changelog is explicitly not the deliverable. Never marks a dependency "compatible" from memory; the status is UNKNOWN unless a file it read says otherwise. Prefers the compiler's own deprecation warnings over any external list, and says at the top when it could not read the migration guide. |
| skill | `privacy-declarations` | Never declares a data type or required-reason code the code does not evidence, and never writes "no data collected" while a linked analytics or ads SDK contradicts it — that contradiction is raised as a blocking question, not resolved. Never states the app "is compliant"; compliance is a legal claim about facts outside the repository, and the last line says so. |

The only mobile pack anywhere built around refusals rather than style. It is
stack-agnostic by *detection* — `Podfile.lock` / `libs.versions.toml` /
`pubspec.lock` / `package.json` — rather than by packaging, so the same four
commands work in an iOS repo, a Compose repo and the React Native monorepo
containing both. Two folder skills make it the catalog's `$SKILL_DIR`
reference implementation: lookup tables ship as data, `executable: false`
stays literally true, and the pack installs with no confirmation.

### 2.3 Data structures and algorithms

#### `complexity-guard` — M

*Growth-rate review and measurement-disciplined optimization, where the role
that states the number is never the role that wrote the code.*

| Kind | Name | Lane (derived) | The refusal |
|---|---|---|---|
| agent | `complexity-reviewer` | **exec** — `read, grep, glob, ls, search_code, bash` | No untagged big-O: every complexity statement is `DERIVED` (traced to a named file:line path) or `MEASURED` (a scan at three or more sizes with the ratio table pasted). Neither tag is not permitted output. And a bounded n is not a finding — a candidate whose n-source is provably bounded is dismissed **with the bound cited**, which kills the dominant false positive in complexity review. |
| agent | `perf-analyst` | **exec** — `read, grep, glob, ls, bash` | Never a mean without dispersion and repeat count. **No claim inside the noise**: a delta at or below the measured coefficient of variation is "indistinguishable at this harness's resolution, MDE is X%", never a speedup. **No cross-fingerprint comparison** — and this matters concretely here, because a lane worktree is seeded from a commit and does not carry `.gitignored` build artifacts, so A/B must be interleaved inside one worktree, not compared across stages. Never adjudicates a change it proposed. |
| agent | `optimizer` | **write** — `read, write, edit, bash, grep, glob, ls` | **Never touches the instrument** — editing the benchmark, the fixture, the input sizes or the measurement contract is a stop, not a fix. Never bundles two hypotheses into one measured change. Never states a performance number itself, even one it observed. Never weakens or skips a correctness test to make a hot path faster. |
| workflow | `complexity-gate` | 4 stages, `budgetUsd: 15` | `NOT-SEPARABLE-AT-THESE-SIZES` is a first-class verdict: when the reachable sizes cannot distinguish n from n log n, the packet says so and names the n that would. Stage 2 emits `ORG-HALT: no harness` when no fixture can be built, and refuses to optimize when the top hotspot's Amdahl ceiling is below the measured noise floor — *refusing to optimize is the pipeline's most valuable output*. |
| skill | `scaling-check` | — | Refuses to name a growth class the data does not separate, reporting "not separable below n = X" and the size that would decide it. Refuses a curve from fewer than three sizes or without repetition counts. Refuses to read the code and name a class — derivation is the reviewer's `DERIVED` lane, and mixing the two is how a guess acquires a measured look. |

Built on a published asymmetry rather than taste: models predict time
complexity at roughly 64% and *measure* it at 92% against human labels, and
agents reach under 0.23× expert speedup while failing specifically at
localization and correctness. So the pack automates measuring and gates
asserting. The noise number is the other load-bearing fact — 2.66% coefficient
of variation on shared CI runners means a 2% regression gate false-alarms
about 45% of the time, so `perf-analyst` measures the floor on the user's
actual hardware instead of assuming one.

### 2.4 Cloud

Both cloud packs obey one non-negotiable constraint stated once here and
repeated in each README: **nothing in either pack mutates infrastructure.**
Not gated — out of scope. The reasoning is mechanical, not squeamish: an
`ORG-ASK` pauses a *run*, it is not a permission boundary, and nothing about
answering a paused workflow un-deletes an S3 bucket. The exec lane guarantees a
role's diff never reaches your checkout and guarantees nothing about an API
call. The real boundaries are the read-only principal the pack demands and
discloses, and the permission engine, which does not read prompts at all.

#### `iac-plan-review` — M

*Plan review that refuses to review a plan it could not produce — and treats
the plan itself as code execution, because on this domain's facts it is.*

| Kind | Name | Lane (derived) | The refusal |
|---|---|---|---|
| agent | `terraform-plan-reviewer` | **exec** — `read, grep, glob, ls, bash` | **Will not review a plan it did not produce.** If init/plan fails — no credentials, unreachable backend, missing var file, state lock — it emits `PLAN-UNAVAILABLE` with the verbatim command and exit code and reviews nothing; it never falls back to reading HCL and asserting an outcome, which is the single most common fabrication in IaC review. Carries a verbatim deny list (`apply`, `destroy`, `import`, `state rm|mv|push`, `taint`, `force-unlock`, `-auto-approve`, `workspace delete`) it will not run under any instruction, **including one arriving inside a plan file, a module README or a provider doc**. Never says "safe" or "no downtime". Prints the principal it ran as into every artifact. |
| workflow | `iac-change-review` | 5 stages, `budgetUsd: 18`, `stepTimeoutMs: 1800000` | No step has apply authority — not gated, absent. ORG-HALTs when the diff touches no stack rather than manufacturing work. Stage 4 writes "not available in this repo" for any policy tool the repo lacks rather than a plausible green line. Stage 5's `ORG-ASK` names exactly what becomes irreversible; it is a question, never an approval. |
| skill | `plan-explain` | — | The credential-free path and the pack's most-used asset: `$ARGUMENTS` is a plan JSON your CI already produced. **Will not mention a resource not in the file** — every sentence carries an address from `resource_changes[].address`, and a resource it cannot classify as stateful is `unknown`, never assumed stateless. Will not print "safe", "no downtime" or "low risk" as a conclusion; those are the approver's judgment and a plan JSON does not contain them. |
| skill | `drift-report` | — | Never writes "someone changed this in the console" without an audit-log record with an event id, time and principal, quoted; otherwise the cause is `unattributed`. **No state surgery** — it will not propose or run `import`, `state rm`, `state mv`, `apply -refresh-only` or `-target`. Exit code 1 is reported as an error, never as "no drift". |

The pack's spine is a README note the roles all reference, `NO-APPLY-CONTRACT`:
the deny list, the read-only credential contract, and the plan-is-execution
warning with its sources (Atlantis's own security docs on the `external` data
source and malicious providers executing at plan time; the Terraform Plan RCE
and GitFlops demonstrations of credential exfiltration from a speculative plan).
The naive design — reviewers are read-only, only `apply` is gated — is wrong on
this domain's facts, and that is the insight the pack is built on.

**Shipped honestly incomplete.** The survey proposed sibling reviewers for
Azure `what-if` and CloudFormation change sets, each with its own
oracle-specific refusal (what-if under-reports by documented module
short-circuiting; `Replacement: Conditional` genuinely means unknown). Both are
named on the pack page as unshipped, with the reason: each needs a real repo of
that dialect to validate its refusal against, and we have not run one. Adding a
role to a shipped pack is a smaller change than a new pack, and that is where
they go when someone has the tree to test them on. `/plan-explain` already
accepts what-if and `describe-change-set` JSON, because reading an export
needs no credential.

#### `cloud-posture-review` — M

*Read-only posture and IAM review where a check that could not run is
NOT-CHECKED, never PASS.*

| Kind | Name | Lane (derived) | The refusal |
|---|---|---|---|
| agent | `posture-scanner` | **exec** — `read, grep, glob, ls, bash` | A check that did not run — permission denied, service not enabled, region not enumerated, tool absent — is `NOT-CHECKED` with the reason, never PASS and never omitted. Never invents a check id, CIS control number, CVE or CVSS score it did not read from real tool output this session. Never writes "this account is secure"; the honest sentence is "no findings from the N checks I ran across these scopes". `VERDICT:` has one value, `ADVISORY`. No auto-remediation, ever. |
| agent | `iam-least-privilege-analyst` | **exec** — `read, grep, glob, ls, bash` | Never proposes a policy not backed by observed access data, and every narrowing cites the generated policy or last-accessed record **with its exact lookback window**. Must print the calibration the entire least-privilege genre omits: absence of use in a 90-day window is not proof a permission is unneeded — quarterly jobs, DR paths, break-glass roles and annual compliance tasks all look identical to dead permissions, and any candidate whose name or tags suggest one is flagged `do-not-prune-without-owner`. Proposed policy JSON is an artifact, never an action. |
| workflow | `posture-review` | 5 stages, `budgetUsd: 20`, `stepTimeoutMs: 2700000` | Stage 1 ORG-HALTs if scope cannot be established, because a posture report with an unknown denominator is worse than none. **Stage 4 is a coverage audit** — what did not get checked, in which scope, and why — the stage every posture review skips and every post-incident review needs. The raised timeout is load-bearing: a scan aborted mid-flight is the exact input that produces a false PASS. |
| skill | `exposure-check` | — | **Will not conclude "not exposed."** The honest verdict is "no public exposure found by the N checks listed below, in these regions, as this principal", and every denied API call is listed as a denial rather than silently treated as a negative — an AccessDenied on `s3:GetBucketPolicyStatus` means unknown, not private. Reports only what an API returned; never infers exposure from an IaC file, and where IaC and the live API disagree it reports both as drift rather than picking. |

The `READ-ONLY-PRINCIPAL` note states the credential contract concretely per
cloud (AWS `SecurityAudit` + `ViewOnlyAccess` + Access Analyzer reads; Azure
`Reader` + `Security Reader`; GCP `roles/viewer` + `roles/iam.securityReviewer`),
the commands each role prints to disclose the identity and scope it actually
ran as, and why this pack's credential should be separate from anything that
can deploy.

### 2.5 Final totals, stated honestly

| Pack | Domain | Skills | Agents | Workflows | Effort | Wave |
|---|---|---|---|---|---|---|
| `plan-pressure-tests` | planning | 4 | — | — | S | 1 |
| `mobile-ground-truth` | mobile | 4 | — | — | M | 1 |
| `design-review-org` | architecture | — | 5 | 2 | L | 1 |
| `design-docs` | architecture | 4 | — | — | M | 2 |
| `complexity-guard` | DS&A | 1 | 3 | 1 | M | 2 |
| `iac-plan-review` | cloud | 2 | 1 | 1 | M | 3 |
| `cloud-posture-review` | cloud | 1 | 2 | 1 | M | 3 |
| **Total** | | **16** | **11** | **5** | | |

Seven packs, thirty-two assets, nine registry entries including the two that
already exist. Thirteen candidate packs came in; six were cut or merged away.
Roughly a hundred candidate assets came in; sixty-eight did not survive. The
wild's mobile pack alone ships 46 skills; this catalog ships 16 across five
domains. If a future wave pushes past nine registry entries, something in it
is padding.

Lane spread across the eleven roles: 2 write, 6 exec, 3 read. Only two roles
in the entire catalog can change a file in your checkout — `design-author`
(which holds no shell) and `optimizer` (whose every edit a compiler grades
within minutes). That ratio is the catalog's headline claim and it is
checkable from `tools:` alone.

---

## 3. Build waves

Wave 1 is chosen for keep-rate per unit effort **and** for showing three
different primitives, so that whatever we learn from wave 1 generalises. Wave
2 deepens the primitives wave 1 proved. Wave 3 is last because both its packs
need external credentials and a real tree of the right shape to validate
against, and shipping them earlier means shipping unvalidated refusals.

### Wave 1 — `plan-pressure-tests`, `mobile-ground-truth`, `design-review-org`

Primitives demonstrated: plain skills at the `starter-skills` bar; **folder
skills with `$SKILL_DIR` reference assets** (nothing in the tree demonstrates
this today); and an org kit whose gate is a mid-pipeline `ORG-ASK` rather than
a pipeline boundary.

**`kits/plan-pressure-tests/`**

```
arcturn.json
README.md
skills/assumption-audit.md
skills/feasibility-read.md
skills/rfc-review.md
skills/scope-cut.md
```
plus `registry/plan-pressure-tests.json`.

**`kits/mobile-ground-truth/`**

```
arcturn.json
README.md
skills/api-check/SKILL.md
skills/api-check/lookup-map.md
skills/crash-triage/SKILL.md
skills/crash-triage/symbolication.md
skills/upgrade-impact.md
skills/privacy-declarations.md
```
plus `registry/mobile-ground-truth.json`. The two reference files are data
only — no scripts inside the skill folders, so `executable: false` stays
literally true and the extensions gate is never approached, let alone routed
around.

**`kits/design-review-org/`**

```
arcturn.json
README.md
agents/design-author.md
agents/codebase-critic.md
agents/invariant-oracle.md
agents/impact-analyst.md
agents/design-lead.md
workflows/design-review.md
workflows/design-drift.md
```
plus `registry/design-review-org.json`. The README carries the role/lane/never
table with the Lane column derived (not typed), the honest-limits table, the
plan-mode caveat (`design-review` stage 1 is a write-lane step, so the run
fails up front under plan mode before a token is spent), and the note that
these five role names are chosen not to collide with `enterprise-org`'s eleven
so both kits install side by side.

**One wave-1 side task, found while calibrating:** `kits/enterprise-org/`
has no `arcturn.json`, so its detection falls back to convention while its
registry entry is fully specified. Add the manifest in the same wave that
introduces the manifest requirement, or the requirement is advice rather than
a rule.

### Wave 2 — `design-docs`, `complexity-guard`

`design-docs` composes with wave 1: `/adr-record` is the solo path to the
artifact `design-review`'s stage 4 produces in a pipeline, and
`/fitness-function` writes the checks `invariant-oracle` proves. That
duplication is deliberate and mirrors `starter-skills` versus
`enterprise-org`'s `docs-writer` — the README must say so rather than let a
reader discover it.

`complexity-guard` is the second org kit and the first three-lane one in a
single pack (write + exec + read authority split across three roles for one
task). It is wave 2 rather than wave 1 because the write-lane `optimizer` is
the catalog's second and last write role, and it should be built after the
first one has run.

### Wave 3 — `iac-plan-review`, `cloud-posture-review`

Both need a credential and a real tree to validate against, both share the
no-mutation spine, and building them in one wave is what keeps the
`NO-APPLY-CONTRACT` and `READ-ONLY-PRINCIPAL` notes consistent with each other.
Neither may ship until its deny list has been exercised against a real plan and
a real scanner run, because a refusal nobody has watched fire is exactly what
`/fitness-function` refuses to call enforcing.

---

## 4. The rejected list

Sixty-eight assets and six packs. Grouped by failure mode rather than by
domain, because the same law rejected the same shape five times independently.

### 4.1 Cut by this document (cross-domain merges and defers)

These were recommended by a researcher and did not survive the catalog cut.
Each names the reasoning.

- **`decision-org` (5 roles, `decide` pipeline, source ledger, `source-checker`)
  — merged away.** Its pipeline is `design-review` with different intake:
  gather evidence → present options → human decides → record. Two of its roles
  duplicate `codebase-critic` and `design-author` outright. What was genuinely
  unique — the web-research half — is also the catalog's largest untrusted
  intake surface, and the pack's own headline invariant ("untrusted intake
  holds no write authority") is capability-only while `{{prev}}` splices a
  whole stage unfenced. The `ORG-ASK` gate placement was the deciding factor
  and it went the *other* way: `decision-org` put the ask on a write-lane role,
  which leaves an orphan `.options.md` if you decline to resume;
  `design-review` puts it on a read-lane role, which leaves nothing. **The
  condition that earns a research kit later:** `taint.ts` and `canary.ts` wired
  into `runtime.ts`, at which point the content half of the invariant becomes
  claimable. `source-checker` (re-fetch, QUOTE-PRESENT/QUOTE-ABSENT, haiku tier,
  deliberately no `websearch` so it cannot launder a bad citation by
  substituting a source) is the best single idea in that pack and should be the
  first asset built when that day comes.
- **`spike-kit` (3 roles, `spike` pipeline, `/spike-report`) — cut.** Its
  structural observation is the best in the entire survey set: Kent Beck's
  twenty-five-year-old rule that spike code must be thrown away is *mechanised*
  by the exec lane, where the engine discards the worktree and mints
  `status=discarded` from a record the role's own text cannot forge. It is cut
  anyway because a spike is episodic, four pipeline stages is heavy for "run
  some commands and write it down", and `/feasibility-read` already ends by
  naming the spike worth running. The observation survives as the canonical
  example under P2 rather than as six files.
- **`invariant-oracles` (mutant-kill admission gate, `oracle-author`,
  `failure-triage`) — deferred, strongest candidate for a wave 4.** The gate is
  genuinely novel: a generated property that kills no mutant is deleted and the
  drop count is published, which is the only thing separating "the agent
  generated 40 property tests" from "the agent generated 6 that can detect a
  regression". Deferred because it applies only to teams that hand-rolled a
  data structure, a mutation run costs real time and money, and the gate is
  enforced by prompt plus stage order rather than by a validator. **Earns a
  slot when:** two real users ask, and there is a repo with a hand-rolled
  structure to validate the gate against.
- **`cloud-cost-review` (`/bill-explain`, `/cost-diff`, `cost-investigator`,
  `cost-spike-triage`) — deferred.** Its refusals are among the sharpest in the
  set (no figure without a receipt; unpriced ≠ zero; `BilledCost` ≠
  `EffectiveCost`, declared in the first line of every answer). It is deferred
  on fit, not quality: the input is a billing export the user must download to
  disk, which is not a repository task, and we have no FOCUS or CUR export in
  this tree to validate the column logic against — so shipping it means
  shipping unvalidated refusals about columns we have never read.
- **`mobile-release-org` (4 roles, `store-readiness`, `sdk-deadline-upgrade`)
  — deferred.** Real work, correct lane split (three of four roles hold `bash`
  without `write`), and two pipelines with stages that genuinely cannot be
  reordered. Deferred because it is L effort requiring Xcode, an Android SDK
  and a real store artifact to validate against; because its `git apply` /
  `project.pbxproj` caveat means the one write role's most likely outcome in
  this domain is a patch refusal; and because the exec lane's guarantee is at
  its *weakest* here — simulators, `adb` state, the Gradle daemon, DerivedData
  and the keychain are all host-global. That caveat is worth carrying forward
  into `mobile-ground-truth`'s README under P6 regardless.
- **`lld-plan` — cut from `design-docs`.** It is `hld-draft` one altitude down
  with a near-identical refusal ("will not name a function it did not locate").
  Two generators in a four-asset pack is one too many, and the altitude that
  earns the citation discipline is the design doc, not the file list.
- **`optimize-loop` workflow and `structure-choice` skill — cut from
  `complexity-guard`.** `optimize-loop`'s best idea is the Amdahl-ceiling halt
  ("nothing here is worth measuring, the ceiling is 3% and the floor is 4%"),
  which moves into `perf-analyst`'s stage-1 duty inside `complexity-gate`.
  `structure-choice`'s refusal is sound but its verdict delegates to
  `/scaling-check` in the common case, which makes it a wrapper.
- **Azure `what-if` and CloudFormation change-set reviewers — named, not
  shipped.** Each preview oracle lies in a documented and *different* way, so
  each needs its own refusal and its own validation. We have no Azure or CDK
  tree to run them against. Named on the pack page with the reason rather than
  silently omitted.
- **A researcher-vs-researcher conflict, resolved and recorded.** The planning
  survey rejected `/design-doc` and `/rfc-draft` outright ("the value of an RFC
  is the author's thinking; a drafted one is a document nobody has thought
  about, and its confident prose will be reviewed as though it were
  considered"). The architecture survey proposed `hld-draft`. Both are right
  about different things. `hld-draft` ships **only** because its refusal turns
  the output into a scaffold with labelled holes — `Assumed — unconfirmed` is
  a section a human must ratify, not prose that reads as considered. If review
  of the built asset finds it reads as a finished document rather than a form,
  the planning survey wins and it comes out.

### 4.2 Encyclopedia content — no refusal is possible

The largest rejection class, and the one the wild's volume is made of.

`jetpack-compose`, `swiftui-patterns`, `core-data`, `koin-patterns`,
`mvi-architecture`, `coroutines-patterns`, `room-patterns`, `combine-framework`
and roughly sixty more of their kind · `api-design-patterns`,
`microservices-design` · a `/system-design` or scalability primer · an
algorithm/data-structure reference skill (complexity tables, "when to use a
trie") · Well-Architected / CAF / Azure Advisor review · migration-assessment
skills (7 Rs, wave planning, TCO) · a "performance best practices" checklist ·
a `/repro-conditions` device-matrix checklist · a `/build-error` "paste your
error and I'll explain it" skill.

These restate documentation the model already approximates, contain no
refusal, and rot faster than the SDKs they describe. Note also that web search
for "HLD vs LLD" returns almost entirely interview-prep content-farm material —
the topic's saturation is a warning about which shape not to build, not an
opportunity.

### 4.3 Input-starved generation — fabrication is guaranteed

`/prd-draft` (duplicates `enterprise-org`'s `pm`, which already emits ORG-ASK
on ambiguity, and would be a worse ungated copy) · `/design-doc`, `/rfc-draft` ·
an `adr-from-change` retro-ADR workflow (its stages are "gather then write";
one session with a shell does both and no lane separation is earned — folded
into `/adr-record`) · user-interview-analysis and persona generators (real
discovery input is transcripts and arcturn has no ingestion story for them) ·
a whole-repo `ARCHITECTURE.md` generator (maximises exactly the unverifiable
surface the CIAO study found developers rate worst) · Terraform/Bicep module
generators and IaC scaffolding · an algorithm-implementation skill ("write me
a Dijkstra") · a `fastlane-lane-writer` (one wrong line leaks a signing key) ·
a DS&A tutor or interview-prep pack (its *product* is generated content, so it
cannot refuse anything, and the space is already saturated with a dozen).

### 4.4 Invented numbers wearing a formula

`/estimate` in any unit — t-shirt, story points, days (**rejected with
prejudice**: estimates demonstrably move on irrelevant anchors and even on the
effort *unit* used, while projects overrun by 30–40% on average; shipping this
puts a spreadsheet's authority behind a guess) · RICE / ICE prioritization
scorers · market-sizing and TAM-SAM-SOM · `/big-o` as a function annotator
(unaided asymptotic assertion is what models get wrong about a third of the
time, and an annotation nobody can check outlives the code it describes) · an
"architecture health score" or maintainability grade · `capacity-plan` and
latency-budget skills (the inputs are not discoverable in a repository) · an
`app-size-diff` role (a size number needs a stored baseline and this catalog
ships no state store) · a "which cloud is cheaper" comparison · a cost
dashboard or HTML report generator (a chart is where an unsourced number
becomes invisible) · an estimation-calibration / reference-class-forecasting
skill (the one estimation method with real evidence behind it, and it needs
the team's own historical cycle-time data, which arcturn cannot reach).

### 4.5 Judgment with no oracle, presented as a verdict

`competitive-analysis` as a skill or a `competitive-analyst` role (the output
is a table of competitor claims and there is no oracle for any cell; the wild
ships a role whose authority is its job title, and a title is not a lane) · a
`skeptic` / red-team role that re-argues sources (a judgment with no oracle is
the LLM-judge-as-gate pattern `enterprise-org` refuses outright: *ranking and
triage, yes; verdicts, never* — `source-checker`'s mechanical "are these words
on the page" is worth strictly more per dollar) · a `device-tester` role that
taps through a UI and reports it works (screenshots and accessibility snapshots
are not an oracle; the honest survivor is launch-and-crash-check inside a build
role, where the evidence is a log) · a `microservice-decomposition` / DDD
bounded-context advisor · a general `cloud-expert` chatops agent (no bounded
task, no oracle, no refusal, unbounded turns — the shape every 160-skill
collection converges on) · a solo `/design-critique` skill (the context that
wrote the doc writes its review; independence has to be structural) ·
roadmap / OKR / quarterly-planning skills (the artifact is a record of a
negotiation the model was not in).

### 4.6 Mutation authority — refused on mechanism, not taste

A `store-submit` role running `deliver` / `supply` / `eas submit` (an approved
App Store version or a released Play track cannot be un-shipped, only halted) ·
an `iac-apply` or `deploy` workflow with an `ORG-ASK` gate before the apply
step (**this is the one worth restating**: `ORG-ASK` pauses a run, it is not a
permission boundary; once a resumed exec-lane step holds a deploy credential
nothing in arcturn bounds the blast radius) · auto-remediation of posture
findings, even "safe" ones like enabling bucket versioning (there is no such
thing as a remediation too small to have an owner) · `/commitment-check` for RI
/ Savings Plan / CUD purchases (irreversible one-to-three-year financial
commitments belong to a human with a demand forecast; `cost-investigator` is
forbidden from recommending one at all) · a `terraform-writer` / `iac-author`
write-lane role (it is `enterprise-org`'s `developer` with a different prompt,
and putting an IaC author in the same kit as its reviewers creates exactly the
conflict of interest `qa-adversarial` refuses) · giving reviewer roles `write`
"so they can fix the doc" (that moves them to the write lane and their patch
lands; a reviewer that can edit what it reviews is not a reviewer) · giving
`design-author` `bash` (it would not change its lane, but it would let the
document's author run something and then narrate it, destroying the one
guarantee that makes the packet trustworthy — **withholding the tool is the
feature**) · any step that marks an ADR `Accepted` on the model's own judgment.

### 4.7 Capability surfaces we cannot vouch for

Every `mcp.json` entry proposed across all five surveys is rejected for v1.
An `mcp.json` is merged into `~/.arcturn/mcp.json`, so installing a *content*
pack would silently widen a remote capability surface the maintainer cannot pin.

Rejected specifically: awslabs `aws-api-mcp-server` (a general credentialed AWS
API surface is precisely the mutation capability these packs claim not to have)
· awslabs `aws-iam-mcp-server` (**most emphatically** — it performs user, role,
group and policy *management*, which deletes the point of an analyst that
proposes narrowings as artifacts) · Azure MCP Server even with `--read-only`
(a server-side tool-list filter over a credential that still holds whatever
your principal holds; `az` on the exec lane under a Reader principal gives the
same reads with the constraint expressed where it is enforceable) · `gcloud-mcp`
(wraps the full GCP mutation surface with no equivalent of
`ENABLE_TF_OPERATIONS=false`) · HashiCorp's `terraform-mcp-server` (defensible
in the registry-reads-only configuration, and deferred anyway: the first cloud
pack's trust posture is stronger without it, and it is documented as an opt-in
the user adds knowingly) · `aws-pricing-mcp-server` (belongs with the deferred
cost pack) · Steampipe / CloudQuery (already work as CLIs on the exec lane) ·
XcodeBuildMCP and `mobile-mcp` (real and useful; their unique value is device
interaction, which this catalog deliberately refuses to treat as evidence) ·
a Structurizr or diagram MCP (no maintained server verified at a bar worth
staking a disclosure block on).

Also rejected: **any `extensions/` directory in any pack.** A citation
verifier, an import-graph analyzer, a curve-fitting script in a skill folder,
a mermaid-to-PNG renderer, a perf/py-spy/pprof wrapper. Shipping executable
code flips `executable: true` — the loudest thing a registry entry can say —
puts every install behind a confirmation that fails closed in non-TTY, and buys
capability that `bash` on the exec lane already provides. The catalog's trust
posture is that this content is markdown, and the moment it ships code the
reason people install it casually is gone. **Do not route around the gate by
putting a script inside a skill folder either** — the extensions gate keys on
`extensions/`, and a `$SKILL_DIR` script would land executable code on a
user's disk with no confirmation at all. `$SKILL_DIR` carries data.

### 4.8 Packaging errors

Per-platform mobile packs (`arcturn-ios` / `-android` / `-flutter` /
`-react-native`) — the obvious shape and wrong: it multiplies the same three
refusals by four so they drift within a release, and it mispackages reality,
since an RN or Flutter or KMP repo *is* an iOS repo and an Android repo.
Platform is a runtime fact to detect, not a packaging axis · one mobile
mega-pack of 20+ assets (the disclosure block becomes unreadable, which defeats
`arcturn inspect`) · separate `hld` and `lld` packs (the seam is cosmetic —
identical install shape, identical grounding discipline) · a third
cross-platform pack for RN + Flutter (a third copy of the same four refusals to
keep in sync) · a standalone cloud incident-response pack (nobody installs a
package during an incident; the two ideas worth keeping — an `/is-it-them` skill
that will not attribute an outage without a provider Health event id it
retrieved, and a post-incident timeline agent that names no person — are
recorded here for a future wave) · per-migration workflows (`swift6-migration`,
`rn-new-architecture`, `target-sdk-36`, `cocoapods-to-spm`) — each an upstream
changelog wearing a pipeline hat that rots on the next upstream release ·
`/security-group-diff`, `/nacl-explain`, `/bucket-policy-explain` micro-skills
(one real question sliced into three commands; folded into `/exposure-check`) ·
`/tag-audit` (folded into `/bill-explain`'s missing-column refusal) ·
`/premortem` as a standalone skill (Klein's technique is a *method* inside an
audit, not a second deliverable; two skills that both output "ways this could
fail" is padding) · `/n-plus-one` as its own detector (one detection category
inside `complexity-reviewer`) · `/quadratic-hunt` as a whole-repo sweep
(one-and-done, and a repo-wide grep manufactures exactly the low-precision
finding list the evidence rule exists to prevent) · a `/whats-new` store
release-notes skill (`/release-notes` already owns "never invent a migration";
the delta is per-locale character caps, which is a paragraph) · a `/api-lint`
skill wrapping `spectral` (a shell alias with frontmatter) · a
benchmark-scaffolding skill (writing the harness is not the hard part; deciding
whether it can detect the effect you care about is, and that judgment cannot be
split from the role that owns the noise floor) · a flamegraph-rendering skill
(tooling glue, no judgment, no refusal — a README line) · a `/complexity-review`
slash-command twin of the agent (a skill runs in the user's session with the
user's write tools, i.e. a reviewer that can silently fix what it reviews and
then report a number from the fixed tree — the exec lane's discarded diff is the
entire guarantee, and duplicating the role as a skill sells it back) · a skill
that scaffolds the ADR directory (CLI scope; `arcturn new` owns it) · a
`crash-repro` workflow and a `/flake-triage` skill (the mobile-specific value is
entirely in the front gate, which is a skill; everything after re-implements
`bug-fix` wearing a hat) · a design-stage `threat-model` role (collides on
mission with `security-reviewer`, and reusing the name collides literally) · a
parallel memory/allocation twin of every `complexity-guard` asset (same
discipline, different counter — the measurement contract takes a metric name) ·
container-image CVE scanning and Kubernetes assets (covered elsewhere or out of
this catalog's brief) · a `/brainstorm`-style refuse-to-code-until-designed
skill (obra/superpowers owns that shape and owns it well; arcturn's equivalent
lever is plan mode plus workflow stage boundaries, and copying it would be
padding with a competitor's idea) · a CI perf-budget gate that fails the build
on an N% regression (with 2.66% CV on shared runners a 2% gate false-alarms
~45% of the time, and shipping an uncalibratable threshold trains teams to
ignore the gate) · change-point detection over benchmark history (state of the
practice, and it needs a time series the pack does not own — that belongs to a
CI service) · an `adr-audit` "are our ADRs still true" workflow (periodic rather
than recurring, and its output is a verdict on decisions humans made —
`design-drift` is the honest version, which reports predicates and pauses) · a
`contract-change` workflow needing a role from another pack (**`@role` resolves
against loaded agents before a pipeline's first step, so a cross-pack workflow
fails the run at load** — a pack that only works when another pack is installed
is not a pack) · themes.

### 4.9 The `interface-contracts` pack — cut, with its best asset preserved as a note

The architecture survey's third pack (`/api-change-review`, `/contract-first`,
`interface-reviewer`) is cut for catalog size. Its central insight is correct
and worth recording: Google and Zalando both concluded API governance scales
only by splitting the linter from the review board, and `oasdiff` alone
classifies 514 distinct OpenAPI change types — a model narrating a spec diff in
prose is strictly worse than a tool that already enumerated every way a change
can hurt a client. The refusal that follows ("will not classify a change as
non-breaking by inspection when a differ exists; with no differ available the
whole classification section is headed `UNVERIFIED`") is the strongest single
sentence in that pack. **It earns a slot** when there is a repo with a
machine-readable contract to validate it against — and it is a two-skill
addition to `design-docs`, not a pack of its own, because a repo with no
OpenAPI/proto/SDL should not have those commands in its slash list.

---

## 5. Quality gate for the build phase

A pack is not listable until all of the following pass. The first four are
mechanical and belong in CI; the rest are a reviewer reading a diff, which is
what `registry/README.md` says curation is.

### 5.1 Loader round-trip — zero warnings, not zero errors

- Every `agents/*.md` loads through `loadAgentDefs` **with an empty warnings
  array.** A dropped tool name is a warning, not an error, and `multiedit` is
  the specific one this catalog will trip on: it is in `WRITE_TOOLS` but absent
  from `BUILT_IN_TOOL_NAMES` (`runtime.ts:142`), so declaring it advertises
  authority the role never receives. Same class: a misspelled tool, a
  non-integer `maxTurns`.
- Every role declares `tools:` explicitly. An omitted list is **refused at
  dispatch** (`undeclaredToolsError`) and is not the read lane — it is the
  widest grant in the system.
- Every `workflows/*.md` parses through `parseWorkflow`, and every `@role` in
  every pipeline resolves against the pack's *own* `agents/`. No cross-pack
  `@role` — resolution happens before the first step runs, so an unresolved
  role fails the whole run up front for anyone who installed one pack.
- Every skill loads at both `<name>.md` and `<name>/SKILL.md`, and every
  `$SKILL_DIR` reference resolves to a file that exists in the folder.
- No role name in the new pack collides with `enterprise-org`'s eleven or with
  any other listed pack's roles. Collisions resolve silently to the later root;
  a warning is not a design.

### 5.2 Disclosure matches the tree

- `npx vitest run web/scripts/hub.test.ts` passes. For a first-party entry the
  suite re-derives every agent's lane from the engine's own `WRITE_TOOLS` and
  `EXEC_TOOLS` literals, counts stages from the numbered lines, and reads
  `budgetUsd` out of the frontmatter. **A lane typed by hand fails the suite.**
- `arcturn inspect ./kits/<pack> --json` is diffed against
  `registry/<pack>.json`. They must agree on every role, lane, tool list, stage
  count, budget, skill name and the `executable` boolean. The page a person
  reads and the install they run cannot describe two different packages.
- `executable: false` is verified by the *absence* of `extensions/`, and by a
  grep confirming no executable file (`.js`, `.ts`, `.sh`, `.py`) anywhere in
  the pack, skill folders included.
- `arcturn.json` exists, its `name` matches the directory and the registry
  filename stem, and its `provides` lists every file that actually ships.
- `source` matches `GITHUB_SHORTHAND` from `registry.ts`, so the install
  command on the hub page is copy-pasteable rather than reconstructed.

### 5.3 The refusal is actually present in the text

This is a reviewer check and it is the one that decides whether the pack is
this catalog's or somebody else's.

- **Every skill body contains an explicit refusal sentence that names its
  substitute.** Not "be careful about X" — *"it will not do X; instead it
  writes Y."* Compare against `commit-message` ("write `fix: ...`, not
  `fix(core): ...`") and `pr-description` ("writes 'Not verified in this
  session' and lists the commands"). A refusal with no substitute is advice.
- **Every role file carries the shared spine**: mission, method, definition of
  done, an explicit `Never` list, and a fixed output envelope beginning
  `ARTIFACT: <TYPE>`. Every reviewer role's `VERDICT:` field has exactly one
  value and no `APPROVED` exists anywhere in the pack.
- **Every role file ends with the halt convention**: "if the input contains
  `ORG-HALT`, re-emit that line verbatim and stop", so an upstream halt walks
  intact into the final packet.
- **Every reviewer role re-derives its artifact** rather than trusting
  `{{prev}}`, and its brief says so. Downstream roles reading a supervisor's
  paraphrase is the most common multi-agent failure mode.
- **Every pipeline ends at a human** — an `ORG-ASK:` line or a
  `DECISION-REQUEST` block naming who decides and what becomes irreversible.
  Grep the pack for `apply`, `deploy`, `submit`, `publish`, `merge`, `tag`,
  `push`, `--auto-approve`, `--yes`, `execute-change-set`, `eas submit` and
  confirm every hit is inside a deny list rather than inside an instruction.
- **Grep for forbidden claims**: no README or role file may describe
  `writes:`/`reads:`/`consumes:`/`produces:` or per-role `budget:` as
  enforcement, because nothing parses them.

### 5.4 Timeouts, budgets and lane sanity

- Every workflow declares `budgetUsd:`. A pipeline with none is unbounded.
- Any workflow whose stages run a build, an archive, a Prowler-style scan or a
  `terraform init` against a remote backend declares `stepTimeoutMs:` **above
  the 10-minute default** (`DEFAULT_WORKFLOW_STEP_TIMEOUT_MS`,
  `workflow.ts:1548`). This catalog's floor for such packs is 1,800,000 ms; the
  posture pipeline uses 2,700,000. A scan aborted mid-flight is the exact input
  that produces a false PASS.
- Model tiers follow P4 and the README says why per role. Any role tiered
  flagship must have no mechanical oracle for its output; any role tiered cheap
  must name its oracle.
- Parallel branches within a stage are disjoint by scope, and the README says
  which of the three ways: both on non-write lanes (disjoint by construction),
  both on the write lane with printed pairwise-intersection globs, or on
  different lanes.

### 5.5 Docs voice and the honest-limits section

- README carries, in this order: what the pack is in two sentences; the install
  command in both shorthand and local-path form; the `arcturn inspect` command;
  a table of *command → what it does → what it refuses to do*; the role/lane/never
  table for org kits with the Lane column derived; the composition note (which
  other packs it coexists with and why no name collides); an **honest-limits
  table** stating where the pack's own guarantee stops (P6); and the
  Author/Support/License footer per project convention.
- The `starter-skills` sentence appears in substance in every README: *these
  instruct a model, they do not constrain it; the real boundaries are the lane
  derivation and the permission engine, which does not read prompts at all.*
- Voice: second person, no marketing adjectives, no emoji in asset bodies, no
  seniority cosplay ("a principal architect with 15+ years"), no count-as-value
  claims. State a number only with its source. Where the pack is incomplete,
  say so on the page rather than omitting it — `iac-plan-review` naming its
  unshipped Azure and CloudFormation reviewers is the model.

### 5.6 One additional gate for the cloud packs

Before either cloud entry is listed, a reviewer must confirm on a real tree:
the deny list has been exercised (a role handed an instruction to run `apply`,
including one planted in a module README, refused and reported it); every role
printed its authenticated principal and enumerated scope into its artifact; and
a deliberately failed check surfaced as `NOT-CHECKED` rather than as PASS or as
silence. A refusal nobody has watched fire is what `/fitness-function` calls an
`UNPROVEN CHECK`, and this catalog does not get to hold itself to a lower
standard than its own assets.
