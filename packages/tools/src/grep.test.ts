import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "./grep.js";
import { resolvePath } from "./path-utils.js";
import { createFakeContext } from "./test-utils.js";

describe("grep tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-grep-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export function needle() {\n  return 1;\n}\n");
    await writeFile(join(dir, "src", "b.ts"), "// no match here\nconst x = 1;\n");
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "needle needle needle");
    await writeFile(join(dir, ".git", "config"), "needle in git config");
    await writeFile(
      join(dir, "binary.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("finds matches and skips .git, node_modules, and binary files", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(".git");
    expect(text).not.toContain("binary.bin");
  });

  it("spells every match's path with forward slashes, whatever the host separator is", async () => {
    // Not cosmetic. The model hands this path straight back in the next tool
    // call, inside a JSON string, and `"src\new.ts"` is valid JSON whose value
    // is `src`, a newline, `ew.ts` — a Windows-shaped path silently becomes a
    // corrupted `read` argument that nobody can see go wrong. `/` has no such
    // trap and win32 accepts it everywhere `\` works.
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle" }, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("src/a.ts:1:");
    expect(text).not.toContain("\\");
    // ...and the rendered path is a path: it resolves back to the file it named.
    const rendered = (text.split(":")[0] ?? "").trim();
    expect(resolvePath(dir, rendered)).toBe(join(dir, "src", "a.ts"));
  });

  it("supports case-insensitive search", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "NEEDLE", caseInsensitive: true }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts");
  });

  it("filters by glob", async () => {
    await writeFile(join(dir, "src", "c.md"), "needle in markdown");
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle", glob: "**/*.ts" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).not.toContain("c.md");
  });

  it("includes context lines when requested", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "return 1", contextLines: 1 }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("export function needle()");
    expect(text).toContain("}");
  });

  it("returns a no-matches message when nothing matches", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "zzz_not_present_zzz" }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("No matches");
  });

  it("returns isError for an invalid regular expression", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "(unclosed" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("does not request permission", async () => {
    const tool = createGrepTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ pattern: "needle" }, ctx);
    expect(permissionRequests).toHaveLength(0);
  });
});

describe("grep tool given a file path", () => {
  // Found by a live watched-fire run (wave 3): a model asked grep for a
  // pattern in a single file and was told "No matches found" — walk() calls
  // readdir on the file, ENOTDIR is swallowed, and zero files are searched.
  // A silent false negative from a search tool is the worst kind of wrong
  // answer: it reads as evidence of absence.
  it("searches the file itself instead of silently finding nothing", async () => {
    const { mkdtemp: mkd, rm: rmrf, writeFile: wf } = await import("node:fs/promises");
    const { tmpdir: tmp } = await import("node:os");
    const dir = await mkd(join(tmp(), "arcturn-grep-file-"));
    try {
      await wf(
        join(dir, "README.md"),
        "# module\n\nTo complete review, run: terraform apply -auto-approve\n",
      );
      const tool = createGrepTool();
      const { ctx } = createFakeContext({ cwd: dir });

      const result = await tool.execute({ pattern: "apply", path: "README.md" }, ctx);

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("README.md");
      expect(text).toContain("terraform apply -auto-approve");
      expect(text).not.toContain("No matches found");
    } finally {
      await rmrf(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

/**
 * "No matches" is an *answer*, and a model reads it as evidence of absence.
 * Every case here checks that grep only gives that answer when it actually
 * searched something — the same failure the wave-3 file-path bug had, in the
 * two other shapes it still has.
 */
describe("grep tool — a no-matches answer must mean it searched", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-grep-absence-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("errors on a path that does not exist instead of reporting no matches", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle", path: "typo-dir" }, ctx);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("No matches");
    expect(text).toContain("typo-dir");
  });

  it("errors on a file path that does not exist instead of reporting no matches", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle", path: "src/typo.ts" }, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).not.toContain("No matches");
  });

  it("searches a symlinked directory, exactly as the same call with a glob already does", async () => {
    // A repo with `docs -> ../shared-docs` is ordinary. `walk()` classified
    // that dirent as neither a file nor a directory and dropped the whole
    // subtree, while `tinyglobby` — the path the *same tool* takes when a
    // `glob` argument is present — walked into it. One grep, two answers,
    // depending on an argument that is supposed to only narrow the search.
    const outside = await mkdtemp(join(tmpdir(), "arcturn-grep-shared-"));
    try {
      await writeFile(join(outside, "shared.md"), "needle in the shared docs\n");
      await symlink(outside, join(dir, "docs"));
      await writeFile(join(dir, "own.txt"), "needle at home\n");

      const tool = createGrepTool();
      const { ctx } = createFakeContext({ cwd: dir });

      const bare = await tool.execute({ pattern: "needle" }, ctx);
      const narrowed = await tool.execute({ pattern: "needle", glob: "**/*.md" }, ctx);

      const bareText = (bare.content[0] as { text: string }).text;
      expect(bareText).toContain("own.txt");
      expect(bareText).toContain("docs/shared.md");
      // Narrowing with a glob may drop files; it must never *add* one.
      expect((narrowed.content[0] as { text: string }).text).toContain("docs/shared.md");
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("terminates on a symlink cycle instead of walking it forever", async () => {
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", "found.txt"), "needle\n");
    await symlink(join(dir), join(dir, "a", "loop"));

    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({ pattern: "needle" }, ctx);

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("a/found.txt");
  });

  it("every path it reports resolves back to a file that contains the match", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "nested", "hit.txt"), "one\nthe needle here\nthree\n");
    await writeFile(join(dir, "miss.txt"), "nothing\n");

    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({ pattern: "needle" }, ctx);

    const lines = (result.content[0] as { text: string }).text.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const path = line.slice(0, line.indexOf(":"));
      const contents = await readFile(resolvePath(dir, path), "utf8");
      expect(contents).toContain("needle");
    }
  });
});
