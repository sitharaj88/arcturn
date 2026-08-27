/**
 * Which shell lifecycle hooks are spawned with, per platform.
 *
 * Hooks are *user*-authored commands, so on POSIX they keep following the
 * user's `$SHELL` (falling back to `/bin/sh`). On Windows there is no
 * meaningful equivalent — see {@link ./hooks.ts} — so they run under
 * `%ComSpec%`.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHookRunner, type HookConfig } from "./hooks.js";

/** The recording shell is a POSIX script, so these only make sense on a POSIX host. */
const itPosix = it.skipIf(process.platform === "win32");

function emptyConfig(): HookConfig {
  return { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] };
}

describe("hook shell resolution", () => {
  let dir: string;
  let record: string;
  let recordingShell: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-hooks-shell-"));
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
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  async function recordedArgv(): Promise<string[] | undefined> {
    let text: string;
    try {
      text = await readFile(record, "utf8");
    } catch {
      return undefined;
    }
    return text.split("\n").filter((line) => line.length > 0);
  }

  itPosix("runs the hook through $SHELL -c on POSIX", async () => {
    const runner = createHookRunner(
      { ...emptyConfig(), sessionStart: [{ command: "echo hook" }] },
      { cwd: dir, env: { ...process.env, SHELL: recordingShell }, platform: "linux" },
    );

    const result = await runner.run("sessionStart");

    expect(result.decision).toBe("allow");
    expect(await recordedArgv()).toEqual(["-c", "echo hook"]);
  });

  itPosix("falls back to /bin/sh -c on POSIX when $SHELL is unset", async () => {
    const marker = join(dir, "ran");
    const runner = createHookRunner(
      { ...emptyConfig(), sessionStart: [{ command: `printf ran > ${JSON.stringify(marker)}` }] },
      { cwd: dir, env: {}, platform: "linux" },
    );

    const result = await runner.run("sessionStart");

    expect(result.decision).toBe("allow");
    expect(await readFile(marker, "utf8")).toBe("ran");
  });

  itPosix('runs the hook as `%ComSpec% /d /s /c "<command>"` on Windows', async () => {
    const runner = createHookRunner(
      { ...emptyConfig(), sessionStart: [{ command: "echo hook" }] },
      { cwd: dir, env: { ComSpec: recordingShell }, platform: "win32" },
    );

    const result = await runner.run("sessionStart");

    expect(result.decision).toBe("allow");
    expect(await recordedArgv()).toEqual(["/d", "/s", "/c", '"echo hook"']);
  });

  itPosix("ignores $SHELL on Windows, where it names a path Win32 cannot spawn", async () => {
    const runner = createHookRunner(
      { ...emptyConfig(), sessionStart: [{ command: "echo hook" }] },
      {
        cwd: dir,
        env: { SHELL: join(dir, "no-such-posix-shell"), ComSpec: recordingShell },
        platform: "win32",
      },
    );

    const result = await runner.run("sessionStart");

    expect(result.warnings).toEqual([]);
    expect(await recordedArgv()).toEqual(["/d", "/s", "/c", '"echo hook"']);
  });
});
