/**
 * `@arcturn/evals` — a task-level eval harness for the Arcturn agent.
 *
 * Unlike the ~1255 unit tests elsewhere in the monorepo, this package
 * measures whether a real, driven agent actually *completes* honest coding
 * tasks — grading the result with programmatic assertions on the workspace,
 * never an LLM judge.
 *
 * ```ts
 * import { ALL_TASKS, runSuite, renderTable } from "@arcturn/evals";
 *
 * const suite = await runSuite(ALL_TASKS, { agentFactory, concurrency: 4 });
 * console.log(renderTable(suite));
 * ```
 *
 * @packageDocumentation
 */

export type {
  CompareResult,
  ComparisonStatus,
  RenderCompareOptions,
  RenderTableOptions,
  TaskComparison,
  TaskOutcome,
} from "./report.js";
export { compare, readReport, renderCompare, renderTable, writeReport } from "./report.js";
export type {
  AgentFactory,
  CreatedAgent,
  RunReason,
  RunTaskOptions,
  TaskRunResult,
} from "./runner.js";
export { DEFAULT_TASK_TIMEOUT_MS, runTask } from "./runner.js";
export type { RunSuiteOptions, SuiteResult, SuiteSummary } from "./suite.js";
export { runSuite } from "./suite.js";
export type { Assertion, AssertionResult, CommandSucceedsOptions, EvalTask } from "./task.js";
export {
  commandSucceeds,
  custom,
  fileContains,
  fileExists,
  fileMatches,
  noFileDeleted,
} from "./task.js";
export { ALL_TASKS } from "./tasks/index.js";
