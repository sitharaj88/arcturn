/** Shared binary-file sniffing, used by every tool that decodes a file as text. */

/** How many leading bytes {@link looksBinary} inspects. */
export const BINARY_SNIFF_BYTES = 8000;

/**
 * Heuristic binary-file detector: a NUL byte in the first few KB.
 *
 * Crude on purpose. It is the same test `file(1)` and `git diff` start from,
 * it costs one pass over a few KB, and it has no false positives on real text
 * — a NUL cannot appear in valid UTF-8, and the encodings where it can
 * (UTF-16/32) are not decodable as UTF-8 either, so refusing them is right for
 * the same reason.
 */
export function looksBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
