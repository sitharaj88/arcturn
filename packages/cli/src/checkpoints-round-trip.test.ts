/**
 * Byte-level round trips for `/rewind` on the local path: snapshot a real
 * file, change it for real, restore, then assert on what is *on disk* — the
 * bytes, the mode, whether the path is still the same kind of thing it was.
 *
 * `checkpoints.test.ts` covers the manifest's bookkeeping. This file covers
 * the only question a user actually asks of a rewind: is my file back?
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointStore, wrapToolsWithCheckpoints } from "./checkpoints.js";

function fakeContext(cwd: string): ToolExecutionContext {
  return {
    cwd,
    signal: new AbortController().signal,
    requestPermission: async () => ({ requestId: "r", behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "s1",
    toolCallId: "t1",
  };
}

/** A stand-in for the real `write` tool: resolves against cwd and follows links. */
function writeTool(): Tool {
  return {
    definition: {
      name: "write",
      description: "write",
      parameters: { type: "object", properties: {} },
    },
    async execute(input): Promise<ToolResult> {
      await writeFile(resolve(cwdOf(input), String(input.path)), String(input.content), "utf8");
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

/** The wrapper hands cwd through the context; the stub only needs the path. */
function cwdOf(input: Record<string, unknown>): string {
  return typeof input.cwd === "string" ? input.cwd : workDir;
}

let root: string;
let storeDir: string;
let workDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "arcturn-checkpoint-round-trip-"));
  storeDir = join(root, "store");
  workDir = join(root, "work");
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function newStore() {
  return createCheckpointStore(storeDir, { restoreRoot: workDir });
}

describe("restore puts the bytes back", () => {
  it("restores a binary file byte for byte, including its NUL bytes", async () => {
    const store = newStore();
    const path = join(workDir, "logo.bin");
    const original = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await writeFile(path, original);

    const turn = await store.beginTurn("touch the binary");
    await store.snapshot(path);
    await writeFile(path, Buffer.from([0x01, 0x02]));

    await store.restore(turn);
    expect(await readFile(path)).toEqual(original);
  });

  it("restores an empty file as empty rather than deleting it", async () => {
    const store = newStore();
    const path = join(workDir, "empty.txt");
    await writeFile(path, "");

    const turn = await store.beginTurn("fill the empty file");
    await store.snapshot(path);
    await writeFile(path, "no longer empty", "utf8");

    const result = await store.restore(turn);
    expect(result.deleted).toEqual([]);
    expect(await stat(path)).toMatchObject({ size: 0 });
  });

  it("brings back a file that was deleted after the checkpoint", async () => {
    const store = newStore();
    const path = join(workDir, "gone.txt");
    await writeFile(path, "still here", "utf8");

    const turn = await store.beginTurn("delete it");
    await store.snapshot(path);
    await rm(path);

    await store.restore(turn);
    expect(await readFile(path, "utf8")).toBe("still here");
  });

  it("is idempotent: restoring twice leaves the same bytes, not a mangled file", async () => {
    const store = newStore();
    const kept = join(workDir, "kept.txt");
    const created = join(workDir, "created.txt");
    await writeFile(kept, "before", "utf8");

    const turn = await store.beginTurn("edit and create");
    await store.snapshot(kept);
    await writeFile(kept, "after", "utf8");
    await store.snapshot(created);
    await writeFile(created, "new file", "utf8");

    const first = await store.restore(turn);
    const second = await store.restore(turn);
    expect(second.errors).toEqual([]);
    expect(second.restored).toEqual(first.restored);
    expect(await readFile(kept, "utf8")).toBe("before");
    await expect(stat(created)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restoring to the newest turn changes nothing it should not", async () => {
    const store = newStore();
    const path = join(workDir, "a.txt");
    await writeFile(path, "v1", "utf8");

    const first = await store.beginTurn("first");
    await store.snapshot(path);
    await writeFile(path, "v2", "utf8");
    // The newest turn has not touched anything yet — the ordinary shape of
    // "rewind to the turn I am in the middle of".
    const newest = await store.beginTurn("newest");

    const plan = await store.planRestore(newest);
    expect(plan.steps).toEqual([]);
    const result = await store.restore(newest);
    expect(result).toEqual({ restored: [], deleted: [], errors: [] });
    expect(await readFile(path, "utf8")).toBe("v2");
    // ...and the older turn is still reachable and still correct.
    await store.restore(first);
    expect(await readFile(path, "utf8")).toBe("v1");
  });
});

describe("restore preserves what a file IS, not only what it contains", () => {
  it("keeps the executable bit on a restored script", async () => {
    const store = newStore();
    const path = join(workDir, "run.sh");
    await writeFile(path, "#!/bin/sh\necho v1\n", "utf8");
    await chmod(path, 0o755);

    const turn = await store.beginTurn("edit the script");
    await store.snapshot(path);
    await writeFile(path, "#!/bin/sh\necho v2\n", "utf8");

    await store.restore(turn);
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho v1\n");
    const mode = (await stat(path)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  it("does not replace a symlink with a regular file", async () => {
    const store = newStore();
    const target = join(workDir, "target.txt");
    const link = join(workDir, "link.txt");
    await writeFile(target, "v1", "utf8");
    await symlink(target, link);

    // Through the wrapper, because the wiring is half the bug: the wrapper is
    // what decides WHICH path gets snapshotted.
    const [write] = wrapToolsWithCheckpoints([writeTool()], store);
    const turn = await store.beginTurn("write through the link");
    await write!.execute({ path: link, content: "v2" }, fakeContext(workDir));
    expect(await readFile(target, "utf8")).toBe("v2");

    await store.restore(turn);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, "utf8")).toBe("v1");
  });

  it("still snapshots an ordinary file under the path the caller spelled", async () => {
    const store = newStore();
    const path = join(workDir, "plain.txt");
    await writeFile(path, "v1", "utf8");

    const [write] = wrapToolsWithCheckpoints([writeTool()], store);
    const turn = await store.beginTurn("edit a plain file");
    await write!.execute({ path: "plain.txt", content: "v2" }, fakeContext(workDir));

    const plan = await store.planRestore(turn);
    expect(plan.steps).toEqual([{ path, action: "restore" }]);
    await store.restore(turn);
    expect(await readFile(path, "utf8")).toBe("v1");
  });
});
