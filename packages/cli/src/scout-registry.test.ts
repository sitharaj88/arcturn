/**
 * The record that made `/scout` reachable from a socket.
 *
 * `built-in-commands.ts` refused the verb for a specific reason: a scout run
 * left nothing behind, so there was nothing to report on and nothing to
 * cancel. These are the claims that reason turns into — the run is observable
 * while it is still going, a cancel actually reaches the scouts, and a run cut
 * short keeps what it had rather than being thrown away.
 *
 * `runScouts` is injected so a test can settle approaches on its own schedule.
 * That is not a shortcut around the real thing: the real `runScouts` needs a
 * git repository, worktrees and a model, and none of those would make the
 * *registry's* behaviour any more true. What they would make is a suite that
 * cannot express "one approach has settled and the other has not", which is
 * the state every claim here is about.
 */

import { describe, expect, it } from "vitest";
import { ScoutRegistry, scoutRunCost } from "./scout-registry.js";
import type { ScoutApproach, ScoutReport, ScoutResult } from "./scouts.js";

const TWO: ScoutApproach[] = [
  { name: "zustand", task: "use zustand" },
  { name: "redux", task: "use redux" },
];

function result(over: Partial<ScoutResult> = {}): ScoutResult {
  return {
    name: "zustand",
    task: "use zustand",
    status: "finished",
    finalText: "done",
    toolCalls: ["read", "write"],
    durationMs: 1200,
    diff: "diff --git a/x b/x\n",
    ...over,
  };
}

/** A registry whose run resolves only when the test says so. */
function controllable() {
  let settleRun: ((report: ScoutReport) => void) | undefined;
  let failRun: ((error: Error) => void) | undefined;
  let emit: ((result: ScoutResult) => void) | undefined;
  let seenSignal: AbortSignal | undefined;

  const registry = new ScoutRegistry({
    run: ({ signal, onResult }) => {
      seenSignal = signal;
      emit = onResult;
      return new Promise<ScoutReport>((resolve, reject) => {
        settleRun = resolve;
        failRun = reject;
      });
    },
  });

  return {
    registry,
    /** Stand in for one scout finishing while the others keep going. */
    settleOne: (over?: Partial<ScoutResult>) => emit?.(result(over)),
    finish: (report: Partial<ScoutReport> = {}) =>
      settleRun?.({
        results: [result()],
        deadlineMs: 60_000,
        durationMs: 5_000,
        timedOut: false,
        warnings: [],
        ...report,
      }),
    fail: (message: string) => failRun?.(new Error(message)),
    get aborted() {
      return seenSignal?.aborted ?? false;
    },
  };
}

