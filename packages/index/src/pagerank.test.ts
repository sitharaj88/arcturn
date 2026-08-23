import { describe, expect, it } from "vitest";
import { type PageRankAdjacency, pageRank } from "./pagerank.js";

/**
 * `A → C`, `B → C`, `C → A`.
 *
 * Solved by hand with uniform teleport and d = 0.85:
 *
 * ```text
 *   rB = 0.05
 *   rA = 0.05 + 0.85·rC
 *   rC = 0.05 + 0.85·(rA + rB) = 0.0925 + 0.85·rA
 *   ⇒ rA(1 − 0.7225) = 0.128625 ⇒ rA = 343/740, rC = 360/740
 * ```
 */
const TRIANGLE: PageRankAdjacency = [
  [{ to: 2, weight: 1 }],
  [{ to: 2, weight: 1 }],
  [{ to: 0, weight: 1 }],
];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe("pageRank", () => {
  it("converges to the hand-computed solution of a three-node graph", () => {
    const { ranks, converged } = pageRank(TRIANGLE);

    expect(converged).toBe(true);
    expect(ranks[0]).toBeCloseTo(343 / 740, 6);
    expect(ranks[1]).toBeCloseTo(0.05, 6);
    expect(ranks[2]).toBeCloseTo(360 / 740, 6);
    expect(sum(ranks)).toBeCloseTo(1, 10);
  });

  it("redistributes dangling mass instead of losing it", () => {
    // A → B; B has no out-edges; C is isolated. Both B and C are dangling, so
    // their rank must flow back through the teleport vector. By hand:
    //   rA = rC = 1/3.85, rB = 1.85/3.85.
    const { ranks } = pageRank([[{ to: 1, weight: 1 }], [], []]);

    expect(ranks[0]).toBeCloseTo(1 / 3.85, 6);
    expect(ranks[1]).toBeCloseTo(1.85 / 3.85, 6);
    expect(ranks[2]).toBeCloseTo(1 / 3.85, 6);
    expect(sum(ranks)).toBeCloseTo(1, 10);
  });

  it("moves rank onto the personalised node", () => {
    // The same triangle, teleporting only to C:
    //   rA = 0.85·rC, rB = 0, rC = 0.15 + 0.85·rA ⇒ rA = 17/37, rC = 20/37.
    const { ranks } = pageRank(TRIANGLE, { personalization: [0, 0, 1] });

    expect(ranks[0]).toBeCloseTo(17 / 37, 6);
    expect(ranks[1]).toBeCloseTo(0, 6);
    expect(ranks[2]).toBeCloseTo(20 / 37, 6);
    expect(sum(ranks)).toBeCloseTo(1, 10);
    // B kept 0.05 of the rank under uniform teleport and loses all of it here.
    expect(ranks[1] ?? 1).toBeLessThan(pageRank(TRIANGLE).ranks[1] ?? 0);
  });

  it("weights edges: the heavier target takes more of the source's rank", () => {
    const { ranks } = pageRank([
      [
        { to: 1, weight: 9 },
        { to: 2, weight: 1 },
      ],
      [],
      [],
    ]);

    expect(ranks[1] ?? 0).toBeGreaterThan(ranks[2] ?? 0);
    expect(sum(ranks)).toBeCloseTo(1, 10);
  });

  it("sums parallel edges between the same pair", () => {
    const merged = pageRank([[{ to: 1, weight: 3 }], [{ to: 0, weight: 1 }]]);
    const parallel = pageRank([
      [
        { to: 1, weight: 1 },
        { to: 1, weight: 2 },
      ],
      [{ to: 0, weight: 1 }],
    ]);

    expect(parallel.ranks[0]).toBeCloseTo(merged.ranks[0] ?? 0, 12);
    expect(parallel.ranks[1]).toBeCloseTo(merged.ranks[1] ?? 0, 12);
  });

  it("handles an empty graph", () => {
    expect(pageRank([])).toEqual({ ranks: [], iterations: 0, converged: true });
  });

  it("handles a single node, with and without a self-loop", () => {
    expect(pageRank([[]]).ranks).toEqual([1]);
    expect(pageRank([[{ to: 0, weight: 1 }]]).ranks).toEqual([1]);
  });

  it("treats unusable edges as no edge at all", () => {
    // Zero, negative, non-finite, and out-of-range destinations all leave the
    // node dangling rather than dividing by a zero out-weight.
    for (const edge of [
      { to: 1, weight: 0 },
      { to: 1, weight: -3 },
      { to: 1, weight: Number.NaN },
      { to: 9, weight: 1 },
    ]) {
      const { ranks } = pageRank([[edge], []]);
      expect(ranks[0]).toBeCloseTo(0.5, 10);
      expect(ranks[1]).toBeCloseTo(0.5, 10);
    }
  });

  it("falls back to uniform teleport for an unusable personalization vector", () => {
    const uniform = pageRank(TRIANGLE).ranks;

    for (const personalization of [
      [1, 2],
      [0, 0, 0],
      [Number.NaN, -1, 0],
    ]) {
      expect(pageRank(TRIANGLE, { personalization }).ranks).toEqual(uniform);
    }
  });

  it("reports when the iteration cap stopped it short", () => {
    const capped = pageRank(TRIANGLE, { maxIterations: 1 });

    expect(capped.converged).toBe(false);
    expect(capped.iterations).toBe(1);
    expect(sum(capped.ranks)).toBeCloseTo(1, 10);
  });

  it("is deterministic", () => {
    expect(pageRank(TRIANGLE)).toEqual(pageRank(TRIANGLE));
  });
});
