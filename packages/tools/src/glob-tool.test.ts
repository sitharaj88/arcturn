import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGlobTool } from "./glob-tool.js";
import { resolvePath } from "./path-utils.js";
import { createFakeContext } from "./test-utils.js";

describe("glob tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-glob-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "old.ts"), "old");
    await writeFile(join(dir, "src", "new.ts"), "new");
    await writeFile(join(dir, "readme.md"), "docs");
    // Make mtimes deterministic and distinct.
    const oldTime = new Date(Date.now() - 60_000);
    const newTime = new Date();
    await utimes(join(dir, "src", "old.ts"), oldTime, oldTime);
    await utimes(join(dir, "src", "new.ts"), newTime, newTime);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds files matching a glob pattern", async () => {
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.ts" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/old.ts");
    expect(text).toContain("src/new.ts");
    expect(text).not.toContain("readme.md");
  });

  it("spells every result with forward slashes, whatever the host separator is", async () => {
    // Same contract as `grep`, same reason: the model re-encodes these paths
    // into a JSON tool call, where a `\` is an escape character.
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.ts" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    const lines = text.split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);
    expect(text).not.toContain("\\");
    for (const line of lines) {
      expect(existsSync(resolvePath(dir, line))).toBe(true);
    }
  });

  it("sorts results by most recently modified first", async () => {
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.ts" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    const lines = text.split("\n");
    expect(lines[0]).toContain("new.ts");
    expect(lines[1]).toContain("old.ts");
  });

  it("accepts an array of patterns", async () => {
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: ["**/*.ts", "**/*.md"] }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("readme.md");
    expect(text).toContain("old.ts");
  });

  it("does not request permission", async () => {
    const tool = createGlobTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ pattern: "**/*.ts" }, ctx);
    expect(permissionRequests).toHaveLength(0);
  });

  it("returns a helpful message when nothing matches", async () => {
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.nonexistent" }, ctx);
    expect((result.content[0] as { text: string }).text).toContain("No files matched");
  });
});

describe("glob tool — a no-files answer must mean it looked", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-glob-absence-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("errors on a base path that does not exist instead of reporting no files", async () => {
    // `tinyglobby` on a missing cwd returns an empty list, which is
    // indistinguishable from "this directory has no .ts files in it". The
    // model reads the second meaning and stops looking.
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.ts", path: "typo-dir" }, ctx);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("No files matched");
    expect(text).toContain("typo-dir");
  });

  it("errors when the base path is a file rather than a directory", async () => {
    await writeFile(join(dir, "not-a-dir.txt"), "x");
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.ts", path: "not-a-dir.txt" }, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).not.toContain("No files matched");
  });

  it("still reports no files for a real directory that genuinely has none", async () => {
    await mkdir(join(dir, "empty"));
    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "**/*.ts", path: "empty" }, ctx);

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("No files matched");
  });

  it("every path it returns exists and matches the requested extension", async () => {
    await mkdir(join(dir, "pkg"), { recursive: true });
    await writeFile(join(dir, "pkg", "a.ts"), "a");
    await writeFile(join(dir, "pkg", "b.js"), "b");

    const tool = createGlobTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({ pattern: "**/*.ts" }, ctx);

    const lines = (result.content[0] as { text: string }).text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(line.endsWith(".ts")).toBe(true);
      expect((await stat(resolvePath(dir, line))).isFile()).toBe(true);
    }
  });
});
