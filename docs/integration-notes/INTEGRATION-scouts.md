# Wiring SCOUTS (time-boxed parallel exploration) into the CLI

This is the integration recipe for `packages/cli/src/scouts.ts` (new file,
already in the tree with `scouts.test.ts`, **32 passing tests**). Per the
task's hard rules **no existing file was edited** — everything below is an
exact instruction for whoever wires it into `commands.ts`, `runtime.ts`,
`config.ts` and `args.ts`.

The idea in one line: before committing to an approach, send N cheap agents
down N different approaches in **isolated git worktrees**, each on a small
budget and a hard deadline; kill them at the buzzer and return their
**partial** results as a scouting report — "approach A hit a type error at
step 3; approach B looks clean". The partial result is the product. Three
half-finished spikes plus their diffs is a decision you can make; one
finished implementation of the wrong design is twenty minutes you don't get
back.

---

## 1. What's already built

`packages/cli/src/scouts.ts` exports:

```ts
// --- isolation -------------------------------------------------------------
createWorktree(repoRoot: string, name: string, options?: {
  execFn?: ExecFn;        // injectable git spawner (same shape as git-status.ts)
  parentDir?: string;     // default: a fresh mkdtemp() under the OS temp dir
  ref?: string;           // default "HEAD"
  gitTimeoutMs?: number;  // default 15_000
}): Promise<Worktree>

interface Worktree { dir: string; remove(): Promise<void> }   // remove() is idempotent

class ScoutWorktreeError extends Error { code: ScoutErrorCode }
type ScoutErrorCode = "git-missing" | "not-a-repo" | "worktree-exists" | "git-failed"

// --- the run ---------------------------------------------------------------
runScouts(options: RunScoutsOptions): Promise<ScoutReport>

interface RunScoutsOptions {
  approaches: readonly ScoutApproach[];                 // { name, task }[]
  spawn: (approach, cwd) => ScoutAgent | Promise<ScoutAgent>;
  deadlineMs: number;                                   // hard wall-clock buzzer
  repoRoot: string;
  maxParallel?: number;                                 // default: all at once
  execFn?: ExecFn;
  parentDir?: string;
  gitTimeoutMs?: number;
  onResult?: (result: ScoutResult) => void;             // live progress
  signal?: AbortSignal;                                 // Ctrl+C — see §5
}

interface ScoutResult {
  name: string; task: string;
  status: "finished" | "timeout" | "error";
  finalText: string;            // findings, or partial notes on a timeout
  toolCalls: string[];          // tool names in call order
  costUsd?: number;             // summed from that agent's own turnEnd events
  diff?: string;                // `git diff` from the worktree — the work product
  error?: string;               // failure text, or the abort reason on timeout
  durationMs: number;
  worktreeDir?: string;         // already deleted by the time you see it
}

interface ScoutReport {
  results: ScoutResult[]; deadlineMs: number; durationMs: number;
  timedOut: boolean; warnings: string[];
}

// --- reporting -------------------------------------------------------------
formatScoutReport(report: ScoutReport, options?: { excerptLines?: number }): string
summarizeDiff(diff: string | undefined): { files: number; added: number; removed: number }
slugifyScoutName(name: string): string
```

`ScoutAgent` is a **structural** subset of `@arcturn/core`'s `Agent`:

