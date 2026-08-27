/**
 * The structural oracle suite.
 *
 * This is the file that makes the word "exhaustive" in `find_symbol`'s and
 * `find_references`' descriptions a checkable claim rather than a boast.
 *
 * ## Why an oracle, and why here
 *
 * Retrieval splits into two epistemic categories. Conceptual queries ("where do
 * we handle retries") top out around HitFile 0.65–0.85 and cannot be scored
 * without a model in the loop. Symbol and literal queries have a **closed,
 * enumerable, machine-checkable answer set** — so 100% is real there, and it is
 * provable in CI, deterministically, in milliseconds, with no LLM and no
 * network. That is what this file does.
 *
 * ## The triangle
 *
 * Ground truth is asserted three ways, and all three must agree:
 *
 * 1. **Hand-enumerated tables** ({@link HAND_DEFINITIONS},
 *    {@link HAND_REFERENCES}) — written by reading the fixture corpus, not
 *    generated from anything. If the index and the second implementation ever
 *    share a bug, the hand table still disagrees with both.
 * 2. **An independent scanner** ({@link oracleDefinitions},
 *    {@link oracleOccurrences}) — a deliberately dumber, line-anchored regex
 *    pass written from the languages' own rules, sharing no code with
 *    `chunker.ts`, `scanner.ts`, `language.ts` or `mask.ts`. It regenerates the
 *    tables, so the tables cannot silently rot as the corpus changes.
 * 3. **The tools' own output** — compared to both by **exact set equality**,
 *    for every symbol in the corpus.
 *
 * Plus a fourth, deliberately trivial check that needs no notion of syntax at
 * all: a five-line whole-word regex counts every textual occurrence of a name,
 * and `resolved.length + unresolved.length` must equal it exactly. That is the
 * "nothing ever vanishes" guarantee, and it is the one assertion that cannot be
 * fooled by a shared misunderstanding of what a declaration is.
 *
 * ## What the corpus deliberately contains
 *
 * - nested / containered symbols (`PaymentDispatcher.dispatch`, `Ledger.record`)
 * - the same name defined in two different files (`processPayment`)
 * - a symbol that appears **only inside a comment** (`GhostRecord`) and must
 *   never be counted as a definition
 * - symbols inside **string literals** (`"processPayment"`, `"PaymentGateway"`)
 * - a file the parser **cannot handle** (`src/broken.ts`), whose occurrences
 *   must show up in the *unresolved* count rather than disappearing
 * - two languages, so the guarantee is not a property of one rule table
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexRepo } from "./indexer.js";
import { CodeIndexStore } from "./store.js";
import { findReferences, findSymbols } from "./structural.js";
import { createTempRepo, type TempRepo } from "./test-helpers/fixtures.js";
import type { CodeChunk } from "./types.js";

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * The fixture tree, small enough to hold in your head and to enumerate by hand.
 *
 * Written as string constants rather than files on disk on purpose: files under
 * `src/` would be compiled by `tsc -p tsconfig.json`, and `src/broken.ts` is
 * deliberately not valid TypeScript. Apostrophes are avoided throughout, so no
 * masker has to decide whether one opens a character literal.
 */
