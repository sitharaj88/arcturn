/**
 * Adversarial security review — tools package, SANDBOX seam.
 *
 * `it.fails` reproduces the current (buggy) behavior; do not "fix" this test
 * by loosening its assertions — fix `bash.ts`/`sandbox.ts` and flip it to
 * `it` once background commands are actually sandboxed.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, createBashTool } from "./bash.js";
import type { SandboxProbe } from "./sandbox.js";
import { createFakeContext } from "./test-utils.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Poll a background task until it stops running, or fail after a timeout. */
async function _waitForTask(
  manager: BackgroundTaskManager,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = manager.poll(taskId);
    if (status && !status.running) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`background task ${taskId} did not finish within ${timeoutMs}ms`);
}

describe("SANDBOX: background bash refuses a sandbox request (fixed)", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("the foreground write is sandbox-denied and the background variant is refused outright", async () => {
    // Only run where the real backend (`sandbox-exec`) actually exists —
    // this is a behavioral test against the live OS sandbox, not a mock.
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
      // eslint-disable-next-line no-console
      console.warn("skipping: sandbox-exec unavailable on this platform");
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "arcturn-tools-sandbox-bg-"));
    dirs.push(root);
    const cwd = join(root, "workspace");
    const outside = join(root, "outside"); // deliberately NOT a writable root
    const fakeTmpDir = join(root, "fake-tmp");
    const fakeHomeDir = join(root, "fake-home");
    await Promise.all(
      [cwd, outside, fakeTmpDir, fakeHomeDir].map((d) => mkdir(d, { recursive: true })),
    );

    // Fully-controlled probe: cwd/tmpDir/home(.arcturn) are the only writable
    // roots under "workspace-write", and `outside` is none of them.
    const probe: SandboxProbe = {
      platform: "darwin",
      existsSync,
      path: process.env.PATH ?? "",
      homeDir: fakeHomeDir,
      tmpDir: fakeTmpDir,
      realpathSync: (p) => p,
    };

    const foregroundTarget = join(outside, "foreground.txt");
    const backgroundTarget = join(outside, "background.txt");

    const manager = new BackgroundTaskManager();
    const tool = createBashTool(manager, { sandbox: "workspace-write", sandboxProbe: probe });
    const { ctx } = createFakeContext({ cwd });

    // 1) Foreground: the OS sandbox actually denies the write outside the
    //    writable roots — this is the control, proving the sandbox works
    //    at all in this environment.
    const fg = await tool.execute(
      { command: `echo pwned > "${foregroundTarget}"`, timeoutMs: 5_000 },
      ctx,
    );
    expect(fg.isError).toBe(true);
    expect(await pathExists(foregroundTarget)).toBe(false);

    // 2) Background: the *identical* sandbox options, the *identical*
    //    kind of write outside the roots, just `background: true`.
    //    `createBashTool`'s background branch calls
    //    `backgroundTasks.start(command, cwd)` (bash.ts) directly — it
    //    never touches `resolveSandboxInvocation`, so the command runs as
    //    plain `/bin/sh -c command` with no sandboxing applied at all.
    // Background: the identical sandbox request is refused rather than run
    // unsandboxed, so no task is started and nothing is written outside.
    const bg = await tool.execute(
      {
        command: `echo pwned > "${backgroundTarget}"`,
        background: true,
      },
      ctx,
    );
    expect(bg.isError).toBe(true);
    expect((bg.details as { taskId?: string } | undefined)?.taskId).toBeUndefined();
    expect(await pathExists(backgroundTarget)).toBe(false);
    void readFile;
  });
});
