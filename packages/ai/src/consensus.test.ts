import type {
  AssistantContent,
  AssistantMessage,
  LLMClient,
  LLMRequest,
  ModelSpec,
  StopReason,
  StreamEvent,
} from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  type ConsensusLink,
  type ConsensusVerdict,
  canonicalJson,
  compareMessages,
  createConsensusClient,
  DEFAULT_SIMILARITY_THRESHOLD,
  formatVerdict,
  normalizeText,
  streamConsensus,
  textSimilarity,
} from "./consensus.js";
import { AIErrorException, createAIError } from "./errors.js";
import { collect, modelSpec, terminal, userMessage } from "./test-helpers/fixtures.js";

const specA = modelSpec({ id: "anthropic/model-a", model: "model-a" });
const specB = modelSpec({ id: "openai/model-b", model: "model-b", provider: "openai" });
const specC = modelSpec({ id: "google/model-c", model: "model-c", provider: "google" });

const request: LLMRequest = { model: specA, messages: [userMessage("read the config")] };

interface Turn {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  stopReason?: StopReason;
}

/** Build the full event script (start … end) a conformant client would emit. */
function script(turn: Turn, model: string): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "start", model }];
  const content: AssistantContent[] = [];
  let blockIndex = 0;

  if (turn.text !== undefined) {
    events.push({ type: "textStart", blockIndex });
    events.push({ type: "textDelta", blockIndex, delta: turn.text });
    events.push({ type: "blockEnd", blockIndex });
    content.push({ type: "text", text: turn.text });
    blockIndex++;
  }
  for (const call of turn.toolCalls ?? []) {
    events.push({ type: "toolCallStart", blockIndex, id: call.id, name: call.name });
    events.push({
      type: "toolCallDelta",
      blockIndex,
      argumentsDelta: JSON.stringify(call.arguments),
    });
    events.push({
      type: "toolCallEnd",
      blockIndex,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    events.push({ type: "blockEnd", blockIndex });
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
    blockIndex++;
  }

  const message: AssistantMessage = {
    role: "assistant",
    content,
    model,
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "toolCalls" : "endTurn"),
    timestamp: 0,
  };
  events.push({ type: "end", message });
  return events;
}

/** A client that replays a scripted sequence and records how often it ran. */
function scriptedClient(
  events: StreamEvent[],
): LLMClient & { calls: number; script: StreamEvent[] } {
  let calls = 0;
  return {
    script: events,
    get calls() {
      return calls;
    },
    stream(): AsyncIterable<StreamEvent> {
      calls++;
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
    async complete(): Promise<AssistantMessage> {
      throw new Error("not used");
    },
  } as LLMClient & { calls: number; script: StreamEvent[] };
}

/** A client whose stream rejects instead of emitting a terminal `error` event. */
function throwingClient(message: string): LLMClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    stream(): AsyncIterable<StreamEvent> {
      calls++;
      return (async function* () {
        yield { type: "start", model: "x" } satisfies StreamEvent;
        throw new AIErrorException(createAIError("network", message));
      })();
    },
    async complete(): Promise<AssistantMessage> {
      throw new Error("not used");
    },
  } as LLMClient & { calls: number };
}

/**
 * A client that never terminates on its own and records the signal it was
 * handed, so a test can prove the panel is cancellable.
 */
