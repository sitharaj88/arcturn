import { describe, expect, it } from "vitest";
import type { WorkflowRunStatus, WorkflowSummary } from "../serve/engine.js";
import {
  actingRoles,
  formatBudget,
  isRunLive,
  projectWorkflow,
  projectWorkflowRun,
  runConfirmation,
  runSummaryLine,
  unrunnableRoles,
} from "./workflows.js";

function summary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    name: "ship-fix",
    description: "Reproduce, patch and review one bug report",
    source: "/ws/.arcturn/workflows/ship-fix.md",
    stages: 3,
    steps: 4,
    roles: [],
    ...overrides,
  };
}

function status(overrides: Partial<WorkflowRunStatus> = {}): WorkflowRunStatus {
  return {
    runId: "run-1",
    workflow: "ship-fix",
    state: "running",
    stageCount: 3,
    stepsDone: 1,
    stepsTotal: 4,
    questions: [],
    ...overrides,
  };
}

describe("projectWorkflow", () => {
  it("carries the engine's derived lane through unchanged, for every value", () => {
    // The catalog's headline guarantee. This module owns no role files and no
    // classifier, so the one thing it must not do is soften a lane it did not
    // compute — `unknown` and `undeclared` mean nobody can say, and rendering
    // either as `read` would be the panel inventing reassurance.
    const row = projectWorkflow(
      summary({
        roles: [
          { name: "auditor", lane: "read" },
          { name: "runner", lane: "exec" },
          { name: "developer", lane: "write" },
          { name: "silent", lane: "undeclared" },
          { name: "ghost", lane: "unknown" },
        ],
      }),
    );
    expect(row.roles.map((role) => role.lane)).toEqual([
      "read",
      "exec",
      "write",
      "undeclared",
      "unknown",
    ]);
  });

  it("escapes every rendered field but leaves the name as identity", () => {
    // `<cwd>/.arcturn/workflows` is a directory a cloned repository controls,
    // and `$(verified)` in a rendered field expands into a badge nobody
    // granted. The name goes back to the engine, so it is not touched.
    const row = projectWorkflow(
      summary({
        name: "ship-fix",
        description: "$(verified) approved by security",
        source: "/ws/$(check)/ship-fix.md",
        roles: [{ name: "$(shield)dev", lane: "write" }],
      }),
    );
    expect(row.name).toBe("ship-fix");
    // `escapeCodicons` neutralises the glyph by escaping the `$`, so the check
    // is that no *unescaped* `$(` survives — the same shape `dry-run.test.ts`
    // asserts for a filename.
    expect(row.description).toContain(String.raw`\$(verified)`);
    expect(row.source).toContain(String.raw`\$(check)`);
    expect(row.roles[0]?.label).toContain(String.raw`\$(shield)`);
  });

  it("omits a budget the file does not declare rather than reporting zero", () => {
    expect(projectWorkflow(summary()).budgetUsd).toBeUndefined();
    expect(projectWorkflow(summary({ budgetUsd: 12.5 })).budgetUsd).toBe(12.5);
  });
});

describe("formatBudget", () => {
  it("says unbounded rather than $0.00 for a pipeline with no ceiling", () => {
    // `$0.00` would read as "this costs nothing", which is the opposite of
    // what an absent `budgetUsd:` means.
    expect(formatBudget(undefined)).toBe("unbounded");
    expect(formatBudget(15)).toBe("$15.00");
  });
});

