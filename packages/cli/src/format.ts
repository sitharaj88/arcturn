/** Small formatting helpers shared by the transcript, the status bar and `/cost`. */

import type { TodoItem, Usage } from "@arcturn/types";

/**
 * Compact token count: `842`, `12.4k`, `1.20M`.
 *
 * @param tokens - Raw token count.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * USD cost with enough precision to be useful at both ends of the range.
 *
 * @param usd - Cost in dollars.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Elapsed wall time as `4s`, `1m12s` or `1h04m`.
 *
 * @param ms - Duration in milliseconds.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Percentage of a model's context window in use.
 *
 * @param tokens - Estimated tokens in the conversation.
 * @param contextWindow - The model's context window.
 */
export function contextPercent(tokens: number, contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.min(100, Math.round((tokens / contextWindow) * 100));
}

/**
 * Total token count of a usage record (input + output + cache).
 *
 * @param usage - Usage to total.
 */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Collapse whitespace and clip a string for single-line display.
 *
 * @param value - Text to shorten.
 * @param max - Maximum characters, including the ellipsis.
 */
export function oneLine(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Checkbox glyphs used for todos, keyed by status. */
export const TODO_MARKS: Readonly<Record<TodoItem["status"], string>> = {
  pending: "☐",
  inProgress: "◐",
  done: "☑",
};

/**
 * Render a todo list as plain checklist lines (no colour).
 *
 * @param todos - The todo list.
 */
export function formatTodos(todos: readonly TodoItem[]): string[] {
  return todos.map((todo) => `${TODO_MARKS[todo.status]} ${todo.text}`);
}

/**
 * A compact relative age for session listings: "just now", "12m ago",
 * "3h ago", "yesterday", "5d ago", then weeks.
 *
 * @param ms - Milliseconds elapsed since the moment being described.
 */
export function relativeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
