/**
 * Live model of a running org-workflow, for the TUI's compact status block.
 *
 * The permanent transcript (notices, and {@link formatWorkflowRun} at the end)
 * is the *durable* record; this is the *ephemeral* one — a per-stage/per-role
 * block that updates in place while a run is live and collapses to nothing the
 * instant the run ends, aborts or is interrupted, so no ghost row survives.
 *
 * Two streams feed the live view and they are kept apart on purpose:
 *
 * - {@link WorkflowActivity} folds the {@link WorkflowEvent} structure — stages,
 *   the roles and lanes in each, which step is running — into a
 *   {@link WorkflowRunView}. It never touches token or turn counting.
 * - the *progress* of the step running right now (turns, tokens, current tool)
 *   already flows through the existing {@link SubagentTracker}: every step
 *   republishes its child agent as a namespaced sub-agent, so its live figures
 *   are read back out of `SubagentTracker.active` by correlating on the step's
 *   {@link workflowStepAgentId}. There is deliberately no second progress meter.
 *
 * @packageDocumentation
 */

import type {
  WorkflowDispatch,
  WorkflowEvent,
  WorkflowStageMember,
  WorkflowStepStatus,
} from "../workflow.js";
import { workflowStepAgentId } from "../workflow.js";

/** How a step stands in the live view. `pending` is unique to the live model. */
export type WorkflowStepPhase = "pending" | "running" | WorkflowStepStatus;

/** One step as the live block draws it. */
export interface WorkflowStepView {
  readonly id: string;
  readonly stageIndex: number;
  readonly branchIndex: number;
  /** The `@role` the step dispatches to, when it named one. */
  readonly role?: string;
  /** Which of the three lanes runs it. */
  readonly lane: WorkflowDispatch;
  /** Resolved model display name, when the step carried a `[tag]`. */
  readonly model?: string;
  readonly phase: WorkflowStepPhase;
  /** Wall clock at which the step started, once it has. */
  readonly startedAt?: number;
  /** Wall clock at which the step ended, once it has. */
  readonly endedAt?: number;
  /**
   * The id the step's child agent is republished under — the key that ties
   * this row to a {@link SubagentTracker} row for its live tokens/tool.
   */
  readonly agentId: string;
  /** Tokens the finished step reported; `0` while it is still running. */
  readonly tokens: number;
  /** The patch record's status, once the step ended on a worktree lane. */
  readonly recordStatus?: string;
}

/** One stage as the live block draws it. */
export interface WorkflowStageView {
  readonly index: number;
  readonly parallel: boolean;
  readonly steps: readonly WorkflowStepView[];
  /** Set once the stage has ended. */
  readonly status?: WorkflowStepStatus;
}

/** The whole run as the live block draws it. */
export interface WorkflowRunView {
  readonly workflow: string;
  readonly startedAt: number;
  readonly totalSteps: number;
  readonly stages: readonly WorkflowStageView[];
  /** The stage a step is running in right now, or the newest started stage. */
  readonly activeStageIndex?: number;
  /** Steps that have reached a terminal phase. */
  readonly doneSteps: number;
}

/** Internal mutable step. */
interface MutableStep {
  id: string;
  stageIndex: number;
  branchIndex: number;
  role?: string;
  lane: WorkflowDispatch;
  model?: string;
  phase: WorkflowStepPhase;
  startedAt?: number;
  endedAt?: number;
  agentId: string;
  tokens: number;
  recordStatus?: string;
}

/** Internal mutable stage. */
interface MutableStage {
  index: number;
  parallel: boolean;
  steps: MutableStep[];
  status?: WorkflowStepStatus;
}

/** Internal mutable run. */
interface MutableRun {
  workflow: string;
  running: boolean;
  startedAt: number;
  totalSteps: number;
  stages: Map<number, MutableStage>;
  activeStageIndex?: number;
}

const TERMINAL: ReadonlySet<WorkflowStepPhase> = new Set<WorkflowStepPhase>([
  "done",
  "failed",
  "skipped",
  "cancelled",
  // The human-question gate: a paused step has settled for this run (it is
  // waiting on a person, not on the model), so it counts as done-for-now rather
  // than showing as perpetually running.
  "paused",
]);

/** Build a pending step row from a stage member, before it has started. */
function memberStep(stageIndex: number, member: WorkflowStageMember): MutableStep {
  return {
    id: `${stageIndex}.${member.branchIndex + 1}`,
    stageIndex,
    branchIndex: member.branchIndex,
    ...(member.agent === undefined ? {} : { role: member.agent }),
    lane: member.lane,
    ...(member.model === undefined ? {} : { model: member.model }),
    phase: "pending",
    agentId: workflowStepAgentId(`${stageIndex}.${member.branchIndex + 1}`, member.agent),
    tokens: 0,
  };
}

