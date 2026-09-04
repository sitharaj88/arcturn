---
title: Insights
description: A local, privacy-preserving ledger of what has been going wrong — parks, silent turns, step failures, slow roles — and the command that turns it into answers.
section: Core concepts
order: 8.98
---

## The fault you already paid for

Every serious defect this tool found in its first week of real pipeline runs was found by
a person reading session JSONL by hand: which model went quiet, on which step, how often,
whether the nudge recovered it, and what a run had cost before it parked. The engine knew
all of that in the moment and kept none of it — so the second occurrence of a fault cost
exactly as much to diagnose as the first.

`arcturn insights` is the feedback loop. A small append-only ledger records the
**failure-shaped** moments of every run, and one command folds it into the five questions
those runs kept raising.

```text
arcturn insights                       # last 7 days, this machine
arcturn insights --since 30d           # a wider window; --since all for everything
arcturn insights --workflow ship-fix   # one pipeline
arcturn insights --json                # the whole aggregate as one object
arcturn insights --share               # a markdown block plus a pre-filled issue link
/insights [same flags]                 # the same report, without leaving a session
```

## What it prints

Sections are omitted when they are empty, so a quiet week is a short report.

```text
Insights — last 7d (since 2026-08-26)

Runs (12)
  status          done 7 · paused 3 · failed 2
  median duration 4m 12s
  spend           $3.41 (lower bound; some runs unpriced) · 1.2M tokens

Parks (5)
  workflow  step  role         parks  cause             produced-nothing
  pipeline  2     @architect   3      produced-nothing  3/3 silent
  nightly   9     @auditor     2      timeout           -

Progress warnings (2)
  @builder 2

Silent turns (7)
  model                       silences  nudged  recovered
  zai/glm-5.3                 5         3       1/3 (33.3%)
  anthropic/claude-sonnet-4-5 2         1       1/1 (100.0%)

Step failures
  turn-ceiling 4 · agent-error 2
  by role (min 3 steps)
    role        failed  rate
    @architect  3/5     60.0%

Slowest roles (median step)
  role        median   n
  @builder    6m 02s   9 steps
  @architect  4m 30s   5 steps
```

Read top to bottom, that is: how runs end and what they cost; which step of which pipeline
keeps parking and why; which write-lane roles had to be told mid-run that they had written
nothing; which models go quiet and whether the loop's nudge recovers them; which failure
kinds and which roles dominate; and where the wall-clock time goes.

Two of those need a word of explanation.

**Silent turns.** The agent loop hands a turn back once when a model ends it with no text
and no tool call, and accepts the second silence in a row. Both are recorded. *Recovered*
is an approximation, and a stated one: the ledger cannot see whether the model answered
the nudge, only whether the step it belonged to later ended `done`, so that is what it
counts. Over a hundred runs it is the right shape; on any single row it is a hint.

**Parks.** A park's cause is bucketed into one of `produced-nothing`, `turn-ceiling`,
`timeout`, `patch-refused`, `agent-error`, `network` or `other`, and for the
produced-nothing parks the report says how many of them also had a recorded silent turn —
which is the difference between "this step keeps failing" and "this *model* keeps going
quiet on this step".

## What is in the file, and what is not

The ledger is `~/.arcturn/insights/events.jsonl`, one JSON object per line, appended
durably and never on the critical path of a run: a write that fails is one warning, never
an error. It rotates at 5 MB to `events.1.jsonl` and keeps exactly one generation; the
report reads both.

It records **names and numbers**:

- workflow names, run ids, step ids, role names, model ids;
- statuses, failure kinds, stop reasons, attempt counts;
- durations, token counts, cost in USD where the model is priced;
- the *shape* of a step's last turn — block kinds and their sizes, the stop reason;
- a step's activity — how many turns it took and how many times it called each tool.

It records **none of**: prompt text, model reasoning, file contents, file paths, your
input, tool arguments, tool output, or session ids. That is enforced structurally rather
than promised: every line is rebuilt field by field from a fixed whitelist on the way to
disk, so a field added upstream is absent here until somebody decides otherwise. In
particular, the run journal's `reasoningTail` — the one field in Arcturn that can carry a
model's reasoning — is dropped, and a test asserts a tail never reaches the file.

Turn the whole thing off with one key:

```json
{ "insights": false }
```

Disabled, the recorder touches no disk at all — not an empty file, not the directory.

## Judge panels and races

When a workflow uses `[judges:N]` or `[race:a|b]`, the report grows two sections — counts
and names only, like everything else here:

```text
Judge panels (3, 1 arbitrated)
  workflow  step  panels  agreed  arbitrated
  review    2     2       1       1
  review    4     1       1       0

Races (2)
  model  won  lost
  fast   2    0
  slow   0    2
  losses: aborted 1, failed 1
```

