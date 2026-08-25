/**
 * The dry-run review loop on the wire: what is waiting, land it, throw it away.
 *
 * `--dry-run` is plan mode for files. Every `write`/`edit` is redirected into a
 * shadow copy of the workspace and the real files are not touched until a
 * person has read the change and said so — `/diff`, then `/apply` or
 * `/discard`. That loop existed only in a terminal: `built-in-commands.ts` used
 * to say of `diff` / `apply` / `discard` that "the dry-run overlay lives in the
 * runtime and is not addressable from here", and it was right, because no verb
 * carried them. A remote client attached to a dry-run engine was shown an agent
 * that appeared to do nothing at all.
 *
 * ## What this module is, and what it is not
 *
 * It is the *projection* between the overlay and the wire: pending changes
 * become {@link PendingChanges} rows, a client's selection becomes a set of
 * paths the overlay already listed, and an outcome becomes a result payload.
 *
 * It is **not** an applier. The writing, the temp-file-plus-rename, and the
 * symlink resolution that keeps an apply from landing outside the workspace all
 * live in `@arcturn/cli`'s `Overlay` — the same object the TUI's `/apply`
 * drives — and are reached here through {@link DryRunOverlay}, a structural
 * interface a real `Overlay` satisfies with no adapter. A second applier is the
 * one thing this feature could not afford: it would be a second place for the
 * symlink check to be forgotten, and the difference would only show up on
 * somebody's disk.
 *
 * ## One engine, one shadow tree
 *
 * Worth stating plainly because the verbs are session-scoped and this is not.
 * `--dry-run` is a flag on the served *process*: `buildRuntime` creates one
 * overlay rooted at the served workspace, and every session the host mints gets
 * the same overlay-wrapped tool set. So two sessions on one `arcturn serve`
 * share a shadow tree, and an apply asked for by one of them lands whatever the
 * other one wrote. The verbs still take a `sessionId` — it is what makes
 * `sessionNotFound` answerable and what the busy refusal is phrased against —
 * but `SessionHost` checks **every** live session for a run in flight before
 * writing, because the tree they are all writing into is one tree.
 */

import { Buffer } from "node:buffer";
import { relative, resolve, sep } from "node:path";
import type {
  ApplyChangesResult,
  DiscardChangesResult,
  PendingChange,
  PendingChanges,
} from "@arcturn/types";

/**
 * One workspace file whose shadow copy differs from the real file.
 *
 * Structurally `@arcturn/cli`'s `OverlayChange`. Restated here because
 * `@arcturn/server` does not depend on `@arcturn/cli` — the same reason
 * `SessionHostOptions.modelCatalog` takes a function rather than importing the
 * model registry.
 */
export interface DryRunChange {
  /** Absolute path of the **real** workspace file the change targets. */
  path: string;
  /** `"added"` when the real file does not exist yet, else `"modified"`. */
  kind: "added" | "modified";
  /** The real file's current content, or `null` when it does not exist. */
  before: string | null;
  /** The shadow copy's content — what an apply would write. */
  after: string;
}

/** One failure to write a pending change back. */
export interface DryRunApplyError {
  path: string;
  message: string;
}

/** Outcome of {@link DryRunOverlay.apply}. */
export interface DryRunApplyOutcome {
  /** Real paths that were successfully overwritten from the shadow tree. */
  applied: string[];
  /** Paths that could not be written back, with a reason. */
  errors: DryRunApplyError[];
}

/**
 * The slice of `@arcturn/cli`'s `Overlay` this package needs.
 *
 * Deliberately the smallest one that works: `redirect` and `materialize` are
 * the tool-wrapping half and have no business on a review surface, and `diff`
 * is a rendering the wire does not carry (a client renders its own, from
 * content and the file it already has).
 */
export interface DryRunOverlay {
  /** Absolute, normalized workspace root the overlay shelters. */
  readonly cwd: string;
  /** Every shadow file whose content differs from its real counterpart. */
  changes(): Promise<DryRunChange[]>;
  /**
   * Write pending changes back over the real files, resolving symlinks on each
   * destination's existing ancestors and refusing any that leaves the
   * workspace. `paths` selects a subset; omitted, everything lands.
   */
  apply(paths?: readonly string[]): Promise<DryRunApplyOutcome>;
  /** Throw pending changes away. `paths` selects a subset; omitted, all of it. */
  discard(paths?: readonly string[]): Promise<void>;
}

