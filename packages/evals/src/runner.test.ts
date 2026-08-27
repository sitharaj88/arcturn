import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@arcturn/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASK_TIMEOUT_MS, isInfraFailure, runTask } from "./runner.js";
import type { EvalTask } from "./task.js";
import { commandSucceeds, custom, fileContains } from "./task.js";
import { scriptedAgentFactory } from "./test-helpers/fake-agent.js";
import { FAKE_MODEL, textTurn, toolCallTurn } from "./test-helpers/fake-llm.js";
import { createFakeTools } from "./test-helpers/fake-tools.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(
      () => undefined,
    );
  }
});

function baseTask(overrides: Partial<EvalTask>): EvalTask {
  return {
    id: "test-task",
    description: "a test task",
    prompt: "do the thing",
    setup: async () => {},
    assertions: [],
    ...overrides,
  };
}

describe("runTask", () => {
  it("passes when the agent writes the expected file and every assertion holds", async () => {
    let capturedDir = "";
    const factory = scriptedAgentFactory([
      toolCallTurn([
        { id: "call-1", name: "write", arguments: { path: "out.txt", content: "hello" } },
      ]),
      textTurn("done"),
    ]);
    const task = baseTask({
      setup: async () => {},
      assertions: [fileContains("out.txt", "hello")],
    });

    const result = await runTask(task, {
      agentFactory: async (dir) => {
        capturedDir = dir;
        return factory(dir);
      },
      cwd: tmpdir(),
    });

    expect(result.passed).toBe(true);
    expect(result.reason).toBe("completed");
    expect(result.assertions).toEqual([{ name: 'fileContains(out.txt, "hello")', passed: true }]);
    expect(result.toolCalls).toEqual({ write: 1 });
    expect(result.turns).toBe(2);
    expect(result.finalText).toBe("done");
    expect(result.workspaceDir).toBeUndefined();
    // The workspace must be gone on success.
    expect(existsSync(capturedDir)).toBe(false);
  });

  it("fails and keeps the workspace when an assertion does not hold", async () => {
    const factory = scriptedAgentFactory([textTurn("I did nothing")]);
    const task = baseTask({ assertions: [fileContains("out.txt", "hello")] });

    const result = await runTask(task, { agentFactory: factory, cwd: tmpdir() });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe("completed");
    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.workspaceDir).toBeDefined();
    if (result.workspaceDir) {
      cleanupDirs.push(result.workspaceDir);
      expect(existsSync(result.workspaceDir)).toBe(true);
    }
  });

  it("counts tool calls by name across multiple calls and turns", async () => {
    const factory = scriptedAgentFactory([
      toolCallTurn([
        { id: "c1", name: "write", arguments: { path: "a.txt", content: "a" } },
        { id: "c2", name: "write", arguments: { path: "b.txt", content: "b" } },
      ]),
      toolCallTurn([{ id: "c3", name: "read", arguments: { path: "a.txt" } }]),
      textTurn("done"),
    ]);
    const task = baseTask({ assertions: [] });

    const result = await runTask(task, { agentFactory: factory, cwd: tmpdir() });

    expect(result.toolCalls).toEqual({ write: 2, read: 1 });
    expect(result.turns).toBe(3);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("sums usage and cost across turns", async () => {
    const usageA = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    };
    const usageB = {
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.005,
    };
    // A text-only turn ends the run (endTurn), so a tool call is scripted
    // first to force a second turn and exercise the summation.
    const factory = scriptedAgentFactory([
      toolCallTurn([{ id: "c1", name: "read", arguments: { path: "x" } }], undefined, usageA),
      textTurn("done", usageB),
    ]);

    const task = baseTask({ assertions: [] });
    const result = await runTask(task, { agentFactory: factory, cwd: tmpdir() });

    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.costUsd).toBeCloseTo(0.015);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("treats a timed-out run as reason 'timeout', not 'completed'", async () => {
    // A hand-rolled LLM whose stream never resolves until the abort signal fires.
    const hangingLlm = {
      async *stream(request: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "error" as const,
          error: { kind: "aborted" as const, message: "Aborted" },
          message: {
            role: "assistant" as const,
            content: [],
            model: FAKE_MODEL.model,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            stopReason: "aborted" as const,
            timestamp: Date.now(),
          },
        };
      },
      async complete() {
        throw new Error("not used");
      },
    };

    const task = baseTask({ assertions: [], timeoutMs: 50 });
    const result = await runTask(task, {
      agentFactory: (cwd) => ({
        agent: new Agent({
          llm: hangingLlm,
          model: FAKE_MODEL,
          systemPrompt: "test",
          tools: createFakeTools(),
          cwd,
          permissions: { mode: "yolo" },
        }),
      }),
      cwd: tmpdir(),
    });

    expect(result.reason).toBe("timeout");
    expect(result.passed).toBe(false);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  }, 10_000);

  it("uses the default timeout when the task specifies none", () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("reports reason 'error' and skips assertions when setup throws", async () => {
    const task = baseTask({
      setup: () => {
        throw new Error("fixture is broken");
      },
      assertions: [fileContains("never.txt", "x")],
    });

    const result = await runTask(task, {
      agentFactory: scriptedAgentFactory([textTurn("n/a")]),
      cwd: tmpdir(),
    });

    expect(result.reason).toBe("error");
    expect(result.errorMessage).toMatch(/fixture is broken/);
    expect(result.assertions).toEqual([]);
    expect(result.passed).toBe(false);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("reports reason 'error' when the agent factory throws", async () => {
    const task = baseTask({ assertions: [] });
    const result = await runTask(task, {
      agentFactory: () => {
        throw new Error("could not build agent");
      },
      cwd: tmpdir(),
    });

    expect(result.reason).toBe("error");
    expect(result.errorMessage).toMatch(/could not build agent/);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("catches an assertion that throws instead of failing the whole run", async () => {
    const task = baseTask({
      assertions: [
        custom("boom", () => {
          throw new Error("assertion bug");
        }),
      ],
    });
    const result = await runTask(task, {
      agentFactory: scriptedAgentFactory([textTurn("done")]),
      cwd: tmpdir(),
    });

    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.assertions[0]?.message).toMatch(/assertion bug/);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("always calls dispose, even when the run fails", async () => {
    const dispose = vi.fn(async () => {});
    const task = baseTask({ assertions: [fileContains("missing.txt", "x")] });
    const result = await runTask(task, {
      agentFactory: (cwd) => {
        const factory = scriptedAgentFactory([textTurn("done")]);
        const created = factory(cwd);
        return { agent: created.agent, dispose };
      },
      cwd: tmpdir(),
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("materializes the fixture via setup() before grading", async () => {
    const task = baseTask({
      setup: async (dir) => {
        await writeFile(join(dir, "seed.txt"), "seeded", "utf8");
      },
      assertions: [fileContains("seed.txt", "seeded")],
    });
    const result = await runTask(task, {
      agentFactory: scriptedAgentFactory([textTurn("noop")]),
      cwd: tmpdir(),
    });

    expect(result.assertions[0]?.passed).toBe(true);
    if (result.workspaceDir) cleanupDirs.push(result.workspaceDir);
  });

  it("creates an isolated workspace per run under the given base directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "arcturn-evals-runner-base-"));
    cleanupDirs.push(base);
    const seen: string[] = [];
    const task = baseTask({
      assertions: [
        custom("records the dir", (dir) => {
          seen.push(dir);
          return true;
        }),
      ],
    });

    await runTask(task, {
      agentFactory: scriptedAgentFactory([textTurn("done")]),
      cwd: base,
    });
    await runTask(task, {
      agentFactory: scriptedAgentFactory([textTurn("done")]),
      cwd: base,
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]?.startsWith(base)).toBe(true);
  });

  it("real commandSucceeds assertions integrate end to end against a written fixture", async () => {
    const factory = scriptedAgentFactory([
      toolCallTurn([
        {
          id: "c1",
          name: "write",
          arguments: { path: "check.sh.txt", content: "ok" },
        },
      ]),
      textTurn("done"),
    ]);
    const task = baseTask({
      assertions: [commandSucceeds("test -f check.sh.txt")],
    });
    const result = await runTask(task, { agentFactory: factory, cwd: tmpdir() });
    expect(result.passed).toBe(true);
  });
});

describe("infrastructure failures", () => {
  it("classifies a provider rate limit as infra, not a failed task", () => {
    // Regression: a 429 that exhausted retries used to be reported as
    // reason "error", which the suite counted as the agent failing the task.
    // A real GLM-5.3 run scored 1/6 that way when the true cause was the
    // provider's quota, not the model.
    expect(isInfraFailure("429 Rate limit reached for requests")).toBe(true);
    expect(isInfraFailure("Overloaded")).toBe(true);
    expect(isInfraFailure("fetch failed")).toBe(true);
    expect(isInfraFailure("ECONNRESET")).toBe(true);
    // Observed verbatim from a real GLM-5.3 run; the SDK reports a dropped
    // transport with no code, and the first pattern missed it.
    expect(isInfraFailure("Connection error.")).toBe(true);
    expect(isInfraFailure("ENOTFOUND api.example.com")).toBe(true);
  });

  it("leaves genuine agent failures alone", () => {
    expect(isInfraFailure("Reached the maximum of 20 turns.")).toBe(false);
    expect(isInfraFailure('Invalid arguments for "edit"')).toBe(false);
    expect(isInfraFailure(undefined)).toBe(false);
  });
});

describe("tool trace", () => {
  it("records what each call acted on, in order", async () => {
    // Counting tool names cannot answer any retrieval question: which paths
    // were searched, what was read, how many rounds to reach the right file.
    // The ordered trace is what makes those measurable.
    const dir = await mkdtemp(join(tmpdir(), "arcturn-trace-"));
    const task: EvalTask = {
      id: "trace-probe",
      description: "probe",
      prompt: "find it",
      setup: async (workspace) => {
        await writeFile(join(workspace, "a.txt"), "hello", "utf8");
      },
      assertions: [],
    };

    const result = await runTask(task, {
      agentFactory: scriptedAgentFactory([
        toolCallTurn([{ id: "c1", name: "read", arguments: { path: "a.txt" } }]),
        toolCallTurn([{ id: "c2", name: "write", arguments: { path: "b.txt", content: "x" } }]),
        textTurn("done"),
      ]),
      cwd: dir,
    });

    expect(result.trace.map((entry) => entry.tool)).toEqual(["read", "write"]);
    expect(result.trace.map((entry) => entry.subject)).toEqual(["a.txt", "b.txt"]);
    // Ordering is the point: a trace that cannot say "read came before write"
    // cannot measure rounds-to-first-hit.
    expect(result.trace[0]!.at).toBeLessThanOrEqual(result.trace[1]!.at);
  });
});
