/**
 * Adversarial review repro — deferred-tools ↔ runtime seam.
 *
 * Regression tests from the wave-3 adversarial review: each `it` states the
 * behaviour a correct implementation must have. They failed against the
 * pre-fix tree (see docs/integration-notes) and must stay green.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ArcturnConfig, DEFAULT_CONFIG } from "./config.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

function config(overrides: Partial<ArcturnConfig>): ArcturnConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as ArcturnConfig;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("DEFERRED TOOLS: a second session agent hijacks the live agent's tool list", () => {
  it("the main agent's write must be checkpointed into its OWN session store", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "f.txt");
    const runtime = await buildTestRuntime(
      scratch,
      [
        { toolCalls: [{ id: "c1", name: "write", arguments: { path: target, content: "hi" } }] },
        { text: "done" },
      ],
      { config: config({ deferredTools: { enabled: true } }) },
    );
    runtime.setPermissionRequester(async (r) => ({ requestId: r.id, behavior: "allow" }));

    const sidA = runtime.agent.sessionId;
    // A concurrent served/ACP session (or a scout) built off the SAME runtime.
    runtime.buildSessionAgent({ sessionId: "session-b" });

    await runtime.agent.prompt("go");

    expect(await exists(target)).toBe(true);
    // The file snapshot belongs in the MAIN session's store, not session B's.
    const manifestA = join(scratch.home, "checkpoints", sidA, "manifest.jsonl");
    const manifestB = join(scratch.home, "checkpoints", "session-b", "manifest.jsonl");
    const recordsA = (await exists(manifestA)) ? await readFile(manifestA, "utf8") : "";
    const recordsB = (await exists(manifestB)) ? await readFile(manifestB, "utf8") : "";
    expect(recordsA).toContain("f.txt");
    // Session B never ran a tool; nothing of session A's may land in its store.
    expect(recordsB).not.toContain("f.txt");
  });

  it("control: with deferral off the snapshot stays in the main session's store", async () => {
    const scratch = await makeScratch();
    const target = join(scratch.cwd, "f.txt");
    const runtime = await buildTestRuntime(scratch, [
      { toolCalls: [{ id: "c1", name: "write", arguments: { path: target, content: "hi" } }] },
      { text: "done" },
    ]);
    runtime.setPermissionRequester(async (r) => ({ requestId: r.id, behavior: "allow" }));
    const sidA = runtime.agent.sessionId;
    runtime.buildSessionAgent({ sessionId: "session-b" });
    await runtime.agent.prompt("go");
    const manifestA = join(scratch.home, "checkpoints", sidA, "manifest.jsonl");
    const manifestB = join(scratch.home, "checkpoints", "session-b", "manifest.jsonl");
    expect(await readFile(manifestA, "utf8")).toContain("f.txt");
    expect((await exists(manifestB)) ? await readFile(manifestB, "utf8") : "").not.toContain(
      "f.txt",
    );
  });
});
