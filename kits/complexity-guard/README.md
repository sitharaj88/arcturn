# complexity-guard

Three agent roles, one pipeline and one slash command for growth-rate review
and measurement-disciplined optimization — where every complexity statement is
either traced to a file and a line or measured at three sizes with its table
pasted, and the role that states the number is never the role that wrote the
code.

The pipeline can refuse to do its own job, and that refusal is the most useful
thing it produces: when the top hotspot's ceiling sits below the noise floor
measured on your machine, it halts before the write-lane role is ever
dispatched. Nothing in this kit approves, commits, tags or pushes anything.

---

## Install

```bash
arcturn add sitharaj88/arcturn/kits/complexity-guard
```

That is the GitHub `owner/repo/subdir` shorthand: Arcturn clones the repo, uses
`kits/complexity-guard` as the package root, pins the resolved commit in
`.arcturn-install.json`, and links three roles into `~/.arcturn/agents/`, one
pipeline into `~/.arcturn/workflows/` and one skill into `~/.arcturn/skills/`.

To read what an install would add before running it:

```bash
arcturn inspect sitharaj88/arcturn/kits/complexity-guard
```

From a clone, the local-path form installs your edited copy — which is also the
loop for forking any of these files:

```bash
arcturn add ./kits/complexity-guard
arcturn remove complexity-guard
```

Then `/scaling-check` is available in your session, `/workflow list` shows the
pipeline, and `/team --roles perf-analyst` resolves a role as a team specialist.

## The pipeline

```
/workflow complexity-gate  <the module, path or entry point you think is scaling
                            badly, and the workload you care about>
```

| Pipeline | Stages | What it does | What it refuses to do |
|---|---|---|---|
| `complexity-gate` | 4 stages (4 steps), `budgetUsd: 15`, `stepTimeoutMs: 1800000` | Tags every growth-rate candidate `DERIVED` or `MEASURED` and dismisses the bounded ones with their bounds, measures the noise floor and the Amdahl ceiling on your hardware, turns one hypothesis into one change, then adjudicates that change interleaved inside a single worktree. | Optimize when it cannot measure. Stage 2 halts when no harness can be built, and halts again when the top hotspot's ceiling is at or below the measured floor — at which point stage 3 is never dispatched at all. It also refuses to name a growth class the reachable sizes do not separate: that verdict is `NOT-SEPARABLE-AT-THESE-SIZES` and it names the n that would decide. |

## The command

| Command | What it does | What it refuses to do |
|---|---|---|
| `/scaling-check` | Reads timings taken at several input sizes — a table, a benchmark's own output, a CSV or JSON path — and says which growth class the numbers support, using the span ratio rather than a single doubling because the gap between `n` and `n log n` per doubling is only `1 / log₂ n`. | Name a class the data does not separate. With more than one class still admitted the verdict is `NOT SEPARABLE`, listing the survivors and printing the size that would decide (for the hard pair, `N > n₀^(1+d)`). It refuses a curve from fewer than three distinct sizes or from sizes with no repeat count — it prints the scan that would supply them and stops — and it refuses to read the implementation and name a class from it, because that is the reviewer's `DERIVED` lane and mixing the two is how a guess acquires a measured look. |

## The roles

| Role | Produces | Tier | Tools | Lane (derived) | The one thing it must never do |
|---|---|---|---|---|---|
| `complexity-reviewer` | `COMPLEXITY-LEDGER` | sonnet | `read, grep, glob, ls, search_code, bash` | **exec** | State a complexity without a tag. Every claim is `DERIVED` (a path a reader walks, every hop addressed) or `MEASURED` (three or more sizes, ratio table pasted); neither tag means no claim is made |
| `perf-analyst` | `BASELINE`, `ADJUDICATION` | sonnet | `read, grep, glob, ls, bash` | **exec** | Report a mean without its dispersion and repeat count, or call a delta inside the noise a speedup. Below the MDE the sentence is "indistinguishable at this harness's resolution" |
| `optimizer` | `CHANGE-RECORD` | opus | `read, write, edit, bash, grep, glob, ls` | **write** | Touch the instrument. Editing the benchmark, the fixture, the input sizes or the measurement contract is a stop, not a fix — and it states no performance number at all, even one it observed |