```ts
interface ScoutAgent {
  prompt(input: string): Promise<void>;
  abort(): void;
  finalText(): string;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

A real `Agent` satisfies it as-is — no adapter, no cast. That is why
`scouts.ts` has **zero** dependency on `runtime.ts` (its only in-repo import
is `formatCost` from `format.ts`) and why the whole scheduler — deadlines,
aborts, failures, concurrency bounds, cleanup — is unit-testable against fake
agents and a fake `execFn`, with no LLM and (for the main coverage) no real
`git`.

What one scout does, in git terms:

| step | command | cwd |
| --- | --- | --- |
| validate | `git rev-parse --is-inside-work-tree` | `repoRoot` |
| isolate | `git worktree add --detach <tmp>/<n-slug> HEAD` | `repoRoot` |
| *(run the agent, `cwd` = the worktree)* | | |
| capture | `git add --all` then `git diff --cached --no-color` | worktree |
| clean up | `git worktree remove --force <dir>` (+ `rm -rf` the temp parent) | `repoRoot` |

The staging step is deliberate: a scout's most interesting output is usually a
**new file**, which plain `git diff` would not show. Mutating the index is
free — the worktree is deleted seconds later. Detached checkout is also
deliberate: a branch per scout would collide across runs and leave refs behind.

---

## 2. `runtime.ts` — supplying `spawn`

`buildSessionAgent` is the right factory, and it is already exactly what a
scout needs: it does **not** swap the runtime's current agent, and it gives
the new agent its *own* checkpoint store rooted at the `cwd` you pass — so a
scout's `/rewind`-able writes snapshot against the worktree, never against the
user's tree.

Add this method to `ArcturnRuntime` (it is the whole runtime-side change):

```ts
// runtime.ts — inside class ArcturnRuntime
/**
 * Spawn one scout: a cheap, worktree-rooted agent for time-boxed exploration.
 *
 * @param approach - Name/task of the approach being explored.
 * @param cwd - The scout's isolated worktree.
 */
scoutAgent(approach: ScoutApproach, cwd: string): Agent {
  const agent = this.buildSessionAgent({
    sessionId: createSessionId(),      // its own session: scout turns must not
                                       // land in the user's transcript
    cwd,                               // the worktree
    model: this.router.specFor("subagent"),   // cheap route, same as delegation
  });
  return agent;
}
```

Then the command passes `spawn: (approach, cwd) => runtime.scoutAgent(approach, cwd)`.

Four notes on that:

1. **`createSessionId()` per scout, not the session's id.** Scouts are
   throwaway; their messages belong in their own JSONL, and `buildSessionAgent`
   keys the checkpoint store by session id, so sharing an id would let two
   scouts' checkpoints collide.
2. **`router.specFor("subagent")`** is the same cheap route `createSubagent`
   uses, so `"router": { "subagent": "..." }` in `arcturn.config.json` already
   controls scout cost with no new config key.
3. **`maxTurns`** is not settable through `buildSessionAgent` today (it reads
   `this.#maxTurns`). A scout that never stops is *handled* — the deadline
   aborts it — but a turn cap is the cheaper backstop. If you want one, either
   add an optional `maxTurns` to `buildSessionAgent`'s options object (a
   two-line change, it already spreads overrides onto `#agentOptions`) or set
   `--max-turns` for the whole session. The deadline alone is sufficient for
   correctness.
4. **Permissions are inherited, and that is the safe default.** The scout gets
   the session's permission mode and rules. In a worktree, writes are already
   harmless — but do **not** silently upgrade scouts to `"yolo"`: a scout can
   still run `bash`, and `bash` reaches the whole machine, not just its `cwd`.
   Isolation here is filesystem-*write* isolation for the user's tree, not a
   sandbox. If prompting for every scout's every edit is too noisy, the honest
   fix is a config key the user opts into (§6), not a hidden escalation.

`repoRoot` is `runtime.cwd` (a.k.a. `paths.cwd`).

---

## 3. `commands.ts` — the `/scout` command

### Parsing

Syntax: approaches separated by `|`, each optionally `name: task`.

```
/scout use a worker pool | rewrite as an event loop | just add a mutex
/scout pool: use a worker pool | loop: rewrite it as an event loop
/scout --deadline 90s --parallel 2 approach A | approach B | approach C
```

Rules: split on `|`, trim, drop empties; a leading `word:` (no spaces, ≤ 24
chars) is the approach's name, otherwise the name is the first few words of the
task; flags are parsed off the front only.

