import { describe, expect, it } from "vitest";
import {
  buildDiagnosticPrompt,
  buildMentionInput,
  rangeFromSelection,
  toWorkspaceRelative,
} from "./mentions.js";

describe("toWorkspaceRelative", () => {
  it("spells the path with forward slashes whatever the host separator is", () => {
    // The mention is read back by the engine's mention expander, which resolves
    // it as a path. A backslash inside it is an escape on the way through the
    // prompt, so `src\new.ts` would arrive as `src` + newline + `ew.ts`.
    expect(toWorkspaceRelative("C:\\work\\repo", "C:\\work\\repo\\src\\new.ts", "win32")).toBe(
      "src/new.ts",
    );
    expect(toWorkspaceRelative("/work/repo", "/work/repo/src/a.ts", "darwin")).toBe("src/a.ts");
  });

  it("falls back to the absolute path when the file is outside the workspace", () => {
    // Relative-with-.. would escape the root the engine resolves against and be
    // silently dropped. An absolute path is at least honest about what it names.
    expect(toWorkspaceRelative("/work/repo", "/etc/hosts", "darwin")).toBe("/etc/hosts");
    expect(toWorkspaceRelative(undefined, "/etc/hosts", "darwin")).toBe("/etc/hosts");
  });

  it("names the root itself rather than emitting an empty mention", () => {
    expect(toWorkspaceRelative("/work/repo", "/work/repo", "darwin")).toBe("/work/repo");
  });
});

describe("buildMentionInput", () => {
  it("types the mention and one trailing space, and nothing else", () => {
    // Nothing else: no newline. A newline would submit the prompt for the user,
    // and the whole point of typing into the terminal is that they still get to
    // write the sentence around the mention.
    expect(buildMentionInput("src/a.ts", { startLine: 12, endLine: 34 })).toEqual({
      ok: true,
      input: "@src/a.ts:12-34 ",
    });
    expect(
      JSON.stringify(buildMentionInput("src/a.ts", { startLine: 12, endLine: 34 })),
    ).not.toContain("\\n");
  });

  it("collapses a single-line range to one number", () => {
    expect(buildMentionInput("src/a.ts", { startLine: 7, endLine: 7 })).toEqual({
      ok: true,
      input: "@src/a.ts:7 ",
    });
  });

  it("omits the range entirely for a whole-file mention", () => {
    expect(buildMentionInput("src/a.ts")).toEqual({ ok: true, input: "@src/a.ts " });
  });

  it("quotes a path containing spaces so the mention token does not split", () => {
    expect(buildMentionInput("src/my file.ts", { startLine: 1, endLine: 2 })).toEqual({
      ok: true,
      input: '@"src/my file.ts":1-2 ',
    });
  });

  it("orders a backwards range low-to-high", () => {
    // A VS Code selection made bottom-up has its anchor after its active
    // position; `:34-12` is not a range any reader parses.
    expect(buildMentionInput("src/a.ts", { startLine: 34, endLine: 12 })).toEqual({
      ok: true,
      input: "@src/a.ts:12-34 ",
    });
  });
});

describe("buildDiagnosticPrompt", () => {
  it("puts the mention first and the diagnostic text on the same line", () => {
    expect(buildDiagnosticPrompt("@src/a.ts:12-14 ", "Type 'string' is not assignable.")).toBe(
      "@src/a.ts:12-14 Fix this problem: Type 'string' is not assignable. ",
    );
  });

  it("flattens a multi-line diagnostic into one terminal line", () => {
    // Terminals treat a newline as submit. A multi-line tsc diagnostic pasted
    // raw would fire the prompt halfway through the message.
    const prompt = buildDiagnosticPrompt(
      "@src/a.ts:1 ",
      "Type 'A' is not assignable to type 'B'.\n  Property 'x' is missing.\r\n  Did you mean 'y'?",
    );
    expect(prompt).not.toContain("\n");
    expect(prompt).not.toContain("\r");
    expect(prompt).toBe(
      "@src/a.ts:1 Fix this problem: Type 'A' is not assignable to type 'B'. Property 'x' is missing. Did you mean 'y'? ",
    );
  });

  it("still sends the mention when the diagnostic carries no message", () => {
    expect(buildDiagnosticPrompt("@src/a.ts:1 ", "   ")).toBe("@src/a.ts:1 ");
  });
});

describe("rangeFromSelection", () => {
  it("converts VS Code's 0-based lines to the 1-based ones humans read", () => {
    expect(
      rangeFromSelection({ start: { line: 11, character: 0 }, end: { line: 33, character: 8 } }),
    ).toEqual({ startLine: 12, endLine: 34 });
  });

  it("does not claim the line a full-line selection merely touches", () => {
    // Triple-clicking line 12 selects (11,0)-(12,0). Reporting that as 12-13
    // asks the model to look at a line the user never highlighted.
    expect(
      rangeFromSelection({ start: { line: 11, character: 0 }, end: { line: 12, character: 0 } }),
    ).toEqual({ startLine: 12, endLine: 12 });
  });

  it("treats an empty selection as the cursor's own line", () => {
    expect(
      rangeFromSelection({ start: { line: 4, character: 3 }, end: { line: 4, character: 3 } }),
    ).toEqual({ startLine: 5, endLine: 5 });
  });
});

