/**
 * Background agents on the wire: what is running, start one, stop one, adopt
 * one's answer.
 *
 * `/bg` is a whole child conversation running off the foreground thread with a
 * durable record on disk. Nothing about it rides a session's event stream — it
 * has its own session, its own tool loop, and it outlives the connection that
 * started it — so a remote client with no verb for this could not tell that an
 * engine had four agents running at all, let alone what they had cost.
 *
 * ## What this module is, and what it is not
 *
 * It is the *projection* between one background-agent manager and the wire:
 * records become {@link BackgroundAgentSummary} rows, a rendered transcript
 * becomes a bounded {@link BackgroundAgentTranscript}, and an outcome becomes a
 * result payload.
 *
 * It is **not** a registry. It starts nothing, tracks nothing and persists
 * nothing. The spawning, the queueing, the concurrency cap, the durable JSON
 * record and the crash-recovery pass all live in `@arcturn/cli`'s
 * `BackgroundAgentManager` — the same object the terminal's `/bg` drives — and
 * are reached here through {@link BackgroundAgentRegistry}, a structural
 * interface an adapter over that manager satisfies. A second registry is the
 * one thing this feature could not afford: two of them would each believe they
 * owned the records directory, and the second one to load it would declare the
 * first one's running agents dead.
 *
 * ## The cap is the shape of the interface
 *
 * {@link BackgroundAgentRegistry.start} takes a **task and nothing else**, and
 * that is the whole containment story for the one verb here that spends money.
 * A background agent's tools, permission mode, working directory and model are
 * the caps it runs under: read-only tools plus `fetch`, permission mode
 * `default` (never `yolo`), `subagent` removed so it cannot fan out, rooted at
 * the served workspace, queued behind the manager's concurrency limit. Every
 * one of those is decided by the manager's own defaults, which are the defaults
 * a `/bg` typed at a terminal gets. There is no parameter here to widen any of
 * them, because a cap a caller can raise is not a cap — so the wire type, the
 * validator and this interface all carry exactly one field, and they agree.
 *
 * ## One engine, one records directory
 *
 * Worth stating plainly. A background-agent manager corrects any record still
 * `running` to `interrupted` when it loads the directory, on the reasoning that
 * a fresh manager is a fresh process and a truly live agent would have been
 * reported by the manager that started it. That reasoning is a *process*
 * assumption, and `arcturn serve` is another process: an engine serving a
 * workspace where a terminal is also running `/bg` adopts the same directory
 * and will report that terminal's live agent as `interrupted`. The record
 * repairs itself when the owning manager next persists it, and the terminal's
 * own view is never wrong — but a panel can show a stale `interrupted` in the
 * window between. Fixing it properly needs an owner lease in the record, which
 * is a change to the manager's durability model rather than to this wire. See
 * `packages/server/NOTES.md` for the same note beside the decisions it explains.
 */

import { Buffer } from "node:buffer";
import type {
  BackgroundAgentList,
  BackgroundAgentState,
  BackgroundAgentSummary,
  BackgroundAgentTranscript,
} from "@arcturn/types";

/**
 * One background agent as its manager reports it.
 *
 * Structurally `@arcturn/cli`'s `BackgroundAgentStatus`. Restated here because
 * `@arcturn/server` does not depend on `@arcturn/cli` — the same reason
 * {@link DryRunChange} is restated in `dry-run.ts`, and the same reason
 * `SessionHostOptions.modelCatalog` takes a function rather than importing the
 * model registry.
 *
 * Deliberately narrower than the manager's own type: `usage` is not here. The
 * one figure a `/bg` listing is read for is spend, and a second token payload
 * on this wire would be a second place for numbers a client is already being
 * given in dollars to disagree with themselves.
 */
export interface BackgroundAgentRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly task: string;
  readonly modelId: string;
  readonly status: BackgroundAgentState;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly elapsedMs: number;
  readonly costUsd: number;
  readonly finalText?: string;
  readonly error?: string;
}

