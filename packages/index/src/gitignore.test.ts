import { describe, expect, it } from "vitest";
import { IgnoreMatcher, parseIgnoreFile } from "./gitignore.js";

/** Build a matcher from gitignore text rooted at `base`. */
function matcher(text: string, base = ""): IgnoreMatcher {
  return new IgnoreMatcher().add(parseIgnoreFile(text), base);
}

describe("IgnoreMatcher", () => {
  it("ignores comments and blank lines", () => {
    const m = matcher("# a comment\n\n   \n");
    expect(m.isEmpty).toBe(true);
  });

  it("matches a bare name at any depth", () => {
    const m = matcher("secrets.env");
    expect(m.ignores("secrets.env", false)).toBe(true);
    expect(m.ignores("deep/nested/secrets.env", false)).toBe(true);
    expect(m.ignores("secrets.env.example", false)).toBe(false);
  });

  it("anchors a pattern containing a slash", () => {
    const m = matcher("/build\nsrc/generated");
    expect(m.ignores("build", true)).toBe(true);
    expect(m.ignores("packages/app/build", true)).toBe(false);
    expect(m.ignores("src/generated", true)).toBe(true);
    expect(m.ignores("app/src/generated", true)).toBe(false);
  });

  it("honors directory-only patterns", () => {
    const m = matcher("dist/");
    expect(m.ignores("dist", true)).toBe(true);
    expect(m.ignores("dist", false)).toBe(false);
    expect(m.ignores("dist/main.js", false)).toBe(true);
    expect(m.ignores("packages/a/dist/main.js", false)).toBe(true);
  });

  it("supports * and ? within a segment", () => {
    const m = matcher("*.log\ntmp?.txt");
    expect(m.ignores("server.log", false)).toBe(true);
    expect(m.ignores("logs/server.log", false)).toBe(true);
    expect(m.ignores("tmp1.txt", false)).toBe(true);
    expect(m.ignores("tmp12.txt", false)).toBe(false);
  });

  it("supports ** across directories", () => {
    const m = matcher("docs/**/draft.md\n**/cache");
    expect(m.ignores("docs/a/b/draft.md", false)).toBe(true);
    expect(m.ignores("docs/draft.md", false)).toBe(true);
    expect(m.ignores("a/b/cache", true)).toBe(true);
  });

  it("supports character classes", () => {
    const m = matcher("file[0-9].txt");
    expect(m.ignores("file3.txt", false)).toBe(true);
    expect(m.ignores("filex.txt", false)).toBe(false);
  });

  it("lets a later negation re-include a path", () => {
    const m = matcher("*.log\n!keep.log");
    expect(m.ignores("debug.log", false)).toBe(true);
    expect(m.ignores("keep.log", false)).toBe(false);
  });

  it("scopes a nested .gitignore to its own directory", () => {
    const m = matcher("fixtures/", "packages/app");
    expect(m.ignores("packages/app/fixtures", true)).toBe(true);
    expect(m.ignores("packages/other/fixtures", true)).toBe(false);
  });

  it("never throws on a malformed pattern", () => {
    expect(() => matcher("[unterminated\n\\\n**/**/**")).not.toThrow();
  });
});
