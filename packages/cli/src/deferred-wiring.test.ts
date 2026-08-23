/**
 * Adversarial review repros for the deferred-tool runtime wiring.
 * Regression tests from the wave-3 adversarial review (confirmed reproes, now fixed).
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ArcturnConfig, DEFAULT_CONFIG } from "./config.js";
import { buildRuntime } from "./runtime.js";
import { fakeLLM, type ScriptedTurn } from "./test-helpers/fake-llm.js";
import type { Scratch } from "./test-helpers/scratch.js";
import { makeScratch } from "./test-helpers/scratch.js";

function configWith(overrides: Partial<ArcturnConfig>): ArcturnConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: [],
    hooks: { preToolUse: [], postToolUse: [], sessionStart: [], runEnd: [] },
    ...overrides,
  };
}

async function runtimeWith(scratch: Scratch, turns: ScriptedTurn[], config: ArcturnConfig) {
  const llm = fakeLLM(turns);
  const runtime = await buildRuntime({
    cwd: scratch.cwd,
    home: scratch.home,
    env: scratch.env,
    llm,
    extensions: false,
    skipRepoLookup: true,
    config,
  });
  return { runtime, llm };
}

const toolNames = (req: { tools?: { name: string }[] }): string[] =>
  (req.tools ?? []).map((t) => t.name);

describe("deferred toolset is shared across every agent the runtime builds", () => {
  it("one session's tool_search activation must not appear in another session's tool list", async () => {
    const scratch = await makeScratch();
    const { runtime, llm } = await runtimeWith(
      scratch,
      [
        { toolCalls: [{ id: "c1", name: "tool_search", arguments: { select: ["fetch"] } }] },
        { text: "A done" },
        { text: "B done" },
      ],
      configWith({ deferredTools: { enabled: true } }),
    );

    const agentA = runtime.buildSessionAgent({ sessionId: "sess-a" });
    const agentB = runtime.buildSessionAgent({ sessionId: "sess-b" });

    await agentA.prompt("do A");
    await agentB.prompt("do B");

    // sanity: deferral is actually on for A's first turn
    expect(toolNames(llm.requests[0]!)).toContain("tool_search");
    expect(toolNames(llm.requests[0]!)).not.toContain("fetch");
    // A activated fetch, so A's second turn legitimately sees it
    expect(toolNames(llm.requests[1]!)).toContain("fetch");

    // B never searched for anything. Its tool list must still be the core set.
    expect(toolNames(llm.requests[2]!)).not.toContain("fetch");

    await runtime.dispose();
  });
});

describe("deferred activation is per-process by design", () => {
  // Persistence of activations onto session state entries was considered and
  // deliberately NOT shipped: the `activatedTools` session field was removed
  // rather than left half-wired (see the adversarial-review notes). After a
  // --resume the model re-discovers tools with one tool_search round trip;
  // within a process, activation must stick across turns.
  it("keeps an activation for the rest of the run within one process", async () => {
    const scratch = await makeScratch();
    const { runtime, llm } = await runtimeWith(
      scratch,
      [
        { toolCalls: [{ id: "c1", name: "tool_search", arguments: { select: ["fetch"] } }] },
        { text: "done" },
        { text: "again" },
      ],
      configWith({ deferredTools: { enabled: true } }),
    );

    await runtime.agent.prompt("find me a fetch tool");
    await runtime.agent.prompt("and again");
    // Every request after the activation carries the full fetch schema.
    expect(toolNames(llm.requests.at(-1)!)).toContain("fetch");

    await runtime.dispose();
  });
});

describe("session agents keep their own checkpoint store under deferral", () => {
  it("CONTROL: with deferral OFF the same scenario is correct", async () => {
    const scratch = await makeScratch();
    const { runtime } = await runtimeWith(
      scratch,
      [
        {
          toolCalls: [
            { id: "w1", name: "write", arguments: { path: "note.txt", content: "hello" } },
          ],
        },
        { text: "A done" },
      ],
      configWith({ permissions: [{ tool: "write", action: "allow", scope: "session" }] }),
    );
    const agentA = runtime.buildSessionAgent({ sessionId: "sess-a" });
    runtime.buildSessionAgent({ sessionId: "sess-b" });
    await agentA.prompt("write the note");
    const { readdir } = await import("node:fs/promises");
    const a = await readdir(join(scratch.home, "checkpoints", "sess-a")).catch(
      () => [] as string[],
    );
    const b = await readdir(join(scratch.home, "checkpoints", "sess-b")).catch(
      () => [] as string[],
    );
    expect({ sessA: a.length > 0, sessB: b.length > 0 }).toEqual({ sessA: true, sessB: false });
    await runtime.dispose();
  });

  it("a write by session A checkpoints into session A's store, not the last-built agent's", async () => {
    const scratch = await makeScratch();
    const { runtime } = await runtimeWith(
      scratch,
      [
        {
          toolCalls: [
            { id: "w1", name: "write", arguments: { path: "note.txt", content: "hello" } },
          ],
        },
        { text: "A done" },
      ],
      configWith({
        deferredTools: { enabled: true },
        permissions: [{ tool: "write", action: "allow", scope: "session" }],
      }),
    );

    const agentA = runtime.buildSessionAgent({ sessionId: "sess-a" });
    // A second session is built afterwards, exactly as `arcturn serve` does.
    runtime.buildSessionAgent({ sessionId: "sess-b" });

    await agentA.prompt("write the note");

    const { readdir } = await import("node:fs/promises");
    const a = await readdir(join(scratch.home, "checkpoints", "sess-a")).catch(
      () => [] as string[],
    );
    const b = await readdir(join(scratch.home, "checkpoints", "sess-b")).catch(
      () => [] as string[],
    );
    // Session A wrote the file, so only session A's checkpoint store may hold
    // a snapshot of it.
    expect({ sessA: a.length > 0, sessB: b.length > 0 }).toEqual({ sessA: true, sessB: false });

    await runtime.dispose();
  });
});
