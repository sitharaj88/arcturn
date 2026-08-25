/**
 * The mode chip's words and the empty state's capability line, driven as
 * functions.
 *
 * `PERMISSION_SOURCE` is the text the webview runs, compiled here so these
 * tests exercise the shipped bytes. The two rules under test are the two RFC
 * 0005 §3 refusals that reach the panel: a mode chip never claims a mode the
 * engine did not confirm, and no capability is implied by an affordance — the
 * capability line names `fetch` only when `permissionState.tools` holds it.
 */

import { describe, expect, it } from "vitest";
import { PERMISSION_SOURCE } from "./webview-permission.js";

interface ModeRow {
  id: string;
  label: string;
  grants: string;
}

const api = new Function(
  `${PERMISSION_SOURCE}\nreturn { PERMISSION_MODES, modeChipLabel, modeSummary, capabilityLine };`,
)() as {
  PERMISSION_MODES: ModeRow[];
  modeChipLabel: (mode: string | undefined) => string;
  modeSummary: (mode: string | undefined) => string;
  capabilityLine: (tools: string[]) => string;
};

describe("PERMISSION_MODES", () => {
  it("offers exactly the four modes the engine accepts", () => {
    expect(api.PERMISSION_MODES.map((row) => row.id)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "yolo",
    ]);
  });

  it("says what each one grants, in one line, rather than leaving the user to find out", () => {
    for (const row of api.PERMISSION_MODES) {
      expect(row.grants.length).toBeGreaterThan(20);
      expect(row.grants).not.toContain("\n");
    }
  });

  it("says a deny rule still wins, so yolo does not read as a promise the engine will not keep", () => {
    const yolo = api.PERMISSION_MODES.find((row) => row.id === "yolo");
    expect(yolo?.grants).toMatch(/deny/i);
  });
});

describe("modeChipLabel", () => {
  it("names the mode in force", () => {
    expect(api.modeChipLabel("plan")).toBe("Plan");
    expect(api.modeChipLabel("acceptEdits")).toBe("Accept edits");
  });

  it("says it does not know rather than picking a mode for an engine that never said", () => {
    expect(api.modeChipLabel(undefined)).toBe("Permissions");
    expect(api.modeChipLabel("")).toBe("Permissions");
  });

  it("quotes a mode it has never heard of rather than falling back to a safe-looking lie", () => {
    expect(api.modeChipLabel("somethingNew")).toBe("somethingNew");
  });
});

describe("modeSummary", () => {
  it("is the same sentence the row shows", () => {
    expect(api.modeSummary("plan")).toBe(
      api.PERMISSION_MODES.find((row) => row.id === "plan")?.grants,
    );
  });

  it("is empty for a mode this panel does not know, rather than a guess about what it grants", () => {
    expect(api.modeSummary("somethingNew")).toBe("");
    expect(api.modeSummary(undefined)).toBe("");
  });
});

describe("capabilityLine", () => {
  it("says nothing at all when the engine did not report its tools", () => {
    expect(api.capabilityLine([])).toBe("");
  });

  it("names reading, editing and running from the tools actually present", () => {
    const line = api.capabilityLine(["read", "glob", "grep", "edit", "write", "bash"]);
    expect(line).toMatch(/read/i);
    expect(line).toMatch(/edit/i);
    expect(line).toMatch(/command/i);
  });

  it("says it can browse only when a browsing tool is in the set", () => {
    expect(api.capabilityLine(["read", "fetch"])).toMatch(/web/i);
    expect(api.capabilityLine(["read", "websearch"])).toMatch(/web/i);
  });

  it("says nothing about the web when neither tool is there — RFC 0005 §3", () => {
    expect(api.capabilityLine(["read", "write", "bash", "edit", "grep"])).not.toMatch(/web|brows/i);
  });

  it("still says something for an engine whose tools it does not recognise at all", () => {
    expect(api.capabilityLine(["mcp__weather__forecast", "mcp__jira__search"])).toMatch(/2 tools/);
  });

  it("reads as one line at 300px rather than a paragraph", () => {
    const line = api.capabilityLine([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "glob",
      "ls",
      "fetch",
      "websearch",
      "todo",
      "plan",
      "mcp__x__y",
    ]);
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(160);
  });
});
