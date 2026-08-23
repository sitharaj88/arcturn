/**
 * Live run accounting: how many tokens the run has burned so far, and which
 * sub-agents are working right now.
 *
 * Two details make this less trivial than a running sum. Providers emit
 * `usage` as a *cumulative snapshot of the current message*, re-sent at
 * `message_start` and again on every `message_delta` — and once per chunk on
 * OpenAI — so adding each event's `outputTokens` counts the same tokens over
 * and over. Separately, a sub-agent's entire event stream is republished on the
 * parent wrapped in `subagentEvent`, so its usage never reaches a handler that
 * only inspects top-level `messageStream` events, and a run that delegates most
 * of its work reports almost nothing.
 *
 * {@link TokenMeter} solves the first by banking only the *growth* of each
 * stream's snapshot; {@link SubagentTracker} solves the second by unwrapping
 * the nesting to any depth and feeding every stream it finds into the meter.
 *
 * @packageDocumentation
 */

import type { AgentEvent } from "@arcturn/types";

/** Stream key standing for the root agent's own messages. */
export const ROOT_STREAM = "";

/**
 * Banks output tokens across any number of concurrently streaming agents.
 *
 * Each stream is metered independently, because the root agent and every live
 * sub-agent are part-way through their own messages at the same time and their
 * snapshots are unrelated to one another.
 */
export class TokenMeter {
  #total = 0;
  /** Highest snapshot seen for each stream's current message. */
  readonly #open = new Map<string, number>();
  /** Tokens banked per stream since the last {@link reset}. */
  readonly #perStream = new Map<string, number>();

  /** Output tokens banked across every stream since the last {@link reset}. */
  get total(): number {
    return this.#total;
  }

  /** Drop every stream and zero the total, ready for a new run. */
  reset(): void {
    this.#total = 0;
    this.#open.clear();
    this.#perStream.clear();
  }

  /**
   * Record a cumulative usage snapshot for one stream.
   *
   * Only the growth since that stream's previous snapshot is banked, so a
   * provider that re-sends a running total a dozen times still contributes its
   * tokens exactly once. A snapshot that goes *down* means a new message began
   * without a close — snapshots never shrink inside a message — so it is banked
   * whole and treated as the start of the next message.
   *
   * @param stream - Stream key: {@link ROOT_STREAM} or a sub-agent id.
   * @param outputTokens - The snapshot's cumulative output-token count.
   */
  observe(stream: string, outputTokens: number): void {
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) return;
    const seen = this.#open.get(stream) ?? 0;
    if (outputTokens === seen) return;
    const delta = outputTokens > seen ? outputTokens - seen : outputTokens;
    this.#open.set(stream, outputTokens);
    this.#total += delta;
    this.#perStream.set(stream, (this.#perStream.get(stream) ?? 0) + delta);
  }

  /**
   * Close the current message on a stream so the next one is metered from zero.
   *
   * @param stream - Stream key whose message ended.
   */
  endMessage(stream: string): void {
    this.#open.delete(stream);
  }

  /**
   * Output tokens banked for a single stream.
   *
   * @param stream - Stream key to report on.
   */
  streamTotal(stream: string): number {
    return this.#perStream.get(stream) ?? 0;
  }
}

/** A live sub-agent, as shown in the activity block. */
export interface SubagentStatus {
  /** Sub-agent id, from the `subagentStart` event. */
  readonly id: string;
  /** The delegated task, collapsed to a single line. */
  readonly task: string;
  /** Nesting depth; `0` for a direct child of the root agent. */
  readonly depth: number;
  /** Wall clock at which the sub-agent started. */
  readonly startedAt: number;
  /** Output tokens this sub-agent has produced so far. */
  readonly tokens: number;
  /** Turns this sub-agent has entered (one per model round-trip). */
  readonly turns: number;
  /** Tool calls this sub-agent has started. */
  readonly toolCalls: number;
  /** What it is doing right now: a tool name, or `"thinking"`. */
  readonly activity: string;
  /** The sub-agent's own todo progress, when it keeps a list. */
  readonly todos: { readonly done: number; readonly total: number } | undefined;
}

/** Internal mutable form of {@link SubagentStatus}. */
interface LiveSubagent {
  readonly id: string;
  readonly task: string;
  readonly depth: number;
  readonly startedAt: number;
  turns: number;
  toolCalls: number;
  activity: string;
  todos: { done: number; total: number } | undefined;
}

/** Collapse a delegated prompt to one line so it fits a status row. */
function oneLine(task: string): string {
  return task.replace(/\s+/gu, " ").trim();
}

/**
 * Tracks which sub-agents are live and folds every agent's usage into a
 * {@link TokenMeter}.
 *
 * Feed it *every* event the app receives — including sub-agent events, which it
 * unwraps itself. Nesting is followed to arbitrary depth, so a sub-agent that
 * delegates further still has its tokens counted and its child listed.
 */
export class SubagentTracker {
  readonly #meter: TokenMeter;
  readonly #now: () => number;
  readonly #live = new Map<string, LiveSubagent>();

  /**
   * @param meter - Meter that receives every stream's usage snapshots.
   * @param now - Clock, injectable for tests.
   */
  constructor(meter: TokenMeter, now: () => number = Date.now) {
    this.#meter = meter;
    this.#now = now;
  }

