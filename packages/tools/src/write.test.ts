import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeContext, denyAllPermissions } from "./test-utils.js";
import { createWriteTool } from "./write.js";

describe("write tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a new file, making parent directories as needed", async () => {
    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "nested/deep/file.txt", content: "hello" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ created: true, bytes: 5 });
    const written = await readFile(join(dir, "nested/deep/file.txt"), "utf8");
    expect(written).toBe("hello");
  });

  it("overwrites an existing file and reports created: false", async () => {
    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd: dir });

    await tool.execute({ path: "file.txt", content: "v1" }, ctx);
    const result = await tool.execute({ path: "file.txt", content: "v2" }, ctx);

    expect(result.details).toMatchObject({ created: false });
    const written = await readFile(join(dir, "file.txt"), "utf8");
    expect(written).toBe("v2");
  });

  it("requests permission with the resolved path as subject and a directory glob suggestion", async () => {
    const tool = createWriteTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ path: "sub/file.txt", content: "x" }, ctx);

    expect(permissionRequests).toHaveLength(1);
    const request = permissionRequests[0];
    expect(request.toolName).toBe("write");
    expect(request.subject).toBe(join(dir, "sub/file.txt"));
    expect(request.suggestedRule?.specifier).toBe(`${join(dir, "sub")}/**`);
  });

  it("does not write the file when permission is denied", async () => {
    const tool = createWriteTool();
    const { ctx } = createFakeContext({
      cwd: dir,
      onPermissionRequest: denyAllPermissions("nope"),
    });

    const result = await tool.execute({ path: "denied.txt", content: "x" }, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("nope");
    await expect(readFile(join(dir, "denied.txt"), "utf8")).rejects.toThrow();
  });
});
