/**
 * Org memory on the wire — and, more to the point, the half of it that is
 * deliberately not here.
 *
 * An org-memory entry is a one-line lesson appended to a role's **system
 * prompt** on later runs. An `active` entry is therefore standing instruction
 * text: text the model reads, every run, with no user action at all. Entries
 * are `proposed` or `active`, only `active` ones are ever rendered, and the
 * thing that moves an entry between those two states is a person typing
 * `/org memory approve` — "not something a model should be able to grant
 * itself".
 *
 * ## Three verbs, and the one that is missing
 *
 * `orgMemory` reads. `proposeOrgMemory` files an entry that reaches no prompt.
 * `revokeOrgMemory` takes one back. **There is no verb that makes an entry
 * active**, and this module is shaped so that there could not accidentally be
 * one: {@link OrgMemoryStoreAccess.propose} has no status parameter, the wire
 * request type has no status field, the validator copies two fields by name,
 * and the response validator *refuses* an entry that comes back `active`. Four
 * independent narrow gates on one bit, because that bit is the whole feature.
 *
 * ### Why proposing is allowed and approving is not
 *
 * The direction. Proposing, revoking and deleting can only ever *reduce or
 * leave unchanged* what a later run is told; approving is the only one that
 * adds. And the gate is not "is this caller trustworthy" — the serve token
 * already buys full tool execution as the user, so a caller that holds it can
 * do far worse than write a JSON file. The gate is about **who is asserting**.
 * An engine cannot tell a frame a person clicked from a frame an agent sent,
 * and `/org memory add` is live precisely *because* a person typed it at their
 * own keyboard. RFC 0005 §1.2 settled the identical question for permission
 * rules: a decision made over the wire may not outlive its session, because a
 * rule that does "is written by a person, in their own config file". An
 * org-memory entry outlives the session in exactly that sense — it is the
 * next run's instructions — so it gets exactly that answer.
 *
 * What a remote client *should* do with this is make the queue visible: show
 * what is waiting, who proposed it, and the one command that approves it. That
 * is a better outcome than a remote approve button, because the person then
 * reads the sentence before it becomes an instruction.
 *
 * ## What this module is, and what it is not
 *
 * It is the projection between one org-memory store and the wire. It is **not**
 * a store: the file path, the read-time bound re-application, the sanitizer
 * that refuses an over-long lesson rather than clipping it, and the writer all
 * live in `@arcturn/cli`'s `org-memory.ts` — the same functions `/org memory`
 * drives — and are reached here through {@link OrgMemoryStoreAccess}. A second
 * store would be a second set of bounds, and the bounds are the feature.
 */

import type { OrgMemoryEntry, OrgMemoryList, OrgMemoryStatus } from "@arcturn/types";

/**
 * One entry as its store reports it.
 *
 * Structurally `@arcturn/cli`'s `OrgMemoryEntry`. Restated because
 * `@arcturn/server` does not depend on `@arcturn/cli`, for the reason
 * {@link BackgroundAgentRecord} is restated in `background-agents.ts`.
 */
export interface OrgMemoryRecord {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly status: OrgMemoryStatus;
  readonly createdAt: number;
  readonly origin?: string;
}

/** What a store read produced: the entries, and what its bounds rejected. */
export interface OrgMemoryReadResult {
  readonly entries: readonly OrgMemoryRecord[];
  readonly warnings: readonly string[];
}

/**
 * A refusal the store itself wrote — an over-long lesson, a control marker, a
 * per-role cap already full, an id nothing matches.
 *
 * A union rather than a throw so the refusal can be tested by reading a value,
 * and so the *sentence* stays in `@arcturn/cli` next to the bound it describes.
 * A person reading "at most 160 characters; clipping can invert a lesson" needs
 * that sentence, not "invalid request".
 */
export type OrgMemoryWriteResult<T> = { readonly value: T } | { readonly error: string };

/**
 * The slice of `@arcturn/cli`'s org-memory functions this package needs.
 *
 * Three methods, and the shape of the first one is the argument: `propose`
 * takes a role and a text and **no status**. The CLI's own
 * `addOrgMemoryEntry` takes a `status`, because the terminal has two callers
 * for it — `/org memory add` (active, because a person typed it) and
 * `/org memory propose` (inert). This wire has one, and the seam is where that
 * is made structural rather than remembered.
 */
export interface OrgMemoryStoreAccess {
  /** Read the store, re-applying its own bounds. */
  read(): Promise<OrgMemoryReadResult>;
  /**
   * File a **proposed** entry. There is no status parameter and there will not
   * be one; see this module's doc.
   */
  propose(role: string, text: string): Promise<OrgMemoryWriteResult<OrgMemoryRecord>>;
  /**
   * Demote an `active` entry to `proposed`, or (with `remove`) delete it
   * outright. Both directions only ever reduce what later runs are told.
   */
  revoke(id: string, remove: boolean): Promise<OrgMemoryWriteResult<OrgMemoryReadResult>>;
}

/**
 * Project one store entry into a wire row.
 *
 * Built by naming every field, like every other projection in this package, so
 * a field the store grows tomorrow is absent by default. `text` is the one
 * field here that is genuinely untrusted prose, and it arrives already bounded
 * by the store's own sanitizer — one line, 160 characters, no control or bidi
 * characters, no `ORG-ASK:`/`ORG-HALT:`/`ARCTURN-PATCH:` marker, no fence
 * delimiter — because those bounds are re-applied on read rather than trusted
 * from the file.
 */
export function projectOrgMemoryEntry(record: OrgMemoryRecord): OrgMemoryEntry {
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.origin === undefined ? {} : { origin: record.origin }),
  };
}

/**
 * Build the `orgMemory` payload.
 *
 * Sorted by role, then by id, so two reads of an unchanged store compare equal
 * — the same reason `PermissionState.tools` and `mcpServerSummaries` sort. The
 * store's own order is insertion order, which is a fine thing for a file and a
 * poor thing for a list a client diffs.
 */
export function projectOrgMemory(read: OrgMemoryReadResult): OrgMemoryList {
  const entries = [...read.entries]
    .sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id))
    .map(projectOrgMemoryEntry);
  return { entries, warnings: [...read.warnings] };
}
