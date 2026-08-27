# RFC 0001 — Agent Organizations

| | |
|---|---|
| **Status** | Draft — ready to execute against |
| **Date** | 2026-08-21 |
| **Scope** | `packages/cli/src/org/*` (new), plus additive changes to `agents.ts`, `runtime.ts`, `router.ts`, `audit.ts`, `memory.ts`, `provenance.ts` |
| **Inputs** | Five research reports (frameworks, products, enterprise, evidence, frontier) and two design drafts (architecture, org-model), reconciled here. Where the drafts disagreed, §11 records the decision and what would reverse it. |
| **Depends on** | Nothing unshipped. v1 is a format and a runner over primitives that already exist and are already tested. |

---

## Summary

Arcturn Organizations turns arcturn from one agent with helpers into a **governed software
organization**: named roles with declared authority, typed work products passed by
reference, gates bound to external oracles, and human approval points that are signed
decisions rather than sentences an agent wrote.

Everything an org *is* lives in markdown under `.arcturn/org/` — reviewable in a PR,
diffable, blameable. Everything an org *did* lives in an append-only ledger joined to the
session tree, so `arcturn blame` answers "which prompt, which turn, which evidence, **which
role, under which human sponsor**" for every shipped line.

The bet is not that more agents write better code. The evidence says that is mostly false
(§14, findings 2–3). The bet is that **the binding constraint on agentic software delivery is governed
delegation, not model capability** — and that an accountability substrate is the thing
nobody else has built.

---

## 1. Why arcturn

### 1.1 The constraint is delegation, not capability

Four independent 2025–2026 sources point at the same wall, from four directions:

