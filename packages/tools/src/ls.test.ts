import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("ls tool — entries are what the filesystem says they are", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-ls-links-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("shows a symlinked directory as a directory, not as a file with the link's size", async () => {
    // `readdir(..., { withFileTypes: true })` does not stat through a link, so
    // `isDirectory()` is false for `linkdir` and it was rendered as a file
    // whose "size" was the directory inode's byte count. The tool's own
    // description promises directories are suffixed with "/", so a model told
    // `linkdir  (96B)` reads it back with `read` and is told it is a directory.
    await mkdir(join(dir, "real"));
    await writeFile(join(dir, "real", "inner.txt"), "hello");
    await symlink(join(dir, "real"), join(dir, "linkdir"));

    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({}, ctx);
    const lines = (result.content[0] as { text: string }).text.split("\n");

    expect(lines).toContain("linkdir/");
    // And the claim holds up: listing what it named gives that directory.
    const nested = await tool.execute({ path: "linkdir" }, ctx);
    expect((nested.content[0] as { text: string }).text).toContain("inner.txt");
  });

  it("shows a symlinked file with the target's size", async () => {
    await writeFile(join(dir, "target.txt"), "0123456789");
    await symlink(join(dir, "target.txt"), join(dir, "alias.txt"));

    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({}, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toMatch(/alias\.txt\s+\(10B\)/);
  });

  it("lists a dangling symlink without claiming it is a directory", async () => {
    await symlink(join(dir, "gone.txt"), join(dir, "dangling.txt"));

    const tool = createLsTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({}, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(result.isError).toBeFalsy();
    expect(text).toContain("dangling.txt");
    expect(text).not.toContain("dangling.txt/");
  });
});
