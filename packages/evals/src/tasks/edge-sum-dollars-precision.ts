/**
 * Task: fix floating-point drift in a money summation, including at scale.
 *
 * `sumDollars` naively adds floats, so classic cases like `0.1 * 10` land
 * on `0.9999999999999999`. The fix must round to whole cents before
 * summing (and only divide back once at the end) so the result stays exact
 * even over very large inputs — the hidden verifier sums a million small
 * amounts and expects an exact result.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const MONEY_JS = `/**
 * Sum an array of dollar amounts and return the total in dollars, accurate
 * to the cent — no floating-point drift, even summing many values.
 */
export function sumDollars(amounts) {
  return amounts.reduce((sum, amount) => sum + amount, 0);
}
`;

const MONEY_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sumDollars } from "./money.mjs";

test("sums without floating point drift", () => {
  const amounts = Array(10).fill(0.1);
  assert.equal(sumDollars(amounts), 1);
});

test("handles an empty array", () => {
  assert.equal(sumDollars([]), 0);
});

test("handles negative amounts (refunds)", () => {
  assert.equal(sumDollars([10, -3.5]), 6.5);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { sumDollars } from "../money.mjs";

assert.equal(sumDollars([]), 0);
assert.equal(sumDollars([0.1, 0.2]), 0.3);
assert.equal(sumDollars(Array(20).fill(0.05)), 1);
assert.equal(sumDollars([19.99, 5.01]), 25);
assert.equal(sumDollars([100, -37.5, -12.5]), 50);

// Very large values: a big batch of small amounts must still be exact.
const large = Array(1000000).fill(0.01);
assert.equal(sumDollars(large), 10000);

// A single large amount plus tiny ones, still exact to the cent.
assert.equal(sumDollars([999999.99, 0.01]), 1000000);

console.log("verify: ok");
`;

export const edgeSumDollarsPrecision: EvalTask = {
  id: "edge-sum-dollars-precision",
  description:
    "Fix floating-point drift in a money summation so it stays exact to the cent, even over " +
    "very large inputs.",
  prompt:
    "sumDollars(amounts) in money.mjs is supposed to add up dollar amounts exactly, but " +
    "money.test.mjs shows it drifts due to plain floating-point addition (e.g. summing ten " +
    "0.1's doesn't equal exactly 1). Fix it so it is exact to the cent no matter how many " +
    "amounts are summed, matching every test.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "money.mjs": MONEY_JS,
      "money.test.mjs": MONEY_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["edge-case", "numeric", "medium"],
};
