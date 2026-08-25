/**
 * JSONL-backed session store: one directory per store, one `.jsonl` file per
 * session. The first line is the {@link SessionHeader}; every later line is a
 * {@link SessionEntry}. Entries form a tree through their `parentId` links, so
 * branching is just appending a child to an older node.
 */

import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
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

/** Construction options for {@link JsonlSessionStore}. */
export interface JsonlSessionStoreOptions {
  /** Directory that holds the `.jsonl` session files. Created on demand. */
  dir: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const FILE_SUFFIX = ".jsonl";

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
  /** Serializes writes per session so concurrent appends never interleave. */
  #writeQueues = new Map<string, Promise<void>>();
  #dirReady: Promise<void> | undefined;

  constructor(options: JsonlSessionStoreOptions) {
    this.#dir = options.dir;
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
   * @param sessionId - Target session.
   * @param entry - Entry to append.
   */
  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    assertSessionId(sessionId);
    const previous = this.#writeQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          // appendFile would happily create a brand-new file; a session must
          // never exist without its header line.
          await access(this.#path(sessionId));
          await appendFile(this.#path(sessionId), `${JSON.stringify(entry)}\n`);
        } catch (error) {
          if (isMissing(error)) {
            throw new SessionStoreError(`Session ${sessionId} does not exist`, "notFound");
          }
          throw error;
        }
      });
    this.#writeQueues.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.#writeQueues.get(sessionId) === next) this.#writeQueues.delete(sessionId);
    }
  }

  /**
   * Every entry of a session, in append order.
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
        if (parsed !== undefined) entries.push(parsed);
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
   * leave a session without its header.
   *
   * @param sessionId - Session to retitle.
   * @param title - New title.
   */
  async setTitle(sessionId: string, title: string): Promise<void> {
    const header = await this.open(sessionId);
    const lines = await this.#lines(sessionId);
    const updated: SessionHeader = { ...header, title };
    const body = [JSON.stringify(updated), ...lines.slice(1)].join("\n");
    const tmp = `${this.#path(sessionId)}.tmp`;
    await writeFile(tmp, `${body}\n`);
    await rename(tmp, this.#path(sessionId));
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
    await this.#writeQueues.get(sessionId)?.catch(() => undefined);
    try {
      await rm(this.#path(sessionId));
    } catch (error) {
      if (isMissing(error)) {
        throw new SessionStoreError(`Session ${sessionId} does not exist`, "notFound");
      }
      throw error;
    }
    this.#writeQueues.delete(sessionId);
  }

  #path(sessionId: string): string {
    return join(this.#dir, `${sessionId}${FILE_SUFFIX}`);
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
