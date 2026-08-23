import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIndexStore } from "./store.js";
import {
  createFindReferencesTool,
  createFindSymbolTool,
  createStructuralTools,
  FIND_REFERENCES_DESCRIPTION,
  FIND_SYMBOL_DESCRIPTION,
  type FindSymbolResult,
  findReferences,
  findSymbols,
  formatReferences,
  formatSymbolMatches,
  scanOccurrences,
  wholeWordPattern,
} from "./structural.js";
import {
  createFakeContext,
  createTempIndexDir,
  createTempRepo,
  resultText,
  type TempRepo,
} from "./test-helpers/fixtures.js";
import { CodeIndexService, indexDirFor } from "./tool.js";
import type { ChunkKind, CodeChunk } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `CodeChunk` for the pure-function tests, which need no index. */
function chunk(
  file: string,
  startLine: number,
  kind: ChunkKind,
  name: string,
  extra: Partial<CodeChunk> = {},
): CodeChunk {
  return {
    id: `${file}:${startLine}:${name}`,
    file,
    startLine,
    endLine: extra.endLine ?? startLine,
    kind,
    name,
    language: "typescript",
    ...extra,
  };
}

const REPO = {
  "src/rate-limit.ts": [
    "/** Token bucket rate limiter. */",
    "export class TokenBucket {",
    "  capacity = 10;",
    "",
    "  tryConsume(n: number): boolean {",
    "    return n <= this.capacity;",
    "  }",
    "}",
    "",
    "export function tryConsumeAll(): boolean {",
    "  return new TokenBucket().tryConsume(1);",
    "}",
    "",
  ].join("\n"),
  "src/other.ts": [
    'import { TokenBucket } from "./rate-limit.js";',
    "",
    "/** A second definition of the same name, in another file. */",
    "export function tryConsumeAll(): boolean {",
    "  // tryConsume is mentioned here only in prose.",
    '  const key = "tryConsume";',
    "  return Boolean(TokenBucket) && key.length > 0;",
    "}",
    "",
  ].join("\n"),
  "docs/limits.md": ["# Limits", "", "The tryConsume method is documented here.", ""].join("\n"),
  "src/broken.ts": ["tryConsume(((( unbalanced", "  <<< not typescript >>>", ""].join("\n"),
};

let repo: TempRepo | null = null;
const indexRoots: string[] = [];

afterEach(async () => {
  await repo?.cleanup();
  repo = null;
  await Promise.all(indexRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(overrides: Record<string, unknown> = {}) {
  repo = await createTempRepo(REPO);
  const indexRoot = await createTempIndexDir();
  indexRoots.push(indexRoot);
  return {
    findSymbol: createFindSymbolTool({ indexRoot, ...overrides }),
    references: createFindReferencesTool({ indexRoot, ...overrides }),
    root: repo.root,
  };
}

/** Render every match as `file:line:kind:qualifiedName`, the identity used for set equality. */
function identities(result: FindSymbolResult): string[] {
  return result.matches.map(
    ({ chunk: c }) =>
      `${c.file}:${c.startLine}:${c.kind}:${c.container ? `${c.container}.${c.name}` : c.name}`,
  );
}

// ---------------------------------------------------------------------------
// Tool definitions — the routing mechanism
// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  it("names the tools and takes only `name` as required input", async () => {
    const { findSymbol, references } = await setup();
    expect(findSymbol.definition.name).toBe("find_symbol");
    expect(references.definition.name).toBe("find_references");

    const symbolParams = findSymbol.definition.parameters as {
      required: string[];
      properties: object;
    };
    expect(symbolParams.required).toEqual(["name"]);
    expect(Object.keys(symbolParams.properties).sort()).toEqual(["exact", "kind", "name"]);

    const referenceParams = references.definition.parameters as {
      required: string[];
      properties: object;
    };
    expect(referenceParams.required).toEqual(["name"]);
    expect(Object.keys(referenceParams.properties).sort()).toEqual(["name", "path"]);
  });

  it("states find_symbol's guarantee verbatim, in the first sentence", () => {
    expect(FIND_SYMBOL_DESCRIPTION).toContain(
      "Exhaustive over indexed definitions. Use when you know the symbol's name; prefer this over\n" +
        "search_code for a known identifier.",
    );
    expect(FIND_SYMBOL_DESCRIPTION.indexOf("Exhaustive over indexed definitions.")).toBe(0);
  });

  it("states find_references' guarantee and its escape hatch verbatim", () => {
    expect(FIND_REFERENCES_DESCRIPTION).toContain(
      "Exhaustive over statically visible references, and reports what it could not resolve. " +
        "Dynamic\ndispatch and reflection may not appear — the unresolved count tells you when " +
        "to fall back to\ngrep.",
    );
    expect(
      FIND_REFERENCES_DESCRIPTION.indexOf("Exhaustive over statically visible references"),
    ).toBe(0);
  });

  it("routes: each description says when to prefer it over the neighbouring tools", () => {
    for (const description of [FIND_SYMBOL_DESCRIPTION, FIND_REFERENCES_DESCRIPTION]) {
      expect(description).toContain("grep");
      expect(description).toContain("search_code");
    }
    expect(FIND_SYMBOL_DESCRIPTION).toContain("not ranked");
    expect(FIND_SYMBOL_DESCRIPTION).toContain("find_references");
    expect(FIND_REFERENCES_DESCRIPTION).toContain("NOT ATTRIBUTED");
    expect(FIND_REFERENCES_DESCRIPTION).toContain("RESOLVED");
  });
});

