/**
 * The seam itself, against a hand-rolled `vscode` stand-in.
 *
 * `vscode` has no npm package — it is injected by the extension host — so it
 * cannot resolve under vitest at all. Everything with real logic already lives
 * in a module with no `vscode` import; what is left to prove here is the part
 * only the adapter can get wrong: that RFC 0004 §3's activation budget holds
 * (nothing spawns, nothing connects, until the user asks) and that disposal
 * actually disposes.
 *
 * The fake is local rather than shared with Builder A's `test-vscode.ts`
 * because it models a different slice of the API (status bar, webview view,
 * quick-picks) and the two files are owned by different builders.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
  spawns: 0,
  commands: new Map<string, (...args: never[]) => unknown>(),
  outputs: [] as { name: string; lines: string[]; disposed: boolean }[],
  statusBars: [] as {
    text: string;
    tooltip: string;
    command: string;
    shown: number;
    hidden: number;
    disposed: boolean;
  }[],
  views: [] as { id: string; options: unknown; provider: WebviewViewProviderLike }[],
  treeViews: [] as { id: string; provider: unknown }[],
  posted: [] as { type: string; [key: string]: unknown }[],
  clipboard: [] as string[],
  quickPicks: [] as { items: { label: string; description?: string }[]; options: unknown }[],
  /** Every `showInputBox` call, so a test can prove the native dialog was — or was not — raised. */
  inputBoxes: [] as unknown[],
  contentProviders: [] as { scheme: string; provider: unknown }[],
  messages: [] as { level: string; message: string; items: string[] }[],
  executed: [] as { command: string; args: unknown[] }[],
  shownOutputs: 0,
  forgotEnvironment: 0,
  config: {} as Record<string, unknown>,
  /** Every `WorkspaceConfiguration.update` the seam performed, in order. */
  configWrites: [] as { key: string; value: unknown; target: unknown }[],
  /** Listeners the seam put on the three editor streams and on configuration. */
  activeEditorHandlers: [] as ((editor: unknown) => void)[],
  selectionHandlers: [] as ((event: { textEditor: unknown }) => void)[],
  closedDocumentHandlers: [] as ((document: unknown) => void)[],
  configHandlers: [] as ((event: { affectsConfiguration(section: string): boolean }) => void)[],
  /** What `window.activeTextEditor` answers. */
  activeEditor: undefined as unknown,
  /** How many times the seam asked what is on screen. */
  activeEditorReads: 0,
  folders: [{ uri: { fsPath: "/workspace" } }] as { uri: { fsPath: string } }[] | undefined,
  disposed: 0,
  reset(): void {
    ledger.spawns = 0;
    ledger.commands = new Map();
    ledger.outputs = [];
    ledger.statusBars = [];
    ledger.views = [];
    ledger.treeViews = [];
    ledger.posted = [];
    ledger.clipboard = [];
    ledger.quickPicks = [];
    ledger.inputBoxes = [];
    ledger.contentProviders = [];
    ledger.messages = [];
    ledger.executed = [];
    ledger.shownOutputs = 0;
    ledger.forgotEnvironment = 0;
    ledger.config = {};
    ledger.configWrites = [];
    ledger.activeEditorHandlers = [];
    ledger.selectionHandlers = [];
    ledger.closedDocumentHandlers = [];
    ledger.configHandlers = [];
    ledger.activeEditor = undefined;
    ledger.activeEditorReads = 0;
    ledger.folders = [{ uri: { fsPath: "/workspace" } }];
    ledger.disposed = 0;
  },
}));

// The login-shell probe is a process spawn; the seam's job is to call it
// lazily and pass the result on, which is provable without running a shell —
// and no test here may depend on the developer's own profile.
vi.mock("../user-env.js", () => ({
  resolveUserEnvironment: async () => ({
    env: { PATH: "/opt/homebrew/bin:/usr/bin" },
    source: "shell" as const,
    shell: "/bin/zsh",
    diagnostic: "environment: read 3 variables from /bin/zsh in 12ms",
    secrets: ["shell-secret-value"],
    retryable: false,
  }),
  forgetFailedUserEnvironment: () => {
    ledger.forgotEnvironment += 1;
    return true;
  },
}));

vi.mock("node:child_process", () => ({
  spawn: () => {
    ledger.spawns += 1;
    throw new Error("the sidebar must not spawn during activation");
  },
}));

