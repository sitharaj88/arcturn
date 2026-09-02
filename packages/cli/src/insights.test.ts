/**
 * The feedback loop, asserted on the FILE and on a real run.
 *
 * Every test here was written red: each one names, in its own comment, the
 * thing that did not exist or did not hold before this module — because a
 * ledger nobody has ever read back is indistinguishable from a ledger that
 * writes the wrong thing, and a privacy promise nobody has ever tested is a
 * comment.
 *
 * Three groups:
 *
 * - **the recorder** — what lands on disk, byte for byte, including the one
 *   field (`reasoningTail`) that must never appear there;
 * - **the run** — a real `runWorkflow` over a real git checkout and a scripted
 *   model, driven to a park, with the ledger read back afterwards;
 * - **the command** — the aggregate over a hand-written ledger, its filters,
 *   its `--json` shape, its exit codes, and the `--share` URL.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText } from "@arcturn/core";
import type { LLMRequest } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import {
  aggregateInsights,
  createInsightsRecorder,
  INSIGHTS_PRIVACY_STATEMENT,
  type InsightsEvent,
  insightsFile,
  insightsRotatedFile,
  type ParkRecord,
  type ProgressWarningRecord,
  parkCauseKind,
  parseInsightsArgs,
  type RunEndRecord,
  readInsightsLedger,
  renderInsights,
  renderInsightsShare,
  runInsightsCommand,
  SHARE_URL_MAX_BYTES,
  type SilentTurnRecord,
  type StepEndRecord,
} from "./insights.js";
import type { ArcturnRuntime } from "./runtime.js";
import { resolveWindow } from "./stats.js";
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
  writeLaneProgressCheck,
} from "./workflow.js";
import {
  activityFacts,
  createFileRunJournal,
  describeActivity,
  type JournalLine,
  readJournalLines,
} from "./workflow-run.js";

// ===========================================================================
// harness (the orchestration-effects pattern, over an isolated $ARCTURN_HOME)
// ===========================================================================

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

/** These drive real git worktrees and a real POSIX shell. */
const itPosix = it.skipIf(process.platform === "win32");

/** A scratch tree whose project directory is a real git repository. */
async function gitScratch(seed: Record<string, string> = {}): Promise<Scratch> {
  const scratch = await makeScratch();
  roots.push(scratch.root);
  const git = (...args: string[]): Promise<void> => execFileAsync("git", args, scratch.cwd);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
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

/** The production write lane over a real runtime and a real repository. */
function laneFor(runtime: ArcturnRuntime, runId: string): WriteLane {
  return createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId);
}

/** The last message of one recorded request, rendered as text. */
function lastMessageText(request: LLMRequest): string {
  const last = request.messages.at(-1);
  return last === undefined ? "" : contentText(last.content);
}

/** Does this path exist at all? */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// 1. the recorder
// ===========================================================================

