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
