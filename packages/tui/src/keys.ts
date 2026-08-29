/**
 * Terminal key decoding: raw stdin bytes → structured {@link Key} events.
 *
 * The decoder is a small incremental state machine, so escape sequences that arrive
 * split across several `data` chunks (very common over SSH and on slow ptys) are
 * buffered until they are complete. Bracketed paste is surfaced as a single
 * `paste` event carrying the full pasted text.
 *
 * @packageDocumentation
 */

import { CSI, ESC, PASTE_END, PASTE_START } from "./ansi.js";

/**
 * Canonical names produced by the decoder for non-printable keys.
 *
 * Printable keys use the character itself as the name (`"a"`, `"$"`, `"あ"`).
 */
export type SpecialKeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "insert"
  | "delete"
  | "backspace"
  | "tab"
  | "enter"
  | "escape"
  | "space"
  | "clear"
  | "paste"
  | "wheelup"
  | "wheeldown"
  | "mousedown"
  | "mouseup"
  | "unknown"
  | `f${number}`;

/** A decoded key press. */
export interface Key {
  /** Key name: a {@link SpecialKeyName} or the printable character itself. */
  readonly name: string;
  /** `true` when Control was held. */
  readonly ctrl: boolean;
  /** `true` when Alt/Meta (ESC prefix) was held. */
  readonly alt: boolean;
  /** `true` when Shift was held. */
  readonly shift: boolean;
  /** `true` when Super/Command was reported (Kitty protocol only). */
  readonly meta: boolean;
  /** The raw bytes that produced this event. */
  readonly sequence: string;
  /** Text to insert for printable keys; `undefined` for control keys. */
  readonly text?: string;
  /** Full pasted content when {@link Key.name} is `"paste"`. */
  readonly paste?: string;
  /**
   * 1-based cell coordinates when {@link Key.name} is `"mousedown"` or
   * `"mouseup"`. Present so a host can tell a click from a drag — the gap
   * between where the button went down and where it came up — without the
   * TUI growing a mouse vocabulary of its own.
   */
  readonly mouse?: { readonly x: number; readonly y: number };
}

interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const NO_MODS: Mods = { ctrl: false, alt: false, shift: false, meta: false };

function makeKey(
  name: string,
  sequence: string,
  mods: Partial<Mods> = {},
  extra: { text?: string; paste?: string } = {},
): Key {
  return {
    name,
    ctrl: mods.ctrl ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
    meta: mods.meta ?? false,
    sequence,
    ...(extra.text !== undefined ? { text: extra.text } : {}),
    ...(extra.paste !== undefined ? { paste: extra.paste } : {}),
  };
}

/** Decodes an xterm modifier parameter (1-based bitmask) into flags. */
function decodeModifier(param: number | undefined): Mods {
  if (param === undefined || param <= 1) return { ...NO_MODS };
  const bits = param - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    meta: (bits & 8) !== 0,
  };
}

/** `CSI <code> ~` key codes. */
const TILDE_CODES: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
  25: "f13",
  26: "f14",
  28: "f15",
  29: "f16",
  31: "f17",
  32: "f18",
  33: "f19",
  34: "f20",
};

/** Final bytes of `CSI [1;<mod>] <final>` sequences. */
const FINAL_CODES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

/** Legacy rxvt shift-arrow finals (`CSI a` … `CSI e`). */
const LOWER_FINAL_CODES: Record<string, string> = {
  a: "up",
  b: "down",
  c: "right",
  d: "left",
  e: "clear",
};

/** Kitty keypad / functional code points mapped to canonical names. */
const KITTY_FUNCTIONAL: Record<number, string> = {
  57414: "enter",
  57417: "left",
  57418: "right",
  57419: "up",
  57420: "down",
  57421: "pageup",
  57422: "pagedown",
  57423: "home",
  57424: "end",
  57425: "insert",
  57426: "delete",
};

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Returns the first grapheme cluster of `input` (surrogate-pair safe). */
function firstGrapheme(input: string): string {
  if (segmenter) {
    for (const { segment } of segmenter.segment(input)) return segment;
    return input.slice(0, 1);
  }
  const cp = input.codePointAt(0);
  return cp === undefined ? input.slice(0, 1) : String.fromCodePoint(cp);
}

/** Result of one decode step: `null` means "need more input". */
type Step = { key?: Key; consumed: number } | null;

/**
 * Incremental decoder turning raw terminal input into {@link Key} events.
 *
 * Feed every stdin chunk to {@link KeyDecoder.push}. Incomplete escape sequences are
 * retained until the rest arrives; call {@link KeyDecoder.flush} when the terminal
 * has gone quiet to resolve a lone `ESC` into an `escape` key press.
 *
 * @example
 * ```ts
 * const decoder = new KeyDecoder();
 * decoder.push("\u001b[");   // []            – incomplete
 * decoder.push("A");         // [{name:"up"}] – completed
 * ```
 */
