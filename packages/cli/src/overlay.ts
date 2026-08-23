/**
 * Dry-run overlay ("plan mode for files"): every file mutation is redirected
 * into a shadow copy of the workspace instead of the real one, so the agent
 * can work normally and the user reviews **one** aggregate diff at the end and
 * then applies or discards it.
 *
 * The shadow tree lives in a caller-provided directory (the integration is
 * expected to pass something like `~/.arcturn/overlays/<sessionId>`) and mirrors
 * the workspace's relative structure:
 *
 * ```text
 * <cwd>/src/app.ts   ->   <dir>/src/app.ts
 * ```
 *
 * The flow for one file is always the same three steps:
 *
 * 1. {@link Overlay.materialize} copies the real file into the shadow the
 *    first time it is touched (so `edit` has something to match against).
 * 2. The tool writes to the shadow path returned by {@link Overlay.redirect}.
 * 3. {@link Overlay.changes} / {@link Overlay.diff} compare the shadow tree
 *    against the real one, and {@link Overlay.apply} / {@link Overlay.discard}
 *    resolve the session.
 *
 * Only paths *inside* `cwd` are redirected — see {@link Overlay.redirect}.
 *
 * See `INTEGRATION-overlay.md` at the repo root for how a host application is
 * expected to wire this into `config.ts`, `runtime.ts` and `/diff`, `/apply`,
 * `/discard` commands — including the documented `bash` boundary (a shell
 * command still mutates the real tree).
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolvePath } from "@arcturn/tools";
import type { Tool, ToolExecutionContext } from "@arcturn/types";

/** One workspace file whose shadow copy differs from the real file. */
export interface OverlayChange {
  /** Absolute path of the **real** workspace file the change targets. */
  path: string;
  /** `"added"` when the real file does not exist yet, else `"modified"`. */
  kind: "added" | "modified";
  /** The real file's current content, or `null` when it does not exist. */
  before: string | null;
  /** The shadow copy's content — what {@link Overlay.apply} would write. */
  after: string;
}

/** One failure to write a pending change back, alongside the path it targeted. */
export interface OverlayApplyError {
  path: string;
  message: string;
}

/** Outcome of {@link Overlay.apply}. */
export interface OverlayApplyResult {
  /** Real paths that were successfully overwritten from the shadow tree. */
  applied: string[];
  /** Paths that could not be written back, with a reason. */
  errors: OverlayApplyError[];
}

/** Options for {@link createOverlay}. */
export interface CreateOverlayOptions {
  /** Absolute workspace root. Only paths under it are sheltered. */
  cwd: string;
  /** Shadow root, e.g. `~/.arcturn/overlays/<sessionId>`. Created lazily. */
  dir: string;
}

/** A shadow copy of the workspace that file mutations are redirected into. */
export interface Overlay {
  /** Absolute, normalized workspace root. */
  readonly cwd: string;
  /** Absolute, normalized shadow root. */
  readonly dir: string;

  /**
   * Map a real workspace path to its shadow path.
   *
   * Paths outside {@link Overlay.cwd} are returned **unchanged**: the overlay
   * only shelters the workspace. Redirecting `/etc/hosts` or `~/.ssh/config`
   * into the shadow tree would silently swallow a write the user did not ask
   * to be sandboxed (and would need to invent a mapping for an arbitrary
   * absolute path), so those writes keep going where the tool intended and the
   * permission engine stays the thing that gates them.
   *
   * @param absPath - Absolute path (as produced by `resolvePath`).
   * @returns The shadow path, or `absPath` itself when it is not sheltered.
   */
  redirect(absPath: string): string;

  /**
   * Copy the real file at `absPath` into its shadow slot, once.
   *
   * A no-op when the path is not sheltered, when a shadow copy already exists
   * (so the agent's pending edits are never clobbered by a later touch), or
   * when the real file does not exist (a brand-new file simply gets created in
   * the shadow by the `write` tool).
   *
   * @param absPath - Absolute path of the real workspace file.
   * @throws When the real file exists but cannot be read (anything but ENOENT).
   */
  materialize(absPath: string): Promise<void>;

  /**
   * Every shadow file whose content differs from its real counterpart,
   * sorted by path. Resolves to `[]` when the shadow tree does not exist yet.
   *
   * Shadow files that are byte-identical to the real file (a `materialize`
   * the agent never followed up on) are not changes and are omitted.
   */
  changes(): Promise<OverlayChange[]>;