/**
 * Byte budget for one `pendingChanges` response.
 *
 * 1 MiB, the same number and the same argument as
 * {@link SESSION_HISTORY_MAX_BYTES}: it is `ws-server.ts`'s own
 * `DEFAULT_BACKPRESSURE_THRESHOLD_BYTES` — the point at which this server
 * already considers a connection to be in trouble — and a quarter of
 * `DEFAULT_MAX_PAYLOAD_BYTES` (4 MiB), the frame size above which `ws` closes
 * the connection with 1009. A response answering the client's own request is
 * essential traffic and is never dropped by the backpressure policy, which is
 * exactly why it must not be the frame that wedges the socket.
 *
 * This budget is also the reason the list carries no content. A hundred-file
 * refactor's patches are megabytes; a hundred-file *listing* is about twenty
 * kilobytes. The bytes are fetched one file at a time, which is the only
 * granularity a diff editor renders anyway.
 */
export const PENDING_CHANGES_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling on the number of rows one `pendingChanges` lists.
 *
 * A second bound because the two costs are different, exactly as
 * {@link SESSION_HISTORY_MAX_EVENTS} is a second bound alongside the byte
 * budget: bytes are what the wire pays, row count is what a reviewer pays. A
 * generated migration touching fifty thousand files is small per row and
 * unreviewable as a list, and a surface that offered to apply all of them with
 * one click would be offering something nobody read.
 */
export const PENDING_CHANGES_MAX_FILES = 1000;

/** Bounds applied by {@link createDryRunReview}. Both default as documented above. */
export interface PendingChangesLimits {
  /** See {@link PENDING_CHANGES_MAX_BYTES}. */
  maxBytes?: number;
  /** See {@link PENDING_CHANGES_MAX_FILES}. */
  maxFiles?: number;
}

/**
 * A refusal this module can state, or the payload it produced.
 *
 * A union rather than a throw so this file stays free of `SessionHost`'s error
 * type and can be tested by reading a value; `session-host.ts` is where an
 * `{ ok: false }` becomes a `SessionHostError` and therefore an
 * `invalidRequest` on the wire. The same shape `serve-commands.ts` uses for
 * the same reason.
 */
export type DryRunResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The sentence a client gets when it asks a non-dry-run engine to apply or
 * discard something.
 *
 * Written out rather than left as an empty list, because "there is nothing to
 * apply" and "nothing is being held back here — your edits already landed" are
 * different facts and only one of them is reassuring. It is the same sentence
 * the terminal prints for `/apply` on a session with no overlay.
 */
const DRY_RUN_OFF =
  "This engine is not running under --dry-run, so nothing is being held back: " +
  "file edits reached the workspace as they were made. There are no pending " +
  "changes to review, apply or discard. Start the engine with --dry-run (or " +
  '"dryRun": true in config) to get a review step.';

/** The review loop, bound to one overlay — or to none. */
export interface DryRunReview {
  /**
   * What is waiting, and whether anything ever could be.
   *
   * Answers rather than refuses on a non-dry-run engine: this is a read, and
   * `dryRun: false` is the honest answer to "what is waiting" for a session
   * that holds nothing back. Apply and discard are commands, and a command
   * with nothing to command is refused instead.
   *
   * @param path - One row's wire path, to fetch its content. Refused when it
   *   names nothing pending — a client fetching a file the engine did not just
   *   list is a client whose view is stale, and telling it so is more useful
   *   than an empty answer it would render as "no change here".
   */
  pendingChanges(sessionId: string, path?: string): Promise<DryRunResult<PendingChanges>>;
  /** Land pending changes. See {@link DryRunReview.pendingChanges} for `paths`. */
  applyChanges(
    sessionId: string,
    paths?: readonly string[],
  ): Promise<DryRunResult<ApplyChangesResult>>;
  /** Throw pending changes away. Irreversible. */
  discardChanges(
    sessionId: string,
    paths?: readonly string[],
  ): Promise<DryRunResult<DiscardChangesResult>>;
}

