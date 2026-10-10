/**
 * Deferred-tools activation across a process restart.
 *
 * A resumed session must send the tool set it ended with. Anything else is a
 * prefix edit at the very top of the conversation: the prompt cache starts
 * over, and on the preserved-thinking models (Fable 5.1, Opus 5.5, Sonnet
 * 5.5, Haiku 5.5) every replayed thinking block was bound to the old set.
 *
 * Nothing new is persisted for it. The activations are already in the
 * transcript — arcturn's own `tool_search` results carry `details.activated`,
 * and the provider's native search leaves `tool_search_tool_result` blocks —
 * so `Agent.resume` replays them into the fresh toolset
 * (`DeferredToolset.replay`). This used to be "per-process by design", with
 * the model paying a `tool_search` round trip after every resume.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { buildRuntime } from "./runtime.js";
import { fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

describe("deferred-tools session persistence", () => {
  it("resumes with the activations the session ended with, on arcturn's own path", async () => {
    const scratch = await makeScratch();
    // Claude Sonnet 4 predates native tool search, so activation grows the set.
    const config = {
      ...DEFAULT_CONFIG,
      model: "anthropic/claude-sonnet-4",
      deferredTools: { enabled: true },
    };

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

    // A brand-new process resuming the same session: a fresh ArcturnRuntime
    // built from scratch against the same $ARCTURN_HOME / session store —
    // exactly what `arcturn --resume <id>` does.
    const llm2 = fakeLLM([{ text: "done" }]);
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

    // The same set the session ended with — `fetch` included, search tool
    // and its index byte-identical — with no re-discovery round trip.
    expect(firstReqAfterResume.tools?.map((t) => t.name)).toEqual(
      lastReqSameProcess.tools?.map((t) => t.name),
    );
    expect(JSON.stringify(firstReqAfterResume.tools)).toBe(
      JSON.stringify(lastReqSameProcess.tools),
    );

    await runtime2.dispose();
  });

  it("sends the identical tool set before and after a resume on the native path", async () => {
    const scratch = await makeScratch();
    // The default model, Claude Sonnet 5.5 on first-party Anthropic.
    const config = { ...DEFAULT_CONFIG, deferredTools: { enabled: true } };
    const llm1 = fakeLLM([{ text: "hello" }]);
    const runtime1 = await buildTestRuntime(scratch, [], { config, llm: llm1 });
    const sessionId = runtime1.agent.sessionId;
    await runtime1.agent.prompt("hi");
    const before = llm1.requests.at(-1)!;
    await runtime1.dispose();

    const llm2 = fakeLLM([{ text: "again" }]);
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
    await runtime2.agent.prompt("still there?");
    const after = llm2.requests[0]!;

    expect(before.tools?.some((t) => t.deferLoading === true)).toBe(true);
    expect(before.tools?.some((t) => t.name === "tool_search")).toBe(false);
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));

    await runtime2.dispose();
  });
});
