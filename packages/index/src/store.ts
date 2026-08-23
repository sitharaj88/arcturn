/**
 * Persistence: JSONL chunks plus a compact inverted index, both plain files,
 * no native dependencies.
 *
 * Three decisions are load-bearing here:
 *
 * 1. **Files are keyed by content hash, never mtime.** A `git checkout`,
 *    `git stash pop`, or a fresh clone rewrites every mtime in the tree while
 *    changing almost no content. An mtime-keyed index reindexes the world on
 *    every branch switch; a hash-keyed one reindexes what actually changed.
 * 2. **The on-disk format is version-stamped, and any problem rebuilds
 *    silently.** A truncated JSONL line, a half-written postings file, an
 *    index written by an older Arcturn — none of these may ever surface to the
 *    user as an error. They mean "reindex", which costs seconds.
 * 3. **Writes are atomic** (write to a temp file, then rename), so a process
 *    killed mid-save leaves the previous good index in place rather than a
 *    corrupt one.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkDocumentTokens } from "./document.js";
import type { CodeChunk } from "./types.js";

/**
 * Bump when the chunk shape, the document construction, or the postings format
 * changes in a way that makes an existing index wrong rather than merely stale.
 */
export const INDEX_FORMAT_VERSION = 1;

const META_FILE = "meta.json";
const CHUNKS_FILE = "chunks.jsonl";
const POSTINGS_FILE = "postings.json";
const VECTORS_FILE = "vectors.json";

/** What the index remembers about one source file. */
export interface FileRecord {
  /** SHA-1 of the file's raw bytes. The incremental-indexing key. */
  hash: string;
  /** Byte length, kept for reporting and for cheap sanity checks. */
  size: number;
  /** Chunks extracted from this file, in source order. */
  chunks: CodeChunk[];
}

/**
 * An immutable view of the index prepared for retrieval.
 *
 * `postings` maps a term to a flat `[ordinal, tf, ordinal, tf, …]` array — a
 * flat number array is both the most compact JSON encoding and the fastest to
 * parse, which matters because loading the postings is the one unavoidable
 * cost of every search.
 */
export interface IndexSnapshot {
  /** Every chunk, indexed by ordinal. */
  readonly chunks: readonly CodeChunk[];
  /** term → flat `[ordinal, termFrequency, …]`. */
  readonly postings: ReadonlyMap<string, readonly number[]>;
  /** Token count per document, by ordinal. */
  readonly docLengths: readonly number[];
  /** Mean document length, the BM25 normalizer. */
  readonly avgDocLength: number;
  /** Optional embedding vectors by ordinal; present only when an Embedder ran. */
  readonly vectors?: ReadonlyMap<number, readonly number[]>;
}

