/**
 * NDJSON (newline-delimited JSON) framing for the Arcturn wire protocol.
 *
 * Every frame is one JSON value followed by a single U+000A LINE FEED ("\n").
 * Decoding deliberately treats **only** "\n" as a frame delimiter.
 *
 * A note on line terminators: ECMAScript's grammar recognizes four
 * `LineTerminator` code points — LF (U+000A), CR (U+000D), LINE SEPARATOR
 * (U+2028), and PARAGRAPH SEPARATOR (U+2029) — and some higher-level string
 * utilities (Node's `readline` interface, certain "split into lines" helpers)
 * mirror that set or go further and split on any Unicode "line break" class
 * character. NDJSON framing must NOT do that: U+2028/U+2029 are ordinary
 * *content* characters that can legally appear inside a JSON string, and
 * splitting on them would corrupt frames containing them. This module never
 * calls `String.prototype.split` with a multi-character-class pattern and
 * never uses `readline`; it scans for the literal `"\n"` code point via
 * `indexOf`, and separately strips a single trailing `"\r"` per line so
 * CRLF-framed input is tolerated without treating CR as a delimiter in its
 * own right.
 */

/**
 * Emitted by {@link FrameDecoder} in place of a throw when a line cannot be
 * decoded as a protocol frame. `@arcturn/types` has no equivalent type
 * (framing is entirely a `@arcturn/protocol` concern), so this is a local
 * type — see NOTES.md. It is tagged with `__kind` so consumers can
 * distinguish it from a successfully parsed JSON value at runtime, including
 * the (legal) case where the parsed value is itself `null` or a primitive.
 */
export interface ProtocolError {
  readonly __kind: "protocolError";
  /** Machine-readable reason. */
  readonly code: "malformedJson" | "lineTooLong";
  /** Human-readable diagnostic. */
  readonly message: string;
  /**
   * The offending line, truncated to a safe preview length for diagnostics.
   * Omitted for `lineTooLong` errors (the line is discarded, not retained).
   */
  readonly raw?: string;
}

/** Runtime check for {@link ProtocolError} values produced by this module. */
export function isProtocolError(value: unknown): value is ProtocolError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === "protocolError"
  );
}

/** Default cap on a single frame's encoded byte length (32 MiB). */
export const DEFAULT_MAX_LINE_LENGTH = 32 * 1024 * 1024;

/** Longest raw-line preview kept on a `malformedJson` {@link ProtocolError}. */
const RAW_PREVIEW_LENGTH = 200;

/**
 * Encode one value as a single NDJSON frame: `JSON.stringify(value) + "\n"`.
 */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export interface FrameDecoderOptions {
  /**
   * Maximum allowed byte length (UTF-8) of a single buffered, not-yet-terminated
   * line before it is treated as malformed and discarded. Defaults to
   * {@link DEFAULT_MAX_LINE_LENGTH}.
   */
  maxLineLength?: number;
}

/**
 * Incrementally reassembles NDJSON frames from a byte/text stream that may
 * split lines (and multi-byte UTF-8 sequences) arbitrarily across chunks.
 *
 * Usage: call {@link FrameDecoder.feed} once per chunk as it arrives; each
 * call returns the frames (parsed JSON values, or {@link ProtocolError}
 * values for malformed lines) that became complete as a result of that
 * chunk. Feed a `Uint8Array` (raw socket bytes) or a `string` (already
 * decoded text) interchangeably — a streaming `TextDecoder` is used
 * internally so multi-byte UTF-8 sequences split across `Uint8Array` chunk
 * boundaries are reassembled correctly before line-splitting occurs.
 */
export class FrameDecoder {
  private readonly maxLineLength: number;
  private readonly textDecoder = new TextDecoder("utf-8");
  /** Text received so far since the last complete line. */
  private partial = "";
  /** True while discarding input up to the next "\n" after an overlong line. */
  private resyncing = false;

  constructor(options: FrameDecoderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /**
   * Feed the next chunk of input. Returns zero or more frames that completed
   * as a result of this chunk, in order. Never throws: malformed lines
   * surface as {@link ProtocolError} values in the returned array so the
   * stream can keep going.
   */
  feed(chunk: string | Uint8Array): unknown[] {
    const text =
      typeof chunk === "string" ? chunk : this.textDecoder.decode(chunk, { stream: true });
    const combined = this.partial + text;
    const frames: unknown[] = [];

    let start = 0;
    for (;;) {
      const newlineIndex = combined.indexOf("\n", start);
      if (newlineIndex === -1) break;

      const rawLine = combined.slice(start, newlineIndex);
      start = newlineIndex + 1;

      if (this.resyncing) {
        // This line is the tail of a frame we already gave up on; discard it
        // and resume normal processing from the next line.
        this.resyncing = false;
        continue;
      }

      // The line's terminator arrived (possibly only just now), so its full
      // length is known even if part of it was buffered from an earlier
      // feed() call — check it here, not only on the still-unterminated
      // trailing partial below.
      if (byteLength(rawLine) > this.maxLineLength) {
        frames.push(makeLineTooLongError(this.maxLineLength));
        continue;
      }

      const frame = this.decodeLine(rawLine);
      if (frame !== undefined) frames.push(frame);
    }

    const rest = combined.slice(start);
    if (this.resyncing) {
      // Still haven't found the newline that ends the overlong frame:
      // keep discarding rather than buffering unbounded garbage.
      this.partial = "";
    } else if (byteLength(rest) > this.maxLineLength) {
      frames.push(makeLineTooLongError(this.maxLineLength));
      this.partial = "";
      this.resyncing = true;
    } else {
      this.partial = rest;
    }

    return frames;
  }

  /**
   * Decode a single already-delimited line (delimiter stripped) into a frame,
   * or `undefined` if the line should be skipped (blank, or CRLF's bare "\r").
   */
  private decodeLine(rawLine: string): unknown {
    // Tolerate CRLF framing: strip exactly one trailing "\r".
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return undefined; // skip blank lines

    try {
      return JSON.parse(line);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return {
        __kind: "protocolError",
        code: "malformedJson",
        message: `Malformed JSON frame: ${reason}`,
        raw: preview(line),
      } satisfies ProtocolError;
    }
  }
}

function makeLineTooLongError(maxLineLength: number): ProtocolError {
  return {
    __kind: "protocolError",
    code: "lineTooLong",
    message: `Frame exceeded max line length of ${maxLineLength} bytes; discarding until next newline`,
  };
}

function preview(line: string): string {
  return line.length > RAW_PREVIEW_LENGTH ? `${line.slice(0, RAW_PREVIEW_LENGTH)}…` : line;
}

/** UTF-8 byte length of a string, without allocating the encoded bytes. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
