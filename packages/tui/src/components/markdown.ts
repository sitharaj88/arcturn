/**
 * The `Markdown` component: renders Markdown to styled terminal lines.
 *
 * Parsing is done with `marked`'s lexer only — no HTML is generated. Tokens are
 * walked directly and turned into ANSI-styled, width-aware lines.
 *
 * @packageDocumentation
 */

import type { Token, Tokens } from "marked";
import { marked } from "marked";
import { hyperlink, stripAnsi } from "../ansi.js";
import { style as themeStyle, themeVersion } from "../theme.js";
import type { Component } from "../tui.js";
import { padToWidth, stringWidth, truncateToWidth, wrapText } from "../width.js";

/** Options for {@link Markdown} and {@link renderMarkdown}. */
export interface MarkdownOptions {
  /** Columns of padding on the left and right (default `0`). */
  readonly paddingX?: number;
  /** Apply naive syntax highlighting inside fenced code blocks (default `true`). */
  readonly highlightCode?: boolean;
  /** Show the target after a link's label (default `true`). */
  readonly showLinkUrls?: boolean;
  /** Emit OSC-8 hyperlinks instead of a trailing URL (default `false`). */
  readonly osc8Links?: boolean;
  /** Bullet used for unordered lists (default `"•"`). */
  readonly bullet?: string;
  /** Indent applied per nesting level in lists (default `2`). */
  readonly listIndent?: number;
}

interface Ctx extends Required<MarkdownOptions> {
  width: number;
}

const DEFAULTS: Required<MarkdownOptions> = {
  paddingX: 0,
  highlightCode: true,
  showLinkUrls: true,
  osc8Links: false,
  bullet: "•",
  listIndent: 2,
};

/**
 * Renders Markdown to an array of styled terminal lines.
 *
 * @param markdown - The source text.
 * @param width - Available columns.
 * @param options - See {@link MarkdownOptions}.
 * @returns One entry per terminal row.
 *
 * @example
 * ```ts
 * renderMarkdown("# Title\n\nSome **bold** text.", 40);
 * ```
 */
export function renderMarkdown(
  markdown: string,
  width: number,
  options: MarkdownOptions = {},
): string[] {
  const merged = { ...DEFAULTS, ...options };
  const contentWidth = Math.max(1, width - merged.paddingX * 2);
  const ctx: Ctx = { ...merged, width: contentWidth };
  const tokens = marked.lexer(markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
  const lines = renderBlocks(tokens, ctx);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (merged.paddingX === 0) return lines;
  const pad = " ".repeat(merged.paddingX);
  return lines.map((line) => (line === "" ? "" : pad + line));
}

/**
 * A component wrapper around {@link renderMarkdown} with per-width caching.
 *
 * @example
 * ```ts
 * const doc = new Markdown("## Results\n\n- one\n- two");
 * ```
 */
export class Markdown implements Component {
  private source: string;
  private options: MarkdownOptions;
  private cache: { width: number; source: string; version: number; lines: string[] } | undefined;

  constructor(markdown = "", options: MarkdownOptions = {}) {
    this.source = markdown;
    this.options = options;
  }

  /** The Markdown source currently rendered. */
  get markdown(): string {
    return this.source;
  }

  /** Replaces the Markdown source. */
  setMarkdown(markdown: string): void {
    if (markdown === this.source) return;
    this.source = markdown;
    this.cache = undefined;
  }

  /** Appends to the Markdown source — useful while streaming a model response. */
  append(chunk: string): void {
    if (chunk === "") return;
    this.source += chunk;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const version = themeVersion();
    if (
      this.cache &&
      this.cache.width === width &&
      this.cache.source === this.source &&
      this.cache.version === version
    ) {
      return this.cache.lines;
    }
    const lines = renderMarkdown(this.source, width, this.options);
    this.cache = { width, source: this.source, version, lines };
    return lines;
  }
}

/* -------------------------------------------------------------------------- */
/* Block rendering                                                             */
/* -------------------------------------------------------------------------- */

function renderBlocks(tokens: readonly Token[], ctx: Ctx): string[] {
  const lines: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const rendered = renderBlock(token, ctx);
    if (rendered.length === 0) continue;
    lines.push(...rendered);
    if (needsTrailingBlank(token) && i < tokens.length - 1) lines.push("");
  }
  return lines;
}

