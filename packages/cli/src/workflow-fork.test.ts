/**
 * `/workflow fork`, proved on the run it produces.
 *
 * The claim under test is "a fork is a resume that starts in a new directory",
 * so the assertions are the ones that would catch it not being one: the copied
 * stage is never dispatched again, its patch file is in the NEW run's
 * directory (not borrowed from the old one), the `--at` step really runs on
 * the model the fork pinned, and the stages after it run normally. Every
 * refusal is asserted on its exact message, because a fork that quietly did
 * the wrong thing is worse than one that would not start.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LLMRequest, ModelSpec } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import type { ArcturnRuntime } from "./runtime.js";
import { respondingLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  createRuntimeRunStep,
  createRuntimeWriteLane,
  isWorkflowParseError,
  parseWorkflow,
  replayPromptHashes,
  runWorkflow,
  type Workflow,
  type WorkflowStepRequest,
  type WriteLaneHost,
} from "./workflow.js";
import {
  createForkRevert,
  type ForkRevertPlan,
  type ForkRevertResult,
  forkWorkflowRun,
  parseForkArgs,
} from "./workflow-fork.js";
import {
  buildResumeState,
  createFileRunJournal,
  type JournalLine,
  readJournalLines,
} from "./workflow-run.js";

const execFileAsync = promisify(execFile);
const itPosix = it.skipIf(process.platform === "win32");
const roots: string[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose?.();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// ------------------------------------------------------------- the arguments

describe("parseForkArgs", () => {
  it("reads a run id, the fork point and every grant", () => {
    expect(parseForkArgs(" 20260101-abc --at 2 --model zai/glm-5.3-flash --raise 120")).toEqual({
      runId: "20260101-abc",
      at: "2",
      model: "zai/glm-5.3-flash",
      raise: 120,
    });
  });

  it("lets --input swallow the rest of the line, spaces and all", () => {
    expect(parseForkArgs("run-1 --at 3 --input the auth service, staging only")).toEqual({
      runId: "run-1",
      at: "3",
      input: "the auth service, staging only",
    });
  });

  it("refuses a fork with no fork point", () => {
    expect(parseForkArgs("run-1")).toEqual({
      error:
        "A fork needs --at <stepId>. Usage: /workflow fork <runId> --at <stepId> [--revert] [--model <tag>] [--raise <n>] [--input <text>]",
    });
  });

  it("refuses a raise that is not a positive number of turns", () => {
    expect(parseForkArgs("run-1 --at 2 --raise zero")).toEqual({
      error: '--raise needs a positive number of turns, got "zero".',
    });
  });

  it("reads --revert as the consent it is", () => {
    expect(parseForkArgs("run-1 --at 3 --revert")).toEqual({
      runId: "run-1",
      at: "3",
      revert: true,
    });
  });

  it("refuses an option it does not know", () => {
    expect(parseForkArgs("run-1 --at 2 --fast")).toMatchObject({
      error: expect.stringContaining('Unknown option "--fast"'),
    });
  });
});

// ------------------------------------------------------------ a real pipeline

const REVIEW_MODEL = "anthropic/claude-haiku-4-5";
const PINNED_MODEL = "anthropic/claude-sonnet-4-5";

function spec(id: string): ModelSpec {
  return {
    id,
    provider: "anthropic",
    model: id,
    displayName: id,
    contextWindow: 100_000,
    maxOutputTokens: 4_000,
    capabilities: { streaming: true, toolUse: true, vision: false, reasoning: false },
  } as unknown as ModelSpec;
}

const ROLES = new Map<string, AgentDef>([
  [
    "builder",
    {
      name: "builder",
      description: "writes",
      systemPrompt: "You write files.",
      tools: ["read", "write", "edit"],
      source: "<test>",
    },
  ],
  [
    "reviewer",
    {
      name: "reviewer",
      description: "reads",
      systemPrompt: "You review.",
      tools: ["read"],
      source: "<test>",
    },
  ],
]);

const SOURCE = [
  "---",
  "name: fork-wf",
  "description: d",
  "---",
  "1. @builder write it",
  "2. @reviewer check it",
  "3. @reviewer sign it",
].join("\n");

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "fork-wf", source: "/tmp/fork-wf.md" });
  if (isWorkflowParseError(parsed)) throw new Error(parsed.error);
  return parsed;
}

async function gitScratch(): Promise<Scratch> {
  const scratch = await makeScratch();
  roots.push(scratch.root);
  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync("git", args, { cwd: scratch.cwd });
  await mkdir(scratch.cwd, { recursive: true });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await git("config", "core.autocrlf", "false");
  await writeFile(join(scratch.cwd, "seed.txt"), "seed\n", "utf8");
  await git("add", "-A");
  await git("commit", "-qm", "base");
  return scratch;
}

/** The builder writes one file; everyone else answers in one line. */
function pipelineModel(seen: LLMRequest[]) {
  return respondingLLM((request) => {
    seen.push(request);
    if (request.messages.at(-1)?.role === "toolResult") return { text: "done" };
    if (request.tools?.some((tool) => tool.name === "write")) {
      return {
        toolCalls: [
          { id: "w1", name: "write", arguments: { path: "built.txt", content: "built\n" } },
        ],
      };
    }
    return { text: `reviewed on ${request.model.id}` };
  });
}

