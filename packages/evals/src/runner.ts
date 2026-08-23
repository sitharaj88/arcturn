/**
 * Drives one {@link EvalTask}: materializes an isolated workspace, runs a
 * real agent to completion (or until it times out), then grades the result
 * against every assertion.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@arcturn/core";
import { addUsage, emptyUsage } from "@arcturn/core";
import type { AgentEvent, Usage } from "@arcturn/types";
import type { AssertionResult, EvalTask } from "./task.js";

/** An agent plus optional teardown, returned by an {@link AgentFactory}. */
export interface CreatedAgent {
  /** The agent to drive; must be freshly bound to the workspace `cwd`. */
  agent: Agent;
  /** Torn down after the task finishes (pass, fail, timeout or error). */
  dispose?: () => Promise<void> | void;
}

/**
 * Builds (or resumes) the agent that will drive one task, bound to its
 * isolated workspace.
 *
 * @param cwd - Absolute path to the task's isolated workspace.
 */
export type AgentFactory = (cwd: string) => Agent | CreatedAgent | Promise<Agent | CreatedAgent>;

/** Default wall-clock budget for a task with no `timeoutMs` of its own. */
export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;

/** One tool call, in the order it happened. */
export interface ToolTraceEntry {
  /** Completed turns before this call — a cheap proxy for search rounds. */
  readonly turn: number;
  /** Tool name. */
  readonly tool: string;
  /** The path, pattern or command the call acted on, when it has one. */
  readonly subject?: string;
  /** Milliseconds since the run began. */
  readonly at: number;
}

/**
 * The argument a tool call acted on, for the trace.
 *
 * Deliberately the same well-known keys the permission engine derives its
 * subject from, so a trace entry names the same thing a permission prompt
 * would have.
 */
function subjectOf(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "pattern", "query", "command", "url", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 200);
  }
  return undefined;
}

/** Why a task run stopped. */
export type RunReason = "completed" | "aborted" | "timeout" | "error" | "infra";

/**
 * Provider-side failures that say nothing about whether the agent can do the
 * task: rate limits, auth problems, overload, transport errors.
 *
 * These are reported as `"infra"` and excluded from the pass rate. Counting a
 * 429 as a failed task produces a number that measures the provider's quota
 * rather than the agent, which is worse than no number at all.
 */
const INFRA_ERROR_PATTERN = new RegExp(
  [
    "\\b(429|503|502|504)\\b",
    "rate.?limit",
    "quota",
    "overloaded",
    // The OpenAI SDK reports a dropped transport as a bare "Connection error.",
    // which a word-boundary list misses — it cost a real GLM-5.3 run a task.
    "connection error",
    "network error",
    "socket hang up",
    "fetch failed",
    "\\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\\b",
  ].join("|"),
  "i",
);

/** Whether an error message describes an infrastructure failure. */
export function isInfraFailure(message: string | undefined): boolean {
  return message !== undefined && INFRA_ERROR_PATTERN.test(message);
}

/** Full result of driving one task and grading its workspace. */
export interface TaskRunResult {
  /** The task's id, for correlating with the suite it ran in. */
  readonly taskId: string;
  /** `true` only when the run completed and every assertion passed. */
  readonly passed: boolean;
  /** Why the run stopped. */
  readonly reason: RunReason;
  /** Populated when `reason` is `"error"`, or the run threw. */
  readonly errorMessage?: string;
  /** Per-assertion outcomes, in the order declared on the task. */
  readonly assertions: AssertionResult[];
  /** Completed model turns. */
  readonly turns: number;
  /** Tool calls made, counted by name. */
  readonly toolCalls: Record<string, number>;
  /** Every tool call in order, so retrieval behaviour is measurable. */
  readonly trace: readonly ToolTraceEntry[];
  /** Summed token usage across every turn. */
  readonly usage: Usage;
  /** Summed cost in USD, best effort (0 when the model has no known pricing). */
  readonly costUsd: number;
  /** Wall-clock duration of the whole task, in milliseconds. */
  readonly wallTimeMs: number;
  /** The agent's final assistant text. */
  readonly finalText: string;
  /** Present only when the workspace was kept (i.e. the task failed), for inspection. */
  readonly workspaceDir?: string;
}

