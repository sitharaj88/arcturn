/**
 * Runs a list of {@link EvalTask}s under a concurrency cap and aggregates the
 * results into a {@link SuiteResult} — pass rate, per-task results, aggregate
 * cost and tokens.
 */

import { addUsage, emptyUsage } from "@arcturn/core";
import type { Usage } from "@arcturn/types";
import { type AgentFactory, runTask, type TaskRunResult } from "./runner.js";
import type { EvalTask } from "./task.js";

/** Aggregate numbers across every task in a suite run. */
export interface SuiteSummary {
  /** Total tasks run. */
  readonly total: number;
  /** Tasks that passed. */
  readonly passed: number;
  /** Tasks abandoned to a provider failure, excluded from {@link passRate}. */
  readonly infra: number;
  /** Tasks that did not pass, for any reason. */
  readonly failed: number;
  /** `passed / total`, `0` when `total` is `0`. */
  readonly passRate: number;
  /** Summed cost in USD across every task. */
  readonly totalCostUsd: number;
  /** Summed token usage across every task. */
  readonly totalUsage: Usage;
  /** Summed wall-clock time across every task, in milliseconds. */
  readonly totalWallTimeMs: number;
}

/** The full result of one suite run — the JSON artifact shape. */
export interface SuiteResult {
  /** Model id or label the suite ran against, when known. */
  readonly model?: string;
  /** ISO timestamp the suite started. */
  readonly startedAt: string;
  /** ISO timestamp the suite finished. */
  readonly finishedAt: string;
  /** One result per task, in task-list order (not necessarily completion order). */
  readonly results: TaskRunResult[];
  /** Aggregate numbers derived from `results`. */
  readonly summary: SuiteSummary;
}

/** Options for {@link runSuite}. */
export interface RunSuiteOptions {
  /** Builds the agent for each task; called once per task. */
  agentFactory: AgentFactory;
  /** Maximum tasks run at once. Defaults to `4`. */
  concurrency?: number;
  /** Parent directory each task's isolated workspace is created under. */
  cwd?: string;
  /** Recorded on the result for later comparison; purely a label. */
  model?: string;
  /** Called as each task finishes, in completion order — useful for progress output. */
  onTaskComplete?: (result: TaskRunResult, completed: number, total: number) => void;
}

function summarize(results: TaskRunResult[]): SuiteSummary {
  const passed = results.filter((result) => result.passed).length;
  // A provider failure (429, overload, transport) measures the provider's
  // quota, not the agent, so it is reported separately and kept out of the
  // pass-rate denominator — otherwise a rate-limited run silently looks like
  // a model that cannot code.
  const infra = results.filter((result) => result.reason === "infra").length;
  const graded = results.length - infra;
  return {
    total: results.length,
    passed,
    failed: graded - passed,
    infra,
    passRate: graded === 0 ? 0 : passed / graded,
    totalCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    totalUsage: results.reduce((sum, result) => addUsage(sum, result.usage), emptyUsage()),
    totalWallTimeMs: results.reduce((sum, result) => sum + result.wallTimeMs, 0),
  };
}

/**
 * Run every task in `tasks`, up to `concurrency` at once, and aggregate the
 * results.
 *
 * @param tasks - Tasks to run, in the order results are returned.
 * @param options - Agent factory, concurrency cap and progress callback.
 */
export async function runSuite(tasks: EvalTask[], options: RunSuiteOptions): Promise<SuiteResult> {
  const startedAt = new Date().toISOString();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, Math.max(tasks.length, 1)));
  const results: TaskRunResult[] = new Array(tasks.length);
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const task = tasks[index];
      if (task === undefined) return;
      const result = await runTask(task, {
        agentFactory: options.agentFactory,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      results[index] = result;
      completed++;
      options.onTaskComplete?.(result, completed, tasks.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const finishedAt = new Date().toISOString();
  return {
    ...(options.model === undefined ? {} : { model: options.model }),
    startedAt,
    finishedAt,
    results,
    summary: summarize(results),
  };
}
