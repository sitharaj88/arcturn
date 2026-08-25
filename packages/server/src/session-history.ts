/**
 * Replaying a stored session as the events a client already knows how to read.
 *
 * `openSession` subscribes a connection to a session's *future* events and
 * replays nothing, so a client attaching to a session with hours of work in it
 * had no way to render a single word of it. The sessions are event-sourced on
 * disk — the engine has held the answer all along — and this module is the
 * projection from what is stored ({@link SessionEntry}) back onto what a client
 * consumes ({@link AgentEvent}).
 *
 * ## Why events rather than a projected message list
 *
 * A `{ role, text }[]` would be smaller and would force every client to grow a
 * *second* transcript renderer — one that decides all over again how a tool
 * call, a denied permission, a compaction or a sub-agent reads, and that drifts
 * from the live renderer the first time either side changes. Replaying the same
 * `AgentEvent`s the live stream carries means a client folds history through
 * the identical reducer it already runs on `{ kind: "event" }` frames. The
 * VS Code panel's `reduceChat` needed no new branch to render replayed history;
 * that is the whole argument, and it is the same one that keeps
 * `validateSessionHistory` shallow.
 *
 * ## What this is not
 *
 * It is a faithful projection, not a recording. The token-by-token stream that
 * produced an assistant turn was never stored — only the resulting message was
 * — so a replayed turn arrives as one `messageEnd` where a live client saw a
 * `messageStream` per delta. Two rules keep that honest:
 *
 * 1. **Every string comes from the entry that carried it.** Nothing is
 *    re-derived, reformatted or paraphrased.
 * 2. **Only event types the live stream also emits are used.** A stored field
 *    with no live event to carry it (an entry's `label`, a `state` entry's
 *    `model`) is dropped rather than given a shape a client has never seen. So
 *    the replay can never put a *class* of data on the wire that watching the
 *    session live would not already have shown the same client.
 */

import { latestEntryId, pathToLeaf } from "@arcturn/core";
import type { AgentEvent, SessionEntry, SessionHistory } from "@arcturn/types";

/**
 * Byte budget for the replayed events of one session.
 *
 * 1 MiB, which is not a round number picked for looking reasonable: it is
 * `ws-server.ts`'s own `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` — the point at
 * which this server already considers a connection to be in trouble — and a
 * quarter of `DEFAULT_MAX_PAYLOAD_BYTES` (4 MiB), the frame size above which
 * `ws` closes the connection with 1009. A history response is *essential*
 * traffic (it answers the client's own request) and so is never dropped by the
 * backpressure policy, which is exactly why it must not be the frame that
 * wedges the socket. Budgeted at the threshold, it cannot be.
 *
 * Measured on the serialized events, not on the envelope, which adds a
 * hundred-odd bytes — far inside the headroom to the frame cap.
 */
