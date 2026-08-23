/**
 * Inline terminal images.
 *
 * Renders raster images (screenshots the agent reads, diagrams it generates) directly
 * in the transcript using two competing wire protocols:
 *
 * - the **kitty graphics protocol** — an APC (`ESC _G ... ESC \`) escape sequence,
 *   documented at https://sw.kovidgoyal.net/kitty/graphics-protocol/. Supported by
 *   kitty itself and by several terminals that emulate it (e.g. Ghostty, WezTerm).
 * - the **iTerm2 inline images protocol** — an OSC 1337 (`ESC ] 1337 ; File=... BEL`)
 *   escape sequence, documented at https://iterm2.com/documentation-images.html.
 *   Supported by iTerm2 and by WezTerm's iTerm2-compatibility layer.
 *
 * Every terminal that supports neither gets a plain-text placeholder instead — this
 * module never assumes a capable terminal and always returns something printable.
 *
 * Mirrors the environment-sniffing style of {@link "./ansi.js".detectColorLevel} and
 * `@arcturn/cli`'s `resolveGlyphs`: a pure function over an injectable `env` record,
 * defaulting to `process.env`, plus a `ARCTURN_*` opt-out.
 *
 * @packageDocumentation
 */

import { BEL, ESC } from "./ansi.js";
import { stringWidth } from "./width.js";

/** Image rendering capability of the terminal. */
export type ImageSupport = "kitty" | "iterm" | "none";

/** Environment variables consulted by {@link detectImageSupport}. */
export interface ImageDetectionEnv {
  /** `TERM`, e.g. `xterm-kitty`. */
  TERM?: string | undefined;
  /** Set by kitty itself, even when `TERM` has been overridden by multiplexers. */
  KITTY_WINDOW_ID?: string | undefined;
  /** `TERM_PROGRAM`, set by iTerm2, WezTerm, Apple Terminal, VS Code, … */
  TERM_PROGRAM?: string | undefined;
  /** Opt-out escape hatch: any non-empty value forces `"none"`, mirroring `ARCTURN_ASCII`. */
  ARCTURN_NO_IMAGES?: string | undefined;
  /** Allow other keys without widening the type surface. */
  [key: string]: string | undefined;
}

/**
 * Detects which inline-image protocol, if any, the terminal is likely to support.
 *
 * Honours `ARCTURN_NO_IMAGES` as an unconditional opt-out (checked first, same shape as
 * `ARCTURN_ASCII` in `@arcturn/cli`'s glyph detection). Otherwise:
 *
 * - `"kitty"` when `TERM` contains `kitty` (case-insensitive, e.g. `xterm-kitty`) or
 *   `KITTY_WINDOW_ID` is set.
 * - `"iterm"` when `TERM_PROGRAM` is `iTerm.app` or `WezTerm` (WezTerm implements
 *   iTerm2's inline-image protocol rather than kitty's).
 * - `"none"` otherwise.
 *
 * @param env - Environment to inspect (defaults to `process.env`).
 *
 * @example
 * ```ts
 * detectImageSupport({ TERM: "xterm-kitty" });               // "kitty"
 * detectImageSupport({ TERM_PROGRAM: "iTerm.app" });          // "iterm"
 * detectImageSupport({ TERM_PROGRAM: "iTerm.app", ARCTURN_NO_IMAGES: "1" }); // "none"
 * ```
 */
export function detectImageSupport(env: ImageDetectionEnv = process.env): ImageSupport {
  if (env.ARCTURN_NO_IMAGES !== undefined && env.ARCTURN_NO_IMAGES !== "") return "none";

  const term = (env.TERM ?? "").toLowerCase();
  const kittyWindow = env.KITTY_WINDOW_ID;
  if (term.includes("kitty") || (kittyWindow !== undefined && kittyWindow !== "")) {
    return "kitty";
  }

  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm") return "iterm";

  return "none";
}

/** Maximum size, in bytes of base64 text, of a single kitty graphics-protocol chunk. */
const KITTY_CHUNK_SIZE = 4096;

/** Options accepted by {@link encodeKittyImage}. */
export interface KittyImageOptions {
  /**
   * Image id, used by kitty to reference or replace this image later (control key
   * `i`). Omit to let the terminal assign one implicitly.
   */
  readonly id?: number;
  /** Width to render at, in terminal cells (control key `c`). */
  readonly columns?: number;
  /** Height to render at, in terminal cells (control key `r`). */
  readonly rows?: number;
  /**
   * Kitty image-format code (control key `f`). Defaults to `100`, meaning the
   * payload is raw PNG data — the only format this module produces.
   */
  readonly format?: number;
}

/** Splits `text` into chunks of at most `size` characters (always at least one chunk). */
function chunkString(text: string, size: number): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/**
 * Encodes a PNG buffer as a kitty graphics-protocol "transmit and display" escape
 * sequence.
 *
 * Per the protocol (https://sw.kovidgoyal.net/kitty/graphics-protocol/#chunked-data),
 * the base64 payload is split into chunks of at most 4096 bytes, each wrapped in its
 * own `ESC _G ... ESC \` APC sequence. Every chunk but the last sets the continuation
 * flag `m=1`; the last sets `m=0`. Only the first chunk carries the transmission
 * control data (`a=T` transmit-and-display, `f=<format>`, plus `i=`/`c=`/`r=` when
 * given) — kitty ignores those keys on continuation chunks.
 *
 * @param data - Raw PNG bytes.
 * @param options - See {@link KittyImageOptions}.
 * @returns One or more concatenated, individually-terminated APC sequences. Never
 * unterminated, even for an empty buffer.
 */
