/**
 * Repro: deferred-tools activation is not restored across a process restart.
 *
 * docs/integration-notes/INTEGRATION-deferred-tools.md §4 "Session
 * persistence" specifies: persist `DeferredToolset.snapshot()` onto a
 * session `state` entry's `activatedTools` field (which
 * packages/types/src/session.ts does carry), and on resume, restore it via
 * `deferred.restore({ activated })`.
 *
 * Nothing writes that field (agent.ts's `#appendEntry` "state" variant has no
 * `activatedTools` parameter) and nothing reads it back on `Agent.resume`
 * (which only rehydrates `todos`/`plan`/`model`). `ArcturnRuntime#toolOptions`
 * only restores from the in-memory `this.#deferredToolset` snapshot, which
 * does not survive a fresh `buildRuntime()` call (a real `--resume` in a new
 * process). This test builds a runtime, activates `fetch` via `tool_search`,
 * then resumes the same session id in a brand-new runtime instance built
 * against the same `$ARCTURN_HOME` (simulating a new process) and shows the
 * model has to re-discover and re-activate `fetch` instead of it already
 * being active on the first post-resume request.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { buildRuntime } from "./runtime.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

describe("deferred-tools session persistence (review)", () => {
  it("starts from the core set after resume: activation is per-process by design", async () => {
    const scratch = await makeScratch();
    const config = { ...DEFAULT_CONFIG, deferredTools: { enabled: true } };

    const llm1 = fakeLLM([
      {
        text: "activating fetch",
        toolCalls: [{ id: "call-1", name: "tool_search", arguments: { select: ["fetch"] } }],
      },
      { text: "done" },
    ]);
    const runtime1 = await buildTestRuntime(scratch, [], { config, llm: llm1 });
    const sessionId = runtime1.agent.sessionId;

    await runtime1.agent.prompt("please activate fetch");

    // Within the same process, activation sticks: the very next request
    // already carries `fetch`'s full schema.
    const lastReqSameProcess = llm1.requests.at(-1)!;
    expect(lastReqSameProcess.tools?.some((t) => t.name === "fetch")).toBe(true);

    await runtime1.dispose();

    // Simulate a brand-new process resuming the same session: a fresh
    // ArcturnRuntime built from scratch against the same $ARCTURN_HOME /
    // session store — exactly what `arcturn --resume <id>` does.
    const llm2 = fakeLLM([
      {
        text: "activating fetch again",
        toolCalls: [{ id: "call-2", name: "tool_search", arguments: { select: ["fetch"] } }],
      },
      { text: "done" },
    ]);
    const runtime2 = await buildRuntime({
      cwd: scratch.cwd,
      home: scratch.home,
      env: scratch.env,
      llm: llm2,
      extensions: false,
      skipRepoLookup: true,
      resume: sessionId,
      config,
    });

    await runtime2.agent.prompt("what tools do I have now?");
    const firstReqAfterResume = llm2.requests[0]!;

    // DOCUMENTED BEHAVIOUR: activation is per-process by design. Persisting
    // activations onto session entries was considered during the adversarial
    // review and deliberately not shipped (the half-wired `activatedTools`
    // session field was removed instead), so after a resume the model pays
    // one tool_search round trip to re-discover — the fresh request starts
    // from the core set, search tool included.
    expect(firstReqAfterResume.tools?.some((t) => t.name === "fetch")).toBe(false);
    expect(firstReqAfterResume.tools?.some((t) => t.name === "tool_search")).toBe(true);

    await runtime2.dispose();
  });
});
