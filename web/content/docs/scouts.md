---
title: Scouts
description: Time-boxed parallel exploration of an approach in throwaway git worktrees, before you commit to writing it for real.
section: Core concepts
order: 8.92
---

## The mistake this avoids

The expensive mistake in agentic coding is not a wrong edit; it's *committing to the
wrong approach* and then spending twenty minutes and a dollar of tokens discovering that
the chosen design collides with a type the model never read. Humans avoid this by
spiking: try three things badly for five minutes each, then pick. Doing that with an
agent needs two things at once — real isolation (three agents editing the same working
tree is a mess, not an experiment) and a *hard* stop (an exploration that runs to
completion isn't an exploration, it's three full implementations at triple the cost).
`/scout` is that spike.

A scout is deliberately **not** a way to get work done — it's a way to buy information.
Scout writes never touch your real tree; the worktree they run in is destroyed at the end
of the run, always.

## Running one

```text
/scout use zustand | use redux
Scouting 2 approaches in throwaway worktrees…
```

Approaches are pipe-separated. Name one explicitly with a `name:` prefix, or let it default
to `approach-1`, `approach-2`, …:

```text
/scout pool: use a worker pool | loop: rewrite it as an event loop | mutex: just add a mutex
```

At least two approaches are required (`/scout use zustand` alone is rejected: "Give at
least two approaches"). A scout won't start while the main agent is mid-run — interrupt
it first.

## Isolation and cleanup

Each approach runs in its own git worktree, created with:

```text
git worktree add --detach <dir> HEAD
```

A detached checkout rather than a named branch, deliberately — a named branch per scout
would collide across runs and leave refs behind, whereas a detached checkout is pure
scratch space. The worktree lives under a fresh temp directory
(`mkdtemp(join(tmpdir(), "arcturn-scout-"))`) unless the caller supplies a parent
directory (as `/team` does — see below).

Cleanup is a stated guarantee, not a best-effort: every exit path — finished, timed out,
errored, the spawn call itself throwing, a permission prompt being rejected mid-run, even
a failure to capture the diff — calls `worktree.remove()` (`git worktree remove --force`,
then a filesystem delete of the temp parent). A leaked worktree is treated as a real bug:
it's a directory of half-written code plus a stale entry in `.git/worktrees`.

## Time-boxing

`/scout`'s wall-clock budget is a fixed **180 seconds** (`SCOUT_DEADLINE_MS` in
`commands.ts`) for the whole run, not per approach. When the deadline hits, every scout
still running has `.abort()` called on it; any approach that hadn't started yet is marked
`timeout` too, with an explanatory error. Partial findings and partial diffs are still
captured and reported — a scout cut off mid-thought isn't a scout that produced nothing.

## Concurrency and cost

`/scout` doesn't cap how many approaches run at once — every approach you list runs in
parallel, bounded only by however many you type after `/scout`. (The underlying
`runScouts` function does accept a `maxParallel` option for callers that want to bound
it; the shipped `/scout` command doesn't set one.)

Scouts spend real money **outside the main agent's own event stream**. `/scout`'s handler
folds each result's cost back in explicitly (`runtime.recordExternalCost`) after the run
completes — without that, `/cost` and `--max-cost` would silently under-report what a
scouting run actually spent. There's no scout-specific cost ceiling; the only real bound
on spend is the 180-second wall clock and however many approaches you asked for.

## What a scout returns

Each `ScoutResult` carries: `status` (`"finished" | "timeout" | "error"`), `finalText`
(the agent's own findings/notes), `toolCalls`, `costUsd`, `durationMs`, and — the actual
work product — `diff`: the worktree's staged changes (`git add --all` then
`git diff --cached --no-color`), captured before the worktree is torn down. The header
comment is explicit about why the diff matters: a scouting report isn't just prose about
which approach seemed better, it *contains the code* that approach produced, so you can
read it, not just take the model's word for it.

`formatScoutReport` renders a comparison table across approaches and closes with a
reminder that the worktrees are already gone:

> Scouts are exploration only — their worktrees are gone. Re-run "\<winner\>" in the real
> workspace, or apply its diff.

Nothing about a scout run persists to disk beyond that point — there's no scout-record
store the way `/bg` and `/team` have one. A scout's report exists only in the terminal
output of the command that ran it.

## Reused by `/team`

`createWorktree` — the same function `/scout` uses — is also the isolation primitive
[`/team`](/docs/teams) builds member dispatch on: each team member is rooted in its own
`git worktree add --detach` checkout, created through the identical function scouts use,
just pointed at a parent directory under the team's own state rather than a scratch temp
dir. The two features diverge from there: a team member's diff is captured to a
**durable patch file on disk** because team output is meant to be merged
(`/team merge`, `git apply`), while a scout's diff lives only in the in-memory result —
scouting is throwaway by design, teams are not.

## Related

- [Agent teams & background agents](/docs/teams) — the feature that reuses scouts'
  worktree primitive for durable, mergeable parallel work.
- [Dry run & sandbox](/docs/dry-run) — a different way to try something without touching
  the real tree: an overlay in the *same* working directory, rather than a separate
  worktree.
