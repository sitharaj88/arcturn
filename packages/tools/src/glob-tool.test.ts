import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGlobTool } from "./glob-tool.js";
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
