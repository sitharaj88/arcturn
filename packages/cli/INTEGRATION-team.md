# Wiring AGENT TEAMS into the CLI

Integration recipe for `packages/cli/src/team.ts` (new file, shipped with
`team.test.ts`, **79 passing tests**). Per the hard rules **no existing file
was edited** — everything below is an exact instruction for whoever owns the
registration site.

The idea in one line: one supervisor turn splits a goal into 2–5 subtasks with
**disjoint file scopes**, one agent per subtask runs in its **own git
worktree** so their edits cannot collide, and the results are reconciled by
replaying each member's captured patch into your tree with `git apply` —
stopping and surfacing the first conflict rather than guessing.

---

## 1. The wiring, in full

There is exactly **one** registration site. In `commands.ts`:

```ts
import { createTeamCommands } from "./team.js";

// inside createBuiltInCommands(), alongside createBackgroundAgentCommands()
...createTeamCommands(),
```

That is the whole required change. `createTeamCommands()` obtains its manager
through `getTeamManager(runtime)` — memoized per `ArcturnRuntime` in a `WeakMap`,
exactly like `getBackgroundAgentManager` — so the commands and any host code
observe the same instance.

Two optional extras:

- **Completions.** Add `"team"` to whatever list `completions.ts` builds, and a
  line to `/help`.
- **Startup recovery.** `getTeamManager(runtime).recover()` at startup salvages
  and tears down anything a crashed process left behind (§6). Not required —
  every `/team` command already calls it — but it makes the cleanup happen
  before the user notices.

Nothing else needs to change. `team.ts`'s only in-repo imports are
`agents.js` (type-only), `commands.js` (types), `format.js`, `runtime.js`
(type-only, plus the three wiring factories) and `scouts.js`
(`createWorktree`, reused as-is).

---

## 2. Commands

```
/team <goal>                                   plan, dispatch, reconcile
/team --roles implementer,tester,reviewer <goal>
/team --members 3 --parallel 2 --max-cost 2.50 <goal>
/team status                                   list every team
/team status <id>                              one team's full report
/team cancel [id]                              abort all members, clean worktrees
/team merge [id]                               apply members' patches to your tree
/team discard [id]                             delete members' patches
```

`[id]` defaults to the newest team. Flags may be written `--roles=a,b` or
`--roles a,b`, and are parsed off the front only, so a goal can contain the
word `status` without being mistaken for the sub-command (a sub-command is
only recognised when it is the entire remaining argument).

Command description string, as registered:

```
Run a team of agents on one goal: /team <goal> · status|cancel|merge|discard [id]
```

---

## 3. Public API

```ts
// --- the manager -----------------------------------------------------------
class TeamManager {
  constructor(options: TeamManagerOptions)
  get dir(): string
  get roleNames(): string[]
  setDefaults(defaults: { spawn?; roles?; concurrency?; maxCostUsd?; costOf?; execFn? }): void
  start(goal: string, options?: StartTeamOptions): Promise<TeamStatus>
  list(): TeamStatus[]
  get(id: string): TeamStatus | undefined
  latest(): TeamStatus | undefined
  cancel(id: string): boolean
  settled(id: string): Promise<TeamStatus | undefined>
  merge(id: string, options?: { members?: readonly string[] }): Promise<TeamMergeReport | undefined>
  discard(id: string, options?: { members?: readonly string[] }): Promise<TeamStatus | undefined>
  recover(): Promise<TeamRecoveryReport>
  onUpdate(listener: (status: TeamStatus) => void): () => void
}

// --- command + wiring ------------------------------------------------------
createTeamCommands(options?: { manager?: (runtime: ArcturnRuntime) => TeamManager }): SlashCommand[]
getTeamManager(runtime: ArcturnRuntime): TeamManager
createTeamPlanner(runtime: ArcturnRuntime): TeamPlanner
createTeamSpawn(runtime: ArcturnRuntime): TeamSpawn
teamRolesFor(runtime: ArcturnRuntime): ReadonlyMap<string, TeamRole>

// --- decomposition ---------------------------------------------------------
TEAM_PLAN_SYSTEM_PROMPT: string
buildDecompositionPrompt(request: TeamPlanRequest): string
buildMemberPrompt(brief: TeamMemberBrief): string
parseTeamPlan(raw: string): TeamPlanParseResult
validateTeamPlan(subtasks, options?: ValidateTeamPlanOptions): TeamPlanValidation
repairTeamPlan(subtasks, options?: { maxMembers?: number }): TeamPlanRepair
describeTeamPlanIssue(issue: TeamPlanIssue): string
normalizeScope(raw: string): string
scopesOverlap(a: string, b: string): boolean

// --- roles -----------------------------------------------------------------
BUILT_IN_TEAM_ROLES: ReadonlyMap<string, TeamRole>
DEFAULT_TEAM_ROLE_NAME: "implementer"
resolveTeamRole(name: string, extra?: ReadonlyMap<string, TeamRole>): TeamRole | undefined
teamRoleFromAgentDef(def: AgentDef): TeamRole

// --- reporting -------------------------------------------------------------
formatTeamReport(status: TeamStatus, options?: { excerptLines?: number }): string
formatMergeReport(report: TeamMergeReport): string
parseTeamArgs(args: string): ParsedTeamArgs

// --- constants -------------------------------------------------------------
DEFAULT_TEAM_CONCURRENCY = 3
DEFAULT_TEAM_MAX_COST_USD = 5
DEFAULT_TEAM_MAX_TURNS = 40
MAX_TEAM_MEMBERS = 5
MIN_TEAM_MEMBERS = 2
```

