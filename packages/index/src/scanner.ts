/**
 * The declaration scanner: one engine, driven entirely by the rule tables in
 * `language.ts`.
 *
 * It makes a single forward pass over the masked source, holding a stack of
 * open containers. Two properties make that pass both cheap and accurate:
 *
 * 1. **It never descends into non-container bodies.** When a `function` is
 *    matched, the cursor jumps past its closing brace, so local variables and
 *    nested closures never become chunks. Only classes, interfaces, enums,
 *    traits, impls, namespaces and the like are descended into, which is
 *    exactly where members live.
 * 2. **It only ever looks at masked text**, so a brace inside a string or a
 *    `class Foo` inside a comment cannot move it.
 */

import type { BlockStyle, DeclarationRule, LanguageRules } from "./language.js";
import type { MaskedSource } from "./mask.js";
import type { ChunkKind } from "./types.js";

/** A declaration located by the scanner, in 0-based line coordinates. */
export interface RawDeclaration {
  kind: ChunkKind;
  name: string;
  /** Dotted container path, or undefined at top level. */
  container?: string;
  /** 0-based index of the declaration line itself. */
  startLine: number;
  /** 0-based inclusive index of the last line of the declaration. */
  endLine: number;
}

/** Lines a multi-line declaration header may span before we give up on it. */
const MAX_HEADER_LOOKAHEAD = 20;

/** Hard ceiling on chunks from one file, so a generated monster cannot blow up the index. */
const MAX_DECLARATIONS_PER_FILE = 4000;

/** Hard ceiling on lines scanned, for the same reason. */
const MAX_LINES_SCANNED = 200_000;

/** Count leading whitespace, treating a tab as one column (only relative order matters). */
export function indentOf(line: string | undefined): number {
  if (!line) return 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== " " && ch !== "\t") break;
    i++;
  }
  return i;
}

/**
 * A trailing character that means the declaration header continues on the next
 * line: an operator, a separator, or an unfinished type.
 */
const CONTINUES_LINE = /(?:->|=>|[,([{=+\-*/&|?:.<>^%~\\])$/;

/**
 * A leading token that means the *next* line continues the header: a wrapped
 * union type, a chained call, or a Java-style `throws`/`implements` clause.
 */
const CONTINUES_NEXT = /^(?:->|=>|[|&.?:,)\]+*/=]|throws\b|implements\b|extends\b|where\b)/;

/** The next line with any code on it, trimmed, or `null` at end of file. */
function nextMeaningfulLine(masked: readonly string[], from: number): string | null {
  for (let i = from; i < masked.length; i++) {
    const line = (masked[i] ?? "").trim();
    if (line.length > 0) return line;
  }
  return null;
}

/**
 * End of a brace-delimited declaration.
 *
 * Scans forward for the block's opening `{`, ignoring `(`/`[` nesting so a `;`
 * inside a parameter default cannot end the search early. Three things end the
 * search before a `{` is ever found, and all three matter:
 *
 * - a `;` at paren depth zero — a body-less declaration (an interface member,
 *   a C prototype, `const x = 1;`);
 * - a `}` at paren depth zero — the *enclosing* block closed, so the
 *   declaration ended on the previous line;
 * - a line that neither continues nor is continued — which is how
 *   expression-bodied declarations in semicolon-optional languages
 *   (`override fun tryConsume(n: Int) = n <= capacity`) get the single line
 *   they deserve instead of swallowing everything after them.
 *
 * Allman brace style still works, because a next line starting with `{` counts
 * as a continuation.
 */
function braceBlockEnd(masked: readonly string[], start: number): number {
  let parenDepth = 0;
  let braceDepth = 0;
  let started = false;
  const limit = masked.length;

  for (let i = start; i < limit; i++) {
    const line = masked[i] ?? "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (started) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          braceDepth--;
          if (braceDepth === 0) return i;
        }
        continue;
      }
      if (ch === "(" || ch === "[") parenDepth++;
      else if (ch === ")" || ch === "]") parenDepth = parenDepth > 0 ? parenDepth - 1 : 0;
      else if (ch === "{") {
        started = true;
        braceDepth = 1;
      } else if (ch === ";" && parenDepth === 0) return i;
      else if (ch === "}" && parenDepth === 0) return Math.max(start, i - 1);
    }

    if (started) continue;
    if (i - start >= MAX_HEADER_LOOKAHEAD) return start;
    if (parenDepth > 0) continue;
    if (CONTINUES_LINE.test(line.trimEnd())) continue;
    const next = nextMeaningfulLine(masked, i + 1);
    if (next !== null && (next.startsWith("{") || CONTINUES_NEXT.test(next))) continue;
    return i;
  }
  return limit - 1;
}

