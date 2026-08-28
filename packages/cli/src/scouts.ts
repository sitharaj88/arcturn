/**
 * SCOUTS — time-boxed parallel exploration in throwaway git worktrees.
 *
 * The expensive mistake in agentic coding is not a wrong edit; it is
 * *committing to the wrong approach* and then spending twenty minutes and a
 * dollar of tokens discovering that the chosen design collides with a type
 * the model never read. Humans avoid this by spiking: try three things badly
 * for five minutes each, then pick. Nothing in this class of tool does that,
 * because doing it needs two things at once — real isolation (three agents
 * editing the same working tree is a mess, not an experiment) and a *hard*
 * stop (an exploration that runs to completion is not an exploration, it is
 * three full implementations at triple the cost).
 *
 * This module supplies both. {@link createWorktree} gives every scout its own
 * `git worktree add --detach` checkout of `HEAD`, so a scout's writes land in
 * a directory the user has never seen and cannot break the tree they are
 * sitting in. {@link runScouts} spawns one agent per approach rooted in its
 * own worktree, runs them concurrently under a `maxParallel` bound, and at
 * `deadlineMs` **aborts every scout that has not finished** — then reports
 * what each one had gotten as far as. The partial result is the point: "A hit
 * a type error at step 3, B looks clean, C never got past reading the router"
 * is a decision-grade answer, and it is worth strictly more than any single
 * scout's finished output.
 *
 * ## Scouts are read-mostly, and their output is a report — not a commit
 *
 * A scout is deliberately *not* a way to get work done. It is a way to buy
 * information about which approach is worth doing. Three consequences, all
 * intentional:
 *
 * - **Scout writes never touch the user's tree.** Each agent's `cwd` is the
 *   worktree, so even a scout with full write permission mutates only a
 *   temporary checkout. The worktree is destroyed at the end of the run,
 *   always (see the cleanup guarantee below).
 * - **The diff *is* the work product.** {@link ScoutResult.diff} carries
 *   `git diff` from that worktree, so a scouting report is not just prose
 *   about what an approach would look like — it contains the code. The user
 *   reviews the report and then either re-runs the winning approach in the
 *   real workspace with the full-price model, or applies its diff directly.
 * - **Cheap by construction.** The caller supplies `spawn`, and is expected
 *   to hand back agents on the *subagent* route (`router.specFor("subagent")`)
 *   with a low turn cap. See `INTEGRATION-scouts.md` for the exact wiring.
 *
 * ## Why the caller supplies `spawn`
 *
 * {@link runScouts} never imports `ArcturnRuntime`. It asks for a function from
 * `(approach, cwd)` to something satisfying {@link ScoutAgent} — a structural
 * subset of `@arcturn/core`'s `Agent` (`prompt`/`abort`/`finalText`/
 * `subscribe`). A real `Agent` satisfies it as-is, which keeps the production
 * wiring a one-liner (`runtime.buildSessionAgent({ sessionId, cwd, model })`),
 * while the tests drive the entire scheduler — deadlines, aborts, failures,
 * concurrency bounds, cleanup — with fake agents and a fake `execFn`, never
 * touching an LLM and (for the main coverage) never touching real `git`.
 *
 * ## The cleanup guarantee
 *
 * A leaked worktree is a real bug: it is a directory of half-written code
 * plus an entry in `.git/worktrees` that `git worktree list` will show the
 * user forever. Every worktree this module creates is removed in a `finally`,
 * on *every* exit path — the scout finished, the scout was aborted at the
 * buzzer, `spawn` threw, `prompt` rejected, the diff capture failed. Removal
 * failures are non-fatal and surface as {@link ScoutReport.warnings} rather
 * than replacing the report the user is waiting for.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@arcturn/types";
import { formatCost, formatCostTotal } from "./format.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- git plumbing

/** Result shape an {@link ExecFn} resolves with, matching `child_process.execFile`. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Injectable process spawner, mirroring `git-status.ts`'s {@link ExecFn} so
 * both modules fake `git` the same way in tests.
 */
export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<GitExecResult>;

/** Why a worktree operation failed, in a form a caller can branch on. */
export type ScoutErrorCode =
  /** The `git` binary could not be spawned (`ENOENT`). */
  | "git-missing"
  /** `repoRoot` is not inside a git work tree. */
  | "not-a-repo"
  /** The repository has no commits yet, so there is nothing to branch from. */
  | "empty-repo"
  /** The target directory already exists, or git already tracks a worktree there. */
  | "worktree-exists"
  /** `git` ran and failed for any other reason (unborn HEAD, locked index, …). */
  | "git-failed";

