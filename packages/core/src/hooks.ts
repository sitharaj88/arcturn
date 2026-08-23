/** Interception points around tool execution. */

import type { ToolResultMessage } from "@arcturn/types";

/** Identity of a tool call passed to hooks. */
export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Outcome of {@link AgentHooks.beforeToolCall}.
 *
 * Returning nothing is the same as `{ action: "allow" }`.
 */
export type BeforeToolCallResult =
  | { action: "allow"; input?: Record<string, unknown> }
  | { action: "block"; reason: string; details?: Record<string, unknown> }
  | undefined
  // biome-ignore lint/suspicious/noConfusingVoidType: a hook body may return nothing at all.
  | void;

/** Hooks that wrap every tool call the agent makes. */
export interface AgentHooks {
  /**
   * Runs before validation and the permission gate.
   *
   * @param call - The tool call the model requested.
   * @returns `allow` (optionally with rewritten input), `block`, or nothing.
   */
  beforeToolCall?(call: ToolCallInfo): Promise<BeforeToolCallResult> | BeforeToolCallResult;
  /**
   * Runs after execution, including for blocked, denied and failed calls.
   *
   * @param call - The tool call, with its effective input.
   * @param result - The result about to be recorded.
   * @returns A replacement result, or nothing to keep `result`.
   */
  afterToolCall?(
    call: ToolCallInfo,
    result: ToolResultMessage,
    // biome-ignore lint/suspicious/noConfusingVoidType: a hook body may return nothing at all.
  ): Promise<ToolResultMessage | undefined | void> | ToolResultMessage | undefined | void;
}
