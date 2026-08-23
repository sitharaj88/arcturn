/** Identifier helpers used across the runtime. */

import { randomUUID } from "node:crypto";

/**
 * Generate a prefixed, collision-resistant identifier.
 *
 * @param prefix - Short namespace prefix, e.g. `"msg"` or `"perm"`.
 * @returns An identifier of the form `` `${prefix}_${uuid}` ``.
 */
export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Generate a session identifier that is safe to use as a file name.
 *
 * @returns A new random session id.
 */
export function createSessionId(): string {
  return randomUUID();
}