/** SHA-1 hex digest of a buffer or string. Content-addressing, not security. */
export function contentHash(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

interface PersistedMeta {
  formatVersion: number;
  root: string;
  updatedAt: number;
  fileCount: number;
  chunkCount: number;
}

interface PersistedPostings {
  formatVersion: number;
  documentCount: number;
  avgDocLength: number;
  docLengths: number[];
  terms: Record<string, number[]>;
}

interface PersistedVectors {
  formatVersion: number;
  embedderId: string;
  dimensions: number;
  vectors: Record<string, number[]>;
}

/** Best-effort JSON read; any failure at all means "no data", never an error. */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Write via a temp file and rename, so a crash cannot leave a torn file behind.
 *
 * The temp name carries the pid and random bytes because two Arcturn sessions can
 * legitimately index the same repository at once: with a shared temp name they
 * would rename each other's half-written files out from under themselves.
 * Distinct temp names make the last `rename` win cleanly, which for an index
 * that either side can rebuild is exactly the right outcome.
 */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The persistent code index for one repository root.
 *
 * Mutations are in-memory and cheap; {@link CodeIndexStore.save} is the only
 * thing that touches disk. Callers batch a whole indexing pass and save once.
 */
export class CodeIndexStore {
  readonly dir: string;
  readonly root: string;

  private readonly records = new Map<string, FileRecord>();
  private readonly vectorsByChunkId = new Map<string, readonly number[]>();
  private embedderId: string | null = null;
  private snapshotCache: IndexSnapshot | null = null;
  /** Postings loaded from disk, reusable until the first mutation. */
  private loadedPostings: PersistedPostings | null = null;

  private constructor(dir: string, root: string) {
    this.dir = dir;
    this.root = root;
  }

  /**
   * Load the index at `dir`, or start an empty one.
   *
   * A missing, corrupt, or version-mismatched index is not an error: it is an
   * empty store that the next indexing pass will fill in.
   */
  static async open(dir: string, root: string): Promise<CodeIndexStore> {
    const store = new CodeIndexStore(dir, root);
    const meta = await readJson<PersistedMeta>(join(dir, META_FILE));
    if (!meta || meta.formatVersion !== INDEX_FORMAT_VERSION || meta.root !== root) {
      return store;
    }

    let raw: string;
    try {
      raw = await readFile(join(dir, CHUNKS_FILE), "utf8");
    } catch {
      return store;
    }

    try {
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        const entry = JSON.parse(line) as { f?: string; h?: string; s?: number; c?: CodeChunk };
        if (entry.f && entry.h !== undefined && entry.s !== undefined) {
          store.records.set(entry.f, { hash: entry.h, size: entry.s, chunks: [] });
          continue;
        }
        if (entry.c) {
          const record = store.records.get(entry.c.file);
          if (record) record.chunks.push(entry.c);
        }
      }
    } catch {
      // A truncated or garbled JSONL means "reindex", never "crash".
      store.records.clear();
      return store;
    }

    const postings = await readJson<PersistedPostings>(join(dir, POSTINGS_FILE));
    if (postings && postings.formatVersion === INDEX_FORMAT_VERSION) {
      store.loadedPostings = postings;
    }

    const vectors = await readJson<PersistedVectors>(join(dir, VECTORS_FILE));
    if (vectors && vectors.formatVersion === INDEX_FORMAT_VERSION) {
      store.embedderId = vectors.embedderId;
      for (const [id, vector] of Object.entries(vectors.vectors)) {
        if (vector.length === vectors.dimensions) store.vectorsByChunkId.set(id, vector);
      }
    }

    return store;
  }

  /** Number of files currently indexed. */
  get fileCount(): number {
    return this.records.size;
  }

  /** Number of chunks currently indexed. */
  get chunkCount(): number {
    let total = 0;
    for (const record of this.records.values()) total += record.chunks.length;
    return total;
  }

  /** Every indexed file's repo-relative path. */
  indexedFiles(): string[] {
    return [...this.records.keys()];
  }

  /** The recorded content hash for `file`, or undefined if it is not indexed. */
  hashOf(file: string): string | undefined {
    return this.records.get(file)?.hash;
  }

  /** Replace (or add) a file's chunks. Invalidates the retrieval snapshot. */
  setFile(file: string, hash: string, size: number, chunks: CodeChunk[]): void {
    this.records.set(file, { hash, size, chunks });
    this.invalidate();
  }

  /** Drop a file and its chunks. Returns whether anything was removed. */
  removeFile(file: string): boolean {
    const existed = this.records.delete(file);
    if (existed) this.invalidate();
    return existed;
  }

  /** Attach embedding vectors, keyed by chunk id so reindexing one file keeps the rest. */
  setVectors(embedderId: string, vectors: ReadonlyMap<string, readonly number[]>): void {
    if (this.embedderId !== null && this.embedderId !== embedderId) this.vectorsByChunkId.clear();
    this.embedderId = embedderId;
    for (const [id, vector] of vectors) this.vectorsByChunkId.set(id, vector);
    this.invalidate();
  }

  /** Which embedder produced the stored vectors, if any. */
  get storedEmbedderId(): string | null {
    return this.embedderId;
  }

  /** Chunk ids that have no vector yet — the work list for an incremental embedding pass. */
  chunksMissingVectors(): CodeChunk[] {
    const out: CodeChunk[] = [];
    for (const chunk of this.allChunks()) {
      if (!this.vectorsByChunkId.has(chunk.id)) out.push(chunk);
    }
    return out;
  }

  /** Every chunk, in stable order (files sorted by path, chunks in source order). */
  allChunks(): CodeChunk[] {
    const files = [...this.records.keys()].sort();
    const out: CodeChunk[] = [];
    for (const file of files) {
      const record = this.records.get(file);
      if (record) out.push(...record.chunks);
    }
    return out;
  }

  private invalidate(): void {
    this.snapshotCache = null;
    this.loadedPostings = null;
  }

  /**
   * Prepare the index for retrieval, building the inverted index if it is not
   * already available from disk or from a previous call.
   */
  snapshot(): IndexSnapshot {
    if (this.snapshotCache) return this.snapshotCache;

    const chunks = this.allChunks();
    const ordinalById = new Map<string, number>();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk) ordinalById.set(chunk.id, i);
    }

    let postings: Map<string, number[]>;
    let docLengths: number[];
    let avgDocLength: number;

    const reusable =
      this.loadedPostings !== null && this.loadedPostings.documentCount === chunks.length;
    if (reusable && this.loadedPostings) {
      postings = new Map(Object.entries(this.loadedPostings.terms));
      docLengths = this.loadedPostings.docLengths;
      avgDocLength = this.loadedPostings.avgDocLength;
    } else {
      const built = buildPostings(chunks);
      postings = built.postings;
      docLengths = built.docLengths;
      avgDocLength = built.avgDocLength;
    }

    let vectors: Map<number, readonly number[]> | undefined;
    if (this.vectorsByChunkId.size > 0) {
      vectors = new Map();
      for (const [id, vector] of this.vectorsByChunkId) {
        const ordinal = ordinalById.get(id);
        if (ordinal !== undefined) vectors.set(ordinal, vector);
      }
    }

    this.snapshotCache = { chunks, postings, docLengths, avgDocLength, vectors };
    return this.snapshotCache;
  }

  /**
   * Persist the whole index.
   *
   * Rewrites both files wholesale rather than appending. The expensive half of
   * indexing is reading and parsing source files, which incremental indexing
   * already avoids; serializing a few thousand JSON lines afterwards costs
   * milliseconds and buys a format with no compaction story to get wrong.
   */
  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const files = [...this.records.keys()].sort();
    const lines: string[] = [];
    for (const file of files) {
      const record = this.records.get(file);
      if (!record) continue;
      lines.push(JSON.stringify({ f: file, h: record.hash, s: record.size }));
      for (const chunk of record.chunks) lines.push(JSON.stringify({ c: chunk }));
    }
    await writeAtomic(join(this.dir, CHUNKS_FILE), `${lines.join("\n")}\n`);

    const snapshot = this.snapshot();
    const terms: Record<string, number[]> = {};
    for (const [term, entries] of snapshot.postings) terms[term] = entries as number[];
    const persistedPostings: PersistedPostings = {
      formatVersion: INDEX_FORMAT_VERSION,
      documentCount: snapshot.chunks.length,
      avgDocLength: snapshot.avgDocLength,
      docLengths: snapshot.docLengths as number[],
      terms,
    };
    await writeAtomic(join(this.dir, POSTINGS_FILE), JSON.stringify(persistedPostings));

    if (this.embedderId && this.vectorsByChunkId.size > 0) {
      const first = this.vectorsByChunkId.values().next().value;
      const vectors: Record<string, number[]> = {};
      for (const [id, vector] of this.vectorsByChunkId) vectors[id] = vector as number[];
      const persistedVectors: PersistedVectors = {
        formatVersion: INDEX_FORMAT_VERSION,
        embedderId: this.embedderId,
        dimensions: first ? first.length : 0,
        vectors,
      };
      await writeAtomic(join(this.dir, VECTORS_FILE), JSON.stringify(persistedVectors));
    }

    const meta: PersistedMeta = {
      formatVersion: INDEX_FORMAT_VERSION,
      root: this.root,
      updatedAt: Date.now(),
      fileCount: this.records.size,
      chunkCount: snapshot.chunks.length,
    };
    await writeAtomic(join(this.dir, META_FILE), JSON.stringify(meta));
  }

  /** Delete the persisted index. Used when a caller wants a guaranteed cold rebuild. */
  async destroy(): Promise<void> {
    this.records.clear();
    this.vectorsByChunkId.clear();
    this.embedderId = null;
    this.invalidate();
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Build the inverted index and document-length table from a chunk list. */
export function buildPostings(chunks: readonly CodeChunk[]): {
  postings: Map<string, number[]>;
  docLengths: number[];
  avgDocLength: number;
} {
  const postings = new Map<string, number[]>();
  const docLengths: number[] = new Array(chunks.length).fill(0);
  let totalLength = 0;

  for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
    const chunk = chunks[ordinal];
    if (!chunk) continue;
    const tokens = chunkDocumentTokens(chunk);
    docLengths[ordinal] = tokens.length;
    totalLength += tokens.length;

    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, frequency] of frequencies) {
      const entries = postings.get(term);
      if (entries) entries.push(ordinal, frequency);
      else postings.set(term, [ordinal, frequency]);
    }
  }

  return {
    postings,
    docLengths,
    avgDocLength: chunks.length > 0 ? totalLength / chunks.length : 0,
  };
}
