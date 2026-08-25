/**
 * The serve path's org memory: read the store, propose an inert entry, take one
 * back — and, deliberately, no way at all to make one active.
 *
 * This module exists so that the decision about which transitions a remote
 * caller may cause is made **next to the store's own bounds**, the way
 * `serve-mcp.ts` makes its redaction decision next to the credentials. The
 * bounds — one line, 160 characters, refusal rather than truncation, no control
 * marker, no fence delimiter, twelve per role, two hundred per store, all
 * re-applied on read — live in `org-memory.ts`. Nothing here re-implements any
 * of them; every function below is the one `/org memory` already calls.
 *
 * ## The gate, stated once
 *
 * An `active` entry is appended to a role's **system prompt** on later runs.
 * It is standing instruction text the model reads with no user action at all,
 * which is why "a new entry is inert until a person activates it" is bound two
 * of seven on this feature and why the CLI reference says the gate exists
 * because an entry becoming standing instruction is "not something a model
 * should be able to grant itself".
 *
 * So: {@link serveOrgMemoryStore} exposes `read`, `propose` and `revoke`.
 *
 * - `propose` calls `addOrgMemoryEntry` with `status: "proposed"` **written
 *   literally at the call site**, not threaded from a parameter. There is no
 *   parameter. The wire request has no field, `OrgMemoryStoreAccess.propose`
 *   has no argument, and this call site has no variable — three layers, none of
 *   which can be made to say `"active"` by anything arriving over a socket.
 * - There is **no `approve`**. The terminal's `/org memory approve` calls
 *   `setOrgMemoryStatus(store, id, "active")`; that call appears nowhere in
 *   this file and must not. `add`, which files an already-active entry because
 *   a person typed it, is absent for the same reason.
 * - `revoke` calls `setOrgMemoryStatus(store, id, "proposed")` or
 *   `removeOrgMemoryEntries`. Both are allowed because both only ever *reduce*
 *   what a later run is told, and the gate is about text a model could grant
 *   itself, not text it could take away.
 *
 * The argument for refusing approve over the wire is not that the caller is
 * untrustworthy — the serve token already buys full tool execution as this
 * user, so a caller holding it can do considerably worse than write a JSON
 * file. It is that the engine **cannot tell a person from a model** on this
 * side of a socket, and the gate's entire content is *who is asserting*.
 * `/org memory add` is live precisely because a person typed it at their own
 * keyboard. RFC 0005 §1.2 answered the identical question for permission rules
 * — a decision made over the wire may not outlive its session, because a rule
 * that does "is written by a person, in their own config file" — and an
 * org-memory entry outlives the session in exactly that sense: it is the next
 * run's instructions.
 *
 * What a client should build on this is the *queue*: show what is waiting, show
 * its `origin`, and show the one command that approves it. A person then reads
 * the sentence before it becomes an instruction, which is the outcome the gate
 * was for.
 *
 * ## Read-modify-write, and what that costs
 *
 * Every call re-reads the file, applies one change, and writes it back — which
 * is exactly what each `/org memory` invocation does, because the store is a
 * value and not a service. Two writers racing (a serve process and a terminal)
 * can therefore lose one edit, the same way two terminals can today. Left as it
 * is rather than papered over with a lock here: a lock in one of two writers is
 * not a lock, and the fix belongs in `org-memory.ts` where both go through.
 */

import type {
  OrgMemoryReadResult,
  OrgMemoryRecord,
  OrgMemoryStoreAccess,
  OrgMemoryWriteResult,
} from "@arcturn/server";
import {
  addOrgMemoryEntry,
  type OrgMemoryStore,
  orgMemoryPath,
  readOrgMemory,
  removeOrgMemoryEntries,
  setOrgMemoryStatus,
  writeOrgMemory,
} from "./org-memory.js";

/**
 * Where an entry filed over the wire says it came from.
 *
 * A short tag, not prose, and distinct from the terminal's `"operator"` on
 * purpose: provenance is what a person approving an entry most needs and cannot
 * otherwise see. Once two suggestions are both text in a list, one typed at the
 * keyboard and one that arrived over a socket read identically.
 */
export const REMOTE_ORG_MEMORY_ORIGIN = "remote";

/** The paths slice {@link serveOrgMemoryStore} needs. Mirrors `ArcturnPaths`. */
export interface OrgMemoryPaths {
  readonly home: string;
  readonly project: string;
}

/**
 * Build the store accessor `@arcturn/server` consumes, over the same file
 * `/org memory` reads.
 *
 * @param paths - The runtime's paths. The file is
 *   `<home>/org-memory/<project hash>.json` — outside the repository, so a
 *   clone can never ship standing instructions into a role's prompt.
 */
export function serveOrgMemoryStore(paths: OrgMemoryPaths): OrgMemoryStoreAccess {
  const file = orgMemoryPath(paths);
  const read = async (): Promise<OrgMemoryReadResult> => {
    const { store, warnings } = await readOrgMemory(file);
    return { entries: store.entries, warnings };
  };
  /** Persist, then report — or hand back the write failure as a refusal. */
  const save = async <T>(next: OrgMemoryStore, value: T): Promise<OrgMemoryWriteResult<T>> => {
    try {
      await writeOrgMemory(file, next);
    } catch (error) {
      return { error: `Could not write ${file}: ${String(error)}` };
    }
    return { value };
  };
  return {
    read,
    propose: async (role: string, text: string): Promise<OrgMemoryWriteResult<OrgMemoryRecord>> => {
      const { store } = await readOrgMemory(file);
      const result = addOrgMemoryEntry(store, {
        role,
        text,
        // Written literally, and this is the line the whole module is about.
        // There is no variable here and no parameter to make one from.
        status: "proposed",
        origin: REMOTE_ORG_MEMORY_ORIGIN,
      });
      if ("error" in result) return { error: result.error };
      return save(result.store, result.entry);
    },
    revoke: async (
      id: string,
      remove: boolean,
    ): Promise<OrgMemoryWriteResult<OrgMemoryReadResult>> => {
      const { store, warnings } = await readOrgMemory(file);
      if (remove) {
        const result = removeOrgMemoryEntries(store, { ids: [id] });
        if (result.removed.length === 0) {
          return { error: `No org memory entry "${id}".` };
        }
        return save(result.store, { entries: result.store.entries, warnings });
      }
      // `"proposed"`, never `"active"`. `setOrgMemoryStatus` is the same
      // function `/org memory approve` calls with the other argument; the
      // argument is what this wire may not supply.
      const result = setOrgMemoryStatus(store, id, "proposed");
      if ("error" in result) return { error: result.error };
      return save(result.store, { entries: result.store.entries, warnings });
    },
  };
}
