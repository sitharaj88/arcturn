/** An in-memory {@link SessionStore}, useful for tests and ephemeral sessions. */

import type { SessionEntry, SessionHeader, SessionStore } from "@arcturn/types";
import { SessionStoreError } from "./jsonl-store.js";
import { pathToLeaf } from "./tree.js";

/** Volatile {@link SessionStore} backed by plain maps. */
export class MemorySessionStore implements SessionStore {
  #headers = new Map<string, SessionHeader>();
  #entries = new Map<string, SessionEntry[]>();

  /** @inheritdoc */
  async create(header: Omit<SessionHeader, "version" | "createdAt">): Promise<SessionHeader> {
    if (this.#headers.has(header.sessionId)) {
      throw new SessionStoreError(`Session ${header.sessionId} already exists`, "exists");
    }
    const full: SessionHeader = {
      version: 1,
      sessionId: header.sessionId,
      cwd: header.cwd,
      createdAt: Date.now(),
      ...(header.title === undefined ? {} : { title: header.title }),
    };
    this.#headers.set(full.sessionId, full);
    this.#entries.set(full.sessionId, []);
    return full;
  }

  /** @inheritdoc */
  async open(sessionId: string): Promise<SessionHeader> {
    return this.#require(sessionId);
  }

  /** @inheritdoc */
  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    this.#require(sessionId);
    this.#entries.get(sessionId)!.push(entry);
  }

  /** @inheritdoc */
  async entries(sessionId: string): Promise<SessionEntry[]> {
    this.#require(sessionId);
    return [...this.#entries.get(sessionId)!];
  }

  /** @inheritdoc */
  async branch(sessionId: string, leafId: string): Promise<SessionEntry[]> {
    return pathToLeaf(await this.entries(sessionId), leafId);
  }

  /** @inheritdoc */
  async list(): Promise<SessionHeader[]> {
    return [...this.#headers.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** @inheritdoc */
  async setTitle(sessionId: string, title: string): Promise<void> {
    const header = this.#require(sessionId);
    this.#headers.set(sessionId, { ...header, title });
  }

  /** @inheritdoc */
  async delete(sessionId: string): Promise<void> {
    this.#require(sessionId);
    this.#headers.delete(sessionId);
    this.#entries.delete(sessionId);
  }

  #require(sessionId: string): SessionHeader {
    const header = this.#headers.get(sessionId);
    if (!header) throw new SessionStoreError(`Session ${sessionId} does not exist`, "notFound");
    return header;
  }
}
