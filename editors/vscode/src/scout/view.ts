/**
 * Comparing scout approaches in the editor.
 *
 * `/scout` races two or more approaches in throwaway git worktrees and prints
 * a report. In a terminal that report is a wall of unified diff, and choosing
 * between approaches means reading two patches by eye. VS Code has the right
 * surface for this and always did — `vscode.diff` and the multi-file diff
 * editor — and now that the engine keeps a record of a run, the panel can
 * reach it.
 *
 * ## Documents, not files
 *
 * Nothing here writes to disk. The two sides of each diff are held as
 * in-memory documents behind a `arcturn-scout:` content provider, for three
 * reasons that are each sufficient: the worktree the diff came from was
 * deleted seconds after it was captured; the engine may not be on this
 * machine; and a scout's output is a proposal, so putting it in the workspace
 * before the user has chosen would be writing files nobody asked for.
 *
 * Applying an approach is therefore deliberately *not* here. A scout is an
 * exploration, and the thing to do with the winner is to ask the agent for it
 * — which is what the "Send to Arcturn" action does, by putting the approach's
 * findings into the composer rather than its patch into your tree.
 */

import * as vscode from "vscode";
import {
  approachSummaryLine,
  type PatchFile,
  parseApproaches,
  type ScoutApproachSummary,
  summarise,
  touchedPaths,
} from "./patch.js";

/** URI scheme for the reconstructed documents. */
export const SCOUT_SCHEME = "arcturn-scout";

/** Command ids this module registers. */
export const SCOUT_COMMANDS = {
  run: "arcturn.scout.run",
} as const;

/** What the scout view needs from the engine. */
export interface ScoutHost {
  startScout(
    approaches: readonly { name: string; task: string }[],
  ): Promise<{ runId: string } | undefined>;
  scoutRun(runId: string): Promise<{
    state: string;
    results: readonly {
      name: string;
      task: string;
      status: string;
      finalText: string;
      costUsd?: number;
      diff?: string;
      durationMs: number;
    }[];
    warnings: readonly string[];
    error?: string;
  }>;
  cancelScout(runId: string): Promise<boolean>;
  /**
   * Ask the agent to do something, in the open session.
   *
   * This is how a winning approach is acted on. Note what it does *not* do:
   * apply the scout's patch. That patch was made against a worktree branched
   * from a commit the working tree may have moved past, in a directory that no
   * longer exists — so the sound move is to hand the agent the findings and
   * let it do the work against the tree as it is now.
   */
  askAgent(text: string): Promise<void>;
}

/**
 * The document store behind `arcturn-scout:`.
 *
 * Keyed by the whole URI so two approaches touching the same path do not
 * collide, which is exactly the case a comparison is for.
 */
class ScoutDocuments implements vscode.TextDocumentContentProvider {
  readonly #documents = new Map<string, string>();
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#documents.get(uri.toString()) ?? "";
  }

  /** Register one side of one file, and hand back the URI that serves it. */
  put(
    runId: string,
    approach: string,
    side: "before" | "after",
    path: string,
    text: string,
  ): vscode.Uri {
    // The path is the URI's path so the editor's title, language detection and
    // syntax highlighting all come out right; the rest is disambiguation.
    const uri = vscode.Uri.parse(
      `${SCOUT_SCHEME}:/${encodeURIComponent(runId)}/${encodeURIComponent(approach)}/${side}/${path}`,
    );
    this.#documents.set(uri.toString(), text);
    this.#changed.fire(uri);
    return uri;
  }

  /** Forget one run's documents. */
  forget(runId: string): void {
    const prefix = `${SCOUT_SCHEME}:/${encodeURIComponent(runId)}/`;
    for (const key of [...this.#documents.keys()]) {
      if (key.startsWith(prefix)) this.#documents.delete(key);
    }
  }

  dispose(): void {
    this.#documents.clear();
    this.#changed.dispose();
  }
}

/** How often a running scout is re-read. */
const POLL_INTERVAL_MS = 1_500;

/**
 * Register the scout commands and the document provider.
 *
 * @returns A disposable that removes both and drops every held document.
 */