// ---------------------------------------------------------------------------
// find_symbol — matching
// ---------------------------------------------------------------------------

describe("findSymbols — matching", () => {
  const chunks: CodeChunk[] = [
    chunk("src/a.ts", 10, "class", "TokenBucket"),
    chunk("src/a.ts", 14, "method", "tryConsume", { container: "TokenBucket" }),
    chunk("src/b.ts", 3, "function", "tokenBucketFactory"),
    chunk("src/b.ts", 20, "const", "TOKEN_BUCKET_SIZE"),
    chunk("src/c.ts", 1, "function", "TokenBucket"),
  ];

  it("exact:true returns only whole-name matches", () => {
    const result = findSymbols(chunks, { name: "TokenBucket", exact: true });
    expect(identities(result)).toEqual([
      "src/a.ts:10:class:TokenBucket",
      "src/c.ts:1:function:TokenBucket",
    ]);
    expect(result.files).toBe(2);
  });

  it("prefix matching is the default and includes the exact matches", () => {
    const result = findSymbols(chunks, { name: "TokenBucket" });
    expect(identities(result)).toEqual([
      "src/a.ts:10:class:TokenBucket",
      "src/c.ts:1:function:TokenBucket",
      "src/b.ts:3:function:tokenBucketFactory",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(identities(findSymbols(chunks, { name: "tokenbucket", exact: true }))).toEqual([
      "src/a.ts:10:class:TokenBucket",
      "src/c.ts:1:function:TokenBucket",
    ]);
  });

  it("matches a dotted query against the qualified name", () => {
    expect(
      identities(findSymbols(chunks, { name: "TokenBucket.tryConsume", exact: true })),
    ).toEqual(["src/a.ts:14:method:TokenBucket.tryConsume"]);
    // The bare name still finds it when asked for bare.
    expect(identities(findSymbols(chunks, { name: "tryConsume", exact: true }))).toEqual([
      "src/a.ts:14:method:TokenBucket.tryConsume",
    ]);
  });

  it("filters by kind, and counts only the kinds it searched", () => {
    const result = findSymbols(chunks, { name: "TokenBucket", kind: "class" });
    expect(identities(result)).toEqual(["src/a.ts:10:class:TokenBucket"]);
    expect(result.searched).toBe(1);

    // "Token" is a prefix of all three, so there is no exact tier to hoist and
    // the order is purely path, then line.
    const several = findSymbols(chunks, { name: "Token", kind: ["class", "function"] });
    expect(identities(several)).toEqual([
      "src/a.ts:10:class:TokenBucket",
      "src/b.ts:3:function:tokenBucketFactory",
      "src/c.ts:1:function:TokenBucket",
    ]);
  });

  it("returns nothing rather than erroring when nothing matches", () => {
    const result = findSymbols(chunks, { name: "NoSuchThing", exact: true });
    expect(result.matches).toEqual([]);
    expect(result.files).toBe(0);
    expect(result.searched).toBe(chunks.length);
  });
});

// ---------------------------------------------------------------------------
// find_symbol — order is a sort, never a ranking
// ---------------------------------------------------------------------------

describe("findSymbols — order is explainable, not ranked", () => {
  it("orders by match class, then path, then line — never by any relevance signal", () => {
    // Deliberately adversarial for a ranker: the exact match sits in the
    // longest, least 'important'-looking path and at the highest line number,
    // and the prefix matches would out-rank it under any name-similarity or
    // path-depth heuristic.
    const chunks: CodeChunk[] = [
      chunk("z/deep/nested/module/target.ts", 900, "function", "parse"),
      chunk("a.ts", 1, "function", "parseAll"),
      chunk("a.ts", 2, "function", "parse"),
      chunk("b.ts", 5, "const", "parseTable"),
    ];
    expect(identities(findSymbols(chunks, { name: "parse" }))).toEqual([
      "a.ts:2:function:parse",
      "z/deep/nested/module/target.ts:900:function:parse",
      "a.ts:1:function:parseAll",
      "b.ts:5:const:parseTable",
    ]);
  });

  it("is stable: the same chunks in a different input order produce the same output", () => {
    const chunks: CodeChunk[] = [
      chunk("src/a.ts", 4, "function", "run"),
      chunk("src/a.ts", 2, "class", "runner", { name: "run" }),
      chunk("src/b.ts", 1, "function", "run"),
    ];
    const forward = identities(findSymbols(chunks, { name: "run", exact: true }));
    const reversed = identities(findSymbols([...chunks].reverse(), { name: "run", exact: true }));
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([
      "src/a.ts:2:class:run",
      "src/a.ts:4:function:run",
      "src/b.ts:1:function:run",
    ]);
  });
});

// ---------------------------------------------------------------------------
// find_symbol — rendering and the budget
// ---------------------------------------------------------------------------

describe("formatSymbolMatches", () => {
  it("renders `path:line kind name(signature)` and states the complete count", () => {
    const result = findSymbols(
      [
        chunk("src/a.ts", 10, "method", "tryConsume", {
          container: "TokenBucket",
          signature: "tryConsume(n: number): boolean",
        }),
      ],
      { name: "tryConsume", exact: true },
    );
    const rendered = formatSymbolMatches(result);
    expect(rendered.text).toContain("tryConsume: 1 definition in 1 file");
    expect(rendered.text).toContain("not ranked");
    expect(rendered.text).toContain(
      "src/a.ts:10  method TokenBucket.tryConsume(n: number): boolean",
    );
    expect(rendered.omitted).toBe(0);
    expect(rendered.truncated).toBe(false);
  });

  it("names the exact `read` follow-up only when the answer is unambiguous", () => {
    const one = formatSymbolMatches(
      findSymbols([chunk("src/a.ts", 10, "function", "solo", { endLine: 14 })], { name: "solo" }),
    );
    expect(one.text).toContain('Next: read({"path":"src/a.ts","offset":10,"limit":5}) for solo.');

    const two = formatSymbolMatches(
      findSymbols(
        [chunk("src/a.ts", 10, "function", "solo"), chunk("src/b.ts", 3, "function", "solo")],
        { name: "solo" },
      ),
    );
    expect(two.text).not.toContain("Next: read(");
  });

  it("reports exactly how many matches the budget withheld, and never drops one silently", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      chunk("src/handlers.ts", i + 1, "function", `handler${String(i).padStart(2, "0")}`, {
        signature: `export function handler${String(i).padStart(2, "0")}(input: Request): Response`,
      }),
    );
    const result = findSymbols(many, { name: "handler" });
    expect(result.matches).toHaveLength(60);

    const rendered = formatSymbolMatches(result, { tokenBudget: 260 });
    expect(rendered.truncated).toBe(true);
    expect(rendered.shown).toBeGreaterThan(0);
    expect(rendered.shown).toBeLessThan(60);
    expect(rendered.shown + rendered.omitted).toBe(60);
    expect(rendered.text).toContain(`… ${rendered.omitted} more definitions not shown`);
    expect(rendered.text).toContain("60 matched in total");
    expect(rendered.text).toContain("60 definitions in 1 file");
  });

  it("renders at least one row even when one row exceeds the whole budget", () => {
    const huge = chunk("src/very/long/path/to/a/module/with/a/long/name.ts", 1, "function", "fn", {
      signature: `export function fn(${"parameter: SomeVeryLongTypeName, ".repeat(8)}): void`,
    });
    const rendered = formatSymbolMatches(
      findSymbols([huge, chunk("src/a.ts", 2, "function", "fn2")], { name: "fn" }),
      { tokenBudget: 120 },
    );
    expect(rendered.shown).toBe(1);
    expect(rendered.omitted).toBe(1);
    expect(rendered.text).toContain("… 1 more definition not shown");
  });

  it("declares the indexed code files that yielded no declarations", () => {
    const chunks: CodeChunk[] = [
      chunk("src/a.ts", 1, "function", "parse"),
      chunk("src/mystery.ts", 1, "file", "mystery", { endLine: 40 }),
      // A JSON file is not a parse failure: its language has no declaration rules.
      chunk("data/config.json", 1, "file", "config", { language: "text", endLine: 12 }),
    ];
    const result = findSymbols(chunks, { name: "parse" });
    expect(result.unparsedFiles).toEqual(["src/mystery.ts"]);
    expect(formatSymbolMatches(result).text).toContain(
      "Not covered: 1 indexed code file yielded no parsed declarations (src/mystery.ts)",
    );
  });

  it("suggests the next move when nothing matched", () => {
    const rendered = formatSymbolMatches(
      findSymbols([chunk("src/a.ts", 1, "function", "parse")], { name: "nope", exact: true }),
    );
    expect(rendered.text).toContain('No indexed definition named "nope"');
    expect(rendered.text).toContain("exact:false");
    expect(rendered.text).toContain("search_code");
    expect(rendered.text).toContain("grep");
  });
});

