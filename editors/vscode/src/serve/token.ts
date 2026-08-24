/**
 * The shared secret the extension generates for its own `arcturn serve`.
 *
 * Mirrors `serve.ts`'s `generateServeToken` in intent — a random hex string —
 * with more entropy (32 bytes rather than 16), because this one is generated
 * by the client rather than the server and there is no reason to be stingy.
 *
 * The value never leaves this process except as an `--token` argument to the
 * child and an `authenticate` frame on a loopback socket. It is never written
 * to settings, `globalState`, a workspace file, or a log — see `redact.ts`.
 *
 * ### Known exposure
 *
 * Passing the token as `--token <secret>` puts it in the child's argument
 * vector, which any other process running as this user can read from `ps`.
 * The engine offers no other way to supply it today (`args.ts` reads `--token`
 * and nothing else — there is no `--token-fd`, no environment variable), and
 * the alternative of `--token ""` disables authentication entirely, which is
 * strictly worse. Recorded rather than papered over.
 */

import { randomBytes } from "node:crypto";

/** Bytes of entropy in a generated token. */
const TOKEN_BYTES = 32;

/**
 * Generate a fresh shared secret.
 *
 * @returns 64 hex characters of cryptographically strong randomness.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}
