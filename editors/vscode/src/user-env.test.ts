import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_BEGIN, ENV_END, type ShellProbe } from "./shell-env.js";
import {
  forgetFailedUserEnvironment,
  resetUserEnvironment,
  resolveUserEnvironment,
} from "./user-env.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

/** NUL-framed, the way `env -0` writes it — see `shell-env.ts#parseEnvOutput`. */
const dump = `${ENV_BEGIN}\0PATH=/opt/homebrew/bin\0ANTHROPIC_API_KEY=sk-ant-0123456789\0${ENV_END}\0`;

beforeEach(() => {
  resetUserEnvironment();
});

describe("resolveUserEnvironment", () => {
  it("asks the shell VS Code says the user has", async () => {
    const probes: ShellProbe[] = [];
    const resolved = await resolveUserEnvironment({
      platform: "darwin",
      baseEnv: { PATH: "/usr/bin" },
      run: async (probe) => {
        probes.push(probe);
        return { stdout: dump };
      },
    });
    // `test-vscode.ts` reports /bin/zsh, so the flags are the posix ones.
    expect(probes[0]?.command).toBe("/bin/zsh");
    expect(probes[0]?.args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(resolved.env.ANTHROPIC_API_KEY).toBe("sk-ant-0123456789");
  });

  it("runs the shell once per window, however many callers ask", async () => {
    let runs = 0;
    const options = {
      platform: "darwin" as const,
      baseEnv: { PATH: "/usr/bin" },
      run: async () => {
        runs += 1;
        return { stdout: dump };
      },
    };
    const [first, second] = await Promise.all([
      resolveUserEnvironment(options),
      resolveUserEnvironment(options),
    ]);
    await resolveUserEnvironment(options);
    expect(runs).toBe(1);
    expect(first).toBe(second);
  });

  it("never rejects, even when the shell blows up", async () => {
    const resolved = await resolveUserEnvironment({
      platform: "darwin",
      baseEnv: { PATH: "/usr/bin" },
      run: async () => {
        throw new Error("no such file or directory");
      },
    });
    expect(resolved.source).toBe("process");
    expect(resolved.env.PATH).toBe("/usr/bin");
  });
});

describe("forgetFailedUserEnvironment", () => {
  /** A runner that fails `failures` times and then answers. */
  function flaky(failures: number): { run: () => Promise<{ stdout: string }>; runs: () => number } {
    let runs = 0;
    return {
      runs: () => runs,
      run: async () => {
        runs += 1;
        if (runs <= failures) {
          throw Object.assign(new Error("boom"), { killed: true, signal: "SIGTERM" });
        }
        return { stdout: dump };
      },
    };
  }

  it("lets a transient failure be retried instead of pinning the window to it", async () => {
    // A slow `nvm`/`asdf` init that overran the deadline once, or a machine
    // waking from sleep. Before, the fallback was cached for the life of the
    // window and the reconnect card's own Retry kept using the stale
    // environment — only a window reload recovered, and nothing said so.
    const probe = flaky(1);
    const options = { platform: "darwin" as const, baseEnv: { PATH: "/usr/bin" }, run: probe.run };

    const first = await resolveUserEnvironment(options);
    expect(first.source).toBe("process");

    expect(forgetFailedUserEnvironment()).toBe(true);
    const second = await resolveUserEnvironment(options);
    expect(second.source).toBe("shell");
    expect(second.env.ANTHROPIC_API_KEY).toBe("sk-ant-0123456789");
    expect(probe.runs()).toBe(2);
  });

  it("keeps a successful probe cached — a retry must not re-run the login shell", async () => {
    const probe = flaky(0);
    const options = { platform: "darwin" as const, baseEnv: { PATH: "/usr/bin" }, run: probe.run };
    await resolveUserEnvironment(options);
    expect(forgetFailedUserEnvironment()).toBe(false);
    await resolveUserEnvironment(options);
    expect(probe.runs()).toBe(1);
  });

  it("does not re-probe on Windows, where there was never anything to retry", async () => {
    const probe = flaky(0);
    await resolveUserEnvironment({
      platform: "win32",
      shell: "C:\\Windows\\System32\\cmd.exe",
      baseEnv: { PATH: "C:\\Windows" },
      run: probe.run,
    });
    expect(forgetFailedUserEnvironment()).toBe(false);
    expect(probe.runs()).toBe(0);
  });

  it("is safe before anything has been resolved at all", () => {
    expect(forgetFailedUserEnvironment()).toBe(false);
  });
});
