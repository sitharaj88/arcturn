/**
 * Ambient awareness: what the panel knows about the file you are looking at.
 *
 * The sidebar shipped without this and it showed. `vscode.window.activeTextEditor`
 * appeared in exactly two places in the whole extension — the two terminal
 * commands — so the panel had no idea which file was open, and its own starter
 * prompt "Explain what the file I have open does" was a sentence the engine
 * could not answer. Every "explain this function" cost the user an `@` and a
 * path they had to remember.
 *
 * This module is the decision half of the fix: which editors count, what a
 * selection is called, and when a change has settled enough to be worth a
 * round trip. `index.ts` supplies the three real event streams
 * (`onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`,
 * `onDidCloseTextDocument`) and does the resolving; nothing here imports
 * `vscode`, touches a clock it was not given, or reads a file.
 *
 * ## Three rules that are not obvious
 *
 * **A pane is not a file.** Only the `file` scheme is watched. The Output
 * channel, the settings editor, a webview and this extension's own
 * `arcturn-dry-run:` diff documents are all `TextEditor`s as far as VS Code is
 * concerned, and none of them is a path the engine could resolve — attaching
 * one would put the agent's own log in the agent's own context.
 *
 * **Losing the editor is not losing the file.** `activeTextEditor` goes
 * `undefined` the moment focus moves to something that is not a text editor,
 * and the very first thing a user does after reading some code is click into
 * the panel to ask about it. A chip that emptied on that transition would
 * empty exactly when it was about to be used, so an unwatchable editor — or no
 * editor at all — leaves the last real file in place. What clears it is the
 * file actually being *closed*, which is a different event and is handled as
 * one.
 *
 * **A caret is not a selection.** A single click has `start` equal to `end`,
 * and reporting that as `file.ts:12-12` would be the panel inventing an intent
 * the user did not express. Only a non-empty selection gets a range, and the
 * range is computed by `rangeFromSelection` — the same function the terminal's
 * Send Selection uses, so the two surfaces cannot come to disagree about what
 * a triple-click selected.
 */

import type { ContextKind, PromptAttachment, PromptAttachmentKind } from "@arcturn/types";

import { type MentionRange, rangeFromSelection, type SelectionLike } from "../mentions.js";

/**
 * How long the cursor has to stop moving before the panel asks about it.
 *
 * Every settled observation costs a `resolveContext` round trip — that is what
 * makes the chip's byte count the engine's rather than a `fs.stat` this
 * extension did behind the permission engine's back — so this is a budget in
 * engine calls, exactly like `MAX_CONTEXT_CANDIDATES`. The timer is trailing,
 * so a drag across two hundred lines is one call and not two hundred; 150ms is
 * below the threshold at which a chip feels like it is lagging behind the
 * caret, and above the rate at which typing produces selection events.
 */
export const AMBIENT_DEBOUNCE_MS = 150;

/** The scheme of a document that exists on disk, which is the only kind the engine can read. */
const FILE_SCHEME = "file";

/** What the panel is watching: a real path, and the lines highlighted in it. */
export interface AmbientEditor {
  /** Absolute path, as the editor reports it. Made workspace-relative by the engine. */
  readonly fsPath: string;
  /** 1-based inclusive lines, when something is actually selected. */
  readonly selection?: MentionRange;
}

/** The slice of `vscode.TextEditor` any of this depends on. */
export interface TextEditorLike {
  readonly document: { readonly uri: { readonly scheme: string; readonly fsPath: string } };
  readonly selection: SelectionLike;
}

/**
 * Whether a document with this scheme is something the panel may offer to attach.
 *
 * An allow-list of one. The alternative — a deny-list of the schemes seen so
 * far — silently admits the next one somebody's extension registers, and the
 * failure mode is a chip offering to send a pane the user opened to look at
 * the agent.
 *
 * @param scheme - `document.uri.scheme`.
 */
export function isAmbientScheme(scheme: string): boolean {
  return scheme === FILE_SCHEME;
}

/** Whether a selection actually selects anything, or is just where the caret is. */
function isEmptySelection(selection: SelectionLike): boolean {
  return (
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character
  );
}

/**
 * What the panel should be holding for this editor, or nothing.
 *
 * @param editor - The active editor, or `undefined` when there is none.
 * @returns `undefined` for no editor and for one the panel will not watch —
 *   the caller decides what to do about that, and the answer is *not* "clear
 *   the chip". See this module's doc.
 */
