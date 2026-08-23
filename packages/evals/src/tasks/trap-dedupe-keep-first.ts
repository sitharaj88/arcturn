/**
 * Task: fix a data-correctness bug without breaking a second, easy-to-miss
 * invariant.
 *
 * `dedupeKeepFirst` currently lets a later duplicate silently overwrite an
 * earlier one's data. The trap: a common "fix" is to iterate in reverse so
 * the first occurrence's value survives the `Map.set` — which fixes the
 * data but scrambles the output order, breaking the documented
 * order-preservation invariant. The hidden verifier checks both invariants
 * with inputs specifically chosen to catch that reverse-iteration trap.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const DEDUPE_JS = `/**
 * Remove duplicate items by key.
 *
 * INVARIANTS (do not violate either one):
 *  1. On a duplicate key, the FIRST occurrence's data wins.
 *  2. The result preserves the relative order of the surviving
 *     (first-occurrence) items as they appeared in the input.
 */
export function dedupeKeepFirst(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}
`;

const DEDUPE_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeKeepFirst } from "./dedupe.mjs";

test("keeps the first occurrence's data on duplicate keys", () => {
  const items = [
    { id: 1, note: "first" },
    { id: 2, note: "only" },
    { id: 1, note: "duplicate, should be ignored" },
  ];
  const result = dedupeKeepFirst(items, (item) => item.id);
  assert.deepEqual(result, [
    { id: 1, note: "first" },
    { id: 2, note: "only" },
  ]);
});

test("returns items unchanged when there are no duplicates", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(dedupeKeepFirst(items, (item) => item.id), items);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { dedupeKeepFirst } from "../dedupe.mjs";

// Data-correctness: first occurrence's fields must survive.
const a = [
  { id: "x", v: 1 },
  { id: "y", v: 2 },
  { id: "x", v: 999 },
  { id: "z", v: 3 },
];
const ra = dedupeKeepFirst(a, (item) => item.id);
assert.deepEqual(
  ra,
  [
    { id: "x", v: 1 },
    { id: "y", v: 2 },
    { id: "z", v: 3 },
  ],
  "must keep the first occurrence's data, in first-occurrence order",
);

// Order-preservation trap: a naive "iterate in reverse to keep the first
// occurrence's value" fix keeps the right data but scrambles order.
const b = [
  { id: "p", v: "p1" },
  { id: "q", v: "q1" },
  { id: "p", v: "p2 (dup, ignored)" },
  { id: "r", v: "r1" },
  { id: "q", v: "q2 (dup, ignored)" },
];
const rb = dedupeKeepFirst(b, (item) => item.id);
assert.deepEqual(
  rb.map((item) => item.id),
  ["p", "q", "r"],
  "surviving items must keep their first-seen relative order",
);
assert.deepEqual(rb, [
  { id: "p", v: "p1" },
  { id: "q", v: "q1" },
  { id: "r", v: "r1" },
]);

console.log("verify: ok");
`;

export const trapDedupeKeepFirst: EvalTask = {
  id: "trap-dedupe-keep-first",
  description:
    "Fix a duplicate-overwrite bug without breaking the documented order-preservation invariant.",
  prompt:
    "dedupeKeepFirst(items, keyFn) in dedupe.mjs is supposed to keep the FIRST occurrence's data " +
    "for each duplicate key, but dedupe.test.mjs shows it currently keeps the LAST one instead. " +
    "Fix it so every test passes. Both invariants documented in dedupe.mjs's comment must hold: " +
    "the first occurrence's data wins, AND the result preserves the surviving items' original " +
    "relative order.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "dedupe.mjs": DEDUPE_JS,
      "dedupe.test.mjs": DEDUPE_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["trap", "edge-case", "hard"],
};
