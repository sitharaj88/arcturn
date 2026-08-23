import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runSuite } from "./suite.js";
import type { EvalTask } from "./task.js";
import { fileContains } from "./task.js";
import { scriptedAgentFactory } from "./test-helpers/fake-agent.js";
import { textTurn, toolCallTurn } from "./test-helpers/fake-llm.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function checksHello(id: string): EvalTask {
  return {
    id,
    description: "writes and checks a file",
    prompt: "write out.txt containing hello",
    setup: async () => {},
    assertions: [fileContains("out.txt", "hello")],
  };
}

/**
 * The runner names each task's isolated workspace after the task id (see
 * `sanitizeForPath` in runner.ts), so a shared agent factory can still give
 * different tasks different scripted behavior by branching on `cwd`.
 */
function writesHelloOnlyFor(taskIds: string[]) {
  return (cwd: string) => {
    const shouldWrite = taskIds.some((id) => cwd.includes(id));
    const writeHello = toolCallTurn([
      { id: "c1", name: "write", arguments: { path: "out.txt", content: "hello" } },
    ]);
    return scriptedAgentFactory(shouldWrite ? [writeHello] : [textTurn("did nothing")])(cwd);
  };
}

describe("runSuite", () => {
  it("aggregates an all-passing suite", async () => {
    const tasks = [checksHello("t1"), checksHello("t2"), checksHello("t3")];
    const suite = await runSuite(tasks, {
      agentFactory: writesHelloOnlyFor(["t1", "t2", "t3"]),
      cwd: tmpdir(),
      concurrency: 2,
    });

    expect(suite.summary).toMatchObject({ total: 3, passed: 3, failed: 0, passRate: 1 });
    expect(suite.results).toHaveLength(3);
    expect(suite.results.map((r) => r.taskId)).toEqual(["t1", "t2", "t3"]);
  });

  it("reports a genuinely mixed pass rate across distinguishable tasks", async () => {
    const tasks = [checksHello("mix-a"), checksHello("mix-b"), checksHello("mix-c")];
    const suite = await runSuite(tasks, {
      // Only "mix-a" and "mix-c" actually write the file; "mix-b" does not.
      agentFactory: writesHelloOnlyFor(["mix-a", "mix-c"]),
      cwd: tmpdir(),
    });

    expect(suite.summary.total).toBe(3);
    expect(suite.summary.passed).toBe(2);
    expect(suite.summary.failed).toBe(1);
    expect(suite.summary.passRate).toBeCloseTo(2 / 3);

    const byId = new Map(suite.results.map((r) => [r.taskId, r]));
    expect(byId.get("mix-a")?.passed).toBe(true);
    expect(byId.get("mix-b")?.passed).toBe(false);
    expect(byId.get("mix-c")?.passed).toBe(true);

    for (const result of suite.results) {
      if (!result.passed && result.workspaceDir) cleanupDirs.push(result.workspaceDir);
    }
  });

  it("keeps per-task order in results even when completion order differs", async () => {
    const tasks: EvalTask[] = [
      { id: "slow", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
      { id: "fast", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
    ];
    const suite = await runSuite(tasks, {
      agentFactory: async (cwd) => {
        if (cwd.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 30));
        return scriptedAgentFactory([textTurn("done")])(cwd);
      },
      cwd: tmpdir(),
      concurrency: 2,
    });

    expect(suite.results.map((r) => r.taskId)).toEqual(["slow", "fast"]);
  });

  it("sums cost and tokens across every task", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.02,
    };
    const tasks: EvalTask[] = [
      { id: "x", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
      { id: "y", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
    ];
    const suite = await runSuite(tasks, {
      agentFactory: (cwd) => scriptedAgentFactory([textTurn("ok", usage)])(cwd),
      cwd: tmpdir(),
    });

    expect(suite.summary.totalCostUsd).toBeCloseTo(0.04);
    expect(suite.summary.totalUsage.inputTokens).toBe(20);
    expect(suite.summary.totalUsage.outputTokens).toBe(10);
  });

  it("respects the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks: EvalTask[] = Array.from({ length: 6 }, (_, i) => ({
      id: `task-${i}`,
      description: "d",
      prompt: "p",
      setup: async () => {},
      assertions: [],
    }));

    await runSuite(tasks, {
      agentFactory: async (cwd) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return scriptedAgentFactory([textTurn("done")])(cwd);
      },
      cwd: tmpdir(),
      concurrency: 2,
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("records the model label and ISO timestamps on the result", async () => {
    const tasks: EvalTask[] = [
      { id: "x", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
    ];
    const suite = await runSuite(tasks, {
      agentFactory: (cwd) => scriptedAgentFactory([textTurn("ok")])(cwd),
      cwd: tmpdir(),
      model: "test/fake-model",
    });

    expect(suite.model).toBe("test/fake-model");
    expect(Number.isNaN(new Date(suite.startedAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(suite.finishedAt).getTime())).toBe(false);
  });

  it("calls onTaskComplete once per task with a running completion count", async () => {
    const tasks: EvalTask[] = [
      { id: "x", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
      { id: "y", description: "d", prompt: "p", setup: async () => {}, assertions: [] },
    ];
    const seen: Array<[string, number, number]> = [];
    await runSuite(tasks, {
      agentFactory: (cwd) => scriptedAgentFactory([textTurn("ok")])(cwd),
      cwd: tmpdir(),
      onTaskComplete: (result, completed, total) => {
        seen.push([result.taskId, completed, total]);
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen.every(([, , total]) => total === 2)).toBe(true);
    expect(new Set(seen.map(([id]) => id))).toEqual(new Set(["x", "y"]));
  });

  it("returns a zeroed summary for an empty task list", async () => {
    const suite = await runSuite([], {
      agentFactory: (cwd) => scriptedAgentFactory([textTurn("ok")])(cwd),
      cwd: tmpdir(),
    });

    expect(suite.summary).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      infra: 0,
      passRate: 0,
      totalCostUsd: 0,
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      totalWallTimeMs: 0,
    });
  });
});
