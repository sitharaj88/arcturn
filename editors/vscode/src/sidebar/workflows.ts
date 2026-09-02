/**
 * The workflow surface, as pure data.
 *
 * A workflow is a markdown file whose numbered list is real control flow: each
 * stage runs in order, an `@role` dispatches to a named agent with its own
 * tools and its own **lane**, `budgetUsd` caps what the whole run may spend,
 * and an `ORG-ASK:` line stops the pipeline and waits for a person. All of it
 * was reachable only from a terminal until `listWorkflows`, `runWorkflow`,
 * `workflowStatus` and `resumeWorkflow` existed.
 *
 * A sibling of `dry-run.ts`, `webview-models.ts` and `webview-sessions.ts` —
 * plain functions over plain data, no `vscode` import, no DOM — so the three
 * judgements that matter here are testable without a window:
 *
 * 1. **What a catalog row says a pipeline will do.** Its stages, its ceiling,
 *    and the lane every role runs on. The lane is the engine's derived value,
 *    carried through unchanged: this module never infers one and never softens
 *    `"unknown"` or `"undeclared"` into `"read"`, because those two mean *no
 *    one can say*, and a panel that rendered them as "read" would be telling a
 *    person a pipeline is harmless on the strength of a guess.
 * 2. **What the run-confirmation modal names.** Running a workflow spends real
 *    money and a write-lane role's patch lands in the user's checkout the
 *    moment its step succeeds. So the modal has the two jobs the discard modal
 *    has (`dry-run.ts`): say what this will do, and say what it will cost.
 * 3. **What a paused run asks.** An `ORG-ASK:` is a question a person answers,
 *    and the panel's job is to show it and carry the answer back — never to
 *    answer it, and never to summarise it.
 */

import type {
  ServerCapabilities,
  WorkflowRoleLane,
  WorkflowRunStatus,
  WorkflowSummary,
} from "../serve/engine.js";
import { escapeCodicons } from "./picker.js";

/** Button: start the pipeline, spending real money. */
export const RUN_WORKFLOW = "Run";

/** Where the workflow surface stands. */
export type WorkflowStatus =
  /** Nothing asked yet. */
  | "loading"
  /** The engine answered. `workflows` may still be empty — this workspace has none. */
  | "ready"
  /**
   * This engine has no `listWorkflows` at all (the verb resolved `undefined`).
   * Deliberately not folded into `"ready"` with an empty list, on `dry-run.ts`'s
   * terms: "this workspace defines no pipelines" and "this engine cannot tell
   * me" are opposite pieces of news, and only one of them means the panel
   * should offer no workflow affordance at all.
   */
  | "unavailable";

/** One role a pipeline dispatches to, ready to render as a chip. */
export interface WorkflowRoleRow {
  /** Role name, escaped — it reaches a rendered chip and a modal. */
  label: string;
  /** The lane the **engine** derived. Never inferred here. */
  lane: WorkflowRoleLane;
}

/** One discovered workflow as the panel sees it. */
export interface WorkflowOption {
  /** Identity: what `runWorkflow` is sent. Unescaped. */
  name: string;
  /** What to show. Escaped. */
  label: string;
  /** One line of help, escaped. `""` when the file set none. */
  description: string;
  /** The file it came from, escaped, so a person can tell whose pipeline this is. */
  source: string;
  stages: number;
  steps: number;
  /** The file's own ceiling, when it declares one. */
  budgetUsd?: number;
  /** Per-step deadline, when the file sets one. */
  stepTimeoutMs?: number;
  roles: WorkflowRoleRow[];
}

/** What a `raise <n>` reply would need to beat, for the ceiling this park is shaped like. */
export interface WorkflowRaiseInfo {
  /** `"turns"` for a step that hit a role's `maxTurns`; `"budget"` for a stage-boundary ask. */
  kind: "turns" | "budget";
  /** The ceiling in force, in its own unit, when the engine reported one. */
  current?: number;
}

