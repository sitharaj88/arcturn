import { describe, expect, it } from "vitest";
import {
  bestMatch,
  DEFAULT_STOPWORDS,
  explainMatch,
  MIN_CONFIDENCE_SCORE,
  MIN_MARGIN_SCORE,
  searchTurns,
  stem,
  type TurnInfo,
} from "./rewind-search.js";

/** Build a minimal turn, defaulting timestamp/fileCount so tests can focus on labels. */
function turn(overrides: Partial<TurnInfo> & Pick<TurnInfo, "id" | "label">): TurnInfo {
  return { timestamp: 0, fileCount: 0, ...overrides };
}

describe("stem", () => {
  it("collapses refactor/refactored/refactoring to the same form", () => {
    expect(stem("refactor")).toBe(stem("refactored"));
    expect(stem("refactor")).toBe(stem("refactoring"));
  });

  it("leaves short words alone rather than stripping them to nothing", () => {
    expect(stem("bus")).toBe("bus");
    expect(stem("is")).toBe("is");
  });

  it("strips a plain trailing s", () => {
    expect(stem("checkpoints")).toBe("checkpoint");
  });
});

describe("searchTurns", () => {
  it("ranks an exact phrase match above a partial word-overlap match", () => {
    const turns = [
      turn({ id: "weak", label: "Update login page styling" }),
      turn({ id: "exact", label: "Start the auth refactor: split token handling out" }),
    ];
    const results = searchTurns(turns, "auth refactor");
    expect(results[0]?.turn.id).toBe("exact");
    expect(results[0]?.why).toContain("exact phrase");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("ranks word overlap sensibly: more matching content words scores higher", () => {
    const turns = [
      turn({ id: "none", label: "Update the readme" }),
      turn({ id: "partial", label: "auth login cleanup" }), // 1 of 3 words: "auth"
      turn({ id: "full", label: "auth refactor session cleanup" }), // all 3: auth, refactor, cleanup
    ];
    const results = searchTurns(turns, "auth refactor cleanup");
    const byId = new Map(results.map((r) => [r.turn.id, r.score]));
    expect(byId.get("full")).toBeGreaterThan(byId.get("partial") ?? 0);
    expect(byId.get("partial")).toBeGreaterThan(byId.get("none") ?? 0);
  });

  it("matches refactor/refactored/refactoring interchangeably via stemming", () => {
    const turns = [turn({ id: "t1", label: "Refactored the auth session module" })];

    const viaBase = searchTurns(turns, "refactor auth")[0];
    const viaIng = searchTurns(turns, "refactoring auth")[0];

    expect(viaBase?.score).toBeGreaterThan(0);
    expect(viaIng?.score).toBeGreaterThan(0);
    expect(viaBase?.why).toContain("stemmed");
    expect(viaIng?.why).toContain("stemmed");
  });

  it("names the firing signal in `why`", () => {
    const turns = [turn({ id: "t1", label: "Fix the auth refactor bug" })];
    const exact = searchTurns(turns, "auth refactor")[0];
    expect(exact?.why).toMatch(/exact phrase/);

    const overlapTurns = [turn({ id: "t2", label: "auth login cleanup" })];
    const overlap = searchTurns(overlapTurns, "totally different words")[0];
    expect(overlap?.why).toMatch(/no query words matched|query words? matched/);
  });

  it("handles an empty corpus", () => {
    expect(searchTurns([], "anything")).toEqual([]);
  });

  it("handles an empty query without throwing, and scores everything low", () => {
    const turns = [
      turn({ id: "t1", label: "auth refactor" }),
      turn({ id: "t2", label: "unrelated" }),
    ];
    const results = searchTurns(turns, "");
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.score).toBeLessThan(MIN_CONFIDENCE_SCORE);
    }
  });

  it("uses recency only to break ties between otherwise-equal content matches", () => {
    const turns = [
      turn({ id: "older", label: "auth refactor cleanup", timestamp: 1000 }),
      turn({ id: "newer", label: "auth refactor cleanup", timestamp: 2000 }),
    ];
    const results = searchTurns(turns, "auth refactor cleanup");
    expect(results[0]?.turn.id).toBe("newer");
    // The gap must come from recency alone, and recency's ceiling is tiny.
    expect((results[0]?.score ?? 0) - (results[1]?.score ?? 0)).toBeLessThan(5);
  });

  it("never lets recency outrank a genuinely stronger content match", () => {
    const turns = [
      turn({ id: "strong-old", label: "the big auth refactor", timestamp: 1 }),
      turn({ id: "weak-new", label: "tweak css spacing", timestamp: 999_999 }),
    ];
    const results = searchTurns(turns, "auth refactor");
    expect(results[0]?.turn.id).toBe("strong-old");
  });
});