function needsTrailingBlank(token: Token): boolean {
  return (
    token.type === "paragraph" ||
    token.type === "heading" ||
    token.type === "code" ||
    token.type === "blockquote" ||
    token.type === "list" ||
    token.type === "hr" ||
    token.type === "table"
  );
}

function renderBlock(token: Token, ctx: Ctx): string[] {
  switch (token.type) {
    case "space":
      return [];
    case "heading":
      return renderHeading(token as Tokens.Heading, ctx);
    case "paragraph":
      return wrapText(renderInline((token as Tokens.Paragraph).tokens, ctx), ctx.width);
    case "text": {
      const t = token as Tokens.Text;
      const content = t.tokens ? renderInline(t.tokens, ctx) : unescapeEntities(t.text);
      return wrapText(content, ctx.width);
    }
    case "code":
      return renderCode(token as Tokens.Code, ctx);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, ctx);
    case "list":
      return renderList(token as Tokens.List, ctx, 0);
    case "hr":
      return [themeStyle("hr")("─".repeat(Math.min(ctx.width, 80)))];
    case "table":
      return renderTable(token as Tokens.Table, ctx);
    case "html":
      return wrapText(unescapeEntities((token as Tokens.HTML).text.trimEnd()), ctx.width);
    case "br":
      return [""];
    default: {
      const generic = token as Tokens.Generic;
      if (typeof generic.text === "string")
        return wrapText(unescapeEntities(generic.text), ctx.width);
      return [];
    }
  }
}

function renderHeading(token: Tokens.Heading, ctx: Ctx): string[] {
  const styleToken = token.depth === 1 ? "heading1" : token.depth === 2 ? "heading2" : "heading3";
  const prefix = token.depth >= 3 ? `${"#".repeat(token.depth)} ` : "";
  const text = renderInline(token.tokens, ctx);
  return wrapText(themeStyle(styleToken)(prefix + text), ctx.width);
}

function renderCode(token: Tokens.Code, ctx: Ctx): string[] {
  const border = themeStyle("codeBorder");
  const lang = token.lang ?? "";
  const lines: string[] = [border(lang === "" ? "╭╴" : `╭╴${lang}`)];
  const body = token.text.split("\n");
  const highlighted = ctx.highlightCode
    ? highlightCode(body, lang)
    : body.map(themeStyle("codeBg"));
  for (const line of highlighted)
    lines.push(`${border("│")} ${truncateToWidth(line, Math.max(1, ctx.width - 2))}`);
  lines.push(border("╰╴"));
  return lines;
}

function renderBlockquote(token: Tokens.Blockquote, ctx: Ctx): string[] {
  const gutter = themeStyle("quoteBorder")("│ ");
  const inner = renderBlocks(token.tokens, { ...ctx, width: Math.max(1, ctx.width - 2) });
  return inner.map((line) => gutter + themeStyle("quote")(line));
}

