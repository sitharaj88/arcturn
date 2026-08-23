import { describe, expect, it } from "vitest";
import {
  POSIX_DEFAULT_SHELL,
  resolveShell,
  WINDOWS_DEFAULT_SHELL,
  WINDOWS_SHELL_FLAGS,
} from "./shell.js";

describe("resolveShell — POSIX", () => {
  it('defaults to /bin/sh -c under the "posix-sh" policy, ignoring $SHELL', () => {
    const shell = resolveShell("linux", { SHELL: "/usr/bin/fish" }, "posix-sh");

    expect(shell.executable).toBe(POSIX_DEFAULT_SHELL);
    expect(shell.args("echo hi")).toEqual(["-c", "echo hi"]);
    expect(shell.spawnOptions).toEqual({});
  });

  it('honors $SHELL under the "user" policy', () => {
    const shell = resolveShell("darwin", { SHELL: "/bin/zsh" }, "user");

    expect(shell.executable).toBe("/bin/zsh");
    expect(shell.args("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it('falls back to /bin/sh under the "user" policy when $SHELL is unset', () => {
    const shell = resolveShell("darwin", {}, "user");

    expect(shell.executable).toBe(POSIX_DEFAULT_SHELL);
    expect(shell.args("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it('falls back to /bin/sh under the "user" policy when $SHELL is empty', () => {
    const shell = resolveShell("darwin", { SHELL: "" }, "user");

    expect(shell.executable).toBe(POSIX_DEFAULT_SHELL);
  });

  it("defaults to the posix-sh policy when none is given", () => {
    const shell = resolveShell("linux", { SHELL: "/usr/bin/fish" });

    expect(shell.executable).toBe(POSIX_DEFAULT_SHELL);
  });

  it("does not read the real process env when an env object is passed", () => {
    // The real macOS/Linux runner has SHELL set; an explicit empty env must
    // not fall through to it.
    const shell = resolveShell("linux", {}, "user");

    expect(shell.executable).toBe(POSIX_DEFAULT_SHELL);
  });

  it("labels the invocation for docs and model-facing text", () => {
    expect(resolveShell("linux", {}, "posix-sh").label).toBe("/bin/sh -c");
    expect(resolveShell("linux", { SHELL: "/bin/zsh" }, "user").label).toBe("/bin/zsh -c");
  });

  it("is pure: repeated calls with the same inputs agree", () => {
    const a = resolveShell("darwin", { SHELL: "/bin/bash" }, "user");
    const b = resolveShell("darwin", { SHELL: "/bin/bash" }, "user");

    expect(a.executable).toBe(b.executable);
    expect(a.args("x")).toEqual(b.args("x"));
  });
});

describe("resolveShell — Windows", () => {
  it("uses %ComSpec% with cmd's /d /s /c argument vector", () => {
    const shell = resolveShell("win32", { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" }, "posix-sh");

    expect(shell.executable).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(shell.args("echo hi")).toEqual(["/d", "/s", "/c", '"echo hi"']);
    expect(WINDOWS_SHELL_FLAGS).toEqual(["/d", "/s", "/c"]);
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    const shell = resolveShell("win32", {}, "posix-sh");

    expect(shell.executable).toBe(WINDOWS_DEFAULT_SHELL);
    expect(shell.args("dir")).toEqual(["/d", "/s", "/c", '"dir"']);
  });

  it("falls back to cmd.exe when ComSpec is empty", () => {
    expect(resolveShell("win32", { ComSpec: "" }).executable).toBe(WINDOWS_DEFAULT_SHELL);
  });

  it("reads ComSpec case-insensitively, like the Windows environment itself", () => {
    expect(resolveShell("win32", { COMSPEC: "C:\\cmd.exe" }).executable).toBe("C:\\cmd.exe");
    expect(resolveShell("win32", { comspec: "C:\\cmd.exe" }).executable).toBe("C:\\cmd.exe");
  });

  it("ignores $SHELL on Windows under both policies", () => {
    // Git Bash/MSYS set SHELL to a POSIX path (/usr/bin/bash) that Win32
    // CreateProcess cannot resolve, so following it would break every spawn.
    const user = resolveShell("win32", { SHELL: "/usr/bin/bash" }, "user");
    const posix = resolveShell("win32", { SHELL: "/usr/bin/bash" }, "posix-sh");

    expect(user.executable).toBe(WINDOWS_DEFAULT_SHELL);
    expect(posix.executable).toBe(WINDOWS_DEFAULT_SHELL);
  });

  it("requires verbatim arguments so cmd sees the command unmangled", () => {
    const shell = resolveShell("win32", {});

    expect(shell.spawnOptions).toEqual({ windowsVerbatimArguments: true });
  });

  it("wraps the command in the outer quote pair cmd /s strips back off", () => {
    // `cmd /s /c "…"` strips exactly the first and last quote and runs the
    // rest verbatim, so inner quotes survive untouched.
    const shell = resolveShell("win32", {});

    expect(shell.args('echo "a b"')).toEqual(["/d", "/s", "/c", '"echo "a b""']);
  });

  it("labels the invocation with cmd's flags", () => {
    expect(resolveShell("win32", {}).label).toBe("cmd.exe /d /s /c");
  });
});

describe("resolveShell — other platforms", () => {
  it("treats every non-win32 platform as POSIX", () => {
    for (const platform of ["freebsd", "openbsd", "sunos", "aix"] as const) {
      const shell = resolveShell(platform, {}, "posix-sh");
      expect(shell.executable).toBe(POSIX_DEFAULT_SHELL);
      expect(shell.args("id")).toEqual(["-c", "id"]);
    }
  });
});
