import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "./edit.js";
import { createFakeContext, denyAllPermissions } from "./test-utils.js";

describe("edit tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-edit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a unique occurrence", async () => {
    await writeFile(join(dir, "a.txt"), "const x = 1;\nconst y = 2;\n");
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute(
      { path: "a.txt", oldText: "const x = 1;", newText: "const x = 42;" },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const written = await readFile(join(dir, "a.txt"), "utf8");
    expect(written).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("errors with an occurrence count when oldText is ambiguous and replaceAll is not set", async () => {
    await writeFile(join(dir, "dup.txt"), "foo\nfoo\nfoo\n");
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "dup.txt", oldText: "foo", newText: "bar" }, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("3 occurrences");
  });

  it("replaces every occurrence when replaceAll is true", async () => {
    await writeFile(join(dir, "dup.txt"), "foo\nfoo\nfoo\n");
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute(
      { path: "dup.txt", oldText: "foo", newText: "bar", replaceAll: true },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ replacements: 3 });
    const written = await readFile(join(dir, "dup.txt"), "utf8");
    expect(written).toBe("bar\nbar\nbar\n");
  });

  it("rejects when oldText equals newText", async () => {
    await writeFile(join(dir, "a.txt"), "same\n");
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "a.txt", oldText: "same", newText: "same" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("errors when the file does not exist", async () => {
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "missing.txt", oldText: "a", newText: "b" }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("includes a unified diff in the result details", async () => {
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "a.txt", oldText: "two", newText: "TWO" }, ctx);

    const details = result.details as { diff: string };
    expect(details.diff).toContain("-two");
    expect(details.diff).toContain("+TWO");
    expect(details.diff).toContain("@@");
  });

  it("requests permission with the resolved path as subject", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    const tool = createEditTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ path: "a.txt", oldText: "one", newText: "1" }, ctx);

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].subject).toBe(join(dir, "a.txt"));
  });

  it("does not modify the file when permission is denied", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir, onPermissionRequest: denyAllPermissions() });

    const result = await tool.execute({ path: "a.txt", oldText: "one", newText: "1" }, ctx);

    expect(result.isError).toBe(true);
    const written = await readFile(join(dir, "a.txt"), "utf8");
    expect(written).toBe("one\n");
  });
});
