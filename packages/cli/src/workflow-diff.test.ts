/**
 * `/workflow diff`, proved on two journals written by hand.
 *
 * Hand-written on purpose: the question this surface answers is "what is
 * different between these two runs", and the only way to test that honestly is
 * to control exactly what differs. The journals here are the real
 * {@link JournalLine} shape, written to the real on-disk layout and read back
 * through the real reader.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeScratch, type Scratch } from "./test-helpers/scratch.js";
import { diffWorkflowRuns, formatWorkflowDiff, formatWorkflowDiffJson } from "./workflow-diff.js";
import type { JournalLine } from "./workflow-run.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const usage = (output: number, costUsd?: number) => ({
  inputTokens: 10,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...(costUsd === undefined ? {} : { costUsd }),
});

/** One finished step, as the engine writes it. */
function stepEnd(
  id: string,
  stage: number,
  overrides: Partial<Extract<JournalLine, { kind: "stepEnd" }>> = {},
): JournalLine {
  return {
    kind: "stepEnd",
    id,
    stage,
    branch: 0,
    status: "done",
    agent: "builder",
    usage: usage(100, 0.01),
    text: `answer for ${id}`,
    promptHash: "h",
    attempts: 1,
    startedAt: 1_000,
    endedAt: 3_000,
    activity: { turns: 4, toolCalls: { read: 2, write: 1 }, writes: 1 },
    ...overrides,
  } as JournalLine;
}

async function writeRun(scratch: Scratch, runId: string, lines: JournalLine[]): Promise<string> {
  const root = join(scratch.home, "workflow-runs");
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "journal.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  return root;
}

function header(runId: string, extra: Record<string, unknown> = {}): JournalLine {
  return {
    kind: "run",
    v: 1,
    runId,
    workflow: "wf",
    source: "/tmp/wf.md",
    input: "",
    stepTimeoutMs: 1000,
    maxStepRetries: 2,
    startedAt: 0,
    ...extra,
  } as JournalLine;
}

async function twoRuns(): Promise<{ root: string }> {
  const scratch = await makeScratch();
  roots.push(scratch.root);
  const root = await writeRun(scratch, "run-a", [
    header("run-a"),
    stepEnd("1", 1),
    stepEnd("2", 2, { status: "failed", text: "", usage: usage(50, 0.02) }),
    { kind: "runEnd", status: "failed", ts: 9_000 } as JournalLine,
  ]);
  await writeRun(scratch, "run-b", [
    header("run-b", { forkedFrom: { runId: "run-a", at: "2", ts: 5 } }),
    stepEnd("1", 1),
    stepEnd("2", 2, {
      status: "done",
      text: "a better answer",
      usage: usage(80, 0.03),
      lastTurn: { model: "test/slow", blocks: [], stopReason: "endTurn" },
      race: {
        models: ["test/fast", "test/slow"],
        winner: "test/slow",
        losers: [{ model: "test/fast", outcome: "failed", durationMs: 900 }],
      },
    }),
    stepEnd("3", 3),
    { kind: "runEnd", status: "done", ts: 9_000 } as JournalLine,
  ]);
  return { root };
}