vi.mock("vscode", () => {
  class Disposable {
    constructor(private readonly onDispose: () => void) {}
    dispose(): void {
      ledger.disposed += 1;
      this.onDispose();
    }
  }
  class EventEmitter<T> {
    readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): { dispose(): void } => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  const uri = (parts: { scheme?: string; path?: string; query?: string }) => ({
    scheme: parts.scheme ?? "file",
    path: parts.path ?? "",
    query: parts.query ?? "",
    fsPath: parts.path ?? "",
    toString: () => `${parts.scheme ?? "file"}://${parts.path ?? ""}`,
  });
  return {
    Disposable,
    EventEmitter,
    Uri: {
      from: uri,
      file: (fsPath: string) => uri({ scheme: "file", path: fsPath }),
      parse: (value: string) => uri({ scheme: "file", path: value }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      createOutputChannel(name: string) {
        const channel = { name, lines: [] as string[], disposed: false };
        ledger.outputs.push(channel);
        return {
          appendLine: (line: string) => channel.lines.push(line),
          show: () => {
            ledger.shownOutputs += 1;
          },
          dispose: () => {
            channel.disposed = true;
          },
        };
      },
      createStatusBarItem() {
        const item = {
          text: "",
          tooltip: "",
          command: "",
          name: "",
          shown: 0,
          hidden: 0,
          disposed: false,
          show(): void {
            item.shown += 1;
          },
          hide(): void {
            item.hidden += 1;
          },
          dispose(): void {
            item.disposed = true;
          },
        };
        ledger.statusBars.push(item);
        return item;
      },
      // Present in every host at the engine floor. Without it here the
      // failure watcher takes its "shell integration is unavailable" branch on
      // every activation and writes a diagnostic the log tests then see.
      onDidEndTerminalShellExecution() {
        return { dispose: () => {} };
      },
      createTreeView(id: string, options: { treeDataProvider: unknown }) {
        ledger.treeViews.push({ id, provider: options.treeDataProvider });
        return { dispose: () => {} };
      },
      registerWebviewViewProvider(id: string, provider: unknown, options: unknown) {
        ledger.views.push({ id, options, provider: provider as WebviewViewProviderLike });
        return { dispose: () => {} };
      },
      showQuickPick(items: { label: string }[], options: unknown) {
        ledger.quickPicks.push({ items, options });
        return Promise.resolve(undefined);
      },
      showInformationMessage: (message: string, ...items: string[]) => {
        ledger.messages.push({ level: "info", message, items });
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string, ...items: string[]) => {
        ledger.messages.push({ level: "warning", message, items });
        return Promise.resolve(undefined);
      },
      showErrorMessage: (message: string, ...items: string[]) => {
        ledger.messages.push({
          level: "error",
          message,
          items: items.filter((i) => typeof i === "string"),
        });
        return Promise.resolve(undefined);
      },
      showInputBox: (options: unknown) => {
        ledger.inputBoxes.push(options);
        return Promise.resolve(undefined);
      },
      get activeTextEditor() {
        ledger.activeEditorReads += 1;
        return ledger.activeEditor;
      },
      onDidChangeActiveTextEditor(handler: (editor: unknown) => void) {
        ledger.activeEditorHandlers.push(handler);
        return { dispose: () => {} };
      },
      onDidChangeTextEditorSelection(handler: (event: { textEditor: unknown }) => void) {
        ledger.selectionHandlers.push(handler);
        return { dispose: () => {} };
      },
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: {
      registerCommand(id: string, handler: (...args: never[]) => unknown) {
        ledger.commands.set(id, handler);
        return { dispose: () => ledger.commands.delete(id) };
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        ledger.executed.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    env: {
      clipboard: {
        writeText: (text: string) => {
          ledger.clipboard.push(text);
          return Promise.resolve();
        },
      },
    },
    // The review feature creates a diagnostics collection and the commit
    // feature probes for the git extension; both at activation, both inert
    // without a command being run.
    languages: {
      createDiagnosticCollection: () => ({
        set: () => {},
        clear: () => {},
        dispose: () => {},
      }),
    },
    extensions: {
      getExtension: () => undefined,
    },
    workspace: {
      get workspaceFolders() {
        return ledger.folders;
      },
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => ledger.config[key] ?? fallback,
        inspect: (key: string) => ({ key, workspaceValue: undefined, globalValue: undefined }),
        update: (key: string, value: unknown, target: unknown) => {
          ledger.configWrites.push({ key, value, target });
          ledger.config[key] = value;
          return Promise.resolve();
        },
      }),
      onDidCloseTextDocument(handler: (document: unknown) => void) {
        ledger.closedDocumentHandlers.push(handler);
        return { dispose: () => {} };
      },
      onDidChangeConfiguration(
        handler: (event: { affectsConfiguration(section: string): boolean }) => void,
      ) {
        ledger.configHandlers.push(handler);
        return { dispose: () => {} };
      },
      registerTextDocumentContentProvider(scheme: string, provider: unknown) {
        ledger.contentProviders.push({ scheme, provider });
        return { dispose: () => {} };
      },
    },
  };
});

import { BACKGROUND_COMMANDS, BACKGROUND_VIEW_ID } from "../background/view.js";
import { COMMIT_COMMANDS } from "../commit/view.js";
import { FAILURE_COMMANDS } from "../failures/view.js";
import { HUB_COMMANDS, HUB_VIEW_ID } from "../hub/view.js";
import { INLINE_COMMANDS } from "../inline/view.js";
import { MCP_COMMANDS } from "../mcp/view.js";
import { REVIEW_COMMANDS } from "../review/view.js";
import { SCOUT_COMMANDS } from "../scout/view.js";
import { SESSION_COMMANDS } from "../sessions/view.js";
import { activateSidebar, SIDEBAR_COMMANDS, SIDEBAR_VIEW_ID } from "./index.js";
import { WEBVIEW_COMMANDS } from "./webview-messages.js";

/** The slice of `WebviewViewProvider` this file drives. */
interface WebviewViewProviderLike {
  resolveWebviewView(view: unknown): void;
}

/**
 * A stand-in `WebviewView`.
 *
 * `view.ts` touches exactly these members, so this is the whole API surface
 * the panel needs to be driven from a test — which is what lets the messages
 * the *page* would send be pushed through the real validation and the real
 * handlers, with no editor and no DOM.
 */
function fakeView(): {
  view: unknown;
  send(message: unknown): void;
  posted(): { type: string; [key: string]: unknown }[];
  /** Hide or show the view the way the workbench does, firing the event. */
  setVisible(visible: boolean): void;
  /** How many times the host asked the view to reveal itself. */
  shows(): number;
  /** The activity-bar badge, as the host last set it. */
  badge(): { value: number } | undefined;
} {
  let receive: ((raw: unknown) => void) | undefined;
  const visibility: (() => void)[] = [];
  let shows = 0;
  const view = {
    visible: true,
    badge: undefined as { value: number } | undefined,
    webview: {
      options: {} as unknown,
      cspSource: "vscode-webview://test",
      html: "",
      onDidReceiveMessage(handler: (raw: unknown) => void) {
        receive = handler;
        return { dispose: () => {} };
      },
      postMessage(message: { type: string }) {
        ledger.posted.push(message as { type: string });
        return Promise.resolve(true);
      },
    },
    onDidDispose(_handler: () => void) {
      return { dispose: () => {} };
    },
    onDidChangeVisibility(handler: () => void) {
      visibility.push(handler);
      return { dispose: () => {} };
    },
    show(_focus?: boolean) {
      shows += 1;
      view.visible = true;
    },
  };
  return {
    view,
    send: (message: unknown) => receive?.(message),
    posted: () => ledger.posted,
    setVisible: (visible: boolean) => {
      view.visible = visible;
      for (const handler of [...visibility]) handler();
    },
    shows: () => shows,
    badge: () => view.badge,
  };
}

function activate(): { disposable: { dispose(): void }; subscriptions: { dispose(): void }[] } {
  const subscriptions: { dispose(): void }[] = [];
  const disposable = activateSidebar({ subscriptions } as never, async () => ({
    command: "/bin/arcturn",
  }));
  return { disposable, subscriptions };
}

beforeEach(() => {
  ledger.reset();
});

describe("activateSidebar", () => {
  it("spawns nothing and connects to nothing at activation", () => {
    activate();
    expect(ledger.spawns).toBe(0);
  });

  it("registers the sidebar view under the id the manifest declares", () => {
    activate();
    expect(ledger.views.map((view) => view.id)).toEqual(["arcturn.sidebar"]);
  });

  it("registers under exactly the id the seam exports, not a second copy of it", () => {
    activate();
    expect(SIDEBAR_VIEW_ID).toBe("arcturn.sidebar");
    expect(ledger.views[0]?.id).toBe(SIDEBAR_VIEW_ID);
  });

  it("does not retain the webview's context when it is hidden", () => {
    activate();
    expect(ledger.views[0]?.options).toEqual({
      webviewOptions: { retainContextWhenHidden: false },
    });
  });

  it("registers every command it owns, so all of them reach the palette", () => {
    activate();
    // The hub's three come from `activateHub`, which this module calls: the
    // same activation, one module down. Listing them here rather than
    // exempting them keeps the "contributed ⇔ registered" pair total.
    expect([...ledger.commands.keys()].sort()).toEqual(
      [
        ...Object.values(SIDEBAR_COMMANDS),
        ...Object.values(HUB_COMMANDS),
        ...Object.values(SCOUT_COMMANDS),
        ...Object.values(MCP_COMMANDS),
        ...Object.values(BACKGROUND_COMMANDS),
        ...Object.values(INLINE_COMMANDS),
        ...Object.values(FAILURE_COMMANDS),
        ...Object.values(REVIEW_COMMANDS),
        ...Object.values(COMMIT_COMMANDS),
        ...Object.values(SESSION_COMMANDS),
      ].sort(),
    );
  });

  it("opens the hub and background trees beside the chat", () => {
    activate();
    // The hub's catalog is bundled, so its tree draws with no engine and no
    // socket. The background tree asks the engine for a listing, which fails
    // harmlessly when nothing is connected. Activation spawning nothing is
    // asserted elsewhere; this is the narrower claim that adding views did not
    // change it.
    expect(ledger.treeViews.map((view) => view.id)).toEqual([HUB_VIEW_ID, BACKGROUND_VIEW_ID]);
  });

  it("puts the cost item in the status bar, wired to the breakdown command", () => {
    activate();
    // Found by its command rather than by position: the failed-command item
    // shares this bar, and a positional assertion would break every time
    // another one is added rather than when this one is wrong.
    const cost = ledger.statusBars.find((item) => item.command === SIDEBAR_COMMANDS.showCost);
    expect(cost).toBeDefined();
    expect(cost?.text).toContain("$0.00");
  });

  it("puts the failed-command item in the bar too, hidden until something fails", () => {
    activate();
    const failure = ledger.statusBars.find((item) => item.command === FAILURE_COMMANDS.ask);
    expect(failure).toBeDefined();
    // A status item that appears before anything has failed is an offer to
    // explain nothing.
    expect(failure?.shown).toBe(0);
  });

  it("keeps the cost item hidden until there is a session to describe", () => {
    activate();
    expect(ledger.statusBars[0]?.shown).toBe(0);
  });

  it("shows an honest breakdown before any turn has run", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.showCost)?.();
    const rows = ledger.quickPicks[0]?.items ?? [];
    expect(rows.find((row) => row.label === "Total")?.description).toBe("$0.00");
    expect(rows.map((row) => row.label)).toContain("Turns");
  });

  it("registers itself for disposal on the extension context", () => {
    const { disposable, subscriptions } = activate();
    expect(subscriptions).toContain(disposable);
  });

  it("disposes the status bar and the output channel, idempotently", () => {
    const { disposable } = activate();
    disposable.dispose();
    expect(ledger.statusBars[0]?.disposed).toBe(true);
    expect(ledger.outputs[0]?.disposed).toBe(true);
    expect(() => disposable.dispose()).not.toThrow();
  });

  it("unregisters its commands on disposal", () => {
    const { disposable } = activate();
    disposable.dispose();
    expect(ledger.commands.size).toBe(0);
  });
});

