/**
 * Per-language rule tables.
 *
 * The scanner in `scanner.ts` is one engine; everything language-specific
 * lives here as **data**. Adding a language is adding a table, not adding
 * code — which is why this file is long and `scanner.ts` is short.
 *
 * Extraction is deliberately heuristic and dependency-free. A real parser per
 * language would mean a dozen native or multi-megabyte dependencies, and Arcturn's
 * index has to install and run everywhere Node does. The trade is recall, not
 * correctness: a rule that fails to fire loses one chunk; the whole-file
 * fallback in `chunker.ts` guarantees the file is still findable.
 */

import type { CommentSyntax } from "./mask.js";
import type { ChunkKind, LanguageId } from "./types.js";

/** How a declaration's extent is determined. */
export type BlockStyle =
  /** Curly braces: C, Java, Go, Rust, Swift, TS, ... */
  | "brace"
  /** Significant indentation: Python. */
  | "indent"
  /** An explicit `end` keyword: Ruby. */
  | "keyword-end"
  /** No block structure; every declaration is its own line. */
  | "none";

/** One declaration pattern for one language. First matching rule wins. */
export interface DeclarationRule {
  /** Kind recorded when this rule fires at top level. */
  readonly kind: ChunkKind;
  /**
   * Tested against the **masked** line with leading whitespace trimmed, so
   * string and comment contents can never trigger it.
   */
  readonly match: RegExp;
  /** Capture group holding the symbol name. Defaults to 1. */
  readonly nameGroup?: number;
  /** Capture group holding an explicit container name (Go receivers). */
  readonly containerGroup?: number;
  /** Declarations inside this one are members: the scanner descends into it. */
  readonly container?: boolean;
  /** Kind to record when this rule fires inside a container (`function` → `method`). */
  readonly memberKind?: ChunkKind;
  /** Only fire when the scanner is inside a container body. */
  readonly onlyInContainer?: boolean;
  /** Veto: if this matches the trimmed line, the rule does not fire. */
  readonly reject?: RegExp;
  /** The declaration occupies exactly its own line (`#define`, a Ruby constant). */
  readonly oneLine?: boolean;
}

/** Everything the scanner needs to know about one language. */
export interface LanguageRules {
  readonly id: LanguageId;
  readonly blockStyle: BlockStyle;
  readonly syntax: CommentSyntax;
  readonly declarations: readonly DeclarationRule[];
  /** Strips comment punctuation off a doc line. */
  readonly docStrip: RegExp;
  /** Lines above a declaration that continue its doc chain (decorators, attributes). */
  readonly annotation?: RegExp;
  /** Python-style: the doc is a string literal on the line(s) *after* the declaration. */
  readonly docstringAfterDecl?: boolean;
}

/** Statement keywords that must never be mistaken for a declaration name. */
const CONTROL_REJECT =
  /^(?:if|for|while|switch|catch|return|else|do|try|new|throw|case|goto|sizeof|await|yield|typeof|delete|in|of|assert|with|using|lock|foreach|when|guard|repeat|defer|select|go|match|loop)\b/;

const C_STYLE_DOC_STRIP = /^\s*(?:\/{2,3}!?|\/\*{1,2}!?|\*\/|\*)\s?/;
const HASH_DOC_STRIP = /^\s*#{1,3}!?\s?/;

const C_STYLE_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  strings: ['"', "'"],
};

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_MODIFIERS = "(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?";
const TS_MEMBER_MODIFIERS =
  "(?:(?:public|private|protected|static|readonly|abstract|override|async|accessor|declare)\\s+)*";