/**
 * Last line of an indentation-language declaration *header* — the line ending
 * with `:` outside parentheses. A wrapped parameter list means the body does
 * not start on the declaration line, which both the block-extent scan and
 * docstring extraction need to know.
 */
export function indentHeaderEnd(source: MaskedSource, start: number): number {
  const limit = source.masked.length;
  let parenDepth = 0;
  for (let i = start; i < limit && i - start <= MAX_HEADER_LOOKAHEAD; i++) {
    const line = source.masked[i] ?? "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "(" || ch === "[" || ch === "{") parenDepth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        parenDepth = parenDepth > 0 ? parenDepth - 1 : 0;
      }
    }
    if (parenDepth === 0 && line.trimEnd().endsWith(":")) return i;
  }
  return start;
}

/**
 * End of an indentation-delimited declaration (Python).
 *
 * The header may span lines (a wrapped parameter list), so the block starts at
 * the first line that ends with `:` outside parentheses. The body then runs
 * while indentation stays strictly deeper than the declaration's. Blank and
 * comment lines are stepped over but never extend the block on their own, so a
 * comment separating two top-level functions stays outside both.
 */
function indentBlockEnd(source: MaskedSource, start: number): number {
  const declIndent = indentOf(source.lines[start]);
  const limit = source.masked.length;
  const header = indentHeaderEnd(source, start);

  let last = header;
  for (let i = header + 1; i < limit; i++) {
    if (source.isBlank[i] || source.isComment[i]) continue;
    if (indentOf(source.lines[i]) > declIndent) last = i;
    else break;
  }
  return last;
}

const RUBY_BLOCK_OPENERS = /\b(?:def|class|module|do|begin|case)\b/g;
const RUBY_LEADING_CONDITIONAL = /^(?:if|unless|while|until)\b/;
const RUBY_END = /\bend\b/g;
const RUBY_ENDLESS_METHOD = /^\s*def\b[^=]*=[^=]/;

/** Count non-overlapping matches of a global regex without allocating an array. */
function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count++;
  pattern.lastIndex = 0;
  return count;
}

/** Openers a Ruby line introduces: block keywords plus a leading conditional. */
function rubyOpeners(line: string): number {
  const trimmed = line.trim();
  let count = countMatches(trimmed, RUBY_BLOCK_OPENERS);
  if (RUBY_LEADING_CONDITIONAL.test(trimmed)) count++;
  return count;
}

/** End of a Ruby `def`/`class`/`module`, by balancing block openers against `end`. */
function keywordEndBlockEnd(masked: readonly string[], start: number): number {
  const first = masked[start] ?? "";
  if (RUBY_ENDLESS_METHOD.test(first) && !/\bdo\b/.test(first)) return start;

  const rest = first.trim().replace(/^(?:def|class|module)\b/, "");
  let depth = 1 + countMatches(rest, RUBY_BLOCK_OPENERS) - countMatches(rest, RUBY_END);
  if (RUBY_LEADING_CONDITIONAL.test(rest.trim())) depth++;
  if (depth <= 0) return start;

  for (let i = start + 1; i < masked.length; i++) {
    const line = masked[i] ?? "";
    if (line.trim().length === 0) continue;
    depth += rubyOpeners(line) - countMatches(line, RUBY_END);
    if (depth <= 0) return i;
  }
  return masked.length - 1;
}

/**
 * Net block-nesting change contributed by one masked line.
 *
 * Accumulated across the file it gives the scanner a *scope depth*, which is
 * what lets it tell `const engine = …` at module scope (a real symbol) from
 * the identical line inside `describe("…", () => {` (a local variable). Without
 * it, a test file contributes hundreds of junk chunks and one of them will
 * eventually out-rank a genuine declaration.
 */
