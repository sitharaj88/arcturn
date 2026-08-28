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
import type { PermissionCard } from "./permission-surface.js";
import type { RewindView } from "./rewind.js";
import type { CommandOption } from "./webview-commands.js";
import { createNonce, renderSidebarHtml } from "./webview-html.js";
import {
  type ActiveEditorItem,
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
import type { WorkflowView } from "./workflows.js";

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
  /**
   * The view became visible, or stopped being visible.
   *
   * The one signal the permission surface cannot do without.
   * `retainContextWhenHidden` is off, so a hidden view is a *destroyed* page:
   * a permission card drawn on it is gone, and a run waiting on that card
   * would block on a control nobody can see or answer. The host escalates to a
   * native modal on `false` — see `permission-surface.ts`.
   *
   * A disposed view reports `false` for the same reason: it is the strongest
   * form of "not visible" there is.
   */
  onVisibility?: (visible: boolean) => void;
  /** Redacted diagnostics for a message that failed validation. */
  onDiagnostic?: (line: string) => void;
}

/**
 * How long {@link SidebarViewProvider.reveal} waits for a view it just asked
 * to show to report itself visible.
 *
 * `WebviewView.show()` is a request to the workbench, not a synchronous state
 * change: when the whole sidebar is closed the container has to open first, so
 * `visible` can still be `false` on the next line. Waiting is what makes the
 * answer usable — "is the panel actually up?" is the question the permission
 * surface asks before it decides between a card and a modal, and answering it
 * a frame too early would send every request to a modal.
 *
 * Short enough that a workbench which is not going to show the view does not
 * hold a permission prompt for a perceptible time before the modal appears.
 */