**The Lane column is derived, not declared.** `roleDispatch`
(`packages/cli/src/workflow.ts`) reads a role's `tools:` line: any of
`write`/`edit`/`multiedit` lands it on **write**, `bash` without those lands it
on **exec**, and neither lands it on **read**. `arcturn inspect` prints the same
derivation, and `web/scripts/hub.test.ts` re-derives it from the engine's own
tool-set literals when it checks this pack's registry entry — a lane typed by
hand fails that suite.

**Two lanes, not three.** RFC 0003 §3 introduces this pack as the catalog's
first three-lane kit. The tool lists §2.3 specifies do not produce that: two
roles hold `bash` without a writer and one holds `write` and `edit`, so the
engine derives **exec, exec and write**, and no role here lands on the read
lane. The pipeline's step lanes are `read=0 write=1 exec=3`. The claim the pack
actually rests on is narrower and is true: the role that can change your
checkout holds no authority to state a number, and the role that states the
numbers holds no authority to change anything. That is checkable from `tools:`
alone, which is why it is worth stating instead of the wider claim.

Every role file carries the same spine: mission, method, definition of done, an
explicit `Never` list, and a fixed output envelope beginning
`ARTIFACT: <TYPE>`. Each ends with the halt convention — *if the input contains
`ORG-HALT`, re-emit that line verbatim and stop* — so an upstream halt walks
intact into the final packet, and every step in the pipeline repeats the clause
in its own prompt.

**Tiering follows absence of an oracle, not seniority.**
`complexity-reviewer` and `perf-analyst` run a tier down and loop more
(`maxTurns: 60` each) because both are graded mechanically and both spend their
turns on repetition rather than on judgment: the reviewer's claims are a path a
reader opens or a ratio table a reader reruns, and every line the analyst
writes carries the command, the repeat count and the dispersion that produced
it. `optimizer` sits on the flagship tier at `maxTurns: 40` for the opposite
reason. Its diff is graded by the correctness suite it must run — but only to
the extent that suite covers the path it changed, and this pack forbids it from
touching the suite. What is left over is a judgment with no oracle inside this
run: whether the transformation preserves behaviour on the input shapes nobody
wrote a test for. That is the residual P4 tiers up, and it is also the only
role in the pack whose output reaches your checkout.

## Why the numbers, and not the reading

RFC 0003 §2.3 records the published asymmetry this pack is built on: models
predict time complexity at roughly **64%** against human labels and *measure*
it at **92%**, and agents reach under **0.23×** expert speedup while failing
specifically at localization and correctness. So the pack automates the
measuring and gates the asserting — an untagged big-O is not an allowed output
of any role here.

The second load-bearing figure is the noise floor. The same section records
**2.66%** coefficient of variation on shared CI runners, which makes a 2%
regression gate false-alarm about **45%** of the time. A threshold nobody can
calibrate trains a team to ignore the gate, which is why this pack ships no
threshold: `perf-analyst` measures the floor on *your* hardware, with your
editor and your daemons running, converts it into a minimum detectable effect
with the formula and its inputs printed, and compares every delta against that
rather than against zero.

RFC 0003 §4.8 rejects the CI perf-budget gate and the change-point detector
over benchmark history for the same reason, and rejects `/big-o` as a function
annotator outright: an unaided asymptotic assertion is wrong about a third of
the time, and an annotation nobody can check outlives the code it describes.

## Three mechanical facts this kit rests on

**Refusing to optimize costs the write role its turn.** When stage 2 finds the
top hotspot's Amdahl ceiling at or below the MDE it measured, it emits
`ORG-HALT`. A fatal halt short-circuits every later stage, so `optimizer` is
never dispatched — not gated, not asked to behave, never given a turn. The same
holds when no harness can be built. This is the shape the RFC's *"refusing to
optimize is the pipeline's most valuable output"* takes in the engine: a run
that ends at stage 2 with two numbers and a reason is the correct outcome, and
it is also the cheapest one.