  /**
   * A single unified diff across every pending change, with paths shown
   * relative to {@link Overlay.cwd} and 3 lines of context. Each file's body
   * is capped at {@link MAX_DIFF_LINES_PER_FILE} lines followed by a
   * truncation marker. Resolves to `""` when nothing is pending.
   */
  diff(): Promise<string>;

  /**
   * Write every pending change back over the real workspace files.
   *
   * Each file is written via a temp file + rename in the destination
   * directory, so an interrupted apply can never leave a half-written file.
   * A failure on one path is collected and the rest still apply.
   *
   * The shadow tree is left in place; a caller that wants the overlay emptied
   * calls {@link Overlay.discard} afterwards.
   */
  apply(): Promise<OverlayApplyResult>;

  /** Delete the whole shadow tree. Safe to call when it does not exist. */
  discard(): Promise<void>;
}

/** Per-file cap on {@link Overlay.diff} body lines, before the truncation marker. */
export const MAX_DIFF_LINES_PER_FILE = 200;

/** Lines of unchanged context kept around each hunk. */
const DIFF_CONTEXT_LINES = 3;

/** LCS tables above this many cells fall back to a coarse "replaced" diff. */
const MAX_LCS_CELLS = 4_000_000;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/**
 * Whether `error` means "there is no file there": either nothing exists at the
 * path, or one of its parents is a regular file (ENOTDIR), which happens when
 * the agent creates `dir/child` in the shadow while `dir` is a file for real.
 */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file as text, or `null` when there is no file at `path`. Any other
 * failure (a permission error, a directory) propagates: silently calling an
 * unreadable file "absent" would let {@link Overlay.apply} overwrite it as if
 * it were new.
 */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

/** Write `data` to `path` via a temp file + rename in the same directory. */
async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tmp = join(parent, `.overlay-tmp-${randomUUID()}`);
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Collect every regular file under `root`, as paths relative to it.
 *
 * Symlinks are skipped deliberately: the shadow tree is only ever populated by
 * this module's own copies and by tool writes into it, so a symlink there is
 * not something the overlay should follow back out over a real file.
 */
async function listFilesRelative(root: string, prefix = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFilesRelative(root, rel)));
    } else if (entry.isFile()) {
      found.push(rel);
    }
  }
  return found;
}

type DiffOpType = "equal" | "add" | "del";

interface DiffOp {
  type: DiffOpType;
  value: string;
}

/**
 * Line-level diff of `oldLines` against `newLines` via a classic LCS
 * dynamic-programming table, with a coarse "delete everything, add everything"
 * fallback once the table would exceed {@link MAX_LCS_CELLS}.
 */
function computeOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((value): DiffOp => ({ type: "del", value })),
      ...newLines.map((value): DiffOp => ({ type: "add", value })),
    ];
  }

  // dp[i][j] = length of the LCS of oldLines[i..] and newLines[j..].
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const next = dp[i + 1] as Uint32Array;
    const oldLine = oldLines[i] as string;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        oldLine === newLines[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i] as string;
    const newLine = newLines[j] as string;
    if (oldLine === newLine) {
      ops.push({ type: "equal", value: oldLine });
      i++;
      j++;
    } else if ((dp[i + 1] as Uint32Array)[j]! >= (dp[i] as Uint32Array)[j + 1]!) {
      ops.push({ type: "del", value: oldLine });
      i++;
    } else {
      ops.push({ type: "add", value: newLine });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", value: oldLines[i++] as string });
  while (j < m) ops.push({ type: "add", value: newLines[j++] as string });
  return ops;
}

/** Render `ops` as unified-diff hunk lines (`@@` headers included). */
function renderHunks(ops: DiffOp[], context: number): string[] {
  // Runs of changed ops, merged when they are close enough to share context.
  const runs: Array<[number, number]> = [];
  let scan = 0;
  while (scan < ops.length) {
    if ((ops[scan] as DiffOp).type === "equal") {
      scan++;
      continue;
    }
    let end = scan;
    while (end < ops.length && (ops[end] as DiffOp).type !== "equal") end++;
    const last = runs[runs.length - 1];
    if (last && scan - last[1] <= context * 2) last[1] = end;
    else runs.push([scan, end]);
    scan = end;
  }
  if (runs.length === 0) return [];

  const oldNo: number[] = new Array(ops.length);
  const newNo: number[] = new Array(ops.length);
  let ol = 1;
  let nl = 1;
  for (let k = 0; k < ops.length; k++) {
    oldNo[k] = ol;
    newNo[k] = nl;
    const op = ops[k] as DiffOp;
    if (op.type !== "add") ol++;
    if (op.type !== "del") nl++;
  }

  const lines: string[] = [];
  for (const [start, end] of runs) {
    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + context);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k < to; k++) {
      const op = ops[k] as DiffOp;
      if (op.type === "equal") {
        body.push(` ${op.value}`);
        oldCount++;
        newCount++;
      } else if (op.type === "del") {
        body.push(`-${op.value}`);
        oldCount++;
      } else {
        body.push(`+${op.value}`);
        newCount++;
      }
    }
    const oldStart = from < ops.length ? (oldNo[from] as number) : ol;
    const newStart = from < ops.length ? (newNo[from] as number) : nl;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  }
  return lines;
}

