/**
 * The rewind surface, as pure data.
 *
 * `/rewind` restores files to an earlier turn *and* forks the conversation.
 * The terminal's own confirmation says what that means — "restores and deletes
 * files; cannot be undone" — and it is the most destructive thing this panel
 * can ask the engine to do. So the two judgements that decide whether a person
 * clicks it safely live here, testable with no `vscode` and no DOM, exactly as
 * `dry-run.ts` and `dialog.ts` keep theirs:
 *
 * 1. **What a picker row says a choice costs.** How many files, how many of
 *    them get *deleted*, and whether the transcript moves too. A row that said
 *    only "14:32 — add rate limiting" would be asking somebody to approve a
 *    number they were never shown.
 * 2. **What the modal names before anything happens.** The file count first,
 *    then the files, then the sentence that says it does not come back — the
 *    same two jobs `describeSessionDeletion` and `describeDiscard` have, for
 *    the operation that has more to lose than either.
 *
 * ## Why deletions are counted separately
 *
 * "12 files changed" and "12 files deleted" are not the same sentence, and a
 * modal that folded them into one would let somebody approve the second while
 * reading the first. The engine reports the split (`CheckpointEntry.deleteCount`)
 * and this keeps it split all the way to the button.
 *
 * ## Where the restore happens
 *
 * Not here. RFC 0004 §0: the extension never writes a workspace file, and it
 * certainly never unlinks one. The panel sends `rewindTo` and the engine's own
 * checkpoint store does the work, under the same workspace confinement a local
 * `/rewind` runs under — which is also the only version that can refuse
 * mid-run.
 */

import type { CheckpointEntry, CheckpointList } from "../serve/engine.js";
import { escapeCodicons } from "./picker.js";

/** Button: rewind, for good. */
export const REWIND = "Rewind";

/** One rewindable turn as the panel sees it. */
export interface CheckpointRow {
  /** The engine's own id — identity, and what `rewindTo` is sent. */
  id: string;
  /** The turn's label. Escaped; see {@link projectCheckpoint}. */
  label: string;
  /** When the turn began, ms since the epoch, for the row's time. */
  timestamp: number;
  /** How many files a rewind here would touch. */
  fileCount: number;
  /** How many of those would be deleted. */
  deleteCount: number;
  /** The paths, workspace-relative. Escaped. */
  files: string[];
  /** Whether the engine cut the path list; the count is still exact. */
  truncatedFiles: boolean;
  /** Whether the transcript forks too, or only the files move. */
  forksConversation: boolean;
  /** The token `rewindTo` must echo. Identity, not display — never escaped. */
  confirmation: string;
  /** The row's second line: what choosing it would do. */
  detail: string;
}

/** Where the rewind surface stands, for the panel's picker. */
export type RewindStatus =
  /** Nothing asked yet. */
  | "loading"
  /** The engine answered: it keeps checkpoints (possibly none recorded yet). */
  | "ready"
  /**
   * This engine keeps no checkpoints at all. Deliberately *not* folded into
   * `"ready"` with an empty list: "nothing has been checkpointed yet" and
   * "nothing is ever checkpointed here" are opposite pieces of news, and the
   * panel must not show the hopeful one for the other.
   */
  | "off"
  /**
   * This engine has no such verb (`listCheckpoints` resolved `undefined`). A
   * third state again, for the reason `DryRunStatus`'s `"unavailable"` is one:
   * an engine that cannot list checkpoints could not have rewound to one
   * either, so the panel offers no affordance rather than one that would fail
   * — RFC 0005 §3, no capability implied by an affordance.
   */
  | "unavailable";

/** What the panel renders. */
export interface RewindView {
  status: RewindStatus;
  /** The rewindable turns, newest first. Empty unless `status` is `"ready"`. */
  checkpoints: CheckpointRow[];
  /** Whether the engine dropped older rows to fit its cap. */
  truncated: boolean;
  /** Why the last rewind did not take, when it did not. Escaped. */
  note?: string;
}

/**
 * `2 files · 1 deleted`, or `1 file · files only`.
 *
 * Names the deletions when there are any, and names the *absence* of a
 * conversation fork when there is none — that is the case the terminal warns
 * about ("the conversation link for this turn predates this process"), and a
 * row that looked identical to the others would promise a transcript fork the
 * user is not going to get.
 */
function rewindDetail(entry: CheckpointEntry): string {
  const parts = [`${String(entry.fileCount)} file${entry.fileCount === 1 ? "" : "s"}`];
  if (entry.deleteCount > 0) parts.push(`${String(entry.deleteCount)} deleted`);
  if (!entry.forksConversation) parts.push("files only — the transcript stays put");
  return parts.join(" · ");
}