function resolveModel(tag: string): ModelSpec | undefined {
  return tag === "pinned" ? spec(PINNED_MODEL) : undefined;
}

/** Run the whole three-stage pipeline once, for real. */
async function sourceRun(): Promise<{
  scratch: Scratch;
  runtime: ArcturnRuntime;
  runsRoot: string;
  runId: string;
  lines: JournalLine[];
}> {
  const scratch = await gitScratch();
  const seen: LLMRequest[] = [];
  const runtime = await buildTestRuntime(scratch, [], {
    llm: pipelineModel(seen),
    permissionMode: "yolo",
    model: REVIEW_MODEL,
  });
  runtimes.push(runtime);
  const runsRoot = join(scratch.home, "workflow-runs");
  const runId = "fork-source";
  const workflow = parseOk(SOURCE);
  await runWorkflow(workflow, {
    input: "",
    runId,
    resolveAgent: (name) => ROLES.get(name),
    agentNames: () => [...ROLES.keys()],
    resolveModel,
    journal: createFileRunJournal(join(runsRoot, runId)),
    runStep: createRuntimeRunStep(runtime, {
      resolveAgent: (name) => ROLES.get(name),
      agentNames: () => [...ROLES.keys()],
      resolveModel,
      writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId),
    }),
  });
  for (let i = 0; i < 100; i += 1) {
    const lines = await readJournalLines(join(runsRoot, runId));
    if (lines.some((line) => line.kind === "runEnd")) {
      return { scratch, runtime, runsRoot, runId, lines };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the source run never recorded a terminal runEnd");
}

/** The staleness check the command wires, over whatever workflow is passed. */
function hashesFor(workflow: Workflow, input: string) {
  return (recorded: Parameters<typeof replayPromptHashes>[2]) =>
    replayPromptHashes(workflow, input, recorded);
}

describe("forking a finished run", () => {
  itPosix(
    "reuses stage 1 without re-running it and pins stage 2 to the forked model",
    async () => {
      const source = await sourceRun();
      const workflow = parseOk(SOURCE);

      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-child",
        workflow,
        model: "pinned",
        promptHashes: hashesFor(workflow, ""),
      });
      expect(forked).toMatchObject({ ok: true, stages: 1, steps: 1, patches: 1 });
      if (!forked.ok) throw new Error(forked.error);

      const childDir = join(source.runsRoot, "fork-child");
      const lines = await readJournalLines(childDir);

      // THE HEADER: the new run says where it came from and at which step.
      const header = lines.find(
        (line): line is Extract<JournalLine, { kind: "run" }> => line.kind === "run",
      );
      expect(header?.runId).toBe("fork-child");
      expect(header?.workflow).toBe("fork-wf");
      expect(header?.forkedFrom).toMatchObject({ runId: source.runId, at: "2" });

      // THE COPIED PREFIX: stage 1's terminal, and its patch file rewritten to
      // live in the new run's own directory rather than borrowed from the old.
      const copied = lines.find(
        (line): line is Extract<JournalLine, { kind: "stepEnd" }> =>
          line.kind === "stepEnd" && line.id === "1",
      );
      expect(copied?.status).toBe("done");
      const patchPath = copied?.record?.patchPath;
      expect(patchPath?.startsWith(childDir)).toBe(true);
      expect((await stat(patchPath as string)).isFile()).toBe(true);

      // THE GRANT: one line, for one step.
      expect(lines.filter((line) => line.kind === "stepModelOverride")).toEqual([
        { kind: "stepModelOverride", stepId: "2", tag: "pinned", ts: expect.any(Number) },
      ]);

      // …and now continue it, exactly as the command does.
      const state = buildResumeState(lines);
      expect([...(state.modelOverrides ?? new Map())]).toEqual([["2", "pinned"]]);
      const dispatched: WorkflowStepRequest[] = [];
      const seen: LLMRequest[] = [];
      const runtime = await buildTestRuntime(source.scratch, [], {
        llm: pipelineModel(seen),
        permissionMode: "yolo",
        model: REVIEW_MODEL,
      });
      runtimes.push(runtime);
      const inner = createRuntimeRunStep(runtime, {
        resolveAgent: (name) => ROLES.get(name),
        agentNames: () => [...ROLES.keys()],
        resolveModel,
        writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, "fork-child"),
        modelOverride: (stepId) => state.modelOverrides?.get(stepId),
      });
      const result = await runWorkflow(workflow, {
        input: "",
        runId: "fork-child",
        resolveAgent: (name) => ROLES.get(name),
        agentNames: () => [...ROLES.keys()],
        resolveModel,
        journal: createFileRunJournal(childDir),
        resumeFrom: state,
        runStep: async (request) => {
          dispatched.push(request);
          return await inner(request);
        },
      });

      expect(result.status).toBe("done");
      // STAGE 1 WAS NOT RE-RUN — the whole promise of a fork.
      expect(dispatched.map((request) => request.step.id)).toEqual(["2", "3"]);
      // The `--at` step really ran on the pinned model; the step after it did
      // not, because a fork's `--model` binds one step and no other.
      expect(seen[0]?.model.id).toBe(PINNED_MODEL);
      expect(seen.at(-1)?.model.id).toBe(REVIEW_MODEL);
    },
    60_000,
  );

  itPosix(
    "refuses a fork point the workflow does not have",
    async () => {
      const source = await sourceRun();
      const workflow = parseOk(SOURCE);
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "9",
        newRunId: "fork-nope",
        workflow,
        promptHashes: hashesFor(workflow, ""),
      });
      expect(forked).toEqual({
        ok: false,
        error: `Workflow "fork-wf" has no step "9"; /workflow status ${source.runId} lists the steps it ran.`,
      });
    },
    60_000,
  );

  itPosix(
    "refuses a fork at the first stage, where nothing finished before it",
    async () => {
      const source = await sourceRun();
      const workflow = parseOk(SOURCE);
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "1",
        newRunId: "fork-first",
        workflow,
        promptHashes: hashesFor(workflow, ""),
      });
      expect(forked).toEqual({
        ok: false,
        error:
          'Step 1 is in the first stage of "fork-wf", so no stage finished before it — run the workflow again instead of forking it.',
      });
    },
    60_000,
  );

  it("refuses a run id with no journal", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const workflow = parseOk(SOURCE);
    const forked = await forkWorkflowRun({
      runsRoot: join(scratch.home, "workflow-runs"),
      sourceRunId: "nobody",
      at: "2",
      newRunId: "fork-none",
      workflow,
      promptHashes: hashesFor(workflow, ""),
    });
    expect(forked).toEqual({ ok: false, error: 'No run journal for "nobody".' });
  });

  itPosix(
    "refuses when the workflow file changed under a step it would reuse",
    async () => {
      const source = await sourceRun();
      // The same pipeline, with stage 1's brief rewritten: the recorded answer
      // now answers a question the file no longer asks.
      const edited = parseOk(SOURCE.replace("1. @builder write it", "1. @builder write it twice"));
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-stale",
        workflow: edited,
        promptHashes: hashesFor(edited, ""),
      });
      expect(forked).toEqual({
        ok: false,
        error: `Step 1 of "fork-wf" has changed since run ${source.runId} ran it, so its recorded answer cannot be reused. Run the workflow fresh instead.`,
      });
    },
    60_000,
  );

  itPosix(
    "carries the run's frozen baseline so a later worktree still seeds",
    async () => {
      const source = await sourceRun();
      const workflow = parseOk(SOURCE);
      // The source run's lane freezes these once; a fork that re-captured them
      // from a checkout its own prefix already changed could not seed at all.
      await writeFile(join(source.runsRoot, source.runId, "_run-baseline.patch"), "", "utf8");
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-baseline",
        workflow,
        promptHashes: hashesFor(workflow, ""),
      });
      expect(forked.ok).toBe(true);
      expect(
        await readFile(join(source.runsRoot, "fork-baseline", "_run-baseline.patch"), "utf8"),
      ).toBe("");
    },
    60_000,
  );
});

