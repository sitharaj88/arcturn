/**
 * `/rewind` on the wire: which turns a session could go back to, and what
 * going back to one would cost.
 *
 * Checkpoints are the engine's oldest safety net and the last one a remote
 * client could not reach. Before a `write` or `edit` touches a file for the
 * first time in a turn, the engine snapshots that file's content — or its
 * absence — into `~/.arcturn/checkpoints/<sessionId>`. `/rewind` walks those
 * snapshots back and forks the conversation to match. In a terminal that is a
 * picker and a confirmation; over this socket it was nothing at all, which is
 * why `built-in-commands.ts` names `/rewind` as *the* example of a command RFC
 * 0005 §1.3 forbids listing.
 *
 * ## What this module is, and what it is not
 *
 * It is the *projection* between a checkpoint store and the wire: a recorded
 * turn becomes a {@link CheckpointEntry} carrying the price of choosing it, and
 * an outcome becomes a {@link RewindResult}.
 *
 * It is **not** a restorer. The reading of the manifest, the confinement gate,
 * the content-addressed blobs and the atomic writes all live in
 * `@arcturn/cli`'s `FileCheckpointStore` — the same object the TUI's `/rewind`
 * drives — and are reached here through {@link SessionCheckpoints}, a
 * structural interface the CLI satisfies with a thin adapter. A second
 * restorer is the one thing this feature could not afford: it would be a
 * second place for the workspace confinement to be forgotten, and the
 * difference would only show up as somebody's file being overwritten.
 *
 * ## One store per session
 *
 * Unlike the `--dry-run` shadow tree — one per *process*, shared by every
 * session — a checkpoint store belongs to one session and is rooted at that
 * session's own working directory. That is why these verbs are genuinely
 * session-scoped and why the busy refusal is `deleteSession`'s (this session)
 * rather than `applyChanges`' (every session).
 */

import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { Agent } from "@arcturn/core";
import type { CheckpointEntry, CheckpointList } from "@arcturn/types";

/**
 * One recorded turn, and everything a rewind to it would do.
 *
 * Structurally what `@arcturn/cli`'s checkpoint store can answer, restated
 * here because `@arcturn/server` does not depend on `@arcturn/cli` — the same
 * reason {@link DryRunOverlay} is restated in `dry-run.ts`.
 *
 * `restores` and `deletes` are the *plan*, not the history: they span this
 * turn and every turn recorded after it, because that is what a restore
 * applies. A path the store would refuse (a manifest record outside the
 * workspace) belongs in neither list — this is what would happen, not what
 * was recorded.
 */
export interface CheckpointTurnPreview {
  /** Opaque turn id, the store's own. */
  id: string;
  /** The turn's label: the head of the prompt that began it. */
  label: string;
  /** When the turn began, ms since the epoch. */
  timestamp: number;
  /** Absolute paths whose earlier content would be written back. */
  restores: string[];
  /** Absolute paths that would be removed. */
  deletes: string[];
  /**
   * Whether the conversation can be forked to this turn as well, or only the
   * files restored. `false` for a turn resumed from disk with no in-memory
   * record of the transcript entry it began at.
   */
  forksConversation: boolean;
}

/** One path a rewind could not touch, and the store's reason. */
export interface CheckpointRewindFailure {
  /** Absolute path, as the manifest recorded it. */
  path: string;
  message: string;
}

/** Outcome of {@link SessionCheckpoints.rewind}. */
export interface CheckpointRewindOutcome {
  /** Absolute paths written back from a snapshot. */
  restored: string[];
  /** Absolute paths removed. */
  deleted: string[];
  /** Paths the store refused or failed on, with a reason each. */
  failed: CheckpointRewindFailure[];
  /**
   * The agent that now holds the forked conversation, when the transcript
   * moved too.
   *
   * Handed back rather than swapped by the provider because the *host* owns
   * session liveness: it is what subscribes observers, installs the permission
   * requester and answers `sessionNotFound`. A provider that reached into that
   * would be a second session registry.
   *
   * Absent when only the files moved — see
   * {@link CheckpointTurnPreview.forksConversation}.
   */
  agent?: Agent;
}

/**
 * The slice of `@arcturn/cli`'s checkpoint machinery this package needs.
 *
 * Deliberately two methods. `beginTurn` and `snapshot` are the recording half
 * and have no business on a review surface, and `planRestore` is folded into
 * {@link SessionCheckpoints.list} rather than exposed separately so a client
 * can never be shown one plan and have another one applied.
 */
