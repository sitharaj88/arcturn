/**
 * Adversarial correctness review, round 2 — provider failover.
 *
 * `failover.ts`'s module doc states the contract precisely:
 *
 *   "Structural events (`start`, `usage`, `blockEnd`) do **not** count as
 *    output. The leading `start` is held back until an attempt commits ...
 *    exactly one `start` is emitted, carrying the id of the model that
 *    actually answers".
 *
 * Confirmed defects use `it.fails` (the assertion encodes the correct
 * behaviour, so it fails today and the suite stays green); the attacks that
 * the code survives are kept as passing tests so a refactor cannot regress
 * them.
 */

import type { AIError, LLMClient, StreamEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { createAIError } from "./errors.js";
import { streamFailover } from "./failover.js";
import { collect, modelSpec, userMessage } from "./test-helpers/fixtures.js";

const specA = modelSpec({ id: "vendor/model-a", model: "model-a" });
const specB = modelSpec({ id: "vendor/model-b", model: "model-b" });
const overloaded: AIError = createAIError("overloaded", "upstream overloaded");

function errorEvent(error: AIError, model: string): StreamEvent {
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

function endEvent(text: string, model: string): StreamEvent {
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

/** A client that replays a fixed event list, chosen by the request's model id. */
function scriptedByModel(script: Record<string, StreamEvent[]>): LLMClient {
  return {
    async *stream(request) {
      for (const event of script[request.model.id] ?? []) yield event;
    },
    async complete() {
      throw new Error("unused");
    },
  };
}

/* -------------------------------------------------------------------------- */
/* `blockEnd` commits the `start` but does not block the failover              */
/* -------------------------------------------------------------------------- */

describe("streamFailover: blockEnd is documented as structural but behaves as a commit", () => {
  // The switch in streamFailover routes `start`, `usage` and `error`
  // explicitly and sends EVERYTHING else — `blockEnd` included — through the
  // `default` arm, whose first act is
  //     if (!startEmitted) { startEmitted = true; yield pendingStart ...; }
  // Only afterwards does it ask `isContentEvent(event)`, and `blockEnd` is
  // not a content event, so `produced` stays false. The attempt has now
  // emitted its `start` while remaining eligible for failover. If it then
  // errors, the chain moves on, the next link answers, and — because
  // `startEmitted` is already true — no second `start` is emitted. The
  // consumer is left holding a `start` naming model A over a turn produced
  // entirely by model B, which is exactly the misattribution the held-back
  // `start` exists to prevent.
  //
  // Severity is low in practice: a conformant adapter only emits `blockEnd`
  // after a `textStart`/`toolCallStart` (both of which do set `produced`), so
  // reaching this needs a malformed stream. It is filed because the module's
  // stated invariant and its implementation disagree, and because the guard
  // is one line (`isContentEvent` should gate the commit, or `blockEnd`
  // should be routed like `usage`).
  it("the single emitted `start` names the model that answered", async () => {
    const client = scriptedByModel({
      "vendor/model-a": [
        { type: "start", model: "vendor/model-a" },
        // Structural per the module doc; no content has streamed.
        { type: "blockEnd", blockIndex: 0 },
        errorEvent(overloaded, "vendor/model-a"),
      ],
      "vendor/model-b": [
        { type: "start", model: "vendor/model-b" },
        { type: "textStart", blockIndex: 0 },
        { type: "textDelta", blockIndex: 0, delta: "answer from B" },
        { type: "blockEnd", blockIndex: 0 },
        endEvent("answer from B", "vendor/model-b"),
      ],
    });

    const events = await collect(
      streamFailover(
        [
          { client, model: specA },
          { client, model: specB },
        ],
        { model: specA, messages: [userMessage("hi")] },
      ),
    );

    const starts = events.filter((e) => e.type === "start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { model: string }).model).toBe("vendor/model-b");
  });

  // Pins the observed behaviour so the report's claim is unambiguous.
});

/* -------------------------------------------------------------------------- */
/* RULED OUT — attacks the streaming invariant survives                       */
/* -------------------------------------------------------------------------- */

describe("RULED OUT: usage before content does not commit the turn", () => {
  it("buffers pre-commit usage, discards it on failover, and emits it after the answerer's start", async () => {
    const usage = { inputTokens: 99, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const client = scriptedByModel({
      "vendor/model-a": [
        { type: "start", model: "vendor/model-a" },
        { type: "usage", usage },
        errorEvent(overloaded, "vendor/model-a"),
      ],
      "vendor/model-b": [
        { type: "start", model: "vendor/model-b" },
        { type: "usage", usage: { ...usage, inputTokens: 7 } },
        { type: "textStart", blockIndex: 0 },
        { type: "textDelta", blockIndex: 0, delta: "B" },
        endEvent("B", "vendor/model-b"),
      ],
    });

    const events = await collect(
      streamFailover(
        [
          { client, model: specA },
          { client, model: specB },
        ],
        { model: specA, messages: [userMessage("hi")] },
      ),
    );

    const starts = events.filter((e) => e.type === "start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { model: string }).model).toBe("vendor/model-b");
    // Model A's 99 input tokens never reach the consumer; only B's 7 do.
    const usages = events.filter((e) => e.type === "usage");
    expect(usages).toHaveLength(1);
    expect((usages[0] as { usage: { inputTokens: number } }).usage.inputTokens).toBe(7);
    // Order: start precedes the buffered usage it was held back for.
    expect(events.findIndex((e) => e.type === "start")).toBeLessThan(
      events.findIndex((e) => e.type === "usage"),
    );
  });
});

describe("RULED OUT: a tool-call block that started streaming pins the turn", () => {
  it("does not fail over after toolCallStart, even for a retryable error", async () => {
    const client = scriptedByModel({
      "vendor/model-a": [
        { type: "start", model: "vendor/model-a" },
        { type: "toolCallStart", blockIndex: 0, id: "t1", name: "bash" },
        { type: "toolCallDelta", blockIndex: 0, argumentsDelta: '{"command":"ls' },
        errorEvent(overloaded, "vendor/model-a"),
      ],
      "vendor/model-b": [
        { type: "start", model: "vendor/model-b" },
        { type: "textStart", blockIndex: 0 },
        { type: "textDelta", blockIndex: 0, delta: "B" },
        endEvent("B", "vendor/model-b"),
      ],
    });

    const events = await collect(
      streamFailover(
        [
          { client, model: specA },
          { client, model: specB },
        ],
        { model: specA, messages: [userMessage("hi")] },
      ),
    );

    // The turn stayed committed to A: its partial tool call and its error are
    // what the caller sees, and B was never asked.
    expect((events.find((e) => e.type === "start") as { model: string }).model).toBe(
      "vendor/model-a",
    );
    expect(events.some((e) => e.type === "toolCallStart")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((e) => e.type === "end")).toBe(false);
  });
});