// --------------------------------------------------- forking a FINISHED run

/**
 * The case `--revert` exists for: every stage writes, so a run that reached
 * the end left ALL of its patches in the user's checkout. Forking that at
 * step 2 means step 2's work is already in those files.
 */
const APPLY_SOURCE = [
  "---",
  "name: fork-wf",
  "description: d",
  "---",
  "1. @builder write one",
  "2. @builder write two",
  "3. @builder write three",
].join("\n");

/** Each stage rewrites the same file, so its patches stack. */
function applyPipelineModel(seen: LLMRequest[]) {
  return respondingLLM((request) => {
    seen.push(request);
    if (request.messages.at(-1)?.role === "toolResult") return { text: "done" };
    const blob = JSON.stringify(request);
    const content = blob.includes("write three")
      ? "one\ntwo\nthree\n"
      : blob.includes("write two")
        ? "one\ntwo\n"
        : "one\n";
    return { toolCalls: [{ id: "w1", name: "write", arguments: { path: "a.txt", content } }] };
  });
}

function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd });
}

/** The revert executor exactly as the command wires it, over a real repo. */
function revertFor(cwd: string, printed: string[]) {
  return createForkRevert({
    git: { cwd, exec: (dir, args) => git(dir, ...args) },
    // The command serializes through the engine's apply queue; a test has no
    // competing apply, so the seam is exercised without the queue.
    serialize: (task) => task(),
    print: (line) => printed.push(line),
  });
}

