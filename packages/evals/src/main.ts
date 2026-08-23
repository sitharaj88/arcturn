#!/usr/bin/env node
/**
 * `arcturn-evals` — the eval harness CLI.
 *
 * `arcturn-evals run` drives a real Arcturn agent (via `arcturn`'s `buildRuntime`,
 * the exact wiring the `arcturn` binary itself runs on) through every task in
 * the starter suite and reports pass/fail. This needs a real model and a
 * real API key: there is no way to honestly measure whether an agent
 * completes a coding task without actually running one.
 *
 * `arcturn-evals compare` diffs two JSON reports produced by `run` and flags
 * regressions — tasks that passed before and fail now.
 */

import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@arcturn/ai";
import { globToRegExp } from "@arcturn/core";
import type { ModelSpec } from "@arcturn/types";
import {
  buildRuntime,
  DEFAULT_MODEL,
  ModelResolutionError,
  registerBundledCatalog,
  resolveModelSpec,
} from "arcturn";
import { compare, readReport, renderCompare, renderTable, writeReport } from "./report.js";
import type { AgentFactory } from "./runner.js";
import { runSuite } from "./suite.js";
import { ALL_TASKS } from "./tasks/index.js";

const HELP = `arcturn-evals - task-level eval harness for the Arcturn agent

Usage:
  arcturn-evals run [options]
  arcturn-evals compare <a.json> <b.json>
  arcturn-evals --help

run options:
  --model <id>        Model id to drive the agent with (default: ${DEFAULT_MODEL})
  --tasks <glob>       Only run tasks whose id matches this glob (e.g. "fix-*")
  --concurrency <n>    Maximum tasks run at once (default: 4)
  --json <path>        Also write the full JSON report to this path

compare exits 1 when the later run has any regression (a task that passed
before and fails now); run exits 1 when any task failed.

Running a suite needs network access and a real API key for --model (or
$ANTHROPIC_API_KEY / the relevant provider variable by default) — there is
no way to honestly measure whether an agent completes a task without
actually running one.
`;

interface RunCliOptions {
  model?: string;
  tasksGlob?: string;
  concurrency?: number;
  jsonOut?: string;
}

function parseRunArgs(argv: string[]): RunCliOptions | { error: string } {
  const options: RunCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--model": {
        const value = argv[++i];
        if (value === undefined) return { error: "--model needs a value" };
        options.model = value;
        break;
      }
      case "--tasks": {
        const value = argv[++i];
        if (value === undefined) return { error: "--tasks needs a value" };
        options.tasksGlob = value;
        break;
      }
      case "--concurrency": {
        const value = argv[++i];
        const n = value === undefined ? Number.NaN : Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { error: "--concurrency needs a positive integer" };
        }
        options.concurrency = n;
        break;
      }
      case "--json": {
        const value = argv[++i];
        if (value === undefined) return { error: "--json needs a file path" };
        options.jsonOut = value;
        break;
      }
      default:
        return { error: `unknown option "${arg}"` };
    }
  }
  return options;
}

function isOptionsError(value: RunCliOptions | { error: string }): value is { error: string } {
  return "error" in value;
}

async function runCommand(options: RunCliOptions): Promise<number> {
  registerBundledCatalog();

  let model: ModelSpec;
  try {
    model = resolveModelSpec(options.model ?? DEFAULT_MODEL, process.env);
  } catch (error) {
    if (error instanceof ModelResolutionError) {
      process.stderr.write(`arcturn-evals: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const tasks = options.tasksGlob
    ? ALL_TASKS.filter((task) => globToRegExp(options.tasksGlob as string).test(task.id))
    : ALL_TASKS;
  if (tasks.length === 0) {
    process.stderr.write(`arcturn-evals: no tasks match "${options.tasksGlob}".\n`);
    return 2;
  }

  const homeDir = await mkdtemp(join(tmpdir(), "arcturn-evals-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "arcturn-evals-run-"));

  // A batch run values finishing over responding quickly, the opposite of the
  // interactive CLI, whose default policy gives up after ~3.5s. Providers rate
  // limit hard on frontier models — a GLM-5.3 run left 16 of 18 tasks ungraded
  // on 429s — so eval runs wait far longer before abandoning a task.
  const patientClient = createClient({
    retry: { maxAttempts: 8, initialDelayMs: 2_000, maxDelayMs: 90_000, maxRetryAfterMs: 120_000 },
  });

  // Every task gets its own runtime, isolated under a throwaway ARCTURN_HOME so
  // a suite run never touches the real user's ~/.arcturn session/checkpoint state.
  const agentFactory: AgentFactory = async (cwd: string) => {
    const runtime = await buildRuntime({
      cwd,
      home: homeDir,
      model: model.id,
      permissionMode: "yolo",
      extensions: false,
      skipRepoLookup: true,
      llm: patientClient,
    });
    return { agent: runtime.agent, dispose: () => runtime.dispose() };
  };

  process.stderr.write(
    `arcturn-evals: running ${tasks.length} task(s) against ${model.displayName}...\n`,
  );

  try {
    const suite = await runSuite(tasks, {
      agentFactory,
      cwd: workspaceRoot,
      model: model.id,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      onTaskComplete: (result) => {
        const label = result.passed ? "PASS" : "FAIL";
        process.stderr.write(
          `arcturn-evals: ${label} ${result.taskId} (${result.reason}, ${result.wallTimeMs}ms)\n`,
        );
      },
    });

    process.stdout.write(`${renderTable(suite, { color: process.stdout.isTTY === true })}\n`);

    if (options.jsonOut) {
      await writeReport(suite, options.jsonOut);
      process.stderr.write(`arcturn-evals: wrote ${options.jsonOut}\n`);
    }

    return suite.summary.failed === 0 ? 0 : 1;
  } finally {
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function compareCommand(pathA: string, pathB: string): Promise<number> {
  const [a, b] = await Promise.all([readReport(pathA), readReport(pathB)]);
  const result = compare(a, b);
  process.stdout.write(`${renderCompare(result, { color: process.stdout.isTTY === true })}\n`);
  return result.regressions.length === 0 ? 0 : 1;
}

/**
 * Run the `arcturn-evals` CLI.
 *
 * @param argv - Arguments without the node binary and script path.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    process.stderr.write(HELP);
    return 2;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "run") {
    const parsed = parseRunArgs([...rest]);
    if (isOptionsError(parsed)) {
      process.stderr.write(`arcturn-evals: ${parsed.error}\n\n${HELP}`);
      return 2;
    }
    return runCommand(parsed);
  }
  if (command === "compare") {
    const [a, b] = rest;
    if (a === undefined || b === undefined) {
      process.stderr.write(`arcturn-evals: compare needs two JSON report paths.\n\n${HELP}`);
      return 2;
    }
    return compareCommand(a, b);
  }

  process.stderr.write(`arcturn-evals: unknown command "${command}".\n\n${HELP}`);
  return 2;
}

/**
 * Whether this module is the process entry point.
 *
 * `process.argv[1]` may be a bin symlink while `import.meta.url` always
 * points at the real file, so both are resolved through `realpath` first.
 */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `arcturn-evals: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