/** One `ORG-ASK:` a run is waiting on. */
export interface WorkflowQuestionRow {
  /** The step that asked. */
  stepId: string;
  /** The question, escaped — it is model-written text heading for a rendered row. */
  question: string;
  /**
   * What the failed step's model emitted on its last turn, for a step-failure
   * park — escaped on `question`'s own terms. Absent for an ordinary
   * `ORG-ASK` and for a budget ask, which has no "last turn" of its own.
   */
  diagnosis?: string;
  /**
   * Whether a "Raise ceiling…" action is meaningful for THIS park, and what a
   * typed number needs to exceed. Presence alone does not mean the engine
   * will honour one — that is {@link WorkflowView.capabilities}`.ceilingRaise`
   * — only that this park is the shape a raise applies to.
   */
  raise?: WorkflowRaiseInfo;
}

/** The run the panel is currently following. */
export interface WorkflowRunRow {
  runId: string;
  /** The workflow's name, escaped. */
  workflow: string;
  state: WorkflowRunStatus["state"];
  stage?: number;
  stageCount: number;
  stepsDone: number;
  stepsTotal: number;
  spentUsd?: number;
  /** The ceiling in force, echoed by the run handle. */
  budgetUsd?: number;
  questions: WorkflowQuestionRow[];
}

/** What the panel renders. */
export interface WorkflowView {
  status: WorkflowStatus;
  /** The catalog. Empty unless `status` is `"ready"`. */
  workflows: WorkflowOption[];
  /** The run being followed, when one is. */
  run?: WorkflowRunRow;
  /** Why the last run or resume did not take, when it did not. Escaped. */
  note?: string;
  /**
   * What this engine advertised on its `authenticate` handshake — carried
   * straight from `EngineSession.capabilities`. `undefined` reads exactly
   * like `{}`: no capability may be assumed on, so the "Raise ceiling…"
   * action only ever appears when `ceilingRaise` is explicitly `true`.
   */
  capabilities?: ServerCapabilities;
}

/** The view before anything has been asked. */
export const EMPTY_WORKFLOW_VIEW: WorkflowView = { status: "loading", workflows: [] };

/**
 * Project one catalog row into a panel row.
 *
 * Rebuilt field by field rather than spread, and **escaped**, for the reason
 * `projectPendingChange` and `projectCommandOption` are: a workflow lives in
 * `<cwd>/.arcturn/workflows`, a directory a cloned repository controls, and
 * every string here reaches a rendered row and a VS Code modal, where
 * `$(name)` expands into a real glyph. `name` stays unescaped because it is
 * identity — it goes back to the engine, not to a renderer.
 *
 * The lane is copied, never computed. This module has no role files and no
 * classifier; the engine derived it from the role's declared `tools:` with the
 * same function the dispatcher calls, and a second derivation here would be a
 * second answer to the one question this row exists to answer.
 *
 * @param summary - One `listWorkflows` row.
 */
export function projectWorkflow(summary: WorkflowSummary): WorkflowOption {
  return {
    name: summary.name,
    label: escapeCodicons(summary.name),
    description: escapeCodicons(summary.description),
    source: escapeCodicons(summary.source),
    stages: summary.stages,
    steps: summary.steps,
    roles: summary.roles.map((role) => ({
      label: escapeCodicons(role.name),
      lane: role.lane,
    })),
    ...(summary.budgetUsd === undefined ? {} : { budgetUsd: summary.budgetUsd }),
    ...(summary.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: summary.stepTimeoutMs }),
  };
}

