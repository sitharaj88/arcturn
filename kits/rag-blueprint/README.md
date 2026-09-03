# Arcturn RAG Blueprint — build a retrieval system you can defend

Eight markdown roles (`agents/`), two deterministic pipelines (`workflows/`)
and three skills (`skills/`) for building and auditing production retrieval
systems — **on the stack your organization already runs**.

There is no new runtime here and nothing to build. Every file parses through
the same `loadAgentDefs` and `parseWorkflow` the CLI uses, and the validation
at the bottom of this README is a script you can paste with the output it
actually printed.

Arcturn does not become part of the system it builds. The code and the
evaluation suite land in your repository, in your languages, under your
review; these workflows stay behind as the thing that keeps them honest.

---

## SCRATCH-CORPUS-ONLY — read this before running the drills

The red-team drills **write documents into a corpus**: planted injection
payloads, poisoning documents, cross-tenant probes. They need a **disposable
index and a non-production credential**, and `rag-red-teamer` refuses with
`NO-ORACLE: no scratch target` unless it can confirm both from a config file
it read this session.

Take that refusal seriously rather than working around it. **Nothing in this
kit can tell a scratch index from a live one.** The exec lane guarantees the
red-teamer cannot change your *checkout*; it says nothing about an API call,
and no lane sits between a shell and a control plane. Point these pipelines at
a copy of the corpus, with a credential that can only reach it.

---

## Install

```bash
# project-scoped (recommended — the kit travels with the repo)
mkdir -p .arcturn/agents .arcturn/workflows .arcturn/skills
cp kits/rag-blueprint/agents/*.md     .arcturn/agents/
cp kits/rag-blueprint/workflows/*.md  .arcturn/workflows/
cp kits/rag-blueprint/skills/*.md     .arcturn/skills/

# or user-scoped, available in every repo
cp kits/rag-blueprint/agents/*.md     ~/.arcturn/agents/
cp kits/rag-blueprint/workflows/*.md  ~/.arcturn/workflows/
cp kits/rag-blueprint/skills/*.md     ~/.arcturn/skills/
```

In VS Code: **Hub → rag-blueprint → Install**.

## Run

```bash
/workflow rag-setup support agents answer from our runbooks and macros, respecting per-team document permissions
/workflow rag-review the assistant in services/search — it answers from Confluence and the ticket DB, unmeasured
```

Or reach one skill directly, without a pipeline: `/rag-architecture`,
`/rag-eval-suite`, `/rag-threat-drills`.

---

## What `rag-setup` does

| Stage | Role | Lane | Tier | What it produces |
|---|---|---|---|---|
| 1 | `rag-surveyor` | read | fast | Sources, formats, ACL model, cadence, infra, constraints — gaps marked UNKNOWN |
| 2 | `rag-threat-modeler` | read | judgment | Threats with blast radius, demanded mitigation, and the drill that proves each |
| 3 | `rag-architect` | write | judgment | The ADR, written to `docs/adr/rag-architecture.md` |
| 4 | `rag-builder` | write | build | Ingestion 1/3: source connectors, per-format chunking, chunk-window and table-intact tests |
| 5 | `rag-builder` | write | build | Ingestion 2/3: redaction pass and chunk provenance keyed to parent-doc id |
| 6 | `rag-builder` | write | build | Ingestion 3/3: index update and deletion propagation by parent-doc id, deletion-within-bound test |
| 7 | `rag-builder` | write | build | Retrieval 1/2: query rewriting, multi-turn condensation, the retrieve-k → rerank-n cascade |
| 8 | `rag-builder` | write | build | Retrieval 2/2: entitlement filter, entitlement-keyed cache, model routing, the two entitlement tests |
| 9 | `rag-builder` | write | build | Observability 1/2: per-query cost/token by routing class and cache hit, latency decomposed |
| 10 | `rag-builder` | write | build | Observability 2/2: retrieval-quality and freshness signals, eval-facing logs, no-credential-in-logs test |
| 11 | `rag-builder` | write | build | The entry point: the spec's commands, flags and env as a `bin`, reusing the ingestion, retrieval and observability modules already built, credential-gated and proven with one real run against the corpus |
| 12 | `rag-eval-author` | write | build | The suite, the labelled set, the thresholds — **no shell** |
| 13 | `rag-red-teamer` ∥ `rag-eval-runner` | exec ∥ exec | judgment ∥ build | Drills with reproductions ∥ measured numbers |
| 14 | `rag-lead` | read | build | The go-live packet and one DECISION-REQUEST |

`rag-review` is the same discipline pointed at a system that already exists:
survey → threat model → build the missing suite → measure and attack in
parallel → a ranked fix list split BLOCKING / HIGH / COST.

