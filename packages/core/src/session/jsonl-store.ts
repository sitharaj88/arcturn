/**
 * JSONL-backed session store: one directory per store, one `.jsonl` file per
 * session. The first line is the {@link SessionHeader}; every later line is a
 * {@link SessionEntry}. Entries form a tree through their `parentId` links, so
 * branching is just appending a child to an older node.
 */

import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionEntry, SessionHeader, SessionStore } from "@arcturn/types";
import { pathToLeaf } from "./tree.js";

/** Error thrown for missing, malformed or conflicting session files. */
export class SessionStoreError extends Error {
  constructor(
    message: string,
    /** Machine-readable failure kind. */
    readonly code: "notFound" | "exists" | "corrupt" | "invalidId",
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

/**
 * Non-fatal damage a store found while reading or repairing a session.
 *
 * Both kinds mean the same underlying thing — a write that never finished
 * left the file ending mid-line — and neither is fatal: the session stays
 * readable and writable. They are reported rather than thrown because the
 * alternative the store shipped with was to fix them up in silence, which
 * made a lost entry indistinguishable from an entry that was never written.
 */
export interface SessionStoreWarning {
  /** Session the damage was found in. */
  sessionId: string;
  /**
   * - `tornTail` — a read dropped an unreadable final line.
   * - `tornTailRepaired` — a write removed one before appending.
   */
  kind: "tornTail" | "tornTailRepaired";
  /** Human-readable description, safe to show a user verbatim. */
  message: string;
  /** How many bytes the partial line occupied. */
  bytes: number;
}

/** Construction options for {@link JsonlSessionStore}. */
export interface JsonlSessionStoreOptions {
  /** Directory that holds the `.jsonl` session files. Created on demand. */
  dir: string;
  /**
   * Called when a session turns out to be damaged in a way the store can
   * recover from on its own. Optional, and deliberately not an error channel:
   * every method still resolves normally. Reported at most once per session
   * and kind per store instance, so a UI that re-reads a session on every
   * render does not repeat itself.
   *
   * @param warning - What was found; see {@link SessionStoreWarning}.
   */
  onWarning?(warning: SessionStoreWarning): void;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const FILE_SUFFIX = ".jsonl";
const NEWLINE = 0x0a;
/** Window size for the backwards scan that finds a torn line's start. */
const TAIL_SCAN_CHUNK = 64 * 1024;
/**
 * How many times {@link JsonlSessionStore} re-looks at a torn tail before it
 * gives up on repairing it. See `#prepareAppend`.
 */
const TAIL_REPAIR_ATTEMPTS = 5;
/** Pause between the two looks that have to agree before bytes are destroyed. */
const TAIL_SETTLE_MS = 5;
/**
 * Errors a Windows `rename` raises when something else holds the destination
 * open — an antivirus scanner, the search indexer, a backup agent. libuv maps
 * `ERROR_ACCESS_DENIED` / `ERROR_SHARING_VIOLATION` onto these; they are
 * transient, and Node's own `rm` implementation retries the same set for the
 * same reason.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Backoff for {@link renameReplacing}; ~310ms of total patience. */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

/**
 * Write queues keyed by session FILE, shared by every store instance in this
 * process.
 *
 * Deliberately module-level rather than per-instance. Two `JsonlSessionStore`
 * objects over one directory are not two processes — they are two references
 * to the same bytes, and a per-instance queue let their appends run at the
 * same time. That is how a served session beside a terminal one, a background
 * agent beside its parent, and `round-trip.test.ts`'s "two writers on one
 * session file" all ended up interleaving: not through any exotic race, just
 * through two queues that had never heard of each other.
 */
const writeQueues = new Map<string, Promise<void>>();

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new SessionStoreError(
      `Invalid session id ${JSON.stringify(sessionId)}: expected [A-Za-z0-9._-]+`,
      "invalidId",
    );
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** File-backed {@link SessionStore} using newline-delimited JSON. */
export class JsonlSessionStore implements SessionStore {
  readonly #dir: string;
  readonly #onWarning: ((warning: SessionStoreWarning) => void) | undefined;
  /** Warnings already reported, so a re-read does not repeat one. */
  readonly #reported = new Set<string>();
  #dirReady: Promise<void> | undefined;

  constructor(options: JsonlSessionStoreOptions) {
    this.#dir = options.dir;
    this.#onWarning = options.onWarning;
  }

  /** Directory backing this store. */
  get dir(): string {
    return this.#dir;
  }

  /**
   * Create a new session file with its header line.
   *
   * @param header - Session id, cwd and optional title.
   * @throws SessionStoreError when a session with that id already exists.
   */
  async create(header: Omit<SessionHeader, "version" | "createdAt">): Promise<SessionHeader> {
    assertSessionId(header.sessionId);
    await this.#ensureDir();
    const full: SessionHeader = {
      version: 1,
      sessionId: header.sessionId,
      cwd: header.cwd,
      createdAt: Date.now(),
      ...(header.title === undefined ? {} : { title: header.title }),
    };
    try {
      await writeFile(this.#path(header.sessionId), `${JSON.stringify(full)}\n`, { flag: "wx" });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw new SessionStoreError(`Session ${header.sessionId} already exists`, "exists");
      }
      throw error;
    }
    return full;
  }

  /**
   * Read a session's header.
   *
   * @param sessionId - Session to open.
   */
  async open(sessionId: string): Promise<SessionHeader> {
    const [headerLine] = await this.#lines(sessionId);
    if (headerLine === undefined) {
      throw new SessionStoreError(`Session ${sessionId} has no header line`, "corrupt");
    }
    const header = parseJson<SessionHeader>(headerLine, sessionId);
    if (header.version !== 1 || typeof header.sessionId !== "string") {
      throw new SessionStoreError(`Session ${sessionId} has an unsupported header`, "corrupt");
    }
    return header;
  }

  /**
   * Append one entry to a session, creating nothing implicitly.
   *
   * Durable against other writers on three levels, because it took all three
   * to stop losing entries: the process-wide queue (see {@link writeQueues})
   * keeps two store instances off the file at once, {@link appendLine} makes
   * one entry one `write` so a second *process* interleaves whole lines
   * rather than halves, and `#prepareAppend` refuses to destroy a tail it
   * cannot prove is dead.
   *
   * @param sessionId - Target session.
   * @param entry - Entry to append.
   */
  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    assertSessionId(sessionId);
    await this.#serialize(sessionId, async () => {
      try {
        // Opening with "a" would happily create a brand-new file; a session
        // must never exist without its header line.
        await access(this.#path(sessionId));
        // A crash mid-append leaves a file that does not end in a newline.
        // Appending straight onto that glues this entry to the torn one, so
        // BOTH become one unparsable line — and once a later append puts a
        // complete line after it, that garbage is no longer the last line,
        // which `entries` reports as corruption for the WHOLE session. One
        // interrupted write would otherwise cost every message ever stored
        // in the session, not just the interrupted one.
        const prefix = await this.#prepareAppend(sessionId);
        await appendLine(this.#path(sessionId), `${prefix}${JSON.stringify(entry)}\n`);
      } catch (error) {
        if (isMissing(error)) {
          throw new SessionStoreError(`Session ${sessionId} does not exist`, "notFound");
        }
        throw error;
      }
    });
  }

  /**
   * Run `body` after every write already queued for this session, and before
   * every one queued after it.
   *
   * Shared by `append` and `setTitle` because they are not independent: a
   * retitle is a read-modify-write of the WHOLE file, so an append that lands
   * between its read and its rename is erased by the rename — silently, with
   * the append's own promise already resolved.
   *
   * Keyed by the session FILE and held in a process-wide map, so two store
   * instances over one directory queue behind each other instead of racing.
   * See {@link writeQueues}.
   */
  async #serialize(sessionId: string, body: () => Promise<void>): Promise<void> {
    const key = this.#queueKey(sessionId);
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(body);
    writeQueues.set(key, next);
    try {
      await next;
    } finally {
      if (writeQueues.get(key) === next) writeQueues.delete(key);
    }
  }

  #queueKey(sessionId: string): string {
    return resolve(this.#path(sessionId));
  }

  /** Report recoverable damage once per session and kind. */
  #warn(
    sessionId: string,
    kind: SessionStoreWarning["kind"],
    bytes: number,
    message: string,
  ): void {
    const report = this.#onWarning;
    if (report === undefined) return;
    const key = `${sessionId} ${kind}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    try {
      report({ sessionId, kind, message, bytes });
    } catch {
      // A listener must never be able to break a read or a write.
    }
  }

  /**
   * Every entry of a session, in append order.
   *
   * A partial final line is dropped rather than thrown on — see the loop —
   * but the drop is REPORTED through `onWarning`. Silently returning a short
   * list is what made this class's worst failure mode invisible: an entry
   * that was lost and an entry that was never written looked identical to
   * every caller, which is why a multi-writer bug survived several releases
   * as "a flaky test".
   *
   * @param sessionId - Session to read.
   */
  async entries(sessionId: string): Promise<SessionEntry[]> {
    const lines = await this.#lines(sessionId);
    const body = lines.slice(1);
    const entries: SessionEntry[] = [];
    for (const [index, line] of body.entries()) {
      // A crash mid-append leaves a partial final line. Dropping it recovers
      // the whole session; corruption anywhere earlier is still an error,
      // because it means something other than a torn write went wrong.
      if (index === body.length - 1) {
        const parsed = tryParseJson<SessionEntry>(line);
        if (parsed !== undefined) {
          entries.push(parsed);
          continue;
        }
        this.#warn(
          sessionId,
          "tornTail",
          Buffer.byteLength(line, "utf8"),
          `Session ${sessionId} ends in a partial line from a write that never ` +
            "finished; that one entry could not be read. Everything before it is intact.",
        );
        continue;
      }
      entries.push(parseJson<SessionEntry>(line, sessionId));
    }
    return entries;
  }

  /**
   * The entries on the path from the root to `leafId`.
   *
   * @param sessionId - Session to read.
   * @param leafId - Branch tip.
   * @returns Root-first entries; empty when `leafId` is unknown.
   */
  async branch(sessionId: string, leafId: string): Promise<SessionEntry[]> {
    return pathToLeaf(await this.entries(sessionId), leafId);
  }

  /** Every session header in the store, newest first. */
  async list(): Promise<SessionHeader[]> {
    await this.#ensureDir();
    const files = await readdir(this.#dir);
    const headers: SessionHeader[] = [];
    for (const file of files) {
      if (!file.endsWith(FILE_SUFFIX)) continue;
      try {
        headers.push(await this.open(file.slice(0, -FILE_SUFFIX.length)));
      } catch {
        // Skip unreadable or partially written session files.
      }
    }
    return headers.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Rewrite a session's header with a new title.
   *
   * The rewrite goes through a temporary file and a rename, so a crash cannot
   * leave a session without its header, and it runs on the same per-file
   * write queue as `append`, so an entry written by anything in this process
   * while it is in flight is not erased by the rename.
   *
   * Only the header line is rebuilt; everything after the first newline is
   * carried across byte for byte. Re-serializing the body would put a
   * terminating newline after a line a crash had torn, which is what turns a
   * recoverable torn tail into permanent mid-file corruption.
   *
   * STILL not safe against a second *process* retitling or appending
   * concurrently, and unlike `append` it cannot be made so by writing more
   * carefully: this is a read-modify-write of the whole file, so an append
   * that lands between the read and the rename is erased by the rename no
   * matter how atomic either half is. Fixing that needs a lock, which the
   * store does not have. Titles are written once, early, by one interactive
   * process, so the exposure is small — but it is real.
   *
   * The rename goes through {@link renameReplacing} rather than `rename`: on
   * Windows a rename ONTO an existing file fails while anything else holds
   * that file open, and "anything else" routinely means Defender or the
   * search indexer on a CI runner. Nothing in this method holds a handle on
   * the destination when the rename runs — `open` and `readFile` have both
   * closed by then, and the write goes to the temp file — so a failure here
   * comes from outside this process and is worth waiting out.
   *
   * @param sessionId - Session to retitle.
   * @param title - New title.
   * @throws The underlying filesystem error when the rewrite cannot be
   *   completed. Callers that treat titles as best-effort must catch it —
   *   and should say so out loud rather than discarding it.
   */
  async setTitle(sessionId: string, title: string): Promise<void> {
    assertSessionId(sessionId);
    await this.#serialize(sessionId, async () => {
      const header = await this.open(sessionId);
      const updated: SessionHeader = { ...header, title };
      const raw = await readFile(this.#path(sessionId), "utf8");
      const firstBreak = raw.indexOf("\n");
      const body = firstBreak === -1 ? "" : raw.slice(firstBreak + 1);
      const tmp = `${this.#path(sessionId)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(updated)}\n${body}`);
      await renameReplacing(tmp, this.#path(sessionId));
    });
  }

