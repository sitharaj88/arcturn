import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLsTool } from "./ls.js";
import { createFakeContext } from "./test-utils.js";

describe("ls tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-ls-"));
    await mkdir(join(dir, "zdir"));
    await mkdir(join(dir, "adir"));
    await writeFile(join(dir, "file.txt"), "12345");
    await writeFile(join(dir, "another.txt"), "1");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists directory contents with directories suffixed and files sized", async () => {
    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({}, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("zdir/");
    expect(text).toContain("adir/");
    expect(text).toContain("file.txt");
    expect(text).toMatch(/file\.txt\s+\(5B\)/);
  });

  it("sorts directories first, then alphabetically", async () => {
    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({}, ctx);
    const text = (result.content[0] as { text: string }).text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("adir/");
    expect(lines[1]).toBe("zdir/");
  });

  it("resolves a relative path against ctx.cwd", async () => {
    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "zdir" }, ctx);
    expect((result.content[0] as { text: string }).text).toBe("(empty directory)");
  });

  it("returns isError for a missing directory", async () => {
    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "nope" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("does not request permission", async () => {
    const tool = createLsTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({}, ctx);
    expect(permissionRequests).toHaveLength(0);
  });
});
