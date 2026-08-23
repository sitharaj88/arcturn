/**
 * Incremental indexing.
 *
 * The contract this module exists to keep: **indexing must never make a
 * session wait, and must never be the reason something failed.** In practice
 * that means four things.
 *
 * - *Interruptible.* An `AbortSignal` or a wall-clock deadline stops the pass
 *   between files, and a partial pass is saved and perfectly usable — it just
 *   describes fewer files.
 * - *Non-blocking.* The loop yields to the event loop every few files, so a
 *   large repository cannot starve a concurrent tool call or a UI render.
 * - *Incremental.* A file whose content hash is unchanged is never re-chunked.
 *   Hashing costs a read; chunking costs a scan of every line, and on a big
 *   tree that difference is the whole cost of the pass.
 * - *Total.* Every per-file failure is caught. A file the OS will not let us
 *   read, or one that decodes to garbage, is skipped — never thrown.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { chunkFile as defaultChunkFile } from "./chunker.js";
import { chunkEmbeddingText } from "./document.js";
import { type CodeIndexStore, contentHash } from "./store.js";
import type { CodeChunk, Embedder, IndexStats } from "./types.js";
import { type WalkOptions, walkRepository } from "./walk.js";

/** Files larger than this are skipped: generated, vendored, or data, never read by a human. */
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** Bytes sniffed for a NUL to classify a file as binary. */
const BINARY_SNIFF_BYTES = 8_000;

/** A single line this long means a bundle or a minified asset, not source. */
const MINIFIED_MAX_LINE_CHARS = 2_000;

/** Mean line length this high means the same thing, for files without one huge line. */
const MINIFIED_MEAN_LINE_CHARS = 400;

/** Below this many characters, a long mean line is just a short file, not minification. */
const MINIFIED_MIN_CHARS = 5_000;

/** Files processed between event-loop yields. */
const DEFAULT_YIELD_EVERY = 24;

/** Chunks embedded per {@link Embedder} call. */
const EMBED_BATCH_SIZE = 64;

/** Why a file was skipped. Surfaced in progress callbacks for diagnosability. */
export type SkipReason = "unreadable" | "too-large" | "binary" | "minified";

/** Signature of the chunker, so tests (and instrumentation) can substitute one. */
export type ChunkFileFn = (file: string, text: string) => CodeChunk[];

/** Options for {@link indexRepo}. */
export interface IndexRepoOptions {
  /** Absolute repository root. */
  root: string;
  /** The store to update in place. */
  store: CodeIndexStore;
  /** Cancels the pass between files. */
  signal?: AbortSignal;
  /**
   * Absolute wall-clock timestamp (`Date.now()` scale) after which the pass
   * stops early. This is how a tool call bounds a cold index build without
   * refusing to answer.
   */
  deadline?: number;
  /** Substitute chunker. Defaults to {@link "./chunker.js" | chunkFile}. */
  chunkFile?: ChunkFileFn;
  /** Size cap. Defaults to {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number;
  /** Files between event-loop yields. Defaults to 24. */
  yieldEvery?: number;
  /** Extra walk configuration (gitignore handling, extra ignores, file cap). */
  walk?: Omit<WalkOptions, "root" | "signal">;
  /**
   * Optional semantic index. **Off by default** — see
   * {@link "./types.js" | Embedder}. When supplied, chunks without a vector
   * are embedded after the lexical pass, so an interrupted run still leaves a
   * fully working lexical index.
   */
  embedder?: Embedder;
  /** Called after each file. `skipped` names why a file contributed nothing. */
  onProgress?: (file: string, skipped?: SkipReason) => void;
}

/** NUL byte in the first few KB — the same heuristic `grep` uses. */
export function looksBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Minified or bundled text: one enormous line, or a high mean line length over
 * a file big enough for that to be meaningful.
 *
 * Worth its own check even with `*.min.js` in the default ignores, because
 * bundlers emit plenty of long-lined files that are not named `.min.`.
 */
