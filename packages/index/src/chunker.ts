/**
 * Chunking: turn a file into {@link CodeChunk}s on declaration boundaries.
 *
 * Three layers, in order of preference:
 *
 * 1. **Symbol-aware scanning** for the languages in `language.ts`.
 * 2. **Markdown sectioning** — headings are the declarations of prose, and
 *    "where is X documented" is a question this index should answer.
 * 3. **Whole-file fallback** for everything else, *and* for any file the
 *    scanner finds nothing in. This is the robustness contract: a binary blob,
 *    a config file, or a source file with a syntax error still lands in the
 *    index as one addressable chunk. `chunkFile` never throws.
 */

import { detectLanguage, rulesFor } from "./language.js";
import { type MaskedSource, maskSource, splitLines } from "./mask.js";
import { indentHeaderEnd, type RawDeclaration, scanDeclarations } from "./scanner.js";
import type { ChunkKind, CodeChunk, LanguageId } from "./types.js";

/** Signatures longer than this are truncated: they are a *label*, not the code. */
export const MAX_SIGNATURE_CHARS = 160;

/** Docs longer than this are truncated: only the first sentence or two ever gets rendered. */
export const MAX_DOC_CHARS = 400;

/** Cap on stored body lines, so one generated file cannot dominate the index on disk. */
export const MAX_BODY_LINES = 400;

/** Cap on stored body characters, same reason. */
export const MAX_BODY_CHARS = 12_000;

/**
 * Tighter cap for container declarations whose members are indexed separately.
 *
 * A class's chunk and every one of its method chunks would otherwise each
 * store the same method bodies, inflating the index on disk by the nesting
 * depth of the code for no retrieval gain — the method that a query is really
 * about has its own chunk, its own body, and its own address.
 */
export const MAX_CONTAINER_BODY_LINES = 60;

/**
 * Kinds whose members are separately indexed, so their own stored body is
 * redundant past the declaration's opening lines. `file` and `section` are
 * deliberately absent: they are the *only* representation of their content.
 */
const NESTING_CONTAINER_KINDS: ReadonlySet<ChunkKind> = new Set([
  "class",
  "interface",
  "struct",
  "enum",
  "trait",
  "impl",
  "extension",
  "module",
]);

/** How many leading lines of an unrecognized file are scanned for a description. */
const FILE_DOC_LOOKAHEAD = 20;

/** Collapse all whitespace runs to single spaces and trim. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Trim to `max` characters on a word boundary where possible, with an ellipsis. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Where a brace-language signature ends: the first `{` or `;` **outside**
 * parentheses and brackets.
 *
 * The depth check is what keeps a default value or an inline object type from
 * amputating the signature — `createTool(options: Options = {})` must not
 * render as `createTool(options: Options = `.
 */
function signatureCut(masked: string): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = depth > 0 ? depth - 1 : 0;
    else if (depth === 0 && (ch === "{" || ch === ";")) return i;
  }
  return -1;
}

/**
 * Tidy the whitespace a wrapped declaration leaves behind once its lines are
 * joined: `foo( a, b, )` reads as `foo(a, b)`.
 */
function tightenSignature(text: string): string {
  return text
    .replace(/\(\s+/g, "(")
    .replace(/\s+([),\]])/g, "$1")
    .replace(/,\s*\)/g, ")")
    .replace(/\s+,/g, ",");
}

/**
 * The declaration line(s), cut at the point the body begins.
 *
 * Uses the masked mirror to find the cut so a `{` inside a string or comment
 * never truncates a signature, but slices the *raw* line so the returned text
 * is what a developer would recognize.
 */
function extractSignature(source: MaskedSource, decl: RawDeclaration, brace: boolean): string {
  const parts: string[] = [];
  const last = Math.min(decl.endLine, decl.startLine + 5);
  for (let i = decl.startLine; i <= last; i++) {
    const raw = source.lines[i] ?? "";
    const masked = source.masked[i] ?? "";
    let cut = -1;
    if (brace) {
      cut = signatureCut(masked);
    } else {
      const trimmedEnd = masked.trimEnd();
      if (trimmedEnd.endsWith(":")) cut = trimmedEnd.length - 1;
    }
    if (cut >= 0) {
      parts.push(raw.slice(0, cut));
      break;
    }
    parts.push(raw);
  }
  return truncate(tightenSignature(collapse(parts.join(" "))), MAX_SIGNATURE_CHARS);
}

/** Strip comment punctuation from one doc line. */
function stripDocLine(line: string, docStrip: RegExp): string {
  return line.replace(docStrip, "").replace(/\s*\*+\/\s*$/, "");
}

/**
 * The leading comment block above a declaration.
 *
 * Decorators and attributes (`@Override`, `#[derive(...)]`, `[Fact]`) sit
 * between a doc comment and the declaration it documents, so they are stepped
 * over rather than treated as the end of the chain. A blank line does end it.
 */