/**
 * What the engine composed for `/bg adopt`, or why it refused to.
 *
 * A union rather than a throw so the decision can be tested by reading a value,
 * and so the *sentence* stays in `@arcturn/cli` next to the terminal command
 * that already writes it. A wire adopt and a terminal adopt inject the same
 * words, because there is one function that writes them.
 */
export type BackgroundAdoption =
  /** The text to deliver to the session, exactly as it should arrive. */
  | { readonly text: string }
  /** Why there is nothing to adopt — still running, or no output at all. */
  | { readonly refusal: string };

/**
 * The slice of `@arcturn/cli`'s `BackgroundAgentManager` this package needs.
 *
 * Deliberately the smallest one that works, and deliberately *not* the
 * manager's own shape: `start` here takes a bare task where the manager's takes
 * an options object with `tools`, `permissionMode`, `cwd` and `model` on it.
 * Narrowing at this seam is what makes "a remote caller cannot widen a
 * background agent's tool set" a fact about the type system rather than a
 * promise in a comment.
 */
export interface BackgroundAgentRegistry {
  /** Every agent this engine knows about, newest first. */
  list(): readonly BackgroundAgentRecord[];
  /** One agent, or `undefined` for an id nothing matches. */
  get(id: string): BackgroundAgentRecord | undefined;
  /**
   * Start one agent on `task`, with the engine's own defaults for everything
   * else. Returns immediately; the agent may still be queued.
   *
   * @throws For an empty task. The host turns that into `invalidRequest`.
   */
  start(task: string): { id: string; sessionId: string };
  /** Abort one agent. `false` when there was nothing to cancel. */
  cancel(id: string): boolean;
  /**
   * The agent's transcript so far, rendered to lines by the same function the
   * terminal's `/bg logs` prints through. `undefined` for an unknown id.
   */
  transcript(id: string): Promise<readonly string[] | undefined>;
  /**
   * What to inject into a session for `/bg adopt`, or why not to.
   * `undefined` for an unknown id.
   */
  adoption(id: string): BackgroundAdoption | undefined;
}

/**
 * Byte budget for one transcript response.
 *
 * 1 MiB, the same number and the same argument as `SESSION_HISTORY_MAX_BYTES`
 * and `PENDING_CHANGES_MAX_BYTES`: it is `ws-server.ts`'s own
 * `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` — the point at which this server
 * already considers a connection to be in trouble — and a quarter of
 * `DEFAULT_MAX_PAYLOAD_BYTES` (4 MiB), the frame size above which `ws` closes
 * the connection with 1009. A response answering the client's own request is
 * essential traffic that backpressure never drops, which is exactly why it must
 * not be the frame that wedges the socket.
 *
 * It is also why the *listing* carries no transcripts at all: a hundred
 * background agents' transcripts are megabytes, and a hundred rows of metadata
 * are a few kilobytes. One agent's prose at a time is the only granularity a
 * log view ever renders anyway.
 */
export const BACKGROUND_TRANSCRIPT_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling on `task`, `finalText` and `error` in one wire row.
 *
 * `finalText` is model output and therefore unbounded at the source: a hundred
 * agents that each answered with a page would be a listing of megabytes, which
 * is the frame that wedges the socket exactly when a person is trying to find
 * out what their agents did. So the listing's strings are previews, the wire
 * type says so, and the whole answer is reached the two ways that are already
 * bounded — the rendered transcript, and `adoptBackgroundAgent`, which delivers
 * the complete text into a session without it crossing this field.
 *
 * A thousand characters is several times what the terminal's own listing shows
 * (`oneLine(task, 60)`) and several times what its transcript renderer keeps per
 * line (400), so nothing a person reads today gets shorter.
 */
export const BACKGROUND_AGENT_TEXT_MAX_CHARS = 1000;

/**
 * Ceiling on how many rows one listing carries.
 *
 * A manager remembers every agent it ever started; a machine that has run one a
 * day for a year has three hundred and sixty-five, and nothing prunes them.
 * Two hundred rows at roughly a kilobyte each is comfortably inside the same
 * 1 MiB budget {@link BACKGROUND_TRANSCRIPT_MAX_BYTES} is, with the newest kept
 * — which is the end anyone is looking at — and the drop reported rather than
 * silent.
 */