const TS_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "class",
    match: new RegExp(`^${TS_MODIFIERS}(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  {
    kind: "interface",
    match: new RegExp(`^${TS_MODIFIERS}interface\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  {
    kind: "enum",
    match: new RegExp(`^${TS_MODIFIERS}(?:const\\s+)?enum\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  {
    kind: "module",
    match: new RegExp(`^${TS_MODIFIERS}(?:namespace|module)\\s+([A-Za-z_$][\\w$.]*)`),
    container: true,
  },
  {
    kind: "type",
    match: new RegExp(`^${TS_MODIFIERS}type\\s+([A-Za-z_$][\\w$]*)`),
    oneLine: false,
  },
  {
    kind: "function",
    match: new RegExp(`^${TS_MODIFIERS}(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)`),
    memberKind: "function",
  },
  // `const foo = (…) => {}`, `const foo = async function () {}`, `const foo = <T>(…) => {}`
  {
    kind: "function",
    match: new RegExp(
      `^${TS_MODIFIERS}(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\(|<)`,
    ),
  },
  // `const foo = x => x`
  {
    kind: "function",
    match: new RegExp(
      `^${TS_MODIFIERS}(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*=>`,
    ),
  },
  {
    kind: "const",
    match: new RegExp(`^${TS_MODIFIERS}(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*[:=]`),
  },
  {
    kind: "method",
    match: new RegExp(
      `^${TS_MEMBER_MODIFIERS}(?:(?:get|set)\\s+)?(?:\\*\\s*)?(#?[A-Za-z_$][\\w$]*)\\s*(?:<[^>(]*>)?\\s*\\(`,
    ),
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
  {
    kind: "property",
    match: new RegExp(`^${TS_MEMBER_MODIFIERS}(#?[A-Za-z_$][\\w$]*)\\s*[?!]?\\s*(?::[^;=]|=[^=>])`),
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
];

const TS_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  strings: ['"', "'", "`"],
  multiline: ["`"],
  // A delimiter inside a regex literal must not open a string — see the
  // `regexLiterals` note in mask.ts for the 360-line failure this prevents.
  regexLiterals: true,
};

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_DECLARATIONS: readonly DeclarationRule[] = [
  { kind: "class", match: /^class\s+([A-Za-z_]\w*)/, container: true },
  {
    kind: "function",
    match: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    memberKind: "method",
  },
  { kind: "const", match: /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/, oneLine: true },
];

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "method",
    match: /^func\s+\(\s*\w+\s+\*?([A-Za-z_][\w.]*)\s*\)\s*([A-Za-z_]\w*)/,
    nameGroup: 2,
    containerGroup: 1,
  },
  { kind: "function", match: /^func\s+([A-Za-z_]\w*)/ },
  { kind: "struct", match: /^type\s+([A-Za-z_]\w*)\s+struct\b/, container: true },
  { kind: "interface", match: /^type\s+([A-Za-z_]\w*)\s+interface\b/, container: true },
  { kind: "type", match: /^type\s+([A-Za-z_]\w*)\s/ },
  { kind: "const", match: /^(?:const|var)\s+([A-Za-z_]\w*)\s*[=\w[*]/ },
];

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_VIS = "(?:pub(?:\\([^)]*\\))?\\s+)?";

const RUST_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "function",
    match: new RegExp(
      `^${RUST_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+)?fn\\s+([A-Za-z_]\\w*)`,
    ),
    memberKind: "method",
  },
  { kind: "struct", match: new RegExp(`^${RUST_VIS}struct\\s+([A-Za-z_]\\w*)`), container: true },
  { kind: "enum", match: new RegExp(`^${RUST_VIS}enum\\s+([A-Za-z_]\\w*)`), container: true },
  {
    kind: "trait",
    match: new RegExp(`^${RUST_VIS}(?:unsafe\\s+)?trait\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "impl",
    match: /^impl(?:\s*<[^>]*>)?\s+(?:([A-Za-z_][\w:]*)(?:\s*<[^>]*>)?\s+for\s+)?([A-Za-z_][\w:]*)/,
    nameGroup: 2,
    container: true,
  },
  { kind: "module", match: new RegExp(`^${RUST_VIS}mod\\s+([A-Za-z_]\\w*)`), container: true },
  {
    kind: "const",
    match: new RegExp(`^${RUST_VIS}(?:const|static)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)`),
  },
  { kind: "type", match: new RegExp(`^${RUST_VIS}type\\s+([A-Za-z_]\\w*)`) },
  { kind: "macro", match: /^macro_rules!\s+([A-Za-z_]\w*)/, container: false },
];

/**
 * Rust deliberately omits `'` from its string delimiters: `'a` lifetimes are
 * far more common than `'{'` char literals, and treating a lifetime as an open
 * quote would blank the rest of the line (including its parentheses).
 */
const RUST_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  nestedBlock: true,
  strings: ['"'],
};

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_MODIFIERS =
  "(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp|synchronized|native|default|transient|volatile)\\s+)*";
const JAVA_TYPE = "[A-Za-z_$][\\w$<>\\[\\],.?\\s]*?";

const JAVA_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "class",
    match: new RegExp(`^${JAVA_MODIFIERS}class\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  {
    kind: "interface",
    match: new RegExp(`^${JAVA_MODIFIERS}(?:@)?interface\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  {
    kind: "enum",
    match: new RegExp(`^${JAVA_MODIFIERS}enum\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  {
    kind: "struct",
    match: new RegExp(`^${JAVA_MODIFIERS}record\\s+([A-Za-z_$][\\w$]*)`),
    container: true,
  },
  { kind: "module", match: /^package\s+([\w.]+)/, oneLine: true },
  {
    kind: "method",
    match: new RegExp(
      `^${JAVA_MODIFIERS}(?:<[^>]+>\\s*)?${JAVA_TYPE}[\\s>\\]]([A-Za-z_$][\\w$]*)\\s*\\(`,
    ),
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
  // Constructors: modifiers then a capitalized name straight into `(`.
  {
    kind: "method",
    match: /^(?:(?:public|private|protected)\s+)?([A-Z][\w$]*)\s*\(/,
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
  {
    kind: "property",
    match: new RegExp(`^${JAVA_MODIFIERS}${JAVA_TYPE}[\\s>\\]]([A-Za-z_$][\\w$]*)\\s*[=;]`),
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
];

const JAVA_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  strings: ['"""', '"', "'"],
  multiline: ['"""'],
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const KOTLIN_MODIFIERS =
  "(?:(?:public|private|protected|internal|open|final|abstract|sealed|data|inner|enum|annotation|value|override|suspend|inline|operator|infix|tailrec|external|expect|actual|companion|lateinit|const|crossinline|noinline|reified)\\s+)*";

const KOTLIN_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "function",
    match: new RegExp(
      `^${KOTLIN_MODIFIERS}fun\\s*(?:<[^>]*>\\s*)?(?:[A-Za-z_][\\w.<>]*\\.)?([A-Za-z_][\\w$]*)\\s*\\(`,
    ),
    memberKind: "method",
  },
  {
    kind: "class",
    match: new RegExp(`^${KOTLIN_MODIFIERS}class\\s+([A-Za-z_][\\w$]*)`),
    container: true,
  },
  {
    kind: "class",
    match: new RegExp(`^${KOTLIN_MODIFIERS}object\\s+([A-Za-z_][\\w$]*)`),
    container: true,
  },
  {
    kind: "interface",
    match: new RegExp(`^${KOTLIN_MODIFIERS}interface\\s+([A-Za-z_][\\w$]*)`),
    container: true,
  },
  {
    kind: "const",
    match: new RegExp(`^${KOTLIN_MODIFIERS}va[lr]\\s+([A-Za-z_][\\w$]*)`),
    memberKind: "property",
  },
];

const KOTLIN_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  nestedBlock: true,
  strings: ['"""', '"', "'"],
  multiline: ['"""'],
};

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

const RUBY_DECLARATIONS: readonly DeclarationRule[] = [
  { kind: "class", match: /^class\s+([A-Z][\w:]*)/, container: true },
  { kind: "module", match: /^module\s+([A-Z][\w:]*)/, container: true },
  { kind: "method", match: /^def\s+(?:self\.)?([A-Za-z_][\w?!]*)/ },
  { kind: "const", match: /^([A-Z][A-Z0-9_]*)\s*=(?!=)/, oneLine: true },
];

const RUBY_SYNTAX: CommentSyntax = {
  line: ["#"],
  block: ["=begin", "=end"],
  strings: ['"', "'"],
};

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

const PHP_MODIFIERS = "(?:(?:public|private|protected|static|final|abstract|readonly)\\s+)*";

const PHP_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "function",
    match: new RegExp(`^${PHP_MODIFIERS}function\\s*&?\\s*([A-Za-z_]\\w*)\\s*\\(`),
    memberKind: "method",
  },
  {
    kind: "class",
    match: /^(?:(?:final|abstract|readonly)\s+)*class\s+([A-Za-z_]\w*)/,
    container: true,
  },
  { kind: "interface", match: /^interface\s+([A-Za-z_]\w*)/, container: true },
  { kind: "trait", match: /^trait\s+([A-Za-z_]\w*)/, container: true },
  { kind: "enum", match: /^enum\s+([A-Za-z_]\w*)/, container: true },
  { kind: "module", match: /^namespace\s+([\w\\]+)/, oneLine: true },
  { kind: "const", match: /^(?:(?:public|private|protected)\s+)?const\s+([A-Za-z_]\w*)/ },
  {
    kind: "property",
    match: new RegExp(`^${PHP_MODIFIERS}(?:[?\\w\\\\|]+\\s+)?\\$([A-Za-z_]\\w*)`),
    onlyInContainer: true,
  },
];

const PHP_SYNTAX: CommentSyntax = {
  line: ["//", "#"],
  block: ["/*", "*/"],
  strings: ['"', "'"],
};

// ---------------------------------------------------------------------------
// C and C++
// ---------------------------------------------------------------------------

const C_FUNCTION_MODIFIERS =
  "(?:(?:static|inline|extern|virtual|explicit|constexpr|consteval|const|unsigned|signed|register|_Noreturn|friend|noexcept)\\s+)*";

const C_FUNCTION_RULE: DeclarationRule = {
  kind: "function",
  match: new RegExp(
    `^${C_FUNCTION_MODIFIERS}[A-Za-z_][A-Za-z0-9_:<>,*&\\s]*?[\\s*&]([A-Za-z_~]\\w*)\\s*\\(`,
  ),
  memberKind: "method",
  reject: CONTROL_REJECT,
};

const C_DECLARATIONS: readonly DeclarationRule[] = [
  { kind: "macro", match: /^#\s*define\s+([A-Za-z_]\w*)/, oneLine: true },
  { kind: "struct", match: /^(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/, container: true },
  { kind: "struct", match: /^(?:typedef\s+)?union\s+([A-Za-z_]\w*)/, container: true },
  { kind: "enum", match: /^(?:typedef\s+)?enum\s+([A-Za-z_]\w*)/, container: true },
  C_FUNCTION_RULE,
];

const CPP_DECLARATIONS: readonly DeclarationRule[] = [
  { kind: "macro", match: /^#\s*define\s+([A-Za-z_]\w*)/, oneLine: true },
  { kind: "module", match: /^namespace\s+([A-Za-z_][\w:]*)/, container: true },
  {
    kind: "class",
    match: /^(?:template\s*<[^>]*>\s*)?class\s+(?:[A-Z_]+\s+)?([A-Za-z_]\w*)/,
    container: true,
  },
  {
    kind: "struct",
    match: /^(?:template\s*<[^>]*>\s*)?struct\s+(?:[A-Z_]+\s+)?([A-Za-z_]\w*)/,
    container: true,
  },
  { kind: "enum", match: /^(?:typedef\s+)?enum(?:\s+class)?\s+([A-Za-z_]\w*)/, container: true },
  { kind: "type", match: /^using\s+([A-Za-z_]\w*)\s*=/, oneLine: true },
  C_FUNCTION_RULE,
];

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

const CSHARP_MODIFIERS =
  "(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|virtual|override|extern|async|new|required|file)\\s+)*";
const CSHARP_TYPE = "[A-Za-z_][\\w<>\\[\\],.?\\s]*?";

const CSHARP_DECLARATIONS: readonly DeclarationRule[] = [
  { kind: "module", match: /^namespace\s+([A-Za-z_][\w.]*)/, container: true },
  {
    kind: "class",
    match: new RegExp(`^${CSHARP_MODIFIERS}class\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "struct",
    match: new RegExp(
      `^${CSHARP_MODIFIERS}(?:readonly\\s+)?(?:record\\s+)?struct\\s+([A-Za-z_]\\w*)`,
    ),
    container: true,
  },
  {
    kind: "struct",
    match: new RegExp(`^${CSHARP_MODIFIERS}record\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "interface",
    match: new RegExp(`^${CSHARP_MODIFIERS}interface\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "enum",
    match: new RegExp(`^${CSHARP_MODIFIERS}enum\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "method",
    match: new RegExp(
      `^${CSHARP_MODIFIERS}(?:<[^>]+>\\s*)?${CSHARP_TYPE}[\\s>\\]]([A-Za-z_]\\w*)\\s*(?:<[^>(]*>)?\\s*\\(`,
    ),
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
  {
    kind: "property",
    match: new RegExp(
      `^${CSHARP_MODIFIERS}${CSHARP_TYPE}[\\s>\\]]([A-Za-z_]\\w*)\\s*(?:\\{|=>|=|;)`,
    ),
    onlyInContainer: true,
    reject: CONTROL_REJECT,
  },
];

const CSHARP_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  strings: ['"""', '"', "'"],
  multiline: ['"""'],
};

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

const SWIFT_MODIFIERS =
  "(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|nonmutating|class|convenience|required|dynamic|lazy|weak|unowned|indirect|@\\w+)\\s+)*";

const SWIFT_DECLARATIONS: readonly DeclarationRule[] = [
  {
    kind: "function",
    match: new RegExp(`^${SWIFT_MODIFIERS}func\\s+([A-Za-z_][\\w]*)`),
    memberKind: "method",
  },
  {
    kind: "method",
    match: new RegExp(`^${SWIFT_MODIFIERS}(init|deinit|subscript)\\s*[(<{]`),
    onlyInContainer: true,
  },
  {
    kind: "class",
    match: new RegExp(`^${SWIFT_MODIFIERS}class\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "struct",
    match: new RegExp(`^${SWIFT_MODIFIERS}struct\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "enum",
    match: new RegExp(`^${SWIFT_MODIFIERS}enum\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "trait",
    match: new RegExp(`^${SWIFT_MODIFIERS}protocol\\s+([A-Za-z_]\\w*)`),
    container: true,
  },
  {
    kind: "extension",
    match: new RegExp(`^${SWIFT_MODIFIERS}extension\\s+([A-Za-z_][\\w.]*)`),
    container: true,
  },
  {
    kind: "type",
    match: new RegExp(`^${SWIFT_MODIFIERS}typealias\\s+([A-Za-z_]\\w*)`),
    oneLine: true,
  },
  {
    kind: "const",
    match: new RegExp(`^${SWIFT_MODIFIERS}(?:let|var)\\s+([A-Za-z_]\\w*)`),
    memberKind: "property",
  },
];

const SWIFT_SYNTAX: CommentSyntax = {
  line: ["//"],
  block: ["/*", "*/"],
  nestedBlock: true,
  strings: ['"""', '"'],
  multiline: ['"""'],
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const SHELL_DECLARATIONS: readonly DeclarationRule[] = [
  { kind: "function", match: /^function\s+([A-Za-z_][\w-]*)/ },
  { kind: "function", match: /^([A-Za-z_][\w-]*)\s*\(\s*\)/ },
];

const SHELL_SYNTAX: CommentSyntax = { line: ["#"], strings: ['"', "'"] };

const PLAIN_SYNTAX: CommentSyntax = { line: [], strings: [] };

/** Every supported language's rule table, keyed by {@link LanguageId}. */
export const LANGUAGE_RULES: Readonly<Record<LanguageId, LanguageRules>> = {
  typescript: {
    id: "typescript",
    blockStyle: "brace",
    syntax: TS_SYNTAX,
    declarations: TS_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^@/,
  },
  javascript: {
    id: "javascript",
    blockStyle: "brace",
    syntax: TS_SYNTAX,
    declarations: TS_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^@/,
  },
  python: {
    id: "python",
    blockStyle: "indent",
    syntax: {
      line: ["#"],
      strings: ['"""', "'''", '"', "'"],
      multiline: ['"""', "'''"],
    },
    declarations: PYTHON_DECLARATIONS,
    docStrip: HASH_DOC_STRIP,
    annotation: /^@/,
    docstringAfterDecl: true,
  },
  go: {
    id: "go",
    blockStyle: "brace",
    syntax: { line: ["//"], block: ["/*", "*/"], strings: ['"', "'", "`"], multiline: ["`"] },
    declarations: GO_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
  },
  rust: {
    id: "rust",
    blockStyle: "brace",
    syntax: RUST_SYNTAX,
    declarations: RUST_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^#!?\[/,
  },
  java: {
    id: "java",
    blockStyle: "brace",
    syntax: JAVA_SYNTAX,
    declarations: JAVA_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^@/,
  },
  kotlin: {
    id: "kotlin",
    blockStyle: "brace",
    syntax: KOTLIN_SYNTAX,
    declarations: KOTLIN_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^@/,
  },
  ruby: {
    id: "ruby",
    blockStyle: "keyword-end",
    syntax: RUBY_SYNTAX,
    declarations: RUBY_DECLARATIONS,
    docStrip: HASH_DOC_STRIP,
  },
  php: {
    id: "php",
    blockStyle: "brace",
    syntax: PHP_SYNTAX,
    declarations: PHP_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^#\[/,
  },
  c: {
    id: "c",
    blockStyle: "brace",
    syntax: C_STYLE_SYNTAX,
    declarations: C_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
  },
  cpp: {
    id: "cpp",
    blockStyle: "brace",
    syntax: { ...C_STYLE_SYNTAX, nestedBlock: false },
    declarations: CPP_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
  },
  csharp: {
    id: "csharp",
    blockStyle: "brace",
    syntax: CSHARP_SYNTAX,
    declarations: CSHARP_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^\[/,
  },
  swift: {
    id: "swift",
    blockStyle: "brace",
    syntax: SWIFT_SYNTAX,
    declarations: SWIFT_DECLARATIONS,
    docStrip: C_STYLE_DOC_STRIP,
    annotation: /^@/,
  },
  shell: {
    id: "shell",
    blockStyle: "brace",
    syntax: SHELL_SYNTAX,
    declarations: SHELL_DECLARATIONS,
    docStrip: HASH_DOC_STRIP,
  },
  markdown: {
    id: "markdown",
    blockStyle: "none",
    syntax: PLAIN_SYNTAX,
    declarations: [],
    docStrip: /^\s*#{1,6}\s*/,
  },
  text: {
    id: "text",
    blockStyle: "none",
    syntax: PLAIN_SYNTAX,
    declarations: [],
    docStrip: /^\s*[#/*-]{1,3}\s?/,
  },
};

/** File extension (with dot, lowercase) to language. */
const EXTENSION_TO_LANGUAGE: Readonly<Record<string, LanguageId>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".rake": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
};

/** Whole filenames that map to a language regardless of extension. */
const FILENAME_TO_LANGUAGE: Readonly<Record<string, LanguageId>> = {
  Rakefile: "ruby",
  Gemfile: "ruby",
  Dockerfile: "text",
  Makefile: "text",
};

/**
 * Pick a language for `path` by filename then extension, falling back to
 * `text` — which produces a single whole-file chunk rather than nothing, so
 * every file in the tree stays addressable by path and prose.
 */
export function detectLanguage(path: string): LanguageId {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const byName = FILENAME_TO_LANGUAGE[base];
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  return EXTENSION_TO_LANGUAGE[base.slice(dot).toLowerCase()] ?? "text";
}

/** The rule table for a language. Total — every {@link LanguageId} has one. */
export function rulesFor(language: LanguageId): LanguageRules {
  return LANGUAGE_RULES[language];
}
