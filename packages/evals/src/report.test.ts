import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compare, readReport, renderCompare, renderTable, writeReport } from "./report.js";
import type { TaskRunResult } from "./runner.js";
import type { SuiteResult } from "./suite.js";

function usage(inputTokens = 100, outputTokens = 50) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function taskResult(overrides: Partial<TaskRunResult> & { taskId: string }): TaskRunResult {
  return {
    passed: true,
    reason: "completed",
    assertions: [{ name: "a", passed: true }],
    turns: 1,
    toolCalls: {},
    usage: usage(),
    costUsd: 0.01,
    wallTimeMs: 1200,
    finalText: "done",
    ...overrides,
  };
}

function suiteResult(results: TaskRunResult[], model?: string): SuiteResult {
  const passed = results.filter((r) => r.passed).length;
  return {
    ...(model === undefined ? {} : { model }),
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length === 0 ? 0 : passed / results.length,
      totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
      totalUsage: results.reduce(
        (sum, r) => ({
          inputTokens: sum.inputTokens + r.usage.inputTokens,
          outputTokens: sum.outputTokens + r.usage.outputTokens,
          cacheReadTokens: sum.cacheReadTokens + r.usage.cacheReadTokens,
          cacheWriteTokens: sum.cacheWriteTokens + r.usage.cacheWriteTokens,
        }),
        usage(0, 0),
      ),
      totalWallTimeMs: results.reduce((sum, r) => sum + r.wallTimeMs, 0),
    },
  };
}

describe("renderTable", () => {
  it("renders a header, one row per task, and a summary line", () => {
    const suite = suiteResult(
      [
        taskResult({ taskId: "fix-bug", passed: true }),
        taskResult({ taskId: "add-fn", passed: false, reason: "completed" }),
      ],
      "anthropic/claude-sonnet-4-5",
    );

    const table = renderTable(suite);

    expect(table).toContain("STATUS");
    expect(table).toContain("fix-bug");
    expect(table).toContain("add-fn");
    expect(table).toContain("PASS");
    expect(table).toContain("FAIL");
    expect(table).toContain("1/2 passed (50%)");
    expect(table).toContain("anthropic/claude-sonnet-4-5");
  });

  it("never emits ANSI codes when color is off (the default)", () => {
    const suite = suiteResult([taskResult({ taskId: "t1" })]);
    const table = renderTable(suite);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ESC byte is absent.
    expect(table).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is requested", () => {
    const suite = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const table = renderTable(suite, { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ESC byte is present.
    expect(table).toMatch(/\x1b\[/);
  });

  it("keeps columns aligned regardless of color", () => {
    const suite = suiteResult([
      taskResult({ taskId: "t1", passed: true }),
      taskResult({ taskId: "t2", passed: false }),
    ]);
    const plain = renderTable(suite).split("\n");
    const colored = renderTable(suite, { color: true }).split("\n");
    expect(plain.length).toBe(colored.length);
  });

  it("renders an empty-but-valid table for zero tasks", () => {
    const table = renderTable(suiteResult([]));
    expect(table).toContain("0/0 passed (0%)");
  });
});

describe("writeReport / readReport", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-evals-report-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a suite result through JSON", async () => {
    const suite = suiteResult([taskResult({ taskId: "t1" })], "test/model");
    const path = join(dir, "report.json");
    await writeReport(suite, path);
    const loaded = await readReport(path);
    expect(loaded).toEqual(suite);
  });

  it("writes pretty-printed, newline-terminated JSON", async () => {
    const suite = suiteResult([taskResult({ taskId: "t1" })]);
    const path = join(dir, "report.json");
    await writeReport(suite, path);
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  ");
  });
});

describe("compare", () => {
  it("flags a task that passed before and fails now as a regression", () => {
    const before = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const after = suiteResult([taskResult({ taskId: "t1", passed: false })]);
    const result = compare(before, after);

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.taskId).toBe("t1");
    expect(result.tasks[0]?.status).toBe("regression");
  });

  it("flags a task that failed before and passes now as an improvement", () => {
    const before = suiteResult([taskResult({ taskId: "t1", passed: false })]);
    const after = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const result = compare(before, after);

    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0]?.taskId).toBe("t1");
  });

  it("marks unchanged tasks as unchanged, not a regression or improvement", () => {
    const before = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const after = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const result = compare(before, after);

    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
    expect(result.tasks[0]?.status).toBe("unchanged");
  });

  it("classifies tasks present in only one run as new or removed, never a regression", () => {
    const before = suiteResult([taskResult({ taskId: "old", passed: true })]);
    const after = suiteResult([taskResult({ taskId: "new", passed: true })]);
    const result = compare(before, after);

    const byId = new Map(result.tasks.map((t) => [t.taskId, t]));
    expect(byId.get("old")?.status).toBe("removedTask");
    expect(byId.get("new")?.status).toBe("newTask");
    expect(result.regressions).toHaveLength(0);
  });

  it("carries model labels and pass rates through for both runs", () => {
    const before = suiteResult([taskResult({ taskId: "t1", passed: true })], "model-a");
    const after = suiteResult([taskResult({ taskId: "t1", passed: false })], "model-b");
    const result = compare(before, after);

    expect(result.before.model).toBe("model-a");
    expect(result.after.model).toBe("model-b");
    expect(result.before.passRate).toBe(1);
    expect(result.after.passRate).toBe(0);
  });

  it("sorts tasks by id for stable diffs", () => {
    const before = suiteResult([
      taskResult({ taskId: "zebra", passed: true }),
      taskResult({ taskId: "apple", passed: true }),
    ]);
    const after = suiteResult([
      taskResult({ taskId: "zebra", passed: true }),
      taskResult({ taskId: "apple", passed: true }),
    ]);
    const result = compare(before, after);
    expect(result.tasks.map((t) => t.taskId)).toEqual(["apple", "zebra"]);
  });
});

describe("renderCompare", () => {
  it("calls out regressions by name", () => {
    const before = suiteResult([taskResult({ taskId: "broke-me", passed: true })]);
    const after = suiteResult([taskResult({ taskId: "broke-me", passed: false })]);
    const text = renderCompare(compare(before, after));

    expect(text).toContain("REGRESSIONS (1)");
    expect(text).toContain("broke-me");
  });

  it("reports no regressions when there are none", () => {
    const before = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const after = suiteResult([taskResult({ taskId: "t1", passed: true })]);
    const text = renderCompare(compare(before, after));

    expect(text).toContain("No regressions.");
  });
});
