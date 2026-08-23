/**
 * Task: rename a symbol across files.
 *
 * `computeTotal` is defined in `cart.mjs` and called from `checkout.mjs`.
 * The (already-written) test suite imports the *new* name, so the rename
 * has to actually happen — including the call site — for anything to pass.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalTask } from "../task.js";
import { commandSucceeds, custom, noFileDeleted } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const CART_JS = `export function computeTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`;

const CHECKOUT_JS = `import { computeTotal } from "./cart.mjs";

export function checkout(items) {
  const total = computeTotal(items);
  return { total, receipt: \`Total: $\${total.toFixed(2)}\` };
}
`;

const CHECKOUT_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTotal } from "./cart.mjs";
import { checkout } from "./checkout.mjs";

test("calculateTotal sums price times qty", () => {
  assert.equal(calculateTotal([{ price: 2, qty: 3 }]), 6);
});

test("checkout uses the renamed function internally", () => {
  const result = checkout([{ price: 10, qty: 2 }]);
  assert.equal(result.total, 20);
  assert.equal(result.receipt, "Total: $20.00");
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { calculateTotal } from "../cart.mjs";
import { checkout } from "../checkout.mjs";

assert.equal(calculateTotal([{ price: 5, qty: 4 }]), 20);
assert.equal(checkout([{ price: 1.5, qty: 2 }]).total, 3);
console.log("verify: ok");
`;

const RENAME_PATTERN = /\bcomputeTotal\b/;

export const renameComputeTotal: EvalTask = {
  id: "rename-compute-total",
  description:
    "Rename a function and every call site across two files, keeping behavior identical.",
  prompt:
    "Rename the function `computeTotal` to `calculateTotal` everywhere it is defined or used " +
    "in this project (cart.mjs and checkout.mjs), keeping its behavior identical. The test " +
    "suite in checkout.test.mjs already expects the new name.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "cart.mjs": CART_JS,
      "checkout.mjs": CHECKOUT_JS,
      "checkout.test.mjs": CHECKOUT_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    custom("no leftover computeTotal references", async (dir) => {
      for (const file of ["cart.mjs", "checkout.mjs"]) {
        const content = await readFile(join(dir, file), "utf8");
        if (RENAME_PATTERN.test(content)) {
          return {
            name: "no leftover computeTotal references",
            passed: false,
            message: `${file} still references computeTotal`,
          };
        }
      }
      return true;
    }),
    noFileDeleted(["cart.mjs", "checkout.mjs", "checkout.test.mjs"]),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["rename", "multi-file", "easy"],
};