  /** Sub-agents currently running, oldest first. */
  get active(): readonly SubagentStatus[] {
    return [...this.#live.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((entry) => ({
        id: entry.id,
        task: entry.task,
        depth: entry.depth,
        startedAt: entry.startedAt,
        tokens: this.#meter.streamTotal(entry.id),
        turns: entry.turns,
        toolCalls: entry.toolCalls,
        activity: entry.activity,
        todos: entry.todos ? { ...entry.todos } : undefined,
      }));
  }

  /** Forget every live sub-agent, ready for a new run. */
  reset(): void {
    this.#live.clear();
  }

  /**
   * Fold one event into the meter and the live sub-agent list.
   *
   * @param event - Any event from the root agent's stream.
   */
  handle(event: AgentEvent): void {
    this.#handle(event, ROOT_STREAM, 0);
  }

  #handle(event: AgentEvent, stream: string, depth: number): void {
    switch (event.type) {
      case "subagentStart":
        this.#live.set(event.agentId, {
          id: event.agentId,
          task: oneLine(event.task),
          depth,
          startedAt: this.#now(),
          turns: 0,
          toolCalls: 0,
          activity: "starting",
          todos: undefined,
        });
        break;
      case "subagentEnd":
        this.#live.delete(event.agentId);
        break;
      case "subagentEvent":
        this.#handle(event.event, event.agentId, depth + 1);
        break;
      case "messageStream": {
        const inner = event.event;
        if (inner.type === "usage") this.#meter.observe(stream, inner.usage.outputTokens);
        else if (inner.type === "textStart") this.#setActivity(stream, "thinking");
        break;
      }
      case "messageEnd":
        this.#meter.endMessage(stream);
        break;
      case "turnStart": {
        const entry = this.#live.get(stream);
        // `turnIndex` is 0-based; the count of turns entered is one more. Taking
        // the max keeps it monotonic even if a turnStart is somehow re-sent.
        if (entry) entry.turns = Math.max(entry.turns, event.turnIndex + 1);
        break;
      }
      case "toolStart":
        this.#setActivity(stream, event.toolName, true);
        break;
      case "toolEnd":
        this.#setActivity(stream, "thinking");
        break;
      case "todoUpdate": {
        const entry = this.#live.get(stream);
        if (entry) {
          entry.todos = {
            done: event.todos.filter((todo) => todo.status === "done").length,
            total: event.todos.length,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  #setActivity(stream: string, activity: string, counts = false): void {
    const entry = this.#live.get(stream);
    if (!entry) return;
    entry.activity = activity;
    if (counts) entry.toolCalls += 1;
  }
}

/** A tool call whose arguments are still streaming in. */
export interface ToolCallProgress {
  /** Name of the most recently started live tool call. */
  readonly name: string;
  /** Argument characters streamed so far, across every live tool call. */
  readonly chars: number;
  /** How many tool calls are streaming right now. */
  readonly count: number;
}

/** Name used when a provider sends argument deltas without a start event. */
const UNNAMED_TOOL = "tool";

/**
 * Tracks the tool call the model is dictating right now.
 *
 * A model that regenerates a large file spends minutes emitting nothing but
 * `toolCallDelta` — no text, no tool has started executing yet — so a live
 * region that only watches text deltas shows a bare spinner and users assume
 * the run has hung. This tracker turns those deltas into a progress figure.
 *
 * Only the root agent's own calls are tracked: sub-agent activity already has
 * its own rows (see {@link SubagentTracker}), so `subagentEvent` is ignored
 * rather than mixed into the parent's line. When several calls stream at once
 * the tracker reports the *most recently started* name and the *combined*
 * character count, and {@link ToolCallProgress.count} lets the renderer say
 * "2 tool calls" instead of naming one arbitrarily.
 */
export class ToolCallProgressTracker {
  /** Live calls keyed by block index, in the order they started. */
  readonly #live = new Map<number, { name: string; chars: number }>();

  /** The in-flight tool call, or `undefined` when nothing is streaming. */
  get progress(): ToolCallProgress | undefined {
    if (this.#live.size === 0) return undefined;
    let chars = 0;
    let name = UNNAMED_TOOL;
    for (const entry of this.#live.values()) {
      chars += entry.chars;
      name = entry.name;
    }
    return { name, chars, count: this.#live.size };
  }

  /** Forget every in-flight call, so no ghost line survives the turn. */
  reset(): void {
    this.#live.clear();
  }

  /**
   * Fold one root-agent event into the in-flight set.
   *
   * @param event - Any event from the root agent's stream.
   */
  handle(event: AgentEvent): void {
    switch (event.type) {
      case "messageStream": {
        const inner = event.event;
        if (inner.type === "toolCallStart") {
          this.#live.set(inner.blockIndex, { name: inner.name, chars: 0 });
        } else if (inner.type === "toolCallDelta") {
          const entry = this.#live.get(inner.blockIndex) ?? { name: UNNAMED_TOOL, chars: 0 };
          entry.chars += inner.argumentsDelta.length;
          this.#live.set(inner.blockIndex, entry);
        } else if (inner.type === "toolCallEnd" || inner.type === "blockEnd") {
          this.#live.delete(inner.blockIndex);
        } else if (inner.type === "end" || inner.type === "error") {
          this.reset();
        }
        break;
      }
      // The tool is running now: the transcript reports it, so the
      // argument-streaming line has done its job and must not linger.
      case "toolStart":
      case "messageEnd":
      case "runStart":
      case "runEnd":
        this.reset();
        break;
      default:
        break;
    }
  }
}
