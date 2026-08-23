import type { AIError, LLMClient, LLMRequest, StreamEvent } from "@arcturn/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIError } from "./errors.js";
import {
  abortableSleep,
  computeBackoffDelay,
  DEFAULT_RETRY_OPTIONS,
  type RetryAttemptInfo,
  streamWithRetry,
  withRetry,
} from "./retry.js";
import { collect, modelSpec, terminal, userMessage } from "./test-helpers/fixtures.js";

const spec = modelSpec();
const request: LLMRequest = { model: spec, messages: [userMessage("hi")] };

function endEvent(text: string): StreamEvent {
  return {
    type: "end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: spec.id,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 0,
    },
  };
}

function errorEvent(error: AIError): StreamEvent {
  return {
    type: "error",
    error,
    message: {
      role: "assistant",
      content: [],
      model: spec.id,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "error",
      errorMessage: error.message,
      timestamp: 0,
    },
  };
}

/** A client that replays a scripted list of event sequences, one per attempt. */
function scriptedClient(attempts: StreamEvent[][]): LLMClient & { calls: number } {
  let calls = 0;
  const client = {
    get calls() {
      return calls;
    },
    stream(): AsyncIterable<StreamEvent> {
      const script = attempts[Math.min(calls, attempts.length - 1)] ?? [];
      calls++;
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
    async complete() {
      throw new Error("not used");
    },
  };
  return client as LLMClient & { calls: number };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("computeBackoffDelay", () => {
  it("grows exponentially with no jitter", () => {
    const options = { jitter: 0, initialDelayMs: 500, backoffFactor: 2 };
    expect(computeBackoffDelay(1, undefined, options)).toBe(500);
    expect(computeBackoffDelay(2, undefined, options)).toBe(1000);
    expect(computeBackoffDelay(3, undefined, options)).toBe(2000);
    expect(computeBackoffDelay(4, undefined, options)).toBe(4000);
  });

  it("caps at maxDelayMs", () => {
    expect(
      computeBackoffDelay(20, undefined, { jitter: 0, maxDelayMs: 30_000, initialDelayMs: 500 }),
    ).toBe(30_000);
  });

  it("shaves off at most `jitter` of the delay", () => {
    const full = computeBackoffDelay(2, undefined, { jitter: 0.25, random: () => 0 });
    const shaved = computeBackoffDelay(2, undefined, { jitter: 0.25, random: () => 1 });
    expect(full).toBe(1000);
    expect(shaved).toBe(750);
  });

  it("prefers a server-supplied retryAfterMs", () => {
    const error = createAIError("rateLimit", "slow", { retryAfterMs: 4321 });
    expect(computeBackoffDelay(1, error, { jitter: 0 })).toBe(4321);
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_RETRY_OPTIONS.maxAttempts).toBe(4);
    expect(DEFAULT_RETRY_OPTIONS.maxDelayMs).toBe(30_000);
  });
});

describe("streamWithRetry", () => {
  it("retries retryable failures and emits a single start", async () => {
    const client = scriptedClient([
      [{ type: "start", model: spec.id }, errorEvent(createAIError("overloaded", "busy"))],
      [{ type: "start", model: spec.id }, endEvent("recovered")],
    ]);
    const sleeps: number[] = [];
    const events = await collect(
      streamWithRetry(client, request, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        jitter: 0,
      }),
    );
    expect(client.calls).toBe(2);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(sleeps).toEqual([500]);
    expect(terminal(events).type).toBe("end");
  });

  it("gives up after maxAttempts", async () => {
    const client = scriptedClient([
      [{ type: "start", model: spec.id }, errorEvent(createAIError("rateLimit", "429"))],
    ]);
    const seen: RetryAttemptInfo[] = [];
    const events = await collect(
      streamWithRetry(client, request, {
        maxAttempts: 3,
        jitter: 0,
        sleep: async () => {},
        onRetry: (info) => seen.push(info),
      }),
    );
    expect(client.calls).toBe(3);
    expect(seen.map((info) => info.attempt)).toEqual([1, 2]);
    expect(seen.map((info) => info.delayMs)).toEqual([500, 1000]);
    expect(terminal(events).type).toBe("error");
  });

  it("does not retry non-retryable errors", async () => {
    const client = scriptedClient([
      [{ type: "start", model: spec.id }, errorEvent(createAIError("auth", "bad key"))],
    ]);
    const events = await collect(streamWithRetry(client, request, { sleep: async () => {} }));
    expect(client.calls).toBe(1);
    expect(terminal(events).type).toBe("error");
  });

  it("does not retry once content has been emitted", async () => {
    const client = scriptedClient([
      [
        { type: "start", model: spec.id },
        { type: "textStart", blockIndex: 0 },
        { type: "textDelta", blockIndex: 0, delta: "half" },
        errorEvent(createAIError("overloaded", "died mid-stream")),
      ],
    ]);
    const events = await collect(streamWithRetry(client, request, { sleep: async () => {} }));
    expect(client.calls).toBe(1);
    expect(terminal(events).type).toBe("error");
  });

  it("refuses to wait longer than maxRetryAfterMs", async () => {
    const client = scriptedClient([
      [
        { type: "start", model: spec.id },
        errorEvent(createAIError("rateLimit", "come back tomorrow", { retryAfterMs: 3_600_000 })),
      ],
    ]);
    const events = await collect(
      streamWithRetry(client, request, { sleep: async () => {}, maxRetryAfterMs: 60_000 }),
    );
    expect(client.calls).toBe(1);
    expect(terminal(events).type).toBe("error");
  });

  it("honours a custom isRetryable predicate", async () => {
    const client = scriptedClient([
      [{ type: "start", model: spec.id }, errorEvent(createAIError("invalidRequest", "weird"))],
      [{ type: "start", model: spec.id }, endEvent("ok")],
    ]);
    const events = await collect(
      streamWithRetry(client, request, {
        sleep: async () => {},
        isRetryable: (error) => error.kind === "invalidRequest",
      }),
    );
    expect(client.calls).toBe(2);
    expect(terminal(events).type).toBe("end");
  });

  it("ends with stopReason aborted when the signal fires during backoff", async () => {
    const controller = new AbortController();
    const client = scriptedClient([
      [{ type: "start", model: spec.id }, errorEvent(createAIError("network", "reset"))],
    ]);
    const events = await collect(
      streamWithRetry(
        client,
        { ...request, signal: controller.signal },
        {
          sleep: async () => {
            controller.abort();
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          },
        },
      ),
    );
    const last = terminal(events);
    expect(last.type).toBe("end");
    expect(last.message.stopReason).toBe("aborted");
    expect(last.message.errorMessage).toBeUndefined();
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    let done = false;
    const promise = abortableSleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(done).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1000, controller.signal)).rejects.toThrow(/aborted/);
  });

  it("rejects when the signal fires mid-sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = abortableSleep(5000, controller.signal);
    const assertion = expect(promise).rejects.toThrow(/aborted/);
    controller.abort();
    await assertion;
  });

  it("returns immediately for a non-positive delay", async () => {
    await expect(abortableSleep(0)).resolves.toBeUndefined();
  });
});

describe("withRetry", () => {
  it("wraps both stream and complete", async () => {
    const client = scriptedClient([
      [{ type: "start", model: spec.id }, errorEvent(createAIError("network", "reset"))],
      [{ type: "start", model: spec.id }, endEvent("second try")],
    ]);
    const wrapped = withRetry(client, { sleep: async () => {} });
    const message = await wrapped.complete(request);
    expect(message.content).toEqual([{ type: "text", text: "second try" }]);
    expect(client.calls).toBe(2);
  });
});
