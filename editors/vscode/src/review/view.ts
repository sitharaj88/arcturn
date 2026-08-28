/**
 * The review command, and the diagnostics it leaves behind.
 *
 * `model.ts` owns the prompt and the parsing. This owns the three editor
 * pieces: getting the diff, publishing findings as diagnostics, and clearing
 * them.
 *
 * ## The diff comes from VS Code's git extension, not from a spawned `git`
 *
 * This extension spawns exactly one thing — `arcturn serve` — and that
 * restraint is worth keeping. `git-api.ts` reaches the built-in git
 * extension, which answers diffs without a process; its absence degrades to a
 * message rather than an error, because git being disabled is a
 * configuration, not a fault.
 *
 * ## Findings are diagnostics, and that is the whole point
 *
 * A diagnostic is clickable, lives in the Problems panel, and is offered the
 * extension's existing Fix-with-Arcturn code action — which takes any
 * diagnostic, so review findings compose with it with no new wiring. Review,
 * click, fix, review again: the loop closes inside the editor.
 *
 * Diagnostics are cleared when a review starts (stale findings over moved
 * lines are misinformation), on the clear command, and never on file save —
 * a finding is not fixed by touching the file it points at.
 */

import * as vscode from "vscode";
import { gitApi, repositoryFor } from "../git-api.js";
import { parseFindings, type ReviewFinding, reviewPrompt, reviewSummary } from "./model.js";

/** Command ids this module registers. */
export const REVIEW_COMMANDS = {
  run: "arcturn.reviewChanges",
  clear: "arcturn.clearReview",
} as const;

/** What the review needs from the engine. */
export interface ReviewHost {
  /** One read-only turn in a scratch session; the review rides it. */
  askOnce(prompt: string): Promise<string | undefined>;
}

/**
 * Register the review commands and their diagnostics collection.
 *
 * @returns A disposable that removes the commands and every published finding.
 */
export function activateReview(
  context: vscode.ExtensionContext,
  host: ReviewHost,
): vscode.Disposable {
  const diagnostics = vscode.languages.createDiagnosticCollection("arcturn-review");

  const disposables: vscode.Disposable[] = [
    diagnostics,
    vscode.commands.registerCommand(REVIEW_COMMANDS.clear, () => diagnostics.clear()),
    vscode.commands.registerCommand(REVIEW_COMMANDS.run, () => runReview(host, diagnostics)),
  ];

  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** Collect the diff, run the review, publish the findings. */
async function runReview(
  host: ReviewHost,
  diagnostics: vscode.DiagnosticCollection,
): Promise<void> {
  const api = await gitApi();
  const repo =
    api === undefined
      ? undefined
      : repositoryFor(api, vscode.window.activeTextEditor?.document.uri);
  if (repo === undefined) {
    void vscode.window.showInformationMessage(
      "No git repository is open, so there is no diff to review.",
    );
    return;
  }

  // Staged and unstaged both: "review my changes" means everything not yet
  // committed, and reviewing only one half would bless work the other half
  // breaks. A file appearing in both shows up twice in the text, which a
  // reviewer reads correctly — the second hunk supersedes.
  const [staged, unstaged] = await Promise.all([repo.diff(true), repo.diff(false)]);
  const diff = [staged, unstaged].filter((part) => part.trim() !== "").join("\n");
  if (diff.trim() === "") {
    void vscode.window.showInformationMessage("There are no uncommitted changes to review.");
    return;
  }

  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Arcturn is reviewing your changes" },
    () => host.askOnce(reviewPrompt(diff)),
  );
  if (answer === undefined) {
    void vscode.window.showWarningMessage("Arcturn could not be reached for the review.");
    return;
  }

  const findings = parseFindings(answer);
  if (findings === undefined) {
    // The model answered with prose instead of findings. Its first line is
    // usually the verdict, and showing it beats reporting a parse error.
    void vscode.window.showWarningMessage(
      `The review did not produce findings. It said: ${answer.split("\n")[0] ?? ""}`,
    );
    return;
  }

  // Cleared only now, with new results in hand: a review that failed above
  // leaves the previous findings standing rather than wiping them for nothing.
  diagnostics.clear();
  await publish(diagnostics, repo.rootUri, findings);
  const summary = reviewSummary(findings);
  if (findings.length === 0) {
    void vscode.window.showInformationMessage(summary);
  } else {
    const open = await vscode.window.showInformationMessage(summary, "Open Problems");
    if (open === "Open Problems") {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    }
  }
}

/** Turn findings into diagnostics, grouped per file, lines clamped to reality. */
async function publish(
  diagnostics: vscode.DiagnosticCollection,
  root: vscode.Uri,
  findings: readonly ReviewFinding[],
): Promise<void> {
  const byFile = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.path) ?? [];
    list.push(finding);
    byFile.set(finding.path, list);
  }

  for (const [path, fileFindings] of byFile) {
    const uri = vscode.Uri.joinPath(root, path);
    const lineCount = await lineCountOf(uri);
    if (lineCount === undefined) {
      // The model named a file the diff renamed or it misspelled the path.
      // A diagnostic on a URI that does not resolve shows nowhere; better one
      // message naming what was skipped than findings that silently vanish.
      void vscode.window.showWarningMessage(
        `Review finding skipped: ${path} is not in the workspace.`,
      );
      continue;
    }
    diagnostics.set(
      uri,
      fileFindings.map((finding) => {
        // Clamped, and anchored to a whole line: the model's line number is a
        // claim about a diff, not a fact about the file — see model.ts.
        const line = Math.min(Math.max((finding.line ?? 1) - 1, 0), lineCount - 1);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          finding.detail === "" ? finding.title : `${finding.title} — ${finding.detail}`,
          severityOf(finding.severity),
        );
        diagnostic.source = "arcturn review";
        return diagnostic;
      }),
    );
  }
}

/** How many lines a file has, or `undefined` when it cannot be opened. */
async function lineCountOf(uri: vscode.Uri): Promise<number | undefined> {
  try {
    return (await vscode.workspace.openTextDocument(uri)).lineCount;
  } catch {
    return undefined;
  }
}

function severityOf(severity: ReviewFinding["severity"]): vscode.DiagnosticSeverity {
  if (severity === "error") return vscode.DiagnosticSeverity.Error;
  if (severity === "warning") return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}
