/**
 * A dependency-free structural outline scanner for the `read` tool.
 *
 * The governing idea (see `docs/code-index-architecture.md`): a large file dumped whole is
 * noise, not context — Zed switches `read_file` to a symbol outline above 16 KB instead of
 * the body, and the SWE-agent ablations measure a full file costing 5.3pp versus a narrow
 * window. This module is the outline half of that: a heuristic, single-pass, indentation-aware
 * scanner that finds top-level declarations and the declarations nested one level inside them
 * (methods inside a class, functions inside an `impl`, and so on).
 *
 * Deliberately not the `@arcturn/index` chunker: `@arcturn/tools` must not depend on
 * `@arcturn/index` (that edge does not exist and would need a lockfile change), and the
 * `read` tool only needs one level of nesting, not a full retrieval-grade index. So this is a
 * much smaller engine: no multi-line string/comment masking, no brace-depth block extents —
 * just "what declaration starts this line, and how deep is it indented".
 *
 * Extraction is regex-based per language family and is intentionally approximate. It **never
 * throws** and degrades honestly: an unrecognized extension, a minified file, or a file with no
 * matches all just yield an empty array, which the `read` tool treats as "no outline available"
 * and falls back to a normal truncated read.
 */

import { extname } from "node:path";

/** Coarse kind label shown before a declaration's name in the outline. */
export type OutlineKind =
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "protocol"
  | "extension"
  | "namespace"
  | "module"
  | "object"
  | "union"
  | "function"
  | "method"
  | "type"
  | "const"
  | "property";

/** One declaration found while scanning a file, in the order it appears. */
export interface OutlineDeclaration {
  /** 1-indexed line number of the declaration. */
  line: number;
  /** Coarse kind, e.g. `"class"`, `"function"`, `"method"`. */
  kind: OutlineKind;
  /** Symbol name, prefixed with its one-level container when nested (`TokenBucket.tryConsume`). */
  name: string;
  /**
   * What follows the name on its declaration line — parameters and a return type for a
   * callable, a superclass/value for others — collapsed to one line and capped in length.
   * Empty when the declaration has nothing meaningful after its name.
   */
  signature: string;
}

/** One declaration pattern for one language family. */
interface DeclPattern {
  readonly kind: OutlineKind;
  /**
   * Matched against the line (comment/string-masked) with a `^\s*` prefix and a trailing
   * `(.*)$` capture already appended by {@link pattern}. Write `inner` as the bare declaration
   * grammar; group 1 is the name unless `nameGroup` says otherwise.
   */
  readonly match: RegExp;
  /** 1-based capture group holding the symbol name. */
  readonly nameGroup: number;
  /** 1-based capture group holding an explicit container name (Go method receivers). */
  readonly containerGroup?: number;
  /** This declaration opens a container: lines indented deeper than it are its members. */
  readonly container?: boolean;
  /**
   * A wrapper that doesn't spend the one level of nesting this scanner budgets — namespaces
   * (C#, C++) near-universally wrap an entire file, and treating that wrapper as a real
   * container would leave no nesting left for the class's own methods. A transparent match is
   * still recorded, it just never pushes onto the depth-limited stack.
   */
  readonly transparent?: boolean;
  /** Kind to report instead, when this fires one level inside a container. */
  readonly memberKind?: OutlineKind;
  /** Only ever matched one level inside a container (guards against top-level false positives). */
  readonly memberOnly?: boolean;
  /** Veto: skip the match if this also matches the line's trimmed start. */
  readonly reject?: RegExp;
}

/** Build a {@link DeclPattern} from a bare declaration-grammar regex. */
function pattern(
  kind: OutlineKind,
  inner: RegExp,
  opts: {
    nameGroup?: number;
    containerGroup?: number;
    container?: boolean;
    transparent?: boolean;
    memberKind?: OutlineKind;
    memberOnly?: boolean;
    reject?: RegExp;
  } = {},
): DeclPattern {
  return {
    kind,
    match: new RegExp(`^\\s*(?:${inner.source})(.*)$`),
    nameGroup: opts.nameGroup ?? 1,
    containerGroup: opts.containerGroup,
    container: opts.container,
    transparent: opts.transparent,
    memberKind: opts.memberKind,
    memberOnly: opts.memberOnly,
    reject: opts.reject,
  };
}