// ---------------------------------------------------------------------------
// Occurrence scanning
// ---------------------------------------------------------------------------

describe("scanOccurrences", () => {
  it("classifies code, comment and string occurrences of the same identifier", () => {
    const source = [
      "// charge is documented here",
      'const label = "charge";',
      "charge(1);",
      "/* block mentioning charge */",
      // Built by concatenation so the fixture does not itself contain `${`.
      `const t = \`template $${"{charge}"} and charge text\`;`,
    ].join("\n");
    const found = scanOccurrences(source, "charge", "typescript");
    expect(found.map((o) => `${o.line}:${o.context}`)).toEqual([
      "1:comment",
      "2:string",
      "3:code",
      "4:comment",
      // A template interpolation sits inside the literal as far as the masking
      // pass is concerned, so it lands in the *unresolved* half instead of
      // being reported as a resolved reference. Conservative on purpose: the
      // occurrence is still counted, only less precisely attributed.
      "5:string",
      "5:string",
    ]);
  });

  it("matches whole words only, and case-sensitively", () => {
    const source = ["user();", "users();", "getUser();", "User();", "my_user();"].join("\n");
    expect(scanOccurrences(source, "user", "typescript").map((o) => o.line)).toEqual([1]);
  });

  it("finds every occurrence on one line, with distinct columns", () => {
    const found = scanOccurrences("charge(charge(charge()));", "charge", "typescript");
    expect(found).toHaveLength(3);
    expect(found.map((o) => o.column)).toEqual([1, 8, 15]);
  });

  it("treats prose files as code, since they have no comment syntax", () => {
    expect(scanOccurrences("The charge method.", "charge", "markdown")[0]?.context).toBe("code");
  });

  it("builds a boundary-safe pattern even for punctuated names", () => {
    expect(wholeWordPattern("a.b").test("x a.b y")).toBe(true);
    expect(wholeWordPattern("a.b").test("xa.by")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// find_references — the resolved / unresolved split
// ---------------------------------------------------------------------------

describe("findReferences", () => {
  it("splits occurrences into resolved and unresolved, naming the enclosing symbol", async () => {
    repo = await createTempRepo(REPO);
    const indexRoot = await createTempIndexDir();
    indexRoots.push(indexRoot);
    const { findSymbol } = createStructuralTools({ indexRoot });
    // Warm the index through the tool, then use the same store for the raw call.
    await findSymbol.execute({ name: "TokenBucket" }, createFakeContext(repo.root));

    const store = await CodeIndexStore.open(indexDirFor(indexRoot, repo.root), repo.root);
    const result = await findReferences({
      root: repo.root,
      chunks: store.allChunks(),
      name: "tryConsume",
    });

    const resolved = result.resolved.map((r) => `${r.file}:${r.line}:${r.symbol}`);
    expect(resolved).toContain("src/rate-limit.ts:5:TokenBucket.tryConsume");
    expect(resolved).toContain("src/rate-limit.ts:11:tryConsumeAll");
    expect(resolved).toContain("docs/limits.md:3:Limits");

    const unresolved = result.unresolved.map((r) => `${r.file}:${r.line}:${r.reason}`);
    expect(unresolved).toContain("src/broken.ts:1:unparsed-file");
    expect(unresolved).toContain("src/other.ts:5:comment");
    expect(unresolved).toContain("src/other.ts:6:string");

    // The declaration itself is a resolved occurrence, flagged as such.
    const definition = result.resolved.find((r) => r.line === 5 && r.file === "src/rate-limit.ts");
    expect(definition?.definition).toBe(true);
    expect(result.resolved.filter((r) => r.definition)).toHaveLength(1);
  });

  it("puts an unparseable file's symbols in the unresolved count rather than losing them", async () => {
    const chunks = [chunk("src/broken.ts", 1, "file", "broken", { endLine: 3 })];
    repo = await createTempRepo({
      "src/broken.ts": ["mystery(((( unbalanced", "  <<< junk >>>", "  mystery again", ""].join(
        "\n",
      ),
    });
    const result = await findReferences({ root: repo.root, chunks, name: "mystery" });
    expect(result.resolved).toEqual([]);
    expect(result.unresolved.map((r) => `${r.line}:${r.reason}`)).toEqual([
      "1:unparsed-file",
      "3:unparsed-file",
    ]);
  });

  it("calls code outside any declaration file-scope, not unparsed", async () => {
    repo = await createTempRepo({
      "src/a.ts": [
        'import { thing } from "./b.js";',
        "",
        "export function use() {",
        "  return thing;",
        "}",
        "",
      ].join("\n"),
    });
    const chunks = [chunk("src/a.ts", 3, "function", "use", { endLine: 5 })];
    const result = await findReferences({ root: repo.root, chunks, name: "thing" });
    expect(result.unresolved.map((r) => `${r.line}:${r.reason}`)).toEqual(["1:file-scope"]);
    expect(result.resolved.map((r) => `${r.line}:${r.symbol}`)).toEqual(["4:use"]);
  });

  it("restricts to a path filter without changing how the rest is classified", async () => {
    repo = await createTempRepo(REPO);
    const chunks = [
      chunk("src/rate-limit.ts", 2, "class", "TokenBucket", { endLine: 8 }),
      chunk("src/other.ts", 4, "function", "tryConsumeAll", { endLine: 8 }),
    ];
    const scoped = await findReferences({
      root: repo.root,
      chunks,
      name: "TokenBucket",
      path: "src/other.ts",
    });
    expect(scoped.filesSearched).toBe(1);
    expect(new Set(scoped.resolved.map((r) => r.file))).toEqual(new Set(["src/other.ts"]));
  });

  it("counts files it could not read instead of failing", async () => {
    repo = await createTempRepo({ "src/a.ts": "export const x = 1;\n" });
    const chunks = [
      chunk("src/a.ts", 1, "const", "x"),
      chunk("src/gone.ts", 1, "const", "x", { file: "src/gone.ts" }),
    ];
    const result = await findReferences({ root: repo.root, chunks, name: "x" });
    expect(result.filesUnreadable).toBe(1);
    expect(result.resolved).toHaveLength(1);
  });

  it("stops at the file cap and says how many files it never read", async () => {
    repo = await createTempRepo({
      "a.ts": "export const target = 1;\n",
      "b.ts": "export const target = 2;\n",
      "c.ts": "export const target = 3;\n",
    });
    const chunks = [
      chunk("a.ts", 1, "const", "target"),
      chunk("b.ts", 1, "const", "target"),
      chunk("c.ts", 1, "const", "target"),
    ];
    const result = await findReferences({ root: repo.root, chunks, name: "target", maxFiles: 2 });
    expect(result.filesSearched).toBe(2);
    expect(result.filesNotSearched).toBe(1);
    expect(result.capped).toBe(true);
    expect(formatReferences(result).text).toContain("1 more not searched (cap reached)");
  });
});

// ---------------------------------------------------------------------------
// find_references — rendering
// ---------------------------------------------------------------------------

describe("formatReferences", () => {
  const result = {
    name: "charge",
    resolved: [
      {
        file: "src/a.ts",
        line: 4,
        column: 3,
        symbol: "Gateway.charge",
        kind: "method" as ChunkKind,
        definition: true,
        text: "charge(amount: number): boolean {",
      },
      {
        file: "src/b.ts",
        line: 9,
        column: 10,
        symbol: "run",
        kind: "function" as ChunkKind,
        definition: false,
        text: "return charge(1);",
      },
    ],
    unresolved: [
      {
        file: "src/b.ts",
        line: 2,
        column: 20,
        reason: "string" as const,
        text: 'const key = "charge";',
      },
    ],
    filesWithReferences: 2,
    filesSearched: 12,
    filesUnreadable: 0,
    filesNotSearched: 0,
    capped: false,
  };

  it("states both counts in the first line, in the mandated shape", () => {
    const [header] = formatReferences(result).text.split("\n");
    expect(header).toBe("charge: 2 references in 2 files · 1 textual occurrence not attributed");
  });

  it("states a zero unresolved count just as explicitly", () => {
    const clean = { ...result, unresolved: [] };
    expect(formatReferences(clean).text.split("\n")[0]).toBe(
      "charge: 2 references in 2 files · 0 textual occurrences not attributed",
    );
  });

  it("marks the declaration, names the enclosing symbol, and groups by file", () => {
    const text = formatReferences(result).text;
    expect(text).toContain("src/a.ts\n  :4  Gateway.charge (method) [def]");
    expect(text).toContain("src/b.ts\n  :9  run (function)  return charge(1);");
    expect(text).toContain("Not attributed (1) — the index cannot name an owner:");
    expect(text).toContain("src/b.ts:2  string literal");
  });

  it("always closes with the fallback that keeps the agent looking", () => {
    const text = formatReferences(result).text;
    expect(text).toContain("Searched 12 indexed files.");
    expect(text).toContain("Dynamic dispatch, reflection and string-keyed calls are invisible");
    expect(text).toContain('grep for "charge"');
  });

  it("reserves budget for the unresolved list so clean references cannot crowd it out", () => {
    const many = {
      ...result,
      resolved: Array.from({ length: 400 }, (_, i) => ({
        file: `src/file${i}.ts`,
        line: i + 1,
        column: 1,
        symbol: `handler${i}`,
        kind: "function" as ChunkKind,
        definition: false,
        text: "return charge(1);",
      })),
      unresolved: Array.from({ length: 6 }, (_, i) => ({
        file: `src/dyn${i}.ts`,
        line: i + 1,
        column: 1,
        reason: "string" as const,
        text: 'table["charge"]();',
      })),
      filesWithReferences: 400,
    };
    const rendered = formatReferences(many, { tokenBudget: 700 });
    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain("Not attributed (6)");
    expect(rendered.text).toContain("src/dyn0.ts:1  string literal");
    expect(rendered.text).toMatch(/… \d+ more references not listed/);
    // Counts survive truncation intact.
    expect(rendered.text.split("\n")[0]).toContain("400 references in 400 files · 6 textual");
  });

  it("says so plainly when there is no occurrence at all", () => {
    const empty = {
      ...result,
      resolved: [],
      unresolved: [],
      filesWithReferences: 0,
    };
    const text = formatReferences(empty).text;
    expect(text).toContain(
      "charge: 0 references in 0 files · 0 textual occurrences not attributed",
    );
    expect(text).toContain("whole-word and case-sensitive");
  });
});

// ---------------------------------------------------------------------------
// The tools end to end
// ---------------------------------------------------------------------------

describe("find_symbol — execution", () => {
  it("indexes the working directory on first use and returns addresses", async () => {
    const { findSymbol, root } = await setup();
    const result = await findSymbol.execute({ name: "TokenBucket" }, createFakeContext(root));
    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toContain("src/rate-limit.ts:2  class TokenBucket");
    expect(text).not.toContain("return n <= this.capacity");
    expect(result.details).toMatchObject({ matchCount: 1, files: 1, exhaustive: true });
  });

  it("returns both definitions of a name that exists in two files", async () => {
    const { findSymbol, root } = await setup();
    const text = resultText(
      await findSymbol.execute({ name: "tryConsumeAll", exact: true }, createFakeContext(root)),
    );
    expect(text).toContain("tryConsumeAll: 2 definitions in 2 files");
    expect(text).toContain("src/other.ts:4");
    expect(text).toContain("src/rate-limit.ts:10");
  });

  it("honours the kind filter", async () => {
    const { findSymbol, root } = await setup();
    const text = resultText(
      await findSymbol.execute({ name: "tryConsume", kind: "method" }, createFakeContext(root)),
    );
    expect(text).toContain("src/rate-limit.ts:5  method TokenBucket.tryConsume");
    expect(text).not.toContain("src/rate-limit.ts:10");
  });

  it("rejects an empty name and an aborted context", async () => {
    const { findSymbol, root } = await setup();
    const empty = await findSymbol.execute({ name: "  " }, createFakeContext(root));
    expect(empty.isError).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const aborted = await findSymbol.execute(
      { name: "TokenBucket" },
      createFakeContext(root, controller.signal),
    );
    expect(aborted.isError).toBe(true);
    expect(resultText(aborted)).toContain("Aborted");
  });
});

describe("find_references — execution", () => {
  it("reports the resolved and unresolved counts for a real repository", async () => {
    const { references, root } = await setup();
    const result = await references.execute({ name: "tryConsume" }, createFakeContext(root));
    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toMatch(
      /^tryConsume: \d+ references in \d+ files · \d+ textual occurrences not attributed/,
    );
    expect(text).toContain("TokenBucket.tryConsume (method) [def]");
    expect(text).toContain("Not attributed");
    expect(text).toContain("file not parsed");
    expect(result.details).toMatchObject({ definitions: 1 });
    const details = result.details as { references: number; unresolved: number };
    expect(details.references).toBeGreaterThan(0);
    expect(details.unresolved).toBeGreaterThan(0);
  });

  it("scopes to a path", async () => {
    const { references, root } = await setup();
    const text = resultText(
      await references.execute(
        { name: "tryConsume", path: "src/other.ts" },
        createFakeContext(root),
      ),
    );
    expect(text).toContain("Searched 1 indexed file.");
    expect(text).not.toContain("src/rate-limit.ts");
  });

  it("rejects an empty name and an aborted context", async () => {
    const { references, root } = await setup();
    expect((await references.execute({ name: "" }, createFakeContext(root))).isError).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const aborted = await references.execute(
      { name: "tryConsume" },
      createFakeContext(root, controller.signal),
    );
    expect(aborted.isError).toBe(true);
  });
});

describe("createStructuralTools", () => {
  it("builds both tools over one shared index service", async () => {
    repo = await createTempRepo(REPO);
    const indexRoot = await createTempIndexDir();
    indexRoots.push(indexRoot);
    const service = new CodeIndexService({ indexRoot });
    const tools = createStructuralTools({ indexRoot, service });

    expect(tools.findSymbol.definition.name).toBe("find_symbol");
    expect(tools.findReferences.definition.name).toBe("find_references");

    await tools.findSymbol.execute({ name: "TokenBucket" }, createFakeContext(repo.root));
    // The second tool sees the index the first one warmed.
    const store = await service.storeFor(repo.root);
    expect(store.chunkCount).toBeGreaterThan(0);
    const text = resultText(
      await tools.findReferences.execute({ name: "TokenBucket" }, createFakeContext(repo.root)),
    );
    expect(text).toContain("references in");
  });
});