/** A typed failure from {@link createWorktree}. */
export class ScoutWorktreeError extends Error {
  /** Machine-readable failure kind. */
  readonly code: ScoutErrorCode;

  /**
   * @param code - Failure kind; see {@link ScoutErrorCode}.
   * @param message - Human-readable explanation.
   * @param options - Standard `Error` options (`cause`).
   */
  constructor(code: ScoutErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScoutWorktreeError";
    this.code = code;
  }
}

/** A temporary checkout owned by one scout. */
export interface Worktree {
  /** Absolute path to the checked-out directory; use it as the scout's `cwd`. */
  dir: string;
  /**
   * Detach the worktree (`git worktree remove --force`) and delete the
   * temporary directory holding it. Idempotent: a second call is a no-op.
   *
   * @throws {@link ScoutWorktreeError} when `git worktree remove` fails. The
   *   temporary directory is deleted regardless, so a failure here leaves at
   *   most a stale administrative entry that `git worktree prune` clears.
   */
  remove(): Promise<void>;
}

/** Options for {@link createWorktree}. */
export interface CreateWorktreeOptions {
  /** Injectable process spawner; defaults to a real `git` via `execFile`. */
  execFn?: ExecFn;
  /**
   * Directory to create the worktree *inside*. Defaults to a fresh
   * `mkdtemp` directory under the OS temp dir, which is also deleted by
   * {@link Worktree.remove}. Supply this to keep scouts on a specific
   * filesystem (or to point tests at a scratch dir).
   */
  parentDir?: string;
  /** Commit-ish to check out. Default `"HEAD"`. */
  ref?: string;
  /** Per-`git`-spawn timeout in milliseconds. Default `15000`. */
  gitTimeoutMs?: number;
}

/** Per-spawn timeout for worktree add/remove. */
const GIT_TIMEOUT_MS = 15_000;

/** Output cap for bookkeeping git calls (`rev-parse`, `worktree add`, `add -A`). */
const SMALL_MAX_BUFFER = 256 * 1024;

/** Output cap for a captured `git diff`. Larger than a scout should ever produce. */
const DIFF_MAX_BUFFER = 4 * 1024 * 1024;

const defaultExecFn: ExecFn = (command, args, options) =>
  execFileAsync(command, [...args], { ...options, windowsHide: true });

function isMissingBinary(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT";
}

function stderrOf(error: unknown): string {
  const value = (error as { stderr?: unknown } | undefined)?.stderr;
  return typeof value === "string" ? value : "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Turn an arbitrary approach name into a filesystem-safe directory segment.
 *
 * @param name - Caller-supplied approach name.
 * @returns A lowercase `[a-z0-9._-]` slug, capped at 40 characters, never empty.
 */
export function slugifyScoutName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  // "." and ".." are legal under the charset above but are path segments, not
  // names: joined onto a parent they escape it, and `remove()` would then
  // rm -rf the wrong tree.
  if (slug.length === 0 || slug === "." || slug === "..") return "scout";
  return slug;
}

/**
 * Create an isolated `git worktree` for one scout.
 *
 * Runs `git worktree add --detach <dir> <ref>` from `repoRoot`. The worktree
 * is detached on purpose: a named branch per scout would collide across runs
 * and leave refs behind, whereas a detached checkout is pure scratch space.
 *
 * The repository is validated first (`git rev-parse --is-inside-work-tree`)
 * so a missing `git` and a non-repository directory produce distinguishable
 * {@link ScoutWorktreeError} codes instead of one opaque exit status.
 *
 * @param repoRoot - Directory inside the repository to branch the worktree from.
 * @param name - Approach name; slugified into the directory name.
 * @param options - Spawner, parent directory, ref and timeout overrides.
 * @returns The worktree's directory plus its {@link Worktree.remove} teardown.
 * @throws {@link ScoutWorktreeError} with code `"git-missing"`, `"not-a-repo"`,
 *   `"worktree-exists"` or `"git-failed"`.
 */