function hangingClient(): LLMClient & { observed: AbortSignal | undefined } {
  const client = {
    observed: undefined as AbortSignal | undefined,
    stream(req: LLMRequest): AsyncIterable<StreamEvent> {
      client.observed = req.signal;
      return (async function* () {
        yield { type: "start", model: specB.id } satisfies StreamEvent;
        await new Promise<void>((resolve) => {
          req.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })();
    },
    async complete(): Promise<AssistantMessage> {
      throw new Error("not used");
    },
  };
  return client;
}

/** A client that emits a terminal `error` event, as a conformant client does. */
function erroringClient(message: string): LLMClient & { calls: number } {
  const error = createAIError("overloaded", message);
  return scriptedClient([
    { type: "start", model: "x" },
    {
      type: "error",
      error,
      message: {
        role: "assistant",
        content: [],
        model: "x",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "error",
        errorMessage: message,
        timestamp: 0,
      },
    },
  ]);
}

/** An `onVerdict` callback paired with a promise that settles when it fires. */
function verdictSink(): {
  onVerdict: (v: ConsensusVerdict) => void;
  verdict: Promise<ConsensusVerdict>;
} {
  let resolve!: (v: ConsensusVerdict) => void;
  const verdict = new Promise<ConsensusVerdict>((r) => {
    resolve = r;
  });
  return { onVerdict: resolve, verdict };
}

/** Let every already-queued microtask and macrotask drain. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function assistant(
  content: AssistantContent[],
  stopReason: StopReason = "endTurn",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: "anthropic/model-a",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason,
    timestamp: 0,
  };
}

function link(client: LLMClient, model: ModelSpec): ConsensusLink {
  return { client, model };
}

describe("canonicalJson", () => {
  it("sorts object keys recursively so key order is not a difference", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ outer: { z: [1, { q: 1, p: 2 }], a: true } })).toBe(
      canonicalJson({ outer: { a: true, z: [1, { p: 2, q: 1 }] } }),
    );
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("handles primitives, null, and undefined properties", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ a: Number.NaN })).toBe('{"a":null}');
  });
});

describe("normalizeText / textSimilarity", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeText("  Hello\n\tWORLD  ")).toBe("hello world");
  });

  it("scores identical text 1 and disjoint text 0", () => {
    expect(textSimilarity("the cat sat", "The   cat\nsat")).toBe(1);
    expect(textSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("treats two empty texts as agreement and one empty text as disagreement", () => {
    expect(textSimilarity("", "")).toBe(1);
    expect(textSimilarity("", "something")).toBe(0);
  });

  it("returns a partial score for partially overlapping word sets", () => {
    // {a,b,c} vs {a,b,d}: intersection 2, union 4.
    expect(textSimilarity("a b c", "a b d")).toBeCloseTo(0.5, 5);
  });
});

describe("compareMessages", () => {
  const read = (args: Record<string, unknown>): AssistantContent => ({
    type: "toolCall",
    id: "call_1",
    name: "read",
    arguments: args,
  });

  it("finds no divergence between identical messages", () => {
    const a = assistant(
      [{ type: "text", text: "reading it" }, read({ path: "a.ts" })],
      "toolCalls",
    );
    const b = assistant(
      [{ type: "text", text: "reading it" }, read({ path: "a.ts" })],
      "toolCalls",
    );
    const divergence = compareMessages(a, b);
    expect(divergence).toMatchObject({
      toolCallsDiffer: false,
      textSimilarity: 1,
      stopReasonDiffers: false,
    });
    expect(divergence.details).toEqual([]);
  });

  it("ignores provider-assigned tool call ids", () => {
    const a = assistant([read({ path: "a.ts" })], "toolCalls");
    const b = assistant(
      [
        {
          type: "toolCall",
          id: "toolu_totally_different",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ],
      "toolCalls",
    );
    expect(compareMessages(a, b).toolCallsDiffer).toBe(false);
  });

  it("ignores argument key ORDER", () => {
    const a = assistant([read({ path: "a.ts", limit: 10 })], "toolCalls");
    const b = assistant([read({ limit: 10, path: "a.ts" })], "toolCalls");
    expect(compareMessages(a, b).toolCallsDiffer).toBe(false);
  });

  it("reports a differing tool name with specifics", () => {
    const a = assistant([read({ path: "a.ts" })], "toolCalls");
    const b = assistant(
      [{ type: "toolCall", id: "c", name: "write", arguments: { path: "a.ts" } }],
      "toolCalls",
    );
    const divergence = compareMessages(a, b);
    expect(divergence.toolCallsDiffer).toBe(true);
    expect(divergence.details).toContain("tool call 0: name differs (read vs write)");
  });

  it("reports differing arguments with both values", () => {
    const a = assistant([read({ path: "a.ts" })], "toolCalls");
    const b = assistant([read({ path: "b.ts" })], "toolCalls");
    const divergence = compareMessages(a, b);
    expect(divergence.toolCallsDiffer).toBe(true);
    expect(divergence.details[0]).toBe(
      'tool call 0 (read): arguments differ ({"path":"a.ts"} vs {"path":"b.ts"})',
    );
  });

  it("reports a differing tool call count", () => {
    const a = assistant([read({ path: "a.ts" })], "toolCalls");
    const b = assistant([read({ path: "a.ts" }), read({ path: "b.ts" })], "toolCalls");
    const divergence = compareMessages(a, b);
    expect(divergence.toolCallsDiffer).toBe(true);
    expect(divergence.details[0]).toBe("tool call count differs: 1 (read) vs 2 (read, read)");
  });

  it("reports a stop reason mismatch", () => {
    const a = assistant([{ type: "text", text: "same words" }], "endTurn");
    const b = assistant([{ type: "text", text: "same words" }], "maxTokens");
    const divergence = compareMessages(a, b);
    expect(divergence.stopReasonDiffers).toBe(true);
    expect(divergence.details).toContain("stop reason differs: endTurn vs maxTokens");
  });

  it("excludes thinking blocks from the text comparison", () => {
    const a = assistant([
      { type: "thinking", thinking: "wildly different private reasoning" },
      { type: "text", text: "the answer is four" },
    ]);
    const b = assistant([
      { type: "thinking", thinking: "nothing alike at all here" },
      { type: "text", text: "the answer is four" },
    ]);
    expect(compareMessages(a, b).textSimilarity).toBe(1);
  });
});

describe("createConsensusClient", () => {
  it("throws when constructed with an empty panel", () => {
    expect(() => createConsensusClient([])).toThrow(TypeError);
  });

  it("reports FULL agreement for identical responses", async () => {
    const turn: Turn = { text: "I will read the config file now." };
    const primary = scriptedClient(script(turn, specA.id));
    const secondary = scriptedClient(script(turn, specB.id));
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    const events = await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(secondary.calls).toBe(1);
    expect(verdict.agreement).toBe("full");
    expect(verdict.toolCallsMatch).toBe(true);
    expect(verdict.textSimilarity).toBe(1);
    expect(verdict.details).toEqual([]);
    expect(verdict.models).toEqual([specA.id, specB.id]);
    // The primary's events reached the consumer untouched.
    expect(events).toEqual(primary.script);
  });

  it("reports PARTIAL agreement for the same tool calls worded differently", async () => {
    const toolCalls = [{ id: "call_1", name: "read", arguments: { path: "arcturn.config.json" } }];
    const primary = scriptedClient(
      script({ text: "Let me open the configuration file.", toolCalls }, specA.id),
    );
    const secondary = scriptedClient(
      script({ text: "Checking what settings are currently declared.", toolCalls }, specB.id),
    );
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(verdict.agreement).toBe("partial");
    expect(verdict.toolCallsMatch).toBe(true);
    expect(verdict.textSimilarity).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
    expect(verdict.details.join(" ")).toContain(`${specB.id}: text similarity`);
  });

  it("reports DIVERGENT with specifics when the models pick a different tool", async () => {
    const primary = scriptedClient(
      script(
        { toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }] },
        specA.id,
      ),
    );
    const secondary = scriptedClient(
      script(
        { toolCalls: [{ id: "call_9", name: "write", arguments: { path: "a.ts" } }] },
        specB.id,
      ),
    );
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(verdict.agreement).toBe("divergent");
    expect(verdict.toolCallsMatch).toBe(false);
    expect(verdict.details).toContain(`${specB.id}: tool call 0: name differs (read vs write)`);
  });

  it("reports DIVERGENT with specifics when only the ARGUMENTS differ", async () => {
    const primary = scriptedClient(
      script(
        { toolCalls: [{ id: "call_1", name: "bash", arguments: { command: "ls" } }] },
        specA.id,
      ),
    );
    const secondary = scriptedClient(
      script(
        { toolCalls: [{ id: "call_2", name: "bash", arguments: { command: "rm -rf ." } }] },
        specB.id,
      ),
    );
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(verdict.agreement).toBe("divergent");
    expect(verdict.details).toContain(
      `${specB.id}: tool call 0 (bash): arguments differ ({"command":"ls"} vs {"command":"rm -rf ."})`,
    );
  });

  it("does NOT diverge when only argument key ORDER differs", async () => {
    const text = "Reading the file.";
    const primary = scriptedClient(
      script(
        {
          text,
          toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.ts", limit: 10 } }],
        },
        specA.id,
      ),
    );
    const secondary = scriptedClient(
      script(
        {
          text,
          toolCalls: [{ id: "call_2", name: "read", arguments: { limit: 10, path: "a.ts" } }],
        },
        specB.id,
      ),
    );
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(verdict.agreement).toBe("full");
    expect(verdict.toolCallsMatch).toBe(true);
    expect(verdict.details).toEqual([]);
  });

  it("takes the WORST case across a three-model panel", async () => {
    const turn: Turn = {
      toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }],
    };
    const primary = scriptedClient(script(turn, specA.id));
    const agreeing = scriptedClient(script(turn, specB.id));
    const dissenting = scriptedClient(
      script(
        { toolCalls: [{ id: "call_3", name: "read", arguments: { path: "z.ts" } }] },
        specC.id,
      ),
    );
    const sink = verdictSink();

    const client = createConsensusClient(
      [link(primary, specA), link(agreeing, specB), link(dissenting, specC)],
      { onVerdict: sink.onVerdict },
    );
    await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(verdict.models).toEqual([specA.id, specB.id, specC.id]);
    expect(verdict.agreement).toBe("divergent");
    expect(verdict.details.join(" ")).toContain(specC.id);
    expect(verdict.details.join(" ")).not.toContain(`${specB.id}: tool call`);
  });

  it("records a THROWING secondary as unavailable and leaves the primary stream intact", async () => {
    const primary = scriptedClient(script({ text: "all good here" }, specA.id));
    const secondary = throwingClient("socket hang up");
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    const events = await collect(client.stream(request));
    const verdict = await sink.verdict;

    // The turn the user saw is complete and unmodified.
    expect(events).toEqual(primary.script);
    expect(terminal(events)).toMatchObject({ type: "end" });
    expect(secondary.calls).toBe(1);
    expect(verdict.agreement).toBe("partial");
    expect(verdict.models).toEqual([specA.id, specB.id]);
    expect(verdict.details).toContain(`${specB.id}: unavailable (socket hang up)`);
    expect(verdict.details).toContain(
      "no secondary produced a comparable message; consensus unconfirmed",
    );
  });

  it("records an ERRORING secondary as unavailable while a healthy one still votes", async () => {
    const turn: Turn = { text: "same answer from both" };
    const primary = scriptedClient(script(turn, specA.id));
    const broken = erroringClient("upstream overloaded");
    const healthy = scriptedClient(script(turn, specC.id));
    const sink = verdictSink();

    const client = createConsensusClient(
      [link(primary, specA), link(broken, specB), link(healthy, specC)],
      { onVerdict: sink.onVerdict },
    );
    const events = await collect(client.stream(request));
    const verdict = await sink.verdict;

    expect(events).toEqual(primary.script);
    expect(verdict.details).toContain(`${specB.id}: unavailable (upstream overloaded)`);
    // The one model that did answer agreed, so the turn is still corroborated.
    expect(verdict.agreement).toBe("full");
    expect(verdict.textSimilarity).toBe(1);
  });

  it("sampleRate 0 skips the secondaries entirely", async () => {
    const primary = scriptedClient(script({ text: "solo turn" }, specA.id));
    const secondary = scriptedClient(script({ text: "never asked" }, specB.id));
    const onVerdict = vi.fn();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict,
      sampleRate: 0,
    });
    const events = await collect(client.stream(request));
    await settle();

    expect(secondary.calls).toBe(0);
    expect(onVerdict).not.toHaveBeenCalled();
    expect(events).toEqual(primary.script);
  });

  it("sampleRate uses the injected randomness source", async () => {
    const turn: Turn = { text: "sampled" };
    const makePanel = (roll: number) => {
      const primary = scriptedClient(script(turn, specA.id));
      const secondary = scriptedClient(script(turn, specB.id));
      const onVerdict = vi.fn();
      const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
        onVerdict,
        sampleRate: 0.5,
        random: () => roll,
      });
      return { client, secondary, onVerdict };
    };

    const below = makePanel(0.2);
    await collect(below.client.stream(request));
    await settle();
    expect(below.secondary.calls).toBe(1);
    expect(below.onVerdict).toHaveBeenCalledTimes(1);

    const above = makePanel(0.9);
    await collect(above.client.stream(request));
    await settle();
    expect(above.secondary.calls).toBe(0);
    expect(above.onVerdict).not.toHaveBeenCalled();
  });

  it("skips the secondaries when no onVerdict is supplied", async () => {
    const primary = scriptedClient(script({ text: "nobody is watching" }, specA.id));
    const secondary = scriptedClient(script({ text: "so this never runs" }, specB.id));

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)]);
    const events = await collect(client.stream(request));
    await settle();

    expect(secondary.calls).toBe(0);
    expect(events).toEqual(primary.script);
  });

  it("passes primary events through by identity, not by copy", async () => {
    const turn: Turn = {
      text: "hi",
      toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }],
    };
    const primary = scriptedClient(script(turn, specA.id));
    const secondary = scriptedClient(script(turn, specB.id));
    const sink = verdictSink();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    });
    const events = await collect(client.stream(request));
    await sink.verdict;

    expect(events).toHaveLength(primary.script.length);
    for (const [index, event] of events.entries()) {
      expect(event).toBe(primary.script[index]);
    }
  });

  it("emits no verdict when the PRIMARY errors, and does not consult the panel result", async () => {
    const primary = erroringClient("primary is down");
    const secondary = scriptedClient(script({ text: "would have answered" }, specB.id));
    const onVerdict = vi.fn();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict,
    });
    const events = await collect(client.stream(request));
    await settle();

    expect(terminal(events)).toMatchObject({ type: "error" });
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("emits no verdict when the primary turn was aborted", async () => {
    const aborted = script({ text: "half a" }, specA.id);
    const last = aborted[aborted.length - 1];
    if (last?.type === "end") last.message.stopReason = "aborted";
    const primary = scriptedClient(aborted);
    const secondary = scriptedClient(script({ text: "half a" }, specB.id));
    const onVerdict = vi.fn();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict,
    });
    await collect(client.stream(request));
    await settle();

    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("emits no verdict when the consumer abandons the stream early", async () => {
    const turn: Turn = { text: "a long answer that the consumer stops reading" };
    const primary = scriptedClient(script(turn, specA.id));
    const secondary = scriptedClient(script(turn, specB.id));
    const onVerdict = vi.fn();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict,
    });
    for await (const event of client.stream(request)) {
      if (event.type === "textDelta") break;
    }
    await settle();

    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("aborts the secondaries when the consumer abandons the stream, so they stop billing", async () => {
    const primary = scriptedClient(script({ text: "a long answer" }, specA.id));
    const secondary = hangingClient();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: vi.fn(),
    });
    for await (const event of client.stream(request)) {
      if (event.type === "textDelta") break;
    }
    await settle();

    expect(secondary.observed?.aborted).toBe(true);
  });

  it("propagates the caller's abort signal to the secondaries", async () => {
    const controller = new AbortController();
    const primary = scriptedClient(script({ text: "done" }, specA.id));
    const secondary = hangingClient();

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: vi.fn(),
    });
    await collect(client.stream({ ...request, signal: controller.signal }));
    expect(secondary.observed?.aborted).toBe(false);
    controller.abort();
    await settle();

    expect(secondary.observed?.aborted).toBe(true);
  });

  it("survives an onVerdict callback that throws", async () => {
    const turn: Turn = { text: "identical" };
    const primary = scriptedClient(script(turn, specA.id));
    const secondary = scriptedClient(script(turn, specB.id));
    let called = 0;

    const client = createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: () => {
        called++;
        throw new Error("bad consumer");
      },
    });
    const events = await collect(client.stream(request));
    await settle();

    expect(called).toBe(1);
    expect(events).toEqual(primary.script);
  });

  it("honours an injected similarity threshold", async () => {
    const toolCalls = [{ id: "call_1", name: "read", arguments: { path: "a.ts" } }];
    const primary = scriptedClient(script({ text: "a b c", toolCalls }, specA.id));
    const secondary = scriptedClient(script({ text: "a b d", toolCalls }, specB.id));
    const strict = verdictSink();
    const lax = verdictSink();

    await collect(
      createConsensusClient([link(primary, specA), link(secondary, specB)], {
        onVerdict: strict.onVerdict,
        similarityThreshold: 0.9,
      }).stream(request),
    );
    expect((await strict.verdict).agreement).toBe("partial");

    await collect(
      createConsensusClient([link(primary, specA), link(secondary, specB)], {
        onVerdict: lax.onVerdict,
        similarityThreshold: 0.4,
      }).stream(request),
    );
    expect((await lax.verdict).agreement).toBe("full");
  });

  it("overrides request.model per panel member", async () => {
    const seen: string[] = [];
    const recorder = (spec: ModelSpec): LLMClient => ({
      stream(req) {
        seen.push(req.model.id);
        return (async function* () {
          for (const event of script({ text: "same" }, spec.id)) yield event;
        })();
      },
      async complete(): Promise<AssistantMessage> {
        throw new Error("not used");
      },
    });
    const sink = verdictSink();

    await collect(
      createConsensusClient([link(recorder(specA), specA), link(recorder(specB), specB)], {
        onVerdict: sink.onVerdict,
      }).stream(request),
    );
    await sink.verdict;

    expect(seen.sort()).toEqual([specA.id, specB.id]);
  });

  it("complete() resolves to the PRIMARY's message", async () => {
    const primary = scriptedClient(script({ text: "primary answer" }, specA.id));
    const secondary = scriptedClient(script({ text: "secondary answer" }, specB.id));
    const sink = verdictSink();

    const message = await createConsensusClient([link(primary, specA), link(secondary, specB)], {
      onVerdict: sink.onVerdict,
    }).complete(request);
    await sink.verdict;

    expect(message.content).toEqual([{ type: "text", text: "primary answer" }]);
    expect(message.model).toBe(specA.id);
  });

  it("streamConsensus with a single link is a pure pass-through", async () => {
    const only = scriptedClient(script({ text: "solo" }, specA.id));
    const onVerdict = vi.fn();
    const events = await collect(streamConsensus([only], request, { onVerdict }));
    await settle();

    expect(events).toEqual(only.script);
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("accepts bare clients as links, defaulting to request.model", async () => {
    const turn: Turn = { text: "same" };
    const primary = scriptedClient(script(turn, specA.id));
    const secondary = scriptedClient(script(turn, specA.id));
    const sink = verdictSink();

    await collect(
      createConsensusClient([primary, secondary], { onVerdict: sink.onVerdict }).stream(request),
    );
    const verdict = await sink.verdict;

    expect(verdict.models).toEqual([specA.id, specA.id]);
    expect(verdict.agreement).toBe("full");
  });
});

describe("formatVerdict", () => {
  it("summarises agreement and divergence in one line", () => {
    expect(
      formatVerdict({
        agreement: "full",
        toolCallsMatch: true,
        textSimilarity: 1,
        details: [],
        models: [specA.id, specB.id],
      }),
    ).toBe("full: 2 models agree");
    expect(
      formatVerdict({
        agreement: "divergent",
        toolCallsMatch: false,
        textSimilarity: 0.2,
        details: ["openai/model-b: tool call 0: name differs (read vs write)"],
        models: [specA.id, specB.id],
      }),
    ).toBe("divergent: openai/model-b: tool call 0: name differs (read vs write)");
  });
});
