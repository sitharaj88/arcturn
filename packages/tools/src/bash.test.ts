import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_KILL_GRACE_MS,
  BackgroundTaskManager,
  buildTaskkillArgv,
  createBashTool,
  defaultKillEnvironment,
  FOREGROUND_KILL_DRAIN_MS,
} from "./bash.js";
import { createFakeContext, denyAllPermissions, removeTempDir } from "./test-utils.js";

/** Whether a process (any process, not just our own children) is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `check` (timing-tolerant) until it returns true or `maxWaitMs` elapses. */
async function waitUntil(check: () => boolean, maxWaitMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

/**
 * Skip on win32: these tests spawn `sleep` (and, in one case, `sh -c`
 * itself) as the literal command text, relying on it hanging for real
 * wall-clock time so the tool's own timeout/kill path fires. `resolveShell`
 * correctly hands that text to `%ComSpec%` on Windows (see `./shell.ts`),
 * but `cmd.exe` has no `sleep` builtin and none is guaranteed on PATH, so
 * the command fails in milliseconds with "not recognized" instead of
 * hanging — the exact behavior under test never occurs. This is a test
 * content gap, not a `bash` tool bug: making it exercise the real
 * timeout/kill path on Windows needs a portable "block for N ms" command
 * (e.g. `ping -n <n+1> 127.0.0.1 >NUL`) threaded through every call site
 * here, tracked as follow-up rather than folded into this change.
 */
const itPosix = it.skipIf(process.platform === "win32");
/** Same reasoning as {@link itPosix}, applied to a whole `describe` block. */
const describePosix = describe.skipIf(process.platform === "win32");

describe("bash tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("runs a command and returns merged output with exit code details", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("hi");
    expect(result.details).toMatchObject({ exitCode: 0 });
  });

  it("reports isError and exit code for a non-zero exit", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "exit 7" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ exitCode: 7 });
  });

  it("streams output chunks via ctx.onUpdate", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx, updates } = createFakeContext({ cwd: dir });

    await tool.execute({ command: "echo streamed" }, ctx);

    const streamedText = updates.map((u) => u.text ?? "").join("");
    expect(streamedText).toContain("streamed");
  });

  itPosix(
    "times out long-running commands",
    async () => {
      const tool = createBashTool(new BackgroundTaskManager());
      const { ctx } = createFakeContext({ cwd: dir });

      const result = await tool.execute({ command: "sleep 5", timeoutMs: 200 }, ctx);

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("timed out");
    },
    10_000,
  );

  itPosix(
    "is killed by an aborted signal",
    async () => {
      const tool = createBashTool(new BackgroundTaskManager());
      const controller = new AbortController();
      const { ctx } = createFakeContext({ cwd: dir, signal: controller.signal });

      const promise = tool.execute({ command: "sleep 5" }, ctx);
      setTimeout(() => controller.abort(), 100);
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("aborted");
    },
    10_000,
  );

  it("requests permission with the command as subject and a first-word suggested rule", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ command: "git status" }, ctx);

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].subject).toBe("git status");
    expect(permissionRequests[0].suggestedRule).toMatchObject({ tool: "bash", specifier: "git *" });
  });

  it("does not run the command when permission is denied", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({
      cwd: dir,
      onPermissionRequest: denyAllPermissions("no shells"),
    });

    const result = await tool.execute({ command: "echo should-not-run" }, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("no shells");
  });

  itPosix(
    "supports the full background task lifecycle: start, poll, kill, list",
    async () => {
      const manager = new BackgroundTaskManager();
      const tool = createBashTool(manager);
      const { ctx } = createFakeContext({ cwd: dir });

      const startResult = await tool.execute(
        { command: "sleep 0.2 && echo background-done", background: true },
        ctx,
      );
      expect(startResult.isError).toBeFalsy();
      const taskId = (startResult.details as { taskId: string }).taskId;
      expect(taskId).toBeTruthy();

      // Immediately after starting, the task should still be tracked.
      const immediateStatus = manager.poll(taskId);
      expect(immediateStatus).toBeDefined();
      expect(immediateStatus?.command).toBe("sleep 0.2 && echo background-done");

      // Wait for completion by polling.
      let finalStatus = manager.poll(taskId);
      for (let i = 0; i < 50 && finalStatus?.running; i++) {
        await new Promise((r) => setTimeout(r, 50));
        finalStatus = manager.poll(taskId);
      }
      expect(finalStatus?.running).toBe(false);
      expect(finalStatus?.output).toContain("background-done");
      expect(finalStatus?.exitCode).toBe(0);

      expect(manager.list().some((t) => t.taskId === taskId)).toBe(true);
      expect(manager.poll("nonexistent-task-id")).toBeUndefined();
    },
    10_000,
  );

  it("kills a running background task", async () => {
    const manager = new BackgroundTaskManager();
    const tool = createBashTool(manager);
    const { ctx } = createFakeContext({ cwd: dir });

    const startResult = await tool.execute({ command: "sleep 5", background: true }, ctx);
    const taskId = (startResult.details as { taskId: string }).taskId;

    expect(manager.kill(taskId)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(manager.poll(taskId)?.running).toBe(false);
    expect(manager.kill("nonexistent-task-id")).toBe(false);
  }, 10_000);

  itPosix(
    "kills a background task's whole process group, including a grandchild",
    async () => {
      const manager = new BackgroundTaskManager();
      const tool = createBashTool(manager);
      const { ctx } = createFakeContext({ cwd: dir });
      const pidFile = join(dir, "grandchild.pid");

      // The background task's own top-level process (`/bin/sh -c ...`) forks a
      // grandchild (`sleep 30`) that never receives a signal directly — it
      // only dies if the whole process *group* is signaled, not just the
      // immediate child. `wait` keeps the shell (and thus the group) alive
      // until the grandchild exits or is killed.
      const startResult = await tool.execute(
        {
          command: `sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`,
          background: true,
        },
        ctx,
      );
      expect(startResult.isError).toBeFalsy();
      const taskId = (startResult.details as { taskId: string }).taskId;

      const pidFileWritten = await waitUntil(() => {
        try {
          return readFileSync(pidFile, "utf8").trim().length > 0;
        } catch {
          return false;
        }
      }, 5_000);
      expect(pidFileWritten).toBe(true);

      const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      expect(manager.kill(taskId)).toBe(true);

      // Timing-tolerant: SIGTERM should kill `sleep` almost immediately, but
      // poll generously past the SIGKILL grace period in case it doesn't.
      const died = await waitUntil(() => !isAlive(grandchildPid), BACKGROUND_KILL_GRACE_MS + 2_000);
      expect(died).toBe(true);

      // Two different observers, so this needs its own wait rather than
      // reusing the one above. `died` comes from polling `kill(pid, 0)`, which
      // sees the grandchild go the instant the kernel reaps it; `running`
      // flips on the manager's own `close` handler, which needs the top-level
      // shell to exit AND its stdio pipes to close AND the event to reach this
      // loop's turn. The gap between the two is small and real, and asserting
      // on `running` at the moment `died` became true was reading the manager
      // before it could have known. What the test means is that it converges.
      const observedExit = await waitUntil(
        () => manager.poll(taskId)?.running === false,
        BACKGROUND_KILL_GRACE_MS + 2_000,
      );
      expect(observedExit).toBe(true);
      expect(manager.poll(taskId)?.running).toBe(false);
    },
    15_000,
  );
});

