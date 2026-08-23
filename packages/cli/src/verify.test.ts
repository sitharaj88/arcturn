import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifier, matchesGlob, type Verifier, wrapToolsWithVerify } from "./verify.js";

const roots: string[] = [];

afterEach(() => {
  roots.length = 0;
});

/** A fresh scratch directory for one test's scripts and marker files. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-verify-"));
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

/**
 * Skip on win32: every test below that calls {@link writeScript} hands the
 * verify loop a *path* to a `#!/bin/sh` script, not a literal command
 * string. On POSIX, `resolveShell()`'s real `/bin/sh -c <path>` follows the
 * shebang. On Windows, the real `%ComSpec% /d /s /c "<path>"` this file
 * exercises (no injected `platform:` here — see `./verify-shell.test.ts`
 * for that) has no shebang mechanism and no association for an extensionless
 * write-your-own-chmod script: `cmd.exe` cannot run it at all, so it fails
 * immediately with "is not recognized" rather than exercising the behavior
 * under test. `resolveShell` itself is correct (proven in
 * `verify-shell.test.ts`, which runs on every platform); this is these two
 * fixtures' reliance on a POSIX-only script format, tracked as follow-up.
 */
const describePosix = describe.skipIf(process.platform === "win32");

function fakeCtx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    signal: new AbortController().signal,
    requestPermission: async () => ({ behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "session-1",
    toolCallId: "call-1",
  };
}

function fakeTool(
  name: string,
  behavior: (calls: number) => ToolResult,
): { tool: Tool; calls: () => number } {
  let calls = 0;
  const tool: Tool = {
    definition: { name, description: "fake", parameters: { type: "object" } },
    async execute(): Promise<ToolResult> {
      calls++;
      return behavior(calls);
    },
  };
  return { tool, calls: () => calls };
}

describe("matchesGlob", () => {
  it("matches a leading-* pattern as a suffix", () => {
    expect(matchesGlob("/repo/src/foo.ts", "*.ts")).toBe(true);
    expect(matchesGlob("/repo/src/foo.tsx", "*.ts")).toBe(false);
  });

  it("matches an exact path, a trailing suffix, or a path segment", () => {
    expect(matchesGlob("/repo/src/foo.ts", "/repo/src/foo.ts")).toBe(true);
    expect(matchesGlob("/repo/src/foo.ts", "src/foo.ts")).toBe(true);
    expect(matchesGlob("/repo/src/foo.ts", "src")).toBe(true);
    expect(matchesGlob("/repo/lib/foo.ts", "src")).toBe(false);
  });
});

