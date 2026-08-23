/**
 * Pure-state tools owned by the runtime.
 *
 * Neither tool touches the outside world: they write agent state, persist a
 * `state` session entry and emit the matching event. Both are
 * {@link BindableTool}s, so simply passing them in `AgentOptions.tools` wires
 * them to the agent that runs them.
 */

import type { PermissionMode, TodoItem, Tool, ToolResult } from "@arcturn/types";
import type { AgentStateController, BindableTool } from "./state.js";
import { text } from "./util/content.js";
import { createId } from "./util/ids.js";

const TODO_STATUSES = ["pending", "inProgress", "done"] as const;

/** Options for {@link createTodoTool}. */
export interface TodoToolOptions {
  /** Tool name exposed to the model. Defaults to `"todo"`. */
  name?: string;
  /** Description exposed to the model. */
  description?: string;
}

/** Options for {@link createPlanTool}. */
export interface PlanToolOptions {
  /** Tool name exposed to the model. Defaults to `"plan"`. */
  name?: string;
  /** Description exposed to the model. */
  description?: string;
  /** Mode to switch to once a plan is approved. Defaults to `"default"`. */
  approvedMode?: PermissionMode;
}

const DEFAULT_TODO_DESCRIPTION =
  "Record the full task list for the current work. Always send every todo, " +
  "not just the ones that changed: the list you send replaces the stored list. " +
  "Keep at most one item in the inProgress state. " +
  "Call this again every time an item's state changes — mark an item done as " +
  "soon as it is finished, including when the work was delegated and the " +
  "sub-agent has returned. The user watches this list to see progress, so a " +
  "list left stale reads as work that stalled. Progress belongs in `status`, " +
  "never written into `text`.";

const DEFAULT_PLAN_DESCRIPTION =
  "Present an implementation plan to the user. In plan mode this is the only " +
  "way to leave plan mode: the user reviews the plan and, if they approve it, " +
  "editing and execution tools become available.";

function unbound(name: string): ToolResult {
  return {
    content: [text(`The "${name}" tool is not attached to an agent.`)],
    isError: true,
  };
}

function normalizeTodos(raw: unknown): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "todos must be an array" };
  const todos: TodoItem[] = [];
  let inProgress = 0;
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return { error: `todos[${index}] must be an object` };
    }
    const record = item as Record<string, unknown>;
    const value = record.text;
    const status = record.status;
    if (typeof value !== "string" || value.trim().length === 0) {
      return { error: `todos[${index}].text must be a non-empty string` };
    }
    if (typeof status !== "string" || !TODO_STATUSES.includes(status as TodoItem["status"])) {
      return { error: `todos[${index}].status must be one of ${TODO_STATUSES.join(", ")}` };
    }
    if (status === "inProgress") inProgress++;
    todos.push({
      id: typeof record.id === "string" && record.id.length > 0 ? record.id : createId("todo"),
      text: value,
      status: status as TodoItem["status"],
    });
  }
  if (inProgress > 1) return { error: "at most one todo may be inProgress" };
  return { todos };
}

function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "Todo list cleared.";
  const marks: Record<TodoItem["status"], string> = {
    pending: "[ ]",
    inProgress: "[~]",
    done: "[x]",
  };
  const lines = todos.map((todo) => `${marks[todo.status]} ${todo.text}`);
  const done = todos.filter((todo) => todo.status === "done").length;
  return `Todos (${done}/${todos.length} done):\n${lines.join("\n")}`;
}

/**
 * Create the todo tool: the model sends the complete list, the runtime stores
 * it, appends a `state` session entry and emits `todoUpdate`.
 *
 * @param options - Optional naming overrides.
 */
export function createTodoTool(options: TodoToolOptions = {}): BindableTool {
  const name = options.name ?? "todo";
  let controller: AgentStateController | undefined;

  return {
    definition: {
      name,
      description: options.description ?? DEFAULT_TODO_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete todo list, replacing any previous list.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable id; omit for new items." },
                text: {
                  type: "string",
                  description: "What needs to be done. State only — no progress markers.",
                },
                status: {
                  type: "string",
                  description: "Where the item stands right now.",
                  enum: [...TODO_STATUSES],
                },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
    bindAgent(next: AgentStateController): void {
      controller = next;
    },
    async execute(input): Promise<ToolResult> {
      if (!controller) return unbound(name);
      const normalized = normalizeTodos(input.todos);
      if ("error" in normalized) {
        return { content: [text(normalized.error)], isError: true };
      }
      await controller.setTodos(normalized.todos);
      return {
        content: [text(renderTodos(normalized.todos))],
        details: { todos: normalized.todos },
      };
    },
  };
}

/**
 * Create the plan tool: records a plan, emits `planUpdate`, and — while the
 * agent is in `plan` permission mode — acts as the exit gate by asking the
 * user for approval and switching mode when they accept.
 *
 * @param options - Optional naming overrides and the post-approval mode.
 */
export function createPlanTool(options: PlanToolOptions = {}): BindableTool {
  const name = options.name ?? "plan";
  const approvedMode: PermissionMode = options.approvedMode ?? "default";
  let controller: AgentStateController | undefined;

  return {
    definition: {
      name,
      description: options.description ?? DEFAULT_PLAN_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description: "The plan, as markdown. Be concrete about files and steps.",
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
    bindAgent(next: AgentStateController): void {
      controller = next;
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (!controller) return unbound(name);
      const plan = typeof input.plan === "string" ? input.plan : "";
      if (plan.trim().length === 0) {
        return { content: [text("plan must be a non-empty string")], isError: true };
      }
      await controller.setPlan(plan);

      if (controller.getPermissionMode() !== "plan") {
        return { content: [text("Plan recorded.")], details: { plan, approved: null } };
      }

      const approval = await controller.requestPlanApproval(plan, ctx.toolCallId);
      if (!approval.approved) {
        const suffix = approval.message ? `\nFeedback: ${approval.message}` : "";
        return {
          content: [
            text(`The user did not approve the plan. Stay in plan mode and revise it.${suffix}`),
          ],
          isError: true,
          details: {
            plan,
            approved: false,
            ...(approval.message ? { message: approval.message } : {}),
          },
        };
      }

      controller.setPermissionMode(approvedMode);
      return {
        content: [
          text(`The user approved the plan. Plan mode is off (${approvedMode}); start executing.`),
        ],
        details: { plan, approved: true, mode: approvedMode },
      };
    },
  };
}

/**
 * Narrow a tool to the runtime's state tools by name.
 *
 * @param tool - Tool to test.
 */
export function isStateToolName(tool: Tool): boolean {
  return tool.definition.name === "todo" || tool.definition.name === "plan";
}
