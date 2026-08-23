/**
 * The `bash` tool's shell wiring: which executable and argument vector it
 * actually hands to `spawn` on each platform.
 *
 * These assert on observable spawn behavior rather than on internals: the
 * injected shell is a real script that records the argv it was invoked with,
 * so a call site that quietly kept its own hardcoded `/bin/sh` fails here.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, createBashTool } from "./bash.js";
import type { SandboxProbe } from "./sandbox.js";
import { createFakeContext } from "./test-utils.js";

/**
 * The recording shell is a POSIX script, so these tests only make sense on a
 * POSIX host. Windows CI runs the platform-pure {@link ./shell.test.ts}
 * assertions instead.
 */
const itPosix = it.skipIf(process.platform === "win32");

function fakeSandboxProbe(overrides: Partial<SandboxProbe>): SandboxProbe {
  return {
    platform: "darwin",
    existsSync: () => true,
    path: "",
    homeDir: "/Users/arcturn",
    tmpDir: "/tmp",
    realpathSync: (p) => p,
    ...overrides,
  };
}

describe("bash tool shell resolution", () => {
  let dir: string;
  let record: string;
  let recordingShell: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-bash-shell-"));
    record = join(dir, "argv.txt");
    recordingShell = join(dir, "recording-shell");
    await writeFile(
      recordingShell,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\n`,
      "utf8",
    );
    await chmod(recordingShell, 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The argv lines the recording shell captured, or `undefined` if it never ran. */
  async function recordedArgv(): Promise<string[] | undefined> {
    let text: string;
    try {
      text = await readFile(record, "utf8");
    } catch {
      return undefined;
    }
    return text.split("\n").filter((line) => line.length > 0);
  }

  itPosix('spawns Windows commands as `%ComSpec% /d /s /c "<command>"`', async () => {
    const tool = createBashTool(new BackgroundTaskManager(), {
      shellProbe: { platform: "win32", env: { ComSpec: recordingShell } },
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(await recordedArgv()).toEqual(["/d", "/s", "/c", '"echo hi"']);
  });

  itPosix("falls back to cmd.exe on Windows when ComSpec is unset", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), {
      shellProbe: { platform: "win32", env: {} },
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    // No cmd.exe on this host, so the spawn fails — but it fails *naming the
    // shell we resolved*, which is what this asserts.
    expect((result.content[0] as { text: string }).text).toContain("cmd.exe");
  });

  itPosix("keeps POSIX commands on /bin/sh even when $SHELL points elsewhere", async () => {
    // Model-authored commands are POSIX-sh flavored; following an interactive
    // $SHELL (fish, csh, zsh globbing) would silently change their meaning.
    const tool = createBashTool(new BackgroundTaskManager(), {
      shellProbe: { platform: "linux", env: { SHELL: recordingShell } },
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect((result.content[0] as { text: string }).text).toContain("hi");
    expect(await recordedArgv()).toBeUndefined();
  });

  itPosix("routes the unsandboxable Windows fallback through the Windows shell too", async () => {
    const tool = createBashTool(new BackgroundTaskManager(), {
      sandbox: "workspace-write",
      sandboxProbe: fakeSandboxProbe({ platform: "win32" }),
      shellProbe: { platform: "win32", env: { ComSpec: recordingShell } },
    });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ command: "echo hi" }, ctx);

    expect((result.content[0] as { text: string }).text).toContain("sandbox requested but");
    expect(result.details).toMatchObject({ sandboxUnavailable: true });
    expect(await recordedArgv()).toEqual(["/d", "/s", "/c", '"echo hi"']);
  });

  it("tells the model which shell interprets its command", () => {
    const posix = createBashTool(new BackgroundTaskManager(), {
      shellProbe: { platform: "darwin", env: {} },
    });
    const windows = createBashTool(new BackgroundTaskManager(), {
      shellProbe: { platform: "win32", env: {} },
    });

    expect(posix.definition.description).toContain("`/bin/sh -c`");
    expect(posix.definition.description).not.toContain("cmd.exe");
    expect(windows.definition.description).toContain("`cmd.exe /d /s /c`");
    // The model has to know POSIX syntax is off the table there.
    expect(windows.definition.description).toMatch(/not a POSIX shell/i);
  });
});