describePosix("createVerifier", () => {
  it("runs the command and reports success", async () => {
    const dir = await scratch();
    const verifier = createVerifier({ command: "exit 0" }, { cwd: dir });
    const result = await verifier.maybeRun(join(dir, "foo.ts"));
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.exitCode).toBe(0);
  });

  it("runs the command and reports failure with captured output", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "fail.sh", 'echo "boom" 1>&2\nexit 1');
    const verifier = createVerifier({ command: script }, { cwd: dir });
    const result = await verifier.maybeRun(join(dir, "foo.ts"));
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.exitCode).toBe(1);
    expect(result?.output).toContain("boom");
  });

  it("captures stdout in the output tail", async () => {
    const dir = await scratch();
    const verifier = createVerifier({ command: "echo hello-from-verify" }, { cwd: dir });
    const result = await verifier.maybeRun(join(dir, "foo.ts"));
    expect(result?.output).toContain("hello-from-verify");
  });

  it("resolves null without running when the edited path doesn't match globs", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(dir, "count.sh", `printf x >> ${JSON.stringify(counter)}`);
    const verifier = createVerifier({ command: script, globs: ["*.ts"] }, { cwd: dir });

    const result = await verifier.maybeRun(join(dir, "foo.py"));
    expect(result).toBeNull();
    expect(await readFile(counter, "utf8")).toBe("");

    const matched = await verifier.maybeRun(join(dir, "foo.ts"));
    expect(matched).not.toBeNull();
    expect(await readFile(counter, "utf8")).toBe("x");
  });

  it('never auto-runs when runOn is "manual", but runNow still runs it', async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(dir, "count.sh", `printf x >> ${JSON.stringify(counter)}`);
    const verifier = createVerifier({ command: script, runOn: "manual" }, { cwd: dir });

    const result = await verifier.maybeRun(join(dir, "foo.ts"));
    expect(result).toBeNull();
    expect(await readFile(counter, "utf8")).toBe("");

    const manual = await verifier.runNow();
    expect(manual.ok).toBe(true);
    expect(await readFile(counter, "utf8")).toBe("x");
  });

  it("kills the whole process tree on timeout", async () => {
    const dir = await scratch();
    const marker = join(dir, "grandchild-ran");
    const grandchild = join(dir, "grandchild.mjs");
    await writeFile(
      grandchild,
      'import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(process.argv[2], "ran"), 700);\n',
      "utf8",
    );
    const script = await writeScript(dir, "slow.sh", `node ${grandchild} ${marker} &\nsleep 5`);
    const verifier = createVerifier({ command: script, timeoutMs: 150 }, { cwd: dir });

    const start = Date.now();
    const result = await verifier.maybeRun(join(dir, "foo.ts"));
    expect(Date.now() - start).toBeLessThan(4000);
    expect(result?.ok).toBe(false);
    expect(result?.exitCode).toBeNull();
    expect(result?.output).toContain("timed out");

    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  }, 10_000);

  it("caps output to the tail when the command is chatty", async () => {
    const dir = await scratch();
    const script = await writeScript(
      dir,
      "chatty.sh",
      'for i in $(seq 1 100); do echo "line $i"; done',
    );
    const verifier = createVerifier({ command: script }, { cwd: dir });
    const result = await verifier.maybeRun(join(dir, "foo.ts"));
    const lines = result?.output.split("\n") ?? [];
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(result?.output).toContain("line 100");
    expect(result?.output).not.toContain("line 1\n");
  });

  it("coalesces concurrent calls into a single command run", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    // Sleep briefly so both calls are in flight together before either settles.
    const script = await writeScript(
      dir,
      "slow-count.sh",
      `printf x >> ${JSON.stringify(counter)}\nsleep 0.3`,
    );
    const verifier = createVerifier({ command: script }, { cwd: dir });

    const [a, b] = await Promise.all([
      verifier.maybeRun(join(dir, "a.ts")),
      verifier.maybeRun(join(dir, "b.ts")),
    ]);

    expect(await readFile(counter, "utf8")).toBe("x");
    expect(a).toEqual(b);

    // A later, non-overlapping call spawns a fresh process.
    const c = await verifier.maybeRun(join(dir, "c.ts"));
    expect(c).toEqual(a);
    expect(await readFile(counter, "utf8")).toBe("xx");
  });
});