/**
 * Unified diff for one file, `null`-safe on `before` (an added file diffs
 * against `/dev/null`) and capped at {@link MAX_DIFF_LINES_PER_FILE} body
 * lines.
 *
 * @param label - Path shown in the `---`/`+++` header, conventionally relative.
 * @param before - Previous content, or `null` when the file is new.
 * @param after - New content.
 */
export function formatOverlayDiff(label: string, before: string | null, after: string): string {
  const oldLines = before === null ? [] : before.split("\n");
  const newLines = after.split("\n");
  const body = renderHunks(computeOps(oldLines, newLines), DIFF_CONTEXT_LINES);
  const header = [before === null ? "--- /dev/null" : `--- a/${label}`, `+++ b/${label}`];
  if (body.length <= MAX_DIFF_LINES_PER_FILE) return [...header, ...body].join("\n");
  const kept = body.slice(0, MAX_DIFF_LINES_PER_FILE);
  const hidden = body.length - kept.length;
  return [
    ...header,
    ...kept,
    `... diff truncated: ${hidden} more line${hidden === 1 ? "" : "s"} for ${label}`,
  ].join("\n");
}

/** Filesystem-backed {@link Overlay}. */
class ShadowOverlay implements Overlay {
  readonly cwd: string;
  readonly dir: string;

  constructor(options: CreateOverlayOptions) {
    this.cwd = resolve(options.cwd);
    this.dir = resolve(options.dir);
  }

  redirect(absPath: string): string {
    const resolved = resolve(absPath);
    // `cwd` itself is a directory, never a sheltered file, so only strict
    // descendants map into the shadow tree.
    if (!resolved.startsWith(this.cwd + sep)) return absPath;
    return join(this.dir, relative(this.cwd, resolved));
  }

  async materialize(absPath: string): Promise<void> {
    const shadow = this.redirect(absPath);
    if (shadow === absPath) return; // Not sheltered.
    if (await exists(shadow)) return; // Already copied; keep pending edits.
    let content: Buffer;
    try {
      content = await readFile(resolve(absPath));
    } catch (error) {
      if (isMissing(error)) return; // Brand-new file: nothing to copy.
      throw error;
    }
    await mkdir(dirname(shadow), { recursive: true });
    await writeFile(shadow, content);
  }

  async changes(): Promise<OverlayChange[]> {
    const relatives = await listFilesRelative(this.dir);
    const changes: OverlayChange[] = [];
    for (const rel of relatives.sort()) {
      const shadowPath = join(this.dir, rel);
      const realPath = join(this.cwd, rel);
      const after = await readFile(shadowPath, "utf8");
      const before = await readTextOrNull(realPath);
      if (before === after) continue; // Materialized but never edited.
      changes.push({
        path: realPath,
        kind: before === null ? "added" : "modified",
        before,
        after,
      });
    }
    return changes;
  }

  async diff(): Promise<string> {
    const changes = await this.changes();
    return changes
      .map((change) =>
        formatOverlayDiff(relative(this.cwd, change.path), change.before, change.after),
      )
      .join("\n");
  }

