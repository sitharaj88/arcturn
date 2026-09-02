/**
 * The serve path's workflows: `listWorkflows`, `runWorkflow`, `workflowStatus`
 * and `resumeWorkflow`, answered by the engine the terminal's `/workflow`
 * already drives.
 *
 * Every one of those verbs reaches the same `workflow.ts` the slash command
 * does — the same `discoverWorkflows`, the same `parseWorkflow`, the same
 * `roleDispatch` lane classifier, the same `runWorkflow` loop, the same
 * `createRuntimeRunStep`, the same `createRuntimeWriteLane`, the same run
 * journal under `~/.arcturn/workflow-runs`. Nothing here re-implements a step,
 * a lane, a budget check or a journal line. That is not tidiness: a second
 * workflow engine behind the socket would derive a different lane for the same
 * role file and write a second journal into the same directory, and the panel
 * would then be showing a pipeline the terminal has never run.
 *
 * Split out of `serve.ts` for the reason `serve-commands.ts` and `serve-mcp.ts`
 * were: `serve.ts` is the wiring, and the decisions below — what a catalog row
 * says, what a budget request may do, what a run publishes onto a session's
 * stream — are decisions, not wiring.
 *
 * ## Three rules this module keeps
 *
 * **1. The lane shown is the lane derived.** {@link workflowSummary} reads a
 * role's lane from `roleDispatch`, the function the dispatcher itself calls,
 * and never from the role's prose. A role the host has not loaded is reported
 * `"unknown"` and one with no `tools:` line is `"undeclared"` — the two ways a
 * lane is genuinely unknowable — rather than rounded down to `"read"`, which
 * would tell a person a pipeline is harmless when the truth is that nobody can
 * say.
 *
 * **2. A wire budget may only lower the file's.** {@link resolveRunBudget} is
 * the whole of that rule, and it *refuses* rather than clamping. The workflow
 * file is the authority; the ceiling a client renders has to be the ceiling the
 * engine enforces, and `listWorkflows` already told the client what the file
 * says, so the refusal is actionable.
 *
 * **3. The permission posture only ever narrows.** A served run inherits the
 * engine's own mode — which is exactly what a person at a terminal in this
 * workspace would get — and additionally refuses both worktree lanes when the
 * *calling session* is in `plan`. A remote caller can set their session's mode
 * (`setPermissionMode`) but not the engine's, so that composition can only ever
 * be stricter than a local run, never looser.
 *
 * ### One thing this does not do, stated rather than half-built
 *
 * A workflow step's permission asks go to the **runtime's** requester, not to
 * the calling session's. `arcturn serve` installs no requester on the runtime
 * (each *session* agent gets its own, at `SessionHost.#register`), so an ask
 * raised by a step fails closed and denies — see `ArcturnRuntime.#ask`. The
 * practical consequence is that a write- or exec-lane role reaches its tools
 * over the wire only on an engine already running in `yolo`, exactly as it
 * would for a `--print` run. Routing those asks to the calling session would
 * mean mutating the runtime's shared requester slot for the duration of a run,
 * which races every other session the same engine is hosting; the honest
 * failure is better than the racy feature, and it errs closed.
 */

import { join } from "node:path";
import { errorText } from "@arcturn/core";
import type { WorkflowResult, WorkflowService } from "@arcturn/server";
import type {
  AgentEvent,
  PermissionMode,
  WorkflowRoleLane,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowSummary,
} from "@arcturn/types";
import type { AgentDef } from "./agents.js";
import { loadOrgMemoryInjector, orgMemoryPath } from "./org-memory.js";
import { sanitizeDescription } from "./skill-tool.js";
import {
  type AgentRoleResolver,
  budgetWireRaiseRefusal,
  createPatchVerifier,
  createRunId,
  createRuntimeRunStep,
  createRuntimeWriteLane,
  DEFAULT_MAX_STEP_RETRIES,
  DEFAULT_WORKFLOW_STEP_TIMEOUT_MS,
  discoverWorkflows,
  type ModelTagResolver,
  parseBudgetRaiseAnswer,
  pruneWorkflowRuns,
  reportWorkflowEvent,
  roleDispatch,
  runWorkflow as runWorkflowEngine,
  turnWireRaiseRefusal,
  type Workflow,
  type WorkflowCommandRuntime,
  type WorkflowRunResult,
  type WriteLaneHost,
  workflowPostureNotices,
} from "./workflow.js";
import {
  BUDGET_ACK_ANSWER,
  BUDGET_ASK_STEP_ID,
  type BudgetAskAudience,
  budgetAskQuestion,
  buildResumeState,
  createFileRunJournal,
  describeLastTurn,
  type JournalLine,
  RUN_JOURNAL_SCHEMA_VERSION,
  readJournalLines,
  STEP_ABANDON_ANSWER,
  STEP_RETRY_ANSWER,
  stepFailAskQuestion,
  writeManifest,
} from "./workflow-run.js";
import {
  deriveRunState,
  type JournalRun,
  readWorkflowRun,
  readWorkflowRuns,
  summariseRun,
} from "./workflow-status.js";