**A/B never crosses a worktree.** Every lane worktree is created from `HEAD`,
brought up to the run's accumulated state and committed inside itself — and the
seeding respects the checkout's own ignore rules, so `node_modules/`,
`target/`, `build/`, `DerivedData` and every warm cache stay out (see
`createRuntimeWriteLane`'s seeding notes in `packages/cli/src/workflow.ts`).
Each stage therefore builds cold, with a different cache state and different
neighbours on the machine. A stage-2 baseline and a stage-4 candidate are two
different machines wearing one hostname, so stage 4 reconstructs both arms
inside its own worktree — reversing the change record's verbatim diff with
`git apply -R` — and interleaves them A, B, A, B in one session. That is why
`optimizer` is required to paste its diff, and why a diff too large to paste is
a sign it bundled two hypotheses.

**The instrument is the thing you must not touch.** The benchmark, the fixture,
the sizes, the repeat counts, what is timed and the correctness suite are all
off limits to the only role that can edit anything. When the hypothesis cannot
be tested without moving one of them, that is a halt with no edit made, and the
proposal goes into the record as text for a person. The reason is arithmetic
rather than principle: an A and a B measured through two different instruments
share a unit and nothing else.

## Sequencing, and why there is no parallel stage

`complexity-gate` is fully sequential and each stage genuinely needs the last:
candidates with their n-sources, then a floor and a ceiling, then one change,
then a verdict measured against that floor. There are no parallel branches in
this pipeline, so there is no scope partition to declare — the disjointness
question §5.4 asks does not arise here.

Under plan mode the run fails at stage 1 before a token is spent. Every step
dispatches on the exec or write lane and plan mode has neither — the write
lane's patch reaches your checkout and the exec lane's shell is real even
though its worktree is discarded, and plan mode promises a session with no
prompts and no egress. `/workflow` names all three roles in its pre-flight
warning, and the first step is then refused rather than run. Under an ordinary
permission mode the same pre-flight warns that the run will stop for your
approval as those steps come.

The pipeline ends at a person in a `DECISION-REQUEST` block rather than an
`ORG-ASK`. A question at the final stage buys nothing — there is no later stage
for an answer to be spliced into — and on resume the engine *replaces the asking
step's output text with the answer*, so pausing at the end would overwrite the
adjudication packet with a sentence. Where an `ORG-ASK` earns its place is
mid-pipeline on a role that leaves nothing behind, which is `design-review-org`
stage 3, and this pack has no read-lane role to put one on.

## Composition

These three role names are chosen not to collide with `enterprise-org`'s eleven
(`pm`, `architect`, `tech-lead`, `developer`, `qa-functional`, `qa-adversarial`,
`security-reviewer`, `ux-reviewer`, `docs-writer`, `release-manager`, `retro`)
or with `design-review-org`'s five (`design-author`, `codebase-critic`,
`invariant-oracle`, `impact-analyst`, `design-lead`). `complexity-gate`
collides with none of the eight pipeline names those two kits ship, and
`/scaling-check` collides with none of the eleven skill names in
`starter-skills`, `plan-pressure-tests` or `mobile-ground-truth`. Install all
five side by side and nothing shadows anything: a name collision resolves
silently to the later root, and a warning is not a design.

`complexity-gate` names no role from another package, and that is structural
rather than stylistic: `@role` resolves against the loaded agents **before** the
pipeline's first step runs, so a cross-pack reference would fail the whole run
at load for anyone who installed one pack and not the other.

Where the kits meet:

- **`design-review-org`** reviews a design before the code exists and ends at a
  decision record. This one starts from code that already runs and ends at a
  measurement. `invariant-oracle` proves a check *bites* by planting a
  violation; `perf-analyst` proves a difference is *resolvable* by measuring the
  floor first. Same discipline, two different oracles.
- **`enterprise-org`**'s `refactor-guard` is the natural next pipeline for a
  change this one adjudicated as `SEPARATED-IMPROVEMENT`, and its `developer` is
  the other write-lane role you might have installed — note that it and
  `optimizer` are the only two roles across the whole catalog that can change a
  file in your checkout.
- **`plan-pressure-tests`** reads plans; `/feasibility-read` ends by naming the
  one spike worth running, and a `complexity-gate` run is frequently that spike.

`design-docs`, the other wave-2 pack (RFC 0003 §2.1), ships four skills and
none of them is named `scaling-check`.

`/scaling-check` deliberately overlaps `complexity-reviewer`'s `MEASURED` tag,
the way `starter-skills` overlaps `enterprise-org`'s `docs-writer`: the skill is
the solo path to the same table when you already have timings and do not want a
four-stage run. Both apply the same separation rule and neither may bend it.

## Honest limits — where this kit's guarantee stops