// The exact filename the adversarial review used. Legal on any POSIX
// filesystem: the embedded `"` closes the quote the builder opens, `;` starts
// a new command, and the trailing `#` comments out the dangling quote.
const POC_PATH = 'my file".ts; touch /tmp/arcturn_poc_pwned #';

describe("buildMentionInput refuses to type anything a shell would act on", () => {
  it("does not emit the proof-of-concept's bytes", () => {
    // Shape-agnostic on purpose: this fails whether the builder returns a
    // string or a result object, so it is the injection under test and not
    // the signature.
    expect(JSON.stringify(buildMentionInput(POC_PATH))).not.toContain(
      "; touch /tmp/arcturn_poc_pwned",
    );
  });

  it("rejects the path outright rather than quoting around it", () => {
    const result = buildMentionInput(POC_PATH, { startLine: 1, endLine: 2 });
    expect(result.ok).toBe(false);
  });

  it("rejects a raw newline, which is an Enter the user never pressed", () => {
    // The worst case by a distance. Every other hostile character still waits
    // for the human to press Enter; a newline submits the line itself. The
    // module doc has always promised "no newline, ever" -- this is the test
    // that makes that promise true rather than aspirational.
    for (const path of ["src/a\nrm -rf ~.ts", "src/a\rwhoami.ts"]) {
      const result = buildMentionInput(path);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("\\n");
      expect(JSON.stringify(result)).not.toContain("\\r");
    }
  });

  it("rejects the rest of the control range, escape sequences included", () => {
    // ESC opens an ANSI sequence, and some terminals answer those with input.
    for (const path of [
      "a\u0000b.ts",
      "a\u001b[31mb.ts",
      "a\u0007b.ts",
      "a\u007fb.ts",
      "a\u009fb.ts",
    ]) {
      expect(buildMentionInput(path).ok).toBe(false);
    }
  });

  it("rejects the metacharacters that double quotes cannot contain", () => {
    // Verified against a real shell: `"$(cmd)"` still runs cmd. There is no
    // quoting form the engine's mention grammar understands that makes these
    // inert, so the only honest answer is to refuse them.
    for (const bad of ['"', "$", "`", "\\", ";", "|", "&", "<", ">", "!"]) {
      const result = buildMentionInput(`src/a${bad}b.ts`);
      expect(result.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
    }
  });

  it("says which characters it refused, so the message is actionable", () => {
    const result = buildMentionInput(POC_PATH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("buildMentionInput still carries the awkward-but-ordinary names", () => {
  it("keeps a plain path bare", () => {
    const result = buildMentionInput("src/components/Button.test.tsx", {
      startLine: 3,
      endLine: 9,
    });
    expect(result).toEqual({ ok: true, input: "@src/components/Button.test.tsx:3-9 " });
  });

  it("quotes the punctuation that is common in real trees", () => {
    // Every one of these is inert inside double quotes: no globbing, no brace
    // expansion, no subshell, no comment.
    for (const path of ["src/foo (1).ts", "app/[id]/page.tsx", "a'b.ts", "#temp.ts", "x{y}.ts"]) {
      const result = buildMentionInput(path);
      expect(result.ok, `expected ${path} to be accepted`).toBe(true);
      if (!result.ok) continue;
      expect(result.input).toBe(`@"${path}" `);
    }
  });

  it("carries non-ASCII names, which are not a security question", () => {
    const result = buildMentionInput("src/nihongo/café.ts");
    expect(result).toEqual({ ok: true, input: "@src/nihongo/café.ts " });
  });

  it("emits only inert bytes for every path it accepts", () => {
    // The invariant behind the whole allow-list: an accepted mention is either
    // a bare word of safe characters or a double-quoted span nothing can break
    // out of, followed by exactly one space.
    const candidates = [
      "src/a.ts",
      "src/foo (1).ts",
      POC_PATH,
      "a\nb.ts",
      "a$(id).ts",
      "app/[id]/page.tsx",
      "src/nihongo/café.ts",
    ];
    for (const path of candidates) {
      const result = buildMentionInput(path, { startLine: 1, endLine: 2 });
      if (!result.ok) continue;
      expect(result.input, `unsafe bytes for ${JSON.stringify(path)}`).toMatch(
        /^@(?:[^\s"'`$;|&<>!()[\]{}#*?]+|"[^"`$;|&<>!\n\r]+")(?::\d+(?:-\d+)?)? $/,
      );
    }
  });
});

describe("buildDiagnosticPrompt neutralizes what a language server hands it", () => {
  it("strips control characters out of the message", () => {
    // A diagnostic often quotes source text back, so a hostile string literal
    // in the file reaches this line. Stripping is right here where rejecting
    // is right for a path: a shortened message is still a useful message,
    // where a shortened path names the wrong file.
    const prompt = buildDiagnosticPrompt(
      "@src/a.ts:1 ",
      "Type \u001b[31m'A'\u001b[0m is not assignable.",
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point.
    expect(prompt).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(prompt).toContain("assignable");
  });
});
