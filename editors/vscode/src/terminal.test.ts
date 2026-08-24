import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalHub, terminalName } from "./terminal.js";
import { endShellExecution, fake, fakeFolder, resetFake } from "./test-vscode.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

const cli = { command: "/usr/local/bin/arcturn", source: "path" } as const;
const noWait = { sleep: async () => {}, platform: "darwin" as NodeJS.Platform };

beforeEach(() => {
  resetFake();
});

describe("terminalName", () => {
  it("is plain 'Arcturn' in the ordinary single-root case", () => {
    expect(terminalName("repo", false)).toBe("Arcturn");
    expect(terminalName(undefined, false)).toBe("Arcturn");
  });

  it("names the folder in a multi-root workspace, where two would collide", () => {
    expect(terminalName("api", true)).toBe("Arcturn — api");
  });
});

describe("terminal hub", () => {
  it("launches the resolved binary in a terminal for the folder", () => {
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);

    hub.open(fake.workspaceFolders[0] as never, cli);

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.name).toBe("Arcturn");
    expect(fake.terminals[0]?.sent).toEqual([{ text: "/usr/local/bin/arcturn", addNewLine: true }]);
    expect(fake.terminals[0]?.shows).toBe(1);
    hub.dispose();
  });

  it("passes the configured default model through as the engine's own flag", () => {
    fake.config["arcturn.defaultModel"] = "anthropic/claude-opus-4";
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);

    hub.open(fake.workspaceFolders[0] as never, cli);

    expect(fake.terminals[0]?.sent[0]?.text).toBe(
      "/usr/local/bin/arcturn --model anthropic/claude-opus-4",
    );
    hub.dispose();
  });

  it("focuses the existing terminal instead of starting a second engine", () => {
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;

    hub.open(folder, cli);
    hub.open(folder, cli);

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.shows).toBe(2);
    expect(fake.terminals[0]?.sent).toHaveLength(1);
    hub.dispose();
  });

  it("keeps one terminal per workspace folder", () => {
    fake.workspaceFolders = [fakeFolder("/work/api", "api"), fakeFolder("/work/web", "web", 1)];
    const hub = createTerminalHub(noWait);

    hub.open(fake.workspaceFolders[0] as never, cli);
    hub.open(fake.workspaceFolders[1] as never, cli);

    expect(fake.terminals.map((t) => t.name)).toEqual(["Arcturn — api", "Arcturn — web"]);
    hub.dispose();
  });

  it("forgets a terminal the user closed, so the next open starts a fresh one", () => {
    // Without this the hub hands back a disposed terminal and the command
    // appears to do nothing at all.
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;

    hub.open(folder, cli);
    fake.terminals[0]?.dispose();
    hub.open(folder, cli);

    expect(fake.terminals).toHaveLength(2);
    hub.dispose();
  });

  it("types a mention without a newline, so the user still writes the sentence", async () => {
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;
    hub.open(folder, cli);

    await hub.sendInput(folder, cli, "@src/a.ts:12-34 ");

    expect(fake.terminals[0]?.sent[1]).toEqual({ text: "@src/a.ts:12-34 ", addNewLine: false });
    hub.dispose();
  });

  it("waits for a freshly launched engine before typing into it", async () => {
    // The launch line has been sent but the TUI has not taken the tty yet;
    // typing immediately lands in the shell's buffer and the mention is
    // swallowed or echoed as garbage.
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const waits: number[] = [];
    const hub = createTerminalHub({
      platform: "darwin",
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await hub.sendInput(fake.workspaceFolders[0] as never, cli, "@src/a.ts ");

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(fake.terminals[0]?.sent).toEqual([
      { text: "/usr/local/bin/arcturn", addNewLine: true },
      { text: "@src/a.ts ", addNewLine: false },
    ]);
    hub.dispose();
  });

  it("does not stall when the terminal is already running", async () => {
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const waits: number[] = [];
    const hub = createTerminalHub({
      platform: "darwin",
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const folder = fake.workspaceFolders[0] as never;
    hub.open(folder, cli);

    await hub.sendInput(folder, cli, "@src/a.ts ");

    expect(waits).toEqual([]);
    hub.dispose();
  });
});

describe("a reused terminal is not assumed to still be running the engine", () => {
  it("re-launches in place when the TUI exited but the shell did not", () => {
    // The adversarial path. The user pressed q, the terminal is still open on
    // a bare shell prompt, and the hub's map still holds it. Typing a mention
    // in here types at a shell.
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;
    hub.open(folder, cli);

    endShellExecution(fake.terminals[0] as never);
    hub.open(folder, cli);

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.sent).toEqual([
      { text: "/usr/local/bin/arcturn", addNewLine: true },
      { text: "/usr/local/bin/arcturn", addNewLine: true },
    ]);
  });

  it("settles after a re-launch before typing, exactly as after a first launch", () => {
    // The `fresh` shortcut is what made the reused path skip the wait; a
    // re-launch is every bit as unsettled as a first one.
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const waits: number[] = [];
    const hub = createTerminalHub({
      platform: "darwin",
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const folder = fake.workspaceFolders[0] as never;
    hub.open(folder, cli);
    endShellExecution(fake.terminals[0] as never);

    return hub.sendInput(folder, cli, "@src/a.ts ").then(() => {
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThan(0);
      expect(fake.terminals[0]?.sent).toEqual([
        { text: "/usr/local/bin/arcturn", addNewLine: true },
        { text: "/usr/local/bin/arcturn", addNewLine: true },
        { text: "@src/a.ts ", addNewLine: false },
      ]);
    });
  });

  it("abandons a terminal whose shell itself has exited", () => {
    // `exitStatus` is the one liveness signal VS Code gives us directly. It
    // only covers the shell dying, not the TUI, but where it does fire the
    // terminal is unusable and must not be handed back.
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;
    hub.open(folder, cli);

    const dead = fake.terminals[0];
    if (dead !== undefined) dead.exitStatus = { code: 0 };
    hub.open(folder, cli);

    expect(fake.terminals).toHaveLength(2);
    expect(fake.terminals[1]?.sent).toEqual([{ text: "/usr/local/bin/arcturn", addNewLine: true }]);
  });

  it("still reuses a terminal whose engine is running, without re-launching", () => {
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;

    hub.open(folder, cli);
    hub.open(folder, cli);

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.sent).toHaveLength(1);
  });

  it("keeps working on a host with no shell integration", () => {
    // VS Code before 1.93, or a shell VS Code cannot instrument. We lose the
    // signal, not the feature: reuse still works, and the mention text is
    // inert by construction whatever ends up reading it.
    fake.shellIntegrationSupported = false;
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    const folder = fake.workspaceFolders[0] as never;

    hub.open(folder, cli);
    hub.open(folder, cli);

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.sent).toHaveLength(1);
    hub.dispose();
  });

  it("stops listening once disposed", () => {
    fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
    const hub = createTerminalHub(noWait);
    hub.open(fake.workspaceFolders[0] as never, cli);

    expect(fake.shellExecutionEndHandlers).toHaveLength(1);
    hub.dispose();
    expect(fake.shellExecutionEndHandlers).toHaveLength(0);
  });
});
