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
import { createNonce, renderSidebarHtml } from "./webview-html.js";
import {
  type ConnectionStatus,
  type HostMessage,
  parseWebviewMessage,
  type WebviewMessage,
} from "./webview-messages.js";

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
  #lastConnection: { status: ConnectionStatus; detail?: string } = { status: "idle" };
  #lastCost = "";

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

  /** Push the connection status (the reconnect card). */
  postConnection(status: ConnectionStatus, detail?: string): void {
    this.#lastConnection = detail === undefined ? { status } : { status, detail };
    this.#post({ type: "connection", status, ...(detail === undefined ? {} : { detail }) });
  }

  /** Push the cost label. */
  postCost(label: string): void {
    this.#lastCost = label;
    this.#post({ type: "cost", label });
  }

  /** Reveal the view, resolving it if it has never been opened. */
  async reveal(): Promise<void> {
    if (this.#view !== undefined) {
      this.#view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${SidebarViewProvider.viewId}.focus`);
  }

  #replay(): void {
    this.#post({
      type: "connection",
      status: this.#lastConnection.status,
      ...(this.#lastConnection.detail === undefined ? {} : { detail: this.#lastConnection.detail }),
    });
    if (this.#lastState !== undefined) this.#post({ type: "state", state: this.#lastState });
    if (this.#lastCost !== "") this.#post({ type: "cost", label: this.#lastCost });
  }

  #post(message: HostMessage): void {
    void this.#view?.webview.postMessage(message);
  }
}