  /**
   * Delete a session's file.
   *
   * The queued write for this session (if any) is drained first, so a delete
   * issued while an append is in flight lands after it rather than racing it.
   * That is ordering hygiene, not the safety net: the net is `append`'s own
   * `access` guard, which refuses to write to a session whose file is gone —
   * so a later append can never resurrect a deleted session as an orphan
   * carrying entries with no header line.
   *
   * `force` is deliberately **not** used: a delete that silently succeeds for
   * an id that never existed cannot tell a caller its session is already gone
   * from a caller's typo, and every other method here reports `notFound`.
   *
   * @param sessionId - Session to remove.
   * @throws SessionStoreError `notFound` when no such session file exists,
   *   `invalidId` when the id is not a legal one.
   */
  async delete(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    await writeQueues.get(this.#queueKey(sessionId))?.catch(() => undefined);
    try {
      await rm(this.#path(sessionId));
    } catch (error) {
      if (isMissing(error)) {
        throw new SessionStoreError(`Session ${sessionId} does not exist`, "notFound");
      }
      throw error;
    }
    writeQueues.delete(this.#queueKey(sessionId));
  }

  #path(sessionId: string): string {
    return join(this.#dir, `${sessionId}${FILE_SUFFIX}`);
  }

  /**
   * Leave the session file in a state that can be appended to, and return the
   * prefix this append needs.
   *
   * Normally a no-op returning `""`: the file ends in a newline, so the next
   * line starts cleanly. The interesting case is a file that does NOT — a
   * write torn by a crash, or by a second process on the same session dying
   * mid-append.
   *
   * A torn tail is dropped here rather than carried. `entries` already
   * discards an unparsable final line, so the bytes hold nothing a reader
   * would ever have surfaced; leaving them in place is what turns one
   * interrupted write into a session that is unreadable forever, because the
   * next complete line demotes the garbage to mid-file corruption. Dropping
   * it restores the invariant every other method depends on — every line in
   * the file is a whole line — which is what lets `entries` keep treating
   * mid-file garbage as the real corruption it is.
   *
   * A trailing line that DOES parse is kept: that is a complete entry that
   * merely never got its terminator, and it is not this method's to throw
   * away.
   *
   * Re-checked on every append rather than cached: a second writer on the
   * same file is reachable today (`arcturn serve` alongside a terminal), and
   * a cached "we left it clean" flag would be exactly wrong in the case that
   * matters — the other writer being the one that died.
   *
   * ## Why the repair has to prove the bytes are dead first
   *
   * "The file does not end in a newline" does NOT mean "a writer died". It
   * means "no writer has finished". A writer that is still going looks
   * exactly the same from here, because a session line is written with one
   * `write` but a reader is under no lock: it can see the file's size while
   * that write is only part-way into the page cache, and `fs.appendFile`
   * splits anything over 512 KiB into several writes outright, so a big entry
   * is visibly half-there on every platform.
   *
   * Truncating on that evidence deletes a live writer's entry — a complete,
   * already-acknowledged message, gone, with no error anywhere and nothing in
   * the file to say it was ever there. That is strictly worse than the
   * problem being solved, so a repair now needs the tail to hold STILL: two
   * looks a beat apart that agree on the size and on where the partial line
   * starts, and a third check through the write handle itself. Any
   * disagreement means someone is writing, so we go round again — and if the
   * file never settles, the honest conclusion is that the tail belongs to a
   * live writer, not to a corpse. We then leave it alone and start our own
   * line with a newline: our append cannot land inside their write, so the
   * separator falls after their finished line and reads back as a blank line,
   * which `#lines` drops.
   */
  async #prepareAppend(sessionId: string): Promise<string> {
    const path = this.#path(sessionId);
    for (let attempt = 0; attempt < TAIL_REPAIR_ATTEMPTS; attempt++) {
      const tail = await this.#inspectTail(path);
      if (tail.kind === "clean") return "";
      if (tail.kind === "keep") return "\n";

      await delay(TAIL_SETTLE_MS);
      const settled = await this.#inspectTail(path);
      if (
        settled.kind !== "torn" ||
        settled.size !== tail.size ||
        settled.truncateTo !== tail.truncateTo
      ) {
        // It moved: a writer, not a corpse. Look again from the top — by now
        // the tail is usually a finished line and this returns `""`.
        continue;
      }

      // Only here — the rare repair — is a write handle opened at all.
      const writer = await open(path, "r+");
      try {
        // Last look, through the handle about to do the damage: `truncate`
        // waits on the same lock a write holds, so a size that changed
        // between opening and here is a write that landed in the meantime.
        const { size } = await writer.stat();
        if (size !== tail.size) continue;
        await writer.truncate(tail.truncateTo);
      } finally {
        await writer.close();
      }
      this.#warn(
        sessionId,
        "tornTailRepaired",
        tail.size - tail.truncateTo,
        `Session ${sessionId} ended in a partial line from a write that never finished; ` +
          `${tail.size - tail.truncateTo} byte(s) were dropped so the session stays readable.`,
      );
      return "";
    }
    return "\n";
  }

  /**
   * Read-only look at how the session file ends.
   *
   * - `clean` — it ends in a newline (or is empty); append straight on.
   * - `keep` — the trailing line is a whole entry that never got its
   *   terminator, or the file has no newline at all (a torn header, which
   *   truncating would erase). Separate it with a newline and leave it.
   * - `torn` — the trailing line is an incomplete write; drop it from
   *   `truncateTo`. `size` is what the file measured at the time, so a caller
   *   can tell a tail that is holding still from one that is being written.
   */
  async #inspectTail(
    path: string,
  ): Promise<
    { kind: "clean" } | { kind: "keep" } | { kind: "torn"; truncateTo: number; size: number }
  > {
    const reader = await open(path, "r");
    try {
      const { size } = await reader.stat();
      if (size === 0) return { kind: "clean" };
      const last = Buffer.alloc(1);
      await reader.read(last, 0, 1, size - 1);
      if (last[0] === NEWLINE) return { kind: "clean" };

      const start = await findLastLineStart(reader, size);
      if (start === undefined) return { kind: "keep" };

      const partial = Buffer.alloc(size - start);
      await reader.read(partial, 0, partial.length, start);
      if (tryParseJson(partial.toString("utf8")) !== undefined) return { kind: "keep" };
      return { kind: "torn", truncateTo: start, size };
    } finally {
      await reader.close();
    }
  }