const CORPUS: Readonly<Record<string, string>> = {
  "src/payments.ts": [
    "/**", //                                                                1
    " * Payment processing.", //                                             2
    " *", //                                                                 3
    " * Historical note: class GhostRecord was removed in v2.", //           4
    " */", //                                                                5
    "", //                                                                   6
    "export const RETRY_LIMIT = 3;", //                                      7
    "", //                                                                   8
    "/** Charge a card. */", //                                              9
    "export function processPayment(amount: number): boolean {", //         10
    "  return amount > 0 && amount < RETRY_LIMIT;", //                      11
    "}", //                                                                 12
    "", //                                                                  13
    "/** Dispatches by name rather than by reference. */", //               14
    "export class PaymentDispatcher {", //                                  15
    "  /** The handler key: a string, so no compiler sees the edge. */", // 16
    '  readonly handler = "processPayment";', //                            17
    "", //                                                                  18
    "  dispatch(amount: number): boolean {", //                             19
    "    // processPayment is reached reflectively below.", //               20
    "    const table: Record<string, (n: number) => boolean> = { processPayment };", // 21
    "    const fn = table[this.handler];", //                               22
    "    return fn ? fn(amount) : false;", //                               23
    "  }", //                                                               24
    "}", //                                                                 25
    "", //                                                                  26
  ].join("\n"),

  "src/legacy/payments.ts": [
    'import { RETRY_LIMIT } from "../payments.js";', //                       1
    "", //                                                                   2
    "/** The same name, defined a second time in a second file. */", //      3
    "export function processPayment(amount: number): boolean {", //          4
    "  return amount >= 0 && amount <= RETRY_LIMIT;", //                     5
    "}", //                                                                  6
    "", //                                                                   7
  ].join("\n"),

  "src/gateway.ts": [
    "/** The gateway contract. */", //                                       1
    "export interface PaymentGateway {", //                                  2
    "  charge(amount: number): boolean;", //                                 3
    "}", //                                                                  4
    "", //                                                                   5
    "/** The gateway name, as a string key. */", //                          6
    'export const GATEWAY_NAME = "PaymentGateway";', //                      7
    "", //                                                                   8
  ].join("\n"),

  "src/billing.py": [
    '"""Billing helpers."""', //                                             1
    "", //                                                                   2
    "", //                                                                   3
    "class Ledger:", //                                                      4
    '    """A tiny ledger."""', //                                           5
    "", //                                                                   6
    "    def record(self, amount):", //                                      7
    "        return processPayment(amount)", //                              8
    "", //                                                                   9
    "", //                                                                  10
    "def total(entries):", //                                               11
    "    return sum(entries)", //                                           12
    "", //                                                                  13
  ].join("\n"),

  // Deliberately unparseable: no declaration rule can fire, so the chunker
  // falls back to a single whole-file chunk and the two identifiers in here
  // have no symbol to belong to.
  "src/broken.ts": [
    "processPayment(((( unbalanced", //                                      1
    "  <<< this is not valid typescript >>>", //                             2
    "  processPayment again, and RETRY_LIMIT too", //                        3
    "", //                                                                   4
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Ground truth, hand-enumerated
// ---------------------------------------------------------------------------

/**
 * Every definition in {@link CORPUS}, written out by reading it.
 *
 * The identity is `file:line:kind:qualifiedName`. Note what is *absent*:
 * `GhostRecord` (comment only), `PaymentGateway` at `src/gateway.ts:7` (inside
 * a string), and anything at all from `src/broken.ts`.
 */
const HAND_DEFINITIONS: readonly string[] = [
  "src/billing.py:4:class:Ledger",
  "src/billing.py:7:method:Ledger.record",
  "src/billing.py:11:function:total",
  "src/gateway.ts:2:interface:PaymentGateway",
  "src/gateway.ts:3:method:PaymentGateway.charge",
  "src/gateway.ts:7:const:GATEWAY_NAME",
  "src/legacy/payments.ts:4:function:processPayment",
  "src/payments.ts:7:const:RETRY_LIMIT",
  "src/payments.ts:10:function:processPayment",
  "src/payments.ts:15:class:PaymentDispatcher",
  "src/payments.ts:17:property:PaymentDispatcher.handler",
  "src/payments.ts:19:method:PaymentDispatcher.dispatch",
];

/** Hand-enumerated references for the corpus' interesting names. */
const HAND_REFERENCES: Readonly<
  Record<string, { resolved: readonly string[]; unresolved: readonly string[] }>
> = {
  processPayment: {
    resolved: [
      "src/billing.py:8:Ledger.record",
      "src/legacy/payments.ts:4:processPayment:def",
      "src/payments.ts:10:processPayment:def",
      "src/payments.ts:21:PaymentDispatcher.dispatch",
    ],
    unresolved: [
      "src/broken.ts:1:unparsed-file",
      "src/broken.ts:3:unparsed-file",
      "src/payments.ts:17:string",
      "src/payments.ts:20:comment",
    ],
  },
  RETRY_LIMIT: {
    resolved: [
      "src/legacy/payments.ts:5:processPayment",
      "src/payments.ts:7:RETRY_LIMIT:def",
      "src/payments.ts:11:processPayment",
    ],
    unresolved: ["src/broken.ts:3:unparsed-file", "src/legacy/payments.ts:1:file-scope"],
  },
  // A symbol that exists only in a comment: zero references, one occurrence,
  // and it must never be reported as a definition.
  GhostRecord: {
    resolved: [],
    unresolved: ["src/payments.ts:4:comment"],
  },
  // A symbol whose second occurrence is inside a string literal — exactly what
  // string-keyed dispatch looks like, and exactly what must not be silently
  // dropped or silently promoted to a reference.
  PaymentGateway: {
    resolved: ["src/gateway.ts:2:PaymentGateway:def"],
    unresolved: ["src/gateway.ts:7:string"],
  },
};

// ---------------------------------------------------------------------------
// Ground truth, independently derived
// ---------------------------------------------------------------------------

/** A definition as the independent scanner sees it. */
interface OracleSymbol {
  file: string;
  line: number;
  endLine: number;
  kind: string;
  name: string;
  container?: string;
}

/** `Ledger.record`, or `total` at top level. */
function oracleQualified(symbol: OracleSymbol): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

/** `file:line:kind:qualifiedName` — the identity used for every set comparison. */
function oracleIdentity(symbol: OracleSymbol): string {
  return `${symbol.file}:${symbol.line}:${symbol.kind}:${oracleQualified(symbol)}`;
}

/** Which of the two masking dialects a fixture file uses. */
type OracleDialect = "ts" | "py";

function dialectOf(file: string): OracleDialect {
  return file.endsWith(".py") ? "py" : "ts";
}

/**
 * An independent masker: blank comments and/or string literals, preserving
 * every character position.
 *
 * Written from scratch as a single forward pass over the whole text — no
 * per-line state machine, no rule tables, no shared helpers with `mask.ts`. It
 * only needs to handle the constructs the corpus actually uses, which is what
 * makes it small enough to audit by eye.
 */
function oracleMask(
  source: string,
  dialect: OracleDialect,
  blank: { comments: boolean; strings: boolean },
): string[] {
  const out = [...source];
  const lineComment = dialect === "py" ? "#" : "//";
  const delimiters = dialect === "py" ? ['"""', "'''", '"', "'"] : ['"', "'", "`"];

  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  let i = 0;
  while (i < source.length) {
    if (dialect === "ts" && source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      const stop = close === -1 ? source.length : close + 2;
      if (blank.comments) blankRange(i, stop);
      i = stop;
      continue;
    }
    if (source.startsWith(lineComment, i)) {
      const newline = source.indexOf("\n", i);
      const stop = newline === -1 ? source.length : newline;
      if (blank.comments) blankRange(i, stop);
      i = stop;
      continue;
    }
    const delimiter = delimiters.find((candidate) => source.startsWith(candidate, i));
    if (delimiter) {
      let j = i + delimiter.length;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source.startsWith(delimiter, j)) {
          j += delimiter.length;
          break;
        }
        // Only triple-quoted and backtick literals may cross a line.
        if (source[j] === "\n" && delimiter.length === 1 && delimiter !== "`") break;
        j++;
      }
      const stop = Math.min(j, source.length);
      if (blank.strings) blankRange(i, stop);
      i = Math.max(stop, i + 1);
      continue;
    }
    i++;
  }
  return out.join("").split("\n");
}

