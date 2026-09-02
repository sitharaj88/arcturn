/**
 * Orchestration, asserted on **effects** rather than on return values.
 *
 * The limits that make workflows, teams and background agents safe to spend
 * money on — a run budget, a step deadline, a role's turn ceiling, the promise
 * that an `exec`-lane role cannot reach the user's checkout — were all covered
 * by tests that read the field back out, or read the error string the engine
 * chose. A limit nobody has ever crossed is not a limit, and a lane guarantee
 * proved by "no `git apply` was issued" is a claim about the code, not about
 * the tree.
 *
 * So every test here crosses the limit and then asks the world what happened:
 * how many requests the model actually received, whether a real pid is still
 * alive, whether the bytes in a real checkout moved, whether a journal line
 * exists on disk. Where a stop is asserted, the matching *non*-stop is
 * asserted beside it, so "the pipeline halted" can never be satisfied by a
 * pipeline that never ran.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText } from "@arcturn/core";
import type { LLMRequest } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import {
  addOrgMemoryEntry,
  loadOrgMemoryInjector,
  setOrgMemoryStatus,
  writeOrgMemory,
} from "./org-memory.js";
import type { ArcturnRuntime } from "./runtime.js";
import { type FakeLLM, fakeLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  createRuntimeRunStep,
  createRuntimeWriteLane,
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WorkflowStepRequest,
  type WriteLane,
  type WriteLaneHost,
} from "./workflow.js";
import {
  buildResumeState,
  createFileRunJournal,
  type JournalLine,
  type ResumeState,
  readJournalLines,
} from "./workflow-run.js";
import { foldJournal, summariseRun } from "./workflow-status.js";

const execFileAsync = (cmd: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { cwd }, (error) => (error ? reject(error) : resolve()));
  });

const runtimes: ArcturnRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** These drive a real POSIX shell and real process groups. */
const itPosix = it.skipIf(process.platform === "win32");

/** Does this path exist at all? */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A scratch tree whose project directory is a real git repository. */
async function gitScratch(seed: Record<string, string> = {}): Promise<Scratch> {
  const scratch = await makeScratch();
  roots.push(scratch.root);
  const git = (...args: string[]): Promise<void> => execFileAsync("git", args, scratch.cwd);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  // Pin the line-ending policy so a checkout's bytes are the repository's
  // decision and not the runner's — Git for Windows would otherwise rewrite
  // every file these tests compare.
  await git("config", "core.autocrlf", "false");
  await git("config", "core.eol", "lf");
  for (const [path, body] of Object.entries({ "seed.txt": "seed\n", ...seed })) {
    await mkdir(join(scratch.cwd, path, ".."), { recursive: true });
    await writeFile(join(scratch.cwd, path), body, "utf8");
  }
  await git("add", "-A");
  await git("commit", "-qm", "base");
  return scratch;
}

