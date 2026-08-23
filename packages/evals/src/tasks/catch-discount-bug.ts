/**
 * Task: write a test that catches a specific bug, then fix it.
 *
 * `applyDiscount` never clamps the result, so a discount over 100% produces
 * a negative price. There is no test file yet — the agent has to write one
 * that actually exercises the bug (not just the happy path) before fixing
 * the underlying function.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalTask } from "../task.js";
import { commandSucceeds, custom, fileExists } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const DISCOUNT_JS = `export function applyDiscount(price, percentOff) {
  return price - (price * percentOff) / 100;
}
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { applyDiscount } from "../discount.mjs";

// The bug: a discount over 100% must not push the price negative.
assert.equal(applyDiscount(50, 150), 0, "a 150% discount should clamp the price to 0");
assert.equal(applyDiscount(80, 200), 0, "a 200% discount should clamp the price to 0");
// Normal cases must be unaffected by the fix.
assert.equal(applyDiscount(200, 25), 150, "a normal discount is unaffected");
assert.equal(applyDiscount(100, 0), 100, "a 0% discount is unaffected");
console.log("verify: ok");
`;

/** Loosely checks the written test calls applyDiscount with an over-100 percentage. */
function referencesOverHundredPercent(content: string): boolean {
  const calls = content.matchAll(/applyDiscount\(\s*[\d.]+\s*,\s*(-?[\d.]+)\s*\)/g);
  for (const match of calls) {
    const percent = Number(match[1]);
    if (Number.isFinite(percent) && percent > 100) return true;
  }
  return false;
}

export const catchDiscountBug: EvalTask = {
  id: "catch-discount-bug",
  description: "Write a regression test that reproduces a real bug, then fix the bug.",
  prompt:
    "applyDiscount(price, percentOff) in discount.mjs can return a negative price when " +
    "percentOff is greater than 100 — a discount should never make the price negative, that " +
    "is a bug. Write a test in discount.test.mjs that reproduces this bug, then fix " +
    "discount.mjs so the price is clamped at 0 and every test passes.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "discount.mjs": DISCOUNT_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    fileExists("discount.test.mjs"),
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    custom("test file exercises a discount over 100%", async (dir) => {
      const content = await readFile(join(dir, "discount.test.mjs"), "utf8").catch(() => "");
      return referencesOverHundredPercent(content);
    }),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["write-test", "fix-bug", "easy"],
};
