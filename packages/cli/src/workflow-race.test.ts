/**
 * MODEL RACING, proved on effects.
 *
 * Two halves, and the second is the one that matters. The first drives the
 * pure reducer (`runStepRace`) with scripted arms: who wins, whose abort
 * signal actually fired, what happens when nobody clears the gate. The second
 * drives the REAL write lane over a real git repository with two models, and
 * asserts the only thing a race must never get wrong — that exactly one
 * model's work reached the user's checkout, and that the loser's work is on
 * disk, unapplied, where a person can read it.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LLMRequest, ModelSpec, Usage } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import type { ArcturnRuntime } from "./runtime.js";
import { type FakeLLM, respondingLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  createRuntimeRunStep,
  createRuntimeWriteLane,
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WriteLaneHost,
} from "./workflow.js";
import {
  describeRace,
  type RaceApplyClaim,
  type RaceVerdict,
  raceSummaryFacts,
  runStepRace,
} from "./workflow-race.js";
import { createFileRunJournal, type JournalLine, readJournalLines } from "./workflow-run.js";
import { foldJournal, formatRunDetail } from "./workflow-status.js";

const execFileAsync = promisify(execFile);
const itPosix = it.skipIf(process.platform === "win32");
const roots: string[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose?.();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// --------------------------------------------------------------- the reducer

/** A minimal outcome shape, so the reducer's tests need no engine at all. */
interface FakeOutcome {
  readonly label: string;
  readonly verdict: RaceVerdict;
  readonly usage: Usage;
}

function usage(output: number): Usage {
  return { inputTokens: 0, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
const emptyUsage = (): Usage => usage(0);

describe("runStepRace", () => {
  it("gives the win to the first arm that CLEARS the gate and aborts the rest", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let releaseA: (() => void) | undefined;
    const race = await runStepRace<FakeOutcome>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: (outcome) => outcome.usage,
      judge: (outcome) => outcome.verdict,
      runArm: async (arm, index, signal) => {
        signals[index] = signal;
        if (arm.model === "model-b") return { label: "b", verdict: "clears", usage: usage(5) };
        // A never settles on its own: it settles only once the race has cut it,
        // which is what proves the abort actually reached it.
        await new Promise<void>((resolve) => {
          releaseA = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { label: "a", verdict: "failed", usage: usage(3) };
      },
    });
    releaseA?.();

    expect(race.winner?.arm.model).toBe("model-b");
    expect(race.summary.winner).toBe("model-b");
    // THE EFFECT: arm A's own signal fired, so a real agent on it would have
    // been told to stop rather than being left running.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(race.summary.losers).toEqual([
      { model: "model-a", outcome: "aborted", durationMs: expect.any(Number) },
    ]);
    // Every arm's spend is billed, not just the winner's.
    expect(race.usage.outputTokens).toBe(8);
  });

  it("passes over a fast arm that fails its contract and lets the slower one win", async () => {
    const race = await runStepRace<FakeOutcome>({
      arms: [
        { tag: "quick", model: "model-quick" },
        { tag: "careful", model: "model-careful" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: (outcome) => outcome.usage,
      // The gate stands in for `extractContractJson` + `validateContract`.
      judge: (outcome) => outcome.verdict,
      runArm: async (arm) => {
        if (arm.model === "model-quick") {
          return { label: "quick", verdict: "failed", usage: usage(1) };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { label: "careful", verdict: "clears", usage: usage(2) };
      },
    });
    expect(race.winner?.arm.model).toBe("model-careful");
    // The fast arm settled on its own, so it is a genuine failure, not an abort.
    expect(race.summary.losers[0]).toMatchObject({ model: "model-quick", outcome: "failed" });
  });

  it("surfaces the LAST arm to settle when no arm clears, so retry sees one failure", async () => {
    const race = await runStepRace<FakeOutcome>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: (outcome) => outcome.usage,
      judge: (outcome) => outcome.verdict,
      runArm: async (arm) => {
        if (arm.model === "model-a") return { label: "a", verdict: "void", usage: usage(1) };
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { label: "b", verdict: "failed", usage: usage(1) };
      },
    });
    expect(race.winner).toBeUndefined();
    expect(race.fallback.arm.model).toBe("model-b");
    expect(race.summary.winner).toBe("model-b");
    expect(race.summary.losers[0]).toMatchObject({ model: "model-a", outcome: "void" });
  });

  it("labels an arm that cleared the gate a moment too late as slower", async () => {
    const race = await runStepRace<FakeOutcome>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: (outcome) => outcome.usage,
      judge: (outcome) => outcome.verdict,
      // Both settle immediately and both clear: the first one the race observes
      // wins and the other is `slower`, never `aborted` — nobody cut it off.
      runArm: async (arm) => ({ label: arm.model, verdict: "clears", usage: usage(1) }),
    });
    expect(race.summary.winner).toBe("model-a");
    expect(race.summary.losers[0]).toMatchObject({ model: "model-b", outcome: "slower" });
  });

  it("reports the running total across every arm as each one spends", async () => {
    const totals: number[] = [];
    await runStepRace<FakeOutcome>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: (outcome) => outcome.usage,
      judge: () => "clears",
      onUsage: (total) => totals.push(total.outputTokens),
      runArm: async (arm, _index, _signal, onUsage) => {
        onUsage(usage(arm.model === "model-a" ? 10 : 4));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { label: arm.model, verdict: "clears", usage: usage(1) };
      },
    });
    // The last total a budget guard sees is both arms' spend, not one arm's.
    expect(totals.at(-1)).toBe(14);
  });

  it("stops every arm when the step's own signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: boolean[] = [];
    const race = await runStepRace<FakeOutcome>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: controller.signal,
      addUsage,
      emptyUsage,
      usageOf: (outcome) => outcome.usage,
      judge: (outcome) => outcome.verdict,
      runArm: async (arm, index, signal) => {
        seen[index] = signal.aborted;
        return { label: arm.model, verdict: "failed", usage: usage(0) };
      },
    });
    expect(seen).toEqual([true, true]);
    expect(race.winner).toBeUndefined();
  });
});

