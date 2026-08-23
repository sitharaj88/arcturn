/**
 * FAILURE-INJECTION AUDIT of the just-landed org-workflow reliability work
 * (self-healing retry + run journal + resume + `/workflow status`).
 *
 * Every `it` here is a hostile repro that FAILS against the code as it stands;
 * each is annotated with the reliability CLAIM it breaks and the ledger incident
 * it maps to. New file only — nothing existing is edited.
 */

import type { Usage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  isWorkflowParseError,
  parseWorkflow,
  runWorkflow,
  type Workflow,
  type WorkflowStepRequest,
} from "./workflow.js";
import { buildResumeState, type JournalLine, type RunJournal } from "./workflow-run.js";
import { foldJournal, summariseRun } from "./workflow-status.js";

// ------------------------------------------------------------------ helpers

function parseOk(raw: string): Workflow {
  const parsed = parseWorkflow(raw, { name: "wf" });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow, got: ${parsed.error}`);
  return parsed;
}

const FRONT = ["---", "name: demo", "description: A demo", "---"].join("\n");

/** A Usage with an explicit output-token count (the billed total) and cost. */
function spend(outputTokens: number, costUsd?: number): Usage {
  return {
    inputTokens: outputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/** In-memory journal recording every appended line. */
function memoryJournal(): { sink: RunJournal; lines: JournalLine[] } {
  const lines: JournalLine[] = [];
  return { lines, sink: { append: async (line) => void lines.push(line) } };
}

/**
 * A journal that models a CRASH after a step's side effect landed but before
 * its `stepEnd` commit reached disk: it records the `run`/`stageStart`/
 * `stepStart` prefix and silently drops every terminal line (`stepEnd`,
 * `stageEnd`, `budget`, `runEnd`) — exactly what `createFileRunJournal`'s
 * best-effort, error-swallowing `append` leaves behind when the write that
 * carries the durability commit is the one the crash (or the disk) eats.
 */
function crashAfterSideEffectJournal(): { sink: RunJournal; lines: JournalLine[] } {
  const lines: JournalLine[] = [];
  const dropped = new Set(["stepEnd", "stageEnd", "budget", "runEnd"]);
  return {
    lines,
    sink: { append: async (line) => void (dropped.has(line.kind) ? 0 : lines.push(line)) },
  };
}

const fastRetry = { maxRetries: 2, sleep: async () => {}, computeDelay: () => 0 };

// ===========================================================================
// FINDING A — the self-healing retry drops the token spend of every attempt
// but the last, under-reporting cost on exactly the expensive flapping case.
//
// CLAIM (workflow.ts runStepAttempts / WorkflowRetryPolicy docs): a transient
// step is retried; the run's usage is accurate.
// LEDGER: "A step timed out reporting zero token spend, understating cost
// exactly on the expensive runaway case."  Retry is the same failure class:
// each failed attempt DID call the provider and DID burn tokens, yet only the
// final attempt's usage survives into the step result, the run total and the
// stepEnd journal line.
// ===========================================================================
describe("FINDING A: retry under-reports cost (only the last attempt is counted)", () => {
  /** Fails transient `failures` times, spending real tokens each time. */
  function flakySpender(failures: number, perAttempt: number[]) {
    let n = 0;
    const runStep = async (_request: WorkflowStepRequest) => {
      const out = perAttempt[n] ?? 0;
      n += 1;
      if (n <= failures) {
        return {
          text: "",
          usage: spend(out),
          isError: true as const,
          error: "socket stalled",
          failureKind: "network" as const,
        };
      }
      return { text: "ok", usage: spend(out), isError: false as const };
    };
    return { runStep, calls: () => n };
  }

  it("counts the tokens burned by the failed attempts, not just the survivor", async () => {
    const workflow = parseOk([FRONT, "1. flaky"].join("\n"));
    // Two transient failures (100 + 40 tokens) then success (7 tokens).
    const flaky = flakySpender(2, [100, 40, 7]);
    const mem = memoryJournal();
    const result = await runWorkflow(workflow, {
      retry: fastRetry,
      runStep: flaky.runStep,
      journal: mem.sink,
    });

    expect(flaky.calls()).toBe(3); // 1 + 2 retries all ran (and all cost tokens)
    expect(result.status).toBe("done");

    // Honest spend is 100 + 40 + 7 = 147 output tokens. Current code reports 7:
    // the failed attempts' 140 tokens are silently dropped from the ledger.
    expect(result.usage.outputTokens).toBe(147);
    expect(result.steps[0]?.usage.outputTokens).toBe(147);

    // …and the durable journal is under-reported too, so `/workflow status`
    // and any post-hoc cost audit inherit the same lie.
    const stepEnd = mem.lines.find((l) => l.kind === "stepEnd");
    expect(stepEnd && "usage" in stepEnd ? stepEnd.usage.outputTokens : -1).toBe(147);
  });
});

// ===========================================================================
// FINDING B — `/workflow status` can never show a run's spend or turns, so the
// operator watching a runaway-cost run sees no dollar figure at all.
//
// CLAIM (workflow-status.ts): the status view surfaces "spend so far" so an
// operator answers "what is it doing / what did it do" without grepping JSONL.
// The `budget` JournalLine carries `spentUsd?`/`turns?`, the fold reads them,
// and the table renders `$X.XX` / `N turns`.
// REALITY: the engine's ONLY budget emission (workflow.ts) writes `{usage}` and
// never `spentUsd`/`turns`; and `addUsage` drops `costUsd`, so even
// `usage.costUsd` is gone. The reader consumes fields the writer never emits,
// leaving the spend column permanently blank in production. The green suite
// hides this because the status tests hand-craft budget lines carrying
// spentUsd/turns the engine does not produce.
// LEDGER: cost visibility on a runaway run (incident #4).
// ===========================================================================
describe("FINDING B: /workflow status never shows run spend or turns", () => {
  it("surfaces the spend the engine actually journalled for a real run", async () => {
    const workflow = parseOk([FRONT, "1. a", "2. b {{prev}}"].join("\n"));
    const mem = memoryJournal();
    // Each step reports a real dollar cost on its usage — the run genuinely
    // spent money, and the journal is the durable record of that.
    await runWorkflow(workflow, {
      runStep: async (req) => ({
        text: `out-${req.step.id}`,
        usage: spend(500, 3.5),
        isError: false,
      }),
      journal: mem.sink,
    });

    // A budget line was written (the status view's spend source)…
    const budget = mem.lines.find((l) => l.kind === "budget");
    expect(budget).toBeDefined();

    // …but folding the real journal yields no spend and no turns, so the
    // operator's status row is blank exactly where cost belongs.
    const run = foldJournal("R", mem.lines);
    const summary = summariseRun(run, Date.now());
    expect(summary.spentUsd).toBeDefined();
    expect(summary.spentUsd).toBeGreaterThan(0);
  });
});

// ===========================================================================
// FINDING C — resume RE-EXECUTES a step whose external side effect (the write
// lane's `git apply` into the real checkout) already landed, because the
// durability commit (`stepEnd`) is written AFTER the side effect and the file
// journal swallows write failures. A crash / failed commit in that window
// leaves the checkout mutated but the journal saying "not done", so resume
// double-applies (or, on the real write lane, the re-run's `git apply` refuses
// the already-applied patch and reports success as a hard failure).
//
// CLAIM (workflow-run.ts): "a done step (its patch already in the checkout) is
// never redone or double-applied"; stepEnd is the crash-consistency commit.
// GAP: the claim only covers steps that reached a persisted stepEnd. The side
// effect happens one ordering step earlier, so the window between "patch
// applied" and "stepEnd on disk" has no barrier.
// LEDGER: resumability of a run killed by machine sleep (incident #6), and the
// explicit ask: "kill a run between 'patch captured' and 'patch applied' … does
// it double-apply?"
// ===========================================================================
describe("FINDING C: resume double-applies a step whose stepEnd commit was lost", () => {
  it("does not re-run a step whose side effect already landed before the crash", async () => {
    const workflow = parseOk([FRONT, "1. apply"].join("\n"));

    // The real checkout the write lane's `git apply` mutates, modelled as an
    // append log. runStep is the write lane: it lands the patch (the side
    // effect) and reports it applied.
    const checkout: string[] = [];
    const applyStep = async (_req: WorkflowStepRequest) => {
      checkout.push("PATCH-1"); // git apply into the user's real tree
      return {
        text: "landed",
        usage: spend(10),
        isError: false as const,
        record: {
          status: "applied" as const,
          role: "developer",
          stepId: "1",
          files: 1,
          patchPath: "/runs/R/1.patch",
        },
      };
    };

    // ROUND 1: run under a journal that crashes right after the side effect —
    // the stepEnd commit never reaches disk (best-effort append swallowed it).
    const crash = crashAfterSideEffectJournal();
    await runWorkflow(workflow, { runStep: applyStep, journal: crash.sink, runId: "R" });
    expect(checkout).toEqual(["PATCH-1"]); // the patch is in the checkout
    // The crash-truncated journal has the stepStart but no stepEnd for step 1.
    expect(crash.lines.some((l) => l.kind === "stepStart")).toBe(true);
    expect(crash.lines.some((l) => l.kind === "stepEnd")).toBe(false);

    // ROUND 2: resume from that journal. The patch is ALREADY in the checkout;
    // a correct resume must not apply it a second time.
    const state = buildResumeState(crash.lines);
    const resume = memoryJournal();
    await runWorkflow(workflow, {
      runStep: applyStep,
      journal: resume.sink,
      runId: "R",
      resumeFrom: state,
    });

    // Correct: the checkout still holds exactly one copy of the patch. Current
    // code re-runs step 1 and the side effect lands twice — a double-apply of
    // work the previous run had already completed.
    expect(checkout).toEqual(["PATCH-1"]);
  });
});
