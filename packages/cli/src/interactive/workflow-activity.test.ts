import { ColorLevel, setColorLevel, stripAnsi } from "@arcturn/tui";
import type { AgentEvent } from "@arcturn/types";
import { beforeAll, describe, expect, it } from "vitest";
import { FANCY_GLYPHS } from "../glyphs.js";
import type { WorkflowStepResult, WorkflowStepStatus } from "../workflow.js";
import { workflowStepAgentId } from "../workflow.js";
import { SubagentTracker, TokenMeter } from "./activity.js";
import { renderWorkflowActivity } from "./widgets.js";
import { WorkflowActivity } from "./workflow-activity.js";

beforeAll(() => {
  setColorLevel(ColorLevel.Ansi256);
});

/** A `stepEnd` result with sensible defaults. */
function stepResult(
  overrides: Partial<WorkflowStepResult> & { id: string; stageIndex: number; branchIndex: number },
): WorkflowStepResult {
  return {
    status: "done" as WorkflowStepStatus,
    prompt: "do the thing",
    text: "did it",
    usage: { inputTokens: 4, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  };
}

/** Feed a run through workflowStart → one parallel stage with two roles. */
function startTwoBranchStage(activity: WorkflowActivity): void {
  activity.handle({ type: "workflowStart", workflow: "ship-fix", totalSteps: 2 });
  activity.handle({
    type: "stageStart",
    stageIndex: 1,
    parallel: true,
    steps: 2,
    members: [
      { branchIndex: 0, agent: "developer", lane: "write", model: "smart" },
      { branchIndex: 1, agent: "reviewer", lane: "read" },
    ],
  });
}

describe("WorkflowActivity", () => {
  it("builds a per-stage / per-role view from workflow events", () => {
    const activity = new WorkflowActivity(() => 1000);
    startTwoBranchStage(activity);

    const before = activity.snapshot();
    expect(before?.workflow).toBe("ship-fix");
    expect(before?.stages[0]?.steps.map((step) => step.role)).toEqual(["developer", "reviewer"]);
    expect(before?.stages[0]?.steps.map((step) => step.lane)).toEqual(["write", "read"]);
    expect(before?.stages[0]?.steps.map((step) => step.phase)).toEqual(["pending", "pending"]);

    activity.handle({
      type: "stepStart",
      id: "1.1",
      stageIndex: 1,
      branchIndex: 0,
      agent: "developer",
      prompt: "write the fix",
      lane: "write",
      model: "smart",
    });
    const running = activity.snapshot();
    expect(running?.stages[0]?.steps[0]?.phase).toBe("running");
    expect(running?.stages[0]?.steps[0]?.model).toBe("smart");
    expect(running?.activeStageIndex).toBe(1);
    // The running step's agent id is exposed so the app can de-dupe rows.
    expect([...activity.runningAgentIds()]).toEqual([workflowStepAgentId("1.1", "developer")]);
  });

  it("marks a step's terminal status, tokens and patch record on stepEnd", () => {
    const activity = new WorkflowActivity(() => 1000);
    startTwoBranchStage(activity);
    activity.handle({
      type: "stepStart",
      id: "1.1",
      stageIndex: 1,
      branchIndex: 0,
      agent: "developer",
      prompt: "write the fix",
      lane: "write",
    });
    activity.handle({
      type: "stepEnd",
      result: stepResult({
        id: "1.1",
        stageIndex: 1,
        branchIndex: 0,
        agent: "developer",
        record: {
          status: "applied",
          role: "developer",
          stepId: "1.1",
          files: 3,
          patchPath: "/x/1.1-developer.patch",
        },
      }),
    });
    const view = activity.snapshot();
    expect(view?.stages[0]?.steps[0]?.phase).toBe("done");
    expect(view?.stages[0]?.steps[0]?.recordStatus).toBe("applied");
    expect(view?.stages[0]?.steps[0]?.tokens).toBe(200);
    expect(view?.doneSteps).toBe(1);
    expect(activity.runningAgentIds().size).toBe(0);
  });

  it("clears cleanly on workflowEnd — no ghost rows survive", () => {
    const activity = new WorkflowActivity(() => 1000);
    startTwoBranchStage(activity);
    expect(activity.running).toBe(true);
    expect(activity.snapshot()).toBeDefined();

    activity.handle({
      type: "workflowEnd",
      result: {
        workflow: "ship-fix",
        status: "done",
        steps: [],
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        startedAt: 0,
        endedAt: 1,
      },
    });
    expect(activity.running).toBe(false);
    expect(activity.snapshot()).toBeUndefined();
    expect(activity.runningAgentIds().size).toBe(0);
    // And the renderer draws nothing at all for a finished run.
    expect(renderWorkflowActivity(activity.snapshot(), [], 80, FANCY_GLYPHS, 2000)).toEqual([]);
  });

  it("reset() drops the run so an interrupt leaves no rows", () => {
    const activity = new WorkflowActivity(() => 1000);
    startTwoBranchStage(activity);
    activity.reset();
    expect(activity.snapshot()).toBeUndefined();
    expect(renderWorkflowActivity(activity.snapshot(), [], 80, FANCY_GLYPHS)).toEqual([]);
  });
});

describe("renderWorkflowActivity", () => {
  it("reflects a child's live turn and token deltas via the SubagentTracker", () => {
    const now = 5000;
    const activity = new WorkflowActivity(() => 1000);
    activity.handle({ type: "workflowStart", workflow: "ship-fix", totalSteps: 1 });
    activity.handle({
      type: "stageStart",
      stageIndex: 1,
      parallel: false,
      steps: 1,
      members: [{ branchIndex: 0, agent: "developer", lane: "write" }],
    });
    activity.handle({
      type: "stepStart",
      id: "1.1",
      stageIndex: 1,
      branchIndex: 0,
      agent: "developer",
      prompt: "write the fix",
      lane: "write",
    });

    const agentId = workflowStepAgentId("1.1", "developer");
    const tracker = new SubagentTracker(new TokenMeter(), () => 1000);
    tracker.handle({
      type: "subagentStart",
      agentId,
      task: "@developer · step 1.1: write the fix",
    });

    // Before the child has done anything: no turns, no tokens, "starting".
    const cold = renderWorkflowActivity(
      activity.snapshot(),
      tracker.active,
      80,
      FANCY_GLYPHS,
      now,
    ).map(stripAnsi);
    const coldRow = cold.find((line) => line.includes("@developer"));
    expect(coldRow).toContain("starting");
    expect(coldRow).not.toContain("turn");

    // The child takes two turns, streams 500 output tokens, and runs `bash`.
    const from = (event: AgentEvent): AgentEvent => ({ type: "subagentEvent", agentId, event });
    tracker.handle(from({ type: "turnStart", turnIndex: 0 }));
    tracker.handle(from({ type: "messageStream", event: { type: "usage", usage: usage(300) } }));
    tracker.handle(from({ type: "turnStart", turnIndex: 1 }));
    tracker.handle(from({ type: "messageStream", event: { type: "usage", usage: usage(500) } }));
    tracker.handle(from({ type: "toolStart", toolCallId: "t1", toolName: "bash", input: {} }));

    const hot = renderWorkflowActivity(
      activity.snapshot(),
      tracker.active,
      80,
      FANCY_GLYPHS,
      now,
    ).map(stripAnsi);
    const hotRow = hot.find((line) => line.includes("@developer"));
    expect(hotRow).toContain("2 turns");
    expect(hotRow).toContain("500");
    expect(hotRow).toContain("bash");
    // The header frames the whole run: which stage, how far along.
    expect(hot[0]).toContain("workflow ship-fix");
    expect(hot[0]).toContain("stage 1/1");
  });
});

/** A cumulative output-token usage snapshot. */
function usage(output: number) {
  return { inputTokens: 10, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