```ts
// commands.ts — a helper next to the registry
const SCOUT_NAME = /^([\w.-]{1,24}):\s*(.+)$/s;

/** Parse `/scout` arguments into approaches plus overrides. */
export function parseScoutArgs(args: string): {
  approaches: ScoutApproach[];
  deadlineMs?: number;
  maxParallel?: number;
} {
  let rest = args.trim();
  let deadlineMs: number | undefined;
  let maxParallel: number | undefined;
  for (;;) {
    const flag = /^--(deadline|parallel)[= ]\s*(\S+)\s*/.exec(rest);
    if (!flag) break;
    if (flag[1] === "deadline") deadlineMs = parseDuration(flag[2]!);   // "90s" | "2m" | "45000"
    else maxParallel = Number.parseInt(flag[2]!, 10) || undefined;
    rest = rest.slice(flag[0].length);
  }
  const approaches = rest
    .split("|")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const named = SCOUT_NAME.exec(chunk);
      if (named) return { name: named[1]!, task: named[2]!.trim() };
      return { name: chunk.split(/\s+/).slice(0, 3).join("-").toLowerCase(), task: chunk };
    });
  return {
    approaches,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(maxParallel === undefined ? {} : { maxParallel }),
  };
}
```

`slugifyScoutName` already sanitizes whatever name you produce, so the parser
never needs to worry about filesystem-hostile characters.

### The command

```ts
// commands.ts — registered alongside /diff, /apply, /cost
{
  name: "scout",
  description: "Explore several approaches in parallel worktrees under a deadline",
  async run({ runtime, ui, args }) {
    const parsed = parseScoutArgs(args);
    if (parsed.approaches.length < 2) {
      ui.notice("warn", "Usage: /scout <approach A> | <approach B> [| ...]");
      return;
    }
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);          // see §5

    ui.print(`Scouting ${parsed.approaches.length} approaches…`);
    try {
      const report = await runScouts({
        approaches: parsed.approaches,
        spawn: (approach, cwd) => runtime.scoutAgent(approach, cwd),
        deadlineMs: parsed.deadlineMs ?? runtime.config.scoutDeadlineMs ?? 120_000,
        repoRoot: runtime.cwd,
        ...(parsed.maxParallel === undefined ? {} : { maxParallel: parsed.maxParallel }),
        signal: controller.signal,
        onResult: (result) =>
          ui.print(`  ${result.name}: ${result.status} (${result.toolCalls.length} tools)`),
      });
      ui.print(formatScoutReport(report));
      for (const warning of report.warnings) ui.notice("warn", warning);
      // The winning diff is right there — offer it as the next prompt.
      const winner = report.results.find((r) => r.status === "finished" && r.diff);
      if (winner) ui.setInput(`Implement the "${winner.name}" approach here: ${winner.task}`);
    } catch (error) {
      ui.notice("error", error instanceof Error ? error.message : String(error));
    } finally {
      process.off("SIGINT", onSigint);
    }
  },
}
```

Note `ui.setInput(...)` at the end: the report's whole purpose is to pick a
winner, and the natural next action is re-running that approach **in the real
workspace** at full price. Pre-filling the editor buffer makes the handoff one
keystroke. (Storing the winning diff so `/apply` could take it instead would
mean touching `overlay.ts`'s apply path — out of scope here; the diff is on
`ScoutResult.diff` for whoever wants it.)

Also add `"scout"` to whatever completion list `completions.ts` builds, and a
line to `/help`.

---

## 4. Per-scout budget — what the cost guard actually gives you

