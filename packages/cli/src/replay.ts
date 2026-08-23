/**
 * Session replay: re-run the original user prompts from a recorded session
 * against a (possibly different) model or config, for regression testing and
 * provider evaluation (`arcturn replay <sessionId|file>`).
 *
 * The flow is: {@link extractPrompts} pulls the ordered user prompts out of a
 * session's stored entries, {@link replaySession} feeds them one at a time to
 * a fresh {@link ArcturnRuntime}'s agent, and {@link diffReplays} compares two
 * {@link ReplayResult}s (e.g. the original run vs. a replay on another model)
 * to surface behavioural regressions.
 */

import type { SessionEntry, TextContent } from "@arcturn/types";
import type { ArcturnRuntime } from "./runtime.js";

/**
 * Pull the original user prompts out of a session's entries, in chronological
 * (append) order.
 *
 * Only `kind: "message"` entries whose message has `role: "user"` are
 * candidates; their text content blocks are joined and trimmed (image blocks
 * are dropped — a replay re-sends text only). Assistant messages, tool
 * results, and non-message entries (compaction, label, state) are always
 * skipped.
 *
 * A user-role entry is further skipped when it is *steering* rather than an
 * original prompt: `Agent.steer()` injects its message immediately after the
 * tool-result entries of the batch it interrupted, so its parent entry is
 * itself a `toolResult` message — a shape an original prompt (submitted while
 * the agent was idle) can never have, since a run only ever ends on a
 * `role: "assistant"` entry. Steering queued during the model's final
 * (tool-call-free) response of a turn is structurally identical to a fresh
 * prompt and is intentionally not distinguished — from stored entries alone
 * there is no reliable signal that separates the two.
 *
 * @param entries - A session's entries, in append order (as returned by
 *   {@link JsonlSessionStore.entries} or {@link JsonlSessionStore.branch}).
 * @returns The original user prompts, in order, as plain text.
 */
export function extractPrompts(entries: readonly SessionEntry[]): string[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;

    const parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
    const isSteeringAfterToolBatch =
      parent !== undefined && parent.kind === "message" && parent.message.role === "toolResult";
    if (isSteeringAfterToolBatch) continue;

    const text = entry.message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) prompts.push(text);
  }
  return prompts;
}

/** Outcome of replaying one prompt. */
export interface ReplayTurnResult {
  /** The prompt that was sent. */
  prompt: string;
  /** The final assistant text produced for this prompt. */
  finalText: string;
  /** Names of the tools called while answering this prompt, in call order. */
  toolCalls: string[];
  /** Cost of this turn in USD, best effort. */
  costUsd: number;
  /** Populated when the run for this prompt ended in an error or was aborted. */
  error?: string;
}

/** Outcome of replaying a full sequence of prompts. */
export interface ReplayResult {
  /** One entry per prompt, in the order they were sent. */
  turns: ReplayTurnResult[];
  /** Summed cost across every turn in USD, best effort. */
  totalCostUsd: number;
}

/** Options for {@link replaySession}. */
export interface ReplaySessionOptions {
  /** Prompts to send, in order — typically {@link extractPrompts}'s output. */
  prompts: string[];
  /** Runtime whose agent runs each prompt in sequence. */
  runtime: ArcturnRuntime;
  /** Called after each turn completes, with its index, prompt and final text. */
  onTurn?: (index: number, prompt: string, finalText: string) => void;
}

/**
 * Feed each prompt to `runtime.agent.prompt()` in sequence, collecting the
 * tool calls, final text, cost and any error for every turn.
 *
 * A prompt that errors or is aborted does not stop the replay — its turn is
 * recorded with `error` set and the next prompt still runs — so one bad
 * provider response does not throw away the rest of the comparison.
 *
 * @param options - The prompts to replay and the runtime to replay them on.
 */
