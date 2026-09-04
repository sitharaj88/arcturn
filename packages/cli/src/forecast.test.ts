/**
 * RUN FORECASTING — `forecastWorkflow`, its rendering, and the wired
 * `/workflow forecast` command plus the run-start banner.
 *
 * Three groups, same shape as `insights.test.ts`:
 *
 * - **the pure fold** — `forecastWorkflow` over a hand-written ledger:
 *   percentile math, superseded exclusion, model/role fallbacks, unknown-cost
 *   propagation, stop-probability math, window filtering.
 * - **the rendering** — the banner's thresholds, the table, `--json`'s
 *   round-trip stability.
 * - **the command** — `/workflow forecast` and the run-start banner, driven
 *   through the real registry and a real `runWorkflow`, over the on-disk
 *   ledger both generations included.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORECAST_WINDOW_DAYS,
  type ForecastWorkflowOptions,
  forecastWorkflow,
  formatForecastJson,
  renderForecast,
  renderForecastBanner,
  resolveForecastStepModel,
} from "./forecast.js";
import {
  type InsightsEvent,
  insightsFile,
  insightsRotatedFile,
  type ParkRecord,
  type RunEndRecord,
  readInsightsLedger,
  type StepEndRecord,
} from "./insights.js";
import { runPrint } from "./print.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import type { Workflow, WorkflowStage, WorkflowStep } from "./workflow.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-04T00:00:00Z");

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** One step, defaulting the fields the fold ignores. */
function step(id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id, stageIndex: Number(id), branchIndex: 0, prompt: `do ${id}`, ...overrides };
}

/** A one-step-per-stage workflow from a list of steps, in order. */
function workflow(name: string, steps: readonly WorkflowStep[]): Workflow {
  const stages: WorkflowStage[] = steps.map((s, i) => ({
    index: i + 1,
    parallel: false,
    steps: [s],
  }));
  return { name, description: "", continueOnError: false, stages, source: "/wf.md" };
}