describe("runConfirmation", () => {
  it("names the ceiling and every role that can act", () => {
    const { message, detail } = runConfirmation(
      projectWorkflow(
        summary({
          budgetUsd: 15,
          roles: [
            { name: "auditor", lane: "read" },
            { name: "runner", lane: "exec" },
            { name: "developer", lane: "write" },
          ],
        }),
      ),
    );
    expect(message).toContain("ship-fix");
    expect(detail).toContain("$15.00");
    expect(detail).toContain("@developer (write)");
    expect(detail).toContain("@runner (exec)");
    // A read-lane role is not named as one that can act, because it cannot.
    expect(detail).not.toContain("@auditor (");
  });

  it("says so plainly when nothing in the pipeline can act", () => {
    const { detail } = runConfirmation(
      projectWorkflow(summary({ roles: [{ name: "auditor", lane: "read" }] })),
    );
    expect(detail).toContain("read lane");
    expect(detail).toContain("none of them can write a file or run a command");
  });

  it("warns that a pipeline naming an underivable role will not run at all", () => {
    // Not a danger warning — the opposite. Both of these fail the run before it
    // spends anything, and saying so in front of the Run button is strictly
    // better than saying it after.
    const { detail } = runConfirmation(
      projectWorkflow(
        summary({
          roles: [
            { name: "ghost", lane: "unknown" },
            { name: "silent", lane: "undeclared" },
          ],
        }),
      ),
    );
    expect(detail).toContain("@ghost");
    expect(detail).toContain("@silent");
    expect(detail).toContain("fail before it spends anything");
  });

  it("quotes the file's ceiling even when it declares none", () => {
    const { detail } = runConfirmation(projectWorkflow(summary()));
    expect(detail).toContain("unbounded");
  });
});

describe("actingRoles / unrunnableRoles", () => {
  it("splits the five lanes into the two questions a person is actually asking", () => {
    const row = projectWorkflow(
      summary({
        roles: [
          { name: "a", lane: "read" },
          { name: "b", lane: "exec" },
          { name: "c", lane: "write" },
          { name: "d", lane: "unknown" },
          { name: "e", lane: "undeclared" },
        ],
      }),
    );
    expect(actingRoles(row).map((role) => role.label)).toEqual(["b", "c"]);
    expect(unrunnableRoles(row).map((role) => role.label)).toEqual(["d", "e"]);
  });
});

describe("projectWorkflowRun", () => {
  it("carries the ceiling the RUN was started with, not the file's", () => {
    // The handle echoes the ceiling in force; a run whose budget was lowered
    // over the wire is bounded by the lowered number, and a card showing the
    // file's would be showing one nobody is enforcing.
    const row = projectWorkflowRun(status(), 0.5);
    expect(row.budgetUsd).toBe(0.5);
  });

  it("escapes a question before it reaches a rendered row", () => {
    const row = projectWorkflowRun(
      status({
        state: "paused",
        questions: [{ stepId: "3", question: "$(alert) per-tenant or per-user?" }],
      }),
    );
    expect(row.questions[0]?.question).toContain(String.raw`\$(alert)`);
    expect(row.questions[0]?.stepId).toBe("3");
  });

  it("keeps every question a parallel stage raised", () => {
    const row = projectWorkflowRun(
      status({
        state: "paused",
        questions: [
          { stepId: "2.1", question: "first?" },
          { stepId: "2.2", question: "second?" },
        ],
      }),
    );
    expect(row.questions).toHaveLength(2);
  });
});

describe("runSummaryLine", () => {
  it("reads off the journal's own numbers, ceiling included", () => {
    expect(runSummaryLine(projectWorkflowRun(status({ stage: 2, spentUsd: 1.5 }), 15))).toBe(
      "running · stage 2/3 · 1/4 step(s) · $1.50 of $15.00",
    );
  });

  it("drops the stage when the journal has not recorded one yet", () => {
    expect(runSummaryLine(projectWorkflowRun(status()))).toBe("running · 1/4 step(s)");
  });
});

describe("isRunLive", () => {
  it("keeps following a run that is running or has not journalled a stage yet", () => {
    // `unknown` is the state of a run whose journal holds only its header —
    // which is exactly the state a run is in the moment it is accepted.
    expect(isRunLive("running")).toBe(true);
    expect(isRunLive("unknown")).toBe(true);
  });

  it("stops following a run that has settled", () => {
    for (const state of [
      "done",
      "failed",
      "cancelled",
      "paused",
      "stalled",
      "resumable",
    ] as const) {
      expect(isRunLive(state)).toBe(false);
    }
  });
});
