import { describe, expect, it } from "vitest";
import {
  contextPercent,
  formatCost,
  formatCostTotal,
  formatDuration,
  formatTodos,
  formatTokens,
  oneLine,
  totalTokens,
} from "./format.js";

describe("formatTokens", () => {
  it("scales to k and M", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(1_200_000)).toBe("1.20M");
  });

  it("survives nonsense input", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatCost", () => {
  it("keeps four decimals for sub-cent amounts", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(1.239)).toBe("$1.24");
  });
});

describe("formatCostTotal", () => {
  it("renders a complete total exactly like formatCost", () => {
    expect(formatCostTotal(0, true)).toBe("$0.00");
    expect(formatCostTotal(0.0034, true)).toBe("$0.0034");
    expect(formatCostTotal(1.239, true)).toBe("$1.24");
  });

  it("says n/a when nothing could be priced", () => {
    // "$0.00" here would read as "this session was free" when the truth is
    // "this model publishes no price".
    expect(formatCostTotal(0, false)).toBe("n/a");
  });

  it("marks a partly priced total as a floor", () => {
    expect(formatCostTotal(1.239, false)).toBe("$1.24+");
    expect(formatCostTotal(0.0034, false)).toBe("$0.0034+");
  });
});

describe("formatDuration", () => {
  it("switches units as time passes", () => {
    expect(formatDuration(900)).toBe("0s");
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(72_000)).toBe("1m12s");
    expect(formatDuration(3_840_000)).toBe("1h04m");
  });
});

describe("contextPercent", () => {
  it("clamps and rounds", () => {
    expect(contextPercent(0, 200_000)).toBe(0);
    expect(contextPercent(100_000, 200_000)).toBe(50);
    expect(contextPercent(400_000, 200_000)).toBe(100);
    expect(contextPercent(10, 0)).toBe(0);
  });
});

describe("totalTokens", () => {
  it("sums every bucket", () => {
    expect(
      totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    ).toBe(10);
  });
});

describe("oneLine", () => {
  it("collapses whitespace and clips with an ellipsis", () => {
    expect(oneLine("  a\n  b  ")).toBe("a b");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
    expect(oneLine("abc", 5)).toBe("abc");
  });
});

describe("formatTodos", () => {
  it("marks each status", () => {
    expect(
      formatTodos([
        { id: "1", text: "a", status: "pending" },
        { id: "2", text: "b", status: "inProgress" },
        { id: "3", text: "c", status: "done" },
      ]),
    ).toEqual(["☐ a", "◐ b", "☑ c"]);
  });
});
