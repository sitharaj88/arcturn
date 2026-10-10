/** Tool contracts shared by the runtime, built-in tools, MCP bridge, and extensions. */

import type { ToolResultContent } from "./messages.js";
import type { PermissionRequester } from "./permissions.js";

/** JSON Schema (draft 2020-12 subset) describing tool parameters. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * Sent, but withheld from the model until its provider's native tool search
   * finds it (Anthropic's `defer_loading: true`). Only set on a request whose
   * model has native tool search; the set of tools — deferred or not — then
   * never changes between requests, which is what keeps the prompt cache and
   * every replayed thinking block valid. Adapters without native tool search
   * never receive it.
   */
  deferLoading?: boolean;
  /**
   * Ask the provider to guarantee the model's input matches `parameters`
   * exactly (Anthropic and OpenAI `strict: true`). Only set on a tool whose
   * schema satisfies the strict grammar: `additionalProperties: false` on every
   * object, no numeric or string-length constraints, no top-level `oneOf`.
   * An adapter whose provider has a stricter rule (OpenAI wants every property
   * required) drops it for a schema that misses it. Never set on a tool whose
   * schema arcturn does not own (MCP).
   */
  strict?: boolean;
  /**
   * Stream this tool's input as it is generated instead of having the server
   * buffer and validate it (Anthropic `eager_input_streaming`). Worth it for a
   * tool that takes a file body; with it the input can arrive cut off or
   * malformed, so the runtime validates it before dispatch. Adapters send it
   * only on streaming requests to the first-party API.
   */
  eagerInputStreaming?: boolean;
}

export interface ToolUpdate {
  /** Incremental human-readable progress (e.g. streamed bash output). */
  text?: string;
  /** Structured progress payload for rich UIs. */
  details?: Record<string, unknown>;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  /** Structured machine-readable payload stored on the ToolResultMessage. */
  details?: Record<string, unknown>;
  /**
   * Structured output payload (e.g. an MCP tool's `structuredContent`).
   * Passed through onto {@link ToolResultMessage.structuredContent} verbatim.
   */
  structuredContent?: unknown;
}

/**
 * Behavioral hints about a tool, e.g. surfaced from MCP server `annotations`.
 *
 * IMPORTANT: these are untrusted hints supplied by the tool/server, not a
 * security basis. They may inform display and UX (e.g. "this looks
 * read-only") but must never be used to auto-allow a permission decision —
 * a malicious or buggy server can claim `readOnlyHint: true` for a
 * destructive tool.
 */
export interface ToolAnnotations {
  /** Human-readable display title, distinct from the tool's programmatic name. */
  title?: string;
  /** Hints the tool does not modify its environment. */
  readOnlyHint?: boolean;
  /** Hints the tool may perform destructive updates (meaningful only when not read-only). */
  destructiveHint?: boolean;
  /** Hints repeated calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** Hints the tool interacts with an "open world" of external entities (e.g. web search). */
  openWorldHint?: boolean;
}

export interface ToolExecutionContext {
  /** Working directory for the session. */
  cwd: string;
  /** Aborts when the user interrupts the run. */
  signal: AbortSignal;
  /** Ask the permission engine (may prompt the user) before a sensitive action. */
  requestPermission: PermissionRequester;
  /** Report incremental progress; safe to call many times. */
  onUpdate: (update: ToolUpdate) => void;
  /** Session-scoped identifiers, for tools that persist state. */
  sessionId: string;
  toolCallId: string;
}

export interface Tool {
  definition: ToolDefinition;
  /** Optional behavioral hints; see {@link ToolAnnotations} for the security caveat. */
  annotations?: ToolAnnotations;
  /**
   * Execute the tool. Must resolve with a ToolResult (use isError for
   * expected failures) and only reject on programming errors.
   */
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}
