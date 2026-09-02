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

## Sharing a report

`arcturn insights --share` prints the same report as a markdown block, a one-line
statement of what it contains, and a pre-filled GitHub issue URL with the block already in
the body (truncated, marked, if the report is long enough to overflow a URL).

**Nothing is sent.** The command prints a link and stops; you read the block first and
decide whether to open it. There is no telemetry in Arcturn, and this is not a back door
into one.

## Related

- [Workflows](/docs/workflows) — the pipeline format, the parks, and the write lane
- [Audit trail & cost accounting](/docs/audit-cost) — what one *session* was allowed to do
- [Configuration](/docs/configuration) — the `insights` key, and its neighbours