export async function createWorktree(
  repoRoot: string,
  name: string,
  options?: CreateWorktreeOptions,
): Promise<Worktree> {
  const execFn = options?.execFn ?? defaultExecFn;
  const timeout = options?.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  // `worktree add` performs a full checkout, so its cost scales with the
  // repository while every other command here is metadata. One 15-second cap
  // for both shapes was how a team member on a loaded CI mac died mid-add
  // with "Preparing worktree…" as its entire error — the progress line of a
  // command that was killed, not one that failed. Four times the quick-op
  // budget, floored at a minute, keeps a starved machine or a large checkout
  // from being read as a member's failure.
  const addTimeout = Math.max(timeout * 4, 60_000);
  const ref = options?.ref ?? "HEAD";
  const git = (cwd: string, args: readonly string[], timeoutMs = timeout): Promise<GitExecResult> =>
    execFn("git", args, { cwd, timeout: timeoutMs, maxBuffer: SMALL_MAX_BUFFER });

  try {
    await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (isMissingBinary(error)) {
      throw new ScoutWorktreeError(
        "git-missing",
        "Scouts need the `git` binary on PATH to create isolated worktrees.",
        { cause: error },
      );
    }
    throw new ScoutWorktreeError(
      "not-a-repo",
      `Scouts need a git repository: ${repoRoot} is not inside a git work tree.`,
      { cause: error },
    );
  }

  // A freshly `git init`ed repository has an *unborn* HEAD — it points at a
  // branch with no commit — and `git worktree add --detach <dir> HEAD` refuses
  // it as "invalid reference: HEAD", which names git's mechanics instead of
  // the user's situation. This is the very first thing a person following
  // "mkdir, git init, run the setup workflow" hits, so the refusal must hand
  // them their next command rather than a riddle.
  if ((options?.ref ?? "HEAD") === "HEAD") {
    try {
      await git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {
      throw new ScoutWorktreeError(
        "empty-repo",
        `${repoRoot} has no commits yet, and a worktree needs one to branch from. ` +
          `Make an initial commit first: git commit --allow-empty -m "chore: init"`,
      );
    }
  }

  // A fresh mkdtemp per worktree means two approaches with the same name can
  // never collide, and gives `remove()` one directory to delete.
  const ownsParent = options?.parentDir === undefined;
  const parent = options?.parentDir ?? (await mkdtemp(join(tmpdir(), "arcturn-scout-")));
  const dir = join(parent, slugifyScoutName(name));

  try {
    await git(repoRoot, ["worktree", "add", "--detach", dir, ref], addTimeout);
  } catch (error) {
    // Env-gated forensics, kept on purpose. The team-merge flake took three
    // sessions to pin because the only witness was a one-line error whose
    // stderr was a progress message; this prints the whole shape of a failed
    // `worktree add` (exit code, signal, killed flag, both streams) so the
    // next intermittent failure carries its own evidence out of CI.
    if (process.env.ARCTURN_TEAM_DEBUG) {
      const failed = error as {
        code?: unknown;
        signal?: unknown;
        killed?: unknown;
        stdout?: unknown;
        stderr?: unknown;
        message?: unknown;
      };
      console.error(
        "[worktree-add-debug]",
        JSON.stringify({
          code: failed.code,
          signal: failed.signal,
          killed: failed.killed,
          stdout: String(failed.stdout ?? "").slice(0, 200),
          stderr: String(failed.stderr ?? "").slice(0, 300),
          message: String(failed.message ?? "").slice(0, 200),
        }),
      );
    }
    if (ownsParent) await rm(parent, { recursive: true, force: true }).catch(() => undefined);
    if (isMissingBinary(error)) {
      throw new ScoutWorktreeError(
        "git-missing",
        "Scouts need the `git` binary on PATH to create isolated worktrees.",
        { cause: error },
      );
    }
    const stderr = stderrOf(error);
    if (/already exists|is already (?:checked out|registered)/i.test(stderr)) {
      throw new ScoutWorktreeError(
        "worktree-exists",
        `A worktree already exists at ${dir}; remove it (\`git worktree remove --force\`) and retry.`,
        { cause: error },
      );
    }
    // A killed process's stderr is whatever it had printed — for `worktree
    // add`, usually the "Preparing worktree" progress line, which reads as
    // nonsense in an error. Say what actually happened.
    if ((error as { killed?: boolean }).killed === true) {
      throw new ScoutWorktreeError(
        "git-failed",
        `git worktree add timed out after ${addTimeout}ms for ${dir} — the machine may be ` +
          `under heavy load, or the checkout is large.`,
        { cause: error },
      );
    }
    throw new ScoutWorktreeError(
      "git-failed",
      `git worktree add failed for ${dir}: ${stderr.trim() || messageOf(error)}`,
      { cause: error },
    );
  }

  let removed = false;
  return {
    dir,
    async remove(): Promise<void> {
      if (removed) return;
      removed = true;
      let failure: unknown;
      try {
        await git(repoRoot, ["worktree", "remove", "--force", dir]);
      } catch (error) {
        failure = error;
      }
      // Delete the temp parent even when git refused, so a scout run never
      // leaves a directory of half-written code behind.
      if (ownsParent) await rm(parent, { recursive: true, force: true }).catch(() => undefined);
      if (failure !== undefined) {
        throw new ScoutWorktreeError(
          "git-failed",
          `git worktree remove failed for ${dir}: ${stderrOf(failure).trim() || messageOf(failure)}`,
          { cause: failure },
        );
      }
    },
  };
}

// --------------------------------------------------------------------- scouting

/** One approach to explore. */
export interface ScoutApproach {
  /** Short label, used for the worktree directory and the report. */
  name: string;
  /** The prompt handed to this scout's agent. */
  task: string;
}

/**
 * The subset of `@arcturn/core`'s `Agent` a scout needs.
 *
 * Structural on purpose: a real `Agent` satisfies it without adaptation, and
 * a test can implement it in ten lines.
 */
export interface ScoutAgent {
  /** Run the scout's task to completion (or until {@link ScoutAgent.abort}). */
  prompt(input: string): Promise<void>;
  /** Abort the in-flight run; called on every unfinished scout at the deadline. */
  abort(): void;
  /** Text of the last assistant message — the scout's findings. */
  finalText(): string;
  /**
   * Subscribe to the agent's events, used to collect tool names and cost.
   *
   * @param listener - Receives every event.
   * @returns An unsubscribe function.
   */
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

/** How a scout's run ended. */
export type ScoutStatus =
  /** The agent's run completed before the deadline. */
  | "finished"
  /** The agent was still running at the deadline and was aborted. */
  | "timeout"
  /** The worktree, the spawn, or the run itself failed. */
  | "error";

/** What one scout came back with. */
export interface ScoutResult {
  /** The approach's name. */
  name: string;
  /** The task the scout was given. */
  task: string;
  /** How the run ended; see {@link ScoutStatus}. */
  status: ScoutStatus;
  /** Last assistant text — findings for a finished scout, partial notes otherwise. */
  finalText: string;
  /** Tool names in call order, so a report can say what the scout actually did. */
  toolCalls: string[];
  /** Cumulative USD cost, when any turn reported pricing. */
  costUsd?: number;
  /** `git diff` from the scout's worktree — the work product. */
  diff?: string;
  /** Failure text when `status` is `"error"` (or the abort reason on timeout). */
  error?: string;
  /** Wall time from worktree creation to teardown, in milliseconds. */
  durationMs: number;
  /** The worktree the scout ran in, for the report. Already deleted by then. */
  worktreeDir?: string;
}

/** The full outcome of one {@link runScouts} call. */
export interface ScoutReport {
  /** One entry per approach, in the order the approaches were supplied. */
  results: ScoutResult[];
  /** The deadline the run was given, in milliseconds. */
  deadlineMs: number;
  /** Wall time of the whole run, in milliseconds. */
  durationMs: number;
  /**
   * `true` when the run was cut short — the deadline fired or
   * {@link RunScoutsOptions.signal} aborted — so at least one scout was
   * stopped before it was done.
   */
  timedOut: boolean;
  /** Non-fatal problems (failed cleanups, unreadable diffs). */
  warnings: string[];
}

/** Options for {@link runScouts}. */
export interface RunScoutsOptions {
  /** Approaches to explore, one worktree and one agent each. */
  approaches: readonly ScoutApproach[];
  /**
   * Builds the agent for one approach, rooted at its worktree.
   *
   * Wired in production to `runtime.buildSessionAgent({ sessionId, cwd, model })`
   * with `model = router.specFor("subagent")`; see `INTEGRATION-scouts.md`.
   *
   * @param approach - The approach being explored.
   * @param cwd - The scout's isolated worktree directory.
   */
  spawn: (approach: ScoutApproach, cwd: string) => ScoutAgent | Promise<ScoutAgent>;
  /** Hard wall-clock budget for the whole run. Every scout still running is aborted. */
  deadlineMs: number;
  /** Repository the worktrees branch from. */
  repoRoot: string;
  /** Maximum scouts running at once. Default: all of them. */
  maxParallel?: number;
  /** Injectable process spawner, shared by worktree creation and diff capture. */
  execFn?: ExecFn;
  /** Parent directory for worktrees; see {@link CreateWorktreeOptions.parentDir}. */
  parentDir?: string;
  /** Per-`git`-spawn timeout in milliseconds. Default `15000`. */
  gitTimeoutMs?: number;
  /** Called as each scout settles, for live progress rendering. */
  onResult?: (result: ScoutResult) => void;
  /**
   * Cancels the run early — an aborted signal behaves exactly like the
   * deadline arriving now: every live scout is aborted, unstarted scouts are
   * skipped, and *every worktree is still cleaned up* before the report
   * resolves. Wire it to the CLI's Ctrl+C so an interrupted scout run cannot
   * leave worktrees behind; see `INTEGRATION-scouts.md`.
   */
  signal?: AbortSignal;
}

/**
 * Capture the scout's work product as a diff.
 *
 * Staged first (`git add --all`) so files the scout *created* — usually the
 * most interesting part of an exploration — appear in the diff instead of
 * being invisible as untracked noise. Mutating the index is free here: the
 * worktree is deleted seconds later.
 */
async function captureDiff(
  dir: string,
  execFn: ExecFn,
  timeout: number,
): Promise<{ diff?: string; warning?: string }> {
  try {
    await execFn("git", ["add", "--all"], { cwd: dir, timeout, maxBuffer: SMALL_MAX_BUFFER });
  } catch {
    // Staging failed (locked index, permissions): fall through and diff the
    // tracked changes anyway — a partial diff beats no diff.
  }
  try {
    const { stdout } = await execFn("git", ["diff", "--cached", "--no-color"], {
      cwd: dir,
      timeout,
      maxBuffer: DIFF_MAX_BUFFER,
    });
    return { diff: stdout };
  } catch (error) {
    return { warning: `could not capture diff from ${dir}: ${messageOf(error)}` };
  }
}

/**
 * Explore several approaches in parallel under a hard deadline, and report
 * what each one got as far as.
 *
 * Each approach gets its own detached worktree of `repoRoot`'s `HEAD` and an
 * agent from `spawn` rooted there. Scouts run concurrently, bounded by
 * `maxParallel`. When `deadlineMs` elapses every scout still running is
 * aborted and recorded as `"timeout"` — with its partial text and diff
 * intact, because the partial result is the reason to run scouts at all.
 * Approaches that had not started when the deadline fired are recorded as
 * `"timeout"` too, with an explanatory `error`.
 *
 * A scout that fails — bad worktree, throwing `spawn`, rejecting `prompt` —
 * is recorded as `"error"` and does not disturb the others.
 *
 * An aborted `options.signal` (wire it to Ctrl+C) is treated as the deadline
 * arriving early, cleanup included.
 *
 * Every worktree is removed before this resolves, on every path.
 *
 * @param options - See {@link RunScoutsOptions}.
 * @returns The scouting report; render it with {@link formatScoutReport}.
 * @throws {@link RangeError} when `deadlineMs` is not a positive finite number.
 */
export async function runScouts(options: RunScoutsOptions): Promise<ScoutReport> {
  const { approaches, spawn, deadlineMs, repoRoot } = options;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError(
      `runScouts: deadlineMs must be a positive finite number, got ${deadlineMs}`,
    );
  }
  const execFn = options.execFn ?? defaultExecFn;
  const gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const startedAt = Date.now();
  const warnings: string[] = [];
  const results: ScoutResult[] = [];

  if (approaches.length === 0) {
    return { results, deadlineMs, durationMs: 0, timedOut: false, warnings };
  }

  const live = new Set<ScoutAgent>();
  let timedOut = false;
  let cutoffReason: string | undefined;
  let fireDeadline: () => void = () => {};
  const deadline = new Promise<void>((resolve) => {
    fireDeadline = resolve;
  });
  /** The buzzer: the deadline expiring and `signal` aborting share one path. */
  const cutoff = (reason: string): void => {
    if (cutoffReason !== undefined) return;
    cutoffReason = reason;
    timedOut = true;
    for (const agent of live) {
      // One agent whose abort() throws must not spare the others.
      try {
        agent.abort();
      } catch (error) {
        warnings.push(`abort failed for a scout: ${messageOf(error)}`);
      }
    }
    fireDeadline();
  };
  const timer = setTimeout(() => cutoff(`aborted at the ${deadlineMs}ms deadline`), deadlineMs);
  const onCancel = (): void => cutoff("aborted: the scout run was cancelled");
  options.signal?.addEventListener("abort", onCancel, { once: true });
  if (options.signal?.aborted) onCancel();

  async function runOne(approach: ScoutApproach, index: number): Promise<ScoutResult> {
    const begunAt = Date.now();
    const base: ScoutResult = {
      name: approach.name,
      task: approach.task,
      status: "error",
      finalText: "",
      toolCalls: [],
      durationMs: 0,
    };

    if (timedOut) {
      return {
        ...base,
        status: "timeout",
        error: `${cutoffReason ?? "deadline elapsed"} before this scout started`,
        durationMs: Date.now() - begunAt,
      };
    }

    let worktree: Worktree | undefined;
    try {
      worktree = await createWorktree(repoRoot, `${index + 1}-${approach.name}`, {
        execFn,
        gitTimeoutMs,
        ...(options.parentDir === undefined ? {} : { parentDir: options.parentDir }),
      });
    } catch (error) {
      return { ...base, error: messageOf(error), durationMs: Date.now() - begunAt };
    }

    const toolCalls: string[] = [];
    let costUsd: number | undefined;
    let agent: ScoutAgent | undefined;
    let status: ScoutStatus = "finished";
    let failure: string | undefined;
    let unsubscribe: (() => void) | undefined;

    try {
      agent = await spawn(approach, worktree.dir);
      unsubscribe = agent.subscribe((event) => {
        if (event.type === "toolStart") toolCalls.push(event.toolName);
        else if (event.type === "turnEnd" && event.usage.costUsd !== undefined) {
          costUsd = (costUsd ?? 0) + event.usage.costUsd;
        }
      });
      live.add(agent);
      // The cutoff may have fired while `spawn()` was in flight, in which case
      // this agent missed the abort fan-out — abort it now or it keeps
      // streaming (and spending) against a worktree about to be deleted.
      if (cutoffReason !== undefined) {
        try {
          agent.abort();
        } catch {
          // An abort that throws must not mask the scout's own result.
        }
      }
      // Racing the deadline rather than relying on abort() alone: a scout
      // whose run ignores its abort signal must still be reported at the
      // buzzer, or one stuck agent holds the whole report hostage.
      const run = agent.prompt(approach.task);
      // The loser of the race is still pending; swallow its eventual
      // rejection so an aborted scout cannot raise an unhandled rejection.
      run.catch(() => undefined);
      const finished = await Promise.race([
        run.then(() => true as const),
        deadline.then(() => false as const),
      ]);
      if (!finished) {
        status = "timeout";
        failure = cutoffReason ?? `aborted at the ${deadlineMs}ms deadline`;
      }
    } catch (error) {
      status = "error";
      failure = messageOf(error);
    } finally {
      unsubscribe?.();
      if (agent) live.delete(agent);
    }

    let finalText = "";
    if (agent) {
      try {
        finalText = agent.finalText();
      } catch (error) {
        warnings.push(`finalText() failed for scout "${approach.name}": ${messageOf(error)}`);
      }
    }

    const captured = await captureDiff(worktree.dir, execFn, gitTimeoutMs);
    if (captured.warning) warnings.push(captured.warning);

    // ALWAYS: a leaked worktree outlives the run and shows up in the user's
    // `git worktree list` forever.
    try {
      await worktree.remove();
    } catch (error) {
      warnings.push(messageOf(error));
    }

    return {
      name: approach.name,
      task: approach.task,
      status,
      finalText,
      toolCalls,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(captured.diff === undefined ? {} : { diff: captured.diff }),
      ...(failure === undefined ? {} : { error: failure }),
      durationMs: Date.now() - begunAt,
      worktreeDir: worktree.dir,
    };
  }

  const limit = Math.max(1, Math.min(options.maxParallel ?? approaches.length, approaches.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const approach = approaches[index];
      if (approach === undefined) return;
      const result = await runOne(approach, index);
      results[index] = result;
      options.onResult?.(result);
    }
  };

  try {
    await Promise.all(Array.from({ length: limit }, worker));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    fireDeadline();
  }

  return {
    results,
    deadlineMs,
    durationMs: Date.now() - startedAt,
    timedOut,
    warnings,
  };
}

// -------------------------------------------------------------------- reporting

/** Line counts derived from a unified diff. */
export interface DiffSummary {
  /** Number of `diff --git` file headers. */
  files: number;
  /** Added lines (`+`, excluding the `+++` header). */
  added: number;
  /** Removed lines (`-`, excluding the `---` header). */
  removed: number;
}

/**
 * Summarize a unified diff into file/line counts for the report.
 *
 * @param diff - `git diff` output; `undefined` or empty yields all zeroes.
 */
export function summarizeDiff(diff: string | undefined): DiffSummary {
  const summary: DiffSummary = { files: 0, added: 0, removed: 0 };
  if (!diff) return summary;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) summary.files++;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) summary.added++;
    else if (line.startsWith("-")) summary.removed++;
  }
  return summary;
}