/** Run the all-writing pipeline to completion, for real. */
async function finishedRun(): Promise<{
  scratch: Scratch;
  runsRoot: string;
  runId: string;
  workflow: Workflow;
}> {
  const scratch = await gitScratch();
  const seen: LLMRequest[] = [];
  const runtime = await buildTestRuntime(scratch, [], {
    llm: applyPipelineModel(seen),
    permissionMode: "yolo",
    model: REVIEW_MODEL,
  });
  runtimes.push(runtime);
  const runsRoot = join(scratch.home, "workflow-runs");
  const runId = "revert-source";
  const workflow = parseOk(APPLY_SOURCE);
  await runWorkflow(workflow, {
    input: "",
    runId,
    resolveAgent: (name) => ROLES.get(name),
    agentNames: () => [...ROLES.keys()],
    resolveModel,
    journal: createFileRunJournal(join(runsRoot, runId)),
    runStep: createRuntimeRunStep(runtime, {
      resolveAgent: (name) => ROLES.get(name),
      agentNames: () => [...ROLES.keys()],
      resolveModel,
      writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId),
    }),
  });
  for (let i = 0; i < 100; i += 1) {
    const lines = await readJournalLines(join(runsRoot, runId));
    if (lines.some((line) => line.kind === "runEnd")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // The whole premise: the checkout now holds all three stages' work.
  expect(await readFile(join(scratch.cwd, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  return { scratch, runsRoot, runId, workflow };
}

describe("forking a run whose patches are still in the checkout", () => {
  itPosix(
    "refuses without --revert, and touches nothing",
    async () => {
      const source = await finishedRun();
      const before = (await git(source.scratch.cwd, "status", "--porcelain")).stdout;

      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-refused",
        workflow: source.workflow,
        promptHashes: hashesFor(source.workflow, ""),
      });

      expect(forked).toEqual({
        ok: false,
        error:
          `Run ${source.runId} already applied steps 2-3 into this checkout; add --revert to ` +
          "undo them first, or fork a run that stopped at 2.",
      });
      // EFFECTS: the files and the tree are exactly as the source run left them,
      // and no run directory was created for the fork that did not happen.
      expect(await readFile(join(source.scratch.cwd, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
      expect((await git(source.scratch.cwd, "status", "--porcelain")).stdout).toBe(before);
      await expect(stat(join(source.runsRoot, "fork-refused"))).rejects.toThrow();
    },
    60_000,
  );

  itPosix(
    "with --revert rewinds the checkout to the end of stage 1, records it, and continues",
    async () => {
      const source = await finishedRun();
      const printed: string[] = [];

      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-reverted",
        workflow: source.workflow,
        model: "pinned",
        promptHashes: hashesFor(source.workflow, ""),
        revert: revertFor(source.scratch.cwd, printed),
      });
      if (!forked.ok) throw new Error(forked.error);
      expect(forked).toMatchObject({
        ok: true,
        reverted: { steps: ["2", "3"], patches: 2 },
      });

      // THE EFFECT ON DISK: stage 1's work, and nothing after it.
      expect(await readFile(join(source.scratch.cwd, "a.txt"), "utf8")).toBe("one\n");
      // The dry run went out before the act, newest patch first.
      expect(printed[0]).toContain("Reverting 2 patch(es) applied by revert-source");
      expect(printed[1]).toContain("step 3");
      expect(printed[2]).toContain("step 2");
      expect(printed.at(-1)).toBe(
        `Reverted 2 patch(es) from steps 2-3 of ${source.runId}; the checkout now matches the ` +
          "end of stage 1.",
      );

      // THE DURABLE RECORD, in the NEW run.
      const childDir = join(source.runsRoot, "fork-reverted");
      const lines = await readJournalLines(childDir);
      expect(lines.filter((line) => line.kind === "forkRevert")).toEqual([
        { kind: "forkRevert", steps: ["2", "3"], patches: 2, ts: expect.any(Number) },
      ]);
      // Nothing was copied for a step whose work was just undone.
      expect(lines.filter((line) => line.kind === "stepEnd").map((line) => line.id)).toEqual(["1"]);

      // …and the fork really runs, on the pinned model, applying cleanly.
      const state = buildResumeState(lines);
      const seen: LLMRequest[] = [];
      const runtime = await buildTestRuntime(source.scratch, [], {
        llm: applyPipelineModel(seen),
        permissionMode: "yolo",
        model: REVIEW_MODEL,
      });
      runtimes.push(runtime);
      const dispatched: WorkflowStepRequest[] = [];
      const inner = createRuntimeRunStep(runtime, {
        resolveAgent: (name) => ROLES.get(name),
        agentNames: () => [...ROLES.keys()],
        resolveModel,
        writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, "fork-reverted"),
        modelOverride: (stepId) => state.modelOverrides?.get(stepId),
      });
      const result = await runWorkflow(source.workflow, {
        input: "",
        runId: "fork-reverted",
        resolveAgent: (name) => ROLES.get(name),
        agentNames: () => [...ROLES.keys()],
        resolveModel,
        journal: createFileRunJournal(childDir),
        resumeFrom: state,
        runStep: async (request) => {
          dispatched.push(request);
          return await inner(request);
        },
      });

      expect(result.status).toBe("done");
      expect(dispatched.map((request) => request.step.id)).toEqual(["2", "3"]);
      expect(seen[0]?.model.id).toBe(PINNED_MODEL);
      expect(await readFile(join(source.scratch.cwd, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    },
    120_000,
  );

  itPosix(
    "refuses before reverting anything when a file in the revert set is dirty",
    async () => {
      const source = await finishedRun();
      const dirty = "one\ntwo\nthree\nmy own edit\n";
      await writeFile(join(source.scratch.cwd, "a.txt"), dirty, "utf8");
      const printed: string[] = [];

      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-dirty",
        workflow: source.workflow,
        promptHashes: hashesFor(source.workflow, ""),
        revert: revertFor(source.scratch.cwd, printed),
      });

      expect(forked).toMatchObject({
        ok: false,
        error: expect.stringContaining("uncommitted changes in a.txt"),
      });
      // NOT ONE BYTE, and no run directory for the fork that was refused.
      expect(await readFile(join(source.scratch.cwd, "a.txt"), "utf8")).toBe(dirty);
      await expect(stat(join(source.runsRoot, "fork-dirty"))).rejects.toThrow();
    },
    60_000,
  );

  itPosix(
    "refuses by STEP when a patch no longer reverse-applies",
    async () => {
      const source = await finishedRun();
      // The file moved on and the move was committed, so the tree is clean —
      // the only thing wrong is that step 3's patch no longer fits.
      await writeFile(join(source.scratch.cwd, "a.txt"), "something else entirely\n", "utf8");
      await git(source.scratch.cwd, "add", "-A");
      await git(source.scratch.cwd, "commit", "-qm", "hand edit");
      const printed: string[] = [];

      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-stale-patch",
        workflow: source.workflow,
        promptHashes: hashesFor(source.workflow, ""),
        revert: revertFor(source.scratch.cwd, printed),
      });

      expect(forked).toMatchObject({
        ok: false,
        error: expect.stringContaining(`Cannot revert step 3 of run ${source.runId}`),
      });
      expect(forked).toMatchObject({ error: expect.stringContaining("nothing was undone") });
      expect(await readFile(join(source.scratch.cwd, "a.txt"), "utf8")).toBe(
        "something else entirely\n",
      );
    },
    60_000,
  );

  itPosix(
    "needs no revert at all for a run that stopped at the fork point",
    async () => {
      // The original pipeline: only stage 1 writes, so forking at step 2 finds
      // nothing of its own in the checkout — exactly as before `--revert`.
      const source = await sourceRun();
      const workflow = parseOk(SOURCE);
      const plans: ForkRevertPlan[] = [];
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "2",
        newRunId: "fork-nothing-to-revert",
        workflow,
        promptHashes: hashesFor(workflow, ""),
        revert: async (plan): Promise<ForkRevertResult> => {
          plans.push(plan);
          return { ok: true, steps: plan.steps, patches: plan.patches.length };
        },
      });
      expect(forked).toMatchObject({ ok: true, stages: 1, steps: 1 });
      expect(plans).toEqual([]);
      const lines = await readJournalLines(join(source.runsRoot, "fork-nothing-to-revert"));
      expect(lines.some((line) => line.kind === "forkRevert")).toBe(false);
    },
    60_000,
  );
});

