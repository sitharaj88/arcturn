import { describe, expect, it } from "vitest";
import { type BisectVerdict, bisectTurns, cassetteProbe, formatBisectResult } from "./bisect.js";
import type { Cassette, CassetteStats } from "./vcr.js";
import { CassetteError } from "./vcr.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A probe backed by a fixed verdict array; records every index it was called with. */
function scriptedProbe(verdicts: readonly BisectVerdict[]): {
  probe: (upTo: number) => Promise<BisectVerdict>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    probe: async (upTo: number) => {
      calls.push(upTo);
      const verdict = verdicts[upTo];
      if (verdict === undefined) throw new Error(`no scripted verdict for index ${upTo}`);
      return verdict;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* bisectTurns                                                                 */
/* -------------------------------------------------------------------------- */

describe("bisectTurns", () => {
  it("finds the first bad index in a good/good/bad/bad sequence", async () => {
    const turns = ["t0", "t1", "t2", "t3"];
    const { probe, calls } = scriptedProbe(["good", "good", "bad", "bad"]);

    const result = await bisectTurns(turns, probe);

    expect(result.firstBadIndex).toBe(2);
    expect(result.item).toBe("t2");
    expect(result.confident).toBe(true);
    // O(log n): log2(4) = 2 probes, no duplicates.
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("all-good: reports no divergence", async () => {
    const turns = ["t0", "t1", "t2", "t3"];
    const { probe } = scriptedProbe(["good", "good", "good", "good"]);

    const result = await bisectTurns(turns, probe);

    expect(result.firstBadIndex).toBeUndefined();
    expect(result.item).toBeUndefined();
    expect(result.confident).toBe(true);
    expect(result.reason).toMatch(/no divergence/i);
  });

  it("all-bad: first bad index is 0", async () => {
    const turns = ["t0", "t1", "t2", "t3"];
    const { probe } = scriptedProbe(["bad", "bad", "bad", "bad"]);

    const result = await bisectTurns(turns, probe);

    expect(result.firstBadIndex).toBe(0);
    expect(result.item).toBe("t0");
    expect(result.confident).toBe(true);
  });

  it("single-element good", async () => {
    const { probe } = scriptedProbe(["good"]);
    const result = await bisectTurns(["only"], probe);
    expect(result.firstBadIndex).toBeUndefined();
    expect(result.confident).toBe(true);
  });

  it("single-element bad", async () => {
    const { probe } = scriptedProbe(["bad"]);
    const result = await bisectTurns(["only"], probe);
    expect(result.firstBadIndex).toBe(0);
    expect(result.item).toBe("only");
    expect(result.confident).toBe(true);
  });

  it('resolves a "skip" in the middle by stepping outward to the nearest decidable index', async () => {
    // n=8, first mid probed is index 3. Index 3 is "skip"; the search steps
    // outward to index 4 ("good"), which — under monotonicity — is enough to
    // know everything at or before it is also good, so it can safely advance
    // past the skip without ever needing to resolve it again.
    const turns = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
    const verdicts: BisectVerdict[] = [
      "good",
      "good",
      "good",
      "skip",
      "good",
      "good",
      "bad",
      "bad",
    ];
    const { probe, calls } = scriptedProbe(verdicts);

    const result = await bisectTurns(turns, probe);

    expect(result.firstBadIndex).toBe(6);
    expect(result.item).toBe("t6");
    expect(result.confident).toBe(true);
    // The skip at index 3 must have been probed and stepped past.
    expect(calls).toContain(3);
    expect(calls).toContain(4);
    // No duplicate probes.
    expect(new Set(calls).size).toBe(calls.length);
    // The probe log records the skip verdict too.
    const skipEntry = result.probes.find((entry) => entry.index === 3);
    expect(skipEntry?.verdict).toBe("skip");
  });

  it("reports confident: false when every probe near the search window is skip", async () => {
    // The skip sits immediately before the true boundary, so the final
    // shrunk window collapses exactly onto it with nowhere left to step.
    const turns = ["t0", "t1", "t2", "t3", "t4"];
    const verdicts: BisectVerdict[] = ["good", "good", "skip", "bad", "bad"];
    const { probe } = scriptedProbe(verdicts);

    const result = await bisectTurns(turns, probe);

    // Still finds the best answer it can (from stepping outward the first time)...
    expect(result.firstBadIndex).toBe(3);
    // ...but cannot fully vouch for it, since index 2 was never resolved.
    expect(result.confident).toBe(false);
    expect(result.reason).toMatch(/skip/i);
  });

  it("reports confident: false for a non-monotonic sequence when verify is on", async () => {
    // good, bad, good, bad — violates "once bad, stays bad".
    const turns = ["t0", "t1", "t2", "t3"];
    const verdicts: BisectVerdict[] = ["good", "bad", "good", "bad"];
    const { probe } = scriptedProbe(verdicts);

    const result = await bisectTurns(turns, probe, { verify: true });

    // The unqualified search still finds index 1 first.
    expect(result.firstBadIndex).toBe(1);
    expect(result.confident).toBe(false);
    expect(result.reason).toMatch(/not monotonically bad/i);
  });

  it("without verify, a non-monotonic sequence is not flagged (documents the limitation)", async () => {
    const turns = ["t0", "t1", "t2", "t3"];
    const verdicts: BisectVerdict[] = ["good", "bad", "good", "bad"];
    const { probe } = scriptedProbe(verdicts);

    const result = await bisectTurns(turns, probe);

    expect(result.firstBadIndex).toBe(1);
    expect(result.confident).toBe(true);
  });

  it("respects the maxProbes budget", async () => {
    const turns = Array.from({ length: 64 }, (_, i) => `t${i}`);
    const verdicts: BisectVerdict[] = turns.map((_, i) => (i < 40 ? "good" : "bad"));
    const { probe, calls } = scriptedProbe(verdicts);

    const result = await bisectTurns(turns, probe, { maxProbes: 2 });

    expect(calls.length).toBeLessThanOrEqual(2);
    expect(result.confident).toBe(false);
    expect(result.reason).toMatch(/budget/i);
  });

  it("probe log matches the calls made, in order, with no duplicates", async () => {
    const turns = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const verdicts: BisectVerdict[] = turns.map((_, i) => (i < 11 ? "good" : "bad"));
    const { probe, calls } = scriptedProbe(verdicts);

    const result = await bisectTurns(turns, probe);

    expect(result.firstBadIndex).toBe(11);
    expect(result.probes.map((entry) => entry.index)).toEqual(calls);
    expect(new Set(calls).size).toBe(calls.length);
    // log2(16) = 4; a handful more is fine but it must stay well under n.
    expect(calls.length).toBeLessThan(turns.length);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("handles an empty turn list", async () => {
    const { probe, calls } = scriptedProbe([]);
    const result = await bisectTurns([], probe);
    expect(result.firstBadIndex).toBeUndefined();
    expect(result.confident).toBe(true);
    expect(calls.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* cassetteProbe                                                              */
/* -------------------------------------------------------------------------- */

function fakeStats(overrides: Partial<CassetteStats> = {}): CassetteStats {
  return {
    llmTotal: 0,
    toolTotal: 0,
    llmConsumed: 0,
    toolConsumed: 0,
    misses: 0,
    unused: [],
    skippedLines: 0,
    ...overrides,
  };
}

function fakeCassette(file: string, stats: CassetteStats): Cassette {
  return {
    file,
    takeLlm: () => undefined,
    takeTool: () => undefined,
    stats: () => stats,
  };
}

describe("cassetteProbe", () => {
  it('classifies a clean run (stats().misses === 0) as "good"', async () => {
    const loaded: string[] = [];
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0", "p1", "p2"],
      async () => {
        // Clean run: nothing thrown.
      },
      {
        loadCassette: async (file) => {
          loaded.push(file);
          return fakeCassette(file, fakeStats({ misses: 0 }));
        },
      },
    );

    const verdict = await probe(1);
    expect(verdict).toBe("good");
    expect(loaded).toEqual(["fixtures/run.jsonl"]);
  });

  it('classifies a CassetteError "miss" thrown by runProbe as "bad"', async () => {
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0", "p1", "p2"],
      async () => {
        throw new CassetteError("no recorded response", "miss", { key: "abc", entryKind: "llm" });
      },
      {
        loadCassette: async (file) => fakeCassette(file, fakeStats()),
      },
    );

    const verdict = await probe(1);
    expect(verdict).toBe("bad");
  });

  it('classifies non-zero stats().misses (e.g. onMiss: "error-event") as "bad"', async () => {
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0", "p1"],
      async () => {
        // Run "completes" but left a miss behind.
      },
      {
        loadCassette: async (file) => fakeCassette(file, fakeStats({ misses: 1 })),
      },
    );

    const verdict = await probe(0);
    expect(verdict).toBe("bad");
  });

  it('classifies a corrupt cassette (load throws) as "skip"', async () => {
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0"],
      async () => {
        throw new Error("should not be called");
      },
      {
        loadCassette: async (file) => {
          throw new CassetteError(`Cassette ${file} has an unreadable entry`, "corrupt");
        },
      },
    );

    const verdict = await probe(0);
    expect(verdict).toBe("skip");
  });

  it('classifies a CassetteError "corrupt" thrown by runProbe as "skip"', async () => {
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0"],
      async () => {
        throw new CassetteError("bad line", "corrupt");
      },
      {
        loadCassette: async (file) => fakeCassette(file, fakeStats()),
      },
    );

    const verdict = await probe(0);
    expect(verdict).toBe("skip");
  });

  it("re-throws errors that are not CassetteError", async () => {
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0"],
      async () => {
        throw new Error("boom");
      },
      {
        loadCassette: async (file) => fakeCassette(file, fakeStats()),
      },
    );

    await expect(probe(0)).rejects.toThrow("boom");
  });

  it("loads a fresh cassette on every call (never reuses one across probes)", async () => {
    let loadCount = 0;
    const probe = cassetteProbe("fixtures/run.jsonl", ["p0", "p1", "p2"], async () => {}, {
      loadCassette: async (file) => {
        loadCount++;
        return fakeCassette(file, fakeStats({ misses: 0 }));
      },
    });

    await probe(0);
    await probe(1);
    await probe(2);
    expect(loadCount).toBe(3);
  });

  it("passes only the prompt prefix up to and including upTo", async () => {
    const seen: (readonly string[])[] = [];
    const probe = cassetteProbe(
      "fixtures/run.jsonl",
      ["p0", "p1", "p2", "p3"],
      async (_cassette, prompts) => {
        seen.push(prompts);
      },
      {
        loadCassette: async (file) => fakeCassette(file, fakeStats({ misses: 0 })),
      },
    );

    await probe(0);
    await probe(2);
    expect(seen[0]).toEqual(["p0"]);
    expect(seen[1]).toEqual(["p0", "p1", "p2"]);
  });
});

/* -------------------------------------------------------------------------- */
/* formatBisectResult                                                         */
/* -------------------------------------------------------------------------- */

describe("formatBisectResult", () => {
  it("names the first divergent turn, its label, and the probe trail", async () => {
    const turns = ["fix the bug", "add tests", "refactor the module", "ship it"];
    const { probe } = scriptedProbe(["good", "good", "bad", "bad"]);
    const result = await bisectTurns(turns, probe);

    const text = formatBisectResult(result);

    expect(text).toContain("turn 2");
    expect(text).toContain("refactor the module");
    expect(text).toContain("confident: yes");
    expect(text).toContain("Probe trail");
    for (const entry of result.probes) {
      expect(text).toContain(`turn ${entry.index}: ${entry.verdict}`);
    }
  });

  it("reports no divergence when every turn was good", async () => {
    const turns = ["a", "b", "c"];
    const { probe } = scriptedProbe(["good", "good", "good"]);
    const result = await bisectTurns(turns, probe);

    const text = formatBisectResult(result);
    expect(text).toMatch(/no divergence found/i);
  });

  it("supports a custom label function", async () => {
    interface Turn {
      readonly prompt: string;
    }
    const turns: Turn[] = [{ prompt: "a" }, { prompt: "b" }];
    const { probe } = scriptedProbe(["good", "bad"]);
    const result = await bisectTurns(turns, probe);

    const text = formatBisectResult(result, { label: (item) => `<<${item.prompt}>>` });
    expect(text).toContain("<<b>>");
  });

  it("falls back to a label field when present on a non-string item", async () => {
    interface TurnSummary {
      readonly id: string;
      readonly label: string;
    }
    const turns: TurnSummary[] = [
      { id: "t0", label: "first prompt" },
      { id: "t1", label: "second prompt" },
    ];
    const { probe } = scriptedProbe(["good", "bad"]);
    const result = await bisectTurns(turns, probe);

    const text = formatBisectResult(result);
    expect(text).toContain("second prompt");
  });

  it("reports low confidence in the formatted output", async () => {
    const turns = ["a", "b", "c", "d"];
    const { probe } = scriptedProbe(["good", "bad", "good", "bad"]);
    const result = await bisectTurns(turns, probe, { verify: true });

    const text = formatBisectResult(result);
    expect(text).toContain("confident: no");
  });
});