| Limit | Why it is there | What actually holds |
|---|---|---|
| **These role files instruct a model; they do not constrain it.** Every `Never` list in this pack is prompt text | A role file is markdown. Nothing validates that a role obeyed its own refusal, counted its repeats honestly, or really ran the command it pasted | The lane derived from `tools:`, which the dispatcher applies before the role's first token, and the [permission engine](https://arcturn.dev/docs/permissions), which does not read prompts at all |
| **Stage 3's change lands in your checkout before stage 4 has judged it** | The write lane captures the role's diff, audits every path in it and replays it into the real checkout with plain `git apply` when the step succeeds. That is what the write lane *is* | The change is one hypothesis, uncommitted, with its verbatim diff in the record. `git diff` shows it and `git checkout --` reverts it. No step in this pack commits, tags, pushes or opens anything |
| **An `ORG-HALT` does not un-write an edit already made** | The engine classifies a step *after* it completes, by reading its output text — so a patch the lane already minted and applied has already landed, halt or no halt. The rule that keeps this from mattering ("decide before you edit, and revert your own edit before halting") is prompt text | The patch is uncommitted in your tree, and `/workflow status` names the step that halted. If you want a pass that writes nothing at all, run `/scaling-check` on timings you already have |
| **The exec lane protects your checkout, not the world** — and benchmarking is where that gap is widest | It guarantees the two exec-lane roles' diffs never reach your tree. It says nothing about CPU frequency scaling, thermal throttling, the page cache, a shared database, a container's CPU quota, or the other processes on this machine — all of which move a timing | Their deny lists are prompt text. `config.sandbox` and the permission engine are the layers where that constraint is expressible somewhere it is enforced. Measuring the floor *on this machine, in this session* is the pack's answer to the part nothing can fence |
| **The noise floor is a measurement of one machine at one moment** | It is measured with your editor, your browser and your daemons running, which is deliberate — that is the machine the number will be used on | Re-measure rather than reusing yesterday's floor, and treat a floor measured on a laptop on battery as a different instrument from the same laptop on mains |
| **The MDE rests on an assumption the data may not meet** | `MDE ≈ 2.8 × cv × sqrt(2/n)` is the two-sample rule of thumb at 80% power and α = 0.05, and it assumes roughly normal, independent repeats. Garbage collection, JIT warm-up, a page-cache transition and thermal drift produce bimodal or autocorrelated timings that break both assumptions | The formula and its inputs are printed so a reader can recompute or reject it, and the role is instructed to report the distribution rather than a mean when it is visibly not normal. That instruction is a rule, not a validator |
| **`NOT-SEPARABLE-AT-THESE-SIZES` names a size this pack often cannot reach for you** | Separating `n` from `n log n` needs a span, and the deciding size may be one your fixture will not build, your memory will not hold, or your patience will not wait for | The verdict names the size anyway, because "not separable, and not separable on this machine" is a complete answer and a named class would not be. Building a bigger fixture is a person's decision, and the roles are forbidden from making it |
| **A growth class is not a performance verdict** | Constants and cache behaviour decide real workloads. An `O(n log n)` with a large constant loses to an `O(n²)` at the n you actually run | The pack reports both, separately: the reviewer's class with its tag, and the analyst's measured delta with its dispersion. Neither answers the other, and collapsing them is the mistake both halves exist to prevent |
| **`{{prev}}` is unfenced** | A whole previous stage is spliced verbatim into the next prompt — including a pasted diff, benchmark output and whatever a fixture printed | "The measuring role holds no writer" is a claim about **capability**, never about content. `taint.ts` and `canary.ts` exist in this tree with integration notes and are not wired into `runtime.ts`; until they are, the content half of that invariant is not claimable and this README does not claim it |
| **Budgets and step timeouts are ceilings, not measurements** | `budgetUsd: 15` is set to catch a runaway loop. The 30-minute step ceiling is load-bearing rather than generous: a benchmark suite at three sizes with repeats is exactly the step the 10-minute default (`DEFAULT_WORKFLOW_STEP_TIMEOUT_MS`) cuts off mid-flight, and a scan aborted mid-flight is the input that produces a confident wrong number | Run the pipeline once, read the real spend off `/workflow status`, and set your own |
| **No frontmatter in this pack pretends to be enforcement** | `agents.ts` parses exactly `name`, `description`, `tools`, `model` and `maxTurns`. `writes:`, `reads:`, `consumes:`, `produces:` and per-role `budget:` are parsed by nothing, and `multiedit` is in the engine's `WRITE_TOOLS` but absent from `BUILT_IN_TOOL_NAMES`, so declaring it advertises authority the role never receives | These three files declare only the five keys that are read, so there is no field in this pack that looks like a boundary and is not |
| **A listing is not an audit** | The hub entry's disclosure block is re-derived from these files by `web/scripts/hub.test.ts`, so it cannot drift. That checks that the page and the install agree — nothing more | Run `arcturn inspect` against the source you are about to install, and trust that over any page |

