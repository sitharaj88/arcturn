/**
 * JUDGE DISAGREEMENT — the panel's own decisions, and the engine running one.
 *
 * Two halves, deliberately: `runJudgePanel` is pure policy and is exercised
 * against a three-line fake, and then the whole construct is driven through
 * the REAL engine so the facts that matter are effects — how many requests the
 * runner actually saw at once, what the arbiter was shown, which line reached
 * `journal.jsonl`, and what `~/.arcturn/insights/events.jsonl` did and did not
 * record.
 */

import { rm } from "node:fs/promises";
import type { Usage } from "@arcturn/types";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentDef } from "./agents.js";
import type { WorkflowContract } from "./contracts.js";
import { createInsightsRecorder, readInsightsLedger } from "./insights.js";
import {
  arbiterPrompt,
  contractRetryPrompt,
  describeJudges,
  judgeCompareField,
  judgesDisagreementNotice,
  judgesNoEnumFieldError,
  judgesWriteLaneError,
  runJudgePanel,
} from "./judges.js";
import { makeScratch } from "./test-helpers/scratch.js";
import { isWorkflowParseError, parseWorkflow, runWorkflow, type Workflow } from "./workflow.js";
import type { JournalLine, RunJournal, StepEndLine } from "./workflow-run.js";
import { foldJournal, formatRunDetail } from "./workflow-status.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const FENCE = "```";
const FRONT = ["---", "name: demo", "description: A demo", "---"].join("\n");

function memoryJournal(): { sink: RunJournal; lines: JournalLine[] } {
  const lines: JournalLine[] = [];
  return {
    lines,
    sink: {
      append: async (line) => {
        lines.push(line);
      },
    },
  };
}

function usage(inputTokens = 1, outputTokens = 2): Usage {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function parseOk(raw: string, name = "wf"): Workflow {
  const parsed = parseWorkflow(raw, { name });
  if (isWorkflowParseError(parsed)) throw new Error(`expected a workflow, got: ${parsed.error}`);
  return parsed;
}

function role(name: string, tools: string[]): AgentDef {
  return {
    name,
    description: `${name} role`,
    systemPrompt: `You are the ${name}.`,
    tools,
    source: `/roles/${name}.md`,
  };
}

function verdictReply(decision: string, why = "because"): string {
  return [why, "", `${FENCE}json`, JSON.stringify({ decision }), FENCE].join("\n");
}

const VERDICT_BLOCK = [`${FENCE}contract verdict`, "decision: SHIP | DO-NOT-SHIP", FENCE];

const JUDGED = parseOk(
  [
    FRONT,
    "1. [judges:2] [contract:verdict] @reviewer review the diff",
    "2. act on {{contract.decision}}",
    "",
    ...VERDICT_BLOCK,
  ].join("\n"),
);

const READ_ROLE = (name: string): AgentDef => role(name, ["read", "glob"]);

// ===========================================================================
// 1. the panel's own decisions
// ===========================================================================

function contract(fields: WorkflowContract["fields"]): WorkflowContract {
  return { name: "verdict", line: 1, fields };
}

describe("judgeCompareField", () => {
  it("prefers the first enum field, whatever it is called", () => {
    const c = contract([
      { name: "summary", optional: false, type: { kind: "string" } },
      { name: "call", optional: false, type: { kind: "enum", values: ["A", "B"] } },
      { name: "second", optional: false, type: { kind: "enum", values: ["C", "D"] } },
    ]);
    expect(judgeCompareField(c)?.name).toBe("call");
  });

  it("falls back to a field named decision or verdict", () => {
    expect(
      judgeCompareField(contract([{ name: "decision", optional: false, type: { kind: "string" } }]))
        ?.name,
    ).toBe("decision");
    expect(
      judgeCompareField(contract([{ name: "verdict", optional: false, type: { kind: "string" } }]))
        ?.name,
    ).toBe("verdict");
  });

  it("finds nothing to compare in a contract of free text and numbers", () => {
    expect(
      judgeCompareField(
        contract([
          { name: "summary", optional: false, type: { kind: "string" } },
          { name: "score", optional: false, type: { kind: "number" } },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("runJudgePanel", () => {
  /** A panel over canned replies; records the prompt each seat was given. */
  function panelOver(replies: readonly (string | undefined)[]) {
    const seen: { index: number; seat: string; prompt: string }[] = [];
    const splits: string[][] = [];
    return {
      seen,
      splits,
      run: () =>
        runJudgePanel<number>({
          count: replies.length - 1,
          field: "decision",
          prompt: "review the diff",
          onDisagreement: (verdicts) => splits.push([...verdicts]),
          run: async ({ index, seat, prompt }) => {
            seen.push({ index, seat, prompt });
            const decision = replies[index];
            return {
              carrier: index,
              ...(decision === undefined ? {} : { value: { decision } }),
              text: decision === undefined ? "no idea" : verdictReply(decision),
            };
          },
        }),
    };
  }

  it("runs every judge and keeps the first when they agree — no arbiter", async () => {
    const panel = panelOver(["SHIP", "SHIP", "NEVER-USED"]);
    const result = await panel.run();
    expect(panel.seen.map((seat) => seat.seat)).toEqual(["judge", "judge"]);
    expect(panel.seen.every((seat) => seat.prompt === "review the diff")).toBe(true);
    expect(result.winner?.carrier).toBe(0);
    expect(result.record).toEqual({
      count: 2,
      verdicts: ["SHIP", "SHIP"],
      agreed: true,
      arbitrated: false,
    });
    expect(panel.splits).toEqual([]);
  });

  it("arbitrates a split, showing the arbiter both replies in full", async () => {
    const panel = panelOver(["SHIP", "DO-NOT-SHIP", "DO-NOT-SHIP"]);
    const result = await panel.run();
    expect(panel.seen.map((seat) => seat.seat)).toEqual(["judge", "judge", "arbiter"]);
    // The arbiter takes the seat AFTER the last judge, so no two seats share a
    // marker.
    expect(panel.seen.at(-1)?.index).toBe(2);
    const prompt = panel.seen.at(-1)?.prompt ?? "";
    expect(prompt).toContain("review the diff");
    expect(prompt).toContain("Two independent judges disagreed:");
    expect(prompt).toContain("Judge 1:");
    expect(prompt).toContain("Judge 2:");
    expect(prompt).toContain(verdictReply("SHIP"));
    expect(prompt).toContain(verdictReply("DO-NOT-SHIP"));
    expect(prompt).toContain(
      "Decide. Weigh the evidence in each; do not average. End with the contract json block.",
    );
    // The arbiter's answer is the step's answer.
    expect(result.winner?.carrier).toBe(2);
    expect(result.record).toEqual({
      count: 2,
      verdicts: ["SHIP", "DO-NOT-SHIP"],
      agreed: false,
      arbitrated: true,
      arbiterVerdict: "DO-NOT-SHIP",
    });
    expect(panel.splits).toEqual([["SHIP", "DO-NOT-SHIP"]]);
  });

  it("leaves no winner when nothing valid came back", async () => {
    const panel = panelOver([undefined, undefined, "NEVER-USED"]);
    const result = await panel.run();
    expect(result.winner).toBeUndefined();
    expect(result.record).toEqual({
      count: 2,
      verdicts: [],
      agreed: false,
      arbitrated: false,
    });
    // No arbiter over an empty split.
    expect(panel.seen).toHaveLength(2);
  });

  /**
   * A silent judge is not a dissenting vote — but the one judge left is not a
   * panel that AGREED either: `judges: 2 · SHIP` would read as "two judges
   * agreed" over a single voice. So the seat that answered is shown to an
   * arbiter, which is the same escalation every other unresolved panel gets.
   */
  it("does not call one surviving vote an agreement, and arbitrates it", async () => {
    const panel = panelOver(["SHIP", undefined, "SHIP"]);
    const result = await panel.run();
    expect(result.record.agreed).toBe(false);
    expect(result.record.arbitrated).toBe(true);
    expect(result.record.verdicts).toEqual(["SHIP"]);
    expect(panel.seen.map((seat) => seat.seat)).toEqual(["judge", "judge", "arbiter"]);
    // The arbiter is told what it is looking at: one reply, not a split.
    expect(panel.seen.at(-1)?.prompt).toContain(
      "Only one of the independent judges produced a usable reply:",
    );
    expect(result.winner?.carrier).toBe(2);
  });

  it("leaves no winner when the arbiter itself missed the shape", async () => {
    const panel = panelOver(["SHIP", "DO-NOT-SHIP", undefined]);
    const result = await panel.run();
    expect(result.winner).toBeUndefined();
    expect(result.record.arbitrated).toBe(true);
    expect(result.record.arbiterVerdict).toBeUndefined();
  });
});

describe("judges — the strings", () => {
  it("names the refusals exactly", () => {
    expect(judgesWriteLaneError("3", "builder")).toBe(
      'step 3: judges requires a read-only role; "builder" can write',
    );
    expect(judgesNoEnumFieldError("3")).toBe(
      "step 3: judges needs a contract with an enum field to compare",
    );
  });

  it("says a split in one line", () => {
    expect(judgesDisagreementNotice("3", ["SHIP", "DO-NOT-SHIP"])).toBe(
      "judges disagreed on step 3 (SHIP vs DO-NOT-SHIP) — arbitrating",
    );
  });

  it("renders the status line", () => {
    expect(
      describeJudges({
        count: 2,
        verdicts: ["SHIP", "DO-NOT-SHIP"],
        agreed: false,
        arbitrated: true,
        arbiterVerdict: "DO-NOT-SHIP",
      }),
    ).toBe("judges: 2 · SHIP / DO-NOT-SHIP · arbiter: DO-NOT-SHIP");
    expect(
      describeJudges({ count: 2, verdicts: ["SHIP", "SHIP"], agreed: true, arbitrated: false }),
    ).toBe("judges: 2 · SHIP / SHIP");
  });

  it("keeps the retry note to the original prompt plus the complaint", () => {
    expect(contractRetryPrompt("do the thing", ["missing required field decision"])).toBe(
      [
        "do the thing",
        "",
        "```",
        "Your previous reply did not satisfy the contract: missing required field decision.",
        "Reply again and end with a valid json block.",
        "```",
      ].join("\n"),
    );
  });

  it("names three judges as three", () => {
    expect(arbiterPrompt("p", ["a", "b", "c"])).toContain("Three independent judges disagreed:");
  });
});

