/**
 * Task: replace an accidentally-quadratic implementation with a linear one.
 *
 * `findDuplicates` is functionally correct (the small visible test suite
 * passes as-is) but uses a nested loop plus `Array.prototype.includes`,
 * making it O(n^2). The hidden verifier runs it on a 60,000-element array
 * and asserts it finishes in well under two seconds — a bound that a
 * correct near-linear implementation clears by a huge margin (well under
 * 100ms in practice) while the shipped O(n^2) version takes several
 * seconds, so the bound is generous enough to be stable on any reasonable
 * machine while still failing reliably on unfixed code.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const DUPLICATES_JS = `/**
 * Return the values that occur more than once in \`arr\`, each listed once,
 * in the order each value's FIRST occurrence appears in \`arr\`.
 */
export function findDuplicates(arr) {
  const dupes = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i] === arr[j] && !dupes.includes(arr[i])) {
        dupes.push(arr[i]);
      }
    }
  }
  return dupes;
}
`;

const DUPLICATES_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates } from "./duplicates.mjs";

test("returns duplicated values in order of first occurrence", () => {
  assert.deepEqual(findDuplicates([3, 1, 2, 1, 3, 4]), [3, 1]);
});

test("returns an empty array when there are no duplicates", () => {
  assert.deepEqual(findDuplicates([1, 2, 3]), []);
});

test("handles an empty array", () => {
  assert.deepEqual(findDuplicates([]), []);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { findDuplicates } from "../duplicates.mjs";

// Correctness, including an interleaving order that a naive
// "collect at second-occurrence" rewrite could get wrong.
assert.deepEqual(findDuplicates([1, 2, 2, 1]), [1, 2]);
assert.deepEqual(findDuplicates(["a", "b", "a", "c", "b"]), ["a", "b"]);
assert.deepEqual(findDuplicates([]), []);
assert.deepEqual(findDuplicates([1]), []);

// Performance: the shipped implementation was accidentally quadratic and
// unusable on realistic input sizes. A correct near-linear implementation
// finishes this in well under a second; the bound below is generous enough
// to be stable on any reasonable machine while still catching an
// unfixed O(n^2) implementation, which takes several seconds at this size.
const n = 60000;
const big = new Array(n);
for (let i = 0; i < n; i++) big[i] = i % Math.floor(n * 0.9);

const start = Date.now();
const result = findDuplicates(big);
const elapsedMs = Date.now() - start;

assert.ok(
  elapsedMs < 2000,
  \`findDuplicates(\${n} items) took \${elapsedMs}ms — looks like it is still quadratic\`,
);
assert.equal(result.length, Math.floor(n * 0.1), "duplicate count sanity check");

console.log("verify: ok");
`;

export const perfQuadraticDuplicates: EvalTask = {
  id: "perf-quadratic-duplicates",
  description:
    "Replace an accidentally-quadratic duplicate-finder with a near-linear one, verified by a " +
    "generous runtime bound on a large input.",
  prompt:
    "findDuplicates(arr) in duplicates.mjs returns the values that occur more than once, each " +
    "listed once in the order of their first occurrence — duplicates.test.mjs already checks " +
    "this is correct. The problem is performance: the current implementation is accidentally " +
    "quadratic and becomes unusably slow on large arrays (tens of thousands of items). Replace " +
    "it with an efficient, roughly linear-time implementation that still returns exactly the " +
    "same results.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "duplicates.mjs": DUPLICATES_JS,
      "duplicates.test.mjs": DUPLICATES_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs", { timeoutMs: 8000 }),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["perf", "hard"],
};
