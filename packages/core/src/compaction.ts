/**
 * Context compaction: estimate how full the context window is, pick a safe cut
 * point at a turn boundary, and fold everything before it into a structured
 * markdown summary produced by the injected LLM client.
 */

import type { LLMClient, Message, ModelSpec } from "@arcturn/types";
import { contentText, text, userMessage } from "./util/content.js";

/** Tokens held back for the next response and system prompt. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** Recent conversation, in tokens, that compaction tries to preserve verbatim. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** Rough characters-per-token ratio used for un-metered tail messages. */
const CHARS_PER_TOKEN = 4;

/** Tool result text longer than this is truncated inside the summary prompt. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** Tuning knobs for automatic and manual compaction. */
export interface CompactionOptions {
  /** Set to `false` to disable automatic compaction. Defaults to `true`. */
  enabled?: boolean;
  /** Head-room kept free in the context window. Defaults to 16384. */
  reserveTokens?: number;
  /** Recent tokens preserved verbatim. Defaults to 20000. */
  keepRecentTokens?: number;
  /** Model used for summarization; defaults to the agent's current model. */
  model?: ModelSpec;
  /** Replace the summarization prompt entirely. */
  buildPrompt?: (conversation: string) => string;
  /** Output budget for the summarizer call. Defaults to 4096. */
  maxOutputTokens?: number;
}

/** Resolved compaction settings. */
export interface ResolvedCompactionOptions {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  maxOutputTokens: number;
  model: ModelSpec | undefined;
  buildPrompt: (conversation: string) => string;
}

/**
 * Fill in compaction defaults.
 *
 * @param options - Partial user options.
 */
export function resolveCompactionOptions(
  options: CompactionOptions = {},
): ResolvedCompactionOptions {
  return {
    enabled: options.enabled ?? true,
    reserveTokens: options.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    maxOutputTokens: options.maxOutputTokens ?? 4_096,
    model: options.model,
    buildPrompt: options.buildPrompt ?? buildSummaryPrompt,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Approximate the token cost of a single message from its serialized size.
 *
 * @param message - Message to measure.
 */
export function estimateMessageTokens(message: Message): number {
  return Math.ceil(safeStringify(message).length / CHARS_PER_TOKEN);
}

/**
 * Estimate how many context tokens a conversation currently occupies.
 *
 * The last assistant message that reported real usage anchors the estimate;
 * everything after it is approximated at ~4 characters per token. That keeps
 * the number honest for long histories without re-tokenizing anything.
 *
 * @param messages - Conversation history, oldest first.
 */
export function estimateTokens(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = message.usage;
    const metered = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (metered <= 0) continue;
    let tail = 0;
    for (let j = i + 1; j < messages.length; j++) tail += estimateMessageTokens(messages[j]!);
    return metered + tail;
  }
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/**
 * Decide whether the conversation should be compacted before the next turn.
 *
 * @param tokens - Current estimated context size.
 * @param contextWindow - The model's context window.
 * @param options - Compaction options; only `reserveTokens` matters here.
 */
export function shouldCompact(
  tokens: number,
  contextWindow: number,
  options: CompactionOptions = {},
): boolean {
  const reserve = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const threshold = contextWindow - reserve;
  if (threshold <= 0) return tokens > 0;
  return tokens > threshold;
}

/**
 * Find the index to cut history at, keeping roughly `keepRecentTokens` of
 * recent conversation.
 *
 * The cut always lands on a user message, which is the only place that can
 * never sit between an assistant tool call and its results.
 *
 * @param messages - Conversation history, oldest first.
 * @param keepRecentTokens - Recent tokens to preserve verbatim.
 * @returns The index of the first kept message, or `0` when nothing can be
 *   safely folded away.
 */
export function findCutPoint(
  messages: readonly Message[],
  keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS,
): number {
  if (messages.length < 2) return 0;

  let accumulated = 0;
  let candidate = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]!);
    if (accumulated >= keepRecentTokens) {
      candidate = i;
      break;
    }
    candidate = i;
  }

  // Snap back to the nearest user message that still leaves history to fold.
  for (let i = Math.min(candidate, messages.length - 1); i > 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return 0;
}

