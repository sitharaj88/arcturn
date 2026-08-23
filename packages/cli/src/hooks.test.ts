import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHookRunner,
  type HookConfig,
  type HookRunner,
  parseHookConfig,
  wrapToolsWithHooks,
} from "./hooks.js";

const roots: string[] = [];

afterEach(() => {
  roots.length = 0;
});

/** A fresh scratch directory for one test's scripts and marker files. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-hooks-"));
  roots.push(dir);
  return dir;
}

/** Write an executable shell script and return its path. */
async function writeScript(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function emptyConfig(): HookConfig {
  return { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] };
}

/**
 * Skip on win32: every test below that calls {@link writeScript} hands the
 * hook runner a *path* to a `#!/bin/sh` script, not a literal command
 * string, and this file resolves the shell against the real host (no
 * injected `platform:` — see `./hooks-shell.test.ts` for that). On Windows
 * `cmd.exe` has no shebang mechanism and no association for an
 * extensionless chmod'd script, so it fails immediately with "is not
 * recognized" instead of exercising the behavior under test.
 * `resolveShell` itself is correct (proven in `hooks-shell.test.ts`, which
 * runs on every platform); this is these fixtures' reliance on a
 * POSIX-only script format, tracked as follow-up.
 */
const describePosix = describe.skipIf(process.platform === "win32");

function fakeCtx(): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    requestPermission: async () => ({ behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "session-1",
    toolCallId: "call-1",
  };
}

describe("parseHookConfig", () => {
  it("accepts a full document", () => {
    const warnings: string[] = [];
    const parsed = parseHookConfig(
      {
        preToolUse: [{ matcher: "bash", command: "./check.sh", timeoutMs: 5000 }],
        postToolUse: [{ command: "./log.sh" }],
        sessionStart: [{ command: "./start.sh" }],
        runEnd: [{ command: "./end.sh" }],
      },
      "cfg",
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(parsed.preToolUse).toEqual([
      { matcher: "bash", command: "./check.sh", timeoutMs: 5000 },
    ]);
    expect(parsed.postToolUse).toEqual([{ command: "./log.sh" }]);
    expect(parsed.sessionStart).toEqual([{ command: "./start.sh" }]);
    expect(parsed.runEnd).toEqual([{ command: "./end.sh" }]);
  });

  it("treats a missing hooks key as no hooks, without warning", () => {
    const warnings: string[] = [];
    const parsed = parseHookConfig(undefined, "cfg", warnings);
    expect(parsed).toEqual(emptyConfig());
    expect(warnings).toEqual([]);
  });

  it("warns about bad shapes and drops the offending entries instead of throwing", () => {
    const warnings: string[] = [];
    const parsed = parseHookConfig(
      {
        preToolUse: "nope",
        postToolUse: [{ matcher: 42 }],
        weirdEvent: [{ command: "./x.sh" }],
        runEnd: [{ command: "./end.sh", timeoutMs: -5, extra: true }],
      },
      "cfg",
      warnings,
    );
    expect(parsed.preToolUse).toEqual([]);
    expect(parsed.postToolUse).toEqual([]);
    expect(parsed.runEnd).toEqual([{ command: "./end.sh" }]);
    const joined = warnings.join("\n");
    expect(joined).toContain('"hooks.preToolUse" must be an array');
    expect(joined).toContain('needs a non-empty "command"');
    expect(joined).toContain('unknown hook event "weirdEvent"');
    expect(joined).toContain('"timeoutMs" must be a positive number');
    expect(joined).toContain('unknown key "extra"');
  });

  it("rejects a non-object hooks value", () => {
    const warnings: string[] = [];
    const parsed = parseHookConfig("nope", "cfg", warnings);
    expect(parsed).toEqual(emptyConfig());
    expect(warnings.join("\n")).toContain('"hooks" must be an object');
  });
});

describePosix("createHookRunner", () => {
  it("allows when the hook exits 0 with no veto", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "allow.sh", "exit 0");
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script }] },
      { cwd: dir },
    );
    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });
    expect(result).toEqual({ decision: "allow", warnings: [] });
  });

  it("denies via exit code 2, using stderr as the reason", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "deny2.sh", 'echo "no bash allowed" 1>&2\nexit 2');
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script }] },
      { cwd: dir },
    );
    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("no bash allowed");
    expect(result.warnings).toEqual([]);
  });

  it("denies via stdout JSON with exit 0", async () => {
    const dir = await scratch();
    const script = await writeScript(
      dir,
      "denyjson.sh",
      `echo '{"decision":"deny","reason":"blocked by policy"}'\nexit 0`,
    );
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script }] },
      { cwd: dir },
    );
    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("blocked by policy");
  });

  it("kills the whole process tree on timeout, fail-open with a warning", async () => {
    const dir = await scratch();
    const marker = join(dir, "grandchild-ran");
    // A plain .mjs file (invoked with no shell quoting involved) that writes
    // `marker` after 700ms, run as a backgrounded grandchild of the hook
    // process, which then just hangs. If the runner only killed the direct
    // child (not its whole process group), the grandchild would survive and
    // still write the marker.
    const grandchild = join(dir, "grandchild.mjs");
    await writeFile(
      grandchild,
      'import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(process.argv[2], "ran"), 700);\n',
      "utf8",
    );
    const script = await writeScript(dir, "slow.sh", `node ${grandchild} ${marker} &\nsleep 5`);
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script, timeoutMs: 150 }] },
      { cwd: dir },
    );

    const start = Date.now();
    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });
    expect(Date.now() - start).toBeLessThan(4000);
    expect(result.decision).toBe("allow");
    expect(result.warnings.some((w) => w.includes("timed out"))).toBe(true);

    // Give the (killed) grandchild's 700ms timer a chance to have fired if it
    // had survived, then confirm it never wrote the marker.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  }, 10_000);

  it("only runs hooks whose matcher glob matches the tool name", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(dir, "count.sh", `printf x >> ${JSON.stringify(counter)}`);
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script, matcher: "mcp_*" }] },
      { cwd: dir },
    );

    await runner.run("preToolUse", { toolName: "mcp_search", input: {} });
    await runner.run("preToolUse", { toolName: "bash", input: {} });
    await runner.run("preToolUse", { toolName: "mcp_fetch", input: {} });

    expect(await readFile(counter, "utf8")).toBe("xx");
  });

  it("fails open with a warning when the hook process cannot be spawned", async () => {
    const dir = await scratch();
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: "true" }] },
      { cwd: dir, env: { ...process.env, SHELL: join(dir, "no-such-shell-binary") } },
    );
    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });
    expect(result.decision).toBe("allow");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/failed to (start|run)/);
  });

  it("does not interleave concurrent runs' output between separate calls", async () => {
    const dir = await scratch();
    const outA = join(dir, "out-a.json");
    const outB = join(dir, "out-b.json");
    const script = await writeScript(dir, "echo-stdin.sh", `out=$1\ncat > "$out"`);
    const runner = createHookRunner(
      { ...emptyConfig(), sessionStart: [{ command: `${script} ${outA}` }] },
      { cwd: dir },
    );
    const runnerB = createHookRunner(
      { ...emptyConfig(), sessionStart: [{ command: `${script} ${outB}` }] },
      { cwd: dir },
    );

    await Promise.all([
      runner.run("sessionStart", { label: "a" }),
      runnerB.run("sessionStart", { label: "b" }),
    ]);

    const a = JSON.parse(await readFile(outA, "utf8"));
    const b = JSON.parse(await readFile(outB, "utf8"));
    expect(a.label).toBe("a");
    expect(b.label).toBe("b");
  });
});

