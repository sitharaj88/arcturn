/**
 * Adversarial portability review of the CLI, after shell resolution (D1),
 * win32 process termination (D2) and sandbox degradation (D3) landed.
 *
 * Every `it` here is a repro that was run against the code as landed. The
 * ones that FAIL are the findings; the ones that PASS are refutations kept on
 * purpose.
 *
 * Two of these findings are not Windows-only. A case-insensitive filesystem
 * is the default on macOS as well, so the permission and session-bucket
 * repros below fail on the machine this suite normally runs on — they are
 * filed here because the audit that found them was a Windows audit.
 */

import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchRules, matchSpecifier } from "@arcturn/core";
import { ColorLevel, detectColorLevel } from "@arcturn/tui";
import type { PermissionRule } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cwdHash } from "./paths.js";
import { auditPatchPaths } from "./workflow.js";

/**
 * Whether the filesystem under `os.tmpdir()` is case-insensitive — true on a
 * default macOS (APFS) and on every Windows volume, false on ext4/xfs. Decided
 * once, against the real filesystem, rather than guessed from `process.platform`.
 */
const CASE_INSENSITIVE_FS: boolean = (() => {
  const probe = mkdtempSync(join(tmpdir(), "arcturn-case-probe-"));
  mkdirSync(join(probe, "Aa"));
  try {
    return statSync(join(probe, "aA")).isDirectory();
  } catch {
    return false;
  }
})();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arcturn-portability-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/* ------------------------------------------- rule specifiers vs Windows paths */

describe("permission specifiers are matched with a hardcoded POSIX separator", () => {
  const denySecrets: PermissionRule[] = [
    // The exact rule the permissions doc tells users to write
    // (web/content/docs/permissions.md).
    { tool: "write", specifier: "**/.env", action: "deny", scope: "user" },
    { tool: "edit", specifier: "**/.env", action: "deny", scope: "user" },
  ];

  it("still denies the documented secret path when the subject is a Windows path", () => {
    // `defaultSubject` resolves a path subject with `path.resolve`, so on
    // Windows the engine sees backslashes — while `globToRegExp` compiles
    // `**/` to `(?:.*/)?`, which only ever matches a forward slash.
    expect(matchRules(denySecrets, "write", "C:\\repo\\.env")?.action).toBe("deny");
  });

  it("does not let `*` cross a Windows directory separator", () => {
    // `*` compiles to `[^/]*`, which happily eats backslashes. A rule meant to
    // grant one directory grants the whole subtree under it on Windows.
    expect(matchSpecifier("C:\\repo\\*", "C:\\repo\\secrets\\deep\\prod.env")).toBe(false);
  });
});

/* --------------------------------------- case-insensitive filesystems */

describe("case-insensitive filesystems (Windows always, macOS by default)", () => {
  it.skipIf(!CASE_INSENSITIVE_FS)("denies the same file spelled with different case", async () => {
    const secret = join(dir, ".env");
    await writeFile(secret, "TOKEN=1", "utf8");
    // Same bytes, two spellings — proven against the real filesystem rather
    // than assumed.
    expect(statSync(join(dir, ".ENV")).ino).toBe(statSync(secret).ino);

    const rules: PermissionRule[] = [
      { tool: "write", specifier: "**/.env", action: "deny", scope: "user" },
    ];
    // `defaultSubject` normalizes `..` and relative spellings for exactly this
    // reason ("otherwise a deny rule written with an absolute path would not
    // match the same file named relatively") — but not case, so the same file
    // has a second name that no deny rule sees.
    expect(matchRules(rules, "write", join(dir, ".ENV"))?.action).toBe("deny");
  });

  it.skipIf(!CASE_INSENSITIVE_FS)("buckets one directory into one session store", async () => {
    const project = join(dir, "Project");
    await mkdir(project);
    const otherSpelling = join(dir, "project");
    expect(statSync(otherSpelling).ino).toBe(statSync(project).ino);

    // `arcturn --continue` looks in `sessions/<cwdHash(cwd)>`. Started from
    // one spelling and resumed from the other — `cd project` after
    // `cd Project`, or a drive letter that came back lowercased — the history
    // is intact but invisible.
    expect(cwdHash(otherSpelling)).toBe(cwdHash(project));
  });
});

/* ------------------------------------------------------------- TUI on Windows */

describe("colour detection", () => {
  it("does not fall back to monochrome inside Windows Terminal", () => {
    // Windows Terminal sets neither TERM nor COLORTERM nor TERM_PROGRAM. It
    // does set WT_SESSION, and it has supported 24-bit colour since 1703.
    // `detectColorLevel` ends at `term !== "" ? Basic : None`, so the whole
    // TUI renders unstyled there.
    const level = detectColorLevel({
      env: { WT_SESSION: "b4d1f3c2-0000-4000-8000-000000000000" },
      isTTY: true,
    });
    expect(level).not.toBe(ColorLevel.None);
  });
});

/* ------------------------------- D2 was applied to one of three kill sites */

describe("process-tree termination outside tools/bash.ts", () => {
  const sourceOf = (file: string) =>
    readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  it.each(["./verify.ts", "./hooks.ts"])(
    "%s terminates a timed-out command's tree on win32 too",
    async (file) => {
      const source = await sourceOf(file);
      // The kill site itself, with enough of its neighbourhood to see whether
      // it is guarded. Sliced rather than asserted whole so the failure names
      // the defect instead of printing the file.
      const killSite = /.{0,200}process\.kill\(-[\s\S]{0,200}/.exec(source)?.[0];
      // Documents that this file really does own a process-tree kill...
      expect(killSite).toBeDefined();
      // ...and that the kill knows what platform it is on. `process.kill(-pid)`
      // throws on Windows (there are no process groups), and the `catch` falls
      // back to `child.kill()`, which reaches only the `cmd.exe` wrapper and
      // leaves the command itself running.
      expect(killSite).toMatch(/win32|taskkill|windowsKill|terminateProcessTree/);
    },
  );
});

/* --------------------------------------------------------------- refutations */

describe("refutations (kept so the next reviewer does not re-litigate them)", () => {
  it("rejects Windows-absolute and backslash-escaping patch targets", () => {
    expect(auditPatchPaths("+++ b/C:\\Windows\\System32\\drivers\\etc\\hosts\n")).toEqual([
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
    ]);
    expect(auditPatchPaths("+++ b/..\\..\\.ssh\\authorized_keys\n")).toEqual([
      "..\\..\\.ssh\\authorized_keys",
    ]);
    expect(auditPatchPaths("+++ b/.GIT\\config\n")).toEqual([".GIT\\config"]);
  });

  it("keeps session-bucket names free of characters Windows forbids", () => {
    // `:` `*` `?` `"` `<` `>` `|` are illegal in a Windows filename, and the
    // bucket name is a directory that gets created for real.
    expect(cwdHash("C:\\Users\\me\\proj")).toMatch(/^[0-9a-f]{16}$/);
  });
});
