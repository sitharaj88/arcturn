/**
 * The dry-run review surface, as pure data.
 *
 * `--dry-run` holds every file edit in a shadow copy of the workspace until a
 * person reads it. In a terminal that is `/diff`, then `/apply` or `/discard`.
 * In an editor it should be the best thing this product does, because VS Code
 * already owns the hard part: a native diff viewer.
 *
 * A sibling of `webview-models.ts` and `webview-sessions.ts` — plain functions
 * over plain data, no `vscode` import, no DOM — so the two judgements that
 * matter here are testable without a window:
 *
 * 1. **What a row says about a change.** The size before and after, and whether
 *    the file is new — enough for a reviewer to know what they are opening.
 *    (The indicator's own count sentence is *not* here: it is built in the page,
 *    in `webview-client.ts`, next to the element that shows it, and asserted in
 *    `webview-render.test.ts`. Keeping a second copy of it on this side would
 *    give one sentence two spellings and no way to notice when they diverged.)
 * 2. **What the discard modal names.** Discard is irreversible and the shadow
 *    tree is the only copy, so the modal has the same two jobs the session-
 *    delete modal has (`dialog.ts`): say *what* is being lost, and say it does
 *    not come back.
 *
 * ## Where the diff comes from
 *
 * Not from here, and not rendered as a patch in the webview. The panel opens
 * VS Code's own diff editor with the workspace file on the left and the pending
 * content on the right, which is the entire reason this feature belongs in an
 * editor rather than a terminal. This module supplies the identity of the
 * right-hand document ({@link pendingDocumentPath}) and its title; `index.ts`
 * turns those into a `vscode.Uri` and a `vscode.diff` call.
 *
 * The **left** side is the real file rather than a "before" snapshot from the
 * engine, and that is a correctness choice rather than a shortcut. `applyChanges`
 * writes the pending content over the real file *whole* — it does not apply a
 * patch against a snapshot — and `bash` is not wrapped by the overlay, so the
 * real file can change under a dry run. The honest left-hand side of "what will
 * this file become" is therefore the file as it stands now, which is exactly
 * what a `file:` URI shows. That is also why the wire carries no `before`.
 */

import type { PendingChange, PendingChanges } from "../serve/engine.js";
import { escapeCodicons } from "./picker.js";

/**
 * URI scheme for the right-hand document of a review diff.
 *
 * A virtual document, not the shadow file on disk. The extension reads nothing
 * of the engine's — RFC 0004 §0 — so the content arrives over the wire from
 * `pendingChanges` and is served back to the diff editor through a
 * `TextDocumentContentProvider`. Read-only by construction, which is also what
 * a reviewer wants: the right-hand side is what the agent proposes, not a
 * scratch buffer.
 */
export const DRY_RUN_SCHEME = "arcturn-dry-run";

/** Button: throw the pending changes away, for good. */
export const DISCARD_CHANGES = "Discard";

/** One pending change as the panel sees it. */
export interface PendingChangeRow {
  /** The engine's own path — identity, and what `applyChanges` is sent. */
  path: string;
  /** What to show. Escaped; see {@link projectPendingChange}. */
  label: string;
  /** Where the file lives, for the diff editor's left-hand side. */
  absolutePath: string;
  /** `"added"` or `"modified"`, as the engine reported it. */
  kind: "added" | "modified";
  /** The row's second line: what this change does to the file's size. */
  detail: string;
}

/** Where the review surface stands, for the panel's indicator. */
export type DryRunStatus =
  /** Nothing asked yet. */
  | "loading"
  /** The engine answered: it is holding changes back (possibly none yet). */
  | "ready"
  /**
   * This engine is not running under `--dry-run`. Deliberately *not* folded
   * into `"ready"` with an empty list: "nothing is pending" and "nothing is
   * ever held back here — your edits already landed" are opposite pieces of
   * news, and the panel must not show the reassuring one for the other.
   */
  | "off"
  /**
   * This engine has no such verb at all (`pendingChanges` resolved
   * `undefined`). A third state again, because an older engine could not have
   * applied anything either, so the panel shows no review affordance rather
   * than one that would fail — RFC 0005 §3, no capability implied by an
   * affordance.
   */
  | "unavailable";

/** What the panel renders. */
export interface DryRunView {
  status: DryRunStatus;
  /** The waiting files. Empty unless `status` is `"ready"`. */
  changes: PendingChangeRow[];
  /** Whether the engine dropped rows to fit its payload cap. */
  truncated: boolean;
  /** Why the last apply or discard did not take, when it did not. Escaped. */
  note?: string;
}

