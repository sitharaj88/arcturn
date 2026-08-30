import type { AgentEvent, Usage } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  costLimitMessage,
  createCostGuard,
  nearingCeiling,
  shouldAbortForCost,
  shouldAbortForTokens,
} from "./cost-guard.js";

const emptyUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function runStart(sessionId = "s1"): AgentEvent {
  return {
    type: "runStart",
    sessionId,
    prompt: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
  };
}

function turnEnd(turnIndex = 0): AgentEvent {
  return { type: "turnEnd", turnIndex, usage: emptyUsage };
}

describe("shouldAbortForCost", () => {
  it("is false below the limit", () => {
    expect(shouldAbortForCost(0.5, 1)).toBe(false);
  });

  it("is true at and above the limit", () => {
    expect(shouldAbortForCost(1, 1)).toBe(true);
    expect(shouldAbortForCost(1.5, 1)).toBe(true);
  });

  it("is false when the limit is 0, undefined-as-0, negative or non-finite", () => {
    expect(shouldAbortForCost(100, 0)).toBe(false);
    expect(shouldAbortForCost(100, -1)).toBe(false);
    expect(shouldAbortForCost(100, Number.NaN)).toBe(false);
    expect(shouldAbortForCost(100, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("treats a non-finite spend as not-over-limit", () => {
    expect(shouldAbortForCost(Number.NaN, 1)).toBe(false);
  });
});

describe("shouldAbortForTokens", () => {
  it("is false below and exactly at the limit — a count equal to its ceiling has not exceeded it", () => {
    expect(shouldAbortForTokens(999, 1_000)).toBe(false);
    expect(shouldAbortForTokens(1_000, 1_000)).toBe(false);
  });

  it("is true above the limit", () => {
    expect(shouldAbortForTokens(1_001, 1_000)).toBe(true);
    expect(shouldAbortForTokens(60_000_001, 60_000_000)).toBe(true);
  });

  it("is false when the limit is 0, undefined, negative or non-finite (disabled)", () => {
    expect(shouldAbortForTokens(1_000_000, 0)).toBe(false);
    expect(shouldAbortForTokens(1_000_000, undefined)).toBe(false);
    expect(shouldAbortForTokens(1_000_000, -1)).toBe(false);
    expect(shouldAbortForTokens(1_000_000, Number.NaN)).toBe(false);
    expect(shouldAbortForTokens(1_000_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("treats a non-finite spend as not-over-limit", () => {
    expect(shouldAbortForTokens(Number.NaN, 1_000)).toBe(false);
  });
});

describe("nearingCeiling", () => {
  it("is false below the fraction and true above it", () => {
    expect(nearingCeiling(0.79, 1, 0.8)).toBe(false);
    expect(nearingCeiling(0.81, 1, 0.8)).toBe(true);
    expect(nearingCeiling(79_999, 100_000, 0.8)).toBe(false);
    expect(nearingCeiling(80_001, 100_000, 0.8)).toBe(true);
  });

  it("fires at exactly the boundary — 80% consumed IS nearing", () => {
    // Neither `spent >= ceiling * fraction` nor `spent / ceiling >= fraction`
    // gets this on its own: the first rounds UP (`100 * 0.8` is not `80` in
    // IEEE doubles), the second rounds DOWN on decimal dollars (see below).
    expect(nearingCeiling(80, 100, 0.8)).toBe(true);
    expect(nearingCeiling(0.8, 1, 0.8)).toBe(true);
    expect(nearingCeiling(48_000_000, 60_000_000, 0.8)).toBe(true);
  });

  it("fires at the boundary for DECIMAL dollars, where one rounded division lands a ulp low", () => {
    // FAIL-FIRST: `2.4 / 3` is 0.7999999999999999, not 0.8 — a bare `>=`
    // against the ratio misses the exact boundary this predicate exists to
    // catch, for the most ordinary money there is ($2.40 of a $3.00 budget).
    expect(nearingCeiling(2.4, 3, 0.8)).toBe(true);
    expect(nearingCeiling(4.8, 6, 0.8)).toBe(true);
    expect(nearingCeiling(0.72, 0.9, 0.8)).toBe(true);
    expect(nearingCeiling(0.16, 0.2, 0.8)).toBe(true);
    // The pairs whose division happens to land exactly on (or a ulp above)
    // the boundary must keep firing too.
    expect(nearingCeiling(0.24, 0.3, 0.8)).toBe(true);
    expect(nearingCeiling(0.56, 0.7, 0.8)).toBe(true);
  });

  it("does not round a genuine near-miss up to the boundary", () => {
    // The tolerance is a few ulps of one division, not a fudge factor: a cent
    // under 80% of a $3.00 budget is still under it.
    expect(nearingCeiling(2.39, 3, 0.8)).toBe(false);
    expect(nearingCeiling(0.799, 1, 0.8)).toBe(false);
    expect(nearingCeiling(0.15, 0.2, 0.8)).toBe(false);
  });

  it("never nears a disabled limit — 0, undefined, negative or non-finite", () => {
    expect(nearingCeiling(1_000_000, 0, 0.8)).toBe(false);
    expect(nearingCeiling(1_000_000, undefined, 0.8)).toBe(false);
    expect(nearingCeiling(1_000_000, -5, 0.8)).toBe(false);
    expect(nearingCeiling(1_000_000, Number.NaN, 0.8)).toBe(false);
    expect(nearingCeiling(1_000_000, Number.POSITIVE_INFINITY, 0.8)).toBe(false);
  });

  it("treats a non-finite or negative spend as not-nearing", () => {
    expect(nearingCeiling(Number.NaN, 100, 0.8)).toBe(false);
    expect(nearingCeiling(Number.POSITIVE_INFINITY, 100, 0.8)).toBe(false);
    expect(nearingCeiling(-1, 100, 0.8)).toBe(false);
  });

  it("ignores a nonsensical fraction rather than arming at zero", () => {
    expect(nearingCeiling(50, 100, 0)).toBe(false);
    expect(nearingCeiling(50, 100, Number.NaN)).toBe(false);
  });

  it("still fires past 100% — over the ceiling is certainly near it", () => {
    expect(nearingCeiling(150, 100, 0.8)).toBe(true);
  });
});

describe("costLimitMessage", () => {
  it("names the limit and how to raise it", () => {
    expect(costLimitMessage(2)).toBe(
      "Cost limit $2.00 reached; run aborted. Raise it with --max-cost or /cost limit.",
    );
  });

  it("uses extra precision for sub-cent limits", () => {
    expect(costLimitMessage(0.001)).toBe(
      "Cost limit $0.0010 reached; run aborted. Raise it with --max-cost or /cost limit.",
    );
  });
});

describe("createCostGuard", () => {
  it("aborts exactly once when cost reaches the threshold", () => {
    let cost = 0;
    const abort = vi.fn();
    const notify = vi.fn();
    const guard = createCostGuard({ limitUsd: 1, getCostUsd: () => cost, abort, notify });

    guard.onEvent(runStart());

    cost = 0.4;
    guard.onEvent(turnEnd(0));
    expect(abort).not.toHaveBeenCalled();

    cost = 0.9;
    guard.onEvent(turnEnd(1));
    expect(abort).not.toHaveBeenCalled();

    cost = 1.2;
    guard.onEvent(turnEnd(2));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(
      "Cost limit $1.00 reached; run aborted. Raise it with --max-cost or /cost limit.",
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(abort.mock.calls[0]?.[0]);

    // Further turnEnd events past the threshold must not call abort again.
    cost = 1.5;
    guard.onEvent(turnEnd(3));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("never aborts when the limit is undefined or 0 (disabled)", () => {
    let cost = 0;
    const abortUndefined = vi.fn();
    const guardUndefined = createCostGuard({
      limitUsd: undefined,
      getCostUsd: () => cost,
      abort: abortUndefined,
    });
    const abortZero = vi.fn();
    const guardZero = createCostGuard({ limitUsd: 0, getCostUsd: () => cost, abort: abortZero });

    guardUndefined.onEvent(runStart());
    guardZero.onEvent(runStart());

    cost = 1_000_000;
    guardUndefined.onEvent(turnEnd(0));
    guardZero.onEvent(turnEnd(0));

    expect(abortUndefined).not.toHaveBeenCalled();
    expect(abortZero).not.toHaveBeenCalled();
  });

  it("ignores events other than turnEnd for the trip check", () => {
    const cost = 5;
    const abort = vi.fn();
    const guard = createCostGuard({ limitUsd: 1, getCostUsd: () => cost, abort });

    guard.onEvent(runStart());
    guard.onEvent({ type: "turnStart", turnIndex: 0 });
    guard.onEvent({ type: "notice", level: "info", text: "hello" });
    expect(abort).not.toHaveBeenCalled();

    guard.onEvent(turnEnd(0));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("re-arms on runStart, so a fresh run can trip the guard again", () => {
    const cost = 2;
    const abort = vi.fn();
    const guard = createCostGuard({ limitUsd: 1, getCostUsd: () => cost, abort });

    guard.onEvent(runStart("s1"));
    guard.onEvent(turnEnd(0));
    expect(abort).toHaveBeenCalledTimes(1);

    // Same run, more turns: must stay armed-off (no second abort call).
    guard.onEvent(turnEnd(1));
    expect(abort).toHaveBeenCalledTimes(1);

    // A new run (e.g. next prompt, /clear, or a resumed session) re-arms it.
    guard.onEvent(runStart("s2"));
    guard.onEvent(turnEnd(0));
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("reset() re-arms the guard without waiting for runStart", () => {
    const cost = 2;
    const abort = vi.fn();
    const guard = createCostGuard({ limitUsd: 1, getCostUsd: () => cost, abort });

    guard.onEvent(runStart());
    guard.onEvent(turnEnd(0));
    expect(abort).toHaveBeenCalledTimes(1);

    guard.reset();
    guard.onEvent(turnEnd(1));
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("calls notify with undefined-safe optionality when no notify is given", () => {
    const cost = 2;
    const abort = vi.fn();
    const guard = createCostGuard({ limitUsd: 1, getCostUsd: () => cost, abort });

    expect(() => {
      guard.onEvent(runStart());
      guard.onEvent(turnEnd(0));
    }).not.toThrow();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
