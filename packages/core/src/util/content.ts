/** Small helpers for building and reading message content blocks. */

import type {
  AssistantContent,
  AssistantMessage,
  Message,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  ToolResultMessage,
  Usage,
  UserContent,
  UserMessage,
} from "@arcturn/types";

/**
 * Build a text content block.
 *
 * @param value - Plain text.
 */
export function text(value: string): TextContent {
  return { type: "text", text: value };
}

/**
 * Concatenate the text blocks of a content array.
 *
 * @param content - Any content array containing optional text blocks.
 * @param separator - Joins consecutive text blocks (default `"\n"`).
 */
export function contentText(
  content: ReadonlyArray<AssistantContent | UserContent | ToolResultContent>,
  separator = "\n",
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join(separator);
}

/**
 * Normalize a prompt input into user content blocks.
 *
 * @param input - Raw string or ready-made content blocks.
 */
export function toUserContent(input: string | UserContent[]): UserContent[] {
  return typeof input === "string" ? [text(input)] : input;
}

/**
 * Create a {@link UserMessage}.
 *
 * @param input - Raw string or content blocks.
 * @param timestamp - Creation time, defaults to now.
 */
export function userMessage(input: string | UserContent[], timestamp = Date.now()): UserMessage {
  return { role: "user", content: toUserContent(input), timestamp };
}

/** An all-zero {@link Usage} record. */
export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Add two usage records together.
 *
 * @param a - Left operand.
 * @param b - Right operand.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  const cost =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/**
 * Extract the tool calls from an assistant message.
 *
 * @param message - Assistant message to inspect.
 */
export function toolCallsOf(message: AssistantMessage): ToolCallContent[] {
  return message.content.filter((block): block is ToolCallContent => block.type === "toolCall");
}

/**
 * Create a {@link ToolResultMessage}.
 *
 * @param toolCallId - Id of the originating tool call.
 * @param toolName - Tool that produced (or failed to produce) the result.
 * @param content - Result content blocks.
 * @param isError - Whether the result represents a failure.
 * @param details - Optional structured payload.
 * @param structuredContent - Optional structured output payload (e.g. an MCP tool's `structuredContent`).
 */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: ToolResultContent[],
  isError: boolean,
  details?: Record<string, unknown>,
  structuredContent?: unknown,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    ...(details === undefined ? {} : { details }),
    ...(structuredContent === undefined ? {} : { structuredContent }),
    timestamp: Date.now(),
  };
}

/**
 * Build an error tool result message from a plain string.
 *
 * @param toolCallId - Id of the originating tool call.
 * @param toolName - Tool name.
 * @param message - Human-readable error text handed back to the model.
 * @param details - Optional structured payload.
 */
export function errorToolResult(
  toolCallId: string,
  toolName: string,
  message: string,
  details?: Record<string, unknown>,
): ToolResultMessage {
  return toolResultMessage(toolCallId, toolName, [text(message)], true, details);
}

/**
 * Find the text of the last assistant message in a conversation.
 *
 * @param messages - Conversation history.
 * @returns The concatenated text, or an empty string when there is none.
 */
export function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") {
      const value = contentText(message.content);
      if (value.trim().length > 0) return value;
    }
  }
  return "";
}

/**
 * Convert an unknown thrown value into a readable message.
 *
 * @param error - Any thrown value.
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
