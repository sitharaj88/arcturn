import { describe, expect, it } from "vitest";
import type { ServeStartFailure } from "../serve/supervisor.js";
import {
  CONNECTION_ACTIONS,
  type ConnectionReport,
  missingCliReport,
  outageReport,
  reportText,
  startFailureReport,
} from "./connection-card.js";

const noKey: ServeStartFailure = {
  reason: "exited",
  code: 2,
  signal: null,
  stderr:
    "arcturn: No API key found for Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5).\n" +
    "Set ANTHROPIC_API_KEY in your environment, or pick another model with --model.",
};

function ids(report: ConnectionReport): string[] {
  return report.actions.map((action) => action.id);
}

describe("startFailureReport", () => {
  it("shows the engine's own words, unaltered and unparaphrased", () => {
    const report = startFailureReport(noKey);
    expect(report.engineOutput).toBe(noKey.stderr);
  });

  it("says the engine never started, not that it stopped", () => {
    const report = startFailureReport(noKey);
    expect(report.headline).toMatch(/could not start/i);
    expect(report.headline).not.toMatch(/stopped/i);
  });

  it("offers the log, the model setting and a retry when the engine refused to start", () => {
    expect(ids(startFailureReport(noKey))).toEqual(["showLog", "openModelSetting", "reconnect"]);
  });

  it("offers the CLI path and the installer when the binary could not be executed", () => {
    const report = startFailureReport({
      reason: "spawn",
      code: null,
      signal: null,
      stderr: "",
    });
    expect(ids(report)).toContain("openCliSetting");
    expect(ids(report)).toContain("installCli");
  });

  it("only ever offers actions from the validated list", () => {
    for (const reason of ["exited", "timeout", "spawn", "address"] as const) {
      const report = startFailureReport({ reason, code: 1, signal: null, stderr: "" });
      for (const action of report.actions) {
        expect(CONNECTION_ACTIONS).toContain(action.id);
        expect(action.label.length).toBeGreaterThan(0);
      }
      expect(ids(report).at(-1)).toBe("reconnect");
    }
  });

  it("explains a silent exit itself, because there is nothing to quote", () => {
    const report = startFailureReport({ reason: "exited", code: 127, signal: null, stderr: "" });
    expect(report.engineOutput).toBe("");
    expect(report.headline).toContain("127");
  });

  it("names the signal when the child was killed rather than exiting", () => {
    const report = startFailureReport({
      reason: "exited",
      code: null,
      signal: "SIGKILL",
      stderr: "",
    });
    expect(report.headline).toContain("SIGKILL");
  });
});

describe("missingCliReport and outageReport", () => {
  it("points a missing CLI at the installer and the path setting", () => {
    const report = missingCliReport("The arcturn CLI could not be found.");
    expect(report.headline).toContain("could not be found");
    expect(ids(report)).toContain("installCli");
    expect(ids(report)).toContain("openCliSetting");
  });

  it("treats an engine that died mid-session as an outage, with its last words", () => {
    const report = outageReport("arcturn serve: out of memory");
    expect(report.headline).toMatch(/stopped/i);
    expect(report.engineOutput).toBe("arcturn serve: out of memory");
    expect(ids(report)).toEqual(["showLog", "reconnect"]);
  });
});

describe("reportText", () => {
  it("is the headline plus the engine's words, which is what the log and a toast carry", () => {
    const text = reportText(startFailureReport(noKey));
    expect(text).toContain("could not start");
    expect(text).toContain("No API key found");
    expect(text).toContain("Set ANTHROPIC_API_KEY");
  });

  it("is just the headline when the engine said nothing", () => {
    const report = startFailureReport({ reason: "timeout", code: null, signal: null, stderr: "" });
    expect(reportText(report)).toBe(report.headline);
  });
});