// ===========================================================================
// 2. the engine running one
// ===========================================================================

describe("runWorkflow — a judged step", () => {
  it("runs N judges CONCURRENTLY, on identical prompts and distinct markers", async () => {
    let inFlight = 0;
    let peak = 0;
    const prompts: string[] = [];
    const markers: (number | undefined)[] = [];
    const result = await runWorkflow(JUDGED, {
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id === "1") {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          prompts.push(request.prompt);
          markers.push(request.attempt);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
        }
        return { text: verdictReply("SHIP"), usage: usage(), isError: false };
      },
    });
    expect(result.status).toBe("done");
    expect(peak).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]);
    // Every seat gets a marker of its own, or two judges share a worktree slug
    // and a live row.
    expect(new Set(markers).size).toBe(2);
  });

  it("keeps the first verdict when the judges agree, with no arbiter run", async () => {
    const prompts: string[] = [];
    let second = "";
    const mem = memoryJournal();
    const result = await runWorkflow(JUDGED, {
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        prompts.push(request.prompt);
        if (request.step.id === "2") {
          second = request.prompt;
          return { text: "acted", usage: usage(), isError: false };
        }
        return {
          text: verdictReply("SHIP", `judge ${prompts.length}`),
          usage: usage(),
          isError: false,
        };
      },
    });
    expect(result.status).toBe("done");
    // Two judges and stage 2 — nothing else ran.
    expect(prompts).toHaveLength(3);
    expect(prompts.some((prompt) => prompt.includes("disagreed"))).toBe(false);
    expect(second).toBe("act on SHIP");

    const end = mem.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(end?.judges).toEqual({
      count: 2,
      verdicts: ["SHIP", "SHIP"],
      agreed: true,
      arbitrated: false,
    });
    // ONE terminal for the step, however many seats ran under it.
    expect(mem.lines.filter((line) => line.kind === "stepEnd" && line.id === "1")).toHaveLength(1);
    // The step's spend is the whole panel's: two judges at usage() each.
    expect(end?.usage.outputTokens).toBe(4);
  });

  it("arbitrates a split, and the arbiter's verdict is the step's answer", async () => {
    const prompts: string[] = [];
    const notices: string[] = [];
    let second = "";
    const mem = memoryJournal();
    let judged = 0;
    const result = await runWorkflow(JUDGED, {
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      onEvent: (event) => {
        if (event.type === "judgesDisagreed") {
          notices.push(`${event.id}:${event.verdicts.join("|")}`);
        }
      },
      runStep: async (request) => {
        if (request.step.id === "2") {
          second = request.prompt;
          return { text: "acted", usage: usage(), isError: false };
        }
        prompts.push(request.prompt);
        if (request.prompt.includes("independent judges disagreed")) {
          return {
            text: verdictReply("DO-NOT-SHIP", "the second judge is right"),
            usage: usage(),
            isError: false,
          };
        }
        judged += 1;
        return {
          text: verdictReply(judged === 1 ? "SHIP" : "DO-NOT-SHIP", `judge ${judged}`),
          usage: usage(),
          isError: false,
        };
      },
    });
    expect(result.status).toBe("done");
    // Two judges plus one arbiter.
    expect(prompts).toHaveLength(3);
    const arbiter = prompts[2] ?? "";
    expect(arbiter).toContain("review the diff");
    expect(arbiter).toContain("Two independent judges disagreed:");
    // Both replies go in WHOLE — reasons and all.
    expect(arbiter).toContain("judge 1");
    expect(arbiter).toContain("judge 2");
    expect(arbiter).toContain("do not average");
    // The arbiter's object is what the next stage reads.
    expect(second).toBe("act on DO-NOT-SHIP");
    expect(result.steps[0]?.contract).toEqual({ decision: "DO-NOT-SHIP" });
    expect(notices).toEqual(["1:SHIP|DO-NOT-SHIP"]);

    const end = mem.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(end?.judges).toEqual({
      count: 2,
      verdicts: ["SHIP", "DO-NOT-SHIP"],
      agreed: false,
      arbitrated: true,
      arbiterVerdict: "DO-NOT-SHIP",
    });
    expect(end?.contract).toEqual({ decision: "DO-NOT-SHIP" });
    // Three seats, three bills.
    expect(end?.usage.outputTokens).toBe(6);
  });

  it("gives each judge its own contract retry, and heals a single bad reply", async () => {
    const prompts: string[] = [];
    let judged = 0;
    const result = await runWorkflow(JUDGED, {
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      retryPolicy: { sleep: async () => {} },
      runStep: async (request) => {
        if (request.step.id === "2") return { text: "acted", usage: usage(), isError: false };
        prompts.push(request.prompt);
        if (request.prompt.includes("did not satisfy the contract")) {
          return { text: verdictReply("SHIP"), usage: usage(), isError: false };
        }
        judged += 1;
        return judged === 1
          ? { text: "no json here at all", usage: usage(), isError: false }
          : { text: verdictReply("SHIP"), usage: usage(), isError: false };
      },
    });
    expect(result.status).toBe("done");
    // Judge A, judge B, and A's single retry.
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("the reply has no fenced json block");
    expect(result.steps[0]?.judges?.agreed).toBe(true);
  });

  it("fails the step `contract` when every judge missed the shape", async () => {
    const mem = memoryJournal();
    const result = await runWorkflow(JUDGED, {
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      retryPolicy: { sleep: async () => {} },
      runStep: async () => ({ text: "just some prose", usage: usage(), isError: false }),
    });
    // A failed step is a question, judged or not.
    expect(result.status).toBe("paused");
    const ask = mem.lines.find((line) => line.kind === "stepFailAsk");
    if (ask?.kind !== "stepFailAsk") throw new Error("expected a stepFailAsk line");
    expect(ask.failureKind).toBe("contract");
    expect(ask.cause).toContain("the reply has no fenced json block");
    const end = mem.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(end?.status).toBe("failed");
    expect(end?.contract).toBeUndefined();
    expect(end?.judges?.verdicts).toEqual([]);
  });

  it("aborts every judge when the run is cancelled", async () => {
    const controller = new AbortController();
    let started = 0;
    const aborted: boolean[] = [];
    const result = await runWorkflow(JUDGED, {
      signal: controller.signal,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        started += 1;
        if (started === 2) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        aborted.push(request.signal.aborted);
        return { text: "", usage: usage(), isError: true, error: "cancelled" };
      },
    });
    expect(result.status).toBe("cancelled");
    expect(started).toBe(2);
    // Both seats saw the abort — a panel is one step's worth of cancellation.
    expect(aborted).toEqual([true, true]);
  });

  it("prints the panel under the step in /workflow status", async () => {
    const mem = memoryJournal();
    let judged = 0;
    await runWorkflow(JUDGED, {
      runId: "RID",
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id === "2") return { text: "acted", usage: usage(), isError: false };
        if (request.prompt.includes("independent judges disagreed")) {
          return { text: verdictReply("DO-NOT-SHIP"), usage: usage(), isError: false };
        }
        judged += 1;
        return {
          text: verdictReply(judged === 1 ? "SHIP" : "DO-NOT-SHIP"),
          usage: usage(),
          isError: false,
        };
      },
    });
    const detail = formatRunDetail(foldJournal("RID", mem.lines), Date.now()).join("\n");
    expect(detail).toContain("judges: 2 · SHIP / DO-NOT-SHIP · arbiter: DO-NOT-SHIP");
    expect(detail).toContain("contract: decision=DO-NOT-SHIP");
  });

  it("records counts in the ledger and never a verdict", async () => {
    const scratch = await makeScratch();
    roots.push(scratch.root);
    const recorder = createInsightsRecorder({ home: scratch.home });
    let judged = 0;
    await runWorkflow(JUDGED, {
      runId: "RID",
      insights: recorder,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id === "2") return { text: "acted", usage: usage(), isError: false };
        if (request.prompt.includes("independent judges disagreed")) {
          return { text: verdictReply("DO-NOT-SHIP"), usage: usage(), isError: false };
        }
        judged += 1;
        return {
          text: verdictReply(judged === 1 ? "SHIP" : "DO-NOT-SHIP"),
          usage: usage(),
          isError: false,
        };
      },
    });
    await recorder.flush();

    const { events } = await readInsightsLedger(scratch.home);
    const stepEnd = events.find(
      (event) => event.kind === "step-end" && "stepId" in event && event.stepId === "1",
    );
    expect(stepEnd).toMatchObject({
      kind: "step-end",
      contract: true,
      judges: { count: 2, agreed: false, arbitrated: true },
    });
    // The whole ledger, not just this record: no verdict ever reaches it.
    const bytes = JSON.stringify(events);
    expect(bytes).not.toContain("SHIP");
    expect(bytes).not.toContain("arbiterVerdict");
  });
});

