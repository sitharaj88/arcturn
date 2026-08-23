/**
 * Optional shared-token auth for {@link ArcturnServer} (`ws-server.ts`).
 *
 * `authenticate` is not a method in `@arcturn/types`' frozen `ClientRequest`
 * union, so it is handled as a pre-protocol frame: when a server `token` is
 * configured, a connection's very first frame must match
 * {@link AuthenticateFrame} shape and carry the right token, checked here
 * before any frame reaches `validateClientRequest`. See NOTES.md.
 */

import { timingSafeEqual } from "node:crypto";

/** Shape of the one frame accepted before authentication succeeds. */
export interface AuthenticateFrame {
  id: string;
  method: "authenticate";
  params: { token: string };
}

/** Narrow an unknown parsed JSON value to an {@link AuthenticateFrame}. */
export function isAuthenticateFrame(value: unknown): value is AuthenticateFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return false;
  if (record.method !== "authenticate") return false;
  const params = record.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
  return typeof (params as Record<string, unknown>).token === "string";
}

/**
 * Constant-time token comparison. Buffers of differing length compare
 * unequal without calling into `timingSafeEqual` (which requires equal
 * lengths); this still only leaks length, not content.
 */
export function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
