/** LLM streaming contracts implemented by @arcturn/ai. */

import type { AssistantMessage, Message, Usage } from "./messages.js";
import type { ModelSpec, ThinkingLevel } from "./models.js";
import type { JsonSchema, ToolDefinition } from "./tools.js";

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

/**
 * Ask the provider to constrain the reply's text to a JSON schema (native
 * structured output): Anthropic `output_config.format`, OpenAI
 * `response_format` / Responses `text.format`, Gemini `responseJsonSchema`.
 *
 * An adapter whose model cannot honour it drops it (see
 * `ModelCapabilities.structuredOutput`) — the caller keeps validating the reply
 * either way, since a schema is a guarantee about shape, not about meaning.
 */
export interface ResponseFormat {
  /** A short identifier for the schema, `[a-zA-Z0-9_-]`; OpenAI requires one. */
  name: string;
  /** The JSON Schema the reply must satisfy. Objects carry `additionalProperties: false`. */
  schema: JsonSchema;
  /**
   * Ask for strict schema adherence where the provider distinguishes it
   * (OpenAI). Default `true`; an adapter downgrades it where the schema does
   * not satisfy that provider's strict grammar rather than sending a 400.
   */
  strict?: boolean;
}

/**
 * A token budget for an agentic task the model paces itself against
 * (Anthropic's `output_config.task_budget`, beta `task-budgets-2026-03-13`).
 *
 * Advisory, not enforced: the server shows the model a countdown of what it
 * generated and the tool results it read. Not the turn ceiling, which is the
 * client's hard stop.
 */
export interface TaskBudget {
  /** Total tokens for the task; the API's minimum is 20,000. */
  total: number;
  /**
   * What is left of {@link total} at the start of the history this request
   * carries. Only set after a compaction rewrote history, when the provider
   * can no longer derive the spend from what it sees; left unset otherwise.
   */
  remaining?: number;
}

/**
 * Where a provider-native web tool may go: an allow list or a deny list of
 * plain hostnames (subdomains included). Never both — Anthropic rejects a
 * tool carrying the two with a 400, so an adapter handed both sends only the
 * deny list.
 */
export interface WebToolDomains {
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
}

/**
 * A tool the provider runs on its own infrastructure for this request
 * (Anthropic's server tools). Arcturn executes nothing for it: the call and
 * its result arrive as `ServerToolContent` blocks in the assistant message and
 * are replayed verbatim for as long as later requests carry the same tool.
 *
 * An adapter maps each entry onto what the model and platform take, and drops
 * what they do not; adapters for other providers ignore the field entirely.
 *
 * - `webSearch` / `webFetch` — provider-native web search and fetch.
 *   `replaces` names a client tool in {@link LLMRequest.tools} doing the same
 *   job (`"websearch"`, `"fetch"`): an adapter that sends the native tool
 *   leaves that definition out of the request, so the model is not offered
 *   two of the same thing; one that does not send it keeps it.
 * - `advisor` — a stronger model the request's model consults mid-generation
 *   (Anthropic beta `advisor-tool-2026-03-01`). `model` is the advisor's wire
 *   model id (`"claude-opus-5-5"`); an adapter sends it only for a pairing the
 *   provider accepts.
 */
export type ServerToolRequest =
  | ({ kind: "webSearch"; maxUses?: number; replaces?: string } & WebToolDomains)
  | ({ kind: "webFetch"; maxUses?: number; replaces?: string } & WebToolDomains)
  | { kind: "advisor"; model: string; maxUses?: number };

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
  /** Native structured output for the reply text; see {@link ResponseFormat}. */
  responseFormat?: ResponseFormat;
  /** A task budget the model paces itself against; see {@link TaskBudget}. */
  taskBudget?: TaskBudget;
  /** Provider-run tools for this request; see {@link ServerToolRequest}. */
  serverTools?: readonly ServerToolRequest[];
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
      /** The raw argument text, when it was not valid JSON — see {@link ToolCallContent.malformedArguments}. */
      malformedArguments?: string;
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