export class KeyDecoder {
  private buffer = "";

  /** Input received so far that does not yet form a complete sequence. */
  get pending(): string {
    return this.buffer;
  }

  /** Discards any buffered partial sequence. */
  reset(): void {
    this.buffer = "";
  }

  /**
   * Feeds a chunk of raw terminal input into the decoder.
   *
   * @param chunk - Bytes decoded as a UTF-8 string.
   * @returns Every complete key event contained in the chunk.
   */
  push(chunk: string): Key[] {
    this.buffer += chunk;
    return this.drain();
  }

  /**
   * Resolves whatever is still buffered.
   *
   * A dangling `ESC` becomes an `escape` key press; anything else that cannot be
   * parsed is emitted as an `unknown` key so input is never silently swallowed.
   */
  flush(): Key[] {
    const keys: Key[] = [];
    while (this.buffer.length > 0) {
      const before = this.buffer;
      keys.push(...this.drain());
      if (this.buffer.length === 0) break;
      if (this.buffer === before) {
        // An incomplete SGR mouse report has no meaningful literal reading — drop
        // it rather than degrade into escape + garbage text.
        if (this.buffer.startsWith(`${CSI}<`) && /^[0-9;]*$/.test(this.buffer.slice(3))) {
          this.buffer = "";
          break;
        }
        // Still stuck: consume the leading ESC as a literal escape key press.
        if (this.buffer.startsWith(ESC)) {
          keys.push(makeKey("escape", ESC));
          this.buffer = this.buffer.slice(1);
        } else {
          keys.push(makeKey("unknown", this.buffer));
          this.buffer = "";
        }
      }
    }
    return keys;
  }

  private drain(): Key[] {
    const keys: Key[] = [];
    while (this.buffer.length > 0) {
      const step = this.step(this.buffer);
      if (step === null) break;
      if (step.consumed <= 0) break;
      this.buffer = this.buffer.slice(step.consumed);
      if (step.key) keys.push(step.key);
    }
    return keys;
  }

  private step(buf: string): Step {
    // Bracketed paste: buffer until the terminating marker arrives.
    if (buf.startsWith(PASTE_START)) {
      const end = buf.indexOf(PASTE_END, PASTE_START.length);
      if (end === -1) return null;
      const content = buf.slice(PASTE_START.length, end);
      const consumed = end + PASTE_END.length;
      return {
        key: makeKey("paste", buf.slice(0, consumed), {}, { paste: content }),
        consumed,
      };
    }
    if (PASTE_START.startsWith(buf)) return null;

    const first = buf[0]!;
    if (first !== ESC) return decodeChar(buf);

    if (buf.length === 1) return null; // lone ESC — wait for more or flush()

    const second = buf[1]!;
    if (second === "[") return decodeCsi(buf);
    if (second === "O") return decodeSs3(buf);

    if (second === ESC) {
      // ESC ESC: either alt+escape, or a real escape followed by a sequence.
      if (buf.length === 2) return null;
      const third = buf[2]!;
      if (third === "[" || third === "O") return { key: makeKey("escape", ESC), consumed: 1 };
      return { key: makeKey("escape", buf.slice(0, 2), { alt: true }), consumed: 2 };
    }

    // ESC + char → alt-modified key.
    const inner = decodeChar(buf.slice(1));
    if (inner === null) return null;
    const key = inner.key;
    if (!key) return { consumed: inner.consumed + 1 };
    const seq = buf.slice(0, inner.consumed + 1);
    return {
      key: makeKey(
        key.name,
        seq,
        { ctrl: key.ctrl, alt: true, shift: key.shift, meta: key.meta },
        key.text !== undefined ? { text: key.text } : {},
      ),
      consumed: inner.consumed + 1,
    };
  }
}

/** Decodes a single non-escape character (or grapheme cluster). */
function decodeChar(buf: string): Step {
  const ch = buf[0]!;
  const code = ch.charCodeAt(0);

  switch (ch) {
    case "\r":
      return { key: makeKey("enter", ch), consumed: 1 };
    case "\n":
      return { key: makeKey("enter", ch), consumed: 1 };
    case "\t":
      return { key: makeKey("tab", ch), consumed: 1 };
    case "\u007f":
      return { key: makeKey("backspace", ch), consumed: 1 };
    case "\b":
      return { key: makeKey("backspace", ch, { ctrl: true }), consumed: 1 };
    case ESC:
      return { key: makeKey("escape", ch), consumed: 1 };
    case " ":
      return { key: makeKey("space", ch, {}, { text: " " }), consumed: 1 };
    default:
      break;
  }

  if (code === 0) return { key: makeKey("space", ch, { ctrl: true }), consumed: 1 };
  if (code >= 1 && code <= 26) {
    return {
      key: makeKey(String.fromCharCode(code + 96), ch, { ctrl: true }),
      consumed: 1,
    };
  }
  if (code >= 28 && code <= 31) {
    const names = ["\\", "]", "^", "_"];
    return { key: makeKey(names[code - 28]!, ch, { ctrl: true }), consumed: 1 };
  }

  const grapheme = firstGrapheme(buf);
  const shift = /^\p{Lu}$/u.test(grapheme);
  return {
    key: makeKey(grapheme, grapheme, { shift }, { text: grapheme }),
    consumed: grapheme.length,
  };
}