describe("diffWorkflowRuns", () => {
  it("marks the rows that differ and leaves the identical ones unmarked", async () => {
    const { root } = await twoRuns();
    const diff = await diffWorkflowRuns(root, "run-a", "run-b");
    if ("error" in diff) throw new Error(diff.error);

    expect(diff.sameWorkflow).toBe(true);
    expect(diff.rows.map((row) => row.stepId)).toEqual(["1", "2", "3"]);
    // Step 1 ran identically in both, so nothing about it is worth a reader's
    // attention; step 2 changed status and answer; step 3 only exists in B.
    expect(diff.rows.map((row) => row.differs)).toEqual([false, true, true]);
    expect(diff.rows[1]?.a?.status).toBe("failed");
    expect(diff.rows[1]?.b?.status).toBe("done");
    expect(diff.rows[1]?.b?.race?.winner).toBe("test/slow");
    expect(diff.rows[2]?.a).toBeUndefined();
    // The fork's provenance travels with the run's headline facts.
    expect(diff.b.forkedFrom).toEqual({ runId: "run-a", at: "2" });
    expect(diff.a.status).toBe("failed");
    expect(diff.b.status).toBe("done");
  });

  it("renders a table naming the models, the race and the first line that differs", async () => {
    const { root } = await twoRuns();
    const diff = await diffWorkflowRuns(root, "run-a", "run-b");
    if ("error" in diff) throw new Error(diff.error);
    const text = formatWorkflowDiff(diff).join("\n");

    expect(text).toContain("A run-a — wf [failed]");
    expect(text).toContain("B run-b — wf [done] (forked from run-a at 2)");
    expect(text).toContain("race unknown → test/slow");
    expect(text).toContain("A: —");
    expect(text).toContain("B: a better answer");
    expect(text).toContain("2 of 3 step(s) differ.");
    expect(text).toContain("Totals  A 2 step(s)");
  });

  it("reports totals as unknown rather than as a wrong zero when a step is unpriced", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const root = await writeRun(scratch, "priced", [header("priced"), stepEnd("1", 1)]);
    await writeRun(scratch, "unpriced", [
      header("unpriced"),
      stepEnd("1", 1, { usage: usage(100) }),
    ]);
    const diff = await diffWorkflowRuns(root, "priced", "unpriced");
    if ("error" in diff) throw new Error(diff.error);
    expect(diff.a.costKnown).toBe(true);
    expect(diff.b.costKnown).toBe(false);
    expect(diff.b.costUsd).toBeUndefined();
    expect(formatWorkflowDiff(diff).join("\n")).toContain("B 1 step(s)");
    expect(formatWorkflowDiff(diff).at(-2)).toContain("unknown");
  });

  it("compares two different workflows by step id, and says that is what it did", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const root = await writeRun(scratch, "left", [header("left"), stepEnd("1", 1)]);
    await writeRun(scratch, "right", [
      { ...(header("right") as Record<string, unknown>), workflow: "other" } as JournalLine,
      stepEnd("1", 1),
    ]);
    const diff = await diffWorkflowRuns(root, "left", "right");
    if ("error" in diff) throw new Error(diff.error);
    expect(diff.sameWorkflow).toBe(false);
    expect(formatWorkflowDiff(diff).join("\n")).toContain("two different workflows");
  });

  it("hands back structured json for a machine", async () => {
    const { root } = await twoRuns();
    const diff = await diffWorkflowRuns(root, "run-a", "run-b");
    if ("error" in diff) throw new Error(diff.error);
    const parsed = JSON.parse(formatWorkflowDiffJson(diff)) as typeof diff;
    expect(parsed.a.runId).toBe("run-a");
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1]?.b?.race?.winner).toBe("test/slow");
    expect(parsed.rows[1]?.differs).toBe(true);
  });

  it("names the run it could not read rather than half-rendering a comparison", async () => {
    const { root } = await twoRuns();
    expect(await diffWorkflowRuns(root, "run-a", "nobody")).toEqual({
      error: 'No run journal for "nobody". Try /workflow status.',
    });
    expect(await diffWorkflowRuns(root, "nobody", "run-b")).toEqual({
      error: 'No run journal for "nobody". Try /workflow status.',
    });
  });
});

describe("diffWorkflowRuns — a raced run's totals", () => {
  /**
   * The per-step column is the WINNER's — that is the answer the step
   * produced — but the run's totals are the bill, and a race is billed for
   * every arm. Comparing a raced run against an unraced one on the winner's
   * usage alone made the race look free.
   */
  it("totals the whole race, and still describes the step by its winner", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const root = await writeRun(scratch, "run-c", [
      header("run-c"),
      stepEnd("1", 1, {
        usage: usage(100, 0.01),
        raceUsage: usage(300, 0.05),
        race: {
          models: ["fast", "slow"],
          winner: "fast",
          losers: [{ model: "slow", outcome: "aborted", durationMs: 900 }],
        },
      }),
      { kind: "runEnd", status: "done", ts: 9_000 } as JournalLine,
    ]);
    await writeRun(scratch, "run-d", [
      header("run-d"),
      stepEnd("1", 1, { usage: usage(100, 0.01) }),
      { kind: "runEnd", status: "done", ts: 9_000 } as JournalLine,
    ]);
    const diff = await diffWorkflowRuns(root, "run-c", "run-d");
    if ("error" in diff) throw new Error(diff.error);
    expect(diff.a.costUsd).toBeCloseTo(0.05, 5);
    expect(diff.b.costUsd).toBeCloseTo(0.01, 5);
    // The step row is the winner's, unchanged.
    expect(diff.rows.find((row) => row.stepId === "1")?.a?.costUsd).toBeCloseTo(0.01, 5);
  });
});