/** Options for {@link runTask}. */
export interface RunTaskOptions {
  /** Builds the agent that will drive this task, bound to its isolated workspace. */
  agentFactory: AgentFactory;
  /** Parent directory the isolated workspace is created under. Defaults to `os.tmpdir()`. */
  cwd?: string;
}

function isCreatedAgent(value: Agent | CreatedAgent): value is CreatedAgent {
  return typeof value === "object" && value !== null && "agent" in value;
}

function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one task to completion in an isolated temp workspace and grade it.
 *
 * The workspace is deleted on success; on failure it is left in place (its
 * path is on {@link TaskRunResult.workspaceDir}) so a human can inspect what
 * the agent actually did.
 *
 * @param task - The task to run.
 * @param options - The agent factory and where to root the temp workspace.
 */
export async function runTask(task: EvalTask, options: RunTaskOptions): Promise<TaskRunResult> {
  const baseDir = options.cwd ?? tmpdir();
  await mkdir(baseDir, { recursive: true });
  const workspaceDir = await mkdtemp(join(baseDir, `arcturn-evals-${sanitizeForPath(task.id)}-`));

  const startedAt = Date.now();
  let dispose: (() => Promise<void> | void) | undefined;
  const toolCalls: Record<string, number> = {};
  const trace: ToolTraceEntry[] = [];
  let turns = 0;
  let usage: Usage = emptyUsage();
  let costUsd = 0;
  let finalText = "";
  let timedOut = false;
  let ranSetup = false;
  // Held in an object rather than `let` bindings: the assignments below
  // happen inside an event-listener callback, which control-flow analysis
  // cannot see — a `let` would keep narrowing to whatever was last assigned
  // in the *linear* code, hiding the outcomes the listener actually sets.
  const outcome: { reason: RunReason; errorMessage?: string } = { reason: "error" };

  try {
    await task.setup(workspaceDir);
    ranSetup = true;

    const created = await options.agentFactory(workspaceDir);
    const agent = isCreatedAgent(created) ? created.agent : created;
    dispose = isCreatedAgent(created) ? created.dispose : undefined;

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "toolStart") {
        toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
        // Counting tool *names* cannot answer any question about retrieval:
        // which paths were searched, what was read, how many rounds it took to
        // reach the file that mattered. Recording the ordered call trace makes
        // those measurable from runs already being paid for.
        trace.push({
          turn: turns,
          tool: event.toolName,
          subject: subjectOf(event.input),
          at: Date.now() - startedAt,
        });
      } else if (event.type === "turnEnd") {
        turns++;
        usage = addUsage(usage, event.usage);
        costUsd += event.usage.costUsd ?? 0;
      } else if (event.type === "runEnd") {
        outcome.reason = event.reason;
        outcome.errorMessage = event.errorMessage;
      }
    });

    const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, timeoutMs);

    try {
      await agent.prompt(task.prompt);
    } catch (error) {
      outcome.reason = "error";
      outcome.errorMessage = errorMessageOf(error);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }

    if (timedOut) outcome.reason = "timeout";
    // A provider failure is not the agent failing the task.
    if (outcome.reason === "error" && isInfraFailure(outcome.errorMessage)) {
      outcome.reason = "infra";
    }
    finalText = agent.finalText();
  } catch (error) {
    outcome.errorMessage = errorMessageOf(error);
    outcome.reason = isInfraFailure(outcome.errorMessage) ? "infra" : "error";
  } finally {
    if (dispose) {
      try {
        await dispose();
      } catch {
        // Teardown failures must never mask the task's real outcome.
      }
    }
  }

  const wallTimeMs = Date.now() - startedAt;

  const assertions: AssertionResult[] = [];
  if (ranSetup) {
    for (const assertion of task.assertions) {
      try {
        assertions.push(await assertion.check(workspaceDir));
      } catch (error) {
        assertions.push({
          name: assertion.name,
          passed: false,
          message: `assertion threw: ${errorMessageOf(error)}`,
        });
      }
    }
  }

  const passed = outcome.reason === "completed" && assertions.every((a) => a.passed);

  const result: TaskRunResult = {
    taskId: task.id,
    passed,
    reason: outcome.reason,
    ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
    assertions,
    turns,
    toolCalls,
    trace,
    usage,
    costUsd,
    wallTimeMs,
    finalText,
    ...(passed ? {} : { workspaceDir }),
  };

  if (passed) {
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