Types: `TeamRole`, `TeamSubtask`, `TeamPlan`, `TeamPlanParseResult`,
`TeamPlanRequest`, `TeamPlanner`, `TeamPlanIssue`, `TeamPlanValidation`,
`TeamPlanRepair`, `ValidateTeamPlanOptions`, `ScopeConflict`, `TeamAgent`,
`TeamSpawn`, `TeamMemberBrief`, `TeamMemberStatusValue`, `TeamStatusValue`,
`DiffStat`, `TeamMemberStatus`, `TeamStatus`, `TeamManagerOptions`,
`StartTeamOptions`, `TeamMergeOutcome`, `TeamMergeReport`,
`TeamRecoveryReport`, `TeamSubcommand`, `ParsedTeamArgs`.

`TeamAgent` is a **structural** subset of `@arcturn/core`'s `Agent`
(`prompt` / `abort` / `finalText` / `subscribe` / optional `sessionId`), so a
real `Agent` satisfies it with no adapter — the same trick `scouts.ts` uses,
and the reason the whole scheduler is unit-testable without an LLM.

---

## 4. Decomposition, and why validation is the feature

A supervisor that splits a task badly produces three agents fighting over the
same file, and the merge step then has to pick whose work to lose. So the plan
is treated as untrusted input:

1. **Ask.** One `llm.complete()` on the `main` route with
   `TEAM_PLAN_SYSTEM_PROMPT` and `buildDecompositionPrompt(...)`. The prompt
   demands a `files` scope per subtask, because disjointness cannot be proved
   without one.
2. **Parse** (`parseTeamPlan`). Tolerant of code fences, prose either side of
   the JSON, a bare top-level array, and key aliases (`subtasks`/`members`/
   `tasks`, `files`/`paths`/`scope`). Intolerant of anything that would change
   what gets dispatched — a subtask with no `task` text is a parse failure, not
   a member with an empty prompt.
3. **Validate** (`validateTeamPlan`). Issues: `too-few`, `too-many`,
   `unscoped`, `overlap`, `unknown-role`. Overlap is computed by
   `scopesOverlap`, which compares the literal prefix either side of the first
   wildcard: `src/**` collides with `src/a.ts`, `src/a.ts` does not collide
   with `src/b.ts`, and `**/*.ts` collides with everything. Deliberately
   conservative — a false positive costs one merged member, a false negative
   costs a member's work at merge time.
4. **Re-ask exactly once**, feeding the rejection back verbatim
   (`describeTeamPlanIssue`). An `unknown-role` issue alone does *not* trigger
   a re-ask; it downgrades to `implementer`.
5. **Repair, never dispatch** (`repairTeamPlan`). If the second plan still
   overlaps, colliding subtasks are merged transitively into one member —
   tasks concatenated, scopes unioned — an over-long plan has its tail folded
   into the last member, and an unscoped subtask is treated as claiming `**`
   so it merges rather than running unbounded. **Nothing is ever dropped or
   truncated.** A repair can legitimately collapse the plan to one member; the
   report says so ("Decomposition collapsed to a single member").

If the model never produces parseable JSON in two attempts, the team is
recorded `failed` and **no agent is dispatched and no worktree is created**.

---

## 5. Dispatch, isolation and budgets

Per member: `createWorktree(repoRoot, "<n>-<memberId>", { parentDir })` from
`scouts.ts` → `git worktree add --detach`. The member's agent is rooted there,
so two members writing a file of the *same name* write two independent files.