/**
 * The slice of `ArcturnRuntime` this module needs, on top of what
 * `ServableRuntime` already carries.
 *
 * Every member is optional so a stub runtime (`serve.ts`'s tests, an embedder
 * that never loaded an agent catalog) still satisfies the shape and simply gets
 * no workflow engine — which is the honest answer for such a host, and the one
 * `SessionHost` renders as "this engine has no workflow support". A real
 * `ArcturnRuntime` satisfies all of them structurally, with nothing added to
 * `runtime.ts`.
 */
export interface ServableWorkflowRuntime {
  /** Where workflow files and run journals live. */
  readonly paths?: { readonly home: string; readonly project: string };
  /** The user's checkout, for worktree hygiene. */
  readonly cwd?: string;
  /** The markdown agents a `@role` step resolves against. */
  readonly agents?: ReadonlyMap<string, AgentDef>;
  /** The engine's own live permission mode. */
  readonly permissionMode?: PermissionMode;
  /** Builds the child agent every read-lane step runs as. */
  createSubagent?: WorkflowCommandRuntime["createSubagent"];
}

/**
 * Options for {@link createServeWorkflows}, all injectable for tests.
 *
 * `resolveModelTag` is the same resolver `createCommandRegistry` hands
 * `createWorkflowCommands`, threaded here rather than re-derived: a `[tag]` has
 * to mean the same model in a panel that it means in a terminal, and two
 * resolvers reading two catalogs is how that stops being true.
 */
export interface ServeWorkflowOptions {
  /** Resolves a step's `[tag]` against the model catalog `/model` uses. */
  resolveModelTag?: ModelTagResolver;
  /** Discovery override, for tests. */
  discover?: typeof discoverWorkflows;
  /** Clock injection, for tests. */
  now?: () => number;
  /**
   * `arcturn serve --allow-ceiling-raise`. Off by default, on the seam's own
   * contract: nothing on the wire may raise a ceiling unless the host running
   * `serve` opted in deliberately, because a raise spends the operator's own
   * money or turns.
   *
   * ONE flag, threaded to every place the contract has a say — `runWorkflow`'s
   * engine call gets it as `allowBudgetRaise`, which decides both whether a
   * `raise <n>` reply is honoured and how the budget/step-failure questions are
   * *worded* (never advertise a reply this origin will only be refused for);
   * `resume`'s own pre-flight refusal is gated by the same flag, so the two can
   * never disagree about what this server allows.
   */
  allowBudgetRaise?: boolean;
}

/**
 * How many characters of a finished run's product are published onto the
 * session stream.
 *
 * The terminal prints the whole thing; a socket cannot, because one `notice`
 * frame is one WebSocket message and `ws-server.ts` treats a megabyte of
 * buffered output as backpressure. 64 KiB is far past any review packet a
 * pipeline actually produces and a sixteenth of that threshold, and what is cut
 * is *said* to be cut rather than silently dropped — the run's full text is
 * still in the journal directory the run id names.
 */
export const WORKFLOW_RESULT_TEXT_MAX_CHARS = 64 * 1024;

/**
 * Permission modes from strictest to loosest.
 *
 * A total order is what makes "narrow to the stricter of two" a decision rather
 * than a guess. `plan` is strictest because it grants no writes and no egress;
 * `yolo` is loosest because it approves everything.
 */
const MODE_STRICTNESS: readonly PermissionMode[] = ["plan", "default", "acceptEdits", "yolo"];

/**
 * The stricter of two permission modes.
 *
 * Used to compose the calling session's mode with the engine's own, and it only
 * ever composes downward: a remote caller can put *their session* in `plan` and
 * have a pipeline refuse its worktree lanes, and can never do the reverse,
 * because widening would mean a mode a remote caller set granting authority the
 * engine's own mode does not.
 *
 * @param a - One mode.
 * @param b - The other.
 */
export function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  const rankA = MODE_STRICTNESS.indexOf(a);
  const rankB = MODE_STRICTNESS.indexOf(b);
  // An unrecognised mode ranks -1, i.e. stricter than everything — the safe
  // direction for a value this function does not understand.
  return rankA <= rankB ? a : b;
}

/** Roots a workflow may live in, lowest precedence first — `workflow.ts`'s own order. */
function workflowRoots(paths: { home: string; project: string }): string[] {
  return [...new Set([join(paths.home, "workflows"), join(paths.project, "workflows")])];
}

/**
 * The shape a run id may have: what {@link createRunId} mints, and nothing else.
 *
 * A run id becomes a **path** — `join(runsRoot, runId)` names the directory a
 * journal is read from and a resumed run appends to — and it arrives from a
 * client. Without this, `workflowStatus("../../../etc")` would ask the engine to
 * read `/etc/journal.jsonl`: a token holder already has a shell, so this is not
 * the wall that keeps them out, but a verb that joins client strings onto a root
 * without checking them is how a *later* caller with less authority inherits a
 * traversal. The check is on the shape rather than on the resolved path, because
 * the shape is something this module actually owns: ids are minted here, and
 * `20260825T134500-a1b2c3d4` has no reason to contain a separator or a dot
 * segment.
 *
 * Refusing rather than sanitising, on the rule the rest of this file keeps: a
 * silently rewritten id would read a *different* run than the caller named.
 */
