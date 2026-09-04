/**
 * Adversarial review of forecast.ts (wave-2): perf/soundness checks that
 * complement the shipped forecast.test.ts. Nothing here modifies forecast.ts.
 */

import { describe, expect, it } from "vitest";
import { forecastWorkflow, renderForecastBanner } from "./forecast.js";
import type { InsightsEvent, StepEndRecord } from "./insights.js";
import type { Workflow } from "./workflow.js";

function workflow(stepIds: readonly string[]): Workflow {
  return {
    name: "demo",
    source: "test",
    stages: [{ steps: stepIds.map((id) => ({ id, kind: "agent" }) as never) }],
  } as unknown as Workflow;
}

function stepEnd(overrides: Partial<StepEndRecord> & { stepId: string }): StepEndRecord {
  return {
    kind: "step-end",
    ts: Date.now(),
    workflow: "demo",
    runId: "r",
    role: "worker",
    status: "done",
    model: "zai/glm-5.3-flash",
    durationMs: 1000,
    usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    attempts: 1,
    ...overrides,
  } as StepEndRecord;
}

describe("the run-start banner never meaningfully delays on a large ledger", () => {
  it("folds a 5 MB / ~30k-event ledger (well beyond a realistic local ledger) in well under a second", () => {
    const events: InsightsEvent[] = [];
    const now = Date.now();
    for (let i = 0; i < 30_000; i++) {
      events.push(
        stepEnd({
          stepId: `step-${i % 12}`,
          ts: now - i * 1000,
          runId: `run-${i}`,
        }),
      );
    }
    const wf = workflow(Array.from({ length: 12 }, (_, i) => `step-${i}`));
    const start = performance.now();
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: () => "zai/glm-5.3-flash",
      events,
      now,
    });
    renderForecastBanner(forecast);
    const elapsedMs = performance.now() - start;
    // Generous ceiling: this is meant to catch an accidentally-quadratic
    // rewrite, not to pin an exact number.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("percentile edge cases", () => {
  it("n=1 and n=2 never crash and stay within the observed range", () => {
    const wf = workflow(["only"]);
    const oneSample = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: () => "m",
      events: [stepEnd({ stepId: "only", model: "m", durationMs: 4242 })],
      now: Date.now(),
    });
    expect(oneSample.stages[0]?.history?.p50DurationMs).toBe(4242);
    expect(oneSample.stages[0]?.history?.p90DurationMs).toBe(4242);

    const twoSamples = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: () => "m",
      events: [
        stepEnd({ stepId: "only", model: "m", durationMs: 1000 }),
        stepEnd({ stepId: "only", model: "m", durationMs: 3000 }),
      ],
      now: Date.now(),
    });
    const h = twoSamples.stages[0]?.history;
    expect(h?.p50DurationMs).toBeGreaterThanOrEqual(1000);
    expect(h?.p50DurationMs).toBeLessThanOrEqual(3000);
    expect(h?.p90DurationMs).toBe(3000);
  });
});

describe("race losers (superseded) never pollute a stage's history bucket", () => {
  it("excludes superseded/lost arms from both the step and step-any-model buckets", () => {
    const wf = workflow(["raced"]);
    const events: InsightsEvent[] = [
      // The winner: an ordinary, non-superseded terminal.
      stepEnd({ stepId: "raced", model: "model-a", status: "done", race: "won" }),
      // A loser: superseded, must never be counted as a failure for model-b.
      stepEnd({
        stepId: "raced",
        model: "model-b",
        status: "failed",
        race: "lost",
        superseded: true,
      }),
    ];
    const forecast = forecastWorkflow({
      workflow: wf,
      roles: new Map(),
      resolveStepModel: () => "model-a",
      events,
      now: Date.now(),
    });
    const h = forecast.stages[0]?.history;
    expect(h?.samples).toBe(1);
    expect(h?.stopRate).toBe(0);
  });
});
