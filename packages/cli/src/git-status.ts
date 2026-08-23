/**
 * Cheap, cacheable git branch/dirty status for the TUI status bar.
 *
 * {@link createGitStatusTracker} wraps two short-lived `git` spawns (current
 * branch, then a capped `git status --porcelain`) behind a small
 * time-to-live cache so a status bar can call {@link GitStatusTracker.current}
 * on every render without spawning a process per frame. See
 * `INTEGRATION-git-status.md` at the repo root for how a host application is
 * expected to wire the tracker into its render loop.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Current git branch/dirty summary for a working directory. */
export interface GitStatus {
  /** Short branch name, or the short commit SHA when `detached` is `true`. */
  branch: string;
  /** `true` when `git status --porcelain` reports any tracked change. */
  dirty: boolean;
  /** `true` when HEAD does not point at a branch (detached HEAD). */
  detached: boolean;
}

/** Result shape an {@link ExecFn} resolves with, matching `child_process.execFile`. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Injectable process-spawning function, matching the subset of
 * `node:child_process`'s promisified `execFile` that {@link createGitStatusTracker}
 * relies on. Tests supply a fake to avoid touching a real `git` binary.
 */
export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<GitExecResult>;

/** Options for {@link createGitStatusTracker}. */
export interface GitStatusTrackerOptions {
  /**
   * How long a resolved value (including a negative "not a repo" result) is
   * served from cache before {@link GitStatusTracker.refresh} spawns `git`
   * again. Default `5000`.
   */
  ttlMs?: number;
  /** Injectable process spawner; defaults to a real `git` via `execFile`. */
  execFn?: ExecFn;
}

/** Tracks one working directory's git branch/dirty status with a TTL cache. */
export interface GitStatusTracker {
  /**
   * The most recently resolved status, or `undefined` when nothing has been
   * fetched yet or the directory is not (or is no longer known to be) a git
   * work tree. Synchronous and never spawns a process — safe to call on
   * every render.
   */
  current(): GitStatus | undefined;

  /**
   * Refresh the cached status, spawning `git` only when the cache is empty
   * or has expired. Concurrent calls made before the in-flight fetch settles
   * share the same promise rather than spawning `git` again.
   *
   * @returns The freshly resolved (or still-cached) status, or `undefined`
   *   when `cwd` is not a git work tree, `git` is missing, or the spawn
   *   timed out. The `undefined` result is itself cached for `ttlMs` so a
   *   non-repository directory does not re-spawn `git` on every call.
   */
  refresh(): Promise<GitStatus | undefined>;
}

const DEFAULT_TTL_MS = 5_000;

/** Per-spawn timeout: a status bar refresh must never hang the render loop. */
const GIT_TIMEOUT_MS = 2_000;

/**
 * Cap on `git status` output read for the dirty check. A repository with an
 * enormous number of changed files still just needs to know "is it dirty",
 * so exceeding this cap is treated as "yes" (see {@link isMaxBufferError})
 * rather than as a failure.
 */
const STATUS_MAX_BUFFER = 64 * 1024;

const defaultExecFn: ExecFn = (command, args, options) =>
  execFileAsync(command, [...args], { ...options, windowsHide: true });

function isMaxBufferError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER"
  );
}

class GitStatusTrackerImpl implements GitStatusTracker {
  readonly #cwd: string;
  readonly #ttlMs: number;
  readonly #execFn: ExecFn;

  #cachedStatus: GitStatus | undefined;
  #hasCached = false;
  #cacheExpiresAt = 0;
  #inFlight: Promise<GitStatus | undefined> | undefined;

  constructor(cwd: string, options?: GitStatusTrackerOptions) {
    this.#cwd = cwd;
    this.#ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.#execFn = options?.execFn ?? defaultExecFn;
  }

  current(): GitStatus | undefined {
    return this.#cachedStatus;
  }

  refresh(): Promise<GitStatus | undefined> {
    if (this.#inFlight) return this.#inFlight;
    if (this.#hasCached && Date.now() < this.#cacheExpiresAt) {
      return Promise.resolve(this.#cachedStatus);
    }
    const promise = this.#fetch().finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = promise;
    return promise;
  }

  async #fetch(): Promise<GitStatus | undefined> {
    const head = await this.#resolveHead();
    if (head === undefined) {
      this.#store(undefined);
      return undefined;
    }
    const dirty = await this.#checkDirty();
    const status: GitStatus = { branch: head.branch, detached: head.detached, dirty };
    this.#store(status);
    return status;
  }

  /** Short branch name via `symbolic-ref`, falling back to a short SHA when detached. */
  async #resolveHead(): Promise<{ branch: string; detached: boolean } | undefined> {
    try {
      const { stdout } = await this.#git(["symbolic-ref", "--short", "-q", "HEAD"]);
      const branch = stdout.trim();
      if (branch.length > 0) return { branch, detached: false };
    } catch {
      // Detached HEAD (symbolic-ref fails by design) or not a repo: try the fallback below.
    }
    try {
      const { stdout } = await this.#git(["rev-parse", "--short", "HEAD"]);
      const sha = stdout.trim();
      if (sha.length > 0) return { branch: sha, detached: true };
    } catch {
      // Not a git repository, git is missing/unreachable, or the spawn timed out.
    }
    return undefined;
  }

  /** Whether `git status --porcelain` reports any tracked change. */
  async #checkDirty(): Promise<boolean> {
    try {
      const { stdout } = await this.#git(["status", "--porcelain", "--untracked-files=no", "-z"]);
      return stdout.length > 0;
    } catch (error) {
      // Output exceeding the cap still proves the tree is dirty.
      if (isMaxBufferError(error)) return true;
      return false;
    }
  }

  #git(args: readonly string[]): Promise<GitExecResult> {
    return this.#execFn("git", args, {
      cwd: this.#cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
    });
  }

  #store(status: GitStatus | undefined): void {
    this.#cachedStatus = status;
    this.#hasCached = true;
    this.#cacheExpiresAt = Date.now() + this.#ttlMs;
  }
}

/**
 * Create a {@link GitStatusTracker} for `cwd`.
 *
 * Nothing is spawned until the first {@link GitStatusTracker.refresh} call;
 * {@link GitStatusTracker.current} is synchronous and only ever reads the
 * cache, so a render loop can call it unconditionally.
 *
 * @param cwd - Directory to run `git` in.
 * @param options - TTL and process-spawner overrides; see {@link GitStatusTrackerOptions}.
 */
export function createGitStatusTracker(
  cwd: string,
  options?: GitStatusTrackerOptions,
): GitStatusTracker {
  return new GitStatusTrackerImpl(cwd, options);
}
