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
  /**
   * The argument text exactly as the provider streamed it, set only when it
   * was not valid JSON — a tool whose input streamed eagerly (unvalidated by
   * the server) and came out cut off or malformed. `arguments` then holds the
   * best-effort repair, which may be silently truncated; the runtime answers
   * such a call with an error result and never runs it.
   */
  malformedArguments?: string;
}

/**
 * A provider's server-side compaction marker, kept in the assistant message
 * that carried it (Anthropic's `compaction` block, beta `compact-2026-01-12`).
 *
 * It must go back to the same provider **verbatim** on every later request:
 * the server replaces everything before it with its own summary, and the
 * thinking-binding check restarts at it. Other providers drop it on replay —
 * the summary is shown to people, never sent outside the provider that wrote it.
 */
export interface CompactionContent {
  type: "compaction";
  /** The server's summary of what it folded away, or `null` for a failed compaction (a no-op on replay). */
  summary: string | null;
  /** Opaque provider state, round-tripped byte for byte. */
  encryptedContent: string | null;
}

/**
 * A block a provider's own server-side tool produced inside an assistant turn
 * — Anthropic's `server_tool_use` and `tool_search_tool_result` from native
 * tool search, for instance. Arcturn runs nothing for it; it is carried so the
 * next request replays the turn exactly as the model produced it.
 *
 * `block` is the wire object as received. The adapter for `provider` sends it
 * back unchanged; every other adapter drops it.
 */
export interface ServerToolContent {
  type: "serverTool";
  /** Provider family that issued the block, e.g. `"anthropic"`. */
  provider: string;
  /** The raw wire block, replayed verbatim. Never interpreted outside its provider. */
  block: Readonly<Record<string, unknown>>;
}

export type AssistantContent =
  | TextContent
  | ThinkingContent
  | ToolCallContent
  | CompactionContent
  | ServerToolContent;
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
  /**
   * Estimated cost in USD, when the model's pricing is known. Includes every
   * {@link advisor} entry's cost: this is what the message cost in total.
   */
  costUsd?: number;
  /**
   * Tokens a server-side advisor model spent inside this message (Anthropic's
   * advisor tool), one entry per advisor model. Not part of the top-level
   * token counts above, which stay the answering model's own; each entry is
   * priced at the advisor's rate, and that price is already in
   * {@link costUsd}. Absent when no advisor ran.
   */
  advisor?: AdvisorUsage[];
}

/** What an advisor model spent inside one message (or, summed, a session); see {@link Usage.advisor}. */
export interface AdvisorUsage {
  /** Catalog id of the advisor, e.g. `"anthropic/claude-opus-5-5"`. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** At the advisor's rate; absent when its pricing is unknown. */
  costUsd?: number;
}

/**
 * Why an assistant turn ended.
 *
 * `refusal` is a finished turn, not a failed one: the provider answered — a
 * safety classifier or content filter declined the request (Anthropic's
 * `stop_reason: "refusal"`, OpenAI's `content_filter`, Gemini's `SAFETY`).
 * Nothing about it is retryable as-is, and it is not an `error`.
 *
 * `pauseTurn` is a turn the provider stopped *before* it was done — Anthropic's
 * `pause_turn`, returned when a server-side tool loop (native tool search, web
 * search) reaches its iteration limit. The work is half finished; the right
 * move is to send the conversation back unchanged so the model resumes.
 */
export type StopReason =
  | "endTurn"
  | "toolCalls"
  | "maxTokens"
  | "refusal"
  | "pauseTurn"
  | "aborted"
  | "error";

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

/**
 * One change a provider says it made to the request before the model saw it —
 * Anthropic's `input_transformations` (beta `thinking-binding-controls-2026-08-01`).
 *
 * `type` and `reason` are open sets; consumers ignore values they do not
 * recognise. On Claude today: `{type: "thinking_dropped", reason:
 * "prefix_binding_mismatch"}` (the history before `path` changed since the
 * block was produced — a harness bug), `{type: "thinking_dropped", reason:
 * "model_binding_mismatch"}` (the conversation switched models — expected),
 * and `{type: "thinking_mismatch_allowed", reason: "prefix_binding_mismatch"}`
 * (failed the check but reached the model on an account that is not enforced).
 */
export interface InputTransformation {
  type: string;
  /** Where in the request, e.g. `"messages.5.content.0"`. */
  path: string;
  reason: string;
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
  /**
   * What the provider changed in the request before the model read it, when
   * it said so (only non-empty lists are recorded). See {@link InputTransformation}.
   */
  inputTransformations?: readonly InputTransformation[];
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

/**
 * Operator text appended mid-conversation: the harness speaking, not the user.
 *
 * The distinction is authority, not wording. A {@link UserMessage} is what the
 * person typed — a prompt, a steer, an @-mention, an image. A `SystemMessage`
 * is what arcturn itself says to the model about the run: the turn-budget
 * warning, a host's progress check, the silent-turn nudge, the stale-todo
 * reminder. On models that accept it (Claude Opus 4.8 / 5 / 5.5, Fable 5 /
 * 5.1, Sonnet 5.5) it is sent as an appended `role: "system"` message — the
 * operator-authority channel a prompt injection cannot forge, and one that
 * leaves the cached prefix intact. Elsewhere the adapter folds it into a user
 * turn as a text block (Anthropic: a `<system-reminder>` block; Gemini:
 * `[operator]`). The choice is made at send time, so the stored transcript
 * keeps the `system` role and a later model switch renders it correctly.
 *
 * Never put untrusted data here — tool output, a sub-agent's reply, file
 * contents: that would hand it operator authority. Text only, by API rule.
 */
export interface SystemMessage {
  role: "system";
  content: TextContent[];
  timestamp: number;
  /**
   * A random token minted with the message and stored with it. A fold renders
   * it into its marker (`<system-reminder nonce="…">`, `[operator …]`) so text
   * that merely spells the marker — a file, a fetched page, an MCP result —
   * cannot match the real one, with no rewriting of that text. Stored, so a
   * resumed session re-renders the same bytes. Absent on older transcripts,
   * which fold unmarked.
   */
  nonce?: string;
  /**
   * Reserved for turn-scoped reminders (Anthropic's beta `clear_at:
   * "next_user_message"`). No adapter sends it yet; the no-beta form —
   * append the reminder and leave earlier copies in place — is what ships.
   */
  clearAt?: "nextUserMessage";
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage | SystemMessage;
