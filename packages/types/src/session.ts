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

/**
 * One deliberate prefix edit by local context editing, recorded so a resume
 * replays exactly the request the live agent sent.
 *
 * Elision is decided in rare *passes*, never per request: between passes the
 * outgoing history is append-only. A pass stubs out the `elided` results
 * (keyed by tool-call id) from this entry on and — where thinking is bound to
 * the prefix — withholds the thinking of every assistant message between the
 * first of them and this entry, since those blocks were produced over the
 * unedited results. `withholdThinking: "all"` withholds every earlier
 * assistant message's thinking (the tool set changed under all of them).
 */
export interface ContextEditRecord {
  /** Tool-call ids whose results are sent as elision stubs from here on. */
  elided: string[];
  /** Which earlier thinking stops being replayed at this entry. */
  withholdThinking?: "afterFirstElided" | "all";
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
      /**
       * The kept tail's assistant messages replay without their thinking: it
       * was produced over the history the summary replaced, so it is bound to
       * a prefix that no longer exists. Absent on older files and on shapes
       * that keep no tail.
       */
      stripTailThinking?: boolean;
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
      /** A local context-editing pass; see {@link ContextEditRecord}. */
      contextEdit?: ContextEditRecord;
      /**
       * Fingerprint of the `system` prompt and tool set the next requests go
       * out with. Written whenever it changes (and on a session's first
       * request), so a resume can tell that the head differs from the one
       * every earlier thinking block was produced under.
       */
      head?: string;
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