/**
 * Project one engine row into a panel row.
 *
 * Rebuilt field by field rather than spread, and **escaped**, for the reason
 * `projectPendingChange` is: a label is the head of a prompt and a path is a
 * filename in a workspace the agent has been writing to, and both reach a VS
 * Code notification and a quick-pick where `$(name)` expands into a real
 * glyph. `id` and `confirmation` stay unescaped because they are identity —
 * they go back to the engine, not to a renderer.
 *
 * @param entry - One `listCheckpoints` row.
 */
export function projectCheckpoint(entry: CheckpointEntry): CheckpointRow {
  return {
    id: entry.id,
    label: escapeCodicons(entry.label),
    timestamp: entry.timestamp,
    fileCount: entry.fileCount,
    deleteCount: entry.deleteCount,
    files: entry.files.map((path) => escapeCodicons(path)),
    truncatedFiles: entry.truncatedFiles,
    forksConversation: entry.forksConversation,
    confirmation: entry.confirmation,
    detail: escapeCodicons(rewindDetail(entry)),
  };
}

/**
 * Turn a `listCheckpoints` answer into what the panel shows.
 *
 * `undefined` — the verb is missing — and `available: false` are kept apart
 * here rather than at the call site, so there is one place that decides which
 * of the three "no rewind" stories a user is told. The same shape
 * {@link toDryRunView} has, for the same reason.
 *
 * @param answer - The engine's reply, or `undefined` for an engine with no verb.
 */
export function toRewindView(answer: CheckpointList | undefined): RewindView {
  if (answer === undefined) return { status: "unavailable", checkpoints: [], truncated: false };
  if (!answer.available) return { status: "off", checkpoints: [], truncated: false };
  return {
    status: "ready",
    checkpoints: answer.checkpoints.map(projectCheckpoint),
    truncated: answer.truncated,
  };
}

/** The modal shown before a rewind. */
export interface RewindPrompt {
  /** The question, naming how much is at stake. */
  message: string;
  /** What changes, named file by file where that fits. */
  detail: string;
  /** The only label that means yes. */
  confirmLabel: string;
}

/** How many paths a modal can name before it stops being readable. */
const MAX_NAMED_FILES = 8;

/**
 * The confirmation for a rewind.
 *
 * Here rather than inline in the `vscode` adapter for the reason
 * {@link describeDiscard} is: the decision is the dangerous part and it should
 * be testable without a window.
 *
 * It **names the file count in the question** and the files in the detail, up
 * to a readable limit. A modal that said "rewind to this turn?" asks somebody
 * to approve a set they cannot see, and unlike a discard — which loses work
 * that was never on disk — this one overwrites and unlinks files a person has
 * open in the editor next to it.
 *
 * The sentence about the conversation is not decoration either. A rewind
 * normally moves the transcript with the files; when the engine says it cannot
 * (`forksConversation: false`), the user is about to end up with a chat log
 * describing work that no longer exists, and they should know that before they
 * click rather than after.
 *
 * @param row - The turn being rewound to.
 */
export function describeRewind(row: CheckpointRow): RewindPrompt {
  const named = row.files.slice(0, MAX_NAMED_FILES);
  const rest = row.fileCount - named.length;
  const list = rest > 0 ? [...named, `and ${String(rest)} more`] : named;
  const deletions =
    row.deleteCount > 0
      ? ` ${String(row.deleteCount)} of them ${row.deleteCount === 1 ? "is" : "are"} deleted outright.`
      : "";
  const conversation = row.forksConversation
    ? " The conversation is forked back to the same point; nothing already in the transcript is erased."
    : " The conversation link for this turn predates this engine's process, so only the files move — the transcript is left describing work that will no longer be on disk.";
  const count = `${String(row.fileCount)} file${row.fileCount === 1 ? "" : "s"}`;
  return {
    message: `Rewind to "${row.label}" and change ${count}?`,
    detail:
      `${list.length === 0 ? "No files were recorded for this turn." : list.join("\n")}\n\n` +
      `This restores files to how they were before that turn.${deletions}` +
      " It cannot be undone." +
      conversation,
    confirmLabel: REWIND,
  };
}

/**
 * Whether the user actually said yes.
 *
 * The same rule {@link confirmsDiscard} and {@link confirmsSessionDeletion}
 * use, for the same reason: everything that is not an explicit confirmation is
 * a refusal. A dismissed modal (Escape, VS Code's own Cancel) and an
 * unrecognised button both mean *do not rewind* — treating "no answer" as
 * consent is the one failure mode a destructive action may not have.
 *
 * @param choice - The button label, or `undefined` when the modal was dismissed.
 * @param prompt - The prompt that was shown.
 */
export function confirmsRewind(choice: string | undefined, prompt: RewindPrompt): boolean {
  return choice !== undefined && choice === prompt.confirmLabel;
}
