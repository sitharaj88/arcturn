import { describe, expect, it } from "vitest";
import { addUsage, calculateCostUsd, emptyUsage } from "./cost.js";
import { modelSpec } from "./test-helpers/fixtures.js";

describe("calculateCostUsd", () => {
  it("prices every token bucket", () => {
    const spec = modelSpec({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    const cost = calculateCostUsd(spec, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBe(3 + 15 + 0.3 + 3.75);
  });

  it("scales sub-million counts", () => {
    const spec = modelSpec({ cost: { input: 10, output: 20 } });
    expect(
      calculateCostUsd(spec, {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(0.02, 10);
  });

  it("falls back to the input rate for unspecified cache rates", () => {
    const spec = modelSpec({ cost: { input: 2, output: 4 } });
    expect(
      calculateCostUsd(spec, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(4);
  });

  it("returns undefined when the spec has no pricing", () => {
    const { cost: _omit, ...rest } = modelSpec();
    expect(calculateCostUsd(rest, emptyUsage())).toBeUndefined();
  });

  it("returns zero for an empty usage record", () => {
    expect(calculateCostUsd(modelSpec(), emptyUsage())).toBe(0);
  });
});

describe("addUsage", () => {
  it("sums each bucket", () => {
    const total = addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    );
    expect(total).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
  });

  // FIXTURE CHANGED (was: "drops stale cost"). Cost is priced once, at the
  // provider boundary; nothing downstream re-derives it. Dropping it here was
  // not discarding a stale estimate, it was destroying the only cost figure
  // that existed — precisely at the point two priced turns roll into a run
  // total. `@arcturn/core`'s addUsage always summed it; the two must agree.
  it("sums cost, so a run total keeps the money its turns were priced at", () => {
    const total = addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 },
      { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
    );
    expect(total.costUsd).toBeCloseTo(0.75, 10);
  });

  it("keeps the priced side when only one operand carries a cost", () => {
    const total = addUsage(
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 9 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
    );
    // A floor, not a fiction: the unpriced operand cannot be priced from here.
    expect(total.costUsd).toBe(9);
  });

  it("leaves cost ABSENT when neither side was priced (never a fabricated $0)", () => {
    const total = addUsage(emptyUsage(), {
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(total.costUsd).toBeUndefined();
    expect("costUsd" in total).toBe(false);
  });
});
