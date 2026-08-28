import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, Usage } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  type ExecFn,
  formatScoutReport,
  type GitExecResult,
  runScouts,
  type ScoutAgent,
  type ScoutApproach,
  type ScoutReport,
  type ScoutResult,
  ScoutWorktreeError,
  slugifyScoutName,
  summarizeDiff,
} from "./scouts.js";

const execFileAsync = promisify(execFile);

/** A parent dir that is never touched: with `parentDir` set, nothing hits the fs. */
const PARENT = join(tmpdir(), "arcturn-scouts-unit");

interface ExecCall {
  args: readonly string[];
  cwd: string;
}

interface FakeGit {
  execFn: ExecFn;
  calls: ExecCall[];
  /** Just the joined argv of every recorded call, for readable assertions. */
  argv(): string[];
}

/** Records every git invocation and answers with canned output. */
function fakeGit(
  handler?: (args: readonly string[], cwd: string) => GitExecResult | Error | undefined,
): FakeGit {
  const calls: ExecCall[] = [];
  const execFn: ExecFn = async (command, args, options) => {
    expect(command).toBe("git");
    calls.push({ args: [...args], cwd: options.cwd });
    const reply = handler?.(args, options.cwd);
    if (reply instanceof Error) throw reply;
    return reply ?? { stdout: "", stderr: "" };
  };
  return { execFn, calls, argv: () => calls.map((call) => call.args.join(" ")) };
}

function usage(costUsd?: number): Usage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

interface FakeAgentOptions {
  /** What `prompt()` does. Default: resolve immediately. */
  run?: (agent: FakeAgent) => Promise<void>;
  /** Text returned by `finalText()`. */
  text?: string;
}

