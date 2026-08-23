/**
 * Adversarial review repro — workflow ↔ subagent/permission seam.
 *
 * `/workflow` (new) calls `ArcturnRuntime.createSubagent` DIRECTLY, so it is
 * reachable in `plan` mode — unlike the `subagent` tool, which the permission
 * engine denies in plan mode. Child agents are built with
 * `mode: yolo ? "yolo" : "default"`, which is a WIDENING of a plan-mode parent.
 *
 * Regression tests from the wave-3 adversarial review: each `it` states the
 * behaviour a correct implementation must have. They failed against the
 * pre-fix tree (see docs/integration-notes) and must stay green.
 */

import type { AgentDef } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { CommandUi } from "./commands.js";
import type { ArcturnRuntime } from "./runtime.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";
import { createWorkflowCommands, parseWorkflow, type Workflow } from "./workflow.js";

describe("WORKFLOW: step agents run wider than a plan-mode parent", () => {
  it("a child built while the parent is in plan mode must not be in default mode", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    runtime.setPermissionMode("plan");

    const child = runtime.createSubagent("workflow step 1", {
      name: "workflow-step-1",
      description: "Workflow step 1",
      systemPrompt: "do the step",
      source: "<workflow>",
    });

    // Plan mode is "read-only, no prompts". The child must not silently
    // relax that to "default" (ask-the-user) just by being delegated.
    expect(child.permissionMode).toBe("plan");
    // ...and network egress must not become reachable from plan mode.
    expect(child.tools.map((t) => t.definition.name)).not.toContain("fetch");
  });
});

describe("WORKFLOW: /workflow is reachable in plan mode and spawns wider children", () => {
  it("running /workflow in plan mode must not spawn a default-mode child agent", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [{ text: "step output" }]);
    runtime.setPermissionMode("plan");

    const modes: string[] = [];
    const host = {
      paths: runtime.paths,
      createSubagent: (task: string, def?: AgentDef) => {
        const child = runtime.createSubagent(task, def);
        modes.push(child.permissionMode);
        return child;
      },
    } as unknown as ArcturnRuntime;

    const workflow = parseWorkflow("---\nname: build\n---\n1. do the thing\n", {
      name: "build",
    }) as Workflow;
    const [command] = createWorkflowCommands({ discover: async () => [workflow] });

    const ui = {
      print: () => {},
      notice: () => {},
      select: async () => undefined,
      setInput: () => {},
      clear: () => {},
      exit: () => {},
    } as unknown as CommandUi;

    await command?.run({
      runtime: host,
      ui,
      args: "build",
      commands: undefined as never,
    });

    // The slash command is not permission-gated at all, so this runs; the
    // child it spawns must at least stay inside the parent's plan mode.
    expect(modes).toEqual(["plan"]);
  });
});