function extractLeadingDoc(
  source: MaskedSource,
  declLine: number,
  docStrip: RegExp,
  annotation: RegExp | undefined,
): string | undefined {
  let i = declLine - 1;
  while (i >= 0 && !source.isComment[i] && annotation?.test((source.lines[i] ?? "").trim())) i--;

  const collected: string[] = [];
  while (i >= 0 && source.isComment[i]) {
    collected.unshift(stripDocLine(source.lines[i] ?? "", docStrip));
    i--;
  }
  const doc = truncate(collapse(collected.join(" ")), MAX_DOC_CHARS);
  return doc.length > 0 ? doc : undefined;
}

const DOCSTRING_OPEN = /^[rubfRUBF]{0,2}("""|''')/;

/**
 * A Python docstring: the first string literal after the declaration header.
 *
 * Detected structurally rather than by regex over the whole body — the masking
 * pass has already blanked string contents, so "a line whose masked form is
 * empty but whose raw form is not" *is* a string literal line.
 */
function extractPythonDocstring(source: MaskedSource, decl: RawDeclaration): string | undefined {
  const header = indentHeaderEnd(source, decl.startLine);
  const limit = Math.min(decl.endLine, header + 40);
  for (let i = header + 1; i <= limit; i++) {
    if (source.isBlank[i] || source.isComment[i]) continue;
    const raw = (source.lines[i] ?? "").trim();
    const opened = DOCSTRING_OPEN.exec(raw);
    if (!opened) return undefined;
    const quote = opened[1] ?? '"""';
    const afterOpen = raw.slice(opened[0].length);
    const closeOnSameLine = afterOpen.indexOf(quote);
    if (closeOnSameLine >= 0) {
      const doc = truncate(collapse(afterOpen.slice(0, closeOnSameLine)), MAX_DOC_CHARS);
      return doc.length > 0 ? doc : undefined;
    }
    const parts: string[] = [afterOpen];
    for (let j = i + 1; j <= Math.min(decl.endLine, i + 40); j++) {
      const line = source.lines[j] ?? "";
      const close = line.indexOf(quote);
      if (close >= 0) {
        parts.push(line.slice(0, close));
        break;
      }
      parts.push(line);
    }
    const doc = truncate(collapse(parts.join(" ")), MAX_DOC_CHARS);
    return doc.length > 0 ? doc : undefined;
  }
  return undefined;
}

/** Slice and cap the source text of a declaration for storage. */
function extractBody(
  lines: readonly string[],
  startLine: number,
  endLine: number,
  kind?: ChunkKind,
): string {
  const maxLines =
    kind !== undefined && NESTING_CONTAINER_KINDS.has(kind)
      ? MAX_CONTAINER_BODY_LINES
      : MAX_BODY_LINES;
  const end = Math.min(endLine, startLine + maxLines - 1);
  const body = lines.slice(startLine, end + 1).join("\n");
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
}