function lineDelta(masked: string, style: BlockStyle): number {
  if (style === "keyword-end") {
    return rubyOpeners(masked) - countMatches(masked, RUBY_END);
  }
  if (style !== "brace") return 0;
  let delta = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

/** Dispatch to the block-extent strategy for one language. */
export function declarationEnd(
  source: MaskedSource,
  start: number,
  style: BlockStyle,
  oneLine: boolean,
): number {
  if (oneLine || style === "none") return start;
  if (style === "indent") return indentBlockEnd(source, start);
  if (style === "keyword-end") return keywordEndBlockEnd(source.masked, start);
  return braceBlockEnd(source.masked, start);
}

interface RuleMatch {
  rule: DeclarationRule;
  name: string;
  container?: string;
}

/** First rule whose pattern fires on `trimmed`, honoring container scoping and vetoes. */
function matchRule(
  trimmed: string,
  rules: readonly DeclarationRule[],
  inContainer: boolean,
): RuleMatch | null {
  for (const rule of rules) {
    if (rule.onlyInContainer && !inContainer) continue;
    const match = rule.match.exec(trimmed);
    if (!match) continue;
    const name = match[rule.nameGroup ?? 1];
    if (!name) continue;
    if (rule.reject?.test(trimmed)) continue;
    const container = rule.containerGroup !== undefined ? match[rule.containerGroup] : undefined;
    return { rule, name, container };
  }
  return null;
}

/**
 * Locate every declaration in a masked source file.
 *
 * Never throws: a rule that cannot match simply produces no chunk, and a
 * block whose end cannot be found collapses to its declaration line.
 */
export function scanDeclarations(source: MaskedSource, rules: LanguageRules): RawDeclaration[] {
  const out: RawDeclaration[] = [];
  if (rules.declarations.length === 0) return out;

  const style = rules.blockStyle;
  const stack: Array<{ name: string; endLine: number; indent: number }> = [];
  const limit = Math.min(source.masked.length, MAX_LINES_SCANNED);

  const deltas: number[] = new Array(limit);
  for (let i = 0; i < limit; i++) deltas[i] = lineDelta(source.masked[i] ?? "", style);

  /** Running block depth through the line *before* the cursor. */
  let depth = 0;
  let i = 0;

  while (i < limit) {
    while (stack.length > 0 && i > (stack[stack.length - 1]?.endLine ?? -1)) stack.pop();

    const masked = source.masked[i];
    if (masked === undefined || masked.trim().length === 0) {
      depth += deltas[i] ?? 0;
      i++;
      continue;
    }

    // Only declarations at the current scope's own level are chunks. Anything
    // deeper is inside a block the scanner does not model as a container — a
    // callback, an `if`, an IIFE — and its bindings are locals, not symbols.
    const top = stack[stack.length - 1];
    const inScope =
      style === "indent"
        ? indentOf(source.lines[i]) > (top?.indent ?? -1) &&
          (top !== undefined || indentOf(source.lines[i]) === 0)
        : depth === stack.length;

    if (!inScope) {
      depth += deltas[i] ?? 0;
      i++;
      continue;
    }

    const trimmed = masked.trim();
    const matched = matchRule(trimmed, rules.declarations, stack.length > 0);
    if (!matched) {
      depth += deltas[i] ?? 0;
      i++;
      continue;
    }

    const { rule, name } = matched;
    const end = Math.max(declarationEnd(source, i, style, rule.oneLine === true), i);
    const stackPath = stack.map((entry) => entry.name).join(".");
    const container = matched.container ?? (stackPath.length > 0 ? stackPath : undefined);
    const kind = stack.length > 0 && rule.memberKind ? rule.memberKind : rule.kind;

    out.push({ kind, name, container, startLine: i, endLine: end });
    if (out.length >= MAX_DECLARATIONS_PER_FILE) break;

    if (rule.container) {
      stack.push({
        name: container ? `${container}.${name}` : name,
        endLine: end,
        indent: indentOf(source.lines[i]),
      });
      depth += deltas[i] ?? 0;
      i++;
    } else {
      // A skipped body is brace-balanced by construction, but summing its
      // deltas rather than assuming zero keeps the depth honest even when the
      // block-extent heuristic stopped somewhere unexpected.
      for (let j = i; j <= end; j++) depth += deltas[j] ?? 0;
      i = end + 1;
    }
  }

  return out;
}