describe("the ledger records failure-shaped events, and nothing else", () => {
  /**
   * RED FIRST: there was no ledger at all — every one of these facts lived for
   * the length of one terminal scrollback and then did not exist.
   */
  it("writes each kind with exactly the fields it promises", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    let clock = 1_000;
    const recorder = createInsightsRecorder({ home: scratch.home, now: () => (clock += 1) });

    recorder.record({
      kind: "silent-turn",
      model: "zai/glm-5.3",
      nudged: true,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
    });
    recorder.record({
      kind: "progress-warning",
      turnIndex: 40,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r1",
      stepId: "5",
      role: "builder",
    });
    recorder.record({
      kind: "step-end",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
      status: "failed",
      failureKind: "turn-ceiling",
      model: "zai/glm-5.3",
      durationMs: 4200,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
      },
      attempts: 2,
      activity: { turns: 80, toolCalls: { bash: 77, read: 17 }, writes: 0 },
    });
    recorder.record({
      kind: "park",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
      failureKind: "turn-ceiling",
      attempts: 2,
      causeKind: "turn-ceiling",
    });
    recorder.record({
      kind: "budget-ask",
      workflow: "pipeline",
      runId: "r1",
      ceiling: "usd",
      spent: 0.81,
      limit: 1,
    });
    recorder.record({
      kind: "run-end",
      workflow: "pipeline",
      runId: "r1",
      status: "paused",
      stopReason: "turn-ceiling",
      durationMs: 60_000,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      costUsd: 0.81,
      models: ["zai/glm-5.3", "zai/glm-5.3"],
      steps: 4,
      parks: 1,
    });
    await recorder.flush();

    const { events, skippedLines } = await readInsightsLedger(scratch.home);
    expect(skippedLines).toBe(0);
    expect(events.map((event) => event.kind)).toEqual([
      "silent-turn",
      "progress-warning",
      "step-end",
      "park",
      "budget-ask",
      "run-end",
    ]);
    expect(events[0]).toEqual({
      v: 1,
      ts: 1001,
      kind: "silent-turn",
      model: "zai/glm-5.3",
      nudged: true,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
    });
    expect(events[1]).toEqual({
      v: 1,
      ts: 1002,
      kind: "progress-warning",
      turnIndex: 40,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r1",
      stepId: "5",
      role: "builder",
    });
    expect(events[2]).toEqual({
      v: 1,
      ts: 1003,
      kind: "step-end",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
      status: "failed",
      failureKind: "turn-ceiling",
      model: "zai/glm-5.3",
      durationMs: 4200,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 },
      attempts: 2,
      activity: { turns: 80, toolCalls: { bash: 77, read: 17 }, writes: 0 },
    });
    expect(events[3]).toEqual({
      v: 1,
      ts: 1004,
      kind: "park",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
      failureKind: "turn-ceiling",
      attempts: 2,
      causeKind: "turn-ceiling",
    });
    expect(events[4]).toEqual({
      v: 1,
      ts: 1005,
      kind: "budget-ask",
      workflow: "pipeline",
      runId: "r1",
      ceiling: "usd",
      spent: 0.81,
      limit: 1,
    });
    // `models` is de-duplicated on the way in, so a nine-step run on one model
    // does not write nine copies of its id.
    expect(events[5]).toEqual({
      v: 1,
      ts: 1006,
      kind: "run-end",
      workflow: "pipeline",
      runId: "r1",
      status: "paused",
      stopReason: "turn-ceiling",
      durationMs: 60_000,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.81,
      models: ["zai/glm-5.3"],
      steps: 4,
      parks: 1,
    });
  });

  /**
   * RED FIRST, and the one that matters most: a `LastTurnShape` straight off
   * the run journal carries `reasoningTail` — up to 160 characters of the
   * model's own reasoning. Spreading that shape onto a ledger line (the
   * obvious implementation) puts reasoning in a file whose whole purpose is to
   * be shareable. `insightsLastTurn` rebuilds the shape field by field; this
   * asserts the bytes.
   */
  it("never lets a reasoning tail reach the file, on any record that carries a last turn", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const recorder = createInsightsRecorder({ home: scratch.home, now: () => 7 });
    const lastTurn = {
      model: "zai/glm-5.3",
      stopReason: "endTurn",
      blocks: [{ type: "thinking" as const, chars: 69_786 }],
      // Exactly what the journal would hand over.
      reasoningTail: "...the customer database password is hunter2. Now write.",
    };

    recorder.record({
      kind: "step-end",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      status: "failed",
      durationMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      attempts: 1,
      lastTurn,
    });
    recorder.record({
      kind: "park",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      attempts: 1,
      lastTurn,
      causeKind: "produced-nothing",
    });
    await recorder.flush();

    const raw = await readFile(insightsFile(scratch.home), "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("reasoningTail");
    const { events } = await readInsightsLedger(scratch.home);
    for (const event of events) {
      const shape = (event as StepEndRecord | ParkRecord).lastTurn;
      expect(shape).toEqual({
        model: "zai/glm-5.3",
        stopReason: "endTurn",
        blocks: [{ type: "thinking", chars: 69_786 }],
      });
      expect(Object.keys(shape ?? {})).not.toContain("reasoningTail");
    }
  });

  /**
   * RED FIRST: an append-only file with no rotation grows without bound. One
   * generation is the whole policy — this pins the threshold and pins that the
   * OLD generation is still readable afterwards, which is what makes the
   * `--since 30d` window honest across a rotation.
   */
  it("rotates at the threshold and keeps exactly one generation", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    let clock = 0;
    // Small enough that the third line crosses it.
    const recorder = createInsightsRecorder({
      home: scratch.home,
      now: () => (clock += 1),
      rotateBytes: 260,
    });
    const record = (stepId: string): void =>
      recorder.record({
        kind: "silent-turn",
        model: "m",
        nudged: true,
        origin: "workflow",
        workflow: "pipeline",
        runId: "r1",
        stepId,
      });

    record("1");
    record("2");
    await recorder.flush();
    const beforeSize = (await stat(insightsFile(scratch.home))).size;
    expect(beforeSize).toBeGreaterThan(130);
    expect(beforeSize).toBeLessThanOrEqual(260);
    expect(await exists(insightsRotatedFile(scratch.home))).toBe(false);

    record("3");
    await recorder.flush();

    // The live file now holds only the line that crossed the threshold…
    const live = await readFile(insightsFile(scratch.home), "utf8");
    expect(live.trim().split("\n")).toHaveLength(1);
    expect(live).toContain('"stepId":"3"');
    // …and the previous generation is intact, and still read back.
    const rotated = await readFile(insightsRotatedFile(scratch.home), "utf8");
    expect(rotated.trim().split("\n")).toHaveLength(2);
    const { events } = await readInsightsLedger(scratch.home);
    expect(events.map((event) => (event as SilentTurnRecord).stepId)).toEqual(["1", "2", "3"]);
  });

  /**
   * RED FIRST: "you can turn it off" is a claim, and the only honest proof is
   * that nothing appears on disk — not an empty file, not even the directory.
   */
  it("writes nothing at all — not even a directory — when insights are disabled", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const recorder = createInsightsRecorder({ home: scratch.home, enabled: false });
    expect(recorder.enabled).toBe(false);

    recorder.record({
      kind: "run-end",
      workflow: "pipeline",
      runId: "r1",
      status: "done",
      durationMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      models: ["m"],
      steps: 1,
      parks: 0,
    });
    await recorder.flush();

    expect(await exists(join(scratch.home, "insights"))).toBe(false);
    const { events } = await readInsightsLedger(scratch.home);
    expect(events).toEqual([]);
  });

  /**
   * RED FIRST: a diagnostic that can throw is a diagnostic that can kill a
   * nine-stage run over a full disk. `record` returns void and swallows;
   * this proves the failure surfaces as ONE warning instead.
   */
  it("turns an unwritable ledger into one warning, never a throw", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    // A FILE where the insights directory should be: `mkdir` cannot win.
    await writeFile(join(scratch.home, "insights"), "not a directory\n", "utf8");
    const warnings: string[] = [];
    const recorder = createInsightsRecorder({
      home: scratch.home,
      onWarn: (message) => warnings.push(message),
    });

    expect(() => {
      recorder.record({
        kind: "silent-turn",
        model: "m",
        nudged: false,
        origin: "main",
      });
      recorder.record({
        kind: "silent-turn",
        model: "m",
        nudged: false,
        origin: "main",
      });
    }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("insights ledger could not be written");
    expect(warnings[0]).toContain('"insights": false');
  });
});

// ===========================================================================
// 2. what a step actually did, and the write lane's mid-run check
// ===========================================================================

