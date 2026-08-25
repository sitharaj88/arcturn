---
title: Agent teams & background agents
description: Three ways to spend a second agent — a synchronous sub-agent, a durable /bg task, and a coordinated /team.
section: Core concepts
order: 8.95
---

Arcturn has three ways to spend a second agent, and they solve different problems. The
[`subagent` tool](/docs/sub-agents) is one-shot and synchronous — the parent asks a
question and waits for an answer. `/bg` is fire-and-forget and durable — a whole task
runs off-thread, and you check back later. `/team` is orchestration — several agents move
one goal forward *at once*, and something is responsible for reconciling their work back
into a single tree. This page covers the latter two.

## Background agents: `/bg`

`/bg <task>` starts a full child agent running your task as its sole prompt, off the
foreground thread, and returns immediately:

```text
/bg fix the flaky retry test and open a summary of what was wrong
Started background agent bg-a1b2c3d4 (session <sessionId>).
```

- `/bg` (no arguments) — list every background agent this process knows about.
- `/bg logs <id>` — print the transcript so far.
- `/bg cancel <id>` — abort it.
- `/bg adopt <id>` — pull its final result into the live conversation: if the main agent
  is currently running, the result is queued with `steer()`; if idle, it's injected as a
  fresh prompt via `agent.prompt()`.

A background agent's first word being literally `logs`, `cancel`, or `adopt` gets parsed
as that sub-verb rather than the start of a new task — a known, accepted ambiguity, the
same shape `/cost limit`/`/cost preview` already have.

**Lifecycle states:** `"running" | "done" | "failed" | "cancelled" | "interrupted"`. There
is no separate "queued" state in the type — a queued agent still reports `"running"`;
whether it's actually started or waiting is inferred from `startedAt` being unset.
`"interrupted"` specifically means the record was still `"running"` when a fresh manager
process loaded it from disk: the process that owned it died mid-run.

**Where it runs:** rooted at the manager's configured `cwd` (the runtime's `cwd` by
default). Permission mode defaults to `"default"`, never `"yolo"` — there is nowhere to
send a permission prompt for an unattended agent, so a non-default mode fails closed by
construction. The default tool set is the read-only tools plus `fetch`; `subagent` is
always excluded, so a background agent cannot recursively spawn more background agents or
sub-agents.

**Persistence:** one JSON record per agent under `<paths.home>/background-agents/records/`,
written atomically (temp file, then rename), plus a normal session store under
`<paths.home>/background-agents/sessions/` — an ordinary `JsonlSessionStore`, so a
background agent's conversation can be resumed the same way any session can. Up to
3 agents run concurrently by default; the rest queue FIFO.

## Agent teams: `/team`

A team decomposes one goal into disjoint subtasks, dispatches one agent per subtask into
its own throwaway git worktree, and reconciles their work by applying patches back to
your tree — the orchestration case neither `subagent` nor `/bg` covers.

### The shape of a run

1. **Decompose.** One supervisor turn splits the goal into 2–5 subtasks
   (`MIN_TEAM_MEMBERS`–`MAX_TEAM_MEMBERS`), each with an explicit, disjoint file scope.
2. **Validate.** This is the load-bearing step: a plan is never dispatched until its
   file scopes are provably disjoint. Overlapping subtasks trigger exactly one re-ask
   with the conflicts spelled out; if the second plan still overlaps, the colliding
   subtasks are **merged into one member** rather than dispatched — merging loses
   parallelism, dispatching an overlapping plan loses work.
