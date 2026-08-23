/**
 * A dependency-free `.gitignore` matcher.
 *
 * Hand-rolled rather than pulled in, for the same reason the chunker is: this
 * package must install and run everywhere Node does, and an ignore matcher is
 * a hundred lines of pattern translation. It implements the parts of the
 * gitignore spec that actually shape a code index — anchoring, directory-only
 * patterns, `**`, character classes, and negation with last-match-wins — and
 * deliberately skips the exotic corners (`\` escapes of glob metacharacters
 * inside classes, `.git/info/exclude`, the global excludes file).
 *
 * Getting this wrong is cheap in one direction and expensive in the other: an
 * over-broad ignore loses a file from the index, while an under-broad one
 * indexes `node_modules`. The defaults in `walk.ts` are therefore belt and
 * braces on top of whatever the repository's own rules say.
 */

/** One compiled ignore pattern. */
interface CompiledRule {
  /** Matches the path the pattern names, exactly. */
  self: RegExp;
  /** Matches any path *inside* the path the pattern names. */
  under: RegExp;
  /** `!pattern` — re-includes a path an earlier rule excluded. */
  negated: boolean;
  /** `pattern/` — only matches directories (and, via `under`, their contents). */
  dirOnly: boolean;
}

/** Regex-escape one literal character. */
function escapeChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate a gitignore glob body into a regular-expression body. */
function translateGlob(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      let cls = "[";
      if (pattern[j] === "!" || pattern[j] === "^") {
        cls += "^";
        j++;
      }
      if (pattern[j] === "]") {
        cls += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        const inner = pattern[j] ?? "";
        cls += inner === "\\" ? "\\\\" : inner;
        j++;
      }
      if (j >= pattern.length) {
        // Unterminated class: treat the `[` as a literal rather than throwing.
        out += "\\[";
        i++;
        continue;
      }
      out += `${cls}]`;
      i = j + 1;
      continue;
    }
    out += escapeChar(ch ?? "");
    i++;
  }
  return out;
}

/** Compile one gitignore line, relative to `base` (a repo-relative directory, or ""). */
function compileRule(line: string, base: string): CompiledRule | null {
  let pattern = line.replace(/\r$/, "");
  // Trailing whitespace is insignificant unless escaped.
  pattern = pattern.replace(/(?:(?<!\\)\s)+$/, "");
  if (pattern.length === 0 || pattern.startsWith("#")) return null;

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  pattern = pattern.replace(/^\\(?=[!#])/, "");

  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0) return null;

  // A slash anywhere but the end anchors the pattern to the .gitignore's dir.
  const anchored = pattern.slice(0, -1).includes("/") || pattern.startsWith("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  const prefix = base.length > 0 ? `${base.split("/").map(escapeSegment).join("/")}/` : "";
  const body = translateGlob(pattern);
  const head = anchored ? `^${prefix}${body}` : `^${prefix}(?:.*/)?${body}`;

  return {
    self: new RegExp(`${head}$`),
    under: new RegExp(`${head}/`),
    negated,
    dirOnly,
  };
}

/** Escape a literal path segment for use as a regex prefix. */
function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a `.gitignore` file's contents into its pattern lines. */
export function parseIgnoreFile(contents: string): string[] {
  return contents.split(/\r?\n/);
}

/**
 * An ordered set of gitignore rules, possibly from several `.gitignore` files
 * at different depths. Later rules win, which is what makes `!keep.me` work.
 */
export class IgnoreMatcher {
  private readonly rules: CompiledRule[] = [];

  /**
   * Add patterns from a `.gitignore` located in `base` (a repo-relative
   * directory path, `""` for the repository root). Unparseable lines are
   * skipped, never thrown.
   */
  add(patterns: Iterable<string>, base = ""): this {
    for (const pattern of patterns) {
      try {
        const rule = compileRule(pattern, base);
        if (rule) this.rules.push(rule);
      } catch {
        // A pattern that will not compile simply does not apply.
      }
    }
    return this;
  }

  /** True when nothing has been added. */
  get isEmpty(): boolean {
    return this.rules.length === 0;
  }

  /**
   * Should `path` (repo-relative, POSIX separators) be ignored?
   *
   * Last matching rule wins, so a later `!pattern` re-includes a path an
   * earlier pattern excluded — the semantics people actually rely on.
   */
  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      const matched = rule.under.test(path)
        ? true
        : rule.self.test(path) && (!rule.dirOnly || isDirectory);
      if (matched) ignored = !rule.negated;
    }
    return ignored;
  }
}
