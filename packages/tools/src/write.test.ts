import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "./edit.js";
import { createFakeContext, denyAllPermissions } from "./test-utils.js";
import { createWriteTool, LARGE_CONTENT_CHARS } from "./write.js";

describe("write tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

describe("write tool — bytes on disk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-write-bytes-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("writes the content verbatim, CRLF and a missing trailing newline included", async () => {
    const content = "first\r\nsecond\r\nno trailing newline";
    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd: dir });

    await tool.execute({ path: "verbatim.txt", content }, ctx);

    expect(await readFile(join(dir, "verbatim.txt"))).toEqual(Buffer.from(content, "utf8"));
  });

  it("reports the byte count the file actually has, not the character count", async () => {
    const content = "café ☕\n"; // 7 characters, 11 UTF-8 bytes
    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "utf8.txt", content }, ctx);

    const onDisk = await stat(join(dir, "utf8.txt"));
    expect((result.details as { bytes: number }).bytes).toBe(onDisk.size);
    expect(await readFile(join(dir, "utf8.txt"), "utf8")).toBe(content);
  });

  it("truncates when overwriting with shorter content, leaving no tail behind", async () => {
    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd: dir });

    await tool.execute({ path: "shrink.txt", content: "a very long original line\n" }, ctx);
    await tool.execute({ path: "shrink.txt", content: "short\n" }, ctx);

    expect(await readFile(join(dir, "shrink.txt"))).toEqual(Buffer.from("short\n"));
  });

  it("does not damage an existing file when it is used as a parent directory", async () => {
    const blocker = join(dir, "not-a-dir.txt");
    await writeFile(blocker, "important\n");

    const tool = createWriteTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({ path: "not-a-dir.txt/child.txt", content: "x" }, ctx);

    expect(result.isError).toBe(true);
    expect(await readFile(blocker, "utf8")).toBe("important\n");
  });
});

/**
 * The rule a model reads before it fills in `content`.
 *
 * Four times in one week a write-lane role reasoned for 35–70K characters,
 * decided to write a ~30 KB document, and then ended its turn without emitting
 * the `write` call at all. Nothing here refuses a large `content` — an 8 KB
 * source file in one call is legitimate — but the tool's own description is
 * the last place the model looks before making the call that fails, so the
 * way out is written there.
 */
describe("write tool — the large-content rule in its own definition", () => {
  it("names the threshold and the way out, in the tool description", () => {
    const { description } = createWriteTool().definition;
    expect(description).toContain(LARGE_CONTENT_CHARS.toLocaleString("en-US"));
    expect(description).toContain("in parts");
    expect(description).toContain("`edit`");
  });

  it("says it again on `content`, which is the argument that overflows", () => {
    const properties = createWriteTool().definition.parameters.properties as Record<
      string,
      { description?: string }
    >;
    expect(properties.content?.description).toContain(LARGE_CONTENT_CHARS.toLocaleString("en-US"));
    expect(properties.content?.description).toContain("headings or skeleton");
  });

  it("points edit at the other half of the same rule", () => {
    // A model that read only `edit` still has to learn that filling a large
    // file one section at a time is what this tool is for.
    const { description } = createEditTool().definition;
    expect(description).toContain(LARGE_CONTENT_CHARS.toLocaleString("en-US"));
    expect(description).toContain("one section per call");
  });

  it("quotes the same number `@arcturn/core` prompts with", () => {
    // This package depends on `@arcturn/types` alone, so the constant is
    // duplicated rather than imported. If the two ever disagree the prompts
    // and the tool schema tell the model different things.
    expect(LARGE_CONTENT_CHARS).toBe(6_000);
  });
});