function usage(tokens: number): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  return { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

let seq = 0;
function stepEnd(
  overrides: Partial<StepEndRecord> & { workflow: string; stepId: string },
): StepEndRecord {
  seq += 1;
  return {
    v: 1,
    ts: NOW,
    kind: "step-end",
    runId: `r${seq}`,
    role: undefined,
    status: "done",
    model: "m1",
    durationMs: 1000,
    usage: usage(100),
    attempts: 1,
    ...overrides,
  } as StepEndRecord;
}

function park(
  overrides: Partial<ParkRecord> & { workflow: string; runId: string; stepId: string },
): ParkRecord {
  return {
    v: 1,
    ts: NOW,
    kind: "park",
    attempts: 1,
    causeKind: "other",
    ...overrides,
  } as ParkRecord;
}

function runEnd(
  overrides: Partial<RunEndRecord> & { workflow: string; runId: string },
): RunEndRecord {
  return {
    v: 1,
    ts: NOW,
    kind: "run-end",
    status: "done",
    durationMs: 1000,
    usage: usage(100),
    models: ["m1"],
    steps: 1,
    parks: 0,
    ...overrides,
  } as RunEndRecord;
}

/** A `resolveStepModel` that returns the same fixed model for every step. */
function fixedModel(model: string | undefined): ForecastWorkflowOptions["resolveStepModel"] {
  return () => model;
}

const priceOf = (rate: number) => (id: string) =>
  id === "m1"
    ? ({
        id: "m1",
        provider: "anthropic",
        model: "m1",
        displayName: "m1",
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        capabilities: {},
        cost: { input: rate, output: rate },
      } as unknown as ReturnType<NonNullable<ForecastWorkflowOptions["resolveModelSpec"]>>)
    : undefined;

// ---------------------------------------------------------------------------
// the pure fold
// ---------------------------------------------------------------------------

describe("forecastWorkflow", () => {
  it("reports honestly when the ledger has nothing to say", () => {
    const wf = workflow("pipeline", [step("1"), step("2")]);
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events: [],
      now: NOW,
    });
    expect(forecast.stagesWithoutHistory).toBe(2);
    expect(forecast.stages.every((s) => s.history === undefined)).toBe(true);
    expect(forecast.runHistory.runs).toBe(0);
    expect(forecast.totals).toEqual({
      p50DurationMs: 0,
      costUsd: 0,
      costKnown: true,
      stopProbability: 0,
    });
    expect(forecast.windowDays).toBe(DEFAULT_FORECAST_WINDOW_DAYS);
  });

  it("computes p50/p90 by nearest-rank, exactly", () => {
    const wf = workflow("pipeline", [step("1")]);
    // ceil(0.5*10)=5th -> 500; ceil(0.9*10)=9th -> 900.
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const events: InsightsEvent[] = durations.map((durationMs) =>
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", durationMs }),
    );
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    const history = forecast.stages[0]?.history;
    expect(history?.samples).toBe(10);
    expect(history?.p50DurationMs).toBe(500);
    expect(history?.p90DurationMs).toBe(900);
    expect(history?.source).toBe("step");
  });

  it("excludes a superseded terminal from the samples the fold counts", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      // The stall the automatic retry rescued: a huge duration that must NOT
      // pull the p50 toward it.
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        model: "m1",
        durationMs: 999_000,
        status: "failed",
        superseded: true,
      }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", durationMs: 1000, status: "done" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    const history = forecast.stages[0]?.history;
    expect(history?.samples).toBe(1);
    expect(history?.p50DurationMs).toBe(1000);
  });

  /**
   * A race's losing arm is `superseded` so nothing that counts STEPS counts it
   * twice — but it is not another attempt at the same thing: it is a different
   * MODEL answering this exact step, at its own speed and its own price, which
   * is the one comparison no single-model history can make. So the forecast
   * samples it, under its own model, and only counts it as a STOP when it
   * actually failed on its own terms.
   */
  it("samples a race's losing arm under its own model", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        model: "fast",
        durationMs: 1_000,
        status: "done",
        race: "won",
      }),
      // Cut off the instant the winner appeared: real duration, no fault.
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        model: "slow",
        durationMs: 4_000,
        status: "failed",
        failureKind: "cancelled",
        superseded: true,
        race: "lost",
        raceOutcome: "aborted",
      }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("slow"),
      events,
      now: NOW,
    });
    const history = forecast.stages[0]?.history;
    // The lost arm IS this model's history on this step…
    expect(history?.samples).toBe(1);
    expect(history?.p50DurationMs).toBe(4_000);
    // …and being cut off is not a stop: nothing about that model failed.
    expect(history?.stopRate).toBe(0);
  });

  it("counts a lost arm that failed on its own terms as a stop", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        model: "slow",
        durationMs: 4_000,
        status: "failed",
        failureKind: "agent-error",
        superseded: true,
        race: "lost",
        raceOutcome: "failed",
      }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("slow"),
      events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.stopRate).toBe(1);
  });

  it("offers the model that keeps winning a raced step as the alternative", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      // The step is configured on `slow`, which loses every race it runs.
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        model: "slow",
        status: "failed",
        failureKind: "agent-error",
        superseded: true,
        race: "lost",
        raceOutcome: "failed",
      }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "fast", status: "done", race: "won" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("slow"),
      events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.alternative).toMatchObject({
      model: "fast",
      stopRate: 0,
    });
  });

  it("falls back step -> any model -> role, labelling the source", () => {
    // Step "1": history only exists on a DIFFERENT model -> "step-any-model".
    // Step "2": no history under this workflow/step at all, but the role
    // "builder" has history on ANOTHER workflow -> "role".
    // Step "3": nothing anywhere -> no history.
    const wf = workflow("pipeline", [
      step("1", { agent: "architect" }),
      step("2", { agent: "builder" }),
      step("3"),
    ]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "other-model", role: "architect" }),
      stepEnd({ workflow: "nightly", stepId: "9", model: "m1", role: "builder" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.source).toBe("step-any-model");
    expect(forecast.stages[1]?.history?.source).toBe("role");
    expect(forecast.stages[2]?.history).toBeUndefined();
    expect(forecast.stagesWithoutHistory).toBe(1);
  });

  it("prefers the role's own catalog name over the workflow's stale @role text", () => {
    const wf = workflow("pipeline", [step("1", { agent: "old-name" })]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "nightly", stepId: "9", model: "m1", role: "new-name" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map([["old-name", { name: "new-name" } as never]]),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.source).toBe("role");
    expect(forecast.stages[0]?.role).toBe("new-name");
  });

  it("marks a stage's cost unknown the moment one sample cannot be priced", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", usage: usage(1_000_000) }),
      // A coding-plan model: no pricing published.
      stepEnd({ workflow: "pipeline", stepId: "1", model: "unpriced-model", usage: usage(500) }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel(undefined),
      resolveModelSpec: priceOf(1),
      events,
      now: NOW,
    });
    const history = forecast.stages[0]?.history;
    expect(history?.costKnown).toBe(false);
    expect(history?.costUsd).toBeUndefined();
    expect(forecast.totals.costKnown).toBe(false);
    expect(forecast.totals.costUsd).toBeUndefined();
  });

  it("prices every sample known and reports the p50 dollar figure", () => {
    const wf = workflow("pipeline", [step("1")]);
    // rate 1 per token (via priceOf); PER_MILLION divisor in calculateCostUsd
    // means 1,000,000 input tokens at rate 1 = $1.00.
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", usage: usage(1_000_000) }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", usage: usage(2_000_000) }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      resolveModelSpec: priceOf(1),
      events,
      now: NOW,
    });
    const history = forecast.stages[0]?.history;
    expect(history?.costKnown).toBe(true);
    // nearest-rank p50 of [1, 2] (ascending) -> rank ceil(0.5*2)=1 -> 1.
    expect(history?.costUsd).toBe(1);
  });

  it("computes stop probability as 1 - the product of survival, over every stage", () => {
    const wf = workflow("pipeline", [step("1"), step("2")]);
    // Stage 1: 2 of 4 failed, no parks -> stopRate 2/4 = 0.5.
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "a", status: "failed" }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "b", status: "failed" }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "c", status: "done" }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "d", status: "done" }),
      // Stage 2: 1 of 5 failed -> 0.2.
      ...["e", "f", "g", "h"].map((runId) =>
        stepEnd({ workflow: "pipeline", stepId: "2", model: "m1", runId, status: "done" }),
      ),
      stepEnd({ workflow: "pipeline", stepId: "2", model: "m1", runId: "i", status: "failed" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.stopRate).toBeCloseTo(0.5);
    expect(forecast.stages[1]?.history?.stopRate).toBeCloseTo(0.2);
    // 1 - (1-0.5)*(1-0.2) = 1 - 0.5*0.8 = 1 - 0.4 = 0.6
    expect(forecast.totals.stopProbability).toBeCloseTo(0.6);
  });

  it("attributes a park only to the model bucket its own terminal ran on", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "a", status: "failed" }),
      park({ workflow: "pipeline", stepId: "1", runId: "a" }),
      // A park on a DIFFERENT model's run must not inflate m1's stop rate.
      stepEnd({ workflow: "pipeline", stepId: "1", model: "other", runId: "z", status: "failed" }),
      park({ workflow: "pipeline", stepId: "1", runId: "z" }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "b", status: "done" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    // m1: 1 failed + 1 park over 2 samples = 1.0; "other" is a separate model.
    expect(forecast.stages[0]?.history?.stopRate).toBeCloseTo(1);
    expect(forecast.stages[0]?.history?.samples).toBe(2);
  });

  it("surfaces a lower-stop-rate alternative model, but only when it beats the current one", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      // m1: 2 of 2 failed -> 1.0.
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "a", status: "failed" }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "b", status: "failed" }),
      // alt-model: 0 of 4 failed -> 0.
      ...["c", "d", "e", "f"].map((runId) =>
        stepEnd({ workflow: "pipeline", stepId: "1", model: "alt-model", runId, status: "done" }),
      ),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.alternative).toEqual({
      model: "alt-model",
      stopRate: 0,
      samples: 4,
    });
  });

  it("filters events outside the window", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", ts: NOW - 40 * DAY }),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", ts: NOW - 1 * DAY }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
      windowDays: 30,
    });
    expect(forecast.stages[0]?.history?.samples).toBe(1);

    const wider = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
      windowDays: 90,
    });
    expect(wider.stages[0]?.history?.samples).toBe(2);
  });

  it("reads history off BOTH ledger generations", async () => {
    const scratch = await makeScratch();
    await mkdir(join(scratch.home, "insights"), { recursive: true });
    const older = stepEnd({ workflow: "pipeline", stepId: "1", model: "m1" });
    const current = stepEnd({ workflow: "pipeline", stepId: "1", model: "m1" });
    await writeFile(insightsRotatedFile(scratch.home), `${JSON.stringify(older)}\n`, "utf8");
    await writeFile(insightsFile(scratch.home), `${JSON.stringify(current)}\n`, "utf8");

    const ledger = await readInsightsLedger(scratch.home);
    const forecast = forecastWorkflow({
      workflow: workflow("pipeline", [step("1")]),
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events: ledger.events,
      now: NOW,
    });
    expect(forecast.stages[0]?.history?.samples).toBe(2);
  });

  it("sanity-checks against the workflow's own whole-run history", () => {
    const wf = workflow("pipeline", [step("1")]);
    const events: InsightsEvent[] = [
      runEnd({ workflow: "pipeline", runId: "a", durationMs: 1000, costUsd: 0.1 }),
      runEnd({ workflow: "pipeline", runId: "b", durationMs: 3000, costUsd: 0.3 }),
      // A different workflow's run-end must not leak into this sanity line.
      runEnd({ workflow: "other", runId: "z", durationMs: 999_000, costUsd: 9 }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    expect(forecast.runHistory.runs).toBe(2);
    // nearest-rank p50 of [1000, 3000] (ascending): rank ceil(0.5*2)=1 -> 1000.
    expect(forecast.runHistory.p50DurationMs).toBe(1000);
    expect(forecast.runHistory.costUsd).toBeCloseTo(0.1);
  });
});