/** `src/rate-limit.ts` → `rate-limit`; used to name whole-file chunks. */
function fileStem(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The fallback chunk: one address for the whole file.
 *
 * Its `doc` is the file's leading comment (or first prose line), which is
 * usually the single most informative sentence in the file, and its body
 * supplies identifier tokens so the file stays findable by its contents.
 */
function wholeFileChunk(file: string, text: string, language: LanguageId): CodeChunk {
  const rules = rulesFor(language);
  const lines = splitLines(text);
  let doc: string | undefined;

  try {
    const source = maskSource(text, rules.syntax);
    const collected: string[] = [];
    for (let i = 0; i < Math.min(lines.length, FILE_DOC_LOOKAHEAD); i++) {
      if (source.isBlank[i]) {
        if (collected.length > 0) break;
        continue;
      }
      if (source.isComment[i]) {
        collected.push(stripDocLine(lines[i] ?? "", rules.docStrip));
        continue;
      }
      break;
    }
    if (collected.length === 0) {
      const firstProse = lines.slice(0, FILE_DOC_LOOKAHEAD).find((line) => line.trim().length > 0);
      if (firstProse) collected.push(firstProse);
    }
    doc = truncate(collapse(collected.join(" ")), MAX_DOC_CHARS) || undefined;
  } catch {
    doc = undefined;
  }

  return {
    id: `${file}:1:${fileStem(file)}`,
    file,
    startLine: 1,
    endLine: Math.max(1, lines.length),
    kind: "file",
    name: fileStem(file),
    signature: undefined,
    doc,
    body: extractBody(lines, 0, lines.length - 1),
    language,
  };
}

const MD_FENCE = /^(```+|~~~+)/;
const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/**
 * Markdown chunking: one chunk per heading, spanning to the next heading of
 * the same or shallower level. Fenced code blocks are skipped so a `#` comment
 * inside a shell example is not mistaken for a heading.
 */
function chunkMarkdown(file: string, text: string): CodeChunk[] {
  const lines = splitLines(text);
  const headings: Array<{ level: number; title: string; line: number }> = [];

  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    const fenceMatch = MD_FENCE.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker[0] ?? "`";
      else if (marker.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = MD_HEADING.exec(trimmed);
    if (heading) {
      headings.push({
        level: (heading[1] ?? "#").length,
        title: heading[2] ?? "",
        line: i,
      });
    }
  }

  if (headings.length === 0) return [wholeFileChunk(file, text, "markdown")];

  const chunks: CodeChunk[] = [];
  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h];
    if (!heading) continue;
    let end = lines.length - 1;
    for (let n = h + 1; n < headings.length; n++) {
      const next = headings[n];
      if (next && next.level <= heading.level) {
        end = next.line - 1;
        break;
      }
    }
    // Walk backwards collecting the nearest heading at each shallower level:
    // `### Retry` under `## Networking` under `# Guide` yields both ancestors.
    const ancestors: string[] = [];
    let wanted = heading.level - 1;
    for (let a = h - 1; a >= 0 && wanted >= 1; a--) {
      const candidate = headings[a];
      if (candidate && candidate.level === wanted) {
        ancestors.unshift(candidate.title);
        wanted--;
      }
    }

    const bodyLines = lines.slice(heading.line + 1, end + 1);
    const firstProse = bodyLines.find((line) => line.trim().length > 0 && !MD_FENCE.test(line));
    chunks.push({
      id: `${file}:${heading.line + 1}:${heading.title}`,
      file,
      startLine: heading.line + 1,
      endLine: Math.max(end + 1, heading.line + 1),
      kind: "section",
      name: heading.title,
      container: ancestors.length > 0 ? ancestors.join(" / ") : undefined,
      signature: `${"#".repeat(heading.level)} ${heading.title}`,
      doc: firstProse ? truncate(collapse(firstProse), MAX_DOC_CHARS) : undefined,
      body: extractBody(lines, heading.line, end),
      language: "markdown",
    });
  }
  return chunks;
}

/** Give every chunk in a file a unique id, even if two share a line and a name. */
function dedupeIds(chunks: CodeChunk[]): CodeChunk[] {
  const seen = new Map<string, number>();
  for (const chunk of chunks) {
    const count = seen.get(chunk.id) ?? 0;
    seen.set(chunk.id, count + 1);
    if (count > 0) chunk.id = `${chunk.id}~${count}`;
  }
  return chunks;
}

/**
 * Chunk one file.
 *
 * @param file - Repo-relative path with POSIX separators; becomes the address
 *   half of every hit, so it must be the path a caller can `read`.
 * @param text - Decoded file contents. Invalid UTF-8 arrives here as U+FFFD
 *   replacement characters and is handled like any other text.
 * @param language - Override for the detected language; mainly for tests.
 * @returns At least one chunk for any non-empty file. **Never throws** — any
 *   internal failure degrades to the whole-file chunk.
 */
export function chunkFile(file: string, text: string, language?: LanguageId): CodeChunk[] {
  const detected = language ?? detectLanguage(file);
  try {
    if (detected === "markdown") return dedupeIds(chunkMarkdown(file, text));

    const rules = rulesFor(detected);
    if (rules.declarations.length === 0) return [wholeFileChunk(file, text, detected)];

    const source = maskSource(text, rules.syntax);
    const declarations = scanDeclarations(source, rules);
    if (declarations.length === 0) return [wholeFileChunk(file, text, detected)];

    const brace = rules.blockStyle === "brace";
    const chunks = declarations.map((decl): CodeChunk => {
      const doc = rules.docstringAfterDecl
        ? (extractPythonDocstring(source, decl) ??
          extractLeadingDoc(source, decl.startLine, rules.docStrip, rules.annotation))
        : extractLeadingDoc(source, decl.startLine, rules.docStrip, rules.annotation);
      return {
        id: `${file}:${decl.startLine + 1}:${decl.name}`,
        file,
        startLine: decl.startLine + 1,
        endLine: decl.endLine + 1,
        kind: decl.kind,
        name: decl.name,
        container: decl.container,
        signature: extractSignature(source, decl, brace),
        doc,
        body: extractBody(source.lines, decl.startLine, decl.endLine, decl.kind),
        language: detected,
      };
    });
    return dedupeIds(chunks);
  } catch {
    // The whole point of the fallback: an unparseable file is still indexed.
    try {
      return [wholeFileChunk(file, text, detected)];
    } catch {
      return [
        {
          id: `${file}:1:${fileStem(file)}`,
          file,
          startLine: 1,
          endLine: 1,
          kind: "file",
          name: fileStem(file),
          language: detected,
        },
      ];
    }
  }
}
