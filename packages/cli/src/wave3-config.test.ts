/**
 * Wave 3's configuration keys: `providers.anthropic.toolSearch`.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, parseConfigFile } from "./config.js";

function parse(raw: unknown, scope: "user" | "project" = "user") {
  const warnings: string[] = [];
  const parsed = parseConfigFile(raw, scope, "cfg", warnings);
  return { parsed, warnings: warnings.join("\n") };
}

describe("providers.anthropic.toolSearch", () => {
  it("reads bm25 and regex, without declaring an endpoint", () => {
    for (const toolSearch of ["bm25", "regex"] as const) {
      const { parsed, warnings } = parse({ providers: { anthropic: { toolSearch } } });
      expect(parsed.anthropicToolSearch).toBe(toolSearch);
      expect(parsed.providers).toBeUndefined();
      expect(warnings).toBe("");
    }
  });

  it("warns about and drops anything else, and merges layer-wise", () => {
    const bad = parse({ providers: { anthropic: { toolSearch: "vector" } } });
    expect(bad.parsed.anthropicToolSearch).toBeUndefined();
    expect(bad.warnings).toContain('"providers.anthropic.toolSearch" must be "bm25" or "regex"');
    const user = parse({ providers: { anthropic: { toolSearch: "regex" } } }).parsed;
    const project = parse({ model: "anthropic/claude-opus-5-5" }, "project").parsed;
    expect(mergeConfig(mergeConfig(DEFAULT_CONFIG, user), project).anthropicToolSearch).toBe(
      "regex",
    );
  });
});
