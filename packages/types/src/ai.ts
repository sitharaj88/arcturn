/** LLM streaming contracts implemented by @arcturn/ai. */

import type { AssistantMessage, Message, Usage } from "./messages.js";
import type { ModelSpec, ThinkingLevel } from "./models.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Server-side context management for one request. Neither counts as a history
 * edit: the provider compares the conversation as it was sent, not its own
 * edited copy, so the outgoing prefix stays append-only.
 *
 * An adapter whose provider lacks one refuses the request with an
 * `invalidRequest` error rather than silently sending the full history.
 */
export interface ContextManagementRequest {
  /**
   * Server-side compaction (Anthropic `compact_20260112`, beta
   * `compact-2026-01-12`). A response may then carry a `CompactionContent`
   * block, which is replayed verbatim from then on.
   */
  compact?: boolean;
  /**
   * Server-side clearing of old tool results (Anthropic
   * `clear_tool_uses_20250919`, beta `context-management-2025-06-27`).
   */
  clearToolUses?: boolean;
  /**
   * Tools whose results the provider must never clear (`exclude_tools`):
   * the ones whose output *is* the state the model reasons over. Honoured with
   * `clearToolUses`; the local editor protects the same names.
   */
  protectTools?: readonly string[];
}

export interface LLMRequest {
  model: ModelSpec;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  /** Server-side compaction / tool-result clearing; see {@link ContextManagementRequest}. */
  contextManagement?: ContextManagementRequest;
  /** Escape hatch for provider-specific parameters. */
  providerOptions?: Record<string, unknown>;
}

/** Incremental events emitted while an assistant message streams. */
export type StreamEvent =
  | { type: "start"; model: string }
  | { type: "textStart"; blockIndex: number }
  | { type: "textDelta"; blockIndex: number; delta: string }
  | { type: "thinkingStart"; blockIndex: number }
  | { type: "thinkingDelta"; blockIndex: number; delta: string }
  | { type: "toolCallStart"; blockIndex: number; id: string; name: string }
  | { type: "toolCallDelta"; blockIndex: number; argumentsDelta: string }
  | {
      type: "toolCallEnd";
      blockIndex: number;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /** Provider signature over the call, when it issued one — see {@link ToolCallContent.signature}. */
      signature?: string;
    }
  | { type: "blockEnd"; blockIndex: number }
  | { type: "usage"; usage: Usage }
  | { type: "end"; message: AssistantMessage }
  | { type: "error"; error: AIError; message: AssistantMessage };

export interface AIError {
  kind: "auth" | "rateLimit" | "overloaded" | "invalidRequest" | "network" | "aborted" | "unknown";
  message: string;
  status?: number;
  retryAfterMs?: number;
}

/**
 * A streaming LLM client. `stream` yields incremental events and always
 * terminates with exactly one `end` or `error` event carrying the final
 * (possibly partial) assistant message.
 */
export interface LLMClient {
  stream(request: LLMRequest): AsyncIterable<StreamEvent>;
  /** Non-streaming convenience wrapper over `stream`. */
  complete(request: LLMRequest): Promise<AssistantMessage>;
}
