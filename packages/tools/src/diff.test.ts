import { describe, expect, it } from "vitest";
import { createUnifiedDiff } from "./diff.js";

describe("createUnifiedDiff", () => {
  it("returns an empty string when content is unchanged", () => {
    expect(createUnifiedDiff("a.txt", "same\n", "same\n")).toBe("");
  });

  it("marks removed and added lines", () => {
    const diff = createUnifiedDiff("a.txt", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(diff).toContain("--- a/a.txt");
    expect(diff).toContain("+++ b/a.txt");
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain(" one");
    expect(diff).toContain(" three");
  });

  it("handles pure insertions", () => {
    const diff = createUnifiedDiff("a.txt", "one\n", "one\ntwo\n");
    expect(diff).toContain("+two");
  });

  it("handles pure deletions", () => {
    const diff = createUnifiedDiff("a.txt", "one\ntwo\n", "one\n");
    expect(diff).toContain("-two");
  });
});
