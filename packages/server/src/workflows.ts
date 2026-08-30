/**
 * The workflow seam: what `@arcturn/server` needs from the engine to answer
 * `listWorkflows`, `runWorkflow`, `workflowStatus` and `resumeWorkflow`.
 *
 * Every one of those verbs is answered by `@arcturn/cli`'s workflow engine —
 * the same 7,000 lines the terminal's `/workflow` drives, the same parser, the
 * same lane classifier, the same run journal. This package depends on none of
 * it and must not: a second workflow engine living behind the socket would
 * parse the same file differently, derive a different lane for the same role,
 * and write a different journal into the same directory.
 *
 * So the shape below is an **injection**, on exactly the terms
 * `SessionHostOptions.dryRunOverlay` and `SessionHostOptions.mcpStatus` are,
 * and for the same reason: the knowledge lives in the CLI, the wire contract
 * lives here, and the seam between them is four methods that speak only in
 * types `@arcturn/types` already defines.
 *
 * ## One injection, four verbs
 *
 * Deliberately one object rather than four callbacks — the rule
 * `createServeHost` keeps after the `resolveModel`/`modelCatalog` pair drifted
 * apart once and became a real routing bug. Here the stakes are higher again:
 * a catalog built from one workflow root and a run started against another
 * would run a pipeline nobody was shown, and a status read from one journal
 * while a resume re-entered a different one would resume the wrong work.
 *
 * ## What this seam deliberately does not carry
 *
 * There is no way through it to raise a limit. A workflow's own `budgetUsd:`
 * and `stepTimeoutMs:`, a role's `maxTurns`, a role's declared `tools:` and the
 * engine's permission rules are all read by the implementation from the files
 * that own them; the only number crossing this boundary is
 * {@link WorkflowRunRequest.budgetUsd}, and its contract is that it may lower
 * the file's ceiling and may never raise it.
 *
 * That contract binds the **run**, not merely the request that started it. The
 * implementation journals the lowered figure on the run's own header, because
 * the bounded workflow it enforces is an in-memory copy and a resume
 * rediscovers the file — with its full ceiling — from disk. A resume therefore
 * enforces the lower of the two, and no raise can lift a run past the ceiling
 * it was commissioned under.
 *
 * The same rule holds for the *answers* a resume may carry. A run parked at the
 * engine's stage-boundary budget ask accepts one reply over this seam —
 * `"continue"`, the acknowledgement that lets the run proceed to its hard stop.
 * A bare resume with no answer is refused exactly as it is for an unanswered
 * `ORG-ASK` (the acknowledgement is a durable record of a person's consent, and
 * a nudge is not one), and a `raise <n>` answer is refused with an error naming
 * this contract rather than threaded through as free text. Raising a parked
 * run's ceiling is terminal-only, or an edit to the workflow file itself — and
 * the question this seam hands back says so, offering `continue` and never
 * advertising the one reply it would always refuse.
 */

import type {
  AgentEvent,
  PermissionMode,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSummary,
} from "@arcturn/types";

/**
 * A refusal a client can act on, or the value.
 *
 * A union rather than a throw, the shape `dry-run.ts` already uses: the
 * implementation lives in another package, and returning a value keeps the
 * decision about *which wire error code* a refusal becomes in this package —
 * next to the dispatch table that answers for it — rather than spread across
 * two.
 */
