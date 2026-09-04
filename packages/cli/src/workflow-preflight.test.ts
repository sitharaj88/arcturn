/**
 * PRE-FLIGHT REFUSALS, proved through the real `/workflow` slash command under
 * `-p` — the surface a person and a CI job actually meet them on.
 *
 * A pre-flight refusal is the engine saying "this file cannot work" before a
 * single token is spent. Three of them shipped composing a precise message and
 * then throwing `ReferenceError: Cannot access 'stopReason' before
 * initialization` on the way out, because `finish` — which every early return
 * goes through — closed over a `let` declared hundreds of lines below it, still
 * in its temporal dead zone at pre-flight time. The refusal was replaced by a
 * generic crash, which is the one outcome nobody can act on.
 *
 * So this suite asserts the whole contract of a refusal, on effects only:
 * the exact message on stderr, exit code 1, no step ever dispatched (zero
 * tokens), and the journal it leaves — a run that failed at pre-flight, header
 * and all, with no `stepStart`/`stepEnd` on it.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelSpec } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import { CommandRegistry } from "./commands.js";
import { PRINT_EXIT, runPrint } from "./print.js";
import type { ArcturnRuntime } from "./runtime.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  createWorkflowCommands,
  isWorkflowParseError,
  parseWorkflow,
  type Workflow,
} from "./workflow.js";
import type { JournalLine } from "./workflow-run.js";

const roots: string[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose?.();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const FENCE = "```";

function parseOk(raw: string, name: string): Workflow {
  const parsed = parseWorkflow(raw, { name, source: `/tmp/${name}.md` });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow, got: ${parsed.error}`);
  return parsed;
}

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

/** A writer and a reader, so the write-lane refusal has both sides to pick from. */
const ROLES = new Map<string, AgentDef>([
  [
    "builder",
    {
      name: "builder",
      description: "writes",
      systemPrompt: "You write files.",
      tools: ["read", "write", "edit", "bash"],
      source: "<test>",
    },
  ],
  [
    "judge",
    {
      name: "judge",
      description: "reads",
      systemPrompt: "You judge.",
      tools: ["read"],
      source: "<test>",
    },
  ],
]);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (chunk: string) => void out.push(chunk),
    stderr: (chunk: string) => void err.push(chunk),
    stdoutText: () => out.join(""),
    stderrText: () => err.join(""),
  };
}

/** Every run directory the command minted under this home, newest last. */
async function runDirs(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "workflow-runs"))).sort();
  } catch {
    return [];
  }
}

