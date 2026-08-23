/**
 * Renders a {@link SuiteResult} as a terminal table or a JSON artifact, and
 * diffs two JSON runs (`compare`) so a regression — a task that passed
 * before and fails now — is easy to spot between runs or models.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { SuiteResult } from "./suite.js";

/** Write a suite result to disk as pretty-printed, diffable JSON. */
export async function writeReport(suite: SuiteResult, path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
}

/** Read a suite result previously written by {@link writeReport}. */
export async function readReport(path: string): Promise<SuiteResult> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as SuiteResult;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

function formatTokens(inputTokens: number, outputTokens: number): string {
  const total = inputTokens + outputTokens;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

/** ANSI color, applied only when the caller opts in (i.e. stdout is a TTY). */
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function colorize(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/** Options for {@link renderTable}. */
export interface RenderTableOptions {
  /** Use ANSI colors for pass/fail. Defaults to `false` (safe for files/tests). */
  color?: boolean;
}

/**
 * Render a suite result as a fixed-width terminal table plus a summary line.
 *
 * @param suite - The suite result to render.
 * @param options - Rendering options.
 */
export function renderTable(suite: SuiteResult, options: RenderTableOptions = {}): string {
  const color = options.color ?? false;
  const headers = [
    "STATUS",
    "TASK",
    "REASON",
    "CHECKS",
    "TURNS",
    "TOOLS",
    "TOKENS",
    "COST",
    "TIME",
  ];
  const rows = suite.results.map((result) => {
    const toolCallTotal = Object.values(result.toolCalls).reduce((sum, n) => sum + n, 0);
    return [
      // An ungraded run is neither a pass nor a failure: labelling a provider
      // outage "FAIL" is what made the first GLM-5.3 run look like a bad model.
      result.reason === "infra"
        ? colorize("INFRA", YELLOW, color)
        : result.passed
          ? colorize("PASS", GREEN, color)
          : colorize("FAIL", RED, color),
      result.taskId,
      result.reason,
      // Assertions are reported even on a failed run, because "solved it but
      // never stopped" and "never solved it" are different defects and the
      // status alone cannot tell them apart — a real GLM-5.3 timeout passed
      // every assertion.
      `${result.assertions.filter((a) => a.passed).length}/${result.assertions.length}`,
      String(result.turns),
      String(toolCallTotal),
      formatTokens(result.usage.inputTokens, result.usage.outputTokens),
      formatCost(result.costUsd),
      formatMs(result.wallTimeMs),
    ];
  });

  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI codes `colorize` added.
  const ansiPattern = /\x1b\[\d+m/g;
  const visibleLength = (cell: string): number => cell.replace(ansiPattern, "").length;
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => visibleLength(row[i] ?? ""))),
  );

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, i) => {
        const width = widths[i] ?? cell.length;
        // Pad using the *visible* length so ANSI codes never throw off alignment.
        return pad(cell, width + (cell.length - visibleLength(cell)));
      })
      .join("  ");

  const lines = [renderRow(headers), renderRow(headers.map((h) => "-".repeat(h.length)))];
  for (const row of rows) lines.push(renderRow(row));

  const { summary } = suite;
  const summaryLine = [
    // `infra` post-dates the first reports written to disk, and `compare`
    // reads those, so its absence must degrade to "nothing was ungraded".
    `${summary.passed}/${summary.total - (summary.infra ?? 0)} passed ` +
      `(${(summary.passRate * 100).toFixed(0)}%)` +
      ((summary.infra ?? 0) > 0 ? ` [${summary.infra} not graded: provider errors]` : ""),
    `cost ${formatCost(summary.totalCostUsd)}`,
    `tokens ${formatTokens(summary.totalUsage.inputTokens, summary.totalUsage.outputTokens)}`,
    `time ${formatMs(summary.totalWallTimeMs)}`,
    ...(suite.model ? [`model ${suite.model}`] : []),
  ].join("  |  ");

  lines.push("", summaryLine);
  return lines.join("\n");
}

/** Pass/fail state of one task in one run, for {@link compare}. */
export type TaskOutcome = "passed" | "failed" | "missing";

/** Whether a task got better, worse, or stayed the same between two runs. */
export type ComparisonStatus =
  | "regression"
  | "improvement"
  | "unchanged"
  | "newTask"
  | "removedTask";

/** One task's before/after outcome. */
export interface TaskComparison {
  readonly taskId: string;
  readonly before: TaskOutcome;
  readonly after: TaskOutcome;
  readonly status: ComparisonStatus;
}