export async function replaySession(options: ReplaySessionOptions): Promise<ReplayResult> {
  const { prompts, runtime, onTurn } = options;
  const turns: ReplayTurnResult[] = [];
  let totalCostUsd = 0;

  for (const [index, prompt] of prompts.entries()) {
    const toolCalls: string[] = [];
    let error: string | undefined;

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === "toolStart") toolCalls.push(event.toolName);
      if (event.type === "runEnd" && event.reason !== "completed") {
        error = event.errorMessage ?? `run ${event.reason}`;
      }
    });

    const costBefore = runtime.metrics.costUsd;
    try {
      await runtime.agent.prompt(prompt);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      unsubscribe();
    }
    const costUsd = runtime.metrics.costUsd - costBefore;
    totalCostUsd += costUsd;

    const finalText = runtime.agent.finalText();
    const turn: ReplayTurnResult = {
      prompt,
      finalText,
      toolCalls,
      costUsd,
      ...(error === undefined ? {} : { error }),
    };
    turns.push(turn);
    onTurn?.(index, prompt, finalText);
  }

  return { turns, totalCostUsd };
}

/** Format a signed delta, e.g. `+3` or `-1`. */
function signed(delta: number, digits = 0): string {
  const value = digits > 0 ? delta.toFixed(digits) : String(delta);
  return delta >= 0 ? `+${value}` : value;
}

/**
 * Compare two replay results turn by turn: whether the tool-call sequence
 * matched, how much the final-text length diverged, and the cost delta. This
 * is the regression signal — behaviour drift across models, providers or
 * versions replaying the same prompts.
 *
 * A final-text length change of more than 20% (or going from empty to
 * non-empty, or vice versa) counts as a divergence.
 *
 * @param a - The baseline replay (e.g. the original recorded session).
 * @param b - The replay to compare against it (e.g. a different model).
 * @returns A human-readable, multi-line summary.
 */
export function diffReplays(a: ReplayResult, b: ReplayResult): string {
  const lines: string[] = [];
  if (a.turns.length !== b.turns.length) {
    lines.push(`Turn count differs: ${a.turns.length} (a) vs ${b.turns.length} (b)`);
  }

  const turnCount = Math.max(a.turns.length, b.turns.length);
  let toolMismatches = 0;
  let textDivergences = 0;

  for (let index = 0; index < turnCount; index++) {
    const ta = a.turns[index];
    const tb = b.turns[index];
    if (!ta || !tb) {
      lines.push(`Turn ${index + 1}: present only in ${ta ? "a" : "b"}`);
      continue;
    }

    const toolsA = ta.toolCalls.join(", ");
    const toolsB = tb.toolCalls.join(", ");
    const toolsMatch = toolsA === toolsB;
    if (!toolsMatch) toolMismatches++;

    const lenA = ta.finalText.length;
    const lenB = tb.finalText.length;
    const diverged = lenA === 0 || lenB === 0 ? lenA !== lenB : Math.abs(lenB - lenA) / lenA > 0.2;
    if (diverged) textDivergences++;

    const costDelta = tb.costUsd - ta.costUsd;
    const errorNote =
      ta.error !== undefined || tb.error !== undefined
        ? ` [error a=${ta.error ?? "-"} b=${tb.error ?? "-"}]`
        : "";

    lines.push(
      `Turn ${index + 1}: tools ${toolsMatch ? "match" : `DIFFER (a=[${toolsA}] b=[${toolsB}])`}; ` +
        `text ${lenA} -> ${lenB} chars${diverged ? " DIVERGED" : ""}; ` +
        `cost $${ta.costUsd.toFixed(4)} -> $${tb.costUsd.toFixed(4)} (${signed(costDelta, 4)})` +
        errorNote,
    );
  }

  const totalCostDelta = b.totalCostUsd - a.totalCostUsd;
  lines.push(
    `Summary: ${turnCount} turn(s), ${toolMismatches} tool-call mismatch(es), ` +
      `${textDivergences} text divergence(s), total cost $${a.totalCostUsd.toFixed(4)} -> ` +
      `$${b.totalCostUsd.toFixed(4)} (${signed(totalCostDelta, 4)})`,
  );

  return lines.join("\n");
}
