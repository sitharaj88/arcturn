import { describe, expect, it } from "vitest";
import type { AgentEvent, Usage } from "../serve/engine.js";
import {
  costBreakdown,
  costLabel,
  costTooltip,
  formatCost,
  formatCostTotal,
  initialCostState,
  reduceCost,
} from "./cost.js";

function usage(over: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

function turnEnd(over: Partial<Usage> = {}, turnIndex = 0): AgentEvent {
  return { type: "turnEnd", turnIndex, usage: usage(over) };
}

describe("formatCostTotal — the engine's honesty rules", () => {
  it("prints a complete total plainly", () => {
    expect(formatCostTotal(0.42, true)).toBe("$0.42");
  });

  it("marks a partial total as the floor it is", () => {
    expect(formatCostTotal(0.42, false)).toBe("$0.42+");
  });

  it("says n/a rather than $0.00 when nothing could be priced", () => {
    expect(formatCostTotal(0, false)).toBe("n/a");
  });

  it("keeps four decimals under a cent, like the CLI", () => {
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("reduceCost", () => {
  it("sums the cost the engine reported", () => {
    const state = [turnEnd({ costUsd: 0.25 }), turnEnd({ costUsd: 0.17 }, 1)].reduce(
      reduceCost,
      initialCostState,
    );
    expect(state.turns).toBe(2);
    expect(state.costUsd).toBeCloseTo(0.42, 10);
    expect(state.unpricedTurns).toBe(0);
    expect(costLabel(state)).toBe("$0.42");
  });

  it("counts a turn the engine could not price instead of scoring it as free", () => {
    const state = [turnEnd({ costUsd: 0.42 }), turnEnd({}, 1)].reduce(reduceCost, initialCostState);
    expect(state.costUsd).toBeCloseTo(0.42, 10);
    expect(state.unpricedTurns).toBe(1);
    expect(costLabel(state)).toBe("$0.42+");
  });

  it("reports n/a for a model that publishes no pricing at all", () => {
    const state = [turnEnd({}), turnEnd({}, 1)].reduce(reduceCost, initialCostState);
    expect(costLabel(state)).toBe("n/a");
  });

  it("shows $0.00 for a fresh session, which is complete and really is zero", () => {
    expect(costLabel(initialCostState)).toBe("$0.00");
  });

  it("accumulates token usage across turns", () => {
    const state = [
      turnEnd({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }),
      turnEnd({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 3 }, 1),
    ].reduce(reduceCost, initialCostState);
    expect(state.usage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    });
  });

  it("ignores every event that is not a turnEnd", () => {
    const state = reduceCost(initialCostState, { type: "turnStart", turnIndex: 0 });
    expect(state).toBe(initialCostState);
  });

  it("treats a nonsense cost as unpriced rather than poisoning the total", () => {
    const state = reduceCost(initialCostState, turnEnd({ costUsd: Number.NaN }));
    expect(state.costUsd).toBe(0);
    expect(state.unpricedTurns).toBe(1);
  });
});

describe("cost breakdown", () => {
  it("names the unpriced turns so the quick-pick can explain the plus sign", () => {
    const state = [turnEnd({ costUsd: 1 }), turnEnd({}, 1)].reduce(reduceCost, initialCostState);
    const rows = costBreakdown(state);
    const labels = rows.map((row) => row.label);
    expect(labels).toContain("Total");
    expect(rows.find((row) => row.label === "Total")?.detail).toBe("$1.00+");
    expect(labels.join(" ")).toMatch(/unpriced/i);
  });

  it("tooltips a complete total without the caveat", () => {
    const state = reduceCost(initialCostState, turnEnd({ costUsd: 1 }));
    expect(costTooltip(state)).not.toMatch(/unpriced/i);
    expect(costTooltip(state)).toContain("$1.00");
  });
});
