/**
 * Which shell the verify loop hands its command to, per platform.
 *
 * Asserted through a real recording shell (a script that writes down the
 * argv it was invoked with) rather than through internals, so a verify
 * command still spawned via a hardcoded `/bin/sh` fails here.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVerifier } from "./verify.js";

/** The recording shell is a POSIX script, so these only make sense on a POSIX host. */
const itPosix = it.skipIf(process.platform === "win32");

describe("verify command shell resolution", () => {
  let dir: string;
  let record: string;
  let recordingShell: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-verify-shell-"));
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

  async function recordedArgv(): Promise<string[] | undefined> {
    let text: string;
    try {
      text = await readFile(record, "utf8");
    } catch {
      return undefined;
    }
    return text.split("\n").filter((line) => line.length > 0);
  }

  itPosix('runs the verify command as `%ComSpec% /d /s /c "<command>"` on Windows', async () => {
    const verifier = createVerifier(
      { command: "pnpm test" },
      { cwd: dir, env: { ...process.env, ComSpec: recordingShell }, platform: "win32" },
    );

    const result = await verifier.runNow();

    expect(result.ok).toBe(true);
    expect(await recordedArgv()).toEqual(["/d", "/s", "/c", '"pnpm test"']);
  });

  itPosix("falls back to cmd.exe on Windows when ComSpec is unset", async () => {
    const verifier = createVerifier(
      { command: "pnpm test" },
      { cwd: dir, env: {}, platform: "win32" },
    );

    const result = await verifier.runNow();

    expect(result.ok).toBe(false);
    expect(result.output).toContain("cmd.exe");
  });

  itPosix("keeps using /bin/sh -c on POSIX, regardless of $SHELL", async () => {
    const marker = join(dir, "ran");
    const verifier = createVerifier(
      { command: `printf ran > ${JSON.stringify(marker)}` },
      { cwd: dir, env: { ...process.env, SHELL: recordingShell }, platform: "linux" },
    );

    const result = await verifier.runNow();

    expect(result.ok).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("ran");
    expect(await recordedArgv()).toBeUndefined();
  });
});