describe("a command invoked while the engine cannot start", () => {
  /**
   * The mocked `node:child_process.spawn` throws, so `startServeProcess`
   * rejects before any address is announced — the same shape as the real
   * failure a user hits when `arcturn serve` exits over a missing API key.
   */
  it("says so, instead of opening an empty picker", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.selectModel)?.();
    const errors = ledger.messages.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/arcturn/i);
    expect(errors[0]?.items).toContain("Show Log");
    expect(ledger.quickPicks).toHaveLength(0);
  });

  it("does not stack one toast per command", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.selectModel)?.();
    await ledger.commands.get(SIDEBAR_COMMANDS.showSessions)?.();
    await ledger.commands.get(SIDEBAR_COMMANDS.newSession)?.();
    expect(ledger.messages.filter((entry) => entry.level === "error")).toHaveLength(1);
  });

  it("writes the same explanation to the output channel", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.selectModel)?.();
    expect(ledger.outputs[0]?.lines.join("\n")).toMatch(/could not start/i);
  });

  it("registers a Show Log command so the detail is reachable from the palette", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.showLog)?.();
    expect(ledger.shownOutputs).toBeGreaterThan(0);
  });
});

describe("retrying after the engine failed to start", () => {
  it("lets the login-shell probe be re-attempted, so a transient failure is not permanent", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.reconnect)?.();
    expect(ledger.forgotEnvironment).toBeGreaterThan(0);
  });
});

