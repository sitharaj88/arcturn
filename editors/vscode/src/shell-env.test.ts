import { describe, expect, it } from "vitest";
import {
  ENV_BEGIN,
  ENV_END,
  mergeUserEnvironment,
  parseEnvOutput,
  readUserEnvironment,
  secretEnvValues,
  shellProbeCommand,
} from "./shell-env.js";

/**
 * A probe result, framed the way `env -0` frames it.
 *
 * Every record — both markers and every assignment — is terminated by a NUL,
 * which is the one byte an environment variable's name or value cannot
 * contain. Test helpers that build the bytes any other way would be testing a
 * format the shell does not produce.
 */
function output(env: Record<string, string>, noise = ""): string {
  const records = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return `${noise}${ENV_BEGIN}\0${records.map((record) => `${record}\0`).join("")}${ENV_END}\0`;
}

describe("shellProbeCommand", () => {
  it("runs zsh and bash as an interactive login shell, which is where profiles are read", () => {
    for (const shell of ["/bin/zsh", "/usr/local/bin/bash", "/opt/homebrew/bin/zsh"]) {
      const probe = shellProbeCommand(shell, "darwin");
      expect(probe?.command).toBe(shell);
      expect(probe?.args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
      expect(probe?.args.at(-1)).toContain(ENV_BEGIN);
    }
  });

  it("asks every shell for NUL-separated output, which is the whole safety argument", () => {
    for (const shell of ["/bin/zsh", "/bin/sh", "/usr/bin/fish", "/usr/bin/nu", "/bin/tcsh"]) {
      expect(shellProbeCommand(shell, "linux")?.args.at(-1)).toContain("/usr/bin/env -0");
    }
    expect(shellProbeCommand("/usr/local/bin/pwsh", "linux")?.args.at(-1)).toContain(
      "/usr/bin/env -0",
    );
  });

  it("does not pass -l or -i to /bin/sh, because dash rejects both", () => {
    const probe = shellProbeCommand("/bin/sh", "linux");
    expect(probe?.args).toEqual(["-c", expect.stringContaining(ENV_BEGIN)]);
    expect(shellProbeCommand("/bin/dash", "linux")?.args[0]).toBe("-c");
  });

  it("uses fish's own login/interactive flags", () => {
    const probe = shellProbeCommand("/opt/homebrew/bin/fish", "darwin");
    expect(probe?.args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
  });

  it("never asks nushell for --interactive, which would open a repl instead of answering", () => {
    const probe = shellProbeCommand("/opt/homebrew/bin/nu", "darwin");
    expect(probe?.args.slice(0, 2)).toEqual(["-l", "-c"]);
    expect(probe?.args).not.toContain("-i");
  });

  it("uses tcsh's -i, because its -l has to be the only flag", () => {
    const probe = shellProbeCommand("/bin/tcsh", "darwin");
    expect(probe?.args.slice(0, 2)).toEqual(["-i", "-c"]);
    expect(probe?.args).not.toContain("-l");
  });

  it("speaks PowerShell to pwsh rather than posix", () => {
    const probe = shellProbeCommand("/usr/local/bin/pwsh", "linux");
    expect(probe?.args.slice(0, 2)).toEqual(["-Login", "-Command"]);
  });

  it("declines on Windows, where a GUI app already inherits the user environment", () => {
    expect(shellProbeCommand("C:\\Windows\\System32\\cmd.exe", "win32")).toBeUndefined();
    expect(
      shellProbeCommand("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32"),
    ).toBeUndefined();
  });

  it("declines when VS Code reports no shell at all", () => {
    expect(shellProbeCommand(undefined, "darwin")).toBeUndefined();
    expect(shellProbeCommand("   ", "darwin")).toBeUndefined();
  });
});

describe("parseEnvOutput", () => {
  it("reads only what is between the markers, so a chatty profile cannot inject a variable", () => {
    const parsed = parseEnvOutput(output({ FOO: "bar" }, "Welcome!\nHACKED=1\n"));
    expect(parsed).toEqual({ FOO: "bar" });
  });

  it("keeps a value that contains an equals sign intact", () => {
    expect(parseEnvOutput(output({ A: "b=c=d" }))?.A).toBe("b=c=d");
  });

  it("keeps a multi-line value together instead of dropping its tail", () => {
    const parsed = parseEnvOutput(
      output({ KEYFILE: "-----BEGIN-----\nline two\n-----END-----", NEXT: "1" }),
    );
    expect(parsed?.KEYFILE).toBe("-----BEGIN-----\nline two\n-----END-----");
    expect(parsed?.NEXT).toBe("1");
  });

  it("answers undefined when the markers never arrived", () => {
    expect(parseEnvOutput("PATH=/usr/bin\0")).toBeUndefined();
    expect(parseEnvOutput(`${ENV_BEGIN}\0PATH=/usr/bin\0`)).toBeUndefined();
  });

  it("refuses newline-framed output rather than parsing it ambiguously", () => {
    // What `env` without `-0` prints. A platform whose `env` does not accept
    // `-0` must fall back to the host environment, not to a guess.
    expect(parseEnvOutput(`${ENV_BEGIN}\nPATH=/usr/bin\nHOME=/root\n${ENV_END}\n`)).toBeUndefined();
  });

  it("refuses an empty body, which is what an env that rejected -0 leaves behind", () => {
    expect(parseEnvOutput(`${ENV_BEGIN}\0${ENV_END}\0`)).toBeUndefined();
  });
});

describe("parseEnvOutput: a value is attacker-influenced, a record boundary is not", () => {
  it("does not let a newline inside a value declare a new variable", () => {
    const parsed = parseEnvOutput(
      output({ EVIL: "x\nANTHROPIC_API_KEY=attacker-injected", HOME: "/root" }),
    );
    expect(parsed?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(parsed?.EVIL).toBe("x\nANTHROPIC_API_KEY=attacker-injected");
    expect(parsed?.HOME).toBe("/root");
  });

  it("does not let a newline inside a value rewrite PATH", () => {
    // `decideCli` walks PATH in order and runs the first hit it can execute,
    // so prepending a directory chooses which `arcturn` binary is spawned.
    const parsed = parseEnvOutput(output({ EVIL: "y\nPATH=/attacker/bin", PATH: "/usr/bin:/bin" }));
    expect(parsed?.PATH).toBe("/usr/bin:/bin");
  });

  it("does not let an end marker inside a value truncate the body", () => {
    const parsed = parseEnvOutput(output({ EVIL: `z\n${ENV_END}\nAFTER=1`, LEGIT: "kept" }));
    expect(parsed?.LEGIT).toBe("kept");
    expect(parsed?.AFTER).toBeUndefined();
    expect(parsed?.EVIL).toBe(`z\n${ENV_END}\nAFTER=1`);
  });

  it("does not let a begin marker inside a value drop the records before it", () => {
    const parsed = parseEnvOutput(output({ FIRST: "kept", EVIL: `w\n${ENV_BEGIN}`, LAST: "kept" }));
    expect(parsed?.FIRST).toBe("kept");
    expect(parsed?.LAST).toBe("kept");
  });

  it("still ignores a banner printed before the real marker", () => {
    const parsed = parseEnvOutput(output({ FOO: "bar" }, "Welcome!\nHACKED=1\n"));
    expect(parsed).toEqual({ FOO: "bar" });
  });
});

describe("mergeUserEnvironment", () => {
  const base = { PATH: "/usr/bin:/bin", VSCODE_PID: "1", TERM_PROGRAM: "vscode" };

  it("brings in a variable the extension host never had", () => {
    const merged = mergeUserEnvironment(base, { ANTHROPIC_API_KEY: "sk-live" }, "darwin");
    expect(merged.ANTHROPIC_API_KEY).toBe("sk-live");
  });

  it("never overwrites something VS Code deliberately set", () => {
    const merged = mergeUserEnvironment(base, { TERM_PROGRAM: "iTerm.app" }, "darwin");
    expect(merged.TERM_PROGRAM).toBe("vscode");
  });

  it("refuses the electron and vscode variables even when the host does not carry them", () => {
    const merged = mergeUserEnvironment(
      { PATH: "/usr/bin" },
      { ELECTRON_RUN_AS_NODE: "1", VSCODE_NLS_CONFIG: "{}", NODE_OPTIONS: "--inspect" },
      "darwin",
    );
    expect(merged.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(merged.VSCODE_NLS_CONFIG).toBeUndefined();
    expect(merged.NODE_OPTIONS).toBeUndefined();
  });

  it("puts the shell's PATH first and keeps the host's entries after it, deduped", () => {
    const merged = mergeUserEnvironment(base, { PATH: "/opt/homebrew/bin:/usr/bin" }, "darwin");
    expect(merged.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("leaves PATH alone when the shell reported none", () => {
    expect(mergeUserEnvironment(base, { FOO: "1" }, "darwin").PATH).toBe("/usr/bin:/bin");
  });
});

describe("secretEnvValues", () => {
  it("names the values of secret-shaped variables so the redactor can cover them", () => {
    const secrets = secretEnvValues({
      ANTHROPIC_API_KEY: "sk-ant-0123456789",
      GITHUB_TOKEN: "ghp_abcdefghijkl",
      DB_PASSWORD: "hunter2hunter2",
      HOME: "/Users/me",
    });
    expect(secrets).toContain("sk-ant-0123456789");
    expect(secrets).toContain("ghp_abcdefghijkl");
    expect(secrets).toContain("hunter2hunter2");
    expect(secrets).not.toContain("/Users/me");
  });

  it("does not treat a path or a sentence as a credential", () => {
    const secrets = secretEnvValues({
      SSH_KEY_PATH: "/Users/me/.ssh/id_ed25519",
      KEY_DESCRIPTION: "the key for the thing",
      SHORT_TOKEN: "abc",
    });
    expect(secrets).toEqual([]);
  });
});

describe("readUserEnvironment", () => {
  const base = { PATH: "/usr/bin" };

  it("merges the login shell's environment and says where it came from", async () => {
    const result = await readUserEnvironment({
      platform: "darwin",
      shell: "/bin/zsh",
      baseEnv: base,
      run: async () => ({
        stdout: output({ PATH: "/opt/homebrew/bin", ZAI_API_KEY: "abcdefghij" }),
      }),
    });
    expect(result.source).toBe("shell");
    expect(result.env.ZAI_API_KEY).toBe("abcdefghij");
    expect(result.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(result.secrets).toContain("abcdefghij");
  });

  it("never puts a variable name or value in the diagnostic", async () => {
    const result = await readUserEnvironment({
      platform: "darwin",
      shell: "/bin/zsh",
      baseEnv: base,
      run: async () => ({ stdout: output({ ANTHROPIC_API_KEY: "sk-ant-secret-value" }) }),
    });
    expect(result.diagnostic).not.toContain("ANTHROPIC_API_KEY");
    expect(result.diagnostic).not.toContain("sk-ant-secret-value");
    expect(result.diagnostic).toContain("/bin/zsh");
  });

  it("falls back to the host environment when the shell times out, and says so", async () => {
    const result = await readUserEnvironment({
      platform: "darwin",
      shell: "/bin/zsh",
      baseEnv: base,
      timeoutMs: 10,
      run: async () => {
        throw Object.assign(new Error("spawn timed out"), { killed: true, signal: "SIGTERM" });
      },
    });
    expect(result.source).toBe("process");
    expect(result.env).toEqual(base);
    expect(result.diagnostic).toMatch(/could not read/i);
    expect(result.diagnostic).toMatch(/timed out|timeout/i);
  });

  it("does not repeat the shell's own output in the diagnostic, which could carry a secret", async () => {
    const result = await readUserEnvironment({
      platform: "darwin",
      shell: "/bin/zsh",
      baseEnv: base,
      run: async () => {
        throw new Error("Command failed: printenv\nAWS_SECRET_ACCESS_KEY=leaked-by-a-profile");
      },
    });
    expect(result.source).toBe("process");
    expect(result.diagnostic).not.toContain("leaked-by-a-profile");
  });

  it("falls back when the shell answers without the markers", async () => {
    const result = await readUserEnvironment({
      platform: "darwin",
      shell: "/bin/zsh",
      baseEnv: base,
      run: async () => ({ stdout: "your profile printed a banner and nothing else\n" }),
    });
    expect(result.source).toBe("process");
    expect(result.diagnostic).toMatch(/could not read/i);
  });

  it("skips the probe entirely on Windows and says why", async () => {
    let ran = false;
    const result = await readUserEnvironment({
      platform: "win32",
      shell: "C:\\Windows\\System32\\cmd.exe",
      baseEnv: base,
      run: async () => {
        ran = true;
        return { stdout: "" };
      },
    });
    expect(ran).toBe(false);
    expect(result.source).toBe("process");
    expect(result.diagnostic).toMatch(/windows/i);
  });
});
