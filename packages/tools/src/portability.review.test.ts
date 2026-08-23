/**
 * Adversarial portability review of the tools package, after shell
 * resolution (D1), win32 process termination (D2) and sandbox degradation
 * (D3) landed.
 *
 * Every `it` here is a repro that was run against the code as landed. The
 * ones that FAIL are the findings; the ones that PASS are refutations kept
 * on purpose, because each is an assumption someone will make again and a
 * test is the cheapest way to keep the answer honest.
 *
 * These run on POSIX, but the defects they pin are Windows defects: the
 * foreground kill path below leaks *sometimes* on POSIX (only when the shell
 * does not exec-optimize the command) and *always* on Windows, because
 * `cmd.exe /c` never execs — it always forks the real command as a child.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager, createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { resolveShell } from "./shell.js";
import { createFakeContext, removeTempDir } from "./test-utils.js";

const textOf = (result: ToolResult): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcturn-portability-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ D2 gap */

describe("bash foreground termination (D2 audited only the background path)", () => {
  it.skipIf(process.platform === "win32")(
    "kills the whole tree on timeout, and returns as soon as it has",
    async () => {
      // A command whose shell forks a child that outlives it. On POSIX this
      // is any non-exec-optimized shape (`a; b`, `a && b`, `a &`, a pipeline);
      // on Windows it is EVERY command, since `cmd /d /s /c` always forks.
      const marker = join(dir, "orphan-did-work");
      const command = `sh -c 'sleep 2; printf orphan > "${marker}"' & wait`;

      const tool = createBashTool(new BackgroundTaskManager());
      const { ctx } = createFakeContext({ cwd: dir });

      const startedAt = Date.now();
      const result = await tool.execute({ command, timeoutMs: 300 }, ctx);
      const elapsedMs = Date.now() - startedAt;

      // The timeout fired, so the tool reports a timeout...
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("timed out");

      // ...but `runForeground` resolves on `close`, and `close` waits for the
      // stdio pipes the *orphan* still holds. The 300ms timeout therefore
      // does not bound the tool call at all: it returns when the orphan
      // finally exits, whenever that is. Here that is ~2s; for `npm run dev`
      // it is never.
      expect(elapsedMs).toBeLessThan(1_200);

      // And the orphan kept doing the work the kill was supposed to stop.
      await sleep(Math.max(0, 2_600 - (Date.now() - startedAt)));
      expect(existsSync(marker)).toBe(false);
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills the whole tree on abort, and returns as soon as it has",
    async () => {
      const marker = join(dir, "orphan-survived-abort");
      const command = `sh -c 'sleep 2; printf orphan > "${marker}"' & wait`;

      const tool = createBashTool(new BackgroundTaskManager());
      const controller = new AbortController();
      const { ctx } = createFakeContext({ cwd: dir, signal: controller.signal });

      const startedAt = Date.now();
      const pending = tool.execute({ command, timeoutMs: 30_000 }, ctx);
      setTimeout(() => controller.abort(), 300);
      const result = await pending;
      const elapsedMs = Date.now() - startedAt;

      expect(result.isError).toBe(true);
      // An abort is a user pressing Esc. It must not wait on a process the
      // abort was meant to kill.
      expect(elapsedMs).toBeLessThan(1_200);

      await sleep(Math.max(0, 2_600 - (Date.now() - startedAt)));
      expect(existsSync(marker)).toBe(false);
    },
    20_000,
  );
});

/* ------------------------------------------------------ CRLF working copies */

describe("CRLF working copies (git-for-windows checks out CRLF by default)", () => {
  it("gives the model a recoverable answer when oldText differs only by line ending", async () => {
    // What `git clone` produces on Windows under the default
    // core.autocrlf=true: every line ends CRLF on disk.
    const file = join(dir, "app.ts");
    await writeFile(file, "const a = 1;\r\nconst b = 2;\r\n", "utf8");

    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute(
      {
        path: file,
        // Exactly what a model writes after reading the file: `read` splits on
        // "\n" and shows the model lines whose trailing "\r" is invisible, so
        // the text it echoes back is LF-joined.
        oldText: "const a = 1;\nconst b = 2;",
        newText: "const a = 9;\nconst b = 2;",
      },
      ctx,
    );

    if (result.isError !== true) {
      expect(await readFile(file, "utf8")).toContain("const a = 9;");
      return;
    }
    // If it is going to refuse, it has to say WHY, or the model has no move
    // left: the text it just read back verbatim "is not found", so it retries
    // the identical edit until the turn budget runs out.
    expect(textOf(result)).toMatch(/line ending|CRLF|\\r\\n|carriage return/i);
  });
});

/* --------------------------------------------------------------- refutations */

describe("refutations (kept so the next reviewer does not re-litigate them)", () => {
  it("resolveShell hands Windows a shell that exists, and POSIX the one it had", () => {
    const win = resolveShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(win.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(win.args("echo hi")).toEqual(["/d", "/s", "/c", '"echo hi"']);
    expect(win.spawnOptions.windowsVerbatimArguments).toBe(true);

    const posix = resolveShell("darwin", { SHELL: "/opt/homebrew/bin/fish" });
    expect(posix.executable).toBe("/bin/sh");
    expect(posix.args("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it("a background task's spawn is not defeated by an unset %ComSpec%", () => {
    expect(resolveShell("win32", {}).executable).toBe("cmd.exe");
  });
});