function fakeTool(behavior: (calls: number) => ToolResult): { tool: Tool; calls: () => number } {
  let calls = 0;
  const tool: Tool = {
    definition: { name: "bash", description: "fake", parameters: { type: "object" } },
    async execute(): Promise<ToolResult> {
      calls++;
      return behavior(calls);
    },
  };
  return { tool, calls: () => calls };
}

describePosix("wrapToolsWithHooks", () => {
  it("does not execute the wrapped tool when preToolUse denies", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "deny.sh", 'echo "nope" 1>&2\nexit 2');
    const runner: HookRunner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script }] },
      { cwd: dir },
    );
    const { tool, calls } = fakeTool(() => ({ content: [{ type: "text", text: "ran" }] }));

    const [wrapped] = wrapToolsWithHooks([tool], runner);
    const result = await (wrapped as Tool).execute({}, fakeCtx());

    expect(calls()).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Blocked by preToolUse hook: nope",
    });
  });

  it("runs the wrapped tool and lets a real error result through unchanged", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "allow.sh", "exit 0");
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script }] },
      { cwd: dir },
    );
    const { tool, calls } = fakeTool(() => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }));

    const [wrapped] = wrapToolsWithHooks([tool], runner);
    const result = await (wrapped as Tool).execute({}, fakeCtx());

    expect(calls()).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "boom" });
  });

  it("propagates a thrown error from the wrapped tool instead of swallowing it", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "allow.sh", "exit 0");
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script }] },
      { cwd: dir },
    );
    const tool: Tool = {
      definition: { name: "bash", description: "fake", parameters: { type: "object" } },
      async execute(): Promise<ToolResult> {
        throw new Error("boom from tool");
      },
    };

    const [wrapped] = wrapToolsWithHooks([tool], runner);
    await expect((wrapped as Tool).execute({}, fakeCtx())).rejects.toThrow("boom from tool");
  });

  it("runs postToolUse with the tool's result after a successful call", async () => {
    const dir = await scratch();
    const preScript = await writeScript(dir, "allow.sh", "exit 0");
    const received = join(dir, "received.json");
    const postScript = await writeScript(dir, "post.sh", `cat > ${JSON.stringify(received)}`);
    const runner = createHookRunner(
      {
        ...emptyConfig(),
        preToolUse: [{ command: preScript }],
        postToolUse: [{ command: postScript }],
      },
      { cwd: dir },
    );
    const { tool } = fakeTool(() => ({ content: [{ type: "text", text: "done" }] }));

    const [wrapped] = wrapToolsWithHooks([tool], runner);
    const result = await (wrapped as Tool).execute({ x: 1 }, fakeCtx());
    expect(result.content[0]).toEqual({ type: "text", text: "done" });

    const payload = JSON.parse(await readFile(received, "utf8"));
    expect(payload.event).toBe("postToolUse");
    expect(payload.toolName).toBe("bash");
    expect(payload.input).toEqual({ x: 1 });
    expect(payload.resultText).toBe("done");
    expect(payload.isError).toBe(false);
    expect(payload.cwd).toBe(dir);
  });
});