| step | command | cwd |
| --- | --- | --- |
| isolate | `git worktree add --detach <state>/worktrees/<team>/<n-id> HEAD` | repo root |
| *(run the member's agent, `cwd` = the worktree)* | | |
| capture | `git add --all` then `git diff --cached --binary --no-color` | worktree |
| persist | write `<state>/patches/<team>/<member>.patch` | — |
| clean up | `git worktree remove --force <dir>` | repo root |
| merge | `git apply --check` then `git apply` (no `--3way`, no `--force`) | repo root |

Budgets and safety:

- **Concurrency cap** — `concurrency` (default 3), overridable per run with
  `--parallel`. The rest queue and start as slots free, exactly like `/bg`.
- **Per-team cost ceiling** — `maxCostUsd` (default `$5`), overridable with
  `--max-cost`. Summed across members from their own `turnEnd` events; tripping
  it cuts the whole team off.
- **Per-member turn ceiling** — `maxTurnsPerMember` (default 40). Also handed
  to `spawn` on `TeamMemberBrief.maxTurns` so the host can give the real
  `Agent` a hard cap too.
- **Cancellation** — `/team cancel` (and Ctrl+C, and `StartTeamOptions.signal`)
  aborts every live member, which cascades through `@arcturn/core`'s loop and
  appends synthetic tool results, so **no tool call is left dangling**. Queued
  members never start. Every member's partial diff is captured to a patch
  *before* its worktree is removed, so cancelling costs no work.
- **A member that ignores its abort** is raced against the cutoff and torn down
  anyway. The trade-off is deliberate and documented in the source: such an
  agent may still be streaming when its worktree is deleted, which is strictly
  better than never cleaning up.

**Worktrees never outlive their member.** Removal is in a `finally` on every
path — finished, cancelled, failed, spawn threw, diff capture failed. The
`.patch` file, not the worktree, is the durable work product.

### Permissions

`createTeamSpawn` builds each member with
`runtime.buildSessionAgent({ sessionId: createSessionId(), cwd, model: router.specFor("subagent") })`
and then narrows its tools with `setTools`:

- the role's `tools` list, when it has one (a `reviewer` gets exactly
  `read, grep, glob, ls` — it *literally has no* `write`, `edit` or `bash`);
- `subagent` is always removed, so a member cannot fan out into a team of its
  own.

Permission mode and rules are inherited from the session — writes inside a
worktree are already harmless to the user's tree, but a member can still run
`bash`, and `bash` reaches the whole machine. **Do not silently upgrade members
to `yolo`.** Isolation here is filesystem-*write* isolation for the user's
tree, not a sandbox.

**One known compromise:** `buildSessionAgent` is the only factory that roots an
agent at an arbitrary `cwd` with its own checkpoint store, and it takes no
system-prompt override — so the role's instructions are folded into the
member's *prompt* by `buildMemberPrompt` rather than its system prompt. If you
want them where they belong, add an optional `systemPrompt` to
`buildSessionAgent`'s options object (it already spreads overrides onto
`#agentOptions`) and pass `brief.role.systemPrompt` in `createTeamSpawn`. Six
lines; nothing here depends on it happening. The tool narrowing is a real
restriction either way.

---

## 6. Reconciliation, and the conflict policy

`/team merge` walks members in dispatch order:

- **discarded / already merged / empty** → reported, skipped.
- otherwise `git apply --check <patch>`; if that passes, `git apply <patch>`.
- **On the first refusal the merge stops.** Members applied before it stay
  applied and are recorded `merged`, so re-running `/team merge` resumes rather
  than double-applying. Every later member is reported `skipped` — their
  patches were cut against the same base, and replaying them over a
  half-merged tree is exactly the clever auto-merge this module refuses to
  attempt.

`git apply` is used **without `--3way` and without `--force`**: it refuses a
patch whose context does not match, so a merge can fail but it cannot clobber.
Nothing is deleted on conflict — the patch stays on disk and
`formatMergeReport` names it, so the user chooses:
`git apply --3way <patch>`, re-run the member, or `/team discard`.

`/team discard` is the only operation in the module that deletes a patch.

### Crash recovery

State lives under `~/.arcturn/teams/`:

```
records/<teamId>.json     durable status, written on every transition
patches/<teamId>/<id>.patch
worktrees/<teamId>/<n-id>/
```

A record still `running`/`planning` when a fresh `TeamManager` loads it belongs
to a process that is gone, so load corrects it to `interrupted` and flags it.
`recover()` — idempotent, memoized, called by every `/team` command — then, for
each such member with a surviving worktree: **captures its diff to a patch
first**, removes the worktree, and runs `git worktree prune`. A crash therefore
costs neither work nor a leaked worktree, and the salvaged patch is mergeable
like any other. Running `recover()` twice does no further git work.

---

## 7. Config keys you may want (none are required)

Every knob has a working default. If you want them, in `config.ts`'s
`ArcturnConfig`:

```jsonc
{
  "team": {
    "concurrency": 3,      // members running at once
    "maxMembers": 5,       // most subtasks a plan may produce
    "maxCostUsd": 5.0,     // per-team ceiling
    "maxTurnsPerMember": 40
  }
}
```

