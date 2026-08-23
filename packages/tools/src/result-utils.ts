/** Shared helpers for building `ToolResult` values. */

import type { ToolResult } from "@arcturn/types";

/** Build a successful text-only tool result. */
export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/** Build an error tool result (an expected failure, not a thrown exception). */
export function errorResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], isError: true, details };
}

/** Standard result returned when a tool observes `ctx.signal` has aborted. */
export function abortedResult(): ToolResult {
  return errorResult("Aborted: the operation was cancelled before it completed.");
}
