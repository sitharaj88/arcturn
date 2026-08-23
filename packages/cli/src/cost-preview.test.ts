import type { ModelSpec } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  type CostEstimate,
  DEFAULT_TURNS_PER_STEP_HIGH,
  estimateCost,
  estimateFromHistory,
  estimateFromModel,
  formatEstimate,
  MEDIAN_CONFIDENCE_SAMPLE_SIZE,
  type TurnSample,
} from "./cost-preview.js";

function model(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    model: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    capabilities: { tools: true, vision: true, thinking: true, caching: true },
    ...overrides,
  };
}

function sample(costUsd: number, inputTokens = 4000, outputTokens = 800): TurnSample {
  return { inputTokens, outputTokens, costUsd };
}

describe("estimateFromHistory", () => {
  it("uses the median cost per turn, not the mean, so an outlier can't skew it", () => {
    // Nine cheap turns at $0.10, one wildly expensive outlier at $50.
    const history: TurnSample[] = [...Array.from({ length: 9 }, () => sample(0.1)), sample(50)];
    const estimate = estimateFromHistory(history, { steps: 4 });

    // Median of [0.1 x9, 50] is 0.1. Mean would be ~5.01 — wildly different.
    expect(estimate.basis).toBe("history");
    expect(estimate.turnsLow).toBe(4);
    expect(estimate.turnsHigh).toBe(4 * DEFAULT_TURNS_PER_STEP_HIGH);
    expect(estimate.usdLow).toBeCloseTo(4 * 0.1, 5);
    expect(estimate.usdHigh).toBeCloseTo(12 * 0.1, 5);
  });

  it("computes the median correctly for an even-length sample", () => {
    const history: TurnSample[] = [sample(0.2), sample(0.4), sample(0.6), sample(0.8)];
    // sorted: 0.2, 0.4, 0.6, 0.8 -> median = (0.4+0.6)/2 = 0.5
    const estimate = estimateFromHistory(history, { steps: 2 });
    expect(estimate.usdLow).toBeCloseTo(2 * 0.5, 5);
    expect(estimate.usdHigh).toBeCloseTo(6 * 0.5, 5);
  });

  it("reports the median tokens per turn as informational data", () => {
    const history: TurnSample[] = [
      sample(0.1, 1000, 100), // 1100
      sample(0.1, 3000, 300), // 3300
      sample(0.1, 5000, 500), // 5500
    ];
    const estimate = estimateFromHistory(history, { steps: 1 });
    expect(estimate.medianTokensPerTurn).toBe(3300);
  });

  it("returns low confidence below the sample-size threshold and medium at/above it", () => {
    const below = Array.from({ length: MEDIAN_CONFIDENCE_SAMPLE_SIZE - 1 }, () => sample(0.5));
    const atThreshold = Array.from({ length: MEDIAN_CONFIDENCE_SAMPLE_SIZE }, () => sample(0.5));
    const above = Array.from({ length: MEDIAN_CONFIDENCE_SAMPLE_SIZE + 5 }, () => sample(0.5));

    expect(estimateFromHistory(below, { steps: 2 }).confidence).toBe("low");
    expect(estimateFromHistory(atThreshold, { steps: 2 }).confidence).toBe("medium");
    expect(estimateFromHistory(above, { steps: 2 }).confidence).toBe("medium");
  });

  it("confidence rises strictly with sample size (never drops as more data arrives)", () => {
    const sizes = [1, 3, 8, 20];
    const confidences = sizes.map(
      (n) =>
        estimateFromHistory(
          Array.from({ length: n }, () => sample(0.5)),
          { steps: 2 },
        ).confidence,
    );
    const rank = { low: 0, medium: 1 } as const;
    for (let i = 1; i < confidences.length; i++) {
      expect(rank[confidences[i] as "low" | "medium"]).toBeGreaterThanOrEqual(
        rank[confidences[i - 1] as "low" | "medium"],
      );
    }
  });

  it("returns a well-formed, dollar-free estimate for an empty history", () => {
    const estimate = estimateFromHistory([], { steps: 3 });
    expect(estimate.basis).toBe("history");
    expect(estimate.sampleSize).toBe(0);
    expect(estimate.usdLow).toBeUndefined();
    expect(estimate.usdHigh).toBeUndefined();
    expect(estimate.confidence).toBe("low");
  });

  it("handles a zero-step plan without producing negative or NaN figures", () => {
    const estimate = estimateFromHistory([sample(1), sample(2)], { steps: 0 });
    expect(estimate.turnsLow).toBe(0);
    expect(estimate.turnsHigh).toBe(0);
    expect(estimate.usdLow).toBe(0);
    expect(estimate.usdHigh).toBe(0);
  });

  it("respects an injectable turnsPerStepHigh multiplier", () => {
    const estimate = estimateFromHistory([sample(1)], { steps: 5 }, { turnsPerStepHigh: 10 });
    expect(estimate.turnsLow).toBe(5);
    expect(estimate.turnsHigh).toBe(50);
  });

  it("always returns turnsLow <= turnsHigh and, when present, usdLow <= usdHigh", () => {
    const histories: TurnSample[][] = [
      [],
      [sample(0.5)],
      [sample(0.1), sample(0.2), sample(0.9)],
      Array.from({ length: 15 }, (_, i) => sample(i + 1)),
    ];
    for (const history of histories) {
      for (const steps of [0, 1, 4, 9]) {
        const estimate = estimateFromHistory(history, { steps });
        expect(estimate.turnsLow).toBeLessThanOrEqual(estimate.turnsHigh);
        if (estimate.usdLow !== undefined && estimate.usdHigh !== undefined) {
          expect(estimate.usdLow).toBeLessThanOrEqual(estimate.usdHigh);
        }
      }
    }
  });
});