function renderList(token: Tokens.List, ctx: Ctx, depth: number): string[] {
  const lines: string[] = [];
  const indent = " ".repeat(depth * ctx.listIndent);
  let counter = typeof token.start === "number" && token.start > 0 ? token.start : 1;

  for (const item of token.items) {
    const marker = token.ordered ? `${counter++}. ` : `${ctx.bullet} `;
    const check = item.task ? `[${item.checked ? "x" : " "}] ` : "";
    const prefix = indent + themeStyle("listBullet")(marker) + check;
    const prefixWidth = stringWidth(indent + marker + check);
    const bodyWidth = Math.max(1, ctx.width - prefixWidth);

    const nested: string[] = [];
    const own: Token[] = [];
    for (const child of item.tokens) {
      if (child.type === "list") nested.push(...renderList(child as Tokens.List, ctx, depth + 1));
      else own.push(child);
    }

    const body = renderBlocks(own, { ...ctx, width: bodyWidth });
    const continuation = " ".repeat(prefixWidth);
    if (body.length === 0) lines.push(prefix);
    for (let i = 0; i < body.length; i++) {
      lines.push((i === 0 ? prefix : continuation) + body[i]);
    }
    lines.push(...nested);
    if (token.loose) lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderTable(token: Tokens.Table, ctx: Ctx): string[] {
  const header = token.header.map((cell) => renderInline(cell.tokens, ctx));
  const rows = token.rows.map((row) => row.map((cell) => renderInline(cell.tokens, ctx)));
  const columns = header.length;
  if (columns === 0) return [];

  const natural = header.map((cell, i) =>
    Math.max(stringWidth(cell), ...rows.map((r) => stringWidth(r[i] ?? ""))),
  );
  const overhead = columns * 3 + 1;
  const budget = Math.max(columns, ctx.width - overhead);
  const total = natural.reduce((a, b) => a + b, 0);
  const widths =
    total <= budget ? natural : natural.map((w) => Math.max(1, Math.floor((w / total) * budget)));

  const border = themeStyle("tableBorder");
  const line = (left: string, mid: string, right: string): string =>
    border(left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right);

  const renderRow = (cells: string[], bold: boolean): string => {
    const parts = cells.map((cell, i) => {
      const w = widths[i] ?? 1;
      const text = truncateToWidth(cell, w);
      const padded = padToWidth(text, w, token.align[i] ?? "left");
      return bold ? themeStyle("tableHeader")(padded) : padded;
    });
    return `${border("│")} ${parts.join(` ${border("│")} `)} ${border("│")}`;
  };

  const out = [line("┌", "┬", "┐"), renderRow(header, true), line("├", "┼", "┤")];
  for (const row of rows) out.push(renderRow(row, false));
  out.push(line("└", "┴", "┘"));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Inline rendering                                                            */
/* -------------------------------------------------------------------------- */

function renderInline(tokens: readonly Token[] | undefined, ctx: Ctx): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape":
        out += unescapeEntities((token as Tokens.Text).text);
        break;
      case "strong":
        out += themeStyle("bold")(renderInline((token as Tokens.Strong).tokens, ctx));
        break;
      case "em":
        out += themeStyle("italic")(renderInline((token as Tokens.Em).tokens, ctx));
        break;
      case "del":
        out += themeStyle("strikethrough")(renderInline((token as Tokens.Del).tokens, ctx));
        break;
      case "codespan":
        out += themeStyle("code")(unescapeEntities((token as Tokens.Codespan).text));
        break;
      case "br":
        out += "\n";
        break;
      case "link":
        out += renderLink(token as Tokens.Link, ctx);
        break;
      case "image": {
        const image = token as Tokens.Image;
        out += themeStyle("muted")(`[image: ${image.text || image.href}]`);
        break;
      }
      case "html":
        out += unescapeEntities((token as Tokens.HTML).text);
        break;
      default: {
        const generic = token as Tokens.Generic;
        if (generic.tokens) out += renderInline(generic.tokens, ctx);
        else if (typeof generic.text === "string") out += unescapeEntities(generic.text);
      }
    }
  }
  return out;
}

/**
 * Matches control bytes that must never reach a link href: `stripAnsi` first
 * removes complete escape sequences, this then removes anything left in the
 * C0 (including bare `ESC`/`BEL`), `DEL` and C1 ranges. Unlike editor text,
 * hrefs are single-line, so `\n`/`\t`/`\r` are stripped too.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching raw control bytes to strip them
const HREF_CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Sanitises a Markdown link target before it is written to the terminal —
 * either as a trailing ` (url)` or, opt-in, inside an OSC-8 hyperlink escape.
 * Without this, an href containing a bare `BEL`/`ESC` could break out of the
 * OSC-8 string (or inject its own escape sequence) even though the surrounding
 * label text is themed and safe.
 */
