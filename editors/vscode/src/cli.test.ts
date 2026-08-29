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

  it("installs automatically when the CLI is missing, in a terminal the user can watch", async () => {
    // A fresh install landing on a panel that needs a CLI it does not have
    // should just get one — visibly. The terminal is the transparency: the
    // exact command on screen, Ctrl+C available, nothing silent.
    const provisioner = createCliProvisioner({
      platform: "linux",
      home: "/home/me",
      pathVar: "/usr/bin",
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });

    expect(await provisioner.resolveCli()).toBe(undefined);
    await provisioner.resolveCli();
    await provisioner.settled();

    expect(fake.terminals).toHaveLength(1);
    expect(fake.terminals[0]?.sent).toEqual([{ text: "npm install -g arcturn", addNewLine: true }]);
    expect(fake.terminals[0]?.shows).toBeGreaterThan(0);
    // One notification, however often it is asked — and it names the setting
    // that turns the behaviour off, which is what makes automatic honest.
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.level).toBe("info");
    expect(fake.messages[0]?.message).toContain("arcturn.cli.autoUpdate");
    provisioner.dispose();
  });

  it("asks first when auto-management is turned off", async () => {
    fake.config["arcturn.cli.autoUpdate"] = false;
    const provisioner = createCliProvisioner({
      platform: "linux",
      home: "/home/me",
      pathVar: "/usr/bin",
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });

    expect(await provisioner.resolveCli()).toBe(undefined);
    await provisioner.settled();

    expect(fake.terminals).toHaveLength(0);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.message).toContain("not found on your PATH");
    expect(fake.messages[0]?.items).toContain("Install");
    provisioner.dispose();
  });

  it("still types the command into a terminal when the user opts to install manually", async () => {
    // RFC 0004 §1: the user watches exactly what executes.
    fake.config["arcturn.cli.autoUpdate"] = false;
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

  it("upgrades an old engine automatically, and still hands the caller the binary", async () => {
    // Degrading is honest; refusing to run at all over a version number is not
    // — so the caller gets the binary it has while the terminal fetches the
    // one it needs.
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "0.1.0",
    });

    const cli = await provisioner.resolveCli();
    await provisioner.settled();

    expect(cli?.command).toBe("/usr/local/bin/arcturn");
    expect(fake.terminals[0]?.sent).toEqual([
      { text: "npm install -g arcturn@latest", addNewLine: true },
    ]);
    expect(fake.messages[0]?.message).toContain("0.1.0");
    provisioner.dispose();
  });

  it("asks before upgrading when auto-management is turned off", async () => {
    fake.config["arcturn.cli.autoUpdate"] = false;
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "0.1.0",
    });

    await provisioner.resolveCli();
    await provisioner.settled();

    expect(fake.terminals).toHaveLength(0);
    expect(fake.messages[0]?.items).toContain("Upgrade");
    provisioner.dispose();
  });

  it("updates once a day when npm has a newer engine, and not on every resolve", async () => {
    // The daily check is the whole point of "not manual": a user who never
    // reads release notes still ends up current. Throttled through the shared
    // state so a window reload is not a registry hit.
    const memory = new Map<string, unknown>();
    const state = {
      get: <T>(key: string): T | undefined => memory.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void memory.set(key, value),
    };
    let clock = 200_000_000; // past the first 24h window from epoch 0
    let asked = 0;
    const build = () =>
      createCliProvisioner({
        platform: "darwin",
        home: "/Users/me",
        pathVar: "/usr/local/bin",
        isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
        probeVersion: async () => "0.5.0",
        state,
        now: () => clock,
        fetchLatestVersion: async () => {
          asked += 1;
          return "0.5.2";
        },
      });

    const first = build();
    await first.resolveCli();
    await first.settled();
    expect(asked).toBe(1);
    expect(fake.terminals[0]?.sent).toEqual([
      { text: "npm install -g arcturn@latest", addNewLine: true },
    ]);
    expect(fake.messages[0]?.message).toContain("0.5.0 → 0.5.2");
    first.dispose();

    // An hour later — same day, same state: no second registry hit.
    clock += 60 * 60 * 1000;
    const second = build();
    await second.resolveCli();
    await second.settled();
    expect(asked).toBe(1);
    second.dispose();

    // A day later: checked again.
    clock += 25 * 60 * 60 * 1000;
    const third = build();
    await third.resolveCli();
    await third.settled();
    expect(asked).toBe(2);
    third.dispose();
  });

  it("provisions in the background without being asked, and without blocking", async () => {
    // Activation calls this and does not await it: a missing engine is dealt
    // with while the editor opens, not on the first command a user runs.
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: () => false,
      probeVersion: async () => undefined,
    });

    // Returns synchronously — nothing is awaited on the activation path.
    provisioner.provisionInBackground();
    expect(fake.terminals).toHaveLength(0);

    await provisioner.settled();
    expect(fake.terminals[0]?.sent).toEqual([{ text: "npm install -g arcturn", addNewLine: true }]);
    provisioner.dispose();
  });

  it("lets only one window start an install, so four windows are not four npm runs", async () => {
    // The one-shot guards are per window; the claim that stops a stampede has
    // to be profile-wide, which is what globalState is.
    const memory = new Map<string, unknown>();
    const state = {
      get: <T>(key: string): T | undefined => memory.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void memory.set(key, value),
    };
    let clock = 500_000_000;
    const window = () =>
      createCliProvisioner({
        platform: "darwin",
        home: "/Users/me",
        pathVar: "/usr/local/bin",
        isExecutable: () => false,
        probeVersion: async () => undefined,
        state,
        now: () => clock,
      });

    const first = window();
    first.provisionInBackground();
    await first.settled();
    expect(fake.terminals).toHaveLength(1);

    // Three more windows open moments later: they find the engine missing
    // too, and each declines because the claim is still warm.
    for (let i = 0; i < 3; i += 1) {
      const other = window();
      other.provisionInBackground();
      await other.settled();
      other.dispose();
    }
    expect(fake.terminals).toHaveLength(1);

    // The claim expires, so a later attempt is not blocked forever.
    clock += 6 * 60 * 1000;
    const later = window();
    later.provisionInBackground();
    await later.settled();
    expect(fake.terminals).toHaveLength(2);
    later.dispose();
    first.dispose();
  });

  it("never auto-updates a binary pinned by arcturn.cliPath", async () => {
    // `npm install -g` can freshen what PATH found; it cannot touch the file
    // an explicit setting points at. For a pinned path the daily check would
    // open a terminal that fixes nothing, so it must not run at all.
    fake.config["arcturn.cliPath"] = "/opt/custom/arcturn";
    const memory = new Map<string, unknown>();
    const state = {
      get: <T>(key: string): T | undefined => memory.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void memory.set(key, value),
    };
    let asked = 0;
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) =>
        candidate === "/opt/custom/arcturn" || candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "0.5.0",
      state,
      now: () => 200_000_000,
      fetchLatestVersion: async () => {
        asked += 1;
        return "0.5.2";
      },
    });

    const resolved = await provisioner.resolveCli();
    await provisioner.settled();

    expect(resolved?.source).toBe("setting");
    expect(asked).toBe(0);
    expect(fake.terminals).toHaveLength(0);
    expect(fake.messages).toHaveLength(0);
    provisioner.dispose();
  });

  it("asks — never auto-runs — when a pinned engine is below the floor", async () => {
    // Below MIN_ENGINE_VERSION the offer path fires; for a pinned path it
    // must degrade to the question, because the install command cannot repair
    // the setting.
    fake.config["arcturn.cliPath"] = "/opt/custom/arcturn";
    const provisioner = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/opt/custom/arcturn",
      probeVersion: async () => "0.1.0",
    });

    await provisioner.resolveCli();
    await provisioner.settled();

    expect(fake.terminals).toHaveLength(0);
    expect(fake.messages[0]?.message).toContain("0.1.0");
    provisioner.dispose();
  });

  it("stays silent when the engine is current or the registry cannot be reached", async () => {
    // "Could not check" must never surface as an error to somebody who merely
    // opened their editor.
    const memory = new Map<string, unknown>();
    const state = {
      get: <T>(key: string): T | undefined => memory.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void memory.set(key, value),
    };
    const current = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "0.5.2",
      state,
      now: () => 1,
      fetchLatestVersion: async () => "0.5.2",
    });
    await current.resolveCli();
    await current.settled();
    expect(fake.terminals).toHaveLength(0);
    expect(fake.messages).toHaveLength(0);
    current.dispose();

    const offline = createCliProvisioner({
      platform: "darwin",
      home: "/Users/me",
      pathVar: "/usr/local/bin",
      isExecutable: (candidate) => candidate === "/usr/local/bin/arcturn",
      probeVersion: async () => "0.5.2",
      state,
      now: () => 60 * 60 * 60 * 1000,
      fetchLatestVersion: async () => {
        throw new Error("offline");
      },
    });
    await offline.resolveCli();
    await offline.settled();
    expect(fake.messages).toHaveLength(0);
    offline.dispose();
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
    fake.config["arcturn.cli.autoUpdate"] = false;
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
