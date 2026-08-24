import { describe, expect, it } from "vitest";
import {
  cliExecutableNames,
  compareVersions,
  decideCli,
  describeMissingCli,
  describeUpgrade,
  findCliOnPath,
  installCommand,
  isOutdated,
  MIN_ENGINE_VERSION,
  normalizeCliPathSetting,
  parseVersionOutput,
} from "./cli-resolve.js";

describe("cliExecutableNames", () => {
  it("prefers the shim npm actually writes on win32", () => {
    // `npm install -g arcturn` on Windows writes arcturn.cmd (and arcturn.ps1)
    // next to a extension-less shell script. Probing the bare name first finds
    // the sh script, which cmd.exe and PowerShell cannot execute.
    expect(cliExecutableNames("win32")).toEqual(["arcturn.cmd", "arcturn.exe", "arcturn.bat"]);
    expect(cliExecutableNames("darwin")).toEqual(["arcturn"]);
    expect(cliExecutableNames("linux")).toEqual(["arcturn"]);
  });
});

describe("findCliOnPath", () => {
  it("walks PATH in order and returns the first executable hit", () => {
    const found = findCliOnPath({
      pathVar: "/usr/bin:/opt/homebrew/bin:/usr/local/bin",
      platform: "darwin",
      isExecutable: (candidate) => candidate === "/opt/homebrew/bin/arcturn",
    });
    expect(found).toBe("/opt/homebrew/bin/arcturn");
  });

  it("splits on ; and strips quoted entries on win32", () => {
    const seen: string[] = [];
    const found = findCliOnPath({
      pathVar: 'C:\\Windows;"C:\\Program Files\\nodejs";',
      platform: "win32",
      isExecutable: (candidate) => {
        seen.push(candidate);
        return candidate === "C:\\Program Files\\nodejs\\arcturn.cmd";
      },
    });
    expect(found).toBe("C:\\Program Files\\nodejs\\arcturn.cmd");
    expect(seen).toContain("C:\\Windows\\arcturn.cmd");
    expect(seen.every((entry) => entry !== "")).toBe(true);
  });

  it("returns undefined when PATH is unset or holds nothing runnable", () => {
    expect(findCliOnPath({ pathVar: undefined, platform: "linux", isExecutable: () => true })).toBe(
      undefined,
    );
    expect(
      findCliOnPath({ pathVar: "/usr/bin", platform: "linux", isExecutable: () => false }),
    ).toBe(undefined);
  });
});

describe("normalizeCliPathSetting", () => {
  it("treats blank and whitespace-only settings as unset", () => {
    expect(normalizeCliPathSetting("", "/Users/me", "darwin")).toBe(undefined);
    expect(normalizeCliPathSetting("   ", "/Users/me", "darwin")).toBe(undefined);
    expect(normalizeCliPathSetting(undefined, "/Users/me", "darwin")).toBe(undefined);
  });

  it("expands a leading ~ against the home directory", () => {
    expect(normalizeCliPathSetting("~/bin/arcturn", "/Users/me", "darwin")).toBe(
      "/Users/me/bin/arcturn",
    );
    expect(normalizeCliPathSetting("~", "/Users/me", "darwin")).toBe("/Users/me");
    // A file that merely starts with a tilde is not a home reference.
    expect(normalizeCliPathSetting("~weird/bin", "/Users/me", "darwin")).toBe("~weird/bin");
  });

  it("keeps a win32 path intact and trims stray spaces", () => {
    expect(normalizeCliPathSetting("  C:\\tools\\arcturn.cmd  ", "C:\\Users\\me", "win32")).toBe(
      "C:\\tools\\arcturn.cmd",
    );
  });
});

describe("parseVersionOutput", () => {
  it("reads the bare version arcturn prints today", () => {
    expect(parseVersionOutput("0.2.0\n")).toBe("0.2.0");
  });

  it("survives a prefixed or decorated line", () => {
    expect(parseVersionOutput("arcturn 1.4.2\n")).toBe("1.4.2");
    expect(parseVersionOutput("arcturn/0.9.0 darwin-arm64\n")).toBe("0.9.0");
    expect(parseVersionOutput("0.3.0-rc.1\n")).toBe("0.3.0-rc.1");
  });

  it("returns undefined rather than guessing when nothing looks like a version", () => {
    expect(parseVersionOutput("command not found\n")).toBe(undefined);
    expect(parseVersionOutput("")).toBe(undefined);
  });
});

describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
  });

  it("ranks a prerelease below its own release", () => {
    expect(compareVersions("0.3.0-rc.1", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0", "0.3.0-rc.1")).toBeGreaterThan(0);
  });
});

describe("isOutdated", () => {
  it("says nothing when the version could not be read", () => {
    // An unknown version is not evidence of an old one. Nagging here would
    // punish anyone whose shim prints something we cannot parse.
    expect(isOutdated(undefined, "0.2.0")).toBe(false);
  });

  it("flags only versions below the minimum", () => {
    expect(isOutdated("0.1.9", "0.2.0")).toBe(true);
    expect(isOutdated("0.2.0", "0.2.0")).toBe(false);
    expect(isOutdated("1.0.0", "0.2.0")).toBe(false);
  });

  it("ships a minimum that is a real version string", () => {
    expect(parseVersionOutput(MIN_ENGINE_VERSION)).toBe(MIN_ENGINE_VERSION);
  });
});

describe("installCommand", () => {
  it("installs the npm package the CLI actually publishes", () => {
    expect(installCommand("install")).toBe("npm install -g arcturn");
  });

  it("pins @latest for an upgrade so npm does not consider the install satisfied", () => {
    expect(installCommand("upgrade")).toBe("npm install -g arcturn@latest");
  });
});

describe("decideCli", () => {
  it("prefers the configured path over anything on PATH", () => {
    const decision = decideCli({
      configured: "/opt/custom/arcturn",
      pathVar: "/usr/bin",
      platform: "darwin",
      isExecutable: (candidate) =>
        candidate === "/opt/custom/arcturn" || candidate === "/usr/bin/arcturn",
    });
    expect(decision).toEqual({
      kind: "found",
      cli: { command: "/opt/custom/arcturn", source: "setting" },
    });
  });

  it("reports a broken setting instead of quietly falling back to PATH", () => {
    // Silently using a different binary than the one the user named is how you
    // get a bug report that says "I set cliPath and it ignored me".
    const decision = decideCli({
      configured: "/opt/typo/arcturn",
      pathVar: "/usr/bin",
      platform: "darwin",
      isExecutable: (candidate) => candidate === "/usr/bin/arcturn",
    });
    expect(decision).toEqual({
      kind: "missing",
      reason: "setting-not-executable",
      configured: "/opt/typo/arcturn",
    });
  });

  it("falls back to PATH when no path is configured", () => {
    const decision = decideCli({
      configured: undefined,
      pathVar: "/usr/bin:/usr/local/bin",
      platform: "linux",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
    });
    expect(decision).toEqual({
      kind: "found",
      cli: { command: "/usr/local/bin/arcturn", source: "path" },
    });
  });

  it("reports a plain miss when nothing is configured and PATH has nothing", () => {
    expect(
      decideCli({
        configured: undefined,
        pathVar: "/usr/bin",
        platform: "linux",
        isExecutable: () => false,
      }),
    ).toEqual({ kind: "missing", reason: "not-on-path" });
  });
});

describe("missing and upgrade messages", () => {
  it("names the configured path when that is what is broken", () => {
    const message = describeMissingCli({
      kind: "missing",
      reason: "setting-not-executable",
      configured: "/opt/typo/arcturn",
    });
    expect(message).toContain("/opt/typo/arcturn");
    expect(message).toContain("arcturn.cliPath");
  });

  it("offers the install story when the CLI is simply absent", () => {
    const message = describeMissingCli({ kind: "missing", reason: "not-on-path" });
    expect(message).toContain("arcturn");
    expect(message).not.toContain("undefined");
  });

  it("states both versions in the upgrade prompt, so the nag is checkable", () => {
    const message = describeUpgrade("0.1.0", "0.2.0");
    expect(message).toContain("0.1.0");
    expect(message).toContain("0.2.0");
  });
});