describe("step activity is counts and tool names, rendered for a human", () => {
  /**
   * RED FIRST: the park for the eighty-turn builder said "hit its 80-turn
   * ceiling" and nothing else. This is the line that says what those turns
   * went on.
   */
  it("names the busiest tools and says plainly that nothing was written", () => {
    expect(
      describeActivity({ turns: 80, toolCalls: { bash: 77, read: 17, grep: 1 }, writes: 0 }),
    ).toBe("activity: 80 turns · bash 77 · read 17 · grep 1 · no file written");
  });

  it("summarises past the sixth tool, and counts writes when there were any", () => {
    expect(
      describeActivity({
        turns: 9,
        toolCalls: { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3, h: 2 },
        writes: 3,
      }),
    ).toBe("activity: 9 turns · a 9 · b 8 · c 7 · d 6 · e 5 · f 4 · +2 more · 3 writes");
    expect(describeActivity({ turns: 1, toolCalls: {}, writes: 0 })).toBe(
      "activity: 1 turn · no tool call · no file written",
    );
  });

  /**
   * RED FIRST: `stepFailAskFacts` folds a line straight off disk, and a
   * hand-edited (or torn) line reaching a renderer once took `/workflow
   * status` down for every run on the machine. `writes` is recomputed rather
   * than trusted, so a line cannot claim files it never wrote.
   */
  it("validates an activity record off disk, recomputing writes rather than trusting them", () => {
    expect(activityFacts(undefined)).toBeUndefined();
    expect(activityFacts({ toolCalls: {} })).toBeUndefined();
    expect(activityFacts({ turns: -1, toolCalls: {} })).toBeUndefined();
    expect(
      activityFacts({
        turns: 4.7,
        toolCalls: { read: 2, bogus: "many", empty: 0, edit: 1 },
        writes: 999,
      }),
    ).toEqual({ turns: 4, toolCalls: { read: 2, edit: 1 }, writes: 1 });
  });
});

describe("the write lane's mid-run progress check", () => {
  const reading = { bash: 40, read: 12 };

  /**
   * RED FIRST: nothing looked at a running step's shape. Every guard rail
   * fired only after the money was gone.
   */
  it("fires on the halfway turn, and on that turn only", () => {
    expect(writeLaneProgressCheck({ turnIndex: 39, maxTurns: 80, toolCalls: reading })).toBe(
      undefined,
    );
    const notice = writeLaneProgressCheck({ turnIndex: 40, maxTurns: 80, toolCalls: reading });
    expect(notice).toContain("Progress check: 40 of 80 turns are spent");
    expect(notice).toContain("no file has been changed");
    expect(notice).toContain("write-lane step");
    // Once per run: the loop dedupes by exact text, and this message names the
    // turn, so firing again would say something new every remaining turn.
    expect(writeLaneProgressCheck({ turnIndex: 41, maxTurns: 80, toolCalls: reading })).toBe(
      undefined,
    );
  });

  it("never fires once a file has been authored", () => {
    for (const tool of ["write", "edit", "multiedit"]) {
      expect(
        writeLaneProgressCheck({
          turnIndex: 40,
          maxTurns: 80,
          toolCalls: { ...reading, [tool]: 1 },
        }),
      ).toBeUndefined();
    }
  });
});

// ===========================================================================
// 3. a real run
// ===========================================================================