/** Decodes an SS3 sequence (`ESC O <final>`). */
function decodeSs3(buf: string): Step {
  if (buf.length < 3) return null;
  const final = buf[2]!;
  const seq = buf.slice(0, 3);
  const lower = LOWER_FINAL_CODES[final];
  if (lower) return { key: makeKey(lower, seq, { ctrl: true }), consumed: 3 };
  const name = FINAL_CODES[final];
  if (name) return { key: makeKey(name, seq), consumed: 3 };
  if (final === "M") return { key: makeKey("enter", seq), consumed: 3 };
  return { key: makeKey("unknown", seq), consumed: 3 };
}

/** Decodes a CSI sequence (`ESC [ <params> <intermediates> <final>`). */
function decodeCsi(buf: string): Step {
  let i = 2;
  while (i < buf.length && /[0-9;:<=>?]/.test(buf[i]!)) i++;
  const paramEnd = i;
  while (i < buf.length && buf.charCodeAt(i) >= 0x20 && buf.charCodeAt(i) <= 0x2f) i++;
  if (i >= buf.length) return null;
  const final = buf[i]!;
  const codeAt = buf.charCodeAt(i);
  if (codeAt < 0x40 || codeAt > 0x7e) return null;

  const consumed = i + 1;
  const seq = buf.slice(0, consumed);
  const paramText = buf.slice(2, paramEnd);

  // SGR mouse reports: wheel motion becomes a synthetic key; everything else
  // is consumed so clicks and drags never leak into the editor as text.
  if (paramText.startsWith("<")) return decodeSgrMouse(paramText, final, seq, consumed);

  const parts = paramText.split(";");
  const nums = parts.map((p) => {
    const head = p.split(":")[0] ?? "";
    return head === "" ? undefined : Number.parseInt(head, 10);
  });

  if (final === "Z") return { key: makeKey("tab", seq, { shift: true }), consumed };

  if (final === "u") {
    // Kitty keyboard protocol: CSI <codepoint>[;<mod>] u
    const cp = nums[0];
    if (cp === undefined) return { key: makeKey("unknown", seq), consumed };
    return { key: kittyKey(cp, decodeModifier(nums[1]), seq), consumed };
  }

  if (final === "~") {
    const code = nums[0];
    if (code === undefined) return { key: makeKey("unknown", seq), consumed };
    if (code === 27) {
      // xterm modifyOtherKeys: CSI 27 ; <mod> ; <codepoint> ~
      const cp = nums[2];
      if (cp !== undefined) return { key: kittyKey(cp, decodeModifier(nums[1]), seq), consumed };
    }
    const name = TILDE_CODES[code];
    if (!name) return { key: makeKey("unknown", seq), consumed };
    return { key: makeKey(name, seq, decodeModifier(nums[1])), consumed };
  }

  const lower = LOWER_FINAL_CODES[final];
  if (lower) return { key: makeKey(lower, seq, { shift: true }), consumed };

  const name = FINAL_CODES[final];
  if (name) {
    // `CSI 1;<mod> <final>` — the leading 1 is a placeholder for the key code.
    return { key: makeKey(name, seq, decodeModifier(nums[1])), consumed };
  }

  return { key: makeKey("unknown", seq), consumed };
}

/** SGR mouse button codes for wheel motion, after masking with {@link SGR_BUTTON_MASK}. */
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;

/**
 * Keeps the wheel flag (64) and the low button bits while dropping the
 * shift/meta/ctrl modifier bits (4/8/16) and the motion bit (32), so
 * modifier-adorned wheel codes such as 68 (shift+wheel-up) still match.
 */
const SGR_BUTTON_MASK = 0x43;

/**
 * Decodes an SGR mouse report (`CSI < Cb ; Cx ; Cy M` press/motion, `… m` release).
 *
 * Wheel motion surfaces as a `wheelup` / `wheeldown` key with no modifiers,
 * and the left button surfaces as `mousedown` / `mouseup` carrying its cell —
 * that pair is how a host notices a drag it should hand back to the terminal.
 * Everything else (other buttons, motion) is consumed without emitting a key
 * so it never reaches the editor as garbage text.
 */