- Developers use AI for ~60% of their work but can fully hand off only **0–20% of tasks**
  ([Anthropic 2026 Agentic Coding Trends](https://rits.shanghai.nyu.edu/ai/anthropics-2026-agentic-coding-trends-report-from-assistants-to-agent-teams/)).
  Agents now take ~20 autonomous actions before checking in — double six months prior — yet
  the *full-delegation* ceiling barely moved. Agents can do more before asking; humans still
  will not let them finish without asking.
- METR's productivity result flipped from **−19%** to **1.4–2×** — and METR's own framing is
  that what changed was **workflow maturity, not the model**
  ([METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/),
  [METR 2026](https://metr.org/blog/2026-02-24-uplift-update/)).
- DORA 2025 finds AI raises throughput **and** instability together, degrading most when
  agents lack institutional context about the systems they change; the strongest predictor of
  good outcomes was platform and workflow quality, not the tooling
  ([DORA 2025](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)).
- Gartner projects **>40% of agentic AI projects cancelled by end of 2027**, attributing the
  failure list to management and governance rather than engineering
  ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)).

And the failures inside multi-agent systems are the same shape: MAST, built from 1,600+
annotated traces across seven frameworks, attributes **41.8%** of failures to
specification/design, **36.9%** to inter-agent miscoordination, and **21.3%** to verification
gaps ([arXiv:2503.13657](https://arxiv.org/pdf/2503.13657)). None of those three clusters is
fixed by a better model. All three are fixed — or not — by the orchestration layer.

### 1.2 The foil: what seven shipping products do not have

| Product | What it does well | The gap Organizations targets |
|---|---|---|
| **Devin** (Cognition) | Planner→Coder→Critic→Review; context-isolated reviewer catches 2 bugs/PR, ~58% severe | No replayable session tree. "Why did this line get written" is not answerable after the fact |
| **Cursor / Bugbot** | >2M PRs/month reviewed; risk-scored auto-merge on 35% of internal PRs | Risk score is a black box; the evidence trail is per-PR, not per-line, and not bisectable |
| **GitHub Agent HQ** | Best-in-class *orchestrator of other vendors' agents*; audit-log streaming to SIEM | Audits sessions, not derivations. No provenance from a shipped line back to a prompt |
| **Factory** | Coordinator dispatching role-scoped droids (code/review/docs/test) | Roles are product features, not files a human reviews in a PR |
| **Amazon Kiro** | Structure over roles — a mandatory Spec→Plan→Impl→Test pipeline with gates | Gates are process ceremony; no oracle binding, no per-role authority model |
| **OpenAI Codex** | Manager + parallel workers, each with own context, disaggregated sandbox | No org-level identity, budget scope, or approval chain |
| **Google Jules** | Deliberately simple: one async agent per task, PR out | Explicitly no inter-task coordination — not a competitor to an org model at all |

Sources: [Cognition](https://cognition.com/blog/multi-agents-working) ·
[Cursor](https://arize.com/blog/inside-cursors-agent-factory-how-it-verifies-ai-written-code/) ·
[GitHub](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/) ·
[Factory](https://theaiagentindex.com/agents/factory-ai) ·
[Kiro](https://kiro.dev/docs/ide/chat/autopilot/) ·
[Codex](https://zackproser.com/blog/openai-codex-review-2026) ·
[Jules](https://www.digitalapplied.com/blog/google-jules-gemini-async-coding-agent-guide).

**None of the seven has a replayable, bisectable, blameable session tree.** That is not a
marketing gap; it is the missing substrate. Every governance control an enterprise asks for
in 2026 — trace an action to a human sponsor (only **28%** of orgs can, per
[CSA](https://labs.cloudsecurityalliance.org/research/csa-whitepaper-nonhuman-identity-agentic-ai-governance-v1-cs/)),
show what an agent was *allowed* to do, produce a rollback for every automated action — is a
query over data arcturn already writes to disk, and a new subsystem for everyone else.

### 1.3 The claim we make, and the claim we refuse

**Refused:** "more agents produce better code." Multi-agent decomposition averages
**+3.87–7.62%** on code benchmarks while costing >10× the tokens; under equal thinking-token
budgets single agents match or beat multi-agent on multi-hop reasoning; Anthropic states
outright that multi-agent is weakest on "tightly interdependent tasks such as coding" — which
is arcturn's core workload (§14, findings 2–3). An org sold on throughput will disappoint, loudly.

**Made:** *every delegation, gate and approval is a replayable, blameable file.* An org run
produces not just a diff but a defensible account of how the diff came to exist — which role
was allowed to do what, which oracle passed, which human signed, what it cost, and what the
org assumed when the spec was ambiguous. That account is the product.

### 1.4 Anti-goals, stated once and enforced structurally

Arcturn Organizations is **not** an autonomous software company.

- No vendor surveyed ships agent-to-production without a gate (§6.3). Neither do we.
- Project Vend's overseer agent accepted a **forged PDF** as proof of board authority
  ([coverage](https://beam.ai/agentic-insights/what-anthropics-vending-machine-disaster-teaches-us-about-enterprise-ai-agents)).
  A supervisory agent is not an authorization mechanism, ever (L7).
- No nested orgs, no recursive delegation, no parallel writers on a shared tree, no LLM judge
  as a sole pass/fail authority. Each is denied by construction, not by prompt (§8).

---

## 2. Design laws

Eight laws. Everything below is downstream of them. Each carries the evidence that bought it
and the code that already enforces it.

**L1 — Multi-threaded intelligence, single-threaded writes.** Many roles may *analyse* one
change; exactly one role may *write* a given path at a time. Cognition's Flappy Bird failure —
parallel subagents producing a bird and a Super-Mario background because neither could see the
other's in-flight decisions — generalised to "actions carry implicit decisions, and conflicting
decisions carry bad results"
([Cognition](https://cognition.com/blog/dont-build-multi-agents)), narrowed but not retracted a
year later ([follow-up](https://cognition.com/blog/multi-agents-working)). *Already enforced:*
`validateTeamPlan`/`repairTeamPlan` (`team.ts`) refuse to dispatch a plan whose file scopes
overlap — colliding subtasks are **merged into one member**, because merging loses parallelism
while dispatching loses work.

**L2 — Every gate binds to an external oracle, or it escalates to a human.** An LLM grading
another LLM with no oracle reproduces exactly the condition Huang et al. showed degrades rather
than improves ([arXiv:2310.01798](https://arxiv.org/pdf/2310.01798)). A gate is
`command + assertion`, never `prompt + verdict`. *Already enforced:* `VerifyConfig`
(`verify.ts`) runs a shell command scoped to edited paths and feeds failures back into the same
tool result; `packages/evals/src/task.ts` already ships `commandSucceeds`, `fileContains`,
`fileMatches`, `noFileDeleted` as reusable assertions.

**L3 — Handoffs are files with provenance, never chat.** MetaGPT's message pool, Anthropic's
"return a reference, not the blob", and LangChain's independently-rediscovered "translation
problem" are the same failure found three times — the telephone game, in a peer mesh, a
supervisor hierarchy and a research fan-out. A consuming role receives an artifact *path* and
reads it with `read`, so the handoff itself passes the permission engine and lands in the audit
trail and provenance records for free.

**L4 — Clean-room review.** A reviewer never inherits the author's context. Devin Review
deliberately does not inherit the coder's transcript; Claude Code teammates get project context
plus a spawn prompt and explicitly *not* the lead's history. *Already enforced:*
`createSubagent` (`runtime.ts`) builds a child that never inherits the parent transcript.

**L5 — Repro-or-it-didn't-happen.** A finding blocks only if it ships executable evidence: a
failing test at a named commit, a reproduced trace, a scanner rule id. Everything else
annotates. The best AI reviewer measured across 200,000 real PRs scores F1 **51.7%** /
precision **52.2%**, and above ~50% false positives developers dismiss findings by default
([CodeAnt 2026](https://www.codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests)).
A blocking gate at that precision trains humans to ignore the gate.

**L6 — Topology is a structural constraint, not a prompt convention.** Google ADK's tree-scoped
handoffs are the pattern worth stealing; in arcturn the constraint lives in the permission
engine and the tool list, neither of which a model can argue with. *Already enforced:*
`createSubagent` strips `subagent` from every child and intersects a role's requested `tools:`
with what the mode already allows — "may only NARROW, never widen."

**L7 — Authority is a signed decision, never text an agent reads.** Project Vend's forged-PDF
coup; Claude Code treating a teammate's "the user approved this" as untrusted input. In an org,
"approved" means a `PermissionDecision.requestId` recorded in the ledger by the governance
surface. No role can approve anything by writing prose saying it was approved.

**L8 — Budgets and loop bounds are infrastructure, outside the agent's control loop.** One
insurance claims agent made **847,000 API calls in 4 hours for $63,000** because nothing outside
it capped it. *Already enforced:* `shouldAbortForCost(spentUsd, limitUsd)` (`cost-guard.ts`) is a
pure function; the org composes it at three scopes rather than reimplementing it.

**The meta-law — the Right to Solo.** Every pipeline carries a recorded **solo baseline**: cost
and pass rate for one strong agent on that task class, from `packages/evals`. If the org cannot
beat its own solo baseline on a rolling window, the dispatcher demotes that class to solo and
says so. An org that cannot outperform one good agent should be the first to admit it.

**Shallow and bounded beats deep and clever.** 68% of production agent systems run ≤10 steps
before a human ([MAP study](https://arxiv.org/abs/2512.04123)); coordination overhead grows
superlinearly with agent count; Claude Code's own guidance is that "three focused teammates
often outperform five scattered ones." Defaults: **≤5 concurrent roles per stage**
(`MAX_TEAM_MEMBERS = 5`), **depth 2** (org → role), **one rework cycle per gate**, hard USD
ceilings at three scopes.

---

## 3. The org as files

Everything is markdown or JSONL under the project, versioned in git, reviewable in a PR.
Nothing about an org lives in a database or in a model's head.

```
.arcturn/org/
  org.md                    # charter: budgets, governance mode, risk tiers, sponsor policy
  roles/
    architect.md            # a superset of today's AgentDef file — §3.2
    dev.md  qa-functional.md  qa-adversarial.md  security.md  docs.md  ux.md  pm.md
    lead.md  release.md  retro.md
  teams/
    feature-squad.md        # composition: which roles, fan-out cap, budget
  pipelines/
    feature.md  bugfix.md  refactor.md  security-audit.md  docs.md  release.md
  gates/
    tests-green.md  plan-disjoint.md  mutation-delta.md  findings-triage.md
  artifacts/
    prd.md  design-doc.md  test-report.md   # type schemas: required sections + gate
  memory/
    org/  roles/<role>/                     # §10
  runs/<runId>/                             # per-run state; git-ignored by default
    ledger.jsonl                            # append-only handoff/gate/approval record
    artifacts/  patches/  memory/
```

### 3.1 Why frontmatter, and why this exact shape

`parseAgentFrontmatter` (`agents.ts`) recognises exactly `name`, `description`, `tools` and
`model`, and **silently ignores every other key**. That is the seam this whole RFC is built on:
an org role file with extra frontmatter loads cleanly through today's `loadAgentDefs` with no
parser change. Adding `join(paths.project, "org/roles")` to the roots array in `runtime.ts` is a
one-line change that makes every role immediately usable as a `subagent agent:` target and as a
`/team --roles` specialist (`teamRoleFromAgentDef`, `team.ts`).

The parser's shape dictates the format: flat `key: value`, one line each, lists
comma-separated, no nesting, no YAML lists. Design to that and v1 needs no new parser. The cost
is real and worth naming: `writes: tests/**, **/*.test.ts` is a comma-joined string, not a
structured list, so a glob containing a comma is unrepresentable. We accept that over
introducing a YAML dependency to a format whose entire virtue is that it is trivially parseable.

A second reason for markdown-over-engine, from the research: AutoGen reached 54k stars and
Microsoft's backing, then forked to AG2, entered maintenance mode in Oct 2025, and was replaced
by Microsoft Agent Framework in April 2026 — a three-way ecosystem split in eighteen months
([VentureBeat](https://venturebeat.com/orchestration/microsoft-retires-autogen-and-debuts-agent-framework-to-unify-and-govern)).
The authored layer must outlive whatever executes it.

### 3.2 Role files

```md
---
name: qa-functional
description: Proves acceptance criteria with executable tests. Never edits production code.
model: anthropic/claude-sonnet-4-5
tools: read, grep, glob, ls, bash, write, edit
writes: tests/**, **/*.test.ts
reads: src/**, tests/**, docs/**
consumes: prd, patch
produces: test-report
gate: tests-green
lane: write
context: fresh
tier: workhorse
budget: 1.00
maxTurns: 15
reanchorEveryTurns: 8
escalate: human
---
You are the functional QA engineer on this change. Your oracle is the test runner, not your
own opinion. Every new test must be demonstrated to fail before the patch and pass after it…
```

| Key | Meaning | Compiles to |
|---|---|---|
| `writes` | Path globs this role may mutate | `PermissionRule[]` (§8.1) |
| `reads` | Path globs this role may read | `PermissionRule[]` (§8.1) |
| `consumes` | Artifact types this role may be handed | Handoff validation — MetaGPT's role subscription, made enforced instead of advisory |
| `produces` | Artifact types this role must emit | Stage fails if the artifact is missing |
| `gate` | Gate the produced artifact must clear | `GateRunner` (§6.2) |
| `lane` | `read` \| `exec` \| `write` | Dispatch lane (§7.1) |
| `context` | `fresh` \| `inherit` | Only meaningful on the write lane — the read lane is fresh by construction |
| `tier` | `flagship` \| `workhorse` \| `fast` | Provider-agnostic route name resolved by the router (§7.4) |
| `budget` | USD ceiling per assignment | `BudgetLedger` (§7.4) |
| `maxTurns` | Turn ceiling | `TeamMemberBrief.maxTurns` |
| `reanchorEveryTurns` | Role-block re-injection cadence | §3.6 |
| `escalate` | `human` \| `<role>` | Escalation table (§7.5) |

**Glob dialect, stated because it will otherwise bite.** `writes:`/`reads:` globs compile to
`PermissionRule.specifier` and are matched by `globToRegExp` (`permissions.ts`), which supports
`**`, `*` and `?` with `/`-aware semantics. `verify.ts`'s `globs` field is a *different, simpler*
dialect — a suffix/segment check with no `**` at all. These are not interchangeable. Gate files
therefore use the permission dialect for `paths:` and pass their oracle command a path list,
rather than reusing `VerifyConfig` verbatim.

### 3.3 Team files

```md
---
name: feature-squad
description: Ships one user-facing feature end to end.
roles: pm, architect, lead, dev, qa-functional, qa-adversarial, docs
maxParallel: 3
budget: 25.00
---
Notes for the runner: dev owns src/**, qa-functional owns tests/**, docs owns docs/**.
```

`maxParallel` defaults to `DEFAULT_TEAM_CONCURRENCY = 3` and is hard-capped at
`MAX_TEAM_MEMBERS = 5`. Membership is composition, not hierarchy — there is no seniority
relation between roles, only artifact dependencies.

### 3.4 Pipelines — the workflow grammar plus four tokens

The existing workflow grammar is already the right substrate: top-level numbered items are
sequential stages, indented `-` bullets are parallel branches, `[tag]` selects a model,
`{{prev}}`/`{{input}}` pipe. An org pipeline adds exactly four tokens:

- `@role` — parsed in the same position as `[tag]`, resolved to a role instead of a `ModelSpec`.
- `-> artifact-type` — declares the work product the stage must produce.
- `!gate-name` — a gate stage. Runs an oracle. **No model participates.**
- `?human: <question>` — an approval point, raised through the permission engine's `ask` path.

```md
---
name: feature
description: PRD → design → build → verify → review → docs → release
team: feature-squad
continueOnError: false
maxRework: 1
---
1. @pm Turn this request into a PRD with testable acceptance criteria: {{input}} -> prd
2. ?human: Approve the PRD before design starts.
3. @architect Produce the design doc, including declared invariants: {{prev}} -> design-doc
4. @lead Partition the work into provably disjoint file scopes: {{prev}} -> plan
5. !plan-disjoint
6. Build against the plan:
   - @dev Implement the change. Plan: {{prev}} -> patch
   - @qa-functional Write failing-then-passing tests. PRD + plan: {{prev}} -> test-report
7. !tests-green
8. @qa-adversarial Try to break the change. Clean context, diff only. -> findings
9. !findings-triage
10. @lead Assemble the evidence packet. -> evidence-packet
11. ?human: Merge.
```

Stage 6 is the only parallel one, and it parallelises across **disjoint write scopes** (L1).
Stage 8 is deliberately sequential and single-lane — see §11, decision 5, for why the five-lane review
fan-out in the org-model draft did not survive. Stages 5, 7 and 9 are oracles, not models: that
is L2 made syntactic.

What this pipeline is *not*: it is not ChatDev's fresh-persona-per-phase waterfall (lower
executability and worse token efficiency than a typed-artifact pool on the same benchmark), and
it is not a debate loop (weak-to-negative scaling evidence, §14, finding 17). It is a deterministic graph
with named specialists and hard gates — the shape CrewAI (Flow-wraps-Crew) and LangGraph
(supervisor-first) converged on independently.

### 3.5 Gate files

```md
---
name: tests-green
description: The change's tests pass and no test was weakened to get there.
kind: oracle
command: pnpm vitest run --reporter=json
timeoutMs: 600000
paths: src/**, tests/**
assert: exitZero, no-new-skips
onFail: rework
onRepeatFail: escalate
---
```

`kind` is one of `oracle` (may block), `advisory` (may annotate and route, never block), or
`human` (an approval point). An `oracle` gate must carry a `command:`; an `advisory` gate may
carry a model rubric but its verdict is attached to the record and cannot change it. Gate
execution is performed by the **runner**, not by an agent — no role holds `bash` on the read
lane, and no role is handed its own gate command, so a role cannot pass its own gate by running
something else.

### 3.6 `org.md`

```md
---
name: acme-platform
governance: gated          # gated | supervised | autopilot (never a default, never shipped on)
budget: 100.00             # USD per org run
budgetScope: run           # run > stage > assignment, all enforced
region: us                 # model-endpoint region pin
sponsor: required          # every run must name a human sponsor
riskTiers: packages/core/src/permissions.ts = t1, src/** = t2, docs/** = t3
maxRework: 1
soloBaseline: on
---
```

`sponsor: required` implements the single most-cited enterprise gap: only 28% of organizations
can trace an agent action back to a human sponsor.

**Persona re-anchoring.** Instruction-tuned models lose **20–40% persona fidelity over 10–15
turns** ([survey](https://arxiv.org/html/2601.10122v1)). A role held open across a long
assignment gets its role block re-injected every `reanchorEveryTurns` (default **8**) through
the existing steer path. Eight is chosen to land inside the observed drift window rather than
after it; it is a guess with a rationale, not a measurement, and §15 lists it as an unknown.

---

## 4. Role catalog

**The tiering principle, and it is counterintuitive: tier by *absence of an oracle*, not by
seniority.** A role whose output is checked by a compiler and a test suite can run cheap and
loop; a role whose output has no mechanical checker needs the strong model *and* a human gate,
because nothing downstream will catch it. This inverts "important role = big model."

Budgets are ceilings enforced by the cost guard, anchored to published market units (Devin's
ACU ≈ 15 min ≈ $2.25; Bugbot ≈ $1.00–1.50/run) and meant to be re-tuned monthly from showback
data, not treated as truth.

| Role | In → Out | Tier | Budget | Lane | Evidence |
|---|---|---|---|---|---|
| `pm` | charter → **prd** | workhorse | $0.40 / 6t | read | `[PROMISING]` as drafter only |
| `architect` | prd → **design-doc** (+ invariants) | flagship | $2.50 / 12t | read | `[EXPERIMENTAL]` — no vendor ships this role |
| `lead` | prd+design → **plan**; artifacts → **evidence-packet** | flagship / workhorse | $1.50 + $0.50 | read | `[PROVEN]` topology |
| `dev` | plan subtask → **patch** | workhorse → flagship on 2nd fail | $3.00 / 25t | write | `[PROVEN]` |
| `qa-functional` | prd+patch → **test-report** | workhorse | $1.00 / 15t | write | `[PROVEN]` with oracle |
| `qa-adversarial` | diff+prd+invariants (clean ctx) → **findings** | flagship, different family | $1.50 / 15t | read | `[PROVEN]` — best-evidenced split |
| `security` | patch+deps+audit trail → **security-review** | flagship | $1.50 t1 / $0.50 | read | `[PROVEN]` that autonomous gating is unsupported |
| `ux` | UI diff + component tree → **ux-review** | workhorse | $0.60 | read | `[PROVEN]` for rubric checks only |
| `docs` | patch+design → **doc-set** | fast / workhorse | $0.80 | write | `[PROVEN]` API docs; `[PROVEN NEGATIVE]` for context files |
| `release` | patches + gate outcomes → **release-record** | fast | $0.50 | read | `[PROVEN]` — cheap and boring is the goal |
| `retro` | ledger → **retrospective** + role diffs | fast | $0.30/wk | read | `[EXPERIMENTAL]` as a role |

Maturity tags: `[PROVEN]` = production-deployed at scale or replicated; `[PROMISING]` = real
published result, single source or narrow domain; `[EXPERIMENTAL]` = extrapolation, ships behind
a flag with a measured comparison before it becomes a default.

**The `Never` clauses matter more than the missions.** Each role file carries them verbatim in
its body, because they are the parts a model will otherwise negotiate away.

| Role | Never |
|---|---|
| `pm` | Invents scope untraceable to the charter; resolves an ambiguity silently (an unanswered question is a STOP trigger, not a judgment call). **The least evidenced role in the literature** — 51 primary studies, and the field's own review says substituting for product owners "requires further experimentation" |
| `architect` | Declares an invariant it cannot describe how to check. Invariants are the payload: "no module under `packages/tui` may import `@arcturn/ai`" is a grep; "p95 render budget 16ms" is a benchmark. This converts the least automatable role's output into the most automatable gates' input |
| `lead` | Edits source (the partitioner must not also be a writer); overrides an oracle gate; **re-summarises a finding when assembling the evidence packet — it links** |
| `dev` | Touches a file outside its scope (widening is an escalation, not a `git add`); writes the test that certifies its own fix; weakens an existing test to go green |
| `qa-functional` | Reports line coverage as evidence of quality — documented suites reach 100% line coverage while killing **4% of mutants** ([MutGen](https://arxiv.org/html/2506.02954)) |
| `qa-adversarial` | Reviews a patch whose author id appears in its provenance chain (§8.3); escalates an unreproduced finding to blocker; blocks on style |
| `security` | **Signs off.** Agents collapse **3.5–6×** from CTF benchmarks to real CVE exploitation ([CVE-Bench](https://arxiv.org/html/2503.17332v3)); 9 agent-found vulns vs 49 human-found on the same targets. A triage filter feeding a named human approver |
| `ux` | **Claims accessibility compliance.** Scanners reliably detect ~**13%** of WCAG 2.2 AA criteria; ~half of ~87 need human judgment by design. Findings split `machine-checkable` / `needs-human-judgment`, and the judgment list goes to the human. In v1 there is no screenshot tool, so it reviews component source and DOM only, and its file says so |
| `docs` | **Auto-writes agent-facing context files** (`AGENTS.md`, `CLAUDE.md`, role prompts). LLM-generated context files cut task success in **5 of 8 settings**, +2.45–3.92 steps, +20–23% cost ([arXiv:2511.12884](https://arxiv.org/pdf/2511.12884)). It may *propose* a diff; a human merges it after the rehearsal gate |
| `release` | Performs an irreversible external action without a signed approval; releases with an unresolved confirmed finding absent a signed accepted-risk |
| `retro` | Applies a role-prompt change itself; talks to other roles — it reads the ledger and writes to the human |

Overclaiming in these files is the fastest way to lose the accountability positioning. Each
ships with its honest capability note in its own `description:`.

---

## 5. Work products and handoffs

### 5.1 The artifact envelope

A work product is a real file carrying a frontmatter envelope. The envelope is the contract;
the body is whatever the type schema requires.

```md
---
artifact: design-doc
id: dd-checkout-v2
run: org-7f3a91
stage: 3
producer: architect
sponsor: sitharaj
turn: turn-91c2ef
inputs: prd:prd-checkout-v2
status: accepted        # draft | submitted | accepted | rejected | superseded
gate: design-consistent
rework: 0
---
```

`turn` is the join key into `ProvenanceTurnRecord`, so `arcturn blame` on any line of an
artifact already answers "which prompt, which turn, which evidence" with no new machinery.
`inputs` makes the derivation chain explicit and queryable — the shape MemClaw's harness
validated at depth four with correct writer identity
([arXiv:2606.24535](https://arxiv.org/abs/2606.24535)).

Type schemas live in `.arcturn/org/artifacts/<type>.md`: required section headings, a maximum
size, and the gate that must clear before `status: accepted`. Validation is **structural**
(headings present, size bounded, envelope well-formed) — deliberately not a model judging
quality, per L2.

| Type | Owner | Read by | Schema essentials |
|---|---|---|---|
| `charter` | **human** | everyone | goal, non-goals, acceptance criteria, risk tier, budget ceiling |
| `prd` | pm | architect, lead, qa-*, ux, docs | user stories, requirement pool with stable ids, explicit out-of-scope, **open questions listed as open** |
| `design-doc` | architect | lead, dev, qa-adversarial, security | context, ≥2 rejected alternatives, decision, **declared invariants in checkable form**, file impact map |
| `plan` | lead | dev, qa-*, human | subtasks with provably disjoint file scopes, per-subtask oracle command, budget, dependency edges |
| `patch` | dev | qa-*, lead, release | diff, commands run **and their exit codes**, checkpoint ids, self-declared risk notes |
| `test-report` | qa-functional | lead, release | criterion→test map, fail-before/pass-after proof as checkpoint ids, mutation delta |
| `findings` | qa-adversarial | dev, lead, human | per finding: severity, **evidence artifact**, status (confirmed/rebutted/accepted-risk) |
| `security-review` | security | lead, human, release | CWE/ASI class, exploitability, calibrated confidence, `human_review_required` |
| `ux-review` | ux | pm, dev, human | rule id per finding, machine-checkable vs needs-human-judgment split, executable next step |
| `doc-set` | docs | human, release | doc diff, API-surface coverage, "what a newcomer still can't answer" |
| `evidence-packet` | lead (assembled) | **human** | §5.4 |
| `release-record` | release | human, audit | version, included patches, gate outcomes, blame manifest, **tested rollback path**, skipped-gate declaration |
| `retrospective` | retro | human | gate failures, budget variance, STOP triggers, proposed role diffs |

### 5.2 The handoff contract — three rules, all enforced

1. **By reference, never by value.** A consuming role's prompt carries the artifact's *path*,
   not its contents; it reads the file with `read`. This caps token cost, removes the telephone
   game (the downstream role reads the original, not a paraphrase), and routes the handoff
   through the permission engine so it is auditable.
2. **Subscription is checked.** A role may only be handed artifacts whose type is in its
   `consumes:` list. A pipeline handing a `patch` to a role that consumes only `prd` fails at
   **parse time**, not at runtime.
3. **Every handoff is ledgered.** One append-only JSONL line per handoff, written through the
   same single-promise-queue discipline as `createAuditLog` (`audit.ts`), so concurrent role
   completions never interleave bytes.

```ts
type OrgLedgerEntry =
  | { kind: "assignment"; ts: number; runId: string; stage: number; role: string;
      assignmentId: string; sponsor: string; lane: "read" | "write"; budgetUsd: number }
  | { kind: "handoff"; ts: number; from: string; to: string;
      artifact: { type: string; id: string; path: string; turn: string } }
  | { kind: "gate"; ts: number; gate: string; kind_: "oracle" | "advisory"; artifact: string;
      verdict: "pass" | "reject" | "escalate"; oracle: string;
      findings: { file: string; line?: number; summary: string }[]; advisory?: string }
  | { kind: "approval"; ts: number; question: string; decision: "allow" | "deny";
      requestId: string; sponsor: string }        // requestId ties to PermissionDecision
  | { kind: "escalation"; ts: number; reason: string; trigger: number; from: string; to: string };
```

### 5.3 Vocabulary note

The unit of work is a **run** (`runId`), not an "engagement". This is not cosmetic: `run` is
already the top-level span name in `telemetry.ts` and the identifier shape in the session store,
so an org run nests inside vocabulary that already exists rather than introducing a parallel one.

### 5.4 The evidence packet

The single thing a human reads before approving. A gate with a bad exhibit is theatre, so the
contents are non-negotiable:

1. **The diff, per hunk, with `arcturn blame`** — which prompt, which turn, which evidence
   produced each line. No competitor has this; it is what makes the gate cheap to answer.
2. **Verify transcript** — commands and exit codes, verbatim, never "tests pass."
3. **Fail-before / pass-after proof** for each claimed fix, as checkpoint ids a human can replay.
4. **Findings ledger** — confirmed (with repro), rebutted (with the rebuttal's evidence),
   accepted-risk (awaiting this signature).
5. **Blast radius** — files touched, directories, count of files not previously modified this
   run, every permission decision and hook verdict. Computable today from `DiffStat` plus the
   permission engine.
6. **Budget actuals vs plan, by role** — showback keyed by `OrgPrincipal`.
7. **Assumptions the org made** — every place a role resolved an ambiguity. This is the section
   that catches spec drift, and it is the one a model will want to omit.
8. **Solo-baseline comparison** where available.
9. **Rollback** — the checkpoint id. Checkpoint-before-every-edit already *is* the rollback plan.

Items 1–6 and 9 exist today as data. The packet is an assembly job, not an instrumentation job.

---

## 6. Gates

### 6.1 The three kinds

| Kind | Decided by | May it block? | Example |
|---|---|---|---|
| `oracle` | External, mechanically-checkable verifier | **Yes** | `tests-green`, `plan-disjoint`, scanner exit code, mutation delta |
| `advisory` | Model judgment against a fixed rubric | **No** — annotates and routes | `ux-heuristics`, low-confidence security findings |
| `human` | A signed `PermissionDecision` | **Yes** | charter sign-off, merge, irreversible action |

**Where an LLM judge is permitted:** ranking and triage of findings by likely severity
(ordering, not verdicts); rubric-scored checks citing a *published rule id* (Nielsen heuristic
number, WCAG success criterion); groundedness checks where the reference is in context.

**Banned as a blocking gate:** "is this code good", "is this architecture sound", "is this
secure", "is this PR ready to merge." No source supports these as sole authorities.

**Mandatory controls whenever a judge runs at all:** A/B-swap answer order as a standing
control; a per-judge test-retest baseline recorded in the evals package; bias-sensitivity
reported alongside the score; and **automatic fallback to non-LLM verification when consistency
or accuracy drops below a pre-registered threshold** — the recommendation both major 2026 judge
audits converge on, adopted verbatim (§14, findings 5–6).

### 6.2 How a gate rejects work back

```
producer emits artifact (status: submitted)
      │
      ▼
GateRunner: run oracle command (scoped to gate.paths) → evaluate assertions
      │
      ├─ pass ──────────────► ledger{gate,pass}; status = accepted; stage advances
      │
      ├─ fail, rework < maxRework ─► ledger{gate,reject,findings}; status = rejected;
      │        a `rejection` artifact is written carrying the findings verbatim; the SAME
      │        role is re-dispatched with (original brief + rejection path), rework += 1
      │
      └─ fail at limit, OR oracle unavailable ─► ledger{gate,escalate}; stage suspends;
               the governance surface raises an approval request
```

Three properties worth stating outright:

- **Rework is bounded and blameable.** One cross-role rework cycle by default — the same
  discipline `validateTeamPlan` already uses ("exactly one re-ask"). Repeated rejection is a
  signal to escalate, not to loop.
- **The rejection is an artifact, not a chat message.** So the reason a role redid its work is
  in git, is bisectable, and shows up in `arcturn blame`.
- **An unavailable oracle escalates.** It never auto-passes and never substitutes a judge. This
  is the single most important line in the document.

**Loop budgets differ by whether an oracle is present.** A `dev` running its own verify loop may
iterate up to **4** cycles, because a compiler and a test suite are grading each iteration
cheaply. A cross-role gate rework is capped at **1**, because each cycle costs a full
re-dispatch and no oracle is grading the *handoff*. Loops with an oracle can be longer than
loops without one; that is the whole rule.

### 6.3 Human gate points

Four, by design, and two of them cannot be removed in `governance: gated`:

| Gate | When | Why it cannot be delegated |
|---|---|---|
| Charter / PRD sign-off | before design | MAST attributes 41.8% of failures to specification; requirements agents are the least evidenced role |
| Architecture approval | tier-1 risk only | no oracle exists for architectural tradeoffs |
| **Merge** | every run | no vendor ships autonomous merge without a gate; the floor is universal |
| **Irreversible action** | deploy/publish/delete/external write | "AI proposes, humans approve every irreversible action" is the 2026 consensus |

`?human:` is the general mechanism and may appear anywhere; the four above are what the shipped
pipelines use, and merge + irreversible are a **floor**, not a default. More gates is not safer
— it is the fastest route to the fatigue failure in §13.4.

### 6.4 STOP tripwires — a fixed list, not a judgment call

A model deciding when to ask for help is the same model that decided it was doing fine. These
are hook-enforced:

1. Budget burn ≥80% of ceiling with the current gate not passed.
2. The same gate failed 3 times (loop detector — the $63k class of failure).
3. A required oracle is missing for the touched area.
4. The change touches a tier-1 path (auth, permissions, crypto, migrations, release tooling).
5. `dev` and `qa-adversarial` disagree after one round and **both** cite evidence.
6. Any irreversible or external effect not pre-approved in the charter.
7. Taint/canary tripwire fires, or a hook veto occurs.
8. Spec ambiguity: two readings of the charter yield different acceptance tests.
9. A role requests scope widening beyond its plan allocation.
10. Solo-baseline breach: this class has lost to solo N times running.

Every STOP writes an incident record, auto-populated from the audit trail and provenance.

---

## 7. Execution runtime

### 7.1 Three dispatch lanes — a constraint discovered in the code, not invented

`createSubagent` (`runtime.ts`) computes an `allowedByMode` predicate under which a **non-yolo**
child is restricted to `DEFAULT_READ_ONLY_TOOLS` (`read`, `grep`, `glob`, `ls`) plus `fetch`.
That is correct and must not change — but it means a role that *writes*, or merely *executes*,
cannot be dispatched through `createSubagent` unless the whole session is in yolo.

The first cut of this section shipped with **two** lanes and a false economy underneath them:
any role holding `bash` — including every read-only reviewer, since "repro-or-it-didn't-happen"
needs a way to actually run the repro — was routed onto the *write* lane, meaning whatever it
left behind in its worktree was replayed into the user's real checkout with `git apply`,
unreviewed, the instant the step succeeded. A security reviewer with `bash` and no other tool
never *intended* to mutate anything and was still one careless `bash -c 'echo x > f'` away from
doing so. That was not theoretical: it is finding 1 of the adversarial review this section's v1
slice shipped against (see the status note below). Three lanes fix it, by splitting what "two
dispatch lanes" conflated — *can execute* and *can mutate* are different questions, and `bash`
alone should only ever answer the first one:

| Lane | Authority (from `tools:`) | Primitive | Isolation | Diff |
|---|---|---|---|---|
| **Read** | none of `write`/`edit`/`multiedit`/`bash` | `runtime.createSubagent(task, roleDef)` | Fresh context by construction; child never inherits the parent transcript; no worktree at all | N/A — structurally cannot touch a file |
| **Exec** | `bash`, and none of `write`/`edit`/`multiedit` | `runtime.buildSessionAgent({ sessionId, cwd: worktree, model })` + `setTools` — same primitive as the write lane | Own **seeded** `git worktree add --detach` (`createWorktree`, `scouts.ts`) | **Never captured, never applied** — discarded on completion; the worktree is removed on success and kept, clearly labelled inspect-only, on failure |
| **Write** | at least one of `write`/`edit`/`multiedit` (`bash` alongside them still counts as this lane) | `runtime.buildSessionAgent({ sessionId, cwd: worktree, model })` + `setTools` — exactly `createTeamSpawn` | Own **seeded** `git worktree add --detach`, own checkpoint store | Captured to a patch file and applied with plain `git apply` on success |

Both worktree lanes are seeded, not bare: created from the run's starting commit, every patch
the run has already applied so far replayed into them in order, then committed *inside* the
worktree as its own detached starting point before the role's agent ever runs — so a role
dispatched in a later stage is looking at what an earlier stage actually landed, not at HEAD
before the pipeline began, and a role that commits its own work mid-step (ordinary git hygiene
for anything holding `bash`) loses nothing when the engine captures its diff, because capture
always diffs against that seed commit, never against HEAD.

The write lane's isolation is what makes L1 enforceable rather than aspirational: two roles
writing at once are writing in two different checkouts, and reconciliation is `git apply --check`
then `git apply`, without `--3way` and without `--force`, stopping on the first refusal —
preceded by the engine's own audit of the patch's own target paths (no absolute path, no `..`
segment, nothing under `.git/`); git's own hardening against a symlinked target directory
(shipped since 2.39.2) is the second wall that patch has to clear, not the only one. **Arcturn
surfaces conflicts; it never guesses.** The exec lane delivers the useful side effect the old
two-lane table claimed for *every* bash-holding role and, per finding 1, actually held for none
of them: because an exec-lane role's diff is structurally unappliable, a reviewing role can now
genuinely execute — including its own gate's check command — while remaining structurally unable
to mutate anything. That is what "no read-lane role holds `bash`" was reaching for in the first
place; a third lane is what it actually took.

A role's dispatch record is authoritative, never advisory: the engine returns a structured
`{ status, role, stepId, files, patchPath? }` on the step's result, set only by the engine, and
strips any `ARCTURN-PATCH:` line a step's own output wrote before composing `{{prev}}` for the
next stage — appending its own canonical trailer in its place. A role cannot mint a fake
`status=applied` line and have a downstream stage believe a patch landed that never did (finding
3 of the same review). A role that declares no `tools:` at all is refused at dispatch rather than
defaulted to the read lane — an undeclared list is an authority grant nobody wrote down, and
"roles narrow; nothing widens" (§8.4) applies to omission as much as to escalation.

> **Status: shipped v1 (2026-08-21).** The two-lane version of this table shipped first, in the
> slice described at the end of §12; an adversarial review of that slice found the `bash`-only
> reviewer gap above, among seven other findings, within days, and this three-lane version — plus
> seeded worktrees and the engine-authoritative patch trailer, both new in the same pass — is the
> fix. `roleLane` now returns `"read" | "exec" | "write"`, and `createRuntimeRunStep` /
> `createRuntimeWriteLane` dispatch all three. `kits/enterprise-org/` and `/docs/workflows`
> (website) were reconciled to this table in the same pass; see §12's status note for what is,
> and is not, covered by "shipped."

### 7.2 Mapping onto today's primitives

| Pipeline construct | Runtime primitive |
|---|---|
| Sequential stages, `{{prev}}` piping, abort/continueOnError | `runWorkflow` |
| Parallel branches | Workflow nested-bullet branches (read lane) or `TeamManager.start` (write lane, disjoint-scope-validated) |
| One role assignment | Child agent with the role's `AgentDef` |
| Long autonomous stage detached from the session | `BackgroundAgentManager.start` |
| "Which approach?" spike before design | `runScouts` with a hard deadline |
| Merge / reconcile | `TeamManager.merge` → `TeamMergeReport` |
| Crash recovery | `TeamManager.recover` — salvages worktree diffs to patches, corrects `running` → `interrupted` |

That last row matters more than it looks. Anthropic names "minor system failures can be
catastrophic because errors compound in long-running stateful agents" as the motivation for
durable execution as a first-class requirement. Arcturn already has it.

### 7.3 `OrgPrincipal` — the join key, shipped first

```ts
export interface OrgPrincipal {
  runId: string;         // org run
  roleId: string;        // which role definition
  assignmentId: string;  // this dispatch of that role
  sponsor: string;       // the human who authorised the run
}
```

Threaded through every permission check, audit entry, cost charge, ledger line and telemetry
span. It is cheap now (the session already threads a subject) and it is what turns "spend by
role", "audit by role", "route this approval to the security reviewer" and "what was this agent
*allowed* to do" from four subsystems into four queries. This is the same primitive the
enterprise survey identified as the prerequisite for everything else.

### 7.4 Budgets, routing, region

Three scopes, composed from `shouldAbortForCost` — a pure function that already exists:
**assignment** (role `budget:`, overrun aborts that role), **stage** (team file), **run**
(`org.md`, overrun suspends and escalates — never silently continues).

Per-role routing extends `ModelRouter`. Today `RouteKind` is a closed union of `"main" |
"subagent" | "compaction" | "title"`; v2 adds a router whose `specFor` accepts `role:<name>` and
falls back through `subagent` → `main` → fallback, preserving the existing property that a bad
id never throws, it warns and falls back. Routing is by **competency, not difficulty tier** —
Cognition runs different vendors side by side on the same task class because "some models debug
better, some handle visual reasoning better." `org.md`'s `region:` constrains which provider
endpoints a role may resolve to, rejecting out-of-region ids at resolution time.

The market has settled the billing question: Cursor/Bugbot, GitHub Copilot and OpenAI Codex all
abandoned flat/seat pricing for run-metered billing in 2026 because flat rates could not track
agent-run variance. Per-assignment cost attribution keyed by `OrgPrincipal` is the expected norm.

### 7.5 Failure, retry and escalation

| Condition | Action |
|---|---|
| Gate rejects, rework < max | Re-dispatch same role with the rejection artifact |
| Gate rejects again | Escalate to `role.escalate` (default human); stage suspends |
| Oracle unavailable / times out | Escalate. Never auto-pass, never substitute a judge |
| Role agent fails (crash, turn cap) | v1: stage fails per `continueOnError`. v2: **localized replan** — re-decompose only the failing branch |
| Budget exceeded at any scope | Abort that scope, escalate up |
| Merge conflict | Stop, report which patches landed, leave the patch file; the human chooses |
| Process dies mid-run | `TeamManager.recover` salvages diffs to patches; the ledger replays |

### 7.6 Telemetry and audit

`telemetry.ts` already builds a span tree — run > turn > (tool | llm-stream), subagent runs
nested as children — with **no** `@opentelemetry/api` dependency, satisfied structurally by a
real OTel SDK. Org runs add three parent levels: `org.run` > `org.stage` > `org.assignment`,
each tagged with the `OrgPrincipal`. Because the GenAI semantic conventions are **still
unstable** as of mid-2026 (every `gen_ai.*` attribute carries a Development badge; the
conventions were split into their own repo at v1.42.0), `gen_ai.*` naming is an **opt-in mapping
layer**, never a rewrite.

`AuditEntry` is a discriminated union (`AuditToolEntry | AuditPermissionEntry | AuditHookEntry`);
adding an `AuditOrgEntry` variant carrying ledger entries is additive and inherits the
append-only, single-writer-queued, self-describing-line properties for free.

---

## 8. Security model

Three enforcement layers. None of them is a prompt.

### 8.1 Layer 1 — tool narrowing, and Layer 2 — path scoping

`AgentDef.tools` flows into `createSubagent` where it is intersected with what the permission
*mode* already allows, and into `createTeamSpawn` where `agent.setTools` produces a genuinely
shorter tool array — a read-only reviewer has no `write`, `edit` or `bash` object to call.
`subagent` is stripped in both paths (no nested orgs, L6).

`writes:`/`reads:` globs compile to rules seeded into the role's permission engine:

```ts
export function compileRolePermissions(role: OrgRole, cwd: string): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const tool of ["write", "edit", "multiedit"]) {
    for (const glob of role.writes) {
      rules.push({ tool, specifier: resolve(cwd, glob), action: "allow", scope: "session" });
    }
    rules.push({ tool, specifier: "*", action: "deny", scope: "session" });
  }
  return rules;
}
```

This works because of three properties already proven in `permissions.ts`:

- `matchRules` ranks by scope, then **specificity**, then deny-bias. A concrete allow-glob
  outranks the `*` catch-all deny for in-scope paths; everything else hits the deny.
- The engine's stated rule — "a more specific deny beats a broader permissive rule even from a
  nearer scope", added so a checked-in config cannot escalate its own privileges just by being
  cloned — means a project-scoped `allow *` cannot silently widen a role.
- **Correctness detail that will otherwise silently break everything:** `PATH_SUBJECT_KEYS`
  (`file_path`, `filePath`, `path`, `target`) are resolved against `cwd` before matching. Role
  globs must therefore compile to **absolute** patterns rooted at the assignment's cwd — which
  for a writing role is its *worktree*, not the user's tree. Compiling relative globs would fail
  to match and the catch-all deny would block everything.

Concretely: `qa-functional` gets `writes: tests/**` and cannot touch `src/**` even if its own
prompt tells it to. `pm` gets no write globs, a read-only tool list, **and** `plan` mode — which
denies every mutating tool by construction — so it is read-only twice over.

### 8.2 Layer 3 — hooks with veto, and the forged-authority rule

`wrapToolsWithHooks` gives `preToolUse` a real veto and `auditedHookRunner` already records
every verdict. Org policy that cannot be expressed as a static rule — "no role may edit
`.arcturn/org/roles/**` during a run", "no role may write outside the run's declared risk tier" —
is a `preToolUse` hook.

**The forged-authority rule (L7).** An approval is a `PermissionDecision.requestId` in the
ledger, never text in an artifact. `GateRunner` verifies approvals by looking up the ledger entry
and matching the `requestId` against the permission engine's emitted decision. Artifacts produced
by roles are **data**; only the governance surface writes `kind: "approval"` lines. No role can
approve anything by writing prose saying it was approved, and no role can relay another role's
denied action.

### 8.3 Conflict of interest

A role whose `agent_id` appears in a file's provenance chain cannot be dispatched as that file's
reviewer. This is a `preToolUse` check against the provenance index, not a convention — it is
the structural form of "agents cannot reliably check their own work" (§14, finding 4), and it composes
with L4's clean-room requirement: the reviewer is both a *different* principal and a *fresh*
context. On tier-1 paths the reviewer must additionally be a different model family.

### 8.4 What an org can never do

- **Nest.** `subagent` stays stripped from every child. No vendor allows recursive delegation;
  Claude Code bans it outright.
- **Write in parallel on a shared tree.** Worktrees or nothing.
- **Coordinate over free-form agent chat.** The ledger and artifacts are the substrate.
- **Pass a gate on a model verdict alone.** L2.
- **Escalate its own authority.** Roles narrow; nothing widens. A role file is itself a
  permission-gated, checkpointed, blameable edit — changing one during a run is a hook veto.

---

## 9. Governance surface

Approval points are raised through **the existing permission engine's `ask` path**, not a new
prompt mechanism, so they inherit for free: the TUI dialog, `--print`'s refusal to assume,
headless fail-closed behaviour, and the `permissionRequest`/`permissionDecision` event pair the
audit observer already records.

| Command | What it does |
|---|---|
| `/org run <pipeline> [input]` | Start a run. Fails closed if `sponsor: required` and no sponsor is resolvable |
| `/org status [runId]` | Stage board, per-role state, spend vs budget, open gates, pending approvals — rendered from the ledger, reusing `formatTeamReport` |
| `/org approve\|reject <runId> <stage> [reason]` | Writes a `kind: "approval"` ledger line carrying the `requestId` |
| `/org attach <runId> <role>` | Tail one role's live event stream. Over `arcturn serve` this is `SessionHost.observe` on the role's session id — an org run becomes tmux for an engineering team |
| `/org steer <runId> <role> <text>` | Mid-run correction (§9.1) |
| `/org cancel\|merge\|discard <runId>` | Reconciliation, using `TeamManager.merge` |
| `arcturn org blame <file>` | `arcturn blame` scoped to a run, adding role and stage to the prompt/turn/evidence answer |
| `arcturn org permissions <role>` | What this role is *allowed* to do — compiled rules, tool list, lane |

### 9.1 Mid-run steering is a designed capability, not a gap

Anthropic names synchronous execution blocking real-time steering as its current bottleneck, and
MetaGPT concedes humans "face challenges to interrupt the running process." Arcturn's
`Agent.steer()` already injects a message into a running agent, and `SessionHost.steer` exposes
it over the wire. `/org steer` is a thin wrapper over both. This is a genuine differentiator
against two named gaps in the leading frameworks.

### 9.2 The human's job

The owner is not a manager of agents. The owner is the **holder of intent and the signer of
consequences** — the two things no evidence supports delegating.

- **Write the charter.** Goal, non-goals, acceptance criteria, risk tier, budget. 41.8% of
  multi-agent failures are specification failures; this is the highest-leverage 15 minutes.
- **Answer decision requests** — chosen from options the org prepared, with costs and evidence.
  Never a transcript dump.
- **Sign irreversible actions.** Merge, deploy, publish, delete, external writes.
- **Own the taste calls.** Architecture tradeoffs, UX judgment, prioritisation under conflict.
- **Merge the org's own self-improvement PRs.**

**Explicitly not the human's job:** reading transcripts, babysitting a running agent, reviewing
code an oracle already checked, or re-deriving what an agent did — that is what `arcturn blame`
is for. Each gate should cost 2–5 minutes because the evidence packet did the work.

**Minimum viable ceremony.** Three artifacts (`charter`, `evidence-packet`, `retrospective`),
four gates, two rituals (daily digest, weekly retro PR), one rule:

> **No merge without an evidence packet. No exceptions, no "just this once."**

If the org ever requires more ceremony than this from the human, the org has failed, not the
human.

---

## 10. Org memory

Build on `memory.ts`. `CreateMemoryToolOptions.dir` already accepts **a function of the tool
context** — added so a scout in a throwaway worktree does not write into the user's repo. That
one seam gives role-scoped memory with zero new core code:
`createMemoryTool({ dir: (ctx) => memoryDirFor(principalOf(ctx)) })`.

| Scope | Path | Write | Read |
|---|---|---|---|
| Assignment | `runs/<runId>/memory/<assignmentId>/` | that assignment | that assignment |
| Role | `memory/roles/<role>/` | that role | that role |
| Run | `runs/<runId>/memory/shared/` | any role in the run | any role in the run |
| Org | `memory/org/` | **permission-gated promotion only** | all roles |

Four primitives, matching the governed-shared-memory set:

- **Scoped retrieval** — `formatMemoriesForPrompt` is already called per-agent at prompt build;
  it needs only the principal-derived directory.
- **Temporal supersession, not overwrite** — a note gains `supersedes: <slug>` frontmatter and
  the old note is retained with `status: superseded`. The memory frontmatter parser understands
  only `title` and ignores unknown keys, so this is forward-compatible with today's loader.
- **Provenance** — a real gap worth naming: `MUTATION_TOOL_NAMES = ["write", "edit"]`, so memory
  writes are **not** provenance-tracked today. v2 records a `memoryWrite` provenance record so a
  promoted org fact is blameable to the run and turn that learned it.
- **Policy-governed propagation** — promotion from role scope to org scope is a
  **permission-gated** tool call. Today the memory tool never requests permission, because every
  write is confined to the memory directory by construction. That is right for role-local notes
  and wrong for org-wide ones: a self-modifying shared knowledge base is the natural target of a
  prompt-injection persistence attack, and OWASP's 2026 Agentic Top 10 lists Memory Poisoning as
  a named class with real incidents behind it.

### 10.1 Post-mortems and role self-improvement

Weekly, not per-run — per-run reflection produces prompt bloat and overfits to noise. The `retro`
role reads the ledger (gate rejections, escalations, rework counts, spend, solo deltas) and
writes a `retrospective` with **systemic** observations. It may then propose a **diff** to a
role's `.md` — an ACE-style incremental playbook edit, never a prompt rewrite, so role prompts
do not accrete forever. Three hard constraints:

1. The diff is an ordinary file edit: checkpointed, permission-gated, `arcturn blame`-able.
   Self-modification is not a special case.
2. It requires human approval. Nothing auto-writes a role prompt.
3. **It must clear the rehearsal gate before it can be approved** (§12, v3). This is not
   optional caution: LLM-*generated* agent context files measurably reduced task success in 5 of
   8 tested settings. Un-rehearsed auto-tuning of role prompts is an evidenced way to make the
   org worse.

---

## 11. Alternatives considered

Where the two design drafts disagreed, this is the decision and what would reverse it.

| # | The disagreement | Decision | Tradeoff accepted | What would reverse it |
|---|---|---|---|---|
| 1 | 8 roles (flat) vs 11 (QA split, explicit lead, chief-of-staff) | **11**, with QA split into `qa-functional` / `qa-adversarial` | More role files to maintain; more surface to get wrong | If clean-context adversarial review stops outperforming a combined reviewer on cost-adjusted quality |
| 2 | Is `lead` a persistent supervisor or a stage role? | **A stage role.** Mechanical dispatch stays code (`TeamManager`); the lead's model work is limited to partitioning and evidence assembly | Loses a single "voice" coordinating the run | If localized replanning (v2) needs a standing arbiter rather than a per-stage one |
| 3 | Ledger at `.arcturn/org/<engagement-id>/` vs definitions and runs separated | **Separated**, runs under `.arcturn/org/runs/<runId>/` | Two places to look | Nothing foreseeable — definitions are reviewed in PRs, runs are git-ignored |
| 4 | "engagement" vs "run" | **run** — matches `telemetry.ts`'s span name and the session store id shape | "Engagement" reads better to a non-engineer | If a non-engineering surface (dashboard, PM tool) becomes the primary consumer |
| 5 | Five-lane parallel review (security ‖ ux ‖ docs ‖ qa-adversarial ‖ …) vs one lane | **One lane by default** (`qa-adversarial`), others conditional on risk tier; full fan-out behind a flag | Slower wall-clock review | A measured win over a single combined reviewer on cost-adjusted quality — which the org-model draft itself demanded before making it default |
| 6 | `ADR` as a separate artifact vs invariants inside `design-doc` | **One artifact**, `design-doc`, with a required `## Invariants` section | Loses the ADR convention some teams already run | If a team needs ADRs to live in their existing ADR directory — then the schema points there |
| 7 | `judge: advisory` field vs `kind: advisory` gate | **`kind:`** — one taxonomy (`oracle`/`advisory`/`human`), not a modifier on a field | Slightly more gate files | Nothing |
| 8 | One rework cycle (architecture draft) vs 4 verify cycles + 2 rebuttal rounds (org-model draft) | **Both, split by oracle presence:** 4 for oracle-graded self-correction, 1 for cross-role gate rework | Two numbers to remember | If measured rework data shows a second cross-role cycle recovers work more often than it burns budget |
| 9 | Human gates: exactly four (fixed) vs `?human:` anywhere | **`?human:` is the mechanism; four is the shipped usage; merge + irreversible are a floor** | A team can add gates until it drowns | Nothing — the floor is the safety property, the ceiling is the team's problem |
| 10 | Tier by seniority vs tier by absence-of-oracle | **Absence of oracle**, shipped as the default config and tagged `[EXPERIMENTAL]` | Counterintuitive; will surprise people who expect `dev` on the biggest model | Per-role rehearsal data (v3) showing the inversion loses |
| 11 | Global model tier ids vs provider-agnostic names | **`flagship`/`workhorse`/`fast`** resolved through the router | An indirection | Nothing — arcturn ships nine provider adapters; hardcoding ids would rot |
| 12 | Solo baseline: implicit caution vs an enforced demotion loop | **Enforced**, v2, `[PROMISING]` | The org can publicly demote itself, which is embarrassing and correct | If the demotion signal proves noisier than the cost of running it |
| 13 | Blackboard mode, adversarial courtroom, market bidding, reputation | **All v3, all flagged, none default** | Slower to the interesting ideas | v2 telemetry showing a concrete need |

Deliberately not built, ever: nested orgs; parallel writers on a shared tree; agent chat as the
coordination substrate; an LLM judge as sole pass/fail authority; auction task allocation;
gossip reputation; self-organising agent trees; digital-twin-of-the-org. And arcturn does not
become an IdP, a secrets manager, a SAST scanner, a billing system or a ticketing system — it
emits the data and plugs into what the enterprise already runs.

---

## 12. Roadmap

### v1 — composition, near-zero new core code

The point of v1 is that Organizations is mostly a *format and a runner*, because the hard parts —
isolation, permissions, checkpoints, provenance, audit, cost, recovery — already exist and are
already tested.

**Zero new core code required for:** role loading (`loadAgentDefs` ignores unknown frontmatter
keys — **one line** added to the roots array in `runtime.ts`); roles as `/team --roles`
specialists and `subagent agent:` targets; write-lane isolation, disjoint-scope validation, patch
capture, conflict-safe merge and crash recovery (`TeamManager`); read-lane fresh-context
reviewers (`createSubagent`); spikes (`runScouts`); detached work (`BackgroundAgentManager`);
gate oracles (shell commands + `preToolUse` hooks + the evals assertion helpers); rollback,
blame, audit, checkpoints, taint/canary, sandbox; approval dialogs and headless fail-closed
(`PermissionEngine.ask`).

**New v1 surface** — all of it in a new `packages/cli/src/org/`:

| API | Module | Notes |
|---|---|---|
| `OrgPrincipal` + `principalOf(ctx)` | `org/principal.ts` | **Ship first** — the join key everything else needs |
| `loadOrgRoles(roots, warnings, validToolNames)` | `org/roles.ts` | Wraps `loadAgentDefs`, parses the extra keys |
| `compileRolePermissions(role, cwd)` | `org/roles.ts` | §8.1 — **must** resolve globs against the assignment cwd |
| `parseOrgPipeline(raw, defaults)` | `org/pipeline.ts` | Superset of `parseWorkflow`; adds `@role`, `-> type`, `!gate`, `?human` |
| `createOrgLedger(file)` | `org/ledger.ts` | Mirrors `createAuditLog`'s single-writer queue exactly |
| `runOrgPipeline(pipeline, ctx)` | `org/run.ts` | Delegates to `runWorkflow` / `TeamManager` / `createSubagent` per lane |
| `createOrgCommands()`, `formatOrgStatus(run)` | `org/commands.ts`, `org/report.ts` | Reuses `formatTeamReport`, `formatCost`, `formatDuration` |

Shipped role library: all eleven from §4, each with its honest capability note. Shipped
pipelines: `feature`, `bugfix`. Shipped gates: `tests-green`, `plan-disjoint`, `findings-triage`.

> **Status (2026-08-21).** A first slice of this table has shipped, on a different path than
> planned above: `packages/cli/src/org/` has not been created, and none of `OrgPrincipal`,
> `loadOrgRoles`, `compileRolePermissions`, `createOrgLedger`, `runOrgPipeline` or
> `createOrgCommands` exist. Instead, the `@role` token — only `@role`; `-> type`, `!gate` and
> `?human` remain unbuilt — was added directly to the existing `parseWorkflow`/`runWorkflow` in
> `workflow.ts`, dispatching through the **three** lanes of §7.1 (read, exec, write —
> `roleLane`, `createRuntimeRunStep`, `createRuntimeWriteLane`; write-lane patches are captured
> and replayed with plain `git apply`, never `--3way`/`--force`, into a **seeded** worktree; a
> plan-mode parent refuses a write- or exec-lane step before any token is spent). The two-lane
> cut shipped first and was reconciled to three lanes within the same pass, after an adversarial
> review of the two-lane slice found a `bash`-only reviewer landing on the write lane among eight
> verified findings — §7.1's status note has the detail. `agents.ts` also gained `maxTurns:`
> frontmatter, enforced as a real per-role turn ceiling clamped to the session's own budget in
> both worktree lanes. `kits/enterprise-org/` now ships ten role files and six
> `@role`-dispatching pipelines built on this slice, in place of the `feature`/`bugfix` pair and
> `org/`-package gates sketched above, and `/docs/workflows` (website) documents it. None of the
> v1 acceptance criteria below are met by this slice — there is no `arcturn org run`, no ledger,
> no `arcturn org blame`, no `consumes:`/`produces:` enforcement, and no gate runner.

**v1 acceptance criteria**

1. `arcturn org run bugfix "<issue>"` completes end to end and produces an evidence packet whose
   nine sections are all populated from real data — no placeholders.
2. A `qa-functional` role with `writes: tests/**` is **denied** by the permission engine when its
   own prompt instructs it to edit `src/**`, and the denial appears in the audit trail. This is a
   test, not a demo.
3. `arcturn org blame <file>` returns role and stage alongside prompt, turn and evidence for
   every line produced by the run.
4. Killing the process mid-run and restarting recovers every write-lane patch, with statuses
   corrected to `interrupted`.
5. An artifact handed to a role that does not `consume:` its type fails at **parse** time.
6. A gate whose oracle command is missing **escalates**; a test asserts it never auto-passes.
7. `--print` mode refuses to auto-approve a `?human:` stage and exits non-zero.
8. Token and USD overhead of a `bugfix` run is reported against the recorded solo baseline for
   the same issue class, even though demotion is not yet automatic.

### v2 — the org-specific subsystems

| API | What it adds |
|---|---|
| `ArtifactStore` + `createArtifactTool()` | Typed envelopes, `consumes`/`produces` validation, supersession, derivation chains |
| `GateRunner` + `GateVerdict` | Oracle execution, assertion evaluation, advisory findings that cannot change a verdict |
| `createRoleRouter(config, resolve, base)` | `specFor("role:qa-adversarial")`, region constraint, competency routing |
| `BudgetLedger` | run > stage > assignment ceilings composed from `shouldAbortForCost` |
| `createOrgMemoryTool()` | Four scopes, permission-gated org promotion, supersession, `memoryWrite` provenance |
| `replanBranch(stage, failure)` | Localized replan with backtracking — re-decompose the failing node, never abort the graph or blindly continue |
| `AuditOrgEntry`; `org.run/stage/assignment` spans | Additive to `AuditEntry` and `telemetry.ts` |
| Approver-role routing on `ask` | "Security must approve changes under `packages/core/src/permissions.ts`" |
| Blast-radius payload on approvals | From `DiffStat` + checkpoint id |
| Solo-baseline recorder + dispatcher demotion | The honesty mechanism from the meta-law |
| `/org attach`, `/org steer`, org channel in `SessionHost` | Mid-run steering and per-role observation over `arcturn serve` |

**v2 acceptance criteria.** Approval routing sends a tier-1 permission ask to a named approver
role and refuses to accept a decision from anyone else. A run that exceeds its stage budget
suspends rather than continuing. The dispatcher demotes a pipeline to solo after N recorded
losses and the demotion is visible in `/org status`. A promoted org memory note carries a
provenance record naming the run and turn that learned it. Every `org.assignment` span carries a
resolvable `OrgPrincipal`.

### v3 — the frontier bets, each gated on v2 telemetry proving a need

| Capability | Why | Evidence |
|---|---|---|
| **`arcturn org rehearse <change>`** — the flagship. Replay a corpus of recorded sessions with a candidate role prompt / pipeline / model route substituted, auto-grade with the evals suites, report a rate estimate with error bounds, before the change is accepted | Turns "does this prompt change regress anything" from vibes into a measured pre-deployment gate. Composes VCR + `replaySession`/`diffReplays` + `runSuite` — three existing features into one gate | OpenAI's Deployment Simulation: 1.3M conversations, median 1.5× multiplicative error, simulated traffic flagged as "evaluation-like" only 5.1% of the time. Strongest-evidenced pattern in the entire scan |
| `roleEvalGate(role, model)` | A role-specific battery must pass before a model may be assigned; the result is recorded as provenance on the role config, so "why is this model doing security review" is answerable | JudgeAgent-class interview protocols, up to 13.5% correction rate over static benchmarks |
| Skill-conditional competence → router | Per-role, per-model outcome signal (gate rejections, reverted findings) auto-routes a failing role up a tier. **Not** a global trust score — competence is per-skill and global scores are attackable | RepuNet; skill-conditional reputation attack surface |
| Adversarial gate (`prosecutor`/`defender`/`judge`) | Opt-in for high-stakes diffs only. The defender must cite line numbers and test runs, never assertions; a human breaks ties, never same-family majority vote | Vuln-detection debate beats Cppcheck/PrimeVul more accurately and cheaper — but guard the Confident Liar failure mode; cap at 2 rounds |
| Blackboard mode | A third coordination mode for ill-structured work ("stabilise this incident") where neither a fixed graph nor a bounded team fits; schema-grounded patches so writes compose with checkpoints | Blackboard MAS competitive with SOTA at fewer tokens; 13–57% relative gain on information discovery |
| SIEM export sink; EU AI Act risk-management record; JIT secret-provider interface | The compliance surface: streaming audit export, a generated risk record from role frontmatter + compiled permissions, and pluggable Vault/Secrets-Manager fetch at tool-execution time | The single highest-leverage compliance gap versus Anthropic's Compliance API and GitHub's audit-log streaming |

**v3 acceptance criterion, and it is one sentence:** no role prompt, pipeline or model route may
be changed in a `governance: gated` org without a rehearsal report attached to the diff.

---

## 13. Risks

### 13.1 Cost blowup

**Risk.** Multi-agent costs 5.4× (three agents) to ~15× (production systems) a single-agent
baseline — mostly system-prompt repetition, tool-schema repetition and coordination messages, not
work. One agent made 847,000 calls in four hours for $63,000 because nothing outside it capped it.

**Mitigation.** Ceilings at three scopes enforced by `shouldAbortForCost` outside the agent loop;
fan-out capped at 5, defaulted to 3; loop detector as STOP trigger #2; handoffs by reference so
payloads are never copied through prompts; one rework cycle per gate; solo-baseline demotion.
**Residual risk accepted:** none of this makes the org *cheap*. It makes its cost bounded,
attributed and visible, which is the honest version of the promise.

### 13.2 Role-play drift

**Risk.** Models lose 20–40% persona fidelity over 10–15 turns. A drifted `dev` edits outside its
scope; a drifted `qa-adversarial` starts agreeing. Sycophancy collapses disagreement *before* a
correct conclusion, producing lower accuracy than a single agent, and conformity pressure rises as
more agents agree.

**Mitigation.** Turn caps; role re-anchoring every 8 turns, inside the drift window; persistent
named roles rather than per-phase re-recruitment, so provenance stays attributable; and the
load-bearing one — **drift cannot cause damage it is not permitted to cause.** A drifted `dev`
still cannot write outside `writes:`. The runner never asks "do you all agree?"; verification is a
separate role with its own evidence requirement and its own permission set.

### 13.3 Role escalation and forged authority

**Risk.** A role talks its way into more authority — persuading a peer to act for it, writing an
artifact that claims approval, editing its own role file, or prompt injection through a fetched
page or a poisoned memory note. Project Vend is the existence proof: fabricated PDFs accepted by
an overseer agent as board authority.

**Mitigation.** Tools narrow and never widen, enforced in `createSubagent` and `setTools`, not in
a prompt. `subagent` is stripped from every child, so no role can spawn its way out. Approvals are
`requestId`s in the ledger, never text. A role file edited during a run is a hook veto. Org-memory
promotion is permission-gated and taint-checked. Conflict-of-interest is a provenance query, not
an honour system. **Residual risk accepted:** a compromised human sponsor defeats all of it.
Arcturn makes that legible after the fact; it does not prevent it.

### 13.4 Human fatigue — the gate that becomes a rubber stamp

**Risk, and it is the one most likely to actually kill this.** At ~52% precision the best measured
reviewer produces enough noise that above ~50% false positives developers dismiss findings by
default, and up to 40% of alerts get ignored once fatigue sets in. DORA records median PR review
time **up 441%** and incidents per PR **up 242.7%** as agentic volume outran review capacity. An
org that generates more work than its humans can adjudicate has not automated anything — it has
moved the bottleneck and hidden it.

**Mitigation.** Only oracle-backed findings block; low-confidence findings are ranked and
suppressed from the blocking path. Four human gates, not fourteen. The evidence packet exists so a
gate costs 2–5 minutes. A pipeline that consistently produces more evidence packets than the
sponsor closes is a STOP condition, not a throughput win.

### 13.5 Believing our own throughput story

METR's durable finding is not the −19%; it is the **perception gap** — developers who had just
been measurably slower still estimated they were 20% faster. So self-reported productivity is
never an input to any routing or promotion decision here. The solo baseline and the evals suites
are.

---

## 14. Evidence appendix

The findings this design is actually load-bearing on. Where evidence is thin, §15 says so.

| # | Finding | Source |
|---|---|---|
| 1 | 41.8% of multi-agent failures are specification/design, 36.9% miscoordination, 21.3% verification — from 1,600+ traces across 7 frameworks, human-validated at κ=0.88 | [MAST, NeurIPS 2025](https://arxiv.org/pdf/2503.13657) |
| 2 | Under equal thinking-token budgets, single agents match or beat multi-agent on multi-hop reasoning; multi-agent wins largely reflect spending more inference | [arXiv:2604.02460](https://chatpaper.com/paper/264450), [arXiv:2606.13003](https://arxiv.org/pdf/2606.13003) |
| 3 | Multi-agent decomposition averages **+3.87–7.62%** on code benchmarks at >10× token cost; production multi-agent measured at ~15× a single chat turn | evidence synthesis; [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) |
| 4 | Intrinsic self-correction without an external oracle degrades rather than improves; earlier gains traced to hidden oracles | [Huang et al., arXiv:2310.01798](https://arxiv.org/pdf/2310.01798) |
| 5 | 541k judgments, 21 judges, 9 providers: exact-match agreement overstates judge reliability by **33–41 points** vs chance-corrected κ; production judges show >0.95 test-retest **with** >0.10 position bias — repeatable and systematically wrong | [arXiv:2606.19544](https://arxiv.org/pdf/2606.19544) |
| 6 | SE-specific: a sentiment cue moved one code-judge **+31.6 points**, a verbosity cue **−30.6 points**, on the identical task; test-retest as low as **50.36%** | [arXiv:2604.16790](https://arxiv.org/html/2604.16790v1) |
| 7 | Best AI reviewer across **200,000 real PRs**: F1 51.7%, precision 52.2%, recall 51.1%. Trust cliff: <10% FP treated as real, >50% dismissed by default | [CodeAnt 2026](https://www.codeant.ai/blogs/ai-code-review-benchmark-results-from-200-000-real-pull-requests) |
| 8 | Clean-context adversarial review is the one role split every serious vendor ships with numbers: Devin Review 2 bugs/PR (~58% severe); Bugbot 52%→76% resolution after agentic rebuild | [Cognition](https://cognition.com/blog/multi-agents-working), [Cursor](https://cursor.com/bugbot) |
| 9 | Coverage is gameable: documented suites at 100% line coverage killing **4% of mutants**; mutation-guided generation beats EvoSuite and vanilla prompting | [MutGen, arXiv:2506.02954](https://arxiv.org/html/2506.02954) |
| 10 | Security agents collapse **3.5–6×** from CTF benchmarks to real CVE exploitation; 9 agent-found vulns vs 49 human-found on the same targets; best SecVulEval F1 23.83% | [CVE-Bench](https://arxiv.org/html/2503.17332v3) |
| 11 | Automated scanners reliably detect ~**13%** of WCAG 2.2 AA criteria; ~half of ~87 criteria need human judgment by design; tool spread 22.6%–62.8% on real audits | accessibility benchmark synthesis |
| 12 | LLM-generated agent context files **reduced** task success in 5 of 8 settings, +2.45–3.92 steps, +20–23% inference cost; security/perf constraints are the systematically missing sections (14.5% each) | [arXiv:2511.12884](https://arxiv.org/pdf/2511.12884) |
| 13 | Requirements/PM agents are the least evidenced role: 51 primary studies, field's own review says substituting for product owners "requires further experimentation" | RE systematic mapping study |
| 14 | 68% of production agent systems run ≤10 steps before human intervention; 74% depend primarily on human evaluation; reliability, not capability, is the top challenge | [MAP, arXiv:2512.04123](https://arxiv.org/abs/2512.04123) |
| 15 | Per-task topology routing beats any fixed topology by **22.9%** relative; 62% of SWE-bench-Verified tasks wanted hybrid, 24% parallel, 14% hierarchical — most tasks do not want a big org | [AdaptOrch, arXiv:2602.16873](https://arxiv.org/html/2602.16873) |
| 16 | Hierarchical supervisor-worker: **97.7%** of reflexive-topology accuracy at **60.9%** of its cost across four topologies on a 10,000-document corpus | [arXiv:2603.22651](https://arxiv.org/html/2603.22651v1) |
| 17 | Debate has weak-to-negative scaling: accuracy peaks at 2 rounds, can underperform majority vote; sycophancy collapses disagreement to *below* single-agent accuracy | [arXiv:2510.20963](https://arxiv.org/html/2510.20963v2), [arXiv:2509.23055](https://arxiv.org/abs/2509.23055) |
| 18 | Deployment Simulation validated at **1.3M conversations**, median **1.5×** multiplicative error; simulated traffic flagged as "evaluation-like" only **5.1%** of the time vs near-100% for benchmarks; caught a real pre-release issue benchmarks missed | [OpenAI, Jun 2026](https://www.marktechpost.com/2026/06/16/openai-deployment-simulation/) |
| 19 | Only **28%** of organizations can trace an agent action to a human sponsor; 47% of non-human identities go unrotated for over a year | [CSA](https://labs.cloudsecurityalliance.org/research/csa-whitepaper-nonhuman-identity-agentic-ai-governance-v1-cs/) |
| 20 | >40% of agentic AI projects projected cancelled by end of 2027 — attributed to governance, not capability | [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027) |

**The cross-cutting pattern, and the single most portable finding in the whole scan:** every
task category that agents do well has an external, mechanically-checkable oracle. Every category
they do badly lacks one. That is the same structural fact as the verification gap, restated at
the level of job function — and it is why this design puts an oracle behind every blocking gate
and a human behind every gate that cannot have one.

---

## 15. What we do not know yet

Stated plainly, because a design document that only lists its evidence is a sales deck.

1. **Whether a staffed org beats one strong agent on real repository work at all.** Every
   budget-normalised study we found says probably not by default. The solo baseline exists
   because we expect to lose some of these comparisons and want to find out in public.
2. **Whether the five-lane review fan-out is worth it.** Deferred, flagged, unmeasured. It may
   turn out one combined reviewer at a bigger model beats five specialists.
3. **Whether tier-by-absence-of-oracle survives contact with data.** It follows logically from
   the oracle finding; it has not been measured per role by anyone, including us.
4. **Whether 8 turns is the right re-anchoring cadence.** It is inside the observed 10–15-turn
   drift window. That is a rationale, not a measurement.
5. **Whether the mutation-score gate is safe to make blocking.** Mutation runners are slow and
   flaky on some stacks. It ships advisory and gets promoted per repo only after the false-block
   rate is measured.
6. **Whether the `architect` role's declared invariants are actually checkable in practice.** The
   idea converts the least automatable role's output into the most automatable gates' input, and
   no vendor ships an architect role, so there is no prior art either way. This is the most
   interesting bet in the document and the least supported.
7. **What the real human time cost per run is.** The design asserts 2–5 minutes per gate. Nobody
   has measured that for an evidence packet of this shape, because nobody ships one.
8. **Whether roles authored independently capture the gains at all.** Jointly-trained agents
   took accuracy from 16.00 to 96.00 in one controlled study, while independently-authored
   specialists combine only marginally better than a generalist. Our roles are authored
   independently, in markdown, by humans. The rehearsal gate (v3) is the only mechanism we have
   for catching the integration failures that implies.
9. **Whether `governance: autopilot` should exist.** It is in the schema and will never be a
   default. We are not yet convinced it should be reachable.

If the numbers come back against any of these, the honest move is to say so in this file and
demote the feature — the same discipline the Right to Solo imposes on the org itself.