3. **Dispatch.** One agent per subtask, each rooted in its own `git worktree add --detach`
   checkout (reusing [scouts.ts's](/docs/scouts) `createWorktree` — the same isolation
   primitive scouts use), bounded by a concurrency cap and a per-team cost/turn ceiling.
4. **Capture.** When a member settles, its `git diff` is staged (`git add --all`) and
   written to a **patch file on disk**, and its worktree is destroyed in a `finally` —
   the patch, not the worktree, is the durable work product, so a crash, a cancel, or a
   conflict can never lose a member's output.
5. **Reconcile.** `/team merge` replays those patches into your tree with `git apply`,
   one member at a time, checking each (`git apply --check`) before applying.

### Conflict policy: surface, never guess

`git apply` runs without `--3way` and without `--force` — it refuses a patch whose
context doesn't match rather than overwriting anything. The first refusal **stops the
merge**: it reports which members landed and which didn't, and leaves the offending
patch file on disk. Arcturn does not attempt a clever auto-merge and does not write
conflict markers into your tree. You choose: `git apply --3way <patch>`, re-run the
member, or `/team discard`. Members already applied stay applied and are recorded as
merged, so re-running `/team merge` resumes rather than double-applying.

### Roles

Four built-in roles, resolved case-insensitively, a host-defined role of the same name
(e.g. from a markdown [named agent](/docs/sub-agents#named-agents-from-markdown)) winning
over the built-in:

| Role | Tools | What it does |
|---|---|---|
| `implementer` | unrestricted | Writes the production change for one file scope. |
| `tester` | unrestricted | Writes and runs tests; told not to edit production code to make a test pass. |
| `reviewer` | **read-only** | Reads and critiques; cannot modify anything. |
| `documenter` | unrestricted | Updates prose/doc comments; told not to change behavior. |

`reviewer` is deliberately read-only: a reviewer that can edit stops being a second
opinion and becomes a fourth author racing the others for the same lines. The default
role, when a plan names none or names one nobody can resolve, is `implementer`.

### Command syntax

```text
/team <goal>                                       decompose, dispatch, show the report
/team --roles implementer,tester,reviewer <goal>    pin the specialists, in order
/team status [id]                                   list teams, or one team's report
/team cancel [id]                                    abort every member, clean up worktrees
/team merge [id]                                     apply members' patches to your tree
/team discard [id]                                   throw the members' patches away
```

Flags accepted before a goal or sub-command: `--roles a,b,c`, `--members <n>`,
`--max-cost <usd>` (also `$<usd>`), `--parallel <n>` (or `--concurrency <n>`). Omitting
`[id]` on a sub-command targets the most recently created team.

### Defaults

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_TEAM_CONCURRENCY` | 3 | Members running at once; the rest queue. |
| `DEFAULT_TEAM_MAX_COST_USD` | 5 | Per-team spend ceiling; exceeding it cancels every remaining member. `0` disables it. |
| `DEFAULT_TEAM_MAX_TURNS` | 40 | Turn ceiling for one member. |
| `MIN_TEAM_MEMBERS` / `MAX_TEAM_MEMBERS` | 2 / 5 | Bounds on a decomposition; beyond either, the plan is re-asked. |

Hitting the cost ceiling mid-run cuts off every remaining member but does not discard
work already captured — patches already on disk from members that finished first are
still mergeable, and the team's status/report says so.

### Team status values

`"planning" | "running" | "review" | "merged" | "discarded" | "cancelled" | "failed" |
"interrupted"`. `"review"` is the interesting one: every member has settled and its
patch is on disk, but nothing has touched your tree yet — a team sits in `"review"`
until you run `/team merge` or `/team discard`.

### Durability and recovery

Every record is written synchronously to `<dir>/records` on each status change, mirroring
`/bg`'s durability model. A record still `"running"` when a fresh manager loads it
belongs to a process that is gone — `TeamManager.recover()` salvages it: each member's
surviving worktree has its diff captured to a patch (so a crash costs no work) before the
worktree is removed, and `git worktree prune` clears any leftover administrative entry.
Recovery is idempotent and runs automatically at the start of every `/team` command.

### Cost accounting

A team's spend happens outside the main agent's own event stream — without explicit
accounting, `/cost` and `--max-cost` would silently under-report a whole team's spend.
`/team <goal>` folds each member's summed cost into the parent session's running total
via `runtime.recordExternalCost(status.costUsd)` once the run settles.

## From a remote client

`arcturn serve` exposes `/bg` in full and `/team` not at all, and the asymmetry is
deliberate rather than unfinished.

**`/bg` is reachable, subverb for subverb.** `backgroundAgents` is the listing and
`/bg logs`, `startBackgroundAgent` is `/bg <task>`, `cancelBackgroundAgent` is
`/bg cancel` and `adoptBackgroundAgent` is `/bg adopt`. A remote client reaches the same
manager a terminal in the same process does — same records directory, same queue, same
concurrency cap — and a background agent started over the wire runs under exactly the caps
a locally-started one does, because the verb carries a task and nothing else. See
[Server mode](/docs/server-mode#background-agents) for the table and for the one wrinkle:
a serve process adopting the records directory can briefly report another process's live
agent as `interrupted`.

**`/team` is not reachable, and two separate things have to change first.**

1. *Reading a team's status is not read-only today.* The only way to reach a `TeamManager`
   is to construct one, and construction rewrites every record still `"running"` to
   `"interrupted"` — sound when a fresh manager really is a fresh process, and false in a
   serve process running alongside a terminal that owns a live team. A status verb whose
   first call declares somebody else's running team dead is not a status verb. The fix is
   an owner lease in the record (a pid, or a process token), so a manager can tell "the
   process that owned this is gone" from "this belongs to somebody else".
2. *`merge` and `discard` have no mid-run guard.* `merge` runs `git apply` into your real
   tree and `discard` deletes the patch files that are the only copy of a member's work,
   and neither refuses while members are still running — a mid-run `discard` would remove
   worktrees out from under live agents. Every write verb on the wire refuses `sessionBusy`
   rather than racing (`applyChanges`, `rewindTo`, `setPermissionMode`), and there is
   nothing for those verbs to refuse *with* until the manager can answer "is this team
   still going".

Neither is a protocol problem, which is why neither was solved with a protocol change.

**`/scout` is not reachable either**, and for a simpler reason: a scout run leaves nothing
behind. It creates throwaway worktrees, races the approaches against a deadline, captures
each diff into memory, deletes every worktree in a `finally`, and returns a report that
exists only as printed text. There is nothing for a listing verb to list and nothing for a
cancel verb to name, so a `startScout` would be one request that blocks for minutes, cannot
be reported on, cannot be cancelled, and hands back worktrees that are already gone. Making
it reachable means giving scouts durable records first.

## Choosing between them

- **`subagent`** — you need an answer to fold back into the current turn, right now, and
  the work is small enough for one focused pass.
- **`/bg`** — the work is bigger, doesn't need supervision, and you want to keep working
  on something else while it runs; check back with `/bg logs`/`/bg adopt` when it's done.
- **`/team`** — the goal genuinely decomposes into independent pieces (separate files,
  separate concerns) that benefit from running in parallel, and you're willing to review
  and merge patches rather than get one linear diff.

## Related

- [Sub-agents, plan mode & todos](/docs/sub-agents) — the synchronous `subagent` tool and
  named agents from markdown, which teams reuse for role definitions.
- [Scouts](/docs/scouts) — the throwaway-worktree exploration primitive `/team` reuses for
  member isolation; scouts never produce a merge-ready patch, teams always do.
- [Model providers](/docs/providers#per-role-routing) — the `subagent` route both
  background agents and team members resolve their model through by default.
