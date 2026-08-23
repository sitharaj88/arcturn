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
}