describe("describeRace / raceSummaryFacts", () => {
  it("renders the status line an operator reads", () => {
    expect(
      describeRace(
        {
          models: ["glm-5.3-flash", "glm-5.3"],
          winner: "glm-5.3-flash",
          losers: [{ model: "glm-5.3", outcome: "aborted", durationMs: 12_000 }],
        },
        41_000,
      ),
    ).toBe("glm-5.3-flash won in 41s · glm-5.3 aborted");
  });

  it("drops a torn block rather than half-rendering it", () => {
    expect(raceSummaryFacts({ winner: "x" })).toBeUndefined();
    expect(raceSummaryFacts(undefined)).toBeUndefined();
    expect(
      raceSummaryFacts({
        models: ["a", "b"],
        winner: "a",
        losers: [{ model: "b", outcome: "nope" }],
      }),
    ).toEqual({ models: ["a", "b"], winner: "a", losers: [] });
  });
});

// ------------------------------------------------------- the real write lane

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

/** A model spec the fake client will echo back on `request.model.id`. */
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

const FAST = "test/fast";
const SLOW = "test/slow";

function builderRole(): AgentDef {
  return {
    name: "builder",
    description: "writes files",
    systemPrompt: "You write files.",
    tools: ["read", "write", "edit"],
    source: "<test>",
  };
}

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "race-wf", source: "/tmp/race-wf.md" });
  if (isWorkflowParseError(parsed)) throw new Error(parsed.error);
  return parsed;
}

/**
 * One model per arm: the fast one writes `from-fast.txt` and answers at once,
 * the slow one writes `from-slow.txt` and dawdles on every turn.
 */
function racingModel(): FakeLLM {
  return respondingLLM((request: LLMRequest) => {
    const slow = request.model.id === SLOW;
    if (request.messages.at(-1)?.role === "toolResult") {
      // The slow model dawdles only AFTER it has written, so its arm really
      // does have work in flight when the race cuts it off — which is the
      // state the "loser's patch is preserved" assertion is about.
      return { text: `done on ${request.model.id}`, ...(slow ? { delayMs: 300 } : {}) };
    }
    return {
      toolCalls: [
        {
          id: `call-${slow ? "slow" : "fast"}`,
          name: "write",
          arguments: {
            path: slow ? "from-slow.txt" : "from-fast.txt",
            content: `${request.model.id}\n`,
          },
        },
      ],
    };
  });
}