/**
 * Which OS call terminates a timed-out hook's tree. The kill environment is
 * injected (and records instead of killing), so the win32 branch is exercised
 * on this POSIX runner; the hooks below outlive their timeout and then exit on
 * their own, so each run still settles.
 */
describePosix("hook process-tree termination", () => {
  function fakeKillEnvironment(platform: NodeJS.Platform) {
    const posixKill = vi.fn();
    const windowsKill = vi.fn();
    return { killEnvironment: { platform, posixKill, windowsKill }, posixKill, windowsKill };
  }

  it("signals the process group via posixKill on POSIX, never windowsKill", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "slow.sh", "sleep 0.4");
    const { killEnvironment, posixKill, windowsKill } = fakeKillEnvironment("linux");
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: script, timeoutMs: 100 }] },
      { cwd: dir, killEnvironment },
    );

    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });

    expect(result.warnings.some((w) => w.includes("timed out"))).toBe(true);
    expect(posixKill).toHaveBeenCalledTimes(1);
    const [pid, signal] = posixKill.mock.calls[0] as [number, NodeJS.Signals];
    expect(typeof pid).toBe("number");
    expect(signal).toBe("SIGKILL");
    expect(windowsKill).not.toHaveBeenCalled();
  }, 10_000);

  it("force-terminates the tree via windowsKill on win32, never posixKill", async () => {
    // `process.kill(-pid)` throws on Windows — there are no process groups —
    // and the old fallback reached only the `cmd.exe` wrapper, leaving the
    // hook's own children running. A stand-in `%ComSpec%` keeps the child a
    // real POSIX process here while the *kill* takes the Windows branch.
    const dir = await scratch();
    const fakeComSpec = await writeScript(dir, "fake-cmd", "sleep 0.4");
    const { killEnvironment, posixKill, windowsKill } = fakeKillEnvironment("win32");
    const runner = createHookRunner(
      { ...emptyConfig(), preToolUse: [{ command: "check.bat", timeoutMs: 100 }] },
      { cwd: dir, env: { ...process.env, ComSpec: fakeComSpec }, killEnvironment },
    );

    const result = await runner.run("preToolUse", { toolName: "bash", input: {} });

    expect(result.warnings.some((w) => w.includes("timed out"))).toBe(true);
    expect(windowsKill).toHaveBeenCalledTimes(1);
    expect(windowsKill).toHaveBeenCalledWith(expect.any(Number));
    expect(posixKill).not.toHaveBeenCalled();
  }, 10_000);
});

// Sanity check that the sandboxed test environment can actually run detached
// process groups the way the POSIX side of the implementation assumes
// (`process.kill(-pid)`) — win32 has no negative-pid group semantics at all
// (that's what D2's `taskkill /T /F` path replaces it with; see
// `killEnvironment`/`buildTaskkillArgv` in `../tools/src/bash.ts`), and this
// test also spawns `sh` directly, which doesn't exist there. Skipped rather
// than weakened: this checks the test *environment*, not our code.
describe.skipIf(process.platform === "win32")("environment sanity", () => {
  it("supports negative-pid group signalling", async () => {
    const child = spawn("sh", ["-c", "sleep 5"], { detached: true, stdio: "ignore" });
    expect(child.pid).toBeDefined();
    if (child.pid !== undefined) {
      expect(() => process.kill(-child.pid, "SIGKILL")).not.toThrow();
    }
    await new Promise((resolve) => child.on("close", resolve));
  });
});