// ---------------------------------------------------------------------------
// raced steps
// ---------------------------------------------------------------------------

/**
 * A `[race:a|b]` step has NO single model, so it must not be forecast as one
 * row: labelling it with one arm reports that arm's name over the other arm's
 * numbers — the defect this split closes. One row per arm, each on its own
 * samples; the totals time the run on the arm that has won most often,
 * because a race ends when its first arm ends, while cost bills every arm.
 */
describe("a raced step forecasts one row per arm", () => {
  /** Prices any model at 1 per million tokens, and resolves a race tag to itself. */
  const priceAny = (id: string) =>
    ({
      id,
      provider: "anthropic",
      model: id,
      displayName: id,
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      capabilities: {},
      cost: { input: 1, output: 1 },
    }) as unknown as ReturnType<NonNullable<ForecastWorkflowOptions["resolveModelSpec"]>>;

  it("splits per arm and times the totals on the arm that has won most often", () => {
    // Declared "fast" first, but "slow" won 2 of the 3 races — so the totals
    // must take their wall clock from "slow", never from the declared-first
    // arm and never from the sum of the two.
    const wf = workflow("pipeline", [step("1", { race: ["fast", "slow"] })]);
    const lost = (runId: string, model: string, durationMs: number): StepEndRecord =>
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        runId,
        model,
        durationMs,
        status: "failed",
        failureKind: "cancelled",
        superseded: true,
        race: "lost",
        raceOutcome: "aborted",
      });
    const won = (runId: string, model: string, durationMs: number): StepEndRecord =>
      stepEnd({
        workflow: "pipeline",
        stepId: "1",
        runId,
        model,
        durationMs,
        status: "done",
        race: "won",
      });
    const events: InsightsEvent[] = [
      // run a: fast wins.
      won("a", "fast", 1_000),
      lost("a", "slow", 3_000),
      // run b: slow wins.
      lost("b", "fast", 5_000),
      won("b", "slow", 2_000),
      // run c: slow wins again.
      lost("c", "fast", 7_000),
      won("c", "slow", 4_000),
      runEnd({ workflow: "pipeline", runId: "a" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      // The engine hands a raced step no single model; the fold must not use
      // one even when the option offers it.
      resolveStepModel: fixedModel("fast"),
      events,
      now: NOW,
    });

    expect(forecast.stages).toHaveLength(2);
    expect(forecast.stages.map((s) => s.stepId)).toEqual(["1", "1"]);
    expect(forecast.stages.map((s) => s.model)).toEqual(["fast", "slow"]);
    expect(forecast.stages.every((s) => s.raceArm === true)).toBe(true);

    // Each arm carries ITS OWN durations: fast [1000, 5000, 7000] -> p50 5000,
    // slow [2000, 3000, 4000] -> p50 3000.
    const fast = forecast.stages[0];
    const slow = forecast.stages[1];
    expect(fast?.history?.samples).toBe(3);
    expect(fast?.history?.p50DurationMs).toBe(5_000);
    expect(fast?.history?.source).toBe("step");
    expect(slow?.history?.samples).toBe(3);
    expect(slow?.history?.p50DurationMs).toBe(3_000);
    // The historical winner, marked on exactly one arm.
    expect(fast?.raceWinner).toBeUndefined();
    expect(slow?.raceWinner).toBe(true);
    // Totals: the winner's p50 — not the loser's 5000, not the sum 8000.
    expect(forecast.totals.p50DurationMs).toBe(3_000);
    // Being cut off the instant the other arm won is nobody's failure.
    expect(forecast.totals.stopProbability).toBe(0);

    // The compact table says which rows are arms, since two rows share step 1.
    const text = renderForecast(forecast).join("\n");
    const armRows = text.split("\n").filter((line) => line.includes("race arm"));
    expect(armRows).toHaveLength(2);
    expect(armRows[0]).toContain("fast");
    expect(armRows[1]).toContain("slow");
    expect(text).toContain("step 1: timed on slow");

    // …and so does --json.
    const json = JSON.parse(formatForecastJson(forecast)) as typeof forecast;
    expect(json.stages).toHaveLength(2);
    expect(json.stages[0]).toMatchObject({ stepId: "1", model: "fast", raceArm: true });
    expect(json.stages[0]?.raceWinner).toBeUndefined();
    expect(json.stages[1]).toMatchObject({
      stepId: "1",
      model: "slow",
      raceArm: true,
      raceWinner: true,
    });
    expect(json.totals.p50DurationMs).toBe(3_000);
  });

  it("keeps the arm that loses every race as its own row, and bills cost for both", () => {
    // The shape the eval caught: `zai/glm-5.3-flash` lost both races, yet the
    // single row it produced wore the flash label over the winner's numbers.
    const wf = workflow("pipeline", [step("1", { race: ["zai/glm-5.3-flash", "zai/glm-5.3"] })]);
    const events: InsightsEvent[] = [
      ...["a", "b"].map((runId) =>
        stepEnd({
          workflow: "pipeline",
          stepId: "1",
          runId,
          model: "zai/glm-5.3-flash",
          durationMs: 31_464,
          usage: usage(1_000_000),
          status: "failed",
          failureKind: "cancelled",
          superseded: true,
          race: "lost",
          raceOutcome: "slower",
        }),
      ),
      ...["a", "b"].map((runId) =>
        stepEnd({
          workflow: "pipeline",
          stepId: "1",
          runId,
          model: "zai/glm-5.3",
          durationMs: 21_238,
          usage: usage(1_000_000),
          status: "done",
          race: "won",
        }),
      ),
      runEnd({ workflow: "pipeline", runId: "a" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("zai/glm-5.3-flash"),
      resolveModelSpec: priceAny,
      events,
      now: NOW,
    });

    const [flash, glm] = forecast.stages;
    expect(forecast.stages).toHaveLength(2);
    // The loser keeps its own, slower durations under its own name…
    expect(flash).toMatchObject({ model: "zai/glm-5.3-flash", raceArm: true });
    expect(flash?.raceWinner).toBeUndefined();
    expect(flash?.history?.samples).toBe(2);
    expect(flash?.history?.p50DurationMs).toBe(31_464);
    // …and the winner, which won both, is what the run's clock follows.
    expect(glm).toMatchObject({ model: "zai/glm-5.3", raceArm: true, raceWinner: true });
    expect(glm?.history?.p50DurationMs).toBe(21_238);
    expect(forecast.totals.p50DurationMs).toBe(21_238);

    // Cost is the other way round: both arms ran, both arms were paid for.
    // 1,000,000 input tokens at rate 1 = $1.00 per arm.
    expect(flash?.history?.costUsd).toBe(1);
    expect(glm?.history?.costUsd).toBe(1);
    expect(forecast.totals.costKnown).toBe(true);
    expect(forecast.totals.costUsd).toBe(2);

    const text = renderForecast(forecast).join("\n");
    expect(text.split("\n").filter((line) => line.includes("race arm"))).toHaveLength(2);
    expect(text).toContain("zai/glm-5.3-flash");
    expect(text).toContain("step 1: timed on zai/glm-5.3");

    const json = formatForecastJson(forecast);
    expect(json.match(/"raceArm": true/g)).toHaveLength(2);
    expect(json.match(/"raceWinner": true/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

describe("renderForecastBanner", () => {
  it("says plainly when there is no history at all", () => {
    const forecast = forecastWorkflow({
      workflow: workflow("pipeline", [step("1")]),
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events: [],
      now: NOW,
    });
    expect(renderForecastBanner(forecast)).toEqual(["forecast: no history for this workflow yet"]);
  });

  it("stays one line under the 25% stop-risk threshold", () => {
    const wf = workflow("pipeline", [step("1")]);
    // 1 of 5 failed -> 20%, below the threshold.
    const events: InsightsEvent[] = [
      ...["a", "b", "c", "d"].map((runId) =>
        stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId, status: "done" }),
      ),
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", runId: "e", status: "failed" }),
      runEnd({ workflow: "pipeline", runId: "a" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    const lines = renderForecastBanner(forecast);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("forecast:");
  });

  it("adds the risky-stage line at or above the 25% threshold, naming the alternative", () => {
    const wf = workflow("pipeline", [step("5", { agent: "rag-builder" })]);
    const events: InsightsEvent[] = [
      stepEnd({
        workflow: "pipeline",
        stepId: "5",
        model: "zai/glm-5.3",
        role: "rag-builder",
        runId: "a",
        status: "failed",
      }),
      park({ workflow: "pipeline", stepId: "5", runId: "a" }),
      stepEnd({
        workflow: "pipeline",
        stepId: "5",
        model: "zai/glm-5.3",
        role: "rag-builder",
        runId: "b",
        status: "done",
      }),
      stepEnd({
        workflow: "pipeline",
        stepId: "5",
        model: "zai/glm-5.3",
        role: "rag-builder",
        runId: "c",
        status: "done",
      }),
      stepEnd({
        workflow: "pipeline",
        stepId: "5",
        model: "openai/gpt-5-nano",
        role: "rag-builder",
        runId: "d",
        status: "done",
      }),
      stepEnd({
        workflow: "pipeline",
        stepId: "5",
        model: "openai/gpt-5-nano",
        role: "rag-builder",
        runId: "e",
        status: "done",
      }),
      runEnd({ workflow: "pipeline", runId: "a" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("zai/glm-5.3"),
      events,
      now: NOW,
    });
    const lines = renderForecastBanner(forecast);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("stage 5");
    expect(lines[1]).toContain("rag-builder");
    // Run "a" both failed AND parked, so it counts in both halves of the
    // formula (the ledger's own words: "stop rate = (parks + failed
    // terminals) / samples") -> 2 of 3, matching the brief's own example.
    expect(lines[1]).toContain("2/3");
    expect(lines[1]).toContain("zai/glm-5.3");
    expect(lines[1]).toContain("0/2");
    expect(lines[1]).toContain("openai/gpt-5-nano");
  });
});

describe("renderForecast (the table)", () => {
  it("shows the confidence line's caveat when a stage has no history", () => {
    const wf = workflow("pipeline", [step("1"), step("2")]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1" }),
      runEnd({ workflow: "pipeline", runId: "a" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      events,
      now: NOW,
    });
    const text = renderForecast(forecast).join("\n");
    expect(text).toContain("Forecast — pipeline");
    expect(text).toContain("1 run of this workflow in the last 30 days; 1 stage has no history.");
    // Row 1 has history (a "-" source label); row 2 says plainly it has none.
    expect(text).toMatch(/^1\s+-\s+m1/m);
    expect(text).toContain("no history");
  });
});

describe("formatForecastJson", () => {
  it("round-trips the forecast exactly, for a stable --json shape", () => {
    const wf = workflow("pipeline", [step("1", { agent: "builder" })]);
    const events: InsightsEvent[] = [
      stepEnd({ workflow: "pipeline", stepId: "1", model: "m1", role: "builder" }),
      runEnd({ workflow: "pipeline", runId: "a" }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: fixedModel("m1"),
      resolveModelSpec: priceOf(1),
      events,
      now: NOW,
    });
    const json = formatForecastJson(forecast);
    expect(JSON.parse(json)).toEqual(forecast);
    expect(json).toContain('"workflow": "pipeline"');
    expect(json).toContain('"stages"');
    expect(json).toContain('"totals"');
    expect(json).toContain('"runHistory"');
  });
});

// ---------------------------------------------------------------------------
// resolveForecastStepModel
// ---------------------------------------------------------------------------

describe("resolveForecastStepModel", () => {
  const spec = (id: string) => ({ id }) as never;
  const roles = new Map([["builder", { model: "role-model" } as never]]);

  it("a step's own [tag] wins over everything", () => {
    const model = resolveForecastStepModel(
      { modelTag: "tag", agent: "builder" },
      roles,
      (tag) => (tag === "tag" ? spec("tag-model") : undefined),
      () => spec("fallback"),
    );
    expect(model).toBe("tag-model");
  });

  it("an unresolvable [tag] forecasts as no model, never falling back", () => {
    const model = resolveForecastStepModel(
      { modelTag: "ghost", agent: "builder" },
      roles,
      () => undefined,
      () => spec("fallback"),
    );
    expect(model).toBeUndefined();
  });

  it("the role's own model: wins over the subagent default", () => {
    const model = resolveForecastStepModel(
      { agent: "builder" },
      roles,
      (tag) => (tag === "role-model" ? spec("resolved-role-model") : undefined),
      () => spec("fallback"),
    );
    expect(model).toBe("resolved-role-model");
  });

  it("falls back to the subagent default when nothing else names a model", () => {
    const model = resolveForecastStepModel(
      {},
      roles,
      () => undefined,
      () => spec("fallback"),
    );
    expect(model).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// the command: `/workflow forecast` and the run-start banner, over the real
// registry and a real runWorkflow.
// ---------------------------------------------------------------------------

async function writeWorkflow(scratch: Scratch, name: string, body: string): Promise<void> {
  const dir = join(scratch.home, "workflows");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}

async function writeRole(scratch: Scratch, name: string, body: string): Promise<void> {
  const dir = join(scratch.home, "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body, "utf8");
}

async function writeLedger(scratch: Scratch, events: readonly InsightsEvent[]): Promise<void> {
  await mkdir(join(scratch.home, "insights"), { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(insightsFile(scratch.home), `${body}\n`, "utf8");
}

describe("/workflow forecast, wired through the real registry", () => {
  it("prints a stage table over a ledger fixture", async () => {
    const scratch = await makeScratch();
    await writeRole(
      scratch,
      "reviewer",
      "---\nname: reviewer\ndescription: Reads only\ntools: read\n---\nReview.\n",
    );
    await writeWorkflow(
      scratch,
      "review",
      [
        "---",
        "name: review",
        "description: one step",
        "---",
        "1. @reviewer Review: {{input}}",
        "",
      ].join("\n"),
    );
    await writeLedger(scratch, [
      stepEnd({ workflow: "review", stepId: "1", model: "m1", role: "reviewer", durationMs: 4000 }),
      stepEnd({ workflow: "review", stepId: "1", model: "m1", role: "reviewer", durationMs: 6000 }),
      runEnd({ workflow: "review", runId: "r1", durationMs: 10_000 }),
    ]);

    const runtime = await buildTestRuntime(scratch);
    const out: string[] = [];
    const result = await runPrint({
      runtime,
      prompt: "/workflow forecast review",
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
    });
    await runtime.dispose();

    const printed = out.join("");
    expect(result.exitCode).toBe(0);
    expect(printed).toContain("Forecast — review");
    expect(printed).toContain("reviewer");
    expect(printed).toContain("1 run of this workflow in the last 30 days.");
    // The role names no model of its own, so the row's MODEL column is
    // whatever the test runtime's subagent default resolves to — not the
    // ledger's "m1" — but the fixture still has two "m1" terminals for step
    // "1", so the row falls back to "step-any-model" history: 2 samples.
    expect(printed).toMatch(/^1\s+@reviewer\s+\S+\s+2\s/m);
    expect(printed).toContain("any model");
  });

  it("--json emits the same structured forecast the pure function returns", async () => {
    const scratch = await makeScratch();
    await writeRole(scratch, "reviewer", "---\nname: reviewer\ntools: read\n---\nReview.\n");
    await writeWorkflow(
      scratch,
      "review",
      ["---", "name: review", "---", "1. @reviewer Review: {{input}}", ""].join("\n"),
    );
    await writeLedger(scratch, [
      stepEnd({ workflow: "review", stepId: "1", model: "m1", role: "reviewer" }),
    ]);

    const runtime = await buildTestRuntime(scratch);
    const out: string[] = [];
    await runPrint({
      runtime,
      prompt: "/workflow forecast review --json",
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
    });
    await runtime.dispose();

    const parsed = JSON.parse(out.join(""));
    expect(parsed.workflow).toBe("review");
    expect(parsed.stages).toHaveLength(1);
    expect(parsed.stages[0].stepId).toBe("1");
  });

  it("names the workflow when it does not exist", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const err: string[] = [];
    const result = await runPrint({
      runtime,
      prompt: "/workflow forecast ghost",
      stdout: () => {},
      stderr: (chunk) => err.push(chunk),
    });
    await runtime.dispose();
    expect(result.exitCode).not.toBe(0);
    expect(err.join("")).toContain('No workflow named "ghost"');
  });

  it("prints the run-start banner before a real run begins", async () => {
    const scratch = await makeScratch();
    await writeRole(
      scratch,
      "reviewer",
      "---\nname: reviewer\ndescription: Reads only\ntools: read\n---\nReview.\n",
    );
    await writeWorkflow(
      scratch,
      "review",
      ["---", "name: review", "---", "1. @reviewer Review: {{input}}", ""].join("\n"),
    );
    // History for step "1" under ANY model, so the banner has something to
    // say regardless of which model the subagent default resolves to.
    await writeLedger(scratch, [
      stepEnd({ workflow: "review", stepId: "1", model: "some-model", role: "reviewer" }),
      runEnd({ workflow: "review", runId: "r1" }),
    ]);

    const runtime = await buildTestRuntime(scratch, [{ text: "done" }]);
    const out: string[] = [];
    await runPrint({
      runtime,
      prompt: "/workflow review go",
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
    });
    await runtime.dispose();

    expect(out.join("")).toContain("forecast:");
  });

  it("never blocks a run when the ledger is missing entirely", async () => {
    const scratch = await makeScratch();
    await writeRole(scratch, "reviewer", "---\nname: reviewer\ntools: read\n---\nReview.\n");
    await writeWorkflow(
      scratch,
      "review",
      ["---", "name: review", "---", "1. @reviewer Review: {{input}}", ""].join("\n"),
    );
    const runtime = await buildTestRuntime(scratch, [{ text: "done" }]);
    const out: string[] = [];
    const result = await runPrint({
      runtime,
      prompt: "/workflow review go",
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
    });
    await runtime.dispose();
    // No ledger at all: forecast reads back empty, the banner says so, and
    // the run itself still completes.
    expect(out.join("")).toContain("forecast: no history for this workflow yet");
    expect(result.exitCode).toBe(0);
  });
});
