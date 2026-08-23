/**
 * Task: implement CSV-line parsing edge cases correctly.
 *
 * The starting implementation is a bare `split(",")`, which is right for
 * the trivial case and wrong for everything that makes CSV worth having a
 * parser for: quoted fields containing commas, doubled-quote escaping, and
 * empty fields. The hidden verifier adds empty input, a trailing empty
 * field, an entirely-empty quoted field, and a quote-escape at the very
 * start of a field — cases the small visible suite doesn't cover.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const CSV_JS = `/**
 * Parse a single CSV line into an array of fields.
 *  - Fields are separated by commas.
 *  - A field may be wrapped in double quotes to contain a literal comma
 *    (or nothing at all).
 *  - Inside a quoted field, "" represents one literal double-quote
 *    character.
 *  - An empty input string parses to a single empty field: [""].
 */
export function parseCsvLine(line) {
  return line.split(",");
}
`;

const CSV_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "./csv.mjs";

test("splits plain comma-separated fields", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("keeps a comma inside a quoted field", () => {
  assert.deepEqual(parseCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

test("unescapes doubled quotes inside a quoted field", () => {
  assert.deepEqual(parseCsvLine('"she said ""hi""",done'), ['she said "hi"', "done"]);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { parseCsvLine } from "../csv.mjs";

// Empty input.
assert.deepEqual(parseCsvLine(""), [""]);

// Plain fields, including trailing empty field.
assert.deepEqual(parseCsvLine("a,b,"), ["a", "b", ""]);

// Quoted field containing a comma, at various positions.
assert.deepEqual(parseCsvLine('"a,b",c,d'), ["a,b", "c", "d"]);
assert.deepEqual(parseCsvLine('a,b,"c,d"'), ["a", "b", "c,d"]);

// An entirely empty quoted field.
assert.deepEqual(parseCsvLine('"",x'), ["", "x"]);

// Doubled-quote escaping, including at the start of a field.
assert.deepEqual(parseCsvLine('"""quoted""",x'), ['"quoted"', "x"]);

// A field that mixes quoted and unquoted content around a comma boundary.
assert.deepEqual(parseCsvLine('name,"Smith, John",42'), ["name", "Smith, John", "42"]);

console.log("verify: ok");
`;

export const edgeCsvRowParser: EvalTask = {
  id: "edge-csv-row-parser",
  description:
    "Implement CSV-line parsing with quoted fields, escaped quotes and empty fields, not just " +
    "a plain comma split.",
  prompt:
    "parseCsvLine(line) in csv.mjs is currently a bare line.split(','), which breaks as soon as " +
    "a field is quoted. Implement real CSV-line parsing per the comment in csv.mjs: fields may " +
    'be wrapped in double quotes to contain a literal comma, a doubled quote ("") inside a ' +
    "quoted field means one literal quote character, and an empty input parses to ['']. Match " +
    "every test in csv.test.mjs.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "csv.mjs": CSV_JS,
      "csv.test.mjs": CSV_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["edge-case", "parsing", "hard"],
};
