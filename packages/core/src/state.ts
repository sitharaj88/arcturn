/**
 * The surface the runtime exposes to tools that own agent state
 * (todos, plan mode, sub-agents) rather than touching the outside world.
 */

import type { AgentEvent, PermissionMode, TodoItem, Tool } from "@arcturn/types";

/** Outcome of asking the user to approve a plan. */
export interface PlanApproval {
  approved: boolean;
  /** Feedback from the user, fed back to the model on rejection. */
  message?: string;
}

/** Handle onto the running agent, handed to bindable tools. */
export interface AgentStateController {
  /** Session the agent is writing to. */
  readonly sessionId: string;
  /** Working directory of the agent. */
  readonly cwd: string;
  /** Publish an event on the agent's stream. */
  emit(event: AgentEvent): void;
  /** Current todo list. */
  getTodos(): TodoItem[];
  /** Replace the todo list, persist it and emit `todoUpdate`. */
  setTodos(todos: TodoItem[]): Promise<void>;
  /** Current plan, if one has been presented. */
  getPlan(): string | undefined;
  /** Replace the plan, persist it and emit `planUpdate`. */
  setPlan(plan: string): Promise<void>;
  /** Active permission mode. */
  getPermissionMode(): PermissionMode;
  /** Switch permission mode, e.g. when leaving plan mode. */
  setPermissionMode(mode: PermissionMode): void;
  /**
   * Ask the user to approve a plan. Bypasses permission rules so that stored
   * rules can never pre-approve leaving plan mode.
   *
   * @param plan - The plan text presented to the user.
   * @param toolCallId - Tool call requesting approval.
   */
  requestPlanApproval(plan: string, toolCallId: string): Promise<PlanApproval>;
}

/** A tool that needs a handle on the agent that runs it. */
export interface BindableTool extends Tool {
  /**
   * Called once by the agent during construction.
   *
   * @param controller - Handle onto the owning agent.
   */
  bindAgent(controller: AgentStateController): void;
}

/**
 * Type guard for tools that implement {@link BindableTool}.
 *
 * @param tool - Any tool.
 */
export function isBindableTool(tool: Tool): tool is BindableTool {
  return typeof (tool as Partial<BindableTool>).bindAgent === "function";
}
