import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProvisioner, ResolvedCli } from "./cli.js";
import { activate, activateWith } from "./extension.js";
import type { TerminalHub } from "./terminal.js";
import { fake, fakeFolder, fakeUri, resetFake } from "./test-vscode.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

const seam = vi.hoisted(() => {
  // A stable identity, so a test can ask whether *this* disposable ended up
  // somewhere it should not have.
  const sidebarDisposable = { dispose: () => {} };
  return { sidebarDisposable, activateSidebar: vi.fn(() => sidebarDisposable) };
});

vi.mock("./sidebar/index.js", () => ({ activateSidebar: seam.activateSidebar }));

const cli: ResolvedCli = { command: "/usr/local/bin/arcturn", source: "path", version: "0.2.0" };

interface Sent {
  folderName: string | undefined;
  text: string;
}

/** `null` means "the CLI could not be resolved"; omitted means the happy path. */
function makeDeps(resolved?: ResolvedCli | null): {
  context: { subscriptions: { dispose(): void }[] };
  sent: Sent[];
  opened: number;
  deps: Parameters<typeof activateWith>[1];
} {
  const sent: Sent[] = [];
  const state = { opened: 0 };
  const answer = resolved === undefined ? cli : (resolved ?? undefined);
  const provisioner: CliProvisioner = {
    resolveCli: async () => answer,
    runInstall: () => {},
    settled: async () => {},
    dispose: () => {},
  };
  const hub: TerminalHub = {
    open: () => {
      state.opened++;
      return {} as never;
    },
    sendInput: async (folder, _cli, text) => {
      sent.push({ folderName: folder?.name, text });
    },
    dispose: () => {},
  };
  return {
    context: { subscriptions: [] },
    sent,
    get opened() {
      return state.opened;
    },
    deps: { provisioner, hub, platform: "darwin" },
  };
}

beforeEach(() => {
  resetFake();
  // Reset rather than clear: a test that swaps in its own implementation must
  // not leak it into the next one.
  seam.activateSidebar.mockReset();
  seam.activateSidebar.mockImplementation(() => seam.sidebarDisposable);
  fake.workspaceFolders = [fakeFolder("/work/repo", "repo")];
});

/** Deliver a settings change the way VS Code would. */
function fireConfigChange(section: string): void {
  for (const handler of [...fake.configChangeHandlers]) {
    handler({ affectsConfiguration: (candidate: string) => candidate === section });
  }
}

describe("activate", () => {
  it("registers exactly the commands the manifest contributes", async () => {
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect([...fake.commands.keys()].sort()).toEqual([
      "arcturn.fixDiagnostic",
      "arcturn.installCli",
      "arcturn.open",
      "arcturn.sendFile",
      "arcturn.sendSelection",
    ]);
  });

  it("registers the diagnostic code action provider", async () => {
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect(fake.codeActionProviders).toHaveLength(1);
  });

  it("puts everything it registered into the context's subscriptions", async () => {
    // A command left registered after deactivate is a duplicate palette entry
    // the next activation cannot overwrite. The nine are: the provisioner, the
    // terminal hub, five commands, the code action provider, and the
    // arcturn.serve.enabled listener.
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect(harness.context.subscriptions).toHaveLength(9);
  });
});

describe("arcturn.open", () => {
  it("opens the terminal once the CLI resolves", async () => {
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.open")?.();

    expect(harness.opened).toBe(1);
  });

  it("does nothing but the provisioner's own notification when there is no CLI", async () => {
    const harness = makeDeps(null);
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.open")?.();

    expect(harness.opened).toBe(0);
    expect(harness.sent).toEqual([]);
  });
});

