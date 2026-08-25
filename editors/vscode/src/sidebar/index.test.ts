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
  posted: [] as { type: string; [key: string]: unknown }[],
  clipboard: [] as string[],
  quickPicks: [] as { items: { label: string; description?: string }[]; options: unknown }[],
  messages: [] as { level: string; message: string; items: string[] }[],
  executed: [] as { command: string; args: unknown[] }[],
  shownOutputs: 0,
  forgotEnvironment: 0,
  config: {} as Record<string, unknown>,
  folders: [{ uri: { fsPath: "/workspace" } }] as { uri: { fsPath: string } }[] | undefined,
  disposed: 0,
  reset(): void {
    ledger.spawns = 0;
    ledger.commands = new Map();
    ledger.outputs = [];
    ledger.statusBars = [];
    ledger.views = [];
    ledger.posted = [];
    ledger.clipboard = [];
    ledger.quickPicks = [];
    ledger.messages = [];
    ledger.executed = [];
    ledger.shownOutputs = 0;
    ledger.forgotEnvironment = 0;
    ledger.config = {};
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
  return {
    Disposable,
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
      registerWebviewViewProvider(id: string, provider: unknown, options: unknown) {
        ledger.views.push({ id, options, provider: provider as WebviewViewProviderLike });
        return { dispose: () => {} };
      },
      showQuickPick(items: { label: string }[], options: unknown) {
        ledger.quickPicks.push({ items, options });
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
      showInputBox: () => Promise.resolve(undefined),
    },
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
    workspace: {
      get workspaceFolders() {
        return ledger.folders;
      },
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => ledger.config[key] ?? fallback,
      }),
    },
  };
});

import { activateSidebar, SIDEBAR_COMMANDS, SIDEBAR_VIEW_ID } from "./index.js";

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
} {
  let receive: ((raw: unknown) => void) | undefined;
  const view = {
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
    show(_focus?: boolean) {},
  };
  return {
    view,
    send: (message: unknown) => receive?.(message),
    posted: () => ledger.posted,
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
    expect([...ledger.commands.keys()].sort()).toEqual(
      Object.values(SIDEBAR_COMMANDS).slice().sort(),
    );
  });

  it("puts the cost item in the status bar, wired to the breakdown command", () => {
    activate();
    expect(ledger.statusBars).toHaveLength(1);
    expect(ledger.statusBars[0]?.command).toBe(SIDEBAR_COMMANDS.showCost);
    expect(ledger.statusBars[0]?.text).toContain("$0.00");
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
