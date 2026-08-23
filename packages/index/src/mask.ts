/**
 * The masking pass: blank out comments and string literals before any
 * structural scanning happens.
 *
 * Every brace-counting or declaration-matching heuristic that skips this step
 * breaks on the first `"}"` inside a string or the first `// class Foo` in a
 * comment. Masking once, up front, turns a pile of fragile regexes into a set
 * of reliable ones: the scanner only ever looks at *code* characters, and the
 * per-line comment flags it produces are exactly what doc-comment extraction
 * needs anyway.
 *
 * Masking preserves line and column structure — every masked line has the same
 * length as its raw counterpart — so a position in the masked text is a
 * position in the real file.
 */

/** How one language spells its comments and string literals. */
export interface CommentSyntax {
  /**
   * Whether `/.../flags` is a regex literal in this language (JS/TS family).
   *
   * Without this, a delimiter *inside* a regex opens a phantom string: the
   * backtick in `/(?:\|\||`|;)/g` was read as a template literal and masked
   * the remaining 360 lines of `permissions.ts`, hiding `matchSpecifier`,
   * `matchRules` and `class PermissionEngine` from the index entirely.
   */
  regexLiterals?: boolean;
  /** Line-comment introducers, e.g. `["//"]` or `["#"]`. Longest first. */
  line: readonly string[];
  /** Block-comment delimiters: the opener and closer, as literal strings. */
  block?: readonly [string, string];
  /** Rust and Swift allow block comments to nest; C, Java and friends do not. */
  nestedBlock?: boolean;
  /**
   * String/char delimiters, **longest first** so `"""` wins over `"`. Each is
   * matched literally as an opening and closing sequence.
   */
  strings: readonly string[];
  /**
   * Delimiters whose strings may span lines (template literals, Python and
   * Java text blocks, Go raw strings). Anything not listed here is force-closed
   * at end of line, so one stray quote can never mask the rest of a file.
   */
  multiline?: readonly string[];
  /** Backslash escaping inside strings. True for nearly everything. */
  escapes?: boolean;
}

/** A source file split into lines, with a code-only mirror of each line. */
export interface MaskedSource {
  /** Raw lines, without their line terminators. */
  readonly lines: readonly string[];
  /**
   * Same lines with comment and string-literal characters replaced by spaces.
   * Same length per line as {@link lines}, so offsets line up.
   */
  readonly masked: readonly string[];
  /** True for lines that contain comment characters and no code. */
  readonly isComment: readonly boolean[];
  /** True for lines that are empty or whitespace-only. */
  readonly isBlank: readonly boolean[];
}

/** Split on any line terminator, keeping empty trailing lines out of the way. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Does `haystack` start with `needle` at `index`? Avoids substring allocation. */
function matchesAt(haystack: string, index: number, needle: string): boolean {
  if (needle.length === 0) return false;
  if (index + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[index + i] !== needle[i]) return false;
  }
  return true;
}

/** Find the first delimiter in `candidates` that occurs at `index`. */
function delimiterAt(line: string, index: number, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (matchesAt(line, index, candidate)) return candidate;
  }
  return null;
}

/**
 * Produce the code-only mirror of `text`.
 *
 * Never throws and never fails: unterminated constructs simply mask to end of
 * line (or, for multi-line ones, to end of file), which degrades a chunker's
 * recall on a broken file but never its liveness. That is the whole robustness
 * contract of this package in one function.
 */

/**
 * Whether a `/` at `column` can begin a regex literal rather than division.
 *
 * The standard disambiguation: a regex may start where a *value* may not have
 * just ended. Looking back at the already-masked output means comments and
 * strings have been blanked, so only real code characters are considered.
 */
function regexCanStartHere(out: readonly (string | undefined)[], column: number): boolean {
  for (let i = column - 1; i >= 0; i--) {
    const previous = out[i];
    if (previous === undefined || previous.trim().length === 0) continue;
    // After a value or a closer, `/` is division. After an operator, a comma,
    // an opening bracket or a keyword's `(`, it opens a regex.
    return !/[A-Za-z0-9_$)\]]/.test(previous);
  }
  return true;
}

/**
 * Find the end of a regex literal starting at `start`, or `start` when the
 * line holds no unescaped closing slash (in which case it was division).
 *
 * @returns The index just past the closing `/` and any flags.
 */