const RUN_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether a client-supplied run id may be joined onto the runs root. */
export function isSafeRunId(runId: string): boolean {
  if (runId.length > 200 || !RUN_ID_SHAPE.test(runId)) return false;
  // `.` and `..` pass the charset above and are exactly what it exists to stop.
  return runId !== "." && runId !== "..";
}

/**
 * Derive one role's lane, or say why it cannot be derived.
 *
 * The three real answers come from {@link roleDispatch} — the same call the
 * dispatcher makes — and the two others are the honest shapes of "unknowable":
 * a role nobody loaded, and a role that declared no tools. Neither of those
 * runs; both fail the pipeline before a token is spent (`unknownRoleError`,
 * `undeclaredToolsError`), so reporting either as `"read"` would describe a
 * pipeline that cannot run as one that runs harmlessly.
 *
 * @param name - The role name written after `@`.
 * @param resolve - The host's role catalog.
 */
export function deriveRoleLane(name: string, resolve: AgentRoleResolver): WorkflowRoleLane {
  const def = resolve(name);
  if (!def) return "unknown";
  if (def.tools === undefined) return "undeclared";
  return roleDispatch(def);
}

/**
 * Project one parsed workflow into its catalog row.
 *
 * Roles are listed in first-appearance order and deduplicated: a role used in
 * three stages is one chip, and the reader meets them in the order the run
 * will — the same ordering {@link workflowPostureNotices} uses for its warning,
 * for the same reason.
 *
 * @param workflow - The parsed pipeline.
 * @param resolve - The host's role catalog, for lane derivation.
 */
export function workflowSummary(workflow: Workflow, resolve: AgentRoleResolver): WorkflowSummary {
  const roles: WorkflowSummary["roles"] = [];
  const seen = new Set<string>();
  for (const stage of workflow.stages) {
    for (const step of stage.steps) {
      if (step.agent === undefined || seen.has(step.agent)) continue;
      seen.add(step.agent);
      roles.push({ name: step.agent, lane: deriveRoleLane(step.agent, resolve) });
    }
  }
  return {
    name: workflow.name,
    // Untrusted markdown from a directory a cloned repository controls, landing
    // in a menu a person reads and clicks — the same treatment a skill
    // description gets on this wire, from the same function.
    description: sanitizeDescription(workflow.description),
    source: workflow.source,
    stages: workflow.stages.length,
    steps: workflow.stages.reduce((total, stage) => total + stage.steps.length, 0),
    roles,
    ...(workflow.budgetUsd === undefined ? {} : { budgetUsd: workflow.budgetUsd }),
    ...(workflow.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: workflow.stepTimeoutMs }),
  };
}

/**
 * Settle the run's USD ceiling: the file's own, or a smaller one a caller asked
 * for.
 *
 * **Refuses rather than clamps**, and names both numbers. Three things are
 * true at once here and the refusal is what keeps them consistent: the file is
 * the authority, `listWorkflows` already published the file's number, and the
 * handle echoes the ceiling in force — so a client that asked for more is told
 * exactly what it may ask for instead, and no client ever renders a ceiling the
 * engine is not enforcing.
 *
 * A file with no ceiling accepts any positive request, because bounding an
 * unbounded run is a narrowing too. `0` and negatives never reach here: the
 * wire validator refuses them, because `shouldAbortForCost` reads `0` as
 * "disabled" and a "ceiling" that disables the guard is a widening wearing a
 * narrowing's clothes.
 *
 * @param workflow - The parsed pipeline, for its own `budgetUsd:`.
 * @param requested - The caller's ceiling, when it sent one.
 */
export function resolveRunBudget(
  workflow: Workflow,
  requested: number | undefined,
): WorkflowResult<number | undefined> {
  if (requested === undefined) return { ok: true, value: workflow.budgetUsd };
  if (!(requested > 0) || !Number.isFinite(requested)) {
    return {
      ok: false,
      error:
        `A workflow run budget must be a positive number of US dollars; got ` +
        `$${String(requested)}. Zero disables the cost guard, which would widen this run ` +
        `rather than bound it.`,
    };
  }
  const own = workflow.budgetUsd;
  if (own !== undefined && own > 0 && requested > own) {
    return {
      ok: false,
      error:
        `Workflow "${workflow.name}" sets budgetUsd: ${own.toFixed(2)} in its own frontmatter, ` +
        `and a run started over the wire may only lower that ceiling — $${requested.toFixed(2)} ` +
        `would raise it. Ask for $${own.toFixed(2)} or less, or edit ${workflow.source}.`,
    };
  }
  return { ok: true, value: requested };
}

