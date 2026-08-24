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
  views: [] as { id: string; options: unknown }[],
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
      registerWebviewViewProvider(id: string, _provider: unknown, options: unknown) {
        ledger.views.push({ id, options });
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
