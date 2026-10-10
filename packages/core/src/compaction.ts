/**
 * Context compaction: estimate how full the context window is, pick a safe cut
 * point at a turn boundary, and fold everything before it into a structured
 * markdown summary produced by the injected LLM client.
 *
 * ## Shapes
 *
 * - `"keep-tail"` — summarize the head, keep the most recent turns verbatim.
 *   On a Claude model with adaptive thinking the kept tail is replayed without
 *   its thinking blocks: they were produced with the whole history present, and
 *   on the preserved-thinking models (Fable 5.1, Opus 5.5, Sonnet 5.5,
 *   Haiku 5.5) replaying them after a summary is a 400 on an enforced account.
 * - `"simple"` — one summary replaces the **whole** history and nothing earlier
 *   is replayed: no turns, no thinking. Only a trailing run of user (and
 *   operator) messages — the new request, which carries no thinking — survives
 *   it. The recommended shape under preserved thinking, and the default there.
 * - `"server"` — the provider compacts (Anthropic `compact_20260112`); arcturn
 *   never summarizes locally and replays the returned compaction block verbatim.
 *
 * No shape ever cuts through a tool round: an assistant turn whose tool call is
 * still waiting on its result goes back whole, thinking and all.
 */

import type { LLMClient, Message, ModelSpec } from "@arcturn/types";
import { isAdaptiveAnthropic } from "./model-traits.js";
import { contentText, text, userMessage, withoutThinking } from "./util/content.js";

/** How compaction rewrites history; see the module comment. */
export type CompactionShape = "keep-tail" | "simple" | "server";

/** Every {@link CompactionShape}, for validators and pickers. */
export const COMPACTION_SHAPES: readonly CompactionShape[] = ["keep-tail", "simple", "server"];

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
  /**
   * How history is rewritten. Defaults per model: `"simple"` on a Claude model
   * with adaptive thinking, `"keep-tail"` everywhere else. `"server"` hands
   * compaction to the provider and is refused by providers that lack it.
   */
  shape?: CompactionShape;
}

/** Resolved compaction settings. */
export interface ResolvedCompactionOptions {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  maxOutputTokens: number;
  model: ModelSpec | undefined;
  buildPrompt: (conversation: string) => string;
  /** The explicitly configured shape; `undefined` means "the model's default". */
  shape: CompactionShape | undefined;
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
    shape: options.shape,
  };
}

/**
 * The shape compaction takes for `model`, and why — for `arcturn doctor`.
 *
 * @param options - Compaction options; only `shape` matters.
 * @param model - The model the session talks to.
 */
export function explainCompactionShape(
  options: Pick<CompactionOptions, "shape">,
  model: ModelSpec,
): { shape: CompactionShape; reason: string } {
  if (options.shape !== undefined) {
    return { shape: options.shape, reason: "set by compaction.shape" };
  }
  if (isAdaptiveAnthropic(model)) {
    return {
      shape: "simple",
      reason:
        "default for Claude with adaptive thinking: its thinking is bound to the conversation " +
        "that produced it, so nothing from before a summary is replayed",
    };
  }
  return { shape: "keep-tail", reason: "default: this model's thinking is not bound to history" };
}

/**
 * Resolve the compaction shape for `model`: the configured one, else
 * `"simple"` on a Claude model with adaptive thinking, else `"keep-tail"`.
 *
 * @param options - Compaction options; only `shape` matters.
 * @param model - The model the session talks to.
 */
export function resolveCompactionShape(
  options: Pick<CompactionOptions, "shape">,
  model: ModelSpec,
): CompactionShape {
  return explainCompactionShape(options, model).shape;
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
 * Whether the last tool round is still open: an assistant turn that called a
 * tool whose result has not been appended yet. Compaction waits it out.
 *
 * @param messages - Conversation history, oldest first.
 */
export function hasPendingToolRound(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const calls = message.content.filter((block) => block.type === "toolCall");
    if (calls.length === 0) return false;
    const answered = new Set<string>();
    for (const later of messages.slice(i + 1)) {
      if (later.role === "toolResult") answered.add(later.toolCallId);
    }
    return calls.some((call) => !answered.has(call.id));
  }
  return false;
}

