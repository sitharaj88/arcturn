/**
 * Task: debug a symptom whose real cause is in a different file than where
 * it's observed, without breaking a documented performance invariant.
 *
 * `store.test.mjs` fails inside `store.mjs`'s `totalFor`, but `store.mjs`
 * is not the bug: it just calls `getPrice`. The real bug is that
 * `catalog.mjs`'s `setPrice` never invalidates `pricing.mjs`'s memoization
 * cache. The obvious "fix" — stop caching in `getPrice` — makes the visible
 * test pass too, but violates the documented caching invariant; the hidden
 * verifier instruments `catalog.lookup` to prove the cache is still doing
 * its job as well as being correctly invalidated.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, noFileDeleted } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const PRICING_JS = `/**
 * A small memoizing price lookup. Looking up a price is assumed to be
 * relatively expensive (e.g. a remote catalog call in a real system), so
 * results are cached by SKU.
 *
 * NOTE: this caching is load-bearing for performance — do not remove it as
 * a way to "fix" staleness. A correct fix invalidates the right cache entry
 * instead of skipping the cache entirely.
 */
const cache = new Map();

export function getPrice(catalog, sku) {
  if (cache.has(sku)) return cache.get(sku);
  const price = catalog.lookup(sku);
  cache.set(sku, price);
  return price;
}

export function invalidatePrice(sku) {
  cache.delete(sku);
}
`;

const CATALOG_JS = `const prices = new Map();

export function setPrice(sku, price) {
  prices.set(sku, price);
}

export const catalog = {
  lookup(sku) {
    return prices.get(sku);
  },
};
`;

const STORE_JS = `import { catalog } from "./catalog.mjs";
import { getPrice } from "./pricing.mjs";

export function totalFor(skus) {
  return skus.reduce((sum, sku) => sum + (getPrice(catalog, sku) ?? 0), 0);
}
`;

const STORE_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { setPrice } from "./catalog.mjs";
import { totalFor } from "./store.mjs";

test("store total reflects the latest price after an update", () => {
  setPrice("sku-1", 10);
  assert.equal(totalFor(["sku-1"]), 10);

  setPrice("sku-1", 15);
  assert.equal(totalFor(["sku-1"]), 15);
});

test("totals combine multiple SKUs correctly", () => {
  setPrice("sku-2", 4);
  setPrice("sku-3", 6);
  assert.equal(totalFor(["sku-2", "sku-3"]), 10);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { catalog, setPrice } from "../catalog.mjs";
import { totalFor } from "../store.mjs";

let lookups = 0;
const originalLookup = catalog.lookup.bind(catalog);
catalog.lookup = (sku) => {
  lookups++;
  return originalLookup(sku);
};

setPrice("v-sku", 100);
assert.equal(totalFor(["v-sku"]), 100);
assert.equal(totalFor(["v-sku"]), 100);
assert.equal(lookups, 1, "repeated reads of an unchanged price must hit the cache, not re-lookup");

setPrice("v-sku", 250);
assert.equal(totalFor(["v-sku"]), 250, "total must reflect the new price after an update");
assert.ok(lookups >= 2, "updating a price must invalidate its cache entry, not reuse stale data");

const lookupsAfterUpdate = lookups;
assert.equal(totalFor(["v-sku"]), 250);
assert.equal(lookups, lookupsAfterUpdate, "the freshly-cached post-update price should be reused too");

console.log("verify: ok");
`;

export const debugStalePriceCache: EvalTask = {
  id: "debug-stale-price-cache",
  description:
    "Fix a stale-cache bug whose symptom shows up in a different file than its cause, without " +
    "removing the caching itself.",
  prompt:
    "store.test.mjs is failing: totalFor(['sku-1']) still returns the old price right after " +
    "setPrice updates it. Find the bug and fix it so every test passes. pricing.mjs's price " +
    "cache is there for performance and should stay — do not delete or bypass it as the fix.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "pricing.mjs": PRICING_JS,
      "catalog.mjs": CATALOG_JS,
      "store.mjs": STORE_JS,
      "store.test.mjs": STORE_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    noFileDeleted(["pricing.mjs", "catalog.mjs", "store.mjs", "store.test.mjs"]),
  ],
  timeoutMs: 4 * 60_000,
  tags: ["debugging", "trap", "multi-file", "hard"],
};