### Three structural choices, and why

**Writes are single-threaded.** Every write-lane step's diff is replayed into
your checkout with `git apply` — never a three-way merge — so two *concurrent*
steps over one file fail at apply time; the build steps run one after another,
each worktree seeded from the last, so a later step extends what an earlier one
landed. The three build slices also have a real dependency order: retrieval
must match the schema ingestion created, and observability instruments both.
Each slice is cut into two or three small steps (ingestion 4–6, retrieval 7–8,
observability 9–10) so that no step is scoped as an entire subsystem in one
turn budget — the defect that made this stage retry three times before it was
re-sized. Stage 11 wires the entry point the spec names — the commands, flags
and env, as a `bin` — on top of those three slices rather than reimplementing
them, refuses to start without the credential the ADR names, and proves
itself by running once against the real corpus before the eval author ever
sees the repository. Stage 13's two branches are the only parallel pair, and
they are
**disjoint by construction**: both hold `bash` with neither `write` nor
`edit`, so both are on the exec lane, neither can land a change, and there is
no shared scope to partition.

**The ADR is carried by a file.** `{{prev}}` holds only the immediately
previous stage, so an ADR that lived only in step output would be gone by the
time the eval stage needs its thresholds — and a stage that cannot read its
thresholds invents them and reports PASS against its own invention. Stage 3
writes the file; later stages read it.

**The gate's author cannot run it.** `rag-eval-author` holds `write` and no
shell; `rag-eval-runner` holds the shell and no writer. One writes the
labelled set and the thresholds, the other runs the suite and reports — so no
role can edit the gate it is judged by, and the runner emits
`ORG-HALT: oracle tampered with` if the set changed during its own run.

### Under plan mode

Both pipelines stop at their first write-lane step: `rag-setup` at stage 3
(after the survey and threat model), `rag-review` at stage 3. The refusal
fires at dispatch, not before the run, so you pay for the earlier stages.

## What it designs against

The failure modes are named in the roles, not left to the model to remember:
query-side condensation for multi-turn (the dominant production shape);
chunking per format checked against the embedder's context window; the
retrieve-k → rerank-n cascade with the reranker's **per-candidate** cost in
the arithmetic; entitlement filtering at query time with its **recall cost**
stated and measured for a low-entitlement identity; a semantic cache keyed to
include entitlement, because a cache keyed on the query alone serves one
user's answer to another **past a correct filter**; deletion propagation
including orphan chunks; incremental re-embedding by content hash and the
dual-index cutover a model change actually requires.

## Costs and caps

`budgetUsd:` is 40 for `rag-setup` and 20 for `rag-review`. **Raise it, or
delete the line for no cap** — `0` and absent both mean unlimited. These are
ceilings set to catch a runaway loop, not measurements: run once, read the
real spend off `/workflow status`, and set your own. `rag-setup` also carries
`budgetTokens: 60000000` — a 60,000,000-token run ceiling that still fires on
a model with no published pricing (a coding-plan endpoint, a local server),
where a dollar ceiling never can.

---

## Honest limits — where this kit's guarantee stops

| Limit | What actually holds |
|---|---|
| **These role files instruct a model; they do not constrain it.** Every "Never" line in this kit is prompt text, and nothing validates that a role obeyed one | The lane derived from `tools:`, applied by the dispatcher before the role's first token, and the permission engine, which does not read prompts at all |
| **The exec lane protects your checkout, not your index.** The red-teamer cannot change your tree; it can still reach any endpoint the environment can | The credential you give it. That is the whole answer, and it is why SCRATCH-CORPUS-ONLY is the first section in this file |
| **`{{prev}}` is unfenced, and this kit's inputs are attacker-adjacent** — a whole stage is spliced into the next prompt, including document names and retrieved text your organization did not write | Nothing in the prompt layer. `taint` and `canary` guard the *Arcturn agent*'s own tool calls, and `canary` is off by default; they do nothing for the RAG service being built |
| **Only five frontmatter keys are enforcement.** `agents.ts` parses `name`, `description`, `tools`, `model`, `maxTurns` — and a role's lane comes from `tools:` alone | Every role in this kit declares exactly those five, so there is no field here that looks like a boundary and is not |
| **The blocking gates are only as good as the labelled set**, and a set generated from the corpus scores the question generator | The human-validated core is the only part allowed to block; the generated remainder is advisory and the suite prints which is which |
| **Faithfulness is a model judging a model** | It is `ADVISORY` always, reported only after the runner hand-labels a sample and prints its own agreement rate. No model verdict blocks in this kit |
| **A per-cell rate over four pairs is noise** | Cells under 30 pairs report `NO-ORACLE: insufficient sample`, and every rate carries a confidence interval |
| **This kit has never been run end-to-end.** No transcript in this directory came from a real pipeline run | The validation below is real — it is a parse and dispatch check, and it is *only* that. Run the pipelines against your own scratch corpus before trusting any of it |