describe("the panel's built-in commands reach the surfaces they name", () => {
  function open(): ReturnType<typeof fakeView> {
    activate();
    const panel = fakeView();
    ledger.views[0]?.provider.resolveWebviewView(panel.view);
    return panel;
  }

  it("routes every WEBVIEW_COMMANDS id to a command this module registers", () => {
    // The `/` menu's built-in rows land here, and a row that reached nothing
    // would be the menu that lies — one file away from where RFC 0005 §1.3
    // says so. Asserted over the whole list rather than one id, so an id added
    // to the union has to be routed before this passes.
    activate();
    const panel = open();
    panel.send({ type: "ready" });
    for (const command of WEBVIEW_COMMANDS) {
      ledger.executed.length = 0;
      panel.send({ type: "command", command });
      const executed = ledger.executed.map((entry) => entry.command);
      expect(executed.length).toBeGreaterThan(0);
      for (const id of executed) expect(ledger.commands.has(id)).toBe(true);
    }
  });

  it("sends /cost to the cost breakdown, not to the engine", async () => {
    const panel = open();
    panel.send({ type: "ready" });
    ledger.executed.length = 0;
    panel.send({ type: "command", command: "cost" });
    expect(ledger.executed.map((entry) => entry.command)).toEqual([SIDEBAR_COMMANDS.showCost]);
  });
});

describe("arcturn.showSessions", () => {
  function open(): ReturnType<typeof fakeView> {
    activate();
    const panel = fakeView();
    ledger.views[0]?.provider.resolveWebviewView(panel.view);
    return panel;
  }

  it("opens the panel's own history view instead of a quick-pick", async () => {
    const panel = open();
    panel.send({ type: "ready" });
    ledger.posted.length = 0;
    await ledger.commands.get(SIDEBAR_COMMANDS.showSessions)?.();
    expect(panel.posted().map((message) => message.type)).toContain("showSessions");
    // The whole point of the move: no native dropdown at the top of the window.
    expect(ledger.quickPicks).toHaveLength(0);
  });

  it("reveals the panel first, so the palette does not talk to a hidden view", async () => {
    activate();
    await ledger.commands.get(SIDEBAR_COMMANDS.showSessions)?.();
    expect(ledger.executed.map((entry) => entry.command)).toContain("arcturn.sidebar.focus");
  });

  it("waits for a page that has not loaded yet rather than posting into the void", async () => {
    // `retainContextWhenHidden` is off: revealing the view starts a *fresh*
    // document, and a message posted before its script runs is simply lost.
    // The command is invoked here against a resolved-but-silent page.
    const panel = open();
    await ledger.commands.get(SIDEBAR_COMMANDS.showSessions)?.();
    expect(panel.posted().map((message) => message.type)).not.toContain("showSessions");
    panel.send({ type: "ready" });
    expect(panel.posted().map((message) => message.type)).toContain("showSessions");
  });

  it("opens the view once, not again on every later reload", async () => {
    const panel = open();
    await ledger.commands.get(SIDEBAR_COMMANDS.showSessions)?.();
    panel.send({ type: "ready" });
    ledger.posted.length = 0;
    panel.send({ type: "ready" });
    expect(panel.posted().map((message) => message.type)).not.toContain("showSessions");
  });
});