Two limits are not going away, and should not:

**No step in this kit decides whether to keep the change.** Stage 4 ends in a
`DECISION-REQUEST` naming who decides and what the evidence supports.
`VERDICT: ADVISORY` is the only verdict value in the pack, there is no
`APPROVED` anywhere in it, and nothing in it merges, commits, tags, pushes or
publishes.

**No model judgment is a blocking claim.** Only a number with its command, its
repeat count and its dispersion, or an address a reader can open, is allowed to
rank first. Everything else is labelled as a reading, including the readings
these roles write about their own results.

## Validating your copy

Every file in this directory parses through the parsers the runtime itself
uses. To prove it in your checkout:

```js
// scratch.mjs — run with: node scratch.mjs
import { loadAgentDefs } from "./packages/cli/dist/agents.js";
import { parseWorkflow, roleDispatch } from "./packages/cli/dist/workflow.js";
import { BUILT_IN_TOOL_NAMES } from "./packages/cli/dist/runtime.js";

const warnings = [];
const defs = await loadAgentDefs(["kits/complexity-guard/agents"], warnings, BUILT_IN_TOOL_NAMES);
console.log(defs.length, "agents,", warnings.length, "warnings");
for (const def of defs) console.log(def.name, roleDispatch(def));
```

Result at the time of writing (`packages/cli/dist`, 3 agents, 1 workflow,
1 skill):

```
=== AGENTS: loadAgentDefs(kits/complexity-guard/agents) ===
files on disk: 3  parsed defs: 3
  ok  complexity-reviewer  model=tier:build  prompt=10776ch  lane=exec   maxTurns=60  tools=[read,grep,glob,ls,search_code,bash]
  ok  optimizer            model=tier:judgment    prompt= 8303ch  lane=write  maxTurns=40  tools=[read,write,edit,bash,grep,glob,ls]
  ok  perf-analyst         model=tier:build  prompt=11842ch  lane=exec   maxTurns=60  tools=[read,grep,glob,ls,bash]
agent loader warnings: none

=== SKILLS: loadSkills(kits/complexity-guard/skills) ===
  ok  /scaling-check  desc=152ch  prompt=6598ch  $ARGUMENTS-substituted=true  $CWD-substituted=true
skill loader warnings: none

=== WORKFLOWS: parseWorkflow(kits/complexity-guard/workflows) ===
  ok  complexity-gate  stages=4  steps=4  parallel-stages=0  continueOnError=false  budgetUsd=15  stepTimeoutMs=1800000  role-steps=4 (read=0 write=1 exec=3)  anonymous-steps=0

unresolved @role references: none
```

`role-steps=4 (read=0 write=1 exec=3)` is `roleDispatch()` computed for real
over every `@role` step in the file. Exactly one step in this pipeline runs on
the write lane, and it is the only role in the pack that never states a number.
That ratio is checkable from `tools:` alone, which is the point of stating it.

`arcturn inspect ./kits/complexity-guard` prints the same three lanes, the
same stage count and budget, and `No extensions: this package ships no
executable code.` The registry entry at `registry/complexity-guard.json`
carries `"executable": false`, and `npx vitest run web/scripts/hub.test.ts`
checks that claim against the absence of an `extensions/` directory rather than
taking the entry's word for it.

## Editing the kit

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
`agents/` fails the whole run before stage 1 spends a token, exactly like an
unknown model tag.

Every role in this kit declares `tools:` explicitly, and yours must too: an
omitted list is refused at dispatch rather than defaulting to the read lane — it
used to mean "everything the session allows", which is the widest grant in the
system. If you add a role, run the loader snippet above and confirm the
warnings array is still empty; a dropped tool name is a warning, not an error,
and `multiedit` is the one this catalog trips on.

If you change `optimizer`'s tools, check what you did to its lane before you
commit it. Dropping `write` and `edit` moves it to exec and its patch stops
reaching your checkout; adding `write` to either analyst moves *that* role to
the write lane and the pack's one real guarantee is gone.

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
