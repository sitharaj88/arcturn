import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliProvisioner } from "./cli.js";
import { fake, resetFake } from "./test-vscode.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

beforeEach(() => {
  resetFake();
});

describe("createCliProvisioner", () => {
  it("returns the configured binary and reads its version once, not once per command", async () => {
    fake.config["arcturn.cliPath"] = "/opt/custom/arcturn";
    const probed: string[] = [];
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/bin",
      isExecutable: (candidate) => candidate === "/opt/custom/arcturn",
      probeVersion: async (command) => {
        probed.push(command);
        return "0.9.0";
      },
    });

    const first = await provisioner.resolveCli();
    const second = await provisioner.resolveCli();

    expect(first).toEqual({ command: "/opt/custom/arcturn", source: "setting", version: "0.9.0" });
    expect(second).toEqual(first);
    expect(probed).toEqual(["/opt/custom/arcturn"]);
    provisioner.dispose();
  });

  it("shows exactly one notification when the CLI is missing, however often it is asked", async () => {
    // Three commands in a row on a machine without the engine must not stack
    // three identical toasts.
    const provisioner = createCliProvisioner({
      platform: "linux",
      home: "/home/me",
      pathVar: "/usr/bin",
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });

    expect(await provisioner.resolveCli()).toBe(undefined);
    await provisioner.resolveCli();
    await provisioner.resolveCli();

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.message).toContain("not found on your PATH");
    expect(fake.messages[0]?.items).toContain("Install");
    provisioner.dispose();
  });

  it("installs by typing the command into a terminal, never silently", async () => {
    // RFC 0004 §1: the user watches exactly what executes.
    fake.messageAnswer = "Install";
    const provisioner = createCliProvisioner({
      platform: "linux",
      home: "/home/me",
      pathVar: "/usr/bin",
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });

    await provisioner.resolveCli();
    await provisioner.settled();

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.sent).toEqual([{ text: "npm install -g arcturn", addNewLine: true }]);
    expect(fake.terminals[0]?.shows).toBeGreaterThan(0);
    provisioner.dispose();
  });

  it("names the broken setting rather than blaming PATH", async () => {
    fake.config["arcturn.cliPath"] = "/opt/typo/arcturn";
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/bin",
      isExecutable: (candidate) => candidate === "/usr/bin/arcturn",
      probeVersion: async () => "0.2.0",
    });

    expect(await provisioner.resolveCli()).toBe(undefined);
    expect(fake.messages[0]?.message).toContain("/opt/typo/arcturn");
    provisioner.dispose();
  });

  it("offers an upgrade for an old engine but still hands the caller the binary", async () => {
    // Degrading is honest; refusing to run at all over a version number is not.
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "0.1.0",
    });

    const cli = await provisioner.resolveCli();

    expect(cli?.command).toBe("/usr/local/bin/arcturn");
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.message).toContain("0.1.0");
    expect(fake.messages[0]?.items).toContain("Upgrade");
    provisioner.dispose();
  });

  it("says nothing about the version when the engine is new enough", async () => {
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "1.0.0",
    });

    await provisioner.resolveCli();

    expect(fake.messages).toEqual([]);
    provisioner.dispose();
  });

  it("re-resolves after the cliPath setting changes", async () => {
    // Otherwise the user fixes the setting, nothing happens, and the only
    // remedy anyone finds is reloading the window.
    let executable = "/usr/local/bin/arcturn";
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === executable,
      probeVersion: async () => "1.0.0",
    });

    expect((await provisioner.resolveCli())?.command).toBe("/usr/local/bin/arcturn");

    executable = "/opt/next/arcturn";
    fake.config["arcturn.cliPath"] = "/opt/next/arcturn";
    for (const handler of fake.configChangeHandlers) {
      handler({ affectsConfiguration: (section: string) => section === "arcturn.cliPath" });
    }

    expect((await provisioner.resolveCli())?.command).toBe("/opt/next/arcturn");
    provisioner.dispose();
  });

  it("runs the install command on demand for the palette entry", async () => {
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/bin",
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });

    provisioner.runInstall("install");

    expect(fake.terminals[0]?.sent[0]?.text).toBe("npm install -g arcturn");
    provisioner.dispose();
  });
});

describe("createCliProvisioner: the environment it looks in", () => {
  it("searches the login shell's PATH, which is the only place /opt/homebrew/bin appears", async () => {
    // A GUI-launched VS Code on macOS inherits launchd's PATH, not the
    // user's; without the shell probe the binary below is invisible.
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      environment: async () => ({
        env: { PATH: "/opt/arcturn-fixture/bin:/usr/bin" },
        source: "shell",
        diagnostic: "environment: read 42 variables from /bin/zsh in 180ms",
        secrets: [],
        retryable: false,
      }),
      isExecutable: (candidate) => candidate === "/opt/arcturn-fixture/bin/arcturn",
      probeVersion: async () => "0.2.0",
    });
    expect(await provisioner.resolveCli()).toEqual({
      command: "/opt/arcturn-fixture/bin/arcturn",
      source: "path",
      version: "0.2.0",
    });
    provisioner.dispose();
  });

  it("resolves the environment lazily — constructing the provisioner probes nothing", () => {
    let calls = 0;
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      environment: async () => {
        calls += 1;
        return {
          env: { PATH: "/usr/bin" },
          source: "shell",
          diagnostic: "",
          secrets: [],
          retryable: false,
        };
      },
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });
    expect(calls).toBe(0);
    provisioner.dispose();
  });

  it("says the shell probe failed in the same notification that says the CLI is missing", async () => {
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      environment: async () => ({
        env: { PATH: "/usr/bin:/bin" },
        source: "process",
        diagnostic:
          "environment: could not read the login shell environment (the shell timed out after 5000ms); using the extension host's own environment.",
        secrets: [],
        retryable: false,
      }),
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });
    expect(await provisioner.resolveCli()).toBe(undefined);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.message).toMatch(/login shell/i);
    provisioner.dispose();
  });

  it("hands the resolved environment to the version probe, so the shim can find node", async () => {
    const seen: (Record<string, string | undefined> | undefined)[] = [];
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      environment: async () => ({
        env: { PATH: "/opt/homebrew/bin:/usr/bin" },
        source: "shell",
        diagnostic: "",
        secrets: [],
        retryable: false,
      }),
      isExecutable: () => true,
      probeVersion: async (_command, env) => {
        seen.push(env);
        return "0.2.0";
      },
    });
    fake.config["arcturn.cliPath"] = "/opt/homebrew/bin/arcturn";
    await provisioner.resolveCli();
    expect(seen[0]?.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    provisioner.dispose();
  });
});
