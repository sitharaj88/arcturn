/** Provider-agnostic message and content types. */

export type Role = "system" | "user" | "assistant" | "toolResult";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** Base64-encoded image data. */
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Provider-specific signature/opaque blob needed to replay thinking. */
  signature?: string;
}

export interface ToolCallContent {
  type: "toolCall";
  /** Provider-assigned id, unique within the conversation. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque provider signature over this call, replayed verbatim on the next
   * request when the provider issued one.
   *
   * Gemini 3 signs the tool *call*, not only the thinking that led to it, and
   * rejects the follow-up turn with `400 INVALID_ARGUMENT` when the signature
   * does not come back — so dropping it breaks every multi-turn tool use,
   * which is the agent loop itself. Parallel to {@link ThinkingContent.signature},
   * which exists because Anthropic rejects unsigned thinking the same way.
   *
   * Absent for providers that do not sign tool calls. Never interpreted here:
   * it is the provider's token, and this layer only carries it back.
   */
  signature?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;
export type UserContent = TextContent | ImageContent;
export type ToolResultContent = TextContent | ImageContent;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Output tokens the model spent on internal reasoning, when the provider
   * reports the breakdown.
   *
   * A subset of `outputTokens` (which stays the authoritative billed total),
   * so cost consumers must not add it in separately — it is an observability
   * signal for how much of the output spend went to thinking. Absent when the
   * provider reports no breakdown.
   */
  thinkingTokens?: number;
  /** Estimated cost in USD, when the model's pricing is known. */
  costUsd?: number;
}

/**
 * Why an assistant turn ended.
 *
 * `refusal` is a finished turn, not a failed one: the provider answered — a
 * safety classifier or content filter declined the request (Anthropic's
 * `stop_reason: "refusal"`, OpenAI's `content_filter`, Gemini's `SAFETY`).
 * Nothing about it is retryable as-is, and it is not an `error`.
 */
export type StopReason = "endTurn" | "toolCalls" | "maxTokens" | "refusal" | "aborted" | "error";

/**
 * What the provider said about a refusal.
 *
 * Informational only — branch on `stopReason`, never on this. The category is
 * an open set (`"cyber"`, `"bio"`, `"reasoning_extraction"`, `"frontier_llm"`,
 * `"general_harms"` on Claude; the filter's own name elsewhere, e.g.
 * `"content_filter"`, `"safety"`), and `null` is a valid, permanent value.
 */
export interface StopDetails {
  category: string | null;
  /** Provider-supplied explanation, when one was given. */
  explanation?: string;
}

export interface UserMessage {
  role: "user";
  content: UserContent[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  /** Model id that produced this message. */
  model: string;
  usage: Usage;
  stopReason: StopReason;
  /** Populated when stopReason === "error". */
  errorMessage?: string;
  /**
   * Populated, when the provider said anything, only for stopReason ===
   * "refusal". Any content beside it is the partial output of a declined turn.
   */
  stopDetails?: StopDetails;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContent[];
  isError: boolean;
  /** Structured machine-readable payload for UIs and extensions. */
  details?: Record<string, unknown>;
  /**
   * Structured output payload (e.g. an MCP tool's `structuredContent`),
   * distinct from `details`: this is provider/tool-defined structured data
   * describing the result itself, not host-side metadata about the call.
   */
  structuredContent?: unknown;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