export function activateScout(
  context: vscode.ExtensionContext,
  host: ScoutHost,
): vscode.Disposable {
  const documents = new ScoutDocuments();

  const disposables: vscode.Disposable[] = [
    vscode.workspace.registerTextDocumentContentProvider(SCOUT_SCHEME, documents),
    { dispose: () => documents.dispose() },
    vscode.commands.registerCommand(SCOUT_COMMANDS.run, () => runScout(host, documents)),
  ];

  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** Ask for the approaches, run them, then open the comparison. */
async function runScout(host: ScoutHost, documents: ScoutDocuments): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: "Scout approaches",
    prompt: "Two or more approaches, separated by |",
    placeHolder: "zustand: use zustand | redux: use redux toolkit",
    validateInput: (value) =>
      parseApproaches(value).length < 2
        ? "Give at least two approaches, separated by |"
        : undefined,
  });
  if (input === undefined) return;

  const approaches = parseApproaches(input);
  const started = await host.startScout(approaches);
  if (started === undefined) {
    void vscode.window.showWarningMessage(
      "This engine cannot run scouts from the editor; use /scout in the terminal instead.",
    );
    return;
  }

  const run = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Scouting ${approaches.length} approaches`,
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => void host.cancelScout(started.runId));
      let settled = 0;
      for (;;) {
        const current = await host.scoutRun(started.runId);
        if (current.results.length > settled) {
          settled = current.results.length;
          // Named as they land, so a run where one approach is much slower
          // still shows progress rather than a spinner that never moves.
          progress.report({
            message: `${settled}/${approaches.length} done — ${current.results
              .map((result) => result.name)
              .join(", ")}`,
          });
        }
        if (current.state !== "running") return current;
        if (token.isCancellationRequested) return current;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    },
  );

  if (run.state === "failed") {
    void vscode.window.showErrorMessage(`The scout run failed: ${run.error ?? "no reason given"}`);
    return;
  }
  for (const warning of run.warnings) void vscode.window.showWarningMessage(`Scout: ${warning}`);

  await openComparison(host, documents, started.runId, summarise(run.results));
}

/**
 * Show the approaches, then whichever one the reader picks.
 *
 * A quick-pick first rather than every diff at once: with three approaches and
 * four files each, opening twelve diff editors is not a comparison, it is a
 * mess to close.
 */
async function openComparison(
  host: ScoutHost,
  documents: ScoutDocuments,
  runId: string,
  approaches: readonly ScoutApproachSummary[],
): Promise<void> {
  if (approaches.length === 0) {
    void vscode.window.showInformationMessage("The scout run produced no results.");
    return;
  }

  const paths = touchedPaths(approaches);
  const picked = await vscode.window.showQuickPick(
    approaches.map((approach) => ({
      label: approach.name,
      description: approachSummaryLine(approach),
      detail: approach.finalText.split("\n")[0] ?? approach.task,
      approach,
    })),
    {
      title: `Scout results — ${paths.length} ${paths.length === 1 ? "file" : "files"} touched across ${approaches.length} approaches`,
      placeHolder: "Which approach do you want to read?",
    },
  );
  if (picked === undefined) return;

  await openApproach(documents, runId, picked.approach);

  const next = await vscode.window.showInformationMessage(
    `${picked.approach.name}: ${approachSummaryLine(picked.approach)}`,
    "Ask Arcturn to apply it",
    "Compare another",
  );
  if (next === "Compare another") {
    await openComparison(host, documents, runId, approaches);
    return;
  }
  if (next === "Ask Arcturn to apply it") {
    // The findings, not the patch — see `ScoutHost.askAgent`. The label says
    // "ask" because that is what happens: a turn starts, and it costs money.
    await host.askAgent(scoutHandoff(picked.approach));
  }
}

/** Open one approach's files as diffs. */
async function openApproach(
  documents: ScoutDocuments,
  runId: string,
  approach: ScoutApproachSummary,
): Promise<void> {
  if (approach.files.length === 0) {
    void vscode.window.showInformationMessage(
      `${approach.name} changed no files. Its findings: ${approach.finalText.slice(0, 200)}`,
    );
    return;
  }

  const changes: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  for (const file of approach.files) {
    if (file.binary) continue;
    const before = documents.put(runId, approach.name, "before", file.oldPath, file.before);
    const after = documents.put(runId, approach.name, "after", file.path, file.after);
    changes.push([after, before, after]);
  }
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(`${approach.name} changed only binary files.`);
    return;
  }

  const partial = approach.files.some((file) => file.partial);
  if (partial) {
    // Said once, up front. A reader who does not know the gaps are elided will
    // read a reconstructed file as the whole file.
    void vscode.window.showInformationMessage(
      "Some files are shown only where the patch covered them; unchanged regions are elided.",
    );
  }

  try {
    // The multi-file diff editor when it is available, which is the surface
    // this feature is really for.
    await vscode.commands.executeCommand("vscode.changes", `Scout: ${approach.name}`, changes);
  } catch {
    // Older editors have no `vscode.changes`; one diff per file still works.
    for (const [, before, after] of changes) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        `${approach.name}: ${labelOf(after)}`,
      );
    }
  }
}

/** The file name a diff title should carry. */
function labelOf(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] ?? uri.path;
}

/** Re-exported so the tests can build summaries without the editor. */
export type { PatchFile, ScoutApproachSummary };

/**
 * The prompt that hands a winning approach to the agent.
 *
 * The task and the findings, and an explicit note that the patch is not
 * attached — otherwise a model reading "apply this approach" may go looking
 * for a diff it was never given and invent one.
 */
export function scoutHandoff(approach: ScoutApproachSummary): string {
  const files = approach.files.map((file) => `- ${file.path} (${file.change})`).join("\n");
  return (
    `A scout explored this approach in a throwaway worktree, which has since been deleted. ` +
    `Apply it here, against the working tree as it is now.\n\n` +
    `**${approach.name}** — ${approach.task}\n\n` +
    `What the scout reported:\n\n${approach.finalText}\n\n` +
    (files === "" ? "It changed no files." : `Files it touched:\n${files}`)
  );
}
