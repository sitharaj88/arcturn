---
title: Replay & bisect
description: Re-run a session's prompts against a live model or a recorded cassette, and binary-search for where behaviour diverged.
section: Core concepts
order: 8.7
---

## Two different tools, one input

`arcturn replay` and `arcturn bisect` both start from the same thing — the ordered list of
user prompts pulled out of a stored session by `extractPrompts` — but they answer
different questions. Replay asks "what happens if I run this again, maybe on a different
model?" Bisect asks "at which turn did behaviour stop matching a known-good recording?"
Neither is hermetic on its own; only bisect, backed by a cassette, is byte-identical.

Both skip *steering* messages — text injected mid-run via `Agent.steer()` — since those
aren't original prompts a user submitted while the agent was idle; `extractPrompts`
distinguishes them structurally (a steering message's parent entry is a tool-result
message, which an original prompt's parent never is) rather than guessing from content.

## arcturn replay

```bash
arcturn replay <sessionId|file> [--model <id>] [--cwd <dir>]
```

Replay is **live**: it re-runs the session's prompts against a real provider, one at a
time, in order. `--model` swaps which one — the whole point is comparing a session's
outcome across models or a config change, not reproducing the original run byte for byte.
Progress goes to stderr; results are one JSON object per turn on stdout, so a replay pipes
straight into `jq` or a diff without any cleanup:

```bash
$ arcturn replay 019c4a2f --model openai/gpt-5.1
arcturn: replaying 6 prompts on GPT-5.1
arcturn: [1/6] rate-limit the login route
{"prompt":"rate-limit the login route","finalText":"Added a 5-req…","toolCalls":["read","edit"],"costUsd":0.0412}
arcturn: [2/6] add a test for the limiter
{"prompt":"add a test for the limiter","finalText":"Added auth.test…","toolCalls":["read","write"],"costUsd":0.0388}
arcturn: replay total $0.2317
```

Each turn's JSON line carries `prompt`, `finalText`, `toolCalls` (call order), `costUsd`,
and an `error` field when that turn errored or was aborted — a bad turn doesn't stop the
replay; it's recorded and the next prompt still runs. The command's own exit code is
non-zero if any turn errored.

Because it's live, replay is the tool for **cross-model comparison and regression
testing against a real provider** — not for reproducing exactly what happened. Two runs
of the same session against the same model can still diverge (temperature, provider-side
changes, tool results that depend on the current state of the world). `diffReplays`
compares two `ReplayResult`s turn by turn — tool-call sequence match, final-text length
divergence (>20% or empty↔non-empty counts as diverged), and cost delta — useful for
scripting "did this change anything" checks around a replay pair.

## Cassettes: the hermetic path

The byte-identical alternative lives in `vcr.ts`, not in `replay`. A **cassette** is a
JSONL recording of everything arcturn doesn't control during a run: every LLM stream event
and every tool result, keyed by a content hash of the request/input that produced it (not
by position) so the recording survives being replayed against a slightly different call
order. Replaying against a cassette touches neither the network nor the real filesystem —
a recorded session that ran `rm -rf` deletes nothing on replay.

Record one with `--record` on any ordinary run:

```bash
arcturn -p "your prompt" --record run.jsonl
arcturn bisect <session> --cassette run.jsonl
```

`--record` tees the run: every LLM request and response, and every tool call and its
result, are appended to the file while the run proceeds normally. The tee sits *inside*
failover and consensus, so on a multi-model config the cassette names the model that
actually answered rather than the head of the chain — a cassette is a recording of what
happened, not of what was attempted.

The same machinery is available at SDK level (`createCassetteRecorder`, `recordingClient`,
`wrapToolsWithRecorder` in `vcr.ts`) for a host application that wants to wire it up
itself.

## arcturn bisect

```bash
arcturn bisect <session> --cassette <file> [--model <id>] [--cwd <dir>]
```

Bisect binary-searches the session's prompts, replaying prefixes of them against a
**freshly loaded** copy of the cassette for each probe (cassette consumption is stateful,
so reusing one loaded cassette across probes would make every probe after the first see
an already-partially-consumed recording). Each probe is classified:

- the replay throws a cassette **miss** → `"bad"` — the agent asked for something the
  recording never produced, the turn-level signature of "behaviour diverged here."
- the cassette load or replay hits **corruption** → `"skip"` — undecidable, not good or
  bad.
- the replay completes clean with zero misses → `"good"`.

```bash
$ arcturn bisect 019c4a2f --cassette run.jsonl
arcturn bisect: behaviour first diverges at turn 4 — refactor the token parser.
confident: yes (first divergence at turn 4)

Probe trail (4 probe(s)):
  turn 0: good
  turn 2: good
  turn 3: good
  turn 4: bad
```

Exit code is `0` when no divergence was found, `1` when one was.

**The search assumes badness is monotonic** — once a turn is bad, every turn after it is
too, the same assumption `git bisect` makes. A `"skip"` doesn't count as good or bad; the
search steps outward to the nearest decidable neighbour instead of guessing. A probe
budget (default 64 calls, including outward-stepping and verification) bounds the total
cost, since a real probe means spinning up a runtime and replaying a cassette. Pass
`{ verify: true }` to `bisectTurns` (not yet a CLI flag) to re-probe the two turns
straddling the discovered boundary and catch a non-monotonic run rather than silently
trusting it.

**Read `confident` before you read the answer.** `confident: no` means the search ran out
of probe budget, hit a window where every nearby probe returned `"skip"`, or (with
`verify`) caught a contradiction with monotonicity — `firstBadIndex` may still be printed
as the best available answer, but it isn't guaranteed correct. Bisecting over a smaller,
cleaner reproduction — or falling back to a linear scan — is the honest move when that
happens, not trusting the number.

## Limits and blind spots

- Replay is **not hermetic**. Two live replays of the same session can print different
  `finalText` even on the same model. Only the cassette path is byte-identical.
  Provider-side model updates, tool results tied to real time/state, and sampling
  variance are all real sources of drift `replay` cannot control for.
  Reach for `arcturn bisect --cassette` when you need a deterministic answer, and reach
  for `arcturn replay --model` when you're deliberately comparing outcomes, not
  reproducing one.
- Bisect can only find a divergence that already has a cassette to diverge *from*, so the
  recording has to exist before the change you are hunting: run with `--record` while the
  behaviour is still good, then bisect against that file afterwards.
- `extractPrompts` sends **text only**; image content blocks in an original prompt are
  dropped on replay.

## Related

- [Sessions, branching & compaction](/docs/sessions) — `extractPrompts` walks the same
  entry list this page's tools are built on.
- [Provenance & arcturn blame](/docs/provenance) — attributes the lines a replayed prompt
  would have produced, in the original run.
- [Audit & cost](/docs/audit-cost) — replay reports cost per turn using the same
  accounting `/cost` shows live.
- The [accountability feature page](/features/accountability) has both commands' exact
  output, including the bisect probe trail shown above.
