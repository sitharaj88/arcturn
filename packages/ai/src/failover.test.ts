import type { AIError, LLMClient, LLMRequest, StreamEvent } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import { AIErrorException, createAIError } from "./errors.js";
import {
  createFailoverClient,
  defaultShouldFailover,
  type FailoverLink,
  streamFailover,
} from "./failover.js";
import { collect, modelSpec, terminal, textOf, userMessage } from "./test-helpers/fixtures.js";

const spec = modelSpec();
const request: LLMRequest = { model: spec, messages: [userMessage("hi")] };

function startEvent(model = spec.id): StreamEvent {
  return { type: "start", model };
}

function textEvents(text: string, blockIndex = 0): StreamEvent[] {
  return [
    { type: "textStart", blockIndex },
    { type: "textDelta", blockIndex, delta: text },
    { type: "blockEnd", blockIndex },
  ];
}

function endEvent(text: string, model = spec.id): StreamEvent {
  return {
    type: "end",
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 0,
    },
  };
}

function errorEvent(error: AIError, model = spec.id): StreamEvent {
  return {
    type: "error",
    error,
    message: {
      role: "assistant",
      content: [],
      model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "error",
      errorMessage: error.message,
      timestamp: 0,
    },
  };
}

const overloaded = createAIError("overloaded", "upstream overloaded");
const rateLimit = createAIError("rateLimit", "slow down");
const network = createAIError("network", "socket hang up");
const auth = createAIError("auth", "bad key");
const invalidRequest = createAIError("invalidRequest", "bad params");
const aborted = createAIError("aborted", "The request was aborted");

