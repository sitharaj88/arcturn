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
    ledger.config = {};
    ledger.folders = [{ uri: { fsPath: "/workspace" } }];
    ledger.disposed = 0;
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
      showWarningMessage: () => Promise.resolve(undefined),
      showInputBox: () => Promise.resolve(undefined),
    },
    commands: {
      registerCommand(id: string, handler: (...args: never[]) => unknown) {
        ledger.commands.set(id, handler);
        return { dispose: () => ledger.commands.delete(id) };
      },
      executeCommand: () => Promise.resolve(undefined),
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
