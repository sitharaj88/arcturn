import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";
import { writeReport } from "./report.js";
import type { SuiteResult } from "./suite.js";

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(chunk.toString());
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(chunk.toString());
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

function minimalSuite(taskId: string, passed: boolean, model: string): SuiteResult {
  return {
    model,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    results: [
      {
        taskId,
        passed,
        reason: "completed",
        assertions: [{ name: "a", passed }],
        turns: 1,
        toolCalls: {},
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        wallTimeMs: 1,
        finalText: "",
      },
    ],
    summary: {
      total: 1,
      passed: passed ? 1 : 0,
      failed: passed ? 0 : 1,
      passRate: passed ? 1 : 0,
      totalCostUsd: 0,
      totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      totalWallTimeMs: 1,
    },
  };
}

describe("main (arg parsing and dispatch, no network)", () => {
  it("prints help and exits 2 when called with no command", async () => {
    const capture = captureOutput();
    const code = await main([]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain("arcturn-evals");
  });

  it("prints help and exits 0 for --help", async () => {
    const capture = captureOutput();
    const code = await main(["--help"]);
    capture.restore();
    expect(code).toBe(0);
    expect(capture.stdout.join("")).toContain("Usage:");
  });

  it("exits 2 with a message for an unknown command", async () => {
    const capture = captureOutput();
    const code = await main(["frobnicate"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain('unknown command "frobnicate"');
  });

  it("rejects an unknown run option", async () => {
    const capture = captureOutput();
    const code = await main(["run", "--bogus"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain("unknown option");
  });

  it("rejects --concurrency with a non-numeric value", async () => {
    const capture = captureOutput();
    const code = await main(["run", "--concurrency", "abc"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain("--concurrency needs a positive integer");
  });

  it("rejects --model with no value", async () => {
    const capture = captureOutput();
    const code = await main(["run", "--model"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain("--model needs a value");
  });

  it("compare requires two file arguments", async () => {
    const capture = captureOutput();
    const code = await main(["compare", "only-one.json"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain("compare needs two JSON report paths");
  });
});

describe("main run (fails fast, no network, no API key)", () => {
  const savedKeys: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      savedKeys[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("fails with a clear message when no API key is configured", async () => {
    const capture = captureOutput();
    const code = await main(["run"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toMatch(/api key/i);
  });
});

describe("main run (task filtering, network-free once no tasks match)", () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    // A syntactically-present key is enough for model resolution to succeed;
    // it is never sent anywhere in this test because no task matches, so the
    // command returns before `runSuite` (and any network call) happens.
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it("exits 2 when --tasks matches nothing", async () => {
    const capture = captureOutput();
    const code = await main(["run", "--tasks", "no-such-task-*"]);
    capture.restore();
    expect(code).toBe(2);
    expect(capture.stderr.join("")).toContain("no tasks match");
  });
});

describe("main compare", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-evals-main-compare-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("exits 0 and reports no regressions when nothing got worse", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await writeReport(minimalSuite("t1", true, "model-a"), a);
    await writeReport(minimalSuite("t1", true, "model-b"), b);

    const capture = captureOutput();
    const code = await main(["compare", a, b]);
    capture.restore();

    expect(code).toBe(0);
    expect(capture.stdout.join("")).toContain("No regressions.");
  });

  it("exits 1 and calls out a regression by task id", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await writeReport(minimalSuite("t1", true, "model-a"), a);
    await writeReport(minimalSuite("t1", false, "model-b"), b);

    const capture = captureOutput();
    const code = await main(["compare", a, b]);
    capture.restore();

    expect(code).toBe(1);
    expect(capture.stdout.join("")).toContain("REGRESSIONS (1)");
    expect(capture.stdout.join("")).toContain("t1");
  });
});
