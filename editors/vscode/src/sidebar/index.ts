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
import type { ChatViewModel } from "./chat-state.js";
import { createCoalescer } from "./coalesce.js";
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
        case "reconnect":
          void restart();
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
      log,
      ...(port === undefined ? {} : { port }),
      ...(model === undefined || model === "" ? {} : { model }),
      host: {
        onChat: (state) => states.push(state),
        onCost: (cost) => {
          statusBar.update(cost);
          provider.postCost(costLabel(cost));
        },
        onConnection: (status, detail) => {
          provider.postConnection(status, detail);
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

  async function start(): Promise<void> {
    await ensureEngine().start();
  }

  async function restart(): Promise<void> {
    await ensureEngine().restart();
  }

  /** Run `action` against a started engine, surfacing failures as a card. */
  async function withEngine(
    action: (session: EngineSession) => Promise<void> | undefined,
  ): Promise<void> {
    const session = ensureEngine();
    await session.start();
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
        const items = modelPickItems({
          observed: controller.observedModels,
          ...(configured === undefined || configured === "" ? {} : { configured }),
          ...(controller.state.model === undefined ? {} : { current: controller.state.model }),
        });
        const picked = await vscode.window.showQuickPick(items, {
          title: "Arcturn model",
          placeHolder: "Switch the model for this session",
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
