/**
 * Task: fix a race in a concurrency-limited promise pool.
 *
 * `runWithConcurrency` collects each worker's result with `results.push(...)`
 * instead of writing to `results[current]`, so the output order tracks
 * completion order (a race) instead of input order. The visible test uses
 * well-separated `setTimeout` delays so the wrong order is deterministic,
 * not flaky. The hidden verifier additionally checks the concurrency cap is
 * actually respected/used and that a rejection still propagates correctly.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, fileContains } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const POOL_JS = `/**
 * Run async \`tasks\` with at most \`limit\` running concurrently.
 *
 * Results must come back in the SAME ORDER as \`tasks\`, not completion
 * order. If any task rejects, the whole call rejects with that error.
 */
export async function runWithConcurrency(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results.push(await tasks[current]());
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}
`;

const POOL_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "./pool.mjs";

function delayed(value, ms) {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test("returns results in input order, not completion order", async () => {
  const tasks = [delayed("slow", 60), delayed("fast", 5)];
  const results = await runWithConcurrency(tasks, 2);
  assert.deepEqual(results, ["slow", "fast"]);
});

test("runs everything with a limit of 1 (fully sequential)", async () => {
  const order = [];
  const tasks = [1, 2, 3].map((n) => async () => {
    order.push(n);
    return n * 10;
  });
  const results = await runWithConcurrency(tasks, 1);
  assert.deepEqual(results, [10, 20, 30]);
  assert.deepEqual(order, [1, 2, 3]);
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { runWithConcurrency } from "../pool.mjs";

// 1. Order must match input order even though completion order differs.
{
  const delays = [70, 20, 45, 10, 60];
  const tasks = delays.map(
    (ms, i) => () => new Promise((resolve) => setTimeout(() => resolve(i), ms)),
  );
  const results = await runWithConcurrency(tasks, 3);
  assert.deepEqual(results, [0, 1, 2, 3, 4], "results must be in input order, not completion order");
}

// 2. The concurrency cap is actually respected AND actually used.
{
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, () => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return true;
  });
  await runWithConcurrency(tasks, 2);
  assert.ok(maxActive <= 2, \`concurrency cap violated: saw \${maxActive} running at once\`);
  assert.ok(maxActive >= 2, "should actually use the available concurrency, not run serially");
}

// 3. A rejection propagates instead of being swallowed.
{
  let threw = false;
  try {
    await runWithConcurrency(
      [() => Promise.resolve(1), () => Promise.reject(new Error("boom")), () => Promise.resolve(3)],
      2,
    );
  } catch (error) {
    threw = true;
    assert.match(String(error?.message ?? error), /boom/);
  }
  assert.ok(threw, "a rejected task must cause runWithConcurrency to reject");
}

console.log("verify: ok");
`;

export const asyncConcurrentTaskPool: EvalTask = {
  id: "async-concurrent-task-pool",
  description:
    "Fix a race in a concurrency-limited promise pool that collects results by completion " +
    "order instead of input order.",
  prompt:
    "runWithConcurrency(tasks, limit) in pool.mjs is supposed to run up to `limit` async tasks " +
    "at once and return their results in the same order as the `tasks` array, but pool.test.mjs " +
    "is failing. Find the bug and fix it so every test passes, without changing what the " +
    "function is supposed to do.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "pool.mjs": POOL_JS,
      "pool.test.mjs": POOL_TEST_JS,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    fileContains("pool.mjs", "runWithConcurrency"),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["async", "concurrency", "hard"],
};