  async apply(): Promise<OverlayApplyResult> {
    const changes = await this.changes();
    const applied: string[] = [];
    const errors: OverlayApplyError[] = [];
    for (const change of changes) {
      try {
        // The shadow path is workspace-relative, but the REAL destination may
        // leave the workspace through a symlink the agent created (bash is
        // unwrapped in dry-run). Resolving links before writing keeps /apply
        // from landing somewhere the reviewed diff never showed.
        if (!(await this.#insideWorkspace(change.path))) {
          errors.push({
            path: change.path,
            message: "resolves outside the workspace (symlink); refused",
          });
          continue;
        }
        await writeFileAtomic(change.path, Buffer.from(change.after, "utf8"));
        applied.push(change.path);
      } catch (error) {
        errors.push({ path: change.path, message: errorMessage(error) });
      }
    }
    return { applied, errors };
  }

  /**
   * Whether `target` really lives under the workspace once symlinks on its
   * existing ancestors are resolved.
   *
   * The file itself may not exist yet (an added file), so the deepest
   * existing ancestor is what gets checked.
   */
  async #insideWorkspace(target: string): Promise<boolean> {
    let root: string;
    try {
      root = await realpath(this.cwd);
    } catch {
      return false;
    }
    let probe = target;
    for (;;) {
      try {
        const real = await realpath(probe);
        return real === root || real.startsWith(root + sep);
      } catch {
        const parent = dirname(probe);
        // Reached the filesystem root without finding an existing ancestor.
        if (parent === probe) return false;
        probe = parent;
      }
    }
  }

  async discard(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * Create an {@link Overlay} rooted at `options.dir`, sheltering `options.cwd`.
 *
 * The shadow directory is created lazily on the first `materialize`/write, so
 * an overlay that is never written to leaves no trace on disk.
 *
 * @param options - Workspace root and shadow root; see {@link CreateOverlayOptions}.
 */
export function createOverlay(options: CreateOverlayOptions): Overlay {
  return new ShadowOverlay(options);
}

/** Tools whose `path` input is rewritten to the shadow copy. */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/** Tool whose `path` input is rewritten only when a shadow copy already exists. */
const READ_TOOL_NAME = "read";

/**
 * Wrap `write`, `edit` and `read` so they operate on the overlay's shadow copy
 * instead of the real workspace. Every other tool is returned unchanged (the
 * same object, not a copy).
 *
 * - `write`/`edit`: the target is {@link Overlay.materialize}d (so `edit` sees
 *   the real file's current text) and the tool's `path` input is rewritten to
 *   the shadow path. The real file is never opened for writing.
 * - `read`: the path is rewritten **only when a shadow copy exists**, so the
 *   agent sees its own pending edits, and falls through to the real file for
 *   everything it has not touched.
 *
 * Paths outside the overlay's `cwd` are not redirected (see
 * {@link Overlay.redirect}), so the input passes through untouched.
 *
 * A `materialize` failure does not un-redirect the write: falling back to the
 * real path would break the dry-run promise precisely when something is
 * already wrong. The tool then fails visibly (e.g. `edit` reporting "File not
 * found") instead of quietly mutating the workspace.
 *
 * `bash`, `grep` and `glob` are intentionally **not** wrapped — they take
 * commands and patterns rather than a single `path`, so a shell command still
 * reads and mutates the real tree. That is a documented boundary of dry-run
 * mode; see `INTEGRATION-overlay.md`.
 *
 * @param tools - Tools to (selectively) wrap.
 * @param overlay - Overlay the wrapped tools read and write through.
 */
export function wrapToolsWithOverlay(tools: readonly Tool[], overlay: Overlay): Tool[] {
  return tools.map((tool) => {
    const name = tool.definition.name;
    const isMutating = MUTATING_TOOL_NAMES.has(name);
    if (!isMutating && name !== READ_TOOL_NAME) return tool;

    // Spread first so extra tool surface (e.g. bindAgent) survives the wrap.
    return {
      ...tool,
      async execute(input: Record<string, unknown>, ctx: ToolExecutionContext) {
        const rawPath = input.path;
        if (typeof rawPath !== "string" || rawPath.length === 0) return tool.execute(input, ctx);

        let realPath: string;
        try {
          realPath = resolvePath(ctx.cwd, rawPath);
        } catch {
          return tool.execute(input, ctx);
        }
        const shadowPath = overlay.redirect(realPath);
        if (shadowPath === realPath) return tool.execute(input, ctx); // Not sheltered.

        if (isMutating) {
          try {
            await overlay.materialize(realPath);
          } catch {
            // See TSDoc: still redirect, so a failure cannot leak a write out
            // of the overlay and onto the real file.
          }
        } else if (!(await exists(shadowPath))) {
          return tool.execute(input, ctx); // Nothing pending: read the real file.
        }

        return tool.execute({ ...input, path: shadowPath }, ctx);
      },
    } satisfies Tool;
  });
}