export function toAmbientEditor(editor: TextEditorLike | undefined): AmbientEditor | undefined {
  if (editor === undefined) return undefined;
  if (!isAmbientScheme(editor.document.uri.scheme)) return undefined;
  const fsPath = editor.document.uri.fsPath;
  if (fsPath === "") return undefined;
  if (isEmptySelection(editor.selection)) return { fsPath };
  return { fsPath, selection: rangeFromSelection(editor.selection) };
}

/**
 * What the chip says: the path, and the lines when there are some.
 *
 * `file.ts:12` for one line rather than `file.ts:12-12`, because that is how a
 * person says it and how `buildMentionInput` already writes it.
 *
 * @param path - The path as the engine resolved it. Already escaped, if it is
 *   going to be rendered.
 * @param selection - 1-based inclusive lines, when there is a selection.
 */
export function ambientLabel(path: string, selection?: MentionRange): string {
  if (selection === undefined) return path;
  const { startLine, endLine } = selection;
  return startLine === endLine
    ? `${path}:${String(startLine)}`
    : `${path}:${String(startLine)}-${String(endLine)}`;
}

/** Whether two observations say the same thing, and so are not worth a round trip. */
export function sameAmbient(a: AmbientEditor | undefined, b: AmbientEditor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.fsPath !== b.fsPath) return false;
  if (a.selection === undefined || b.selection === undefined) {
    return a.selection === b.selection;
  }
  return (
    a.selection.startLine === b.selection.startLine && a.selection.endLine === b.selection.endLine
  );
}

/**
 * Whether the ambient chip has nothing to add, because an explicit one already
 * names this file.
 *
 * The chip row is the whole truth about what the next prompt carries, and one
 * file is one attachment: two chips for `src/auth.ts` next to a wire carrying
 * it once would make the row a summary rather than a statement. The explicit
 * chip is the one that stays — somebody put it there on purpose, and it does
 * not move when they scroll.
 *
 * Compared by **path**, never by label: the ambient chip may read
 * `src/auth.ts:12-40`, and its path is still `src/auth.ts`.
 *
 * @param path - The ambient item's path, as the engine resolved it.
 * @param attached - The paths of the chips the user assembled.
 */
export function ambientIsRedundant(path: string, attached: readonly string[]): boolean {
  if (path === "") return false;
  return attached.includes(path);
}

/**
 * What the ambient chip becomes on the wire — a path, an excerpt, or a name.
 *
 * Three spellings, and the distinction between them is the one this whole
 * surface turns on: **a selection is a request; an open file is not.**
 *
 * - **Lines highlighted** → `{ kind: "file", range }`. The user pointed at
 *   something. The excerpt is small, precise, and unambiguously what they
 *   meant. `ActiveEditorItem.selection` is already 1-based and inclusive —
 *   `rangeFromSelection` converts from VS Code's 0-based lines at the one
 *   place that reads an editor — which is exactly what `LineRange` documents,
 *   so the numbers cross the wire unchanged.
 * - **Nothing selected** → `{ kind: "fileReference" }`. The model is told the
 *   path and none of the bytes. Sending it as `{ kind: "file" }` — which is
 *   what this did when the chip shipped — cost about 22,600 tokens a turn for
 *   `packages/protocol/src/client.ts` and about 81,200 for `workflow.ts`, on
 *   *every* turn, for a file the user never asked about and merely had open.
 *   The agent has a `read` tool: a path is enough for it to decide, and it
 *   pays for the file only on the turns where the answer is yes.
 * - **An image** → `{ kind: "image" }`, unchanged. "Read this if it matters"
 *   is not an instruction the `read` tool can act on for a `.png`, and the
 *   case is barely reachable anyway: the tracker only ever sees
 *   `window.activeTextEditor`.
 *
 * Pure, and exported, because it is the load-bearing four lines of the whole
 * ambient feature and it used to live inside `activateSidebar`'s closure where
 * only a live engine could reach it.
 *
 * @param item - The ambient chip as the panel is rendering it. A chip the
 *   engine refused is not attachable and answers `undefined` — the row shows
 *   the refusal, and the engine is not asked to refuse it twice.
 */
