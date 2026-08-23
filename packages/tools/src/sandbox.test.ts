import { existsSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBwrapArgv,
  buildSandboxExecArgv,
  buildSandboxExecProfile,
  commandExistsOnPath,
  escapeSandboxProfilePath,
  noSandboxBackendNote,
  resolveSandboxInvocation,
  SANDBOX_UNAVAILABLE_NOTE,
  type SandboxProbe,
  type SandboxWritableRoots,
} from "./sandbox.js";

/** Run `fn` with `process.env.ComSpec` temporarily set (or deleted), restoring it afterward. */
function withComSpec<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.ComSpec;
  try {
    if (value === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = value;
    return fn();
  } finally {
    if (original === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = original;
  }
}

const ROOTS: SandboxWritableRoots = {
  cwd: "/repo/project",
  tmpDir: "/private/tmp",
  homeDir: "/Users/arcturn",
};

function fakeProbe(overrides: Partial<SandboxProbe>): SandboxProbe {
  return {
    platform: "darwin",
    existsSync: () => true,
    path: "",
    homeDir: ROOTS.homeDir,
    tmpDir: ROOTS.tmpDir,
    realpathSync: (p) => p,
    ...overrides,
  };
}

describe("escapeSandboxProfilePath", () => {
  it("escapes backslashes and double quotes", () => {
    expect(escapeSandboxProfilePath(String.raw`C:\path\to"thing"`)).toBe(
      String.raw`C:\\path\\to\"thing\"`,
    );
  });

  it("leaves ordinary paths untouched", () => {
    expect(escapeSandboxProfilePath("/repo/project")).toBe("/repo/project");
  });
});

describe("buildSandboxExecProfile", () => {
  it("denies file writes by default and allows the three writable roots", () => {
    const profile = buildSandboxExecProfile(ROOTS);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(allow file-write* (subpath "/repo/project"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(profile).toContain(`(allow file-write* (subpath "${join(ROOTS.homeDir, ".arcturn")}"))`);
  });

  it("carves the org memory store back out, after the allow that would cover it", () => {
    // `$HOME/.arcturn` is writable so a sandboxed step can checkpoint and log.
    // The org memory store lives under it and must not be: its entries become
    // standing instruction text in a later role's prompt, so a sandboxed step
    // that can write it can plant a forged operator-approved lesson. Order is
    // load-bearing — sandbox-exec takes the LAST matching rule, so the deny has
    // to come after the allow it narrows.
    const profile = buildSandboxExecProfile(ROOTS);
    const store = join(ROOTS.homeDir, ".arcturn", "org-memory");
    expect(profile).toContain(`(deny file-write* (subpath "${store}"))`);
    expect(profile.indexOf(`(deny file-write* (subpath "${store}"))`)).toBeGreaterThan(
      profile.indexOf(`(allow file-write* (subpath "${join(ROOTS.homeDir, ".arcturn")}"))`),
    );
  });

  it("escapes quotes/backslashes embedded in a root path", () => {
    const profile = buildSandboxExecProfile({
      cwd: 'C:\\repo "weird"',
      tmpDir: "/tmp",
      homeDir: "/home/arcturn",
    });
    expect(profile).toContain('(subpath "C:\\\\repo \\"weird\\"")');
    // The raw quote character must never appear unescaped inside the literal.
    expect(profile).not.toMatch(/subpath "C:\\repo "weird""/);
  });
});

describe("buildBwrapArgv — the org memory carve-out", () => {
  it("re-binds the store read-only after the read-write bind that covers it", () => {
    // Same reasoning as the sandbox-exec deny, expressed the way bwrap does it:
    // a later bind wins, so re-binding the store read-only after `.arcturn` is
    // bound read-write leaves the rest of the state directory writable and the
    // store not. `--ro-bind-try` because the store need not exist yet — an
    // ordinary `--ro-bind` would fail the whole sandbox on a fresh machine.
    const argv = buildBwrapArgv(ROOTS, "echo hi");
    const store = join(ROOTS.homeDir, ".arcturn", "org-memory");
    expect(argv).toEqual(expect.arrayContaining(["--ro-bind-try", store, store]));
    expect(argv.lastIndexOf(store)).toBeGreaterThan(
      argv.lastIndexOf(join(ROOTS.homeDir, ".arcturn")),
    );
  });
});

describe("buildSandboxExecArgv", () => {
  it("passes the profile via -p and runs the command through /bin/sh -c", () => {
    const profile = "(version 1)";
    const argv = buildSandboxExecArgv(profile, "echo hi");
    expect(argv).toEqual(["-p", profile, "/bin/sh", "-c", "echo hi"]);
  });
});

describe("buildBwrapArgv", () => {
  it("binds / read-only, the three roots read-write, and shares the network", () => {
    const argv = buildBwrapArgv(ROOTS, "echo hi");
    expect(argv.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(argv).toContain("--bind");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--bind",
        ROOTS.cwd,
        ROOTS.cwd,
        "--bind",
        ROOTS.tmpDir,
        ROOTS.tmpDir,
        "--bind",
        join(ROOTS.homeDir, ".arcturn"),
        join(ROOTS.homeDir, ".arcturn"),
        "--share-net",
      ]),
    );
    expect(argv.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });
});

describe("commandExistsOnPath", () => {
  it("finds a binary in one of the PATH directories", () => {
    const pathEnv = ["/usr/bin", "/opt/bin", "/nonexistent-dir"].join(delimiter);
    const exists = (p: string) => p === `/opt/bin${sep}bwrap`;
    expect(commandExistsOnPath("bwrap", pathEnv, exists)).toBe(true);
  });

  it("returns false when no PATH directory has the binary", () => {
    const pathEnv = ["/usr/bin", "/opt/bin"].join(delimiter);
    expect(commandExistsOnPath("bwrap", pathEnv, () => false)).toBe(false);
  });

  it("ignores empty PATH segments", () => {
    const pathEnv = `${delimiter}/usr/bin${delimiter}`;
    expect(commandExistsOnPath("bwrap", pathEnv, () => false)).toBe(false);
  });
});

describe("resolveSandboxInvocation", () => {
  it("mode 'off' always passes the command straight through (executable/args), on the probe's platform", () => {
    const invocation = resolveSandboxInvocation("echo hi", "/repo", "off", fakeProbe({}));
    expect(invocation).toEqual({
      executable: "/bin/sh",
      args: ["-c", "echo hi"],
      spawnOptions: {},
      unavailableNote: undefined,
    });
  });

  it("darwin + sandbox-exec present: wraps with sandbox-exec -p <profile>", () => {
    const probe = fakeProbe({ platform: "darwin", existsSync: () => true });
    const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
    expect(invocation.executable).toBe("/usr/bin/sandbox-exec");
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args.slice(2)).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(invocation.unavailableNote).toBeUndefined();
    expect(invocation.args[1]).toContain("(deny file-write*)");
  });

  it("darwin + sandbox-exec missing: falls back unsandboxed with the unavailable note", () => {
    const probe = fakeProbe({ platform: "darwin", existsSync: () => false });
    const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
    expect(invocation).toEqual({
      executable: "/bin/sh",
      args: ["-c", "echo hi"],
      spawnOptions: {},
      unavailableNote: SANDBOX_UNAVAILABLE_NOTE,
    });
  });

  it("linux + bwrap on PATH: wraps with bwrap", () => {
    const probe = fakeProbe({
      platform: "linux",
      path: "/usr/local/bin",
      existsSync: (p: string) => p === "/usr/local/bin/bwrap",
    });
    const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
    expect(invocation.executable).toBe("bwrap");
    expect(invocation.args[0]).toBe("--ro-bind");
    expect(invocation.unavailableNote).toBeUndefined();
  });

  it("linux + bwrap missing from PATH: falls back unsandboxed with the unavailable note", () => {
    const probe = fakeProbe({ platform: "linux", path: "/usr/bin", existsSync: () => false });
    const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
    expect(invocation).toEqual({
      executable: "/bin/sh",
      args: ["-c", "echo hi"],
      spawnOptions: {},
      unavailableNote: SANDBOX_UNAVAILABLE_NOTE,
    });
  });

  it("win32 (no sandboxing backend exists at all): falls back unsandboxed via cmd.exe, with an explicit no-confinement note naming the platform (D3)", () => {
    withComSpec(String.raw`C:\Windows\System32\cmd.exe`, () => {
      const probe = fakeProbe({ platform: "win32" });
      const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
      expect(invocation.executable).toBe(String.raw`C:\Windows\System32\cmd.exe`);
      expect(invocation.args).toEqual(["/d", "/s", "/c", '"echo hi"']);
      expect(invocation.spawnOptions).toEqual({ windowsVerbatimArguments: true });
      // Must be plainly told nothing is confined, not the generic
      // "binary happens to be missing" note used for darwin/linux.
      expect(invocation.unavailableNote).not.toBe(SANDBOX_UNAVAILABLE_NOTE);
      expect(invocation.unavailableNote).toBe(noSandboxBackendNote("win32"));
      expect(invocation.unavailableNote).toContain('"win32"');
      expect(invocation.unavailableNote).toMatch(/without confinement/i);
    });
  });

  it("win32: falls back to plain cmd.exe when $ComSpec is unset", () => {
    withComSpec(undefined, () => {
      const probe = fakeProbe({ platform: "win32" });
      const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
      expect(invocation.executable).toBe("cmd.exe");
      expect(invocation.args).toEqual(["/d", "/s", "/c", '"echo hi"']);
    });
  });

  it('mode "off" on win32 also uses cmd.exe, never a hardcoded /bin/sh that does not exist on Windows', () => {
    withComSpec(undefined, () => {
      const probe = fakeProbe({ platform: "win32" });
      const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "off", probe);
      expect(invocation).toEqual({
        executable: "cmd.exe",
        args: ["/d", "/s", "/c", '"echo hi"'],
        spawnOptions: { windowsVerbatimArguments: true },
        unavailableNote: undefined,
      });
    });
  });

  it('mode "off" on darwin/linux is unchanged: still literal "/bin/sh -c"', () => {
    const invocation = resolveSandboxInvocation(
      "echo hi",
      ROOTS.cwd,
      "off",
      fakeProbe({ platform: "linux" }),
    );
    expect(invocation).toEqual({
      executable: "/bin/sh",
      args: ["-c", "echo hi"],
      spawnOptions: {},
      unavailableNote: undefined,
    });
  });

  it("resolves symlinked roots (e.g. macOS's /var -> /private/var) before embedding them", () => {
    const probe = fakeProbe({
      platform: "darwin",
      tmpDir: "/var/folders/xx/T",
      realpathSync: (p) => p.replace(/^\/var\//, "/private/var/"),
    });
    const invocation = resolveSandboxInvocation("echo hi", "/repo", "workspace-write", probe);
    expect(invocation.args[1]).toContain('(subpath "/private/var/folders/xx/T")');
    expect(invocation.args[1]).not.toContain('"/var/folders/xx/T"');
  });

  it("falls back to the original path when realpathSync throws", () => {
    const probe = fakeProbe({
      platform: "darwin",
      realpathSync: () => {
        throw new Error("ENOENT");
      },
    });
    const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "workspace-write", probe);
    expect(invocation.args[1]).toContain(`(subpath "${ROOTS.cwd}")`);
  });

  it("uses the real environment (defaultSandboxProbe) when no probe is passed", () => {
    // Smoke test only: on this test runner's actual (POSIX) platform, "off"
    // must still resolve to a plain "/bin/sh -c" passthrough.
    const invocation = resolveSandboxInvocation("echo hi", ROOTS.cwd, "off");
    expect(invocation).toEqual({
      executable: "/bin/sh",
      args: ["-c", "echo hi"],
      spawnOptions: {},
      unavailableNote: undefined,
    });
  });
});