/** Let the registry's own `.then` handlers run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("starting a run", () => {
  it("hands back an id immediately, without waiting for the run", async () => {
    // The whole reason the verb exists in this shape: a request that blocked
    // for minutes could not be reported on or cancelled.
    const harness = controllable();
    const id = harness.registry.start(TWO);
    expect(id).not.toBe("");
    expect(harness.registry.get(id)?.state).toBe("running");
  });

  it("refuses a single approach, because one approach is not a comparison", () => {
    const harness = controllable();
    expect(() => harness.registry.start([TWO[0] as ScoutApproach])).toThrow(/at least two/i);
  });

  it("gives each run its own id", () => {
    const harness = controllable();
    expect(harness.registry.start(TWO)).not.toBe(harness.registry.start(TWO));
  });
});

describe("watching a run that is still going", () => {
  it("shows a settled approach before the slowest one finishes", async () => {
    // This is what a blocking request could not do, and what a client watching
    // two approaches needs: the first result, while the second is still out.
    const harness = controllable();
    const id = harness.registry.start(TWO);

    harness.settleOne({ name: "zustand" });

    const run = harness.registry.get(id);
    expect(run?.state).toBe("running");
    expect(run?.results.map((entry) => entry.name)).toEqual(["zustand"]);
  });

  it("keeps the diff, which outlives the worktree it was made in", () => {
    const harness = controllable();
    const id = harness.registry.start(TWO);
    harness.settleOne({ diff: "diff --git a/src/store.ts b/src/store.ts\n" });
    expect(harness.registry.get(id)?.results[0]?.diff).toContain("src/store.ts");
  });

  it("reports finished once the run resolves", async () => {
    const harness = controllable();
    const id = harness.registry.start(TWO);
    harness.finish();
    await settled();
    expect(harness.registry.get(id)?.state).toBe("finished");
  });

  it("records a run that threw, rather than taking the process down with it", async () => {
    // Nothing awaits the run, so an unobserved rejection would be fatal.
    const harness = controllable();
    const id = harness.registry.start(TWO);
    harness.fail("not a git repository");
    await settled();
    expect(harness.registry.get(id)).toMatchObject({
      state: "failed",
      error: "not a git repository",
    });
  });

  it("says nothing about a run it never had", () => {
    expect(controllable().registry.get("no-such-run")).toBeUndefined();
  });
});

describe("cancelling", () => {
  it("aborts the signal the run is watching", () => {
    // The abort is what makes `runScouts` tear its worktrees down, so a cancel
    // that did not reach the signal would leave directories behind.
    const harness = controllable();
    const id = harness.registry.start(TWO);
    expect(harness.registry.cancel(id)).toBe(true);
    expect(harness.aborted).toBe(true);
  });

  it("keeps what had already settled, because a cut-short comparison still reads", async () => {
    const harness = controllable();
    const id = harness.registry.start(TWO);
    harness.settleOne({ name: "zustand" });
    harness.registry.cancel(id);
    harness.finish({ results: [result({ name: "zustand" })], timedOut: true });
    await settled();

    const run = harness.registry.get(id);
    expect(run?.state).toBe("cancelled");
    expect(run?.results).toHaveLength(1);
  });

  it("does not call a cancelled run finished", async () => {
    // `runScouts` resolves normally after an abort — every worktree is still
    // cleaned up — so the resolution alone cannot tell the two apart.
    const harness = controllable();
    const id = harness.registry.start(TWO);
    harness.registry.cancel(id);
    harness.finish();
    await settled();
    expect(harness.registry.get(id)?.state).toBe("cancelled");
  });

  it("answers false for a run that is unknown or already settled", async () => {
    const harness = controllable();
    expect(harness.registry.cancel("no-such-run")).toBe(false);
    const id = harness.registry.start(TWO);
    harness.finish();
    await settled();
    expect(harness.registry.cancel(id)).toBe(false);
  });
});

describe("what a run cost", () => {
  it("adds up the priced results", () => {
    const run = {
      id: "r",
      state: "finished",
      approaches: TWO,
      results: [result({ costUsd: 0.25 }), result({ costUsd: 0.5 })],
      timedOut: false,
      warnings: [],
    };
    expect(scoutRunCost(run)).toBeCloseTo(0.75);
  });

  it("says unknown rather than zero when nothing was priced", () => {
    // A scout on an unpriced model has an unknown cost, and summing it as zero
    // would report a run as cheaper than it was — the rule `/cost` keeps.
    const run = {
      id: "r",
      state: "finished",
      approaches: TWO,
      results: [result(), result()],
      timedOut: false,
      warnings: [],
    };
    expect(scoutRunCost(run)).toBeUndefined();
  });
});

describe("not growing without bound", () => {
  it("drops the oldest settled runs past the cap", async () => {
    const harness = controllable();
    const registry = new ScoutRegistry({
      run: () =>
        Promise.resolve({
          results: [],
          deadlineMs: 1,
          durationMs: 1,
          timedOut: false,
          warnings: [],
        }),
      keep: 2,
    });
    const first = registry.start(TWO);
    await settled();
    registry.start(TWO);
    await settled();
    registry.start(TWO);
    await settled();

    expect(registry.get(first)).toBeUndefined();
    expect(registry.list()).toHaveLength(2);
    void harness;
  });

  it("never evicts a run that is still going", () => {
    // A forgotten running scout owns worktrees and can no longer be cancelled.
    const harness = controllable();
    const registry = new ScoutRegistry({
      run: ({ signal }) =>
        new Promise<ScoutReport>(() => {
          void signal;
        }),
      keep: 1,
    });
    const first = registry.start(TWO);
    registry.start(TWO);
    registry.start(TWO);

    expect(registry.get(first)?.state).toBe("running");
    expect(registry.list()).toHaveLength(3);
    void harness;
  });
});
