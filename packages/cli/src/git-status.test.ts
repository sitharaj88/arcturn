import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitStatusTracker, type ExecFn, type GitExecResult } from "./git-status.js";

const execFileAsync = promisify(execFile);

/** Builds a fake {@link ExecFn} from a map of `"<args joined by space>" -> handler`. */
function fakeExec(handlers: Record<string, () => GitExecResult | Promise<GitExecResult>>): {
  execFn: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const execFn: ExecFn = async (command, args) => {
    calls.push([command, ...args]);
    const key = args.join(" ");
    const handler = handlers[key];
    if (!handler) {
      throw Object.assign(new Error(`fatal: no handler for "${key}"`), { code: 128 });
    }
    return handler();
  };
  return { execFn, calls };
}

const SYMBOLIC_REF = "symbolic-ref --short -q HEAD";
const REV_PARSE = "rev-parse --short HEAD";
const STATUS = "status --porcelain --untracked-files=no -z";

function notARepoError(): never {
  throw Object.assign(new Error("fatal: not a git repository"), { code: 128 });
}

describe("createGitStatusTracker", () => {
  it("parses the branch name from symbolic-ref and reports clean when status is empty", async () => {
    const { execFn, calls } = fakeExec({
      [SYMBOLIC_REF]: () => ({ stdout: "main\n", stderr: "" }),
      [STATUS]: () => ({ stdout: "", stderr: "" }),
    });
    const tracker = createGitStatusTracker("/repo", { execFn });

    expect(tracker.current()).toBeUndefined();
    const status = await tracker.refresh();

    expect(status).toEqual({ branch: "main", dirty: false, detached: false });
    expect(tracker.current()).toEqual(status);
    expect(calls).toEqual([
      ["git", "symbolic-ref", "--short", "-q", "HEAD"],
      ["git", "status", "--porcelain", "--untracked-files=no", "-z"],
    ]);
  });

  it("falls back to a short SHA and marks detached when symbolic-ref fails", async () => {
    const { execFn } = fakeExec({
      [SYMBOLIC_REF]: notARepoError,
      [REV_PARSE]: () => ({ stdout: "abc1234\n", stderr: "" }),
      [STATUS]: () => ({ stdout: "", stderr: "" }),
    });
    const tracker = createGitStatusTracker("/repo", { execFn });

    const status = await tracker.refresh();

    expect(status).toEqual({ branch: "abc1234", dirty: false, detached: true });
  });

  it("reports dirty when git status reports porcelain output", async () => {
    const { execFn } = fakeExec({
      [SYMBOLIC_REF]: () => ({ stdout: "feature\n", stderr: "" }),
      [STATUS]: () => ({ stdout: " M file.ts\0", stderr: "" }),
    });
    const tracker = createGitStatusTracker("/repo", { execFn });

    const status = await tracker.refresh();

    expect(status).toEqual({ branch: "feature", dirty: true, detached: false });
  });

  it("treats a capped (maxBuffer-exceeded) status output as dirty rather than a failure", async () => {
    const { execFn } = fakeExec({
      [SYMBOLIC_REF]: () => ({ stdout: "main\n", stderr: "" }),
      [STATUS]: () => {
        throw Object.assign(new Error("stdout maxBuffer exceeded"), {
          code: "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER",
        });
      },
    });
    const tracker = createGitStatusTracker("/repo", { execFn });

    const status = await tracker.refresh();

    expect(status).toEqual({ branch: "main", dirty: true, detached: false });
  });

  it("resolves undefined and negative-caches when the directory is not a git repository", async () => {
    const { execFn, calls } = fakeExec({
      [SYMBOLIC_REF]: notARepoError,
      [REV_PARSE]: notARepoError,
    });
    const tracker = createGitStatusTracker("/not-a-repo", { execFn, ttlMs: 5_000 });

    const first = await tracker.refresh();
    expect(first).toBeUndefined();
    expect(tracker.current()).toBeUndefined();
    expect(calls).toHaveLength(2);

    // Within the TTL, refresh() must serve the cached negative result without re-spawning.
    const second = await tracker.refresh();
    expect(second).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("re-fetches after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const execFn: ExecFn = async (_command, args) => {
        const key = args.join(" ");
        if (key === SYMBOLIC_REF) {
          call += 1;
          return { stdout: call === 1 ? "main\n" : "develop\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };
      const tracker = createGitStatusTracker("/repo", { execFn, ttlMs: 1_000 });

      const first = await tracker.refresh();
      expect(first?.branch).toBe("main");

      // Still within the TTL: cached value, no re-fetch.
      const stillCached = await tracker.refresh();
      expect(stillCached?.branch).toBe("main");
      expect(call).toBe(1);

      vi.advanceTimersByTime(1_001);

      const afterTtl = await tracker.refresh();
      expect(afterTtl?.branch).toBe("develop");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes concurrent refresh() calls into a single in-flight fetch", async () => {
    let inFlightCount = 0;
    let maxConcurrent = 0;
    const execFn: ExecFn = async (_command, args) => {
      const key = args.join(" ");
      if (key === SYMBOLIC_REF) {
        inFlightCount += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlightCount);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlightCount -= 1;
        return { stdout: "main\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const tracker = createGitStatusTracker("/repo", { execFn });

    const [a, b, c] = await Promise.all([tracker.refresh(), tracker.refresh(), tracker.refresh()]);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(maxConcurrent).toBe(1);
  });

  it("current() never spawns and only reflects the last resolved refresh()", async () => {
    const { execFn, calls } = fakeExec({
      [SYMBOLIC_REF]: () => ({ stdout: "main\n", stderr: "" }),
      [STATUS]: () => ({ stdout: "", stderr: "" }),
    });
    const tracker = createGitStatusTracker("/repo", { execFn });

    expect(tracker.current()).toBeUndefined();
    // Calling current() repeatedly before any refresh() must never touch execFn.
    expect(tracker.current()).toBeUndefined();
    expect(calls).toHaveLength(0);

    await tracker.refresh();
    expect(tracker.current()).toEqual({ branch: "main", dirty: false, detached: false });
    expect(calls).toHaveLength(2);
  });
});

describe("createGitStatusTracker (real git)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-git-status-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("reports a clean status on a freshly initialized real repository", async () => {
    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      return; // git is unavailable in this environment: skip silently.
    }

    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "hello", "utf8");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    if (!existsSync(join(dir, ".git"))) return; // Defensive: skip if init didn't actually happen.

    const tracker = createGitStatusTracker(dir);
    const clean = await tracker.refresh();
    expect(clean).toEqual({ branch: "main", dirty: false, detached: false });

    await writeFile(join(dir, "a.txt"), "hello, dirty", "utf8");
    const dirtyTracker = createGitStatusTracker(dir);
    const dirty = await dirtyTracker.refresh();
    expect(dirty).toEqual({ branch: "main", dirty: true, detached: false });
  });
});
