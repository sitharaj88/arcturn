/**
 * Task: fix a failing test.
 *
 * `sum` is implemented with the wrong operator. `node --test` fails out of
 * the box; the agent has to find the one-line bug and fix it without
 * touching the test file.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, fileContains, noFileDeleted } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const SUM_JS = `export function sum(a, b) {
  return a - b;
}
`;

const SUM_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.mjs";

test("sum adds two positive numbers", () => {
  assert.equal(sum(2, 3), 5);
});

test("sum handles negatives", () => {
  assert.equal(sum(-2, -3), -5);
});

test("sum handles zero", () => {
  assert.equal(sum(0, 7), 7);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { sum } from "../sum.mjs";

// Independent of whatever the agent's own tests check.
assert.equal(sum(2, 3), 5, "sum(2, 3) should be 5");
assert.equal(sum(10, -4), 6, "sum(10, -4) should be 6");
assert.equal(sum(-1, -1), -2, "sum(-1, -1) should be -2");
console.log("verify: ok");
`;

export const fixFailingSumTest: EvalTask = {
  id: "fix-failing-sum-test",
  description: "Fix a one-line bug (wrong operator) so an existing failing test suite passes.",
  prompt:
    "This project's test suite is failing (`node --test`). Find the bug in sum.mjs and fix " +
    "it so every test passes. Do not weaken, skip or delete any test.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "sum.mjs": SUM_JS,
      "sum.test.mjs": SUM_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    fileContains("sum.test.mjs", "sum adds two positive numbers"),
    noFileDeleted(["sum.mjs", "sum.test.mjs"]),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["fix-bug", "small", "easy"],
};