describe("bestMatch", () => {
  it("returns the turn for a clearly winning exact-phrase query", () => {
    const turns = [
      turn({ id: "unrelated", label: "Update dependency versions" }),
      turn({
        id: "target",
        label: "Start the auth refactor: split token handling out",
        fileCount: 3,
      }),
    ];
    const match = bestMatch(turns, "auth refactor");
    expect(match?.turn.id).toBe("target");
  });

  it("refuses a stopword-only query (no confident match)", () => {
    const turns = [
      turn({ id: "t1", label: "the a to my and" }),
      turn({ id: "t2", label: "auth refactor" }),
    ];
    expect(bestMatch(turns, "the a to my")).toBeUndefined();
  });

  it("refuses when two turns are equally good (ambiguous)", () => {
    const turns = [
      turn({ id: "a", label: "auth refactor cleanup", timestamp: 1000, fileCount: 2 }),
      turn({ id: "b", label: "auth refactor cleanup", timestamp: 1000, fileCount: 2 }),
    ];
    expect(bestMatch(turns, "auth refactor cleanup")).toBeUndefined();
  });

  it("refuses when the runner-up is within the margin even if not identical", () => {
    const turns = [
      turn({ id: "a", label: "auth refactor for login", timestamp: 1000 }),
      turn({ id: "b", label: "auth refactor for signup", timestamp: 1000 }),
    ];
    // Both share "auth refactor for" (3/4 words) against a 4-word query; near-identical scores.
    expect(bestMatch(turns, "auth refactor for accounts")).toBeUndefined();
  });

  it("picks the stronger match when the gap is genuine", () => {
    const turns = [
      turn({ id: "weak", label: "tweak css spacing" }),
      turn({ id: "strong", label: "auth refactor: split token handling out", fileCount: 4 }),
    ];
    const match = bestMatch(turns, "auth refactor");
    expect(match?.turn.id).toBe("strong");
  });

  it("handles an empty corpus", () => {
    expect(bestMatch([], "auth refactor")).toBeUndefined();
  });

  it("handles an empty query", () => {
    const turns = [turn({ id: "t1", label: "auth refactor" })];
    expect(bestMatch(turns, "")).toBeUndefined();
  });

  it("respects custom confidence/margin overrides", () => {
    const turns = [
      turn({ id: "a", label: "auth login cleanup" }),
      turn({ id: "b", label: "totally unrelated label" }),
    ];
    // "auth" alone against "auth login cleanup" (1/1 word, exact) scores well
    // above default confidence but let's force a stricter bar to prove the
    // override is honored.
    const withDefaults = bestMatch(turns, "auth");
    expect(withDefaults?.turn.id).toBe("a");
    const withStrictBar = bestMatch(turns, "auth", { minConfidence: 1000 });
    expect(withStrictBar).toBeUndefined();
  });

  it("respects a custom margin override", () => {
    // Two turns close but not identical in score; the default margin
    // (MIN_MARGIN_SCORE) refuses to call it, but a caller that accepts a
    // smaller gap can opt into a looser bar.
    const turns = [
      turn({ id: "a", label: "auth refactor for login" }),
      turn({ id: "b", label: "auth refactor for signup" }),
    ];
    const strict = bestMatch(turns, "auth refactor for accounts");
    expect(strict).toBeUndefined();
    const loose = bestMatch(turns, "auth refactor for accounts", { minMargin: 0 });
    expect(loose).toBeDefined();
    expect(MIN_MARGIN_SCORE).toBeGreaterThan(0);
  });
});

describe("explainMatch", () => {
  it("names the signal and mentions file count", () => {
    const turns = [turn({ id: "t1", label: "Start the auth refactor", fileCount: 3 })];
    const match = searchTurns(turns, "auth refactor")[0];
    expect(match).toBeDefined();
    const explanation = explainMatch(match!);
    expect(explanation).toContain("auth refactor");
    expect(explanation).toContain("3 files changed");
  });

  it("uses singular 'file' for a single-file turn", () => {
    const turns = [turn({ id: "t1", label: "Start the auth refactor", fileCount: 1 })];
    const match = searchTurns(turns, "auth refactor")[0]!;
    expect(explainMatch(match)).toContain("1 file changed");
  });
});

describe("DEFAULT_STOPWORDS sanity", () => {
  it("keeps the stopword list small and lowercase", () => {
    for (const word of DEFAULT_STOPWORDS) {
      expect(word).toBe(word.toLowerCase());
    }
    expect(DEFAULT_STOPWORDS.size).toBeLessThan(40);
  });
});