  async #ensureDir(): Promise<void> {
    this.#dirReady ??= mkdir(this.#dir, { recursive: true }).then(() => undefined);
    await this.#dirReady;
  }

  async #lines(sessionId: string): Promise<string[]> {
    assertSessionId(sessionId);
    let raw: string;
    try {
      raw = await readFile(this.#path(sessionId), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw new SessionStoreError(`Session ${sessionId} does not exist`, "notFound");
      }
      throw error;
    }
    return raw.split("\n").filter((line) => line.trim().length > 0);
  }
}

/**
 * Append one already-terminated line, in as few writes as the kernel allows.
 *
 * Not `fs.appendFile`, which chops anything past 512 KiB
 * (`kWriteFileMaxChunkSize`) into separate `write` calls — and a second
 * writer's `O_APPEND` write is free to land in the gap between two of them,
 * splicing its line into the middle of this one. A session entry over half a
 * megabyte is ordinary (a large tool result, a pasted file), so that is not a
 * theoretical size. One `write` per line instead: `O_APPEND` makes the
 * kernel place it at the end under its own lock, so two writers interleave
 * whole lines rather than halves of them. The loop is for the short write a
 * signal can still cause; it is not the normal path.
 *
 * @param path - Session file, which must already exist.
 * @param text - The line, newline included.
 */