Two limits are not going away, and should not:

**No step in this kit decides anything.** Stage 14 ends in a `DECISION-REQUEST`
naming what a person is approving. Nothing here deploys, tags, publishes or
signs off, and the red-teamer's vocabulary contains no verdict that clears.

**No model judgment blocks.** Only a number a command printed — recall, MRR,
filtered recall, propagation time, cost, latency — sits on the blocking path.

## Editing the kit

The lane is the only real boundary, so **edit `tools:` deliberately**: adding
`write` to a read-lane role moves it to the write lane and its diff will reach
your checkout; adding `bash` to `rag-eval-author` destroys the split that
keeps the gate honest. Everything else in these files is prose that shapes a
model's behaviour, and prose can be improved freely.

Right-size `maxTurns` to the step, not to the subsystem. The build and eval
roles declare `maxTurns: 80`; the session clamps every subagent at
`subagentMaxTurns` (default 64) and a role file may only narrow that, so 80
resolves to an effective `min(80, 64) = 64` unless a deployment raises the
session ceiling, and a human's run-scoped raise at a parked run lifts both
halves. The ceiling's job is to trip a runaway loop, not to size honest work —
a step scoped this small finishes well under 64, so the real lever is keeping
steps small, not ceilings large. A slice scoped as a whole subsystem in one
step is the defect this kit was re-sized to remove; do not merge the build
steps back together.

If you add a role, re-run the validation below and the hub catalog build
(`node editors/vscode/scripts/build-catalog.mjs`) so the registry disclosure
cannot drift from the files.

---

## Validating your copy

```bash
node - <<'JS'
import { readFileSync } from "node:fs";
import { loadAgentDefs } from "./packages/cli/dist/agents.js";
import { BUILT_IN_TOOL_NAMES } from "./packages/cli/dist/runtime.js";
import { parseWorkflow, roleDispatch, isWorkflowParseError } from "./packages/cli/dist/workflow.js";

const warnings = [];
const defs = await loadAgentDefs(["kits/rag-blueprint/agents"], warnings, BUILT_IN_TOOL_NAMES);
for (const d of defs) {
  console.log(`${d.name.padEnd(20)} ${roleDispatch(d).padEnd(6)} ${String(d.model).padEnd(15)} maxTurns=${d.maxTurns}`);
}
console.log("role warnings:", warnings.length ? warnings : "none");

const names = new Set(defs.map((d) => d.name));
for (const f of ["rag-setup", "rag-review"]) {
  const raw = readFileSync(`kits/rag-blueprint/workflows/${f}.md`, "utf8");
  const r = parseWorkflow(raw, { name: f });
  if (isWorkflowParseError(r)) { console.log(f, "PARSE ERROR:", r.error); continue; }
  const shape = r.stages.map((s) => s.steps.length + (s.parallel ? "p" : "")).join(",");
  const refs = [...raw.matchAll(/(?:^|\s)@([a-z0-9-]+)/gm)].map((m) => m[1]);
  const unresolved = [...new Set(refs)].filter((n) => !names.has(n));
  console.log(`${f.padEnd(12)} stages=${r.stages.length} steps/stage=${shape} budgetUsd=${r.budgetUsd} unresolved-roles=${unresolved.length ? unresolved : "none"}`);
}
JS
```

What it printed here, verbatim:

```
rag-architect        write  tier:judgment   maxTurns=60
rag-builder          write  tier:build      maxTurns=80
rag-eval-author      write  tier:build      maxTurns=80
rag-eval-runner      exec   tier:build      maxTurns=80
rag-lead             read   tier:build      maxTurns=40
rag-red-teamer       exec   tier:judgment   maxTurns=50
rag-surveyor         read   tier:fast       maxTurns=40
rag-threat-modeler   read   tier:judgment   maxTurns=40
role warnings: none
rag-setup    stages=14 steps/stage=1,1,1,1,1,1,1,1,1,1,1,1,2p,1 budgetUsd=40 unresolved-roles=none
rag-review   stages=5 steps/stage=1,1,1,2p,1 budgetUsd=20 unresolved-roles=none
```

That is a parse, dispatch and reference check — it proves the files load, the
lanes are what this README claims, every tool name is real, and no step
references a role that does not exist. It proves nothing about behaviour.

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