/** Leading-whitespace width of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The line index of the `}` that closes a brace block opened at `start`. */
function braceEnd(code: readonly string[], start: number, indent: number): number {
  for (let j = start + 1; j < code.length; j++) {
    const line = code[j] ?? "";
    if (line.trim() === "}" && indentOf(line) === indent) return j;
  }
  return code.length - 1;
}

/** The last line index of an indentation block opened at `start`. */
function indentEnd(lines: readonly string[], start: number, indent: number): number {
  let last = start;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (line.trim().length === 0) continue;
    if (indentOf(line) <= indent) break;
    last = j;
  }
  return last;
}

const TS_MEMBER_MODIFIERS = /^(?:public |private |protected |static |readonly |abstract |async )*/;

/**
 * The independent TypeScript declaration scanner.
 *
 * Deliberately dumber than `scanner.ts`: anchored regexes on masked lines, one
 * container at a time, members recognised only at exactly two spaces of
 * indentation, and block extents found by looking for a `}` at the opener's own
 * indentation. It is right for this corpus, and it agrees with nothing by
 * construction — it was written from what TypeScript means, not from what the
 * chunker does.
 */
function oracleTypeScript(file: string, code: readonly string[]): OracleSymbol[] {
  const out: OracleSymbol[] = [];
  let container: { name: string; endLine: number } | null = null;

  for (let i = 0; i < code.length; i++) {
    const line = code[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const indent = indentOf(line);

    if (container && i > container.endLine) container = null;

    if (indent === 0) {
      container = null;
      const push = (kind: string, name: string, endLine: number): void => {
        out.push({ file, line: i + 1, endLine: endLine + 1, kind, name });
      };

      let matched = /^export (?:abstract )?class (\w+)/.exec(trimmed);
      if (matched?.[1]) {
        const end = braceEnd(code, i, 0);
        push("class", matched[1], end);
        container = { name: matched[1], endLine: end };
        continue;
      }
      matched = /^export interface (\w+)/.exec(trimmed);
      if (matched?.[1]) {
        const end = braceEnd(code, i, 0);
        push("interface", matched[1], end);
        container = { name: matched[1], endLine: end };
        continue;
      }
      matched = /^(?:export )?function (\w+)/.exec(trimmed);
      if (matched?.[1]) {
        push("function", matched[1], braceEnd(code, i, 0));
        continue;
      }
      matched = /^export type (\w+)/.exec(trimmed);
      if (matched?.[1]) {
        push("type", matched[1], i);
        continue;
      }
      matched = /^export (?:const|let|var) (\w+)\s*=\s*(.*)$/.exec(trimmed);
      if (matched?.[1]) {
        const rhs = (matched[2] ?? "").trim();
        const isCallable = rhs.startsWith("(") || /^(?:async\b|function\b)/.test(rhs);
        if (isCallable) push("function", matched[1], braceEnd(code, i, 0));
        else push("const", matched[1], i);
        continue;
      }
      continue;
    }

    if (!container || indent !== 2) continue;
    const member = trimmed.replace(TS_MEMBER_MODIFIERS, "");
    let matched = /^(\w+)\s*\(/.exec(member);
    if (matched?.[1]) {
      const end = member.endsWith(";") ? i : braceEnd(code, i, 2);
      out.push({
        file,
        line: i + 1,
        endLine: end + 1,
        kind: "method",
        name: matched[1],
        container: container.name,
      });
      continue;
    }
    matched = /^(\w+)\s*\??\s*[:=]/.exec(member);
    if (matched?.[1]) {
      out.push({
        file,
        line: i + 1,
        endLine: i + 1,
        kind: "property",
        name: matched[1],
        container: container.name,
      });
    }
  }
  return out;
}

/** The independent Python declaration scanner: `class`/`def`, by indentation. */
function oraclePython(
  file: string,
  code: readonly string[],
  raw: readonly string[],
): OracleSymbol[] {
  const out: OracleSymbol[] = [];
  let container: string | null = null;

  for (let i = 0; i < code.length; i++) {
    const line = code[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const indent = indentOf(line);
    if (indent === 0) container = null;

    if (indent === 0) {
      const asClass = /^class (\w+)\s*[:(]/.exec(trimmed);
      if (asClass?.[1]) {
        out.push({
          file,
          line: i + 1,
          endLine: indentEnd(raw, i, 0) + 1,
          kind: "class",
          name: asClass[1],
        });
        container = asClass[1];
        continue;
      }
      const asFunction = /^(?:async )?def (\w+)/.exec(trimmed);
      if (asFunction?.[1]) {
        out.push({
          file,
          line: i + 1,
          endLine: indentEnd(raw, i, 0) + 1,
          kind: "function",
          name: asFunction[1],
        });
      }
      continue;
    }

    if (indent !== 4 || !container) continue;
    const asMethod = /^(?:async )?def (\w+)/.exec(trimmed);
    if (asMethod?.[1]) {
      out.push({
        file,
        line: i + 1,
        endLine: indentEnd(raw, i, 4) + 1,
        kind: "method",
        name: asMethod[1],
        container,
      });
    }
  }
  return out;
}

/** Every definition in one fixture file, derived independently of the index. */
function oracleDefinitions(file: string, source: string): OracleSymbol[] {
  const dialect = dialectOf(file);
  const code = oracleMask(source, dialect, { comments: true, strings: true });
  const raw = source.split("\n");
  return dialect === "py" ? oraclePython(file, code, raw) : oracleTypeScript(file, code);
}

/** Every definition in the whole corpus, sorted by identity. */
function oracleCorpusDefinitions(): OracleSymbol[] {
  const out: OracleSymbol[] = [];
  for (const [file, source] of Object.entries(CORPUS)) out.push(...oracleDefinitions(file, source));
  return out.sort((a, b) => (oracleIdentity(a) < oracleIdentity(b) ? -1 : 1));
}

/** Escape a name for use inside a regular expression. */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The trivial authority: how many whole-word occurrences of `name` exist in the
 * corpus, counted by one regex that knows nothing about syntax.
 *
 * `resolved + unresolved` must equal this, always. It is the assertion that
 * catches a symbol silently vanishing, and no amount of shared misunderstanding
 * between the index and the scanner above can make it pass wrongly.
 */
function rawOccurrenceCount(name: string): number {
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`, "g");
  let total = 0;
  for (const source of Object.values(CORPUS)) total += (source.match(pattern) ?? []).length;
  return total;
}

/** One occurrence as the independent implementation classifies it. */
interface OracleOccurrence {
  file: string;
  line: number;
  resolvedTo: string | null;
  definition: boolean;
  reason: "comment" | "string" | "file-scope" | "unparsed-file" | null;
}

/** Every occurrence of `name` in the corpus, classified and attributed independently. */
function oracleOccurrences(name: string): OracleOccurrence[] {
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`, "g");
  const out: OracleOccurrence[] = [];

  for (const file of Object.keys(CORPUS).sort()) {
    const source = CORPUS[file] ?? "";
    const dialect = dialectOf(file);
    const codeMask = oracleMask(source, dialect, { comments: true, strings: true });
    const stringMask = oracleMask(source, dialect, { comments: true, strings: false });
    const symbols = oracleDefinitions(file, source);
    const declarationLines = new Set(symbols.filter((s) => s.name === name).map((s) => s.line));
    const lines = source.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      pattern.lastIndex = 0;
      let match = pattern.exec(raw);
      while (match !== null) {
        const column = match.index;
        const inCode = (codeMask[i] ?? "").startsWith(name, column);
        const inString = !inCode && (stringMask[i] ?? "").startsWith(name, column);
        const line = i + 1;

        let enclosing: OracleSymbol | undefined;
        if (inCode) {
          for (const symbol of symbols) {
            if (symbol.line > line || symbol.endLine < line) continue;
            if (!enclosing || symbol.line > enclosing.line) enclosing = symbol;
          }
        }

        out.push({
          file,
          line,
          resolvedTo: enclosing ? oracleQualified(enclosing) : null,
          definition: enclosing !== undefined && declarationLines.has(line),
          reason: enclosing
            ? null
            : inCode
              ? symbols.length > 0
                ? "file-scope"
                : "unparsed-file"
              : inString
                ? "string"
                : "comment",
        });
        match = pattern.exec(raw);
      }
    }
  }
  return out;
}

/** `file:line:symbol[:def]` for a resolved occurrence, the comparison identity. */
function resolvedIdentity(occurrence: OracleOccurrence): string {
  return `${occurrence.file}:${occurrence.line}:${occurrence.resolvedTo}${
    occurrence.definition ? ":def" : ""
  }`;
}

/** `file:line:reason` for an unresolved occurrence. */
function unresolvedIdentity(occurrence: OracleOccurrence): string {
  return `${occurrence.file}:${occurrence.line}:${occurrence.reason}`;
}

// ---------------------------------------------------------------------------
// The index under test
// ---------------------------------------------------------------------------

let repo: TempRepo;
let indexDir: string;
let chunks: readonly CodeChunk[];

beforeAll(async () => {
  repo = await createTempRepo(CORPUS as Record<string, string>);
  indexDir = await mkdtemp(join(tmpdir(), "arcturn-oracle-"));
  const store = await CodeIndexStore.open(indexDir, repo.root);
  await indexRepo({ root: repo.root, store });
  chunks = store.allChunks();
});

afterAll(async () => {
  await repo?.cleanup();
  if (indexDir) await rm(indexDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** Every indexed definition, as `file:line:kind:qualifiedName`. */
function indexedDefinitions(): string[] {
  return chunks
    .filter((chunk) => chunk.kind !== "file")
    .map(
      (chunk) =>
        `${chunk.file}:${chunk.startLine}:${chunk.kind}:` +
        `${chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name}`,
    )
    .sort();
}

/** The distinct symbol names the oracle knows about, plus the comment-only ghost. */
function everyName(): string[] {
  const names = new Set(oracleCorpusDefinitions().map((symbol) => symbol.name));
  for (const name of Object.keys(HAND_REFERENCES)) names.add(name);
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// 1. The independent scanner agrees with the hand-written table
// ---------------------------------------------------------------------------

describe("oracle — the ground truth agrees with itself", () => {
  it("the independent scanner reproduces the hand-enumerated definition set exactly", () => {
    expect(oracleCorpusDefinitions().map(oracleIdentity)).toEqual([...HAND_DEFINITIONS].sort());
  });

  it("the independent occurrence pass reproduces the hand-enumerated references exactly", () => {
    for (const [name, expected] of Object.entries(HAND_REFERENCES)) {
      const occurrences = oracleOccurrences(name);
      expect(
        occurrences.filter((o) => o.resolvedTo !== null).map(resolvedIdentity),
        `resolved occurrences of ${name}`,
      ).toEqual([...expected.resolved]);
      expect(
        occurrences.filter((o) => o.resolvedTo === null).map(unresolvedIdentity),
        `unresolved occurrences of ${name}`,
      ).toEqual([...expected.unresolved]);
    }
  });

  it("the trivial regex authority agrees with the classified occurrence count", () => {
    for (const name of everyName()) {
      expect(oracleOccurrences(name), `occurrence count for ${name}`).toHaveLength(
        rawOccurrenceCount(name),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. find_symbol is exhaustive: exact set equality, every symbol
// ---------------------------------------------------------------------------

describe("oracle — find_symbol is exhaustive over indexed definitions", () => {
  it("the index's whole definition set equals the independently derived one", () => {
    expect(indexedDefinitions()).toEqual(oracleCorpusDefinitions().map(oracleIdentity));
  });

  it("the index's whole definition set equals the hand-enumerated one", () => {
    expect(indexedDefinitions()).toEqual([...HAND_DEFINITIONS].sort());
  });

  it("returns exactly the ground-truth definitions for EVERY symbol in the corpus", () => {
    const truth = oracleCorpusDefinitions();
    for (const name of everyName()) {
      const expected = truth
        .filter((symbol) => symbol.name === name)
        .map(oracleIdentity)
        .sort();
      const actual = findSymbols(chunks, { name, exact: true })
        .matches.map(
          ({ chunk }) =>
            `${chunk.file}:${chunk.startLine}:${chunk.kind}:` +
            `${chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name}`,
        )
        .sort();
      expect(actual, `definitions of ${name}`).toEqual(expected);
    }
  });

  it("finds both definitions when one name is defined in two files", () => {
    const result = findSymbols(chunks, { name: "processPayment", exact: true });
    expect(result.matches).toHaveLength(2);
    expect(result.files).toBe(2);
    expect(result.matches.map((m) => m.chunk.file)).toEqual([
      "src/legacy/payments.ts",
      "src/payments.ts",
    ]);
  });

  it("a symbol that appears only in a comment is NOT a definition", () => {
    expect(findSymbols(chunks, { name: "GhostRecord", exact: true }).matches).toEqual([]);
    expect(findSymbols(chunks, { name: "GhostRecord" }).matches).toEqual([]);
    // …and the corpus really does mention it, so the assertion is not vacuous.
    expect(rawOccurrenceCount("GhostRecord")).toBe(1);
  });

  it("a symbol that appears only inside a string is NOT a second definition", () => {
    const gateway = findSymbols(chunks, { name: "PaymentGateway", exact: true });
    expect(gateway.matches.map((m) => `${m.chunk.file}:${m.chunk.startLine}`)).toEqual([
      "src/gateway.ts:2",
    ]);
    expect(rawOccurrenceCount("PaymentGateway")).toBe(2);
  });

  it("declares the unparseable file rather than pretending it has no symbols", () => {
    expect(findSymbols(chunks, { name: "processPayment" }).unparsedFiles).toEqual([
      "src/broken.ts",
    ]);
  });

  it("prefix matching stays exhaustive: every definition whose name starts with the query", () => {
    const truth = oracleCorpusDefinitions()
      .filter((symbol) => symbol.name.toLowerCase().startsWith("payment"))
      .map(oracleIdentity)
      .sort();
    const actual = findSymbols(chunks, { name: "Payment" })
      .matches.map(
        ({ chunk }) =>
          `${chunk.file}:${chunk.startLine}:${chunk.kind}:` +
          `${chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name}`,
      )
      .sort();
    expect(actual).toEqual(truth);
    expect(actual.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. find_references is exhaustive, and honest about what it cannot attribute
// ---------------------------------------------------------------------------

describe("oracle — find_references is exhaustive and declares its gaps", () => {
  it("nothing ever vanishes: resolved + unresolved equals the raw occurrence count", async () => {
    for (const name of everyName()) {
      const result = await findReferences({ root: repo.root, chunks, name });
      expect(
        result.resolved.length + result.unresolved.length,
        `total occurrences of ${name}`,
      ).toBe(rawOccurrenceCount(name));
    }
  });

  it("matches the independently derived resolved set exactly, for EVERY symbol", async () => {
    for (const name of everyName()) {
      const truth = oracleOccurrences(name)
        .filter((o) => o.resolvedTo !== null)
        .map(resolvedIdentity);
      const result = await findReferences({ root: repo.root, chunks, name });
      const actual = result.resolved.map(
        (reference) =>
          `${reference.file}:${reference.line}:${reference.symbol}` +
          `${reference.definition ? ":def" : ""}`,
      );
      expect(actual, `resolved references to ${name}`).toEqual(truth);
    }
  });

  it("matches the independently derived unresolved set exactly, for EVERY symbol", async () => {
    for (const name of everyName()) {
      const truth = oracleOccurrences(name)
        .filter((o) => o.resolvedTo === null)
        .map(unresolvedIdentity);
      const result = await findReferences({ root: repo.root, chunks, name });
      const actual = result.unresolved.map(
        (reference) => `${reference.file}:${reference.line}:${reference.reason}`,
      );
      expect(actual, `unresolved occurrences of ${name}`).toEqual(truth);
    }
  });

  it("matches the hand-enumerated tables for the corpus' interesting names", async () => {
    for (const [name, expected] of Object.entries(HAND_REFERENCES)) {
      const result = await findReferences({ root: repo.root, chunks, name });
      expect(
        result.resolved.map((r) => `${r.file}:${r.line}:${r.symbol}${r.definition ? ":def" : ""}`),
        `resolved references to ${name}`,
      ).toEqual([...expected.resolved]);
      expect(
        result.unresolved.map((r) => `${r.file}:${r.line}:${r.reason}`),
        `unresolved occurrences of ${name}`,
      ).toEqual([...expected.unresolved]);
    }
  });

  it("puts the unparseable file's symbols in the unresolved count, not nowhere", async () => {
    const result = await findReferences({ root: repo.root, chunks, name: "processPayment" });
    const fromBroken = result.unresolved.filter((r) => r.file === "src/broken.ts");
    expect(fromBroken.map((r) => `${r.line}:${r.reason}`)).toEqual([
      "1:unparsed-file",
      "3:unparsed-file",
    ]);
    expect(result.resolved.some((r) => r.file === "src/broken.ts")).toBe(false);
  });

  it("reports the comment-only symbol as an occurrence with zero references", async () => {
    const result = await findReferences({ root: repo.root, chunks, name: "GhostRecord" });
    expect(result.resolved).toEqual([]);
    expect(result.filesWithReferences).toBe(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.reason).toBe("comment");
  });

  it("reports a string-literal occurrence as unattributed, never as a reference", async () => {
    const result = await findReferences({ root: repo.root, chunks, name: "PaymentGateway" });
    expect(result.unresolved.map((r) => `${r.file}:${r.line}:${r.reason}`)).toEqual([
      "src/gateway.ts:7:string",
    ]);
  });

  it("attributes a reference to the innermost enclosing symbol, not the outer container", async () => {
    const result = await findReferences({ root: repo.root, chunks, name: "processPayment" });
    const inDispatch = result.resolved.find((r) => r.line === 21 && r.file === "src/payments.ts");
    expect(inDispatch?.symbol).toBe("PaymentDispatcher.dispatch");
    expect(inDispatch?.kind).toBe("method");
    // `Ledger.record`, not `Ledger`.
    const inRecord = result.resolved.find((r) => r.file === "src/billing.py");
    expect(inRecord?.symbol).toBe("Ledger.record");
  });

  it("is deterministic: the same query twice gives byte-identical results", async () => {
    const first = await findReferences({ root: repo.root, chunks, name: "processPayment" });
    const second = await findReferences({ root: repo.root, chunks, name: "processPayment" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ---------------------------------------------------------------------------
// 4. The regression alarm
// ---------------------------------------------------------------------------

describe("oracle — the alarm", () => {
  it("fails loudly if the index ever drops a symbol", async () => {
    // Simulate the failure this suite exists to catch: a chunk quietly missing
    // from the index. Every one of the assertions above must reject it.
    const damaged = chunks.filter((chunk) => chunk.name !== "dispatch");
    expect(damaged.length).toBe(chunks.length - 1);

    const definitions = damaged
      .filter((chunk) => chunk.kind !== "file")
      .map(
        (chunk) =>
          `${chunk.file}:${chunk.startLine}:${chunk.kind}:` +
          `${chunk.container ? `${chunk.container}.${chunk.name}` : chunk.name}`,
      )
      .sort();
    expect(definitions).not.toEqual([...HAND_DEFINITIONS].sort());
    expect(findSymbols(damaged, { name: "dispatch", exact: true }).matches).toEqual([]);

    // The reference at src/payments.ts:21 loses its innermost owner and falls
    // back to the class — but it is still counted, never lost.
    const result = await findReferences({
      root: repo.root,
      chunks: damaged,
      name: "processPayment",
    });
    expect(result.resolved.length + result.unresolved.length).toBe(
      rawOccurrenceCount("processPayment"),
    );
    expect(result.resolved.find((r) => r.line === 21)?.symbol).toBe("PaymentDispatcher");
  });
});
