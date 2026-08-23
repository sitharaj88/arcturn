/**
 * Task: implement a string edge case correctly — Unicode code points, not
 * UTF-16 code units.
 *
 * The starting implementation slices by `.length` (UTF-16 code units), so
 * it can split an emoji's surrogate pair in half, mis-measures astral-plane
 * characters, and mishandles `maxLength <= 0`. The hidden verifier checks
 * surrogate-pair safety, astral-plane characters, both `maxLength <= 0`
 * cases, and a very large `maxLength` (must return unchanged, no crash).
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const TRUNCATE_JS = `/**
 * Truncate \`str\` to at most \`maxLength\` Unicode CODE POINTS (not UTF-16
 * code units — never split an emoji or other surrogate-pair character in
 * half), appending "…" when truncation actually happened.
 *
 *  - If str already fits within maxLength code points, return it unchanged
 *    (no ellipsis appended).
 *  - If maxLength <= 0: return "…" for a non-empty str, or "" for an empty
 *    str.
 */
export function truncateWithEllipsis(str, maxLength) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "…";
}
`;

const TRUNCATE_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateWithEllipsis } from "./truncate.mjs";

test("returns the string unchanged when it already fits", () => {
  assert.equal(truncateWithEllipsis("hello", 10), "hello");
});

test("truncates and appends an ellipsis when too long", () => {
  assert.equal(truncateWithEllipsis("hello world", 5), "hello…");
});

test("does not split an emoji in half", () => {
  const result = truncateWithEllipsis("Hi 😀 there", 4);
  assert.equal(result, "Hi 😀…");
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { truncateWithEllipsis } from "../truncate.mjs";

// Fits exactly: no ellipsis.
assert.equal(truncateWithEllipsis("abc", 3), "abc");
assert.equal(truncateWithEllipsis("", 5), "");

// Basic truncation.
assert.equal(truncateWithEllipsis("abcdef", 3), "abc…");

// Surrogate-pair safety: must never produce an unpaired surrogate, and must
// count the emoji as ONE unit, not two.
const withEmoji = "a😀b😀c";
const result = truncateWithEllipsis(withEmoji, 3);
assert.equal(result, "a😀b…");
for (const ch of result) {
  const code = ch.codePointAt(0);
  assert.ok(
    code < 0xd800 || code > 0xdfff || ch.length === 2,
    \`result contains an unpaired surrogate: \${JSON.stringify(result)}\`,
  );
}

// Astral-plane characters (mathematical bold, outside the BMP) count as one
// code point each too.
const astral = "𝓐𝓑𝓒𝓓";
assert.equal(truncateWithEllipsis(astral, 2), "𝓐𝓑…");
assert.equal(truncateWithEllipsis(astral, 4), astral);

// maxLength <= 0.
assert.equal(truncateWithEllipsis("hello", 0), "…");
assert.equal(truncateWithEllipsis("hello", -3), "…");
assert.equal(truncateWithEllipsis("", 0), "");

// Very large maxLength: returns unchanged, no crash, no hang.
const long = "x".repeat(10000);
assert.equal(truncateWithEllipsis(long, Number.MAX_SAFE_INTEGER), long);

console.log("verify: ok");
`;

export const edgeTruncateUnicode: EvalTask = {
  id: "edge-truncate-unicode",
  description:
    "Truncate a string by Unicode code point (not UTF-16 code unit), never splitting a " +
    "surrogate pair, handling non-positive and very large lengths.",
  prompt:
    "truncateWithEllipsis(str, maxLength) in truncate.mjs is supposed to keep at most " +
    "maxLength Unicode characters and append '…' when it truncates, but it currently measures " +
    "length in UTF-16 code units, so it can cut an emoji in half. Fix it so it correctly counts " +
    "and truncates by whole Unicode code points (never splitting a surrogate pair), matching " +
    "truncate.test.mjs.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "truncate.mjs": TRUNCATE_JS,
      "truncate.test.mjs": TRUNCATE_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["edge-case", "unicode", "medium"],
};
