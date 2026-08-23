/** Shared fixtures for the colocated unit tests. Excluded from the build. */

import type {
  AssistantMessage,
  ModelSpec,
  StreamEvent,
  ToolResultMessage,
  UserMessage,
} from "@arcturn/types";

/** A model spec with every capability enabled and simple round pricing. */
export function modelSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id: "anthropic/test-model",
    provider: "anthropic",
    model: "test-model",
    displayName: "Test Model",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    capabilities: { tools: true, vision: true, thinking: true, caching: true },
    ...overrides,
  };
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export function imageMessage(data: string, mimeType = "image/png"): UserMessage {
  return { role: "user", content: [{ type: "image", data, mimeType }], timestamp: 1 };
}

export function assistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    model: "anthropic/test-model",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "endTurn",
    timestamp: 2,
    ...overrides,
  };
}

export function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
    ...overrides,
  };
}

/** Turn an array into an async iterable, as the SDK streams do. */
export async function* asyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** Collect every event a stream emits. */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Concatenate all text deltas in an event list. */
export function textOf(events: StreamEvent[]): string {
  return events
    .filter(
      (event): event is Extract<StreamEvent, { type: "textDelta" }> => event.type === "textDelta",
    )
    .map((event) => event.delta)
    .join("");
}

/** The terminal event of a stream. */
export function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "end" | "error" }> {
  const last = events[events.length - 1];
  if (!last || (last.type !== "end" && last.type !== "error")) {
    throw new Error(`Expected a terminal event, saw ${last?.type}`);
  }
  return last;
}