function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_LABEL: Record<ScoutStatus, string> = {
  finished: "finished",
  timeout: "TIMEOUT",
  error: "ERROR",
};

/** Collapse repeated tool names into `read x3, edit, bash`. */
function formatToolCalls(toolCalls: readonly string[]): string {
  if (toolCalls.length === 0) return "no tool calls";
  const counts = new Map<string, number>();
  for (const name of toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts].map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
  return `${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** First non-empty lines of a scout's text, capped so the report stays scannable. */
function excerpt(text: string, maxLines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

/**
 * Render a {@link ScoutReport} as a readable side-by-side comparison.
 *
 * Deliberately shows diff *size* rather than diff content: the report is for
 * choosing between approaches, and the full diff is available on
 * {@link ScoutResult.diff} for whichever one wins.
 *
 * @param report - The report from {@link runScouts}.
 * @param options - `excerptLines` caps each scout's quoted findings (default `4`).
 * @returns Lines ready to hand to a `print`-style UI, joined by newlines.
 */
export function formatScoutReport(
  report: ScoutReport,
  options?: { excerptLines?: number },
): string {
  const excerptLines = options?.excerptLines ?? 4;
  const count = report.results.length;
  if (count === 0) return "Scouting report: no approaches were explored.";

  const totalCost = report.results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
  // Each scout line below already says "cost unknown" where it applies; the
  // total has to agree with them. Summing the unknowns as zero made three
  // unpriced scouts read as "total $0.00", i.e. free.
  const unpriced = report.results.filter((result) => result.costUsd === undefined).length;
  const lines: string[] = [
    `Scouting report — ${count} approach${count === 1 ? "" : "es"}, ` +
      `deadline ${formatSeconds(report.deadlineMs)}, elapsed ${formatSeconds(report.durationMs)}, ` +
      `total ${formatCostTotal(totalCost, unpriced === 0)}`,
    "",
  ];

  report.results.forEach((result, index) => {
    const diff = summarizeDiff(result.diff);
    const cost = result.costUsd === undefined ? "cost unknown" : formatCost(result.costUsd);
    lines.push(
      `[${index + 1}] ${result.name} — ${STATUS_LABEL[result.status]} ` +
        `in ${formatSeconds(result.durationMs)}, ${cost}`,
    );
    lines.push(`    ${formatToolCalls(result.toolCalls)}`);
    lines.push(
      diff.files === 0
        ? "    diff: no changes"
        : `    diff: ${diff.files} file${diff.files === 1 ? "" : "s"}, +${diff.added}/-${diff.removed}`,
    );
    if (result.error)
      lines.push(`    ${result.status === "timeout" ? "note" : "error"}: ${result.error}`);
    const notes = excerpt(result.finalText, excerptLines);
    if (notes.length > 0) for (const note of notes) lines.push(`    | ${note}`);
    lines.push("");
  });

  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
    lines.push("");
  }

  const finished = report.results.filter((result) => result.status === "finished");
  const winner = finished.reduce<ScoutResult | undefined>(
    (best, result) =>
      best === undefined || summarizeDiff(result.diff).files > summarizeDiff(best.diff).files
        ? result
        : best,
    undefined,
  );
  lines.push(
    winner === undefined
      ? "No scout finished within the deadline; the partial results above are all there is."
      : `Scouts are exploration only — their worktrees are gone. Re-run "${winner.name}" ` +
          "in the real workspace, or apply its diff.",
  );
  return lines.join("\n");
}
