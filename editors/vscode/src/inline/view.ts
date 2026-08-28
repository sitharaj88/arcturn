/**
 * "Edit this selection", bound to a key.
 *
 * `model.ts` explains why the agent proposes text and the editor makes the
 * edit. This is the gesture around that: take the selection, ask what to do,
 * run one read-only turn, show the answer as a diff, and apply it as a
 * `WorkspaceEdit` if the user says yes.
 *
 * ## The turn runs in a session of its own
 *
 * Not the one in the panel. An inline edit is a private exchange about three
 * lines, and threading it through the conversation would push whatever the
 * person was actually discussing off the top — and then leave the model's
 * "here is the replacement" in the history as though it were an answer to the
 * previous question. The scratch session is created, prompted, read and
 * deleted, and the panel never sees it.
 *
 * The cost is that the model has no memory of the conversation you were having.
 * That is the right trade for a gesture whose whole premise is that the
 * context is *right there on screen*, and it is why the instruction carries
 * the selected text inline rather than relying on anything remembered.
 */

import * as vscode from "vscode";
import {
  describeEdit,
  type EditTarget,
  editInstruction,
  extractReplacement,
  fitToSelection,
  isNoChange,
} from "./model.js";

/** Command ids this module registers. */
export const INLINE_COMMANDS = {
  edit: "arcturn.inlineEdit",
} as const;

/** URI scheme the "before" side of the preview is served from. */
export const INLINE_SCHEME = "arcturn-inline";

/** What the gesture needs from the engine. */
export interface InlineEditHost {
  /**
   * Run one prompt in a throwaway session and return the assistant's text.
   *
   * The session is the host's to create and delete; this module only needs the
   * answer. `undefined` means the engine could not be reached or said nothing.
   */
  askOnce(prompt: string): Promise<string | undefined>;
}

/** Documents for the diff's left-hand side. */
class BeforeDocuments implements vscode.TextDocumentContentProvider {
  readonly #documents = new Map<string, string>();
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#documents.get(uri.toString()) ?? "";
  }

  put(path: string, text: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${INLINE_SCHEME}:/${path}`);
    this.#documents.set(uri.toString(), text);
    this.#changed.fire(uri);
    return uri;
  }

  dispose(): void {
    this.#documents.clear();
    this.#changed.dispose();
  }
}

/**
 * Register the inline-edit command and its preview provider.
 *
 * @returns A disposable that removes both.
 */
export function activateInlineEdit(
  context: vscode.ExtensionContext,
  host: InlineEditHost,
): vscode.Disposable {
  const before = new BeforeDocuments();

  const disposables: vscode.Disposable[] = [
    vscode.workspace.registerTextDocumentContentProvider(INLINE_SCHEME, before),
    { dispose: () => before.dispose() },
    vscode.commands.registerCommand(INLINE_COMMANDS.edit, () => runInlineEdit(host, before)),
  ];

  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** Take the selection, ask, preview, apply. */
async function runInlineEdit(host: InlineEditHost, before: BeforeDocuments): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage("Open a file and select some code first.");
    return;
  }

  const target = targetFor(editor);
  if (target === undefined) {
    void vscode.window.showInformationMessage(
      "Select the lines you want changed, then run the command again.",
    );
    return;
  }

  const request = await vscode.window.showInputBox({
    title: `Edit ${target.start === target.end ? `line ${target.start}` : `lines ${target.start}-${target.end}`}`,
    prompt: "What should change?",
    placeHolder: "sum the prices instead of counting them",
  });
  if (request === undefined || request.trim() === "") return;

  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Arcturn is rewriting the selection" },
    () => host.askOnce(editInstruction(target, request.trim())),
  );
  if (answer === undefined) {
    void vscode.window.showWarningMessage("Arcturn could not be reached for that edit.");
    return;
  }

  const extracted = extractReplacement(answer);
  if (extracted === undefined) {
    // The model answered with prose. Showing it beats a bare failure: it
    // usually says why it did not change anything, and that is the answer.
    void vscode.window.showWarningMessage(
      `Arcturn did not return a replacement. It said: ${answer.split("\n")[0] ?? ""}`,
    );
    return;
  }

  const replacement = fitToSelection(target, extracted);
  if (isNoChange(target, replacement)) {
    void vscode.window.showInformationMessage("Arcturn left the selection unchanged.");
    return;
  }

  const choice = await preview(before, target, replacement);
  if (choice !== "apply") return;

  // A `WorkspaceEdit` rather than a write from the agent: one entry in the
  // editor's undo stack, and the user's own action in their own document.
  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, rangeOf(editor, target), replacement);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage("The edit could not be applied — the file may have moved.");
  }
}

/** Show the change, and ask. */
async function preview(
  before: BeforeDocuments,
  target: EditTarget,
  replacement: string,
): Promise<"apply" | "discard"> {
  const left = before.put(`${target.path}#before`, target.text);
  const right = before.put(`${target.path}#after`, replacement);
  await vscode.commands.executeCommand("vscode.diff", left, right, `${target.path} — proposed`, {
    preview: true,
  });

  const answer = await vscode.window.showInformationMessage(
    describeEdit(target, replacement),
    { modal: false },
    "Apply",
    "Discard",
  );
  return answer === "Apply" ? "apply" : "discard";
}

/**
 * What the user has selected, or `undefined` when they have selected nothing.
 *
 * An empty selection is refused rather than widened to the whole line or the
 * enclosing function: guessing what somebody meant and then rewriting it is
 * the one behaviour an inline edit cannot get away with.
 */
export function targetFor(editor: vscode.TextEditor): EditTarget | undefined {
  const selection = editor.selection;
  if (selection.isEmpty) return undefined;
  const document = editor.document;
  // Whole lines, always. A partial-line replacement would need the model to
  // reproduce the surrounding characters exactly, and a near-miss there
  // corrupts a line rather than failing.
  const start = selection.start.line;
  const end = selection.end.line;
  const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
  return {
    path: vscode.workspace.asRelativePath(document.uri, false),
    start: start + 1,
    end: end + 1,
    text: document.getText(range),
    languageId: document.languageId,
  };
}

/** The editor range an `EditTarget` names. */
function rangeOf(editor: vscode.TextEditor, target: EditTarget): vscode.Range {
  const endLine = target.end - 1;
  return new vscode.Range(
    target.start - 1,
    0,
    endLine,
    editor.document.lineAt(endLine).text.length,
  );
}