/** A client that replays a scripted event sequence and records its calls. */
function scriptedClient(script: StreamEvent[]): LLMClient & { calls: number } {
  let calls = 0;
  const client = {
    get calls() {
      return calls;
    },
    stream(): AsyncIterable<StreamEvent> {
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

/** A client that throws mid-stream instead of surfacing an error event. */
function throwingClient(error: AIError): LLMClient & { calls: number } {
  const thrown = new AIErrorException(error);
  let calls = 0;
  const client = {
    get calls() {
      return calls;
    },
    stream(): AsyncIterable<StreamEvent> {
      calls++;
      return (async function* () {
        yield startEvent();
        throw thrown;
      })();
    },
    async complete() {
      throw new Error("not used");
    },
  };
  return client as LLMClient & { calls: number };
}

describe("defaultShouldFailover", () => {
  it("fails over on transient errors only", () => {
    expect(defaultShouldFailover(overloaded)).toBe(true);
    expect(defaultShouldFailover(rateLimit)).toBe(true);
    expect(defaultShouldFailover(network)).toBe(true);
    expect(defaultShouldFailover(auth)).toBe(false);
    expect(defaultShouldFailover(invalidRequest)).toBe(false);
    expect(defaultShouldFailover(aborted)).toBe(false);
    expect(defaultShouldFailover(createAIError("unknown", "?"))).toBe(false);
  });
});

describe("createFailoverClient", () => {
  it("throws when constructed with an empty chain", () => {
    expect(() => createFailoverClient([])).toThrow(TypeError);
  });

  it("fails over on overloaded before any output and answers from the next link", async () => {
    const primary = scriptedClient([startEvent(), errorEvent(overloaded)]);
    const secondary = scriptedClient([startEvent(), ...textEvents("hello"), endEvent("hello")]);
    const onFailover = vi.fn();

    const client = createFailoverClient([primary, secondary], { onFailover });
    const events = await collect(client.stream(request));

    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(1);
    // Exactly one start, one terminal, and the fallback's content.
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(textOf(events)).toBe("hello");
    expect(terminal(events)).toMatchObject({ type: "end" });
    expect(onFailover).toHaveBeenCalledTimes(1);
    expect(onFailover).toHaveBeenCalledWith(0, 1, overloaded);
  });

  it("does NOT fail over once output has started; surfaces the error", async () => {
    // Content streams, then the same turn errors: switching now would corrupt it.
    const primary = scriptedClient([
      startEvent(),
      ...textEvents("partial"),
      errorEvent(overloaded),
    ]);
    const secondary = scriptedClient([startEvent(), ...textEvents("nope"), endEvent("nope")]);
    const onFailover = vi.fn();

    const client = createFailoverClient([primary, secondary], { onFailover });
    const events = await collect(client.stream(request));

    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(0);
    expect(textOf(events)).toBe("partial");
    expect(terminal(events)).toMatchObject({ type: "error", error: overloaded });
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("does NOT fail over on auth errors", async () => {
    const primary = scriptedClient([startEvent(), errorEvent(auth)]);
    const secondary = scriptedClient([startEvent(), ...textEvents("hi"), endEvent("hi")]);
    const onFailover = vi.fn();

    const client = createFailoverClient([primary, secondary], { onFailover });
    const events = await collect(client.stream(request));

    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(0);
    expect(terminal(events)).toMatchObject({ type: "error", error: auth });
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("does NOT fail over on invalidRequest errors", async () => {
    const primary = scriptedClient([startEvent(), errorEvent(invalidRequest)]);
    const secondary = scriptedClient([startEvent(), ...textEvents("hi"), endEvent("hi")]);

    const client = createFailoverClient([primary, secondary]);
    const events = await collect(client.stream(request));

    expect(secondary.calls).toBe(0);
    expect(terminal(events)).toMatchObject({ type: "error", error: invalidRequest });
  });

  it("does NOT fail over on a user abort even with a permissive policy", async () => {
    const primary = scriptedClient([startEvent(), errorEvent(aborted)]);
    const secondary = scriptedClient([startEvent(), ...textEvents("hi"), endEvent("hi")]);
    const onFailover = vi.fn();

    // shouldFailover returns true for everything; the abort guard must still win.
    const client = createFailoverClient([primary, secondary], {
      shouldFailover: () => true,
      onFailover,
    });
    const events = await collect(client.stream(request));

    expect(secondary.calls).toBe(0);
    expect(terminal(events)).toMatchObject({ type: "error", error: aborted });
    expect(onFailover).not.toHaveBeenCalled();
  });

  it("exhausts the chain and surfaces the LAST error", async () => {
    const a = scriptedClient([startEvent(), errorEvent(overloaded)]);
    const b = scriptedClient([startEvent(), errorEvent(rateLimit)]);
    const c = scriptedClient([startEvent(), errorEvent(network)]);
    const onFailover = vi.fn();

    const client = createFailoverClient([a, b, c], { onFailover });
    const events = await collect(client.stream(request));

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(c.calls).toBe(1);
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(terminal(events)).toMatchObject({ type: "error", error: network });
    // Two hops: 0->1 and 1->2. The final failure is surfaced, not a third hop.
    expect(onFailover.mock.calls).toEqual([
      [0, 1, overloaded],
      [1, 2, rateLimit],
    ]);
  });

  it("walks multiple retryable links before one succeeds", async () => {
    const a = scriptedClient([startEvent(), errorEvent(overloaded)]);
    const b = scriptedClient([startEvent(), errorEvent(network)]);
    const c = scriptedClient([startEvent(), ...textEvents("third"), endEvent("third")]);

    const client = createFailoverClient([a, b, c]);
    const events = await collect(client.stream(request));

    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 1]);
    expect(textOf(events)).toBe("third");
    expect(terminal(events)).toMatchObject({ type: "end" });
  });

  it("overrides request.model per link so start/end carry the answering model", async () => {
    const specA = modelSpec({ id: "anthropic/model-a", model: "model-a" });
    const specB = modelSpec({ id: "openai/model-b", model: "model-b", provider: "openai" });

    const seen: string[] = [];
    const primary: LLMClient = {
      stream(req) {
        seen.push(req.model.id);
        return (async function* () {
          yield startEvent(req.model.id);
          yield errorEvent(overloaded, req.model.id);
        })();
      },
      async complete() {
        throw new Error("not used");
      },
    };
    const secondary: LLMClient = {
      stream(req) {
        seen.push(req.model.id);
        return (async function* () {
          yield startEvent(req.model.id);
          yield* textEvents("ok");
          yield endEvent("ok", req.model.id);
        })();
      },
      async complete() {
        throw new Error("not used");
      },
    };

    const links: FailoverLink[] = [
      { client: primary, model: specA },
      { client: secondary, model: specB },
    ];
    const events = await collect(createFailoverClient(links).stream(request));

    // Each link saw its own overridden model, and the single surfaced start plus
    // terminal reflect the model that actually answered (B).
    expect(seen).toEqual(["anthropic/model-a", "openai/model-b"]);
    const starts = events.filter(
      (e): e is Extract<StreamEvent, { type: "start" }> => e.type === "start",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.model).toBe("openai/model-b");
    expect(terminal(events)).toMatchObject({ type: "end", message: { model: "openai/model-b" } });
  });

  it("buffers pre-commit usage so a failed-over turn does not leak it", async () => {
    const usage: StreamEvent = {
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    const primary = scriptedClient([startEvent(), usage, errorEvent(overloaded)]);
    const secondary = scriptedClient([startEvent(), ...textEvents("hi"), endEvent("hi")]);

    const events = await collect(createFailoverClient([primary, secondary]).stream(request));

    // The primary's usage event was buffered and discarded when it failed over.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(textOf(events)).toBe("hi");
  });

  it("defensively fails over when a client throws before output", async () => {
    const primary = throwingClient(createAIError("overloaded", "boom"));
    const secondary = scriptedClient([startEvent(), ...textEvents("safe"), endEvent("safe")]);
    const onFailover = vi.fn();

    const events = await collect(
      createFailoverClient([primary, secondary], { onFailover }).stream(request),
    );

    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(1);
    expect(textOf(events)).toBe("safe");
    expect(terminal(events)).toMatchObject({ type: "end" });
    expect(onFailover).toHaveBeenCalledWith(0, 1, expect.objectContaining({ kind: "overloaded" }));
  });

  it("surfaces a thrown non-retryable error without failing over", async () => {
    const primary = throwingClient(createAIError("invalidRequest", "nope"));
    const secondary = scriptedClient([startEvent(), ...textEvents("unused"), endEvent("unused")]);

    const events = await collect(createFailoverClient([primary, secondary]).stream(request));

    expect(secondary.calls).toBe(0);
    expect(terminal(events)).toMatchObject({ type: "error", error: { kind: "invalidRequest" } });
  });

  it("respects a custom shouldFailover predicate", async () => {
    // Treat auth as failover-worthy (e.g. a per-model key outage).
    const primary = scriptedClient([startEvent(), errorEvent(auth)]);
    const secondary = scriptedClient([
      startEvent(),
      ...textEvents("recovered"),
      endEvent("recovered"),
    ]);

    const client = createFailoverClient([primary, secondary], {
      shouldFailover: (err) => err.kind === "auth",
    });
    const events = await collect(client.stream(request));

    expect(secondary.calls).toBe(1);
    expect(textOf(events)).toBe("recovered");
  });

  it("streamFailover surfaces a single link's success unchanged", async () => {
    const only = scriptedClient([startEvent(), ...textEvents("solo"), endEvent("solo")]);
    const events = await collect(streamFailover([only], request));
    expect(textOf(events)).toBe("solo");
    expect(terminal(events)).toMatchObject({ type: "end" });
  });

  it("complete() resolves to the terminal message of the answering link", async () => {
    const primary = scriptedClient([startEvent(), errorEvent(overloaded)]);
    const secondary = scriptedClient([startEvent(), ...textEvents("done"), endEvent("done")]);

    const message = await createFailoverClient([primary, secondary]).complete(request);
    expect(message.stopReason).toBe("endTurn");
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
  });
});