Pass them into `getTeamManager`'s `new TeamManager({...})` call, and add
matching `--team-*` flags in `args.ts` if `/team` should be reachable from
`--print` (it works headlessly as-is: it never prompts, and permission asks
fail closed exactly as they do for any other tool).

Cost: a team's spend does **not** currently fold into `runtime.metrics`, so
`/cost` and `--max-cost` under-report a session that ran teams — the same gap
scouts has. The fix is one line at the `/team` call site once you are editing
`runtime.ts` anyway: `runtime.recordExternalCost(status.costUsd)` after
`start()` resolves. The per-team ceiling is the real backstop until then.

---

## 8. Test coverage (`team.test.ts`, 79 tests, all green)

Zero network throughout: a scripted `LLMClient` (`test-helpers/fake-llm.ts`),
fake `TeamAgent`s, an injectable fake `git`, and `fs.mkdtemp` scratch dirs. The
real-git block builds its **own throwaway repository** and never touches this
one.

- **Plan parsing** — well-formed; fenced and prefaced replies; bare arrays and
  key aliases; scope normalization and id de-duplication; malformed replies
  (no JSON, truncated JSON, empty array, no `subtasks`, missing `task`);
  default role.
- **Scope validation** — `normalizeScope`; `scopesOverlap` including the
  `src/a.ts` vs `src/a.ts.bak` non-boundary case; disjoint plan passes;
  overlapping plan reports the colliding pair; bounds, unscoped and
  unknown-role issues.
- **Repair** — transitive merge of an overlap chain; unscoped subtask treated
  as claiming everything; over-long plan folded, not truncated; the repaired
  plan re-validates clean.
- **Decomposition flow** — dispatch on the first turn; re-ask once on a
  malformed plan; re-ask once on overlap and dispatch only the corrected,
  disjoint scopes; **an overlapping plan that survives the re-ask is merged,
  not dispatched**, with both tasks preserved; collapse to one member reported;
  two failed attempts dispatch nothing and create no worktree; a throwing
  supervisor turn retried; empty goal rejected; a scripted `LLMClient` driving
  the whole thing.
- **Dispatch** — one worktree per member, all removed; `maxParallel` bound
  (5 members, peak exactly 2); isolation of two members writing the same
  filename; a failing member not disturbing its sibling; cost/turn/tool
  accounting; cost ceiling cutting the team off; turn ceiling aborting a
  member; live `onUpdate` transitions; role/scope/turn-budget reaching `spawn`;
  unknown role downgraded; worktree-creation failure recorded.
- **Capture & cancel** — stage-before-diff ordering; patches written to disk;
  no patch when nothing changed; cancel cascading to every member with partial
  work kept and every worktree removed; a member that finished before the
  cutoff staying `done` and still mergeable; external `AbortSignal`; failed
  teardown demoted to a warning.
- **Merge** — clean apply of every member; `--check` before every apply and
  never `--3way`/`--force`; conflict surfaced, merge stopped, patch kept on
  disk; later members not attempted; resume without re-applying; `members`
  filter; empty member never calls `git apply`; unknown team id; discard.
- **Recovery** — a stale `running` record from a dead process corrected to
  `interrupted` on load, its worktree's diff salvaged to a patch and then
  removed, `git worktree prune` run, idempotent on a second call and on a
  fresh manager; corrupt record files skipped; a finished team surviving a
  manager restart.
- **Reporting & args** — report contents; "nothing left to merge";
  `parseTeamArgs` flags, `--flag=value`, sub-command-only-when-whole, garbage
  values.
- **Command** — usage string; empty state; dispatch showing live per-member
  status then the reconciliation view; list/report; merge; conflict warning;
  discard; unknown id; already-settled cancel.
- **Runtime wiring** — `getTeamManager` memoization and markdown-agent roles;
  `createTeamPlanner` producing a parseable plan; `createTeamSpawn` narrowing a
  reviewer to `read, grep, glob, ls`, stripping `subagent`, and rooting each
  member at its own worktree.
- **Real git (gated on `git --version`)** — two members writing the *same*
  filename in their own worktrees, neither visible to the other nor to the
  user's tree, both diffs captured, no worktree left in `git worktree list`;
  disjoint members merged cleanly into a real tree; a **real** conflict
  detected with the tree holding the first member's version and the second's
  patch intact on disk; cancellation leaving no real worktree behind; a real
  orphaned worktree salvaged, removed, and its rescued patch applied.

Verify with:

```sh
pnpm --filter arcturn build
npx vitest run packages/cli
npx biome check packages/cli/src/team.ts packages/cli/src/team.test.ts
```
