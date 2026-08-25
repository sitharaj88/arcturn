/**
 * The `WebviewViewProvider` behind the `arcturn.sidebar` view.
 *
 * Thin by design: the page comes from `webview-html.ts`, every inbound message
 * is validated by `webview-messages.ts`, and every outbound update is a
 * projection built by `chat-state.ts`. What lives here is the VS Code plumbing
 * and two policies:
 *
 * - **Lazy.** `resolveWebviewView` is the first moment anything starts. VS Code
 *   calls it when the user actually opens the view, which is exactly the
 *   activation budget RFC 0004 §3 sets.
 * - **No retained context.** `retainContextWhenHidden` is left off, per §3.
 *   The webview therefore reloads when it is revealed again, and announces
 *   itself with a `ready` message; the host answers by re-posting the current
 *   state, so nothing is lost by not retaining it.
 */

import * as vscode from "vscode";
import type { ChatViewModel } from "./chat-state.js";
import type { ConnectionReport } from "./connection-card.js";
import type { DryRunView } from "./dry-run.js";
import type { CommandOption } from "./webview-commands.js";
import { createNonce, renderSidebarHtml } from "./webview-html.js";
import {
  type CommandListStatus,
  type ConnectionStatus,
  type ContextItem,
  type HostMessage,
  type ModelListStatus,
  type PermissionStateStatus,
  parseWebviewMessage,
  type SessionListStatus,
  type WebviewMessage,
} from "./webview-messages.js";
import type { ModelOption } from "./webview-models.js";
import type { SessionOption } from "./webview-sessions.js";

/** What the header shows about the session the panel is attached to. */
export interface SessionSummary {
  sessionId?: string;
  title?: string;
  cwd?: string;
}

/** The model list as the panel last saw it. */
export interface ModelListView {
  status: ModelListStatus;
  models: ModelOption[];
  current?: string;
}

/** The session list as the panel last saw it. */
export interface SessionListView {
  status: SessionListStatus;
  sessions: SessionOption[];
  current?: string;
  cwd?: string;
}

/** The session's permission regime as the panel last saw it. */
export interface PermissionView {
  status: PermissionStateStatus;
  /** The mode in force. Absent when the engine did not say. */
  mode?: string;
  /** Tool names, for the capability line. */
  tools: string[];
  /**
   * Why the last mode change did not take.
   *
   * Deliberately part of the *same* view as the mode, so a refusal and the
   * mode still in force are one message and cannot arrive out of order: the
   * chip snaps back and the sentence appears in one paint.
   */
  note?: string;
}

/** The `/` menu as the panel last saw it. */
export interface CommandListView {
  status: CommandListStatus;
  commands: CommandOption[];
}

/** What the provider needs from the extension host. */
export interface SidebarViewHandlers {
  /** The view was resolved for the first time — start the engine. */
  onResolve: () => void;
  /** The webview reloaded and wants the current state. */
  onReady: () => void;
  /** A validated message from the webview. */
  onMessage: (message: WebviewMessage) => void;
  /** Redacted diagnostics for a message that failed validation. */
  onDiagnostic?: (line: string) => void;
}

