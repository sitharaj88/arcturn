/**
 * Incremental line reassembly for a child process's stdout/stderr.
 *
 * A pipe delivers bytes, not lines: `arcturn serving on ws://…\n` can arrive
 * split across two `data` events or coalesced with the three lines after it.
 * This is the same problem `@arcturn/protocol`'s `FrameDecoder` solves for
 * NDJSON streams, minus the JSON — kept local so the extension does not take
 * a dependency on framing it does not need.
 *
 * A line that never terminates is dropped rather than buffered: a child that
 * writes megabytes without a newline must not be able to grow the extension
 * host's heap.
 */

/** Accumulates chunks and emits complete lines. */
export interface LineSplitter {
  /** Feed one chunk. `Buffer`/`Uint8Array` payloads are decoded as UTF-8. */
  push(chunk: unknown): void;
  /** Emit any buffered partial line (call when the stream ends). */
  flush(): void;
  /** Stop emitting and drop the buffer. Idempotent. */
  dispose(): void;
}

/** Buffer ceiling before a runaway line is abandoned. */
const DEFAULT_MAX_LINE_LENGTH = 8192;

const decoder = new TextDecoder("utf-8");

function decodeChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return decoder.decode(chunk);
  if (chunk instanceof ArrayBuffer) return decoder.decode(new Uint8Array(chunk));
  return String(chunk);
}

/**
 * Create a {@link LineSplitter}.
 *
 * @param onLine - Called once per complete line, without its line terminator.
 * @param options - `maxLineLength` caps the unterminated buffer (default 8192);
 *   once exceeded, the buffer is dropped and reading resumes at the next
 *   newline.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  options: { maxLineLength?: number } = {},
): LineSplitter {
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  let buffer = "";
  let overflowed = false;
  let disposed = false;

  const emit = (line: string): void => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  return {
    push(chunk: unknown): void {
      if (disposed) return;
      buffer += decodeChunk(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // A line that already overran the cap is incomplete by definition —
        // emitting its tail would hand the caller a truncated, misleading line.
        if (overflowed) overflowed = false;
        else emit(line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > maxLineLength) {
        buffer = "";
        overflowed = true;
      }
    },
    flush(): void {
      if (disposed || overflowed || buffer === "") return;
      const line = buffer;
      buffer = "";
      emit(line);
    },
    dispose(): void {
      disposed = true;
      buffer = "";
    },
  };
}