export function ambientAttachment(item: {
  readonly path: string;
  readonly kind: ContextKind;
  readonly ok: boolean;
  readonly selection?: { startLine: number; endLine: number };
}): PromptAttachment | undefined {
  if (!item.ok) return undefined;
  if (item.kind === "image") return { kind: "image", path: item.path };
  if (item.selection === undefined) return { kind: "fileReference", path: item.path };
  return {
    kind: "file",
    path: item.path,
    range: { start: item.selection.startLine, end: item.selection.endLine },
  };
}

/**
 * Whether this engine can be told a file is open without being sent it.
 *
 * Read off any `resolveContext` answer, because `attachmentKinds` is a
 * statement about the *engine* and not about the path that was queried — the
 * panel already makes a `resolveContext` round trip per settled observation, so
 * this costs nothing extra.
 *
 * **Absent means an engine older than the field**, which is an engine older
 * than the kind — never "this engine supports no kinds at all", which would
 * also condemn the `@` attachments that work perfectly well on it.
 *
 * @param resolution - Any answer this connection has had from the engine.
 */
export function engineKnowsReferences(resolution: {
  readonly attachmentKinds?: readonly PromptAttachmentKind[];
}): boolean {
  return resolution.attachmentKinds?.includes("fileReference") ?? false;
}

/** What {@link createAmbientTracker} needs. Timers are injected so a test needs no clock. */
export interface AmbientTrackerOptions {
  /** Called once per settled change, with what the panel should now hold. */
  readonly onSettled: (editor: AmbientEditor | undefined) => void;
  /** Defaults to {@link AMBIENT_DEBOUNCE_MS}. */
  readonly delayMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Coalesces the editor's event storm into the handful of answers worth acting on. */
export interface AmbientTracker {
  /** The active editor changed, or its selection moved. */
  observe(editor: TextEditorLike | undefined): void;
  /** A document was closed. Clears the chip, immediately, when it was the one held. */
  closed(fsPath: string): void;
  /** What is held right now, without waiting for anything. */
  current(): AmbientEditor | undefined;
  /** Forget everything and say so — what turning the setting off does. */
  clear(): void;
  dispose(): void;
}

/**
 * Build the tracker.
 *
 * The debounce is trailing and the comparison happens *before* the timer is
 * armed rather than after it fires, which is what makes an unchanged
 * observation cost nothing at all: VS Code fires a selection event for a click
 * that landed where the caret already was, and an active-editor event for a
 * tab that was already active, and neither is news.
 */
export function createAmbientTracker(options: AmbientTrackerOptions): AmbientTracker {
  const delay = options.delayMs ?? AMBIENT_DEBOUNCE_MS;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));

  let held: AmbientEditor | undefined;
  let pending: AmbientEditor | undefined;
  let timer: unknown;
  let disposed = false;

  function cancel(): void {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
    pending = undefined;
  }

  function settle(next: AmbientEditor | undefined): void {
    held = next;
    options.onSettled(held);
  }

  return {
    observe(editor: TextEditorLike | undefined): void {
      if (disposed) return;
      const next = toAmbientEditor(editor);
      // Not a file, or not an editor at all: keep what is held. See the module
      // doc — this is the case that fires every time somebody clicks into the
      // panel to type, and clearing here would make the chip useless.
      if (next === undefined) return;
      if (sameAmbient(next, pending ?? held)) return;
      pending = next;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => {
        timer = undefined;
        const settled = pending;
        pending = undefined;
        if (settled !== undefined) settle(settled);
      }, delay);
    },
    closed(fsPath: string): void {
      if (disposed) return;
      const affectsPending = pending?.fsPath === fsPath;
      if (affectsPending) cancel();
      if (held?.fsPath !== fsPath) {
        // A pending observation about the closed file was dropped above; if it
        // was the only thing this was about, there is still nothing to say.
        if (affectsPending && held === undefined) settle(undefined);
        return;
      }
      cancel();
      settle(undefined);
    },
    current(): AmbientEditor | undefined {
      return held;
    },
    clear(): void {
      cancel();
      if (held === undefined) {
        options.onSettled(undefined);
        return;
      }
      settle(undefined);
    },
    dispose(): void {
      disposed = true;
      cancel();
      held = undefined;
    },
  };
}