describe("a real parked run writes its own autopsy to the ledger", () => {
  /**
   * RED FIRST: this is the run that motivated the whole module. Stage 2 went
   * silent twice, the run parked, and the only record of *which model* went
   * quiet *on which step* was a person reading session JSONL. Every assertion
   * below is a fact that existed nowhere before.
   */
  itPosix("records the silences, the terminal, the park and the run's end", async () => {
    const scratch = await gitScratch();
    const llm = fakeLLM([
      // Stage 1, the surveyor: a real file and a real report.
      {
        toolCalls: [
          { id: "s1", name: "write", arguments: { path: "SURVEY.md", content: "the survey\n" } },
        ],
      },
      { text: "survey done" },
      // Stage 2, the architect: THE VOID, twice — the loop hands a silent turn
      // back once before accepting it.
      { text: "" },
      { text: "" },
    ]);
    const runtime = await runtimeWith(scratch, llm);
    expect(runtime.insights.enabled).toBe(true);

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
        "3. @builder build, following the ADR {{prev}}",
        "",
      ].join("\n"),
    );
    const runId = "run-ledger";
    const journalDir = join(scratch.home, "ledger-journal");
    const result = await runWorkflow(workflow, {
      resolveAgent: resolve,
      agentNames: () => ["surveyor", "architect", "builder"],
      journal: createFileRunJournal(journalDir),
      runId,
      insights: runtime.insights,
      runStep: createRuntimeRunStep(runtime, {
        resolveAgent: resolve,
        writeLane: laneFor(runtime, runId),
        insights: { recorder: runtime.insights, workflow: workflow.name, runId },
      }),
    });
    expect(result.status).toBe("paused");
    await runtime.insights.flush();

    const { events, skippedLines } = await readInsightsLedger(scratch.home);
    expect(skippedLines).toBe(0);

    // ---- the silences: twice, nudged then accepted, attributed to the step.
    const silences = events.filter((e): e is SilentTurnRecord => e.kind === "silent-turn");
    expect(silences).toHaveLength(2);
    for (const silence of silences) {
      expect(silence.origin).toBe("workflow");
      expect(silence.workflow).toBe("pipeline");
      expect(silence.runId).toBe(runId);
      expect(silence.stepId).toBe("2");
      expect(silence.role).toBe("architect");
      expect(silence.model).not.toBe("");
    }
    expect(silences.map((s) => s.nudged)).toEqual([true, false]);

    // ---- the terminals: BOTH steps, not only the failed one.
    const terminals = events.filter((e): e is StepEndRecord => e.kind === "step-end");
    expect(terminals.map((step) => [step.stepId, step.status])).toEqual([
      ["1", "done"],
      ["2", "failed"],
    ]);
    const failed = terminals[1];
    expect(failed?.runId).toBe(runId);
    expect(failed?.role).toBe("architect");
    expect(failed?.lastTurn?.stopReason).toBe("endTurn");
    expect(Object.keys(failed?.lastTurn ?? {})).toEqual(["model", "stopReason", "blocks"]);
    expect(failed?.activity?.writes).toBe(0);
    // The surveyor's terminal proves the "every step, not only failures" rule.
    expect(terminals[0]?.activity?.toolCalls.write).toBe(1);
    expect(terminals[0]?.activity?.writes).toBe(1);

    // ---- the park, bucketed by what actually happened rather than by a kind.
    const parks = events.filter((e): e is ParkRecord => e.kind === "park");
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({
      workflow: "pipeline",
      runId,
      stepId: "2",
      role: "architect",
      causeKind: "produced-nothing",
    });
    expect(parks[0]?.activity?.writes).toBe(0);

    // ---- the run's own end.
    const runEnds = events.filter((e): e is RunEndRecord => e.kind === "run-end");
    expect(runEnds).toHaveLength(1);
    expect(runEnds[0]).toMatchObject({
      workflow: "pipeline",
      runId,
      status: "paused",
      // Two steps reached a terminal; the third was skipped and is not counted.
      steps: 2,
      parks: 1,
    });
    expect(runEnds[0]?.models).toEqual([silences[0]?.model]);
    expect(runEnds[0]?.durationMs).toBeGreaterThanOrEqual(0);

    // ---- and the whole ledger holds no prompt, no output and no path.
    const raw = await readFile(insightsFile(scratch.home), "utf8");
    expect(raw).not.toContain("SURVEY.md");
    expect(raw).not.toContain("rag-architecture");
    expect(raw).not.toContain("survey done");
    expect(raw).not.toContain(scratch.cwd);
  });

  /**
   * RED FIRST: the park line said what the model emitted on its LAST turn and
   * nothing about the eighty before it. A step that read twice and then went
   * quiet is a different fault from one that never called a tool at all.
   */
  itPosix("puts the step's activity on the durable park line", async () => {
    const scratch = await gitScratch();
    const llm = fakeLLM([
      { toolCalls: [{ id: "a", name: "read", arguments: { path: "seed.txt" } }] },
      { toolCalls: [{ id: "b", name: "read", arguments: { path: "seed.txt" } }] },
      { text: "" },
      { text: "" },
    ]);
    const runtime = await runtimeWith(scratch, llm);
    const architect = role("architect", ["read", "write", "edit"]);
    const workflow = parseOk("---\nname: pipeline\n---\n1. @architect write the ADR\n");
    const runId = "run-activity";
    const journalDir = join(scratch.home, "activity-journal");

    await runWorkflow(workflow, {
      resolveAgent: () => architect,
      agentNames: () => ["architect"],
      journal: createFileRunJournal(journalDir),
      runId,
      insights: runtime.insights,
      runStep: createRuntimeRunStep(runtime, {
        resolveAgent: () => architect,
        writeLane: laneFor(runtime, runId),
        insights: { recorder: runtime.insights, workflow: workflow.name, runId },
      }),
    });

    const lines = await readJournalLines(journalDir);
    const ask = lines.find(
      (line): line is Extract<JournalLine, { kind: "stepFailAsk" }> => line.kind === "stepFailAsk",
    );
    // Two reads, four turns (two tool turns plus the silence and its nudge),
    // and no file written — the whole diagnosis, on the line a human reads.
    expect(ask?.activity).toEqual({ turns: 4, toolCalls: { read: 2 }, writes: 0 });
    expect(describeActivity(ask?.activity ?? { turns: 0, toolCalls: {}, writes: 0 })).toBe(
      "activity: 4 turns · read 2 · no file written",
    );
    const stepEnd = lines.find(
      (line): line is Extract<JournalLine, { kind: "stepEnd" }> => line.kind === "stepEnd",
    );
    expect(stepEnd?.activity).toEqual(ask?.activity);
  });
});

