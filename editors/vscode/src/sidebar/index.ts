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
import type { WebSocketLike } from "../serve/engine.js";
import { createRedactor } from "../serve/redact.js";
import type { SpawnLike } from "../serve/supervisor.js";
import { generateToken } from "../serve/token.js";
import { forgetFailedUserEnvironment, resolveUserEnvironment } from "../user-env.js";
import { type ChatViewModel, toViewModel } from "./chat-state.js";
import { createCoalescer } from "./coalesce.js";
import { type ConnectionActionId, type ConnectionReport, reportText } from "./connection-card.js";
import { costBreakdown, costLabel } from "./cost.js";
import { answerFromChoice, permissionChoices } from "./dialog.js";
import { createEngineSession, type EngineSession } from "./engine-session.js";
import { describePermissionRequest } from "./permission-queue.js";
import { escapeCodicons, modelPickItems } from "./picker.js";
import { CostStatusBar } from "./status-bar.js";
import { SidebarViewProvider } from "./view.js";
import {
  type ModelListStatus,
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
        case "send":
          void withEngine((session) => session.controller?.send(message.text));
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
      repaintTranscript();
      publishSession();
      await publishSessions();
    });
  }

  /** Start a session, and put it in the list the panel shows. */
  async function startNewSession(session: EngineSession): Promise<void> {
    await session.newSession();
    selectedModel = undefined;
    repaintTranscript();
    // A session that exists now was not in the cached list.
    sessions = undefined;
    publishSession();
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