describe("noSandboxBackendNote", () => {
  it("names the requesting platform, both implemented backends, and states plainly that nothing is confined (D3)", () => {
    const note = noSandboxBackendNote("win32");
    expect(note).toContain('"win32"');
    expect(note).toContain("sandbox-exec");
    expect(note).toContain("bwrap");
    expect(note).toMatch(/without confinement/i);
    // Names what *would* have been confined, so a Windows user can't mistake
    // silence for enforcement.
    expect(note).toContain(".arcturn");
  });

  it("is distinct from SANDBOX_UNAVAILABLE_NOTE (missing binary on a supported platform)", () => {
    expect(noSandboxBackendNote("win32")).not.toBe(SANDBOX_UNAVAILABLE_NOTE);
  });
});

// Real sandbox-exec execution is only exercised when the binary genuinely
// exists at the well-known path, so this suite behaves on CI machines/OSes
// that lack it (Linux runners, hardened macOS images, etc.).
const hasRealSandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe.runIf(hasRealSandboxExec)("resolveSandboxInvocation (real sandbox-exec)", () => {
  it("actually denies a write outside the allowed roots end-to-end", async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { homedir, tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "arcturn-sandbox-e2e-"));
    try {
      // Directly under $HOME (not under the allowed $HOME/.arcturn, cwd, or the
      // OS temp dir — the temp dir itself is one of the three writable roots).
      const outsidePath = join(homedir(), `arcturn-sandbox-should-not-exist-${Date.now()}.txt`);
      const invocation = resolveSandboxInvocation(
        `echo nope > ${outsidePath}`,
        dir,
        "workspace-write",
      );
      expect(invocation.unavailableNote).toBeUndefined();

      const exitCode = await new Promise<number | null>((resolvePromise) => {
        const child = spawn(invocation.executable, invocation.args, { cwd: dir });
        child.on("close", resolvePromise);
      });

      expect(exitCode).not.toBe(0);
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("actually allows a write inside the cwd end-to-end", async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "arcturn-sandbox-e2e-"));
    try {
      const insidePath = join(dir, "allowed.txt");
      const invocation = resolveSandboxInvocation(
        `echo yes > ${insidePath}`,
        dir,
        "workspace-write",
      );

      const exitCode = await new Promise<number | null>((resolvePromise) => {
        const child = spawn(invocation.executable, invocation.args, { cwd: dir });
        child.on("close", resolvePromise);
      });

      expect(exitCode).toBe(0);
      expect((await readFile(insidePath, "utf8")).trim()).toBe("yes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