**The honest statement of the gap:** `cost-guard.ts` is wired **per runtime**.
`buildRuntime` builds exactly one guard, reading `runtime.metrics.costUsd` and
aborting `runtime.agent` — and `runtime.metrics` is only fed by
`runtime.subscribe`, which (per `buildSessionAgent`'s own comment) *only ever
sees the runtime's current agent*. So today:

- a scout's spend does **not** count against `--max-cost`;
- `/cost` will under-report a session that ran scouts;
- and a runaway scout is stopped by the **deadline**, not by a budget.

That is survivable — the deadline is a hard stop, and a cheap-route model on a
two-minute leash cannot spend much — but it is not a budget. A real per-scout
budget needs three things, none of which `scouts.ts` can do alone:

1. **A per-scout ledger.** `createCostGuard` is already per-instance and
   event-driven, so this is the easy part — build one guard per scout inside
   `spawn`, over a *local* counter, and abort *that* agent:

   ```ts
   // runtime.ts — inside scoutAgent(), before returning
   let spent = 0;
   const guard = createCostGuard({
     limitUsd: perScoutLimitUsd,          // e.g. config.scoutMaxCostUsd
     getCostUsd: () => spent,
     abort: () => agent.abort(),
     notify: (message) => this.notify("warn", `scout "${approach.name}": ${message}`),
   });
   agent.subscribe((event) => {
     if (event.type === "turnEnd") spent += event.usage.costUsd ?? calculateCostUsd(spec, event.usage) ?? 0;
     guard.onEvent(event);
   });
   ```

   A guard-aborted scout surfaces as `status: "finished"` (its `prompt()`
   resolves normally after the abort), with a short `finalText` and a small
   diff. If you want it distinguishable in the report, have `spawn`'s closure
   record the trip and prepend a line to the scout's task summary — or accept
   the ambiguity, since the report shows cost per scout anyway.

2. **A run-level ceiling.** N scouts at `perScoutLimitUsd` each is N× the
   number the user typed. Either divide (`scoutMaxCostUsd / approaches.length`)
   or add a shared counter across all guards and pass `signal` — `runScouts`'s
   `signal` already means "stop everything now, cleanly", so a run-level budget
   is `if (total >= limit) controller.abort()` and nothing more.

3. **Folding scout spend into the session total.** This is the part that
   *requires* editing `runtime.ts`: add the report's summed `costUsd` into
   `runtime.metrics` after `runScouts` resolves (a small
   `runtime.addExternalCost(usd)` method), or `/cost` keeps lying. Note the
   ordering hazard if you do: the session's own guard reads
   `runtime.metrics.costUsd`, so folding scout spend in can trip it on the next
   `turnEnd` — which is arguably correct, but it must be a deliberate choice,
   not a surprise.

Until (3) exists, print the report's total cost line (it is in
`formatScoutReport`'s header) so the user sees what the scouts spent even
though `/cost` does not.

---

## 5. Cleanup guarantees, including Ctrl+C

A leaked worktree is a real bug: a directory of half-written code plus an
entry in `.git/worktrees` that shows up in `git worktree list` forever. The
guarantees, in order of strength:

- **Every path inside `runScouts` cleans up.** Scout finished, scout aborted at
  the buzzer, `spawn` threw, `prompt` rejected, diff capture failed — the
  worktree is removed before the result is built. `scouts.test.ts` asserts this
  for the finished / timeout / error cases *by inspecting the injected
  `execFn`'s call log*, so a future refactor that drops a `finally` fails the
  suite rather than leaking silently.
- **Removal failures never lose the report.** A failed `git worktree remove`
  becomes a `ScoutReport.warnings` entry; the temp parent directory is deleted
  regardless, so the worst case is a stale admin entry that `git worktree
  prune` clears.
- **Ctrl+C during a scout run: use `signal`.** This is why
  `RunScoutsOptions.signal` exists. An aborted signal is treated as the buzzer
  arriving early: live scouts are aborted, unstarted ones are skipped, and
  **every worktree already created is still removed** before `runScouts`
  resolves. The `/scout` sketch in §3 wires `process.once("SIGINT", ...)` to
  it. Do this rather than letting SIGINT unwind the command, because a promise
  chain that is never resumed never reaches its `finally`.
- **Ctrl+C twice / SIGKILL is unrecoverable in-process** — no `finally` runs
  when the process dies. Two backstops, both cheap:
  1. worktrees live under `mkdtemp(tmpdir(), "arcturn-scout-")`, so the OS reclaims
     the *files* on its own schedule;
  2. the git admin entries do not self-clean, so run `git worktree prune` once
     at startup (a fire-and-forget `execFile` in `buildRuntime`, failures
     ignored) — it only removes entries whose directory is already gone, so it
     can never touch a worktree the user is actually using.

The TUI's existing Ctrl+C behaviour (`main.ts` uses `process.once("SIGINT")`
for `arcturn serve`) means the `/scout` handler must **remove its listener in a
`finally`**, or a later Ctrl+C aborts a controller nobody is watching.