async function racingRun(): Promise<{
  scratch: Scratch;
  runDir: string;
  lines: JournalLine[];
}> {
  const scratch = await gitScratch();
  const runtime = await buildTestRuntime(scratch, [], {
    llm: racingModel(),
    permissionMode: "yolo",
  });
  runtimes.push(runtime);
  const roles = new Map([["builder", builderRole()]]);
  const workflow = parseOk(
    ["---", "name: race-wf", "description: d", "---", "1. [race:fast|slow] @builder go"].join("\n"),
  );
  const runId = "race-run";
  const runDir = join(scratch.home, "workflow-runs", runId);
  const resolveModel = (tag: string): ModelSpec | undefined =>
    tag === "fast" ? spec(FAST) : tag === "slow" ? spec(SLOW) : undefined;
  await runWorkflow(workflow, {
    input: "",
    runId,
    resolveAgent: (name) => roles.get(name),
    agentNames: () => [...roles.keys()],
    resolveModel,
    journal: createFileRunJournal(runDir),
    ...(runtime.insights === undefined ? {} : { insights: runtime.insights }),
    runStep: createRuntimeRunStep(runtime, {
      resolveAgent: (name) => roles.get(name),
      agentNames: () => [...roles.keys()],
      resolveModel,
      writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId),
      ...(runtime.insights === undefined
        ? {}
        : { insights: { recorder: runtime.insights, workflow: workflow.name, runId } }),
    }),
  });
  // `runEnd` is appended fire-and-forget; wait for it before reading.
  for (let i = 0; i < 100; i += 1) {
    const lines = await readJournalLines(runDir);
    if (lines.some((line) => line.kind === "runEnd")) return { scratch, runDir, lines };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the raced run never recorded a terminal runEnd");
}

