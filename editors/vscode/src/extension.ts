/**
 * Activation: wire the commands, the code action, and the one seam into
 * Builder B's sidebar.
 *
 * Owned by Builder A per RFC 0004 §2.
 *
 * Two things this file is careful about. First, activation is cheap — no
 * process is spawned and no socket is opened here; the provisioner does not
 * look for the binary until a command asks it to. That is what lets the
 * manifest keep narrow activation events instead of `"*"`. Second, the
 * sidebar is loaded through a lazy import behind a `typeof` check, so Stage 1
 * keeps working whether Stage 2 has landed, is disabled by setting, or throws
 * on the way up.
 */

import * as vscode from "vscode";
import { type CliProvisioner, createCliProvisioner, type ResolveCli } from "./cli.js";
import { FIX_COMMAND, registerDiagnosticFixProvider } from "./code-actions.js";
import {
  buildDiagnosticPrompt,
  buildMentionInput,
  type MentionRange,
  rangeFromSelection,
  type SelectionLike,
  toWorkspaceRelative,
} from "./mentions.js";
import { createTerminalHub, type TerminalHub } from "./terminal.js";

/**
 * The shape Builder B publishes from `src/sidebar/index.ts`, per RFC 0004 §2.
 *
 * Declared here rather than imported as a type because A must typecheck and
 * ship before B's module exports anything — the runtime `typeof` check below
 * is what makes that safe rather than merely convenient.
 */
interface SidebarSeam {
  activateSidebar(context: vscode.ExtensionContext, resolveCli: ResolveCli): vscode.Disposable;
}

/** What `activate` builds for itself; tests substitute fakes. */
export interface ExtensionDeps {
  readonly provisioner: CliProvisioner;
  readonly hub: TerminalHub;
  readonly platform: NodeJS.Platform;
}

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return activateWith(context, {
    provisioner: createCliProvisioner({ state: context.globalState }),
    hub: createTerminalHub(),
    platform: process.platform,
  });
}

export function deactivate(): void {
  // Everything registered went into context.subscriptions; VS Code disposes
  // them for us. Nothing outlives the window.
}

