/**
 * Two session-level conveniences: export the chat, and rewind from the palette.
 *
 * ## Export
 *
 * The engine has rendered transcripts since `/export` — markdown or HTML, with
 * a suggested filename — and `exportSession` has carried it over the wire for
 * as long. Nothing in the editor called it, so the only way to keep a
 * conversation was screenshotting the panel. One command: pick a format, pick
 * a place, the engine renders, the editor writes.
 *
 * The engine hands back a *name*, never a path — where the file lands is the
 * user's choice in a save dialog, which is what keeps a remote engine from
 * deciding where on this machine bytes get written.
 *
 * ## Checkpoints, from the palette
 *
 * This was asked for as "checkpoints in the Timeline pane", and that surface
 * cannot be built honestly: `registerTimelineProvider` is still a *proposed*
 * VS Code API — absent from the stable typings — and a marketplace extension
 * cannot ship proposed APIs. What can be built is the keyboard path to the
 * same place: list the checkpoints, pick one, and confirm the same modal the
 * panel's picker shows. Every judgement is reused from `sidebar/rewind.ts` —
 * the row projection, the confirmation prose, the check that the user clicked
 * the scary button — because a rewind overwrites and deletes files, and two
 * copies of that logic would be two chances for one of them to be wrong.
 */

import * as vscode from "vscode";
import {
  type CheckpointRow,
  confirmsRewind,
  describeRewind,
  projectCheckpoint,
} from "../sidebar/rewind.js";

/** Command ids this module registers. */
export const SESSION_COMMANDS = {
  exportChat: "arcturn.exportChat",
  checkpoints: "arcturn.checkpoints",
} as const;

/** What these commands need from the engine session. */
export interface SessionToolsHost {
  /**
   * Render the open conversation. `undefined` when the engine predates the
   * verb, or no session is open.
   */
  exportSession(
    format: "markdown" | "html",
  ): Promise<{ filename: string; content: string; messageCount: number } | undefined>;
  /** The open session's checkpoints, raw from the wire. */
  listCheckpoints(): Promise<
    | {
        id: string;
        label: string;
        timestamp: number;
        fileCount: number;
        deleteCount: number;
        files: string[];
        truncatedFiles: boolean;
        forksConversation: boolean;
        confirmation: string;
      }[]
    | undefined
  >;
  /** Rewind, echoing the checkpoint's confirmation token. */
  rewindTo(checkpointId: string, confirmation: string): Promise<void>;
}

/** Register both commands. */
export function activateSessionTools(
  context: vscode.ExtensionContext,
  host: SessionToolsHost,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand(SESSION_COMMANDS.exportChat, () => exportChat(host)),
    vscode.commands.registerCommand(SESSION_COMMANDS.checkpoints, () => pickCheckpoint(host)),
  ];
  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** Pick a format, render, save. */
async function exportChat(host: SessionToolsHost): Promise<void> {
  const format = await vscode.window.showQuickPick(
    [
      { label: "Markdown", description: "readable anywhere, diffs well", id: "markdown" as const },
      { label: "HTML", description: "self-contained page", id: "html" as const },
    ],
    { title: "Export the conversation as…" },
  );
  if (format === undefined) return;

  const rendered = await host.exportSession(format.id);
  if (rendered === undefined) {
    void vscode.window.showWarningMessage(
      "Nothing to export — no session is open, or this engine cannot render transcripts.",
    );
    return;
  }

  // The engine suggested a *name*; the user chooses the place. A remote
  // engine must not decide where on this machine bytes land.
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    ...(workspace === undefined
      ? {}
      : { defaultUri: vscode.Uri.joinPath(workspace, rendered.filename) }),
    filters: format.id === "markdown" ? { Markdown: ["md"] } : { HTML: ["html"] },
  });
  if (target === undefined) return;

  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(rendered.content));
  const open = await vscode.window.showInformationMessage(
    `Exported ${rendered.messageCount} messages.`,
    "Open",
  );
  if (open === "Open") {
    await vscode.commands.executeCommand("vscode.open", target);
  }
}

/** List, pick, confirm with the panel's own prose, rewind. */
async function pickCheckpoint(host: SessionToolsHost): Promise<void> {
  const entries = await host.listCheckpoints();
  if (entries === undefined) {
    void vscode.window.showWarningMessage(
      "This engine keeps no checkpoints, or no session is open.",
    );
    return;
  }
  if (entries.length === 0) {
    void vscode.window.showInformationMessage("No checkpoints yet — they appear as turns run.");
    return;
  }

  const rows = entries.map((entry) => projectCheckpoint(entry));
  const picked = await vscode.window.showQuickPick(
    rows.map((row) => ({
      label: row.label,
      description: relativeTime(row.timestamp),
      detail: row.detail,
      row,
    })),
    { title: "Rewind to a checkpoint", placeHolder: "Files are restored; later work is deleted" },
  );
  if (picked === undefined) return;

  await confirmAndRewind(host, picked.row);
}

/** The same modal the panel shows, built by the same code. */
async function confirmAndRewind(host: SessionToolsHost, row: CheckpointRow): Promise<void> {
  const prompt = describeRewind(row);
  const choice = await vscode.window.showWarningMessage(
    prompt.message,
    { modal: true, detail: prompt.detail },
    prompt.confirmLabel,
  );
  // The shared check, not a local comparison: what counts as consent to an
  // operation that deletes files is decided in exactly one place.
  if (!confirmsRewind(choice, prompt)) return;

  try {
    await host.rewindTo(row.id, row.confirmation);
    void vscode.window.showInformationMessage(`Rewound to: ${row.label}`);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Rewind failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** "3m ago", for a picker row. Whole units, like the background tree. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