// ------------------------------- forking past a write stage the pipe reads

/**
 * THE FORK THAT REFUSED A FILE NOBODY HAD TOUCHED.
 *
 * A live evaluation forked a finished three-stage run at step 3 — a raced,
 * write-lane stage 1, a `[judges:2] [contract:verdict]` stage 2 reading
 * `{{prev}}`, and a `{{contract.decision}}` stage 3 — and got
 * `step 2 cannot resume: the workflow "ship" changed since this run` on every
 * attempt, from an unedited file.
 *
 * The cause is not judges, contracts or the race: it is the PATCH PATH. A
 * worktree step's terminal carries a patch record, `{{prev}}` renders that
 * record as an `ARCTURN-PATCH: … patch=<absolute path>` trailer, and a fork
 * copies the patch file into its own directory and rewrites the record to
 * match. Every later reused step's prompt therefore legitimately differs from
 * the source run's — while the copied lines still carried the SOURCE's prompt
 * hashes, so the fork's own resume compared its recomputed prompt against a
 * hash for a prompt it could never produce, and refused.
 *
 * The fix restamps the copied hashes through the same `replayPromptHashes`
 * the staleness refusal uses, called a second time with the lines as they will
 * be on disk. These tests pin the run, not the internals: the fork completes,
 * and stage 1 and 2 are never dispatched again.
 */
