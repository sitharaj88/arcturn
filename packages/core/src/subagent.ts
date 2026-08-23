/**
 * The `subagent` tool: run a scoped child {@link Agent} for a delegated task.
 *
 * The child's whole event stream is re-published on the parent, wrapped as
 * `subagentStart` / `subagentEvent` / `subagentEnd`, so a UI can render nested
 * activity without knowing anything about the child. Aborting the parent
 * cascades to the child.
 */

import type { ToolResult } from "@arcturn/types";
import type { Agent } from "./agent.js";
import type { AgentStateController, BindableTool } from "./state.js";
import { errorText, text } from "./util/content.js";
import { createId } from "./util/ids.js";

/** Options for {@link createSubagentTool}. */
export interface SubagentToolOptions {
  /**
   * Build a child agent for one task. Give the child its own tool set, model
   * and budget here; it must not share bindable tool instances with the parent.
   */
  factory: (task: string, agentName?: string) => Agent;
  /** Tool name exposed to the model. Defaults to `"subagent"`. */
  name?: string;
  /** Description exposed to the model. */
  description?: string;
  /**
   * Names of specialized agents the host can resolve.
   *
   * The `agent` parameter is only advertised when this is non-empty, and the
   * valid names are listed inline. Advertising a free-text `agent` field with
   * nothing to put in it invites the model to invent a plausible value
   * (`"general"`, `"default"`) and fail the delegation for no reason.
   */
  agentNames?: readonly string[];
}

const DEFAULT_DESCRIPTION =
  "Delegate a self-contained task to a child agent with its own context window. " +
  "Use it for wide searches or independent chunks of work whose intermediate " +
  "output you do not need to see. The child cannot ask you questions, so state " +
  "the task and the expected result in full.";

/**
 * Create the sub-agent tool.
 *
 * @param options - The child-agent factory plus optional naming overrides.
 */
export function createSubagentTool(options: SubagentToolOptions): BindableTool {
  const name = options.name ?? "subagent";
  const agentNames = options.agentNames ?? [];
  let controller: AgentStateController | undefined;

  return {
    definition: {
      name,
      description: options.description ?? DEFAULT_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The complete task for the child agent, including every constraint " +
              "and the exact shape of the answer you expect back.",
          },
          description: {
            type: "string",
            description: 'A short label for progress display, e.g. "find auth callers".',
          },
          ...(agentNames.length === 0
            ? {}
            : {
                agent: {
                  type: "string",
                  enum: [...agentNames],
                  description:
                    `Delegate to one of these specialized agents: ${agentNames.join(", ")}. ` +
                    "Omit this to use the default investigative agent.",
                },
              }),
        },
        required: ["task"],
        additionalProperties: false,
      },
    },
    bindAgent(next: AgentStateController): void {
      controller = next;
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (!controller) {
        return {
          content: [text(`The "${name}" tool is not attached to an agent.`)],
          isError: true,
        };
      }
      const task = typeof input.task === "string" ? input.task : "";
      if (task.trim().length === 0) {
        return { content: [text("task must be a non-empty string")], isError: true };
      }
      const label = typeof input.description === "string" ? input.description : task;
      // Resolving the name to a definition is the host's job: core stays
      // unaware that markdown agents exist, as it is for skills and extensions.
      const agentName = typeof input.agent === "string" ? input.agent : undefined;

      const agentId = createId("agent");
      const parent = controller;
      let child: Agent;
      try {
        child = options.factory(task, agentName);
      } catch (error) {
        return {
          content: [text(`Could not start the sub-agent: ${errorText(error)}`)],
          isError: true,
        };
      }

      parent.emit({ type: "subagentStart", agentId, task });

      let failure: string | undefined;
      const unsubscribe = child.subscribe((event) => {
        parent.emit({ type: "subagentEvent", agentId, event });
        if (event.type === "runEnd" && event.reason !== "completed") {
          failure = event.errorMessage ?? `Sub-agent run ${event.reason}.`;
        }
        if (event.type === "messageEnd") {
          const value = event.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim();
          if (value.length > 0) ctx.onUpdate({ text: value, details: { agentId, label } });
        }
      });

      const cascade = () => child.abort();
      ctx.signal.addEventListener("abort", cascade, { once: true });
      if (ctx.signal.aborted) child.abort();

      try {
        await child.prompt(task);
      } catch (error) {
        failure = errorText(error);
      } finally {
        ctx.signal.removeEventListener("abort", cascade);
        unsubscribe();
      }

      const resultText = child.finalText() || failure || "The sub-agent produced no output.";
      const isError = failure !== undefined;
      parent.emit({ type: "subagentEnd", agentId, resultText, isError });

      return {
        content: [text(resultText)],
        isError,
        details: {
          agentId,
          sessionId: child.sessionId,
          ...(failure === undefined ? {} : { error: failure }),
        },
      };
    },
  };
}
