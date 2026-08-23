import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_SHELLS,
  DEFAULT_COMPLETION_SPEC,
  generateCompletions,
  isCompletionShell,
  UnknownCompletionShellError,
} from "./completions.js";

/** Whether a binary exists on `$PATH`, so shell-specific syntax checks can skip cleanly. */
function hasBinary(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("isCompletionShell", () => {
  it("accepts exactly the supported shells", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("fish")).toBe(true);
    expect(isCompletionShell("tcsh")).toBe(false);
    expect(isCompletionShell("")).toBe(false);
  });
});

describe("generateCompletions", () => {
  it("throws a typed error for an unknown shell", () => {
    expect(() => generateCompletions("powershell")).toThrow(UnknownCompletionShellError);
    try {
      generateCompletions("powershell");
      throw new Error("expected generateCompletions to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownCompletionShellError);
      expect((error as UnknownCompletionShellError).shell).toBe("powershell");
      expect((error as Error).message).toContain("powershell");
    }
  });

  it("throws for an empty shell name", () => {
    expect(() => generateCompletions("")).toThrow(UnknownCompletionShellError);
  });

  /**
   * fish's `complete` builtin takes flag names without their leading dashes
   * (`-l model -s m`, not `--model -m`), so its script never contains the
   * literal `--model` substring the other two shells do. This maps a flag to
   * the substring each shell's script actually uses for it.
   */
  function expectedLongToken(shell: (typeof COMPLETION_SHELLS)[number], long: string): string {
    return shell === "fish" ? `-l ${long.replace(/^--/, "")}` : long;
  }
  function expectedShortToken(shell: (typeof COMPLETION_SHELLS)[number], short: string): string {
    return shell === "fish" ? `-s ${short.replace(/^-/, "")}` : short;
  }

  for (const shell of COMPLETION_SHELLS) {
    describe(shell, () => {
      const script = generateCompletions(shell);

      it("is non-empty and mentions the program name", () => {
        expect(script.length).toBeGreaterThan(0);
        expect(script).toContain(DEFAULT_COMPLETION_SPEC.program);
      });

      it("contains every flag's long form", () => {
        for (const flag of DEFAULT_COMPLETION_SPEC.flags) {
          const token = expectedLongToken(shell, flag.long);
          expect(script, `missing ${token} in ${shell} script`).toContain(token);
        }
      });

      it("contains every flag's short alias, where one exists", () => {
        for (const flag of DEFAULT_COMPLETION_SPEC.flags) {
          if (!flag.short) continue;
          const token = expectedShortToken(shell, flag.short);
          expect(script, `missing ${token} in ${shell} script`).toContain(token);
        }
      });

      it("contains every enum value for flags that have one", () => {
        for (const flag of DEFAULT_COMPLETION_SPEC.flags) {
          if (!flag.enumValues) continue;
          for (const value of flag.enumValues) {
            expect(script, `missing enum value "${value}" in ${shell} script`).toContain(value);
          }
        }
      });

      it("contains every top-level subcommand and its children", () => {
        for (const sub of DEFAULT_COMPLETION_SPEC.subcommands) {
          expect(script, `missing subcommand "${sub.name}" in ${shell} script`).toContain(sub.name);
          for (const child of sub.children ?? []) {
            expect(script, `missing child "${child.name}" in ${shell} script`).toContain(
              child.name,
            );
          }
        }
      });

      it("references --list-models for dynamic model completion", () => {
        expect(script).toContain("--list-models");
      });
    });
  }

  it("accepts a custom spec instead of the default", () => {
    const spec = {
      program: "widget",
      flags: [
        {
          long: "--color",
          short: "-C",
          takesValue: true,
          enumValues: ["red", "blue"],
          description: "Pick a color.",
        },
      ],
      subcommands: [{ name: "paint", description: "Paint something." }],
    };
    for (const shell of COMPLETION_SHELLS) {
      const script = generateCompletions(shell, spec);
      expect(script).toContain("widget");
      expect(script).toContain(shell === "fish" ? "-l color" : "--color");
      expect(script).toContain(shell === "fish" ? "-s C" : "-C");
      expect(script).toContain("red");
      expect(script).toContain("blue");
      expect(script).toContain("paint");
    }
  });

  it("is deterministic: the same spec always renders the same script", () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(generateCompletions(shell)).toBe(generateCompletions(shell));
    }
  });
});

describe("bash script", () => {
  const script = generateCompletions("bash");

  it("registers completion for the arcturn program via complete -F", () => {
    expect(script).toMatch(/complete -F \S+ arcturn/);
  });

  it("is syntactically valid bash", () => {
    if (!hasBinary("bash")) return;
    expect(() => execFileSync("bash", ["-n"], { input: script })).not.toThrow();
  });

  it("guards the --list-models call so a missing/failing arcturn yields no suggestions", () => {
    expect(script).toContain("command -v timeout");
    expect(script).toContain("2>/dev/null");
  });
});

describe("zsh script", () => {
  const script = generateCompletions("zsh");

  it("starts with a #compdef directive", () => {
    expect(script.startsWith("#compdef arcturn")).toBe(true);
  });

  it("uses _arguments with bracketed descriptions", () => {
    expect(script).toContain("_arguments");
    // Spot-check one flag's description made it into the _arguments spec.
    const modelFlag = DEFAULT_COMPLETION_SPEC.flags.find((f) => f.long === "--model");
    expect(modelFlag).toBeDefined();
    expect(script).toContain(`[${modelFlag?.description}]`);
  });

  it("is syntactically valid zsh", () => {
    if (!hasBinary("zsh")) return;
    expect(() => execFileSync("zsh", ["-n"], { input: script })).not.toThrow();
  });
});

describe("fish script", () => {
  const script = generateCompletions("fish");

  it("uses complete -c arcturn lines", () => {
    expect(script).toMatch(/complete -c arcturn/);
  });

  it("is syntactically valid fish, when fish is installed", () => {
    if (!hasBinary("fish")) return;
    expect(() => execFileSync("fish", ["-n"], { input: script })).not.toThrow();
  });
});