/** How a declaration's trailing signature is cut off, per language family. */
type CutMode = "brace" | "colon" | "none";

interface LanguageSpec {
  readonly patterns: readonly DeclPattern[];
  readonly lineComments: readonly string[];
  readonly cut: CutMode;
}

/** Statement keywords that must never be mistaken for a bare-identifier declaration. */
const CONTROL_REJECT =
  /^(?:if|for|while|switch|catch|return|else|do|try|new|throw|case|await|yield|typeof|delete|in|of|with|using|foreach|when|guard|match)\b/;

/**
 * A line that is plainly the continuation of the *previous* line's declaration header — a
 * wrapped parameter list's closing `)`, an `extends`/`implements` clause on its own line, an
 * Allman-style opening `{` sitting alone below the declaration it belongs to, and the like.
 * These lines are inert: they neither pop the indentation stack nor are tried against any
 * pattern, so a signature that wraps (or opens its body) across several lines can't be mistaken
 * for the start of a *new* declaration just because a token happens to land back at the outer
 * indent.
 */
const CONTINUATION_START = /^(?:[{)\]}.,:|&]|=>|->|extends\b|implements\b|throws\b|where\b)/;

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_MOD = /(?:export\s+)?(?:default\s+)?/;

const TS_PATTERNS: DeclPattern[] = [
  pattern("class", new RegExp(`${TS_MOD.source}(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)`), {
    container: true,
  }),
  pattern("interface", new RegExp(`${TS_MOD.source}interface\\s+([A-Za-z_$][\\w$]*)`), {
    container: true,
  }),
  pattern("enum", new RegExp(`${TS_MOD.source}(?:const\\s+)?enum\\s+([A-Za-z_$][\\w$]*)`), {
    container: true,
  }),
  pattern("type", new RegExp(`${TS_MOD.source}type\\s+([A-Za-z_$][\\w$]*)`)),
  pattern(
    "function",
    new RegExp(`${TS_MOD.source}(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)`),
    { memberKind: "method" },
  ),
  // `const foo = (…) => …`, `const foo = async function () {…}`, `const foo = x => x`
  pattern(
    "function",
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
    { memberKind: "method" },
  ),
  pattern("const", /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, {
    memberKind: "property",
  }),
  // A trailing lookahead (not a literal `\(`) confirms this is callable without consuming the
  // `(` itself, so it stays in the captured "rest" and the rendered signature keeps its paren.
  pattern(
    "method",
    /(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|async\s+|override\s+|get\s+|set\s+)*(?:\*\s*)?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*(?=\()/,
    { memberOnly: true, reject: CONTROL_REJECT },
  ),
];

const TS_SPEC: LanguageSpec = { patterns: TS_PATTERNS, lineComments: ["//"], cut: "brace" };

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_SPEC: LanguageSpec = {
  patterns: [
    pattern("class", /class\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("function", /(?:async\s+)?def\s+([A-Za-z_]\w*)/, { memberKind: "method" }),
    pattern("const", /([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/),
  ],
  lineComments: ["#"],
  cut: "colon",
};

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_SPEC: LanguageSpec = {
  patterns: [
    pattern("method", /func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)/, {
      nameGroup: 2,
      containerGroup: 1,
    }),
    pattern("function", /func\s+([A-Za-z_]\w*)/),
    pattern("struct", /type\s+([A-Za-z_]\w*)\s+struct\b/, { container: true }),
    pattern("interface", /type\s+([A-Za-z_]\w*)\s+interface\b/, { container: true }),
    pattern("type", /type\s+([A-Za-z_]\w*)\s/),
    pattern("const", /(?:const|var)\s+([A-Za-z_]\w*)/),
  ],
  lineComments: ["//"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_PUB = /(?:pub(?:\([^)]*\))?\s+)?/;

const RUST_SPEC: LanguageSpec = {
  patterns: [
    pattern(
      "function",
      new RegExp(
        `${RUST_PUB.source}(?:default\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_]\\w*)`,
      ),
      { memberKind: "method" },
    ),
    pattern("struct", new RegExp(`${RUST_PUB.source}struct\\s+([A-Za-z_]\\w*)`), {
      container: true,
    }),
    pattern("enum", new RegExp(`${RUST_PUB.source}enum\\s+([A-Za-z_]\\w*)`), { container: true }),
    pattern("trait", new RegExp(`${RUST_PUB.source}trait\\s+([A-Za-z_]\\w*)`), {
      container: true,
    }),
    pattern("impl", /impl(?:<[^>]*>)?\s+([A-Za-z_][\w:]*)/, { container: true }),
    pattern("const", new RegExp(`${RUST_PUB.source}(?:const|static)\\s+([A-Za-z_]\\w*)`)),
    pattern("type", new RegExp(`${RUST_PUB.source}type\\s+([A-Za-z_]\\w*)`)),
  ],
  lineComments: ["//"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_SPEC: LanguageSpec = {
  patterns: [
    pattern(
      "class",
      /(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_]\w*)/,
      { container: true },
    ),
    pattern("interface", /(?:public\s+|private\s+|protected\s+)*interface\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("enum", /(?:public\s+|private\s+|protected\s+)*enum\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    // The lookahead stops greedy backtracking from reinterpreting an unconsumed modifier (e.g.
    // `public` in a constructor's `public Foo(int x)`, which has no return type) as the type.
    pattern(
      "method",
      /(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|native\s+|default\s+)*(?:<[^>]+>\s+)?(?!(?:public|private|protected|static|final|abstract|synchronized|native|default)\s)[\w.[\]]+(?:<[^,>]*>)?\s+([A-Za-z_]\w*)\s*(?=\()/,
      { memberOnly: true, reject: CONTROL_REJECT },
    ),
  ],
  lineComments: ["//"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const KOTLIN_SPEC: LanguageSpec = {
  patterns: [
    pattern(
      "class",
      /(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|private\s+|internal\s+|open\s+|abstract\s+|final\s+|sealed\s+|data\s+|inner\s+)*class\s+([A-Za-z_]\w*)/,
      { container: true },
    ),
    pattern("interface", /(?:public\s+|private\s+|internal\s+)*interface\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("object", /(?:public\s+|private\s+|internal\s+)*object\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern(
      "function",
      /(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|override\s+|suspend\s+|inline\s+|abstract\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/,
      { memberKind: "method" },
    ),
    pattern("const", /(?:public\s+|private\s+|internal\s+)*(?:const\s+)?val\s+([A-Za-z_]\w*)/, {
      memberKind: "property",
    }),
    pattern("const", /(?:public\s+|private\s+|internal\s+)*var\s+([A-Za-z_]\w*)/, {
      memberKind: "property",
    }),
  ],
  lineComments: ["//"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

const CSHARP_SPEC: LanguageSpec = {
  patterns: [
    pattern("namespace", /namespace\s+([A-Za-z_][\w.]*)/, { transparent: true }),
    pattern(
      "class",
      /(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+([A-Za-z_]\w*)/,
      { container: true },
    ),
    pattern("interface", /(?:public\s+|private\s+|internal\s+)*interface\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("struct", /(?:public\s+|private\s+|internal\s+)*struct\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("enum", /(?:public\s+|private\s+|internal\s+)*enum\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    // Same anti-backtracking guard as Java's method pattern — see the comment there.
    pattern(
      "method",
      /(?:\[[^\]]*\]\s*)*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|virtual\s+|override\s+|abstract\s+|async\s+|sealed\s+)*(?!(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed)\s)[\w<>.[\],]+\s+([A-Za-z_]\w*)\s*(?=\()/,
      { memberOnly: true, reject: CONTROL_REJECT },
    ),
  ],
  lineComments: ["//"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

const RUBY_SPEC: LanguageSpec = {
  patterns: [
    pattern("class", /class\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/, { container: true }),
    pattern("module", /module\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/, { container: true }),
    pattern("function", /def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, { memberKind: "method" }),
  ],
  lineComments: ["#"],
  cut: "none",
};

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

const PHP_SPEC: LanguageSpec = {
  patterns: [
    pattern("class", /(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("interface", /interface\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("trait", /trait\s+([A-Za-z_]\w*)/, { container: true }),
    pattern(
      "function",
      /(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*function\s+&?\s*([A-Za-z_]\w*)/,
      { memberKind: "method" },
    ),
  ],
  lineComments: ["//", "#"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------

// The trailing lookahead requires an inline `(params) {` shape (filtering out prototypes and
// most control statements) without consuming it, so it stays in the captured "rest" and the
// rendered signature shows the parameter list instead of just the bare name.
const C_FUNCTION = pattern(
  "function",
  /(?:static\s+|inline\s+|extern\s+|virtual\s+|constexpr\s+|explicit\s+)*[A-Za-z_][\w:<>,\s*&]*[\s*&]([A-Za-z_~]\w*)\s*(?=\([^;{}]*\)\s*(?:const\s*)?\{)/,
  { memberKind: "method", reject: CONTROL_REJECT },
);

const C_SPEC: LanguageSpec = {
  patterns: [
    pattern("struct", /(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("enum", /(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("union", /(?:typedef\s+)?union\s+([A-Za-z_]\w*)/, { container: true }),
    C_FUNCTION,
  ],
  lineComments: ["//"],
  cut: "brace",
};

const CPP_SPEC: LanguageSpec = {
  patterns: [
    pattern("class", /(?:template\s*<[^>]*>\s*)?class\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("struct", /(?:template\s*<[^>]*>\s*)?struct\s+([A-Za-z_]\w*)/, { container: true }),
    pattern("namespace", /namespace\s+([A-Za-z_]\w*)/, { transparent: true }),
    pattern("enum", /enum(?:\s+class)?\s+([A-Za-z_]\w*)/, { container: true }),
    C_FUNCTION,
  ],
  lineComments: ["//"],
  cut: "brace",
};

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

const SWIFT_SPEC: LanguageSpec = {
  patterns: [
    pattern(
      "class",
      /(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*class\s+([A-Za-z_]\w*)/,
      { container: true },
    ),
    pattern("struct", /(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+)*struct\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("protocol", /(?:public\s+|private\s+|internal\s+)*protocol\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("enum", /(?:public\s+|private\s+|internal\s+)*enum\s+([A-Za-z_]\w*)/, {
      container: true,
    }),
    pattern("extension", /extension\s+([A-Za-z_][\w.]*)/, { container: true }),
    pattern(
      "function",
      /(?:@\w+\s+)*(?:public\s+|private\s+|internal\s+|static\s+|override\s+|final\s+|mutating\s+|class\s+)*func\s+([A-Za-z_]\w*)/,
      { memberKind: "method" },
    ),
  ],
  lineComments: ["//"],
  cut: "brace",
};

/** Extension (lowercased, with leading dot) to language spec. */
const EXTENSION_LANGUAGE: Record<string, LanguageSpec> = {
  ".ts": TS_SPEC,
  ".tsx": TS_SPEC,
  ".mts": TS_SPEC,
  ".cts": TS_SPEC,
  ".js": TS_SPEC,
  ".jsx": TS_SPEC,
  ".mjs": TS_SPEC,
  ".cjs": TS_SPEC,
  ".py": PYTHON_SPEC,
  ".pyi": PYTHON_SPEC,
  ".go": GO_SPEC,
  ".rs": RUST_SPEC,
  ".java": JAVA_SPEC,
  ".kt": KOTLIN_SPEC,
  ".kts": KOTLIN_SPEC,
  ".cs": CSHARP_SPEC,
  ".rb": RUBY_SPEC,
  ".php": PHP_SPEC,
  ".c": C_SPEC,
  ".h": C_SPEC,
  ".cpp": CPP_SPEC,
  ".cc": CPP_SPEC,
  ".cxx": CPP_SPEC,
  ".hpp": CPP_SPEC,
  ".hh": CPP_SPEC,
  ".hxx": CPP_SPEC,
  ".swift": SWIFT_SPEC,
};

/** Files larger than this are not scanned at all: too big to be a source file worth outlining. */
const MAX_SCAN_CHARS = 4_000_000;
/** Lines scanned past this point are ignored, so a pathological file can't blow up the scan. */
const MAX_LINES_SCANNED = 200_000;
/** Declarations collected past this point are ignored, so a generated file can't flood the outline. */
const MAX_DECLARATIONS = 3000;
/** Prefix of a line actually examined for a match; bounds the cost of an absurdly long line. */
const MAX_LINE_SCAN_CHARS = 2000;
/** Signatures longer than this are truncated — a label, not the code. */
const MAX_SIGNATURE_CHARS = 140;

function languageFor(path: string): LanguageSpec | undefined {
  return EXTENSION_LANGUAGE[extname(path).toLowerCase()];
}

/** Leading whitespace width, treating a tab as one column (only relative order matters). */
function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
}

/**
 * Blank out string-literal interiors and same-line comments, preserving the original length so
 * every index in the result still lines up with the raw line. Best-effort and single-line only —
 * a multi-line template literal or block comment isn't tracked, which is an acceptable miss for a
 * heuristic outline (the whole-file fallback exists for exactly this kind of gap).
 */
function maskLine(line: string, lineComments: readonly string[]): string {
  let masked = line
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => " ".repeat(m.length))
    .replace(/\/\*.*?\*\//g, (m) => " ".repeat(m.length));

  let cutAt = -1;
  for (const marker of lineComments) {
    const idx = masked.indexOf(marker);
    if (idx >= 0 && (cutAt === -1 || idx < cutAt)) cutAt = idx;
  }
  if (cutAt >= 0) masked = masked.slice(0, cutAt) + " ".repeat(masked.length - cutAt);
  return masked;
}

/** First index of a top-level `{` or `;`, outside `(`/`[` nesting; -1 if the line has neither. */
function braceCut(masked: string): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = depth > 0 ? depth - 1 : 0;
    else if (depth === 0 && (ch === "{" || ch === ";")) return i;
  }
  return -1;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/** The declaration's trailing signature text, cut at the point its body would begin. */
function extractSignature(rawRest: string, maskedRest: string, cut: CutMode): string {
  let cutIndex = -1;
  if (cut === "brace") {
    cutIndex = braceCut(maskedRest);
  } else if (cut === "colon") {
    const trimmedEnd = maskedRest.trimEnd();
    if (trimmedEnd.endsWith(":")) cutIndex = trimmedEnd.length - 1;
  }
  const sliced = cutIndex >= 0 ? rawRest.slice(0, cutIndex) : rawRest;
  return truncate(collapse(sliced), MAX_SIGNATURE_CHARS);
}

interface Match {
  readonly pattern: DeclPattern;
  readonly name: string;
  readonly explicitContainer: string | undefined;
  readonly signature: string;
}

/** Try every pattern in order against one already-masked line; the first match wins. */
function matchDeclaration(
  patterns: readonly DeclPattern[],
  masked: string,
  raw: string,
  atMemberDepth: boolean,
  cut: CutMode,
): Match | undefined {
  const trimmedMasked = masked.trimStart();
  for (const decl of patterns) {
    if (decl.memberOnly && !atMemberDepth) continue;
    if (decl.reject?.test(trimmedMasked)) continue;

    const m = decl.match.exec(masked);
    if (!m) continue;
    const name = m[decl.nameGroup];
    if (!name) continue;

    const restGroup = m[m.length - 1] ?? "";
    const restStart = masked.length - restGroup.length;
    const rawRest = raw.slice(restStart);
    const signature = extractSignature(rawRest, restGroup, cut);
    const explicitContainer = decl.containerGroup ? m[decl.containerGroup] : undefined;

    return { pattern: decl, name, explicitContainer, signature };
  }
  return undefined;
}

/** One entry on the indentation stack: a declaration whose body owns everything indented past it. */
interface StackEntry {
  readonly indent: number;
  readonly name: string;
  /** Only true for a real container (class/interface/impl/…) — the one case a body may hold a match. */
  readonly allowsMembers: boolean;
}

/**
 * Scan `text` for top-level declarations and declarations nested one level inside a container
 * (a class's methods, an `impl` block's functions, and the like). Containment is inferred purely
 * from indentation, not language-specific block syntax, which is what keeps one engine covering
 * every supported language family.
 *
 * Every matched declaration — not only containers — pushes onto the indentation stack, so a plain
 * function's local variables (indented deeper than the function, but not inside a *container*)
 * are correctly treated as depth 2+ and skipped, rather than misread as top-level or member
 * declarations. Only a genuine container's immediate body is eligible for a depth-1 match.
 *
 * Never throws: an unrecognized extension, an oversized file, or a scan that finds nothing all
 * simply return `[]`, which callers should treat as "no outline available".
 *
 * @param path - File path (only its extension is used, to pick a language).
 * @param text - Decoded file contents.
 */
export function scanOutline(path: string, text: string): OutlineDeclaration[] {
  try {
    const spec = languageFor(path);
    if (!spec || text.length === 0 || text.length > MAX_SCAN_CHARS) return [];

    const lines = text.split("\n");
    const scanLimit = Math.min(lines.length, MAX_LINES_SCANNED);
    const declarations: OutlineDeclaration[] = [];
    const stack: StackEntry[] = [];

    for (let i = 0; i < scanLimit; i++) {
      if (declarations.length >= MAX_DECLARATIONS) break;

      const rawFull = lines[i] ?? "";
      if (rawFull.trim().length === 0) continue;
      const raw =
        rawFull.length > MAX_LINE_SCAN_CHARS ? rawFull.slice(0, MAX_LINE_SCAN_CHARS) : rawFull;
      const masked = maskLine(raw, spec.lineComments);
      const trimmedMasked = masked.trimStart();
      if (trimmedMasked.length === 0 || CONTINUATION_START.test(trimmedMasked)) continue;

      const indent = indentOf(rawFull);
      while (stack.length > 0 && indent <= (stack[stack.length - 1] as StackEntry).indent) {
        stack.pop();
      }
      if (stack.length > 1) continue;

      const container = stack.length === 1 ? (stack[0] as StackEntry) : undefined;
      // Inside a plain function/const/etc.'s body (not a container's): nothing here is a new
      // declaration, and nothing here should be scanned for one either.
      if (container && !container.allowsMembers) continue;

      const found = matchDeclaration(spec.patterns, masked, raw, container !== undefined, spec.cut);
      if (!found) continue;

      const kind =
        container !== undefined && found.pattern.memberKind
          ? found.pattern.memberKind
          : found.pattern.kind;
      const name = found.explicitContainer
        ? `${found.explicitContainer}.${found.name}`
        : container
          ? `${container.name}.${found.name}`
          : found.name;

      declarations.push({ line: i + 1, kind, name, signature: found.signature });
      if (!found.pattern.transparent) {
        stack.push({ indent, name: found.name, allowsMembers: found.pattern.container === true });
      }
    }

    return declarations;
  } catch {
    return [];
  }
}

/** Render one declaration as `line │ kind name(signature)`. */
export function formatOutlineEntry(decl: OutlineDeclaration): string {
  const lineLabel = String(decl.line).padStart(6, " ");
  const body =
    decl.signature.length === 0
      ? decl.name
      : decl.signature.startsWith("(")
        ? `${decl.name}${decl.signature}`
        : `${decl.name} ${decl.signature}`;
  return `${lineLabel} │ ${decl.kind} ${body}`;
}
