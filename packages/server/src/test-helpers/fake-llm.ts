/**
 * A tiny scripted {@link LLMClient} for this package's tests — no network, no
 * dependency on `@arcturn/core`'s internal test helpers (out of scope per
 * the task brief). Excluded from the build by `tsconfig.json`.
 */

import type {
  AssistantMessage,
  LLMClient,
  LLMRequest,
  ModelSpec,
  StreamEvent,
  Usage,
} from "@arcturn/types";

/** A minimal model spec suitable for tests. */
export const TEST_MODEL: ModelSpec = {
  id: "test/fake-model",
  provider: "anthropic",
  model: "fake-model",
  displayName: "Fake Test Model",
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: false, thinking: false, caching: false },
};

function usage(): Usage {
  return { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Script a turn that streams plain text, then ends with `endTurn`. */
export function textTurn(value: string): StreamEvent[] {
  const turnUsage = usage();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: value }],
    model: TEST_MODEL.model,
    usage: turnUsage,
    stopReason: "endTurn",
    timestamp: Date.now(),
  };
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "textStart", blockIndex: 0 },
    { type: "textDelta", blockIndex: 0, delta: value },
    { type: "blockEnd", blockIndex: 0 },
    { type: "usage", usage: turnUsage },
    { type: "end", message },
  ];
}

/** Script a turn that calls a single tool, then ends with `toolCalls`. */
export function toolCallTurn(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  const turnUsage = usage();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
    model: TEST_MODEL.model,
    usage: turnUsage,
    stopReason: "toolCalls",
    timestamp: Date.now(),
  };
  return [
    { type: "start", model: TEST_MODEL.model },
    { type: "toolCallStart", blockIndex: 0, id: toolCallId, name: toolName },
    { type: "toolCallDelta", blockIndex: 0, argumentsDelta: JSON.stringify(args) },
    { type: "toolCallEnd", blockIndex: 0, id: toolCallId, name: toolName, arguments: args },
    { type: "blockEnd", blockIndex: 0 },
    { type: "usage", usage: turnUsage },
    { type: "end", message },
  ];
}

/** A scripted client whose single turn only starts once `release()` is called. */
export interface GatedLLM extends LLMClient {
  /** Let the in-flight `stream()` call proceed past its gate. */
  release: () => void;
}

/**
 * Build an `LLMClient` whose turn blocks until `release()` is called —
 * useful for tests that need to observe an agent mid-run (e.g. to assert
 * `sessionBusy` on a concurrent prompt) before letting it complete.
 */
export function createGatedLLM(finalTurn: StreamEvent[] = textTurn("done")): GatedLLM {
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  async function* stream(_request: LLMRequest): AsyncIterable<StreamEvent> {
    await gate;
    for (const event of finalTurn) yield event;
  }

  return {
    stream,
    async complete(request: LLMRequest): Promise<AssistantMessage> {
      let final: AssistantMessage | undefined;
      for await (const event of stream(request)) {
        if (event.type === "end" || event.type === "error") final = event.message;
      }
      if (!final) throw new Error("Gated stream produced no final message");
      return final;
    },
    release: () => releaseGate(),
  };
}

/** A scripted client that replays fixed turns, one per `stream()` call. */
export interface ScriptedLLM extends LLMClient {
  readonly requests: LLMRequest[];
}

/**
 * Build a scripted `LLMClient`. Each call to `stream` consumes the next
 * scripted turn; once the script is exhausted, a plain `textTurn("done")` is
 * replayed so an under-scripted test terminates instead of hanging.
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
  };
}