describe("mention commands", () => {
  it("sends the selection as a workspace-relative mention with its line range", async () => {
    fake.activeTextEditor = {
      document: { uri: fakeUri("/work/repo/src/a.ts") },
      selection: { start: { line: 11, character: 2 }, end: { line: 33, character: 9 } },
    };
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendSelection")?.();

    expect(harness.sent).toEqual([{ folderName: "repo", text: "@src/a.ts:12-34 " }]);
  });

  it("sends a whole file with no range at all", async () => {
    fake.activeTextEditor = {
      document: { uri: fakeUri("/work/repo/src/a.ts") },
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendFile")?.();

    expect(harness.sent).toEqual([{ folderName: "repo", text: "@src/a.ts " }]);
  });

  it("accepts a uri argument, so the explorer context menu works with no editor open", async () => {
    fake.activeTextEditor = undefined;
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendFile")?.(fakeUri("/work/repo/docs/x.md") as never);

    expect(harness.sent).toEqual([{ folderName: "repo", text: "@docs/x.md " }]);
  });

  it("explains itself instead of doing nothing when there is no file to send", async () => {
    fake.activeTextEditor = undefined;
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendSelection")?.();

    expect(harness.sent).toEqual([]);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.level).toBe("info");
  });

  it("sends the diagnostic's own text alongside the range it covers", async () => {
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.fixDiagnostic")?.(
      fakeUri("/work/repo/src/a.ts") as never,
      { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } } as never,
      "Type 'A' is not assignable to type 'B'." as never,
    );

    expect(harness.sent).toEqual([
      {
        folderName: "repo",
        text: "@src/a.ts:5 Fix this problem: Type 'A' is not assignable to type 'B'. ",
      },
    ]);
  });
});

describe("the sidebar seam", () => {
  it("calls Builder B's entry point exactly once, with the resolver", async () => {
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect(seam.activateSidebar).toHaveBeenCalledTimes(1);
    const [, resolver] = seam.activateSidebar.mock.calls[0] as unknown as [unknown, () => unknown];
    expect(typeof resolver).toBe("function");
  });

  it("leaves the sidebar's own disposable to the sidebar", async () => {
    // activateSidebar already pushes it onto context.subscriptions. Pushing
    // the return value as well makes the lifecycle two-sided and disposes it
    // twice on deactivate — survivable only because B happens to be
    // idempotent, which is not a property to build on.
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect(harness.context.subscriptions).not.toContain(seam.sidebarDisposable);
  });

  it("stays out of the way when arcturn.serve.enabled is off", async () => {
    fake.config["arcturn.serve.enabled"] = false;
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect(seam.activateSidebar).not.toHaveBeenCalled();
  });

  it("still activates the terminal half when the sidebar module throws", async () => {
    // Stage 1 must not be taken down by a Stage 2 regression: the terminal is
    // the front-end that always has to work.
    seam.activateSidebar.mockImplementationOnce(() => {
      throw new Error("serve blew up");
    });
    const harness = makeDeps();

    await activateWith(harness.context as never, harness.deps);

    expect(fake.commands.has("arcturn.open")).toBe(true);
    expect(fake.messages.some((m) => m.level === "error")).toBe(true);
  });
});

// The adversarial review's filename, reached through each of the three doors.
const HOSTILE = '/work/repo/my file".ts; touch /tmp/arcturn_poc_pwned #';

describe("a filename that cannot be mentioned safely stops at the door", () => {
  it("refuses it from Send File", async () => {
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendFile")?.(fakeUri(HOSTILE) as never);

    expect(harness.sent).toEqual([]);
    expect(fake.messages).toHaveLength(1);
  });

  it("refuses it from Send Selection", async () => {
    fake.activeTextEditor = {
      document: { uri: fakeUri(HOSTILE) },
      selection: { start: { line: 1, character: 0 }, end: { line: 4, character: 2 } },
    };
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendSelection")?.();

    expect(harness.sent).toEqual([]);
    expect(fake.messages).toHaveLength(1);
  });

  it("refuses it from the diagnostic code action", async () => {
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.fixDiagnostic")?.(
      fakeUri(HOSTILE) as never,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } as never,
      "Type error." as never,
    );

    expect(harness.sent).toEqual([]);
    expect(fake.messages).toHaveLength(1);
  });

  it("explains the refusal instead of failing silently", async () => {
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    await fake.commands.get("arcturn.sendFile")?.(fakeUri(HOSTILE) as never);

    expect(fake.messages[0]?.message).toContain("Arcturn");
    expect(fake.messages[0]?.message.length).toBeGreaterThan(20);
  });
});