"How often a question this pipeline acts on turned out not to have a stable answer" is a
fact about the pipeline; the verdicts themselves are the run's own content and never reach
the ledger. The race table separates a loss the engine caused (`aborted` — another arm won
first) from a loss the model owns (`failed`, `void`), because they are the same `lost` and
completely different evidence. A losing arm is not counted as a step failure anywhere: it
appears here and nowhere else.

A typed-reply miss needs no section of its own — it is a failure kind like any other and
shows up as `contract` in the step-failure table.

## Sharing a report

`arcturn insights --share` prints the same report as a markdown block, a one-line
statement of what it contains, and a pre-filled GitHub issue URL with the block already in
the body (truncated, marked, if the report is long enough to overflow a URL).

**Nothing is sent.** The command prints a link and stops; you read the block first and
decide whether to open it. There is no telemetry in Arcturn, and this is not a back door
into one.

## Forecasting a run

`/workflow forecast <name>` predicts a pipeline's next run from the same ledger, before it
spends a token: duration, cost, tokens and stop risk, per stage, on the model that stage
will actually use — resolved with the exact `[tag]` → role `model:` → subagent-default
precedence the run itself applies.

```text
Forecast — rag-setup

step  role         model                n   p50    p90    cost    tokens  stop   source
1     planner      zai/glm-5.3          12  1m30s  3m00s  $0.04   1.2k    8.3%   -
5     rag-builder  zai/glm-5.3          3   6m10s  9m40s  $0.11   4.6k    66.7%  -

Lower-risk alternative seen in history:
    step 5: 0.0% on openai/gpt-5-nano, n=2

Totals: p50 7m40s · cost $0.15 · stop risk 69.4%
Historical whole run: p50 12m00s · cost $0.20 (n=3)
3 runs of this workflow in the last 30 days.
```

Each stage's history comes from `step-end` events for that exact step *on that exact
model*; when there is none, it falls back to the same step on any model, then to the same
role anywhere, and says so in the `source` column. A stage with no history at all shows
`no history` rather than a guess. Cost is repriced from the historical token usage against
each sample's own model, so a stage whose samples span an unpriced model reads `unknown`
instead of a wrong `$0.00`.

A **race's losing arm** is a sample too. It is recorded `superseded` so nothing that counts
steps counts it twice, but it is not another attempt at the same thing — it is a different
model answering that exact step, at its own speed and its own price, which is the one
comparison a single-model history cannot make. So its duration and tokens count under *its*
model, and it counts as a *stop* only when it failed on its own terms (`failed`, `void`) —
never when it was simply cut off because another arm won (`aborted`) or answered well a
moment too late (`slower`). That is what lets the alternative line say "0.0% on
openai/gpt-5-nano" from races you already ran.

A step declared `[race:a|b]` therefore gets **one row per arm**, not one row for the step:
it has no single model, so there is no honest way to label a single row — and labelling it
with one arm would print that arm's name over the other arm's durations. Each row is built
from that arm's own samples and marked `race arm` in the `source` column, so two rows share
a step number:

```text
step  role     model                n  p50     p90     cost   tokens  stop  source
1     builder  zai/glm-5.3-flash    2  31.5s   31.5s   $0.02  8.9k    0.0%  race arm
1     builder  zai/glm-5.3          2  21.2s   21.2s   $0.02  8.9k    0.0%  race arm

Raced steps run every arm at once: the totals take duration from the arm
that has won most often, and cost from all of them.
    step 1: timed on zai/glm-5.3
```

The totals split the two because a race does: it is over the moment its first arm is over,
so the run's **duration and stop risk** come from the winning arm alone, while every arm's
tokens were really spent, so the run's **cost** is all of them. The "winning arm" is the one
that has won this step most often in the window; a tie, or a step that has never raced here
yet, falls back to the first arm the workflow declares, so the same ledger always forecasts
the same arm. An arm with no history of its own falls back to role history and never to the
other arm — that would just be this race quoting itself.

`--json` prints the same forecast as one structured object, for scripting. A raced step's
arms appear as consecutive `stages[]` entries sharing a `stepId`, each carrying
`"raceArm": true`, and the arm the totals are timed on also carries `"raceWinner": true`.
Neither field appears on an ordinary stage.

Before a real run starts, `/workflow <name>` prints a two-line forecast banner and then
runs regardless of what it says — a forecast never delays or blocks a run, and one that
cannot be built (no ledger, no history) prints a single honest line instead of an error:

```text
forecast: ~7m40s · ~$0.15 · stop risk 69.4% (n=3 runs)
stage 5 rag-builder stopped 2/3 on zai/glm-5.3 — 0/2 on openai/gpt-5-nano
```

The second line appears only when some stage's stop rate is 25% or higher, naming the
worst one and, when the ledger has seen a lower-risk model for that same step, what it was.

## Related

- [Workflows](/docs/workflows) — the pipeline format, the parks, and the write lane
- [Audit trail & cost accounting](/docs/audit-cost) — what one *session* was allowed to do
- [Configuration](/docs/configuration) — the `insights` key, and its neighbours
