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

/**
 * Effect-asserting cases: every expectation below is on the *bytes on disk*
 * after the call, not on what the call returned. A tool that reports
 * `Edited …` while it silently rewrote bytes the caller never named passes
 * every assertion that only looks at the result.
 */
describe("edit tool — bytes on disk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-edit-bytes-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a file that is not valid UTF-8 instead of corrupting the bytes around the edit", async () => {
    // `0xe9` is `é` in Latin-1 and an invalid UTF-8 byte. Decoding the file as
    // UTF-8 turns it into U+FFFD, and writing the result back re-encodes that
    // as `EF BF BD` — three bytes replacing one, in a line the caller never
    // mentioned. The old tool did exactly that and reported success.
    const path = join(dir, "latin1.txt");
    const original = Buffer.concat([
      Buffer.from("caf", "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("\nTARGET\n"),
    ]);
    await writeFile(path, original);

    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute(
      { path: "latin1.txt", oldText: "TARGET", newText: "REPLACED" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not valid UTF-8");
    expect(await readFile(path)).toEqual(original);
  });

  it("does not write when the file changed between the read and the permission grant", async () => {
    // The permission prompt sits in front of a human for as long as it takes
    // them to answer. `newContent` was spliced from a snapshot taken before
    // it; writing that snapshot back discards whatever the user's editor, a
    // formatter, or a parallel tool call saved in the meantime — silently,
    // while reporting a successful edit.
    const path = join(dir, "race.txt");
    await writeFile(path, "alpha\nbeta\n");
    const concurrent = "alpha\nbeta\nadded by someone else\n";

    const tool = createEditTool();
    const { ctx } = createFakeContext({
      cwd: dir,
      onPermissionRequest: async () => {
        await writeFile(path, concurrent);
        return { requestId: "test", behavior: "allow" };
      },
    });

    const result = await tool.execute(
      { path: "race.txt", oldText: "alpha", newText: "ALPHA" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("changed on disk");
    // The concurrent write survived intact — no part of it was clobbered.
    expect(await readFile(path, "utf8")).toBe(concurrent);
  });

  it("leaves the file byte-identical when the edit fails to match", async () => {
    const path = join(dir, "unchanged.txt");
    const original = Buffer.from("one\ntwo\nthree\n");
    await writeFile(path, original);

    const tool = createEditTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });
    const result = await tool.execute(
      { path: "unchanged.txt", oldText: "four", newText: "5" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(await readFile(path)).toEqual(original);
    // A failed match must not even reach the prompt.
    expect(permissionRequests).toHaveLength(0);
  });

  it("preserves a CRLF file's exact bytes outside the replaced region", async () => {
    const path = join(dir, "crlf.txt");
    await writeFile(path, Buffer.from("one\r\ntwo\r\nthree\r\n"));

    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });
    // The model reads lines split on "\n", so the oldText it echoes back is
    // LF-joined even though the file is CRLF.
    const result = await tool.execute(
      { path: "crlf.txt", oldText: "one\ntwo", newText: "ONE\nTWO" },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(path)).toEqual(Buffer.from("ONE\r\nTWO\r\nthree\r\n"));
  });

  it("does not invent a trailing newline in a file that has none", async () => {
    const path = join(dir, "no-trailing-newline.txt");
    await writeFile(path, Buffer.from("first\nlast"));

    const tool = createEditTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute(
      { path: "no-trailing-newline.txt", oldText: "last", newText: "final" },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(path)).toEqual(Buffer.from("first\nfinal"));
  });
});