const PIPED_SOURCE = [
  "---",
  "name: fork-wf",
  "description: d",
  "---",
  "1. @builder write it",
  "2. @reviewer check this: {{prev}}",
  "3. @reviewer sign it",
].join("\n");

const RACE_JUDGED_SOURCE = [
  "---",
  "name: fork-wf",
  "description: d",
  "---",
  "1. [race:armA|armB] @builder write it",
  "2. [judges:2] [contract:verdict] @reviewer review this: {{prev}}",
  "3. @reviewer act on {{contract.decision}}",
  "",
  "```contract verdict",
  "decision: SHIP | DO-NOT-SHIP",
  "confidence: number",
  "```",
].join("\n");

/** The judged stage answers in the shape its contract asks for. */
function judgedPipelineModel() {
  return respondingLLM((request) => {
    if (request.messages.at(-1)?.role === "toolResult") return { text: "done" };
    if (request.tools?.some((tool) => tool.name === "write")) {
      return {
        toolCalls: [
          { id: "w1", name: "write", arguments: { path: "built.txt", content: "built\n" } },
        ],
      };
    }
    return {
      text: ["Looks fine.", "", "```json", '{"decision":"SHIP","confidence":0.9}', "```"].join(
        "\n",
      ),
    };
  });
}

function raceModel(tag: string): ModelSpec | undefined {
  if (tag === "pinned") return spec(PINNED_MODEL);
  if (tag === "armA") return spec(REVIEW_MODEL);
  if (tag === "armB") return spec(PINNED_MODEL);
  return undefined;
}

