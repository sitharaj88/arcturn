// Owned by Builder B per RFC 0004 §2. Seam: activateSidebar(context, resolveCli).
/**
 * The Stage 2 seam.
 *
 * Builder A calls {@link activateSidebar} exactly once, gated on
 * `arcturn.serve.enabled`. Everything below it — the `arcturn serve` child, the
 * protocol client, the chat webview, the permission surface, the cost status
 * bar, the model and session pickers — is Builder B's, and none of it runs
 * until the user opens the `arcturn.sidebar` view or invokes one of the
 * commands registered here. That is RFC 0004 §3's activation budget: "no
 * protocol connection, no server spawn, until the user opens the sidebar or
 * runs a command."
 *
 * This file is deliberately the *only* one in `src/sidebar/` that is more than
 * incidentally about VS Code, and it is deliberately thin: every decision it
 * makes is delegated to a module that has no `vscode` import and its own
 * tests. What is left here is wiring — registration, disposal, and turning a
 * quick-pick selection into a protocol call.
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as vscode from "vscode";
import { ARCTURN_EXTENSION_ID, authorizeMcpServer, type McpAuthEditor } from "../mcp-auth.js";
import type { ResolvedCliLike } from "../serve/args.js";
import type { SocketFactory } from "../serve/connect.js";
import {
  isUnsupportedMethodError,
  type PermissionMode,
  type PromptAttachment,
  type WebSocketLike,
} from "../serve/engine.js";
import { createRedactor } from "../serve/redact.js";
import type { SpawnLike } from "../serve/supervisor.js";
import { generateToken } from "../serve/token.js";
import { forgetFailedUserEnvironment, resolveUserEnvironment } from "../user-env.js";
import {
  type AmbientEditor,
  ambientAttachment,
  ambientIsRedundant,
  createAmbientTracker,
  engineKnowsReferences,
  sameAmbient,
  type TextEditorLike,
} from "./active-editor.js";
import { type ChatViewModel, toViewModel } from "./chat-state.js";
import { createCoalescer } from "./coalesce.js";
import { type ConnectionActionId, type ConnectionReport, reportText } from "./connection-card.js";
import { costBreakdown, costLabel } from "./cost.js";
import { confirmsSessionDeletion, describeSessionDeletion, permissionChoices } from "./dialog.js";
import {
  confirmsDiscard,
  DRY_RUN_SCHEME,
  type DryRunView,
  describeDiscard,
  diffTitle,
  type PendingChangeRow,
  pendingDocumentPath,
  toDryRunView,
} from "./dry-run.js";
import { createEngineSession, type EngineSession } from "./engine-session.js";
import { PermissionSurface } from "./permission-surface.js";
import { escapeCodicons, modelPickItems } from "./picker.js";
import {
  type CheckpointRow,
  confirmsRewind,
  describeRewind,
  type RewindView,
  toRewindView,
} from "./rewind.js";
import { CostStatusBar } from "./status-bar.js";
import { SidebarViewProvider } from "./view.js";
import type { CommandOption } from "./webview-commands.js";
import { contextGlob, narrowCandidates } from "./webview-context.js";
import {
  type ActiveEditorItem,
  type CommandListStatus,
  type ContextItem,
  type ModelListStatus,
  type PermissionStateStatus,
  projectActiveEditorItem,
  projectCommandOption,
  projectContextItem,
  projectModelOption,
  projectSessions,
  type SessionListStatus,
  type WebviewCommand,
} from "./webview-messages.js";
import type { ModelOption } from "./webview-models.js";
import type { SessionOption } from "./webview-sessions.js";
import {
  EMPTY_WORKFLOW_VIEW,
  isRunLive,
  projectWorkflow,
  projectWorkflowRun,
  RUN_WORKFLOW,
  runConfirmation,
  type WorkflowOption,
  type WorkflowRunRow,
  type WorkflowView,
} from "./workflows.js";

/**
 * Builder A's resolved CLI.
 *
 * A owns the real type in `src/cli.ts`; this is the structural shape the
 * sidebar consumes, so the two sides compile independently. When A's export
 * lands, replace this alias with
 * `import type { ResolvedCli } from "../cli.js"` — `cliInvocation` in
 * `serve/args.ts` already accepts either field spelling.
 */
export type ResolvedCli = ResolvedCliLike;

/**
 * The view id this module registers a `WebviewViewProvider` for.
 *
 * Exported so the manifest and the registration can be pinned to each other:
 * `package.json` declares the view, `resolveWebviewView` is only ever called
 * for the id it declares, and a test on either side can assert the two strings
 * are the same one rather than two copies that happen to match today. The
 * value lives on {@link SidebarViewProvider}; this is the seam's spelling of it.
 */
export const SIDEBAR_VIEW_ID = SidebarViewProvider.viewId;

/**
 * How many paths the workspace index is asked for before the picker narrows.
 *
 * Free — `findFiles` is the editor's own index and costs no engine round trip
 * — so this is generous, and `narrowCandidates` is what turns it into the
 * handful of paths that actually get resolved.
 */
const MAX_INDEX_MATCHES = 400;

/**
 * The setting that decides whether the panel watches the editor.
 *
 * Spelled as a group — `arcturn.context.*` — for the reason `arcturn.serve.*`
 * is: this is the first of a family, and a flat `arcturn.activeEditorContext`
 * would leave the second one with nowhere to go.
 *
 * **Default: on.** Three reasons, in order of how much they cost to ignore.
 * The panel already ships four starter prompts, and three of them say "the
 * file I have open" or "the code I have selected" — with nothing watching,
 * those buttons ask the model a question about a file it was never told, and
 * it answers confidently about nothing. Second, this is what a person coming
 * from Claude's extension expects, and a panel that silently knows less than
 * the one next to it reads as broken rather than as careful. Third, the
 * exposure a default-on adds is bounded and visible: the extension reads no
 * file (the engine does, from a path, where the permission engine can see it),
 * the chip is on screen before anything is sent, and nothing leaves the
 * machine until somebody presses send — which is already true of every `@`
 * they type.
 *
 * What that argument does *not* justify is having no switch, which is why
 * there are three: this setting, the `arcturn.toggleActiveEditorContext`
 * command, and the chip's own dismiss control.
 */
const ACTIVE_EDITOR_SETTING = "context.activeEditor";

/** Command ids this module registers. Builder A declares them in the manifest. */
export const SIDEBAR_COMMANDS = {
  selectModel: "arcturn.selectModel",
  showDiff: "arcturn.showDiff",
  applyChanges: "arcturn.applyChanges",
  discardChanges: "arcturn.discardChanges",
  showSessions: "arcturn.showSessions",
  newSession: "arcturn.newSession",
  abortRun: "arcturn.abortRun",
  showCost: "arcturn.showCost",
  reconnect: "arcturn.reconnect",
  showLog: "arcturn.showLog",
  toggleActiveEditorContext: "arcturn.toggleActiveEditorContext",
  authorizeMcpServer: "arcturn.authorizeMcpServer",
} as const;

/**
 * Which VS Code command each `WEBVIEW_COMMANDS` id runs.
 *
 * A **total** record rather than a chain of ternaries, and that is the point:
 * `WEBVIEW_COMMANDS` grows when the engine grows a built-in the panel has a
 * surface for, and a chain ending in an `else` would silently route the new id
 * to whatever the last branch happened to be. Typed as
 * `Record<WebviewCommand, …>`, an id with no entry does not compile.
 *
 * Every value is a command this module registers below, so a message from the
 * page can only ever reach one of them — the page never names a VS Code
 * command, it names one of four ids.
 */
const WEBVIEW_COMMAND_TARGETS: Record<WebviewCommand, string> = {
  model: SIDEBAR_COMMANDS.selectModel,
  sessions: SIDEBAR_COMMANDS.showSessions,
  newSession: SIDEBAR_COMMANDS.newSession,
  // `/cost` in the terminal prints a readout; here it opens the one the panel
  // already has. No engine round trip: the figures come from the `turnEnd`
  // events this extension folds in `cost.ts`, which is why RFC 0005's command
  // list can offer `/cost` without the protocol growing a verb for it.
  cost: SIDEBAR_COMMANDS.showCost,
};

/**
 * Wire up the native sidebar.
 *
 * @param context - The extension context; every registration is also pushed
 *   onto `context.subscriptions` so deactivation cleans up even if the caller
 *   drops the returned disposable.
 * @param resolveCli - Builder A's CLI resolution, called lazily the first time
 *   the engine is started (never at activation).
 * @returns A disposable that kills the `arcturn serve` child, closes the
 *   protocol client, and removes every registration.
 */