describe("estimateFromModel", () => {
  it("prices from model.cost and the injected per-turn token assumptions", () => {
    const priced = model({ cost: { input: 3, output: 15 } });
    const estimate = estimateFromModel(
      priced,
      { steps: 2 },
      { inputTokensPerTurn: 1_000_000, outputTokensPerTurn: 1_000_000 },
    );
    // Per turn: 1M * $3/M + 1M * $15/M = $18.
    expect(estimate.basis).toBe("model");
    expect(estimate.turnsLow).toBe(2);
    expect(estimate.turnsHigh).toBe(2 * DEFAULT_TURNS_PER_STEP_HIGH);
    expect(estimate.usdLow).toBeCloseTo(2 * 18, 5);
    expect(estimate.usdHigh).toBeCloseTo(6 * 18, 5);
    expect(estimate.sampleSize).toBe(0);
  });

  it("returns basis 'unpriced' with no dollar figures when model.cost is absent", () => {
    const unpriced = model({ cost: undefined });
    const estimate = estimateFromModel(unpriced, { steps: 3 });
    expect(estimate.basis).toBe("unpriced");
    expect(estimate.usdLow).toBeUndefined();
    expect(estimate.usdHigh).toBeUndefined();
    expect(estimate.turnsLow).toBe(3);
    expect(estimate.turnsHigh).toBe(3 * DEFAULT_TURNS_PER_STEP_HIGH);
  });

  it("handles a zero-step plan without producing negative or NaN figures", () => {
    const priced = model({ cost: { input: 3, output: 15 } });
    const estimate = estimateFromModel(priced, { steps: 0 });
    expect(estimate.turnsLow).toBe(0);
    expect(estimate.turnsHigh).toBe(0);
    expect(estimate.usdLow).toBe(0);
    expect(estimate.usdHigh).toBe(0);
  });

  it("is always low confidence (it has no sample data)", () => {
    const estimate = estimateFromModel(model({ cost: { input: 1, output: 1 } }), { steps: 5 });
    expect(estimate.confidence).toBe("low");
    expect(estimate.sampleSize).toBe(0);
  });
});

describe("estimateCost", () => {
  it("falls back to the model estimator when history is empty", () => {
    const priced = model({ cost: { input: 3, output: 15 } });
    const withHistory = estimateCost({ history: [], plan: { steps: 4 }, model: priced });
    const direct = estimateFromModel(priced, { steps: 4 });
    expect(withHistory.basis).toBe("model");
    expect(withHistory).toEqual(direct);
  });

  it("falls back to the model estimator when history is omitted entirely", () => {
    const priced = model({ cost: { input: 3, output: 15 } });
    const estimate = estimateCost({ plan: { steps: 4 }, model: priced });
    expect(estimate.basis).toBe("model");
  });

  it("uses the history estimator when samples are present", () => {
    const estimate = estimateCost({
      history: [sample(1), sample(2), sample(3)],
      plan: { steps: 4 },
      model: model({ cost: { input: 3, output: 15 } }),
    });
    expect(estimate.basis).toBe("history");
  });
});

describe("formatEstimate", () => {
  const m = model({ cost: { input: 3, output: 15 } });

  it("formats a history-based estimate with the sample size", () => {
    const estimate: CostEstimate = {
      basis: "history",
      turnsLow: 8,
      turnsHigh: 24,
      usdLow: 1.2,
      usdHigh: 3.6,
      confidence: "medium",
      sampleSize: 12,
    };
    expect(formatEstimate(estimate, m)).toBe(
      "~8-24 turns · $1.20-$3.60 (based on 12 recent turns)",
    );
  });

  it("formats a model-based estimate as assumption-based", () => {
    const estimate: CostEstimate = {
      basis: "model",
      turnsLow: 8,
      turnsHigh: 24,
      usdLow: 1.2,
      usdHigh: 3.6,
      confidence: "low",
      sampleSize: 0,
    };
    expect(formatEstimate(estimate, m)).toBe(
      "~8-24 turns · $1.20-$3.60 (assumption-based on Claude Sonnet 5 pricing)",
    );
  });

  it("formats an unpriced estimate with no dollar figures", () => {
    const estimate: CostEstimate = {
      basis: "unpriced",
      turnsLow: 8,
      turnsHigh: 24,
      confidence: "low",
      sampleSize: 0,
    };
    expect(formatEstimate(estimate, m)).toBe("~8-24 turns · price unknown for Claude Sonnet 5");
  });

  it("collapses turnsLow===turnsHigh and usdLow===usdHigh to a single number", () => {
    const estimate: CostEstimate = {
      basis: "history",
      turnsLow: 0,
      turnsHigh: 0,
      usdLow: 0,
      usdHigh: 0,
      confidence: "low",
      sampleSize: 1,
    };
    expect(formatEstimate(estimate, m)).toBe("~0 turns · $0.00 (based on 1 recent turn)");
  });

  it("round-trips a real estimateFromHistory result through formatEstimate", () => {
    const history = Array.from({ length: 12 }, () => sample(0.3));
    const estimate = estimateFromHistory(history, { steps: 8 });
    expect(formatEstimate(estimate, m)).toContain("(based on 12 recent turns)");
    expect(formatEstimate(estimate, m)).toMatch(/^~8-24 turns · \$/);
  });
});
