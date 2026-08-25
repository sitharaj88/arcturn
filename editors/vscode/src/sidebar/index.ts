// Owned by Builder B per RFC 0004 §2. Seam: activateSidebar(context, resolveCli).
/**
 * The Stage 2 seam.
 *
 * Builder A calls {@link activateSidebar} exactly once, gated on
 * `arcturn.serve.enabled`. Everything below it — the `arcturn serve` child, the
 * protocol client, the chat webview, the permission modals, the cost status
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
import { type ChatViewModel, toViewModel } from "./chat-state.js";
import { createCoalescer } from "./coalesce.js";
import { type ConnectionActionId, type ConnectionReport, reportText } from "./connection-card.js";
import { costBreakdown, costLabel } from "./cost.js";
import {
  answerFromChoice,
  confirmsSessionDeletion,
  describeSessionDeletion,
  permissionChoices,
} from "./dialog.js";
import { createEngineSession, type EngineSession } from "./engine-session.js";
import { describePermissionRequest } from "./permission-queue.js";
import { escapeCodicons, modelPickItems } from "./picker.js";
import { CostStatusBar } from "./status-bar.js";
import { SidebarViewProvider } from "./view.js";
import type { CommandOption } from "./webview-commands.js";
import { contextGlob, narrowCandidates } from "./webview-context.js";
import {
  type CommandListStatus,
  type ContextItem,
  type ModelListStatus,
  type PermissionStateStatus,
  projectCommandOption,
  projectContextItem,
  projectModelOption,
  projectSessions,
  type SessionListStatus,
} from "./webview-messages.js";
import type { ModelOption } from "./webview-models.js";
import type { SessionOption } from "./webview-sessions.js";

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

/** Command ids this module registers. Builder A declares them in the manifest. */
export const SIDEBAR_COMMANDS = {
  selectModel: "arcturn.selectModel",
  showSessions: "arcturn.showSessions",
  newSession: "arcturn.newSession",
  abortRun: "arcturn.abortRun",
  showCost: "arcturn.showCost",
  reconnect: "arcturn.reconnect",
  showLog: "arcturn.showLog",
} as const;

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
        case "requestPermission":
          void publishPermission();
          return;
        case "setPermissionMode":
          void applyPermissionMode(message.mode);
          return;
        case "requestCommands":
          void publishCommands();
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
          void vscode.commands.executeCommand(
            message.command === "model"
              ? SIDEBAR_COMMANDS.selectModel
              : message.command === "sessions"
                ? SIDEBAR_COMMANDS.showSessions
                : SIDEBAR_COMMANDS.newSession,
          );
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
    onDiagnostic: log,
  });

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

  /** Push the chip row as it stands. */
  function publishContext(): void {
    provider.postContext([...attached.values()]);
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
      repaintTranscript();
      publishSession();
      // The mode is a property of the session, not of the engine: a different
      // session may be running under a different one, and a chip carried
      // across the switch would be describing the conversation the user just
      // left. The tools do not change, but they arrive on the same message.
      permission = undefined;
      permissionUnavailable = false;
      await publishPermission();
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
    repaintTranscript();
    // A session that exists now was not in the cached list.
    sessions = undefined;
    permission = undefined;
    permissionUnavailable = false;
    publishSession();
    await publishPermission();
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
        onChat: (state) => states.push(state),
        onCost: (cost) => {
          statusBar.update(cost);
          provider.postCost(costLabel(cost));
        },
        onConnection: (status, detail, report) => {
          provider.postConnection(status, report);
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
            // A path resolved against the last workspace means nothing in this
            // one, and a chip carried across a reconnect is a chip the engine
            // never agreed to.
            clearContext();
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
        askPermission: async (request, args) => {
          const described = describePermissionRequest(request, args);
          const choice = await vscode.window.showWarningMessage(
            described.message,
            { modal: true, detail: described.detail },
            ...permissionChoices(described),
          );
          return answerFromChoice(choice, described);
        },
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
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.showCost, async () => {
      const rows = costBreakdown(statusBar.state);
      await vscode.window.showQuickPick(
        rows.map((row) => ({ label: row.label, description: row.detail })),
        { title: "Arcturn session cost" },
      );
    }),
  );

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
