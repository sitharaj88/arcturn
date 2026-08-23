import { rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkFile as realChunkFile } from "./chunker.js";
import { indexRepo, looksBinary, looksMinified, type SkipReason } from "./indexer.js";
import { CodeIndexStore } from "./store.js";
import { createTempIndexDir, createTempRepo, type TempRepo } from "./test-helpers/fixtures.js";
import type { CodeChunk, Embedder } from "./types.js";

let repo: TempRepo | null = null;
const indexDirs: string[] = [];

afterEach(async () => {
  await repo?.cleanup();
  repo = null;
  await Promise.all(indexDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A chunker that records every file it is asked to parse. */
function countingChunker(): { calls: string[]; chunk: (f: string, t: string) => CodeChunk[] } {
  const calls: string[] = [];
  return {
    calls,
    chunk(file, text) {
      calls.push(file);
      return realChunkFile(file, text);
    },
  };
}

async function freshStore(root: string): Promise<CodeIndexStore> {
  const dir = await createTempIndexDir();
  indexDirs.push(dir);
  return CodeIndexStore.open(dir, root);
}

const TREE = {
  "src/a.ts": "export function alpha() { return 1; }\n",
  "src/b.ts": "export function beta() { return 2; }\n",
  "src/c.py": "def gamma():\n    return 3\n",
  "README.md": "# Project\n\nDocs here.\n",
};

describe("indexRepo — incremental indexing", () => {
  it("chunks every file on a cold pass", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    const chunker = countingChunker();

    const stats = await indexRepo({ root: repo.root, store, chunkFile: chunker.chunk });

    expect(chunker.calls.sort()).toEqual(["README.md", "src/a.ts", "src/b.ts", "src/c.py"]);
    expect(stats.filesIndexed).toBe(4);
    expect(stats.totalChunks).toBeGreaterThan(3);
  });

  it("re-chunks only the file whose CONTENT changed", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    await repo.write({ "src/b.ts": "export function betaRenamed() { return 22; }\n" });

    const chunker = countingChunker();
    const stats = await indexRepo({ root: repo.root, store, chunkFile: chunker.chunk });

    expect(chunker.calls).toEqual(["src/b.ts"]);
    expect(stats.filesIndexed).toBe(1);
    expect(stats.filesScanned).toBe(4);
    expect(store.allChunks().map((c) => c.name)).toContain("betaRenamed");
    expect(store.allChunks().map((c) => c.name)).not.toContain("beta");
  });

  it("re-chunks NOTHING when only mtimes change (a git checkout must be free)", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    const future = new Date(Date.now() + 60_000);
    for (const relative of Object.keys(TREE)) {
      await utimes(join(repo.root, relative), future, future);
    }

    const chunker = countingChunker();
    const stats = await indexRepo({ root: repo.root, store, chunkFile: chunker.chunk });

    expect(chunker.calls).toEqual([]);
    expect(stats.filesIndexed).toBe(0);
    expect(stats.filesScanned).toBe(4);
  });

  it("re-chunks nothing across a reload from disk either", async () => {
    repo = await createTempRepo(TREE);
    const dir = await createTempIndexDir();
    indexDirs.push(dir);

    const first = await CodeIndexStore.open(dir, repo.root);
    await indexRepo({ root: repo.root, store: first, chunkFile: realChunkFile });

    const second = await CodeIndexStore.open(dir, repo.root);
    const chunker = countingChunker();
    await indexRepo({ root: repo.root, store: second, chunkFile: chunker.chunk });

    expect(chunker.calls).toEqual([]);
    expect(second.chunkCount).toBe(first.chunkCount);
  });

  it("re-chunks a file whose content reverts to a previously seen state", async () => {
    repo = await createTempRepo({ "src/a.ts": "export const one = 1;\n" });
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    await repo.write({ "src/a.ts": "export const two = 2;\n" });
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });
    expect(store.allChunks().map((c) => c.name)).toEqual(["two"]);

    await repo.write({ "src/a.ts": "export const one = 1;\n" });
    const chunker = countingChunker();
    await indexRepo({ root: repo.root, store, chunkFile: chunker.chunk });
    expect(chunker.calls).toEqual(["src/a.ts"]);
    expect(store.allChunks().map((c) => c.name)).toEqual(["one"]);
  });

  it("drops files that disappeared from the tree", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    await rm(join(repo.root, "src/b.ts"));
    const stats = await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    expect(stats.filesRemoved).toBe(1);
    expect(store.indexedFiles()).not.toContain("src/b.ts");
  });
});

describe("indexRepo — interruptibility", () => {
  it("stops on abort and removes nothing (a partial walk is not evidence of deletion)", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    const controller = new AbortController();
    let seen = 0;
    const stats = await indexRepo({
      root: repo.root,
      store,
      signal: controller.signal,
      chunkFile: realChunkFile,
      onProgress: () => {
        if (++seen === 1) controller.abort();
      },
    });

    expect(stats.aborted).toBe(true);
    expect(stats.filesRemoved).toBe(0);
    expect(store.fileCount).toBe(4);
  });

  it("stops at a wall-clock deadline", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    const stats = await indexRepo({
      root: repo.root,
      store,
      deadline: Date.now() - 1,
      chunkFile: realChunkFile,
    });
    expect(stats.aborted).toBe(true);
    expect(stats.filesScanned).toBe(0);
  });

  it("returns to the event loop mid-pass instead of blocking it", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
    repo = await createTempRepo(many);
    const store = await freshStore(repo.root);

    let immediateRan = false;
    let ranAtFile: number | null = null;
    let count = 0;

    await indexRepo({
      root: repo.root,
      store,
      yieldEvery: 2,
      chunkFile: realChunkFile,
      onProgress: () => {
        count++;
        if (count === 1) {
          setImmediate(() => {
            immediateRan = true;
          });
        }
        if (immediateRan && ranAtFile === null) ranAtFile = count;
      },
    });

    expect(ranAtFile).not.toBeNull();
    expect(ranAtFile ?? Number.POSITIVE_INFINITY).toBeLessThan(60);
  });
});

