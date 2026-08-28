/**
 * The commit prompt, and the cleanup its answers need.
 *
 * The cleanup is where this can go wrong permanently: a message committed with
 * a stray fence or wrapping quotes in it is history. The engine's `/commit`
 * makes the same repairs for the same reason; these tests pin the editor's
 * copy to the same behaviour.
 */

import { describe, expect, it } from "vitest";
import { cleanMessage, commitPrompt, MAX_COMMIT_DIFF_CHARS } from "./model.js";

const DIFF = "diff --git a/src/x.ts b/src/x.ts\n+const a = 1;";

describe("the prompt", () => {
  it("asks for the message text and nothing else", () => {
    const prompt = commitPrompt({ diff: DIFF, staged: true, recentSubjects: [] });
    expect(prompt).toContain("Conventional");
    expect(prompt).toContain("ONLY the commit message text");
    expect(prompt).toContain("Do not use any tool");
  });

  it("carries the repository's own subjects, which is the style that matters", () => {
    const prompt = commitPrompt({
      diff: DIFF,
      staged: true,
      recentSubjects: ["feat(cart): add totals", "fix: rounding"],
    });
    expect(prompt).toContain("feat(cart): add totals");
    expect(prompt).toContain("match their");
  });

  it("keeps subjects to their first line, because bodies are not style", () => {
    const prompt = commitPrompt({
      diff: DIFF,
      staged: true,
      recentSubjects: ["feat: subject\n\na long body\nwith lines"],
    });
    expect(prompt).toContain("feat: subject");
    expect(prompt).not.toContain("a long body");
  });

  it("says which diff it is describing", () => {
    expect(commitPrompt({ diff: DIFF, staged: true, recentSubjects: [] })).toContain("staged diff");
    expect(commitPrompt({ diff: DIFF, staged: false, recentSubjects: [] })).toContain(
      "nothing is staged",
    );
  });

  it("caps a huge diff without growing it", () => {
    const prompt = commitPrompt({
      diff: "x".repeat(MAX_COMMIT_DIFF_CHARS * 2),
      staged: true,
      recentSubjects: [],
    });
    expect(prompt).toContain("diff truncated");
    expect(prompt.length).toBeLessThan(MAX_COMMIT_DIFF_CHARS + 2_000);
  });
});

describe("cleaning the answer", () => {
  it("passes a clean message through", () => {
    expect(cleanMessage("feat(cart): sum item prices")).toBe("feat(cart): sum item prices");
  });

  it("keeps a subject-and-body message whole", () => {
    const message = "fix: round totals\n\nCents were truncated.";
    expect(cleanMessage(message)).toBe(message);
  });

  it("strips a fence the model added despite instructions", () => {
    expect(cleanMessage("```\nfeat: x\n```")).toBe("feat: x");
    expect(cleanMessage("```text\nfeat: x\n```")).toBe("feat: x");
  });

  it("strips wrapping quotes, straight and curly", () => {
    expect(cleanMessage('"feat: x"')).toBe("feat: x");
    expect(cleanMessage("“feat: x”")).toBe("feat: x");
  });

  it("does not strip a quote that is part of the message", () => {
    // Only a *wrapping* pair goes; an apostrophe or an internal quote stays.
    expect(cleanMessage(`fix: handle "quoted" flags`)).toBe(`fix: handle "quoted" flags`);
  });

  it("says undefined for an empty answer rather than committing nothing", () => {
    expect(cleanMessage("")).toBeUndefined();
    expect(cleanMessage('""')).toBeUndefined();
    expect(cleanMessage("```\n\n```")).toBeUndefined();
  });
});
