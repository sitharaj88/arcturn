/** Shared path resolution helpers used by every built-in tool. */

import { relative, resolve, sep } from "node:path";

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
