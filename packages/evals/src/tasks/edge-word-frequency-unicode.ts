/**
 * Task: count word frequency with real Unicode word boundaries.
 *
 * The `\w+` regex only matches ASCII letters/digits/underscore, so it
 * chops accented Latin words at the accent (`"naïve"` becomes `"na"` +
 * `"ve"`) and drops non-Latin scripts entirely. The fix is a Unicode-aware
 * character class (`\p{L}`/`\p{N}` with the `u` flag). The hidden verifier
 * checks accented words, case-folding of accented letters, and a non-Latin
 * script (CJK).
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const WORD_FREQ_JS = `/**
 * Count how many times each word occurs in \`text\`, case-insensitively.
 * A "word" is a run of Unicode letters or digits (any script, including
 * accented Latin letters, CJK, Cyrillic, etc.) — not just ASCII [a-zA-Z].
 */
export function wordFrequency(text) {
  const counts = {};
  const words = text.toLowerCase().match(/\\w+/g) || [];
  for (const word of words) counts[word] = (counts[word] ?? 0) + 1;
  return counts;
}
`;

const WORD_FREQ_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { wordFrequency } from "./word-freq.mjs";

test("counts ASCII words case-insensitively", () => {
  assert.deepEqual(wordFrequency("The cat sat. The cat ran."), {
    the: 2,
    cat: 2,
    sat: 1,
    ran: 1,
  });
});

test("handles an empty string", () => {
  assert.deepEqual(wordFrequency(""), {});
});

test("counts accented words correctly", () => {
  assert.deepEqual(wordFrequency("café café naïve"), { "café": 2, "naïve": 1 });
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { wordFrequency } from "../word-freq.mjs";

assert.deepEqual(wordFrequency(""), {});
assert.deepEqual(wordFrequency("one"), { one: 1 });

// Accented Latin letters must stay whole, not get chopped at the accent.
assert.deepEqual(wordFrequency("naïve naïve résumé"), { "naïve": 2, "résumé": 1 });

// Case-folding must apply to accented letters too.
assert.deepEqual(wordFrequency("Café CAFÉ café"), { café: 3 });

// Non-Latin scripts count as words too.
assert.deepEqual(wordFrequency("日本語 日本語 hello"), { "日本語": 2, hello: 1 });

console.log("verify: ok");
`;

export const edgeWordFrequencyUnicode: EvalTask = {
  id: "edge-word-frequency-unicode",
  description:
    "Fix a word-frequency counter that splits accented and non-Latin words incorrectly because " +
    "it only recognizes ASCII word characters.",
  prompt:
    "wordFrequency(text) in word-freq.mjs is supposed to count case-insensitive word " +
    "occurrences for any script (see the comment in word-freq.mjs), but word-freq.test.mjs " +
    "shows accented words like 'naïve' get split apart. Fix it so words are matched by real " +
    "Unicode letters/digits, not just ASCII, while keeping every existing test passing.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "word-freq.mjs": WORD_FREQ_JS,
      "word-freq.test.mjs": WORD_FREQ_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["edge-case", "unicode", "medium"],
};