/** Run one pipeline for real, and return everything a fork of it needs. */
async function pipedSourceRun(
  raw: string,
  runId: string,
): Promise<{ scratch: Scratch; runsRoot: string; runId: string; workflow: Workflow }> {
  const scratch = await gitScratch();
  const runtime = await buildTestRuntime(scratch, [], {
    llm: judgedPipelineModel(),
    permissionMode: "yolo",
    model: REVIEW_MODEL,
  });
  runtimes.push(runtime);
  const runsRoot = join(scratch.home, "workflow-runs");
  const workflow = parseOk(raw);
  const result = await runWorkflow(workflow, {
    input: "",
    runId,
    resolveAgent: (name) => ROLES.get(name),
    agentNames: () => [...ROLES.keys()],
    resolveModel: raceModel,
    journal: createFileRunJournal(join(runsRoot, runId)),
    runStep: createRuntimeRunStep(runtime, {
      resolveAgent: (name) => ROLES.get(name),
      agentNames: () => [...ROLES.keys()],
      resolveModel: raceModel,
      writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId),
    }),
  });
  if (result.status !== "done") throw new Error(`source run ${result.status}: ${result.error}`);
  for (let i = 0; i < 100; i += 1) {
    const lines = await readJournalLines(join(runsRoot, runId));
    if (lines.some((line) => line.kind === "runEnd")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { scratch, runsRoot, runId, workflow };
}

/** Cut the fork and continue it, exactly as the `/workflow fork` verb does. */
async function forkAndContinue(
  source: { scratch: Scratch; runsRoot: string; runId: string; workflow: Workflow },
  at: string,
  forkId: string,
) {
  const forked = await forkWorkflowRun({
    runsRoot: source.runsRoot,
    sourceRunId: source.runId,
    at,
    newRunId: forkId,
    workflow: source.workflow,
    promptHashes: hashesFor(source.workflow, ""),
  });
  if (!forked.ok) throw new Error(`the fork refused: ${forked.error}`);
  const childDir = join(source.runsRoot, forkId);
  const lines = await readJournalLines(childDir);
  const state = buildResumeState(lines);
  const runtime = await buildTestRuntime(source.scratch, [], {
    llm: judgedPipelineModel(),
    permissionMode: "yolo",
    model: REVIEW_MODEL,
  });
  runtimes.push(runtime);
  const inner = createRuntimeRunStep(runtime, {
    resolveAgent: (name) => ROLES.get(name),
    agentNames: () => [...ROLES.keys()],
    resolveModel: raceModel,
    writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, forkId),
  });
  const dispatched: string[] = [];
  const result = await runWorkflow(source.workflow, {
    input: "",
    runId: forkId,
    resolveAgent: (name) => ROLES.get(name),
    agentNames: () => [...ROLES.keys()],
    resolveModel: raceModel,
    journal: createFileRunJournal(childDir),
    resumeFrom: state,
    runStep: async (request) => {
      dispatched.push(request.step.id);
      return await inner(request);
    },
  });
  return { result, dispatched, childDir, forkLines: lines };
}