/**
 * The path a client sees and selects by: workspace-relative, `/`-separated.
 *
 * Relative and not absolute because it is an **identity on the wire**, and an
 * absolute one would invite a client to construct its own. This spelling can
 * only ever be one the engine produced from its own `changes()`, which is what
 * makes the selection check in {@link selectPending} a whitelist rather than a
 * sanitizer.
 *
 * A change outside `cwd` cannot occur — the overlay only shelters the
 * workspace, so nothing outside it ever gets a shadow copy — but a `relative`
 * that escaped would produce a `..` path, and that is refused rather than
 * listed. See {@link selectPending}'s note on why a refusal here is preferable
 * to a row nobody can act on.
 */
function wirePath(cwd: string, absolutePath: string): string | undefined {
  const rel = relative(resolve(cwd), resolve(absolutePath));
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) return undefined;
  return rel.split(sep).join("/");
}

/** Project one overlay change into a wire row, without its content. */
function toRow(cwd: string, change: DryRunChange): PendingChange | undefined {
  const path = wirePath(cwd, change.path);
  if (path === undefined) return undefined;
  return {
    path,
    absolutePath: resolve(change.path),
    kind: change.kind,
    bytes: Buffer.byteLength(change.after, "utf8"),
    previousBytes: change.before === null ? 0 : Buffer.byteLength(change.before, "utf8"),
  };
}

/** Rough serialized size of one row, for the byte budget. */
function rowBytes(row: PendingChange): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

/** The refusal for a path nothing is pending under. */
function notPending(path: string): string {
  return (
    `No pending change named ${JSON.stringify(path)}. Selections are the exact paths ` +
    "pendingChanges reported (workspace-relative, forward slashes); ask for the list again — " +
    "the agent may have written since. Nothing was applied or discarded."
  );
}

/**
 * Resolve a client's selection against what is actually pending.
 *
 * Returns the **engine's own** absolute paths, never the client's strings, and
 * that is the whole confinement story for a selective apply: a path the engine
 * did not just list cannot be selected, so there is no `..`, no absolute path,
 * no symlink and no drive letter for this layer to have to reason about. (The
 * overlay's own symlink resolution still runs at write time, for the case the
 * listing itself was fine and the *destination* moved — `bash` is not wrapped
 * by the overlay, so a link can appear mid-run.)
 *
 * A name that is not pending refuses the whole request rather than being
 * skipped. A reviewer who selected four files and silently got three has been
 * told a status that was correct about the wrong set.
 */
function selectPending(
  rows: readonly PendingChange[],
  paths: readonly string[] | undefined,
): DryRunResult<PendingChange[]> {
  if (paths === undefined) return { ok: true, value: [...rows] };
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const selected: PendingChange[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const row = byPath.get(path);
    if (row === undefined) return { ok: false, error: notPending(path) };
    // A repeated path is not an error, but it must not be acted on twice: a
    // duplicate would double-count `applied` and, for discard, ask the overlay
    // to remove a shadow copy that is already gone.
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    selected.push(row);
  }
  return { ok: true, value: selected };
}

/**
 * Build the review loop over an overlay, or over nothing.
 *
 * @param overlay - The served runtime's dry-run overlay, or `undefined` when
 *   the engine is not in dry-run mode. Not an optional *feature* flag: an
 *   engine with no overlay still answers `pendingChanges` (with
 *   `dryRun: false`), because "this engine does not hold edits back" is
 *   something a client must be able to learn without guessing from silence.
 * @param limits - Payload bounds; both default. Injectable so a test can prove
 *   the caps bite without writing a megabyte of scratch files first.
 */