---

## 6. Optional config keys

None are required — every knob has a working default. If you want them, in
`config.ts`'s `ArcturnConfig`:

```jsonc
{
  "scouts": {
    "deadlineMs": 120000,     // default hard deadline for /scout
    "maxParallel": 3,         // don't melt the laptop or the rate limit
    "maxCostUsd": 0.50,       // run-level ceiling; see §4
    "ref": "HEAD"             // what scouts branch from
  }
}
```

and the matching `--scout-deadline` / `--scout-parallel` flags in `args.ts` if
`/scout` should be reachable from `--print`. (It works headlessly as-is: it
never prompts, and permission asks fail closed in `--print` exactly as they do
for any other tool.)

---

## 7. Design constraint to keep in mind

**Scouts are read-mostly exploration, and their worktrees are gone by the time
you read the report.** They exist to buy information, not to produce the
change. Concretely:

- a scout's writes can never touch the user's tree, because its `cwd` is a
  throwaway checkout;
- the report is the deliverable, and `ScoutResult.diff` carries the code so the
  report is evidence, not opinion;
- the user then re-runs the winning approach in the real workspace (full-price
  model, full turn budget) or applies its diff by hand.

`formatScoutReport` ends with exactly that instruction, so the affordance is in
the output and not only in this document. If a future version wants "apply the
winner directly", the right shape is to keep the winning worktree alive and
hand its path to `/apply` — a deliberate extension, not a default, because
"the cheap model's two-minute spike" is not the same artifact as "the change
you ship".

---

## 8. Test coverage (`scouts.test.ts`, 32 tests, all green)

- `createWorktree`: argv and cwd of every git call; custom `ref`; idempotent
  `remove()`; typed errors for **not-a-repo**, **git-missing** (`ENOENT`),
  **worktree-exists**, **git-failed**; a failing removal surfacing as
  `ScoutWorktreeError`.
- `runScouts`: a scout that finishes inside the deadline (text, tool names,
  summed cost, captured diff); staging-before-diff ordering; a hanging scout
  aborted at a 120 ms deadline reporting `"timeout"` **with its partial text
  and diff**; a rejecting `prompt` and a throwing `spawn` reporting `"error"`
  without disturbing the sibling scout; a failed worktree creation; a failed
  cleanup demoted to a warning; `maxParallel` bounding a max-concurrency
  counter (5 approaches, peak exactly 2); unbounded default; queued scouts
  marked timed out; per-approach worktree paths; `onResult` ordering; `signal`
  cancellation mid-run and pre-aborted; `RangeError` on a non-positive
  deadline; empty-approaches short circuit.
- **Cleanup is asserted in every one of those cases** via the injected
  `execFn`'s call log (`removedDirs(git)` must equal `addedDirs(git)`).
- `summarizeDiff` and `formatScoutReport` output, including the "nothing
  finished" and warnings branches.
- A `describe.skipIf(!hasGit)` block runs the whole thing against **real git**:
  a temp repo, a real detached worktree, proof that a write inside it does not
  appear in the parent repo, a real captured diff of a file the scout created,
  and proof after teardown that both the directory and the `git worktree list`
  entry are gone.

Verify with:

```sh
npx vitest run packages/cli/src/scouts.test.ts
npx tsc -p packages/cli/tsconfig.json --noEmit
npx biome check packages/cli/src/scouts.ts packages/cli/src/scouts.test.ts
```
