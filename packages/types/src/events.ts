/** Agent runtime event stream — the single source of truth consumed by TUI, server, and SDK. */

import type { StreamEvent } from "./ai.js";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "./messages.js";
import type { PermissionDecision, PermissionRequest } from "./permissions.js";
import type { ToolUpdate } from "./tools.js";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "inProgress" | "done";
}

export type AgentEvent =
  /** A run begins (one user prompt → n turns until the model stops calling tools). */
  | { type: "runStart"; sessionId: string; prompt: Message }
  | { type: "turnStart"; turnIndex: number }
  /** Raw LLM stream events, re-emitted for UIs that render token-by-token. */
  | { type: "messageStream"; event: StreamEvent }
  | { type: "messageEnd"; message: AssistantMessage }
  | { type: "toolStart"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: "toolUpdate"; toolCallId: string; update: ToolUpdate }
  | { type: "toolEnd"; toolCallId: string; result: ToolResultMessage }
  | { type: "permissionRequest"; request: PermissionRequest }
  | { type: "permissionDecision"; decision: PermissionDecision }
  | { type: "todoUpdate"; todos: TodoItem[] }
  | { type: "planUpdate"; plan: string }
  /** Sub-agent lifecycle (child events are namespaced by agentId). */
  | { type: "subagentStart"; agentId: string; task: string }
  | { type: "subagentEvent"; agentId: string; event: AgentEvent }
  | { type: "subagentEnd"; agentId: string; resultText: string; isError: boolean }
  /** Background process lifecycle (e.g. long-running bash). */
  | { type: "backgroundTaskStart"; taskId: string; command: string }
  | { type: "backgroundTaskOutput"; taskId: string; chunk: string }
  | { type: "backgroundTaskEnd"; taskId: string; exitCode: number | null }
  | { type: "compactionStart" }
  | { type: "compactionEnd"; summary: string; tokensBefore: number; tokensAfter: number }
  /** Tool-result content was elided from the outgoing request (history untouched). */
  | { type: "contextEdit"; elidedCount: number; charsSaved: number }
  | { type: "turnEnd"; turnIndex: number; usage: Usage }
  | { type: "runEnd"; reason: "completed" | "aborted" | "error"; errorMessage?: string }
  /** Non-fatal diagnostics surfaced to the user. */
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  /**
   * A per-turn progress check judged the run to be spending its budget on the
   * wrong thing — a write-lane agent forty turns in with nothing written, say
   * — and said so to the model. `text` is the message it was sent, verbatim,
   * and each distinct wording is sent at most once per run. Structured so a
   * host can report "never started writing" instead of "hit its turn ceiling".
   */
  | { type: "progressWarning"; turnIndex: number; text: string }
  /**
   * The model ended a turn with nothing a caller can act on — no text and no
   * tool call. `nudged` is true when the loop handed the turn back once to
   * ask again, false when this was the second silence in a row and the run
   * accepted it. Structured so a host can count them: which models go quiet,
   * how often, and whether the nudge recovered it.
   */
  | { type: "silentTurn"; turnIndex: number; nudged: boolean; model: string };

/**
 * The discriminant of {@link AgentEvent} — every event type name as a
 * string-literal union. Use it for handler signatures; the compiler rejects
 * typos and narrows payloads in `switch`/`if` without any runtime constants.
 */
export type AgentEventType = AgentEvent["type"];

export type AgentEventListener = (event: AgentEvent) => void;