/** Project one `workflowStatus` row into the card's model. */
export function projectWorkflowRun(run: WorkflowRunStatus, budgetUsd?: number): WorkflowRunRow {
  return {
    runId: run.runId,
    workflow: escapeCodicons(run.workflow),
    state: run.state,
    stageCount: run.stageCount,
    stepsDone: run.stepsDone,
    stepsTotal: run.stepsTotal,
    questions: run.questions.map((question) => ({
      stepId: question.stepId,
      question: escapeCodicons(question.question),
      ...(question.diagnosis === undefined
        ? {}
        : { diagnosis: escapeCodicons(question.diagnosis) }),
      ...(question.raise === undefined ? {} : { raise: question.raise }),
    })),
    ...(run.stage === undefined ? {} : { stage: run.stage }),
    ...(run.spentUsd === undefined ? {} : { spentUsd: run.spentUsd }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
  };
}

/** `$12.50`, or `unbounded` for a pipeline that declares no ceiling. */
export function formatBudget(budgetUsd: number | undefined): string {
  return budgetUsd === undefined ? "unbounded" : `$${budgetUsd.toFixed(2)}`;
}

/**
 * The roles that can change something, in the order they will run.
 *
 * Exec and write are grouped because the modal's question is "does this
 * pipeline get to *act*", and both lanes do: an exec role runs arbitrary
 * commands (in a worktree whose diff is discarded), and a write role's patch
 * is applied to the real checkout. A read role can do neither by construction.
 */
export function actingRoles(workflow: WorkflowOption): WorkflowRoleRow[] {
  return workflow.roles.filter((role) => role.lane === "exec" || role.lane === "write");
}

/**
 * The roles whose lane the engine could not derive.
 *
 * Both kinds fail the run *before it spends anything* — an unknown role fails
 * pre-flight, an undeclared `tools:` is refused at dispatch — so this is not a
 * warning about danger, it is a warning that the pipeline will not run. Saying
 * so before the modal's Run button is pressed is strictly better than saying it
 * afterwards.
 */
export function unrunnableRoles(workflow: WorkflowOption): WorkflowRoleRow[] {
  return workflow.roles.filter((role) => role.lane === "unknown" || role.lane === "undeclared");
}

/**
 * What the confirmation modal says before a pipeline starts.
 *
 * Three facts, in the order that decides whether a person presses Run: what
 * this will cost at most, whether anything in it can touch their files or run
 * commands, and whether it can run at all. None of them is inferable from the
 * pipeline's name, which is exactly why the modal exists — `runWorkflow` is
 * the one control on this surface that spends money *and* can rewrite a
 * checkout, and a webview button is not a confirmation (`dialog.ts`).
 *
 * @param workflow - The pipeline about to run.
 */
export function runConfirmation(workflow: WorkflowOption): { message: string; detail: string } {
  const acting = actingRoles(workflow);
  const broken = unrunnableRoles(workflow);
  const lines = [
    `${workflow.stages} stage(s), ${workflow.steps} step(s). Spend ceiling: ${formatBudget(workflow.budgetUsd)}.`,
  ];
  if (acting.length === 0) {
    lines.push(
      "Every role in this pipeline is on the read lane: none of them can write a file or run a command.",
    );
  } else {
    const named = acting.map((role) => `@${role.label} (${role.lane})`).join(", ");
    lines.push(
      `${named} can act: a write-lane role's patch is applied to your checkout as soon as its ` +
        "step succeeds, and an exec-lane role runs commands in a throwaway worktree.",
    );
  }
  if (broken.length > 0) {
    lines.push(
      `${broken.map((role) => `@${role.label}`).join(", ")} cannot be dispatched on this engine ` +
        "(no such role, or the role declares no tools:), so this run will fail before it spends anything.",
    );
  }
  return { message: `Run the workflow "${workflow.label}"?`, detail: lines.join("\n\n") };
}

/**
 * The card's one-line progress sentence.
 *
 * Deliberately built from the *journal's* numbers rather than from counted
 * notices: the notices are narration and the journal is the record, and a card
 * that tallied its own would drift from `/workflow status` in a terminal
 * looking at the same run.
 */
export function runSummaryLine(run: WorkflowRunRow): string {
  const where =
    run.stage === undefined
      ? `${run.stepsDone}/${run.stepsTotal} step(s)`
      : `stage ${run.stage}/${run.stageCount} · ${run.stepsDone}/${run.stepsTotal} step(s)`;
  const spend = run.spentUsd === undefined ? "" : ` · $${run.spentUsd.toFixed(2)}`;
  const ceiling = run.budgetUsd === undefined ? "" : ` of ${formatBudget(run.budgetUsd)}`;
  return `${run.state} · ${where}${spend}${ceiling}`;
}

/** Whether a run is still moving, i.e. whether the card should keep refreshing. */
export function isRunLive(state: WorkflowRunStatus["state"]): boolean {
  return state === "running" || state === "unknown";
}
