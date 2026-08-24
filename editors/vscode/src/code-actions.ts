/**
 * "Fix with Arcturn" — the lightbulb entry on any diagnostic.
 *
 * It sends the file, the range and the problem-reporter's own words into the
 * terminal. It does not paraphrase the diagnostic, and it does not attempt a
 * fix itself: the engine is the only thing in this system allowed to change
 * code, under the permission rules it already enforces.
 */

import * as vscode from "vscode";

/** The command the action invokes. Hidden from the palette — it needs arguments. */
export const FIX_COMMAND = "arcturn.fixDiagnostic";

const TITLE = "Fix with Arcturn";

/** The provider, separated from registration so a test can call it directly. */
export function createDiagnosticFixProvider(): vscode.CodeActionProvider {
  return {
    provideCodeActions(document, _range, context) {
      const actions: vscode.CodeAction[] = [];
      for (const diagnostic of context.diagnostics) {
        const action = new vscode.CodeAction(TITLE, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        // Deliberately not `isPreferred`. Fix-on-save and the first ctrl+.
        // entry both take the preferred action; claiming that slot would turn
        // a routine auto-fix into "open a chat about it".
        action.command = {
          command: FIX_COMMAND,
          title: TITLE,
          arguments: [document.uri, diagnostic.range, diagnostic.message],
        };
        actions.push(action);
      }
      return actions;
    },
  };
}

/**
 * Register the provider for on-disk files.
 *
 * `{ scheme: "file" }` and nothing else: a mention is a path the engine
 * resolves against the workspace, and an untitled buffer, a diff view or an
 * output channel has no path to send.
 */
export function registerDiagnosticFixProvider(): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(
    { scheme: "file" },
    createDiagnosticFixProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  );
}