export interface SessionCheckpoints {
  /**
   * Every recorded turn for one session, oldest first, each with the plan a
   * rewind to it would apply.
   *
   * @param sessionId - Session to list.
   * @returns The turns, or `[]` for a session that has never checkpointed.
   */
  list(sessionId: string): Promise<CheckpointTurnPreview[]>;
  /**
   * Restore the session's files to `turnId` and fork its conversation to
   * match.
   *
   * Deliberately **not** handed the agent the host is currently serving. A
   * provider forks from the session id and a stored transcript entry, and the
   * host is the only thing that decides which agent a session *is* — passing
   * the live one in would invite a provider to wind it down, and two owners
   * for one agent's lifecycle is how it gets aborted twice, or not at all.
   *
   * @param sessionId - Session to rewind.
   * @param turnId - Turn to rewind to.
   * @returns What moved, what did not, and the forked agent when there is one.
   */
  rewind(sessionId: string, turnId: string): Promise<CheckpointRewindOutcome>;
}

/**
 * Ceiling on how many turns one `listCheckpoints` reports.
 *
 * A session accumulates one checkpoint per prompt forever, and a picker with
 * ten thousand rows is not a picker. 200 is well past what anyone scrolls and
 * far under what would make the payload interesting; the oldest are the ones
 * dropped, because "rewind to something recent" is what the verb is reached
 * for and an ancient turn's plan spans the whole session anyway.
 */
export const CHECKPOINT_LIST_MAX_ENTRIES = 200;

/**
 * Ceiling on how many paths one row names.
 *
 * The count is always exact (see {@link CheckpointEntry.fileCount}); this
 * bounds only the list a modal prints. A row naming five hundred files is a
 * row nobody reads, and the number is what the decision actually turns on.
 */
export const CHECKPOINT_ENTRY_MAX_FILES = 50;

/**
 * Byte budget for one `listCheckpoints` response.
 *
 * 1 MiB, the same number and the same argument as
 * {@link SESSION_HISTORY_MAX_BYTES} and {@link PENDING_CHANGES_MAX_BYTES}: it
 * is `ws-server.ts`'s own backpressure threshold — the point at which this
 * server already considers a connection to be in trouble — and a quarter of
 * the frame size above which `ws` closes it outright. A response answering the
 * client's own request is never dropped by the backpressure policy, which is
 * exactly why it must not be the frame that wedges the socket.
 */
export const CHECKPOINT_LIST_MAX_BYTES = 1024 * 1024;

/** Ceiling on a turn label, past which a menu row is unreadable anyway. */
const MAX_LABEL_LENGTH = 200;

/** Bounds applied by {@link buildCheckpointList}. All default as documented. */
export interface CheckpointListLimits {
  /** See {@link CHECKPOINT_LIST_MAX_ENTRIES}. */
  maxEntries?: number;
  /** See {@link CHECKPOINT_ENTRY_MAX_FILES}. */
  maxFilesPerEntry?: number;
  /** See {@link CHECKPOINT_LIST_MAX_BYTES}. */
  maxBytes?: number;
}

/**
 * One turn label, made safe for a menu a person clicks.
 *
 * A label is the head of a prompt — text a user typed or, for a sub-agent
 * turn, text a model produced — and it is heading for a webview row and a
 * native modal. Control characters are dropped rather than escaped (a newline
 * in a modal detail forges a second line) and the whole thing is capped. This
 * is the same treatment `serve-commands.ts` gives a skill description, for the
 * same reason: untrusted prose on the way to a UI.
 */
function sanitizeLabel(label: string): string {
  let out = "";
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_LABEL_LENGTH ? `${out.slice(0, MAX_LABEL_LENGTH - 1)}…` : out;
}

/**
 * A path as a person reads it: workspace-relative, `/`-separated.
 *
 * The spelling {@link PendingChange.path} already uses on this wire, so a
 * panel renders a rewind's files and a dry run's files the same way. A path
 * that is not under `root` keeps its absolute form — that can only be a
 * refusal, and a refusal that named nothing would be unactionable — but it
 * never appears in a row's `files`, which lists only what would actually
 * happen.
 *
 * @param root - The session's working directory, already resolved.
 * @param path - An absolute path from the manifest.
 */
export function workspaceRelative(root: string, path: string): string {
  const absolute = resolve(path);
  if (absolute !== root && !absolute.startsWith(root + sep)) return absolute;
  const rel = relative(root, absolute);
  return rel === "" ? "." : rel.split(sep).join("/");
}

