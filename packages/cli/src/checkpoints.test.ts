import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointStore, wrapToolsWithCheckpoints } from "./checkpoints.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

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

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    async execute(input): Promise<ToolResult> {
      const path = input.path as string;
      if (input.content !== undefined) {
        await writeFile(path, input.content as string, "utf8");
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

describe("checkpoints", () => {
  let root: string;
  let storeDir: string;
  let workDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arcturn-checkpoints-"));
    storeDir = join(root, "store");
    workDir = join(root, "work");
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a snapshot and restore of a modified file", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "a.txt");
    await writeFile(filePath, "original", "utf8");

    const turnId = await store.beginTurn("edit a.txt");
    await store.snapshot(filePath);
    await writeFile(filePath, "changed", "utf8");

    const turns = await store.listTurns();
    expect(turns).toEqual([
      { id: turnId, label: "edit a.txt", timestamp: expect.any(Number), fileCount: 1 },
    ]);

    const result = await store.restore(turnId);
    expect(result).toEqual({ restored: [filePath], deleted: [], errors: [] });
    expect(await readFile(filePath, "utf8")).toBe("original");
  });

  it("keeps the first snapshot when the same path is snapshotted twice in one turn", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "a.txt");
    await writeFile(filePath, "v1", "utf8");

    const turnId = await store.beginTurn("t1");
    await store.snapshot(filePath); // records "v1"
    await writeFile(filePath, "v2", "utf8");
    await store.snapshot(filePath); // no-op: v1 stays the recorded pre-turn state
    await writeFile(filePath, "v3", "utf8");

    const turns = await store.listTurns();
    expect(turns[0]?.fileCount).toBe(1);

    const result = await store.restore(turnId);
    expect(result.restored).toEqual([filePath]);
    expect(await readFile(filePath, "utf8")).toBe("v1");
  });

  it("deletes a file that was created mid-turn on restore", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "new.txt");
    expect(await exists(filePath)).toBe(false);

    const turnId = await store.beginTurn("create new.txt");
    await store.snapshot(filePath); // records "absent"
    await writeFile(filePath, "hello", "utf8");
    expect(await exists(filePath)).toBe(true);

    const result = await store.restore(turnId);
    expect(result).toEqual({ restored: [], deleted: [filePath], errors: [] });
    expect(await exists(filePath)).toBe(false);
  });

  it("picks the earliest snapshot across multiple turns when restoring an older turn", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "a.txt");
    await writeFile(filePath, "v1", "utf8");

    const turn1 = await store.beginTurn("turn 1");
    await store.snapshot(filePath); // records v1
    await writeFile(filePath, "v2", "utf8");

    await store.beginTurn("turn 2");
    await store.snapshot(filePath); // records v2
    await writeFile(filePath, "v3", "utf8");

    // Restoring turn 1 must undo everything since (v2 and v3), landing back on v1.
    const result = await store.restore(turn1);
    expect(result.restored).toEqual([filePath]);
    expect(await readFile(filePath, "utf8")).toBe("v1");
  });

  it("restoring a later turn only undoes changes from that turn onward", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "a.txt");
    await writeFile(filePath, "v1", "utf8");

    await store.beginTurn("turn 1");
    await store.snapshot(filePath);
    await writeFile(filePath, "v2", "utf8");

    const turn2 = await store.beginTurn("turn 2");
    await store.snapshot(filePath); // records v2
    await writeFile(filePath, "v3", "utf8");

    const result = await store.restore(turn2);
    expect(result.restored).toEqual([filePath]);
    expect(await readFile(filePath, "utf8")).toBe("v2");
  });

  it("reports a clean error when a referenced blob is missing, without throwing", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "a.txt");
    await writeFile(filePath, "original", "utf8");

    const turnId = await store.beginTurn("t1");
    await store.snapshot(filePath);
    await writeFile(filePath, "changed", "utf8");

    // Simulate blob-store corruption / manual deletion.
    const blobsDir = join(storeDir, "blobs");
    const blobFiles = await readdir(blobsDir);
    expect(blobFiles.length).toBeGreaterThan(0);
    for (const blob of blobFiles) await unlink(join(blobsDir, blob));

    const result = await store.restore(turnId);
    expect(result.restored).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe(filePath);
    expect(result.errors[0]?.message.length).toBeGreaterThan(0);
    // File is left untouched since the restore could not be applied.
    expect(await readFile(filePath, "utf8")).toBe("changed");
  });

  it("throws a clear error for an unknown turn id", async () => {
    const store = createCheckpointStore(storeDir);
    await store.beginTurn("t1");
    await expect(store.restore("does-not-exist")).rejects.toThrow(/unknown turn/i);
  });

  it("opens an untracked turn when snapshot() is called before beginTurn()", async () => {
    const store = createCheckpointStore(storeDir);
    const target = join(workDir, "a.txt");
    await writeFile(target, "pre", "utf8");
    // Dropping the snapshot would make the pre-image unrecoverable, so the
    // store opens a synthetic turn instead of throwing.
    await store.snapshot(target);
    const turns = await store.listTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.label).toBe("(untracked)");
    expect(turns[0]?.fileCount).toBe(1);
  });

  it("wraps write and edit tools and snapshots before the mutation happens", async () => {
    const store = createCheckpointStore(storeDir);
    const write = fakeTool("write");
    const read = fakeTool("read");
    const [wrappedWrite, wrappedRead] = wrapToolsWithCheckpoints([write, read], store);

    const filePath = join(workDir, "created-by-tool.txt");
    await store.beginTurn("write via tool");

    expect(await exists(filePath)).toBe(false);
    await wrappedWrite!.execute({ path: filePath, content: "from tool" }, fakeContext(workDir));
    expect(await readFile(filePath, "utf8")).toBe("from tool");

    // The `read` tool is untouched (identity), since it is not write/edit.
    expect(wrappedRead).toBe(read);

    const turns = await store.listTurns();
    expect(turns[0]?.fileCount).toBe(1);
  });

  it("does not block the tool call when snapshot() fails (no active turn)", async () => {
    const store = createCheckpointStore(storeDir);
    const write = fakeTool("write");
    const [wrapped] = wrapToolsWithCheckpoints([write], store);

    const filePath = join(workDir, "no-turn.txt");
    // No beginTurn() call: store.snapshot() will reject, but the tool must still run.
    const result = await wrapped!.execute({ path: filePath, content: "ok" }, fakeContext(workDir));
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(await readFile(filePath, "utf8")).toBe("ok");
  });

  it("serializes concurrent snapshots without corrupting the manifest", async () => {
    const store = createCheckpointStore(storeDir);
    const paths = Array.from({ length: 8 }, (_, i) => join(workDir, `f${i}.txt`));
    for (const p of paths) await writeFile(p, `content-${p}`, "utf8");

    await store.beginTurn("bulk edit");
    await Promise.all(paths.map((p) => store.snapshot(p)));

    const turns = await store.listTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.fileCount).toBe(paths.length);

    const raw = await readFile(join(storeDir, "manifest.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1 + paths.length);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("does not duplicate a manifest entry when snapshot() is called concurrently for the same path", async () => {
    const store = createCheckpointStore(storeDir);
    const filePath = join(workDir, "same.txt");
    await writeFile(filePath, "v1", "utf8");

    await store.beginTurn("t1");
    await Promise.all([
      store.snapshot(filePath),
      store.snapshot(filePath),
      store.snapshot(filePath),
    ]);

    const turns = await store.listTurns();
    expect(turns[0]?.fileCount).toBe(1);
  });
});