describe("BackgroundTaskManager kill: platform-specific termination (D2)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-kill-platform-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("POSIX (darwin/linux): signals the process group via posixKill, never windowsKill", async () => {
    const posixKill = vi.fn();
    const windowsKill = vi.fn();
    const manager = new BackgroundTaskManager({
      killEnvironment: { platform: "linux", posixKill, windowsKill },
    });
    const { taskId } = manager.start("sleep 0.3", dir);

    expect(manager.kill(taskId)).toBe(true);

    expect(posixKill).toHaveBeenCalledTimes(1);
    const [pid, signal] = posixKill.mock.calls[0] as [number, NodeJS.Signals];
    expect(typeof pid).toBe("number");
    expect(signal).toBe("SIGTERM");
    expect(windowsKill).not.toHaveBeenCalled();
  });

  it("win32: force-terminates via windowsKill, never posixKill (no process-group-by-negative-pid on Windows)", async () => {
    const posixKill = vi.fn();
    const windowsKill = vi.fn();
    const manager = new BackgroundTaskManager({
      killEnvironment: { platform: "win32", posixKill, windowsKill },
    });
    const { taskId } = manager.start("sleep 0.3", dir);

    expect(manager.kill(taskId)).toBe(true);

    expect(windowsKill).toHaveBeenCalledTimes(1);
    expect(windowsKill).toHaveBeenCalledWith(expect.any(Number));
    expect(posixKill).not.toHaveBeenCalled();
  });

  it("win32: does not schedule a redundant second windowsKill once the task has already exited", async () => {
    const windowsKill = vi.fn();
    const manager = new BackgroundTaskManager({
      killEnvironment: { platform: "win32", posixKill: vi.fn(), windowsKill },
    });
    const { taskId } = manager.start("sleep 0.3", dir);

    expect(manager.kill(taskId)).toBe(true);
    // Simulate the tree actually dying in response to the first windowsKill
    // call, then wait past the SIGKILL grace period: the `if (task.running)`
    // guard should skip the follow-up call rather than invoking taskkill
    // again against an already-dead pid.
    await new Promise((r) => setTimeout(r, BACKGROUND_KILL_GRACE_MS + 300));
    expect(windowsKill.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("default construction (no options) uses the real platform, matching prior behavior on POSIX", () => {
    // No injected killEnvironment: BackgroundTaskManager must still work
    // exactly as it did before D2 on this (POSIX) test runner.
    expect(() => new BackgroundTaskManager()).not.toThrow();
  });

  it("buildTaskkillArgv targets the pid, its whole process tree, and forces termination", () => {
    expect(buildTaskkillArgv(4242)).toEqual(["/pid", "4242", "/T", "/F"]);
  });

  it("defaultKillEnvironment reports the real process.platform", () => {
    expect(defaultKillEnvironment().platform).toBe(process.platform);
  });
});

describe("bash foreground kill: process-tree termination", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-foreground-kill-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  /** A kill environment that records calls without actually killing anything. */
  function fakeKillEnvironment(platform: NodeJS.Platform) {
    const posixKill = vi.fn();
    const windowsKill = vi.fn();
    return { killEnvironment: { platform, posixKill, windowsKill }, posixKill, windowsKill };
  }

  itPosix(
    "spawns the foreground command as its own process-group leader on POSIX",
    async () => {
      // Group leadership *is* the mechanism: without it `posixKill(-pid)` signals
      // whatever group this process happens to be in, so the command's own forks
      // survive the kill. `ps` prints "<pid> <pgid>"; they match only for a leader.
      const tool = createBashTool(new BackgroundTaskManager());
      const { ctx } = createFakeContext({ cwd: dir });

      const result = await tool.execute({ command: "ps -o pid=,pgid= -p $$" }, ctx);

      const [pid, pgid] = ((result.content[0] as { text: string }).text.match(/\d+/g) ?? []).map(
        Number,
      );
      expect(pid).toBeGreaterThan(0);
      expect(pgid).toBe(pid);
    },
    10_000,
  );

  itPosix(
    "routes a foreground timeout through posixKill on POSIX, never windowsKill",
    async () => {
      const { killEnvironment, posixKill, windowsKill } = fakeKillEnvironment("linux");
      const tool = createBashTool(new BackgroundTaskManager(), { killEnvironment });
      const { ctx } = createFakeContext({ cwd: dir });

      const result = await tool.execute({ command: "sleep 2", timeoutMs: 200 }, ctx);

      expect(posixKill).toHaveBeenCalledTimes(1);
      const [pid, signal] = posixKill.mock.calls[0] as [number, NodeJS.Signals];
      expect(typeof pid).toBe("number");
      expect(signal).toBe("SIGKILL");
      expect(windowsKill).not.toHaveBeenCalled();
      expect((result.content[0] as { text: string }).text).toContain("timed out");
    },
    10_000,
  );

  itPosix(
    "routes a foreground timeout through windowsKill on win32, never posixKill",
    async () => {
      // `process.kill(-pid)` throws on Windows, and the old fallback reached only
      // the `cmd.exe` wrapper — never the command it forked.
      const { killEnvironment, posixKill, windowsKill } = fakeKillEnvironment("win32");
      const tool = createBashTool(new BackgroundTaskManager(), { killEnvironment });
      const { ctx } = createFakeContext({ cwd: dir });

      const result = await tool.execute({ command: "sleep 2", timeoutMs: 200 }, ctx);

      expect(windowsKill).toHaveBeenCalledTimes(1);
      expect(windowsKill).toHaveBeenCalledWith(expect.any(Number));
      expect(posixKill).not.toHaveBeenCalled();
      expect((result.content[0] as { text: string }).text).toContain("timed out");
    },
    10_000,
  );

  itPosix(
    "returns within the drain window even when nothing dies, keeping the output it captured",
    async () => {
      // The kill environment is a no-op, standing in for the case the drain
      // exists for: a descendant that survived the kill and still holds the
      // pipes. The tool call must still be bounded by its own timeout.
      const { killEnvironment } = fakeKillEnvironment("linux");
      const tool = createBashTool(new BackgroundTaskManager(), { killEnvironment });
      const { ctx } = createFakeContext({ cwd: dir });

      const startedAt = Date.now();
      const result = await tool.execute(
        { command: "echo printed-before-kill; sleep 2", timeoutMs: 200 },
        ctx,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(200 + FOREGROUND_KILL_DRAIN_MS + 800);
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("timed out");
      // Captured-output contract: a timed-out command still reports what it printed.
      expect(text).toContain("printed-before-kill");
    },
    10_000,
  );

  itPosix(
    "still reports what a really-killed command printed before the kill",
    async () => {
      // Same contract on the real path, where the tree does die and `close`
      // arrives normally.
      const tool = createBashTool(new BackgroundTaskManager());
      const { ctx } = createFakeContext({ cwd: dir });

      const result = await tool.execute(
        { command: "echo printed-before-kill; sleep 5", timeoutMs: 300 },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("printed-before-kill");
    },
    10_000,
  );
});

describePosix("bash tool timeout teaching + repeat-timeout circuit breaker", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-timeout-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  /** Run `command` with a short timeout so it is killed by the tool. */
  async function timeOut(tool: Tool, ctx: ToolExecutionContext, command = "sleep 5") {
    return tool.execute({ command, timeoutMs: 200 }, ctx);
  }

  it("explains why a command failed to exit and names a bounding remedy", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await timeOut(tool, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(result.isError).toBe(true);
    expect(text).toContain("timed out after 200ms");
    // Names the likely cause...
    expect(text).toMatch(/handle open/i);
    // ...and a concrete way to bound the re-run.
    expect(text).toContain("--test-force-exit");
    expect(text).toContain("vitest run");
  }, 10_000);

  it("refuses the third attempt at a command that has already timed out twice", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    const first = await timeOut(tool, ctx);
    const second = await timeOut(tool, ctx);
    expect((first.content[0] as { text: string }).text).toContain("timed out");
    expect((second.content[0] as { text: string }).text).toContain("timed out");

    const started = Date.now();
    const third = await timeOut(tool, ctx);
    const text = (third.content[0] as { text: string }).text;

    // Refused, not run: it comes back well inside the 200ms timeout.
    expect(Date.now() - started).toBeLessThan(150);
    expect(third.isError).toBe(true);
    expect(text).toMatch(/timed out twice/i);
    expect(text).toMatch(/change/i);
    expect(third.details).toMatchObject({ command: "sleep 5", timeoutCount: 2 });
  }, 10_000);

  it("returns the refusal as an isError result rather than throwing", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    await timeOut(tool, ctx);
    await timeOut(tool, ctx);

    // Per the Tool contract: expected failures are isError results, never throws.
    const third = await timeOut(tool, ctx).catch((error: unknown) => ({ threw: error }));
    expect(third).not.toHaveProperty("threw");
    expect((third as ToolResult).isError).toBe(true);
    expect((third as ToolResult).content[0]).toMatchObject({ type: "text" });
    expect(((third as ToolResult).content[0] as { text: string }).text).toMatch(/timed out twice/i);
  }, 10_000);

  it("still runs a different command after another has been circuit-broken", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    await timeOut(tool, ctx);
    await timeOut(tool, ctx);
    const refused = await timeOut(tool, ctx);
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toMatch(/timed out twice/i);

    const other = await tool.execute({ command: "echo still-works" }, ctx);
    expect(other.isError).toBeFalsy();
    expect((other.content[0] as { text: string }).text).toContain("still-works");
  }, 10_000);

  it("treats whitespace-only differences as the same command", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    await timeOut(tool, ctx, "sleep 5");
    await timeOut(tool, ctx, "  sleep    5  ");

    const third = await timeOut(tool, ctx, "sleep\t5");
    expect(third.isError).toBe(true);
    expect((third.content[0] as { text: string }).text).toMatch(/timed out twice/i);
  }, 10_000);

  it("clears a command's timeout counter once it succeeds", async () => {
    const tool = createBashTool(new BackgroundTaskManager());
    const { ctx } = createFakeContext({ cwd: dir });

    // Same command string, but a generous timeout lets it finish.
    const first = await tool.execute({ command: "sleep 0.5", timeoutMs: 150 }, ctx);
    expect((first.content[0] as { text: string }).text).toContain("timed out");
    const success = await tool.execute({ command: "sleep 0.5", timeoutMs: 5_000 }, ctx);
    expect(success.isError).toBeFalsy();

    // Counter cleared, so this is timeout #1 again — a real run, not a refusal.
    const started = Date.now();
    const again = await tool.execute({ command: "sleep 0.5", timeoutMs: 150 }, ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect((again.content[0] as { text: string }).text).toContain("timed out");
    expect(again.details).toMatchObject({ timeoutCount: 1 });
  }, 15_000);

  it("counts timeouts per tool instance, so a fresh tool starts clean", async () => {
    const manager = new BackgroundTaskManager();
    const first = createBashTool(manager);
    const { ctx } = createFakeContext({ cwd: dir });

    await timeOut(first, ctx);
    await timeOut(first, ctx);
    const refused = await timeOut(first, ctx);
    expect((refused.content[0] as { text: string }).text).toMatch(/timed out twice/i);

    const fresh = createBashTool(manager);
    const started = Date.now();
    const result = await timeOut(fresh, ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect((result.content[0] as { text: string }).text).toContain("timed out");
  }, 15_000);
});
