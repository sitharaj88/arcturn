import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkFile } from "./chunker.js";
import { buildPostings, CodeIndexStore, contentHash, INDEX_FORMAT_VERSION } from "./store.js";
import { createTempIndexDir } from "./test-helpers/fixtures.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

async function freshDir(): Promise<string> {
  const dir = await createTempIndexDir();
  dirs.push(dir);
  return dir;
}

const SOURCE = "export class TokenBucket {\n  tryConsume(n: number) { return true; }\n}\n";

describe("CodeIndexStore", () => {
  it("round-trips chunks and file hashes through disk", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", contentHash(SOURCE), SOURCE.length, chunkFile("src/a.ts", SOURCE));
    await store.save();

    const reopened = await CodeIndexStore.open(dir, "/repo");
    expect(reopened.fileCount).toBe(1);
    expect(reopened.chunkCount).toBe(store.chunkCount);
    expect(reopened.hashOf("src/a.ts")).toBe(contentHash(SOURCE));
    expect(reopened.allChunks().map((c) => c.name)).toEqual(store.allChunks().map((c) => c.name));
  });

  it("keys files by content hash, not mtime", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", contentHash(SOURCE), SOURCE.length, chunkFile("src/a.ts", SOURCE));
    expect(store.hashOf("src/a.ts")).toBe(contentHash(SOURCE));
    expect(store.hashOf("src/a.ts")).not.toBe(contentHash(`${SOURCE}// changed\n`));
  });

  it("removes a file and its chunks", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", "h", 1, chunkFile("src/a.ts", SOURCE));
    expect(store.removeFile("src/a.ts")).toBe(true);
    expect(store.removeFile("src/a.ts")).toBe(false);
    expect(store.chunkCount).toBe(0);
  });

  it("rebuilds silently when the persisted format version is stale", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", "h", 1, chunkFile("src/a.ts", SOURCE));
    await store.save();

    const metaPath = join(dir, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    meta.formatVersion = INDEX_FORMAT_VERSION + 1;
    await writeFile(metaPath, JSON.stringify(meta), "utf8");

    const reopened = await CodeIndexStore.open(dir, "/repo");
    expect(reopened.chunkCount).toBe(0);
  });

  it("rebuilds silently when the index belongs to a different root", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", "h", 1, chunkFile("src/a.ts", SOURCE));
    await store.save();

    const elsewhere = await CodeIndexStore.open(dir, "/other-repo");
    expect(elsewhere.chunkCount).toBe(0);
  });

  it("rebuilds silently when chunks.jsonl is truncated mid-line", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", "h", 1, chunkFile("src/a.ts", SOURCE));
    await store.save();

    const chunksPath = join(dir, "chunks.jsonl");
    const raw = await readFile(chunksPath, "utf8");
    await writeFile(chunksPath, `${raw.slice(0, raw.length - 30)}\n`, "utf8");

    const reopened = await CodeIndexStore.open(dir, "/repo");
    expect(reopened.chunkCount).toBe(0);
    expect(reopened.fileCount).toBe(0);
  });

  it("rebuilds postings when the persisted ones do not match the chunk count", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", "h", 1, chunkFile("src/a.ts", SOURCE));
    await store.save();

    await writeFile(
      join(dir, "postings.json"),
      JSON.stringify({
        formatVersion: INDEX_FORMAT_VERSION,
        documentCount: 999,
        avgDocLength: 1,
        docLengths: [],
        terms: {},
      }),
      "utf8",
    );

    const reopened = await CodeIndexStore.open(dir, "/repo");
    const snapshot = reopened.snapshot();
    expect(snapshot.postings.get("tokenbucket")).toBeDefined();
  });

  it("survives a missing index directory entirely", async () => {
    const store = await CodeIndexStore.open("/definitely/not/here", "/repo");
    expect(store.chunkCount).toBe(0);
    expect(store.snapshot().chunks).toEqual([]);
  });

  it("writes atomically, leaving no stray temp files", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    store.setFile("src/a.ts", "h", 1, chunkFile("src/a.ts", SOURCE));
    await store.save();
    await expect(readFile(join(dir, "chunks.jsonl.tmp"), "utf8")).rejects.toThrow();
  });

  it("stores and reloads embedding vectors keyed by chunk id", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    const chunks = chunkFile("src/a.ts", SOURCE);
    store.setFile("src/a.ts", "h", 1, chunks);
    const first = chunks[0];
    if (!first) throw new Error("expected a chunk");
    store.setVectors("fake-embedder", new Map([[first.id, [1, 0, 0]]]));
    await store.save();

    const reopened = await CodeIndexStore.open(dir, "/repo");
    expect(reopened.storedEmbedderId).toBe("fake-embedder");
    expect(reopened.snapshot().vectors?.size).toBe(1);
  });

  it("discards vectors when the embedder identity changes", async () => {
    const dir = await freshDir();
    const store = await CodeIndexStore.open(dir, "/repo");
    const chunks = chunkFile("src/a.ts", SOURCE);
    store.setFile("src/a.ts", "h", 1, chunks);
    const first = chunks[0];
    if (!first) throw new Error("expected a chunk");
    store.setVectors("model-a", new Map([[first.id, [1, 0, 0]]]));
    store.setVectors("model-b", new Map());
    expect(store.chunksMissingVectors()).toHaveLength(chunks.length);
  });
});

describe("buildPostings", () => {
  it("weights the name far above a body mention", () => {
    const named = chunkFile("src/a.ts", "export class TokenBucket {}")[0];
    const mentioning = chunkFile(
      "src/b.ts",
      "export function build() { return new TokenBucket(); }",
    )[0];
    if (!named || !mentioning) throw new Error("expected chunks");

    const { postings } = buildPostings([named, mentioning]);
    const entries = postings.get("tokenbucket") ?? [];
    const frequencies = new Map<number, number>();
    for (let i = 0; i < entries.length; i += 2) {
      frequencies.set(entries[i] ?? -1, entries[i + 1] ?? 0);
    }
    expect((frequencies.get(0) ?? 0) > (frequencies.get(1) ?? 0)).toBe(true);
  });

  it("reports an average document length of zero for an empty index", () => {
    expect(buildPostings([]).avgDocLength).toBe(0);
  });
});