async function appendLine(path: string, text: string): Promise<void> {
  const buffer = Buffer.from(text, "utf8");
  const handle = await open(path, "a");
  try {
    let written = 0;
    while (written < buffer.byteLength) {
      const { bytesWritten } = await handle.write(buffer, written, buffer.byteLength - written);
      if (bytesWritten <= 0) throw new Error(`Append to ${path} made no progress`);
      written += bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

/**
 * `rename`, retried through the transient failures Windows raises when the
 * destination is momentarily held open by another process.
 *
 * POSIX `rename(2)` replaces the destination atomically no matter who has it
 * open. Windows does not: Node's `rename` is libuv's, which is `MoveFileExW`
 * with `MOVEFILE_REPLACE_EXISTING`, and that fails with `ERROR_ACCESS_DENIED`
 * or `ERROR_SHARING_VIOLATION` — surfacing as `EPERM`, `EACCES` or `EBUSY` —
 * while an antivirus scanner, the search indexer or a backup agent has a
 * handle on the file it is replacing. Those holders let go in milliseconds,
 * which is why Node's own `rm` retries the same codes on Windows instead of
 * treating them as real errors.
 *
 * The temp file is cleaned up if the retries run out, so a failed rewrite
 * leaves nothing behind for the next one to trip over. The error itself is
 * re-thrown: a caller may decide this was best-effort, but that has to be the
 * caller's decision to make out loud.
 *
 * @param from - Temp file to move.
 * @param to - Destination, which may already exist.
 */
async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const backoff = RENAME_RETRY_DELAYS_MS[attempt];
      if (backoff === undefined || code === undefined || !RENAME_RETRY_CODES.has(code)) {
        await rm(from, { force: true }).catch(() => undefined);
        throw error;
      }
      await delay(backoff);
    }
  }
}

/**
 * Byte offset where the file's final line begins, or `undefined` when the file
 * holds no newline at all.
 *
 * Scans backwards in bounded windows so the cost is the length of the last
 * line, not the length of the session.
 */
async function findLastLineStart(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<number | undefined> {
  let end = size;
  while (end > 0) {
    const chunkStart = Math.max(0, end - TAIL_SCAN_CHUNK);
    const chunk = Buffer.alloc(end - chunkStart);
    await handle.read(chunk, 0, chunk.length, chunkStart);
    const index = chunk.lastIndexOf(NEWLINE);
    if (index !== -1) return chunkStart + index + 1;
    end = chunkStart;
  }
  return undefined;
}

function parseJson<T>(line: string, sessionId: string): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new SessionStoreError(`Session ${sessionId} contains an unparsable line`, "corrupt");
  }
}

/** Parse a line, or return undefined when it is not valid JSON. */
function tryParseJson<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}