function decodeSgrMouse(paramText: string, final: string, seq: string, consumed: number): Step {
  if (final !== "M" && final !== "m") return { consumed };
  const parts = paramText.slice(1).split(";");
  const cb = Number.parseInt(parts[0] ?? "", 10);
  if (Number.isNaN(cb)) return { consumed };
  const button = cb & SGR_BUTTON_MASK;
  // Bit 32 marks motion, and the mask drops it — so a left-drag motion report
  // (code 32) would read as button 0. Motion is never a press or a release.
  const isLeftButton = button === 0 && (cb & 32) === 0;
  if (final === "m") {
    if (isLeftButton) {
      const mouse = sgrCell(parts);
      if (mouse) return { key: { ...makeKey("mouseup", seq), mouse }, consumed };
    }
    return { consumed };
  }
  if (button === SGR_WHEEL_UP) return { key: makeKey("wheelup", seq), consumed };
  if (button === SGR_WHEEL_DOWN) return { key: makeKey("wheeldown", seq), consumed };
  if (isLeftButton) {
    const mouse = sgrCell(parts);
    if (mouse) return { key: { ...makeKey("mousedown", seq), mouse }, consumed };
  }
  return { consumed };
}

/** Reads the 1-based `Cx ; Cy` cell out of an SGR mouse report's parameters. */
function sgrCell(parts: readonly string[]): { x: number; y: number } | undefined {
  const x = Number.parseInt(parts[1] ?? "", 10);
  const y = Number.parseInt(parts[2] ?? "", 10);
  if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
  return { x, y };
}

/** Builds a key from a Unicode code point plus modifier flags. */
function kittyKey(codePoint: number, mods: Mods, seq: string): Key {
  const functional = KITTY_FUNCTIONAL[codePoint];
  if (functional) return makeKey(functional, seq, mods);

  switch (codePoint) {
    case 27:
      return makeKey("escape", seq, mods);
    case 13:
      return makeKey("enter", seq, mods);
    case 9:
      return makeKey(mods.shift ? "tab" : "tab", seq, mods);
    case 127:
      return makeKey("backspace", seq, mods);
    case 32:
      return makeKey("space", seq, mods, mods.ctrl || mods.alt ? {} : { text: " " });
    default:
      break;
  }

  if (codePoint < 32) return makeKey("unknown", seq, mods);
  const char = String.fromCodePoint(codePoint);
  const name = char.toLowerCase();
  const printable = !mods.ctrl && !mods.alt && !mods.meta;
  return makeKey(
    name,
    seq,
    mods,
    printable ? { text: mods.shift ? char.toUpperCase() : char } : {},
  );
}

/* -------------------------------------------------------------------------- */
/* Matching helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Renders a key as a canonical binding string such as `"ctrl+shift+a"`.
 *
 * Modifier order is always `ctrl`, `alt`, `shift`, `meta`.
 *
 * @param key - Key to format.
 */
export function keyToString(key: Key): string {
  const parts: string[] = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.alt) parts.push("alt");
  if (key.shift) parts.push("shift");
  if (key.meta) parts.push("meta");
  parts.push(key.name);
  return parts.join("+");
}

/**
 * Tests a key against a binding string such as `"ctrl+c"` or `"shift+tab"`.
 *
 * Modifiers may appear in any order; `cmd`/`super` are accepted as aliases of
 * `meta`, and `option` as an alias of `alt`.
 *
 * @param key - The decoded key.
 * @param binding - Binding description.
 *
 * @example
 * ```ts
 * matchesKey(key, "ctrl+c");
 * matchesKey(key, "alt+enter");
 * ```
 */
export function matchesKey(key: Key, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const part of parts) {
    if (part === "ctrl" || part === "control") ctrl = true;
    else if (part === "alt" || part === "option") alt = true;
    else if (part === "shift") shift = true;
    else if (part === "meta" || part === "cmd" || part === "super") meta = true;
    else return false;
  }
  return (
    key.name.toLowerCase() === name &&
    key.ctrl === ctrl &&
    key.alt === alt &&
    key.shift === shift &&
    key.meta === meta
  );
}

/**
 * `true` when the key inserts literal text (a printable character or a paste).
 *
 * @param key - Key to inspect.
 */
export function isPrintable(key: Key): boolean {
  return key.text !== undefined && key.text.length > 0;
}

/**
 * Convenience factory used by tests and by programmatic input injection.
 *
 * @param name - Key name.
 * @param mods - Modifier flags.
 */
export function createKey(name: string, mods: Partial<Mods> & { text?: string } = {}): Key {
  const { text, ...flags } = mods;
  const inferred = text ?? (name.length === 1 && !flags.ctrl && !flags.alt ? name : undefined);
  return makeKey(name, text ?? name, flags, inferred !== undefined ? { text: inferred } : {});
}

/** The escape sequence prefix used to introduce CSI keys — re-exported for convenience. */
export { CSI };
