---
title: Workflows
description: Deterministic, file-defined multi-step runs — a markdown numbered list is the control flow, with the model filling in only the content.
section: Extend
order: 10.8
---

## Skills, agents, and workflows are three different levers

[Markdown skills](/docs/skills) are a prompt template a *user* invokes with a slash
command. [Sub-agents](/docs/sub-agents) let the *model* decide, mid-task, to delegate work
and shape that delegation itself. A **workflow** is the third lever: the control flow —
which steps run, in what order, sequential or fanned out in parallel, which model runs
each one — is fixed in a file, and the model only fills in the content of each step. Run
one with `/workflow <name> <args>`, and it executes the same steps, in the same order,
every single time.

## Where workflow files live

Exactly beside skills and agent definitions, user root scanned first so a project file can
override it by name:

```text
~/.arcturn/workflows/<name>.md         # user
<cwd>/.arcturn/workflows/<name>.md     # project (wins on a name collision)
```

`/workflow` re-discovers files on each invocation — a workflow added mid-session is picked
up with no restart needed.

## File format

```markdown
---
name: ship-fix
description: Reproduce, patch and review one bug report
continueOnError: false
stepTimeoutMs: 1800000
budgetUsd: 15
---
Optional prose here is documentation only and is ignored by the parser.

1. [anthropic/claude-haiku-4-5] Reproduce this bug and quote the failing output: {{input}}
2. Given the repro below, do both halves:
   - Write the minimal patch. Repro: {{prev}}
   - Write a regression test that fails before the patch. Repro: {{prev}}
3. Review the patch and the test for correctness. Work so far: {{prev}}
```

The grammar is strict, by design — a workflow is meant to be predictable, not merely
"usually parses":

- **Top-level numbered items** (`1.` or `1)`) are **stages**, run strictly in order, and
  must be numbered consecutively starting at 1.
- **Indented `-` bullets** under a numbered item are **parallel branches** of that stage —
  they all run concurrently, and their outputs are joined with a blank line in **written**
  order, never completion order, so the same file always produces the same pipe regardless
  of which branch happens to finish first.
- A numbered line carries either a prompt **or** branches, never both — unless it ends with
  `:`, which marks it as a label instead of a step.