/**
 * Find the cut for the `"simple"` shape: everything is folded except a
 * trailing run of user and operator messages — the new request, which carries
 * no thinking and so cannot be bound to the history it follows.
 *
 * @param messages - Conversation history, oldest first.
 * @returns The index of the first kept message (`messages.length` keeps
 *   nothing), or `0` when nothing can be folded — an empty or user-only
 *   history, or an open tool round.
 */
export function findSimpleCutPoint(messages: readonly Message[]): number {
  if (hasPendingToolRound(messages)) return 0;
  let cut = messages.length;
  while (cut > 0) {
    const role = messages[cut - 1]!.role;
    if (role !== "user" && role !== "system") break;
    cut--;
  }
  return cut;
}

/**
 * Find the cut for a shape.
 *
 * @param messages - Conversation history, oldest first.
 * @param shape - `"keep-tail"` or `"simple"`; `"server"` never cuts locally.
 * @param keepRecentTokens - Recent tokens a keep-tail cut preserves.
 * @returns The index of the first kept message, or `0` for "nothing to fold".
 */
export function findCompactionCut(
  messages: readonly Message[],
  shape: CompactionShape,
  keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS,
): number {
  if (shape === "server") return 0;
  if (shape === "simple") return findSimpleCutPoint(messages);
  return findCutPoint(messages, keepRecentTokens);
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
      for (const block of message.content) {
        if (block.type === "compaction" && block.summary) {
          parts.push(`[Earlier summary]: ${block.summary}`);
        }
      }
      continue;
    }
    if (message.role === "system") {
      const value = contentText(message.content);
      if (value) parts.push(`[Operator]: ${value}`);
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
    "## Reasoning to carry forward",
    "The transcript omits the assistant's private reasoning, and none of it survives this " +
      "summary: the summary is all the next agent will have. From what the assistant did " +
      "and said, record the hypotheses it was testing, what it ruled out and why, and what " +
      "it was about to try.",
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
  /** The shape that produced this result. */
  shape: CompactionShape;
  /** True when the kept tail's assistant messages were replayed without their thinking. */
  stripTailThinking: boolean;
  /**
   * For each message after the summary in {@link CompactionResult.messages},
   * its index in the input — a stripped message is a new object, and this is
   * how a caller maps it back to where it came from.
   */
  keptIndices: number[];
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
 * @throws When the summarizer returns an error message or empty text, and for
 *   the `"server"` shape, which the provider runs instead.
 */
export async function compactMessages(
  input: CompactMessagesInput,
): Promise<CompactionResult | undefined> {
  const options = resolveCompactionOptions(input.options);
  const shape = resolveCompactionShape(options, input.model);
  if (shape === "server") {
    throw new Error(
      'compaction.shape is "server": the provider compacts this conversation itself, so ' +
        "there is nothing to summarize locally.",
    );
  }
  const messages = input.messages;
  const cutIndex = findCompactionCut(messages, shape, options.keepRecentTokens);
  if (cutIndex <= 0) return undefined;

  const head = messages.slice(0, cutIndex);
  // A kept tail's thinking was produced over the history this summary
  // replaces; on adaptive Claude that binding makes it unreplayable.
  const stripTailThinking = shape === "keep-tail" && isAdaptiveAnthropic(input.model);
  const tail: Message[] = [];
  const keptIndices: number[] = [];
  for (let index = cutIndex; index < messages.length; index++) {
    const message = messages[index]!;
    const kept =
      stripTailThinking && message.role === "assistant" ? withoutThinking(message) : message;
    // A turn that was nothing but thinking has nothing left to replay.
    if (kept.role === "assistant" && kept.content.length === 0) continue;
    tail.push(kept);
    keptIndices.push(index);
  }
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
  // A declined summary is not a short one: whatever streamed before the
  // refusal is a fragment, and installing it would replace real history.
  if (response.stopReason === "refusal") {
    const category = response.stopDetails?.category;
    throw new Error(`Summarization was declined by the model${category ? ` (${category})` : ""}`);
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
    shape,
    stripTailThinking,
    keptIndices,
  };
}
