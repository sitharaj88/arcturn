/**
 * Task: trace two unrelated-looking test failures back to one shared helper.
 *
 * `range.mjs`'s off-by-one bug (`<=` instead of `<`) breaks two independent
 * consumers, `calendar.mjs` and `pagination.mjs`, in ways that look like
 * separate bugs in separate files. The trap: patching the symptom locally
 * in `calendar.mjs` (e.g. dropping its compensating `+ 1`) makes
 * `calendar.test.mjs` pass without touching the shared `range.mjs` bug —
 * but leaves `pagination.mjs` (and `range.mjs` itself) still broken. The
 * hidden verifier checks `range` directly plus both callers with inputs
 * the visible tests never used, so a local patch in only one caller fails.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, noFileDeleted } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const RANGE_JS = `/** Returns [start, start+1, ..., end-1] — END-EXCLUSIVE, like Python's range(). */
export function range(start, end) {
  const result = [];
  for (let i = start; i <= end; i++) result.push(i);
  return result;
}
`;

const CALENDAR_JS = `import { range } from "./range.mjs";

export function daysInMonth(year, monthIndex) {
  // monthIndex is 0-based (0 = January), matching Date's convention.
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** The day numbers of a month, e.g. [1, 2, ..., 28] for a non-leap February. */
export function monthDayNumbers(year, monthIndex) {
  return range(1, daysInMonth(year, monthIndex) + 1);
}
`;

const PAGINATION_JS = `import { range } from "./range.mjs";

/** The zero-based page indices for \`pageCount\` pages, e.g. [0, 1, 2]. */
export function pageIndices(pageCount) {
  return range(0, pageCount);
}
`;

const CALENDAR_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { monthDayNumbers } from "./calendar.mjs";

test("February in a non-leap year has 28 days", () => {
  assert.deepEqual(monthDayNumbers(2023, 1), Array.from({ length: 28 }, (_, i) => i + 1));
});

test("February in a leap year has 29 days", () => {
  assert.deepEqual(monthDayNumbers(2024, 1), Array.from({ length: 29 }, (_, i) => i + 1));
});
`;

const PAGINATION_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { pageIndices } from "./pagination.mjs";

test("pageIndices(3) returns [0, 1, 2]", () => {
  assert.deepEqual(pageIndices(3), [0, 1, 2]);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { range } from "../range.mjs";
import { monthDayNumbers } from "../calendar.mjs";
import { pageIndices } from "../pagination.mjs";

// range() itself: end-exclusive, including boundary cases.
assert.deepEqual(range(0, 0), []);
assert.deepEqual(range(3, 3), []);
assert.deepEqual(range(2, 5), [2, 3, 4]);
assert.deepEqual(range(5, 2), []);

// Both real callers, with different inputs than the visible tests, so
// patching calendar.mjs or pagination.mjs locally instead of fixing the
// shared helper won't be enough.
assert.deepEqual(monthDayNumbers(2023, 3), Array.from({ length: 30 }, (_, i) => i + 1)); // April
assert.deepEqual(monthDayNumbers(2023, 0), Array.from({ length: 31 }, (_, i) => i + 1)); // January
assert.deepEqual(pageIndices(1), [0]);
assert.deepEqual(pageIndices(5), [0, 1, 2, 3, 4]);
assert.deepEqual(pageIndices(0), []);

console.log("verify: ok");
`;

export const debugSharedRangeHelper: EvalTask = {
  id: "debug-shared-range-helper",
  description:
    "Trace two seemingly unrelated test failures (calendar.mjs, pagination.mjs) to a single " +
    "off-by-one bug in a shared range.mjs helper.",
  prompt:
    "Both calendar.test.mjs and pagination.test.mjs are failing in this project. Find the root " +
    "cause and fix it so every test passes, without changing what any function is documented to " +
    "do.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "range.mjs": RANGE_JS,
      "calendar.mjs": CALENDAR_JS,
      "pagination.mjs": PAGINATION_JS,
      "calendar.test.mjs": CALENDAR_TEST_JS,
      "pagination.test.mjs": PAGINATION_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    noFileDeleted(["range.mjs", "calendar.mjs", "pagination.mjs"]),
  ],
  timeoutMs: 4 * 60_000,
  tags: ["debugging", "multi-file", "find-bug", "hard"],
};