function sanitizeHref(href: string): string {
  return stripAnsi(href).replace(HREF_CONTROL_PATTERN, "");
}

function renderLink(token: Tokens.Link, ctx: Ctx): string {
  const href = sanitizeHref(token.href);
  // When the source href contains raw control bytes, marked's inline-link regex
  // fails to match it as `[label](href)` and falls back to autolinking the raw
  // URL text instead — in that fallback, `token.tokens` carries the same
  // unsanitised bytes as the label. Run it through the same sanitiser so a
  // malicious href can't smuggle its payload back in via the visible text.
  const label = sanitizeHref(renderInline(token.tokens, ctx)) || href;
  const styled = themeStyle("link")(themeStyle("underline")(label));
  if (ctx.osc8Links) return hyperlink(styled, href);
  if (!ctx.showLinkUrls) return styled;
  const bare = label === href || `mailto:${label}` === href;
  return bare ? styled : styled + themeStyle("linkUrl")(` (${href})`);
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

/** Reverses the HTML escaping that marked applies to text tokens. */
function unescapeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

/* -------------------------------------------------------------------------- */
/* Code highlighting                                                           */
/* -------------------------------------------------------------------------- */

const COMMON_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "delete",
  "do",
  "elif",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "go",
  "if",
  "impl",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "match",
  "mod",
  "module",
  "mut",
  "new",
  "nil",
  "None",
  "not",
  "null",
  "or",
  "package",
  "pass",
  "private",
  "protected",
  "public",
  "pub",
  "raise",
  "readonly",
  "return",
  "satisfies",
  "select",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "try",
  "type",
  "typeof",
  "use",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Fence-tag aliases, so `py` and `python` mean one thing. */
const LANG_ALIASES: Record<string, string> = {
  javascript: "js",
  jsx: "js",
  typescript: "ts",
  tsx: "ts",
  python: "py",
  ruby: "rb",
  rust: "rs",
  golang: "go",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  "c++": "cpp",
  csharp: "cs",
  yml: "yaml",
};

/**
 * Words that highlight only under their own fence tag. Layered over the
 * shared set, so `select` no longer lights up in TypeScript and `fn` does
 * not need to pollute Python — the fix for the flat list's false positives
 * without growing a parser.
 */
const LANG_KEYWORDS: Record<string, ReadonlySet<string>> = {
  js: new Set(["declare", "delete", "extends", "instanceof", "of", "keyof", "infer"]),
  ts: new Set(["declare", "delete", "extends", "instanceof", "of", "keyof", "infer", "unknown"]),
  py: new Set([
    "and",
    "assert",
    "del",
    "elif",
    "except",
    "global",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
  ]),
  rb: new Set([
    "begin",
    "do",
    "end",
    "ensure",
    "module",
    "next",
    "nil",
    "rescue",
    "then",
    "unless",
    "until",
    "when",
  ]),
  rs: new Set([
    "dyn",
    "extern",
    "fn",
    "impl",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "ref",
    "unsafe",
    "where",
  ]),
  go: new Set(["chan", "defer", "fallthrough", "func", "go", "goto", "map", "package", "range"]),
  sh: new Set(["do", "done", "echo", "elif", "esac", "exit", "export", "fi", "local", "then"]),
  sql: new Set([
    "alter",
    "and",
    "by",
    "create",
    "delete",
    "drop",
    "group",
    "having",
    "insert",
    "into",
    "join",
    "limit",
    "not",
    "on",
    "or",
    "order",
    "table",
    "update",
    "values",
    "where",
  ]),
  java: new Set([
    "extends",
    "final",
    "implements",
    "instanceof",
    "native",
    "package",
    "synchronized",
    "throws",
    "transient",
    "volatile",
  ]),
  cpp: new Set([
    "auto",
    "constexpr",
    "delete",
    "friend",
    "inline",
    "namespace",
    "nullptr",
    "operator",
    "template",
    "typename",
    "using",
    "virtual",
  ]),
  cs: new Set([
    "base",
    "checked",
    "delegate",
    "event",
    "internal",
    "namespace",
    "out",
    "override",
    "sealed",
    "using",
    "virtual",
  ]),
};

/** Value-like words, painted as values in every language. */
const LITERAL_CONSTANTS = new Set([
  "true",
  "false",
  "null",
  "nil",
  "undefined",
  "None",
  "True",
  "False",
  "NaN",
  "Infinity",
]);

const HASH_COMMENT_LANGS = new Set([
  "sh",
  "bash",
  "zsh",
  "shell",
  "python",
  "py",
  "ruby",
  "rb",
  "yaml",
  "yml",
  "toml",
  "perl",
  "r",
  "make",
  "makefile",
  "dockerfile",
  "ini",
  "conf",
]);

const CODE_TOKEN =
  /(\/\*[\s\S]*?(?:\*\/|$))|(\/\/[^\n]*)|(#[^\n]*)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

/**
 * Applies a deliberately simple, language-agnostic highlight to code lines.
 *
 * This is not a parser: it recognises comments, string literals, numbers and a
 * shared keyword set. It never throws and never reorders content, which matters
 * when highlighting a partially streamed code block.
 *
 * @param lines - Raw code lines.
 * @param lang - Language hint from the fence, used only to enable `#` comments.
 */
export function highlightCode(lines: readonly string[], lang = ""): string[] {
  const language = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  const hashComments = HASH_COMMENT_LANGS.has(language);
  const extraKeywords = LANG_KEYWORDS[language];
  const base = themeStyle("codeBg");
  return lines.map((line) => {
    let out = "";
    let last = 0;
    CODE_TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null = CODE_TOKEN.exec(line);
    while (match !== null) {
      const [raw, block, slash, hash, str, num, ident] = match;
      if (hash !== undefined && !hashComments) {
        match = CODE_TOKEN.exec(line);
        continue;
      }
      if (match.index > last) out += base(line.slice(last, match.index));
      if (block !== undefined || slash !== undefined || hash !== undefined) {
        out += themeStyle("codeComment")(raw);
      } else if (str !== undefined) {
        out += themeStyle("codeString")(raw);
      } else if (num !== undefined) {
        out += themeStyle("codeNumber")(raw);
      } else if (ident !== undefined && LITERAL_CONSTANTS.has(ident)) {
        // Value-like words read as values: the number colour, not the keyword one.
        out += themeStyle("codeNumber")(raw);
      } else if (
        ident !== undefined &&
        (COMMON_KEYWORDS.has(ident) || extraKeywords?.has(ident) === true)
      ) {
        out += themeStyle("codeKeyword")(raw);
      } else {
        out += base(raw);
      }
      last = match.index + raw.length;
      match = CODE_TOKEN.exec(line);
    }
    if (last < line.length) out += base(line.slice(last));
    return out;
  });
}

/* -------------------------------------------------------------------------- */
/* Incremental streaming renderer                                              */
/* -------------------------------------------------------------------------- */

/**
 * Renders a *growing* Markdown document in amortised O(delta) time.
 *
 * `renderMarkdown` re-parses its whole input, which makes per-frame rendering
 * of a streaming LLM answer O(answer length) — the UI gets slower the longer
 * the answer runs. `MarkdownStream` splits the source at safe block boundaries
 * as it grows: everything before the last boundary is rendered once and cached,
 * and only the trailing (still-changing) block is re-rendered per frame.
 *
 * A boundary is a blank line outside any code fence whose following line does
 * not start a list item, table row, quote or indented continuation — i.e. a
 * point where cutting the document cannot change how either side renders.
 *
 * @example
 * ```ts
 * const stream = new MarkdownStream();
 * stream.append(delta);            // on every streamed chunk
 * const lines = stream.render(80); // per frame: cached prefix + live tail
 * ```
 */
export class MarkdownStream {
  #options: MarkdownOptions;
  /** Source text after the last stable boundary (the live tail). */
  #tail = "";
  /** Source text before the last stable boundary. */
  #stable = "";
  /** Rendered lines of {@link MarkdownStream.#stable} at {@link MarkdownStream.#width}. */
  #stableLines: string[] = [];
  #width = -1;
  /**
   * {@link themeVersion} at which {@link MarkdownStream.#stableLines} was last
   * rendered — a theme switch must invalidate the cached prefix exactly like a
   * width change does, or the stable lines keep the old palette's colours.
   */
  #themeVersion = -1;
  /** Whether the live tail currently sits inside an unclosed code fence. */
  #inFence = false;

  constructor(options: MarkdownOptions = {}) {
    this.#options = options;
  }

  /** Total source text so far. */
  get source(): string {
    return this.#stable + this.#tail;
  }

  /** Drops all content, ready for the next stream. */
  reset(): void {
    this.#tail = "";
    this.#stable = "";
    this.#stableLines = [];
    this.#inFence = false;
  }

  /**
   * Appends streamed source text and advances the stable boundary when the
   * tail has grown past one.
   */
  append(delta: string): void {
    if (delta === "") return;
    this.#tail += delta;
    this.#advanceBoundary();
  }

  /**
   * Renders the whole document: cached stable prefix plus a fresh render of
   * the live tail. A width change re-renders the prefix once.
   *
   * @param width - Available columns.
   */
  render(width: number): string[] {
    const version = themeVersion();
    if (width !== this.#width || version !== this.#themeVersion) {
      this.#width = width;
      this.#themeVersion = version;
      this.#stableLines =
        this.#stable === "" ? [] : renderMarkdown(this.#stable, width, this.#options);
    }
    const tailLines =
      this.#tail.trim() === "" ? [] : renderMarkdown(this.#tail, width, this.#options);
    if (this.#stableLines.length === 0) return tailLines;
    if (tailLines.length === 0) return this.#stableLines;
    return [...this.#stableLines, "", ...tailLines];
  }

  /** Moves any completed blocks in the tail into the cached stable prefix. */
  #advanceBoundary(): void {
    const cut = this.#lastSafeBoundary();
    if (cut <= 0) return;
    const chunk = this.#tail.slice(0, cut);
    this.#tail = this.#tail.slice(cut);
    this.#stable += chunk;
    // With no width seen yet the first render() call renders the prefix whole.
    // Likewise, if the theme changed since #stableLines was last built, don't
    // append a freshly-styled chunk onto a stale-themed prefix — leave it for
    // render() to notice the version mismatch and rebuild #stableLines whole.
    if (this.#width <= 0 || this.#themeVersion !== themeVersion()) return;
    const stripped = chunk.replace(/\n+$/, "");
    if (stripped === "") return;
    const rendered = renderMarkdown(stripped, this.#width, this.#options);
    if (this.#stableLines.length > 0 && rendered.length > 0) this.#stableLines.push("");
    this.#stableLines.push(...rendered);
  }

  /**
   * Index just past the last safe blank-line boundary in the tail, or `0`.
   *
   * Fence state is tracked across calls for the text already consumed; within
   * the tail it is recomputed line by line.
   */
  #lastSafeBoundary(): number {
    const text = this.#tail;
    let inFence = this.#inFence;
    let cut = 0;
    let cutFence = this.#inFence;
    let lineStart = 0;
    let previousBlank = false;
    while (lineStart < text.length) {
      let lineEnd = text.indexOf("\n", lineStart);
      const complete = lineEnd !== -1;
      if (!complete) lineEnd = text.length;
      const line = text.slice(lineStart, lineEnd);
      if (/^\s{0,3}(```|~~~)/.test(line)) inFence = !inFence;
      const blank = line.trim() === "";
      if (
        previousBlank &&
        !blank &&
        !inFence &&
        lineStart > 0 &&
        !/^[\s\-*+>|]|^\d+[.)]/.test(line)
      ) {
        cut = lineStart;
        cutFence = inFence;
      }
      previousBlank = blank;
      if (!complete) break;
      lineStart = lineEnd + 1;
    }
    if (cut > 0) this.#inFence = cutFence;
    return cut;
  }
}