describe("forking past a stage whose patch the pipe reads", () => {
  itPosix(
    "forks at step 3 of a raced + judged + contract pipeline without refusing",
    async () => {
      const source = await pipedSourceRun(RACE_JUDGED_SOURCE, "fork-eval-source");
      const { result, dispatched } = await forkAndContinue(source, "3", "fork-eval-child");

      // THE ASSERTION THE EVAL WANTED: no "the workflow changed" refusal about
      // a file that was never edited.
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("done");
      // …and the reused prefix really was reused, race and panel included.
      expect(dispatched).toEqual(["3"]);
    },
    120_000,
  );

  itPosix(
    "forks at step 3 of a plain pipeline whose stage 2 reads {{prev}}",
    async () => {
      // The same defect with none of the race/judges machinery, so a
      // regression cannot hide behind "it is only the exotic shape".
      const source = await pipedSourceRun(PIPED_SOURCE, "fork-piped-source");
      const { result, dispatched, forkLines } = await forkAndContinue(
        source,
        "3",
        "fork-piped-child",
      );

      expect(result.status).toBe("done");
      expect(dispatched).toEqual(["3"]);
      // The copied hash is the one THIS run's resume recomputes, not the
      // source's — the trailer names a patch file in this run's directory.
      const sourceStep2 = (await readJournalLines(join(source.runsRoot, source.runId))).find(
        (line): line is Extract<JournalLine, { kind: "stepEnd" }> =>
          line.kind === "stepEnd" && line.id === "2",
      );
      const forkStep2 = forkLines.find(
        (line): line is Extract<JournalLine, { kind: "stepEnd" }> =>
          line.kind === "stepEnd" && line.id === "2",
      );
      expect(forkStep2?.promptHash).not.toBe(sourceStep2?.promptHash);
    },
    120_000,
  );

  itPosix(
    "leaves one writer per stage line, so a fork's status cannot contradict itself",
    async () => {
      // The source run's stage lines used to be copied in beside the ones the
      // fork's own run writes, and `/workflow status` folds `stageEnd`
      // last-wins: a fork that failed later rendered "Stage 1 — failed" over a
      // step whose own terminal said `done`.
      const source = await pipedSourceRun(PIPED_SOURCE, "fork-stage-source");
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "3",
        newRunId: "fork-stage-child",
        workflow: source.workflow,
        promptHashes: hashesFor(source.workflow, ""),
      });
      expect(forked.ok).toBe(true);
      const lines = await readJournalLines(join(source.runsRoot, "fork-stage-child"));
      // Nothing but the header, the reused terminals and the grants: the fork
      // itself writes no stage line at all.
      expect(lines.filter((line) => line.kind === "stageStart")).toEqual([]);
      expect(lines.filter((line) => line.kind === "stageEnd")).toEqual([]);

      // …and after the run, exactly one of each, from one writer.
      const { result } = await forkAndContinue(source, "3", "fork-stage-child-2");
      expect(result.status).toBe("done");
      // The stage roll-ups are fire-and-forget appends, so wait for the run's
      // own terminal to land rather than assuming a machine speed.
      let after = await readJournalLines(join(source.runsRoot, "fork-stage-child-2"));
      for (let i = 0; i < 100 && !after.some((line) => line.kind === "runEnd"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        after = await readJournalLines(join(source.runsRoot, "fork-stage-child-2"));
      }
      const ends = after.filter(
        (line): line is Extract<JournalLine, { kind: "stageEnd" }> => line.kind === "stageEnd",
      );
      expect(ends.map((line) => line.stage)).toEqual([1, 2, 3]);
      expect(ends.every((line) => line.status === "done")).toBe(true);
    },
    120_000,
  );

  itPosix(
    "refuses a genuinely changed workflow before it mints a directory",
    async () => {
      // The other half of "a fork that refuses must not leave a half-written
      // run": every refusal happens before `mkdir`, so there is no run to read
      // back at all.
      const source = await pipedSourceRun(PIPED_SOURCE, "fork-clean-source");
      const edited = parseOk(
        PIPED_SOURCE.replace("1. @builder write it", "1. @builder write TWICE"),
      );
      const forked = await forkWorkflowRun({
        runsRoot: source.runsRoot,
        sourceRunId: source.runId,
        at: "3",
        newRunId: "fork-clean-child",
        workflow: edited,
        promptHashes: hashesFor(edited, ""),
      });
      expect(forked).toEqual({
        ok: false,
        error: `Step 1 of "fork-wf" has changed since run ${source.runId} ran it, so its recorded answer cannot be reused. Run the workflow fresh instead.`,
      });
      await expect(stat(join(source.runsRoot, "fork-clean-child"))).rejects.toThrow();
    },
    120_000,
  );
});
