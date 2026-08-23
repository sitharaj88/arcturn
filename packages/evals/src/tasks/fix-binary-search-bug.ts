/**
 * Task: find and fix a real bug, with no hint where it is.
 *
 * `binarySearch` uses `<` instead of `<=`, so it misses the case where the
 * search window has collapsed to exactly one element that IS the target
 * (e.g. single-element arrays, or the target at either end).
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, noFileDeleted } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const SEARCH_JS = `export function binarySearch(sortedArr, target) {
  let lo = 0;
  let hi = sortedArr.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sortedArr[mid] === target) return mid;
    if (sortedArr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`;

const SEARCH_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { binarySearch } from "./search.mjs";

test("finds a value in the middle", () => {
  assert.equal(binarySearch([1, 3, 5, 7, 9], 5), 2);
});

test("finds a single-element array containing the target", () => {
  assert.equal(binarySearch([42], 42), 0);
});

test("finds the first element", () => {
  assert.equal(binarySearch([2, 4, 6, 8], 2), 0);
});

test("finds the last element", () => {
  assert.equal(binarySearch([2, 4, 6, 8], 8), 3);
});

test("returns -1 when the value is absent", () => {
  assert.equal(binarySearch([2, 4, 6, 8], 5), -1);
  assert.equal(binarySearch([], 1), -1);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { binarySearch } from "../search.mjs";

assert.equal(binarySearch([10], 10), 0, "single-element array");
assert.equal(binarySearch([1, 2], 1), 0, "two elements, first");
assert.equal(binarySearch([1, 2], 2), 1, "two elements, last");
assert.equal(binarySearch([1, 2, 3, 4, 5, 6], 1), 0, "even-length array, first");
assert.equal(binarySearch([1, 2, 3, 4, 5, 6], 6), 5, "even-length array, last");
assert.equal(binarySearch([1, 2, 3, 4, 5, 6], 9), -1, "absent value");
console.log("verify: ok");
`;

export const fixBinarySearchBug: EvalTask = {
  id: "fix-binary-search-bug",
  description: "Find and fix an unhinted off-by-one bug in a binary search implementation.",
  prompt:
    "There is a bug somewhere in this project that makes `node --test` fail. Find it and fix " +
    "it. Do not change the test file.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "search.mjs": SEARCH_JS,
      "search.test.mjs": SEARCH_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    noFileDeleted(["search.mjs", "search.test.mjs"]),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["fix-bug", "find-bug", "easy"],
};
