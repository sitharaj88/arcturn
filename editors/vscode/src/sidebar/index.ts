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
import type { ChatViewModel } from "./chat-state.js";
import { createCoalescer } from "./coalesce.js";
import { type ConnectionActionId, type ConnectionReport, reportText } from "./connection-card.js";
import { costBreakdown, costLabel } from "./cost.js";
import { answerFromChoice, permissionChoices } from "./dialog.js";
import { createEngineSession, type EngineSession } from "./engine-session.js";
import { describePermissionRequest } from "./permission-queue.js";
import { modelPickItems, sessionPickItems } from "./picker.js";
import { CostStatusBar } from "./status-bar.js";
import { SidebarViewProvider } from "./view.js";

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
      withEngine(async (session) => {
        await session.newSession();
        await provider.reveal();
      }),
    ),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.showSessions, () =>
      withEngine(async (session) => {
        const headers = await session.listSessions();
        const active = session.controller?.sessionId;
        const items = sessionPickItems(headers, {
          cwd: workspaceCwd(),
          ...(active === undefined ? {} : { activeSessionId: active }),
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: "Arcturn sessions",
          placeHolder: "Open a session, or start a new one",
        });
        if (picked === undefined) return;
        if (picked.action === "new" || picked.sessionId === undefined) {
          await session.newSession();
        } else {
          await session.openSession(picked.sessionId);
        }
        await provider.reveal();
      }),
    ),
    vscode.commands.registerCommand(SIDEBAR_COMMANDS.selectModel, () =>
      withEngine(async (session) => {
        const controller = session.controller;
        if (controller === undefined) return;
        const configured = vscode.workspace.getConfiguration("arcturn").get<string>("defaultModel");
        // `listModels` is an optional verb: an older engine answers
        // `undefined`, and anything else that goes wrong here is a
        // diagnostic, not a reason to deny the user a picker. Either way the
        // catalog is simply absent and the pre-catalog rows still render.
        const catalog = await session.listModels().catch((error: unknown) => {
          log(
            `sidebar: model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
        const items = modelPickItems({
          ...(catalog === undefined ? {} : { catalog }),
          observed: controller.observedModels,
          ...(configured === undefined || configured === "" ? {} : { configured }),
          ...(controller.state.model === undefined ? {} : { current: controller.state.model }),
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: "Arcturn model",
          placeHolder:
            catalog === undefined
              ? "Switch the model for this session"
              : `Switch the model for this session (${catalog.length} available)`,
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
        await controller.setModel(modelId.trim());
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
