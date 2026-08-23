/**
 * Task: write a test that reproduces an async staleness bug, then fix it.
 *
 * `memoizeAsync` correctly deduplicates concurrent calls for the same key,
 * but never evicts a settled call, so every later call for that key reuses
 * the first call's result forever. There is no test file yet — the agent
 * has to write one that actually proves the bug (a call made *after* the
 * previous one has settled must invoke `fn` again) before fixing it.
 *
 * The hidden verifier does two independent things: it exercises the real
 * behavior directly, and — more unusually — it re-runs the agent's own
 * written test file against a byte-for-byte copy of the *original, buggy*
 * `single-flight.mjs` in a scratch directory and asserts that copy fails.
 * That catches the cheap cheat of writing a test that only covers the
 * (already-working) concurrent-dedup path, which would pass against both
 * the buggy and the fixed implementation and therefore prove nothing.
 */

import { exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AssertionResult, EvalTask } from "../task.js";
import { commandSucceeds, custom, fileExists } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const execAsync = promisify(exec);

const SINGLE_FLIGHT_JS = `/**
 * Wrap an async function \`fn(key)\` so CONCURRENT calls for the same key
 * share a single underlying call (no duplicate work): if \`memoized(key)\` is
 * called again before the first call for that key has settled, it gets the
 * same promise instead of calling \`fn\` again.
 *
 * Once that call settles, a LATER call for the same key must invoke \`fn\`
 * again — it must not keep returning the old result forever.
 */
export function memoizeAsync(fn) {
  const inFlight = new Map();
  return function memoized(key) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = fn(key);
    inFlight.set(key, promise);
    return promise;
  };
}
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { memoizeAsync } from "../single-flight.mjs";

// Concurrent calls for the same key must still be deduplicated.
{
  let calls = 0;
  const fn = async (key) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return \`\${key}-\${calls}\`;
  };
  const memoized = memoizeAsync(fn);
  const [a, b, c] = await Promise.all([memoized("k"), memoized("k"), memoized("k")]);
  assert.equal(calls, 1, "concurrent calls for the same key must share one underlying call");
  assert.equal(a, b);
  assert.equal(b, c);
}

// Sequential calls, after the previous one has fully settled, must NOT
// reuse the stale result forever.
{
  let calls = 0;
  const fn = async (key) => {
    calls++;
    return calls;
  };
  const memoized = memoizeAsync(fn);
  const first = await memoized("k");
  const second = await memoized("k");
  const third = await memoized("k");
  assert.deepEqual([first, second, third], [1, 2, 3], "each call after completion must invoke fn again");
}

// A rejection must not permanently poison the cache for that key.
{
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return "ok";
  };
  const memoized = memoizeAsync(fn);
  await assert.rejects(() => memoized("k"));
  const result = await memoized("k");
  assert.equal(result, "ok", "a failed call must not permanently poison the cache for that key");
}

// Different keys are always independent.
{
  let calls = 0;
  const fn = async (key) => {
    calls++;
    return \`\${key}:\${calls}\`;
  };
  const memoized = memoizeAsync(fn);
  const [a, b] = await Promise.all([memoized("x"), memoized("y")]);
  assert.equal(calls, 2);
  assert.notEqual(a, b);
}

console.log("verify: ok");
`;

/**
 * Runs the workspace's own `single-flight.test.mjs` against a fresh copy of
 * the *original, unfixed* `single-flight.mjs` in an isolated scratch
 * directory, and requires at least one test to fail there — proving the
 * written test actually reproduces the staleness bug rather than just
 * happening to pass either way.
 */
async function testReproducesTheBug(dir: string): Promise<boolean | AssertionResult> {
  const name = "test file fails against the original buggy implementation";
  const testPath = join(dir, "single-flight.test.mjs");
  let testContent: string;
  try {
    testContent = await readFile(testPath, "utf8");
  } catch {
    return { name, passed: false, message: "single-flight.test.mjs not found" };
  }

  const scratchDir = await mkdtemp(join(tmpdir(), "verify-single-flight-"));
  try {
    await writeFile(join(scratchDir, "single-flight.mjs"), SINGLE_FLIGHT_JS, "utf8");
    await writeFile(join(scratchDir, "single-flight.test.mjs"), testContent, "utf8");
    try {
      await execAsync("node --test", { cwd: scratchDir, timeout: 15_000 });
    } catch {
      // A non-zero exit means at least one test failed against the known-
      // buggy implementation — exactly what a real regression test should do.
      return true;
    }
    return {
      name,
      passed: false,
      message:
        "the written test passes even against the original, unfixed single-flight.mjs — it " +
        "does not actually reproduce the bug (e.g. it only covers the concurrent-dedup path, " +
        "which already worked)",
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const asyncSingleFlightMemoize: EvalTask = {
  id: "async-single-flight-memoize",
  description:
    "Write a test that reproduces a stale-forever async memoization bug, then fix it while " +
    "keeping concurrent-call deduplication working.",
  prompt:
    "memoizeAsync(fn) in single-flight.mjs is supposed to deduplicate CONCURRENT calls for the " +
    "same key (so overlapping calls only run fn once) but should call fn again for a call that " +
    "happens after the previous call for that key has already finished. Right now it caches the " +
    "result forever instead. There is no test file yet. Write a test in single-flight.test.mjs " +
    "that reproduces this bug — proving a call made after a previous call completed still gets " +
    "the stale result — then fix single-flight.mjs so concurrent calls are still deduplicated " +
    "but calls after completion are not.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "single-flight.mjs": SINGLE_FLIGHT_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    fileExists("single-flight.test.mjs"),
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    custom("test file actually reproduces the stale-forever bug", testReproducesTheBug),
  ],
  timeoutMs: 4 * 60_000,
  tags: ["write-test", "async", "debugging", "hard"],
};
