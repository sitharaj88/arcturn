/**
 * A scripted {@link LLMClient} that replays fixed {@link StreamEvent}
 * sequences. Used by the core test suite; exported so hosts can test their own
 * tools and hooks without a network.
 */

import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  ModelSpec,
  StreamEvent,
  ToolCallContent,
  Usage,
} from "@arcturn/types";

/** A model spec suitable for tests. */
export const TEST_MODEL: ModelSpec = {
  id: "test/model",
  provider: "anthropic",
  model: "test-model",
  displayName: "Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: true, caching: true },
};

/** Usage helper with sensible zeroes. */
export function usage(inputTokens = 10, outputTokens = 5): Usage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Build the assistant message a scripted turn should end with. */
function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  turnUsage: Usage,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: TEST_MODEL.model,
    usage: turnUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Script a turn that streams plain text and then ends.
 *
 * @param value - Text the model "writes".
 * @param turnUsage - Usage reported for the turn.
 */
export function textTurn(value: string, turnUsage: Usage = usage()): StreamEvent[] {
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "textStart", blockIndex: 0 },
    { type: "textDelta", blockIndex: 0, delta: value },
    { type: "blockEnd", blockIndex: 0 },
    { type: "usage", usage: turnUsage },
    {
      type: "end",
      message: assistantMessage([{ type: "text", text: value }], "endTurn", turnUsage),
    },
  ];
}

/** A tool call to script into a turn. */
export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Script a turn that emits one or more tool calls.
 *
 * @param calls - The calls the model makes.
 * @param preface - Optional text streamed before the calls.
 * @param turnUsage - Usage reported for the turn.
 */
export function toolCallTurn(
  calls: ScriptedToolCall[],
  preface?: string,
  turnUsage: Usage = usage(),
): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "start", model: TEST_MODEL.model }];
  const content: AssistantMessage["content"] = [];
  let blockIndex = 0;

  if (preface !== undefined) {
    events.push(
      { type: "textStart", blockIndex },
      { type: "textDelta", blockIndex, delta: preface },
      { type: "blockEnd", blockIndex },
    );
    content.push({ type: "text", text: preface });
    blockIndex++;
  }

  for (const call of calls) {
    const block: ToolCallContent = {
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    };
    events.push(
      { type: "toolCallStart", blockIndex, id: call.id, name: call.name },
      { type: "toolCallDelta", blockIndex, argumentsDelta: JSON.stringify(call.arguments) },
      {
        type: "toolCallEnd",
        blockIndex,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      },
      { type: "blockEnd", blockIndex },
    );
    content.push(block);
    blockIndex++;
  }

  events.push(
    { type: "usage", usage: turnUsage },
    { type: "end", message: assistantMessage(content, "toolCalls", turnUsage) },
  );
  return events;
}

/**
 * Script a turn that fails.
 *
 * @param message - Error text reported by the provider.
 * @param kind - Error classification.
 */
export function errorTurn(
  message: string,
  kind: "network" | "overloaded" = "network",
): StreamEvent[] {
  const partial = assistantMessage([], "error", usage(0, 0));
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "error", error: { kind, message }, message: { ...partial, errorMessage: message } },
  ];
}

/** A scripted client plus the requests it received. */
export interface ScriptedLLM extends LLMClient {
  /** Every request the agent made, in order. */
  readonly requests: LLMRequest[];
  /** Number of scripted turns consumed so far. */
  readonly consumed: number;
  /** Append more turns while a test is running. */
  push(...turns: StreamEvent[][]): void;
}

/** Options for {@link createScriptedLLM}. */
export interface ScriptedLLMOptions {
  /** Invoked before each event is yielded; use it to abort mid-stream. */
  onEvent?: (event: StreamEvent, index: number) => void | Promise<void>;
  /** Invoked before each turn starts. */
  onTurn?: (request: LLMRequest, turnIndex: number) => void | Promise<void>;
}

/**
 * Create a scripted LLM client.
 *
 * Each call to `stream` (or `complete`) consumes the next scripted turn. When
 * the script runs out the client yields a plain "done" text turn, so a test
 * that under-scripts terminates instead of hanging. Aborting the request's
 * signal ends the stream with an `aborted` error event, mirroring a real
 * provider.
 *
 * @param script - Turns to replay, in order.
 * @param options - Optional per-event and per-turn callbacks.
 */
export function createScriptedLLM(
  script: StreamEvent[][],
  options: ScriptedLLMOptions = {},
): ScriptedLLM {
  const turns = [...script];
  const requests: LLMRequest[] = [];
  let turnIndex = 0;

  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    requests.push(request);
    const events = turns[turnIndex] ?? textTurn("done");
    const index = turnIndex;
    turnIndex++;
    await options.onTurn?.(request, index);

    for (const [eventIndex, event] of events.entries()) {
      await options.onEvent?.(event, eventIndex);
      if (request.signal?.aborted) {
        yield {
          type: "error",
          error: { kind: "aborted", message: "Aborted" },
          message: {
            role: "assistant",
            content: [],
            model: request.model.model,
            usage: usage(0, 0),
            stopReason: "aborted",
            timestamp: Date.now(),
          },
        };
        return;
      }
      yield event;
    }
  }

  return {
    stream,
    async complete(request: LLMRequest): Promise<AssistantMessage> {
      let final: AssistantMessage | undefined;
      for await (const event of stream(request)) {
        if (event.type === "end" || event.type === "error") final = event.message;
      }
      if (!final) throw new Error("Scripted stream produced no final message");
      return final;
    },
    get requests(): LLMRequest[] {
      return requests;
    },
    get consumed(): number {
      return turnIndex;
    },
    push(...next: StreamEvent[][]): void {
      turns.push(...next);
    },
  };
}