/**
 * How much of a parked step's `describeLastTurn()` reaches a wire client.
 *
 * Wider than {@link INDEX_LINE_MAX_CHARS} on purpose: a diagnosis is read once,
 * at a park, by a person deciding whether to retry or raise a ceiling — not
 * embedded in a prompt on every request the way a skill index line is. Still
 * one line, on `sanitizeDescription`'s own terms: `describeLastTurn` writes a
 * second line only when the turn was silent, and that reasoning-tail line is
 * exactly what a first-line cap is for dropping — the facts line survives, the
 * scrubbed reasoning excerpt does not travel over the wire at all.
 */
const DIAGNOSIS_MAX_CHARS = 240;

/**
 * What a client needs to know beyond the question's own text: whether the
 * failed step left a diagnosis, and whether a `raise <n>` reply would be
 * meaningful for this specific park.
 *
 * `stepId` distinguishes the two shapes a pending question can be, on the
 * fold's own terms (`workflow-status.ts`): the step-failure park is keyed by
 * the step that failed, and the stage-boundary budget ask is always keyed by
 * {@link BUDGET_ASK_STEP_ID}. A step id matching neither — an ordinary
 * `ORG-ASK` — gets neither field, because neither applies.
 *
 * @param run - The folded journal, for its `parkedStep`/`budgetAsk` facts.
 * @param stepId - The question's own step id.
 */
function questionExtras(
  run: JournalRun,
  stepId: string,
): Pick<WorkflowRunStatus["questions"][number], "diagnosis" | "raise"> {
  if (run.parkedStep !== undefined && run.parkedStep.stepId === stepId) {
    const ask = run.parkedStep;
    const diagnosis =
      ask.lastTurn === undefined
        ? undefined
        : sanitizeDescription(describeLastTurn(ask.lastTurn), DIAGNOSIS_MAX_CHARS);
    return {
      ...(diagnosis === undefined ? {} : { diagnosis }),
      ...(ask.failureKind === "turn-ceiling"
        ? {
            raise: {
              kind: "turns" as const,
              ...(ask.ceiling === undefined ? {} : { current: ask.ceiling }),
            },
          }
        : {}),
    };
  }
  if (stepId === BUDGET_ASK_STEP_ID && run.budgetAsk !== undefined) {
    return { raise: { kind: "budget" as const, current: run.budgetAsk.limit } };
  }
  return {};
}

/** Project a folded journal run into its wire row. */
export function runStatus(run: JournalRun, now: number, withSteps: boolean): WorkflowRunStatus {
  const summary = summariseRun(run, now);
  const steps: WorkflowRunStepStatus[] = run.stages.flatMap((stage) =>
    stage.steps.map((step) => ({
      id: step.id,
      stage: step.stage,
      status: step.status,
      ...(step.branch === undefined ? {} : { branch: step.branch }),
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
      ...(step.tokens === undefined ? {} : { tokens: step.tokens }),
      ...(step.attempts === undefined ? {} : { attempts: step.attempts }),
      ...(step.recordStatus === undefined ? {} : { patch: step.recordStatus }),
      ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
      ...(step.endedAt === undefined ? {} : { endedAt: step.endedAt }),
    })),
  );
  return {
    runId: summary.runId,
    // `summariseRun` renders an unknown workflow as "?" for a table cell; the
    // wire says `""` instead, so a client can test for absence rather than
    // matching a glyph the engine chose for a terminal.
    workflow: run.workflow ?? "",
    state: deriveRunState(run, now),
    stageCount: summary.stageCount,
    stepsDone: summary.stepsDone,
    stepsTotal: summary.stepsTotal,
    // Model-written prose heading for a surface a person reads and answers —
    // sanitized on exactly the terms a workflow description is.
    questions: run.pendingQuestions.map((question) => ({
      stepId: question.stepId,
      question: sanitizeDescription(question.question),
      ...questionExtras(run, question.stepId),
    })),
    ...(summary.stage === undefined ? {} : { stage: summary.stage }),
    ...(summary.spentUsd === undefined ? {} : { spentUsd: summary.spentUsd }),
    ...(summary.turns === undefined ? {} : { turns: summary.turns }),
    ...(summary.stopReason === undefined ? {} : { stopReason: summary.stopReason }),
    ...(summary.startedAt === undefined ? {} : { startedAt: summary.startedAt }),
    ...(run.lastWriteTs === undefined ? {} : { updatedAt: run.lastWriteTs }),
    ...(withSteps ? { steps } : {}),
  };
}

/** A `notice`-only `CommandUi`, so `reportWorkflowEvent` can narrate onto a socket. */
function noticeSink(emit: (event: AgentEvent) => void): {
  notice: (level: "info" | "warn" | "error", text: string) => void;
} {
  return {
    notice: (level, text) => {
      emit({ type: "notice", level, text });
    },
  };
}

/**
 * Publish a finished run's report onto the session stream.
 *
 * Mirrors what the slash command does at the end of a run — the same status
 * line, the same error/warning level, the same product text — because a person
 * moving between the panel and the terminal must not be told two different
 * stories about the same run. What differs is the cap: see
 * {@link WORKFLOW_RESULT_TEXT_MAX_CHARS}.
 */
