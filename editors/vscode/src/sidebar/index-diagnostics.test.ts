/**
 * The output channel is a sink for engine-supplied text, so it is a place a
 * credential could land. These tests pin the wiring at the seam itself:
 * `activateSidebar` hands `createEngineSession` a `log` and a
 * `host.onDiagnostic`, and *both* must pass through a redactor before anything
 * reaches `output.appendLine`.
 *
 * `engine-session.js` is mocked here purely to capture those two callbacks —
 * the defect this file exists for lives in how `index.ts` builds them, not in
 * what the engine session does with them. `index.test.ts` keeps the real
 * module, so the activation-budget assertions there stay honest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A token exactly as `serve/token.ts` generates one: 32 random bytes as hex. */
const SECRET = "a3f1".repeat(16);

const captured = vi.hoisted(() => ({
  options: undefined as
    | { log?: (line: string) => void; host: { onDiagnostic?: (line: string) => void } }
    | undefined,
  lines: [] as string[],
  reset(): void {
    captured.options = undefined;
    captured.lines = [];
  },
}));

vi.mock("./engine-session.js", () => ({
  createEngineSession: (options: unknown) => {
    captured.options = options as typeof captured.options;
    return {
      status: "idle",
      controller: undefined,
      start: async () => {},
      restart: async () => {},
      listSessions: async () => [],
      openSession: async () => {},
      newSession: async () => {},
      dispose: () => {},
    };
  },
}));

vi.mock("vscode", () => {
  class Disposable {
    constructor(private readonly onDispose: () => void) {}
    dispose(): void {
      this.onDispose();
    }
  }
  return {
    Disposable,
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => captured.lines.push(line),
        dispose: () => {},
      }),
      createStatusBarItem: () => ({
        text: "",
        tooltip: "",
        command: "",
        name: "",
        show: () => {},
        hide: () => {},
        dispose: () => {},
      }),
      registerWebviewViewProvider: () => ({ dispose: () => {} }),
      showQuickPick: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showInputBox: () => Promise.resolve(undefined),
    },
    commands: {
      registerCommand: (id: string, handler: (...args: never[]) => unknown) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: () => Promise.resolve(undefined),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
      getConfiguration: () => ({ get: (_k: string, fallback?: unknown) => fallback }),
    },
  };
});

const commands = new Map<string, (...args: never[]) => unknown>();

import { activateSidebar, SIDEBAR_COMMANDS } from "./index.js";

/** Activate, then force the engine session to be built so its options exist. */
async function wired(): Promise<NonNullable<typeof captured.options>> {
  activateSidebar({ subscriptions: [] } as never, async () => ({ command: "/bin/arcturn" }));
  await commands.get(SIDEBAR_COMMANDS.reconnect)?.();
  const options = captured.options;
  if (options === undefined) throw new Error("createEngineSession was never called");
  return options;
}

beforeEach(() => {
  captured.reset();
  commands.clear();
});

describe("diagnostics reaching the output channel", () => {
  it("redacts the log wire, which supervisor and connect diagnostics ride", async () => {
    const options = await wired();
    options.log?.(`serve: spawn failed with --token ${SECRET}`);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).not.toContain(SECRET);
  });

  it("redacts the host.onDiagnostic wire, which controller diagnostics ride", async () => {
    const options = await wired();
    options.host.onDiagnostic?.(`prompt failed: internal error ${SECRET}`);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).not.toContain(SECRET);
  });

  it("keeps the diagnostic useful — only the secret is removed", async () => {
    const options = await wired();
    options.host.onDiagnostic?.(`prompt failed: rate limited (${SECRET})`);
    expect(captured.lines[0]).toContain("prompt failed: rate limited");
  });

  it("redacts a command failure written straight to the sink", async () => {
    const options = await wired();
    // `withEngine`'s catch and the provider's message-validation diagnostic
    // both write through the same closure; nothing may reach it unfiltered.
    options.log?.(`sidebar: ws://127.0.0.1:1#token=${SECRET} refused`);
    expect(captured.lines[0]).not.toContain(SECRET);
  });
});