function scanRegexLiteral(line: string, start: number, escapes: boolean): number {
  let inClass = false;
  for (let i = start + 1; i < line.length; i++) {
    const char = line[i];
    if (escapes && char === "\\") {
      i++;
      continue;
    }
    // A `/` inside a character class is literal, not the terminator.
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = i + 1;
      while (end < line.length && /[dgimsuvy]/.test(line[end] ?? "")) end++;
      return end;
    }
  }
  return start;
}

export function maskSource(text: string, syntax: CommentSyntax): MaskedSource {
  const lines = splitLines(text);
  const masked: string[] = new Array(lines.length);
  const isComment: boolean[] = new Array(lines.length);
  const isBlank: boolean[] = new Array(lines.length);

  const escapes = syntax.escapes !== false;
  const multiline = syntax.multiline ?? [];

  let blockDepth = 0;
  /** The delimiter of an open multi-line string, or null. */
  let openString: string | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const out: string[] = new Array(line.length);
    let sawComment = blockDepth > 0;
    let sawCode = false;
    let column = 0;

    while (column < line.length) {
      const char = line[column] ?? " ";

      if (blockDepth > 0 && syntax.block) {
        const [open, close] = syntax.block;
        if (syntax.nestedBlock && matchesAt(line, column, open)) {
          blockDepth++;
          for (let i = 0; i < open.length; i++) out[column + i] = " ";
          column += open.length;
          continue;
        }
        if (matchesAt(line, column, close)) {
          blockDepth--;
          for (let i = 0; i < close.length; i++) out[column + i] = " ";
          column += close.length;
          continue;
        }
        out[column] = " ";
        sawComment = true;
        column++;
        continue;
      }

      if (openString !== null) {
        if (escapes && char === "\\") {
          out[column] = " ";
          if (column + 1 < line.length) out[column + 1] = " ";
          column += 2;
          continue;
        }
        if (matchesAt(line, column, openString)) {
          for (let i = 0; i < openString.length; i++) out[column + i] = " ";
          column += openString.length;
          openString = null;
          continue;
        }
        out[column] = " ";
        column++;
        continue;
      }

      const lineComment = delimiterAt(line, column, syntax.line);
      if (lineComment) {
        for (let i = column; i < line.length; i++) out[i] = " ";
        sawComment = true;
        column = line.length;
        continue;
      }

      if (syntax.block && matchesAt(line, column, syntax.block[0])) {
        blockDepth = 1;
        const open = syntax.block[0];
        for (let i = 0; i < open.length; i++) out[column + i] = " ";
        column += open.length;
        sawComment = true;
        continue;
      }

      if (syntax.regexLiterals && char === "/" && regexCanStartHere(out, column)) {
        const end = scanRegexLiteral(line, column, escapes);
        if (end > column) {
          // Blank the body but keep the slashes: the extent is what matters,
          // and a bare `//` here would read as a line comment on re-scan.
          out[column] = "/";
          for (let i = column + 1; i < end - 1; i++) out[i] = " ";
          out[end - 1] = "/";
          column = end;
          sawCode = true;
          continue;
        }
      }

      const stringDelim = delimiterAt(line, column, syntax.strings);
      if (stringDelim) {
        for (let i = 0; i < stringDelim.length; i++) out[column + i] = " ";
        column += stringDelim.length;
        // Scan the rest of this line for the close; only multi-line-capable
        // delimiters are allowed to leak into the next line.
        let closed = false;
        while (column < line.length) {
          const inner = line[column] ?? " ";
          if (escapes && inner === "\\") {
            out[column] = " ";
            if (column + 1 < line.length) out[column + 1] = " ";
            column += 2;
            continue;
          }
          if (matchesAt(line, column, stringDelim)) {
            for (let i = 0; i < stringDelim.length; i++) out[column + i] = " ";
            column += stringDelim.length;
            closed = true;
            break;
          }
          out[column] = " ";
          column++;
        }
        if (!closed && multiline.includes(stringDelim)) openString = stringDelim;
        sawCode = true;
        continue;
      }

      out[column] = char;
      if (char.trim().length > 0) sawCode = true;
      column++;
    }

    const maskedLine = out.join("");
    masked[lineIndex] = maskedLine;
    isBlank[lineIndex] = line.trim().length === 0;
    isComment[lineIndex] = sawComment && !sawCode && line.trim().length > 0;
  }

  return { lines, masked, isComment, isBlank };
}
