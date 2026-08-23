/**
 * Task: extend an API without breaking existing callers.
 *
 * `formatDuration(ms)` has an existing single-argument contract that
 * `duration.test.mjs` (left untouched, representing existing callers)
 * locks down exactly. The agent must add an optional `{ compact }` mode
 * without changing the original output for any existing call — a common
 * failure mode is refactoring the core formatting logic while adding the
 * new branch and subtly changing old output (e.g. an off-by-one around
 * whole hours/minutes).
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const DURATION_JS = `/**
 * Format a millisecond duration as "1h 2m 3s" (omitting leading zero units,
 * always showing seconds). Existing single-argument callers rely on exactly
 * this format — do not change it.
 */
export function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(\`\${hours}h\`);
  if (hours > 0 || minutes > 0) parts.push(\`\${minutes}m\`);
  parts.push(\`\${seconds}s\`);
  return parts.join(" ");
}
`;

const DURATION_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "./duration.mjs";

test("formats seconds only", () => {
  assert.equal(formatDuration(45000), "45s");
});

test("formats minutes and seconds", () => {
  assert.equal(formatDuration(150000), "2m 30s");
});

test("formats hours, minutes and seconds", () => {
  assert.equal(formatDuration(3723000), "1h 2m 3s");
});

test("formats zero", () => {
  assert.equal(formatDuration(0), "0s");
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { formatDuration } from "../duration.mjs";

// Existing single-argument behavior must be byte-identical to before.
assert.equal(formatDuration(0), "0s");
assert.equal(formatDuration(1000), "1s");
assert.equal(formatDuration(59000), "59s");
assert.equal(formatDuration(60000), "1m 0s");
assert.equal(formatDuration(3600000), "1h 0m 0s");
assert.equal(formatDuration(7325000), "2h 2m 5s");
// Explicitly passing compact: false must match the old default too.
assert.equal(formatDuration(150000, { compact: false }), "2m 30s");

// New compact mode: largest applicable unit, one decimal place.
assert.equal(formatDuration(0, { compact: true }), "0.0s");
assert.equal(formatDuration(2500, { compact: true }), "2.5s");
assert.equal(formatDuration(90000, { compact: true }), "1.5m");
assert.equal(formatDuration(3600000, { compact: true }), "1.0h");
assert.equal(formatDuration(5400000, { compact: true }), "1.5h");

console.log("verify: ok");
`;

export const compatDurationFormat: EvalTask = {
  id: "compat-duration-format",
  description:
    "Add an optional compact mode to formatDuration while keeping every existing call byte-" +
    "identical to before.",
  prompt:
    "Add an optional second parameter to formatDuration(ms, options) in duration.mjs: an " +
    "`options.compact` boolean (default false). When compact is true, return ONLY the largest " +
    "applicable unit as a decimal number with exactly one digit after the decimal point: hours " +
    "if ms is at least one hour, else minutes if ms is at least one minute, else seconds — e.g. " +
    "formatDuration(90000, { compact: true }) === '1.5m' and formatDuration(3600000, { compact: " +
    "true }) === '1.0h'. Existing single-argument callers (see duration.test.mjs, which you " +
    "should not need to change) must keep getting the exact same output as before — do not " +
    "change the default (non-compact) formatting.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "duration.mjs": DURATION_JS,
      "duration.test.mjs": DURATION_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [commandSucceeds("node --test"), commandSucceeds("node .eval/verify.mjs")],
  timeoutMs: 3 * 60_000,
  tags: ["backwards-compat", "api-design", "medium"],
};
