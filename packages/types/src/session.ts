/** Tree-structured session storage contracts. */

import type { TodoItem } from "./events.js";
import type { Message } from "./messages.js";

export interface SessionHeader {
  version: 1;
  sessionId: string;
  cwd: string;
  createdAt: number;
  title?: string;
}

/** One node in the session tree. Entries form a tree via parentId; branching = new child of an older node. */
export type SessionEntry =
  | { kind: "message"; id: string; parentId: string | null; timestamp: number; message: Message }
  | {
      kind: "compaction";
      id: string;
      parentId: string | null;
      timestamp: number;
      summary: string;
      /** Entry id up to which history was folded into the summary. */
      upToId: string;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { kind: "label"; id: string; parentId: string | null; timestamp: number; label: string }
  | {
      kind: "state";
      id: string;
      parentId: string | null;
      timestamp: number;
      todos?: TodoItem[];
      plan?: string;
      model?: string;
    };

export interface SessionStore {
  create(header: Omit<SessionHeader, "version" | "createdAt">): Promise<SessionHeader>;
  open(sessionId: string): Promise<SessionHeader>;
  append(sessionId: string, entry: SessionEntry): Promise<void>;
  /** All entries, in append order. Callers reconstruct the tree from parentId links. */
  entries(sessionId: string): Promise<SessionEntry[]>;
  /** Entries on the path from the root to `leafId` (the active branch). */
  branch(sessionId: string, leafId: string): Promise<SessionEntry[]>;
  list(): Promise<SessionHeader[]>;
  setTitle(sessionId: string, title: string): Promise<void>;
  /**
   * Permanently remove a session and every entry in it.
   *
   * Irreversible: there is no trash, no tombstone and no undo. A store that
   * implements it must make `open`/`entries` on that id fail as `notFound`
   * afterwards, and must drop it from `list()`.
   *
   * **Optional**, so an existing third-party `SessionStore` (the docs invite
   * you to write one) keeps compiling. A caller that needs deletion and finds
   * this absent must *refuse* rather than reach around the store and unlink
   * files itself — see `SessionHost.deleteSession`, which does exactly that:
   * a store is the only thing that knows where its sessions live.
   *
   * @param sessionId - Session to remove.
   * @throws When the session does not exist, or the removal fails.
   */
  delete?(sessionId: string): Promise<void>;
}
