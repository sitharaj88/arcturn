/**
 * The login-shell probe, against a **real** shell process.
 *
 * Every other test of `shell-env.ts` injects the runner, deliberately, so that
 * nothing in this repository depends on the developer's own profile. That
 * isolation is also a blind spot: it means the parser is only ever fed output
 * a test author *imagined* `env(1)` producing. This file closes it by running
 * the actual `shellProbeCommand()` against `/bin/bash` and letting the real
 * `env` write the bytes.
 *
 * It is still hermetic. The child gets `HOME` pointed at a freshly made
 * temporary directory, so the `~/.bash_profile` it sources is one this file
 * wrote — never the developer's. `/bin/bash` exists on macOS and on every
 * Linux distribution this extension is shipped to; where it does not, the
 * whole file skips rather than pretending.
 *
 * ## What it is here to catch
 *
 * An environment variable's *value* is attacker-influenced in a way its name
 * is not: it can come from a dotfile a tool generated, a `.env` a dependency
 * shipped, or anything that got `export`ed along the way. A value may contain
 * newlines. So a parser that reassembles `env` output line by line can be made
 * to read a line *inside a value* as a new assignment — which is a way to set
 * any variable at all, including the credential this whole feature exists to
 * find, and including `PATH`, which decides which `arcturn` binary runs.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readUserEnvironment, type ShellProbe, type UserEnvironment } from "./shell-env.js";

const BASH = "/bin/bash";
const runnable = process.platform !== "win32" && existsSync(BASH);
const withBash = runnable ? describe : describe.skip;

/** What an injected value would set if the parser could be fooled. */
const INJECTED = "attacker-injected-value-should-never-appear";

/**
 * Every value the profile exports, and the exact string it must come back as.
 *
 * Asserting the *values* rather than the side effects is what makes this
 * deterministic. `env(1)` prints the environ array in the shell's own internal
 * order — on bash 3.2 that is neither insertion order nor alphabetical — so
 * whether an injected `PATH=` line actually wins depends on where the carrier
 * variable happens to land relative to the real `PATH`. "It did not win on
 * this machine" is luck, not a defence. A value that comes back truncated at
 * its first newline is the same bug with none of the luck in it.
 */
const PAYLOADS: Record<string, string> = {
  EVIL_MULTILINE: `x\nANTHROPIC_API_KEY=${INJECTED}`,
  EVIL_PATH: "y\nPATH=/attacker/bin",
  EVIL_TRUNCATE: "z\n__ARCTURN_ENV_END__\nAFTER_END=1",
  LEGIT_MARKER: "legitimate-value",
};

const PROFILE = `${[
  `export EVIL_MULTILINE=$'x\\nANTHROPIC_API_KEY=${INJECTED}'`,
  "export EVIL_PATH=$'y\\nPATH=/attacker/bin'",
  "export EVIL_TRUNCATE=$'z\\n__ARCTURN_ENV_END__\\nAFTER_END=1'",
  "export LEGIT_MARKER=legitimate-value",
].join("\n")}\n`;

function probeThroughBash(): Promise<UserEnvironment> {
  const home = mkdtempSync(join(tmpdir(), "arcturn-shell-env-"));
  writeFileSync(join(home, ".bash_profile"), PROFILE);
  const run = (probe: ShellProbe, timeoutMs: number): Promise<{ stdout: string }> =>
    new Promise((resolve, reject) => {
      execFile(
        probe.command,
        probe.args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
          // The only thing changed about the child's world: where it looks for
          // a profile. Everything else is a real login shell.
          env: { ...process.env, HOME: home },
        },
        (error, stdout) => (error ? reject(error) : resolve({ stdout })),
      );
    });
  return readUserEnvironment({
    platform: process.platform,
    shell: BASH,
    baseEnv: { PATH: "/usr/bin:/bin" },
    run,
  });
}

withBash("the login-shell probe, run for real", () => {
  it("reads the profile at all", async () => {
    // The positive control. Without it every assertion below could pass
    // because the probe failed and returned the base environment untouched.
    const resolved = await probeThroughBash();
    expect(resolved.source).toBe("shell");
    expect(resolved.env.LEGIT_MARKER).toBe("legitimate-value");
  });

  it("returns every exported value byte for byte, newlines and all", async () => {
    // The load-bearing assertion, and the one that does not depend on what
    // order `env` happened to print things in: a parser that can be tricked
    // into reading a line inside a value as an assignment necessarily also
    // truncates that value at the newline it consumed.
    const resolved = await probeThroughBash();
    expect(
      Object.fromEntries(Object.keys(PAYLOADS).map((name) => [name, resolved.env[name]])),
    ).toEqual(PAYLOADS);
  });

  it("does not let a newline inside a value declare a new variable", async () => {
    const resolved = await probeThroughBash();
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    // The text is still there — inside the value that really carries it.
    // Dropping it would be a different bug.
    expect(resolved.env.EVIL_MULTILINE).toContain(INJECTED);
  });

  it("does not let a newline inside a value rewrite PATH", async () => {
    // `decideCli` walks PATH in order and runs the first hit, so a value that
    // can prepend a directory chooses which `arcturn` binary the extension
    // executes.
    const resolved = await probeThroughBash();
    expect(resolved.env.PATH ?? "").not.toContain("/attacker/bin");
    expect(resolved.env.PATH).toContain("/usr/bin");
  });

  it("does not let an end marker inside a value truncate the environment", async () => {
    const resolved = await probeThroughBash();
    expect(resolved.env.EVIL_TRUNCATE).toBe(PAYLOADS.EVIL_TRUNCATE);
    expect(resolved.env.AFTER_END).toBeUndefined();
    // Everything the real `env` printed after the fake marker is still here.
    expect(resolved.env.LEGIT_MARKER).toBe("legitimate-value");
    expect(Object.keys(resolved.env).length).toBeGreaterThan(10);
  });
});