export type WorkflowResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** What {@link WorkflowService.run} is asked to start. */
export interface WorkflowRunRequest {
  /** Session whose event stream carries the run, and whose id is echoed back. */
  readonly sessionId: string;
  /** Workflow name, as `listWorkflows` reported it. */
  readonly name: string;
  /** Text spliced into `{{input}}`. */
  readonly input?: string;
  /**
   * A run-scope USD ceiling that may only **lower** the workflow file's own.
   *
   * The implementation refuses anything higher rather than clamping it, and
   * says both numbers — see `ClientRequest`'s `runWorkflow` for why a silent
   * clamp is the wrong shape for a money ceiling.
   */
  readonly budgetUsd?: number;
  /**
   * The permission mode the *calling session* is running under.
   *
   * Supplied so the implementation can narrow to the stricter of this and the
   * engine's own — never widen to it. A remote caller who put their session in
   * `plan` must not get a write lane merely because the served engine's own
   * mode is looser; the reverse direction (an engine in `plan`) already
   * refuses both worktree lanes on its own.
   */
  readonly permissionMode: PermissionMode;
  /**
   * Publishes one event onto the calling session's stream — the same fan-out
   * the session's own agent uses.
   *
   * This is how a client follows the run, and it is why there is no second
   * event channel on this wire: a connection that called `openSession` is
   * already subscribed to everything this pushes.
   */
  emit(event: AgentEvent): void;
  /** Cancels the run. Wired to the session's own `abort`. */
  readonly signal: AbortSignal;
}

/** What {@link WorkflowService.resume} is asked to re-enter. */
export interface WorkflowResumeRequest {
  readonly sessionId: string;
  /** The run to re-enter, as `workflowStatus` reported it. */
  readonly runId: string;
  /**
   * The human's reply to a paused stage's `ORG-ASK:`.
   *
   * Omitted, a paused run is not resumed at all — its questions are
   * re-surfaced on the session stream instead, which is what the terminal does
   * and what lets a client offer "remind me" and "here is my answer" as the
   * two different things they are.
   */
  readonly answer?: string;
  readonly permissionMode: PermissionMode;
  emit(event: AgentEvent): void;
  readonly signal: AbortSignal;
}

/** A run the engine has accepted, and the promise that says when it is over. */
export interface AcceptedWorkflowRun {
  /** What the client is told: the run id, the pipeline's shape, the limits in force. */
  readonly handle: WorkflowRunHandle;
  /**
   * Resolves when the run reaches a terminal state — done, failed, cancelled
   * or paused for a human. **Never rejects**, mirroring `runWorkflow`'s own
   * contract of surfacing every problem as a non-`"done"` result rather than a
   * throw.
   *
   * This is not a second answer to "what happened" — the outcome is on the
   * session's event stream and in the run journal. It exists so the host can
   * tell when the session is free to start another pipeline, which is a
   * question nothing else on this seam answers: without it, one finished run
   * would leave the session reporting `sessionBusy` forever.
   */
  readonly settled: Promise<void>;
}

/**
 * The engine's workflow surface, as this package sees it.
 *
 * Omitted from {@link SessionHostOptions}, the host is an engine with no
 * workflow support: `listWorkflows` and `workflowStatus` answer empty, and
 * `runWorkflow`/`resumeWorkflow` **refuse** with a sentence saying so. That is
 * the `transcriptExporter` treatment rather than the `modelCatalog` one, and
 * the split is the usual one — a read that finds nothing is honest, while a
 * run that quietly did not start is the failure the verb exists to prevent.
 */
export interface WorkflowService {
  /** Every discovered workflow, sorted by name. Read-only. */
  list(): Promise<WorkflowSummary[]>;
  /**
   * Run rows from the durable run journal.
   *
   * @param runId - One run, with its per-step breakdown; omit for the listing.
   * @returns The rows. A `runId` with no journal is **zero rows**, not a
   *   refusal: a read that errored in-band would be read by
   *   `isUnsupportedMethodError` as "this engine is too old" and degraded to
   *   `undefined`. The refusal half of the union is for a store this engine
   *   cannot read at all.
   */
  status(runId?: string): Promise<WorkflowResult<WorkflowRunStatus[]>>;
  /**
   * Accept a run and start it.
   *
   * Resolves once the run is **accepted** — the workflow exists, the budget is
   * legal, the run id is minted — not when the pipeline finishes. Everything
   * after acceptance rides {@link WorkflowRunRequest.emit}.
   */
  run(request: WorkflowRunRequest): Promise<WorkflowResult<AcceptedWorkflowRun>>;
  /** Re-enter an interrupted run, on {@link WorkflowService.run}'s terms. */
  resume(request: WorkflowResumeRequest): Promise<WorkflowResult<AcceptedWorkflowRun>>;
}