describe("indexRepo — robustness", () => {
  it("indexes a binary file, a 5 MB minified file, invalid UTF-8 and broken source without throwing", async () => {
    repo = await createTempRepo({
      "src/ok.ts": "export const ok = 1;\n",
      "src/broken.ts": "export class Broken {\n  method( {\n    if (a { \n'unclosed\n",
    });

    await writeFile(join(repo.root, "data.dat"), Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
    await writeFile(join(repo.root, "invalid.txt"), Buffer.from([0x41, 0xc3, 0x28, 0x42, 0x0a]));
    await writeFile(join(repo.root, "bundle.js"), `var a=1;${"x".repeat(5_000_000)}`);

    const store = await freshStore(repo.root);
    const skips = new Map<string, SkipReason>();

    const stats = await indexRepo({
      root: repo.root,
      store,
      chunkFile: realChunkFile,
      onProgress: (file, reason) => {
        if (reason) skips.set(file, reason);
      },
    });

    expect(stats.filesScanned).toBe(5);
    expect(skips.get("data.dat")).toBe("binary");
    expect(skips.get("bundle.js")).toBe("too-large");
    expect(store.indexedFiles().sort()).toEqual(["invalid.txt", "src/broken.ts", "src/ok.ts"]);
    expect(store.allChunks().every((c) => c.endLine >= c.startLine)).toBe(true);
  });

  it("skips a huge single-line bundle as minified when the size cap is raised", async () => {
    repo = await createTempRepo({});
    await writeFile(join(repo.root, "bundle.js"), `var a=1;${"x".repeat(5_000_000)}`);

    const store = await freshStore(repo.root);
    const skips: SkipReason[] = [];
    await indexRepo({
      root: repo.root,
      store,
      maxFileBytes: 10_000_000,
      chunkFile: realChunkFile,
      onProgress: (_file, reason) => {
        if (reason) skips.push(reason);
      },
    });

    expect(skips).toEqual(["minified"]);
    expect(store.chunkCount).toBe(0);
  });

  it("forgets a file that has become unindexable since the last pass", async () => {
    repo = await createTempRepo({ "src/a.ts": "export const a = 1;\n" });
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });
    expect(store.indexedFiles()).toEqual(["src/a.ts"]);

    await writeFile(join(repo.root, "src/a.ts"), Buffer.from([0x00, 0x01, 0x02]));
    const stats = await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });

    expect(stats.filesSkipped).toBe(1);
    expect(store.indexedFiles()).toEqual([]);
  });

  it("survives an unreadable root", async () => {
    const store = await freshStore("/definitely/not/a/real/path");
    await expect(
      indexRepo({ root: "/definitely/not/a/real/path", store, chunkFile: realChunkFile }),
    ).resolves.toMatchObject({ filesScanned: 0 });
  });
});

describe("indexRepo — optional embedding seam", () => {
  /** A deterministic offline embedder: a 4-dim bag of character codes. */
  function fakeEmbedder(): Embedder & { batches: number } {
    const embedder = {
      id: "fake-v1",
      dimensions: 4,
      batches: 0,
      async embed(texts: readonly string[]): Promise<number[][]> {
        embedder.batches++;
        return texts.map((text) => {
          const vector = [0, 0, 0, 0];
          for (let i = 0; i < text.length; i++) {
            const slot = text.charCodeAt(i) % 4;
            vector[slot] = (vector[slot] ?? 0) + 1;
          }
          return vector;
        });
      },
    };
    return embedder;
  }

  it("is not used unless a caller supplies one", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile });
    expect(store.storedEmbedderId).toBeNull();
    expect(store.snapshot().vectors).toBeUndefined();
  });

  it("embeds only chunks that have no vector yet", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    const embedder = fakeEmbedder();

    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile, embedder });
    expect(store.storedEmbedderId).toBe("fake-v1");
    expect(store.snapshot().vectors?.size).toBe(store.chunkCount);

    const batchesAfterFirst = embedder.batches;
    await indexRepo({ root: repo.root, store, chunkFile: realChunkFile, embedder });
    expect(embedder.batches).toBe(batchesAfterFirst);
  });

  it("degrades to lexical-only when the embedder throws", async () => {
    repo = await createTempRepo(TREE);
    const store = await freshStore(repo.root);
    const broken: Embedder = {
      id: "explodes",
      dimensions: 4,
      async embed() {
        throw new Error("no network in tests");
      },
    };
    await expect(
      indexRepo({ root: repo.root, store, chunkFile: realChunkFile, embedder: broken }),
    ).resolves.toMatchObject({ filesIndexed: 4 });
    expect(store.chunkCount).toBeGreaterThan(0);
  });
});

describe("content heuristics", () => {
  it("detects binaries by a NUL byte in the first few KB", () => {
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it("detects minified text but not merely long files", () => {
    expect(looksMinified("short")).toBe(false);
    expect(looksMinified(`${"a".repeat(80)}\n`.repeat(200))).toBe(false);
    expect(looksMinified("x".repeat(6_000))).toBe(true);
  });
});
