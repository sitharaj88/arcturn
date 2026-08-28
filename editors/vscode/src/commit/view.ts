/**
 * The generate-commit-message button.
 *
 * `model.ts` owns the prompt and the cleanup; this owns the gesture: read the
 * diff and the recent subjects from the git extension, run one read-only turn,
 * and put the result in the Source Control input box for the user to edit.
 * Nothing is committed — generating is cheap, committing is permanent, and the
 * box exists so a person edits before they commit.
 *
 * The staged diff when anything is staged, the working tree otherwise: staging
 * is the user saying "this is the commit", and describing more than they chose
 * would write a message for a commit they are not making. With nothing staged
 * there is no such statement, and describing the working tree is what they
 * are about to commit with `git add -A` anyway.
 */

import * as vscode from "vscode";
import { type GitRepositoryLike, gitApi, repositoryFor } from "../git-api.js";
import { cleanMessage, commitPrompt } from "./model.js";

/** Command ids this module registers. */
export const COMMIT_COMMANDS = {
  generate: "arcturn.generateCommitMessage",
} as const;

/** What the button needs from the engine. */
export interface CommitHost {
  /** One read-only turn in a scratch session. */
  askOnce(prompt: string): Promise<string | undefined>;
}

/**
 * Register the generate command.
 *
 * The SCM button itself is a `scm/title` menu contribution in the manifest;
 * VS Code passes the repository the click happened in, so multi-repo
 * workspaces address the right one without a picker.
 */
export function activateCommit(
  context: vscode.ExtensionContext,
  host: CommitHost,
): vscode.Disposable {
  const disposable = vscode.commands.registerCommand(
    COMMIT_COMMANDS.generate,
    // From the SCM title bar VS Code passes a SourceControl whose rootUri
    // names the repository; from the palette there is no argument and the
    // active editor decides.
    async (scm?: { rootUri?: vscode.Uri }) => {
      const api = await gitApi();
      const repo =
        api === undefined
          ? undefined
          : ((scm?.rootUri !== undefined
              ? api.repositories.find(
                  (candidate) => candidate.rootUri.fsPath === scm.rootUri?.fsPath,
                )
              : undefined) ?? repositoryFor(api, vscode.window.activeTextEditor?.document.uri));
      if (repo === undefined) {
        void vscode.window.showInformationMessage("No git repository is open.");
        return;
      }
      await generate(host, repo);
    },
  );
  context.subscriptions.push(disposable);
  return disposable;
}

/** Build the prompt, ask, land the message. */
async function generate(host: CommitHost, repo: GitRepositoryLike): Promise<void> {
  const staged = await repo.diff(true);
  const useStaged = staged.trim() !== "";
  const diff = useStaged ? staged : await repo.diff(false);
  if (diff.trim() === "") {
    void vscode.window.showInformationMessage("There are no changes to describe.");
    return;
  }

  const recent = await repo.log({ maxEntries: 10 }).catch(() => []);

  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: "Writing a commit message" },
    () =>
      host.askOnce(
        commitPrompt({
          diff,
          staged: useStaged,
          recentSubjects: recent.map((commit) => commit.message),
        }),
      ),
  );
  if (answer === undefined) {
    void vscode.window.showWarningMessage("Arcturn could not be reached to write the message.");
    return;
  }

  const message = cleanMessage(answer);
  if (message === undefined) {
    void vscode.window.showWarningMessage("Arcturn did not produce a usable commit message.");
    return;
  }

  // Into the box, never into a commit. Overwriting what is there is the
  // established behaviour of every such button, and the user asked for a
  // generated message by clicking it.
  repo.inputBox.value = message;
}
