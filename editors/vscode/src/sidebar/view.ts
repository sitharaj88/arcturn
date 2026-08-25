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
import { createNonce, renderSidebarHtml } from "./webview-html.js";
import {
  type ConnectionStatus,
  type HostMessage,
  type ModelListStatus,
  parseWebviewMessage,
  type WebviewMessage,
} from "./webview-messages.js";
import type { ModelOption } from "./webview-models.js";

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

  constructor(handlers: SidebarViewHandlers) {
    this.#handlers = handlers;
  }

  /** Whether the view has ever been opened. */
  get resolved(): boolean {
    return this.#resolved;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
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
        this.#replay();
        this.#handlers.onReady();
        return;
      }
      this.#handlers.onMessage(message);
    });
    view.onDidDispose(() => {
      this.#view = undefined;
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

  /** Push the session the panel is attached to. */
  postSession(session: SessionSummary): void {
    this.#lastSession = session;
    this.#post(sessionMessage(session));
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

/** Build the `session` message from whatever of the header is known. */
function sessionMessage(session: SessionSummary): HostMessage {
  return {
    type: "session",
    ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
  };
}
