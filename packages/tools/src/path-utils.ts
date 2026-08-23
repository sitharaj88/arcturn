/** Shared path resolution helpers used by every built-in tool. */

import { resolve } from "node:path";

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
