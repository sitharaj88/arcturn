import type { AgentEvent, Usage } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { costLimitMessage, createCostGuard, shouldAbortForCost } from "./cost-guard.js";

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
