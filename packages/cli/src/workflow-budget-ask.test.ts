/**
 * WHEN THE STAGE-BOUNDARY BUDGET ASK CAN AND CANNOT FIRE.
 *
 * The ask exists so a run stops POLITELY — paused, resumable, with the numbers
 * on screen — instead of hard-failing on its ceiling into a `runEnd{failed}`
 * that neither resume path will ever continue. `workflow.test.ts` proves it
 * fires, and that a `continue` or a `raise` carries the run on. This suite
 * proves its EDGES, because a live evaluation went looking for it three times
 * with real models and never once saw it: every attempt blew through the
 * ceiling inside a single step, and a boundary check has no boundary to run at
 * in the middle of one.
 *
 * That is working as designed — the ask is a stage-boundary question and the
 * hard ceiling is the backstop for everything else — but a safety net nobody
 * can reach is worth writing down. So each test below is one sentence of
 * `workflows.md`'s "when the ask fires" list, held to the engine.
 */

import type { Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WorkflowStepRunner,
} from "./workflow.js";
import type { JournalLine, RunJournal } from "./workflow-run.js";

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "demo" });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow, got: ${parsed.error}`);
  return parsed;
}

function memoryJournal(): { sink: RunJournal; lines: JournalLine[] } {
  const lines: JournalLine[] = [];
  return {
    lines,
    sink: {
      append: async (line) => {
        lines.push(line);
      },
    },
  };
}

/** An unpriced run: tokens only, which is what `budgetTokens:` governs. */
function tokens(count: number): Usage {
  return { inputTokens: count, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** A runner spending a per-step number of tokens, recording which steps ran. */
function spender(per: (id: string) => number, calls: string[]): WorkflowStepRunner {
  return async (request) => {
    calls.push(request.step.id);
    return { text: `<${request.step.id}>`, usage: tokens(per(request.step.id)), isError: false };
  };
}

const THREE_STAGES = parseOk(
  ["---", "name: demo", "budgetTokens: 100", "---", "1. a", "2. b {{prev}}", "3. c {{prev}}"].join(
    "\n",
  ),
);

describe("the stage-boundary budget ask — the window it can fire in", () => {
  it("fires at a boundary once the ceiling is 80% consumed and stages remain", async () => {
    const { sink, lines } = memoryJournal();
    const calls: string[] = [];

    // Stage 1 lands on 85 of 100 — inside the 80–100% window, with stages left.
    const result = await runWorkflow(THREE_STAGES, {
      journal: sink,
      runStep: spender(() => 85, calls),
    });

    expect(result.status).toBe("paused");
    expect(calls).toEqual(["1"]);
    expect(result.pause?.stepId).toBe("budget");
    expect(
      lines.find(
        (line): line is Extract<JournalLine, { kind: "budgetAsk" }> => line.kind === "budgetAsk",
      ),
    ).toMatchObject({ ceiling: "tokens", spent: 85, limit: 100, stagesDone: 1, stagesTotal: 3 });
  });

  it("CANNOT fire when one step jumps the whole window — the hard ceiling wins", async () => {
    // THE EVALUATION'S CASE, exactly. Step 1 costs 140 against a 100-token
    // ceiling: the run goes from 0% to 140% inside one step, so the first
    // stage boundary is reached with the ceiling already crossed and the run
    // is aborted rather than asked about. With real models this is the common
    // case, not the corner one — the same prompt was measured costing 27k and
    // 72k tokens on different runs of one workflow.
    const { sink, lines } = memoryJournal();
    const calls: string[] = [];

    const result = await runWorkflow(THREE_STAGES, {
      journal: sink,
      runStep: spender(() => 140, calls),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exceeded its 100-token run budget \(spent 140 tokens\)/);
    expect(calls).toEqual(["1"]);
    // No question was asked, and the run is not resumable: the hard stop is
    // the only thing that could have happened here.
    expect(lines.some((line) => line.kind === "budgetAsk")).toBe(false);
    expect(lines.find((line) => line.kind === "runEnd")).toMatchObject({ status: "failed" });
    expect(
      lines.find((line): line is Extract<JournalLine, { kind: "stop" }> => line.kind === "stop")
        ?.reason,
    ).toBe("token-ceiling");
  });

  it("CANNOT fire on the last stage — there is nothing left to save", async () => {
    // 40 a stage: the boundary after stage 1 sits at 40 of 100, and the only
    // boundary that would be in the window comes after the FINAL stage, where
    // asking buys nothing. The run simply finishes at 80%.
    const { sink, lines } = memoryJournal();
    const calls: string[] = [];
    const twoStages = parseOk(
      ["---", "name: demo", "budgetTokens: 100", "---", "1. a", "2. b {{prev}}"].join("\n"),
    );

    const result = await runWorkflow(twoStages, {
      journal: sink,
      runStep: spender(() => 40, calls),
    });

    expect(result.status).toBe("done");
    expect(calls).toEqual(["1", "2"]);
    expect(lines.some((line) => line.kind === "budgetAsk")).toBe(false);
  });

  it("CANNOT fire for budgetUsd on a model with no price — there is no number to compare", async () => {
    // The subscription case the evaluation also checked: `zai/` models carry
    // no price, so `usage.costUsd` stays undefined, the run's dollar spend is
    // unknown, and an unknown cannot be 80% of anything. The run completes.
    const { sink, lines } = memoryJournal();
    const calls: string[] = [];
    const dollars = parseOk(
      ["---", "name: demo", "budgetUsd: 0.01", "---", "1. a", "2. b {{prev}}", "3. c"].join("\n"),
    );

    const result = await runWorkflow(dollars, {
      journal: sink,
      runStep: spender(() => 900, calls),
    });

    expect(result.status).toBe("done");
    expect(calls).toEqual(["1", "2", "3"]);
    expect(lines.some((line) => line.kind === "budgetAsk")).toBe(false);
  });
});
