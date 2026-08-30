/**
 * READ SIDE of the run journal — `/workflow status`.
 *
 * EVERY FIXTURE IN THIS FILE IS ENGINE OUTPUT. The journals below are produced
 * by driving the real {@link runWorkflow} through {@link engineJournal}, never
 * hand-written, because hand-written ones are how this feature shipped blank:
 * the old tests fed the fold `budget{spentUsd, turns}` lines that the engine
 * had no code to emit — it wrote `{usage}` alone — so the reader's suite went
 * green while the spend column an operator uses to catch a runaway was
 * permanently empty in production. A reader test whose input the writer cannot
 * produce proves nothing about the feature; it validates a fiction.
 *
 * Where a test needs a *truncated* journal (a run still going, or one a crash
 * cut short), it cuts real engine output at the point the crash would have cut
 * it, rather than inventing lines.
 */

import type { Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import {
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type WorkflowRetryPolicy,
  type WorkflowStepOutcome,
  type WorkflowStepRequest,
} from "./workflow.js";
import type { JournalLine } from "./workflow-run.js";
import {
  deriveRunState,
  foldJournal,
  formatRunDetail,
  formatRunsTable,
  summariseRun,
} from "./workflow-status.js";

const STEP_TIMEOUT = 600_000;
/** The injected clock's starting instant; the run header records it. */
const START = 1000;

/** Frontmatter naming the workflow and pinning the step deadline. */
const FRONT = [
  "---",
  "name: ship-fix",
  "description: ship a fix",
  `stepTimeoutMs: ${STEP_TIMEOUT}`,
  "---",
].join("\n");

/** A role the engine will accept — it must declare its tools to be dispatched. */
function role(name: string): AgentDef {
  return {
    name,
    description: `${name} role`,
    systemPrompt: `You are the ${name}.`,
    tools: ["read"],
    source: `/roles/${name}.md`,
  };
}

/** Raw token counts, as a runner reports them. */
function usage(output: number, costUsd?: number): Usage {
  return {
    inputTokens: 10,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * Report `turns` model turns, then settle — exactly the shape `driveAgent`
 * produces on a real lane (one progressive `onUsage` per `turnEnd`, then the
 * final outcome). This is what makes the engine's `budget` line carry a real
 * turn count instead of a number a fixture made up.
 */
function spendTurns(
  request: WorkflowStepRequest,
  turns: number,
  perTurnUsd: number,
  outputTokens: number,
): WorkflowStepOutcome {
  for (let turn = 1; turn <= turns; turn += 1) {
    request.onUsage?.(usage(Math.round((outputTokens * turn) / turns), perTurnUsd * turn));
  }
  return {
    text: `out-${request.step.id}`,
    usage: usage(outputTokens, perTurnUsd * turns),
    isError: false,
  };
}

/**
 * Drive the REAL engine over an injected clock and hand back the journal it
 * actually wrote — the only fixture source this file uses.
 *
 * @param options.source - The workflow file.
 * @param options.runStep - The step runner (its clock advances per step).
 * @param options.runId - The run directory id.
 * @param options.retry - Retry policy, for the flapping-step fixtures.
 */
async function engineJournal(options: {
  source: string;
  runStep: (request: WorkflowStepRequest) => Promise<WorkflowStepOutcome>;
  runId?: string;
  retry?: WorkflowRetryPolicy;
}): Promise<JournalLine[]> {
  const parsed = parseWorkflow(options.source, { name: "wf" });
  if (isWorkflowParseError(parsed)) throw new Error(`bad fixture workflow: ${parsed.error}`);
  const lines: JournalLine[] = [];
  let clock = START;
  await runWorkflow(parsed, {
    runId: options.runId ?? "run-A",
    journal: { append: async (line) => void lines.push(line) },
    now: () => clock,
    resolveAgent: (name) => role(name),
    agentNames: () => [],
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    runStep: async (request) => {
      clock += 100; // wall clock moves while the step runs
      const outcome = await options.runStep(request);
      clock += 100;
      return outcome;
    },
  });
  return lines;
}

/** Cut an engine journal where a live read (or a crash) would cut it. */
function upToAndIncluding(
  lines: readonly JournalLine[],
  stop: (line: JournalLine) => boolean,
): JournalLine[] {
  const index = lines.findIndex(stop);
  if (index === -1) throw new Error("fixture: no line matched the cut point");
  return lines.slice(0, index + 1);
}

/** The newest `ts`-bearing line's timestamp, for staleness assertions. */
function lastTs(lines: readonly JournalLine[]): number {
  const line = lines.at(-1) as { ts?: number; endedAt?: number } | undefined;
  const ts = line?.ts ?? line?.endedAt;
  if (ts === undefined) throw new Error("fixture: last line carries no timestamp");
  return ts;
}

const fastRetry: WorkflowRetryPolicy = {
  maxRetries: 2,
  sleep: async () => {},
  computeDelay: () => 0,
};

describe("foldJournal + formatRunsTable", () => {
  it("renders a status table from a real run's journal — a done stage and a running one", async () => {
    const lines = await engineJournal({
      source: [
        FRONT,
        "1. @architect design it",
        "2. Build:",
        "   - @developer patch it {{prev}}",
        "   - @reviewer read it {{prev}}",
      ].join("\n"),
      // The architect burns six turns at 7¢ each: $0.42 of real, engine-priced
      // spend reaching the journal through the production emission path.
      runStep: async (request) => spendTurns(request, 6, 0.07, 400),
    });
    // Read the run mid-flight: stage 2's first step has started and nothing
    // more has been written yet.
    const live = upToAndIncluding(lines, (line) => line.kind === "stepStart" && line.id === "2.1");

    const run = foldJournal("run-A", live);
    // Fold correctness.
    expect(run.workflow).toBe("ship-fix");
    expect(run.startedAt).toBe(START);
    expect(run.stages).toHaveLength(2);
    expect(run.stages[0]?.status).toBe("done");
    expect(run.stages[0]?.steps[0]?.status).toBe("done");
    expect(run.stages[1]?.steps[0]?.status).toBe("running");
    expect(run.lastWriteTs).toBe(lastTs(live));

    // THE POINT OF THIS FILE: spend and turns come from the engine, not a
    // fixture. Before the fix these were `undefined` for every real run.
    expect(run.spentUsd).toBeCloseTo(0.42, 10);
    expect(run.turns).toBe(6);

    const summary = summariseRun(run, (run.lastWriteTs ?? 0) + 100);
    expect(summary.state).toBe("running");
    expect(summary.stepsDone).toBe(1);
    expect(summary.stepsTotal).toBe(2);
    expect(summary.stage).toBe(2);
    expect(summary.spentUsd).toBeCloseTo(0.42, 10);

    const table = formatRunsTable([run], (run.lastWriteTs ?? 0) + 100).join("\n");
    expect(table).toContain("run-A");
    expect(table).toContain("ship-fix");
    expect(table).toContain("running");
    expect(table).toContain("stage 2/2");
    expect(table).toContain("1/2 steps");
    expect(table).toContain("$0.42");
    expect(table).toContain("6 turns");
  });

  it("counts a flapping step's whole spend, so the table cannot understate a retry", async () => {
    let attempt = 0;
    const lines = await engineJournal({
      source: [FRONT, "1. @developer patch it"].join("\n"),
      retry: fastRetry,
      runStep: async (request) => {
        attempt += 1;
        if (attempt === 1) {
          request.onUsage?.(usage(900, 1.5));
          return {
            text: "",
            usage: usage(900, 1.5),
            isError: true,
            error: "socket stalled",
            failureKind: "network",
          };
        }
        return spendTurns(request, 1, 0.25, 100);
      },
    });
    const run = foldJournal("run-flap", lines);
    // The blown attempt burned $1.50 before the healed one burned $0.25.
    // Reporting only the survivor would understate the expensive case.
    expect(run.spentUsd).toBeCloseTo(1.75, 10);
    expect(formatRunsTable([run], lastTs(lines)).join("\n")).toContain("$1.75");
  });

  it("renders no spend column for a run nothing could price (blank, not $0.00)", async () => {
    const lines = await engineJournal({
      // No `[tag]` model and a runner that reports raw tokens: there is no
      // price to be had. "$0.00" would read as "this run was free".
      source: [FRONT, "1. @architect design it"].join("\n"),
      runStep: async () => ({ text: "x", usage: usage(400), isError: false }),
    });
    const run = foldJournal("run-free", lines);
    expect(run.spentUsd).toBeUndefined();
    const table = formatRunsTable([run], lastTs(lines)).join("\n");
    expect(table).not.toContain("$");
    expect(table).not.toContain("turns");
    // Tokens are the one figure an unpriced run still reports — the same sum
    // a `budgetTokens:` ceiling compares against (10 input + 400 output).
    expect(run.spentTokens).toBe(410);
    expect(table).toContain("410 tok");
  });

  it("marks a run stalled when its open step went quiet past the step deadline", async () => {
    const lines = await engineJournal({
      source: [FRONT, "1. @developer patch it"].join("\n"),
      runStep: async (request) => spendTurns(request, 1, 0.1, 100),
    });
    // The crash: the process died with step 1 in flight, so its `stepStart` is
    // the last thing on disk.
    const killed = upToAndIncluding(lines, (line) => line.kind === "stepStart");
    const run = foldJournal("run-hung", killed);
    // The deadline the engine itself recorded in the run header is what
    // staleness is measured against.
    expect(run.stepTimeoutMs).toBe(STEP_TIMEOUT);

    const quiet = lastTs(killed);
    expect(deriveRunState(run, quiet + STEP_TIMEOUT + 1)).toBe("stalled");
    // Just after the last write it still reads as running.
    expect(deriveRunState(run, quiet + 100)).toBe("running");

    const table = formatRunsTable([run], quiet + STEP_TIMEOUT + 5000).join("\n");
    expect(table).toContain("stalled");
    expect(table).toContain("resume with /workflow resume run-hung");
  });

  it("marks a run resumable when it stopped cleanly at a stage boundary", async () => {
    const lines = await engineJournal({
      source: [FRONT, "1. @architect design it", "2. @developer patch it {{prev}}"].join("\n"),
      runStep: async (request) => spendTurns(request, 2, 0.05, 100),
    });
    // Killed between stages: stage 1 is committed, stage 2 never started.
    const cut = upToAndIncluding(lines, (line) => line.kind === "stageEnd");
    const run = foldJournal("run-crash", cut);
    expect(deriveRunState(run, lastTs(cut) + 9_000_000)).toBe("resumable");
    const table = formatRunsTable([run], lastTs(cut) + 9_000_000).join("\n");
    expect(table).toContain("resumable");
    // A resumable run still reports what the part that ran cost.
    expect(table).toContain("$0.10");
  });

  it("reports a finished run's runEnd status", async () => {
    const lines = await engineJournal({
      source: [FRONT, "1. @developer patch it"].join("\n"),
      runStep: async (request) => {
        request.onUsage?.(usage(9000, 10));
        return { text: "", usage: usage(9000, 10), isError: true, error: "it broke" };
      },
    });
    const run = foldJournal("run-cost", lines);
    expect(deriveRunState(run, lastTs(lines) + 500)).toBe("failed");
    const table = formatRunsTable([run], lastTs(lines) + 500).join("\n");
    expect(table).toContain("failed");
    // A failed run still spent money, and still says so.
    expect(table).toContain("$10.00");
    expect(table).toContain("1 turns");
  });

  it("renders a stop reason — reader tolerance for vocabulary no writer produces yet", async () => {
    // The engine now writes `stop` lines for its own ceilings (`cost-ceiling`
    // from `budgetUsd:`, `token-ceiling` from `budgetTokens:` — both proved
    // against real engine output in `orchestration-effects.test.ts` and the
    // token test below), but the rest of the `WorkflowStopReason` vocabulary
    // (`turn-ceiling`, `run-deadline`, …) still has no producer. This test
    // keeps the reader's promise for the whole vocabulary: it *tolerates and
    // renders* any stop line a future writer emits. The hand-appended line is
    // labelled rather than hidden precisely because an unlabelled one is what
    // let the spend column ship blank.
    const lines = await engineJournal({
      source: [FRONT, "1. @developer patch it"].join("\n"),
      runStep: async (request) => spendTurns(request, 1, 0.5, 100),
    });
    const withStop: JournalLine[] = [
      ...lines,
      { kind: "stop", reason: "cost-ceiling", ts: lastTs(lines) },
    ];
    const run = foldJournal("run-stopped", withStop);
    expect(run.stopReason).toBe("cost-ceiling");
    expect(formatRunsTable([run], lastTs(lines) + 100).join("\n")).toContain("stop: cost-ceiling");
  });

  it("folds and renders a token-ceiling stop, from real engine output on an unpriced run", async () => {
    // The engine's own `budgetTokens:` enforcement writes this stop line — no
    // hand-written fixture. The runner reports raw token counts and no price,
    // which is the run this ceiling exists for: stage 1 alone consumes 2,010
    // tokens (10 input + 2,000 output), exceeding the 1,000-token ceiling, so
    // stage 2 never starts.
    const lines = await engineJournal({
      source: [
        "---",
        "name: ship-fix",
        "description: ship a fix",
        `stepTimeoutMs: ${STEP_TIMEOUT}`,
        "budgetTokens: 1000",
        "---",
        "1. @architect design it",
        "2. @developer patch it {{prev}}",
      ].join("\n"),
      runStep: async () => ({ text: "x", usage: usage(2000), isError: false }),
    });

    const run = foldJournal("run-tokens", lines);
    expect(run.stopReason).toBe("token-ceiling");
    expect(run.spentTokens).toBe(2010);
    expect(run.spentUsd).toBeUndefined();

    const summary = summariseRun(run, lastTs(lines) + 100);
    expect(summary.stopReason).toBe("token-ceiling");
    expect(summary.spentTokens).toBe(2010);

    // Grouped like the ceiling's own abort message, so the operator compares
    // the two figures in one notation.
    const table = formatRunsTable([run], lastTs(lines) + 100).join("\n");
    expect(table).toContain("stop: token-ceiling");
    expect(table).toContain("2,010 tok");

    const detail = formatRunDetail(run, lastTs(lines) + 100).join("\n");
    expect(detail).toContain("stopped: token-ceiling");
    expect(detail).toContain("2,010 tokens");
  });

  it("prints a friendly note when no runs exist", () => {
    expect(formatRunsTable([], 0).join("\n")).toContain("No workflow runs recorded yet");
  });
});

describe("formatRunDetail", () => {
  it("renders one run's stage/step tree with patch records, retries and a resume hint", async () => {
    let developerAttempts = 0;
    const lines = await engineJournal({
      source: [FRONT, "1. Build:", "   - @developer patch it", "   - @reviewer read it"].join("\n"),
      retry: fastRetry,
      runStep: async (request) => {
        if (request.step.agent !== "developer") return spendTurns(request, 1, 0.05, 300);
        developerAttempts += 1;
        if (developerAttempts === 1) {
          return {
            text: "",
            usage: usage(200, 0.2),
            isError: true,
            error: "index.lock",
            failureKind: "git-lock",
          };
        }
        return {
          text: "patched",
          usage: usage(1000, 0.8),
          isError: false,
          record: { status: "applied", role: "developer", stepId: request.step.id, files: 3 },
        };
      },
    });
    // The crash: the developer's commit landed, then the process died — the
    // reviewer's terminal line and every roll-up after it never reached disk.
    const crashed = lines.filter(
      (line) =>
        !(line.kind === "stepEnd" && line.id === "1.2") &&
        line.kind !== "stageEnd" &&
        line.kind !== "budget" &&
        line.kind !== "runEnd",
    );

    const run = foldJournal("run-A", crashed);
    const detail = formatRunDetail(run, lastTs(crashed) + STEP_TIMEOUT + 5000).join("\n");
    expect(detail).toContain("Run run-A — ship-fix [stalled]");
    expect(detail).toContain("Stage 1 (parallel)");
    expect(detail).toContain("@developer");
    expect(detail).toContain("patch applied");
    // The retry count is the engine's own: one git-lock blip, then success.
    expect(detail).toContain("2 attempts");
    expect(detail).toContain("@reviewer");
    expect(detail).toContain("/workflow resume run-A");
  });

  it("puts the run's engine-journalled spend and turns on the detail header", async () => {
    const lines = await engineJournal({
      source: [FRONT, "1. @architect design it", "2. @developer patch it {{prev}}"].join("\n"),
      runStep: async (request) => spendTurns(request, 3, 0.25, 500),
    });
    const run = foldJournal("run-A", lines);
    const detail = formatRunDetail(run, lastTs(lines) + 100).join("\n");
    // $0.75 per step across two steps, six turns in total — every digit of it
    // written by the engine on the path production uses.
    expect(detail).toContain("spend $1.50");
    expect(detail).toContain("6 turns");
  });

  it("renders a paused run as awaiting a human answer, with the question and the answer hint", async () => {
    // Real engine output: stage 2 raises an ORG-ASK, so the run pauses.
    const lines = await engineJournal({
      source: [
        FRONT,
        "1. @architect plan it",
        "2. @pm decide {{prev}}",
        "3. @developer build {{prev}}",
      ].join("\n"),
      runStep: async (request) =>
        request.step.id === "2"
          ? {
              text: "ORG-ASK: single-tenant or multi-tenant?",
              usage: usage(100, 0.1),
              isError: false,
            }
          : spendTurns(request, 1, 0.05, 200),
    });
    // The whole thing, runEnd{paused} included — the engine's own terminal.
    expect(lines.some((l) => l.kind === "runEnd" && l.status === "paused")).toBe(true);

    const run = foldJournal("run-A", lines);
    expect(deriveRunState(run, lastTs(lines) + 100)).toBe("paused");
    const detail = formatRunDetail(run, lastTs(lines) + 100).join("\n");
    expect(detail).toContain("Run run-A — ship-fix [paused]");
    expect(detail).toContain("2 @pm — paused");
    expect(detail).toContain("Awaiting a human answer: single-tenant or multi-tenant?");
    expect(detail).toContain("Answer with /workflow resume run-A <answer>");

    // The one-line table row surfaces the same, for the multi-run overview.
    const row = formatRunsTable([run], lastTs(lines) + 100).join("\n");
    expect(row).toContain("paused");
    expect(row).toContain("asks: single-tenant or multi-tenant?");
    expect(row).toContain("answer with /workflow resume run-A <answer>");
  });

  it("surfaces EVERY question when a parallel stage raises more than one", async () => {
    // Real engine output: both branches of stage 2 raise their own ORG-ASK, so
    // the stage pauses owing two answers. Showing only one of them tells the
    // operator the run is waiting on strictly less than it is.
    const lines = await engineJournal({
      source: [
        FRONT,
        "1. @architect plan it",
        "2. Two open questions:",
        "   - @pm decide tenancy {{prev}}",
        "   - @pm decide auth {{prev}}",
        "3. @developer build {{prev}}",
      ].join("\n"),
      runStep: async (request) =>
        request.step.id === "2.1"
          ? {
              text: "ORG-ASK: single-tenant or multi-tenant?",
              usage: usage(100, 0.1),
              isError: false,
            }
          : request.step.id === "2.2"
            ? { text: "ORG-ASK: sessions or JWTs?", usage: usage(100, 0.1), isError: false }
            : spendTurns(request, 1, 0.05, 200),
    });
    expect(lines.filter((l) => l.kind === "stepEnd" && l.status === "paused")).toHaveLength(2);

    const run = foldJournal("run-A", lines);
    expect(deriveRunState(run, lastTs(lines) + 100)).toBe("paused");
    expect(run.pendingQuestions.map((q) => q.question)).toEqual([
      "single-tenant or multi-tenant?",
      "sessions or JWTs?",
    ]);
    // `pendingQuestion` stays the FIRST, not the last, so a single-question
    // reader keeps naming the question the operator is asked about first.
    expect(run.pendingQuestion).toBe("single-tenant or multi-tenant?");

    const detail = formatRunDetail(run, lastTs(lines) + 100).join("\n");
    expect(detail).toContain("single-tenant or multi-tenant?");
    expect(detail).toContain("sessions or JWTs?");

    const row = formatRunsTable([run], lastTs(lines) + 100).join("\n");
    expect(row).toContain("single-tenant or multi-tenant?");
    expect(row).toContain("2 questions");
  });

  it("clears only the answered question when a parallel stage's pauses are settled one at a time", async () => {
    const lines = await engineJournal({
      source: [
        FRONT,
        "1. @architect plan it",
        "2. Two open questions:",
        "   - @pm decide tenancy {{prev}}",
        "   - @pm decide auth {{prev}}",
      ].join("\n"),
      runStep: async (request) =>
        request.step.id === "2.1"
          ? {
              text: "ORG-ASK: single-tenant or multi-tenant?",
              usage: usage(100, 0.1),
              isError: false,
            }
          : request.step.id === "2.2"
            ? { text: "ORG-ASK: sessions or JWTs?", usage: usage(100, 0.1), isError: false }
            : spendTurns(request, 1, 0.05, 200),
    });
    // The engine's own answered terminal for 2.1 only — latest-wins, so the
    // fold must retire that question and keep the other one owing.
    const answered = lines
      .filter((l): l is Extract<JournalLine, { kind: "stepEnd" }> => l.kind === "stepEnd")
      .find((l) => l.id === "2.1");
    if (!answered) throw new Error("fixture: no stepEnd for 2.1");
    const run = foldJournal("run-A", [
      ...lines,
      { ...answered, status: "done", answered: true, question: undefined },
    ]);
    expect(run.pendingQuestions.map((q) => q.question)).toEqual(["sessions or JWTs?"]);
    expect(run.pendingQuestion).toBe("sessions or JWTs?");
    expect(deriveRunState(run, lastTs(lines) + 100)).toBe("paused");
  });
});
