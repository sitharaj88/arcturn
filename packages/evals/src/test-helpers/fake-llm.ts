/**
 * A scripted {@link LLMClient} for the harness's own unit tests.
 *
 * It never touches the network: each call to `stream`/`complete` consumes the
 * next pre-recorded turn (plain text, or one or more tool calls), so a test
 * can drive a real {@link Agent} through a real tool chain deterministically.
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

/** A model spec suitable for tests; never resolves against a real provider. */
export const FAKE_MODEL: ModelSpec = {
  id: "test/fake-model",
  provider: "anthropic",
  model: "fake-model",
  displayName: "Fake Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

/** Usage stub with sensible zeroes. */
export function fakeUsage(inputTokens = 10, outputTokens = 5): Usage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  turnUsage: Usage,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: FAKE_MODEL.model,
    usage: turnUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

/** Script a turn that streams plain text and ends the run. */
export function textTurn(value: string, turnUsage: Usage = fakeUsage()): StreamEvent[] {
  return [
    { type: "start", model: FAKE_MODEL.model },
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

/** A tool call scripted into a turn. */
export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Script a turn that emits one or more tool calls, optionally prefaced by text. */
export function toolCallTurn(
  calls: ScriptedToolCall[],
  preface?: string,
  turnUsage: Usage = fakeUsage(),
): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "start", model: FAKE_MODEL.model }];
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
      { type: "toolCallEnd", blockIndex, id: call.id, name: call.name, arguments: call.arguments },
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

/** A scripted client plus the requests it received, for assertions in tests. */
export interface ScriptedLLM extends LLMClient {
  /** Every request the agent made, in order. */
  readonly requests: LLMRequest[];
  /** Number of scripted turns consumed so far. */
  readonly consumed: number;
}

/**
 * Create a scripted LLM client that replays `script` in order.
 *
 * Running past the end of the script yields a plain `"done"` text turn, so an
 * under-scripted test terminates instead of hanging. Aborting the request's
 * signal ends the stream with an `aborted` error, mirroring a real provider.
 */
export function createScriptedLLM(script: StreamEvent[][]): ScriptedLLM {
  const turns = [...script];
  const requests: LLMRequest[] = [];
  let turnIndex = 0;

  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    requests.push(request);
    const events = turns[turnIndex] ?? textTurn("done");
    turnIndex++;

    for (const event of events) {
      if (request.signal?.aborted) {
        yield {
          type: "error",
          error: { kind: "aborted", message: "Aborted" },
          message: {
            role: "assistant",
            content: [],
            model: request.model.model,
            usage: fakeUsage(0, 0),
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
  };
}
