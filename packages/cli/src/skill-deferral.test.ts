/**
 * Adversarial review repro: the skill tool under deferred tool disclosure.
 *
 * INTEGRATION-skill-tool.md §5 is explicit — if a deferred-tools mechanism is
 * added, `skill` belongs in the "always resolvable, never deferred" set,
 * because its description IS the index a deferred system would otherwise have
 * to rebuild. Hiding it behind tool_search is "a tool to discover the tool
 * that discovers skills".
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ArcturnConfig, DEFAULT_CONFIG } from "./config.js";
import { buildRuntime } from "./runtime.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { makeScratch, writeFileAt } from "./test-helpers/scratch.js";

function configWith(overrides: Partial<ArcturnConfig>): ArcturnConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: [],
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
    ...overrides,
  };
}

describe("skill tool under deferred disclosure", () => {
  it("stays active so the model can see the skill index without a round trip", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.home, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app\n---\n\nRun the deploy.\n",
    );
    const llm = fakeLLM([{ text: "ok" }]);
    const runtime = await buildRuntime({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      llm,
      extensions: false,
      skipRepoLookup: true,
      // arcturn's own deferral path; the default model takes the native one.
      config: configWith({ model: "anthropic/claude-sonnet-4", deferredTools: { enabled: true } }),
    });

    await runtime.agent.prompt("hello");
    const names = (llm.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).toContain("tool_search"); // sanity: deferral is on
    expect(names).toContain("skill");

    await runtime.dispose();
  });

  it("stays loaded on the native tool-search path too, while the rest are deferred", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.home, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app\n---\n\nRun the deploy.\n",
    );
    const llm = fakeLLM([{ text: "ok" }]);
    const runtime = await buildRuntime({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      llm,
      extensions: false,
      skipRepoLookup: true,
      // The default model, Claude Sonnet 5.5 on first-party Anthropic.
      config: configWith({ deferredTools: { enabled: true } }),
    });

    await runtime.agent.prompt("hello");
    const tools = llm.requests[0]?.tools ?? [];
    expect(tools.map((t) => t.name)).not.toContain("tool_search");
    expect(tools.find((t) => t.name === "skill")?.deferLoading).toBeUndefined();
    expect(tools.find((t) => t.name === "read")?.deferLoading).toBeUndefined();
    expect(tools.some((t) => t.deferLoading === true)).toBe(true);

    await runtime.dispose();
  });
});
