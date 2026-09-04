/**
 * REFUSED TOOL CALLS, counted and said out loud.
 *
 * The silence this suite exists for: under `-p` the default permission mode
 * has nobody to ask, so every `bash` call a write-lane role makes is denied.
 * The role reads the files back instead and asserts, in prose, that the
 * command it never ran would have passed — and the step reports `done`. A
 * `ship`-style pipeline whose correctness gate is "run the tests and make them
 * pass" therefore shipped false confidence, and the only trace was one stderr
 * line per denied subject in a busy run.
 *
 * So the assertions here are on what a person actually sees: the step's own
 * line in the run report, the closing notice naming the flag that would have
 * let the calls through, `/workflow status`'s activity line, and the counts on
 * the journal terminal the ledger copies.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import { CommandRegistry } from "./commands.js";
import { runPrint } from "./print.js";
import type { ArcturnRuntime } from "./runtime.js";
import { respondingLLM } from "./test-helpers/fake-llm.js";
import { buildTestRuntime, makeScratch, type Scratch } from "./test-helpers/scratch.js";
import {
  createRuntimeWriteLane,
  createWorkflowCommands,
  isWorkflowParseError,
  parseWorkflow,
  type Workflow,
  type WriteLaneHost,
} from "./workflow.js";
import { activityFacts, type JournalLine, readJournalLines } from "./workflow-run.js";
import { foldJournal, formatRunDetail } from "./workflow-status.js";

const execFileAsync = promisify(execFile);
const itPosix = it.skipIf(process.platform === "win32");
const roots: string[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose?.();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const ROLES = new Map<string, AgentDef>([
  [
    "builder",
    {
      name: "builder",
      description: "writes and runs the tests",
      systemPrompt: "You write files and verify them.",
      tools: ["read", "write", "bash"],
      source: "<test>",
    },
  ],
]);

const SOURCE = [
  "---",
  "name: verified",
  "description: d",
  "---",
  "1. @builder write it, then run `node --test` and make it pass",
].join("\n");

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "verified", source: "/tmp/verified.md" });
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

/**
 * The role writes its file, then tries to verify it twice with the shell —
 * exactly the shape the evaluation ran into. The writes land (the lane's own
 * worktree allows authoring); the two `bash` calls do not.
 */
function verifyingModel() {
  return respondingLLM((request) => {
    const turn = request.messages.filter((message) => message.role === "toolResult").length;
    if (turn === 0) {
      return {
        toolCalls: [
          { id: "w1", name: "write", arguments: { path: "built.txt", content: "built\n" } },
        ],
      };
    }
    if (turn === 1) {
      return { toolCalls: [{ id: "b1", name: "bash", arguments: { command: "node --test" } }] };
    }
    if (turn === 2) {
      return { toolCalls: [{ id: "b2", name: "bash", arguments: { command: "node --test" } }] };
    }
    return { text: "The tests should pass." };
  });
}

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

describe("a step whose tool calls the permission mode refused", () => {
  itPosix(
    "counts them, marks the step, and closes the run with the flag that would have allowed them",
    async () => {
      const scratch = await gitScratch();
      const runtime = await buildTestRuntime(scratch, [], {
        llm: verifyingModel(),
        // The mode the evaluation ran under, and the whole point: `default`
        // has nobody to ask in a headless run, so it denies.
        permissionMode: "default",
      });
      runtimes.push(runtime);
      const [command] = createWorkflowCommands({
        discover: async () => [parseOk(SOURCE)],
        agents: () => ROLES,
        writeLane: (host, runId) => createRuntimeWriteLane(host as unknown as WriteLaneHost, runId),
      });
      if (!command) throw new Error("no /workflow command");
      const registry = new CommandRegistry();
      registry.registerAll([command]);
      const sink = capture();

      await runPrint({ runtime, prompt: "/workflow verified", commands: registry, ...sink });

      const stdout = sink.stdoutText();
      const stderr = sink.stderrText();

      // THE STEP'S OWN LINE says the calls were blocked, beside the `done`
      // that used to be the whole story.
      expect(stdout).toContain("[2 tool call(s) denied]");
      // THE CLOSING NOTICE names the count and the lever, once for the run.
      expect(stderr).toContain(
        "arcturn: 2 tool call(s) were denied by the permission mode; run with " +
          "--permission-mode acceptEdits or yolo, or add rules to allow them.",
      );

      // THE JOURNAL carries the count, so `/workflow status` and the insights
      // ledger can both read it back long after the terminal has scrolled.
      const runsRoot = join(scratch.home, "workflow-runs");
      const runId = (await readdir(runsRoot))[0];
      if (runId === undefined) throw new Error("no run directory");
      const lines = await readJournalLines(join(runsRoot, runId));
      const terminal = lines.find(
        (line): line is Extract<JournalLine, { kind: "stepEnd" }> => line.kind === "stepEnd",
      );
      expect(terminal?.activity?.denied).toBe(2);
      // The counts survive the off-disk validator, so a reader trusts them.
      expect(activityFacts(terminal?.activity)?.denied).toBe(2);

      // …and `/workflow status <id>` prints the activity line for exactly this
      // case, where `done` is not the whole truth.
      const raw = await readFile(join(runsRoot, runId, "journal.jsonl"), "utf8");
      const run = foldJournal(
        runId,
        raw
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as JournalLine),
      );
      const detail = formatRunDetail(run).join("\n");
      expect(detail).toContain("2 denied");
      expect(detail).toMatch(/activity: \d+ turns .*2 denied/);
    },
    120_000,
  );

  itPosix(
    "says nothing at all when the mode allowed every call",
    async () => {
      // The control. A notice that fires on a clean run is noise, and noise is
      // how the real one gets ignored.
      const scratch = await gitScratch();
      const runtime = await buildTestRuntime(scratch, [], {
        llm: verifyingModel(),
        permissionMode: "yolo",
      });
      runtimes.push(runtime);
      const [command] = createWorkflowCommands({
        discover: async () => [parseOk(SOURCE)],
        agents: () => ROLES,
        writeLane: (host, runId) => createRuntimeWriteLane(host as unknown as WriteLaneHost, runId),
      });
      if (!command) throw new Error("no /workflow command");
      const registry = new CommandRegistry();
      registry.registerAll([command]);
      const sink = capture();

      await runPrint({ runtime, prompt: "/workflow verified", commands: registry, ...sink });

      expect(sink.stdoutText()).not.toContain("tool call(s) denied");
      expect(sink.stderrText()).not.toContain("were denied by the permission mode");
    },
    120_000,
  );
});