export function encodeKittyImage(data: Buffer, options: KittyImageOptions = {}): string {
  const base64 = data.toString("base64");
  const chunks = chunkString(base64, KITTY_CHUNK_SIZE);

  const controlKeys: string[] = ["a=T", `f=${options.format ?? 100}`];
  if (options.id !== undefined) controlKeys.push(`i=${options.id}`);
  if (options.columns !== undefined) controlKeys.push(`c=${options.columns}`);
  if (options.rows !== undefined) controlKeys.push(`r=${options.rows}`);

  let out = "";
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const params = i === 0 ? [...controlKeys, `m=${isLast ? 0 : 1}`] : [`m=${isLast ? 0 : 1}`];
    out += `${ESC}_G${params.join(",")};${chunks[i] ?? ""}${ESC}\\`;
  }
  return out;
}

/** Options accepted by {@link encodeItermImage}. */
export interface ItermImageOptions {
  /** File name, shown by terminals that display it (sent base64-encoded, per spec). */
  readonly name?: string;
  /** Rendered width: a cell count, `"<n>px"`, `"<n>%"`, or `"auto"`. */
  readonly width?: number | string;
  /** Rendered height: a cell count, `"<n>px"`, `"<n>%"`, or `"auto"`. */
  readonly height?: number | string;
  /** Whether to preserve aspect ratio when both dimensions are given (default `true`). */
  readonly preserveAspectRatio?: boolean;
}

/**
 * Encodes an image buffer as an iTerm2 inline-image OSC 1337 escape sequence
 * (https://iterm2.com/documentation-images.html).
 *
 * Produces `ESC ] 1337 ; File=inline=1;size=<N>[;...] : <base64> BEL`. `inline=1` is
 * required for the image to render in place rather than being offered as a download;
 * `size` is the byte length of the *undecoded* image data, as the spec requires.
 *
 * @param data - Raw image bytes (PNG, JPEG, GIF, …; iTerm2 sniffs the format).
 * @param options - See {@link ItermImageOptions}.
 * @returns A single BEL-terminated OSC sequence. Never unterminated, even for an
 * empty buffer.
 */
export function encodeItermImage(data: Buffer, options: ItermImageOptions = {}): string {
  const base64 = data.toString("base64");
  const params: string[] = ["inline=1", `size=${data.length}`];
  if (options.name !== undefined) {
    params.push(`name=${Buffer.from(options.name, "utf8").toString("base64")}`);
  }
  if (options.width !== undefined) params.push(`width=${options.width}`);
  if (options.height !== undefined) params.push(`height=${options.height}`);
  if (options.preserveAspectRatio === false) params.push("preserveAspectRatio=0");

  return `${ESC}]1337;File=${params.join(";")}:${base64}${BEL}`;
}

/** Formats a byte count the way {@link renderImage}'s fallback placeholder wants it. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}

/** Options for {@link renderImage}. */
export interface RenderImageOptions {
  /** The terminal's detected capability, from {@link detectImageSupport}. */
  readonly support: ImageSupport;
  /**
   * Human-readable label used both as the iTerm `name=` field and in the text
   * fallback, e.g. a file name or short description.
   */
  readonly altText: string;
  /** Cap the rendered image height to this many terminal rows, when supported. */
  readonly maxRows?: number;
  /** Kitty image id, forwarded to {@link encodeKittyImage} (ignored otherwise). */
  readonly id?: number;
}

/**
 * Renders an image for the terminal transcript.
 *
 * Returns the appropriate escape sequence for a capable terminal (`support` is
 * `"kitty"` or `"iterm"`), or a plain-text placeholder like `[image: diagram.png
 * 24KB]` otherwise. Always returns a printable, fully-terminated string — never an
 * unterminated escape sequence, and never throws on an empty buffer.
 *
 * @param data - Raw image bytes.
 * @param options - See {@link RenderImageOptions}.
 *
 * @example
 * ```ts
 * renderImage(png, { support: detectImageSupport(), altText: "diagram.png" });
 * ```
 */
export function renderImage(data: Buffer, options: RenderImageOptions): string {
  const { support, altText, maxRows, id } = options;

  if (support === "kitty") {
    return encodeKittyImage(data, { id, rows: maxRows });
  }
  if (support === "iterm") {
    return encodeItermImage(data, { name: altText, height: maxRows });
  }
  return `[image: ${altText} ${formatBytes(data.length)}]`;
}

/**
 * Builds placeholder lines that reserve `rows` rows of vertical space for an image
 * that will be printed separately (see the module-level scrollback note below).
 *
 * Every line is padded to the same {@link stringWidth} so a caller relying on the
 * lines for layout — e.g. computing a bounding box for arcturn's differential
 * renderer — sees a uniform, correctly-measured width rather than a ragged one.
 *
 * **This placeholder is layout bookkeeping only.** The image escape sequence itself
 * must be written to scrollback via the app's `Terminal.write()` path *before* the
 * live re-rendered region is drawn — never inside a component the differential
 * renderer redraws, or the next frame's diffing will overwrite/corrupt the pixels.
 * See `INTEGRATION-images.md` for the full explanation.
 *
 * @param rows - Number of rows to reserve (coerced to an integer, minimum `1`).
 * @param label - Text shown on the first reserved line, e.g. `"diagram.png"`.
 * @returns Exactly `max(1, floor(rows))` strings, each of equal display width.
 */
export function imagePlaceholderLines(rows: number, label: string): string[] {
  const count = Math.max(1, Math.trunc(rows));
  const text = `[image: ${label}]`;
  const width = stringWidth(text);
  const blank = " ".repeat(width);

  const lines: string[] = [text];
  for (let i = 1; i < count; i++) lines.push(blank);
  return lines;
}
