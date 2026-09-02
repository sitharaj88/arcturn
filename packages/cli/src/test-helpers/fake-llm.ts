/**
 * A scripted {@link LLMClient} for headless tests.
 *
 * Excluded from the build (see `tsconfig.json`), so it is never part of the
 * published API. Every turn is described declaratively and replayed as a
 * well-formed stream: `start` → blocks → `usage` → `end`.
 */

import type { AssistantMessage, LLMClient, LLMRequest, StreamEvent, Usage } from "@arcturn/types";

/** One scripted assistant turn. */
export interface ScriptedTurn {
  /** Text the model "says". */
  text?: string;
  /** Tool calls the model makes; the loop will run them and ask again. */
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** Usage reported for the turn. */
  usage?: Partial<Usage>;
  /** Terminate the stream with an error instead of `end`. */
  error?: string;
  /** Delay before the terminal event, so tests can act mid-run. */
  delayMs?: number;
}

/** A fake client plus a record of the requests it received. */
export interface FakeLLM extends LLMClient {
  /** Every request the agent made, in order. */
  readonly requests: LLMRequest[];
}

function usageOf(partial: Partial<Usage> | undefined): Usage {
  return {
    inputTokens: partial?.inputTokens ?? 10,
    outputTokens: partial?.outputTokens ?? 5,
    cacheReadTokens: partial?.cacheReadTokens ?? 0,
    cacheWriteTokens: partial?.cacheWriteTokens ?? 0,
    ...(partial?.costUsd === undefined ? {} : { costUsd: partial.costUsd }),
  };
}

/**
 * The one stream implementation behind {@link fakeLLM} and {@link respondingLLM}.
 *
 * `next` decides *what* the model says to a request; this decides *how* it is
 * said — one well-formed stream per request, the request recorded first so a
 * `next` that throws still leaves it on the record.
 *
 * @param next - Picks the turn for each request, in arrival order.
 */
function fakeClient(next: (request: LLMRequest) => ScriptedTurn): FakeLLM {
  const requests: LLMRequest[] = [];

  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    requests.push(request);
    const turn = next(request);

    const modelId = request.model.id;
    yield { type: "start", model: modelId };

    const content: AssistantMessage["content"] = [];
    let block = 0;

    if (turn.text !== undefined) {
      yield { type: "textStart", blockIndex: block };
      for (const chunk of turn.text.match(/.{1,16}/gs) ?? []) {
        yield { type: "textDelta", blockIndex: block, delta: chunk };
      }
      yield { type: "blockEnd", blockIndex: block };
      content.push({ type: "text", text: turn.text });
      block++;
    }

    for (const call of turn.toolCalls ?? []) {
      yield { type: "toolCallStart", blockIndex: block, id: call.id, name: call.name };
      yield {
        type: "toolCallDelta",
        blockIndex: block,
        argumentsDelta: JSON.stringify(call.arguments),
      };
      yield {
        type: "toolCallEnd",
        blockIndex: block,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      };
      yield { type: "blockEnd", blockIndex: block };
      content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
      block++;
    }

    if (turn.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    }

    const usage = usageOf(turn.usage);
    yield { type: "usage", usage };

    const message: AssistantMessage = {
      role: "assistant",
      content,
      model: modelId,
      usage,
      stopReason: turn.error
        ? "error"
        : (turn.toolCalls?.length ?? 0) > 0
          ? "toolCalls"
          : "endTurn",
      ...(turn.error === undefined ? {} : { errorMessage: turn.error }),
      timestamp: Date.now(),
    };

    if (turn.error !== undefined) {
      yield { type: "error", error: { kind: "unknown", message: turn.error }, message };
      return;
    }
    yield { type: "end", message };
  }

  return {
    requests,
    stream,
    async complete(request: LLMRequest): Promise<AssistantMessage> {
      let last: AssistantMessage | undefined;
      for await (const event of stream(request)) {
        if (event.type === "end" || event.type === "error") last = event.message;
      }
      if (!last) throw new Error("fake client produced no terminal message");
      return last;
    },
  };
}

/**
 * Build a scripted client.
 *
 * @param turns - One entry per model turn. The last turn repeats if the agent
 *   asks for more, which keeps a runaway loop from hanging a test.
 */
export function fakeLLM(turns: readonly ScriptedTurn[]): FakeLLM {
  let index = 0;
  return fakeClient(() => {
    const turn = turns[Math.min(index, turns.length - 1)] ?? {};
    index++;
    return turn;
  });
}

/**
 * Build a client that decides each turn from the request it was sent.
 *
 * Where {@link fakeLLM} replays a fixed sequence, this answers *whatever* the
 * agent asks — the shape a test needs when it does not know in advance how
 * many steps, tool results and nudges a real pipeline will produce. The
 * stream a turn becomes is exactly {@link fakeLLM}'s.
 *
 * @param respond - Called once per request, in order; its turn is streamed.
 */
export function respondingLLM(respond: (request: LLMRequest) => ScriptedTurn): FakeLLM {
  return fakeClient(respond);
}