export function activateSidebar(
  context: vscode.ExtensionContext,
  resolveCli: () => Promise<ResolvedCli | undefined>,
): vscode.Disposable {
  const output = vscode.window.createOutputChannel("Arcturn Sidebar");
  const statusBar = new CostStatusBar(SIDEBAR_COMMANDS.showCost);
  const disposables: vscode.Disposable[] = [output, statusBar];
  let engine: EngineSession | undefined;

  /**
   * The output channel is the extension's only diagnostic sink, and
   * `output.appendLine` is called from exactly one place: here. So this is the
   * chokepoint where the credential rule is enforced rather than assumed.
   *
   * Most callers are already redacted upstream — `engine-session.ts`,
   * `supervisor.ts` and `connect.ts` each own a token-aware redactor —
   * but three wires reach this closure carrying text nobody filtered:
   * `host.onDiagnostic` (controller failures), `withEngine`'s catch (command
   * failures), and the webview provider's validation notice. Redacting here
   * covers all of them, and covers whatever is wired in next.
   *
   * This redactor is not told the token's value — the token is generated
   * inside the engine session, which redacts by value before handing anything
   * over. What it adds is the shape rules: `--token <x>`, `token=<x>`, and a
   * long hex run, which is precisely the shape `serve/token.ts` produces.
   */
  const redactor = createRedactor();
  const log = (line: string): void => output.appendLine(redactor.redact(line));

  const provider = new SidebarViewProvider({
    onResolve: () => void start(),
    onReady: () => void start(),
    onMessage: (message) => {
      switch (message.type) {
        case "send": {
          // The chips go with the text, and are cleared once they are on the
          // wire: a chip that survived its own prompt would ride along on the
          // next one too, which is a file the user attached once being sent
          // twice.
          const attachments = pendingAttachments();
          void withEngine((session) => session.controller?.send(message.text, attachments));
          clearContext();
          return;
        }
        case "resolveContext":
          void resolveContext(message.query);
          return;
        case "attach":
          void attachPaths(message.paths);
          return;
        case "detach":
          if (attached.delete(message.id)) {
            pasted.delete(message.id);
            publishContext();
          }
          return;
        case "attachImage":
          attachPastedImage(message.data, message.mimeType);
          return;
        case "browseForFiles":
          void browseForFiles();
          return;
        case "disableActiveEditorContext":
          void setAmbientEnabled(false);
          return;
        case "requestPermission":
          void publishPermission();
          return;
        case "permissionDecision":
          // The page names a button on a request; `PermissionSurface` decides
          // what that means, through the same `answerFromChoice` the native
          // modal's answer goes through, and drops it if it does not name the
          // request currently on the card.
          permissions.answer(message.requestId, message.choice);
          return;
        case "setPermissionMode":
          void applyPermissionMode(message.mode);
          return;
        case "requestCommands":
          void publishCommands();
          return;
        case "requestDryRun":
          void publishDryRun();
          return;
        case "showDiff":
          void showDiff(message.path);
          return;
        case "applyChanges":
          void applyChanges(message.paths);
          return;
        case "discardChanges":
          void discardChanges();
          return;
        case "requestCheckpoints":
          void publishRewind();
          return;
        case "requestWorkflows":
          void publishWorkflows();
          return;
        case "runWorkflow":
          void startWorkflow(message.name, message.input);
          return;
        case "resumeWorkflow":
          void resumeWorkflow(message.runId, message.answer);
          return;
        case "rewindTo":
          void rewindTo(message.checkpointId, message.confirmation);
          return;
        case "abort":
          void withEngine((session) => session.controller?.abort());
          return;
        case "action":
          void runAction(message.id);
          return;
        case "toggle":
          engine?.controller?.toggle(message.blockId);
          return;
        case "command":
          void vscode.commands.executeCommand(WEBVIEW_COMMAND_TARGETS[message.command]);
          return;
        case "requestModels":
          void publishModels();
          return;
        case "requestSessions":
          void publishSessions();
          return;
        case "openSession":
          void openSession(message.sessionId);
          return;
        case "deleteSession":
          void deleteSession(message.sessionId);
          return;
        case "setModel":
          void withEngine((session) => switchModel(session, message.modelId));
          return;
        case "copy":
          // The clipboard, and nothing else. The text is a code block the user
          // is looking at, capped at the boundary; it reaches no engine verb.
          void vscode.env.clipboard.writeText(message.text);
          return;
        // `ready` is handled inside the provider, which replays state first.
        case "ready":
          return;
      }
    },
    onVisibility: (visible) => permissions.setVisible(visible),
    onDiagnostic: log,
  });

  /**
   * Where a permission request gets asked.
   *
   * RFC 0005 §2 used to say "native modals" and this is what replaced it: the
   * card goes in the panel's dock — a region the transcript never writes into
   * — and a native modal is kept as the strict fallback for a panel that
   * cannot be brought into view. `permission-surface.ts` holds the whole
   * argument, including why one live surface per request is not negotiable.
   *
   * Declared after `provider` and referenced from inside its handlers: both
   * closures run long after this line, and each genuinely needs the other.
   */
  const permissions = new PermissionSurface({
    reveal: () => provider.reveal(),
    postCard: (card) => provider.postPermissionAsk(card),
    askModal: (described) =>
      Promise.resolve(
        vscode.window.showWarningMessage(
          described.message,
          { modal: true, detail: described.detail },
          ...permissionChoices(described),
        ),
      ),
    onDiagnostic: log,
  });
  disposables.push({ dispose: () => permissions.dispose() });

  // Coalesced so a token-by-token stream repaints at frame rate, not per delta.
  const states = createCoalescer((state: ChatViewModel) => provider.postState(state));
  disposables.push({ dispose: () => states.dispose() });

  /**
   * The engine's catalog, projected for the panel and cached for this
   * connection.
   *
   * The panel's model list is the same catalog the palette quick-pick renders,
   * and it is fetched on the same terms: `listModels` is an optional verb, an
   * older engine answers `undefined`, and that is reported as *unavailable*
   * rather than as an empty catalog — "this server has no models" is not what
   * happened. Cached because the list is opened far more often than a server's
   * credentials change, and cleared whenever the connection is replaced.
   */
  let catalog: ModelOption[] | undefined;
  let catalogUnavailable = false;
  let catalogInFlight: Promise<void> | undefined;
  /**
   * The last `setModel` that the engine accepted.
   *
   * The event stream announces a model only when a run starts, so between a
   * switch and the next prompt the stream still names the old one. Without
   * this the chip would revert on the next repaint and tell the user their
   * switch did not take — which it did.
   */
  let selectedModel: string | undefined;

  /**
   * What the composer is holding, in insertion order, keyed by id.
   *
   * Held **here** rather than in the page for one reason: this is what `send`
   * actually attaches. A panel that kept its own list could show a chip the
   * next prompt did not carry, or carry one the user had removed — the exact
   * disagreement between what a user sees and what a model gets that RFC 0005
   * §1.1 exists to close. The page's chip row is a render of this map and
   * nothing else.
   *
   * Cleared with the connection and with the session: a path resolved against
   * one workspace means nothing in another.
   */
  let attached = new Map<string, ContextItem>();

  /**
   * The bytes behind a pasted-image chip, keyed by the chip's id.
   *
   * Held here and **not** sent to the page, which is the difference between a
   * chip row and a copy of the clipboard: the page is told a pasted image
   * exists and how big it is, and the megabytes stay on this side until
   * `prompt` carries them. RFC 0005 §1.1 blesses inline data for images and
   * only for images — a file that exists on disk is read by the engine from
   * its path, where the permission engine can see the read happen.
   */
  let pasted = new Map<string, { data: string; mimeType: string }>();
  let pastedCount = 0;

  /**
   * Tell the user, once, that this engine cannot take attachments.
   *
   * Once per connection rather than once per attempt: a drag that drops four
   * files must not stack four identical toasts, which is the toast storm
   * RFC 0004 §1 says the reconnect card exists to avoid.
   */
  let announcedNoContext = false;
  function announceNoContext(): void {
    log("sidebar: this arcturn engine cannot resolve context paths");
    if (announcedNoContext) return;
    announcedNoContext = true;
    void vscode.window.showWarningMessage(
      "This Arcturn engine is too old to attach files — upgrade the CLI to use @ mentions and attachments in the panel.",
    );
  }

  /**
   * The same announcement, one engine-generation later: `resolveContext` is
   * there, `kind: "fileReference"` is not.
   *
   * Kept separate from {@link announceNoContext} because the two are different
   * sentences and only one of them is true at a time. An engine without
   * `resolveContext` cannot attach *anything*; this one attaches everything it
   * always could and simply cannot be told a file is merely open — which is a
   * loss confined to the ambient chip, and the message says so rather than
   * telling somebody their `@` mentions are broken when they are not.
   *
   * Announced once, with `announceNoContext`'s flag lifetime and for a sharper
   * version of its reason: this one is reached from `refreshAmbient`, which
   * runs on every settled caret movement, so without the latch a scroll
   * through a file would be a toast storm.
   */
  let announcedNoReferences = false;
  function announceNoReferences(): void {
    log("sidebar: this arcturn engine cannot be told which file is open");
    if (announcedNoReferences) return;
    announcedNoReferences = true;
    void vscode.window.showWarningMessage(
      "This Arcturn engine is too old to be told which file you have open, so the panel is " +
        "not showing it — sending the whole file every message instead is not a trade it will " +
        "make for you. Upgrade the CLI, or use @ to attach the file when you want it.",
    );
  }

  /**
   * The chip the *editor* put there, as the engine last resolved it.
   *
   * Held apart from `attached` on purpose, and the separation is the feature.
   * `attached` is a set somebody assembled and expects to survive until they
   * change it: `clearContext` empties it after every send, and `detach` takes
   * one out. This is neither — it follows the caret, it is not cleared by
   * sending, and its dismiss control turns the watching off rather than
   * removing a chip that would reappear on the next keystroke.
   *
   * `undefined` until the engine has answered for the path. Deliberately no
   * "pending" state: a chip has to say what a file weighs and whether it can
   * be sent, both of which are the engine's to say, and a chip that appeared
   * first and acquired its facts afterwards would be showing a claim it had
   * not checked.
   */
  let ambientItem: ActiveEditorItem | undefined;

  /** Whether the panel is watching the editor at all. */
  function ambientEnabled(): boolean {
    return vscode.workspace.getConfiguration("arcturn").get<boolean>(ACTIVE_EDITOR_SETTING, true);
  }

  /**
   * The ambient chip, when there is one worth showing.
   *
   * Suppressed when an explicit chip already names the same file: one file is
   * one attachment, and two chips for it would make the row a summary rather
   * than the statement about what the next prompt carries that it is supposed
   * to be. See `ambientIsRedundant`.
   */
  function visibleAmbient(): ActiveEditorItem | undefined {
    if (ambientItem === undefined) return undefined;
    const paths = [...attached.values()].map((item) => item.path);
    return ambientIsRedundant(ambientItem.path, paths) ? undefined : ambientItem;
  }

  /** Push the chip row as it stands. */
  function publishContext(): void {
    provider.postContext([...attached.values()], visibleAmbient());
  }

  /** Forget every chip — a new session, or a new engine. */
  function clearContext(): void {
    if (attached.size === 0) return;
    attached = new Map();
    pasted = new Map();
    publishContext();
  }

  /**
   * Take a pasted or dropped image, which has no path.
   *
   * No `resolveContext` round trip, because there is nothing to resolve: the
   * bytes are already here and confinement has nothing to say about a
   * clipboard. The chip is therefore `ok` from the moment it appears — the
   * boundary has already checked the base64 and the mime type against the
   * engine's own allowlist, so the one thing this chip must not do (appear,
   * then be refused when the turn is sent) cannot happen.
   *
   * @param data - Base64, validated at the boundary.
   * @param mimeType - One of the engine's four image types.
   */
  function attachPastedImage(data: string, mimeType: string): void {
    pastedCount += 1;
    const id = `pasted:${String(pastedCount)}`;
    pasted.set(id, { data, mimeType });
    attached.set(id, {
      id,
      // No path, honestly: this image is not anywhere on disk, and inventing a
      // filename for it would make a chip claim a file the engine cannot read.
      path: "",
      label: `Pasted ${mimeType.replace("image/", "").toUpperCase()}`,
      // Base64 is 4 characters per 3 bytes, padding included.
      bytes: Math.floor((data.length * 3) / 4),
      kind: "image",
      ok: true,
    });
    publishContext();
  }

  /**
   * The native file dialog, and what it attaches.
   *
   * The dialog is the *host's* because a webview cannot read a path off a
   * `File`: a drop or an `<input type=file>` inside the page yields bytes with
   * no name the engine could resolve, and a picker that could not name what it
   * picked would attach nothing. Everything it returns goes through
   * `attachPaths`, so a file chosen here is resolved by the engine exactly like
   * one typed after an `@`.
   */
  async function browseForFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: "Attach",
      title: "Attach files to this Arcturn message",
      ...(vscode.workspace.workspaceFolders?.[0] === undefined
        ? {}
        : { defaultUri: vscode.workspace.workspaceFolders[0].uri }),
    });
    if (picked === undefined || picked.length === 0) return;
    await attachPaths(picked.map((uri) => uri.fsPath));
  }

  /**
   * Ask the engine what one query resolves to, and answer the picker.
   *
   * Never throws at the page: an engine too old for the verb resolves
   * `undefined` and the answer is an empty candidate list, which is what lets a
   * picker degrade to nothing rather than to a list of guesses.
   */
  async function resolveContext(query: string): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) {
        provider.postContextCandidates(query, []);
        return;
      }
      const items: ContextItem[] = [];
      for (const candidate of await candidatePaths(query)) {
        const resolution = await controller.resolveContext(candidate);
        if (resolution === undefined) {
          // The verb itself is missing. Reported as *unavailable* rather than
          // as an empty list, because "the workspace has no file like that"
          // and "this engine cannot answer" are two different sentences and
          // only one of them is true here. The picker closes on this.
          announceNoContext();
          provider.postContextCandidates(query, [], "unavailable");
          return;
        }
        items.push(projectContextItem(resolution));
      }
      provider.postContextCandidates(query, items);
    });
  }

  /**
   * What a query might mean, before the engine is asked about any of it.
   *
   * Two sources, in this order.
   *
   * The **query itself**, always, when the user typed one. That is what makes
   * `@../../etc/passwd` answerable: the file index will never offer a path
   * outside the workspace, and the engine's refusal — with its reason — is
   * exactly what the picker should show for one. It is also the path for a
   * file that exists but is excluded from search.
   *
   * Then **VS Code's own file index**, through `findFiles`. Using the editor's
   * index rather than walking the disk here is deliberate: it already respects
   * `files.exclude` and `search.exclude`, so a workspace that hides
   * `node_modules` hides it from this picker too, with no exclude list of this
   * extension's own to drift from the user's.
   *
   * Note what this is *not*: reading a file. RFC 0005 §3 forbids the panel
   * assembling context — "the panel never reads a file to build a prompt" —
   * and nothing here opens one. What comes back is a list of names, each of
   * which is then handed to `resolveContext` so that every size and every
   * refusal on screen is the engine's own answer.
   */
  async function candidatePaths(query: string): Promise<string[]> {
    const trimmed = query.trim();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) return trimmed === "" ? [] : [trimmed];
    let found: readonly vscode.Uri[] = [];
    try {
      found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, contextGlob(trimmed)),
        undefined,
        MAX_INDEX_MATCHES,
      );
    } catch (error) {
      // A failed search is not a reason to deny the picker the one candidate
      // the user actually typed.
      log(
        `sidebar: workspace search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const root = folder.uri.fsPath.replace(/[/\\]+$/, "");
    const relative = found.map((uri) =>
      uri.fsPath.startsWith(`${root}/`) || uri.fsPath.startsWith(`${root}\\`)
        ? uri.fsPath.slice(root.length + 1).replace(/\\/g, "/")
        : uri.fsPath,
    );
    const narrowed = narrowCandidates(relative);
    if (trimmed === "") return narrowed;
    return [trimmed, ...narrowed.filter((path) => path !== trimmed)].slice(
      0,
      narrowed.length === 0 ? 1 : narrowed.length,
    );
  }

  /**
   * Resolve and validate paths the page asked to attach, then post the chips.
   *
   * The engine resolves; this only records the answer. A path that comes back
   * unattachable is still added as a chip — with `ok: false` and the engine's
   * reason — because a drop that silently produced nothing is worse than a chip
   * that says why it cannot be sent, and because `send` filters on `ok` anyway.
   */
  async function attachPaths(paths: readonly string[]): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) return;
      for (const entry of paths) {
        const path = toWorkspacePath(entry);
        const resolution = await controller.resolveContext(path);
        if (resolution === undefined) {
          // A drop or a picked file that produced nothing at all is the worst
          // version of this failure: the user did something deliberate and the
          // panel looked broken. Said out loud, once.
          announceNoContext();
          return;
        }
        const item = projectContextItem(resolution);
        // Re-inserted rather than skipped when already present: attaching the
        // same path twice should refresh its size, not silently do nothing.
        attached.delete(item.id);
        attached.set(item.id, item);
      }
      publishContext();
    });
  }

  /**
   * Turn whatever a drop gave the page into something the engine can resolve.
   *
   * A drag from the VS Code explorer or from the OS puts `file:///…` URIs on
   * the dataTransfer, and the page forwards them verbatim — deliberately. A
   * URI is not a path: it is percent-encoded, it spells a Windows drive letter
   * with a leading slash, and a page doing that arithmetic itself would be
   * quietly wrong on one platform. `vscode.Uri` already does it correctly, and
   * it lives here.
   *
   * Anything that is not a `file:` URI is passed through untouched, which is
   * every path the `@` picker and the file dialog produce.
   */
  function toWorkspacePath(entry: string): string {
    if (!entry.toLowerCase().startsWith("file://")) return entry;
    try {
      const uri = vscode.Uri.parse(entry, true);
      return uri.scheme === "file" ? uri.fsPath : entry;
    } catch {
      // A malformed URI is not a path this extension should guess at; the
      // engine's own refusal, with its reason, is a better answer than one
      // invented here.
      return entry;
    }
  }

  /* ---- ambient awareness of the active editor ------------------------- */

  /**
   * The editor's event storm, coalesced into the handful of answers worth a
   * round trip.
   *
   * Built here rather than in `activate()` because everything it feeds — the
   * chip row, `resolveContext`, the attachment set — lives in this closure,
   * and because this whole module is already gated on `arcturn.serve.enabled`:
   * a window with the sidebar switched off has no panel to put a chip on and
   * should not be listening for one. Registering a listener costs nothing that
   * `01-activation.test.ts` measures — no process, no socket — and the handler
   * below is careful to keep it that way.
   */
  const ambientTracker = createAmbientTracker({
    onSettled: (editor) => void refreshAmbient(editor),
  });
  disposables.push({ dispose: () => ambientTracker.dispose() });

  /**
   * Ask the engine about the file the user is looking at, and publish the chip.
   *
   * Two rules, both of which are the reason this is not simply `attachPaths`
   * with a different source.
   *
   * **It never starts an engine.** `engine?.controller` rather than
   * `withEngine`: opening a file must not spawn `arcturn serve`, or RFC 0004
   * §3's activation budget would be spent by the act of using the editor. Until
   * the panel is open and connected there is simply no chip, and
   * `onConnection("ready")` calls this again.
   *
   * **The panel measures nothing.** The bytes, the kind and the refusal are all
   * the engine's answer to `resolveContext` — the same round trip the `@`
   * picker makes, so an ambient chip and an explicit one cannot report the same
   * file differently. RFC 0005 §3: the panel never reads a file.
   *
   * @param editor - What the tracker settled on, or `undefined` for "nothing".
   */
  async function refreshAmbient(editor: AmbientEditor | undefined): Promise<void> {
    /** Take the chip away, and repaint only if there was one. */
    function dropChip(): void {
      if (ambientItem === undefined) return;
      ambientItem = undefined;
      publishContext();
    }
    if (!ambientEnabled() || editor === undefined) {
      dropChip();
      return;
    }
    const controller = engine?.controller;
    if (controller === undefined) {
      // No connection yet — and no chip, rather than one with no size on it.
      // `onConnection("ready")` re-runs this the moment there is somebody to
      // ask; nothing is lost but a few hundred milliseconds during which the
      // composer is disabled anyway.
      dropChip();
      return;
    }
    let resolution: Awaited<ReturnType<typeof controller.resolveContext>>;
    try {
      resolution = await controller.resolveContext(editor.fsPath);
    } catch (error) {
      // A failed round trip is a diagnostic, never a chip: the alternative is
      // a warning tint on the file somebody is quietly reading, every time the
      // socket hiccups.
      log(
        `sidebar: could not resolve the active editor: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (resolution === undefined) {
      // This engine has no `resolveContext`, so it has no attachments either.
      // Said once per connection by `announceNoContext`, and no chip — a chip
      // whose file could never be sent is worse than none.
      announceNoContext();
      dropChip();
      return;
    }
    if (!engineKnowsReferences(resolution)) {
      // The same rule one engine-generation later, and it is the *existing*
      // rule rather than a new one: a chip whose file could never be sent is
      // worse than none. An open file with no selection travels as
      // `kind: "fileReference"`, which this engine's validator will refuse —
      // so the chip would be a promise the send cannot keep.
      //
      // The alternative this deliberately does not take is falling back to
      // `{ kind: "file" }`. That is the bug: ~22,600 tokens a turn for
      // `packages/protocol/src/client.ts`, ~81,200 for `workflow.ts`, for a
      // file nobody asked for. Sending everything because the engine is old is
      // not an acceptable substitute for sending a path, and `@` is still
      // right there for anybody who does want the file.
      announceNoReferences();
      dropChip();
      return;
    }
    // A late answer must not overwrite a newer one. Compared whole rather than
    // by path: two resolves for the same file with different selections can be
    // in flight at once, and the slower one landing last would put a range on
    // the chip that the user has already moved off.
    if (!sameAmbient(ambientTracker.current(), editor)) return;
    ambientItem = projectActiveEditorItem(resolution, editor.selection);
    publishContext();
  }

  /** Re-ask about whatever is being watched — a new connection, a new session. */
  function refreshAmbientNow(): void {
    void refreshAmbient(ambientTracker.current());
  }

  /**
   * Turn the watching off (or back on) and make the panel agree immediately.
   *
   * Written to the scope the user already chose. A setting somebody set for
   * this workspace is updated *there*; anything else goes to their user
   * settings, because "do not watch my editor" is a preference about how they
   * work rather than about one repository. Guessing wrong here is not a
   * cosmetic error — it writes a value that an existing narrower scope
   * overrides, and the control then visibly does nothing.
   */
  async function setAmbientEnabled(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("arcturn");
    const scoped = config.inspect<boolean>(ACTIVE_EDITOR_SETTING);
    const target =
      scoped?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : scoped?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    try {
      await config.update(ACTIVE_EDITOR_SETTING, enabled, target);
    } catch (error) {
      log(
        `sidebar: could not write ${ACTIVE_EDITOR_SETTING}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // `onDidChangeConfiguration` will fire for this too, and both paths are
    // idempotent — the chip is either there or it is not.
    applyAmbientSetting();
  }

  /** Bring the chip into line with the setting, in both directions. */
  function applyAmbientSetting(): void {
    if (!ambientEnabled()) {
      ambientTracker.clear();
      return;
    }
    // Turning it back on should not require the user to click into a file
    // again: the editor they are looking at is already there to be read.
    ambientTracker.observe(vscode.window.activeTextEditor as TextEditorLike | undefined);
    refreshAmbientNow();
  }

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!ambientEnabled()) return;
      ambientTracker.observe(editor as TextEditorLike | undefined);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!ambientEnabled()) return;
      // Only the editor that is actually active: VS Code fires this for every
      // visible editor, including the other half of a split the user is not in.
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      ambientTracker.observe(event.textEditor as TextEditorLike);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      ambientTracker.closed(document.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`arcturn.${ACTIVE_EDITOR_SETTING}`)) return;
      applyAmbientSetting();
    }),
  );

  // Seed from whatever is already on screen. Without this, a window restored
  // with a file open and never switched away from fires no editor event at
  // all, and the panel would sit next to that file knowing nothing about it
  // until the user clicked a different tab. Costs a comparison and a timer:
  // there is no engine to ask yet, so `refreshAmbient` records the file and
  // stops, and `onConnection("ready")` is what turns it into a chip.
  applyAmbientSetting();

  /**
   * The attachments to send with the next prompt.
   *
   * Only the chips that actually resolved. An unattachable one is *shown* so
   * the user can see why, and dropped here so the engine is not asked to refuse
   * something the panel already knows it will refuse — the turn would fail as a
   * whole, taking the user's text with it.
   */
  function pendingAttachments(): PromptAttachment[] {
    const items: PromptAttachment[] = [];
    // The file the user is looking at goes first, because it is the one their
    // sentence is most likely about. Only when it is on screen: `visibleAmbient`
    // is what the chip row rendered, so nothing can be attached here that was
    // not visible before send — and nothing visible is silently left off.
    // Which of the three spellings an open file takes — an excerpt, a name, or
    // an image — is `ambientAttachment`'s decision, and it is exported so it
    // can be driven without a live engine. It is the load-bearing choice in
    // this whole feature: getting it wrong is what put ~22k tokens of
    // `client.ts` (~81k of `workflow.ts`) in front of the model on every turn.
    const ambient = visibleAmbient();
    const ambientAttached = ambient === undefined ? undefined : ambientAttachment(ambient);
    if (ambientAttached !== undefined) items.push(ambientAttached);
    for (const item of attached.values()) {
      if (!item.ok) continue;
      const bytes = pasted.get(item.id);
      if (bytes !== undefined) {
        items.push({ kind: "image", data: bytes.data, mimeType: bytes.mimeType });
        continue;
      }
      items.push(
        item.kind === "image"
          ? { kind: "image", path: item.path }
          : {
              kind: "file",
              path: item.path,
            },
      );
    }
    return items;
  }

  /**
   * The session's permission regime, cached for this session.
   *
   * `undefined` mode with `unavailable` status is an engine older than
   * `permissionState`, and the two are kept apart on purpose: "I have not
   * asked yet" and "this engine cannot tell me" produce different chips, and
   * neither of them produces a chip that says `default`. Cleared with the
   * connection and with the session, because both change the answer.
   */
  let permission: { mode?: string; tools: string[] } | undefined;
  let permissionUnavailable = false;
  let permissionInFlight: Promise<void> | undefined;

  function permissionStatus(): PermissionStateStatus {
    if (permissionUnavailable) return "unavailable";
    return permission === undefined ? "loading" : "ready";
  }

  /**
   * Post the mode chip and the capability line as they stand, fetching them
   * first when they are not known yet.
   *
   * @param note - Why the last mode change did not take, when it did not.
   *   Carried on the same message as the mode so the chip snaps back to what
   *   is actually in force in the same paint that explains why.
   */
  async function publishPermission(note?: string): Promise<void> {
    const status = permissionStatus();
    provider.postPermission({
      status,
      ...(permission?.mode === undefined ? {} : { mode: permission.mode }),
      tools: permission?.tools ?? [],
      ...(note === undefined ? {} : { note }),
    });
    if (status !== "loading") return;
    if (engine === undefined || engine.status !== "ready") return;
    permissionInFlight ??= fetchPermission().finally(() => {
      permissionInFlight = undefined;
    });
    await permissionInFlight;
  }

  async function fetchPermission(): Promise<void> {
    try {
      const state = await ensureEngine().controller?.permissionState();
      if (state === undefined) {
        // Either no controller or no verb. Both mean the panel does not know
        // the mode, and the chip says exactly that rather than picking one.
        permissionUnavailable = true;
        permission = { tools: [] };
      } else {
        permissionUnavailable = false;
        permission = { mode: state.mode, tools: [...state.tools] };
      }
    } catch (error) {
      log(
        `sidebar: permission state unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      permissionUnavailable = true;
      permission = { tools: [] };
    }
    await publishPermission();
  }

  /**
   * Change the session's permission mode, and say what actually happened.
   *
   * Three outcomes, three different sentences, and not one of them is silence.
   * The engine's *own* answer sets the chip — a mode is a request, and the
   * state that comes back is the mode in force — so a `yolo` that a deny rule
   * outranks still shows what the engine says it is.
   *
   * A refusal never moves the chip. `setPermissionMode` deliberately rejects
   * rather than degrading against an older engine (see `ProtocolClient`), and
   * that rejection is repeated to the user verbatim in its own words: a panel
   * that showed `plan` over a session still in `yolo` would have told somebody
   * the agent will not write, right before it writes.
   */
  async function applyPermissionMode(mode: PermissionMode): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) return;
      try {
        const state = await controller.setPermissionMode(mode);
        permissionUnavailable = false;
        permission = { mode: state.mode, tools: [...state.tools] };
        await publishPermission();
      } catch (error) {
        const note = permissionRefusal(error);
        log(`sidebar: could not switch to ${mode} mode: ${note}`);
        await publishPermission(note);
      }
    });
  }

  /**
   * The failure the chip prints, in the words a user can act on.
   *
   * `sessionBusy` and "too old" are the two the engine raises by design, and
   * both are actionable; anything else is quoted rather than paraphrased.
   */
  function permissionRefusal(error: unknown): string {
    if (isUnsupportedMethodError(error)) {
      return "This engine is too old to change permission modes — upgrade the Arcturn CLI.";
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (/sessionBusy/i.test(reason) || /run is in flight/i.test(reason)) {
      return "A run is in flight. Stop it, or wait for it to finish, and try again.";
    }
    return `The engine refused: ${escapeCodicons(reason)}`;
  }

  /**
   * What a `/` could invoke here, cached for this connection.
   *
   * The same shape as the model catalog, for the same reasons: skills are
   * files that change far less often than the menu is opened, and "this engine
   * cannot tell me" is reported as itself rather than as an empty list of
   * skills.
   */
  let commands: CommandOption[] | undefined;
  let commandsUnavailable = false;
  let commandsInFlight: Promise<void> | undefined;

  async function publishCommands(): Promise<void> {
    const status: CommandListStatus = commandsUnavailable
      ? "unavailable"
      : commands === undefined
        ? "loading"
        : "ready";
    provider.postCommands({ status, commands: commands ?? [] });
    if (status !== "loading") return;
    if (engine === undefined || engine.status !== "ready") return;
    commandsInFlight ??= fetchCommands().finally(() => {
      commandsInFlight = undefined;
    });
    await commandsInFlight;
  }

  async function fetchCommands(): Promise<void> {
    try {
      const listed = await ensureEngine().listCommands();
      if (listed === undefined) {
        commandsUnavailable = true;
        commands = [];
      } else {
        commandsUnavailable = false;
        commands = listed.map(projectCommandOption);
      }
    } catch (error) {
      log(
        `sidebar: command list unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      commandsUnavailable = true;
      commands = [];
    }
    await publishCommands();
  }

  /**
   * What the dry run is holding back, cached for this session.
   *
   * The same shape the permission state has, and cleared on the same two
   * events: a new connection may be a different engine (dry run on or off),
   * and a new session is a new conversation whose pending set is not the last
   * one's. A card carried across either would be offering to apply changes the
   * engine is not holding.
   */
  let dryRun: DryRunView | undefined;
  let dryRunInFlight: Promise<void> | undefined;

  /**
   * The pending content the diff editor is rendering, keyed by the engine's
   * own path.
   *
   * Held here rather than fetched by the content provider, because a provider
   * is called synchronously-ish on a URI VS Code decides to open (including on
   * a window reload) and cannot itself do a protocol round trip with an engine
   * that may be gone. So `showDiff` fetches first and opens second, and this is
   * the handoff between the two.
   *
   * Cleared with the session for the reason the view is: content from one
   * conversation's shadow tree is not the next one's.
   */
  const pendingContent = new Map<string, string>();

  /**
   * Serve the right-hand side of the diff.
   *
   * The extension reads nothing of the engine's — not the shadow file, not the
   * overlay directory (RFC 0004 §0). What the editor renders is exactly the
   * bytes `pendingChanges` put on the wire, which is also exactly the bytes
   * `applyChanges` will write. A provider that read the shadow tree off disk
   * would be a second source for the same content, and the first time they
   * disagreed a reviewer would approve something they had not seen.
   */
  const dryRunContentChanged = new vscode.EventEmitter<vscode.Uri>();
  const dryRunContentProvider: vscode.TextDocumentContentProvider = {
    onDidChange: dryRunContentChanged.event,
    provideTextDocumentContent(uri) {
      return pendingContent.get(uri.query) ?? "";
    },
  };
  disposables.push(
    dryRunContentChanged,
    vscode.workspace.registerTextDocumentContentProvider(DRY_RUN_SCHEME, dryRunContentProvider),
  );

  /** The virtual document holding one change's pending content. */
  function pendingUri(row: PendingChangeRow): vscode.Uri {
    return vscode.Uri.from({
      scheme: DRY_RUN_SCHEME,
      // The basename is the real file's, so the tab reads right and the
      // language mode is the one the file would get. The engine's path is the
      // query, which is what the provider keys on and what never shows in a tab.
      path: pendingDocumentPath(row.path),
      query: row.path,
    });
  }

  /** Post the review card as it stands, fetching it first when it is not known. */
  async function publishDryRun(note?: string): Promise<void> {
    const view = dryRun ?? { status: "loading" as const, changes: [], truncated: false };
    provider.postDryRun({ ...view, ...(note === undefined ? {} : { note }) });
    if (view.status !== "loading") return;
    if (engine === undefined || engine.status !== "ready") return;
    dryRunInFlight ??= fetchDryRun().finally(() => {
      dryRunInFlight = undefined;
    });
    await dryRunInFlight;
  }

  async function fetchDryRun(): Promise<void> {
    try {
      // `undefined` is an engine with no such verb — or no controller at all,
      // which is the same outcome for this card and the same conflation
      // `fetchPermission` makes: either way the panel does not know, so it
      // offers no review affordance. `dryRun: false` is the third case, an
      // engine that has the verb and is holding nothing back. `toDryRunView`
      // is the one place all three are told apart, so the panel cannot show
      // the reassuring story for one of the others.
      dryRun = toDryRunView(await ensureEngine().controller?.pendingChanges());
    } catch (error) {
      log(
        `sidebar: pending changes unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      dryRun = { status: "unavailable", changes: [], truncated: false };
    }
    await publishDryRun();
  }

  /** Forget the review card. A new engine, or a new session. */
  function clearDryRun(): void {
    dryRun = undefined;
    pendingContent.clear();
  }

  /* ---- workflows ------------------------------------------------------ */

  /**
   * The workflow catalog, as the engine last reported it.
   *
   * Cleared on a new connection for the reason the command list is: a new
   * engine is a different build with a different workspace, and a catalog
   * carried across would offer to run a pipeline this engine has never heard
   * of. `catalogUnavailable` is the third state — an engine with no
   * `listWorkflows` at all — kept apart from an empty catalog because "this
   * workspace defines no pipelines" and "this engine cannot tell me" are not
   * the same news.
   */
  let workflowCatalog: WorkflowOption[] | undefined;
  let workflowsUnavailable = false;
  /**
   * The run this panel is following, and the ceiling the engine said is in
   * force for it.
   *
   * The ceiling is remembered from the run *handle* rather than re-derived
   * from the catalog, and that is the whole point of the handle echoing it: a
   * run started with a lowered budget is bounded by the lowered one, and a
   * card that showed the file's number would be showing a ceiling nobody is
   * enforcing.
   */
  let workflowRun: { runId: string; budgetUsd?: number } | undefined;
  let workflowRunRow: WorkflowRunRow | undefined;
  let workflowRefreshQueued = false;

  /** Post the workflow surface as it stands, fetching the catalog if needed. */
  async function publishWorkflows(note?: string): Promise<void> {
    const view: WorkflowView = {
      ...EMPTY_WORKFLOW_VIEW,
      status: workflowsUnavailable ? "unavailable" : workflowCatalog ? "ready" : "loading",
      workflows: workflowCatalog ?? [],
      ...(workflowRunRow === undefined ? {} : { run: workflowRunRow }),
      ...(note === undefined ? {} : { note }),
    };
    provider.postWorkflows(view);
    if (view.status !== "loading") return;
    if (engine === undefined || engine.status !== "ready") return;
    await fetchWorkflows();
  }

  async function fetchWorkflows(): Promise<void> {
    try {
      // `undefined` is an engine with no such verb — or no controller at all,
      // which is the same outcome for this surface and the same conflation
      // `fetchDryRun` makes: either way the panel does not know what this
      // engine can run, so it offers no catalog rather than an empty one.
      const catalog = await ensureEngine().controller?.listWorkflows();
      if (catalog === undefined) {
        workflowsUnavailable = true;
        workflowCatalog = undefined;
      } else {
        workflowsUnavailable = false;
        workflowCatalog = catalog.workflows.map(projectWorkflow);
      }
    } catch (error) {
      log(
        `sidebar: workflows unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      workflowsUnavailable = true;
      workflowCatalog = undefined;
    }
    await publishWorkflows();
  }

  /**
   * Forget the run this panel was following, keeping the catalog.
   *
   * A session switch, in either direction. The catalog is the *engine's* and is
   * still true; the run is the *session's*, and a card carried across would be
   * showing a pipeline whose notices this panel no longer receives, with an
   * Answer button pointed at a session the user has left. The run itself is
   * unaffected — it keeps going, and `workflowStatus` still finds it, which is
   * the whole reason that verb is not session-scoped.
   */
  function forgetWorkflowRun(): void {
    workflowRun = undefined;
    workflowRunRow = undefined;
  }

  /** Forget the whole workflow surface. A new engine. */
  function clearWorkflows(): void {
    workflowCatalog = undefined;
    workflowsUnavailable = false;
    forgetWorkflowRun();
  }

  /**
   * Start a pipeline, after a native modal that says what it will do.
   *
   * The confirmation is here rather than in the page because a webview button
   * that says "are you sure" is a button, not a confirmation — `dialog.ts`'s
   * rule for `deleteSession` and `dry-run.ts`'s for `discardChanges`, applied
   * to the one control on this surface that spends money *and* can rewrite a
   * checkout. What the modal names is the spend ceiling and every role that can
   * act, because neither is inferable from a pipeline's name.
   *
   * No budget is sent. The engine accepts one only to *lower* the file's own
   * ceiling, and a number typed into a webview is not a decision a person made
   * about money; the file's ceiling is what the modal quotes and what the
   * engine enforces.
   */
  async function startWorkflow(name: string, input?: string): Promise<void> {
    if (workflowCatalog === undefined) await fetchWorkflows();
    const workflow = workflowCatalog?.find((candidate) => candidate.name === name);
    if (workflow === undefined) {
      await publishWorkflows(`No workflow named "${escapeCodicons(name)}" on this engine.`);
      return;
    }
    const { message, detail } = runConfirmation(workflow);
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      RUN_WORKFLOW,
    );
    if (choice !== RUN_WORKFLOW) return;

    try {
      const controller = ensureEngine().controller;
      if (controller === undefined) {
        await publishWorkflows("Not connected to an engine.");
        return;
      }
      const handle = await controller.runWorkflow(workflow.name, input);
      workflowRun = {
        runId: handle.runId,
        ...(handle.budgetUsd === undefined ? {} : { budgetUsd: handle.budgetUsd }),
      };
      // A run that has only just been accepted has journalled a header and
      // nothing else, so the card is seeded from the handle and then corrected
      // by the journal on the first refresh. Seeding from the *handle* rather
      // than from the catalog is what makes the ceiling right for a run whose
      // budget was lowered.
      workflowRunRow = {
        runId: handle.runId,
        workflow: workflow.label,
        state: "running",
        stageCount: handle.stages,
        stepsDone: 0,
        stepsTotal: handle.steps,
        questions: [],
        ...(handle.budgetUsd === undefined ? {} : { budgetUsd: handle.budgetUsd }),
      };
      await publishWorkflows();
      await refreshWorkflowRun();
    } catch (error) {
      await publishWorkflows(workflowRefusal(error, "run"));
    }
  }

  /**
   * Re-enter a paused run with the person's answer.
   *
   * Forwarded verbatim — this panel never summarises a question and never
   * answers one. A resume with no answer asks the engine to re-surface the
   * question, which is what the terminal's bare `/workflow resume` does; the
   * engine refuses that as "needs an answer, not a nudge" and the sentence
   * lands on the card.
   */
  async function resumeWorkflow(runId: string, answer?: string): Promise<void> {
    try {
      const controller = ensureEngine().controller;
      if (controller === undefined) {
        await publishWorkflows("Not connected to an engine.");
        return;
      }
      const handle = await controller.resumeWorkflow(runId, answer);
      workflowRun = {
        runId: handle.runId,
        ...(handle.budgetUsd === undefined ? {} : { budgetUsd: handle.budgetUsd }),
      };
      await refreshWorkflowRun();
    } catch (error) {
      await publishWorkflows(workflowRefusal(error, "resume"));
    }
  }

  /**
   * Re-read the run journal and repaint.
   *
   * **The journal, not the narration.** A run publishes its progress as
   * `notice` events on the session stream — which is what the transcript
   * renders, and what tells this panel that something moved — but the numbers
   * on the card come from `workflowStatus`, which folds the same append-only
   * record `/workflow status` prints. A card that counted the notices would
   * drift the first time a resumed run replayed a finished step instead of
   * executing it.
   */
  async function refreshWorkflowRun(): Promise<void> {
    const following = workflowRun;
    if (following === undefined) return;
    try {
      const answer = await ensureEngine().controller?.workflowStatus(following.runId);
      const row = answer?.runs[0];
      // Zero rows is a run this engine has no journal for — it was pruned, or
      // the engine was replaced. The card stops following rather than showing
      // a run nobody can resume.
      if (row === undefined) {
        if (answer !== undefined) {
          workflowRun = undefined;
          workflowRunRow = undefined;
        }
      } else {
        workflowRunRow = projectWorkflowRun(row, following.budgetUsd);
        // A settled run stops being followed, so a later notice from an
        // ordinary turn does not keep polling a journal that will not change.
        if (!isRunLive(row.state) && row.questions.length === 0) workflowRun = undefined;
      }
    } catch (error) {
      log(
        `sidebar: workflow status unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await publishWorkflows();
  }

  /**
   * A notice arrived; the journal has probably moved.
   *
   * Coalesced to one refresh in flight plus at most one queued, so a stage that
   * publishes six notices in a burst costs two round trips rather than six.
   * This is the whole of "how a client follows a run": the session's own event
   * stream says *when*, and the run journal says *what* — no second channel,
   * and no timer that keeps polling a panel nobody is looking at.
   */
  function onWorkflowTick(): void {
    if (workflowRun === undefined || workflowRefreshQueued) return;
    workflowRefreshQueued = true;
    void Promise.resolve().then(async () => {
      workflowRefreshQueued = false;
      await refreshWorkflowRun();
    });
  }

  /** The failure the card prints, in words a user can act on. */
  function workflowRefusal(error: unknown, verb: string): string {
    if (isUnsupportedMethodError(error)) {
      return `This engine is too old to ${verb} workflows — upgrade the Arcturn CLI.`;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (/sessionBusy/i.test(reason) || /running a (turn|workflow)/i.test(reason)) {
      return `This session is busy. Stop what it is doing, or wait, and ${verb} then.`;
    }
    // The engine's own sentence, quoted rather than paraphrased: a budget
    // refusal already names both figures and a missing workflow already names
    // the ones this engine has, and rewriting either would lose the number the
    // user needs.
    return `The engine refused: ${escapeCodicons(reason)}`;
  }

  /** The rows the card is currently showing, or `[]` when it is showing none. */
  function pendingRows(): PendingChangeRow[] {
    return dryRun?.status === "ready" ? dryRun.changes : [];
  }

  /**
   * Open a pending change in **VS Code's own diff editor**.
   *
   * The left-hand side is the workspace file itself, not a snapshot the engine
   * sent: `applyChanges` writes the pending content over the real file whole,
   * and `bash` is unwrapped under dry run, so "what will this file become" is a
   * question about the file as it stands right now. A `file:` URI answers it
   * and keeps answering it while the editor is open.
   *
   * The right-hand side is the engine's own bytes, served read-only through
   * {@link dryRunContentProvider}. Rendering a patch in the webview instead
   * would throw away the one thing an editor brings to this loop.
   *
   * @param path - One change's path. Omitted with several pending, the user
   *   picks; omitted with one, that one opens.
   */
  async function showDiff(path?: string): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) return;
      // Refreshed first: a card the user has been looking at for ten minutes
      // may be describing a change set the agent has since added to.
      await refreshDryRun();
      if (dryRun?.status === "off") {
        void vscode.window.showInformationMessage(
          "Arcturn is not running under --dry-run, so edits go straight to the workspace. There is nothing to review.",
        );
        return;
      }
      if (dryRun?.status === "unavailable") {
        void vscode.window.showWarningMessage(
          "This Arcturn engine is too old to review dry-run changes — upgrade the CLI.",
        );
        return;
      }
      const rows = pendingRows();
      if (rows.length === 0) {
        void vscode.window.showInformationMessage("Arcturn has no pending changes to review.");
        return;
      }
      const chosen = await pickRow(rows, path);
      if (chosen === undefined) return;

      const detail = await controller.pendingChanges(chosen.path);
      const change = detail?.changes[0];
      if (change === undefined) {
        void vscode.window.showWarningMessage(
          `Arcturn is no longer holding a change for ${chosen.label}.`,
        );
        await refreshDryRun();
        return;
      }
      if (change.contentOmitted === true || change.after === undefined) {
        // Withheld rather than truncated by the engine, and repeated as
        // withheld here: half a file in a diff editor is a false account of
        // the change, and a reviewer would approve it.
        void vscode.window.showWarningMessage(
          `${chosen.label} is too large for Arcturn to send for review. Apply or discard it without a preview, or review it in a terminal with /diff.`,
        );
        return;
      }
      pendingContent.set(chosen.path, change.after);
      const right = pendingUri(chosen);
      // A `provideTextDocumentContent` result is cached per URI, so a second
      // review of the same file after another turn would show the first
      // answer without this.
      dryRunContentChanged.fire(right);
      await vscode.commands.executeCommand(
        "vscode.diff",
        chosen.kind === "added"
          ? // Nothing to diff against: an added file's left-hand side is an
            // empty document rather than a `file:` URI VS Code cannot open.
            vscode.Uri.from({ scheme: DRY_RUN_SCHEME, path: "/(new file)", query: "" })
          : vscode.Uri.file(chosen.absolutePath),
        right,
        diffTitle(chosen),
        { preview: true },
      );
    });
  }

  /** Which change to open: the one named, the only one, or the one picked. */
  async function pickRow(
    rows: readonly PendingChangeRow[],
    path: string | undefined,
  ): Promise<PendingChangeRow | undefined> {
    if (path !== undefined) return rows.find((row) => row.path === path);
    if (rows.length === 1) return rows[0];
    const picked = await vscode.window.showQuickPick(
      rows.map((row) => ({ label: row.label, description: row.detail, row })),
      { title: "Arcturn pending changes", placeHolder: "Review a pending change" },
    );
    return picked?.row;
  }

  /**
   * Land pending changes on the user's real files.
   *
   * The **engine** writes them. This extension never copies a shadow file over
   * a workspace file (RFC 0004 §0, and RFC 0005 §3's rule pointed the other
   * way): an apply the extension performed is an apply that no permission
   * engine, no workspace confinement and no symlink guard ever saw, and that
   * is precisely the guarantee dry run exists to provide.
   *
   * No confirmation modal. Apply is the *safe* half of this pair — it does what
   * the reviewer has just been reading, and it is undoable in the editor and in
   * source control. The modal is on discard, where the work is gone.
   *
   * A per-file failure is reported and the rest still land, which is what
   * `/apply` does in the terminal.
   */
  async function applyChanges(paths?: readonly string[]): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) return;
      try {
        const result = await controller.applyChanges(paths);
        for (const failure of result.failed) {
          log(`sidebar: could not apply ${failure.path}: ${failure.message}`);
        }
        if (result.failed.length > 0) {
          void vscode.window.showWarningMessage(
            `Arcturn applied ${String(result.applied.length)} file(s); ${String(result.failed.length)} failed and are still pending. ${escapeCodicons(result.failed[0]?.message ?? "")}`,
          );
        }
        await refreshDryRun();
      } catch (error) {
        const note = dryRunRefusal(error, "apply");
        log(`sidebar: could not apply pending changes: ${note}`);
        await publishDryRun(note);
      }
    });
  }

  /**
   * Throw pending changes away, after asking.
   *
   * Two things are deliberate, and both are `deleteSession`'s discipline
   * applied to the other irreversible control on this surface. The
   * confirmation is a **native modal naming the files**, not a webview button
   * and not a toast: the shadow tree is the only copy of that work, and a
   * stray click must not be able to lose an afternoon of it. And the deletion
   * is the engine's `discardChanges` verb — the extension never unlinks
   * anything, which is also the only version that can refuse mid-run.
   */
  async function discardChanges(): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) return;
      // Refreshed first so the modal names what is actually pending now, not
      // what the card was showing when the user last looked at it.
      await refreshDryRun();
      const rows = pendingRows();
      if (rows.length === 0) {
        void vscode.window.showInformationMessage("Arcturn has no pending changes to discard.");
        return;
      }
      const prompt = describeDiscard(rows);
      const choice = await vscode.window.showWarningMessage(
        prompt.message,
        { modal: true, detail: prompt.detail },
        prompt.confirmLabel,
      );
      if (!confirmsDiscard(choice, prompt)) {
        // The card was repainted by the refresh above; repaint it again so the
        // buttons the page disabled on click come back.
        await publishDryRun();
        return;
      }
      try {
        await controller.discardChanges();
        await refreshDryRun();
      } catch (error) {
        const note = dryRunRefusal(error, "discard");
        log(`sidebar: could not discard pending changes: ${note}`);
        await publishDryRun(note);
      }
    });
  }

  /* ---- rewind --------------------------------------------------------- */

  /**
   * The turns this session could be rewound to, cached for this session.
   *
   * The same shape the review card has, and cleared on the same two events: a
   * new connection may be a different engine, and a new session has its own
   * checkpoints. A picker carried across either would be offering to restore
   * files from a conversation nobody is in.
   */
  let rewind: RewindView | undefined;
  let rewindInFlight: Promise<void> | undefined;

  /** Post the picker as it stands, fetching it first when it is not known. */
  async function publishRewind(note?: string): Promise<void> {
    const view = rewind ?? { status: "loading" as const, checkpoints: [], truncated: false };
    provider.postRewind({ ...view, ...(note === undefined ? {} : { note }) });
    if (view.status !== "loading") return;
    if (engine === undefined || engine.status !== "ready") return;
    rewindInFlight ??= fetchRewind().finally(() => {
      rewindInFlight = undefined;
    });
    await rewindInFlight;
  }

  async function fetchRewind(): Promise<void> {
    try {
      // `undefined` is an engine with no such verb — or no controller at all,
      // the same conflation `fetchDryRun` makes and for the same reason:
      // either way this panel cannot rewind, so it offers no affordance.
      // `available: false` is the third case, an engine that has the verb and
      // keeps no checkpoints. `toRewindView` is the one place all three are
      // told apart.
      rewind = toRewindView(await ensureEngine().controller?.listCheckpoints());
    } catch (error) {
      log(
        `sidebar: checkpoints unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      rewind = { status: "unavailable", checkpoints: [], truncated: false };
    }
    await publishRewind();
  }

  /** Re-read the checkpoints and repaint, in one paint. See {@link refreshDryRun}. */
  async function refreshRewind(): Promise<void> {
    if (engine === undefined || engine.status !== "ready") {
      rewind = undefined;
      await publishRewind();
      return;
    }
    rewind = undefined;
    await fetchRewind();
  }

  /** The rows the picker is currently showing. */
  function checkpointRows(): CheckpointRow[] {
    return rewind?.status === "ready" ? rewind.checkpoints : [];
  }

  /**
   * Restore files to a checkpoint and fork the conversation, after asking.
   *
   * Three things are deliberate, and all three are the discipline
   * `deleteSession` and `discardChanges` already keep, applied to the control
   * that has more to lose than either.
   *
   * **The list is re-read first**, so the modal names what rewinding would do
   * *now* rather than what the picker was showing when the user last looked.
   * That also means the `confirmation` sent is the current one — and if the
   * cost has moved, the engine refuses rather than rewinding to something
   * nobody saw.
   *
   * **The confirmation is a native modal naming the files.** Not a webview
   * button and not a toast: this overwrites files and deletes files, and a
   * stray click in a list must not be able to do that.
   *
   * **The restore is the engine's `rewindTo` verb.** This extension never
   * writes a workspace file and never unlinks one (RFC 0004 §0), which is also
   * the only version that inherits the engine's workspace confinement and its
   * mid-run refusal.
   *
   * Afterwards the panel **re-opens the session**, which re-fetches
   * `sessionHistory` and rebuilds the transcript from it. There is no second
   * transcript path and this does not invent one: the replay is what the panel
   * already does for every session switch, pointed at the branch the engine is
   * now on.
   */
  async function rewindTo(checkpointId: string, confirmation: string): Promise<void> {
    await withEngine(async (session) => {
      const controller = session.controller;
      if (controller === undefined) return;
      await refreshRewind();
      const row = checkpointRows().find((candidate) => candidate.id === checkpointId);
      if (row === undefined) {
        await publishRewind("That turn is no longer listed. The list below is the current one.");
        return;
      }
      if (row.confirmation !== confirmation) {
        // The page clicked a row costing one thing and the engine now says it
        // costs another — a turn ran in between. The engine would refuse this
        // too, and that refusal is the guarantee; catching it here just means
        // the user is not shown a modal describing a set they never chose from.
        await publishRewind(
          "That turn changed while the list was open — a run has happened since. The costs below are the current ones.",
        );
        return;
      }
      const prompt = describeRewind(row);
      const choice = await vscode.window.showWarningMessage(
        prompt.message,
        { modal: true, detail: prompt.detail },
        prompt.confirmLabel,
      );
      if (!confirmsRewind(choice, prompt)) return;

      let result: Awaited<ReturnType<typeof controller.rewindTo>>;
      try {
        // The row's own confirmation — identical to the page's by the check
        // above, and this is the copy that came from the engine on this
        // refresh, so nothing the page holds becomes an argument.
        result = await controller.rewindTo(row.id, row.confirmation);
      } catch (error) {
        const note = rewindRefusal(error);
        log(`sidebar: could not rewind to ${checkpointId}: ${note}`);
        await publishRewind(note);
        return;
      }

      for (const failure of result.failed) {
        log(`sidebar: could not restore ${failure.path}: ${failure.message}`);
      }
      if (result.failed.length > 0) {
        void vscode.window.showWarningMessage(
          `Arcturn restored ${String(result.restored.length)} file(s) and deleted ${String(result.deleted.length)}; ${String(result.failed.length)} could not be touched. ${escapeCodicons(result.failed[0]?.message ?? "")}`,
        );
      }
      if (!result.conversationForked) {
        // The engine restored the files and said the transcript could not
        // move. Saying so is the whole point: the conversation on screen now
        // describes work that is no longer on disk.
        void vscode.window.showInformationMessage(
          "Arcturn restored the files, but could not fork the conversation to match — the transcript above still describes work that is no longer on disk.",
        );
      }
      // The fork reaches the panel through `sessionHistory`, which is what
      // re-opening the session does — no second transcript path.
      await openSession(controller.sessionId);
      await refreshRewind();
    });
  }

  /**
   * The failure the picker prints, in words a user can act on.
   *
   * The three the engine raises by design are all actionable, and the stale
   * confirmation is quoted rather than paraphrased because the engine's own
   * sentence already says what to do about it.
   */
  function rewindRefusal(error: unknown): string {
    if (isUnsupportedMethodError(error)) {
      return "This Arcturn engine is too old to rewind — upgrade the Arcturn CLI.";
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (/sessionBusy/i.test(reason) || /running a turn/i.test(reason)) {
      return "A run is in flight. Stop it, or wait for it to finish, and rewind then.";
    }
    return `The engine refused: ${escapeCodicons(reason)}`;
  }

  /**
   * Re-read the pending set and repaint, in one paint.
   *
   * Deliberately not `clearDryRun()` followed by `publishDryRun()`: that posts
   * a `loading` view first, which the page renders as *no card*, so every
   * Review click would blink the card out and back. The fetch publishes once,
   * at the end, with the answer.
   */
  async function refreshDryRun(): Promise<void> {
    pendingContent.clear();
    if (engine === undefined || engine.status !== "ready") {
      dryRun = undefined;
      await publishDryRun();
      return;
    }
    await fetchDryRun();
  }

  /**
   * The failure the card prints, in words a user can act on.
   *
   * `sessionBusy` and "too old" are the two the engine raises by design and
   * both are actionable; a dry-run-off refusal is the engine's own sentence
   * and is quoted rather than paraphrased, because it is already the sentence
   * the terminal prints.
   */
  function dryRunRefusal(error: unknown, verb: string): string {
    if (isUnsupportedMethodError(error)) {
      return `This engine is too old to ${verb} dry-run changes — upgrade the Arcturn CLI.`;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (/sessionBusy/i.test(reason) || /running a turn/i.test(reason)) {
      return `A run is in flight. Stop it, or wait for it to finish, and ${verb} then.`;
    }
    return `The engine refused: ${escapeCodicons(reason)}`;
  }

  function configuredModel(): string | undefined {
    const value = vscode.workspace.getConfiguration("arcturn").get<string>("defaultModel");
    return value === undefined || value === "" ? undefined : value;
  }

  /** What the composer's chip should name, most authoritative first. */
  function currentModelId(): string | undefined {
    return selectedModel ?? engine?.controller?.state.model ?? configuredModel();
  }

  /** Post the catalog as it stands, fetching it first when it is not known yet. */
  async function publishModels(): Promise<void> {
    const status: ModelListStatus = catalogUnavailable
      ? "unavailable"
      : catalog === undefined
        ? "loading"
        : "ready";
    const current = currentModelId();
    provider.postModels({
      status,
      models: catalog ?? [],
      ...(current === undefined ? {} : { current }),
    });
    if (status !== "loading") return;
    if (engine === undefined || engine.status !== "ready") return;
    catalogInFlight ??= fetchCatalog().finally(() => {
      catalogInFlight = undefined;
    });
    await catalogInFlight;
  }

  async function fetchCatalog(): Promise<void> {
    try {
      const models = await ensureEngine().listModels();
      if (models === undefined) {
        catalogUnavailable = true;
        catalog = [];
      } else {
        catalogUnavailable = false;
        catalog = models.map(projectModelOption);
      }
    } catch (error) {
      // Not a reason to deny the user a list: the free-text row still works,
      // and `setModel` is validated by the engine either way.
      log(
        `sidebar: model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      catalogUnavailable = true;
      catalog = [];
    }
    await publishModels();
  }

  /**
   * Switch the session's model and tell the panel what actually happened.
   *
   * `selectedModel` moves only on success, and the chip is re-published either
   * way, so a rejected id snaps back to the model still in use rather than
   * leaving the panel claiming a switch that did not happen.
   */
  async function switchModel(session: EngineSession, modelId: string): Promise<void> {
    const controller = session.controller;
    if (controller === undefined) return;
    try {
      await controller.setModel(modelId);
      selectedModel = modelId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`sidebar: could not switch to ${modelId}: ${reason}`);
      void vscode.window.showErrorMessage(`Arcturn could not switch to ${modelId}: ${reason}`);
    }
    await publishModels();
  }

  /**
   * This workspace's sessions, projected for the panel and cached.
   *
   * The same shape as the model catalog above, for the same reasons: the list
   * is opened far more often than it changes, and "cannot list them" is
   * reported as itself rather than as an empty list — a panel that says "no
   * sessions in this workspace" to a user with fifty of them is worse than one
   * that says nothing. Cleared whenever the connection is replaced or a
   * session is created, which are the two things that make it wrong.
   */
  let sessions: SessionOption[] | undefined;
  let sessionsFailed = false;
  let sessionsInFlight: Promise<void> | undefined;

  function sessionsStatus(): SessionListStatus {
    if (engine === undefined || engine.status !== "ready") return "disconnected";
    if (sessionsFailed) return "failed";
    return sessions === undefined ? "loading" : "ready";
  }

  /** Post the session list as it stands, fetching it first when it is not known yet. */
  async function publishSessions(): Promise<void> {
    const status = sessionsStatus();
    const current = engine?.controller?.sessionId;
    provider.postSessions({
      status,
      sessions: sessions ?? [],
      ...(current === undefined ? {} : { current }),
      cwd: workspaceCwd(),
    });
    if (status !== "loading") return;
    sessionsInFlight ??= fetchSessions().finally(() => {
      sessionsInFlight = undefined;
    });
    await sessionsInFlight;
  }

  async function fetchSessions(): Promise<void> {
    try {
      // `listSessions` returns every session the server knows about; RFC 0004
      // §1 asks for this cwd, and `projectSessions` is where that filter lives.
      sessions = projectSessions(await ensureEngine().listSessions(), workspaceCwd());
      sessionsFailed = false;
    } catch (error) {
      log(
        `sidebar: could not list sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
      sessionsFailed = true;
      sessions = [];
    }
    await publishSessions();
  }

  /**
   * Attach the panel to an existing session.
   *
   * The id is the engine's own, echoed back by the page and re-validated at
   * the boundary; the *engine* decides whether it names a session, which is
   * where that check belongs. A refusal is reported rather than swallowed —
   * a history row that does nothing when clicked is the failure mode this
   * whole surface exists to remove.
   */
  async function openSession(sessionId: string): Promise<void> {
    await withEngine(async (session) => {
      try {
        await session.openSession(sessionId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`sidebar: could not open session ${sessionId}: ${reason}`);
        // Escaped because a notification expands `$(name)` into a glyph, and
        // this id came from the engine.
        void vscode.window.showErrorMessage(
          `Arcturn could not open session ${escapeCodicons(sessionId)}: ${reason}`,
        );
        return;
      }
      selectedModel = undefined;
      clearContext();
      // The file on screen is the same file; the session it would be attached
      // to is not, and `resolveContext` runs against the session's own cwd.
      refreshAmbientNow();
      repaintTranscript();
      publishSession();
      // The mode is a property of the session, not of the engine: a different
      // session may be running under a different one, and a chip carried
      // across the switch would be describing the conversation the user just
      // left. The tools do not change, but they arrive on the same message.
      permission = undefined;
      permissionUnavailable = false;
      await publishPermission();
      // The shadow tree is the engine's, not the session's, but the card is
      // this panel's account of it and a stale one across a switch is a card
      // describing a review the user is no longer in.
      await refreshDryRun();
      // Checkpoints ARE the session's, so a stale picker across a switch would
      // offer to restore another conversation's files.
      await refreshRewind();
      // A run belongs to the session whose stream carries it. The catalog is
      // the engine's and survives, but the card must not: it would be showing
      // a pipeline whose notices this panel is no longer subscribed to, with an
      // Answer button that resumes it into a session the user has left.
      forgetWorkflowRun();
      await publishWorkflows();
      await publishSessions();
    });
  }

  /**
   * What to call this session in a sentence the user reads.
   *
   * The engine's title when the cached list has one, the id otherwise —
   * never a blank, because a modal asking "delete ?" is a modal nobody can
   * answer safely.
   */
  function sessionLabel(sessionId: string): string {
    const row = sessions?.find((candidate) => candidate.sessionId === sessionId);
    return row === undefined || row.title === "" ? sessionId : row.title;
  }

  /**
   * Delete a session, after asking.
   *
   * Two things are deliberate. The confirmation is a **native modal** naming
   * the session, not a webview button and not a toast: this is irreversible
   * and a stray click in a list must not be able to lose an afternoon's work.
   * And the deletion itself is the engine's `deleteSession` verb — the
   * extension never unlinks a session file, which is RFC 0004 §0's rule and
   * also the only version that can refuse to delete a session mid-run.
   *
   * When the deleted session was the one on screen the panel opens a fresh
   * one, so the composer still goes somewhere real. Leaving it attached to
   * nothing would give the user a prompt box that silently swallows what they
   * type — which is the failure this whole surface exists to remove.
   */
  async function deleteSession(sessionId: string): Promise<void> {
    await withEngine(async (session) => {
      const wasAttached = session.controller?.sessionId === sessionId;
      // Escaped because a notification expands `$(name)` into a glyph, and
      // both the title and the id came from the engine.
      const label = escapeCodicons(sessionLabel(sessionId));
      const prompt = describeSessionDeletion(label);
      const choice = await vscode.window.showWarningMessage(
        prompt.message,
        { modal: true, detail: prompt.detail },
        prompt.confirmLabel,
      );
      if (!confirmsSessionDeletion(choice, prompt)) return;

      try {
        await session.deleteSession(sessionId);
      } catch (error) {
        const reason = isUnsupportedMethodError(error)
          ? "this arcturn engine is too old to delete sessions — upgrade the CLI"
          : error instanceof Error
            ? error.message
            : String(error);
        log(`sidebar: could not delete session ${sessionId}: ${reason}`);
        void vscode.window.showErrorMessage(`Arcturn could not delete session ${label}: ${reason}`);
        return;
      }

      // A session that no longer exists was in the cached list.
      sessions = undefined;
      if (wasAttached) {
        await startNewSession(session);
        return;
      }
      await publishSessions();
    });
  }

  /** Start a session, and put it in the list the panel shows. */
  async function startNewSession(session: EngineSession): Promise<void> {
    await session.newSession();
    selectedModel = undefined;
    clearContext();
    // Same argument as `openSession`'s: a new session, the same open file.
    refreshAmbientNow();
    repaintTranscript();
    // A session that exists now was not in the cached list.
    sessions = undefined;
    permission = undefined;
    permissionUnavailable = false;
    publishSession();
    await publishPermission();
    await refreshDryRun();
    await refreshRewind();
    // Same argument as `openSession`'s: the run belonged to the session that is
    // no longer on screen.
    forgetWorkflowRun();
    await publishWorkflows();
    await publishSessions();
    await provider.reveal();
  }

  /**
   * Repaint the transcript from the controller's own state.
   *
   * A controller starts empty and posts only when an event *changes* it, so a
   * freshly attached session posts nothing at all — and the panel would go on
   * rendering the conversation the user just navigated away from, underneath
   * the new session's title. Pushing the controller's current state once on
   * attach is what makes "open that session" actually replace the transcript:
   * empty if the engine replays nothing, the replayed history if it does.
   */
  function repaintTranscript(): void {
    const controller = engine?.controller;
    if (controller !== undefined) states.push(toViewModel(controller.state));
  }

  /** Tell the panel's header which session it is looking at. */
  function publishSession(): void {
    const controller = engine?.controller;
    const title = controller?.header?.title;
    provider.postSession({
      ...(controller === undefined ? {} : { sessionId: controller.sessionId }),
      ...(title === undefined ? {} : { title }),
      cwd: workspaceCwd(),
    });
  }

  /**
   * Whether the last chat state said a run was in flight.
   *
   * The edge, not the level: see `onChat` below.
   */
  let wasRunning = false;

  /** Build the engine session on first use. Spawns nothing by itself. */
  function ensureEngine(): EngineSession {
    if (engine !== undefined) return engine;
    const config = vscode.workspace.getConfiguration("arcturn");
    const model = config.get<string>("defaultModel");
    const port = config.get<number>("serve.port");
    engine = createEngineSession({
      cwd: workspaceCwd(),
      resolveCli,
      spawn: nodeSpawn as unknown as SpawnLike,
      socketFactory: webSocketFactory,
      generateToken,
      resolveEnv,
      log,
      ...(port === undefined ? {} : { port }),
      ...(model === undefined || model === "" ? {} : { model }),
      host: {
        onChat: (state) => {
          states.push(state);
          // The activity-bar badge, from the ENGINE's count — requests raised
          // minus decisions seen — not from what the surface happens to be
          // showing. A user who hid the panel between requests is still told
          // the agent is waiting on them, in the one piece of chrome that is
          // on screen in every layout.
          provider.postBadge(state.pendingPermissions);
          // A turn that just ended is when a dry run's shadow tree changed.
          // Without this the review card would only ever appear on a page
          // load, which is the same as asking the user to remember to look —
          // the one thing this surface exists not to do. Only on the
          // *transition* out of a run: refreshing on every streamed delta
          // would be a `pendingChanges` round trip per token.
          if (wasRunning && !state.running) void refreshDryRun();
          wasRunning = state.running;
        },
        onNotice: onWorkflowTick,
        onCost: (cost) => {
          statusBar.update(cost);
          provider.postCost(costLabel(cost));
        },
        onConnection: (status, detail, report) => {
          provider.postConnection(status, report);
          // A dropped connection disposes the controller, which denies every
          // outstanding request — so nothing is waiting on the user any more
          // and the badge must not go on saying otherwise. The card itself
          // came down with those denials, through `onPermissionDecision`.
          if (status !== "ready") provider.postBadge(0);
          if (status === "ready") {
            // A new connection is a new server: its credentials, and therefore
            // which models are usable, may not be the ones the last catalog
            // described. The panel asks for a fresh one as soon as it sees
            // `ready`; this only makes sure the stale answer is not what it gets.
            catalog = undefined;
            catalogUnavailable = false;
            selectedModel = undefined;
            // A new engine may be a different build with different verbs, a
            // different skill set on disk and a different permission config.
            // Cleared rather than re-fetched, like the session list: a panel
            // that is showing a menu asks for itself.
            commands = undefined;
            commandsUnavailable = false;
            permission = undefined;
            permissionUnavailable = false;
            // A new engine may not even be in dry-run mode, and a review card
            // that survived the reconnect would be offering to apply changes
            // this engine is not holding.
            clearDryRun();
            // Same argument, and a sharper one: a checkpoint list from the
            // last engine names turns this one never recorded, and every row
            // in it offers to delete files.
            rewind = undefined;
            // Same argument again: a workflow catalog from the last engine
            // names pipelines this one may not have, and a run card carried
            // across would offer to resume a journal this engine cannot read.
            clearWorkflows();
            // A path resolved against the last workspace means nothing in this
            // one, and a chip carried across a reconnect is a chip the engine
            // never agreed to.
            clearContext();
            // The ambient chip is cleared by the same argument and then asked
            // again, because the file the user is looking at has not changed —
            // only who was available to answer for it. This is also the moment
            // the very first chip appears: nothing could be resolved before
            // there was a connection.
            ambientItem = undefined;
            refreshAmbientNow();
            // A new connection is also a new session store to ask. Cleared,
            // not re-fetched: a user who never opens history should not cost a
            // `listSessions` round trip on every reconnect, and a panel that
            // *is* showing the list asks for itself when it sees `ready`.
            sessions = undefined;
            sessionsFailed = false;
            publishSession();
          }
          // The card is only visible when the view is open. The Output channel
          // is where the same words live for everyone else — including the
          // user who reached this through the command palette.
          if (detail !== undefined) log(`sidebar: ${detail}`);
          // A connection that came back is a new chance to be told about the
          // next failure; a failure that repeats verbatim is not.
          if (status === "ready") announcedFailure = undefined;
          // `$0.00` on a live session is a complete, true answer; the item is
          // hidden only when there is no session for it to describe.
          if (status === "ready") statusBar.show();
          else statusBar.hide();
        },
        askPermission: (request, args) => permissions.ask(request, args),
        // Every decision, whoever produced it — including the denials a
        // disposed queue sends on a session switch or a dropped connection.
        // It is what takes the card down at the moment the request stops being
        // answerable, so a disposal can never leave a live Allow on screen.
        onPermissionDecision: (decision) => permissions.settle(decision.requestId),
        onDiagnostic: log,
      },
    });
    return engine;
  }

  /**
   * The environment the engine is spawned with, resolved on first start.
   *
   * Two things happen here that must not happen anywhere else. The values of
   * credential-shaped variables are registered with the output channel's
   * redactor, so that if one ever reaches a diagnostic by some route nobody
   * anticipated it is blanked by value rather than by shape. And the
   * *diagnostic* — which by construction names no variable and quotes no
   * value — is logged once, so a user whose shell probe failed can see that it
   * failed instead of wondering why their key is still invisible.
   */
  let loggedEnvironment = false;
  async function resolveEnv(): Promise<Record<string, string | undefined>> {
    const resolved = await resolveUserEnvironment();
    for (const secret of resolved.secrets) redactor.add(secret);
    if (!loggedEnvironment) {
      loggedEnvironment = true;
      log(resolved.diagnostic);
    }
    return resolved.env;
  }

  /** One of the card's buttons, from the webview or from a notification. */
  async function runAction(id: ConnectionActionId): Promise<void> {
    switch (id) {
      case "reconnect":
        await restart();
        return;
      case "showLog":
        output.show(true);
        return;
      case "installCli":
        await vscode.commands.executeCommand("arcturn.installCli");
        return;
      case "openCliSetting":
        await vscode.commands.executeCommand("workbench.action.openSettings", "arcturn.cliPath");
        return;
      case "openModelSetting":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "arcturn.defaultModel",
        );
        return;
    }
  }

  /**
   * The failure already announced with a notification.
   *
   * A card is the sidebar's answer; a palette command has no card, and used to
   * answer a dead engine with nothing at all — no picker, no message, an empty
   * Output channel nobody was told to open. So the first command that cannot
   * run raises exactly one notification carrying the engine's own words. It is
   * one per failure, not one per command: three commands in a row on a machine
   * with no API key must not stack three identical toasts, which is the toast
   * storm RFC 0004 §1 says the card exists to avoid.
   */
  let announcedFailure: string | undefined;

  /** A notification carries at most this many buttons before it stops reading as one. */
  const MAX_NOTIFICATION_ACTIONS = 3;

  async function announce(report: ConnectionReport): Promise<void> {
    const text = reportText(report);
    if (announcedFailure === text) return;
    announcedFailure = text;
    const buttons = report.actions.slice(0, MAX_NOTIFICATION_ACTIONS);
    const choice = await vscode.window.showErrorMessage(
      text,
      ...buttons.map((action) => action.label),
    );
    const picked = buttons.find((action) => action.label === choice);
    if (picked !== undefined) await runAction(picked.id);
  }

  async function start(): Promise<void> {
    await ensureEngine().start();
  }

  async function restart(): Promise<void> {
    // Retry means retry the whole start. A login-shell probe that failed is
    // the step most likely to have failed transiently (a slow `nvm`, a machine
    // waking from sleep) and the step whose failure is least visible, so a
    // retry that skipped it would keep spawning serve with an environment that
    // has no API keys in it. A probe that *succeeded* is left cached — see
    // `user-env.ts`.
    if (forgetFailedUserEnvironment()) loggedEnvironment = false;
    await ensureEngine().restart();
  }

  /** Run `action` against a started engine, surfacing failures as a card. */
  async function withEngine(
    action: (session: EngineSession) => Promise<void> | undefined,
  ): Promise<void> {
    const session = ensureEngine();
    await session.start();
    const failure = session.failure;
    if (failure !== undefined) {
      // Running the action now would reach a `controller` that is `undefined`
      // and return silently — which is what an empty model picker looked like
      // from the outside.
      await announce(failure);
      return;
    }
    try {
      await action(session);
    } catch (error) {
      log(`sidebar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  disposables.push(
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewId, provider, {
      // RFC 0004 §3: off unless measured necessary. The webview replays its
      // state on `ready`, so retaining it buys nothing.
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.reconnect, () => restart()),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.showLog, () => output.show(true)),
    /**
     * The discoverable half of the toggle.
     *
     * The chip's own control can only switch the watching *off* — it is only
     * on screen when it is on — so this is the door back, and the one a user
     * who has never seen the chip can find. It reports where it landed,
     * because a palette command that changes a setting and says nothing leaves
     * somebody pressing it twice.
     */
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.toggleActiveEditorContext, async () => {
      const next = !ambientEnabled();
      await setAmbientEnabled(next);
      void vscode.window.showInformationMessage(
        next
          ? "Arcturn will include the file you have open with your next message."
          : "Arcturn will stop including the file you have open.",
      );
    }),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.abortRun, () =>
      withEngine((session) => session.controller?.abort()),
    ),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.newSession, () =>
      withEngine((session) => startNewSession(session)),
    ),
    /**
     * The palette's door to the panel's history view.
     *
     * It used to be a quick-pick: a native dropdown at the top of the *window*,
     * detached from the panel that launched it, which made the sidebar feel
     * like a launcher for dialogs rather than a surface of its own. It now
     * reveals the panel and opens the view that lives there, so the header
     * button and this command are two doors to one list — with one
     * implementation behind them, which is the only way they cannot drift.
     *
     * Deliberately *not* wrapped in `withEngine`: a dead engine must not
     * swallow the command with a toast and leave the user looking at the same
     * panel they started from. The view opens either way and says what it
     * knows, over the reconnect card that says why — which is the same
     * argument RFC 0004 §1 makes for a card instead of a toast storm.
     */
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.showSessions, async () => {
      await provider.reveal();
      provider.showSessions();
      void start();
      await publishSessions();
    }),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.selectModel, () =>
      withEngine(async (session) => {
        const controller = session.controller;
        if (controller === undefined) return;
        const configured = configuredModel();
        // `listModels` is an optional verb: an older engine answers
        // `undefined`, and anything else that goes wrong here is a
        // diagnostic, not a reason to deny the user a picker. Either way the
        // catalog is simply absent and the pre-catalog rows still render.
        const entries = await session.listModels().catch((error: unknown) => {
          log(
            `sidebar: model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
        const items = modelPickItems({
          ...(entries === undefined ? {} : { catalog: entries }),
          observed: controller.observedModels,
          ...(configured === undefined ? {} : { configured }),
          ...(currentModelId() === undefined ? {} : { current: currentModelId() as string }),
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: "Arcturn model",
          placeHolder:
            entries === undefined
              ? "Switch the model for this session"
              : `Switch the model for this session (${entries.length} available)`,
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (picked === undefined) return;
        const modelId =
          picked.modelId ??
          (await vscode.window.showInputBox({
            title: "Arcturn model",
            prompt: "Model id, e.g. anthropic/claude-sonnet-5",
            ignoreFocusOut: true,
          }));
        if (modelId === undefined || modelId.trim() === "") return;
        // Through the same path the panel's chip uses, so the palette and the
        // panel can never disagree about which model is in use.
        await switchModel(session, modelId.trim());
      }),
    ),
    /**
     * The palette's doors to the review loop.
     *
     * Three commands rather than one, and the same three the terminal has, so
     * a person who knows `/diff`, `/apply` and `/discard` finds them where
     * they look for everything else in this editor. Each runs the *same*
     * function the panel's card runs — including the discard modal — because
     * two implementations of a destructive action is one too many.
     */
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.showDiff, () => showDiff()),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.applyChanges, () => applyChanges()),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.discardChanges, () => discardChanges()),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.showCost, async () => {
      const rows = costBreakdown(statusBar.state);
      await vscode.window.showQuickPick(
        rows.map((row) => ({ label: row.label, description: row.detail })),
        { title: "Arcturn session cost" },
      );
    }),
    // Authorizing a hosted MCP server is the one flow the CLI cannot finish on
    // the user's behalf when the editor is attached to anything but this
    // machine: its redirect listener is on `127.0.0.1` *here*, and the browser
    // is over there. `mcp-auth.ts` explains the fix; this is where the editor
    // APIs that make it possible get handed to it.
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.authorizeMcpServer, (server?: string) =>
      withEngine(async (session) => {
        const name = server ?? (await pickOAuthServer(session));
        if (name === undefined) return;
        await runMcpAuthorization(session, name);
      }),
    ),
  );

  /**
   * Ask which server to authorize.
   *
   * Only http servers are offered, because OAuth does not apply to stdio ones,
   * and a picker that lists a server the engine will refuse is a picker that
   * teaches the user the feature is broken.
   */
  async function pickOAuthServer(session: EngineSession): Promise<string | undefined> {
    const servers = await session.mcpServers();
    if (servers === undefined) {
      void vscode.window.showWarningMessage(
        "This engine is too old to authorize MCP servers from the editor.",
      );
      return undefined;
    }
    const candidates = servers.filter((server) => server.transport === "http");
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        "No HTTP MCP servers are configured, so there is nothing to authorize.",
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((server) => ({
        label: server.name,
        description: server.state === "connected" ? "connected" : server.state,
      })),
      { title: "Authorize an MCP server", placeHolder: "Which server?" },
    );
    return picked?.label;
  }

  /**
   * Run one authorization behind a cancellable progress notification.
   *
   * Cancellation is wired through to the engine rather than merely closing the
   * notification: a flow abandoned in the editor but left running in the engine
   * would hold a pending authorization for its full timeout.
   */
  async function runMcpAuthorization(session: EngineSession, server: string): Promise<void> {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Authorizing MCP server "${server}"`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancelled = token.onCancellationRequested(() => controller.abort());
        try {
          return await authorizeMcpServer({
            client: session,
            editor: vscodeMcpAuthEditor(),
            server,
            extensionId: ARCTURN_EXTENSION_ID,
            signal: controller.signal,
          });
        } finally {
          cancelled.dispose();
        }
      },
    );

    if (outcome.kind === "authorized" || outcome.kind === "already-authorized") {
      const detail =
        outcome.kind === "already-authorized" ? " (existing credentials were refreshed)" : "";
      void vscode.window.showInformationMessage(
        `Authorized "${server}"${detail}. Reconnect to pick up its tools.`,
      );
      return;
    }
    if (outcome.kind === "denied") {
      void vscode.window.showWarningMessage(
        `Authorization for "${server}" was denied: ${outcome.reason}`,
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `This engine cannot authorize MCP servers; run "arcturn mcp auth ${server}" instead.`,
    );
  }

  const disposable = new vscode.Disposable(() => {
    engine?.dispose();
    engine = undefined;
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * The folder the engine serves.
 *
 * RFC 0004 §1 says "per workspace"; VS Code's first workspace folder is that,
 * and a window with no folder open falls back to the process's own directory
 * so the sidebar still works for a scratch session.
 */
function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/**
 * The real socket: `ws`'s `WebSocket`, which satisfies {@link WebSocketLike}
 * structurally with no adapter (see `@arcturn/protocol`'s own doc).
 */
const webSocketFactory: SocketFactory = (url) => {
  // Required lazily so `ws` is not initialised during activation — RFC 0004
  // §3's activation budget. esbuild still bundles it; only the module's own
  // top-level work is deferred to the first connection.
  const { WebSocket } = require("ws") as { WebSocket: new (url: string) => WebSocketLike };
  return new WebSocket(url);
};

/**
 * The three editor APIs an MCP authorization needs, bound to the real
 * `vscode` module.
 *
 * `asExternalUri` is the load-bearing one. On a desktop window it hands back
 * the `vscode://` URI unchanged; attached to a remote, a devcontainer or a
 * Codespace it returns a tunnelled `https://` URL that reaches *this window*
 * from a browser running on the user's own machine. That is the whole
 * difference between an authorization that completes and one that times out.
 */
export function vscodeMcpAuthEditor(): McpAuthEditor {
  return {
    asExternalUri: async (uri) =>
      (await vscode.env.asExternalUri(vscode.Uri.parse(uri))).toString(),
    openExternal: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
    onUri: (handler) =>
      vscode.window.registerUriHandler({ handleUri: (uri) => handler(uri.query) }),
  };
}