export async function activateWith(
  context: vscode.ExtensionContext,
  deps: ExtensionDeps,
): Promise<void> {
  const { provisioner, hub, platform } = deps;
  context.subscriptions.push(provisioner, hub);

  function folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  }

  /**
   * Type a mention for `uri` into this folder's terminal, launching if needed.
   *
   * Every path that types into a terminal goes through here — Send File, Send
   * Selection and the diagnostic code action alike — so the refusal that
   * `buildMentionInput` can return is handled once instead of three times.
   * `decorate` is how the code action adds its problem text without earning
   * its own copy of this logic, and so its own chance to skip the check.
   */
  async function sendMention(
    uri: vscode.Uri,
    range: MentionRange | undefined,
    decorate: (mention: string) => string = (mention) => mention,
  ): Promise<void> {
    const cli = await provisioner.resolveCli();
    // No notification here: resolveCli already raised exactly one, and a
    // second would be the extension talking over itself.
    if (cli === undefined) return;
    const folder = folderFor(uri);
    const relative = toWorkspaceRelative(folder?.uri.fsPath, uri.fsPath, platform);
    const mention = buildMentionInput(relative, range);
    if (!mention.ok) {
      // Refusing is the feature, not a failure: see the module doc in
      // `mentions.ts` for why a name that cannot be carried safely is not
      // quietly rewritten into one that can.
      vscode.window.showWarningMessage(`Arcturn: ${mention.reason}`);
      return;
    }
    await hub.sendInput(folder, cli, decorate(mention.input));
  }

  function activeFileUri(): vscode.Uri | undefined {
    return vscode.window.activeTextEditor?.document.uri;
  }

  function complain(what: string): void {
    vscode.window.showInformationMessage(`Arcturn: ${what}`);
  }

  const commands: [string, (...args: never[]) => unknown][] = [
    [
      "arcturn.open",
      async () => {
        const cli = await provisioner.resolveCli();
        if (cli === undefined) return;
        const uri = activeFileUri();
        hub.open(uri === undefined ? vscode.workspace.workspaceFolders?.[0] : folderFor(uri), cli);
      },
    ],
    [
      "arcturn.sendSelection",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) {
          complain("open a file and select some code first.");
          return;
        }
        await sendMention(editor.document.uri, rangeFromSelection(editor.selection));
      },
    ],
    [
      "arcturn.sendFile",
      async (uri?: vscode.Uri) => {
        const target = uri ?? activeFileUri();
        if (target === undefined) {
          complain("open a file first, or right-click one in the explorer.");
          return;
        }
        await sendMention(target, undefined);
      },
    ],
    [
      FIX_COMMAND,
      async (uri: vscode.Uri, range: SelectionLike, message: string) =>
        sendMention(uri, rangeFromSelection(range), (mention) =>
          buildDiagnosticPrompt(mention, message),
        ),
    ],
    ["arcturn.installCli", () => provisioner.runInstall("install")],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
  context.subscriptions.push(registerDiagnosticFixProvider());

  // The sidebar's lifetime is held here rather than in context.subscriptions,
  // because the setting can turn it off mid-session and something has to be
  // able to reach it. `activateSidebar` still pushes its own disposable, so
  // deactivation is covered either way.
  let sidebar: vscode.Disposable | undefined;
  let starting = false;

  /**
   * Bring the sidebar into line with `arcturn.serve.enabled`.
   *
   * Idempotent in both directions, because VS Code will happily deliver two
   * configuration events for one edit and the palette re-evaluates its `when`
   * clauses live — the setting flipping true makes six sidebar commands appear
   * in the palette whether or not anything has registered them.
   */
  async function syncSidebar(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration("arcturn")
      .get<boolean>("serve.enabled", true);
    if (enabled) {
      if (sidebar !== undefined || starting) return;
      starting = true;
      try {
        sidebar = await startSidebar(context, provisioner.resolveCli);
      } finally {
        starting = false;
      }
      return;
    }
    if (sidebar === undefined) return;
    // Turning the setting off is a request to stop running a server, and a
    // request honoured only at the next window reload is not honoured: it
    // leaves a loopback listener holding a live token that the user believes
    // they switched off. The cost is an in-flight turn, which is the lesser
    // harm — the session itself lives in the engine's store and resumes.
    //
    // This disposes something `activateSidebar` also put on
    // context.subscriptions, so deactivation will dispose it a second time.
    // That is safe by the seam's contract, and is the reason the contract
    // says so.
    sidebar.dispose();
    sidebar = undefined;
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("arcturn.serve.enabled")) void syncSidebar();
    }),
  );

  await syncSidebar();
}

/**
 * Hand the sidebar its one entry point.
 *
 * The import is dynamic so the module body — and everything it pulls in —
 * does not run in a window where `arcturn.serve.enabled` is off. The caller
 * owns the gating and the "only once" part; this function only starts it.
 *
 * @returns The sidebar's disposable, or `undefined` when Stage 2 is absent or
 *   failed to come up. `undefined` is not an error state: a later toggle of
 *   the setting will try again.
 */
async function startSidebar(
  context: vscode.ExtensionContext,
  resolveCli: ResolveCli,
): Promise<vscode.Disposable | undefined> {
  try {
    const loaded: unknown = await import("./sidebar/index.js");
    const seam = loaded as Partial<SidebarSeam>;
    // Stage 2 may not have landed in this build. Silence is the right answer:
    // the manifest hides the view behind the same setting, so nothing is
    // visibly missing.
    if (typeof seam.activateSidebar !== "function") return undefined;
    // `activateSidebar` puts its disposable on `context.subscriptions` itself,
    // so the caller must not push it a second time; it keeps the reference
    // only so the setting can turn the sidebar off later.
    return seam.activateSidebar(context, resolveCli);
  } catch (error) {
    // Stage 1 is the front-end that always has to work. A sidebar that fails
    // to come up must not take the terminal integration down with it.
    const detail = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Arcturn: the sidebar failed to start (${detail}).`);
    return undefined;
  }
}