export function createDryRunReview(
  overlay: DryRunOverlay | undefined,
  limits: PendingChangesLimits = {},
): DryRunReview {
  const maxBytes = limits.maxBytes ?? PENDING_CHANGES_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? PENDING_CHANGES_MAX_FILES;

  /**
   * Every pending change as a wire row, sorted by path, paired with the
   * overlay record it came from.
   *
   * The pairing is what lets a single-file fetch answer from the *same*
   * `changes()` snapshot the row was built in. Reading twice would let a run
   * land in between, and a client would get a row describing one version of a
   * file with the content of another.
   */
  async function pendingRows(
    active: DryRunOverlay,
  ): Promise<{ row: PendingChange; change: DryRunChange }[]> {
    const changes = await active.changes();
    const out: { row: PendingChange; change: DryRunChange }[] = [];
    for (const change of changes) {
      const row = toRow(active.cwd, change);
      if (row !== undefined) out.push({ row, change });
    }
    out.sort((a, b) => a.row.path.localeCompare(b.row.path));
    return out;
  }

  /** Just the rows. */
  async function rows(active: DryRunOverlay): Promise<PendingChange[]> {
    return (await pendingRows(active)).map((entry) => entry.row);
  }

  /** How many changes are still waiting. Re-read, never inferred by arithmetic. */
  async function remaining(active: DryRunOverlay): Promise<number> {
    return (await rows(active)).length;
  }

  return {
    async pendingChanges(sessionId: string, path?: string): Promise<DryRunResult<PendingChanges>> {
      if (overlay === undefined) {
        return {
          ok: true,
          value: { sessionId, dryRun: false, changes: [], truncated: false, droppedChanges: 0 },
        };
      }
      // One `changes()` read for both shapes. A second read to fetch the
      // content would be a second snapshot, and a row from one paired with
      // content from the other is exactly the disagreement a review surface
      // must not have.
      const pending = await pendingRows(overlay);

      if (path !== undefined) {
        const found = pending.find((entry) => entry.row.path === path);
        if (found === undefined) return { ok: false, error: notPending(path) };
        const withContent: PendingChange =
          found.row.bytes > maxBytes
            ? { ...found.row, contentOmitted: true }
            : { ...found.row, after: found.change.after };
        return {
          ok: true,
          value: {
            sessionId,
            dryRun: true,
            changes: [withContent],
            truncated: false,
            droppedChanges: 0,
          },
        };
      }

      const all = pending.map((entry) => entry.row);

      const kept: PendingChange[] = [];
      let used = 0;
      for (const row of all) {
        if (kept.length >= maxFiles) break;
        const size = rowBytes(row);
        if (used + size > maxBytes) break;
        used += size;
        kept.push(row);
      }
      const dropped = all.length - kept.length;
      return {
        ok: true,
        value: {
          sessionId,
          dryRun: true,
          changes: kept,
          truncated: dropped > 0,
          droppedChanges: dropped,
        },
      };
    },

    async applyChanges(
      sessionId: string,
      paths?: readonly string[],
    ): Promise<DryRunResult<ApplyChangesResult>> {
      if (overlay === undefined) return { ok: false, error: DRY_RUN_OFF };
      const active = overlay;
      const selected = selectPending(await rows(active), paths);
      if (!selected.ok) return selected;

      // The overlay is handed ITS OWN absolute paths, taken from the rows it
      // produced — never a string that arrived on the wire.
      const outcome = await active.apply(selected.value.map((row) => row.absolutePath));
      // Back to the spelling the client selected by. Looked up from the rows
      // this call built rather than recomputed, so an `applied` entry and the
      // row it came from can never disagree about what to call the file.
      const byAbsolute = new Map(selected.value.map((row) => [row.absolutePath, row.path]));
      const wireOf = (absolutePath: string): string =>
        byAbsolute.get(resolve(absolutePath)) ?? wirePath(active.cwd, absolutePath) ?? absolutePath;

      // A clean, complete apply empties the shadow tree, exactly as the
      // terminal's `/apply` does — it is what leaves an overlay with no
      // materialized-but-unedited copies lying in it. A partial apply does
      // not: the copies that did NOT land are the pending changes, and
      // deleting them would be a discard nobody asked for.
      if (paths === undefined && outcome.errors.length === 0) await active.discard();

      return {
        ok: true,
        value: {
          sessionId,
          applied: outcome.applied.map(wireOf),
          failed: outcome.errors.map((error) => ({
            path: wireOf(error.path),
            message: error.message,
          })),
          remaining: await remaining(active),
        },
      };
    },

    async discardChanges(
      sessionId: string,
      paths?: readonly string[],
    ): Promise<DryRunResult<DiscardChangesResult>> {
      if (overlay === undefined) return { ok: false, error: DRY_RUN_OFF };
      const active = overlay;
      const selected = selectPending(await rows(active), paths);
      if (!selected.ok) return selected;

      await active.discard(
        paths === undefined ? undefined : selected.value.map((row) => row.absolutePath),
      );
      return {
        ok: true,
        value: {
          sessionId,
          discarded: selected.value.map((row) => row.path),
          remaining: await remaining(active),
        },
      };
    },
  };
}
