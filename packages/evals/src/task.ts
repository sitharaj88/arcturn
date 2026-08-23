/**
 * The task format: an {@link EvalTask} is one honest coding assignment plus a
 * fixture and a set of programmatic {@link Assertion}s that grade the result
 * without asking another LLM to judge it.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Outcome of one {@link Assertion} check. */
export interface AssertionResult {
  /** Human-readable name, shown in reports. */
  readonly name: string;
  /** Whether the check passed. */
  readonly passed: boolean;
  /** Explanation, populated when `passed` is `false` (and optionally otherwise). */
  readonly message?: string;
}

/**
 * A single programmatic check run against the task's workspace after the
 * agent finishes. Composable: an {@link EvalTask} lists as many as it needs.
 */
export interface Assertion {
  /** Human-readable name, shown in reports. */
  readonly name: string;
  /**
   * Evaluate the assertion.
   *
   * @param dir - Absolute path to the task's isolated workspace.
   */
  check(dir: string): Promise<AssertionResult>;
}

/**
 * One eval task: a prompt, a fixture, and how to grade the result.
 *
 * Tasks must be small, self-contained and honest — a competent agent should
 * be able to fail them. `setup` only ever writes into the isolated workspace
 * handed to it; it must never touch the real filesystem outside `dir`.
 */
export interface EvalTask {
  /** Stable, unique identifier (used for filtering and in reports). */
  readonly id: string;
  /** One-line human description of what this task measures. */
  readonly description: string;
  /** The prompt handed to the agent verbatim. */
  readonly prompt: string;
  /**
   * Materialize the fixture into an empty temp directory: write files,
   * optionally `git init`. Runs before the agent sees the workspace.
   *
   * @param dir - Absolute path to the freshly created, empty workspace.
   */
  setup(dir: string): Promise<void> | void;
  /** Programmatic checks run against the workspace once the agent stops. */
  readonly assertions: Assertion[];
  /** Wall-clock budget for this task. Defaults to the runner's default. */
  readonly timeoutMs?: number;
  /** Free-form labels for filtering (`--tasks`) and reporting. */
  readonly tags?: string[];
}

function pass(name: string): AssertionResult {
  return { name, passed: true };
}

function failure(name: string, message: string): AssertionResult {
  return { name, passed: false, message };
}

/** Assert that a file exists in the workspace. */
export function fileExists(path: string): Assertion {
  const name = `fileExists(${path})`;
  return {
    name,
    async check(dir: string): Promise<AssertionResult> {
      return existsSync(join(dir, path)) ? pass(name) : failure(name, `expected ${path} to exist`);
    },
  };
}

/** Assert that a file exists and its content contains a string, or matches a regex. */
export function fileContains(path: string, needle: string | RegExp): Assertion {
  const label = needle instanceof RegExp ? needle.toString() : JSON.stringify(needle);
  const name = `fileContains(${path}, ${label})`;
  return {
    name,
    async check(dir: string): Promise<AssertionResult> {
      let content: string;
      try {
        content = await readFile(join(dir, path), "utf8");
      } catch {
        return failure(name, `expected ${path} to exist and be readable`);
      }
      const matched = needle instanceof RegExp ? needle.test(content) : content.includes(needle);
      return matched ? pass(name) : failure(name, `${path} did not match ${label}`);
    },
  };
}

/** Assert that a file exists and its content satisfies an arbitrary predicate. */
export function fileMatches(
  path: string,
  predicate: (content: string) => boolean | Promise<boolean>,
  description?: string,
): Assertion {
  const name = description ?? `fileMatches(${path})`;
  return {
    name,
    async check(dir: string): Promise<AssertionResult> {
      let content: string;
      try {
        content = await readFile(join(dir, path), "utf8");
      } catch {
        return failure(name, `expected ${path} to exist and be readable`);
      }
      const passed = await predicate(content);
      return passed ? pass(name) : failure(name, `${path} failed "${name}"`);
    },
  };
}

/** Options for {@link commandSucceeds}. */
export interface CommandSucceedsOptions {
  /** Directory to run the command in, relative to the workspace root. Defaults to the root. */
  cwd?: string;
  /** Kill the command after this many milliseconds. Defaults to 30s. */
  timeoutMs?: number;
  /** Extra environment variables, merged over `process.env`. */
  env?: Record<string, string | undefined>;
}

function summarizeExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const { message, stdout, stderr } = error as {
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const tail = (text: string | undefined): string =>
      (text ?? "").trim().split("\n").slice(-15).join("\n");
    const parts = [message ?? String(error)];
    if (stdout && stdout.trim() !== "") parts.push(`stdout (tail):\n${tail(stdout)}`);
    if (stderr && stderr.trim() !== "") parts.push(`stderr (tail):\n${tail(stderr)}`);
    return parts.join("\n\n");
  }
  return String(error);
}

/**
 * Assert that a shell command exits with status 0 — e.g. the fixture's own
 * test suite (`node --test`).
 */
export function commandSucceeds(command: string, options: CommandSucceedsOptions = {}): Assertion {
  const name = `commandSucceeds(${command})`;
  return {
    name,
    async check(dir: string): Promise<AssertionResult> {
      const cwd = options.cwd ? join(dir, options.cwd) : dir;
      try {
        await execAsync(command, {
          cwd,
          timeout: options.timeoutMs ?? 30_000,
          env: { ...process.env, ...options.env },
        });
        return pass(name);
      } catch (error) {
        return failure(name, summarizeExecError(error));
      }
    },
  };
}

/** Assert that none of the given paths (present after `setup`) were deleted by the agent. */
export function noFileDeleted(paths: string[]): Assertion {
  const name = `noFileDeleted(${paths.join(", ")})`;
  return {
    name,
    async check(dir: string): Promise<AssertionResult> {
      const missing = paths.filter((path) => !existsSync(join(dir, path)));
      return missing.length === 0 ? pass(name) : failure(name, `deleted: ${missing.join(", ")}`);
    },
  };
}

/** Escape hatch: an arbitrary programmatic check over the workspace. */
export function custom(
  name: string,
  fn: (dir: string) => boolean | AssertionResult | Promise<boolean | AssertionResult>,
): Assertion {
  return {
    name,
    async check(dir: string): Promise<AssertionResult> {
      const result = await fn(dir);
      if (typeof result === "boolean") {
        return result ? pass(name) : failure(name, `custom assertion "${name}" failed`);
      }
      return result;
    },
  };
}