class FakeAgent implements ScoutAgent {
  aborts = 0;
  prompts: string[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #options: FakeAgentOptions;

  constructor(options: FakeAgentOptions = {}) {
    this.#options = options;
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    await (this.#options.run?.(this) ?? Promise.resolve());
  }

  abort(): void {
    this.aborts++;
  }

  finalText(): string {
    return this.#options.text ?? "";
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

const never = (): Promise<void> => new Promise<void>(() => {});
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function approach(name: string): ScoutApproach {
  return { name, task: `explore ${name}` };
}

/** The worktree dir git was told to create for the nth approach. */
function addedDirs(git: FakeGit): string[] {
  return git.calls
    .filter((call) => call.args[0] === "worktree" && call.args[1] === "add")
    .map((call) => call.args[3] ?? "");
}

function removedDirs(git: FakeGit): string[] {
  return git.calls
    .filter((call) => call.args[0] === "worktree" && call.args[1] === "remove")
    .map((call) => call.args[3] ?? "");
}

describe("slugifyScoutName", () => {
  it("produces a filesystem-safe segment", () => {
    expect(slugifyScoutName("Worker Pool!")).toBe("worker-pool");
    expect(slugifyScoutName("###")).toBe("scout");
    expect(slugifyScoutName("a".repeat(80))).toHaveLength(40);
  });
});

describe("createWorktree", () => {
  it("runs `git worktree add --detach` and removes it again", async () => {
    const git = fakeGit();
    const worktree = await createWorktree("/repo", "Approach A", {
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(worktree.dir).toBe(join(PARENT, "approach-a"));
    expect(git.argv()[0]).toBe("rev-parse --is-inside-work-tree");
    // The unborn-HEAD probe sits between the repo check and the add, so a
    // fresh `git init` is refused with the fix in hand instead of git's
    // "invalid reference: HEAD".
    expect(git.argv()[1]).toBe("rev-parse --verify HEAD^{commit}");
    expect(git.argv()[2]).toBe(`worktree add --detach ${worktree.dir} HEAD`);
    expect(git.calls[2]?.cwd).toBe("/repo");

    await worktree.remove();
    expect(git.argv()).toContain(`worktree remove --force ${worktree.dir}`);

    // Idempotent: a second remove is a no-op, not a second git spawn.
    const before = git.calls.length;
    await worktree.remove();
    expect(git.calls).toHaveLength(before);
  });

  it("honours a custom ref", async () => {
    const git = fakeGit();
    await createWorktree("/repo", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
      ref: "origin/main",
    });
    expect(git.argv()[1]).toContain("origin/main");
  });

  it("reports `not-a-repo` when the directory is not a work tree", async () => {
    const git = fakeGit((args) =>
      args[0] === "rev-parse" ? new Error("fatal: not a git repository") : undefined,
    );
    const error = await createWorktree("/tmp/plain", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScoutWorktreeError);
    expect((error as ScoutWorktreeError).code).toBe("not-a-repo");
    // It never got as far as trying to add a worktree.
    expect(addedDirs(git)).toHaveLength(0);
  });

  it("reports `empty-repo`, with the command that fixes it, on an unborn HEAD", async () => {
    // The very first thing a person following "mkdir, git init, run the setup
    // workflow" hits: a fresh repository's HEAD points at a branch with no
    // commit, and `worktree add --detach HEAD` refuses it as "invalid
    // reference: HEAD" — git's mechanics, not the user's situation. The
    // refusal must hand them their next command.
    const git = fakeGit((args) =>
      args[0] === "rev-parse" && args.includes("HEAD^{commit}")
        ? new Error("fatal: Needed a single revision")
        : undefined,
    );
    const error = await createWorktree("/tmp/fresh", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScoutWorktreeError);
    expect((error as ScoutWorktreeError).code).toBe("empty-repo");
    expect((error as ScoutWorktreeError).message).toContain("no commits yet");
    expect((error as ScoutWorktreeError).message).toContain("--allow-empty");
    // It never got as far as trying to add a worktree.
    expect(addedDirs(git)).toHaveLength(0);
  });

  it("skips the unborn-HEAD probe when a caller pins a concrete ref", async () => {
    // A caller that names a ref has already decided what to branch from; the
    // probe is only for the HEAD default, where "nothing to branch from" is
    // otherwise discovered one confusing error too late.
    const git = fakeGit(() => undefined);
    await createWorktree("/tmp/pinned", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
      ref: "main",
    });
    const probes = git.calls.filter((call) => call.args.includes("HEAD^{commit}"));
    expect(probes).toHaveLength(0);
  });

  it("reports `git-missing` when the binary cannot be spawned", async () => {
    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const git = fakeGit(() => enoent);
    const error = await createWorktree("/repo", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
    }).catch((caught: unknown) => caught);
    expect((error as ScoutWorktreeError).code).toBe("git-missing");
  });

  it("reports `worktree-exists` when git refuses the path", async () => {
    const git = fakeGit((args) =>
      args[0] === "worktree"
        ? Object.assign(new Error("exit 128"), {
            stderr: "fatal: '/tmp/x' already exists\n",
          })
        : undefined,
    );
    const error = await createWorktree("/repo", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
    }).catch((caught: unknown) => caught);
    expect((error as ScoutWorktreeError).code).toBe("worktree-exists");
  });

  it("reports `git-failed` for any other git error", async () => {
    const git = fakeGit((args) =>
      args[0] === "worktree"
        ? Object.assign(new Error("exit 128"), { stderr: "fatal: invalid reference: HEAD\n" })
        : undefined,
    );
    const error = await createWorktree("/repo", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
    }).catch((caught: unknown) => caught);
    expect((error as ScoutWorktreeError).code).toBe("git-failed");
    expect((error as ScoutWorktreeError).message).toContain("invalid reference");
  });

  it("surfaces a failing removal as a typed error", async () => {
    const git = fakeGit((args) =>
      args[1] === "remove" ? Object.assign(new Error("exit 1"), { stderr: "locked\n" }) : undefined,
    );
    const worktree = await createWorktree("/repo", "a", {
      execFn: git.execFn,
      parentDir: PARENT,
    });
    const error = await worktree.remove().catch((caught: unknown) => caught);
    expect((error as ScoutWorktreeError).code).toBe("git-failed");
  });
});

describe("runScouts", () => {
  it("rejects a non-positive deadline", async () => {
    await expect(
      runScouts({ approaches: [], spawn: () => new FakeAgent(), deadlineMs: 0, repoRoot: "/repo" }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("returns an empty report for no approaches", async () => {
    const report = await runScouts({
      approaches: [],
      spawn: () => new FakeAgent(),
      deadlineMs: 100,
      repoRoot: "/repo",
    });
    expect(report.results).toEqual([]);
    expect(report.timedOut).toBe(false);
  });

  it("reports a scout that finishes inside the deadline, with its diff and cost", async () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@",
      "+const a = 1;",
      "+const b = 2;",
      "-const old = 0;",
    ].join("\n");
    const git = fakeGit((args) => (args[0] === "diff" ? { stdout: diff, stderr: "" } : undefined));
    const agent = new FakeAgent({
      text: "Approach A looks clean.",
      run: async (self) => {
        self.emit({ type: "toolStart", toolCallId: "1", toolName: "read", input: {} });
        self.emit({ type: "toolStart", toolCallId: "2", toolName: "edit", input: {} });
        self.emit({ type: "turnEnd", turnIndex: 0, usage: usage(0.004) });
        self.emit({ type: "turnEnd", turnIndex: 1, usage: usage(0.002) });
      },
    });

    const report = await runScouts({
      approaches: [approach("A")],
      spawn: () => agent,
      deadlineMs: 2_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });

    const result = report.results[0]!;
    expect(result.status).toBe("finished");
    expect(result.finalText).toBe("Approach A looks clean.");
    expect(result.toolCalls).toEqual(["read", "edit"]);
    expect(result.costUsd).toBeCloseTo(0.006, 6);
    expect(result.diff).toBe(diff);
    expect(summarizeDiff(result.diff)).toEqual({ files: 1, added: 2, removed: 1 });
    expect(agent.prompts).toEqual(["explore A"]);
    expect(agent.aborts).toBe(0);
    expect(report.timedOut).toBe(false);
    expect(report.warnings).toEqual([]);
    // Cleanup happened even on the happy path.
    expect(removedDirs(git)).toEqual(addedDirs(git));
  });

  it("stages before diffing so files the scout created are captured", async () => {
    const git = fakeGit();
    await runScouts({
      approaches: [approach("A")],
      spawn: () => new FakeAgent(),
      deadlineMs: 2_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });
    const argv = git.argv();
    expect(argv).toContain("add --all");
    expect(argv.indexOf("add --all")).toBeLessThan(argv.indexOf("diff --cached --no-color"));
  });

  it("aborts a hanging scout at the deadline and reports its partial work", async () => {
    const diff = "diff --git a/y.ts b/y.ts\n+half done\n";
    const git = fakeGit((args) => (args[0] === "diff" ? { stdout: diff, stderr: "" } : undefined));
    const agent = new FakeAgent({ text: "got as far as the router", run: never });

    const started = Date.now();
    const report = await runScouts({
      approaches: [approach("hangs")],
      spawn: () => agent,
      deadlineMs: 120,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    const result = report.results[0]!;
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("deadline");
    expect(result.finalText).toBe("got as far as the router");
    expect(result.diff).toBe(diff);
    expect(agent.aborts).toBe(1);
    expect(report.timedOut).toBe(true);
    // The buzzer must not leak the worktree.
    expect(removedDirs(git)).toEqual(addedDirs(git));
  });

  it("records a throwing scout as an error without killing the others", async () => {
    const git = fakeGit();
    const good = new FakeAgent({ text: "fine" });
    const report = await runScouts({
      approaches: [approach("boom"), approach("ok")],
      spawn: (candidate) => {
        if (candidate.name === "boom") {
          return new FakeAgent({
            run: () => Promise.reject(new Error("model exploded at step 3")),
          });
        }
        return good;
      },
      deadlineMs: 2_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });

    expect(report.results[0]?.status).toBe("error");
    expect(report.results[0]?.error).toContain("model exploded at step 3");
    expect(report.results[1]?.status).toBe("finished");
    expect(report.results[1]?.finalText).toBe("fine");
    // Both worktrees cleaned up, including the failed one.
    expect(removedDirs(git)).toHaveLength(2);
    expect(removedDirs(git)).toEqual(addedDirs(git));
  });

  it("records a scout whose spawn throws, and still creates no orphan worktree", async () => {
    const git = fakeGit();
    const report = await runScouts({
      approaches: [approach("nospawn")],
      spawn: () => {
        throw new Error("no model configured");
      },
      deadlineMs: 1_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(report.results[0]?.status).toBe("error");
    expect(report.results[0]?.error).toContain("no model configured");
    expect(removedDirs(git)).toEqual(addedDirs(git));
  });

  it("records an error when the worktree cannot be created", async () => {
    const git = fakeGit((args) => (args[0] === "rev-parse" ? new Error("not a repo") : undefined));
    const report = await runScouts({
      approaches: [approach("A")],
      spawn: () => new FakeAgent(),
      deadlineMs: 1_000,
      repoRoot: "/nope",
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(report.results[0]?.status).toBe("error");
    expect(report.results[0]?.error).toContain("not inside a git work tree");
    expect(addedDirs(git)).toHaveLength(0);
  });

  it("surfaces a failed cleanup as a warning rather than losing the report", async () => {
    const git = fakeGit((args) =>
      args[1] === "remove" ? Object.assign(new Error("exit 1"), { stderr: "busy\n" }) : undefined,
    );
    const report = await runScouts({
      approaches: [approach("A")],
      spawn: () => new FakeAgent({ text: "done" }),
      deadlineMs: 1_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(report.results[0]?.status).toBe("finished");
    expect(report.warnings.join("\n")).toContain("worktree remove failed");
  });

  it("bounds concurrency with maxParallel", async () => {
    const git = fakeGit();
    let active = 0;
    let peak = 0;
    const report = await runScouts({
      approaches: ["a", "b", "c", "d", "e"].map(approach),
      spawn: () =>
        new FakeAgent({
          run: async () => {
            active++;
            peak = Math.max(peak, active);
            await delay(30);
            active--;
          },
        }),
      deadlineMs: 5_000,
      repoRoot: "/repo",
      maxParallel: 2,
      execFn: git.execFn,
      parentDir: PARENT,
    });

    expect(peak).toBe(2);
    expect(report.results).toHaveLength(5);
    expect(report.results.every((result) => result.status === "finished")).toBe(true);
    expect(removedDirs(git)).toHaveLength(5);
  });

  it("runs everything at once when maxParallel is not set", async () => {
    const git = fakeGit();
    let active = 0;
    let peak = 0;
    await runScouts({
      approaches: ["a", "b", "c"].map(approach),
      spawn: () =>
        new FakeAgent({
          run: async () => {
            active++;
            peak = Math.max(peak, active);
            await delay(20);
            active--;
          },
        }),
      deadlineMs: 5_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(peak).toBe(3);
  });

  it("marks queued scouts that never started as timed out", async () => {
    const git = fakeGit();
    const report = await runScouts({
      approaches: ["first", "second"].map(approach),
      spawn: () => new FakeAgent({ run: never }),
      deadlineMs: 80,
      repoRoot: "/repo",
      maxParallel: 1,
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(report.results[0]?.status).toBe("timeout");
    expect(report.results[1]?.status).toBe("timeout");
    expect(report.results[1]?.error).toContain("before this scout started");
    // The second scout never got a worktree, so only one was created — and it
    // was removed.
    expect(addedDirs(git)).toHaveLength(1);
    expect(removedDirs(git)).toEqual(addedDirs(git));
  });

  it("treats an aborted signal as an early buzzer and still cleans up", async () => {
    const git = fakeGit();
    const controller = new AbortController();
    const agent = new FakeAgent({ text: "interrupted", run: never });
    setTimeout(() => controller.abort(), 40);

    const report = await runScouts({
      approaches: [approach("A")],
      spawn: () => agent,
      // A deadline far beyond the test's patience: only the signal can end it.
      deadlineMs: 60_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
      signal: controller.signal,
    });

    expect(report.timedOut).toBe(true);
    expect(report.results[0]?.status).toBe("timeout");
    expect(report.results[0]?.error).toContain("cancelled");
    expect(agent.aborts).toBe(1);
    expect(removedDirs(git)).toEqual(addedDirs(git));
  });

  it("skips every scout when the signal is already aborted, creating no worktrees", async () => {
    const git = fakeGit();
    const report = await runScouts({
      approaches: ["a", "b"].map(approach),
      spawn: () => new FakeAgent({ run: never }),
      deadlineMs: 60_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
      signal: AbortSignal.abort(),
    });
    expect(report.results.map((result) => result.status)).toEqual(["timeout", "timeout"]);
    expect(git.calls).toHaveLength(0);
  });

  it("gives each approach its own worktree and reports results in order", async () => {
    const git = fakeGit();
    const seen: string[] = [];
    const report = await runScouts({
      approaches: ["alpha", "beta"].map(approach),
      spawn: (candidate, cwd) => {
        seen.push(`${candidate.name}:${cwd}`);
        return new FakeAgent({ text: candidate.name });
      },
      deadlineMs: 2_000,
      repoRoot: "/repo",
      execFn: git.execFn,
      parentDir: PARENT,
    });
    expect(report.results.map((result) => result.name)).toEqual(["alpha", "beta"]);
    expect(new Set(addedDirs(git)).size).toBe(2);
    expect(seen).toContain(`alpha:${join(PARENT, "1-alpha")}`);
    expect(seen).toContain(`beta:${join(PARENT, "2-beta")}`);
  });

  it("notifies onResult as each scout settles", async () => {
    const git = fakeGit();
    const settled: string[] = [];
    await runScouts({
      approaches: ["a", "b"].map(approach),
      spawn: () => new FakeAgent(),
      deadlineMs: 2_000,
      repoRoot: "/repo",
      maxParallel: 1,
      execFn: git.execFn,
      parentDir: PARENT,
      onResult: (result) => settled.push(`${result.name}:${result.status}`),
    });
    expect(settled).toEqual(["a:finished", "b:finished"]);
  });
});

describe("summarizeDiff", () => {
  it("counts files and lines, ignoring the +++/--- headers", () => {
    expect(summarizeDiff(undefined)).toEqual({ files: 0, added: 0, removed: 0 });
    expect(summarizeDiff("")).toEqual({ files: 0, added: 0, removed: 0 });
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "+one",
      "-two",
      "diff --git a/b.ts b/b.ts",
      "--- /dev/null",
      "+++ b/b.ts",
      "+three",
    ].join("\n");
    expect(summarizeDiff(diff)).toEqual({ files: 2, added: 2, removed: 1 });
  });
});

describe("formatScoutReport", () => {
  function result(overrides: Partial<ScoutResult>): ScoutResult {
    return {
      name: "A",
      task: "explore A",
      status: "finished",
      finalText: "",
      toolCalls: [],
      durationMs: 1_200,
      ...overrides,
    };
  }

  function report(results: ScoutResult[], warnings: string[] = []): ScoutReport {
    return { results, deadlineMs: 60_000, durationMs: 12_300, timedOut: false, warnings };
  }

  it("says so when there is nothing to compare", () => {
    expect(formatScoutReport(report([]))).toContain("no approaches");
  });

  it("compares approaches with status, tools, diff size and cost", () => {
    const text = formatScoutReport(
      report([
        result({
          name: "worker-pool",
          toolCalls: ["read", "read", "edit"],
          costUsd: 0.0042,
          diff: "diff --git a/x.ts b/x.ts\n+a\n+b\n-c\n",
          finalText: "Clean: the pool bounds concurrency without touching runtime.ts.",
        }),
        result({
          name: "event-loop",
          status: "timeout",
          durationMs: 60_000,
          toolCalls: ["read"],
          error: "aborted at the 60000ms deadline",
          finalText: "hit a type error at step 3",
        }),
        result({ name: "rewrite", status: "error", error: "spawn failed", durationMs: 400 }),
      ]),
    );

    expect(text).toContain("Scouting report — 3 approaches");
    expect(text).toContain("deadline 60.0s");
    expect(text).toContain("total $0.0042");
    expect(text).toContain("[1] worker-pool — finished in 1.2s, $0.0042");
    expect(text).toContain("3 tool calls: read x2, edit");
    expect(text).toContain("diff: 1 file, +2/-1");
    expect(text).toContain("| Clean: the pool bounds concurrency");
    expect(text).toContain("[2] event-loop — TIMEOUT in 60.0s, cost unknown");
    expect(text).toContain("note: aborted at the 60000ms deadline");
    expect(text).toContain("[3] rewrite — ERROR in 0.4s");
    expect(text).toContain("error: spawn failed");
    expect(text).toContain("no tool calls");
    expect(text).toContain("diff: no changes");
    // Points the user at re-running the winner, since the worktrees are gone.
    expect(text).toContain('Re-run "worker-pool"');
  });

  it("does not total unpriced scouts as if they were free", () => {
    // The per-scout lines already say "cost unknown"; the header summed them
    // as zero, so three scouts on an unpriced model read as "total $0.00".
    const mixed = formatScoutReport(
      report([result({ name: "priced", costUsd: 0.0042 }), result({ name: "unpriced" })]),
    );
    expect(mixed).toContain("total $0.0042+");

    const nothingPriced = formatScoutReport(report([result({ name: "a" }), result({ name: "b" })]));
    expect(nothingPriced).toContain("total n/a");
    expect(nothingPriced).not.toContain("$0.00");
  });

  it("lists warnings and admits when nothing finished", () => {
    const text = formatScoutReport(
      report([result({ status: "timeout" })], ["worktree remove failed for /tmp/x"]),
    );
    expect(text).toContain("Warnings:");
    expect(text).toContain("- worktree remove failed for /tmp/x");
    expect(text).toContain("No scout finished within the deadline");
  });

  it("caps the excerpt from each scout's findings", () => {
    const text = formatScoutReport(report([result({ finalText: "l1\n\nl2\nl3\nl4\nl5" })]));
    expect(text).toContain("| l4");
    expect(text).not.toContain("| l5");
    const capped = formatScoutReport(report([result({ finalText: "l1\nl2\nl3" })]), {
      excerptLines: 2,
    });
    expect(capped).toContain("| l2");
    expect(capped).not.toContain("| l3");
  });
});

// ---------------------------------------------------------------- real git (gated)

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const hasGit = await gitAvailable();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe.skipIf(!hasGit)("createWorktree against real git", () => {
  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "arcturn-scout-repo-"));
    tempDirs.push(dir);
    const run = (args: string[]): Promise<unknown> => execFileAsync("git", args, { cwd: dir });
    await run(["init", "--quiet"]);
    await run(["config", "user.email", "scout@example.com"]);
    await run(["config", "user.name", "Scout"]);
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await run(["add", "."]);
    await run(["commit", "--quiet", "-m", "seed"]);
    return dir;
  }

  it("checks out a real detached worktree and tears it down again", async () => {
    const repo = await makeRepo();
    const worktree = await createWorktree(repo, "real approach");
    expect((await stat(join(worktree.dir, "seed.txt"))).isFile()).toBe(true);

    // A scout's write lands in the worktree, never in the user's tree.
    await writeFile(join(worktree.dir, "scouted.txt"), "explored\n");
    await expect(stat(join(repo, "scouted.txt"))).rejects.toThrow();

    await worktree.remove();
    await expect(stat(worktree.dir)).rejects.toThrow();
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(worktree.dir);
  });

  it("rejects a directory that is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "arcturn-scout-plain-"));
    tempDirs.push(plain);
    const error = await createWorktree(plain, "a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScoutWorktreeError);
    expect((error as ScoutWorktreeError).code).toBe("not-a-repo");
  });

  it("captures a real scout's diff and cleans up", async () => {
    const repo = await makeRepo();
    const report = await runScouts({
      approaches: [{ name: "adds a file", task: "go" }],
      spawn: (_candidate, cwd) =>
        new FakeAgent({
          text: "wrote a file",
          run: async () => {
            await writeFile(join(cwd, "new.ts"), "export const x = 1;\n");
          },
        }),
      deadlineMs: 10_000,
      repoRoot: repo,
    });
    const scouted = report.results[0]!;
    expect(scouted.status).toBe("finished");
    expect(scouted.diff).toContain("new.ts");
    expect(scouted.diff).toContain("export const x = 1;");
    expect(summarizeDiff(scouted.diff).added).toBeGreaterThan(0);
    await expect(stat(scouted.worktreeDir!)).rejects.toThrow();
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(stdout.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);
  });
});