describePosix("wrapToolsWithVerify", () => {
  it("appends nothing when verify passes", async () => {
    const dir = await scratch();
    const verifier = createVerifier({ command: "exit 0" }, { cwd: dir });
    const { tool } = fakeTool("edit", () => ({ content: [{ type: "text", text: "edited" }] }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    const result = await (wrapped as Tool).execute({ path: "foo.ts" }, fakeCtx(dir));

    expect(result.content).toEqual([{ type: "text", text: "edited" }]);
    expect(result.isError).toBeUndefined();
  });

  it("appends the failure tail when verify fails, without marking the result an error", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "fail.sh", 'echo "type error" 1>&2\nexit 1');
    const verifier = createVerifier({ command: script }, { cwd: dir });
    const { tool } = fakeTool("write", () => ({ content: [{ type: "text", text: "wrote it" }] }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    const result = await (wrapped as Tool).execute({ path: "foo.ts" }, fakeCtx(dir));

    expect(result.isError).toBeUndefined();
    const text = result.content[0];
    expect(text?.type).toBe("text");
    expect(text && "text" in text ? text.text : "").toContain("wrote it");
    expect(text && "text" in text ? text.text : "").toContain("verify failed (exit 1):");
    expect(text && "text" in text ? text.text : "").toContain("type error");
  });

  it("does not run verify, and appends nothing, when globs don't match the edited path", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(
      dir,
      "count.sh",
      `printf x >> ${JSON.stringify(counter)}\nexit 1`,
    );
    const verifier = createVerifier({ command: script, globs: ["*.py"] }, { cwd: dir });
    const { tool } = fakeTool("edit", () => ({ content: [{ type: "text", text: "edited" }] }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    const result = await (wrapped as Tool).execute({ path: "foo.ts" }, fakeCtx(dir));

    expect(result.content).toEqual([{ type: "text", text: "edited" }]);
    expect(await readFile(counter, "utf8")).toBe("");
  });

  it("never turns a successful edit into an error result", async () => {
    const dir = await scratch();
    const script = await writeScript(dir, "fail.sh", "exit 1");
    const verifier = createVerifier({ command: script }, { cwd: dir });
    const { tool } = fakeTool("edit", () => ({ content: [{ type: "text", text: "edited" }] }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    const result = await (wrapped as Tool).execute({ path: "foo.ts" }, fakeCtx(dir));

    expect(result.isError).toBeUndefined();
  });

  it("skips verify entirely when the wrapped tool's own result is an error", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(dir, "count.sh", `printf x >> ${JSON.stringify(counter)}`);
    const verifier = createVerifier({ command: script }, { cwd: dir });
    const { tool } = fakeTool("edit", () => ({
      content: [{ type: "text", text: "failed to edit" }],
      isError: true,
    }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    const result = await (wrapped as Tool).execute({ path: "foo.ts" }, fakeCtx(dir));

    expect(result.isError).toBe(true);
    expect(await readFile(counter, "utf8")).toBe("");
  });

  it("passes non-write/edit tools through unchanged", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(
      dir,
      "count.sh",
      `printf x >> ${JSON.stringify(counter)}\nexit 1`,
    );
    const verifier = createVerifier({ command: script }, { cwd: dir });
    const { tool, calls } = fakeTool("bash", () => ({
      content: [{ type: "text", text: "ran a command" }],
    }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    expect(wrapped).toBe(tool);
    const result = await (wrapped as Tool).execute({ command: "ls" }, fakeCtx(dir));

    expect(calls()).toBe(1);
    expect(result.content).toEqual([{ type: "text", text: "ran a command" }]);
    expect(await readFile(counter, "utf8")).toBe("");
  });

  it("coalesces verify runs across multiple edits landing concurrently", async () => {
    const dir = await scratch();
    const counter = join(dir, "count");
    await writeFile(counter, "", "utf8");
    const script = await writeScript(
      dir,
      "slow-count.sh",
      `printf x >> ${JSON.stringify(counter)}\nsleep 0.3\nexit 1`,
    );
    const verifier: Verifier = createVerifier({ command: script }, { cwd: dir });
    const { tool } = fakeTool("edit", () => ({ content: [{ type: "text", text: "edited" }] }));

    const [wrapped] = wrapToolsWithVerify([tool], verifier);
    const [r1, r2] = await Promise.all([
      (wrapped as Tool).execute({ path: "a.ts" }, fakeCtx(dir)),
      (wrapped as Tool).execute({ path: "b.ts" }, fakeCtx(dir)),
    ]);

    expect(await readFile(counter, "utf8")).toBe("x");
    const text1 = r1.content[0];
    const text2 = r2.content[0];
    expect(text1 && "text" in text1 ? text1.text : "").toContain("verify failed");
    expect(text2 && "text" in text2 ? text2.text : "").toContain("verify failed");
  });
});

/**
 * Which OS call terminates a timed-out verify command's tree. The kill
 * environment is injected (and records instead of killing), so the win32
 * branch is exercised on this POSIX runner; the commands below outlive the
 * timeout and then exit on their own, so each run still settles.
 */
describePosix("verify command process-tree termination", () => {
  function fakeKillEnvironment(platform: NodeJS.Platform) {
    const posixKill = vi.fn();
    const windowsKill = vi.fn();
    return { killEnvironment: { platform, posixKill, windowsKill }, posixKill, windowsKill };
  }

  it("signals the process group via posixKill on POSIX, never windowsKill", async () => {
    const dir = await scratch();
    const { killEnvironment, posixKill, windowsKill } = fakeKillEnvironment("linux");
    const verifier = createVerifier(
      { command: "sleep 0.4", timeoutMs: 100 },
      { cwd: dir, killEnvironment },
    );

    const result = await verifier.runNow();

    expect(result.output).toContain("timed out");
    expect(posixKill).toHaveBeenCalledTimes(1);
    const [pid, signal] = posixKill.mock.calls[0] as [number, NodeJS.Signals];
    expect(typeof pid).toBe("number");
    expect(signal).toBe("SIGKILL");
    expect(windowsKill).not.toHaveBeenCalled();
  }, 10_000);

  it("force-terminates the tree via windowsKill on win32, never posixKill", async () => {
    // `process.kill(-pid)` throws on Windows — there are no process groups —
    // and the old fallback reached only the `cmd.exe` wrapper, orphaning the
    // command it had spawned. A stand-in `%ComSpec%` keeps the child a real
    // POSIX process here while the *kill* takes the Windows branch.
    const dir = await scratch();
    const fakeComSpec = await writeScript(dir, "fake-cmd", "sleep 0.4");
    const { killEnvironment, posixKill, windowsKill } = fakeKillEnvironment("win32");
    const verifier = createVerifier(
      { command: "pnpm test", timeoutMs: 100 },
      { cwd: dir, env: { ...process.env, ComSpec: fakeComSpec }, killEnvironment },
    );

    const result = await verifier.runNow();

    expect(result.output).toContain("timed out");
    expect(windowsKill).toHaveBeenCalledTimes(1);
    expect(windowsKill).toHaveBeenCalledWith(expect.any(Number));
    expect(posixKill).not.toHaveBeenCalled();
  }, 10_000);
});