/** Registers and drives the `arcturn.sidebar` webview view. */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /** Must match the view id Builder A declares in the manifest. */
  static readonly viewId = "arcturn.sidebar";

  readonly #handlers: SidebarViewHandlers;
  #view: vscode.WebviewView | undefined;
  #resolved = false;
  /** The last state posted, replayed when the webview reloads. */
  #lastState: ChatViewModel | undefined;
  #lastConnection: { status: ConnectionStatus; report?: ConnectionReport } = { status: "idle" };
  #lastCost = "";
  /**
   * The model list and the session header, remembered for the same reason the
   * connection report is: `retainContextWhenHidden` is off, so a panel that is
   * hidden and revealed reloads with an empty chip and an unnamed session
   * unless the host replays what it already knows.
   */
  #lastModels: ModelListView | undefined;
  #lastSession: SessionSummary | undefined;
  #lastSessions: SessionListView | undefined;
  #lastPermission: PermissionView | undefined;
  #lastCommands: CommandListView | undefined;
  #lastDryRun: DryRunView | undefined;
  /** What the composer is holding, replayed on reload. See {@link SidebarViewProvider.postContext}. */
  #lastContext: ContextItem[] | undefined;
  /**
   * Whether the page has announced itself since the current document loaded.
   *
   * `showSessions` is an *action*, not state: posting it at a document whose
   * script has not run yet does not queue it, it loses it — and
   * `retainContextWhenHidden` is off, so revealing the view from the palette
   * is exactly that case. So the action is held until the page says `ready`,
   * which is the only signal there is that a listener exists.
   */
  #pageReady = false;
  #pendingShowSessions = false;

  constructor(handlers: SidebarViewHandlers) {
    this.#handlers = handlers;
  }

  /** Whether the view has ever been opened. */
  get resolved(): boolean {
    return this.#resolved;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    // A fresh document: whatever the last one had heard, this one has not.
    this.#pageReady = false;
    view.webview.options = {
      enableScripts: true,
      // The page is entirely inline; it needs no local resource root at all.
      localResourceRoots: [],
    };
    view.webview.html = renderSidebarHtml({
      nonce: createNonce(),
      cspSource: view.webview.cspSource,
    });
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message === undefined) {
        this.#handlers.onDiagnostic?.("sidebar: dropped an unrecognised webview message");
        return;
      }
      if (message.type === "ready") {
        this.#pageReady = true;
        this.#replay();
        this.#handlers.onReady();
        return;
      }
      this.#handlers.onMessage(message);
    });
    view.onDidDispose(() => {
      this.#view = undefined;
      this.#pageReady = false;
    });
    if (!this.#resolved) {
      this.#resolved = true;
      this.#handlers.onResolve();
    }
  }

  /** Push a new transcript to the view. */
  postState(state: ChatViewModel): void {
    this.#lastState = state;
    this.#post({ type: "state", state });
  }

  /**
   * Push the connection status (the reconnect card).
   *
   * The report is remembered, not just posted: `retainContextWhenHidden` is
   * off, so a webview that is hidden and revealed again reloads and asks for a
   * replay — and a user who closes the panel over a failed start must not come
   * back to a card that has forgotten why it is there.
   *
   * @param status - Where the connection stands.
   * @param report - The failure, when there is one.
   */
  postConnection(status: ConnectionStatus, report?: ConnectionReport): void {
    this.#lastConnection = report === undefined ? { status } : { status, report };
    this.#post(this.#connectionMessage());
  }

  /** Push the cost label. */
  postCost(label: string): void {
    this.#lastCost = label;
    this.#post({ type: "cost", label });
  }

  /**
   * Push the model list behind the composer's chip.
   *
   * @param view - Catalog status, the projected rows, and the id the chip
   *   should show. See {@link ModelListView}.
   */
  postModels(view: ModelListView): void {
    this.#lastModels = view;
    this.#post(modelsMessage(view));
  }

  /**
   * Push what the composer is holding.
   *
   * Remembered and replayed for the reason every other list here is:
   * `retainContextWhenHidden` is off, so a panel that is hidden and revealed
   * reloads — and chips that vanished while the host was still going to attach
   * them on the next `send` would be the panel and the prompt disagreeing.
   */
  postContext(items: ContextItem[]): void {
    this.#lastContext = items;
    this.#post({ type: "context", items });
  }

  /**
   * Push one `resolveContext` answer.
   *
   * Deliberately *not* remembered: a picker's candidate list is a response to
   * something the user is typing right now, and replaying a stale one into a
   * reloaded page would re-open a picker nobody asked for.
   */
  postContextCandidates(
    query: string,
    items: ContextItem[],
    status: "ready" | "unavailable" = "ready",
  ): void {
    this.#post({ type: "contextCandidates", query, items, status });
  }

  /**
   * Push the session's permission regime: the mode chip and the capability
   * line in the empty state.
   *
   * @param view - See {@link PermissionView}.
   */
  postPermission(view: PermissionView): void {
    // A note is about one attempt, not about the state: remembering it would
    // replay "this engine is too old" into a panel that was reloaded an hour
    // later, next to a chip that has been correct the whole time.
    const { note: _note, ...remembered } = view;
    this.#lastPermission = remembered;
    this.#post(permissionMessage(view));
  }

  /**
   * Push what a `/` could invoke here.
   *
   * @param view - See {@link CommandListView}.
   */
  postCommands(view: CommandListView): void {
    this.#lastCommands = view;
    this.#post({ type: "commands", status: view.status, commands: view.commands });
  }

  /**
   * Push what the dry run is holding back.
   *
   * Remembered and replayed like every other list here, and for a sharper
   * reason than most: `retainContextWhenHidden` is off, so a panel the user
   * hides and reveals reloads — and a review card that came back *empty* would
   * be telling somebody there is nothing waiting when there is.
   *
   * The `note` is dropped from what is remembered, exactly as
   * {@link SidebarViewProvider.postPermission} drops its own: a refusal is
   * about one attempt, and replaying "a run is in flight" into a panel
   * reopened an hour later would be false.
   *
   * @param view - See {@link DryRunView}.
   */
  postDryRun(view: DryRunView): void {
    const { note: _note, ...remembered } = view;
    this.#lastDryRun = remembered;
    this.#post({ type: "dryRun", view });
  }

  /** Push the session the panel is attached to. */
  postSession(session: SessionSummary): void {
    this.#lastSession = session;
    this.#post(sessionMessage(session));
  }

  /**
   * Push this workspace's sessions behind the header's history button.
   *
   * @param view - List status, the projected rows, the session in use, and the
   *   folder a new one would start in. See {@link SessionListView}.
   */
  postSessions(view: SessionListView): void {
    this.#lastSessions = view;
    this.#post(sessionsMessage(view));
  }

  /**
   * Open the panel's history view.
   *
   * The palette's `arcturn.showSessions` and the panel's own header button are
   * two doors to this one surface, so this is what the command does instead of
   * building a second, native list of its own. Held until the page is `ready`
   * when it is not — see {@link SidebarViewProvider.#pageReady}.
   */
  showSessions(): void {
    if (this.#pageReady) {
      this.#post({ type: "showSessions" });
      return;
    }
    this.#pendingShowSessions = true;
  }

  /** Reveal the view, resolving it if it has never been opened. */
  async reveal(): Promise<void> {
    if (this.#view !== undefined) {
      this.#view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${SidebarViewProvider.viewId}.focus`);
  }

  #connectionMessage(): HostMessage {
    const { status, report } = this.#lastConnection;
    if (report === undefined) return { type: "connection", status };
    return {
      type: "connection",
      status,
      detail: report.headline,
      ...(report.engineOutput === "" ? {} : { engineOutput: report.engineOutput }),
      actions: report.actions,
    };
  }

  #replay(): void {
    this.#post(this.#connectionMessage());
    if (this.#lastState !== undefined) this.#post({ type: "state", state: this.#lastState });
    if (this.#lastCost !== "") this.#post({ type: "cost", label: this.#lastCost });
    if (this.#lastModels !== undefined) this.#post(modelsMessage(this.#lastModels));
    if (this.#lastSession !== undefined) this.#post(sessionMessage(this.#lastSession));
    if (this.#lastSessions !== undefined) this.#post(sessionsMessage(this.#lastSessions));
    if (this.#lastContext !== undefined) this.#post({ type: "context", items: this.#lastContext });
    if (this.#lastPermission !== undefined) this.#post(permissionMessage(this.#lastPermission));
    if (this.#lastCommands !== undefined) {
      this.#post({
        type: "commands",
        status: this.#lastCommands.status,
        commands: this.#lastCommands.commands,
      });
    }
    if (this.#lastDryRun !== undefined) this.#post({ type: "dryRun", view: this.#lastDryRun });
    // Last, so the view it opens is already holding the list it will show. One
    // shot: a reload the user did not ask for must not re-open the view.
    if (this.#pendingShowSessions) {
      this.#pendingShowSessions = false;
      this.#post({ type: "showSessions" });
    }
  }

  #post(message: HostMessage): void {
    void this.#view?.webview.postMessage(message);
  }
}

/** Build the `models` message, omitting `current` rather than sending `undefined`. */
function modelsMessage(view: ModelListView): HostMessage {
  return {
    type: "models",
    status: view.status,
    models: view.models,
    ...(view.current === undefined || view.current === "" ? {} : { current: view.current }),
  };
}

/** Build the `sessions` message, omitting what is not known rather than sending `undefined`. */
function sessionsMessage(view: SessionListView): HostMessage {
  return {
    type: "sessions",
    status: view.status,
    sessions: view.sessions,
    ...(view.current === undefined || view.current === "" ? {} : { current: view.current }),
    ...(view.cwd === undefined || view.cwd === "" ? {} : { cwd: view.cwd }),
  };
}

/** Build the `permission` message, omitting what the engine did not say. */
function permissionMessage(view: PermissionView): HostMessage {
  return {
    type: "permission",
    status: view.status,
    ...(view.mode === undefined || view.mode === "" ? {} : { mode: view.mode }),
    tools: view.tools,
    ...(view.note === undefined || view.note === "" ? {} : { note: view.note }),
  };
}

/** Build the `session` message from whatever of the header is known. */
function sessionMessage(session: SessionSummary): HostMessage {
  return {
    type: "session",
    ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
  };
}