/**
 * Folds a workflow's {@link WorkflowEvent} stream into a live {@link WorkflowRunView}.
 *
 * Feed it every event the run emits. It owns *structure* only; the live
 * per-step progress figures come from the {@link SubagentTracker} at render
 * time. On {@link WorkflowEvent} `workflowEnd`, or {@link reset}, the view
 * collapses to `undefined` so the block leaves no ghost rows behind.
 */
export class WorkflowActivity {
  #run: MutableRun | undefined;
  readonly #now: () => number;

  /**
   * @param now - Clock, injectable for tests.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Whether a run is live right now (i.e. the block should draw). */
  get running(): boolean {
    return this.#run?.running ?? false;
  }

  /** Drop the run, so the block draws nothing. */
  reset(): void {
    this.#run = undefined;
  }

  /**
   * Fold one workflow event into the live view.
   *
   * @param event - A {@link WorkflowEvent} from the run.
   */
  handle(event: WorkflowEvent): void {
    switch (event.type) {
      case "workflowStart":
        this.#run = {
          workflow: event.workflow,
          running: true,
          startedAt: this.#now(),
          totalSteps: event.totalSteps,
          stages: new Map(),
        };
        break;
      case "stageStart": {
        const run = this.#run;
        if (!run) break;
        run.stages.set(event.stageIndex, {
          index: event.stageIndex,
          parallel: event.parallel,
          steps: event.members.map((member) => memberStep(event.stageIndex, member)),
        });
        run.activeStageIndex = event.stageIndex;
        break;
      }
      case "stepStart": {
        const step = this.#step(event.stageIndex, event.id, event.branchIndex);
        if (!step) break;
        step.phase = "running";
        step.startedAt = this.#now();
        step.id = event.id;
        step.agentId = workflowStepAgentId(event.id, event.agent);
        if (event.agent !== undefined) step.role = event.agent;
        step.lane = event.lane;
        if (event.model !== undefined) step.model = event.model;
        if (this.#run) this.#run.activeStageIndex = event.stageIndex;
        break;
      }
      case "stepEnd": {
        const result = event.result;
        const step = this.#step(result.stageIndex, result.id, result.branchIndex);
        if (!step) break;
        step.phase = result.status;
        step.endedAt = this.#now();
        step.tokens = result.usage.outputTokens;
        if (result.record?.status !== undefined) step.recordStatus = result.record.status;
        break;
      }
      case "stageEnd": {
        const stage = this.#run?.stages.get(event.stageIndex);
        if (stage) stage.status = event.status;
        break;
      }
      case "workflowEnd":
        if (this.#run) this.#run.running = false;
        break;
      default:
        break;
    }
  }

  /**
   * An immutable snapshot for the renderer, or `undefined` when nothing is live.
   *
   * Returns `undefined` the moment the run ends so the block clears cleanly.
   */
  snapshot(): WorkflowRunView | undefined {
    const run = this.#run;
    if (!run?.running) return undefined;
    const stages = [...run.stages.values()]
      .sort((a, b) => a.index - b.index)
      .map((stage) => ({
        index: stage.index,
        parallel: stage.parallel,
        steps: stage.steps.map((step) => ({ ...step })),
        ...(stage.status === undefined ? {} : { status: stage.status }),
      }));
    const doneSteps = stages.reduce(
      (sum, stage) => sum + stage.steps.filter((step) => TERMINAL.has(step.phase)).length,
      0,
    );
    return {
      workflow: run.workflow,
      startedAt: run.startedAt,
      totalSteps: run.totalSteps,
      stages,
      ...(run.activeStageIndex === undefined ? {} : { activeStageIndex: run.activeStageIndex }),
      doneSteps,
    };
  }

  /**
   * Agent ids of the steps running right now.
   *
   * The app drops these from the generic sub-agent rows so a workflow step is
   * shown once — in the structured block — not twice.
   */
  runningAgentIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    if (!this.#run?.running) return ids;
    for (const stage of this.#run.stages.values()) {
      for (const step of stage.steps) {
        if (step.phase === "running") ids.add(step.agentId);
      }
    }
    return ids;
  }

  /** Find a step by stage + id, falling back to branch position. */
  #step(stageIndex: number, id: string, branchIndex: number): MutableStep | undefined {
    const stage = this.#run?.stages.get(stageIndex);
    if (!stage) return undefined;
    return (
      stage.steps.find((step) => step.id === id) ??
      stage.steps.find((step) => step.branchIndex === branchIndex)
    );
  }
}