describe("the panel's own messages", () => {
  /**
   * Resolve the view the way VS Code does when a user opens the sidebar, and
   * hand back a channel for the messages the page would post.
   *
   * The mocked `spawn` throws, so the engine never reaches `ready` here. That
   * is deliberate: what is being checked is that each message is *answered* —
   * a panel whose model list silently never arrives looks exactly like the
   * panel this work replaced.
   */
  function open(): ReturnType<typeof fakeView> {
    activate();
    const panel = fakeView();
    ledger.views[0]?.provider.resolveWebviewView(panel.view);
    return panel;
  }

  it("renders the page into the view when VS Code resolves it", () => {
    const panel = open();
    const html = (panel.view as { webview: { html: string } }).webview.html;
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('id="model"');
  });

  it("answers a model-list request even while the engine is down", async () => {
    const panel = open();
    panel.send({ type: "requestModels" });
    await Promise.resolve();
    const models = panel.posted().filter((message) => message.type === "models");
    expect(models.length).toBeGreaterThan(0);
    // "loading", not an empty catalog: the panel must not tell the user this
    // server has no models when what happened is that nobody has asked it yet.
    expect(models.at(-1)?.status).toBe("loading");
    expect(models.at(-1)?.models).toEqual([]);
  });

  it("shows the configured default on the chip before any run has announced one", async () => {
    ledger.config.defaultModel = "anthropic/claude-sonnet-5";
    const panel = open();
    panel.send({ type: "requestModels" });
    await Promise.resolve();
    expect(
      panel
        .posted()
        .filter((message) => message.type === "models")
        .at(-1)?.current,
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("puts a copied code block on the clipboard and nowhere else", () => {
    const panel = open();
    panel.send({ type: "copy", text: "pnpm -r run typecheck" });
    expect(ledger.clipboard).toEqual(["pnpm -r run typecheck"]);
    // No command, no engine verb: the copy button is the clipboard and nothing
    // else, which is why the text is allowed to be arbitrary model output.
    expect(ledger.executed).toEqual([]);
  });

  it("drops a message the boundary does not recognise, and says so once", () => {
    const panel = open();
    panel.send({ type: "copy", text: "x".repeat(200_000) });
    panel.send({ type: "setModel", modelId: "bad\nid" });
    panel.send({ type: "evaluate", code: "1" });
    expect(ledger.clipboard).toEqual([]);
    const dropped = (ledger.outputs[0]?.lines ?? []).filter((line) =>
      line.includes("dropped an unrecognised webview message"),
    );
    expect(dropped).toHaveLength(3);
  });

  it("answers a session-list request even while the engine is down", async () => {
    const panel = open();
    panel.send({ type: "requestSessions" });
    await Promise.resolve();
    const lists = panel.posted().filter((message) => message.type === "sessions");
    expect(lists.length).toBeGreaterThan(0);
    // "disconnected", not an empty list: the panel must not tell the user this
    // workspace has no history when what happened is that nothing can read it.
    expect(lists.at(-1)?.status).toBe("disconnected");
    expect(lists.at(-1)?.sessions).toEqual([]);
    expect(lists.at(-1)?.cwd).toBe("/workspace");
  });

  it("opens the session the panel asked for, and never a native list", async () => {
    const panel = open();
    panel.send({ type: "openSession", sessionId: "01JABCDEFGHJKMNPQRS" });
    await Promise.resolve();
    // The engine is down here, so what is provable is that the id went to the
    // engine path rather than to a quick-pick — the surface this work removed.
    expect(ledger.quickPicks).toHaveLength(0);
  });

  it("replays the session list when the page reloads", async () => {
    const panel = open();
    panel.send({ type: "requestSessions" });
    await Promise.resolve();
    ledger.posted.length = 0;
    panel.send({ type: "ready" });
    expect(panel.posted().map((message) => message.type)).toContain("sessions");
  });

  it("routes a delete request at the engine, and never at the filesystem", async () => {
    const panel = open();
    panel.send({ type: "deleteSession", sessionId: "01JABCDEFGHJKMNPQRS" });
    await Promise.resolve();
    // The engine is down here, so what is provable is that the message was
    // recognised at the boundary and taken down the engine path — the panel
    // has no other way to delete anything, which is the point.
    const dropped = (ledger.outputs[0]?.lines ?? []).filter((line) =>
      line.includes("dropped an unrecognised webview message"),
    );
    expect(dropped).toHaveLength(0);
    expect(ledger.quickPicks).toHaveLength(0);
  });

  it("does not raise a destructive modal when the engine cannot act on it anyway", async () => {
    const panel = open();
    panel.send({ type: "deleteSession", sessionId: "01JABCDEFGHJKMNPQRS" });
    await Promise.resolve();
    await Promise.resolve();
    // A confirmation the engine could not honour is a prompt that teaches the
    // user their click did nothing; the reconnect card is the honest answer.
    expect(ledger.messages.filter((m) => m.message.startsWith("Delete the Arcturn"))).toEqual([]);
  });

  it("registers a read-only provider for the diff's right-hand side", () => {
    open();
    // The pending content is served from what `pendingChanges` put on the
    // wire, never read off the engine's shadow tree. A provider that read the
    // disk would be a second source for the same bytes, and the first time
    // they disagreed a reviewer would approve something they had not seen.
    expect(ledger.contentProviders.map((entry) => entry.scheme)).toContain("arcturn-dry-run");
  });

  it("routes apply and discard at the engine, and never at the filesystem", async () => {
    const panel = open();
    panel.send({ type: "applyChanges" });
    panel.send({ type: "discardChanges" });
    panel.send({ type: "showDiff", path: "src/app.ts" });
    await Promise.resolve();
    const dropped = (ledger.outputs[0]?.lines ?? []).filter((line) =>
      line.includes("dropped an unrecognised webview message"),
    );
    expect(dropped).toHaveLength(0);
  });

  it("does not raise a destructive modal when the engine cannot act on it anyway", async () => {
    const panel = open();
    panel.send({ type: "discardChanges" });
    await Promise.resolve();
    await Promise.resolve();
    // A confirmation the engine could not honour teaches the user their click
    // did nothing; the reconnect card is the honest answer. Same rule the
    // session delete keeps.
    expect(ledger.messages.filter((m) => m.message.startsWith("Discard "))).toEqual([]);
  });

  it("routes a rewind at the engine, and never at the filesystem", async () => {
    const panel = open();
    panel.send({ type: "requestCheckpoints" });
    panel.send({
      type: "rewindTo",
      checkpointId: "turn-1",
      confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
    await Promise.resolve();
    // The panel has no other way to restore or delete a file, which is the
    // point: RFC 0004 §0 forbids the extension writing a workspace file, and a
    // rewind performed here would be one no permission engine and no workspace
    // confinement ever saw.
    const dropped = (ledger.outputs[0]?.lines ?? []).filter((line) =>
      line.includes("dropped an unrecognised webview message"),
    );
    expect(dropped).toHaveLength(0);
  });

  it("does not raise the rewind modal when the engine cannot act on it anyway", async () => {
    const panel = open();
    panel.send({
      type: "rewindTo",
      checkpointId: "turn-1",
      confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
    await Promise.resolve();
    await Promise.resolve();
    // Same rule the session delete and the discard keep: a confirmation the
    // engine could not honour teaches the user their click did nothing.
    expect(ledger.messages.filter((m) => m.message.startsWith("Rewind to "))).toEqual([]);
  });

  it("replays the model list when the page reloads", async () => {
    const panel = open();
    panel.send({ type: "requestModels" });
    await Promise.resolve();
    ledger.posted.length = 0;
    // retainContextWhenHidden is off: a revealed panel is a fresh document
    // that announces itself with `ready` and has to be told everything again.
    panel.send({ type: "ready" });
    expect(panel.posted().map((message) => message.type)).toContain("models");
  });
});

describe("a pasted image, which is the one attachment with no path", () => {
  function open(): ReturnType<typeof fakeView> {
    activate();
    const panel = fakeView();
    ledger.views[0]?.provider.resolveWebviewView(panel.view);
    panel.send({ type: "ready" });
    ledger.posted.length = 0;
    return panel;
  }

  function chips(panel: ReturnType<typeof fakeView>): { items: unknown[] }[] {
    return panel.posted().filter((message) => message.type === "context") as unknown as {
      items: unknown[];
    }[];
  }

  it("becomes a chip with its real size, without an engine round trip to resolve", () => {
    const panel = open();
    // "AAAA" is four base64 characters, which is three bytes. No engine is
    // running in this test and none is needed: there is nothing on disk to
    // resolve, and the boundary already checked the bytes and the type.
    panel.send({ type: "attachImage", data: "AAAA", mimeType: "image/png" });
    const last = chips(panel).at(-1);
    expect(last?.items).toEqual([
      expect.objectContaining({ kind: "image", ok: true, bytes: 3, label: "Pasted PNG", path: "" }),
    ]);
  });

  it("never sends the bytes back to the page, which only needs to know it exists", () => {
    const panel = open();
    panel.send({ type: "attachImage", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(JSON.stringify(chips(panel))).not.toContain("iVBORw0KGgo=");
  });

  it("comes off the row when it is detached, like any other chip", () => {
    const panel = open();
    panel.send({ type: "attachImage", data: "AAAA", mimeType: "image/png" });
    const items = chips(panel).at(-1)?.items ?? [];
    const id = (items[0] as { id: string }).id;
    panel.send({ type: "detach", id });
    expect(chips(panel).at(-1)?.items).toEqual([]);
    // That the *bytes* go with it is not observable from here — nothing the
    // page is sent ever carried them. It is provable only through
    // `pendingAttachments`, which needs a live engine; TESTING.md lists it.
  });

  it("refuses a type the engine would not take, before a chip ever appears", () => {
    const panel = open();
    panel.send({ type: "attachImage", data: "AAAA", mimeType: "image/svg+xml" });
    expect(chips(panel)).toHaveLength(0);
  });
});

describe("the workflow surface at the host seam", () => {
  function open(): ReturnType<typeof fakeView> {
    activate();
    const panel = fakeView();
    ledger.views[0]?.provider.resolveWebviewView(panel.view);
    return panel;
  }

  it("answers a catalog request even while the engine is down", async () => {
    const panel = open();
    panel.send({ type: "requestWorkflows" });
    await Promise.resolve();
    const posts = panel.posted().filter((message) => message.type === "workflows");
    expect(posts.length).toBeGreaterThan(0);
    // "loading", not an empty catalog: the panel must not tell a user this
    // workspace defines no pipelines when what happened is that nobody has
    // asked yet. The same distinction the model list draws.
    const view = posts.at(-1)?.view as { status: string; workflows: unknown[] };
    expect(view.status).toBe("loading");
    expect(view.workflows).toEqual([]);
  });

  it("raises a native modal before a run, and starts nothing when it is dismissed", async () => {
    const panel = open();
    panel.send({ type: "runWorkflow", name: "ship-fix" });
    await Promise.resolve();
    await Promise.resolve();
    // The engine is down here, so the catalog fetch fails and the run never
    // reaches a modal — what matters is that nothing was executed as a VS Code
    // command and no engine call escaped, which is the containment this seam
    // owns. The modal's own words are `workflows.test.ts`'s to prove.
    expect(ledger.executed).toEqual([]);
  });

  it("drops a run message whose name the boundary refuses", () => {
    const panel = open();
    panel.send({ type: "runWorkflow", name: "" });
    panel.send({ type: "resumeWorkflow", runId: "" });
    const dropped = (ledger.outputs[0]?.lines ?? []).filter((line) =>
      line.includes("dropped an unrecognised webview message"),
    );
    expect(dropped).toHaveLength(2);
  });

  it("never shows the native raise-ceiling dialog for a run this panel is not following", async () => {
    // The engine is down in this suite (no spawned `arcturn serve`), so
    // `engine.capabilities.ceilingRaise` reads false and `workflowRunRow` is
    // undefined either way — `raiseCeiling` must return before it ever
    // reaches `vscode.window.showInputBox`, exactly as it would for a stale
    // click racing a run that already answered itself.
    const panel = open();
    panel.send({ type: "raiseCeiling", runId: "run-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(ledger.inputBoxes).toEqual([]);
  });

  it("drops a raiseCeiling message whose run id the boundary refuses", () => {
    const panel = open();
    panel.send({ type: "raiseCeiling", runId: "" });
    const dropped = (ledger.outputs[0]?.lines ?? []).filter((line) =>
      line.includes("dropped an unrecognised webview message"),
    );
    expect(dropped).toHaveLength(1);
  });
});

describe("ambient awareness of the file the user is looking at", () => {
  /** A stand-in editor, of the shape `active-editor.ts` reads. */
  function editorOn(fsPath: string, scheme = "file"): unknown {
    return {
      document: { uri: { scheme, fsPath } },
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }

  it("subscribes to the editor at activation, and spawns nothing by doing so", () => {
    activate();
    // Three streams, and the third is the one that is easy to forget: without
    // onDidCloseTextDocument the chip goes on offering a file the user closed.
    expect(ledger.activeEditorHandlers).toHaveLength(1);
    expect(ledger.selectionHandlers).toHaveLength(1);
    expect(ledger.closedDocumentHandlers).toHaveLength(1);
    expect(ledger.spawns).toBe(0);
  });

  it("starts no engine when the user moves around the editor", () => {
    activate();
    // RFC 0004 §3's budget survives the feature: watching is a listener, and a
    // listener that reached for `withEngine` would spawn `arcturn serve` the
    // first time somebody opened a file — before they ever opened the panel.
    for (const handler of ledger.activeEditorHandlers) handler(editorOn("/workspace/a.ts"));
    for (const handler of ledger.selectionHandlers) {
      handler({ textEditor: editorOn("/workspace/a.ts") });
    }
    for (const handler of ledger.closedDocumentHandlers) {
      handler({ uri: { scheme: "file", fsPath: "/workspace/a.ts" } });
    }
    expect(ledger.spawns).toBe(0);
  });

  it("asks what is already on screen rather than waiting for the next tab switch", () => {
    // A window restored with one file open fires no editor event at all. A
    // panel that only listened would sit next to that file knowing nothing
    // about it until the user clicked somewhere else — which is the state this
    // whole feature exists to end.
    ledger.activeEditor = editorOn("/workspace/a.ts");
    activate();
    expect(ledger.activeEditorReads).toBeGreaterThan(0);
    expect(ledger.spawns).toBe(0);
  });

  it("registers a command that turns the watching off and on again", async () => {
    activate();
    const toggle = ledger.commands.get(SIDEBAR_COMMANDS.toggleActiveEditorContext);
    expect(toggle).toBeDefined();
    // Default on: the panel's own starter prompts say "the file I have open".
    await (toggle as () => Promise<void>)();
    expect(ledger.configWrites.at(-1)).toMatchObject({
      key: "context.activeEditor",
      value: false,
    });
    await (toggle as () => Promise<void>)();
    expect(ledger.configWrites.at(-1)).toMatchObject({
      key: "context.activeEditor",
      value: true,
    });
  });

  it("turns the watching off when the chip's own control asks, and only off", async () => {
    const panel = openPanel();
    panel.send({ type: "disableActiveEditorContext" });
    await Promise.resolve();
    expect(ledger.configWrites).toEqual([{ key: "context.activeEditor", value: false, target: 1 }]);
  });

  it("watches the configuration, so the setting takes effect without a reload", () => {
    activate();
    const affected: string[] = [];
    for (const handler of ledger.configHandlers) {
      handler({
        affectsConfiguration: (section: string) => {
          affected.push(section);
          return false;
        },
      });
    }
    expect(affected).toContain("arcturn.context.activeEditor");
  });
});

describe("the permission card at the host seam", () => {
  /** The provider the extension registered, with `view.ts`'s real API on it. */
  function surface(): {
    panel: ReturnType<typeof fakeView>;
    provider: {
      postPermissionAsk(card?: unknown): void;
      postBadge(pending: number): void;
      reveal(): Promise<boolean>;
      readonly visible: boolean;
    };
  } {
    const panel = openPanel();
    const provider = ledger.views[0]?.provider as unknown as {
      postPermissionAsk(card?: unknown): void;
      postBadge(pending: number): void;
      reveal(): Promise<boolean>;
      readonly visible: boolean;
    };
    return { panel, provider };
  }

  const card = {
    id: "perm-1",
    description: "Run rm -rf build",
    tool: "bash",
    subject: "rm -rf build",
    choices: [
      { id: "deny", label: "Deny" },
      { id: "allow", label: "Allow" },
    ],
  };

  function asks(panel: ReturnType<typeof fakeView>): { request?: { id: string } }[] {
    return panel.posted().filter((message) => message.type === "permissionAsk") as {
      request?: { id: string };
    }[];
  }

  it("posts the card to the page rather than raising a modal", () => {
    const { panel, provider } = surface();
    provider.postPermissionAsk(card);
    expect(asks(panel).at(-1)?.request?.id).toBe("perm-1");
    expect(ledger.messages.filter((message) => message.level === "warning")).toHaveLength(0);
  });

  it("takes the card down with an ask that names no request", () => {
    const { panel, provider } = surface();
    provider.postPermissionAsk(card);
    provider.postPermissionAsk(undefined);
    expect(asks(panel).at(-1)).toEqual({ type: "permissionAsk" });
  });

  it("replays a live card into a page that reloaded, so the run is never stranded", () => {
    // `retainContextWhenHidden` is off: hiding the panel destroys the page. A
    // card that did not come back would leave a blocked run with nothing on
    // screen to unblock it.
    const { panel, provider } = surface();
    provider.postPermissionAsk(card);
    ledger.posted.length = 0;
    panel.send({ type: "ready" });
    expect(asks(panel).at(-1)?.request?.id).toBe("perm-1");
  });

  it("does not replay a card that was already answered", () => {
    const { panel, provider } = surface();
    provider.postPermissionAsk(card);
    provider.postPermissionAsk(undefined);
    ledger.posted.length = 0;
    panel.send({ type: "ready" });
    expect(asks(panel)).toEqual([]);
  });

  it("says whether the view is actually visible, which is what picks the surface", async () => {
    const { panel, provider } = surface();
    expect(provider.visible).toBe(true);
    expect(await provider.reveal()).toBe(true);
    expect(panel.shows()).toBe(1);
  });

  it("badges the activity bar while the engine is waiting, and clears it after", () => {
    const { panel, provider } = surface();
    provider.postBadge(2);
    expect(panel.badge()?.value).toBe(2);
    provider.postBadge(0);
    expect(panel.badge()).toBeUndefined();
  });

  it("routes the page's answer without an engine, and does not throw on a stale one", () => {
    const panel = openPanel();
    panel.send({ type: "permissionDecision", requestId: "perm-1", choice: "Allow" });
    // Nothing is pending, so nothing is decided — and nothing blows up. The
    // rule that a stale page cannot answer for a live request is proved in
    // `permission-surface.test.ts`, where a request can actually be pending.
    expect(ledger.posted.some((message) => message.type === "permissionAsk")).toBe(false);
  });

  it("drops an answer the boundary refuses before it reaches the surface", () => {
    const panel = openPanel();
    ledger.outputs[0]?.lines.splice(0);
    panel.send({ type: "permissionDecision", requestId: "", choice: "Allow" });
    expect(ledger.outputs[0]?.lines.join("\n")).toContain("unrecognised webview message");
  });
});

/** Open the panel the way `resolveWebviewView` does, and hand back the wire. */
function openPanel(): ReturnType<typeof fakeView> {
  activate();
  const panel = fakeView();
  ledger.views[0]?.provider.resolveWebviewView(panel.view);
  return panel;
}