/** The result of diffing two suite runs. */
export interface CompareResult {
  readonly before: { readonly model?: string; readonly passRate: number; readonly total: number };
  readonly after: { readonly model?: string; readonly passRate: number; readonly total: number };
  readonly tasks: TaskComparison[];
  /** Tasks that passed in `before` and fail in `after` — the signal to act on. */
  readonly regressions: TaskComparison[];
  /** Tasks that failed in `before` and pass in `after`. */
  readonly improvements: TaskComparison[];
}

function outcomeOf(result: TaskRunResultLike | undefined): TaskOutcome {
  if (result === undefined) return "missing";
  return result.passed ? "passed" : "failed";
}

interface TaskRunResultLike {
  readonly passed: boolean;
}

/**
 * Diff two suite runs and classify every task by what changed.
 *
 * A "regression" is exactly what it sounds like: a task that passed in `a`
 * and fails in `b`. Tasks present in only one run are `newTask`/`removedTask`
 * rather than a regression or improvement, since there is nothing to compare.
 *
 * @param a - The earlier (or baseline) run.
 * @param b - The later (or candidate) run.
 */
export function compare(a: SuiteResult, b: SuiteResult): CompareResult {
  const before = new Map(a.results.map((result) => [result.taskId, result]));
  const after = new Map(b.results.map((result) => [result.taskId, result]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((x, y) => x.localeCompare(y));

  const tasks: TaskComparison[] = ids.map((taskId) => {
    const beforeOutcome = outcomeOf(before.get(taskId));
    const afterOutcome = outcomeOf(after.get(taskId));
    let status: ComparisonStatus;
    if (beforeOutcome === "missing") status = "newTask";
    else if (afterOutcome === "missing") status = "removedTask";
    else if (beforeOutcome === "passed" && afterOutcome === "failed") status = "regression";
    else if (beforeOutcome === "failed" && afterOutcome === "passed") status = "improvement";
    else status = "unchanged";
    return { taskId, before: beforeOutcome, after: afterOutcome, status };
  });

  return {
    before: { model: a.model, passRate: a.summary.passRate, total: a.summary.total },
    after: { model: b.model, passRate: b.summary.passRate, total: b.summary.total },
    tasks,
    regressions: tasks.filter((t) => t.status === "regression"),
    improvements: tasks.filter((t) => t.status === "improvement"),
  };
}

/** Options for {@link renderCompare}. */
export interface RenderCompareOptions {
  /** Use ANSI colors for regressions/improvements. Defaults to `false`. */
  color?: boolean;
}

/** Render a {@link CompareResult} as readable text, regressions called out first. */
export function renderCompare(result: CompareResult, options: RenderCompareOptions = {}): string {
  const color = options.color ?? false;
  const lines: string[] = [];
  const fmtPct = (rate: number): string => `${(rate * 100).toFixed(0)}%`;
  lines.push(
    `before: ${fmtPct(result.before.passRate)} ` +
      `(${result.before.total} tasks${result.before.model ? `, ${result.before.model}` : ""})`,
    `after:  ${fmtPct(result.after.passRate)} ` +
      `(${result.after.total} tasks${result.after.model ? `, ${result.after.model}` : ""})`,
    "",
  );

  if (result.regressions.length > 0) {
    lines.push(colorize(`REGRESSIONS (${result.regressions.length}):`, RED, color));
    for (const task of result.regressions) lines.push(`  - ${task.taskId} (passed -> failed)`);
    lines.push("");
  } else {
    lines.push("No regressions.");
  }

  if (result.improvements.length > 0) {
    lines.push(colorize(`Improvements (${result.improvements.length}):`, GREEN, color));
    for (const task of result.improvements) lines.push(`  - ${task.taskId} (failed -> passed)`);
    lines.push("");
  }

  const newTasks = result.tasks.filter((t) => t.status === "newTask");
  const removedTasks = result.tasks.filter((t) => t.status === "removedTask");
  if (newTasks.length > 0) {
    const ids = newTasks.map((t) => t.taskId).join(", ");
    lines.push(colorize(`New tasks (${newTasks.length}): ${ids}`, DIM, color));
  }
  if (removedTasks.length > 0) {
    const ids = removedTasks.map((t) => t.taskId).join(", ");
    lines.push(colorize(`Removed tasks (${removedTasks.length}): ${ids}`, DIM, color));
  }

  return lines.join("\n");
}
