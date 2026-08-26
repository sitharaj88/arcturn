/** Shared path resolution helpers used by every built-in tool. */

import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolve `path` against `cwd` and normalize it.
 *
 * Absolute paths keep their root but are still normalized, so `..` segments
 * cannot survive into a permission subject and escape a path-glob rule
 * (`/repo/src/**` must not match `/repo/src/../../etc/passwd`).
 */
export function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

/**
 * Rewrite `\` separators to `/`, but only where `\` actually *is* the
 * separator.
 *
 * The guard is not defensive padding: on POSIX a backslash is an ordinary,
 * legal character in a filename, so a file genuinely called `weird\name.ts`
 * must come back spelled the way it is on disk. On win32 `\` is never part of
 * a name, so rewriting every one of them is lossless.
 *
 * @param path - A path as `node:path` produced it.
 * @param separator - The platform separator; defaults to this platform's.
 *   Injected by tests so both branches are exercised from either OS.
 */
export function toPosixSeparators(path: string, separator: string = sep): string {
  return separator === "\\" ? path.split("\\").join("/") : path;
}

/**
 * How a tool spells a path back to the model: relative to `cwd` where it can
 * be, `/`-separated always.
 *
 * `/` rather than the platform separator, on purpose and on every platform:
 *
 * - The model hands the path straight back in the next tool call, inside a
 *   JSON string. `"src\new.ts"` is *valid* JSON whose value is `src`, a
 *   newline, `ew.ts` — so a Windows-shaped path from `grep` becomes a
 *   silently corrupted `read` argument, and the model has no way to see it
 *   happen. There is no such trap for `/`.
 * - Every consumer accepts it. Win32 APIs, and therefore `node:path` and
 *   `node:fs`, treat `/` and `\` interchangeably, so `src/new.ts` round-trips
 *   through `resolvePath` on Windows exactly as it does on POSIX.
 * - It is already the house convention for model- and user-facing paths
 *   elsewhere in the monorepo (`@arcturn/index`'s repo map and language
 *   detection, the CLI's team labels).
 *
 * Falls back to the absolute path when `relative` returns empty — the path
 * *is* `cwd` — or when the two share no root (separate drives on Windows),
 * where an absolute answer is the only correct one.
 *
 * @param cwd - The tool call's working directory.
 * @param path - An absolute path to render.
 */
export function displayPath(cwd: string, path: string): string {
  return toPosixSeparators(relative(cwd, path) || path);
}

/* ------------------------------------------------- permission subjects */

/**
 * How many symlink hops {@link canonicalizePath} will follow before giving up.
 * Matches the conventional `SYMLOOP_MAX`; a cycle is the only way to exceed it.
 */
const MAX_LINK_HOPS = 40;

/**
 * The path `path` *actually names on disk*, with every symlink in it resolved,
 * even when the path does not exist yet.
 *
 * `fs.realpath` alone cannot answer this: it throws `ENOENT` for a file about
 * to be created, and for a dangling symlink. So this walks the problem
 * instead — resolve what exists, follow a dangling link to its target and
 * retry, otherwise step up to the parent and carry the trailing segments
 * along — and reassembles the answer from the deepest resolvable ancestor.
 *
 * Falls back to the lexical path if nothing resolves (a nonexistent root, a
 * symlink cycle).
 */
async function canonicalizePath(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...[...tail].reverse());
    } catch {
      // `current` does not fully resolve; fall through and take it apart.
    }
    let target: string | undefined;
    try {
      if ((await lstat(current)).isSymbolicLink()) target = await readlink(current);
    } catch {
      // Not a symlink, or not there at all.
    }
    if (target !== undefined) {
      // A dangling symlink still decides where a write lands: follow it.
      current = resolve(dirname(current), target);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) break;
    tail.push(basename(current));
    current = parent;
  }
  return tail.length === 0 ? current : join(current, ...[...tail].reverse());
}

/**
 * The path a permission subject should name: where the tool call's bytes will
 * actually land, not where the argument's spelling suggests they will.
 *
 * `resolvePath` normalizes `..` away, which is why a traversal cannot dodge a
 * directory grant. A *symlink* is not normalized away by anything lexical: a
 * link at `<workspace>/escape` pointing at `/etc` makes `escape/passwd`
 * resolve to `<workspace>/escape/passwd` — a path that matches a
 * `<workspace>/**` allow rule — while `writeFile` follows the link and lands
 * in `/etc/passwd`. A rule-based confinement is only a wall if it cannot be
 * walked around by renaming the door, so the subject has to be the
 * destination.
 *
 * Canonicalizing unconditionally would break the *other* direction, though:
 * `os.tmpdir()` is `/var/folders/…` on macOS and `/var` is itself a symlink to
 * `/private/var`, so a rule a user wrote against the path their shell shows
 * them would stop matching a subject spelled `/private/var/…`. So exactly one
 * case is rewritten — the one that lies:
 *
 * - The path does not claim to be inside `cwd` in the first place: returned
 *   verbatim. Nothing is disguised, and a rule written against `/tmp/**` still
 *   matches on macOS.
 * - It claims to be inside `cwd` and really is: re-spelled under the caller's
 *   own spelling of `cwd`, which is byte-identical to `resolvePath`'s answer
 *   for any path with no symlink in it.
 * - It claims to be inside `cwd` and is not: reported canonically, so the
 *   escape is what the rules see.
 *
 * @param cwd - The tool call's working directory.
 * @param absolutePath - The already-resolved path the tool will operate on.
 */
export async function resolveSubjectPath(cwd: string, absolutePath: string): Promise<string> {
  if (!isUnder(cwd, absolutePath)) return absolutePath;
  const real = await canonicalizePath(absolutePath);
  if (real === absolutePath) return absolutePath;
  const realCwd = await canonicalizePath(cwd);
  if (isUnder(realCwd, real)) return join(cwd, relative(realCwd, real));
  return real;
}

/** Whether `path` is strictly under `root`, comparing spellings only. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
