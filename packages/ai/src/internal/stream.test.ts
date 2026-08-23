import type { StreamEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { collect, modelSpec, terminal } from "../test-helpers/fixtures.js";
import {
  assembleStream,
  completeFromStream,
  MessageAssembler,
  type ProviderStreamEvent,
} from "./stream.js";

const spec = modelSpec();

async function run(events: ProviderStreamEvent[], signal?: AbortSignal): Promise<StreamEvent[]> {
  return collect(
    assembleStream(spec, signal, async function* () {
      for (const event of events) yield event;
    }),
  );
}

describe("MessageAssembler", () => {
  it("builds text, thinking and tool-call blocks in first-seen order", () => {
    const assembler = new MessageAssembler(spec);
    assembler.apply({ type: "thinkingStart", blockIndex: 0 });
    assembler.apply({ type: "thinkingDelta", blockIndex: 0, delta: "hmm" });
    assembler.apply({ type: "thinkingSignature", blockIndex: 0, signature: "sig" });
    assembler.apply({ type: "textStart", blockIndex: 1 });
    assembler.apply({ type: "textDelta", blockIndex: 1, delta: "hello " });
    assembler.apply({ type: "textDelta", blockIndex: 1, delta: "world" });
    assembler.apply({ type: "toolCallStart", blockIndex: 2, id: "t1", name: "read" });
    assembler.apply({ type: "toolCallDelta", blockIndex: 2, argumentsDelta: '{"p":1}' });
    assembler.apply({
      type: "toolCallEnd",
      blockIndex: 2,
      id: "t1",
      name: "read",
      arguments: { p: 1 },
    });

    expect(assembler.content()).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "hello world" },
      { type: "toolCall", id: "t1", name: "read", arguments: { p: 1 } },
    ]);
  });

  it("appends chunked signature deltas but replaces when asked", () => {
    const assembler = new MessageAssembler(spec);
    assembler.apply({ type: "thinkingStart", blockIndex: 0 });
    assembler.apply({ type: "thinkingSignature", blockIndex: 0, signature: "ab" });
    assembler.apply({ type: "thinkingSignature", blockIndex: 0, signature: "cd" });
    expect(assembler.content()[0]).toMatchObject({ signature: "abcd" });

    assembler.apply({ type: "thinkingSignature", blockIndex: 0, signature: "zz", replace: true });
    expect(assembler.content()[0]).toMatchObject({ signature: "zz" });
  });

  it("drops empty text blocks and unsigned empty thinking", () => {
    const assembler = new MessageAssembler(spec);
    assembler.apply({ type: "textStart", blockIndex: 0 });
    assembler.apply({ type: "thinkingStart", blockIndex: 1 });
    expect(assembler.content()).toEqual([]);
  });

  it("prices usage from the model spec", () => {
    const assembler = new MessageAssembler(spec);
    assembler.setUsage({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(assembler.pricedUsage().costUsd).toBe(3);
  });

  it("upgrades endTurn to toolCalls when tool calls are present", () => {
    const assembler = new MessageAssembler(spec);
    assembler.apply({ type: "toolCallEnd", blockIndex: 0, id: "a", name: "b", arguments: {} });
    expect(assembler.finalize().stopReason).toBe("toolCalls");
  });
});

describe("assembleStream", () => {
  it("always starts with start and ends with a single end", async () => {
    const events = await run([
      { type: "textStart", blockIndex: 0 },
      { type: "textDelta", blockIndex: 0, delta: "hi" },
      { type: "blockEnd", blockIndex: 0 },
      { type: "stop", stopReason: "endTurn" },
    ]);
    expect(events[0]).toEqual({ type: "start", model: spec.id });
    expect(events.filter((event) => event.type === "end")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    const end = terminal(events);
    expect(end.message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(end.message.stopReason).toBe("endTurn");
  });

  it("does not surface internal events to consumers", async () => {
    const events = await run([
      { type: "thinkingStart", blockIndex: 0 },
      { type: "thinkingSignature", blockIndex: 0, signature: "s" },
      { type: "stop", stopReason: "endTurn" },
    ]);
    expect(events.some((event) => event.type === "thinkingSignature")).toBe(false);
    expect(events.some((event) => (event as { type: string }).type === "stop")).toBe(false);
  });

  it("attaches cost to forwarded usage events", async () => {
    const events = await run([
      {
        type: "usage",
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      { type: "stop", stopReason: "endTurn" },
    ]);
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { costUsd: 18 } });
    expect(terminal(events).message.usage.costUsd).toBe(18);
  });

  it("converts a thrown error into a terminal error event with the partial message", async () => {
    const events = await collect(
      assembleStream(spec, undefined, async function* () {
        yield { type: "textStart", blockIndex: 0 };
        yield { type: "textDelta", blockIndex: 0, delta: "partial" };
        throw Object.assign(new Error("boom"), { status: 500 });
      }),
    );
    const last = terminal(events);
    expect(last.type).toBe("error");
    if (last.type !== "error") throw new Error("unreachable");
    expect(last.error.kind).toBe("overloaded");
    expect(last.error.status).toBe(500);
    expect(last.message.stopReason).toBe("error");
    expect(last.message.errorMessage).toBe("boom");
    expect(last.message.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("treats an abort as a normal end with stopReason aborted", async () => {
    const controller = new AbortController();
    const events = await collect(
      assembleStream(spec, controller.signal, async function* () {
        yield { type: "textStart", blockIndex: 0 };
        yield { type: "textDelta", blockIndex: 0, delta: "so far" };
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }),
    );
    const last = terminal(events);
    expect(last.type).toBe("end");
    expect(last.message.stopReason).toBe("aborted");
    expect(last.message.content).toEqual([{ type: "text", text: "so far" }]);
  });

  it("short-circuits when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const events = await collect(
      assembleStream(spec, controller.signal, async function* () {
        called = true;
        yield { type: "textStart", blockIndex: 0 };
      }),
    );
    expect(called).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["start", "end"]);
    expect(terminal(events).message.stopReason).toBe("aborted");
  });
});

describe("completeFromStream", () => {
  it("returns the terminal message", async () => {
    const message = await completeFromStream(
      assembleStream(spec, undefined, async function* () {
        yield { type: "textStart", blockIndex: 0 };
        yield { type: "textDelta", blockIndex: 0, delta: "done" };
        yield { type: "stop", stopReason: "endTurn" };
      }),
    );
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("throws when the stream produced no terminal event", async () => {
    async function* empty(): AsyncGenerator<StreamEvent> {
      yield { type: "start", model: "x" };
    }
    await expect(completeFromStream(empty())).rejects.toThrow(/without a terminal event/);
  });
});