describe("a write-lane role that is only reading is told so, while it can still act", () => {
  /** A builder that never stops reading — the shape of the run this exists for. */
  const readForever = (): FakeLLM =>
    fakeLLM([{ toolCalls: [{ id: "c", name: "read", arguments: { path: "seed.txt" } }] }]);

  /**
   * RED FIRST: nothing spoke to a running step. The nudge has to arrive as the
   * last thing the model reads before its next turn, or it is advice delivered
   * after the deadline.
   */
  itPosix("sends the nudge as the last user message at the halfway turn", async () => {
    const scratch = await gitScratch();
    const llm = readForever();
    const runtime = await runtimeWith(scratch, llm);
    const builder = role("builder", ["read", "write", "edit"], { maxTurns: 6 });
    const workflow = parseOk("---\nname: wf\n---\n1. @builder ship the change\n");

    await createRuntimeRunStep(runtime, {
      resolveAgent: () => builder,
      writeLane: laneFor(runtime, "run-progress"),
      insights: { recorder: runtime.insights, workflow: "wf", runId: "run-progress" },
    })(firstRequest(workflow));
    await runtime.insights.flush();

    expect(llm.requests).toHaveLength(6);
    // Half of six is three: turns 0-2 are the role's own business.
    expect(lastMessageText(llm.requests[2]!)).not.toContain("Progress check:");
    expect(lastMessageText(llm.requests[3]!)).toContain(
      "Progress check: 3 of 6 turns are spent and no file has been changed",
    );
    // Once per run: the message stays in the conversation for the remaining
    // turns (requests 3, 4 and 5 all carry it), but it is only ever SENT once.
    const carried = llm.requests.filter((request) =>
      request.messages.some((message) => contentText(message.content).includes("Progress check:")),
    );
    expect(carried).toHaveLength(3);
    expect(
      llm.requests
        .flatMap((request) => request.messages.map((m) => contentText(m.content)))
        .filter((text) => text.startsWith("Progress check:")).length,
    ).toBeGreaterThan(0);
    expect(
      new Set(
        llm.requests
          .flatMap((request) => request.messages.map((m) => contentText(m.content)))
          .filter((text) => text.startsWith("Progress check:")),
      ).size,
    ).toBe(1);

    // …and it lands in the ledger, attributed to the step, with no message text.
    const { events } = await readInsightsLedger(scratch.home);
    const warnings = events.filter(
      (e): e is ProgressWarningRecord => e.kind === "progress-warning",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      turnIndex: 3,
      origin: "workflow",
      workflow: "wf",
      runId: "run-progress",
      stepId: "1",
      role: "builder",
    });
    expect(JSON.stringify(warnings[0])).not.toContain("Progress check");
  });

  /**
   * The control. Without it "the pipeline warned" could be satisfied by a
   * check that warns every write-lane role, which would train people to ignore
   * it exactly like the ceiling warning it is modelled on.
   */
  itPosix("never warns a role that has already written something", async () => {
    const scratch = await gitScratch();
    const llm = fakeLLM([
      { toolCalls: [{ id: "r", name: "read", arguments: { path: "seed.txt" } }] },
      {
        toolCalls: [
          { id: "w", name: "write", arguments: { path: "OUT.md", content: "first section\n" } },
        ],
      },
      { toolCalls: [{ id: "r2", name: "read", arguments: { path: "seed.txt" } }] },
    ]);
    const runtime = await runtimeWith(scratch, llm);
    const builder = role("builder", ["read", "write", "edit"], { maxTurns: 6 });
    const workflow = parseOk("---\nname: wf\n---\n1. @builder ship the change\n");

    await createRuntimeRunStep(runtime, {
      resolveAgent: () => builder,
      writeLane: laneFor(runtime, "run-wrote"),
      insights: { recorder: runtime.insights, workflow: "wf", runId: "run-wrote" },
    })(firstRequest(workflow));
    await runtime.insights.flush();

    expect(llm.requests).toHaveLength(6);
    for (const request of llm.requests) {
      for (const message of request.messages) {
        expect(contentText(message.content)).not.toContain("Progress check:");
      }
    }
    const { events } = await readInsightsLedger(scratch.home);
    expect(events.filter((e) => e.kind === "progress-warning")).toHaveLength(0);
  });
});

// ===========================================================================
// 4. the command
// ===========================================================================

const BASE_TS = 1_700_000_000_000;
const DAY = 86_400_000;