export function looksMinified(text: string): boolean {
  if (text.length < MINIFIED_MIN_CHARS) return false;
  let longest = 0;
  let lines = 0;
  let current = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      if (current > longest) longest = current;
      current = 0;
      lines++;
    } else {
      current++;
    }
  }
  if (current > longest) longest = current;
  if (lines === 0) lines = 1;
  if (longest > MINIFIED_MAX_LINE_CHARS) return true;
  return text.length / lines > MINIFIED_MEAN_LINE_CHARS;
}

/** Embed the chunks that have no vector yet, in batches, honoring cancellation. */
async function embedMissing(
  store: CodeIndexStore,
  embedder: Embedder,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): Promise<void> {
  if (store.storedEmbedderId !== null && store.storedEmbedderId !== embedder.id) {
    // A different model: existing vectors are meaningless, so start over.
    store.setVectors(embedder.id, new Map());
  }
  const pending = store.chunksMissingVectors();
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) return;
    if (deadline !== undefined && Date.now() > deadline) return;
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    let vectors: readonly (readonly number[])[];
    try {
      vectors = await embedder.embed(batch.map(chunkEmbeddingText), signal);
    } catch {
      // A failing embedder degrades to lexical-only retrieval, never an error.
      return;
    }
    const assigned = new Map<string, readonly number[]>();
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vector = vectors[j];
      if (chunk && vector && vector.length === embedder.dimensions) assigned.set(chunk.id, vector);
    }
    if (assigned.size > 0) store.setVectors(embedder.id, assigned);
  }
}

/**
 * Bring `store` up to date with the files under `root`.
 *
 * @returns Statistics for this pass. `aborted` is true when the walk stopped
 *   early, in which case **no files are removed from the index** — a partial
 *   walk is not evidence that the files it never reached are gone.
 */
export async function indexRepo(options: IndexRepoOptions): Promise<IndexStats> {
  const started = Date.now();
  const {
    root,
    store,
    signal,
    deadline,
    onProgress,
    embedder,
    chunkFile = defaultChunkFile,
  } = options;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;

  const stats: IndexStats = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    chunksIndexed: 0,
    totalChunks: 0,
    durationMs: 0,
    aborted: false,
  };

  const seen = new Set<string>();
  let sinceYield = 0;

  const skip = (file: string, reason: SkipReason): void => {
    stats.filesSkipped++;
    if (store.removeFile(file)) stats.filesRemoved++;
    onProgress?.(file, reason);
  };

  for await (const file of walkRepository({ ...options.walk, root, signal })) {
    if (signal?.aborted || (deadline !== undefined && Date.now() > deadline)) {
      stats.aborted = true;
      break;
    }

    stats.filesScanned++;
    seen.add(file);
    const absolute = join(root, file);

    try {
      const info = await stat(absolute);
      if (info.size > maxFileBytes) {
        skip(file, "too-large");
        continue;
      }

      const buffer = await readFile(absolute);
      if (looksBinary(buffer)) {
        skip(file, "binary");
        continue;
      }

      const hash = contentHash(buffer);
      if (store.hashOf(file) === hash) {
        onProgress?.(file);
        continue;
      }

      // Decoding replaces invalid UTF-8 with U+FFFD rather than throwing, so a
      // file with a broken encoding still indexes as text.
      const text = buffer.toString("utf8");
      if (looksMinified(text)) {
        skip(file, "minified");
        continue;
      }

      const chunks = chunkFile(file, text);
      store.setFile(file, hash, buffer.byteLength, chunks);
      stats.filesIndexed++;
      stats.chunksIndexed += chunks.length;
      onProgress?.(file);
    } catch {
      skip(file, "unreadable");
    }

    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }

  // The walk generator also stops itself on abort, in which case the loop above
  // ends without our `break` ever running. Re-check so removal is suppressed
  // either way: a walk that stopped early never proves a file is gone.
  if (signal?.aborted) stats.aborted = true;

  if (!stats.aborted) {
    for (const indexed of store.indexedFiles()) {
      if (seen.has(indexed)) continue;
      if (store.removeFile(indexed)) stats.filesRemoved++;
    }
  }

  if (embedder) await embedMissing(store, embedder, signal, deadline);

  stats.totalChunks = store.chunkCount;
  await store.save();
  stats.durationMs = Date.now() - started;
  return stats;
}
