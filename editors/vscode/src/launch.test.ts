import { describe, expect, it } from "vitest";
import { buildLaunchCommand, launchArgs } from "./launch.js";

describe("launchArgs", () => {
  it("passes the configured model through to the engine's own flag", () => {
    expect(launchArgs("anthropic/claude-opus-4")).toEqual(["--model", "anthropic/claude-opus-4"]);
  });

  it("passes nothing when no model is configured, so the engine picks its default", () => {
    expect(launchArgs(undefined)).toEqual([]);
    expect(launchArgs("")).toEqual([]);
    expect(launchArgs("   ")).toEqual([]);
  });
});

describe("buildLaunchCommand", () => {
  it("leaves a plain command untouched", () => {
    expect(buildLaunchCommand("arcturn", [], "darwin")).toBe("arcturn");
  });

  it("single-quotes a posix path with spaces", () => {
    expect(buildLaunchCommand("/opt/my tools/arcturn", ["--model", "x"], "linux")).toBe(
      "'/opt/my tools/arcturn' --model x",
    );
  });

  it("escapes an embedded single quote the posix way", () => {
    expect(buildLaunchCommand("/opt/o'brien/arcturn", [], "darwin")).toBe(
      "'/opt/o'\\''brien/arcturn'",
    );
  });

  it("uses the PowerShell call operator for a quoted win32 path", () => {
    // VS Code's default Windows profile is PowerShell, where a bare quoted
    // string is an expression that prints the path instead of running it.
    expect(buildLaunchCommand("C:\\Program Files\\nodejs\\arcturn.cmd", [], "win32")).toBe(
      '& "C:\\Program Files\\nodejs\\arcturn.cmd"',
    );
  });

  it("quotes win32 arguments that contain spaces", () => {
    expect(buildLaunchCommand("arcturn.cmd", ["--model", "some model"], "win32")).toBe(
      'arcturn.cmd --model "some model"',
    );
  });
});