/**
 * Project one engine row into a panel row.
 *
 * Rebuilt field by field rather than spread, and **escaped**, for the reason
 * `projectContextItem` and `projectCommandOption` are: the label reaches a VS
 * Code notification and a quick-pick on the failure paths, where `$(name)`
 * expands into a real glyph. This path is a filename in a workspace the agent
 * has been writing to, so a file called `$(verified) approved.ts` would
 * otherwise render with a badge nobody granted it. `path` stays unescaped
 * because it is identity — it goes back to the engine, not to a renderer.
 *
 * @param change - One `pendingChanges` row.
 */
export function projectPendingChange(change: PendingChange): PendingChangeRow {
  return {
    path: change.path,
    label: escapeCodicons(change.path),
    absolutePath: change.absolutePath,
    kind: change.kind === "added" ? "added" : "modified",
    detail: escapeCodicons(sizeDetail(change)),
  };
}

/** `1.2 kB → 1.4 kB`, or `new file · 1.4 kB`. */
function sizeDetail(change: PendingChange): string {
  const after = formatBytes(change.bytes);
  if (change.kind === "added") return `new file · ${after}`;
  return `${formatBytes(change.previousBytes)} → ${after}`;
}

/** Bytes at one decimal place, in the units a file listing uses. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Turn a `pendingChanges` answer into what the panel shows.
 *
 * `undefined` — the verb is missing — and `dryRun: false` are kept apart here
 * rather than at the call site, so there is one place that decides which of the
 * three "no review surface" stories a user is told.
 *
 * @param answer - The engine's reply, or `undefined` for an engine with no verb.
 */
export function toDryRunView(answer: PendingChanges | undefined): DryRunView {
  if (answer === undefined) return { status: "unavailable", changes: [], truncated: false };
  if (!answer.dryRun) return { status: "off", changes: [], truncated: false };
  return {
    status: "ready",
    changes: answer.changes.map(projectPendingChange),
    truncated: answer.truncated,
  };
}

/** The modal shown before pending changes are thrown away. */
export interface DiscardPrompt {
  /** The question, naming how much is at stake. */
  message: string;
  /** What is lost, named file by file where that fits. */
  detail: string;
  /** The only label that means yes. */
  confirmLabel: string;
}

/** How many paths a modal can name before it stops being readable. */
const MAX_NAMED_FILES = 8;

/**
 * The confirmation for a discard.
 *
 * Here rather than inline in the `vscode` adapter for the reason
 * {@link describeSessionDeletion} is: the decision is the dangerous part, and
 * it should be testable without a window.
 *
 * It **names the files**, up to a readable limit. A modal that said "discard 12
 * changes?" asks somebody to approve a set they cannot see, and the whole
 * argument for putting this loop in an editor is that a reviewer gets to see
 * what they are deciding about. The count is still there for the case where the
 * list is too long to print.
 *
 * @param rows - What would be lost.
 */
export function describeDiscard(rows: readonly PendingChangeRow[]): DiscardPrompt {
  const count = rows.length;
  const named = rows.slice(0, MAX_NAMED_FILES).map((row) => row.label);
  const rest = count - named.length;
  const list = rest > 0 ? [...named, `and ${String(rest)} more`] : named;
  return {
    message: `Discard ${String(count)} pending file change${count === 1 ? "" : "s"}?`,
    detail:
      `${list.join("\n")}\n\n` +
      "This throws away everything the agent wrote in this dry run. The shadow copy is the " +
      "only record of that work and it cannot be recovered.",
    confirmLabel: DISCARD_CHANGES,
  };
}

/**
 * Whether the user actually said yes.
 *
 * The same rule {@link confirmsSessionDeletion} uses, for the same reason:
 * everything that is not an explicit confirmation is a refusal. A dismissed
 * modal and an unrecognised button both mean *keep them* — treating "no answer"
 * as consent is the one failure mode a destructive action may not have.
 *
 * @param choice - The button label, or `undefined` when the modal was dismissed.
 * @param prompt - The prompt that was shown.
 */
export function confirmsDiscard(choice: string | undefined, prompt: DiscardPrompt): boolean {
  return choice !== undefined && choice === prompt.confirmLabel;
}

/**
 * The path component of the virtual document holding one file's pending content.
 *
 * Ends in the real file's own basename so the diff editor's tab, the language
 * mode and the syntax highlighting are all the ones the file would get — a
 * review of `app.ts` rendered as plain text is a review nobody can read. The
 * session id is carried in the URI's *query* rather than here, so it never
 * shows up in the tab.
 *
 * @param path - The engine's own `PendingChange.path`.
 */
export function pendingDocumentPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * The diff editor's title.
 *
 * Names both sides in the order they appear, and says which is which: a tab
 * reading `app.ts ↔ app.ts` tells a reviewer nothing about which half is
 * theirs.
 *
 * @param row - The change being reviewed.
 */
export function diffTitle(row: PendingChangeRow): string {
  return row.kind === "added"
    ? `${row.label} (new file — pending)`
    : `${row.label} (workspace ↔ pending)`;
}