export const SESSION_HISTORY_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling on the number of replayed events, whichever binds first with
 * {@link SESSION_HISTORY_MAX_BYTES}.
 *
 * A second bound because the two costs are different: bytes are what the wire
 * pays, element count is what a client's reducer pays. A session of ten
 * thousand one-word turns is small in bytes and expensive to fold. 1000 is
 * roughly 2.5× the 400-block ceiling the richest client in this repo trims its
 * transcript to (`chat-state.ts`'s `MAX_BLOCKS`), so this bound never bites
 * before the byte bound for a client that would have rendered them all.
 */
export const SESSION_HISTORY_MAX_EVENTS = 1000;

/** Bounds applied by {@link buildSessionHistory}. Both default as documented above. */
export interface SessionHistoryLimits {
  /** See {@link SESSION_HISTORY_MAX_BYTES}. */
  maxBytes?: number;
  /** See {@link SESSION_HISTORY_MAX_EVENTS}. */
  maxEvents?: number;
}

/**
 * Project a session's stored entries into the events that reproduce it.
 *
 * Only the **active branch** is replayed — the path from the root to the most
 * recently appended entry, exactly what `Agent.resume` materializes. A session
 * that was rewound has abandoned branches in its file, and replaying those
 * would show a user a conversation that the agent itself will never continue.
 *
 * @param entries - Every entry of the session, in append order.
 * @returns The events, oldest first, before any cap is applied.
 */
export function projectSessionEvents(
  sessionId: string,
  entries: readonly SessionEntry[],
): AgentEvent[] {
  const leafId = latestEntryId(entries);
  const branch = leafId === null ? [] : pathToLeaf(entries, leafId);

  const events: AgentEvent[] = [];
  let runOpen = false;
  /** Close the run a `runStart` opened, so a client's `running` flag lands false. */
  const closeRun = (): void => {
    if (!runOpen) return;
    runOpen = false;
    // `completed` and not `error`: the stored branch is what was successfully
    // persisted. A run that failed left its own `notice`/message behind, and
    // claiming an error here would invent a failure the entries do not record.
    events.push({ type: "runEnd", reason: "completed" });
  };

  for (const entry of branch) {
    switch (entry.kind) {
      case "message": {
        const message = entry.message;
        if (message.role === "user") {
          // One user message opens one run, mirroring `Agent.prompt`. A
          // mid-run steer is stored as a user message too and reads as its own
          // run here, which is the same thing the transcript showed live: the
          // user said this, then the agent answered.
          closeRun();
          runOpen = true;
          events.push({ type: "runStart", sessionId, prompt: message });
        } else if (message.role === "assistant") {
          events.push({ type: "messageEnd", message });
        } else {
          events.push({ type: "toolEnd", toolCallId: message.toolCallId, result: message });
        }
        break;
      }
      case "compaction":
        events.push({
          type: "compactionEnd",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          tokensAfter: entry.tokensAfter,
        });
        break;
      case "state":
        // `entry.model` has no live event of its own — a model id reaches a
        // client on a `messageStream` `start`, and synthesizing one of those
        // would be inventing a stream that never happened. Dropped, per rule 2
        // in this module's doc.
        if (entry.todos !== undefined) events.push({ type: "todoUpdate", todos: entry.todos });
        if (entry.plan !== undefined) events.push({ type: "planUpdate", plan: entry.plan });
        break;
      case "label":
        // Branch bookkeeping. No live event carries it and no client renders
        // it; giving it one would be this module inventing a shape.
        break;
    }
  }
  closeRun();
  return events;
}

/**
 * Apply the cap and report what it cost.
 *
 * The **newest** events are kept: a conversation is read backwards from now,
 * and a client that can only be shown part of one is better served the part it
 * is about to continue. The cut is then advanced forward to the next `runStart`
 * so whole turns are dropped rather than half of one — unless the final run
 * alone is over budget, in which case a partial run beats nothing.
 *
 * @param events - The full projection, oldest first.
 * @param limits - Overrides, for tests and for a caller with a tighter wire.
 */
export function capSessionEvents(
  events: readonly AgentEvent[],
  limits: SessionHistoryLimits = {},
): { events: AgentEvent[]; truncated: boolean; droppedEvents: number } {
  const maxBytes = limits.maxBytes ?? SESSION_HISTORY_MAX_BYTES;
  const maxEvents = limits.maxEvents ?? SESSION_HISTORY_MAX_EVENTS;

  // Walk backwards accumulating serialized size; `cut` ends up at the oldest
  // index that still fits both bounds.
  let bytes = 0;
  let cut = events.length;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // Byte length, not string length: `.length` counts UTF-16 code units, and
    // a transcript in CJK or with emoji in it is two to three times larger on
    // the wire than in code units — which would quietly turn a 1 MiB budget
    // into a 3 MiB frame and put the cap back within reach of `ws`'s 4 MiB.
    const size = Buffer.byteLength(JSON.stringify(events[index]), "utf8") + 1; // +1 for the comma
    if (bytes + size > maxBytes) break;
    if (events.length - index > maxEvents) break;
    bytes += size;
    cut = index;
  }

  if (cut > 0) {
    // Prefer a whole-turn boundary inside the window we can afford. Searching
    // forward (never backward) can only shrink the payload, so the budget
    // computed above still holds.
    const boundary = events.findIndex((event, index) => index >= cut && event.type === "runStart");
    if (boundary !== -1) cut = boundary;
  }

  return {
    events: cut === 0 ? [...events] : events.slice(cut),
    truncated: cut > 0,
    droppedEvents: cut,
  };
}

/**
 * Build the wire payload for one session.
 *
 * @param sessionId - The session being replayed.
 * @param entries - Every entry of the session, in append order.
 * @param limits - Cap overrides; see {@link SessionHistoryLimits}.
 */
export function buildSessionHistory(
  sessionId: string,
  entries: readonly SessionEntry[],
  limits: SessionHistoryLimits = {},
): SessionHistory {
  const capped = capSessionEvents(projectSessionEvents(sessionId, entries), limits);
  return {
    sessionId,
    events: capped.events,
    truncated: capped.truncated,
    droppedEvents: capped.droppedEvents,
  };
}
