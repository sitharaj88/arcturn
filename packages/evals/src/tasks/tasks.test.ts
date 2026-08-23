/**
 * Proves the starter suite is honest: every task's assertions genuinely fail
 * against the unsolved fixture, and genuinely pass once the (independently
 * written, here) correct fix is applied. No agent involved — these are
 * direct filesystem checks against `setup()`'s output and each task's own
 * `assertions`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssertionResult, EvalTask } from "../task.js";
import {
  ALL_TASKS,
  asyncConcurrentTaskPool,
  asyncSingleFlightMemoize,
  catchDiscountBug,
  clampEdgeCases,
  compatDurationFormat,
  debugSharedRangeHelper,
  debugStalePriceCache,
  edgeCsvRowParser,
  edgeSumDollarsPrecision,
  edgeTruncateUnicode,
  edgeWordFrequencyUnicode,
  fixBinarySearchBug,
  fixFailingSumTest,
  handleInvalidConfig,
  multifileLibraryLoanReturn,
  perfQuadraticDuplicates,
  renameComputeTotal,
  trapDedupeKeepFirst,
} from "./index.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function materialize(task: EvalTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arcturn-evals-fixture-${task.id}-`));
  cleanupDirs.push(dir);
  await task.setup(dir);
  return dir;
}

async function gradeAll(task: EvalTask, dir: string): Promise<AssertionResult[]> {
  return Promise.all(task.assertions.map((assertion) => assertion.check(dir)));
}

async function replaceInFile(path: string, from: string, to: string): Promise<void> {
  const content = await readFile(path, "utf8");
  expect(content).toContain(from);
  await writeFile(path, content.replace(from, to), "utf8");
}

describe("starter suite tasks are honest (fail unsolved, pass once fixed)", () => {
  it("fix-failing-sum-test", async () => {
    const dir = await materialize(fixFailingSumTest);

    const before = await gradeAll(fixFailingSumTest, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    await replaceInFile(join(dir, "sum.mjs"), "return a - b;", "return a + b;");

    const after = await gradeAll(fixFailingSumTest, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("clamp-edge-cases", async () => {
    const dir = await materialize(clampEdgeCases);

    const before = await gradeAll(clampEdgeCases, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      "export function clamp(value, min, max) {",
      "  const lo = Math.min(min, max);",
      "  const hi = Math.max(min, max);",
      "  return Math.min(Math.max(value, lo), hi);",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "clamp.mjs"), solution, "utf8");

    const after = await gradeAll(clampEdgeCases, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("rename-compute-total", async () => {
    const dir = await materialize(renameComputeTotal);

    const before = await gradeAll(renameComputeTotal, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    await replaceInFile(
      join(dir, "cart.mjs"),
      "export function computeTotal(items) {",
      "export function calculateTotal(items) {",
    );
    await replaceInFile(
      join(dir, "checkout.mjs"),
      'import { computeTotal } from "./cart.mjs";',
      'import { calculateTotal } from "./cart.mjs";',
    );
    await replaceInFile(join(dir, "checkout.mjs"), "computeTotal(items)", "calculateTotal(items)");

    const after = await gradeAll(renameComputeTotal, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("fix-binary-search-bug", async () => {
    const dir = await materialize(fixBinarySearchBug);

    const before = await gradeAll(fixBinarySearchBug, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    await replaceInFile(join(dir, "search.mjs"), "while (lo < hi) {", "while (lo <= hi) {");

    const after = await gradeAll(fixBinarySearchBug, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("handle-invalid-config", async () => {
    const dir = await materialize(handleInvalidConfig);

    const before = await gradeAll(handleInvalidConfig, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      'import { readFileSync } from "node:fs";',
      "",
      "export function loadConfig(path) {",
      "  try {",
      '    const raw = readFileSync(path, "utf8");',
      "    return { ok: true, value: JSON.parse(raw) };",
      "  } catch (error) {",
      "    return { ok: false, error: error instanceof Error ? error.message : String(error) };",
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "config.mjs"), solution, "utf8");

    const after = await gradeAll(handleInvalidConfig, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("catch-discount-bug", async () => {
    const dir = await materialize(catchDiscountBug);

    // Unsolved: no test file exists yet, so at minimum fileExists must fail.
    const before = await gradeAll(catchDiscountBug, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const testFile = [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { applyDiscount } from "./discount.mjs";',
      "",
      'test("clamps the price at 0 when the discount exceeds 100 percent", () => {',
      "  assert.equal(applyDiscount(50, 150), 0);",
      "});",
      "",
      'test("a normal discount is unaffected", () => {',
      "  assert.equal(applyDiscount(200, 25), 150);",
      "});",
      "",
    ].join("\n");
    await writeFile(join(dir, "discount.test.mjs"), testFile, "utf8");

    const solution = [
      "export function applyDiscount(price, percentOff) {",
      "  const discounted = price - (price * percentOff) / 100;",
      "  return Math.max(0, discounted);",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "discount.mjs"), solution, "utf8");

    const after = await gradeAll(catchDiscountBug, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });
});

describe("expansion suite tasks are honest (fail unsolved, pass once fixed)", () => {
  it("multifile-library-loan-return", async () => {
    const dir = await materialize(multifileLibraryLoanReturn);

    const before = await gradeAll(multifileLibraryLoanReturn, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const booksSolution = [
      "const books = new Map();",
      "",
      "export function addBook(isbn, title, copies) {",
      "  books.set(isbn, { isbn, title, totalCopies: copies, available: copies });",
      "}",
      "",
      "export function getBookInfo(isbn) {",
      "  const book = books.get(isbn);",
      "  return book ? { ...book } : undefined;",
      "}",
      "",
      "export function takeCopy(isbn) {",
      "  const book = books.get(isbn);",
      "  if (!book || book.available <= 0) return false;",
      "  book.available -= 1;",
      "  return true;",
      "}",
      "",
      "export function returnCopy(isbn) {",
      "  const book = books.get(isbn);",
      "  if (!book) return false;",
      "  book.available = Math.min(book.totalCopies, book.available + 1);",
      "  return true;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "books.mjs"), booksSolution, "utf8");

    const membersSolution = [
      "const members = new Map();",
      "const MAX_ACTIVE_LOANS = 3;",
      "",
      "export function addMember(id, name) {",
      "  members.set(id, { id, name, activeLoanIsbns: [] });",
      "}",
      "",
      "export function getMemberInfo(id) {",
      "  const member = members.get(id);",
      "  return member",
      "    ? { id: member.id, name: member.name, activeLoanIsbns: [...member.activeLoanIsbns] }",
      "    : undefined;",
      "}",
      "",
      "export function hasCapacity(id) {",
      "  const member = members.get(id);",
      "  return member !== undefined && member.activeLoanIsbns.length < MAX_ACTIVE_LOANS;",
      "}",
      "",
      "export function recordLoan(id, isbn) {",
      "  const member = members.get(id);",
      "  if (!member) return false;",
      "  member.activeLoanIsbns.push(isbn);",
      "  return true;",
      "}",
      "",
      "export function hasLoan(id, isbn) {",
      "  const member = members.get(id);",
      "  return member !== undefined && member.activeLoanIsbns.includes(isbn);",
      "}",
      "",
      "export function releaseLoan(id, isbn) {",
      "  const member = members.get(id);",
      "  if (!member) return false;",
      "  const index = member.activeLoanIsbns.indexOf(isbn);",
      "  if (index === -1) return false;",
      "  member.activeLoanIsbns.splice(index, 1);",
      "  return true;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "members.mjs"), membersSolution, "utf8");

    const loansSolution = [
      'import { getBookInfo, returnCopy, takeCopy } from "./books.mjs";',
      'import { getMemberInfo, hasCapacity, hasLoan, recordLoan, releaseLoan } from "./members.mjs";',
      "",
      "export function borrowBook(memberId, isbn) {",
      "  const member = getMemberInfo(memberId);",
      "  const book = getBookInfo(isbn);",
      '  if (!member || !book) return { ok: false, error: "not found" };',
      '  if (!hasCapacity(memberId)) return { ok: false, error: "loan limit reached" };',
      '  if (!takeCopy(isbn)) return { ok: false, error: "no copies available" };',
      "  recordLoan(memberId, isbn);",
      "  return { ok: true };",
      "}",
      "",
      "export function returnBook(memberId, isbn) {",
      "  const member = getMemberInfo(memberId);",
      "  const book = getBookInfo(isbn);",
      '  if (!member || !book) return { ok: false, error: "not found" };',
      '  if (!hasLoan(memberId, isbn)) return { ok: false, error: "not on loan to this member" };',
      "  releaseLoan(memberId, isbn);",
      "  returnCopy(isbn);",
      "  return { ok: true };",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "loans.mjs"), loansSolution, "utf8");

    const after = await gradeAll(multifileLibraryLoanReturn, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("debug-stale-price-cache", async () => {
    const dir = await materialize(debugStalePriceCache);

    const before = await gradeAll(debugStalePriceCache, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      'import { invalidatePrice } from "./pricing.mjs";',
      "",
      "const prices = new Map();",
      "",
      "export function setPrice(sku, price) {",
      "  prices.set(sku, price);",
      "  invalidatePrice(sku);",
      "}",
      "",
      "export const catalog = {",
      "  lookup(sku) {",
      "    return prices.get(sku);",
      "  },",
      "};",
      "",
    ].join("\n");
    await writeFile(join(dir, "catalog.mjs"), solution, "utf8");

    const after = await gradeAll(debugStalePriceCache, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("debug-stale-price-cache: removing the cache instead of invalidating it still fails", async () => {
    // The obvious-but-wrong fix: stop caching altogether. This makes the
    // visible test pass (it only checks final values) but must still fail
    // the hidden verifier's caching invariant.
    const dir = await materialize(debugStalePriceCache);

    const noCachingPricing = [
      "export function getPrice(catalog, sku) {",
      "  return catalog.lookup(sku);",
      "}",
      "",
      "export function invalidatePrice() {}",
      "",
    ].join("\n");
    await writeFile(join(dir, "pricing.mjs"), noCachingPricing, "utf8");

    const results = await gradeAll(debugStalePriceCache, dir);
    const visibleTestsPassed = results.find((r) => r.name === "commandSucceeds(node --test)");
    expect(visibleTestsPassed?.passed).toBe(true);
    expect(results.some((r) => !r.passed)).toBe(true);
  });

  it("trap-dedupe-keep-first", async () => {
    const dir = await materialize(trapDedupeKeepFirst);

    const before = await gradeAll(trapDedupeKeepFirst, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      "export function dedupeKeepFirst(items, keyFn) {",
      "  const map = new Map();",
      "  for (const item of items) {",
      "    const key = keyFn(item);",
      "    if (!map.has(key)) map.set(key, item);",
      "  }",
      "  return [...map.values()];",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "dedupe.mjs"), solution, "utf8");

    const after = await gradeAll(trapDedupeKeepFirst, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("trap-dedupe-keep-first: reverse-iteration trap still fails", async () => {
    // Keeps the right VALUE per key but scrambles the surviving items' order.
    const dir = await materialize(trapDedupeKeepFirst);

    const trapSolution = [
      "export function dedupeKeepFirst(items, keyFn) {",
      "  const map = new Map();",
      "  for (let i = items.length - 1; i >= 0; i--) {",
      "    map.set(keyFn(items[i]), items[i]);",
      "  }",
      "  return [...map.values()];",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "dedupe.mjs"), trapSolution, "utf8");

    const results = await gradeAll(trapDedupeKeepFirst, dir);
    expect(results.some((r) => !r.passed)).toBe(true);
  });

  it("async-concurrent-task-pool", async () => {
    const dir = await materialize(asyncConcurrentTaskPool);

    const before = await gradeAll(asyncConcurrentTaskPool, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    await replaceInFile(
      join(dir, "pool.mjs"),
      "results.push(await tasks[current]());",
      "results[current] = await tasks[current]();",
    );

    const after = await gradeAll(asyncConcurrentTaskPool, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("compat-duration-format", async () => {
    const dir = await materialize(compatDurationFormat);

    const before = await gradeAll(compatDurationFormat, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = `export function formatDuration(ms, options = {}) {
  const { compact = false } = options;
  const totalSeconds = Math.floor(ms / 1000);

  if (compact) {
    if (ms >= 3600000) return \`\${(ms / 3600000).toFixed(1)}h\`;
    if (ms >= 60000) return \`\${(ms / 60000).toFixed(1)}m\`;
    return \`\${(ms / 1000).toFixed(1)}s\`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(\`\${hours}h\`);
  if (hours > 0 || minutes > 0) parts.push(\`\${minutes}m\`);
  parts.push(\`\${seconds}s\`);
  return parts.join(" ");
}
`;
    await writeFile(join(dir, "duration.mjs"), solution, "utf8");

    const after = await gradeAll(compatDurationFormat, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("perf-quadratic-duplicates", async () => {
    const dir = await materialize(perfQuadraticDuplicates);

    const before = await gradeAll(perfQuadraticDuplicates, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      "export function findDuplicates(arr) {",
      "  const counts = new Map();",
      "  for (const value of arr) counts.set(value, (counts.get(value) ?? 0) + 1);",
      "  const added = new Set();",
      "  const dupes = [];",
      "  for (const value of arr) {",
      "    if (counts.get(value) > 1 && !added.has(value)) {",
      "      dupes.push(value);",
      "      added.add(value);",
      "    }",
      "  }",
      "  return dupes;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "duplicates.mjs"), solution, "utf8");

    const after = await gradeAll(perfQuadraticDuplicates, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  }, 30_000);

  it("edge-truncate-unicode", async () => {
    const dir = await materialize(edgeTruncateUnicode);

    const before = await gradeAll(edgeTruncateUnicode, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      "export function truncateWithEllipsis(str, maxLength) {",
      "  const codePoints = Array.from(str);",
      "  if (codePoints.length <= maxLength) return str;",
      '  if (maxLength <= 0) return str.length === 0 ? "" : "…";',
      '  return codePoints.slice(0, maxLength).join("") + "…";',
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "truncate.mjs"), solution, "utf8");

    const after = await gradeAll(edgeTruncateUnicode, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("async-single-flight-memoize", async () => {
    const dir = await materialize(asyncSingleFlightMemoize);

    // Unsolved: no test file exists yet, so at minimum fileExists must fail.
    const before = await gradeAll(asyncSingleFlightMemoize, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const testFile = `import { test } from "node:test";
import assert from "node:assert/strict";
import { memoizeAsync } from "./single-flight.mjs";

test("concurrent calls for the same key are deduplicated", async () => {
  let calls = 0;
  const fn = async (key) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return \`\${key}-\${calls}\`;
  };
  const memoized = memoizeAsync(fn);
  const [a, b] = await Promise.all([memoized("x"), memoized("x")]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test("a call made after the previous one has completed calls fn again", async () => {
  let calls = 0;
  const fn = async (key) => {
    calls++;
    return \`\${key}-\${calls}\`;
  };
  const memoized = memoizeAsync(fn);
  const first = await memoized("x");
  const second = await memoized("x");
  assert.equal(calls, 2, "fn should be called again after the first call settled");
  assert.notEqual(first, second);
});
`;
    await writeFile(join(dir, "single-flight.test.mjs"), testFile, "utf8");

    const solution = [
      "export function memoizeAsync(fn) {",
      "  const inFlight = new Map();",
      "  return function memoized(key) {",
      "    if (inFlight.has(key)) return inFlight.get(key);",
      "    const promise = fn(key).finally(() => {",
      "      inFlight.delete(key);",
      "    });",
      "    inFlight.set(key, promise);",
      "    return promise;",
      "  };",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "single-flight.mjs"), solution, "utf8");

    const after = await gradeAll(asyncSingleFlightMemoize, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("async-single-flight-memoize: a test that only covers concurrent dedup does not reproduce the bug", async () => {
    const dir = await materialize(asyncSingleFlightMemoize);

    // Passes against both the buggy and the fixed implementation, so it
    // proves nothing about the "stale forever" bug.
    const shallowTestFile = `import { test } from "node:test";
import assert from "node:assert/strict";
import { memoizeAsync } from "./single-flight.mjs";

test("concurrent calls for the same key are deduplicated", async () => {
  let calls = 0;
  const fn = async (key) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return \`\${key}-\${calls}\`;
  };
  const memoized = memoizeAsync(fn);
  const [a, b] = await Promise.all([memoized("x"), memoized("x")]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});
`;
    await writeFile(join(dir, "single-flight.test.mjs"), shallowTestFile, "utf8");

    const results = await gradeAll(asyncSingleFlightMemoize, dir);
    expect(results.some((r) => !r.passed)).toBe(true);
  });

  it("debug-shared-range-helper", async () => {
    const dir = await materialize(debugSharedRangeHelper);

    const before = await gradeAll(debugSharedRangeHelper, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    await replaceInFile(
      join(dir, "range.mjs"),
      "for (let i = start; i <= end; i++)",
      "for (let i = start; i < end; i++)",
    );

    const after = await gradeAll(debugSharedRangeHelper, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("debug-shared-range-helper: a local patch in only one caller leaves the other broken", async () => {
    const dir = await materialize(debugSharedRangeHelper);

    // Masks the calendar.mjs symptom without fixing the shared range.mjs
    // bug, so pagination.mjs (and range.mjs itself) stay broken.
    await replaceInFile(
      join(dir, "calendar.mjs"),
      "return range(1, daysInMonth(year, monthIndex) + 1);",
      "return range(1, daysInMonth(year, monthIndex));",
    );

    const results = await gradeAll(debugSharedRangeHelper, dir);
    expect(results.some((r) => !r.passed)).toBe(true);
  });

  it("edge-sum-dollars-precision", async () => {
    const dir = await materialize(edgeSumDollarsPrecision);

    const before = await gradeAll(edgeSumDollarsPrecision, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      "export function sumDollars(amounts) {",
      "  const totalCents = amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0);",
      "  return totalCents / 100;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "money.mjs"), solution, "utf8");

    const after = await gradeAll(edgeSumDollarsPrecision, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("edge-csv-row-parser", async () => {
    const dir = await materialize(edgeCsvRowParser);

    const before = await gradeAll(edgeCsvRowParser, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    const solution = [
      "export function parseCsvLine(line) {",
      "  const fields = [];",
      '  let field = "";',
      "  let inQuotes = false;",
      "  for (let i = 0; i < line.length; i++) {",
      "    const ch = line[i];",
      "    if (inQuotes) {",
      "      if (ch === '\"') {",
      "        if (line[i + 1] === '\"') {",
      "          field += '\"';",
      "          i++;",
      "        } else {",
      "          inQuotes = false;",
      "        }",
      "      } else {",
      "        field += ch;",
      "      }",
      "    } else if (ch === '\"') {",
      "      inQuotes = true;",
      '    } else if (ch === ",") {',
      "      fields.push(field);",
      '      field = "";',
      "    } else {",
      "      field += ch;",
      "    }",
      "  }",
      "  fields.push(field);",
      "  return fields;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "csv.mjs"), solution, "utf8");

    const after = await gradeAll(edgeCsvRowParser, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });

  it("edge-word-frequency-unicode", async () => {
    const dir = await materialize(edgeWordFrequencyUnicode);

    const before = await gradeAll(edgeWordFrequencyUnicode, dir);
    expect(before.some((r) => !r.passed)).toBe(true);

    await replaceInFile(
      join(dir, "word-freq.mjs"),
      "const words = text.toLowerCase().match(/\\w+/g) || [];",
      "const words = text.toLowerCase().match(/[\\p{L}\\p{N}]+/gu) || [];",
    );

    const after = await gradeAll(edgeWordFrequencyUnicode, dir);
    expect(after.every((r) => r.passed)).toBe(true);
  });
});

describe("ALL_TASKS invariants", () => {
  it("every task has a unique id", () => {
    const ids = ALL_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has at least sixteen tasks (six starter + at least ten expansion tasks)", () => {
    expect(ALL_TASKS.length).toBeGreaterThanOrEqual(16);
  });

  it("every task has a non-empty prompt", () => {
    for (const task of ALL_TASKS) {
      expect(task.prompt.trim().length, `${task.id} has an empty prompt`).toBeGreaterThan(0);
    }
  });

  it("every task has a non-empty description", () => {
    for (const task of ALL_TASKS) {
      expect(task.description.trim().length, `${task.id} has an empty description`).toBeGreaterThan(
        0,
      );
    }
  });

  it("every task has at least one assertion", () => {
    for (const task of ALL_TASKS) {
      expect(task.assertions.length, `${task.id} has no assertions`).toBeGreaterThan(0);
    }
  });

  it("no prompt mentions the hidden verifier", () => {
    for (const task of ALL_TASKS) {
      const lower = task.prompt.toLowerCase();
      expect(lower, `${task.id}'s prompt mentions .eval`).not.toContain(".eval");
      expect(lower, `${task.id}'s prompt mentions verify.mjs`).not.toContain("verify.mjs");
      expect(lower, `${task.id}'s prompt mentions "hidden"`).not.toContain("hidden");
    }
  });

  it("every task id is unique-looking and filter-friendly (lowercase, hyphenated)", () => {
    for (const task of ALL_TASKS) {
      expect(task.id, `${task.id} is not a clean kebab-case id`).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