- `[tag]` as a line prefix selects the model for that step (see below), and an optional
  `@role` prefix — written *after* `[tag]` when both are present — dispatches the step to a
  named markdown agent instead of an anonymous one (see [Named roles](#named-roles) below).
  `{{prev}}` expands to the previous stage's combined output. `{{input}}` expands to
  whatever text followed `/workflow <name>` on the command line.
- Everything else is a **parse error naming the line number**: an unknown `{{placeholder}}`,
  `{{prev}}` used in stage 1 (there is no previous stage), a top-level bullet instead of a
  numbered item, a `*`-style branch, prose that continues past one line (one line is one
  step — there are no continuation lines), or a non-boolean `continueOnError`.

Step ids are positional: `"2"` for a lone step in stage 2, `"2.1"`/`"2.2"` for its two
branches. Those are the ids `WorkflowStepResult.id` and the progress notices use.

Two optional frontmatter keys bound a run in the two dimensions that actually run away —
time and money:

- **`stepTimeoutMs`** is a per-step deadline, defaulting to 10 minutes. When a step reaches
  it the engine aborts that step's agent and records it `failed` with the deadline named in
  the error — an ordinary step failure, so it short-circuits later stages unless
  `continueOnError: true`. It is a backstop for a genuinely stuck step, not a substitute for
  writing commands that terminate.
- **`budgetUsd`** is a ceiling on the *whole run's* cumulative cost. The engine tracks spend
  across every step and aborts the run when it crosses the number, so a loop that keeps
  paying for the same failure stops on your terms rather than on your invoice. Omit the key
  and the run is unbounded, which is the pre-existing behaviour.

Both are validated at parse time: a non-numeric or negative value is a parse error naming
the line, not a silently ignored key.

## Model tags

Every `[tag]` in a workflow file is resolved **before the first step runs**, not lazily as
each stage starts:

- If the workflow uses a tag but no model resolver was supplied, the run fails immediately
  with `workflow uses model tag "[x]" but no model resolver was supplied`.
- If the resolver can't find the tag, the run fails with `unknown model tag "[x]" (step
  2.1)`.

Either way every step comes back `skipped` and total usage is zero — a workflow whose
*last* step names a dead model must not spend two paid steps first and fail on the third.
The CLI resolves tags through the same model catalog `/model` uses, so both a catalog id
(`anthropic/claude-haiku-4-5`) and a configured symbolic alias work as `[tag]`.

## Named roles

A step can dispatch to a **named markdown agent** instead of an anonymous one — the same
agent files `subagent agent:` and `/team --roles` already resolve, loaded from
`~/.arcturn/agents/<name>.md` and `<cwd>/.arcturn/agents/<name>.md` (see
[Sub-agents](/docs/sub-agents)). Write `@name` right after the optional `[tag]`:

```markdown
1. @architect Design the schema for: {{input}}
2. [anthropic/claude-opus-5] @developer Implement it: {{prev}}
```

`@role` is resolved twice, on purpose. `runWorkflow` resolves every role **before the first
step runs** — exactly like `[tag]` — so a typo'd `@architect` in stage 6 fails the whole run
before stage 1 spends a token, with `unknown role "@x" (step 6); known roles: …` naming
every role the host actually has loaded. The production step runner then resolves the same
name again for itself when it actually dispatches the step; the two are kept independently
resolvable so a host driving the step runner directly can override a role without rewriting
the parsed step.

A role name is lowercased and must match `[a-z0-9][a-z0-9-]*` — the same charset agent
files themselves are normalized to. Model precedence when a role is involved is
**`[tag]` beats the role's own `model:` beats the runtime's default**, identically on
either lane: an explicit tag on the step line always wins, a role with no tag falls back to
whatever `model:` its frontmatter sets, and a role with neither takes the same
`router.specFor("subagent")` default an untagged step would.

## The three dispatch lanes

A role's declared `tools:` decides *how* its step runs — not the session's permission mode,
and not which stage it's in. `ArcturnRuntime.createSubagent` always narrows a non-`yolo`
child to an investigative tool set (read-only tools plus `fetch`), so a role that needs to
mutate files — or merely *execute* something — could never do either through it outside
`yolo`. The two lanes below `createSubagent` exist to run unconditionally, in every
permission mode including `yolo`, precisely because that narrowing can never be widened for
them:

- **Read lane** — the role declares no tool from `write`, `edit`, `multiedit` or `bash`. The
  step runs through `createSubagent` exactly like an untagged step: fresh context by
  construction, no worktree, the parent's non-`yolo` narrowing intact, structurally unable to
  execute or touch anything, cost folded into the same running total.
- **Exec lane** — can run anything, can change nothing of yours: the role declares `bash`
  and none of `write`, `edit` or `multiedit`. The
  step runs in its own seeded `git worktree add --detach` (see *Seeded worktrees*, below),
  narrowed to exactly the role's declared tools, so a role that only reads and runs commands
  (a reviewer reproducing a bug, running a scanner, say) can genuinely do so. Its diff is
  **never captured and never applied** — not "typically comes back with nothing to apply," a
  structural guarantee regardless of what the step actually did. On success the worktree is
  simply removed; on failure or cancellation it is kept on disk, clearly labelled
  inspect-only, for forensics, but even that preserved copy is never replayed anywhere.
- **Write lane** — the role declares at least one of `write`, `edit` or `multiedit` (`bash`
  alongside those still counts as part of this lane, not a separate concern). The step runs
  in its own seeded `git worktree add --detach` (the same primitive [Teams](/docs/teams) and
  [Scouts](/docs/scouts) use), narrowed to exactly the role's declared tools, with `subagent`
  always stripped so a role can never spawn a role of its own. Its agent still inherits the
  parent session's current permission mode — the worktree changes *where* it runs, not
  whether a `write`/`edit`/`bash` call still goes through your permission engine, so
  `default` and `acceptEdits` prompt at each one just like any other delegated agent; only
  `yolo` runs a write- or exec-lane step unattended. When the step finishes, its changes are
  captured to a **patch file on disk** and replayed into your real checkout with a plain
  `git apply --check` then `git apply` — no `--3way`, no `--force`, so a patch whose
  context no longer matches is refused rather than force-merged. Before that replay, the
  engine also audits the patch's own target paths — an absolute path, a `..` segment,
  anything under `.git/` is refused outright; git's own hardening against a symlinked target
  directory (shipped since 2.39.2) is the second wall a patch has to clear, not the only one.
  Unlike `/team merge`, there is no separate confirmation step: a successful write-lane
  step's patch is applied immediately, before the step is reported done.

  A refusal fails the step and names the preserved patch path in the error rather than
  guessing at a resolution — resolve it yourself (`git apply --3way <patch>`) or re-run the
  step. The worktree itself is removed only on success; a failed or cancelled step keeps it
  on disk for forensics and says where.

A role that declares no `tools:` at all is **refused at dispatch**, not defaulted to the read
lane. An omitted list used to mean "every tool the session allows," which in a `yolo` session
made declaring nothing *more* permissive than declaring `read, edit` ever was — exactly
backwards from what a narrowing list is supposed to do. An org role must declare `tools:`
explicitly; an undeclared list is an authority grant nobody wrote down, and dispatch now says
so instead of guessing.

**Worktrees are seeded, not bare.** Both the exec and write lanes create their worktree from
the run's starting commit, replay every patch the run has already applied so far into it in
order, and commit that inside the worktree as its own detached starting point before the
role's agent ever sees it. A stage dispatched after an earlier write-lane stage is therefore
looking at what that earlier stage actually landed, not at the checkout from before the
pipeline began — and a write-lane role that commits its own work partway through a long step
loses nothing when the engine captures its diff, because capture always diffs against that
seed commit, never against bare `HEAD`.

Every write- or exec-lane step's output text carries a trailer line so a later `{{prev}}` can
tell what actually happened — and the trailer is not something a role's own text can forge.
Any line beginning `ARCTURN-PATCH:` that a step's agent writes itself is stripped before its
text is composed into the next stage's `{{prev}}`; the line that actually reaches a later
stage is appended by the engine, from a record it alone sets:

```text
ARCTURN-PATCH: status=applied role=developer step=3 files=2 patch=/Users/you/.arcturn/workflow-runs/…/3-developer.patch
```

`status` is one of `applied` (write lane, landed in your checkout), `refused` (write lane,
`git apply` said no; patch preserved, nothing changed), `empty` (write lane, the role changed
nothing — the correct outcome for a write-lane role whose brief never asked it to touch a
file), `discarded` (exec lane, always — the only status that lane ever reports on success,
regardless of what the step did) or `captured` (a write-lane step failed or was cancelled;
the diff was saved but never applied). A failed step carries the same trailer on its *error*
instead of its text, because the patch path is the one thing a human must not lose when a
step dies.

**Plan mode has no write lane and no exec lane.** A plan-mode parent promises a read-only
session with no prompts and no egress; a worktree that can execute arbitrary commands, or one
whose patch gets applied to your checkout, is neither. A pipeline that reaches a write- or
exec-lane step under plan mode fails that step immediately — before a single token is spent —
naming the role and telling you to approve the plan or leave plan mode and re-run.

## Running a workflow

```text
/workflow                          # list discovered workflows: name, stage/step counts, description
/workflow list                     # same
/workflow ship-fix the retry test flakes
                                    # runs ship-fix with "the retry test flakes" as {{input}}
/workflow status                   # every recent run: status, stage reached, turns, spend
/workflow status <run-id>          # one run, step by step, with the reason it stopped
/workflow resume <run-id>          # re-enter an interrupted run where it left off
```

## Runs survive the process that started them

Every step's terminal state is appended to a durable write-ahead journal *before* the run
moves on, which is what makes the last three commands meaningful. If a run is interrupted —
Ctrl+C, a crash, a closed laptop — `/workflow status` reads the journal back and tells you
exactly which stage it reached and why it stopped, and `/workflow resume` re-enters it there.

Resume is not a re-run. Completed steps are replayed from the journal rather than executed
again: no tokens are spent on them, and a write-lane patch that already landed in your
checkout is **not applied a second time** — the engine probes each recorded patch with
`git apply --check --reverse` to establish whether it is already present before deciding.
That property is the reason the journal exists; treat any resume that re-executes finished
work as a bug worth reporting.

If journaling was never possible at all — an unwritable state directory, say — the run
still executes normally and simply tells you at the end that it was not resumable. A
run that *was* journalling and then loses the ability to write is different, and is
reported as a durability fault, because from that point on the record no longer matches
what actually happened.

An untagged step, and any `@role` step on the read lane, runs as its own child agent
through `ArcturnRuntime.createSubagent` — inheriting the parent's permission mode, stored
permission rules, and hook/checkpoint/canary tool wrapping — with its cost folded into the
parent run's own cost accounting, so a workflow doesn't need any special cost-tracking of
its own. By default such a step's tools are narrowed to the runtime's non-`yolo` read-only
set; that can only ever be narrowed further, never widened, per step. A `@role` step on the
write or exec lane instead runs in its own isolated, seeded worktree, as described above —
its cost still folds into the same running total, but its tools come from the role's own
`tools:`, not from the parent's narrowing, and its turn ceiling is `def.maxTurns` clamped to
the session's own `subagentMaxTurns`, in both lanes alike.

## Failure and cancellation semantics

These are the contract worth knowing before relying on a workflow for anything that
matters:

- **Parallel branches always run to completion.** A sibling branch failing does not cancel
  branches already in flight — those tokens are already spent, and a partial result may
  still be useful.
- **A failed stage short-circuits every later stage**, reported as `skipped` (no
  timestamps, zero usage). Set `continueOnError: true` in the frontmatter to disable the
  short-circuit — the run still ends `failed` overall, and `error` still names the *first*
  failure, so a caller can never mistake a `continueOnError` run for a clean one.
- **`{{prev}}` only ever carries what the stage actually produced.** An all-failed
  `continueOnError` stage hands the next stage an empty string, never stale text carried
  over from an earlier stage.
- **Ctrl+C (`SIGINT`) aborts a run in progress**: in-flight steps are marked `cancelled`,
  everything not yet started is marked `skipped`, and the overall run status is
  `cancelled` — kept distinct from `failed` because nothing actually went wrong.
- **`runWorkflow` never rejects.** A step runner that throws becomes a failed step carrying
  the error's text; every other problem surfaces as a non-`"done"` `WorkflowRunResult`.
  This mirrors `Agent.prompt`'s own contract of surfacing errors as a terminal event, not a
  thrown exception.
- **A write-lane step never loses work on failure.** Its diff is captured to a patch file
  *before* any teardown decision, so a role that crashes, hits its turn ceiling, or gets
  cancelled by `SIGINT` still leaves its partial change on disk with an `ARCTURN-PATCH:
  status=captured` trailer on the error — nothing is applied to your checkout, but nothing
  in the worktree is thrown away either. An exec-lane step that fails or is cancelled keeps
  its worktree on disk the same way, clearly labelled inspect-only — but there is no patch to
  capture in the first place, because that lane never captures one, on success or on failure.
- **Determinism is the point.** Output concatenation is always written order (not
  completion order), step ids are positional, and nothing in the module reads the wall
  clock except through an injectable `now()` — the same workflow file with the same
  `{{input}}` produces the same shape of run every time, even though the model's actual
  words will vary.

## A complete worked example

```markdown
---
name: pr-review
description: Triage a PR description into a structured review
continueOnError: false
---

1. [anthropic/claude-haiku-4-5] Summarize what this PR changes and why, in three
   sentences or fewer: {{input}}
2. Given that summary, do all three checks in parallel:
   - Does the summary above mention any tests being added or changed? Answer yes/no
     and quote the relevant sentence if yes: {{prev}}
   - Does the summary above mention any public API or config surface changing?
     Answer yes/no and name what changed if yes: {{prev}}
   - List any words in the summary above that suggest risk (breaking, migration,
     security, credentials, irreversible): {{prev}}
3. Combine the three findings above into a single go/no-go recommendation for a
   human reviewer, with one sentence of justification: {{prev}}
```

Running `/workflow pr-review <pasted PR description>` produces: one cheap Haiku call that
distills the input, a parallel stage of three independent, narrowly-scoped questions over
that summary (their answers always concatenated in the order written above, regardless of
which finishes first), and a final synthesis step that only ever sees the combined output
of stage 2 — never the raw PR text again, and never stage 1's output directly, since
`{{prev}}` always means "the *immediately preceding* stage."

## Related

- [Agent organizations](/docs/agent-organizations) — what a pipeline becomes when every
  step is a named role with its own model, tools and turn ceiling: the three lanes in
  practice, the `ORG-ASK` human gate, and a runnable ten-role kit.
- [Markdown skills](/docs/skills) — the sibling feature for a *user*-invoked prompt
  template; skills and workflows share nothing but a discovery pattern (user root, then
  project root, project wins).
- [Sub-agents](/docs/sub-agents) — what an untagged or read-lane `@role` step actually runs
  as under the hood, and the delegation model workflows deliberately trade flexibility for
  predictability against.
- [Teams](/docs/teams) — the write and exec lanes' worktree mechanics, shared verbatim
  with `/team`; the difference is that a team's patches wait for `/team merge`, a write-lane
  step's patch applies the moment the step succeeds, and an exec-lane step never produces a
  patch to merge or apply at all.
- [SDK: events](/docs/sdk-events) — `WorkflowEvent` is its own union (`workflowStart`,
  `stageStart`, `stepStart`, `stepEnd`, `stageEnd`, `workflowEnd`) with no `AgentEvent`
  counterpart, since stages, branches, and skips have no equivalent in a single-agent run.
