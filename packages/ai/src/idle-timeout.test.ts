import type { LLMClient, LLMRequest, StreamEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createFailoverClient } from "./failover.js";
import {
  DEFAULT_REQUEST_STALL_TIMEOUT_MS,
  type ScheduleTimeout,
  streamWithIdleTimeout,
  withIdleTimeout,
} from "./idle-timeout.js";
import { streamWithRetry } from "./retry.js";
import { collect, modelSpec, terminal, textOf, userMessage } from "./test-helpers/fixtures.js";

const spec = modelSpec();
const request: LLMRequest = { model: spec, messages: [userMessage("hi")] };

// --- A deterministic, injectable clock ------------------------------------
//
// The watchdog arms exactly one timer at a time. The clock records every
// schedule/cancel so a test can prove the timer is *reset* on each event, and
// `fireLast()` fires the currently-armed timer on demand — no real time passes.

interface FakeTimer {
  fire: () => void;
  cancelled: boolean;
  fired: boolean;
}
function makeClock(): {
  schedule: ScheduleTimeout;
  fireLast: () => void;
  armed: () => boolean;
  scheduleCount: number;
  firedCount: number;
  everyTimerCancelledOrFired: () => boolean;
} {
  const timers: FakeTimer[] = [];
  let scheduleCount = 0;
  let firedCount = 0;
  return {
    schedule(_ms, fire) {
      scheduleCount++;
      const t: FakeTimer = { fire, cancelled: false, fired: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    fireLast() {
      const t = [...timers].reverse().find((x) => !x.cancelled && !x.fired);
      if (!t) throw new Error("no armed timer to fire");
      t.fired = true;
      firedCount++;
      t.fire();
    },
    armed() {
      return timers.some((t) => !t.cancelled && !t.fired);
    },
    get scheduleCount() {
      return scheduleCount;
    },
    get firedCount() {
      return firedCount;
    },
    everyTimerCancelledOrFired() {
      return timers.every((t) => t.cancelled || t.fired);
    },
  };
}

/** Let queued microtasks and the fake client's generator settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- A controllable fake provider ----------------------------------------
//
// Mimics a real adapter driven through `assembleStream`: a `silent` step waits
// on `request.signal` and, when it aborts, emits the aborted terminal exactly
// as `assembleStream` does — which is what the watchdog must reclassify.

type Step = { emit: StreamEvent } | "silent";

function startEvent(model = spec.id): StreamEvent {
  return { type: "start", model };
}
function textDelta(delta: string): StreamEvent {
  return { type: "textDelta", blockIndex: 0, delta };
}
function endEvent(text: string, model = spec.id): StreamEvent {
  return {
    type: "end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 0,
    },
  };
}
/** What `assembleStream` yields when the composed signal aborts mid-stream. */
function abortedEnd(partial: string, model = spec.id): StreamEvent {
  return {
    type: "end",
    message: {
      role: "assistant",
      content: partial ? [{ type: "text", text: partial }] : [],
      model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "aborted",
      timestamp: 0,
    },
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return; // never resolves; the watchdog always composes a signal
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function fakeClient(scripts: Step[][]): LLMClient & { calls: number } {
  let calls = 0;
  const client = {
    get calls() {
      return calls;
    },
    stream(req: LLMRequest): AsyncIterable<StreamEvent> {
      const script = scripts[Math.min(calls, scripts.length - 1)] ?? [];
      const partialSoFar: string[] = [];
      calls++;
      return (async function* () {
        for (const step of script) {
          if (step === "silent") {
            await waitForAbort(req.signal);
            yield abortedEnd(partialSoFar.join(""), req.model.id);
            return;
          }
          if (step.emit.type === "textDelta") partialSoFar.push(step.emit.delta);
          yield step.emit;
        }
      })();
    },
    async complete() {
      throw new Error("unused");
    },
  };
  return client as unknown as LLMClient & { calls: number };
}

describe("streamWithIdleTimeout", () => {
  it("exposes a generous default ceiling", () => {
    expect(DEFAULT_REQUEST_STALL_TIMEOUT_MS).toBe(120_000);
  });

  it("times out a stream that emits nothing after start", async () => {
    const clock = makeClock();
    const fake = fakeClient([[{ emit: startEvent() }, "silent"]]);
    const iter = streamWithIdleTimeout(fake, request, {
      timeoutMs: 1_000,
      schedule: clock.schedule,
    })[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toMatchObject({ type: "start" });

    const pending = iter.next(); // resumes: re-arm, then await the silent step
    await flush();
    expect(clock.armed()).toBe(true);
    clock.fireLast(); // idle watchdog fires

    const term = (await pending).value as StreamEvent;
    expect(term.type).toBe("error");
    if (term.type !== "error") throw new Error("unreachable");
    expect(term.error.kind).toBe("network");
    expect(term.error.message).toContain(spec.displayName);
    expect(term.error.message).toContain("requestStallTimeoutMs");
    expect((await iter.next()).done).toBe(true);
  });

  it("bounds time to the first event (dead connect)", async () => {
    const clock = makeClock();
    const fake = fakeClient([["silent"]]); // never even emits start
    const iter = streamWithIdleTimeout(fake, request, {
      timeoutMs: 1_000,
      schedule: clock.schedule,
    })[Symbol.asyncIterator]();

    const pending = iter.next();
    await flush();
    expect(clock.armed()).toBe(true); // armed before any event arrives
    clock.fireLast();

    const term = (await pending).value as StreamEvent;
    expect(term).toMatchObject({ type: "error", error: { kind: "network" } });
  });

  it("does NOT time out a slow-but-steady stream (idle, not duration)", async () => {
    const clock = makeClock();
    // Four non-terminal events then a natural end: a long turn, but never silent.
    const fake = fakeClient([
      [
        { emit: startEvent() },
        { emit: textDelta("a") },
        { emit: textDelta("b") },
        { emit: textDelta("c") },
        { emit: endEvent("abc") },
      ],
    ]);
    const events = await collect(
      streamWithIdleTimeout(fake, request, { timeoutMs: 1_000, schedule: clock.schedule }),
    );

    expect(textOf(events)).toBe("abc");
    expect(terminal(events).type).toBe("end");
    // One timer armed before the loop + one re-armed after each of the 4
    // non-terminal events = 5 arms, none fired, all reset/cleared: the timer is
    // reset on every event, so an arbitrarily long steady stream never trips it.
    expect(clock.scheduleCount).toBe(5);
    expect(clock.firedCount).toBe(0);
    expect(clock.everyTimerCancelledOrFired()).toBe(true);
  });

  it("times out when a stream goes silent mid-way, keeping partial output", async () => {
    const clock = makeClock();
    const fake = fakeClient([
      [
        { emit: startEvent() },
        { emit: textDelta("partial ") },
        { emit: textDelta("answer") },
        "silent",
      ],
    ]);
    const events: StreamEvent[] = [];
    const iter = streamWithIdleTimeout(fake, request, {
      timeoutMs: 1_000,
      schedule: clock.schedule,
    })[Symbol.asyncIterator]();

    // Drain the three non-terminal events.
    for (let i = 0; i < 3; i++) events.push((await iter.next()).value as StreamEvent);
    const pending = iter.next();
    await flush();
    clock.fireLast();
    const term = (await pending).value as StreamEvent;

    expect(textOf(events)).toBe("partial answer");
    expect(term.type).toBe("error");
    if (term.type !== "error") throw new Error("unreachable");
    expect(term.error.kind).toBe("network");
    // Partial content is preserved on the surfaced error message.
    expect(term.message.content).toEqual([{ type: "text", text: "partial answer" }]);
  });

  it("passes a genuine caller abort through unchanged (not reclassified)", async () => {
    const clock = makeClock();
    const controller = new AbortController();
    const fake = fakeClient([[{ emit: startEvent() }, "silent"]]);
    const iter = streamWithIdleTimeout(
      fake,
      { ...request, signal: controller.signal },
      { timeoutMs: 1_000, schedule: clock.schedule },
    )[Symbol.asyncIterator]();

    await iter.next(); // start
    const pending = iter.next();
    await flush();
    controller.abort(); // the *caller* cancels, not the watchdog

    const term = (await pending).value as StreamEvent;
    expect(term.type).toBe("end");
    if (term.type !== "end") throw new Error("unreachable");
    expect(term.message.stopReason).toBe("aborted");
    expect(clock.firedCount).toBe(0);
  });

  it("disables the watchdog when timeoutMs is 0 (no timer scheduled)", async () => {
    const clock = makeClock();
    const fake = fakeClient([[{ emit: startEvent() }, { emit: endEvent("done") }]]);
    const events = await collect(
      streamWithIdleTimeout(fake, request, { timeoutMs: 0, schedule: clock.schedule }),
    );
    expect(clock.scheduleCount).toBe(0);
    expect(terminal(events).type).toBe("end");
  });

  it("disables the watchdog when timeoutMs is negative", async () => {
    const clock = makeClock();
    const fake = fakeClient([[{ emit: startEvent() }, { emit: endEvent("done") }]]);
    await collect(
      streamWithIdleTimeout(fake, request, { timeoutMs: -1, schedule: clock.schedule }),
    );
    expect(clock.scheduleCount).toBe(0);
  });
});

describe("idle stall classification drives the real retry/failover chain", () => {
  it("is retried by streamWithRetry as a transient network error", async () => {
    const clock = makeClock();
    const fake = fakeClient([
      [{ emit: startEvent() }, "silent"], // attempt 1: stalls -> network
      [{ emit: startEvent() }, { emit: endEvent("recovered") }], // attempt 2: succeeds
    ]);
    const guarded = withIdleTimeout(fake, { timeoutMs: 1_000, schedule: clock.schedule });

    const iter = streamWithRetry(guarded, request, {
      sleep: async () => {},
      maxAttempts: 3,
    })[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toMatchObject({ type: "start" }); // from attempt 1

    const pending = iter.next();
    await flush();
    clock.fireLast(); // attempt 1 stalls; real retry must re-attempt

    const term = (await pending).value as StreamEvent;
    expect(term.type).toBe("end");
    if (term.type !== "end") throw new Error("unreachable");
    expect(term.message.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(fake.calls).toBe(2); // proves streamWithRetry treated the stall as retryable
  });

  it("is failed over by streamFailover to the next model", async () => {
    const clock = makeClock();
    const stalling = withIdleTimeout(fakeClient([[{ emit: startEvent() }, "silent"]]), {
      timeoutMs: 1_000,
      schedule: clock.schedule,
    });
    const healthy = fakeClient([[{ emit: startEvent("m2") }, { emit: endEvent("from B", "m2") }]]);
    const chain = createFailoverClient([{ client: stalling }, { client: healthy }]);

    const iter = chain.stream(request)[Symbol.asyncIterator]();
    const pending = iter.next(); // failover buffers A's start, then awaits the silent step
    await flush();
    clock.fireLast(); // A stalls -> network -> failover switches to B

    const first = (await pending).value as StreamEvent;
    expect(first).toMatchObject({ type: "start", model: "m2" });
    const second = (await iter.next()).value as StreamEvent;
    expect(second.type).toBe("end");
    if (second.type !== "end") throw new Error("unreachable");
    expect(second.message.content).toEqual([{ type: "text", text: "from B" }]);
  });
});
