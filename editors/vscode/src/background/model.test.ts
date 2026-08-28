/**
 * The judgements a background-agent tree makes.
 *
 * Two of them carry real weight. Deciding *which agents just finished* is what
 * a notification is built on, and getting it wrong means either announcing
 * work the user has already seen or silently missing the one thing they were
 * waiting for. Deciding *when to stop polling* is what keeps a background
 * feature from having a foreground cost.
 */

import { describe, expect, it } from "vitest";
import {
  type AgentState,
  type AgentSummary,
  actionsFor,
  agentDescription,
  agentDetail,
  anyLive,
  formatElapsed,
  newlyFinished,
  stateIcon,
  stateSnapshot,
} from "./model.js";

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "bg-1",
    sessionId: "sess-1",
    task: "audit the auth module",
    modelId: "glm-5.2",
    status: "running",
    createdAt: 0,
    elapsedMs: 12_000,
    costUsd: 0,
    ...over,
  };
}

describe("knowing when to stop polling", () => {
  it("keeps going while anything is running", () => {
    expect(anyLive([agent({ status: "done" }), agent({ id: "b" })])).toBe(true);
  });

  it("stops once everything has settled", () => {
    // A tree that polled forever would be a background feature with a
    // foreground cost.
    expect(anyLive([agent({ status: "done" }), agent({ id: "b", status: "failed" })])).toBe(false);
    expect(anyLive([])).toBe(false);
  });
});

describe("noticing what just finished", () => {
  it("reports an agent that was running and now is not", () => {
    const before = stateSnapshot([agent({ status: "running" })]);
    const finished = newlyFinished(before, [agent({ status: "done" })]);
    expect(finished.map((entry) => entry.id)).toEqual(["bg-1"]);
  });

  it("says nothing about one that was already finished last time", () => {
    const before = stateSnapshot([agent({ status: "done" })]);
    expect(newlyFinished(before, [agent({ status: "done" })])).toEqual([]);
  });

  it("says nothing on the very first listing", () => {
    // Otherwise attaching to an engine with a week of history announces every
    // agent in it at once.
    expect(newlyFinished(new Map(), [agent({ status: "done" })])).toEqual([]);
  });

  it("catches two finishing between polls, which a count could not", () => {
    const before = stateSnapshot([agent({ id: "a" }), agent({ id: "b" })]);
    const finished = newlyFinished(before, [
      agent({ id: "a", status: "done" }),
      agent({ id: "b", status: "failed" }),
    ]);
    expect(finished.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  it("is not fooled by an agent dropping out of the listing", () => {
    // A count-based comparison would read an eviction as a completion and
    // announce work that never finished.
    const before = stateSnapshot([agent({ id: "a" }), agent({ id: "b" })]);
    expect(newlyFinished(before, [agent({ id: "a" })])).toEqual([]);
  });

  it("reports an interruption, which is news even though nothing failed", () => {
    // The agent did not fail — the process holding it went away. A user
    // waiting on it needs to know it stopped.
    const before = stateSnapshot([agent({ status: "running" })]);
    expect(newlyFinished(before, [agent({ status: "interrupted" })])).toHaveLength(1);
  });
});

describe("what a row offers to do", () => {
  it("offers cancel only while it is running", () => {
    expect(actionsFor(agent({ status: "running" })).cancel).toBe(true);
    expect(actionsFor(agent({ status: "done" })).cancel).toBe(false);
  });

  it("offers adopt once it has said something", () => {
    expect(actionsFor(agent({ status: "done", finalText: "here is what I found" })).adopt).toBe(
      true,
    );
  });

  it("offers adopt on a failure that still produced findings", () => {
    // Partial findings from an agent that died are still findings, and
    // refusing to hand them over makes the user copy them by hand.
    expect(
      actionsFor(agent({ status: "interrupted", finalText: "got as far as the login route" }))
        .adopt,
    ).toBe(true);
  });

  it("does not offer adopt for an agent with nothing to say", () => {
    expect(actionsFor(agent({ status: "failed" })).adopt).toBe(false);
    expect(actionsFor(agent({ status: "running", finalText: "partial" })).adopt).toBe(false);
  });
});

describe("what a row says", () => {
  it("names the state and how long it has taken", () => {
    expect(agentDescription(agent({ status: "running", elapsedMs: 90_000 }))).toBe(
      "running · 1m 30s",
    );
  });

  it("shows a cost only once there is one", () => {
    // `$0.00` on a job that has not reached a priced turn reads as "this was
    // free" rather than "nothing has been counted yet".
    expect(agentDescription(agent({ costUsd: 0 }))).not.toContain("$");
    expect(agentDescription(agent({ status: "done", costUsd: 0.42 }))).toContain("$0.42");
  });

  it("puts the failure reason ahead of the findings", () => {
    // Somebody reading a red row wants to know what went wrong, not what the
    // agent managed to say first.
    expect(
      agentDetail(agent({ status: "failed", error: "rate limited", finalText: "I was reading" })),
    ).toBe("rate limited");
  });

  it("falls back to the findings, then to the task", () => {
    expect(agentDetail(agent({ finalText: "found three things\nand more" }))).toBe(
      "found three things",
    );
    expect(agentDetail(agent({}))).toBe("audit the auth module");
  });

  it("gives an interruption its own icon, not the failure one", () => {
    // Different things to a person deciding whether to start it again.
    expect(stateIcon("interrupted")).not.toBe(stateIcon("failed"));
    expect(stateIcon("running")).toContain("~spin");
  });

  it("has an icon for every state the wire can carry", () => {
    const states: AgentState[] = ["running", "done", "failed", "cancelled", "interrupted"];
    for (const state of states) expect(stateIcon(state)).not.toBe("");
    expect(new Set(states.map(stateIcon)).size).toBe(states.length);
  });
});

describe("saying how long", () => {
  it("counts in whole units", () => {
    expect(formatElapsed(5_400)).toBe("5s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatElapsed(125_000)).toBe("2m 5s");
    expect(formatElapsed(3_660_000)).toBe("1h 1m");
  });

  it("says nothing about a duration that is not one", () => {
    expect(formatElapsed(Number.NaN)).toBe("");
    expect(formatElapsed(-1)).toBe("");
  });
});