function reportRunResult(result: WorkflowRunResult, emit: (event: AgentEvent) => void): void {
  const ui = noticeSink(emit);
  ui.notice(
    result.status === "done" ? "info" : result.status === "failed" ? "error" : "warn",
    `Workflow ${result.workflow}: ${result.status}.`,
  );
  if (result.status !== "done" && result.status !== "paused" && result.error !== undefined) {
    ui.notice(result.status === "cancelled" ? "warn" : "error", result.error);
  }
  const text = result.text.trim();
  if (text === "") return;
  const capped =
    text.length > WORKFLOW_RESULT_TEXT_MAX_CHARS
      ? `${text.slice(0, WORKFLOW_RESULT_TEXT_MAX_CHARS)}\n\n[truncated — the full output is in this run's journal directory]`
      : text;
  ui.notice("info", capped);
}

/**
 * Build the workflow surface `createServeHost` injects, or `undefined` for a
 * runtime that cannot drive one.
 *
 * The two members it insists on are the two without which nothing here has a
 * meaning: `paths` (there is nowhere to discover workflows or journal runs) and
 * `createSubagent` (there is nothing to run a step as). Everything else
 * degrades — a runtime with no `agents` map simply has no roles, and a
 * workflow that names one fails pre-flight with the engine's own message.
 *
 * @param runtime - The served runtime.
 * @param options - Injections; `resolveModelTag` should be the same resolver
 *   the terminal's registry uses.
 */