/**
 * The token `rewindTo` must echo back for one row.
 *
 * ### Why this verb has one when `deleteSession` does not
 *
 * `deleteSession` refused a wire-level confirmation and was right to: the
 * confirmation belongs in a native modal where a person can read what they are
 * losing, and a two-phase handshake would be state the engine had to keep,
 * expire and evict. Both arguments still hold — and neither one is what this
 * is. What separates `rewindTo` from every other destructive verb here is that
 * **its parameters do not name what it destroys**. A `deleteSession` names its
 * session; a `discardChanges` selection names its files, spelled as the engine
 * just listed them. A `rewindTo` names an opaque turn id, and the files it
 * deletes are derived from a manifest that grows with every turn — so a client
 * that rendered "this deletes 2 files", let a run append three more, and then
 * sent the id would rewind something it never showed anybody.
 *
 * So the confirmation is a **digest of the plan**, not a nonce. There is no
 * server state, nothing to expire and nothing to evict: the engine recomputes
 * the plan at `rewindTo` time and compares. Equal means the client is acting
 * on the cost it displayed; different means the workspace moved underneath the
 * picker, and the answer is to re-list rather than to proceed.
 *
 * Truncated to 32 hex characters — 128 bits. This is a *drift* detector, not a
 * capability: a client already holds the serve token and can call
 * `listCheckpoints` to obtain any confirmation it likes. Guessing one buys
 * nothing that asking would not, so collision resistance is the only property
 * that has to hold.
 *
 * @param preview - The plan as the engine computed it.
 * @param root - The session's resolved working directory.
 */
export function checkpointConfirmation(preview: CheckpointTurnPreview, root: string): string {
  const canonical = JSON.stringify({
    id: preview.id,
    forks: preview.forksConversation,
    // Sorted, so a manifest read that happened to yield a different order does
    // not read as a changed plan.
    restores: [...preview.restores].map((path) => workspaceRelative(root, path)).sort(),
    deletes: [...preview.deletes].map((path) => workspaceRelative(root, path)).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Project one recorded turn into the row a client renders.
 *
 * @param preview - The plan as the engine computed it.
 * @param root - The session's resolved working directory.
 * @param maxFiles - How many paths this row may name.
 */
export function projectCheckpoint(
  preview: CheckpointTurnPreview,
  root: string,
  maxFiles: number,
): CheckpointEntry {
  const files = [...preview.restores, ...preview.deletes]
    .map((path) => workspaceRelative(root, path))
    .sort();
  const named = files.slice(0, Math.max(0, maxFiles));
  return {
    id: preview.id,
    label: sanitizeLabel(preview.label),
    timestamp: preview.timestamp,
    fileCount: files.length,
    deleteCount: preview.deletes.length,
    files: named,
    truncatedFiles: named.length < files.length,
    forksConversation: preview.forksConversation,
    // Computed from the WHOLE plan, never from the truncated `files` above: a
    // digest over what a row happened to fit would change with the cap and
    // would stop describing the thing a rewind actually applies.
    confirmation: checkpointConfirmation(preview, root),
  };
}

/**
 * Build the `listCheckpoints` payload: newest first, bounded, truncation
 * reported.
 *
 * Rows are dropped from the **oldest** end, and the drop is named rather than
 * left to be inferred — a list that silently stops short reads as the whole
 * list, and here that would mean somebody concluding an earlier turn is
 * unreachable when it is merely not shown.
 *
 * @param sessionId - Session this answers for.
 * @param previews - Recorded turns, oldest first, as the store reported them.
 * @param root - The session's working directory; paths are reported relative
 *   to it.
 * @param limits - See {@link CheckpointListLimits}.
 */
export function buildCheckpointList(
  sessionId: string,
  previews: readonly CheckpointTurnPreview[],
  root: string,
  limits: CheckpointListLimits = {},
): CheckpointList {
  const maxEntries = limits.maxEntries ?? CHECKPOINT_LIST_MAX_ENTRIES;
  const maxFiles = limits.maxFilesPerEntry ?? CHECKPOINT_ENTRY_MAX_FILES;
  const maxBytes = limits.maxBytes ?? CHECKPOINT_LIST_MAX_BYTES;
  const resolvedRoot = resolve(root);

  // Newest first, which is the order a picker wants and the order the
  // terminal's own `/rewind` shows.
  const newestFirst = [...previews].reverse();
  const kept: CheckpointEntry[] = [];
  let bytes = 0;
  for (const preview of newestFirst) {
    if (kept.length >= maxEntries) break;
    const entry = projectCheckpoint(preview, resolvedRoot, maxFiles);
    const size = JSON.stringify(entry).length;
    if (kept.length > 0 && bytes + size > maxBytes) break;
    bytes += size;
    kept.push(entry);
  }

  return {
    sessionId,
    checkpoints: kept,
    available: true,
    truncated: kept.length < previews.length,
    droppedCheckpoints: previews.length - kept.length,
  };
}