// ===========================================================================
// 3. the seat is the unit: prompts, budgets and attempts
// ===========================================================================

describe("runWorkflow — a judged step's seats are not the step", () => {
  /**
   * RED FIRST: the contract gate was built ONCE per step and closed over the
   * step's own prompt, and every seat shared it. For a judge that is the same
   * prompt, so nothing showed; for the ARBITER it is not. Its one contract
   * retry was re-dispatched with the step's brief plus the validator's
   * complaint — the two judges' replies and "do not average" gone — so the
   * retry answered a different question from the one the arbiter was seated
   * to answer, and whatever it said was recorded as the panel's arbitration.
   */
  it("re-dispatches the arbiter's contract retry with the ARBITER's own prompt", async () => {
    const prompts: string[] = [];
    let judgeCalls = 0;
    let arbiterReplies = 0;
    const mem = memoryJournal();
    const result = await runWorkflow(JUDGED, {
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id !== "1") return { text: "acted", usage: usage(), isError: false };
        prompts.push(request.prompt);
        if (request.prompt.includes("independent judges disagreed") || arbiterReplies > 0) {
          arbiterReplies += 1;
          // The arbiter's first reply misses the shape, buying its one retry.
          if (arbiterReplies === 1) {
            return { text: "I would go with the first judge.", usage: usage(), isError: false };
          }
          return { text: verdictReply("SHIP", "on reflection"), usage: usage(), isError: false };
        }
        judgeCalls += 1;
        return {
          text: verdictReply(judgeCalls === 1 ? "SHIP" : "DO-NOT-SHIP", `judge ${judgeCalls}`),
          usage: usage(),
          isError: false,
        };
      },
    });
    expect(result.status).toBe("done");
    // seats: judge, judge, arbiter, arbiter-retry.
    expect(prompts).toHaveLength(4);
    expect(prompts[2]).toContain("independent judges disagreed");
    const retry = prompts[3] ?? "";
    expect(retry).toContain("Your previous reply did not satisfy the contract");
    // The whole brief is still there: both replies and the instruction.
    expect(retry).toContain("independent judges disagreed");
    expect(retry).toContain("judge 1");
    expect(retry).toContain("judge 2");
    expect(retry).toContain("do not average");
    expect(mem.lines.find((line) => line.kind === "stepEnd" && line.id === "1")).toMatchObject({
      judges: { arbitrated: true, arbiterVerdict: "SHIP" },
    });
  });

  /**
   * RED FIRST: a role's `budget:` is a per-ASSIGNMENT ceiling ("across every
   * retry of the step it was assigned to, not a fresh allowance per attempt"),
   * and a panel is one assignment — but every seat had its own `spent`
   * accumulator starting at zero, so `[judges:3] @role` with `budget: 5`
   * quietly licensed $20.
   */
  it("trips a role's budget on the PANEL's total, not on each seat's own", async () => {
    const result = await runWorkflow(JUDGED, {
      resolveAgent: (name) => ({ ...role(name, ["read", "glob"]), budget: 1 }),
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id !== "1") return { text: "acted", usage: usage(), isError: false };
        // One turn, $0.80: under the $1 ceiling alone, $1.60 as a pair.
        request.onUsage?.({ ...usage(), costUsd: 0.8 });
        return {
          text: verdictReply("SHIP"),
          usage: { ...usage(), costUsd: 0.8 },
          isError: false,
        };
      },
    });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.error).toContain("budget");
    // The stage never ran on the vote of the seats that finished under it.
    expect(result.steps[1]?.status).toBe("skipped");
  });

  it("leaves a panel under the ceiling alone", async () => {
    const result = await runWorkflow(JUDGED, {
      resolveAgent: (name) => ({ ...role(name, ["read", "glob"]), budget: 5 }),
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id !== "1") return { text: "acted", usage: usage(), isError: false };
        request.onUsage?.({ ...usage(), costUsd: 0.8 });
        return {
          text: verdictReply("SHIP"),
          usage: { ...usage(), costUsd: 0.8 },
          isError: false,
        };
      },
    });
    expect(result.status).toBe("done");
  });

  /**
   * RED FIRST: the judges branch SUMMED every seat's attempt count into the
   * step's `attempts`, so two judges that both answered perfectly first time
   * were journalled as a step that took two tries — indistinguishable, to
   * `/workflow status`, `/workflow diff`, the retrospective and the ledger,
   * from a step that failed once and healed. The panel's size is `judges.count`;
   * `attempts` is flapping only.
   */
  it("does not report attempts>1 for a panel where no seat retried", async () => {
    const mem = memoryJournal();
    const result = await runWorkflow(JUDGED, {
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) =>
        request.step.id === "1"
          ? { text: verdictReply("SHIP"), usage: usage(), isError: false }
          : { text: "acted", usage: usage(), isError: false },
    });
    expect(result.status).toBe("done");
    const stepEnd = mem.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(stepEnd?.judges?.agreed).toBe(true);
    expect(stepEnd?.judges?.count).toBe(2);
    expect(result.steps[0]?.attempts).toBeUndefined();
    expect(stepEnd?.attempts).toBe(1);
  });

  /** …and a seat that really did flap is still reported as one. */
  it("reports the worst seat's attempts when one of them retried", async () => {
    const mem = memoryJournal();
    let flapped = false;
    await runWorkflow(JUDGED, {
      journal: mem.sink,
      resolveAgent: READ_ROLE,
      agentNames: () => ["reviewer"],
      runStep: async (request) => {
        if (request.step.id !== "1") return { text: "acted", usage: usage(), isError: false };
        if (!flapped) {
          flapped = true;
          // A shapeless reply buys this seat, and only this seat, one retry.
          return { text: "no json at all", usage: usage(), isError: false };
        }
        return { text: verdictReply("SHIP"), usage: usage(), isError: false };
      },
    });
    const stepEnd = mem.lines.find(
      (line): line is StepEndLine => line.kind === "stepEnd" && line.id === "1",
    );
    expect(stepEnd?.attempts).toBe(2);
  });
});