async function journalOf(home: string, runId: string): Promise<JournalLine[]> {
  const raw = await readFile(join(home, "workflow-runs", runId, "journal.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as JournalLine);
}

/**
 * Wait for the run's terminal line: `finish` fires the `runEnd` append and
 * does not await it, so the assertion has to wait for the effect rather than
 * assume a machine speed.
 */
async function waitForRunEnd(home: string, runId: string): Promise<JournalLine[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const lines = await journalOf(home, runId);
      if (lines.some((line) => line.kind === "runEnd")) return lines;
    } catch {
      // The directory is minted by the first append; keep waiting for it.
    }
    if (Date.now() >= deadline) throw new Error(`run ${runId} never recorded a runEnd`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Drive one `/workflow <name>` through `runPrint`, exactly as `arcturn -p`
 * does, and report everything a refusal is judged on.
 *
 * `dispatched` counts step dispatches: a pre-flight refusal must leave it at
 * zero, which is what "spends no tokens" means in an assertion.
 */
async function runHeadless(
  source: string,
  name: string,
): Promise<{
  exitCode: number;
  stderr: string;
  dispatched: number;
  home: string;
  runIds: string[];
}> {
  const scratch: Scratch = await makeScratch();
  roots.push(scratch.root);
  const runtime = await buildTestRuntime(scratch, [{ text: "should never run" }], {
    permissionMode: "yolo",
  });
  runtimes.push(runtime);
  let dispatched = 0;
  const [command] = createWorkflowCommands({
    discover: async () => [parseOk(source, name)],
    agents: () => ROLES,
    // Only `known` resolves, so a race naming anything else has an arm the
    // pre-flight cannot resolve.
    resolveModelTag: (tag) => (tag === "known" ? spec("anthropic/claude-haiku-4-5") : undefined),
    step: {
      runStep: async (request) => {
        dispatched += 1;
        return {
          id: request.step.id,
          stageIndex: request.step.stageIndex,
          branchIndex: request.step.branchIndex,
          prompt: request.prompt,
          status: "done",
          text: "dispatched",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    } as never,
  });
  if (!command) throw new Error("no /workflow command");
  const registry = new CommandRegistry();
  registry.registerAll([command]);
  const sink = capture();
  const result = await runPrint({
    runtime,
    prompt: `/workflow ${name}`,
    commands: registry,
    ...sink,
  });
  return {
    exitCode: result.exitCode,
    stderr: sink.stderrText(),
    dispatched,
    home: scratch.home,
    runIds: await runDirs(scratch.home),
  };
}

/**
 * The shared half of all three assertions: the refusal is journalled as a run
 * that failed at pre-flight — one directory, a readable header naming the
 * workflow, a `failed` terminal, and NOTHING between them.
 *
 * This is the deliberate half of the fix. `finish` has always written a
 * `runEnd`, so a refusal has always minted a directory; the choice was never
 * "directory or no directory" but "a readable failed run or an orphan
 * terminal", and an unknown `[tag]` — the oldest refusal in the engine —
 * already behaved this way. So every pre-flight refusal now leaves the same
 * shape, and `/workflow status <id>` can name what was refused.
 */
async function expectPreflightJournal(home: string, runIds: string[], name: string): Promise<void> {
  expect(runIds).toHaveLength(1);
  const runId = runIds[0] as string;
  const lines = await waitForRunEnd(home, runId);
  const header = lines.find(
    (line): line is Extract<JournalLine, { kind: "run" }> => line.kind === "run",
  );
  expect(header?.workflow).toBe(name);
  expect(lines.filter((line) => line.kind === "runEnd")).toEqual([
    { kind: "runEnd", status: "failed", ts: expect.any(Number) },
  ]);
  // Zero tokens, said in the journal's own words: nothing was ever started.
  expect(lines.some((line) => line.kind === "stepStart" || line.kind === "stepEnd")).toBe(false);
  expect(lines.some((line) => line.kind === "stageStart")).toBe(false);
}

describe("pre-flight refusals under -p", () => {
  it("refuses a judged step whose role can write, by name", async () => {
    const source = [
      "---",
      "name: p-writejudges",
      "description: d",
      "---",
      "1. [judges:2] [contract:verdict] @builder Decide something.",
      "",
      `${FENCE}contract verdict`,
      "decision: SHIP | DO-NOT-SHIP",
      FENCE,
    ].join("\n");

    const run = await runHeadless(source, "p-writejudges");

    expect(run.stderr).toContain('step 1: judges requires a read-only role; "builder" can write');
    // The crash this suite exists for must never come back.
    expect(run.stderr).not.toContain("before initialization");
    expect(run.exitCode).toBe(PRINT_EXIT.error);
    expect(run.dispatched).toBe(0);
    await expectPreflightJournal(run.home, run.runIds, "p-writejudges");
  }, 30_000);

  it("refuses a judged step whose contract has nothing to compare", async () => {
    const source = [
      "---",
      "name: p-noenum",
      "description: d",
      "---",
      "1. [judges:2] [contract:plain] @judge Decide something.",
      "",
      `${FENCE}contract plain`,
      "note: string",
      "confidence: number",
      FENCE,
    ].join("\n");

    const run = await runHeadless(source, "p-noenum");

    expect(run.stderr).toContain("step 1: judges needs a contract with an enum field to compare");
    expect(run.stderr).not.toContain("before initialization");
    expect(run.exitCode).toBe(PRINT_EXIT.error);
    expect(run.dispatched).toBe(0);
    await expectPreflightJournal(run.home, run.runIds, "p-noenum");
  }, 30_000);

  it("refuses a race whose second arm names a model that does not resolve", async () => {
    const source = [
      "---",
      "name: p-badrace",
      "description: d",
      "---",
      "1. [race:known|nope] @builder Add a comment.",
    ].join("\n");

    const run = await runHeadless(source, "p-badrace");

    expect(run.stderr).toContain('step 1: unknown model tag "nope" in race');
    expect(run.stderr).not.toContain("before initialization");
    expect(run.exitCode).toBe(PRINT_EXIT.error);
    expect(run.dispatched).toBe(0);
    await expectPreflightJournal(run.home, run.runIds, "p-badrace");
  }, 30_000);
});