/** `git status --porcelain` for a checkout — empty means nothing moved. */
async function porcelain(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["status", "--porcelain"], { cwd }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

/** Build a real runtime over `scratch`, holding on to the scripted client. */
async function runtimeWith(
  scratch: Scratch,
  llm: FakeLLM,
  overrides: Parameters<typeof buildTestRuntime>[2] = {},
): Promise<ArcturnRuntime> {
  const runtime = await buildTestRuntime(scratch, [], {
    llm,
    permissionMode: "yolo",
    onPermissionAsk: async (request) => ({
      requestId: request.id,
      behavior: "deny" as const,
      message: "no interactive user in this test",
    }),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

/** A role definition with explicit tools — the only shape a workflow dispatches. */
function role(name: string, tools: string[], extra: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    description: `${name} role`,
    systemPrompt: `You are ${name}.`,
    tools,
    source: "<test>",
    ...extra,
  };
}

/** Parse a workflow and assert it parsed. */
function parseOk(raw: string, name = "wf"): Workflow {
  const parsed = parseWorkflow(raw, { name });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow, got: ${parsed.error}`);
  return parsed;
}

/** The first step of `workflow`, as a runnable request. */
function firstRequest(
  workflow: Workflow,
  overrides: Partial<WorkflowStepRequest> = {},
): WorkflowStepRequest {
  const step = workflow.stages[0]?.steps[0];
  if (!step) throw new Error("workflow has no first step");
  return {
    step,
    prompt: step.prompt,
    signal: new AbortController().signal,
    ...(step.agent === undefined ? {} : { agent: step.agent }),
    ...overrides,
  };
}

/**
 * A run's journal once its terminal `runEnd` has landed.
 *
 * `runWorkflow` appends that one line fire-and-forget (see `finish`'s note:
 * a finished run must not be held up by a last write), so a test that reads
 * the file the instant the promise resolves can legitimately miss it. Every
 * other line these tests assert on is written durably and needs no poll.
 *
 * @param dir - The run's journal directory.
 * @param status - The terminal status to wait for; any terminal by default.
 */
async function journalOnceEnded(
  dir: string,
  status?: "done" | "failed" | "cancelled" | "paused",
): Promise<JournalLine[]> {
  for (let i = 0; i < 100; i += 1) {
    const lines = await readJournalLines(dir);
    const end = lines.findLast(
      (line): line is Extract<JournalLine, { kind: "runEnd" }> => line.kind === "runEnd",
    );
    if (end !== undefined && (status === undefined || end.status === status)) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`journal at ${dir} never recorded a ${status ?? "terminal"} runEnd`);
}

/** The production write lane over a real runtime and a real repository. */
function laneFor(runtime: ArcturnRuntime, runId: string): WriteLane {
  return createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId);
}

// ===================================================================== maxTurns

describe("a role's maxTurns, counted rather than trusted", () => {
  /**
   * A model that never stops asking for another tool call, so the *only*
   * thing that can end the loop is the ceiling under test.
   */
  const loopForever = (): FakeLLM =>
    fakeLLM([{ toolCalls: [{ id: "c", name: "read", arguments: { path: "seed.txt" } }] }]);

  it("stops a write-lane role at exactly the number of turns its role file declares", async () => {
    const scratch = await gitScratch();
    const llm = loopForever();
    const runtime = await runtimeWith(scratch, llm);

    const developer = role("developer", ["read", "edit"], { maxTurns: 3 });
    const workflow = parseOk("---\nname: demo\n---\n1. @developer keep going\n");
    const outcome = await createRuntimeRunStep(runtime, {
      resolveAgent: () => developer,
      writeLane: laneFor(runtime, "run-turns-3"),
    })(firstRequest(workflow));

    // Three turns is three requests to the provider — no more, and not the
    // session default. The field being forwarded proves nothing; this is the
    // spend it was supposed to bound.
    expect(llm.requests).toHaveLength(3);
    // …and the run says *why* it stopped, rather than reporting a role that
    // quietly ran out of rope as a role that finished.
    expect(outcome.error).toMatch(/hit its 3-turn ceiling before finishing/);
    expect(outcome.error).toMatch(/Nothing was applied/);
  });

  it("spends more turns for a role that declares more — so the count tracks the ceiling", async () => {
    const scratch = await gitScratch();
    const llm = loopForever();
    const runtime = await runtimeWith(scratch, llm);

    const developer = role("developer", ["read", "edit"], { maxTurns: 6 });
    const workflow = parseOk("---\nname: demo\n---\n1. @developer keep going\n");
    await createRuntimeRunStep(runtime, {
      resolveAgent: () => developer,
      writeLane: laneFor(runtime, "run-turns-6"),
    })(firstRequest(workflow));

    // The control for the test above: a stop at 3 that had nothing to do with
    // `maxTurns` would stop at 3 here too.
    expect(llm.requests).toHaveLength(6);
  });

  it("clamps a role that asks for more turns than the session's subagent ceiling", async () => {
    const scratch = await gitScratch();
    await mkdir(join(scratch.cwd, ".arcturn"), { recursive: true });
    await writeFile(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ subagentMaxTurns: 2 }),
      "utf8",
    );
    const llm = loopForever();
    const runtime = await runtimeWith(scratch, llm);
    expect(runtime.config.subagentMaxTurns).toBe(2);

    const greedy = role("greedy", ["read", "edit"], { maxTurns: 9 });
    const workflow = parseOk("---\nname: demo\n---\n1. @greedy keep going\n");
    await createRuntimeRunStep(runtime, {
      resolveAgent: () => greedy,
      writeLane: laneFor(runtime, "run-turns-clamp"),
    })(firstRequest(workflow));

    // "Roles narrow; nothing widens" — a checked-in role file must not be able
    // to buy itself nine turns in a session that budgeted two.
    expect(llm.requests).toHaveLength(2);
  });

  it("warns a role to land the plane before the ceiling, without spending a turn on the note", async () => {
    const scratch = await gitScratch();
    const llm = loopForever();
    const runtime = await runtimeWith(scratch, llm);

    const developer = role("developer", ["read", "edit"], { maxTurns: 3 });
    const workflow = parseOk("---\nname: demo\n---\n1. @developer keep going\n");
    await createRuntimeRunStep(runtime, {
      resolveAgent: () => developer,
      writeLane: laneFor(runtime, "run-turns-warn"),
    })(firstRequest(workflow));

    // The note is injected into the conversation, never *spent*: still exactly
    // three requests reach the provider, same as the un-warned run above.
    expect(llm.requests).toHaveLength(3);

    // maxTurns 3 → threshold max(2, floor(0.45)) = 2 remaining, so the warning
    // boards the second request — the model hears it with turns left to use —
    // and rides the final request exactly once, not per remaining turn.
    const budgetNotes = (request: LLMRequest) =>
      request.messages.filter(
        (m) => m.role === "user" && contentText(m.content).startsWith("Turn budget:"),
      );
    expect(budgetNotes(llm.requests[0]!)).toHaveLength(0);
    expect(budgetNotes(llm.requests[1]!)).toHaveLength(1);
    expect(budgetNotes(llm.requests[2]!)).toHaveLength(1);
  });
});

// ================================================================== lane walls

describe("lane guarantees, asserted against a real checkout", () => {
  itPosix("throws away an exec-lane role's edits: the user's bytes never move", async () => {
    const scratch = await gitScratch({ "src/app.ts": "original\n" });
    // The role really does change its worktree — through `bash`, the only
    // mutating tool the exec lane hands it — and then reads the file back, so
    // the tool result proves the change landed *somewhere* before the lane
    // threw it away. Without that, "the checkout is unchanged" would be
    // satisfied by a role that was never able to write anything at all.
    const llm = fakeLLM([
      {
        toolCalls: [
          {
            id: "c1",
            name: "bash",
            arguments: { command: "printf 'REWRITTEN BY THE REVIEWER\n' > src/app.ts" },
          },
        ],
      },
      { toolCalls: [{ id: "c2", name: "bash", arguments: { command: "cat src/app.ts" } }] },
      { text: "I looked at it." },
    ]);
    const runtime = await runtimeWith(scratch, llm);

    // `bash` and nothing that writes: the exec lane. It still gets a worktree
    // (it has to build and test), and that worktree's diff is discarded unread.
    const reviewer = role("security-reviewer", ["bash", "read"]);
    const workflow = parseOk("---\nname: demo\n---\n1. @security-reviewer audit it\n");
    const outcome = await createRuntimeRunStep(runtime, {
      resolveAgent: () => reviewer,
      writeLane: laneFor(runtime, "run-exec"),
    })(firstRequest(workflow));

    expect(outcome.isError).toBe(false);
    expect(outcome.record?.status).toBe("discarded");
    // The role's own worktree really did hold the rewrite…
    expect(JSON.stringify(llm.requests.at(-1)?.messages)).toContain("REWRITTEN BY THE REVIEWER");
    // …and the user's tree is byte-for-byte what it was, with git agreeing
    // nothing is pending.
    expect(await readFile(join(scratch.cwd, "src", "app.ts"), "utf8")).toBe("original\n");
    expect(await porcelain(scratch.cwd)).toBe("");
  });

  it("applies a write-lane role's edits: the bytes land in the user's checkout", async () => {
    const scratch = await gitScratch({ "src/app.ts": "original\n" });
    const llm = fakeLLM([
      {
        toolCalls: [
          {
            id: "c1",
            name: "write",
            arguments: { path: "src/app.ts", content: "written by the developer\n" },
          },
        ],
      },
      { text: "Done." },
    ]);
    const runtime = await runtimeWith(scratch, llm);

    const developer = role("developer", ["read", "write", "edit"]);
    const workflow = parseOk("---\nname: demo\n---\n1. @developer change it\n");
    const outcome = await createRuntimeRunStep(runtime, {
      resolveAgent: () => developer,
      writeLane: laneFor(runtime, "run-write"),
    })(firstRequest(workflow));

    expect(outcome.isError).toBe(false);
    expect(outcome.record?.status).toBe("applied");
    // The other half of the wall: the same role shape, one tool different, and
    // the bytes really do move.
    expect(await readFile(join(scratch.cwd, "src", "app.ts"), "utf8")).toBe(
      "written by the developer\n",
    );
  });

  it("gives a read-lane role no worktree at all — nothing is created on disk", async () => {
    const scratch = await gitScratch();
    const llm = fakeLLM([{ text: "I read it." }]);
    const runtime = await runtimeWith(scratch, llm);

    const runsDir = join(scratch.home, "workflow-runs", "run-read");
    const analyst = role("analyst", ["read", "grep"]);
    const workflow = parseOk("---\nname: demo\n---\n1. @analyst summarise it\n");
    const outcome = await createRuntimeRunStep(runtime, {
      resolveAgent: () => analyst,
      writeLane: laneFor(runtime, "run-read"),
    })(firstRequest(workflow));

    expect(outcome.isError).toBe(false);
    // No worktree, no patch, no run directory: a read-lane role is dispatched
    // through `createSubagent` and the lane is never asked for anything.
    expect(outcome.record).toBeUndefined();
    expect(await exists(runsDir)).toBe(false);
    expect(await porcelain(scratch.cwd)).toBe("");
  });
});

// ============================================================ step deadline

describe("stepTimeoutMs, proved by exceeding it", () => {
  itPosix(
    "kills the processes a timed-out step started — the pid is gone",
    async () => {
      const scratch = await gitScratch();
      // The role starts a real detached process that would outlive the run by
      // two minutes, records its own pid where the test can read it, and then
      // the model hangs past the deadline. `BackgroundTaskManager` spawns the
      // shell detached as its own process-group leader, so `$$` is the pgid the
      // reaper has to signal.
      const llm = fakeLLM([
        {
          toolCalls: [
            {
              id: "c1",
              name: "bash",
              arguments: { command: "echo $$ > pid.txt; sleep 120", background: true },
            },
          ],
        },
        { text: "still thinking", delayMs: 2_500 },
      ]);
      const runtime = await runtimeWith(scratch, llm);

      const runId = "run-deadline";
      const worktree = join(scratch.home, "workflow-runs", runId, "1-builder");
      const builder = role("builder", ["bash"]);
      const workflow = parseOk(
        "---\nname: demo\nstepTimeoutMs: 700\n---\n1. @builder build it\n2. @builder and again\n",
      );

      // Read the pid while the step is still alive; the file lives in a worktree
      // the deadline path keeps for forensics, but reading it early means the
      // assertion cannot be satisfied by a worktree that was simply deleted.
      let pid: number | undefined;
      const watcher = (async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            pid = Number.parseInt(await readFile(join(worktree, "pid.txt"), "utf8"), 10);
            if (Number.isInteger(pid) && pid > 0) return;
          } catch {
            // not started yet
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();

      const result = await runWorkflow(workflow, {
        resolveAgent: () => builder,
        agentNames: () => ["builder"],
        runStep: createRuntimeRunStep(runtime, {
          resolveAgent: () => builder,
          writeLane: laneFor(runtime, runId),
        }),
      });
      await watcher;

      // The step was really killed for the reason claimed…
      expect(result.steps[0]?.status).toBe("failed");
      // …and the run parked on it rather than ending (the step-failure park),
      // which changes nothing about the kill this test is here to prove.
      expect(result.status).toBe("paused");
      expect(result.steps[0]?.error).toMatch(/exceeded its .* deadline/);
      // …and the later stage never ran at all.
      expect(result.steps[1]?.status).toBe("skipped");

      // The effect: the process the step started is gone. Retried briefly
      // because SIGTERM→SIGKILL is asynchronous, but bounded well under the five
      // minutes the process asked for.
      expect(pid).toBeGreaterThan(0);
      const alive = (): boolean => {
        try {
          process.kill(pid as number, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 5_000;
      while (alive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive()).toBe(false);
    },
    20_000,
  );

  it("lets a step that finishes inside its deadline complete normally", async () => {
    // The control: the same shape, under the limit. Without it, "the step was
    // killed" is indistinguishable from a step that could never have run.
    const scratch = await gitScratch();
    const llm = fakeLLM([{ text: "quick" }]);
    const runtime = await runtimeWith(scratch, llm);

    const builder = role("builder", ["bash"]);
    const workflow = parseOk(
      "---\nname: demo\nstepTimeoutMs: 30000\n---\n1. @builder build it\n2. @builder and again\n",
    );
    const result = await runWorkflow(workflow, {
      resolveAgent: () => builder,
      agentNames: () => ["builder"],
      runStep: createRuntimeRunStep(runtime, {
        resolveAgent: () => builder,
        writeLane: laneFor(runtime, "run-in-time"),
      }),
    });

    expect(result.status).toBe("done");
    expect(result.steps.map((step) => step.status)).toEqual(["done", "done"]);
  });
});

// ============================================================== run budget

describe("budgetUsd, proved by exceeding it", () => {
  /**
   * A model that writes one *distinctly named* file per stage and reports
   * `costUsd` on every turn, so a stage's spend and a stage's artefact are the
   * same event and "stage three never ran" is a question the filesystem can
   * answer.
   *
   * @param costUsd - What each turn costs.
   */
  const spender = (costUsd: number): FakeLLM =>
    fakeLLM(
      [1, 2, 3].flatMap((stage) => [
        {
          toolCalls: [
            {
              id: `c${stage}`,
              name: "bash",
              arguments: { command: `printf ${stage} > stage${stage}.txt` },
            },
          ],
          usage: { costUsd },
        },
        { text: `stage ${stage} complete`, usage: { costUsd } },
      ]),
    );

  /**
   * Run a three-stage pipeline whose every stage is the same write-lane role,
   * against a real journal on disk.
   *
   * @param costUsd - Per-turn spend the scripted model reports.
   * @param budget - The `budgetUsd:` frontmatter line, or `undefined` for none.
   */
  async function threeStages(
    costUsd: number,
    budget: number | undefined,
  ): Promise<{
    scratch: Scratch;
    journalDir: string;
    result: Awaited<ReturnType<typeof runWorkflow>>;
  }> {
    const scratch = await gitScratch();
    const llm = spender(costUsd);
    const runtime = await runtimeWith(scratch, llm);
    const journalDir = join(scratch.home, "journal");
    const developer = role("developer", ["read", "write", "edit", "bash"]);
    const workflow = parseOk(
      [
        "---",
        "name: pipeline",
        ...(budget === undefined ? [] : [`budgetUsd: ${budget.toFixed(2)}`]),
        "---",
        "1. @developer stage one",
        "2. @developer stage two",
        "3. @developer stage three",
        "",
      ].join("\n"),
    );
    const result = await runWorkflow(workflow, {
      resolveAgent: () => developer,
      agentNames: () => ["developer"],
      journal: createFileRunJournal(journalDir),
      runStep: createRuntimeRunStep(runtime, {
        resolveAgent: () => developer,
        writeLane: laneFor(runtime, `run-budget-${budget ?? "none"}`),
      }),
    });
    return { scratch, journalDir, result };
  }

  /** Every step id that reached a terminal journal line. */
  async function journalledSteps(dir: string): Promise<string[]> {
    const lines = await readJournalLines(dir);
    return lines
      .filter((line): line is Extract<typeof line, { kind: "stepEnd" }> => line.kind === "stepEnd")
      .map((line) => line.id);
  }

  itPosix(
    "stops the pipeline: the later stage has no journal entry and never wrote its file",
    async () => {
      // Each turn costs $0.30, two turns per stage: stage one alone is $0.60 —
      // deliberately below the 80% stage-boundary budget ask, which would park
      // the run `paused` before the ceiling (its own feature, proved in
      // `workflow.test.ts`) — and stage two's $1.20 total crosses $1.00, so
      // this run exercises the HARD stop this suite exists to prove.
      const { scratch, journalDir, result } = await threeStages(0.3, 1);

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/exceeded its \$1\.00 run budget/);

      // The effect, not the report: stage three never reached the journal…
      const stepIds = await journalledSteps(journalDir);
      expect(stepIds).toEqual(["1", "2"]);
      // …and its artefact was never created, while the stages that did run left
      // theirs behind. Without that second half, a pipeline that never started
      // would satisfy this test.
      expect(await exists(join(scratch.cwd, "stage1.txt"))).toBe(true);
      expect(await exists(join(scratch.cwd, "stage2.txt"))).toBe(true);
      expect(await exists(join(scratch.cwd, "stage3.txt"))).toBe(false);

      // And the journal says *why* it stopped, which is the one question
      // `/workflow status` opens this record to answer.
      const stopLines = (await readJournalLines(journalDir)).filter(
        (line): line is Extract<typeof line, { kind: "stop" }> => line.kind === "stop",
      );
      expect(stopLines.map((line) => line.reason)).toEqual(["cost-ceiling"]);
      expect(summariseRun(foldJournal("run", await readJournalLines(journalDir))).stopReason).toBe(
        "cost-ceiling",
      );
    },
  );

  itPosix("runs every stage when the same pipeline stays under budget", async () => {
    // The control that makes the stop meaningful: identical pipeline, a budget
    // it cannot cross, and stage three both journals and lands its artefact.
    const { scratch, journalDir, result } = await threeStages(0.01, 100);

    expect(result.status).toBe("done");
    expect(await journalledSteps(journalDir)).toEqual(["1", "2", "3"]);
    expect(await exists(join(scratch.cwd, "stage3.txt"))).toBe(true);
    expect(
      summariseRun(foldJournal("run", await readJournalLines(journalDir))).stopReason,
    ).toBeUndefined();
  });
});

// ============================================================ run token budget

describe("budgetTokens, proved by exceeding it", () => {
  /**
   * The `spender` above, with the price knocked off: every turn reports raw
   * token counts and NO `costUsd` — the exact shape an unpriced model (a
   * coding-plan endpoint, Ollama, vLLM) produces, and the run `budgetUsd`
   * can never stop because the spend it compares against never moves.
   *
   * @param outputTokens - Tokens each turn reports as output; input and cache
   *   are pinned to zero so the run's total is exactly turns × outputTokens.
   */
  const tokenSpender = (outputTokens: number): FakeLLM =>
    fakeLLM(
      [1, 2, 3].flatMap((stage) => [
        {
          toolCalls: [
            {
              id: `c${stage}`,
              name: "bash",
              arguments: { command: `printf ${stage} > stage${stage}.txt` },
            },
          ],
          usage: { inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        {
          text: `stage ${stage} complete`,
          usage: { inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      ]),
    );

  /**
   * The same three-stage write-lane pipeline as the dollar-budget suite,
   * bounded by `budgetTokens:` instead, against a real journal on disk.
   *
   * @param outputTokens - Per-turn output tokens the scripted model reports.
   * @param budgetTokens - The `budgetTokens:` frontmatter line, or `undefined` for none.
   */
  async function threeStages(
    outputTokens: number,
    budgetTokens: number | undefined,
  ): Promise<{
    scratch: Scratch;
    journalDir: string;
    result: Awaited<ReturnType<typeof runWorkflow>>;
  }> {
    const scratch = await gitScratch();
    const llm = tokenSpender(outputTokens);
    const runtime = await runtimeWith(scratch, llm);
    const journalDir = join(scratch.home, "journal");
    const developer = role("developer", ["read", "write", "edit", "bash"]);
    const workflow = parseOk(
      [
        "---",
        "name: pipeline",
        ...(budgetTokens === undefined ? [] : [`budgetTokens: ${budgetTokens}`]),
        "---",
        "1. @developer stage one",
        "2. @developer stage two",
        "3. @developer stage three",
        "",
      ].join("\n"),
    );
    const result = await runWorkflow(workflow, {
      resolveAgent: () => developer,
      agentNames: () => ["developer"],
      journal: createFileRunJournal(journalDir),
      runStep: createRuntimeRunStep(runtime, {
        resolveAgent: () => developer,
        writeLane: laneFor(runtime, `run-token-budget-${budgetTokens ?? "none"}`),
      }),
    });
    return { scratch, journalDir, result };
  }

  /** Every step id that reached a terminal journal line. */
  async function journalledSteps(dir: string): Promise<string[]> {
    const lines = await readJournalLines(dir);
    return lines
      .filter((line): line is Extract<typeof line, { kind: "stepEnd" }> => line.kind === "stepEnd")
      .map((line) => line.id);
  }

  itPosix(
    "stops the pipeline on tokens alone, where budgetUsd could never have fired: no turn carried a price",
    async () => {
      // 300 output tokens per turn, two turns per stage: stage one alone is
      // 600 tokens — deliberately below the 80% stage-boundary budget ask,
      // which would park the run `paused` before the ceiling (its own feature,
      // proved in `workflow.test.ts`) — and stage two's total of 1,200 exceeds
      // the 1,000 ceiling, so this run exercises the HARD token stop.
      const { scratch, journalDir, result } = await threeStages(300, 1_000);

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/exceeded its 1,000-token run budget/);

      // The effect, not the report: stage three never reached the journal…
      const stepIds = await journalledSteps(journalDir);
      expect(stepIds).toEqual(["1", "2"]);
      // …and its artefact was never created, while the stages that did run
      // left theirs behind.
      expect(await exists(join(scratch.cwd, "stage1.txt"))).toBe(true);
      expect(await exists(join(scratch.cwd, "stage2.txt"))).toBe(true);
      expect(await exists(join(scratch.cwd, "stage3.txt"))).toBe(false);

      // The journal names the reason, and the status fold carries it through.
      const stopLines = (await readJournalLines(journalDir)).filter(
        (line): line is Extract<typeof line, { kind: "stop" }> => line.kind === "stop",
      );
      expect(stopLines.map((line) => line.reason)).toEqual(["token-ceiling"]);
      const summary = summariseRun(foldJournal("run", await readJournalLines(journalDir)));
      expect(summary.stopReason).toBe("token-ceiling");
      // THE POINT: nothing here could ever be priced, so the dollar ceiling
      // had no number to compare — the token one is what actually stopped it.
      expect(summary.spentUsd).toBeUndefined();
      expect(result.usage.costUsd).toBeUndefined();
    },
  );

  itPosix("runs every stage when the same pipeline stays under its token budget", async () => {
    // The control: identical pipeline, a ceiling it cannot cross, and stage
    // three both journals and lands its artefact.
    const { scratch, journalDir, result } = await threeStages(400, 60_000_000);

    expect(result.status).toBe("done");
    expect(await journalledSteps(journalDir)).toEqual(["1", "2", "3"]);
    expect(await exists(join(scratch.cwd, "stage3.txt"))).toBe(true);
    expect(
      summariseRun(foldJournal("run", await readJournalLines(journalDir))).stopReason,
    ).toBeUndefined();
  });
});

// ============================================================== org memory

describe("org memory reaches a role's prompt only after a person approves it", () => {
  const NOTE = "this repo's vitest needs --run or it hangs forever";

  /**
   * Write a store holding one entry for `developer`, then hand back the
   * injector the workflow dispatcher actually calls.
   *
   * @param home - The scratch `$ARCTURN_HOME`.
   * @param approve - Promote the entry to `active` before saving.
   */
  async function injectorWith(
    home: string,
    approve: boolean,
  ): Promise<(role: string) => string | undefined> {
    const file = join(home, "org-memory.json");
    const added = addOrgMemoryEntry({ entries: [] }, { role: "developer", text: NOTE });
    if (added.error !== undefined || added.store === undefined || added.entry === undefined) {
      throw new Error(`fixture failed: ${added.error}`);
    }
    // Proposed by construction — the whole point of the gate.
    expect(added.entry.status).toBe("proposed");
    let store = added.store;
    if (approve) {
      const promoted = setOrgMemoryStatus(store, added.entry.id, "active");
      if (promoted.store === undefined) throw new Error("fixture failed to approve");
      store = promoted.store;
    }
    await writeOrgMemory(file, store);
    return loadOrgMemoryInjector(file);
  }

  /**
   * Dispatch one write-lane step and return the system prompt the provider
   * was actually sent — not the `AgentDef` the dispatcher assembled, the
   * bytes on the request.
   *
   * @param approve - Whether the entry was approved first.
   */
  async function systemPromptSeen(approve: boolean): Promise<string> {
    const scratch = await gitScratch();
    const llm = fakeLLM([{ text: "ok" }]);
    const runtime = await runtimeWith(scratch, llm);
    const developer = role("developer", ["read", "write", "edit"]);
    const workflow = parseOk("---\nname: demo\n---\n1. @developer do it\n");
    await createRuntimeRunStep(runtime, {
      resolveAgent: () => developer,
      writeLane: laneFor(runtime, `run-memory-${approve ? "active" : "proposed"}`),
      orgMemory: await injectorWith(scratch.home, approve),
    })(firstRequest(workflow));
    const seen = llm.requests[0];
    if (seen === undefined) throw new Error("the role never took a turn");
    return `${seen.system ?? ""}\n${JSON.stringify(seen.messages)}`;
  }

  it("keeps a PROPOSED entry out of the prompt the model is sent", async () => {
    expect(await systemPromptSeen(false)).not.toContain(NOTE);
  });

  it("puts an APPROVED entry into the prompt the model is sent", async () => {
    // The control: identical fixture, one human act different.
    expect(await systemPromptSeen(true)).toContain(NOTE);
  });
});

// ================================================================== resume

describe("resume replays the journal instead of re-running — against a real checkout", () => {
  itPosix(
    "a completed stage's patch is not applied a second time, and its model is not asked again",
    async () => {
      const scratch = await gitScratch();
      const journalDir = join(scratch.home, "resume-journal");
      const runId = "run-resume";
      const developer = role("developer", ["read", "write", "edit", "bash"]);
      const workflow = parseOk(
        "---\nname: pipeline\n---\n1. @developer stage one\n2. @developer stage two {{prev}}\n",
      );

      // ---- run one: stage one lands its patch, then the run is killed.
      const first = fakeLLM([
        {
          toolCalls: [
            {
              id: "a1",
              name: "bash",
              arguments: { command: "printf 'from stage 1\\n' >> seed.txt" },
            },
          ],
        },
        { text: "stage one done" },
        // Stage two is still thinking when the interrupt arrives.
        { text: "stage two done", delayMs: 3_000 },
      ]);
      const runtimeOne = await runtimeWith(scratch, first);
      const controller = new AbortController();
      const killed = await runWorkflow(workflow, {
        resolveAgent: () => developer,
        agentNames: () => ["developer"],
        journal: createFileRunJournal(journalDir),
        runId,
        signal: controller.signal,
        // Kill the run the moment stage one has settled — the crash window this
        // whole mechanism exists for.
        onEvent: (event) => {
          if (event.type === "stageEnd" && event.stageIndex === 1) controller.abort();
        },
        runStep: createRuntimeRunStep(runtimeOne, {
          resolveAgent: () => developer,
          writeLane: laneFor(runtimeOne, runId),
        }),
      });
      expect(killed.status).toBe("cancelled");
      // Stage one's edit really is in the user's checkout, exactly once.
      expect(await readFile(join(scratch.cwd, "seed.txt"), "utf8")).toBe("seed\nfrom stage 1\n");

      // ---- run two: resume from what survived on disk.
      const lines = await readJournalLines(journalDir);
      const state = buildResumeState(lines);
      expect([...state.completed.keys()]).toEqual(["1"]);

      const second = fakeLLM([
        {
          toolCalls: [
            {
              id: "b1",
              name: "bash",
              arguments: { command: "printf 'from stage 2\\n' >> seed.txt" },
            },
          ],
        },
        { text: "stage two done" },
      ]);
      const runtimeTwo = await runtimeWith(scratch, second);
      const resumed = await runWorkflow(workflow, {
        resolveAgent: () => developer,
        agentNames: () => ["developer"],
        journal: createFileRunJournal(journalDir),
        runId,
        resumeFrom: state,
        runStep: createRuntimeRunStep(runtimeTwo, {
          resolveAgent: () => developer,
          writeLane: laneFor(runtimeTwo, runId),
        }),
      });

      expect(resumed.steps[1]?.error).toBeUndefined();
      expect(resumed.status).toBe("done");
      // Stage one was replayed from the journal: its model was never asked
      // again. Two requests is stage two's own script and nothing else.
      expect(second.requests).toHaveLength(2);
      // The effect that matters most: stage one's line appears once, not twice.
      // A re-executed or re-applied stage one would either duplicate the line or
      // fail `git apply` outright.
      expect(await readFile(join(scratch.cwd, "seed.txt"), "utf8")).toBe(
        "seed\nfrom stage 1\nfrom stage 2\n",
      );
    },
    20_000,
  );

  itPosix(
    "resumes past a stage whose patch created a NEW file in the checkout",
    async () => {
      // The other half of the same defect. Stage one's patch leaves an
      // *untracked* file behind, so on resume `git ls-files --others` listed it
      // into the next worktree's seed and `seed.patches` then replayed the patch
      // that created it — `git apply` refuses a "new file" that is already there.
      const scratch = await gitScratch();
      const journalDir = join(scratch.home, "resume-new-file");
      const runId = "run-resume-new";
      const developer = role("developer", ["read", "write", "edit", "bash"]);
      const workflow = parseOk(
        "---\nname: pipeline\n---\n1. @developer stage one\n2. @developer stage two {{prev}}\n",
      );

      const first = fakeLLM([
        {
          toolCalls: [
            { id: "a1", name: "bash", arguments: { command: "printf 'brand new\\n' > fresh.txt" } },
          ],
        },
        { text: "stage one done" },
        { text: "stage two done", delayMs: 3_000 },
      ]);
      const runtimeOne = await runtimeWith(scratch, first);
      const controller = new AbortController();
      await runWorkflow(workflow, {
        resolveAgent: () => developer,
        agentNames: () => ["developer"],
        journal: createFileRunJournal(journalDir),
        runId,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "stageEnd" && event.stageIndex === 1) controller.abort();
        },
        runStep: createRuntimeRunStep(runtimeOne, {
          resolveAgent: () => developer,
          writeLane: laneFor(runtimeOne, runId),
        }),
      });
      expect(await readFile(join(scratch.cwd, "fresh.txt"), "utf8")).toBe("brand new\n");

      const second = fakeLLM([{ text: "stage two done" }]);
      const runtimeTwo = await runtimeWith(scratch, second);
      const resumed = await runWorkflow(workflow, {
        resolveAgent: () => developer,
        agentNames: () => ["developer"],
        journal: createFileRunJournal(journalDir),
        runId,
        resumeFrom: buildResumeState(await readJournalLines(journalDir)),
        runStep: createRuntimeRunStep(runtimeTwo, {
          resolveAgent: () => developer,
          writeLane: laneFor(runtimeTwo, runId),
        }),
      });

      expect(resumed.steps[1]?.error).toBeUndefined();
      expect(resumed.status).toBe("done");
      // Written once, by the stage that was never re-run.
      expect(await readFile(join(scratch.cwd, "fresh.txt"), "utf8")).toBe("brand new\n");
    },
    20_000,
  );
});

// ================================================================= ORG-HALT

// ============================================ the step-failure park, recovered

/**
 * The whole recovery, against a real checkout and a real journal.
 *
 * FAIL-FIRST, from the run that motivated it: a nine-stage pipeline finished
 * four paid stages and then stage 5's `@rag-builder` hit its turn ceiling. The
 * engine wrote `runEnd{failed}`, both resume verbs refuse a failed run
 * forever, and the only way forward was to buy the four finished stages again.
 *
 * Every claim here is an effect: how many requests actually reached the
 * provider (the money), which files are in the user's checkout, and what is on
 * disk in the journal — never a field read back out of the object that set it.
 */
describe("a failed step parks the run, and the run really is recoverable", () => {
  itPosix("retries only the broken step, under the ceiling a human raised", async () => {
    const scratch = await gitScratch();
    // The SESSION's ceiling, deliberately above the role's own: a raise that
    // lifted only one half of `Math.min(role maxTurns, subagentMaxTurns)`
    // would land on 3 or on 5, and the request count below can tell all three
    // apart. This is the trap that made hand-editing the role file useless.
    await mkdir(join(scratch.cwd, ".arcturn"), { recursive: true });
    await writeFile(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ subagentMaxTurns: 5 }),
      "utf8",
    );

    const llm = fakeLLM([
      // Stage 1, the survey: one write, then it lands the plane.
      {
        toolCalls: [
          { id: "s1", name: "write", arguments: { path: "SURVEY.md", content: "the survey\n" } },
        ],
      },
      { text: "survey done" },
      // Stage 2, the builder: it starts real work…
      {
        toolCalls: [
          { id: "b1", name: "write", arguments: { path: "BUILD.md", content: "half built\n" } },
        ],
      },
      // …and then never stops asking for another turn. The ceiling is the only
      // thing that can end this, which is the whole point.
      { toolCalls: [{ id: "b2", name: "read", arguments: { path: "seed.txt" } }] },
    ]);
    const runtime = await runtimeWith(scratch, llm);
    expect(runtime.config.subagentMaxTurns).toBe(5);

    const surveyor = role("surveyor", ["read", "write", "edit"]);
    const builder = role("builder", ["read", "write", "edit"], { maxTurns: 3 });
    const resolve = (name: string): AgentDef => (name === "surveyor" ? surveyor : builder);
    const workflow = parseOk(
      "---\nname: pipeline\n---\n1. @surveyor survey it\n2. @builder build it {{prev}}\n",
    );
    const runId = "run-park";
    const journalDir = join(scratch.home, "park-journal");
    const drive = (resumeFrom?: ResumeState) =>
      runWorkflow(workflow, {
        resolveAgent: resolve,
        agentNames: () => ["surveyor", "builder"],
        journal: createFileRunJournal(journalDir),
        runId,
        ...(resumeFrom === undefined ? {} : { resumeFrom }),
        runStep: createRuntimeRunStep(runtime, {
          resolveAgent: resolve,
          writeLane: laneFor(runtime, runId),
        }),
      });

    // ---- run one: stage 1 lands, stage 2 runs out of turns, the run PARKS.
    const parked = await drive();

    // FAIL-FIRST: this was `failed`, and `runEnd{failed}` is the tombstone
    // both resume verbs refuse — the survey would have had to be bought again.
    expect(parked.status).toBe("paused");
    expect(parked.steps.map((step) => step.status)).toEqual(["done", "failed"]);
    // Stage 1's patch really is in the user's checkout…
    expect(await readFile(join(scratch.cwd, "SURVEY.md"), "utf8")).toBe("the survey\n");
    // …and the failed step applied nothing, exactly as it always did.
    expect(await exists(join(scratch.cwd, "BUILD.md"))).toBe(false);
    // 2 turns for the survey + the builder's 3 = 5 requests reached the model.
    expect(llm.requests).toHaveLength(5);

    // `runEnd` is the engine's one fire-and-forget append (see `finish`), so
    // the terminal line is polled for rather than assumed.
    const lines = await journalOnceEnded(journalDir);
    const firstAsk = lines.find(
      (line): line is Extract<JournalLine, { kind: "stepFailAsk" }> => line.kind === "stepFailAsk",
    );
    expect(firstAsk).toMatchObject({
      stepId: "2",
      role: "builder",
      failureKind: "turn-ceiling",
      ceiling: 3,
      attempts: 1,
    });
    // The captured patch the question points a human at is a real file on
    // disk, holding the work the failed step could not apply.
    expect(firstAsk?.patchPath).toBeDefined();
    expect(await readFile(firstAsk?.patchPath ?? "", "utf8")).toContain("BUILD.md");
    // And the run is resumable rather than a corpse.
    const state = buildResumeState(lines);
    expect(state.ended).toBe(true);
    expect(state.endedStatus).toBe("paused");
    expect(state.stepFailAsk?.stepId).toBe("2");
    expect([...state.completed.keys()]).toEqual(["1"]);
    // `/workflow status` says the same thing from the same file.
    expect(summariseRun(foldJournal(runId, lines), Date.now()).state).toBe("paused");

    // ---- run two: "raise 8". Only the broken step re-runs, and it re-runs
    // with EIGHT turns — not 3 (the role file's), not 5 (the session's).
    const raised = await drive({ ...state, stepFailAnswer: { text: "raise 8" } });
    expect(raised.status).toBe("paused"); // it ran out of the new rope too

    // THE MONEY, counted: 5 from run one plus the builder's 8. Stage 1 was
    // replayed from the journal and its model was never asked again — 15 would
    // mean the survey was re-bought, 8 would mean the raise never reached the
    // child, and 10 would mean it lifted only the role's own half.
    expect(llm.requests).toHaveLength(13);
    // The survey is still in the checkout exactly once: a re-executed stage 1
    // would have re-applied a patch that creates a file that already exists,
    // and `git apply` would have refused it outright.
    expect(await readFile(join(scratch.cwd, "SURVEY.md"), "utf8")).toBe("the survey\n");

    const afterRaise = await journalOnceEnded(journalDir);
    expect(
      afterRaise.find(
        (line): line is Extract<JournalLine, { kind: "turnRaise" }> => line.kind === "turnRaise",
      ),
    ).toMatchObject({ stepId: "2", role: "builder", value: 8 });
    const asks = afterRaise.filter(
      (line): line is Extract<JournalLine, { kind: "stepFailAsk" }> => line.kind === "stepFailAsk",
    );
    // The second park states the ceiling the child actually ran under — the
    // effective 8, straight out of the loop's own exhaustion message — and a
    // higher attempt count, so nobody feeds a hole without being told.
    expect(asks).toHaveLength(2);
    expect(asks[1]).toMatchObject({ ceiling: 8, attempts: 2 });

    // ---- run three: "abandon". The tombstone, chosen — and now it really is
    // one: the gate both resume entry points apply refuses this run.
    const abandoned = await drive({
      ...buildResumeState(afterRaise),
      stepFailAnswer: { text: "abandon" },
    });
    expect(abandoned.status).toBe("failed");
    // Nothing was spent to abandon.
    expect(llm.requests).toHaveLength(13);

    const ended = buildResumeState(await journalOnceEnded(journalDir, "failed"));
    expect(ended.endedStatus).toBe("failed");
    expect(ended.stepFailAsk).toBeUndefined();
    expect(ended.ended && ended.endedStatus !== "paused").toBe(true);
    expect(
      (await readJournalLines(journalDir))
        .filter((line): line is Extract<JournalLine, { kind: "stop" }> => line.kind === "stop")
        .map((line) => line.reason),
    ).toEqual(["turn-ceiling"]);
  });
});

describe("a step that produced nothing is caught where it happened, not seven stages later", () => {
  itPosix(
    "parks at the void instead of handing the next stage a file that was never written",
    async () => {
      const scratch = await gitScratch();
      // The run this is drawn from: stage 2's entire job was to write one ADR.
      // It wrote nothing, said nothing, and was marked `done`; stage 3 onward
      // then quoted `docs/adr/rag-architecture.md` at each other for hours.
      const llm = fakeLLM([
        // Stage 1, the surveyor: a real file and a real report.
        {
          toolCalls: [
            { id: "s1", name: "write", arguments: { path: "SURVEY.md", content: "the survey\n" } },
          ],
        },
        { text: "survey done" },
        // Stage 2, the architect: THE VOID. No tool call, no words — the model
        // simply ends its turn. This is the outcome that used to be `done`.
        //
        // Twice, because the loop now hands a silent turn back once before
        // accepting it (see `SILENT_TURN_NUDGE`). A model that recovers on the
        // nudge never reaches this machinery at all; what parks a run is a
        // model that answers the nudge with a second silence.
        { text: "" },
        { text: "" },
        // Everything below belongs to the RETRY. Stage 3 must never reach it on
        // run one — the request count below is what proves it did not.
        {
          toolCalls: [
            {
              id: "a1",
              name: "write",
              arguments: {
                path: "docs/adr/rag-architecture.md",
                content: "# RAG architecture\n\npgvector, one index.\n",
              },
            },
          ],
        },
        { text: "ADR written to docs/adr/rag-architecture.md" },
        { text: "built against the ADR" },
      ]);
      const runtime = await runtimeWith(scratch, llm);

      const surveyor = role("surveyor", ["read", "write", "edit"]);
      const architect = role("architect", ["read", "write", "edit"]);
      const builder = role("builder", ["read", "write", "edit"]);
      const resolve = (name: string): AgentDef =>
        name === "surveyor" ? surveyor : name === "architect" ? architect : builder;
      const workflow = parseOk(
        [
          "---",
          "name: pipeline",
          "---",
          "1. @surveyor survey the options",
          "2. @architect write the ADR to docs/adr/rag-architecture.md {{prev}}",
          "3. @builder build, following the ADR at docs/adr/rag-architecture.md {{prev}}",
          "",
        ].join("\n"),
      );
      const runId = "run-void";
      const journalDir = join(scratch.home, "void-journal");
      const drive = (resumeFrom?: ResumeState) =>
        runWorkflow(workflow, {
          resolveAgent: resolve,
          agentNames: () => ["surveyor", "architect", "builder"],
          journal: createFileRunJournal(journalDir),
          runId,
          ...(resumeFrom === undefined ? {} : { resumeFrom }),
          runStep: createRuntimeRunStep(runtime, {
            resolveAgent: resolve,
            writeLane: laneFor(runtime, runId),
          }),
        });

      // ---- run one: the void is caught, and the run parks on it.
      const parked = await drive();

      // FAIL-FIRST: step 2 was `done` and the run ran on to a stage that would
      // read an ADR nobody wrote.
      expect(parked.steps.map((step) => step.status)).toEqual(["done", "failed", "skipped"]);
      expect(parked.status).toBe("paused");
      // THE EFFECT THE OLD RUN PAID FOR: the promised file is not there. What
      // changed is that the pipeline now stops at that fact instead of quoting
      // the path for seven more stages.
      expect(await exists(join(scratch.cwd, "docs", "adr", "rag-architecture.md"))).toBe(false);
      // Stage 1's real work is in the real checkout and is not being re-bought…
      expect(await readFile(join(scratch.cwd, "SURVEY.md"), "utf8")).toBe("the survey\n");
      // …and stage 3's model was never asked a single question. Four requests:
      // the surveyor's two turns, then the architect's void and the one nudged
      // retry the loop spends before giving up on it.
      expect(llm.requests).toHaveLength(4);

      const lines = await journalOnceEnded(journalDir);
      const terminals = lines.filter(
        (line): line is Extract<JournalLine, { kind: "stepEnd" }> => line.kind === "stepEnd",
      );
      expect(terminals.map((line) => [line.id, line.status])).toEqual([
        ["1", "done"],
        ["2", "failed"],
      ]);
      expect(lines.findLast((line) => line.kind === "runEnd")).toMatchObject({ status: "paused" });
      const ask = lines.find(
        (line): line is Extract<JournalLine, { kind: "stepFailAsk" }> =>
          line.kind === "stepFailAsk",
      );
      expect(ask).toMatchObject({ stepId: "2", role: "architect" });
      expect(ask?.cause).toContain("produced nothing");
      // THE DIAGNOSIS RIDES THE PARK: the park line says what the model
      // emitted on the turn it went quiet on, so nobody has to open the
      // session JSONL to learn it. A scripted `{ text: "" }` is a text block
      // of zero characters that ended the turn — no tool call, `endTurn`.
      expect(ask?.lastTurn).toMatchObject({ stopReason: "endTurn" });
      expect(ask?.lastTurn?.blocks.some((block) => block.type === "toolCall")).toBe(false);
      expect(
        ask?.lastTurn?.blocks.reduce(
          (chars, block) => (block.type === "text" ? chars + block.chars : chars),
          0,
        ),
      ).toBe(0);
      // …and the failed terminal carries the same shape, for the autopsy.
      const voidEnd = terminals.find((line) => line.id === "2");
      expect(voidEnd?.lastTurn).toEqual(ask?.lastTurn);
      const state = buildResumeState(lines);
      expect(state.endedStatus).toBe("paused");
      expect([...state.completed.keys()]).toEqual(["1"]);

      // ---- run two: `retry`. The architect gets its second attempt and takes
      // it — which is exactly why this parks rather than dies.
      const resumed = await drive({ ...state, stepFailAnswer: { text: "retry" } });

      expect(resumed.status).toBe("done");
      expect(resumed.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
      // The ADR is now bytes in the user's checkout, applied off the write lane.
      expect(
        await readFile(join(scratch.cwd, "docs", "adr", "rag-architecture.md"), "utf8"),
      ).toContain("# RAG architecture");
      // Only the void was re-bought: 4 from run one, plus the architect's two
      // turns and the builder's one. Stage 1 was replayed from the journal.
      expect(llm.requests).toHaveLength(7);
      // And the handoff the old run never had: the builder's prompt carries the
      // architect's report, not an empty `{{prev}}`.
      const built = llm.requests.at(-1);
      expect(JSON.stringify(built?.messages ?? [])).toContain("ADR written to docs/adr");
    },
  );

  itPosix(
    "parks a step that spoke once and then went silent twice — a preamble is not a result",
    async () => {
      const scratch = await gitScratch();
      // The shape a real architect produced: one turn of "I'll read the
      // survey, then write the ADR", then reasoning alone, then — after the
      // nudge — reasoning alone again. Its `text` is that preamble, so the
      // text-only void gate would have called it done and handed stage 2 a
      // sentence about intending to write. The last turn is what is judged.
      const llm = fakeLLM([
        // Speaks AND acts, so the loop continues past this turn — a text-only
        // first turn would simply be the answer.
        {
          text: "I'll read the survey, then write the ADR.",
          toolCalls: [{ id: "r1", name: "read", arguments: { path: "seed.txt" } }],
        },
        { text: "" },
        { text: "" },
        { text: "STAGE TWO MUST NEVER RUN" },
      ]);
      const runtime = await runtimeWith(scratch, llm);
      const architect = role("architect", ["read", "write", "edit"]);
      const builder = role("builder", ["read", "write", "edit"]);
      const resolve = (name: string): AgentDef => (name === "architect" ? architect : builder);
      const workflow = parseOk(
        [
          "---",
          "name: pipeline",
          "---",
          "1. @architect write the ADR to docs/adr/rag-architecture.md",
          "2. @builder build, following the ADR {{prev}}",
          "",
        ].join("\n"),
      );
      const runId = "run-preamble-void";
      const journalDir = join(scratch.home, "preamble-journal");
      const result = await runWorkflow(workflow, {
        resolveAgent: resolve,
        agentNames: () => ["architect", "builder"],
        journal: createFileRunJournal(journalDir),
        runId,
        runStep: createRuntimeRunStep(runtime, {
          resolveAgent: resolve,
          writeLane: laneFor(runtime, runId),
        }),
      });

      expect(result.status).toBe("paused");
      expect(result.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
      // The preamble turn, the silence, the nudged silence — and nothing for stage 2.
      expect(llm.requests).toHaveLength(3);
      const lines = await journalOnceEnded(journalDir);
      const ask = lines.find(
        (line): line is Extract<JournalLine, { kind: "stepFailAsk" }> =>
          line.kind === "stepFailAsk",
      );
      expect(ask?.cause).toContain("produced nothing");
      // And the diagnosis names the turn that decided it: the last one.
      expect(ask?.lastTurn?.blocks.some((block) => block.type === "toolCall")).toBe(false);
      expect(await exists(join(scratch.cwd, "docs", "adr", "rag-architecture.md"))).toBe(false);
    },
  );

  itPosix(
    "recovers a one-off void inside the step, so the human is never asked at all",
    async () => {
      const scratch = await gitScratch();
      // The same void, from the same real run — but this model does what the
      // observed one did *not*: asked again, it makes the call it had already
      // decided on. Parking is the fallback; this is the common case, and it
      // costs one extra turn instead of a stopped pipeline and a human.
      const llm = fakeLLM([
        {
          toolCalls: [
            { id: "s1", name: "write", arguments: { path: "SURVEY.md", content: "the survey\n" } },
          ],
        },
        { text: "survey done" },
        // The void.
        { text: "" },
        // The nudge lands, and the architect writes the file it went quiet on.
        {
          toolCalls: [
            {
              id: "a1",
              name: "write",
              arguments: {
                path: "docs/adr/rag-architecture.md",
                content: "# RAG architecture\n\npgvector, one index.\n",
              },
            },
          ],
        },
        { text: "ADR written to docs/adr/rag-architecture.md" },
        { text: "built against the ADR" },
      ]);
      const runtime = await runtimeWith(scratch, llm);

      const surveyor = role("surveyor", ["read", "write", "edit"]);
      const architect = role("architect", ["read", "write", "edit"]);
      const builder = role("builder", ["read", "write", "edit"]);
      const resolve = (name: string): AgentDef =>
        name === "surveyor" ? surveyor : name === "architect" ? architect : builder;
      const workflow = parseOk(
        [
          "---",
          "name: pipeline",
          "---",
          "1. @surveyor survey the options",
          "2. @architect write the ADR to docs/adr/rag-architecture.md {{prev}}",
          "3. @builder build, following the ADR at docs/adr/rag-architecture.md {{prev}}",
          "",
        ].join("\n"),
      );
      const runId = "run-void-recovered";
      const journalDir = join(scratch.home, "recovered-journal");
      const result = await runWorkflow(workflow, {
        resolveAgent: resolve,
        agentNames: () => ["surveyor", "architect", "builder"],
        journal: createFileRunJournal(journalDir),
        runId,
        runStep: createRuntimeRunStep(runtime, {
          resolveAgent: resolve,
          writeLane: laneFor(runtime, runId),
        }),
      });

      // No park, no question, no second run: the pipeline just finished.
      expect(result.status).toBe("done");
      expect(result.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
      expect(
        await readFile(join(scratch.cwd, "docs", "adr", "rag-architecture.md"), "utf8"),
      ).toContain("# RAG architecture");

      const lines = await journalOnceEnded(journalDir);
      expect(lines.some((line) => line.kind === "stepFailAsk")).toBe(false);
      expect(lines.findLast((line) => line.kind === "runEnd")).toMatchObject({ status: "done" });
      // The whole cost of the rescue: one extra request.
      expect(llm.requests).toHaveLength(6);
      // And stage 3 was handed the architect's real report.
      expect(JSON.stringify(llm.requests.at(-1)?.messages ?? [])).toContain(
        "ADR written to docs/adr",
      );
    },
  );
});

describe("ORG-HALT short-circuits every later stage — nothing is dispatched", () => {
  it("never builds the later role's agent, never asks its model, never makes its worktree", async () => {
    const scratch = await gitScratch();
    // Stage one halts. Whatever the script says next belongs to stage two, and
    // stage two must never get to say it.
    const llm = fakeLLM([
      { text: "ORG-HALT: the spec contradicts itself; a person has to decide." },
      { text: "STAGE TWO SHOULD NEVER SPEAK" },
    ]);
    const runtime = await runtimeWith(scratch, llm);

    const runId = "run-halt";
    const developer = role("developer", ["read", "write", "edit"]);
    const workflow = parseOk(
      "---\nname: demo\n---\n1. @developer decide\n2. @developer act on {{prev}}\n",
    );
    const result = await runWorkflow(workflow, {
      resolveAgent: () => developer,
      agentNames: () => ["developer"],
      runStep: createRuntimeRunStep(runtime, {
        resolveAgent: () => developer,
        writeLane: laneFor(runtime, runId),
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("skipped");
    // The effects: stage two's model was never asked a single question…
    expect(llm.requests).toHaveLength(1);
    // …and no worktree was ever cut for it. Only stage one's exists under the
    // run directory (kept, because a halted step's tree is evidence).
    const runDir = join(scratch.home, "workflow-runs", runId);
    expect(await exists(join(runDir, "2-developer"))).toBe(false);
  });
});
