/**
 * Deciding which failures are worth mentioning, and what to say about them.
 *
 * The judgement that matters most is the negative one. A feature that offers
 * to explain every non-zero exit — including the Ctrl-C somebody just typed,
 * and the `cd` into a directory that is not there — becomes a feature people
 * turn off, and then the real failures go unnoticed too. So most of these
 * tests are about restraint.
 */

import { describe, expect, it } from "vitest";
import {
  type CommandFailure,
  failureLabel,
  failurePrompt,
  isWorthOffering,
  MAX_OUTPUT_CHARS,
  tailOf,
} from "./model.js";

function failure(over: Partial<CommandFailure> = {}): CommandFailure {
  return {
    command: "pnpm test",
    exitCode: 1,
    cwd: "/work/app",
    output: "FAIL src/cart.test.ts\n  expected 3 to be 4",
    at: 0,
    ...over,
  };
}

describe("deciding whether to say anything", () => {
  it("offers on an ordinary failure", () => {
    expect(isWorthOffering({ command: "pnpm test", exitCode: 1 })).toBe(true);
    expect(isWorthOffering({ command: "cargo build", exitCode: 101 })).toBe(true);
  });

  it("says nothing about a success", () => {
    expect(isWorthOffering({ command: "pnpm test", exitCode: 0 })).toBe(false);
  });

  it("says nothing when the shell did not report a code", () => {
    // Shell integration is best-effort. An unknown exit is not evidence of
    // failure, and treating it as one would fire on every command.
    expect(isWorthOffering({ command: "pnpm test", exitCode: undefined })).toBe(false);
  });

  it("says nothing about an interrupt the user typed", () => {
    // 130 is Ctrl-C. Offering to explain the interrupt somebody just pressed
    // is the fastest way to make this annoying enough to disable.
    expect(isWorthOffering({ command: "pnpm dev", exitCode: 130 })).toBe(false);
    expect(isWorthOffering({ command: "pnpm dev", exitCode: 143 })).toBe(false);
  });

  it("says nothing about a typo", () => {
    expect(isWorthOffering({ command: "cd nowhere", exitCode: 1 })).toBe(false);
    expect(isWorthOffering({ command: "ls missing/", exitCode: 2 })).toBe(false);
  });

  it("says nothing about arcturn's own exit", () => {
    // Offering to ask Arcturn about Arcturn failing is a loop nobody wants to
    // be in, and the TUI exiting non-zero is already reported elsewhere.
    expect(isWorthOffering({ command: "arcturn -p 'hi'", exitCode: 1 })).toBe(false);
  });

  it("says nothing about an empty command line", () => {
    expect(isWorthOffering({ command: "   ", exitCode: 1 })).toBe(false);
  });
});

describe("carrying the output", () => {
  it("keeps a short log whole", () => {
    expect(tailOf("one\ntwo")).toBe("one\ntwo");
  });

  it("keeps the end, because that is where the answer is", () => {
    // A failing suite prints its summary last, a compiler prints its error
    // last, and a stack trace matters at the point it stopped.
    const long = `${"x".repeat(MAX_OUTPUT_CHARS)}\nTHE ACTUAL ERROR`;
    const kept = tailOf(long);
    expect(kept).toContain("THE ACTUAL ERROR");
    expect(kept.length).toBeLessThan(long.length);
  });

  it("marks what it dropped, so nothing reasons about a beginning it cannot see", () => {
    expect(tailOf("y".repeat(MAX_OUTPUT_CHARS + 100))).toContain("earlier output omitted");
  });

  it("normalises carriage returns, which a pty emits and a fence renders badly", () => {
    expect(tailOf("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("labelling a failure", () => {
  it("names the command and the code", () => {
    expect(failureLabel(failure())).toBe("pnpm test (exit 1)");
  });

  it("elides from the left, because the end is the recognisable part", () => {
    // `pnpm --filter @arcturn/cli test -- --grep auth` is identified by its
    // tail; cutting the tail leaves every long command looking alike.
    const label = failureLabel(
      failure({ command: "pnpm --filter @arcturn/cli test -- --grep authorization" }),
      24,
    );
    expect(label.startsWith("…")).toBe(true);
    expect(label).toContain("authorization");
  });

  it("collapses whitespace, so a multi-line command is still one row", () => {
    expect(failureLabel(failure({ command: "pnpm \\\n  test" }))).not.toContain("\n");
  });
});

describe("the prompt", () => {
  it("names the command, the code and the directory", () => {
    const prompt = failurePrompt(failure());
    expect(prompt).toContain("exit code 1");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("/work/app");
  });

  it("fences the output, so log is distinguishable from instruction", () => {
    // A log pasted unfenced is a log a model may read as something it was told
    // to do — the same reason every other context block here is fenced.
    expect(failurePrompt(failure())).toContain("```\nFAIL src/cart.test.ts");
  });

  it("says the output is missing rather than omitting the fact", () => {
    // A model given a command and no output should know the output was not
    // captured, rather than conclude the command printed nothing.
    const prompt = failurePrompt(failure({ output: "" }));
    expect(prompt).toContain("not captured");
    expect(prompt).not.toContain("```\n\n```");
  });

  it("asks for a diagnosis before a change", () => {
    // An agent that starts editing before saying what is wrong is one whose
    // work you cannot check.
    expect(failurePrompt(failure())).toMatch(/say what went wrong before changing anything/i);
  });

  it("caps a huge log rather than sending all of it", () => {
    const prompt = failurePrompt(failure({ output: "z".repeat(MAX_OUTPUT_CHARS * 3) }));
    expect(prompt.length).toBeLessThan(MAX_OUTPUT_CHARS * 2);
    expect(prompt).toContain("earlier output omitted");
  });
});