const REVEAL_SETTLE_MS = 400;

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
  /**
   * The permission card currently up, replayed when the webview reloads.
   *
   * Remembered for the reason the review card is, and with a sharper
   * consequence: `retainContextWhenHidden` is off, so a panel that is hidden
   * and revealed reloads — and a card that did not come back would leave a run
   * blocked with nothing on screen to unblock it. Cleared by
   * {@link SidebarViewProvider.postPermissionAsk} with no argument, which is
   * what the host sends the moment the request stops being answerable here.
   */
  #lastPermissionAsk: PermissionCard | undefined;
  #lastCommands: CommandListView | undefined;
  #lastDryRun: DryRunView | undefined;
  #lastRewind: RewindView | undefined;
  #lastWorkflows: WorkflowView | undefined;
  /** What the composer is holding, replayed on reload. See {@link SidebarViewProvider.postContext}. */
  #lastContext: ContextItem[] | undefined;
  /**
   * The ambient chip, replayed with the rest.
   *
   * Remembered on the *same* terms as `#lastContext` and posted on the same
   * message, because they are one row and one truth: a reload that brought
   * back the attachments without the file the user is looking at would be the
   * panel forgetting half of what the next prompt carries.
   */
  #lastActiveEditor: ActiveEditorItem | undefined;
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
    // A hidden view is a destroyed page (`retainContextWhenHidden` is off), so
    // this is where a permission card stops being answerable. The host is told
    // rather than guessing, and it escalates.
    view.onDidChangeVisibility(() => {
      this.#handlers.onVisibility?.(view.visible);
    });
    view.onDidDispose(() => {
      this.#view = undefined;
      this.#pageReady = false;
      this.#handlers.onVisibility?.(false);
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
   * Put text in the composer for the user to read, edit and send.
   *
   * Deliberately not retained the way `postState` and `postCost` are: a
   * prefill is a one-shot offer, and replaying it when the view is revealed
   * again would overwrite whatever the user had typed since.
   */
  prefillComposer(text: string): void {
    this.#post({ type: "prefill", text });
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
  postContext(items: ContextItem[], active?: ActiveEditorItem): void {
    this.#lastContext = items;
    this.#lastActiveEditor = active;
    this.#post(contextMessage(items, active));
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
   * Push the permission request the panel should ask about — or, with no
   * argument, take down whatever card is up.
   *
   * The host is the only thing that raises a card and the only thing that
   * lowers one; the page renders what arrives and posts back which button was
   * pressed. See `permission-surface.ts` for why that split is what keeps an
   * in-panel prompt sound.
   *
   * @param card - The request, projected from the engine's own words.
   */
  postPermissionAsk(card?: PermissionCard): void {
    this.#lastPermissionAsk = card;
    this.#post(
      card === undefined ? { type: "permissionAsk" } : { type: "permissionAsk", request: card },
    );
  }

  /**
   * Put a count on the view's activity-bar icon, or clear it with `0`.
   *
   * The third leg of the answer to "what if nobody is looking at the panel".
   * Revealing handles the moment a request arrives and the modal handles a
   * panel that would not come up, but a user who hides the panel *between*
   * requests still needs to be told that the agent is waiting on them — and
   * the activity bar is visible in every editor layout that has one, including
   * the one where the Arcturn container is not the container in front.
   *
   * @param pending - Requests the engine is still waiting on.
   */
  postBadge(pending: number): void {
    const view = this.#view;
    if (view === undefined) return;
    view.badge =
      pending > 0
        ? {
            value: pending,
            tooltip:
              pending === 1
                ? "Arcturn is waiting for a permission decision"
                : `Arcturn is waiting on ${String(pending)} permission decisions`,
          }
        : undefined;
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

  /**
   * Push the turns this session could be rewound to.
   *
   * Remembered and replayed on the same terms as the review card, and the
   * `note` dropped for the same reason: a refusal is about one attempt, and
   * replaying "a run is in flight" into a panel reopened an hour later would
   * be false.
   *
   * @param view - See {@link RewindView}.
   */
  postRewind(view: RewindView): void {
    const { note: _note, ...remembered } = view;
    this.#lastRewind = remembered;
    this.#post({ type: "rewind", view });
  }

  /**
   * Push the workflow catalog and the run being followed.
   *
   * Remembered and replayed on the review card's terms, and the `note` dropped
   * for the same reason: a refusal is about one attempt, and replaying "the
   * engine refused" into a panel reopened an hour later would be false.
   *
   * The *run* is remembered, which is deliberate and is the point of this
   * surface: a pipeline outlives the panel being hidden, so a person who
   * collapsed the sidebar mid-run and came back to it finds the card where they
   * left it — including a question it is still waiting on.
   *
   * @param view - See {@link WorkflowView}.
   */
  postWorkflows(view: WorkflowView): void {
    const { note: _note, ...remembered } = view;
    this.#lastWorkflows = remembered;
    this.#post({ type: "workflows", view });
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

  /** Whether the view is on screen right now. */
  get visible(): boolean {
    return this.#view?.visible === true;
  }

  /**
   * Reveal the view, resolving it if it has never been opened.
   *
   * @returns Whether the view is visible now. `false` is a real answer, not a
   *   thrown one: the permission surface treats it as "ask natively instead",
   *   and a request must never be left with no surface at all.
   */
  async reveal(): Promise<boolean> {
    const existing = this.#view;
    if (existing === undefined) {
      // No view object at all — never opened (a palette command can start the
      // engine without it), or removed from the container. The workbench
      // synthesises `<id>.focus` for every registered view, and executing it is
      // what makes VS Code call `resolveWebviewView`.
      await vscode.commands.executeCommand(`${SidebarViewProvider.viewId}.focus`);
    } else {
      // `show(true)` — preserveFocus. A permission prompt should put itself
      // where the user can see it without taking the caret out of whatever they
      // were typing: the half of a modal's behaviour worth keeping, without the
      // half worth losing.
      existing.show(true);
    }
    // Re-read: the focus command above is what creates it in the first branch.
    const view = this.#view;
    if (view === undefined) return false;
    if (view.visible) return true;
    return await this.#settleVisible(view);
  }

  /**
   * Wait out the frame between asking a view to show and its saying it did.
   *
   * Resolves early on the first visibility change, so the common case costs a
   * tick rather than the whole timeout, and resolves `false` when the
   * workbench simply did not show it.
   */
  async #settleVisible(view: vscode.WebviewView): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        subscription.dispose();
        clearTimeout(timer);
        resolve(value);
      };
      const subscription = view.onDidChangeVisibility(() => finish(view.visible));
      const timer = setTimeout(() => finish(view.visible), REVEAL_SETTLE_MS);
    });
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
    if (this.#lastContext !== undefined) {
      this.#post(contextMessage(this.#lastContext, this.#lastActiveEditor));
    }
    if (this.#lastPermission !== undefined) this.#post(permissionMessage(this.#lastPermission));
    // Before the rest of the furniture rather than after: a reloaded page that
    // is holding a live permission request should paint it in the first frame,
    // not once the model list has arrived.
    if (this.#lastPermissionAsk !== undefined) {
      this.#post({ type: "permissionAsk", request: this.#lastPermissionAsk });
    }
    if (this.#lastCommands !== undefined) {
      this.#post({
        type: "commands",
        status: this.#lastCommands.status,
        commands: this.#lastCommands.commands,
      });
    }
    if (this.#lastDryRun !== undefined) this.#post({ type: "dryRun", view: this.#lastDryRun });
    if (this.#lastRewind !== undefined) this.#post({ type: "rewind", view: this.#lastRewind });
    if (this.#lastWorkflows !== undefined) {
      this.#post({ type: "workflows", view: this.#lastWorkflows });
    }
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

/** Build the `context` message, omitting the ambient chip rather than sending `undefined`. */
function contextMessage(items: ContextItem[], active?: ActiveEditorItem): HostMessage {
  return { type: "context", items, ...(active === undefined ? {} : { active }) };
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
