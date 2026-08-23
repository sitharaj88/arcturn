/**
 * Task: implement a function with a real edge case.
 *
 * `clamp` is a stub. The tests (and the hidden verifier) cover the obvious
 * cases plus one that is easy to get wrong: inverted bounds (`min > max`).
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const CLAMP_JS = `export function clamp(value, min, max) {
  throw new Error("not implemented");
}
`;

const CLAMP_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";

test("clamps within range", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("clamps below min", () => {
  assert.equal(clamp(-5, 0, 10), 0);
});

test("clamps above max", () => {
  assert.equal(clamp(15, 0, 10), 10);
});

test("handles inverted bounds (min greater than max)", () => {
  assert.equal(clamp(5, 10, 0), 5);
  assert.equal(clamp(-5, 10, 0), 0);
  assert.equal(clamp(15, 10, 0), 10);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { clamp } from "../clamp.mjs";

assert.equal(clamp(3, 1, 5), 3, "value already in range");
assert.equal(clamp(-10, 1, 5), 1, "clamps to min");
assert.equal(clamp(99, 1, 5), 5, "clamps to max");
// Inverted bounds, different numbers than the visible test file.
assert.equal(clamp(3, 5, 1), 3, "inverted bounds: value inside the real range");
assert.equal(clamp(-10, 5, 1), 1, "inverted bounds: clamps to the lower of the two");
assert.equal(clamp(99, 5, 1), 5, "inverted bounds: clamps to the higher of the two");
console.log("verify: ok");
`;

export const clampEdgeCases: EvalTask = {
  id: "clamp-edge-cases",
  description: "Implement clamp(value, min, max) correctly, including the min > max edge case.",
  prompt:
    "Implement clamp(value, min, max) in clamp.mjs so it passes the tests in clamp.test.mjs, " +
    "including the edge case where min is greater than max.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "clamp.mjs": CLAMP_JS,
      "clamp.test.mjs": CLAMP_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["implement", "edge-case", "small", "easy"],
};