export function createServeWorkflows(
  runtime: ServableWorkflowRuntime,
  options: ServeWorkflowOptions = {},
): WorkflowService | undefined {
  const paths = runtime.paths;
  if (paths === undefined || typeof runtime.createSubagent !== "function") return undefined;

  const discover = options.discover ?? discoverWorkflows;
  const now = options.now ?? Date.now;
  const runsRoot = join(paths.home, "workflow-runs");
  const roles = (): ReadonlyMap<string, AgentDef> => runtime.agents ?? new Map();
  const resolveAgent: AgentRoleResolver = (name) => roles().get(name);
  const agentNames = (): readonly string[] => [...roles().keys()];
  // The engine's own mode, read per call rather than snapshotted: a `/permissions`
  // change in the terminal hosting this server must be visible to the next run,
  // the same reason `modelCatalog` and `commands` re-read in `createServeHost`.
  const engineMode = (): PermissionMode => runtime.permissionMode ?? "default";

  /** Discover, and narrate any parse warning onto the run's own stream. */
  const workflows = async (emit?: (event: AgentEvent) => void): Promise<Workflow[]> => {
    const warnings: string[] = [];
    const found = await discover(workflowRoots(paths), warnings);
    if (emit)
      for (const warning of warnings) emit({ type: "notice", level: "warn", text: warning });
    return found;
  };

  /**
   * Everything both `run` and `resume` do identically, in one place.
   *
   * The two verbs differ in exactly two respects — where the workflow and its
   * input come from, and whether a resume state is threaded in — so everything
   * else (the journal, the lane, the org memory, the posture notices, the
   * narration, the terminal report) is written once. Splitting it would be how
   * a resumed run comes to publish different events than a fresh one, which is
   * the divergence a panel would render as two different features.
   */
  const start = async (params: {
    workflow: Workflow;
    input: string;
    runId: string;
    resumed: boolean;
    resumeFrom?: Awaited<ReturnType<typeof buildResumeState>>;
    /**
     * The dollar cap this run was commissioned under, when the client asked
     * for one of its own. Journalled on the run header so a *resume* enforces
     * it too — the bounded workflow copy the fresh run enforces it with lives
     * only in memory, and a resume rediscovers the file's full ceiling.
     */
    budgetCapUsd?: number;
    sessionId: string;
    sessionMode: PermissionMode;
    emit: (event: AgentEvent) => void;
    signal: AbortSignal;
  }): Promise<{ handle: WorkflowRunHandle; settled: Promise<void> }> => {
    const { workflow, emit, signal } = params;
    // The narrowing rule, in one line: a served run is at most as permissive as
    // the engine, and at most as permissive as the session that asked.
    const effectiveMode = stricterMode(engineMode(), params.sessionMode);
    const journal = createFileRunJournal(join(runsRoot, params.runId));
    const lane =
      typeof (runtime as { buildSessionAgent?: unknown }).buildSessionAgent === "function"
        ? createRuntimeWriteLane(runtime as unknown as WriteLaneHost, params.runId)
        : undefined;
    const orgMemory = await loadOrgMemoryInjector(orgMemoryPath(paths), (warning) => {
      emit({ type: "notice", level: "warn", text: warning });
    });
    const posture = workflowPostureNotices(workflow, effectiveMode, resolveAgent);
    const ui = noticeSink(emit);

    const settled = runWorkflowEngine(workflow, {
      runStep: createRuntimeRunStep(runtime as unknown as WorkflowCommandRuntime, {
        resolveAgent,
        agentNames,
        // Narrowed, never widened: `plan` on *either* side refuses both
        // worktree lanes. A remote caller who set their session to `plan`
        // therefore cannot get a write lane out of an engine whose own mode is
        // looser, and an engine in `plan` refuses regardless of the session.
        planMode: () => effectiveMode === "plan",
        // The live region, over a socket. Each step republishes its child agent
        // onto the session's stream as a namespaced sub-agent, so a panel's
        // existing sub-agent rows light up with no new client logic and no
        // second event channel.
        emit,
        ...(options.resolveModelTag === undefined ? {} : { resolveModel: options.resolveModelTag }),
        ...(lane === undefined ? {} : { writeLane: lane }),
        orgMemory,
      }),
      input: params.input,
      resolveAgent,
      agentNames,
      ...(options.resolveModelTag === undefined ? {} : { resolveModel: options.resolveModelTag }),
      signal,
      runId: params.runId,
      journal,
      ...(lane === undefined ? {} : { verifyPatch: createPatchVerifier(lane) }),
      ...(params.resumeFrom === undefined ? {} : { resumeFrom: params.resumeFrom }),
      // The seam's contract, threaded into the engine: the wire may raise a
      // ceiling only when this server was started with `--allow-ceiling-raise`.
      // It also decides how the budget ask is *worded* for this origin — a
      // question that offered `raise` to a client forbidden to send it would be
      // an instruction to loop on refusals.
      allowBudgetRaise: options.allowBudgetRaise === true,
      ...(params.budgetCapUsd === undefined ? {} : { budgetCapUsd: params.budgetCapUsd }),
      onEvent: (event) => {
        // The same function the TUI narrates with, so the sentences a panel
        // shows are the sentences a terminal shows — including the `ORG-ASK:`
        // pause, which `reportWorkflowEvent` raises as a `warn`.
        reportWorkflowEvent(event, ui);
        if (event.type === "workflowStart") {
          for (const notice of posture) ui.notice(notice.level, notice.text);
        }
      },
    })
      .then((result) => {
        reportRunResult(result, emit);
        if (result.status === "paused" && result.pauses.length > 0) {
          ui.notice(
            "info",
            `Run ${params.runId} is paused awaiting your answer. Resume it with the ` +
              "answer to continue; finished steps are reused, not redone.",
          );
        }
      })
      .catch((error: unknown) => {
        // `runWorkflow` never rejects by contract; this is the belt and braces
        // for a host bug. A rejection that vanished would leave a panel
        // watching a run that stopped narrating with no explanation.
        ui.notice("error", `Workflow ${workflow.name} failed to run: ${errorText(error)}`);
      });

    const steps = workflow.stages.reduce((total, stage) => total + stage.steps.length, 0);
    // The ceiling actually enforced, which on a resume is the file's bounded by
    // the cap this run was commissioned under — not the file's alone.
    const budgetUsd =
      params.budgetCapUsd === undefined
        ? workflow.budgetUsd
        : Math.min(params.budgetCapUsd, workflow.budgetUsd ?? params.budgetCapUsd);
    const handle: WorkflowRunHandle = {
      runId: params.runId,
      workflow: workflow.name,
      sessionId: params.sessionId,
      stages: workflow.stages.length,
      steps,
      resumed: params.resumed,
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      stepTimeoutMs: workflow.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS,
    };
    return { handle, settled };
  };

  return {
    async list(): Promise<WorkflowSummary[]> {
      const found = await workflows();
      return found
        .map((workflow) => workflowSummary(workflow, resolveAgent))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async status(runId?: string): Promise<WorkflowResult<WorkflowRunStatus[]>> {
      const at = now();
      // A parked run's question is rendered into this response verbatim, so it
      // is rendered for THIS audience: a client this server forbids from
      // raising a ceiling must not be handed a question that tells it to.
      const audience: BudgetAskAudience = { allowRaise: options.allowBudgetRaise === true };
      if (runId === undefined) {
        const runs = await readWorkflowRuns(runsRoot, audience);
        return {
          ok: true,
          value: runs
            .map((run) => runStatus(run, at, false))
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
        };
      }
      // A client string on its way to becoming a path. See `isSafeRunId`.
      // Zero rows rather than a refusal, for the same reason an id with no
      // journal gets zero rows: this verb degrades, so an in-band error would
      // be read as "this engine is too old".
      if (!isSafeRunId(runId)) return { ok: true, value: [] };
      const run = await readWorkflowRun(runsRoot, runId, audience);
      // An id with no journal answers an **empty list**, not a refusal — and
      // that is a correction rather than a preference. `isUnsupportedMethodError`
      // reads every `invalidRequest` as "this engine does not know the verb", so
      // a read that refused in-band would be indistinguishable from an engine
      // too old to have it, and `ProtocolClient.workflowStatus` would collapse
      // it to `undefined`. That is the `pendingChanges` lesson exactly: a read
      // verb reports a fact rather than erroring, because on this wire an error
      // from a read means something else. Zero rows for a *named* run is
      // unambiguous — only the listing form can legitimately be empty.
      if (!run) return { ok: true, value: [] };
      return { ok: true, value: [runStatus(run, at, true)] };
    },

    async run(request) {
      const found = await workflows(request.emit);
      const workflow = found.find((candidate) => candidate.name === request.name.toLowerCase());
      if (!workflow) {
        return {
          ok: false,
          error:
            `No workflow named "${request.name}" on this engine. ` +
            `Known: ${found.length === 0 ? "(none)" : found.map((w) => w.name).join(", ")}.`,
        };
      }
      const budget = resolveRunBudget(workflow, request.budgetUsd);
      if (!budget.ok) return budget;

      // Hygiene, and only for a fresh run: a failed step keeps its worktree on
      // purpose, so without a sweep the debuggable-forever promise turns into
      // an unbounded pile of checkouts under the served home. Never fatal.
      await pruneWorkflowRuns({
        root: runsRoot,
        ...(runtime.cwd === undefined ? {} : { repo: runtime.cwd }),
      });

      const runId = createRunId();
      const input = request.input ?? "";
      // The ceiling actually enforced. A spread rather than a mutation: the
      // parsed workflow is shared with the catalog, and `runWorkflow`'s own
      // `workflow.budgetUsd` check is still the only place a budget is enforced.
      const bounded: Workflow =
        budget.value === workflow.budgetUsd
          ? workflow
          : { ...workflow, ...(budget.value === undefined ? {} : { budgetUsd: budget.value }) };
      // …and, when this request set the ceiling rather than the file, the same
      // number DURABLY, on the run's journal header. The bounded copy above is
      // in memory; a resume rediscovers the workflow from disk with its full
      // ceiling restored, so without this the lowered ceiling evaporated at the
      // first resume — and a plain resume is exactly what a parked run invites.
      const budgetCapUsd = budget.value === workflow.budgetUsd ? undefined : budget.value;
      const stepTimeoutMs = bounded.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS;
      // Written before the response goes out, exactly as the slash command
      // writes it before running: a client handed a run id must be able to find
      // that run's directory the moment it holds it.
      await writeManifest(join(runsRoot, runId), {
        v: RUN_JOURNAL_SCHEMA_VERSION,
        runId,
        workflow: bounded.name,
        source: bounded.source,
        input,
        stepTimeoutMs,
        maxStepRetries: bounded.maxStepRetries ?? DEFAULT_MAX_STEP_RETRIES,
        startedAt: now(),
      });

      const accepted = await start({
        workflow: bounded,
        input,
        runId,
        resumed: false,
        ...(budgetCapUsd === undefined ? {} : { budgetCapUsd }),
        sessionId: request.sessionId,
        sessionMode: request.permissionMode,
        emit: request.emit,
        signal: request.signal,
      });
      return { ok: true, value: accepted };
    },

    async resume(request) {
      // Refused loudly here, unlike in `status`: this verb does not degrade, so
      // an error is unambiguous — and it is the one that would *append* to
      // whatever directory the id named.
      if (!isSafeRunId(request.runId)) {
        return {
          ok: false,
          error: `"${request.runId}" is not a run id this engine could have minted.`,
        };
      }
      const lines: JournalLine[] = await readJournalLines(join(runsRoot, request.runId));
      if (lines.length === 0) {
        return {
          ok: false,
          error: `No run journal for "${request.runId}" on this engine; there is nothing to resume.`,
        };
      }
      const state = buildResumeState(lines);
      // A genuinely finished run has nothing to resume. A `"paused"` end is the
      // human gate's *soft* stop and is deliberately not "finished" — the same
      // distinction the slash command draws.
      if (state.ended && state.endedStatus !== "paused") {
        return {
          ok: false,
          error: `Run ${request.runId} already finished (${state.endedStatus ?? "done"}); nothing to resume.`,
        };
      }
      const header = lines.find(
        (line): line is Extract<JournalLine, { kind: "run" }> => line.kind === "run",
      );
      const wfName = state.workflow ?? header?.workflow;
      const found = await workflows(request.emit);
      const workflow = found.find((candidate) => candidate.name === wfName);
      if (!workflow) {
        return {
          ok: false,
          error:
            `Run ${request.runId} ran the workflow "${wfName ?? "?"}", which is no longer ` +
            "discoverable on this engine; restore the workflow file to resume it.",
        };
      }

      // The human-question gate. Without an answer a paused run is not resumed
      // at all: its questions are re-surfaced on the session stream and the run
      // stays exactly where it was, which is what the terminal does and what
      // lets a client offer "remind me" and "here is my answer" separately.
      if (state.pending !== undefined && (request.answer ?? "") === "") {
        for (const question of state.pendings) {
          request.emit({
            type: "notice",
            level: "warn",
            text:
              state.pendings.length === 1
                ? `Run ${request.runId} is paused awaiting a human answer — ${question.question}`
                : `Run ${request.runId} is paused awaiting a human answer at step ${question.stepId} — ${question.question}`,
          });
        }
        return {
          ok: false,
          error:
            `Run ${request.runId} is paused on ${String(state.pendings.length)} question(s) and ` +
            "needs an answer, not a nudge. Resume it again with the answer text.",
        };
      }

      // The stage-boundary budget ask, over the wire. Two answers are valid
      // here and neither of them is silence — three, on a server started with
      // `--allow-ceiling-raise`.
      //
      // A raise-shaped answer is REFUSED here, not threaded through, UNLESS
      // this server opted in: the seam's default contract is that nothing on
      // the wire may raise a ceiling (`packages/server/src/workflows.ts`), and
      // the run-start `budgetUsd` refusal above would be theatre if a resume
      // could smuggle the same raise in as free text. When the flag is set,
      // the reply falls through to `resumeFrom` below and the ENGINE validates
      // it — positive, exceeds both the ceiling and what is already spent, and
      // (for a wire run) under the starter's own cap — with the exact grammar
      // and the exact checks a terminal `raise <n>` gets, because `start()`
      // hands the engine `allowBudgetRaise: options.allowBudgetRaise === true`
      // and this gate uses the same flag. One parser, one set of rules,
      // reached from two origins.
      //
      // A *bare* resume is refused either way, for the same reason the
      // role-pause gate above refuses one: the acknowledgement is a durable
      // record of an operator's consent, and a client that nudges every
      // stalled run would otherwise mint that record for a question nobody
      // ever read.
      if (state.budgetAsk !== undefined) {
        const answer = request.answer ?? "";
        if (options.allowBudgetRaise !== true && parseBudgetRaiseAnswer(answer) !== undefined) {
          return {
            ok: false,
            error:
              `Run ${request.runId} is parked at a budget checkpoint. ` +
              budgetWireRaiseRefusal(workflow.source),
          };
        }
        if (answer.trim() === "") {
          request.emit({
            type: "notice",
            level: "warn",
            text:
              `Run ${request.runId} is parked at a budget checkpoint — ` +
              budgetAskQuestion(state.budgetAsk, { allowRaise: options.allowBudgetRaise === true }),
          });
          return {
            ok: false,
            error:
              `Run ${request.runId} is parked at a budget checkpoint and needs an answer, not a ` +
              `nudge. Resume it again with "${BUDGET_ACK_ANSWER}" to run on to its hard stop.`,
          };
        }
      }

      // The step-failure park, over the wire. Two answers are valid here —
      // `retry` and `abandon` — and a `raise <n>` third when this server
      // allows it, on exactly the terms above.
      //
      // A raise-shaped answer is REFUSED for the reason a budget raise is,
      // gated by the same flag: nothing on the wire may lift a ceiling, turn
      // ceilings included, unless the host opted in. The grammar is the
      // engine's own (`parseBudgetRaiseAnswer`, shared by both gates), so the
      // two can never drift.
      //
      // A *bare* resume is refused either way: a retry is money, and a client
      // that nudges every stalled run must not be able to spend it.
      if (state.stepFailAsk !== undefined) {
        const answer = request.answer ?? "";
        if (options.allowBudgetRaise !== true && parseBudgetRaiseAnswer(answer) !== undefined) {
          return {
            ok: false,
            error:
              `Run ${request.runId} is parked at a failed step. ` +
              turnWireRaiseRefusal(workflow.source),
          };
        }
        if (answer.trim() === "") {
          request.emit({
            type: "notice",
            level: "warn",
            text:
              `Run ${request.runId} is parked at a failed step — ` +
              stepFailAskQuestion(state.stepFailAsk, {
                allowRaise: options.allowBudgetRaise === true,
              }),
          });
          return {
            ok: false,
            error:
              `Run ${request.runId} is parked at a failed step and needs an answer, not a nudge. ` +
              `Resume it again with "${STEP_RETRY_ANSWER}" to run that step again, or ` +
              `"${STEP_ABANDON_ANSWER}" to end the run failed.`,
          };
        }
      }
      const resumeFrom =
        state.budgetAsk !== undefined
          ? { ...state, budgetAnswer: { text: request.answer ?? "" } }
          : state.stepFailAsk !== undefined
            ? { ...state, stepFailAnswer: { text: request.answer ?? "" } }
            : state.pending !== undefined && request.answer !== undefined
              ? { ...state, answer: { stepId: state.pending.stepId, text: request.answer } }
              : state;
      const accepted = await start({
        workflow,
        input: header?.input ?? "",
        runId: request.runId,
        resumed: true,
        resumeFrom,
        // The cap this run was commissioned under, recovered from its own
        // journal header: the wire's "may lower, never raise" contract binds
        // the RUN, not just the request that started it.
        ...(state.budgetCapUsd === undefined ? {} : { budgetCapUsd: state.budgetCapUsd }),
        sessionId: request.sessionId,
        sessionMode: request.permissionMode,
        emit: request.emit,
        signal: request.signal,
      });
      return { ok: true, value: accepted };
    },
  };
}