/**
 * Render a conversation as plain text for the summarizer.
 *
 * @param messages - Messages to serialize.
 */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const value = contentText(message.content);
      if (value) parts.push(`[User]: ${value}`);
      continue;
    }
    if (message.role === "assistant") {
      const value = contentText(message.content);
      if (value) parts.push(`[Assistant]: ${value}`);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => {
          const args = Object.entries(block.arguments)
            .map(([key, argValue]) => `${key}=${safeStringify(argValue)}`)
            .join(", ");
          return `${block.name}(${args})`;
        });
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
      continue;
    }
    const value = contentText(message.content);
    if (!value) continue;
    const truncated =
      value.length > TOOL_RESULT_MAX_CHARS
        ? `${value.slice(0, TOOL_RESULT_MAX_CHARS)}\n[... ${value.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`
        : value;
    parts.push(
      `[Tool result${message.isError ? " (error)" : ""} ${message.toolName}]: ${truncated}`,
    );
  }
  return parts.join("\n\n");
}

/** System prompt used for the summarization call. */
export const SUMMARY_SYSTEM_PROMPT =
  "You compress coding-agent transcripts. Preserve every fact a fresh agent " +
  "would need to continue the work: file paths, identifiers, decisions, and " +
  "outstanding problems. Never invent information and never ask questions.";

/**
 * Build the structured markdown summarization prompt.
 *
 * @param conversation - Serialized conversation to compress.
 */
export function buildSummaryPrompt(conversation: string): string {
  return [
    "Summarize the conversation below so work can continue without it.",
    "",
    "Reply with exactly these markdown sections, in this order:",
    "",
    "## Goal",
    "What the user is ultimately trying to achieve.",
    "",
    "## Progress",
    "What has been done so far, including files created or modified.",
    "",
    "## Key decisions",
    "Choices made and the reasoning behind them.",
    "",
    "## Next steps",
    "The concrete remaining work, in order.",
    "",
    "## Critical context",
    "Exact paths, identifiers, commands, constraints and gotchas to carry forward.",
    "",
    "---",
    "",
    conversation,
  ].join("\n");
}

/** Result of a successful compaction. */
export interface CompactionResult {
  /** The rewritten conversation: summary message followed by the kept tail. */
  messages: Message[];
  /** The raw markdown summary. */
  summary: string;
  /** Index in the original array where the kept tail began. */
  cutIndex: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** Inputs for {@link compactMessages}. */
export interface CompactMessagesInput {
  llm: LLMClient;
  model: ModelSpec;
  messages: readonly Message[];
  options?: CompactionOptions;
  signal?: AbortSignal;
}

/**
 * Summarize the head of a conversation and return the compacted history.
 *
 * @param input - Client, model, history and options.
 * @returns The compaction result, or `undefined` when no safe cut point exists.
 * @throws When the summarizer returns an error message or empty text.
 */
export async function compactMessages(
  input: CompactMessagesInput,
): Promise<CompactionResult | undefined> {
  const options = resolveCompactionOptions(input.options);
  const messages = input.messages;
  const cutIndex = findCutPoint(messages, options.keepRecentTokens);
  if (cutIndex <= 0) return undefined;

  const head = messages.slice(0, cutIndex);
  const tail = messages.slice(cutIndex);
  const tokensBefore = estimateTokens(messages);

  const prompt = options.buildPrompt(serializeConversation(head));
  const response = await input.llm.complete({
    model: options.model ?? input.model,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [userMessage(prompt)],
    maxOutputTokens: options.maxOutputTokens,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "Summarization failed");
  }
  const summary = contentText(response.content).trim();
  if (summary.length === 0) throw new Error("Summarization produced no text");

  const summaryMessage: Message = {
    role: "user",
    content: [text(`<compacted-history>\n${summary}\n</compacted-history>`)],
    timestamp: Date.now(),
  };
  const compacted: Message[] = [summaryMessage, ...tail];

  return {
    messages: compacted,
    summary,
    cutIndex,
    tokensBefore,
    tokensAfter: compacted.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
  };
}