describe("arcturn.serve.enabled reacts to being toggled mid-session", () => {
  /** Stand in for Builder B: register a real command, and remove it on dispose. */
  function seamRegistersCommand(): void {
    seam.activateSidebar.mockImplementation(() => {
      fake.commands.set("arcturn.selectModel", () => "ran");
      return { dispose: () => fake.commands.delete("arcturn.selectModel") };
    });
  }

  it("registers the sidebar's commands when the setting is turned on", async () => {
    // The palette's `when: config.arcturn.serve.enabled` clause re-evaluates
    // live, so the six sidebar entries appear the instant the setting flips.
    // Before this listener existed they appeared unbacked and every one of
    // them failed with "command not found".
    fake.config["arcturn.serve.enabled"] = false;
    seamRegistersCommand();
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    expect(fake.commands.has("arcturn.selectModel")).toBe(false);

    fake.config["arcturn.serve.enabled"] = true;
    fireConfigChange("arcturn.serve.enabled");

    await vi.waitFor(() => {
      expect(fake.commands.has("arcturn.selectModel")).toBe(true);
    });
    expect(await fake.commands.get("arcturn.selectModel")?.()).toBe("ran");
  });

  it("starts the sidebar at most once however often the setting is poked", async () => {
    fake.config["arcturn.serve.enabled"] = false;
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    fake.config["arcturn.serve.enabled"] = true;
    fireConfigChange("arcturn.serve.enabled");
    fireConfigChange("arcturn.serve.enabled");
    await vi.waitFor(() => {
      expect(seam.activateSidebar).toHaveBeenCalledTimes(1);
    });
    fireConfigChange("arcturn.serve.enabled");
    await vi.waitFor(() => {
      expect(seam.activateSidebar).toHaveBeenCalledTimes(1);
    });
  });

  it("shuts the sidebar down when the setting is turned off", async () => {
    // `serve.enabled: false` is a request to stop running a server. Honouring
    // it only after a window reload leaves a loopback listener alive that the
    // user believes they switched off.
    seamRegistersCommand();
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);
    await vi.waitFor(() => {
      expect(fake.commands.has("arcturn.selectModel")).toBe(true);
    });

    fake.config["arcturn.serve.enabled"] = false;
    fireConfigChange("arcturn.serve.enabled");

    await vi.waitFor(() => {
      expect(fake.commands.has("arcturn.selectModel")).toBe(false);
    });
  });

  it("can be turned off and on again", async () => {
    seamRegistersCommand();
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    fake.config["arcturn.serve.enabled"] = false;
    fireConfigChange("arcturn.serve.enabled");
    await vi.waitFor(() => {
      expect(fake.commands.has("arcturn.selectModel")).toBe(false);
    });

    fake.config["arcturn.serve.enabled"] = true;
    fireConfigChange("arcturn.serve.enabled");
    await vi.waitFor(() => {
      expect(fake.commands.has("arcturn.selectModel")).toBe(true);
    });
    expect(seam.activateSidebar).toHaveBeenCalledTimes(2);
  });

  it("ignores changes to unrelated settings", async () => {
    fake.config["arcturn.serve.enabled"] = false;
    const harness = makeDeps();
    await activateWith(harness.context as never, harness.deps);

    fireConfigChange("arcturn.cliPath");

    expect(seam.activateSidebar).not.toHaveBeenCalled();
  });
});

describe("activation survives a host whose shell-integration API is gated", () => {
  it("registers every command on VS Code 1.90-1.92", async () => {
    // The shipping bug, at the level it actually broke. `activate()` builds
    // the terminal hub in its own argument list, before a single
    // registerCommand runs, so a throw in there does not degrade one feature
    // -- it makes the whole extension inert and every command "not found".
    // `activateWith` cannot catch this: it takes an injected hub.
    fake.shellIntegration = "proposal-gated";
    const context = { subscriptions: [] as { dispose(): void }[] };

    await activate(context as never);

    for (const id of [
      "arcturn.open",
      "arcturn.sendSelection",
      "arcturn.sendFile",
      "arcturn.installCli",
      "arcturn.fixDiagnostic",
    ]) {
      expect(fake.commands.has(id), `${id} was never registered`).toBe(true);
    }
  });

  it("comes up on a host with no shell-integration API at all", async () => {
    fake.shellIntegration = "absent";
    const context = { subscriptions: [] as { dispose(): void }[] };

    await activate(context as never);

    expect(fake.commands.has("arcturn.open")).toBe(true);
  });
});