function usage(
  input: number,
  output: number,
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * A hand-written ledger with one of everything the report reads.
 *
 * Written as literal lines rather than through the recorder: the aggregate
 * must fold what is ON DISK, including lines written by an older build.
 */
function fixtureEvents(): InsightsEvent[] {
  const e = (ts: number, body: Omit<InsightsEvent, "v" | "ts">): InsightsEvent =>
    ({ v: 1, ts, ...body }) as InsightsEvent;
  return [
    // --- silences: two on one model, one on another.
    e(BASE_TS + 1, {
      kind: "silent-turn",
      model: "zai/glm-5.3",
      nudged: true,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
    } as Omit<SilentTurnRecord, "v" | "ts">),
    e(BASE_TS + 2, {
      kind: "silent-turn",
      model: "zai/glm-5.3",
      nudged: false,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r2",
      stepId: "2",
      role: "architect",
    } as Omit<SilentTurnRecord, "v" | "ts">),
    e(BASE_TS + 3, {
      kind: "silent-turn",
      model: "anthropic/claude-sonnet-4-5",
      nudged: true,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r3",
      stepId: "5",
      role: "builder",
    } as Omit<SilentTurnRecord, "v" | "ts">),
    // --- terminals.
    e(BASE_TS + 10, {
      kind: "step-end",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
      status: "done",
      durationMs: 4000,
      usage: usage(10, 5),
      attempts: 2,
    } as Omit<StepEndRecord, "v" | "ts">),
    e(BASE_TS + 11, {
      kind: "step-end",
      workflow: "pipeline",
      runId: "r2",
      stepId: "2",
      role: "architect",
      status: "failed",
      durationMs: 6000,
      usage: usage(10, 5),
      attempts: 1,
    } as Omit<StepEndRecord, "v" | "ts">),
    e(BASE_TS + 12, {
      kind: "step-end",
      workflow: "pipeline",
      runId: "r3",
      stepId: "2",
      role: "architect",
      status: "failed",
      failureKind: "agent-error",
      durationMs: 2000,
      usage: usage(10, 5),
      attempts: 1,
    } as Omit<StepEndRecord, "v" | "ts">),
    e(BASE_TS + 13, {
      kind: "step-end",
      workflow: "pipeline",
      runId: "r3",
      stepId: "5",
      role: "builder",
      status: "failed",
      failureKind: "turn-ceiling",
      durationMs: 8000,
      usage: usage(10, 5),
      attempts: 1,
      activity: { turns: 80, toolCalls: { bash: 77 }, writes: 0 },
    } as Omit<StepEndRecord, "v" | "ts">),
    e(BASE_TS + 14, {
      kind: "step-end",
      workflow: "pipeline",
      runId: "r1",
      stepId: "5",
      role: "builder",
      status: "done",
      durationMs: 1000,
      usage: usage(10, 5),
      attempts: 1,
    } as Omit<StepEndRecord, "v" | "ts">),
    // --- parks: three on one step, one on another workflow.
    e(BASE_TS + 20, {
      kind: "park",
      workflow: "pipeline",
      runId: "r1",
      stepId: "2",
      role: "architect",
      attempts: 1,
      causeKind: "produced-nothing",
    } as Omit<ParkRecord, "v" | "ts">),
    e(BASE_TS + 21, {
      kind: "park",
      workflow: "pipeline",
      runId: "r2",
      stepId: "2",
      role: "architect",
      attempts: 1,
      causeKind: "produced-nothing",
    } as Omit<ParkRecord, "v" | "ts">),
    e(BASE_TS + 22, {
      kind: "park",
      workflow: "pipeline",
      runId: "r3",
      stepId: "2",
      role: "architect",
      failureKind: "agent-error",
      attempts: 2,
      causeKind: "agent-error",
    } as Omit<ParkRecord, "v" | "ts">),
    e(BASE_TS + 23, {
      kind: "park",
      workflow: "nightly",
      runId: "r4",
      stepId: "9",
      role: "auditor",
      attempts: 1,
      causeKind: "timeout",
    } as Omit<ParkRecord, "v" | "ts">),
    // --- a budget checkpoint and a progress warning.
    e(BASE_TS + 30, {
      kind: "budget-ask",
      workflow: "pipeline",
      runId: "r2",
      ceiling: "usd",
      spent: 0.82,
      limit: 1,
    } as Omit<BudgetAskRecordAlias, "v" | "ts">),
    e(BASE_TS + 31, {
      kind: "progress-warning",
      turnIndex: 40,
      origin: "workflow",
      workflow: "pipeline",
      runId: "r3",
      stepId: "5",
      role: "builder",
    } as Omit<ProgressWarningRecord, "v" | "ts">),
    // --- run terminals.
    e(BASE_TS + 40, {
      kind: "run-end",
      workflow: "pipeline",
      runId: "r1",
      status: "done",
      durationMs: 1000,
      usage: usage(100, 50),
      costUsd: 0.1,
      models: ["zai/glm-5.3"],
      steps: 2,
      parks: 1,
    } as Omit<RunEndRecord, "v" | "ts">),
    e(BASE_TS + 41, {
      kind: "run-end",
      workflow: "pipeline",
      runId: "r2",
      status: "paused",
      stopReason: "cost-ceiling",
      durationMs: 3000,
      usage: usage(100, 50),
      costUsd: 0.2,
      models: ["zai/glm-5.3"],
      steps: 2,
      parks: 1,
    } as Omit<RunEndRecord, "v" | "ts">),
    e(BASE_TS + 42, {
      kind: "run-end",
      workflow: "pipeline",
      runId: "r3",
      status: "failed",
      durationMs: 5000,
      usage: usage(100, 50),
      models: ["anthropic/claude-sonnet-4-5"],
      steps: 2,
      parks: 1,
    } as Omit<RunEndRecord, "v" | "ts">),
    // --- an OLD run, five weeks back: inside `--since all`, outside `7d`.
    e(BASE_TS - 35 * DAY, {
      kind: "run-end",
      workflow: "nightly",
      runId: "r4",
      status: "failed",
      durationMs: 9000,
      usage: usage(10, 10),
      costUsd: 0.05,
      models: ["zai/glm-5.3"],
      steps: 1,
      parks: 1,
    } as Omit<RunEndRecord, "v" | "ts">),
  ];
}

/** Alias so the fixture can name the budget record without importing it twice. */
type BudgetAskRecordAlias = Extract<InsightsEvent, { kind: "budget-ask" }>;

/** Write a ledger, one JSON object per line, plus any raw lines given. */
async function writeLedger(
  home: string,
  events: readonly InsightsEvent[],
  extraLines: readonly string[] = [],
): Promise<void> {
  await mkdir(join(home, "insights"), { recursive: true });
  const body = [...events.map((event) => JSON.stringify(event)), ...extraLines].join("\n");
  await writeFile(insightsFile(home), `${body}\n`, "utf8");
}

describe("the aggregate answers the questions a person was reading JSONL to answer", () => {
  const all = () => aggregateInsights(fixtureEvents(), { window: resolveWindow("all") });

  /**
   * RED FIRST: there was no aggregate. Each of these numbers was previously a
   * `grep | wc -l` somebody ran by hand, once, and then lost.
   */
  it("counts runs by status, with a median duration and an honest spend", () => {
    const report = all();
    expect(report.runs.total).toBe(4);
    expect(report.runs.byStatus).toEqual({ done: 1, paused: 1, failed: 2 });
    // [1000, 3000, 5000, 9000] -> the mean of the two middle values.
    expect(report.runs.medianDurationMs).toBe(4000);
    expect(report.runs.costUsd).toBeCloseTo(0.35, 10);
    // One run had no priced cost, so the total is declared a lower bound.
    expect(report.runs.costKnown).toBe(false);
    expect(report.runs.tokens).toBe(470);
  });

  it("groups parks by workflow, step and role, with the dominant cause and the silent share", () => {
    const report = all();
    expect(report.parks).toEqual([
      {
        workflow: "pipeline",
        stepId: "2",
        role: "architect",
        count: 3,
        causeKind: "produced-nothing",
        producedNothing: 2,
        // Both produced-nothing parks had a silence recorded on the same
        // run+step; the agent-error park is not counted here at all.
        producedNothingSilent: 2,
      },
      {
        workflow: "nightly",
        stepId: "9",
        role: "auditor",
        count: 1,
        causeKind: "timeout",
        producedNothing: 0,
        producedNothingSilent: 0,
      },
    ]);
  });

  it("scores each model's silences by whether the nudge recovered the step", () => {
    const report = all();
    expect(report.silentTurns).toEqual([
      {
        model: "zai/glm-5.3",
        count: 2,
        // Only the first was nudged; the second was the accepted silence.
        nudged: 1,
        judged: 1,
        recovered: 1,
        recoveryRate: 1,
      },
      {
        model: "anthropic/claude-sonnet-4-5",
        count: 1,
        nudged: 1,
        judged: 1,
        recovered: 0,
        recoveryRate: 0,
      },
    ]);
  });

  it("ranks failure kinds, and only names a role once it has enough steps to mean it", () => {
    const report = all();
    expect(report.stepFailures.byFailureKind).toEqual([
      { failureKind: "agent-error", count: 1 },
      { failureKind: "turn-ceiling", count: 1 },
    ]);
    // @builder failed once in two steps — a 50% rate on a sample of two, which
    // is exactly the number this filter exists to keep out of the report.
    expect(report.stepFailures.byRole).toEqual([
      { role: "architect", steps: 3, failed: 2, rate: 2 / 3 },
    ]);
  });

  it("ranks roles by their median step, not their worst one", () => {
    const report = all();
    expect(report.slowestRoles).toEqual([
      // [8000, 1000] -> 4500 beats architect's [4000, 6000, 2000] -> 4000.
      { role: "builder", steps: 2, medianDurationMs: 4500 },
      { role: "architect", steps: 3, medianDurationMs: 4000 },
    ]);
  });

  it("counts the progress warnings by role", () => {
    expect(all().progressWarnings).toEqual({
      total: 1,
      byRole: [{ role: "builder", count: 1 }],
    });
  });

  /**
   * RED FIRST: without a window every report is "since you installed it",
   * which is the report nobody can act on.
   */
  it("drops everything outside the window", () => {
    const report = aggregateInsights(fixtureEvents(), {
      window: resolveWindow("7d", BASE_TS + 1000),
    });
    expect(report.runs.total).toBe(3);
    expect(report.runs.byStatus).toEqual({ done: 1, paused: 1, failed: 1 });
    expect(report.runs.medianDurationMs).toBe(3000);
  });

  /**
   * RED FIRST: the filter has to apply BEFORE the correlations, or a
   * `--workflow` view credits one pipeline's recovery to another's step.
   */
  it("keeps one workflow, correlations included", () => {
    const report = aggregateInsights(fixtureEvents(), {
      window: resolveWindow("all"),
      workflow: "nightly",
    });
    expect(report.workflow).toBe("nightly");
    expect(report.runs.total).toBe(1);
    expect(report.parks.map((group) => group.workflow)).toEqual(["nightly"]);
    // The pipeline's silences are outside the filter, so nothing is scored.
    expect(report.silentTurns).toEqual([]);
    expect(report.slowestRoles).toEqual([]);
  });
});

describe("parkCauseKind buckets a failure into something a person can act on", () => {
  /**
   * RED FIRST: the void gate reclassifies a `done` step AFTER the lane
   * returned, so it attaches no `failureKind` at all — bucketing on the kind
   * alone files every produced-nothing park under "other", which is the exact
   * fault this whole module exists to surface.
   */
  it("reads the empty-step cause even though the void gate leaves no failure kind", () => {
    expect(
      parkCauseKind(
        undefined,
        "step 2 (@architect) produced nothing — no file was changed and no text was returned.",
      ),
    ).toBe("produced-nothing");
  });

  it("maps the real failure kinds, and refuses to guess at the rest", () => {
    expect(parkCauseKind("turn-ceiling", "ran out of turns")).toBe("turn-ceiling");
    expect(parkCauseKind("timeout", "deadline")).toBe("timeout");
    expect(parkCauseKind("patch-refused", "git apply refused")).toBe("patch-refused");
    expect(parkCauseKind("agent-error", "boom")).toBe("agent-error");
    expect(parkCauseKind("config", "no lane")).toBe("agent-error");
    expect(parkCauseKind("rateLimit", "429")).toBe("network");
    expect(parkCauseKind("network", "socket")).toBe("network");
    expect(parkCauseKind("git-lock", "index.lock")).toBe("other");
    expect(parkCauseKind(undefined, "something else entirely")).toBe("other");
  });
});

describe("arcturn insights", () => {
  /** Run the command against a home seeded with `events`. */
  async function runOver(
    events: readonly InsightsEvent[],
    options: Parameters<typeof runInsightsCommand>[0] = {},
    extraLines: readonly string[] = [],
  ): Promise<{ code: number; out: string; err: string }> {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    await writeLedger(scratch.home, events, extraLines);
    let out = "";
    let err = "";
    const code = await runInsightsCommand({
      home: scratch.home,
      env: {},
      now: BASE_TS + 1000,
      since: "all",
      stdout: (chunk) => {
        out += chunk;
      },
      stderr: (chunk) => {
        err += chunk;
      },
      ...options,
    });
    return { code, out, err };
  }

  /**
   * RED FIRST: there was no command. This is the output a person gets instead
   * of opening a session file.
   */
  it("prints every section, in order, and exits 0", async () => {
    const { code, out } = await runOver(fixtureEvents());
    expect(code).toBe(0);
    const sections = out
      .split("\n")
      .filter((line) => /^[A-Z]/.test(line))
      .map((line) => line.split(" (")[0]?.split(" —")[0]);
    expect(sections).toEqual([
      "Insights",
      "Runs",
      "Parks",
      "Progress warnings",
      "Silent turns",
      "Step failures",
      "Slowest roles",
    ]);
    expect(out).toContain("pipeline");
    expect(out).toContain("produced-nothing");
    expect(out).toContain("2/2 silent");
    expect(out).toContain("@architect");
  });

  it("says so plainly, and still exits 0, when there is nothing recorded", async () => {
    const { code, out } = await runOver([]);
    expect(code).toBe(0);
    expect(out).toContain("Nothing recorded in this window");
    expect(out).not.toContain("Runs (");
  });

  /**
   * RED FIRST: a torn final append is normal for a file being written live. A
   * reader that throws on it makes the command useless exactly while a run is
   * in flight — so bad lines are skipped, and SAID.
   */
  it("skips unreadable lines, counts them, and reports the count", async () => {
    const { code, out } = await runOver(fixtureEvents(), {}, [
      "{not json",
      '{"kind":"unknown-kind","ts":1}',
      '{"kind":"run-end"}',
    ]);
    expect(code).toBe(0);
    expect(out).toContain("3 unreadable lines skipped");
    // …and the good lines still produced a full report.
    expect(out).toContain("Runs (4)");
  });

  it("reads both generations, so a rotation does not lose last week", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    await mkdir(join(scratch.home, "insights"), { recursive: true });
    const events = fixtureEvents();
    await writeFile(
      insightsRotatedFile(scratch.home),
      `${events
        .slice(0, 3)
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
      "utf8",
    );
    await writeFile(
      insightsFile(scratch.home),
      `${events
        .slice(3)
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
      "utf8",
    );
    const ledger = await readInsightsLedger(scratch.home);
    expect(ledger.events).toHaveLength(events.length);
    expect(ledger.events[0]?.kind).toBe("silent-turn");
  });

  it("prints the aggregate as one JSON object under --json", async () => {
    const { code, out } = await runOver(fixtureEvents(), { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as ReturnType<typeof aggregateInsights>;
    expect(Object.keys(parsed)).toEqual([
      "window",
      "events",
      "skippedLines",
      "runs",
      "parks",
      "progressWarnings",
      "silentTurns",
      "stepFailures",
      "slowestRoles",
    ]);
    expect(parsed.runs.total).toBe(4);
    expect(parsed.silentTurns[0]?.recoveryRate).toBe(1);
  });

  it("narrows to one workflow", async () => {
    const { out } = await runOver(fixtureEvents(), { workflow: "nightly", json: true });
    const parsed = JSON.parse(out) as ReturnType<typeof aggregateInsights>;
    expect(parsed.workflow).toBe("nightly");
    expect(parsed.runs.total).toBe(1);
  });

  /**
   * RED FIRST: an unreadable ledger is the ONE case worth a non-zero exit — a
   * missing one is not, and neither is a bad line. Getting that wrong makes
   * the command unusable in a CI step that runs it opportunistically.
   */
  it("exits 1 only when the ledger cannot be read at all", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    // A DIRECTORY where the ledger should be.
    await mkdir(insightsFile(scratch.home), { recursive: true });
    let err = "";
    const code = await runInsightsCommand({
      home: scratch.home,
      env: {},
      stdout: () => undefined,
      stderr: (chunk) => {
        err += chunk;
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("could not read");
  });

  it("exits 2 on a malformed window, naming the shapes it accepts", async () => {
    const { code, err } = await runOver(fixtureEvents(), { since: "last tuesday" });
    expect(code).toBe(2);
    expect(err).toContain("Invalid --since");
  });
});

describe("--share prints a report and a link, and sends nothing", () => {
  /**
   * RED FIRST: the only way to hand a maintainer this data was to paste a
   * session file, which is exactly the thing nobody can share.
   */
  it("carries the privacy statement, the block and a well-formed issue URL", async () => {
    const report = aggregateInsights(fixtureEvents(), { window: resolveWindow("all") });
    const lines = renderInsightsShare(report);
    const text = lines.join("\n");

    expect(text).toContain(INSIGHTS_PRIVACY_STATEMENT);
    expect(text).toContain("Nothing was sent.");
    expect(text).toContain("Arcturn insights");

    const url = lines.at(-1) ?? "";
    expect(url.startsWith("https://github.com/sitharaj88/arcturn/issues/new?title=")).toBe(true);
    expect(url).toContain("&body=");
    expect(Buffer.byteLength(url, "utf8")).toBeLessThanOrEqual(SHARE_URL_MAX_BYTES);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toContain("insights:");
    expect(parsed.searchParams.get("body")).toContain(INSIGHTS_PRIVACY_STATEMENT);
  });

  /**
   * RED FIRST: a URL a browser silently clips is worse than a short one that
   * says it was clipped, and a busy machine's report is long.
   */
  it("truncates a large report rather than emitting a URL nothing can open", () => {
    // Two hundred distinct park buckets: far more than 8 KB of report.
    const many: InsightsEvent[] = Array.from({ length: 200 }, (_, i) => ({
      v: 1,
      ts: BASE_TS + i,
      kind: "park",
      workflow: `workflow-number-${i}`,
      runId: `run-${i}`,
      stepId: String(i),
      role: `role-with-a-long-name-${i}`,
      attempts: 1,
      causeKind: "produced-nothing",
    }));
    const report = aggregateInsights(many, { window: resolveWindow("all") });
    const lines = renderInsightsShare(report);
    const url = lines.at(-1) ?? "";

    expect(Buffer.byteLength(url, "utf8")).toBeLessThanOrEqual(SHARE_URL_MAX_BYTES);
    expect(decodeURIComponent(new URL(url).searchParams.get("body") ?? "")).toContain(
      "(truncated)",
    );
    // The printed block itself is NOT truncated — only the link is.
    expect(lines.join("\n")).toContain("workflow-number-199");
  });
});

describe("the argument parser is shared by the verb and the slash command", () => {
  it("understands both spellings of every flag", () => {
    expect(parseInsightsArgs(["--since", "30d", "--workflow", "pipeline", "--json"])).toEqual({
      since: "30d",
      workflow: "pipeline",
      json: true,
      share: false,
    });
    expect(parseInsightsArgs(["--since=all", "--workflow=nightly", "--share"])).toEqual({
      since: "all",
      workflow: "nightly",
      json: false,
      share: true,
    });
    expect(parseInsightsArgs([])).toEqual({ json: false, share: false });
  });
});

describe("renderInsights omits what it has nothing to say about", () => {
  it("prints only the sections with data", () => {
    const onlyRuns = aggregateInsights(
      fixtureEvents().filter((event) => event.kind === "run-end"),
      { window: resolveWindow("all") },
    );
    const text = renderInsights(onlyRuns).join("\n");
    expect(text).toContain("Runs (4)");
    expect(text).not.toContain("Parks");
    expect(text).not.toContain("Silent turns");
    expect(text).not.toContain("Step failures");
    expect(text).not.toContain("Slowest roles");
  });
});