export const BACKGROUND_AGENTS_MAX_ROWS = 200;

/**
 * Cap one wire string, without pretending it was not cut.
 *
 * Cuts at the end rather than the front, unlike a transcript: the head of an
 * answer is the part a listing row is read for, and the terminal's own listing
 * shows the head of the task for the same reason. The ellipsis is a rendering
 * convenience, not a contract — the contract is the type's own word "preview".
 */
function preview(value: string): string {
  if (value.length <= BACKGROUND_AGENT_TEXT_MAX_CHARS) return value;
  return `${value.slice(0, BACKGROUND_AGENT_TEXT_MAX_CHARS - 1)}…`;
}

/**
 * Project one manager record into a wire row.
 *
 * Built by *naming* every field rather than by copying an object, so a field
 * the manager's record grows tomorrow — a working directory, an absolute
 * session path, an override — is absent by default rather than present until
 * somebody notices. That is the discipline `mcpServerSummaries` keeps for a
 * payload with credentials behind it, applied here to one with a model's own
 * prose in it.
 *
 * @param record - The manager's status for one agent.
 * @param transcript - Present only on a single-id fetch.
 */
export function projectBackgroundAgent(
  record: BackgroundAgentRecord,
  transcript?: BackgroundAgentTranscript,
): BackgroundAgentSummary {
  return {
    id: record.id,
    sessionId: record.sessionId,
    task: preview(record.task),
    modelId: record.modelId,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    // Clamped rather than trusted: `elapsedMs` is derived from two clocks in
    // the manager, and a negative duration is a number a client would render.
    elapsedMs: Math.max(0, record.elapsedMs),
    costUsd: Math.max(0, record.costUsd),
    ...(record.finalText === undefined ? {} : { finalText: preview(record.finalText) }),
    ...(record.error === undefined ? {} : { error: preview(record.error) }),
    ...(transcript === undefined ? {} : { transcript }),
  };
}

/**
 * Bound a rendered transcript to {@link BACKGROUND_TRANSCRIPT_MAX_BYTES}.
 *
 * Truncation drops from the **front**, because the interesting end of an
 * unattended run is the end: the answer, the failure, the last tool call before
 * it gave up. A transcript cut from the back would be the half a person reading
 * `/bg logs` never wants.
 *
 * @param lines - The rendered lines, oldest first.
 * @param maxBytes - Budget override, for tests.
 */
export function capTranscript(
  lines: readonly string[],
  maxBytes: number = BACKGROUND_TRANSCRIPT_MAX_BYTES,
): BackgroundAgentTranscript {
  let total = 0;
  let firstKept = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    // Plus one for the newline a client will render between rows, so the
    // budget describes what actually lands on screen rather than the array.
    const size = Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
    if (total + size > maxBytes) break;
    total += size;
    firstKept = i;
  }
  const kept = lines.slice(firstKept);
  return {
    lines: [...kept],
    truncated: firstKept > 0,
    droppedLines: firstKept,
  };
}

/**
 * Build the `backgroundAgents` payload.
 *
 * @param records - Every agent, newest first, as the registry listed them.
 * @param transcripts - Rendered transcript per agent id, for the single-id
 *   form. Empty for a listing.
 * @param maxRows - Row budget override, for tests. See
 *   {@link BACKGROUND_AGENTS_MAX_ROWS}.
 */
export function projectBackgroundAgents(
  records: readonly BackgroundAgentRecord[],
  transcripts: ReadonlyMap<string, BackgroundAgentTranscript> = new Map(),
  maxRows: number = BACKGROUND_AGENTS_MAX_ROWS,
): BackgroundAgentList {
  // The caller hands these over newest-first, so the *tail* is the oldest and
  // the head is what anyone is looking at. Dropping the tail keeps the answer
  // to "what is running" complete, which is the question this verb is for.
  const kept = records.slice(0, Math.max(0, maxRows));
  return {
    agents: kept.map((record) => projectBackgroundAgent(record, transcripts.get(record.id))),
    truncated: kept.length < records.length,
    droppedAgents: records.length - kept.length,
  };
}