describe("a raced step over the real write lane", () => {
  itPosix(
    "applies only the winner's patch and keeps the loser's on disk, unapplied",
    async () => {
      const { scratch, runDir, lines } = await racingRun();

      // THE EFFECT, in the user's own checkout: the winner's file is there and
      // the loser's is not — one race, one patch, whatever the models did.
      const checkout = await readdir(scratch.cwd);
      expect(checkout).toContain("from-fast.txt");
      expect(checkout).not.toContain("from-slow.txt");
      expect(await readFile(join(scratch.cwd, "from-fast.txt"), "utf8")).toBe(`${FAST}\n`);

      // …and the loser's work is not lost: its patch is on disk in the run's
      // own directory, naming the file it would have written.
      const artifacts = await readdir(runDir);
      const patches = artifacts.filter((name) => name.endsWith(".patch"));
      expect(patches.length).toBeGreaterThanOrEqual(2);
      const bodies = await Promise.all(
        patches.map(async (name) => await readFile(join(runDir, name), "utf8")),
      );
      expect(bodies.some((body) => body.includes("from-slow.txt"))).toBe(true);
      expect(bodies.some((body) => body.includes("from-fast.txt"))).toBe(true);

      // ONE terminal for the step, carrying the whole race.
      const terminal = lines.findLast(
        (line): line is Extract<JournalLine, { kind: "stepEnd" }> =>
          line.kind === "stepEnd" && line.id === "1",
      );
      expect(terminal?.status).toBe("done");
      expect(terminal?.race).toEqual({
        models: [FAST, SLOW],
        winner: FAST,
        losers: [{ model: SLOW, outcome: "aborted", durationMs: expect.any(Number) }],
      });
      // The winner's bill is the step's; the race's bill is everyone's.
      expect(terminal?.raceUsage?.outputTokens ?? 0).toBeGreaterThan(
        terminal?.usage.outputTokens ?? 0,
      );

      // `/workflow status` says which model won, in one line.
      const detail = formatRunDetail(foldJournal("race-run", lines), Date.now()).join("\n");
      expect(detail).toContain(`race: ${FAST} won in`);
      expect(detail).toContain(`${SLOW} aborted`);
    },
    60_000,
  );

  itPosix(
    "records one insights terminal per arm — the winner won, the loser lost",
    async () => {
      const { scratch } = await racingRun();
      const ledger = join(scratch.home, "insights", "events.jsonl");
      const events = (await readFile(ledger, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "step-end" && event.stepId === "1");

      expect(events).toHaveLength(2);
      const won = events.find((event) => event.race === "won");
      const lost = events.find((event) => event.race === "lost");
      expect(won?.model).toBe(FAST);
      expect(won?.superseded).toBeUndefined();
      expect(lost?.model).toBe(SLOW);
      // A losing arm is `superseded`, so every table that counts steps counts
      // this step once rather than twice.
      expect(lost?.superseded).toBe(true);
      expect(typeof lost?.durationMs).toBe("number");
    },
    60_000,
  );
});

describe("a raced step whose models all fail", () => {
  itPosix(
    "surfaces one failure carrying every arm's complaint",
    async () => {
      const scratch = await gitScratch();
      const runtime = await buildTestRuntime(scratch, [], {
        llm: respondingLLM((request) => ({ error: `${request.model.id} is down` })),
        permissionMode: "yolo",
      });
      runtimes.push(runtime);
      const roles = new Map([["builder", builderRole()]]);
      const workflow = parseOk(
        ["---", "name: race-wf", "description: d", "---", "1. [race:fast|slow] @builder go"].join(
          "\n",
        ),
      );
      const runId = "race-fail";
      const resolveModel = (tag: string): ModelSpec | undefined =>
        tag === "fast" ? spec(FAST) : tag === "slow" ? spec(SLOW) : undefined;
      const result = await runWorkflow(workflow, {
        input: "",
        runId,
        resolveAgent: (name) => roles.get(name),
        agentNames: () => [...roles.keys()],
        resolveModel,
        journal: createFileRunJournal(join(scratch.home, "workflow-runs", runId)),
        retry: { maxRetries: 0 },
        runStep: createRuntimeRunStep(runtime, {
          resolveAgent: (name) => roles.get(name),
          agentNames: () => [...roles.keys()],
          resolveModel,
          writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, runId),
        }),
      });

      // The run stops for a human at the step-failure park, as any failed step
      // makes it; what matters here is the STEP, and that there is one of it.
      expect(result.status).toBe("paused");
      const step = result.steps[0];
      expect(step?.status).toBe("failed");
      // ONE failure, and it names what every arm did — nobody should have to
      // open three worktrees to learn that all three models fell over.
      expect(step?.error).toContain("Every arm of this race lost");
      expect(step?.error).toMatch(/test\/(fast|slow)/);
      expect(step?.race?.models).toEqual([FAST, SLOW]);
    },
    60_000,
  );

  itPosix("refuses a race whose tag is not a known model, before spending", async () => {
    const scratch = await gitScratch();
    const runtime = await buildTestRuntime(scratch, [], {
      llm: respondingLLM(() => ({ text: "never asked" })),
      permissionMode: "yolo",
    });
    runtimes.push(runtime);
    const roles = new Map([["builder", builderRole()]]);
    const workflow = parseOk(
      ["---", "name: race-wf", "description: d", "---", "1. [race:fast|nope] @builder go"].join(
        "\n",
      ),
    );
    const runStep = createRuntimeRunStep(runtime, {
      resolveAgent: (name) => roles.get(name),
      agentNames: () => [...roles.keys()],
      resolveModel: (tag) => (tag === "fast" ? spec(FAST) : undefined),
      writeLane: createRuntimeWriteLane(runtime as unknown as WriteLaneHost, "race-config"),
    });
    const step = workflow.stages[0]?.steps[0];
    if (step === undefined) throw new Error("no step");
    const outcome = await runStep({
      step,
      prompt: step.prompt,
      signal: new AbortController().signal,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.failureKind).toBe("config");
    expect(outcome.error).toContain('races model tag "nope"');
  });
});

// The read lane hands a model ID to `createSubagent`, which resolves it
// against the real catalog — so a read-lane race has to name real models. (The
// worktree lanes take the resolved spec straight from the tag resolver, which
// is why the tests above can invent one.)
const READ_FAST = "anthropic/claude-haiku-4-5";
const READ_SLOW = "anthropic/claude-sonnet-4-5";

describe("a contract-gated race", () => {
  itPosix(
    "passes over the fast arm whose reply misses the shape",
    async () => {
      const scratch = await gitScratch();
      const runtime = await buildTestRuntime(scratch, [], {
        llm: respondingLLM((request) => {
          const slow = request.model.id === READ_SLOW;
          return slow
            ? {
                text: 'here it is\n```json\n{"decision":"SHIP"}\n```',
                delayMs: 60,
              }
            : // Fast, and wrong: `decision` is declared as an enum of SHIP|HOLD,
              // so this reply is a valid json block that the contract refuses.
              { text: 'sure\n```json\n{"decision":"MAYBE"}\n```' };
        }),
        permissionMode: "yolo",
      });
      runtimes.push(runtime);
      const reviewer: AgentDef = {
        name: "reviewer",
        description: "reads",
        systemPrompt: "You review.",
        tools: ["read"],
        source: "<test>",
      };
      const workflow = parseOk(
        [
          "---",
          "name: race-wf",
          "description: d",
          "---",
          "1. [race:fast|slow] [contract:verdict] @reviewer judge it",
          "",
          "```contract verdict",
          "decision: SHIP | HOLD",
          "```",
        ].join("\n"),
      );
      const runStep = createRuntimeRunStep(runtime, {
        resolveAgent: () => reviewer,
        agentNames: () => ["reviewer"],
        resolveModel: (tag) =>
          tag === "fast" ? spec(READ_FAST) : tag === "slow" ? spec(READ_SLOW) : undefined,
        resolveContract: (name) => workflow.contracts.get(name),
      });
      const step = workflow.stages[0]?.steps[0];
      if (step === undefined) throw new Error("no step");
      const outcome = await runStep({
        step,
        prompt: step.prompt,
        signal: new AbortController().signal,
      });

      // The slower model won because it was the only one that answered the
      // question the contract actually asked.
      expect(outcome.error ?? "").toBe("");
      expect(outcome.isError).toBe(false);
      expect(outcome.race?.winner).toBe(READ_SLOW);
      expect(outcome.text).toContain('"decision":"SHIP"');
      expect(outcome.race?.losers[0]).toMatchObject({ model: READ_FAST, outcome: "failed" });
    },
    30_000,
  );
});

// ----------------------------------------------------------- the apply claim

describe("runStepRace — the apply claim", () => {
  /**
   * RED FIRST: the claim used to cut every sibling off the instant it was
   * GRANTED, one moment before the claimant's `git apply` ran. A claimant that
   * then failed to land — a refused patch, a lost lock, a crash in the
   * write-ahead — never released the claim, and the race ended with no winner
   * even though another arm was mid-flight with an answer that would have
   * cleared. `patch-refused` is deterministic, so the retry policy does not
   * re-run it: the run parked. It was the one place racing made a run LESS
   * likely to finish than not racing.
   */
  it("does not lose the whole race when the claiming arm fails after claiming", async () => {
    let claim: RaceApplyClaim | undefined;
    const took: number[] = [];
    const race = await runStepRace<{ ok: boolean }>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: () => usage(1),
      judge: (outcome) => (outcome.ok ? "clears" : "failed"),
      onClaim: (lever) => {
        claim = lever;
      },
      drainMs: 50,
      runArm: async (_arm, index, signal) => {
        if (index === 0) {
          // Takes the claim, then its own `git apply` is refused.
          if (claim?.take(0) === true) took.push(0);
          claim?.settle(0, false);
          return { ok: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (signal.aborted) return { ok: false };
        // The claim is free again, so this arm can land.
        if (claim?.take(1) !== true) return { ok: false };
        claim.settle(1, true);
        return { ok: true };
      },
    });
    expect(took).toEqual([0]);
    expect(race.winner?.arm.model).toBe("model-b");
    expect(race.summary.winner).toBe("model-b");
  });

  it("refuses a second claim while the first arm still holds it", async () => {
    let claim: RaceApplyClaim | undefined;
    const refused: number[] = [];
    await runStepRace<{ ok: boolean }>({
      arms: [
        { tag: "a", model: "model-a" },
        { tag: "b", model: "model-b" },
      ],
      signal: new AbortController().signal,
      addUsage,
      emptyUsage,
      usageOf: () => usage(1),
      judge: (outcome) => (outcome.ok ? "clears" : "failed"),
      onClaim: (lever) => {
        claim = lever;
      },
      drainMs: 50,
      runArm: async (_arm, index) => {
        if (index === 0) {
          claim?.take(0);
          // Held while the sibling tries: its patch landed, so nobody else may.
          await new Promise((resolve) => setTimeout(resolve, 20));
          claim?.settle(0, true);
          return { ok: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (claim?.take(1) === false) refused.push(1);
        return { ok: false };
      },
    });
    expect(refused).toEqual([1]);
  });
});

// ------------------------------------------------------------- what it costs

describe("a race's bill is every arm's", () => {
  /**
   * RED FIRST: `StepEndLine.raceUsage`'s own doc says it "is what the run was
   * actually billed, which is what a budget has to be judged against" — and
   * nothing read it. The run total was the WINNER's usage alone, so a 3-arm
   * race was reported (and judged against `budgetUsd:`) at about a third of
   * what it cost.
   */
  it("adds raceUsage, not just the winner's usage, to the run total", async () => {
    const wf = parseOk(
      ["---", "name: race-wf", "description: d", "---", "1. [race:a|b] write it", "2. finish"].join(
        "\n",
      ),
    );
    const result = await runWorkflow(wf, {
      resolveModel: (tag) => spec(tag),
      runStep: async (request) =>
        request.step.id === "1"
          ? {
              text: "done",
              usage: { ...usage(1), costUsd: 1 },
              isError: false,
              race: { models: ["a", "b"], winner: "a", losers: [] },
              raceUsage: { ...usage(9), costUsd: 9 },
            }
          : { text: "ok", usage: { ...usage(1), costUsd: 1 }, isError: false },
    });
    expect(result.status).toBe("done");
    // Winner $1 + losers $8 + step 2 $1 = $10.
    expect(result.usage.costUsd).toBe(10);
    // The STEP is still described by what the winner spent.
    expect(result.steps[0]?.usage.costUsd).toBe(1);
  });

  it("stops the run when the WHOLE race crosses budgetUsd", async () => {
    const wf = parseOk(
      [
        "---",
        "name: race-wf",
        "description: d",
        "budgetUsd: 3",
        "---",
        "1. [race:a|b] write it",
        "2. finish",
      ].join("\n"),
    );
    const ran: string[] = [];
    const result = await runWorkflow(wf, {
      resolveModel: (tag) => spec(tag),
      runStep: async (request) => {
        ran.push(request.step.id);
        return request.step.id === "1"
          ? {
              text: "done",
              usage: { ...usage(1), costUsd: 1 },
              isError: false,
              race: { models: ["a", "b"], winner: "a", losers: [] },
              raceUsage: { ...usage(9), costUsd: 9 },
            }
          : { text: "ok", usage: { ...usage(1), costUsd: 1 }, isError: false };
      },
    });
    // $9 against a $3 ceiling, so stage 2 is never dispatched.
    expect(ran).toEqual(["1"]);
    expect(result.status).not.toBe("done");
  });

  it("stops the run when the whole race crosses budgetTokens", async () => {
    const wf = parseOk(
      [
        "---",
        "name: race-wf",
        "description: d",
        "budgetTokens: 5",
        "---",
        "1. [race:a|b] write it",
        "2. finish",
      ].join("\n"),
    );
    const ran: string[] = [];
    await runWorkflow(wf, {
      resolveModel: (tag) => spec(tag),
      runStep: async (request) => {
        ran.push(request.step.id);
        return request.step.id === "1"
          ? {
              text: "done",
              usage: usage(1),
              isError: false,
              race: { models: ["a", "b"], winner: "a", losers: [] },
              raceUsage: usage(9),
            }
          : { text: "ok", usage: usage(1), isError: false };
      },
    });
    expect(ran).toEqual(["1"]);
  });
});
