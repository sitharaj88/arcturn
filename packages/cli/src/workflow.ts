/**
 * DETERMINISTIC WORKFLOWS — scripted multi-agent orchestration where the
 * control flow is *code on disk*, not a model's choice.
 *
 * Arcturn already has two ways to spend more than one agent, and both hand the
 * decisions to a model: `team.ts` lets a supervisor decompose a goal and pick
 * its specialists, `background-agents.ts` fires one durable delegate at a task.
 * Neither is reproducible — ask twice, get two different shapes of run. A
 * workflow is the opposite trade: the author writes the steps down, and every
 * invocation executes exactly those steps, in exactly that order, with exactly
 * that fan-out. Only the *content* of each step is model-generated.
 *
 * ## The file format
 *
 * A workflow is a markdown file sitting beside markdown skills and agents
 * (`~/.arcturn/workflows/<name>.md`, `<cwd>/.arcturn/workflows/<name>.md`),
 * with the same plain `key: value` frontmatter block those use:
 *
 * ```md
 * ---
 * name: ship-fix
 * description: Reproduce, patch and review one bug report
 * continueOnError: false
 * stepTimeoutMs: 600000
 * ---
 * 1. [tier:cheap] Reproduce this bug and quote the failing output: {{input}}
 * 2. Given the repro below, do the work:
 *    - [tier:judgment] Write the minimal patch. Repro: {{prev}}
 *    - Write a regression test that fails before the patch. Repro: {{prev}}
 * 3. Review the patch and the test for correctness:
 *    {{prev}}
 * ```
 *
 * The grammar is deliberately tiny, and everything outside it is a hard
 * error rather than a guess:
 *
 * - A **top-level numbered item** (`1.` or `1)`, no leading whitespace) is one
 *   *stage*. Stages run strictly in order and must be numbered `1, 2, 3, …`.
 * - **Indented `-` bullets** under a numbered item are that stage's *parallel
 *   branches*; they all run at once and their outputs are concatenated in
 *   written order (never in completion order, so a run is reproducible).
 * - A numbered item either carries a prompt *or* has branches. Carrying both
 *   is ambiguous — is the parent text a step or a heading? — and is rejected,
 *   unless the parent text is plainly a label (it ends with `:`).
 * - An optional `[tag]` prefix on a step line selects a model, resolved by a
 *   caller-supplied {@link ModelTagResolver}. This module never touches the
 *   model catalog itself — a tag is any string matching `VALID_TAG`
 *   (catalog-id characters, `.`, `_`, `/`, `-` and `:`), most commonly either
 *   a concrete catalog id (`[anthropic/claude-opus-5]`) or a `tier:<name>`
 *   symbolic tier (`[tier:judgment]`, see `router.ts`'s `resolveModelTag` and
 *   `RouterConfig.tiers`) that the resolver maps to a config-chosen id — a
 *   role file or workflow written with a tier stays portable across whatever
 *   provider a deployment's `route.tiers` config points it at.
 * - An optional `@role` prefix — written *after* the `[tag]`, if both are
 *   present — dispatches the step to a **named markdown agent** instead of an
 *   anonymous step agent (RFC 0001 §3.4). `1. @architect Design {{input}}`
 *   and `2. [anthropic/claude-opus-5] @developer Implement {{prev}}` are both
 *   legal; an explicit `[tag]` always beats the role's own `model:`.
 * - `{{prev}}` splices the previous stage's combined output, `{{input}}` the
 *   text typed after the workflow name. Any other `{{…}}` placeholder, or a
 *   `{{prev}}` in stage 1 (there is no previous stage), is a parse error.
 * - An optional `stepTimeoutMs:` frontmatter key overrides every step's
 *   wall-clock deadline (milliseconds; must be a positive whole number) —
 *   see {@link DEFAULT_WORKFLOW_STEP_TIMEOUT_MS} and "Every step has a
 *   wall-clock ceiling" below.
 *
 * Continuation lines are not part of the grammar: one line is one step. Prose
 * *before* the first numbered item is allowed and ignored, so a workflow file
 * can carry a paragraph of documentation; prose *after* it is an error,
 * because it reads like a step that would silently never run.
 *
 * ## Three dispatch lanes (RFC 0001 §7.1)
 *
 * A role's `tools:` list decides *how* its step runs, and it is the only
 * thing that decides — not the prompt, not the role's prose, not a
 * `writes: none` line in frontmatter this loader never reads. The split
 * starts as a security constraint discovered in the code rather than a
 * preference: `ArcturnRuntime.createSubagent` narrows every non-yolo child to
 * investigative tools, so a role that must write cannot be dispatched through
 * it at all. The third lane exists because `bash` conflates two different
 * authorities — *executing* and *authoring* — and a reviewer needs the first
 * without the second.
 *
 * | Lane | Declares | Runs in | Its diff |
 * |---|---|---|---|
 * | **read** | neither group | `createSubagent`, the session's cwd | there isn't one |
 * | **exec** | `bash` only | its own seeded worktree | never captured, never applied |
 * | **write** | `write`/`edit`/`multiedit` | its own seeded worktree | captured **and** applied |
 *
 * - **Read lane** — the step runs through `createSubagent` exactly as an
 *   untagged step does, inheriting the parent's permission posture and its
 *   read-only narrowing untouched.
 * - **Exec lane** — the role gets the write lane's isolation without the
 *   write lane's authority: the same detached, seeded worktree, so it can run
 *   the build, the suite and the audit it was dispatched to run — and its
 *   diff is never read, never written to a patch and never applied. The
 *   worktree is deleted when the step ends; a failure keeps it, clearly
 *   labelled inspect-only. A role on this lane *structurally* cannot change
 *   the user's tree, whatever it does with its shell and whatever its report
 *   claims.
 * - **Write lane** — its diff is captured to a **patch file**, every path in
 *   it is audited ({@link auditPatchPaths}), and the patch is replayed into
 *   the real checkout with plain `git apply` — no `--3way`, no `--force`. A
 *   refusal is a step *error* carrying the preserved patch path; arcturn
 *   surfaces conflicts and never guesses. The worktree is removed only on
 *   success and kept for forensics on failure.
 * - **Plan mode** has neither worktree lane. A pipeline reaching a write or
 *   exec step under plan mode fails that step up front, before a single token
 *   is spent — plan mode promises a read-only session with no prompts and no
 *   egress, and neither an applied patch nor a live shell is that.
 *
 * A role with **no `tools:` at all is refused**, at dispatch and in the
 * pre-flight ({@link undeclaredToolsError}). Silence is not the read lane:
 * `tools:` is the *filter*, so leaving it out means "every tool this session
 * has", which in a yolo session is `bash` and `write` on the user's real
 * checkout — the widest grant in the system, and one nobody wrote down.
 * Declaring `tools: read, edit` buys the isolation that declaring nothing
 * skips, so the declaration is mandatory rather than interpreted.
 *
 * ## The worktree is seeded, so stage N+1 sees stage N
 *
 * A worktree lane's checkout is not a bare `HEAD`. It is `HEAD` plus the
 * run's accumulated state — the user's uncommitted *tracked* work as of the
 * run's first worktree, that same checkout's untracked-but-not-`.gitignore`d
 * files (a scratch fixture, a fresh config — `git diff` cannot represent a
 * file git was never told about, so these are copied to disk rather than
 * diffed; see "Untracked files" on {@link createRuntimeWriteLane}'s doc
 * comment), then every patch this run has already applied, in order — and
 * that state is then committed *inside* the worktree (detached; the
 * repository's own refs are never touched). Capture at the end is
 * `git add --all` followed by `git diff <that commit>`. Three properties fall
 * out of the seed commit, and all three were bugs before it existed:
 *
 * 1. A role dispatched to verify, review or document the pipeline's work is
 *    looking at that work, not at a checkout where it does not exist yet.
 * 2. A role that commits inside its own worktree — ordinary hygiene for
 *    anything holding `bash` — loses nothing. `git diff --cached` cannot see a
 *    committed change; `git diff <seed>` can.
 * 3. The captured patch is exactly the role's *own* delta, because everything
 *    that was already there sits below the seed commit and is never replayed
 *    on top of itself.
 *
 * Agent scratch (`.arcturn/`) is excluded from every capture, and
 * `~/.arcturn/workflow-runs` is swept of anything older than a week at the
 * start of each run ({@link pruneWorkflowRuns}) — the failure worktrees this
 * module deliberately keeps are debuggable for a week, not forever.
 *
 * ## A running step is visible while it runs
 *
 * A step's agent is a *separate* `Agent`, so nothing it does reaches the
 * session's own event stream: the main agent is idle for the whole pipeline,
 * the app's spinner never starts, and a seven-stage run looks identical to a
 * hung one for minutes at a time. Every step therefore republishes its child's
 * stream onto the session's stream as `subagentStart` / `subagentEvent` /
 * `subagentEnd`, namespaced by {@link workflowStepAgentId} — the same shape
 * the `subagent` tool publishes — so the host's *existing* live sub-agent rows
 * show the role, its elapsed time, its token count and the tool it is running
 * right now, with no code in the UI that knows what a workflow is. The row is
 * opened and closed inside {@link driveAgent}'s `try`/`finally`, so a
 * cancelled, failed or throwing step can never leave a ghost row behind. The
 * `notice`-shaped progress events remain what they were: the permanent
 * transcript record, not the live region.
 *
 * ## Patch records are minted by the engine, never by an agent
 *
 * Every worktree-lane step carries a structured {@link WorkflowPatchRecord} —
 * `applied`, `refused`, `empty`, `captured` or `discarded` — set by the engine
 * from what git actually did. Text is not evidence: every
 * {@link WRITE_LANE_TRAILER_PREFIX} line an *agent* wrote is stripped from a
 * step's text before composition, and the engine appends its own canonical
 * trailer rendered from the record, so `{{prev}}` gating still works textually
 * ({@link parseWriteLaneTrailer}) while a role can no longer mint one. A
 * refused or captured record reaches the next stage even though the failed
 * step's own text is dropped — that a patch did *not* land is exactly the fact
 * a later gate must not miss.
 *
 * ## Execution
 *
 * {@link runWorkflow} owns sequencing, piping, error policy, abort and
 * progress events — but not agents. The caller injects
 * {@link WorkflowRunContext.runStep}, so the whole engine is exercised in
 * tests with no LLM, no network and no filesystem. {@link createRuntimeRunStep}
 * is the production binding (one child `Agent` per step — through
 * `ArcturnRuntime.createSubagent` on the read lane, through
 * `buildSessionAgent` in a worktree on the other two, both taken structurally
 * so this module never imports the runtime), and
 * `docs/integration-notes/INTEGRATION-workflows.md` shows the single
 * registration site.
 *
 * Failure policy: parallel branches always run to completion (a sibling's
 * failure never cancels work already in flight — that would throw away tokens
 * already spent), then a failed stage short-circuits every *later* stage,
 * which is reported as `skipped`. `continueOnError: true` in the frontmatter
 * turns the short-circuit off and lets the pipeline carry on with whatever
 * output the surviving branches produced.
 *
 * ## Every step has a wall-clock ceiling
 *
 * `maxTurns` bounds an agent's *turns*, not its *time* — an agent that keeps
 * re-running the same hung command (a test suite whose server never exits, a
 * network call with no timeout of its own) never runs out of turns, so
 * nothing stops it. {@link runWorkflow} therefore gives every step its own
 * deadline ({@link DEFAULT_WORKFLOW_STEP_TIMEOUT_MS}, or the workflow's own
 * `stepTimeoutMs:` frontmatter) and aborts the step's agent when it elapses
 * ({@link runStepWithDeadline}), exactly as an external cancellation aborts
 * it — a timed-out step is recorded `"failed"` and follows the same
 * short-circuit-or-continue policy as any other failure. The abort is fired
 * and the pipeline moves on without waiting for the step to actually settle,
 * so a step whose runner ignores its abort signal cannot hold the pipeline
 * hostage; whatever teardown that runner performs on abort (a worktree lane's
 * background-task reap and forensic worktree, say) still happens, unobserved,
 * in the background.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { abortableSleep, calculateCostUsd, computeBackoffDelay } from "@arcturn/ai";
import {
  addUsage,
  createSessionId,
  DEFAULT_READ_ONLY_TOOLS,
  type ExplainedPermissionRule,
  emptyUsage,
  errorText,
  isTurnCeilingError,
  LARGE_CONTENT_LINES,
  shellSegments,
  type TurnProgress,
} from "@arcturn/core";
import type {
  AgentEvent,
  AIError,
  AssistantMessage,
  ModelSpec,
  PermissionRule,
  PermissionScope,
  Usage,
} from "@arcturn/types";
import type { AgentDef } from "./agents.js";
import type { CommandContext, CommandUi, SlashCommand } from "./commands.js";
import { nearingCeiling, shouldAbortForCost, shouldAbortForTokens } from "./cost-guard.js";
import { formatCost, formatDuration, oneLine, totalTokens } from "./format.js";
import { type InsightsRecorder, type InsightsRunScope, parkCauseKind } from "./insights.js";
import { loadOrgMemoryInjector, orgMemoryPath, renderRunJournalDigest } from "./org-memory.js";
import { createWorktree } from "./scouts.js";
import {
  BUDGET_ACK_ANSWER,
  BUDGET_ASK_STEP_ID,
  type BudgetCeilingKind,
  budgetAskQuestion,
  budgetAskResumeHint,
  buildResumeState,
  classifyFailureKind,
  countWrites,
  createFileRunJournal,
  DURABLE_JOURNAL_KINDS,
  decideInterruptedStep,
  describeActivity,
  describeLastTurn,
  failureKindFromAIError,
  hashPatch,
  hashPrompt,
  type InterruptedStep,
  type InterruptedVerdict,
  isGitLockError,
  type JournalLine,
  type LastTurnShape,
  lastTurnDeliveredNothing,
  type PatchPresence,
  type PendingBudgetAsk,
  type PendingStepFailAsk,
  type ResumeState,
  RUN_JOURNAL_SCHEMA_VERSION,
  type RunJournal,
  readJournalLines,
  STEP_ABANDON_ANSWER,
  STEP_RETRY_ANSWER,
  type StepActivity,
  stepFailAskQuestion,
  stepFailAskResumeHint,
  turnRaiseKey,
  turnShapeOf,
  type WorkflowFailureKind,
  type WorkflowStopReason,
  writeManifest,
} from "./workflow-run.js";
import {
  formatRunDetail,
  formatRunsTable,
  readWorkflowRun,
  readWorkflowRuns,
} from "./workflow-status.js";

const execFileAsync = promisify(execFile);

/**
 * ENFORCED PER-ROLE BUDGETS (RFC 0001 §3.2/§7.4): a role's `budget:`
 * frontmatter (a USD ceiling per assignment) becomes a real ceiling in this
 * module, exactly the way `maxTurns:` already is (§8.4, {@link roleDispatch}
 * and its neighbours).
 *
 * `agents.ts` does not parse `budget:` yet — its own doc comment says so
 * explicitly ("the org kit's `budget`, `consumes`, `produces`, etc. are
 * ignored, not rejected"), because that loader only recognises the fields
 * dispatch itself needs. Rather than grow a shared loader for the one field
 * only *this* module consumes, the type is augmented here — the same
 * declaration-merging TypeScript offers for exactly this shape of problem —
 * so every `AgentDef` this module reads (and every test fixture that builds
 * one) can carry `budget` without `agents.ts` changing at all.
 *
 * This augments the *type*, not the *loader*: until `agents.ts` gains
 * `budget:` frontmatter parsing (mirroring its existing `maxTurns:` handling
 * field-for-field) and sets it on the objects `loadCandidate` returns,
 * `AgentDef.budget` is always `undefined` in production — which
 * {@link roleBudgetUsd} below treats identically to "no budget", so nothing
 * here can act on a half-wired field. See `docs/integration-notes/
 * INTEGRATION-role-budget.md` for that follow-up's exact diff.
 */
declare module "./agents.js" {
  interface AgentDef {
    /**
     * USD ceiling for one assignment of this role, from `budget:`
     * frontmatter. `undefined`, `0`, negative or non-finite all mean
     * "disabled", matching {@link shouldAbortForCost}'s own convention.
     */
    budget?: number;
  }
}

// ---------------------------------------------------------------- model shape

/** One executable step: a single prompt handed to a single child agent. */
export interface WorkflowStep {
  /** Stable id: `"2"` for a lone step in stage 2, `"2.1"` for its first branch. */
  readonly id: string;
  /** 1-based stage this step belongs to. */
  readonly stageIndex: number;
  /** 0-based position within the stage (always `0` for a non-parallel stage). */
  readonly branchIndex: number;
  /** The `[tag]` prefix, without brackets; `undefined` when the line had none. */
  readonly modelTag?: string;
  /**
   * The `@role` prefix, without the `@` and lowercased; `undefined` when the
   * line named no role. Resolved against the host's markdown agents.
   */
  readonly agent?: string;
  /** The step's prompt template, still containing `{{prev}}` / `{{input}}`. */
  readonly prompt: string;
}

/** One stage: either a single step, or a set of steps that run concurrently. */
export interface WorkflowStage {
  /** 1-based index, matching the number written in the file. */
  readonly index: number;
  /** `true` when the stage was written as nested bullets. */
  readonly parallel: boolean;
  /** Optional label text from the numbered line (only for a parallel stage). */
  readonly label?: string;
  /** Steps in written order — the order their outputs are concatenated in. */
  readonly steps: readonly WorkflowStep[];
}

/** A parsed, validated workflow definition. */
export interface Workflow {
  /** Workflow name, normalized to `[a-z0-9-]`. */
  readonly name: string;
  /** One-line summary; empty string when the file set none. */
  readonly description: string;
  /** When `true`, a failed step does not short-circuit later stages. */
  readonly continueOnError: boolean;
  /**
   * Wall-clock ceiling for a single step, in milliseconds, from the
   * `stepTimeoutMs:` frontmatter key. `undefined` means the engine's own
   * {@link DEFAULT_WORKFLOW_STEP_TIMEOUT_MS} applies. See {@link runWorkflow}.
   */
  readonly stepTimeoutMs?: number;
  /**
   * How many times a *transient* step failure is retried before its stage
   * fails, from the `maxStepRetries:` frontmatter key. `undefined` means the
   * engine's own {@link DEFAULT_MAX_STEP_RETRIES} applies; `0` disables the
   * self-healing retry. See {@link WorkflowRetryPolicy} and {@link runWorkflow}.
   */
  readonly maxStepRetries?: number;
  /**
   * USD ceiling for the *whole run*, from the `budgetUsd:` frontmatter key —
   * the RFC 0001 §7.4 run-scope backstop behind every role's own per-assignment
   * `budget:` (§3.2/§8.4). Composed from the same {@link shouldAbortForCost}
   * as the role ceiling; `undefined` or `0` disables it, so a workflow with no
   * `budgetUsd:` line runs exactly as it always has. See {@link runWorkflow}.
   */
  readonly budgetUsd?: number;
  /**
   * Token ceiling for the *whole run*, from the `budgetTokens:` frontmatter
   * key — the one run ceiling that can still fire on a model with no
   * published pricing (a coding-plan endpoint, Ollama, vLLM), where
   * {@link budgetUsd} compares against a `costUsd` that is never minted.
   * Counted as ALL tokens the run consumed: input + output + cache read +
   * cache write (thinking tokens are a subset of output and are never added
   * separately). `undefined` or `0` disables it, mirroring `budgetUsd`.
   * Frontmatter-only in v1: unlike `budgetUsd` it is not settable or
   * overridable over the wire. See {@link runWorkflow}.
   */
  readonly budgetTokens?: number;
  /** Stages in execution order; always at least one. */
  readonly stages: readonly WorkflowStage[];
  /** Absolute path of the file it was loaded from; empty for an inline parse. */
  readonly source: string;
}

/** The failure half of {@link parseWorkflow}'s result. */
export interface WorkflowParseError {
  /** Human-readable, single-sentence reason, prefixed with the line when known. */
  readonly error: string;
}

/**
 * Narrow a parse result to its error half.
 *
 * Typed over `object` rather than `Workflow | WorkflowParseError` so the
 * parser's own intermediate results can be narrowed with the same guard.
 *
 * @param value - A parse result.
 */
export function isWorkflowParseError(value: object): value is WorkflowParseError {
  return "error" in value && typeof (value as WorkflowParseError).error === "string";
}

// --------------------------------------------------------------- run contract

/** What {@link WorkflowRunContext.runStep} is asked to execute. */
export interface WorkflowStepRequest {
  /** The step being run (its `prompt` is still the *template*). */
  readonly step: WorkflowStep;
  /** The prompt with `{{prev}}` / `{{input}}` already spliced in. */
  readonly prompt: string;
  /** Model chosen by the step's `[tag]`; `undefined` when it had no tag. */
  readonly model?: ModelSpec;
  /**
   * The step's `@role`, if it named one. Mirrors `step.agent`; carried
   * separately so a host driving {@link WorkflowStepRunner} directly can
   * override the role without rewriting the parsed step.
   */
  readonly agent?: string;
  /**
   * What the run has accumulated so far. Optional so a host driving a runner
   * directly need not synthesise one; a worktree lane treats a missing state
   * as "this run has applied nothing yet".
   */
  readonly state?: WorkflowRunState;
  /** Aborted when the workflow is cancelled; in-flight work must stop. */
  readonly signal: AbortSignal;
  /**
   * Report cumulative spend as it happens, not just at settlement.
   *
   * {@link runStepWithDeadline} sets this so a step that hits its deadline can
   * report what it actually spent instead of {@link emptyUsage}: a runner
   * that drives a real agent (see {@link driveAgent}) calls this with the
   * running total on every turn, so even a step whose runner ignores its
   * abort signal entirely — the exact runaway-turn case the deadline exists
   * for — has its last-known spend on hand when the race is abandoned rather
   * than waited out. A runner that never calls this (a test double that only
   * returns a final {@link WorkflowStepOutcome}) still isn't shortchanged: the
   * deadline path also captures whatever usage arrives if/when the abandoned
   * call eventually settles, before it is read. Optional so a host driving a
   * {@link WorkflowStepRunner} directly need not supply one.
   */
  readonly onUsage?: (usage: Usage) => void;
  /**
   * 0-based attempt index for this step, across the whole RUN.
   *
   * `0` on the first attempt; incremented for each transient retry, and
   * *seeded* by the attempts earlier runs of this same run already burned —
   * the engine reads that from the step-failure ask it is answering. A
   * worktree lane folds it into the worktree/patch slug so an attempt gets a
   * *fresh* worktree instead of colliding with the failed one's, which is kept
   * for forensics. That seeding is load-bearing: a failed write-lane step
   * keeps its worktree on purpose, so a retry that reused the slug would fail
   * with "a worktree already exists" every single time — the park would offer
   * a `retry` that could not work. Absent means "first (and only) attempt".
   * See the retry loop in {@link runWorkflow}.
   */
  readonly attempt?: number;
  /**
   * The step's write-ahead log, for anything it cannot take back.
   *
   * A runner that is about to touch the world outside the run's own artifacts —
   * on the write lane, `git apply` into the user's checkout — records the
   * intent here *first*, and the outcome immediately after. That is what lets a
   * resume tell "the crash beat the patch" from "the crash beat the record of
   * the patch", instead of re-running the step and applying it twice. See
   * {@link WorkflowStepDurability}.
   *
   * Optional, and its absence is not a loophole: a runner that never records an
   * intent is treated by resume as opaque, and an interrupted opaque step is
   * never re-executed.
   */
  readonly durability?: WorkflowStepDurability;
  /**
   * A run-scoped turn ceiling a human granted for this step, when one was
   * granted (`/workflow resume <id> raise 120` at a step-failure park).
   *
   * The engine reads it out of the run's journal and hands it to the runner;
   * the runner hands it to the child agent's constructor, where it lifts BOTH
   * halves of the `Math.min(role maxTurns, subagentMaxTurns)` clamp. Absent —
   * the overwhelmingly common case — leaves that clamp exactly as it was.
   *
   * Deliberately on the *request* rather than on the role: the role file is
   * never edited, and the grant belongs to one run.
   */
  readonly turnCeiling?: number;
}

/**
 * A step's write-ahead log for irreversible acts.
 *
 * The ordering contract, which is the entire point:
 *
 * 1. `intent({ act: "guarded" })` once, at the top of the step — the runner's
 *    promise that it announces every irreversible act before performing it.
 *    Without it, resume must assume the step could have changed anything.
 * 2. `intent({ act: "apply", … })` **before** the act, awaited. It rejects when
 *    the record could not be made durable, and the caller must then *not*
 *    perform the act: an unrecorded mutation is exactly the state a resume
 *    cannot recover from.
 * 3. `effect({ … })` immediately after the act settles, so the window a probe
 *    has to resolve is as narrow as the implementation can make it.
 */
export interface WorkflowStepDurability {
  /** Record what the step is about to do. Rejects if it could not be recorded. */
  intent(intent: WorkflowStepIntent): Promise<void>;
  /** Record how the act settled. Rejects if it could not be recorded. */
  effect(effect: WorkflowStepEffect): Promise<void>;
}

/** What a step declares it is about to do. See {@link WorkflowStepDurability}. */
export interface WorkflowStepIntent {
  /**
   * `"guarded"`: this runner announces irreversible acts before performing them.
   * `"apply"`: this exact patch is about to be replayed into `target`.
   */
  readonly act: "guarded" | "apply";
  /** The attempt this belongs to ({@link WorkflowStepRequest.attempt}). */
  readonly attempt?: number;
  /** Absolute path of the patch about to be applied. */
  readonly patchPath?: string;
  /** SHA-256 of the patch's bytes. */
  readonly patchHash?: string;
  /** The checkout about to be mutated. */
  readonly target?: string;
}

/** How an announced act settled. See {@link WorkflowStepDurability}. */
export interface WorkflowStepEffect {
  readonly act: "apply";
  readonly attempt?: number;
  /** True when the patch is now in the checkout. */
  readonly applied: boolean;
  readonly patchPath?: string;
  /** The engine-minted record, so a recovered step re-enters the run whole. */
  readonly record?: WorkflowPatchRecord;
}

/**
 * The run state threaded into every step.
 *
 * One field today, and it is the one a worktree lane cannot work without: the
 * patches this run has already replayed into the user's checkout, oldest
 * first. Seeding a stage-6 worktree from bare `HEAD` would hand a reviewer a
 * checkout where the change it is reviewing does not exist.
 */
export interface WorkflowRunState {
  /** Patch files this run applied, in the order they were applied. */
  readonly appliedPatches: readonly string[];
}

/** What a step execution reports back. */
export interface WorkflowStepOutcome {
  /** The step's final text — piped into the next stage as `{{prev}}`. */
  readonly text: string;
  /** Tokens the step spent, summed into the run total. */
  readonly usage: Usage;
  /** `true` when the step did not complete successfully. */
  readonly isError: boolean;
  /** Optional detail shown with a failed step. */
  readonly error?: string;
  /**
   * What the engine recorded about this step's diff, on a worktree lane.
   *
   * Minted by the lane from what git actually did and carried structurally,
   * never parsed back out of the step's text — which is precisely why a role
   * cannot mint one. See {@link WorkflowPatchRecord}.
   */
  readonly record?: WorkflowPatchRecord;
  /**
   * Machine-readable cause of an errored step, so the self-healing retry loop
   * ({@link runWorkflow}) can classify transient-vs-deterministic without
   * regexing an error string.
   *
   * A stalled LLM socket surfaces as `network`, a git index-lock as `git-lock`;
   * these retry. A refused patch (`patch-refused`), a config/plan refusal
   * (`config`), a child that ran out of turns (`turn-ceiling`) or an otherwise
   * unidentified agent error (`agent-error`) do not.
   * Only meaningful when `isError` is `true`. See {@link WorkflowFailureKind}.
   */
  readonly failureKind?: WorkflowFailureKind;
  /**
   * A capped excerpt of the agent's final message, when the step errored.
   *
   * `text` stays `""` on an error — a failed step must never feed the next
   * stage's `{{prev}}` — but the words themselves are evidence: how far the
   * agent got, and often *why* it stopped. The lanes fill this in via
   * {@link finalWordsExcerpt}; the engine journals it on the step's terminal
   * and appends it to the failure message a human reads.
   */
  readonly finalText?: string;
  /**
   * The shape of the agent's last turn, whenever the lane drove one. Carried
   * on every outcome — not only errors — because the void gate in
   * {@link runWorkflow} reclassifies a `done` outcome that produced nothing
   * *after* the lane returned, and that is exactly the step whose last turn a
   * human most needs to see. See {@link LastTurnShape}.
   */
  readonly lastTurn?: LastTurnShape;
  /**
   * What the step's agent spent its turns on — turn count, per-tool call
   * counts, and how many of those calls authored a file. Carried on every
   * outcome a lane actually drove an agent for; absent only where no agent
   * ran at all (a refusal, a cancelled step). See {@link StepActivity}.
   */
  readonly activity?: StepActivity;
}

/** Executes one step. Injected so the engine is testable without an LLM. */
export type WorkflowStepRunner = (request: WorkflowStepRequest) => Promise<WorkflowStepOutcome>;

/** Maps a `[tag]` to a model. Return `undefined` for an unknown tag. */
export type ModelTagResolver = (tag: string) => ModelSpec | undefined;

/** Maps an `@role` to its definition. Return `undefined` for an unknown role. */
export type AgentRoleResolver = (name: string) => AgentDef | undefined;

/**
 * How one step ended.
 *
 * `"paused"` is the human-question gate's terminal: a step whose output raised
 * a question ({@link classifyStepHalt}) neither failed nor completed — it is
 * waiting for a person. It is excluded from a resume's `completed` set on
 * purpose, so the step is not spliced back with its *question* as output; it
 * gets its own set instead (`ResumeState.paused`), from which a resume either
 * injects the human's *answer* in its place or re-surfaces the same pause. It
 * is a settled terminal either way — a paused step is never re-executed. See
 * {@link WorkflowPause} and the run loop in {@link runWorkflow}.
 */
export type WorkflowStepStatus = "done" | "failed" | "skipped" | "cancelled" | "paused";

/**
 * How a whole run ended.
 *
 * `"paused"` is not a failure: a role asked a genuine question the engine
 * cannot answer, so the run stopped *cleanly* at a resumable cut point with the
 * question surfaced to the human (and journalled durably). `/workflow resume
 * <runId> <answer>` re-enters it with the answer and continues from the next
 * stage. A fatal `ORG-HALT` is different — it is a `"failed"` run, not
 * resumable-with-an-answer. See {@link classifyStepHalt}.
 */
export type WorkflowRunStatus = "done" | "failed" | "cancelled" | "paused";

/** The record of one step's execution. */
export interface WorkflowStepResult {
  readonly id: string;
  readonly stageIndex: number;
  readonly branchIndex: number;
  readonly modelTag?: string;
  /** The `@role` the step dispatched to, when it named one. */
  readonly agent?: string;
  /** The fully spliced prompt, or the raw template for a skipped step. */
  readonly prompt: string;
  readonly status: WorkflowStepStatus;
  /**
   * Final text; empty for anything that did not complete.
   *
   * Every {@link WRITE_LANE_TRAILER_PREFIX} line is stripped from it: the
   * canonical trailer the next stage reads is rendered from {@link record},
   * so a role writing one into its own answer changes nothing.
   */
  readonly text: string;
  /**
   * What the engine recorded about this step's diff, when it ran on a
   * worktree lane. Present on a *failed* step too — that a patch did not land
   * is exactly the fact a later gate must not miss.
   */
  readonly record?: WorkflowPatchRecord;
  readonly usage: Usage;
  /** Populated when `status` is `"failed"`. */
  readonly error?: string;
  /**
   * The question this step raised, when `status` is `"paused"`.
   *
   * A role emitted an `ORG-ASK:` line, so the human-question gate paused the run
   * here rather than letting the pipeline guess. The full output stays in
   * {@link text}; this is just the extracted question, surfaced to the human and
   * journalled durably so it survives a crash. See {@link classifyStepHalt}.
   */
  readonly question?: string;
  /**
   * How many attempts the step took, when the self-healing retry loop needed
   * more than one.
   *
   * Absent for the ordinary single-attempt step, so this reads as the signal
   * it is — *this step flapped* — rather than as a column of ones. The count
   * is already on the durable `stepEnd` line; carrying it on the result too is
   * what lets a retrospective see instability it would otherwise have to open
   * the journal file to find.
   */
  readonly attempts?: number;
  /**
   * A capped excerpt of the agent's final message, when the step FAILED.
   *
   * {@link text} is empty on a failed step by contract (nothing may pipe a
   * failure into `{{prev}}`), so this is the only place the agent's last
   * words survive — mirrored onto the durable `stepEnd` line and into the
   * step's {@link error} so a human sees how far the agent got.
   */
  readonly finalText?: string;
  /** Unset for a step that never started. */
  readonly startedAt?: number;
  /** Unset for a step that never finished. */
  readonly endedAt?: number;
  /**
   * What the step's model emitted on its last turn, when a lane drove one.
   * Journalled only for a failed step (see the `stepEnd` line), but carried
   * here on every result so the void gate's reclassification keeps it.
   */
  readonly lastTurn?: LastTurnShape;
  /**
   * What this step's agent spent its turns on — journalled on every terminal,
   * not just a failed one. See {@link StepActivity}.
   */
  readonly activity?: StepActivity;
}

/** The record of one workflow run. */
export interface WorkflowRunResult {
  /** Name of the workflow that ran. */
  readonly workflow: string;
  readonly status: WorkflowRunStatus;
  /** Every step of the workflow, in written order — including skipped ones. */
  readonly steps: readonly WorkflowStepResult[];
  /** The last executed stage's combined output: the run's product. */
  readonly text: string;
  /** Summed usage across every step that reported any. */
  readonly usage: Usage;
  /** Populated when `status` is not `"done"`. */
  readonly error?: string;
  /**
   * The pending question, when `status` is `"paused"` — the FIRST of
   * {@link pauses}, kept as its own field for every reader that just needs
   * "what is this run waiting on?".
   *
   * The human-question gate fired: a role asked something the engine cannot
   * answer, so the run stopped cleanly at a resumable cut point. The command
   * surfaces {@link WorkflowPause.question} to the human (interactively, or on
   * the run result for a headless host) and `/workflow resume <runId> <answer>`
   * continues from the next stage with the answer spliced in.
   */
  readonly pause?: WorkflowPause;
  /**
   * EVERY question the pausing stage raised, in branch order; empty otherwise.
   *
   * A parallel stage can pause on several steps at once — its branches all run
   * to a terminal before the pause short-circuits the rest of the run — and all
   * of them are settled, waiting on a person. Reporting only the first is what
   * left the others invisible to a resume, which then re-executed them (and
   * repeated whatever they had already done), so the pause carries the whole
   * set and the human is asked the stage's questions together.
   */
  readonly pauses: readonly WorkflowPause[];
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * ONE pending human-question pause — an entry of a `"paused"` result's
 * {@link WorkflowRunResult.pauses}, and its {@link WorkflowRunResult.pause}
 * when it is the first.
 *
 * Everything a resume needs to inject the answer at exactly the right place:
 * which step asked (so its output is replaced, not re-run), and the
 * `promptHash` staleness key every resume path guards on.
 */
export interface WorkflowPause {
  /** The step whose `ORG-ASK:` line paused the run. */
  readonly stepId: string;
  readonly stageIndex: number;
  readonly branchIndex: number;
  /** The question text after the `ORG-ASK:` marker — what the human is asked. */
  readonly question: string;
  /** The spliced prompt hash the asking step ran under (resume staleness key). */
  readonly promptHash: string;
  /**
   * What kind of question this is, when it is not a role's `ORG-ASK`.
   *
   * `"step-failure"` marks the STEP-FAILURE PARK: the step did not ask
   * anything, it *failed*, and the run stopped to let a human decide whether
   * to spend again. Readers that word a pause ({@link pauseSummary}, the
   * resume command, the status hint) need to tell the two apart, and the
   * step id cannot tell them — unlike the budget ask's sentinel, this pause
   * is keyed under a real step. Absent means an ordinary `ORG-ASK`.
   */
  readonly reason?: "step-failure";
  /** For a step-failure park: the failed step's last turn, when recorded. */
  readonly lastTurn?: LastTurnShape;
  /** For a step-failure park: what the failed step spent its turns on. */
  readonly activity?: StepActivity;
}

/**
 * Progress events emitted while a workflow runs.
 *
 * Deliberately its own union rather than `AgentEvent`: a workflow's structure
 * (stages, branches, skips) has no `AgentEvent` counterpart. The integration
 * recipe maps these onto `notice` events for the TUI.
 */
export type WorkflowEvent =
  | { readonly type: "workflowStart"; readonly workflow: string; readonly totalSteps: number }
  | {
      readonly type: "stageStart";
      readonly stageIndex: number;
      readonly parallel: boolean;
      readonly steps: number;
      /**
       * The roles and lanes of this stage's steps, in branch order — so a live
       * view can draw the whole stage (including steps not yet started) with
       * each role's lane, not just the one running right now.
       */
      readonly members: readonly WorkflowStageMember[];
    }
  | {
      readonly type: "stepStart";
      readonly id: string;
      readonly stageIndex: number;
      readonly branchIndex: number;
      readonly modelTag?: string;
      readonly agent?: string;
      readonly prompt: string;
      /** Which of the three lanes runs this step. */
      readonly lane: WorkflowDispatch;
      /** Resolved model display name, when the step carried a `[tag]`. */
      readonly model?: string;
    }
  | { readonly type: "stepEnd"; readonly result: WorkflowStepResult }
  | {
      readonly type: "stageEnd";
      readonly stageIndex: number;
      readonly status: WorkflowStepStatus;
      readonly text: string;
    }
  | { readonly type: "workflowEnd"; readonly result: WorkflowRunResult };

/**
 * One member of a stage, named in {@link WorkflowEvent} `stageStart`.
 *
 * Enough for a live view to draw a per-role row before the step runs: its
 * position in the stage, the role it dispatches to, the lane that role runs on
 * (derived from its declared tools, never guessed), and the model it will use.
 */
export interface WorkflowStageMember {
  /** Zero-based position within the stage. */
  readonly branchIndex: number;
  /** The `@role` this step dispatches to, when it named one. */
  readonly agent?: string;
  /** Which of the three lanes runs it. */
  readonly lane: WorkflowDispatch;
  /** Resolved model display name, when the step carried a `[tag]`. */
  readonly model?: string;
}

/** Everything {@link runWorkflow} needs beyond the workflow itself. */
export interface WorkflowRunContext {
  /** Runs one step. */
  runStep: WorkflowStepRunner;
  /** Text typed after the workflow name; splices into `{{input}}`. */
  input?: string;
  /** Resolves `[tag]` prefixes; required only when the workflow uses them. */
  resolveModel?: ModelTagResolver;
  /**
   * Resolves `@role` prefixes; required only when the workflow uses them.
   *
   * Used here for **pre-flight validation only** — the engine never dispatches
   * a role itself. Supplying it means a pipeline whose sixth stage names a
   * role nobody defined fails before its first stage spends anything, exactly
   * as {@link WorkflowRunContext.resolveModel} does for a bad `[tag]`.
   */
  resolveAgent?: AgentRoleResolver;
  /** Every known role name, echoed by the unknown-role error. */
  agentNames?: () => readonly string[];
  /** Progress sink. Listener errors are swallowed — a UI cannot fail a run. */
  onEvent?: (event: WorkflowEvent) => void;
  /** Cancels the run; in-flight steps see an aborted signal. */
  signal?: AbortSignal;
  /** Clock injection point for tests. */
  now?: () => number;
  /**
   * The run's artifact-directory id (`~/.arcturn/workflow-runs/<runId>/`).
   *
   * Carried purely for the journal to record — the same id the write lane was
   * built with, so a resumed run's reconstructed `appliedPatches` point at
   * patch files that still exist. Absent leaves it out of the header.
   */
  runId?: string;
  /**
   * Durable run journal sink (see {@link RunJournal}). Injected so the engine
   * stays testable without a filesystem; production wires
   * {@link createFileRunJournal}. Absent means "do not journal this run".
   */
  journal?: RunJournal;
  /**
   * Resume a previous run from its journal. When present, every step whose id
   * is in {@link ResumeState.completed} is spliced back in from the recorded
   * outcome rather than re-executed — its applied patch is never re-applied —
   * and only the first unfinished step onward runs live. Every step in
   * {@link ResumeState.paused} is likewise never re-executed: it is completed
   * with the human's answer, or re-surfaced as the same pause. See
   * {@link buildResumeState}.
   */
  resumeFrom?: ResumeState;
  /**
   * Ask the real checkout whether a patch is already in it.
   *
   * Resume's reality check: for a step the previous run was killed inside its
   * `git apply`, the journal says only "it was about to". Rather than guess,
   * the driver probes the tree itself — see {@link createPatchVerifier}, which
   * production wires from the write lane. Absent means "cannot verify", which
   * resolves toward *not* re-running the step (see
   * {@link decideInterruptedStep}).
   */
  verifyPatch?: (patchPath: string) => Promise<PatchPresence>;
  /** Self-healing retry policy for transient step failures. */
  retry?: WorkflowRetryPolicy;
  /**
   * Whether this run's origin may raise a ceiling at the stage-boundary budget
   * ask. Defaults to `true` — the interactive terminal.
   *
   * The serve path passes `false`, because the wire contract
   * (`@arcturn/server`'s workflow seam) is that nothing on the wire may raise a
   * ceiling. ONE flag, because it decides two things that must never disagree:
   * whether a `raise` reply is granted, and whether the question even *offers*
   * `raise` as a reply. A question that advertises what its reader will only
   * be refused for sending is an instruction to loop.
   */
  allowBudgetRaise?: boolean;
  /**
   * A dollar ceiling this run's starter bound it to, below (or in place of)
   * the workflow file's own — recorded on the journal header so a *resume*
   * enforces it too. See {@link RunHeaderLine.budgetCapUsd}; only the wire
   * sets it.
   */
  budgetCapUsd?: number;
  /**
   * The local insights ledger (`~/.arcturn/insights/events.jsonl`), when the
   * host wired one.
   *
   * Written beside four of this engine's durable journal writes — a step
   * terminal, a park, a budget checkpoint, the run's end — with names and
   * numbers only (see `insights.ts`'s privacy section). Every write is
   * fire-and-forget: a ledger that cannot be written is a warning, never a run
   * failure. Absent means "do not record this run", which is also what
   * `"insights": false` in config produces.
   *
   * Only recorded for a run with a {@link WorkflowRunContext.runId}: the whole
   * value of the ledger is correlating a silence with the step terminal that
   * followed it, and an anonymous run has nothing to correlate on.
   */
  insights?: InsightsRecorder;
}

/**
 * How the engine self-heals a transient step failure.
 *
 * A step classified transient (a stalled LLM socket, a rate limit that outlived
 * the request-layer retries, a git index lock, a wall-clock deadline) is retried
 * with backoff up to `maxRetries` times. Every retry *shares the step's single
 * wall clock* — the deadline is not multiplied — so a flapping step cannot run
 * `(retries+1)×` its budget; when the shared deadline is spent, retrying stops.
 * A deterministic failure is never retried. See the retry loop in
 * {@link runWorkflow}.
 */
export interface WorkflowRetryPolicy {
  /**
   * Transient retries after the first attempt (default
   * {@link DEFAULT_MAX_STEP_RETRIES}). `0` disables retry. A workflow's
   * `maxStepRetries:` frontmatter key overrides this per run.
   */
  maxRetries?: number;
  /** Injectable backoff sleep (default {@link abortableSleep}), for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable delay computation (default {@link computeBackoffDelay}), for tests. */
  computeDelay?: (attempt: number) => number;
}

// -------------------------------------------------------------------- parsing

const NAME_STRIP = /[^a-z0-9-]/g;
const NUMBERED_LINE = /^(\d+)[.)](?:[ \t]+(.*))?$/;
const BULLET_LINE = /^([ \t]+)([-*+])(?:[ \t]+(.*))?$/;
const TOP_LEVEL_BULLET = /^[-*+][ \t]/;
const MODEL_TAG = /^\[([^\]]*)\][ \t]*(.*)$/;
// ":" is allowed alongside a catalog id's usual characters so a tag may name
// a symbolic tier (`[tier:judgment]`, see `router.ts`'s `resolveModelTag`)
// as well as a concrete model id — resolution of either shape happens
// entirely in the caller-supplied `ModelTagResolver`, which this module
// never inspects.
const VALID_TAG = /^[A-Za-z0-9._/:-]+$/;
const ROLE_TAG = /^@(\S*)(?:[ \t]+(.*))?$/;
const VALID_ROLE = /^[a-z0-9][a-z0-9-]*$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * Normalise a raw name into the `[a-z0-9-]` charset the registry expects.
 *
 * @param raw - Candidate name (a filename stem or a frontmatter value).
 */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(NAME_STRIP, "");
}

/** Frontmatter keys understood by workflow files. */
interface Frontmatter {
  name?: string;
  description?: string;
  continueOnError?: string;
  /** Raw `stepTimeoutMs:` value, validated and parsed by {@link parseWorkflow}. */
  stepTimeoutMs?: string;
  /** Raw `maxStepRetries:` value, validated and parsed by {@link parseWorkflow}. */
  maxStepRetries?: string;
  /** Raw `budgetUsd:` value, validated and parsed by {@link parseWorkflow}. */
  budgetUsd?: string;
  /** Raw `budgetTokens:` value, validated and parsed by {@link parseWorkflow}. */
  budgetTokens?: string;
}

/**
 * Split a markdown workflow file into its optional frontmatter and body.
 *
 * Identical in shape to the skills/agents loaders: a leading `---` line, plain
 * `key: value` pairs with one matched pair of quotes stripped, closed by
 * another `---`. Unknown keys are ignored; an unterminated fence means "there
 * was no frontmatter" rather than a guess.
 *
 * @param raw - Full file contents.
 * @returns The parsed keys, the body, the 1-based line the body starts on
 *   (0 when there was no fence), and `keyLines` — the 1-based file line each
 *   *recognised* key was found on, so a value that fails validation
 *   ({@link parseWorkflow}'s `stepTimeoutMs` check, today) can be reported
 *   line-numbered like every other parse error in this file.
 */
function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
  offset: number;
  keyLines: ReadonlyMap<string, number>;
} {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw, offset: 0, keyLines: new Map() };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: raw, offset: 0, keyLines: new Map() };
  }
  const frontmatter: Frontmatter = {};
  const keyLines = new Map<string, number>();
  for (const [i, line] of lines.slice(1, end).entries()) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
    else if (key === "continueOnError") frontmatter.continueOnError = value;
    else if (key === "stepTimeoutMs") frontmatter.stepTimeoutMs = value;
    else if (key === "maxStepRetries") frontmatter.maxStepRetries = value;
    else if (key === "budgetUsd") frontmatter.budgetUsd = value;
    else if (key === "budgetTokens") frontmatter.budgetTokens = value;
    else continue;
    // Line 1 is the opening fence, so the first body-of-frontmatter line (i=0
    // within the slice) is file line 2.
    keyLines.set(key, i + 2);
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n"), offset: end + 1, keyLines };
}

/** A step line before placeholder validation. */
interface ParsedStepLine {
  modelTag?: string;
  agent?: string;
  prompt: string;
}

/**
 * Pull the optional `[tag]` and `@role` prefixes off a step line.
 *
 * The two prefixes are ordered — `[model] @role prompt` — because a model tag
 * selects *how* a role runs and reads naturally as a modifier on it. Writing
 * them the other way round is rejected rather than silently treated as prose:
 * a model tag swallowed into a prompt is exactly the class of silent misfire
 * a deterministic workflow exists to prevent. The cost is that a prompt which
 * *legitimately* opens with a bracketed token right after a role (`@qa
 * [RFC-0001] verify…`) must move it later in the line; the error message says
 * so.
 *
 * @param text - The step line's text, already trimmed.
 * @param line - 1-based line number, for error messages.
 * @returns The split, or an error for a malformed prefix or an empty prompt.
 */
function parseStepLine(text: string, line: number): ParsedStepLine | WorkflowParseError {
  let rest = text;
  let modelTag: string | undefined;

  const tagged = MODEL_TAG.exec(rest);
  if (tagged) {
    const tag = (tagged[1] ?? "").trim();
    if (tag.length === 0) {
      return {
        error: `line ${line}: model tag is empty; write "[tier:cheap] prompt…" or drop the brackets`,
      };
    }
    if (!VALID_TAG.test(tag)) {
      return {
        error: `line ${line}: model tag "${tag}" may only contain letters, digits, ".", "_", "/", ":" and "-"`,
      };
    }
    rest = (tagged[2] ?? "").trim();
    if (rest.length === 0) {
      return { error: `line ${line}: step has a model tag but no prompt` };
    }
    modelTag = tag;
  }

  const roled = ROLE_TAG.exec(rest);
  if (roled) {
    const raw = (roled[1] ?? "").trim();
    if (raw.length === 0) {
      return {
        error: `line ${line}: role name is empty; write "@architect prompt…" or drop the "@"`,
      };
    }
    const agent = raw.toLowerCase();
    if (!VALID_ROLE.test(agent)) {
      return {
        error: `line ${line}: role name "${raw}" may only contain letters, digits and "-", and must start with a letter or digit`,
      };
    }
    const prompt = (roled[2] ?? "").trim();
    if (prompt.length === 0) {
      return { error: `line ${line}: step names role "@${agent}" but has no prompt` };
    }
    if (modelTag === undefined) {
      const stray = MODEL_TAG.exec(prompt);
      const strayTag = (stray?.[1] ?? "").trim();
      if (strayTag.length > 0 && VALID_TAG.test(strayTag)) {
        return {
          error: `line ${line}: a model tag must come before the role — write "[${strayTag}] @${agent} prompt…"; if "[${strayTag}]" is part of the prompt, move it later in the line`,
        };
      }
    }
    return { ...(modelTag === undefined ? {} : { modelTag }), agent, prompt };
  }

  if (rest.length === 0) {
    return { error: `line ${line}: step has an empty prompt` };
  }
  return { ...(modelTag === undefined ? {} : { modelTag }), prompt: rest };
}

/**
 * Reject any placeholder the runner would not understand.
 *
 * Unknown placeholders are a hard error rather than passed-through text: a
 * typo'd `{{previous}}` reaching the model as literal braces is the kind of
 * silent misfire a deterministic workflow exists to prevent.
 *
 * @param prompt - The step prompt.
 * @param stageIndex - 1-based stage, used to reject `{{prev}}` in stage 1.
 * @param line - 1-based line number, for error messages.
 */
function validatePlaceholders(
  prompt: string,
  stageIndex: number,
  line: number,
): WorkflowParseError | undefined {
  PLACEHOLDER.lastIndex = 0;
  for (const match of prompt.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? "").trim();
    if (name !== "prev" && name !== "input" && name !== "journal") {
      return {
        error: `line ${line}: unknown placeholder "${match[0]}"; only {{prev}}, {{input}} and {{journal}} exist`,
      };
    }
    if ((name === "prev" || name === "journal") && stageIndex === 1) {
      return { error: `line ${line}: {{${name}}} has no value in the first step` };
    }
  }
  return undefined;
}

/** A stage under construction while the body is scanned. */
interface StageDraft {
  index: number;
  line: number;
  text: string;
  branches: { line: number; text: string }[];
}

/**
 * Parse a workflow file.
 *
 * @param raw - Full file contents (frontmatter plus body).
 * @param defaults - Fallbacks for values the file may omit: `name` (normally
 *   the filename stem) and `source` (the absolute path it came from).
 * @returns The parsed {@link Workflow}, or `{ error }` describing the first
 *   problem found — parsing is strict and never partially succeeds.
 */
export function parseWorkflow(
  raw: string,
  defaults: { name?: string; source?: string } = {},
): Workflow | WorkflowParseError {
  const { frontmatter, body, offset, keyLines } = parseFrontmatter(raw);

  const rawName =
    frontmatter.name && frontmatter.name.trim().length > 0
      ? frontmatter.name
      : (defaults.name ?? "");
  const name = normalizeName(rawName.trim());
  if (name.length === 0) {
    return { error: 'workflow has no usable name; set "name:" in the frontmatter' };
  }

  let continueOnError = false;
  if (frontmatter.continueOnError !== undefined) {
    const flag = frontmatter.continueOnError.trim().toLowerCase();
    if (flag !== "true" && flag !== "false") {
      return {
        error: `continueOnError must be "true" or "false", got "${frontmatter.continueOnError}"`,
      };
    }
    continueOnError = flag === "true";
  }

  // A step that never returns is the failure mode this field exists to cap
  // (RFC 0001 §7.1's worktree lanes hold a live shell); reject a bad value now
  // rather than let a typo silently fall back to the default.
  let stepTimeoutMs: number | undefined;
  if (frontmatter.stepTimeoutMs !== undefined) {
    const line = keyLines.get("stepTimeoutMs");
    const prefix = line === undefined ? "" : `line ${line}: `;
    const parsed = Number(frontmatter.stepTimeoutMs.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      return {
        error:
          `${prefix}stepTimeoutMs must be a positive whole number of milliseconds, got ` +
          `"${frontmatter.stepTimeoutMs}"`,
      };
    }
    stepTimeoutMs = parsed;
  }

  // Retry count for a transient step failure. `0` is meaningful (disable the
  // self-healing retry), so the floor is >= 0, not > 0; a typo still fails loud
  // rather than silently reverting to the default.
  let maxStepRetries: number | undefined;
  if (frontmatter.maxStepRetries !== undefined) {
    const line = keyLines.get("maxStepRetries");
    const prefix = line === undefined ? "" : `line ${line}: `;
    const parsed = Number(frontmatter.maxStepRetries.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return {
        error:
          `${prefix}maxStepRetries must be a non-negative whole number, got ` +
          `"${frontmatter.maxStepRetries}"`,
      };
    }
    maxStepRetries = parsed;
  }

  // The run-level budget backstop (RFC 0001 §7.4). `0` is meaningful (matches
  // `shouldAbortForCost`'s own "disabled" convention exactly, so it needs no
  // special case here), hence the floor is >= 0, not > 0 — a typo still fails
  // loud rather than silently reverting to "no ceiling".
  let budgetUsd: number | undefined;
  if (frontmatter.budgetUsd !== undefined) {
    const line = keyLines.get("budgetUsd");
    const prefix = line === undefined ? "" : `line ${line}: `;
    const parsed = Number(frontmatter.budgetUsd.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        error:
          `${prefix}budgetUsd must be a non-negative number of US dollars, got ` +
          `"${frontmatter.budgetUsd}"`,
      };
    }
    budgetUsd = parsed;
  }

  // The run-level TOKEN ceiling — the one budget that can still bite on a
  // model with no published pricing, where `budgetUsd` above compares against
  // a `costUsd` that is never minted. Same `>= 0` floor as `budgetUsd` (`0`
  // is "disabled", matching `shouldAbortForTokens`'s own convention), but a
  // whole number: tokens are counted, not measured.
  let budgetTokens: number | undefined;
  if (frontmatter.budgetTokens !== undefined) {
    const line = keyLines.get("budgetTokens");
    const prefix = line === undefined ? "" : `line ${line}: `;
    const parsed = Number(frontmatter.budgetTokens.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return {
        error:
          `${prefix}budgetTokens must be a non-negative whole number of tokens, got ` +
          `"${frontmatter.budgetTokens}"`,
      };
    }
    budgetTokens = parsed;
  }

  // --- scan the body into stage drafts -----------------------------------
  const drafts: StageDraft[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = offset + i + 1;
    if (rawLine.trim().length === 0) continue;

    const numbered = NUMBERED_LINE.exec(rawLine);
    if (numbered) {
      const index = Number(numbered[1]);
      if (index !== drafts.length + 1) {
        return {
          error: `line ${line}: steps must be numbered consecutively from 1; expected ${drafts.length + 1}, got ${index}`,
        };
      }
      drafts.push({ index, line, text: (numbered[2] ?? "").trim(), branches: [] });
      continue;
    }

    const bullet = BULLET_LINE.exec(rawLine);
    if (bullet) {
      const current = drafts[drafts.length - 1];
      if (!current) {
        return { error: `line ${line}: parallel branch appears before any numbered step` };
      }
      if (bullet[2] !== "-") {
        return { error: `line ${line}: use "-" for a parallel branch, not "${bullet[2]}"` };
      }
      const text = (bullet[3] ?? "").trim();
      if (text.length === 0) {
        return { error: `line ${line}: parallel branch has an empty prompt` };
      }
      current.branches.push({ line, text });
      continue;
    }

    if (TOP_LEVEL_BULLET.test(rawLine)) {
      return {
        error: `line ${line}: a top-level bullet is not a step; use a numbered item, or indent it to make it a parallel branch`,
      };
    }
    if (drafts.length > 0) {
      return {
        error: `line ${line}: unexpected text after the step list; a step is exactly one line (no continuations)`,
      };
    }
    // Prose before the first numbered item is documentation; ignore it.
  }

  if (drafts.length === 0) {
    return { error: "workflow has no steps; write a numbered list of them" };
  }

  // --- turn drafts into stages -------------------------------------------
  const stages: WorkflowStage[] = [];
  for (const draft of drafts) {
    if (draft.branches.length > 0) {
      // A parent line that carries prose AND branches is ambiguous: is the
      // prose a step of its own, or a heading for the branches? Only an
      // explicit label (trailing ":") resolves it without guessing.
      if (draft.text.length > 0 && !draft.text.endsWith(":")) {
        return {
          error: `line ${draft.line}: step ${draft.index} has both a prompt and parallel branches; end the line with ":" to make it a label, or move the prompt into a branch`,
        };
      }
      const steps: WorkflowStep[] = [];
      for (const [branchIndex, branch] of draft.branches.entries()) {
        const parsed = parseStepLine(branch.text, branch.line);
        if (isWorkflowParseError(parsed)) return parsed;
        const bad = validatePlaceholders(parsed.prompt, draft.index, branch.line);
        if (bad) return bad;
        steps.push({
          id: `${draft.index}.${branchIndex + 1}`,
          stageIndex: draft.index,
          branchIndex,
          ...(parsed.modelTag === undefined ? {} : { modelTag: parsed.modelTag }),
          ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
          prompt: parsed.prompt,
        });
      }
      stages.push({
        index: draft.index,
        parallel: true,
        ...(draft.text.length === 0 ? {} : { label: draft.text }),
        steps,
      });
      continue;
    }

    if (draft.text.length === 0) {
      return {
        error: `line ${draft.line}: step ${draft.index} has neither a prompt nor any parallel branches`,
      };
    }
    const parsed = parseStepLine(draft.text, draft.line);
    if (isWorkflowParseError(parsed)) return parsed;
    const bad = validatePlaceholders(parsed.prompt, draft.index, draft.line);
    if (bad) return bad;
    stages.push({
      index: draft.index,
      parallel: false,
      steps: [
        {
          id: String(draft.index),
          stageIndex: draft.index,
          branchIndex: 0,
          ...(parsed.modelTag === undefined ? {} : { modelTag: parsed.modelTag }),
          ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
          prompt: parsed.prompt,
        },
      ],
    });
  }

  return {
    name,
    description: frontmatter.description ?? "",
    continueOnError,
    ...(stepTimeoutMs === undefined ? {} : { stepTimeoutMs }),
    ...(maxStepRetries === undefined ? {} : { maxStepRetries }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
    stages,
    source: defaults.source ?? "",
  };
}

// ------------------------------------------------------------------ discovery

/**
 * Discover and parse every markdown workflow under the given roots.
 *
 * Mirrors `loadSkills`/`loadAgentDefs` exactly: roots are scanned in order and
 * a later root wins a name collision (pass the user root first and the project
 * root second, so a project workflow shadows a user one), a missing root is
 * silently fine, and an unreadable or malformed file is skipped with a warning
 * rather than failing the whole load. Only `<root>/<name>.md` is recognised —
 * there is no folder form, because a workflow has no sibling assets to
 * reference.
 *
 * @param roots - Workflow-root directories, lowest priority first.
 * @param warnings - Optional collector for non-fatal problems.
 */
export async function discoverWorkflows(
  roots: readonly string[],
  warnings: string[] = [],
): Promise<Workflow[]> {
  const byName = new Map<string, Workflow>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
      const file = join(root, entry);
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        warnings.push(`${file}: could not be read (${errorText(error)})`);
        continue;
      }
      const parsed = parseWorkflow(raw, { name: basename(entry, ".md"), source: file });
      if (isWorkflowParseError(parsed)) {
        warnings.push(`${file}: ${parsed.error} (skipped)`);
        continue;
      }
      const existing = byName.get(parsed.name);
      if (existing) {
        warnings.push(`workflow "${parsed.name}" in ${parsed.source} overrides ${existing.source}`);
      }
      byName.set(parsed.name, parsed);
    }
  }
  return [...byName.values()];
}

// ------------------------------------------------------------------ execution

/**
 * Splice `{{prev}}`, `{{input}}` and `{{journal}}` into a step prompt.
 *
 * `journal` defaults to `""` rather than being required, and that default is
 * load-bearing rather than convenience: the run loop expands each step
 * **twice**, once with the digest for the prompt it dispatches and once
 * without it for the prompt it records and hashes. A digest carries the run's
 * own spend and step count, so folding it into the staleness key would make a
 * resumed retro step look like a *changed workflow file* and refuse the run —
 * and journalling it would put a copy of the journal inside the journal.
 *
 * @param template - The step's prompt template.
 * @param prev - The previous stage's combined output.
 * @param input - The user's invocation arguments.
 * @param journal - The run journal digest; omitted where it must not appear.
 */
export function expandStepPrompt(
  template: string,
  prev: string,
  input: string,
  journal = "",
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const key = name.trim();
    return key === "prev" ? prev : key === "journal" ? journal : input;
  });
}

/**
 * Join a stage's branch outputs deterministically, in written order.
 *
 * Each step contributes its (trailer-stripped) text and then, when the engine
 * recorded one, the canonical {@link formatWriteLaneTrailer} line for its
 * patch. Two consequences, both deliberate:
 *
 * - A **failed** worktree step still contributes. Its text is dropped, as
 *   every failed step's is, but its record is not: the next stage's `{{prev}}`
 *   carries `status=refused` rather than carrying nothing at all, which is
 *   what a gate reading "did it land?" needs to see.
 * - A trailer an *agent* wrote is not here, because it was stripped from the
 *   step's text. The only trailers in the pipe are the engine's own.
 *
 * @param results - The stage's step results, in written order.
 */
function combineStageText(results: readonly WorkflowStepResult[]): string {
  return results
    .map((result) =>
      [result.text.trim(), result.record === undefined ? "" : formatWriteLaneTrailer(result.record)]
        .filter((part) => part !== "")
        .join("\n\n"),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** A skipped step's record: never started, so no timestamps and no usage. */
function skippedResult(step: WorkflowStep, status: WorkflowStepStatus): WorkflowStepResult {
  return {
    id: step.id,
    stageIndex: step.stageIndex,
    branchIndex: step.branchIndex,
    ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
    ...(step.agent === undefined ? {} : { agent: step.agent }),
    prompt: step.prompt,
    status,
    text: "",
    usage: emptyUsage(),
  };
}

/** The identity fields a step result carries, whether it ran or was spliced. */
type StepResultBase = Pick<WorkflowStepResult, "id" | "stageIndex" | "branchIndex" | "prompt"> & {
  readonly modelTag?: string;
  readonly agent?: string;
};

/**
 * The result a resume substitutes for an interrupted step it refuses to re-run.
 *
 * This is the shape of the fix for the double-apply: the previous run was
 * killed inside the step's irreversible window, so the honest options are "run
 * it again and maybe apply the same patch twice" or "do not run it again and
 * say exactly why". This is the second one, and it says so in the step's own
 * text, which is what flows into the next stage's `{{prev}}` — the next role
 * reads that its input is a recovery note, not a report.
 *
 * The status is `done` because the *checkout* is in the state the step was
 * driving it to (that is what the evidence in {@link decideInterruptedStep}
 * established); failing here would stop a pipeline whose work already landed.
 * The trailer is not spliced into `text` — `combineStageText` renders it from
 * `record`, and doing both would print it twice.
 *
 * Usage is empty and deliberately so: the interrupted attempt's spend was never
 * written down (the crash beat the `stepEnd` that carries it), and inventing a
 * number for a run's cost ledger is worse than a visible zero.
 *
 * @param base - The step's identity fields.
 * @param interrupted - What the journal recorded before the crash.
 * @param verdict - The ruling and the one-clause reason it is shown with.
 * @param at - Clock reading for the synthetic timestamps.
 */
function recoveredStepResult(
  base: StepResultBase,
  interrupted: InterruptedStep,
  verdict: InterruptedVerdict,
  at: number,
): WorkflowStepResult {
  return {
    ...base,
    status: "done",
    text:
      `(resumed run: step ${base.id} was not re-run because ${verdict.reason}. Its report was ` +
      "lost with the interrupted run; the checkout is as that run left it.)",
    ...(interrupted.record === undefined ? {} : { record: interrupted.record }),
    usage: emptyUsage(),
    startedAt: at,
    endedAt: at,
  };
}

/**
 * Ask a real checkout whether a patch is already in it.
 *
 * `git apply --check --reverse` succeeding means the patch can be *taken back
 * out*, which it only can be if it is in there — the strongest evidence
 * available without trusting a record the crash may have eaten. The forward
 * check is the second question, and it is what makes a re-run safe rather than
 * merely plausible: a patch that still applies cleanly proves the tree is in
 * the pre-apply state, so nothing landed.
 *
 * Anything else — the patch file gone, the tree moved on, git unavailable — is
 * `indeterminate`, and the caller must treat that as "do not re-run". A false
 * "not applied" is the dangerous direction (it re-runs the role, producing a
 * *second* change on top of the first), so the negative answer is the one that
 * has to be earned.
 *
 * @param lane - The write lane, for its checkout and its `git`.
 */
export function createPatchVerifier(
  lane: WriteLane,
): (patchPath: string) => Promise<PatchPresence> {
  return async (patchPath: string): Promise<PatchPresence> => {
    const args = ["apply", "--whitespace=nowarn", "--check"];
    try {
      await lane.exec(lane.cwd, [...args, "--reverse", "--", patchPath]);
      return "applied";
    } catch {
      // Not reversible: either it was never applied, or the tree has moved on.
    }
    try {
      await lane.exec(lane.cwd, [...args, "--", patchPath]);
      return "not-applied";
    } catch {
      return "indeterminate";
    }
  };
}

/**
 * The message shown when a step names a role the host does not know.
 *
 * Shared by the engine's pre-flight check and {@link createRuntimeRunStep}'s
 * dispatch check so the two can never drift apart.
 *
 * @param role - The role name written after `@`.
 * @param stepId - The step that named it.
 * @param known - Every role the host has loaded.
 */
export function unknownRoleError(role: string, stepId: string, known: readonly string[]): string {
  const list =
    known.length === 0
      ? "no roles are loaded (define them as markdown agents in .arcturn/agents/<name>.md)"
      : `known roles: ${[...known].sort().join(", ")}`;
  return `unknown role "@${role}" (step ${stepId}); ${list}`;
}

/**
 * Default per-step wall-clock ceiling, in milliseconds, when a workflow's
 * frontmatter sets no `stepTimeoutMs:` of its own.
 *
 * Ten minutes. A step is one child agent working one task — reproduce a bug,
 * write a patch, run a suite — and in practice that finishes in well under a
 * minute of wall time even on the slower worktree lanes, whose own `git`
 * calls carry a 15s ceiling each. Ten minutes is generous enough to absorb a
 * legitimate `npm install` cold-cache or a slow test suite without nuisance
 * failures, while still bounding the failure mode this exists for: a step
 * whose agent re-runs the same hung command every turn, which `maxTurns`
 * alone does not catch because it caps *turns*, not *time*. A pipeline author
 * who genuinely needs longer sets `stepTimeoutMs:` in the workflow's own
 * frontmatter; nobody should have to.
 */
export const DEFAULT_WORKFLOW_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default transient-failure retries per step, beyond the first attempt.
 *
 * Two, i.e. three attempts total. A transient failure — a stalled provider
 * socket surfaced as `network`, a rate limit that outlived the request layer's
 * own four retries, a git index lock, a step that ate its wall clock — is
 * usually cleared by a fresh attempt, and the request layer already burned its
 * cheap retries before this one ever fires, so a small cap here is enough to
 * ride out a blip without turning a genuinely-down provider into a long, doomed
 * loop. All retries share the step's single deadline (§ {@link WorkflowRetryPolicy}),
 * so this caps *count*, not additional wall time. A deterministic failure is
 * never retried regardless of this number.
 */
export const DEFAULT_MAX_STEP_RETRIES = 2;

/**
 * The message a step fails with when it hits its own wall-clock deadline.
 *
 * @param step - The step that overran.
 * @param stepTimeoutMs - The deadline it was given.
 */
function stepDeadlineError(step: WorkflowStep, stepTimeoutMs: number): string {
  const minutes = stepTimeoutMs / 60_000;
  const label = Number.isInteger(minutes)
    ? `${minutes}-minute`
    : `${formatDuration(stepTimeoutMs)}`;
  return (
    `step ${step.id}${step.agent === undefined ? "" : ` (@${step.agent})`} exceeded its ${label} ` +
    `deadline (${stepTimeoutMs}ms) and was aborted. Its agent was signalled to stop; any teardown ` +
    "the lane performs on abort (background-task reap, worktree preserved for forensics) still " +
    "runs, but this run does not wait for it before moving on."
  );
}

/**
 * The message a step fails with when its role's own `budget:` ceiling is
 * crossed (RFC 0001 §3.2/§7.4/§8.4's per-assignment scope).
 *
 * Mirrors {@link stepDeadlineError} deliberately: a budget breach aborts the
 * step's agent exactly the way a deadline does ({@link runStepWithDeadline}
 * fires the same `stepController.abort()`), so the two messages describe the
 * same shape of event for two different ceilings.
 *
 * @param step - The step whose role exceeded its budget.
 * @param role - The role name (always present — a role budget cannot trip
 *   for a step that named none).
 * @param spentUsd - What the step had actually spent, across every attempt,
 *   at the moment the ceiling tripped.
 * @param limitUsd - The role's own `budget:` ceiling that was crossed.
 */
function roleBudgetExceededError(
  step: WorkflowStep,
  role: string,
  spentUsd: number,
  limitUsd: number,
): string {
  return (
    `step ${step.id} (@${role}) exceeded its $${limitUsd.toFixed(2)} budget ` +
    `(spent $${spentUsd.toFixed(2)}) and was aborted. Its agent was signalled to stop; any ` +
    "teardown the lane performs on abort (background-task reap, worktree preserved for " +
    "forensics) still runs, but this run does not wait for it before moving on."
  );
}

/**
 * The message a run fails with when its own `budgetUsd:` ceiling is crossed —
 * the RFC 0001 §7.4 run-scope backstop behind every role's own per-assignment
 * `budget:`, not any one step's.
 *
 * @param name - The workflow's name.
 * @param spentUsd - The run's cumulative spend at the moment the ceiling tripped.
 * @param limitUsd - The `budgetUsd:` ceiling that was crossed.
 */
function workflowBudgetExceededError(name: string, spentUsd: number, limitUsd: number): string {
  return (
    `workflow "${name}" exceeded its $${limitUsd.toFixed(2)} run budget ` +
    `(spent $${spentUsd.toFixed(2)}); run aborted. No further stage will start. Raise it with ` +
    '"budgetUsd:" in the workflow\'s own frontmatter.'
  );
}

/**
 * The message a run fails with when its own `budgetTokens:` ceiling is
 * crossed — {@link workflowBudgetExceededError}'s sibling for the ceiling
 * that can still fire when the dollar one cannot: a model with no published
 * pricing never mints a `costUsd`, but tokens are counted on every turn.
 *
 * `en-US` grouping on both numbers, deliberately: a 60000000-token ceiling
 * is unreadable, and this message is the moment the operator compares the
 * two figures.
 *
 * @param name - The workflow's name.
 * @param spentTokens - Total tokens the run consumed (input + output + cache
 *   read + cache write) at the moment the ceiling tripped.
 * @param limitTokens - The `budgetTokens:` ceiling that was crossed.
 */
function workflowTokenBudgetExceededError(
  name: string,
  spentTokens: number,
  limitTokens: number,
): string {
  return (
    `workflow "${name}" exceeded its ${limitTokens.toLocaleString("en-US")}-token run budget ` +
    `(spent ${spentTokens.toLocaleString("en-US")} tokens); run aborted. No further stage will ` +
    'start. Raise it with "budgetTokens:" in the workflow\'s own frontmatter.'
  );
}

/**
 * The consumed fraction at which the stage-boundary budget ask arms.
 *
 * 80% is the point where the *next* stage is plausibly the one the hard
 * ceiling kills — late enough that most runs never see the question, early
 * enough that answering it can still save the run.
 */
const BUDGET_ASK_FRACTION = 0.8;

/**
 * Parse a resume reply as a budget-raise instruction.
 *
 * Engine-side on purpose — the command parser hands every answer through
 * verbatim, and this grammar only applies when the pending question IS a
 * budget ask: at a role's `ORG-ASK`, "raise 40" is just words and threads
 * through as an ordinary answer, untouched.
 *
 * @param text - The verbatim resume answer.
 * @returns `undefined` when the reply is not raise-shaped at all. A
 *   raise-shaped reply whose value does not parse comes back with a `NaN`
 *   `value`, so the engine can name the problem ("raise fifty" is a bad
 *   raise, not an acknowledgement).
 */
export function parseBudgetRaiseAnswer(
  text: string,
): { readonly raw: string; readonly value: number } | undefined {
  const match = /^raise\s+(\S+)$/i.exec(text.trim());
  if (match === null) return undefined;
  const raw = match[1] ?? "";
  // Tolerate the notations the ask itself renders: `$4.00`, `1,000,000`.
  const cleaned = raw.replace(/^\$/, "").replace(/,/g, "");
  return { raw, value: cleaned === "" ? Number.NaN : Number(cleaned) };
}

/**
 * Whether a reply is the affirmative that answers a budget ask.
 *
 * {@link parseBudgetRaiseAnswer}'s sibling, and deliberately a *word*: an empty
 * resume writes no consent (see {@link BUDGET_ACK_ANSWER}). Case- and
 * whitespace-insensitive, and nothing else — the question names the exact word,
 * and a guessed synonym would be the engine deciding a person meant "yes".
 *
 * @param text - The verbatim resume answer.
 */
export function isBudgetAckAnswer(text: string): boolean {
  return text.trim().toLowerCase() === BUDGET_ACK_ANSWER;
}

/**
 * Whether a raise value is spendable as this ceiling's own unit.
 *
 * Dollars are decimal; tokens are *counted*, and `budgetTokens:` in the
 * frontmatter refuses a fractional value at parse time. A `raise 1000.5` on a
 * token ask that the file itself would have rejected leaves the run under a
 * ceiling the workflow language does not have — so the resume enforces the
 * same rule. Exponent and hex notation go with it (`Number("0x400")` is 1024,
 * and nobody typing a token budget means that): a token raise is digits.
 *
 * @param ceiling - Which ceiling is being raised.
 * @param raw - The reply's raw value, before `$`/`,` were stripped.
 * @param value - The numeric value {@link parseBudgetRaiseAnswer} produced.
 */
function isSpendableRaise(ceiling: BudgetCeilingKind, raw: string, value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  if (ceiling === "usd") return true;
  return Number.isInteger(value) && /^\d[\d,]*$/.test(raw.trim());
}

/**
 * Render one budget figure in its ceiling's own notation, for the raise
 * validation messages — dollars as {@link formatCost} prints them everywhere
 * else (so a sub-cent figure never renders as the "$0.00" that reads "this was
 * free"), tokens in the same `en-US` grouping the token ceiling's message uses.
 */
function formatBudgetValue(ceiling: BudgetCeilingKind, value: number): string {
  return ceiling === "usd"
    ? formatCost(value)
    : `${value.toLocaleString("en-US")} token${value === 1 ? "" : "s"}`;
}

/**
 * The refusal both raise-blocking sites render, in one place.
 *
 * The serve path refuses a raise-shaped answer before the run starts (fail
 * fast, and the client gets an error rather than a silently re-parked run);
 * the engine refuses it again for any host that forgets to. Two sites, one
 * contract, and therefore one sentence — a drift between them would be two
 * different accounts of what the wire may do.
 *
 * @param source - The workflow file, which the operator may edit instead.
 */
export function budgetWireRaiseRefusal(source: string): string {
  return (
    `A run's ceiling cannot be raised over the wire; resume from the terminal, or edit ` +
    `${source}. Reply "${BUDGET_ACK_ANSWER}" to run on to the ceiling already in force.`
  );
}

/**
 * Whether a reply is the affirmative that re-runs a step parked by a
 * step-failure ask.
 *
 * {@link isBudgetAckAnswer}'s twin, and a *word* for the same reason: a retry
 * is money, and an empty resume is not a decision to spend it. Case- and
 * whitespace-insensitive, and nothing else — the question names the exact
 * word, and a guessed synonym would be the engine deciding a person meant
 * "yes, spend again".
 *
 * @param text - The verbatim resume answer.
 */
export function isStepRetryAnswer(text: string): boolean {
  return text.trim().toLowerCase() === STEP_RETRY_ANSWER;
}

/**
 * Whether a reply is the one that ends a parked run `failed` — today's
 * behaviour, now chosen rather than imposed.
 *
 * @param text - The verbatim resume answer.
 */
export function isStepAbandonAnswer(text: string): boolean {
  return text.trim().toLowerCase() === STEP_ABANDON_ANSWER;
}

/**
 * Lift the turn ceiling that tripped out of the cause {@link turnCeilingCause}
 * wrote, so a `raise <n>` can be validated against a real number.
 *
 * A targeted pattern rather than "the first integer in the string": the cause
 * is followed by the agent's own final words, and a role named `v2-indexer`
 * would otherwise donate its digit. Absent when the cause does not name a
 * count (a role file with no `maxTurns:` under a loop message this engine did
 * not write), and the raise is then validated as a positive integer alone.
 *
 * @param message - The failing step's error text.
 */
export function turnCeilingFromCause(message: string | undefined): number | undefined {
  if (message === undefined) return undefined;
  const match = /\bits (\d+)-turn ceiling\b/.exec(message);
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Whether a turn-raise value is a ceiling this engine can hand a child agent.
 *
 * {@link isSpendableRaise}'s sibling for the turn ceiling, and it follows the
 * *token* rule rather than the dollar one: turns are counted, `maxTurns:` in a
 * role file refuses a fractional value, and `Number("0x400")` is 1024 — which
 * nobody typing a turn budget means.
 *
 * @param raw - The reply's raw value, before `,` was stripped.
 * @param value - The numeric value {@link parseBudgetRaiseAnswer} produced.
 */
function isCountableRaise(raw: string, value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  return Number.isInteger(value) && /^\d[\d,]*$/.test(raw.trim());
}

/**
 * The refusal a raise-shaped answer to a step-failure ask gets over the wire.
 *
 * The exact posture of {@link budgetWireRaiseRefusal}, because it is the exact
 * contract: nothing on the wire may lift a ceiling — a dollar one, a token one
 * or a turn one. Two sites (the serve path refuses before the run starts, the
 * engine refuses again for any host that forgets to), one sentence.
 *
 * @param source - The workflow file, whose role files the operator may edit.
 */
export function turnWireRaiseRefusal(source: string): string {
  return (
    "A turn ceiling cannot be raised over the wire; resume from the terminal, or edit the role " +
    `file behind ${source}. Reply "${STEP_RETRY_ANSWER}" to run the step again under the ` +
    `ceiling already in force, or "${STEP_ABANDON_ANSWER}" to end the run.`
  );
}

/**
 * A role's declared per-assignment ceiling, or `undefined` when it opted out.
 *
 * Mirrors {@link shouldAbortForCost}'s own "`0`/absent disables" convention
 * so a role file with no `budget:` line (or `budget: 0`, or a negative/
 * non-finite value) behaves exactly like one that turned the guard off on
 * purpose — never like a role that forgot to think about cost.
 *
 * @param def - The resolved role. See the `declare module "./agents.js"`
 *   augmentation above for why `.budget` exists on this type at all.
 */
function roleBudgetUsd(def: AgentDef): number | undefined {
  const raw = def.budget;
  return raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * What {@link runStepWithDeadline} needs to enforce a role's own `budget:`
 * ceiling in real time, across every attempt of one step.
 */
interface StepBudgetCeiling {
  /** The role's own `budget:` ceiling (already validated positive). */
  readonly limitUsd: number;
  /**
   * What earlier attempts of this *same* step already spent, priced — `0` on
   * the first attempt. A role's ceiling is a per-*assignment* budget (RFC
   * 0001 §7.4), i.e. across every retry of the step it was assigned to, not
   * a fresh allowance per attempt; without this, a step that flapped twice
   * before healing could spend its budget three times over and never trip.
   */
  readonly priorSpentUsd: number;
  /**
   * For pricing a runner's raw usage when it reports no `costUsd` of its
   * own — the same fallback {@link priceStepUsage} uses, and for the same
   * reason: real turns are priced at the provider boundary and normally
   * arrive already carrying it, so this is a safety net, not the common path.
   */
  readonly model: ModelSpec | undefined;
}

/** What one raced step attempt came back with. */
type StepAttempt =
  | { readonly kind: "settled"; readonly outcome: WorkflowStepOutcome }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "timeout"; readonly usage: Usage }
  | { readonly kind: "budget"; readonly usage: Usage; readonly spentUsd: number };

/**
 * One attempt's raced result, plus the cost telemetry the retry loop rolls up.
 *
 * `usage` is what *this attempt* spent, **whatever its outcome** — a failed
 * attempt still called the provider and still burned tokens, so the retry loop
 * above needs its spend as much as the survivor's. It is taken from the
 * settled outcome when there is one, and otherwise from the best-known
 * progressive total (`request.onUsage`), which is the only source a timed-out
 * or throwing attempt leaves behind.
 *
 * `turns` counts the model turns observed on this attempt's stream, one per
 * `onUsage` call — {@link driveAgent} calls it exactly once per `turnEnd`, so
 * this is the real turn count for every lane, and `0` for a runner that reports
 * no progressive usage at all (a test double, or a step refused before it ever
 * reached a model).
 */
interface StepAttemptRun {
  readonly attempt: StepAttempt;
  readonly usage: Usage;
  readonly turns: number;
}

/**
 * Run one step's `runStep` call under its own wall-clock deadline.
 *
 * Mirrors `scouts.ts`'s `runScouts` deadline: a per-step `AbortController` is
 * derived from `parentSignal` (so the workflow's own cancellation — Ctrl+C —
 * still reaches the step exactly as it always did) and additionally aborted
 * when `deadlineMs` elapses first. Either way the step sees an aborted
 * `signal`, which is the same path {@link driveAgent} already drives
 * `agent.abort()` from — this adds a second reason to fire that path, not a
 * new one.
 *
 * The race does not wait for `runStep` to actually settle once the deadline
 * wins: an agent that ignores its abort signal must not hold the whole
 * pipeline hostage. `onFulfilled`/`onRejected` are both attached to `runStep`'s
 * own promise before the race, so the loser can never surface as an unhandled
 * rejection — it simply keeps running (and, on the worktree lanes, keeps
 * tearing down: killing background tasks, preserving the worktree) in the
 * background, unobserved by this call.
 *
 * A timeout must not under-report what the abandoned step actually spent —
 * the runaway-turn loop this deadline exists for is precisely the expensive
 * case, so reporting {@link emptyUsage} for it would hide the cost the guard
 * exists to surface. Two independent sources feed `lastKnownUsage`, and
 * whichever lands closer to the deadline wins:
 *
 * 1. `request.onUsage` — wired to `runStep`'s copy of the request — is called
 *    with the running total on every turn by a runner that drives a real
 *    agent ({@link driveAgent}), so even a call that never settles (it
 *    ignores its abort signal entirely) leaves its last-known spend on hand.
 * 2. A `.then` on `runStep`'s own promise, attached before the race exactly
 *    like `settled`'s, so a runner that only reports a final
 *    {@link WorkflowStepOutcome} (no progressive `onUsage` calls) still has
 *    its usage picked up if that promise happens to settle — even having
 *    lost the race — before this function's caller reads the timeout
 *    attempt's `usage` field.
 *
 * Neither source is waited on: both are fire-and-forget updates to a plain
 * local, so this function still returns the instant the deadline (or the
 * settled/threw race) resolves.
 *
 * ENFORCED PER-ROLE BUDGETS (RFC 0001 §8.4) ride the exact same mechanism:
 * `onUsage` below — already the deadline's early-warning system — is also
 * where a role's own `budget:` ceiling is checked on every turn, so a
 * runaway-cost step is aborted the instant the ceiling is crossed rather than
 * only once it happens to finish or hit its wall clock. A breach sets
 * `budgetTripped` and fires the very same `stepController.abort()` the
 * deadline timer fires; the race below does not need a third branch for it
 * because — exactly like an external `parentSignal` cancellation, which also
 * has no dedicated race arm — the abort makes `settled` resolve on its own
 * once the runner notices its signal. `budgetTripped` is checked *after* the
 * race regardless of which side won it, so a step whose very last turn both
 * finished the task **and** crossed the ceiling is still reported as a
 * breach: the money was spent either way.
 *
 * @param runStep - The injected step runner.
 * @param request - The step's request, built with a placeholder `signal` —
 *   this function supplies the real (derived) one.
 * @param parentSignal - The workflow's own cancellation signal.
 * @param deadlineMs - This step's wall-clock ceiling.
 * @param budget - The role's own per-assignment ceiling, when it declared
 *   one. `undefined` disables this function's budget check entirely (a step
 *   with no `@role`, or a role with no `budget:`, spends exactly as it
 *   always did).
 */
async function runStepWithDeadline(
  runStep: WorkflowStepRunner,
  request: WorkflowStepRequest,
  parentSignal: AbortSignal,
  deadlineMs: number,
  budget?: StepBudgetCeiling,
): Promise<StepAttemptRun> {
  const stepController = new AbortController();
  const onParentAbort = (): void => stepController.abort();
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal.aborted) stepController.abort();

  let fireDeadline: () => void = () => {};
  const deadline = new Promise<void>((resolve) => {
    fireDeadline = resolve;
  });
  const timer = setTimeout(() => {
    stepController.abort();
    fireDeadline();
  }, deadlineMs);
  // A dedicated race arm for the budget check below, mirroring `deadline`
  // above for the same reason: `stepController.abort()` alone only makes
  // `settled` resolve *if the runner actually notices its signal*. A real
  // agent does (`driveAgent` drives `agent.abort()` off it); a runner that
  // ignores it — the exact runaway case both this guard and the deadline
  // exist to catch — would otherwise leave this whole function waiting on
  // `deadline` instead, which is a wall-clock ceiling potentially minutes
  // away, not the budget breach that just happened. Resolves to the same
  // `"timeout"` sentinel as `deadline`'s own race arm on purpose: whichever
  // of the two fired is disambiguated by `budgetTripped` below, so the race
  // itself does not need a third distinct value.
  let fireBudgetBreach: () => void = () => {};
  const budgetBreach = new Promise<void>((resolve) => {
    fireBudgetBreach = resolve;
  });

  // What the step has spent, best known so far — see the doc comment above
  // for the two sources that keep this current without ever being awaited.
  let lastKnownUsage: Usage = emptyUsage();
  // Model turns burned by this attempt: one per progressive usage report, which
  // `driveAgent` emits exactly once per `turnEnd`. Counted here rather than
  // reported by the runner so it survives the paths that never produce an
  // outcome at all — the timed-out runaway is precisely the run whose turn
  // count an operator wants.
  let turns = 0;
  // Set the instant this attempt's own spend, plus whatever earlier attempts
  // of the same step already cost, reaches the role's ceiling. Checked once
  // per turn, in `onUsage` below, so the trip is real-time rather than a
  // post-hoc audit of a step that already finished spending.
  let budgetTripped: { readonly spentUsd: number } | undefined;
  const onUsage = (spent: Usage): void => {
    lastKnownUsage = spent;
    turns += 1;
    if (budget === undefined || budgetTripped !== undefined) return;
    // Real turns are priced at the provider boundary and normally arrive
    // already carrying `costUsd` (see `priceStepUsage`'s doc comment); the
    // `calculateCostUsd` fallback exists for a runner that reports raw token
    // counts only. Neither source known ⇒ this turn's cost cannot be judged
    // against a dollar ceiling, so the check simply does not fire — the same
    // "never fabricate a price" rule `priceStepUsage` follows.
    const pricedUsd = spent.costUsd ?? (budget.model && calculateCostUsd(budget.model, spent));
    if (pricedUsd === undefined) return;
    const spentSoFarUsd = budget.priorSpentUsd + pricedUsd;
    if (!shouldAbortForCost(spentSoFarUsd, budget.limitUsd)) return;
    budgetTripped = { spentUsd: spentSoFarUsd };
    stepController.abort();
    fireBudgetBreach();
  };

  try {
    const run = runStep({ ...request, signal: stepController.signal, onUsage });
    // A settlement this function abandons on a timeout still updates
    // `lastKnownUsage` if it lands in time — deliberately un-awaited, so it
    // can never delay the race below, and errors are swallowed: a runner
    // that rejects has no usage to report here (its `"threw"` arm, when it
    // wins the race, carries none either). It updates the spend *without*
    // going through `onUsage`: a final settlement is not another turn, and
    // counting it as one would over-report every step by exactly one.
    run
      .then((outcome) => {
        lastKnownUsage = outcome.usage;
      })
      .catch(() => {});
    // Both arms handled ⇒ `settled` itself can never reject, so racing it
    // (and abandoning it on a timeout) can never produce an unhandled
    // rejection no matter how long `runStep`'s own promise keeps running.
    const settled: Promise<StepAttempt> = run.then(
      (outcome) => ({ kind: "settled", outcome }),
      (error) => ({ kind: "threw", error }),
    );
    // `lastKnownUsage` is read here, back in this function's own body, and
    // deliberately not inside the `deadline.then` callback below: that
    // callback (and the race it feeds) can settle *before* the fire-and-forget
    // update above has run, since both are reactions racing on the same
    // microtask queue. Reading after the `await` gives the update every
    // chance it has to land first without this function waiting an instant
    // longer for it.
    const raced = await Promise.race([
      settled,
      deadline.then((): "timeout" => "timeout"),
      budgetBreach.then((): "timeout" => "timeout"),
    ]);
    // A budget breach always wins, regardless of which side of the race above
    // resolved — see this function's doc comment for why "the last turn also
    // happened to finish the task" must not erase the breach it caused.
    const attempt: StepAttempt =
      budgetTripped !== undefined
        ? { kind: "budget", usage: lastKnownUsage, spentUsd: budgetTripped.spentUsd }
        : raced === "timeout"
          ? { kind: "timeout", usage: lastKnownUsage }
          : raced;
    // A settled attempt's own outcome is authoritative for its spend; a
    // timeout, a budget breach or a throw has no outcome, so the progressive
    // total is all there is — and it is real money, not `emptyUsage()`.
    const usage = attempt.kind === "settled" ? attempt.outcome.usage : lastKnownUsage;
    return { attempt, usage, turns };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/** How one attempt of a step ended, for the self-healing retry decision. */
type AttemptClass = "ok" | "transient" | "deterministic";

/**
 * Classify one raced step attempt for the retry loop.
 *
 * A `timeout` is a transient wall-clock stall the retry loop *may* re-attempt
 * (only if budget remains — see {@link runStepAttempts}); a `budget` breach is
 * deterministic on purpose — a role's ceiling is a per-*assignment* limit
 * (RFC 0001 §7.4), so retrying it would only spend past it again, never heal
 * it; a `threw` is an exceptional, unclassified fault treated as
 * deterministic (safer to fail fast than to loop on an unknown throw); a
 * `settled` outcome defers to the `failureKind` the runner threaded, via
 * {@link classifyFailureKind}. A successful settle is `ok`.
 *
 * @param attempt - The raced attempt from {@link runStepWithDeadline}.
 */
function classifyAttempt(attempt: StepAttempt): AttemptClass {
  if (attempt.kind === "timeout") return "transient";
  if (attempt.kind === "budget") return "deterministic";
  if (attempt.kind === "threw") return "deterministic";
  if (!attempt.outcome.isError) return "ok";
  return classifyFailureKind(attempt.outcome.failureKind);
}

/** What {@link runStepAttempts} came back with. */
interface StepAttemptResult {
  /** The final attempt (a success, or the last failure retries could not heal). */
  readonly attempt: StepAttempt;
  /** How many attempts were made — 1 plus the retries actually taken. */
  readonly attempts: number;
  /**
   * Tokens spent by **every** attempt, failed ones included.
   *
   * A retried step called the provider once per attempt and was billed once
   * per attempt; reporting only the survivor's usage would understate a
   * flapping step — a step that burns 100 tokens, flaps, burns 40, flaps, then
   * succeeds on 7 costs 147, not 7. Flapping is the *expensive* case, so
   * under-reporting it is exactly backwards: it hides spend from the cost
   * guard, the run total and the durable `stepEnd` line that a post-hoc audit
   * (and `/workflow status`) read.
   */
  readonly usage: Usage;
  /** Model turns observed across every attempt (see {@link StepAttemptRun}). */
  readonly turns: number;
}

/**
 * Run one step under its deadline, self-healing transient failures with backoff.
 *
 * Composition, innermost to outermost: the LLM stall timeout and the request
 * retry live in `@arcturn/ai` and feed a single attempt; {@link
 * runStepWithDeadline} bounds one attempt; *this* loop bounds one step across
 * attempts; the run's own budget/deadline (enforced elsewhere) bounds the whole
 * run.
 *
 * The step's wall clock is **shared, not multiplied**: an absolute deadline is
 * fixed at the first attempt (`now + stepTimeoutMs`), and every attempt — plus
 * its backoff sleep — draws from the same budget. A step that spends its entire
 * deadline on one attempt has nothing left and is not retried; a step that fails
 * transiently in seconds keeps almost its whole budget for another try. This is
 * what makes "retries share the wall clock" true, and it also gives the `timeout`
 * class its natural "at most about once" behaviour for free: a full-deadline
 * timeout leaves no budget to retry.
 *
 * A deterministic failure (a refused patch, a config refusal, an unclassified
 * throw) returns immediately — retrying an outcome that cannot change only burns
 * tokens and wall clock. A cancellation (`parentSignal` aborted) also returns at
 * once: retrying against a cancelled run is pointless. A `budget` breach
 * (ENFORCED PER-ROLE BUDGETS, RFC 0001 §8.4) is deterministic for the same
 * reason — see {@link classifyAttempt}.
 *
 * `roleBudgetLimitUsd`, when given, is the role's own per-*assignment*
 * ceiling — i.e. across every attempt of this one step, not a fresh
 * allowance each retry. `spent.costUsd` (this loop's own running ledger) is
 * threaded into {@link runStepWithDeadline} as each attempt's
 * `priorSpentUsd`, so a step that spent $1.00 on a failed attempt and is
 * retried starts its second attempt already $1.00 into the same ceiling.
 *
 * @param runStep - The injected step runner.
 * @param request - The step's request; `attempt` is overwritten per try.
 * @param parentSignal - The run's cancellation signal (also the retry budget's).
 * @param stepTimeoutMs - The step's single wall-clock deadline, shared by all attempts.
 * @param maxRetries - Transient retries after the first attempt (0 disables retry).
 * @param policy - Injectable backoff sleep and delay computation.
 * @param now - Clock, for the shared-deadline math.
 * @param roleBudgetLimitUsd - The step's role's `budget:` ceiling, already
 *   validated positive by {@link roleBudgetUsd}; `undefined` for a step with
 *   no `@role` or a role that declared none, which disables this check.
 */
async function runStepAttempts(
  runStep: WorkflowStepRunner,
  request: WorkflowStepRequest,
  parentSignal: AbortSignal,
  stepTimeoutMs: number,
  maxRetries: number,
  policy: Required<Pick<WorkflowRetryPolicy, "sleep" | "computeDelay">>,
  now: () => number,
  roleBudgetLimitUsd: number | undefined,
): Promise<StepAttemptResult> {
  const absoluteDeadline = now() + stepTimeoutMs;
  let attempts = 0;
  let last: StepAttempt | undefined;
  // The step's *cumulative* ledger: every attempt's spend and turns fold in
  // here as it happens, so whichever of the returns below fires reports what
  // the whole step cost — not just what its final attempt cost.
  let spent = emptyUsage();
  let turns = 0;
  /** Close the step out with the running ledger attached. */
  const done = (attempt: StepAttempt): StepAttemptResult => ({
    attempt,
    attempts,
    usage: spent,
    turns,
  });

  for (;;) {
    const remaining = absoluteDeadline - now();
    // No budget left for another attempt — return what the last one produced.
    // Unreachable on the first pass (remaining === stepTimeoutMs > 0).
    if (attempts > 0 && remaining <= 0) return done(last as StepAttempt);

    attempts += 1;
    // Built fresh every attempt: `priorSpentUsd` is `spent` as of the *start*
    // of this iteration — every earlier attempt's cost, none of this one's —
    // exactly what a per-assignment ceiling (not a per-attempt one) requires.
    const stepBudget: StepBudgetCeiling | undefined =
      roleBudgetLimitUsd === undefined
        ? undefined
        : {
            limitUsd: roleBudgetLimitUsd,
            priorSpentUsd: spent.costUsd ?? 0,
            model: request.model,
          };
    const run = await runStepWithDeadline(
      runStep,
      // The retry index is added to whatever base the request already carries,
      // never assigned over it. The engine seeds that base with the attempts
      // this step has already burned in EARLIER runs (see the step-failure
      // park), so a worktree-lane retry across a resume gets a slug of its own
      // instead of colliding with the forensic worktree its last failure kept.
      { ...request, attempt: (request.attempt ?? 0) + attempts - 1 },
      parentSignal,
      Math.max(1, remaining),
      stepBudget,
    );
    const attempt = run.attempt;
    // Fold this attempt in *before* any decision below: every exit from here
    // on must carry it, including the failure the loop gives up on.
    spent = addUsage(spent, run.usage);
    turns += run.turns;
    last = attempt;

    // A cancelled run never retries — the outcome is the cancellation itself.
    if (parentSignal.aborted) return done(attempt);
    const cls = classifyAttempt(attempt);
    if (cls === "ok" || cls === "deterministic") return done(attempt);
    // Transient, but out of retries.
    if (attempts > maxRetries) return done(attempt);

    // Back off, bounded by the step's *remaining* shared budget so a sleep can
    // never push past the deadline; abort of the run cancels the sleep.
    const budget = absoluteDeadline - now();
    if (budget <= 0) return done(attempt);
    const delay = Math.min(policy.computeDelay(attempts), budget);
    try {
      await policy.sleep(delay, parentSignal);
    } catch {
      // The sleep was aborted (run cancelled) — stop here with the last failure.
      return done(attempt);
    }
    if (parentSignal.aborted) return done(attempt);
  }
}

/**
 * Give a step's usage a `costUsd` when one can be known — the engine's single
 * cost mint point.
 *
 * Cost is *priced at the provider boundary*, not here: `@arcturn/ai` prices
 * every assistant turn against the exact {@link ModelSpec} that served it (see
 * its `pricedUsage`), which is the only place cache-read/cache-write rates and
 * a role's own `model:` override are all known. So a step's usage normally
 * arrives already carrying `costUsd`, and this function leaves it alone.
 *
 * The fallback exists for the runner that reports raw token counts with no
 * price attached: when the step named a `[tag]`, the engine holds that tag's
 * resolved spec and can price the tokens itself rather than throw the number
 * away. It never invents a price it cannot compute — a step with no spec and no
 * reported cost stays unpriced, and the spend it contributes is reported as
 * *absent*, never as `$0.00`.
 *
 * @param usage - The step's summed usage across all its attempts.
 * @param model - The spec resolved from the step's `[tag]`, when it had one.
 */
function priceStepUsage(usage: Usage, model: ModelSpec | undefined): Usage {
  if (usage.costUsd !== undefined || model === undefined) return usage;
  const cost = calculateCostUsd(model, usage);
  return cost === undefined ? usage : { ...usage, costUsd: cost };
}

// ------------------------------------------------------ human-question gate

/**
 * The line-prefix a role emits to PAUSE the run for a human answer.
 *
 * The org's best behaviour — asking instead of guessing — used to be its worst
 * friction: a role that hit a genuine spec ambiguity emitted an `ORG-HALT` and
 * the whole run died, so the human re-ran from scratch and lost every finished
 * stage. A `{@link WORKFLOW_ASK_PREFIX}` line is that same "I need a person"
 * signal, but the engine now recognises it structurally and *pauses* at a
 * resumable cut point instead. See {@link classifyStepHalt} and
 * {@link runWorkflow}.
 */
export const WORKFLOW_ASK_PREFIX = "ORG-ASK:";

/**
 * The line-prefix a role emits for a FATAL halt — unsafe, impossible, or an
 * oracle it will not tamper with. Unlike {@link WORKFLOW_ASK_PREFIX}, no human
 * answer unblocks it, so the run *fails* (short-circuiting later stages) rather
 * than pausing. Kept engine-recognised so the two are never confused: a genuine
 * dead-end is not a question, and a question is not a dead-end.
 */
export const WORKFLOW_HALT_PREFIX = "ORG-HALT:";

/** A question a role raised via an {@link WORKFLOW_ASK_PREFIX} line. */
export interface WorkflowQuestion {
  /** The full marker line, verbatim (trimmed). */
  readonly marker: string;
  /** The text after the prefix, trimmed — what the human is asked. */
  readonly question: string;
}

/**
 * How a completed step's output classifies against the human-question gate.
 *
 * `undefined` — an ordinary step, nothing to gate on.
 * `"halt"` — a fatal `ORG-HALT`: the run fails, not resumable-with-an-answer.
 * `"ask"` — an `ORG-ASK`: the run pauses for a human answer, resumable.
 */
export type WorkflowHaltKind =
  | { readonly kind: "halt"; readonly reason: string }
  | { readonly kind: "ask"; readonly question: WorkflowQuestion };

/**
 * Classify a step's output for the human-question gate.
 *
 * A marker is recognised only at the *start of a line* (after leading
 * whitespace), so a role that quotes the convention in prose ("emit a line
 * beginning ORG-ASK:") does not trip the gate. A fatal `ORG-HALT` takes
 * precedence over a question anywhere in the same output: a declared dead-end is
 * never downgraded to a mere ask.
 *
 * The engine reads this off {@link WorkflowStepOutcome.text} rather than trusting
 * a status the agent set, for the same reason patch records are engine-minted:
 * the model reports, the engine decides. See {@link runWorkflow}.
 *
 * @param text - A step's final output text.
 * @returns The classification, or `undefined` for an ordinary step.
 */
export function classifyStepHalt(text: string): WorkflowHaltKind | undefined {
  let ask: WorkflowQuestion | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (line.startsWith(WORKFLOW_HALT_PREFIX)) {
      return { kind: "halt", reason: line.trim() };
    }
    if (ask === undefined && line.startsWith(WORKFLOW_ASK_PREFIX)) {
      ask = {
        marker: line.trim(),
        question: line.slice(line.indexOf(WORKFLOW_ASK_PREFIX) + WORKFLOW_ASK_PREFIX.length).trim(),
      };
    }
  }
  return ask === undefined ? undefined : { kind: "ask", question: ask };
}

/**
 * The human-facing one-liner a paused run reports as its `error` text.
 *
 * It reaches `--print` and CI, so it states *every* question the stage raised:
 * an operator told about one of two questions answers one of two, and a person
 * who never saw the second question cannot have answered it. The
 * single-question wording is untouched — that is the common case, and it reads
 * as a sentence.
 *
 * @param pauses - The stage's pauses, in branch order.
 */
/**
 * How a run that stopped for a person announces itself — the two openings
 * every {@link pauseSummary} sentence starts with. Shared with
 * {@link isWorkflowHumanStop} so a headless host can recognise the condition
 * from the notice text without the wording living in two places.
 */
const HUMAN_STOP_OPENINGS = { paused: "Workflow paused", parked: "Workflow parked" } as const;

/**
 * Whether a notice is a workflow stopping for a human — a budget checkpoint,
 * a role's `ORG-ASK`, or a step-failure park — as opposed to finishing or
 * failing. `--print` maps it to its own exit code: a CI job must be able to
 * tell "done" from "waiting for you" without grepping.
 */
export function isWorkflowHumanStop(text: string): boolean {
  return text.startsWith(HUMAN_STOP_OPENINGS.paused) || text.startsWith(HUMAN_STOP_OPENINGS.parked);
}

function pauseSummary(pauses: readonly WorkflowPause[]): string {
  const first = pauses[0];
  if (first === undefined) return "";
  if (pauses.length === 1) {
    // The budget ask is a run-level question with no step behind it — "at
    // step budget" would send the operator hunting for a step that does not
    // exist. It never coexists with a role's pause (the ask only fires on a
    // stage that paused nothing), so only the single-pause wording needs it.
    if (first.stepId === BUDGET_ASK_STEP_ID) {
      return `${HUMAN_STOP_OPENINGS.paused} at a budget checkpoint: ${first.question}`;
    }
    // The step-failure park is not a question a role asked — it is the run
    // reporting that a step broke and stopping to be told what to do about
    // it. "Paused for a human answer at step 5" would read as an `ORG-ASK`,
    // which is exactly the wrong thing to go looking for in the transcript.
    if (first.reason === "step-failure") {
      return `${HUMAN_STOP_OPENINGS.parked} at a failed step (${first.stepId}): ${first.question}`;
    }
    return `${HUMAN_STOP_OPENINGS.paused} for a human answer at step ${first.stepId}: ${first.question}`;
  }
  const asked = pauses.map((pause) => `${pause.stepId}: ${pause.question}`).join(" · ");
  return (
    `${HUMAN_STOP_OPENINGS.paused} for human answers at ${pauses.length} steps of stage ` +
    `${first.stageIndex} — ${asked}`
  );
}

/**
 * Run a workflow to completion.
 *
 * Stages execute in order; a stage's steps execute together. Each stage's
 * combined output becomes the next stage's `{{prev}}`. A failed step
 * short-circuits every later stage (unless `continueOnError`), and an aborted
 * signal cancels in-flight steps and marks the remainder `skipped`.
 *
 * Every step also runs under its own wall-clock deadline —
 * {@link Workflow.stepTimeoutMs} if the file set one, else
 * {@link DEFAULT_WORKFLOW_STEP_TIMEOUT_MS} — because `maxTurns` bounds a
 * runaway agent's *turns*, not its *time*, and a single stuck tool call (a
 * server that never exits, a hung network request) can otherwise keep a step
 * — and the pipeline behind it — running effectively forever. A step that
 * hits its deadline is aborted ({@link runStepWithDeadline}) and recorded as
 * `"failed"`, exactly like any other step failure: it short-circuits later
 * stages unless `continueOnError`, same as always. The workflow's own
 * cancellation (`context.signal`) is unaffected by any of this and keeps
 * working the way it always did.
 *
 * Never rejects: a step runner that throws is recorded as a failed step, and
 * every other problem surfaces as a non-`"done"` {@link WorkflowRunResult}.
 *
 * @param workflow - A parsed workflow.
 * @param context - Step runner, inputs, model resolver, event sink, signal.
 */
export async function runWorkflow(
  workflow: Workflow,
  context: WorkflowRunContext,
): Promise<WorkflowRunResult> {
  const now = context.now ?? Date.now;
  const input = context.input ?? "";
  const startedAt = now();
  const allSteps = workflow.stages.flatMap((stage) => stage.steps);

  const emit = (event: WorkflowEvent): void => {
    if (!context.onEvent) return;
    try {
      context.onEvent(event);
    } catch {
      // A progress listener must never be able to fail a workflow run.
    }
  };

  // The durable run journal (§ resumability). Every append is best-effort — a
  // journal write must never be able to fail a run, exactly like `emit` — so a
  // missing sink or a swallowed write degrades to "not recorded", never a crash.
  const journal = context.journal;
  const journalAppend = (line: JournalLine): Promise<void> =>
    journal ? journal.append(line) : Promise.resolve();
  /**
   * Append a line correctness depends on, and let the failure through.
   *
   * The best-effort `append` above is right for a roll-up and wrong for the
   * records that decide whether a killed run can be resumed without repeating
   * an irreversible act — see {@link DURABLE_JOURNAL_KINDS}. A sink that cannot
   * promise durability (every in-memory double, and any host that implements
   * only `append`) falls back to it, which is safe because resume treats an
   * un-recorded step as opaque rather than as "nothing happened".
   */
  const journalDurable = (line: JournalLine): Promise<void> => {
    if (!journal) return Promise.resolve();
    // Guard rail: only the records resume depends on may fail a run. Anything
    // else routed here by a later edit degrades to best-effort instead of
    // quietly gaining the power to kill a step over a full disk.
    if (!DURABLE_JOURNAL_KINDS.has(line.kind)) return journalAppend(line);
    return journal.appendDurable ? journal.appendDurable(line) : journal.append(line);
  };
  /**
   * The insights ledger for this run, when the host wired one AND this run has
   * an id to correlate on. Every use below is fire-and-forget: `record` never
   * throws and never blocks, so a diagnostic cannot slow — let alone fail — a
   * pipeline. See `insights.ts`.
   */
  const insightsRunId = context.runId ?? "";
  const insights =
    insightsRunId !== "" && context.insights?.enabled === true ? context.insights : undefined;
  /** Distinct model ids this run's steps actually ran on, for its `run-end`. */
  const insightsModels = new Set<string>();
  /** How many times this run parked on a failed step, for its `run-end`. */
  let insightsParks = 0;

  const resumeFrom = context.resumeFrom;
  // A resumed run appends to the *existing* journal; its `run` header is already
  // on disk, so writing a second one would be wrong — true whenever a resume
  // state was supplied at all, even one whose crash left no finished step.
  const resuming = resumeFrom !== undefined;

  // ------------------------------------------- the human-question gate, on resume
  /**
   * Every step the previous run PAUSED on, by id — each one settled, waiting
   * on a person, and never to be executed again.
   */
  const pausedSteps = resumeFrom?.paused;
  /** The prompt hash each pending question was asked under, by step id. */
  const askedHashes = new Map<string, string>();
  for (const question of resumeFrom?.pendings ?? []) {
    askedHashes.set(question.stepId, question.promptHash);
  }
  if (resumeFrom?.pending !== undefined && !askedHashes.has(resumeFrom.pending.stepId)) {
    askedHashes.set(resumeFrom.pending.stepId, resumeFrom.pending.promptHash);
  }
  /** Answers addressed to one specific question (`answers`, then `answer`). */
  const exactAnswers = new Map<string, string>();
  for (const supplied of resumeFrom?.answers ?? [])
    exactAnswers.set(supplied.stepId, supplied.text);
  const stageReply = resumeFrom?.answer;
  if (stageReply !== undefined && !exactAnswers.has(stageReply.stepId)) {
    exactAnswers.set(stageReply.stepId, stageReply.text);
  }
  /**
   * The stage a single {@link ResumeState.answer} replies to.
   *
   * The gate surfaces a stage's questions *together* (that is what makes two
   * reviewers pausing in one parallel stage answerable at all), so the reply is
   * a reply to the stage: it settles every paused step of that stage which has
   * no answer of its own. The alternative — settle only the addressed question
   * and pause again for each sibling — would make a person answer N times for
   * one conversation they have already had, and every intermediate pause would
   * re-ask questions they already answered. A host that genuinely wants one
   * question settled at a time uses {@link ResumeState.answers}, which never
   * spills.
   */
  const repliedStage =
    stageReply === undefined
      ? undefined
      : (resumeFrom?.pendings ?? []).find((q) => q.stepId === stageReply.stepId)?.stage;
  /** The human's answer for one step, or `undefined` if it has none. */
  const answerForStep = (step: WorkflowStep): string | undefined => {
    const exact = exactAnswers.get(step.id);
    if (exact !== undefined) return exact;
    if (stageReply === undefined || repliedStage !== step.stageIndex) return undefined;
    // The spill only ever reaches a step with a RECORDED pause: a reply can
    // settle a question that was asked, never a step that never ran.
    return pausedSteps?.has(step.id) === true ? stageReply.text : undefined;
  };

  // -------------------------------------------- the budget-ask gate, on resume
  /**
   * What this origin may do about a budget ask — read by the raise check AND
   * by every render of the question, so the two can never disagree.
   */
  const askAudience = { allowRaise: context.allowBudgetRaise !== false };
  /**
   * The hard cap this run's *starter* bound it to, when that ceiling did not
   * come from the workflow file: a wire run's `budgetUsd`, which
   * `resolveRunBudget` already refused to let rise above the file's.
   *
   * Load-bearing on a resume. A fresh wire run is handed a bounded *copy* of
   * the parsed workflow, so `workflow.budgetUsd` below IS the lowered figure;
   * a resume rediscovers the workflow from disk and gets the file's full
   * ceiling back. Without the cap the client's $0.50 quietly became the file's
   * $1.00 the moment anybody resumed — and the plain resume the budget-ask
   * refusal itself recommends was exactly such a resume. Read from the journal
   * on a resume, from the starter on a fresh run.
   */
  const budgetCapUsd = resumeFrom?.budgetCapUsd ?? context.budgetCapUsd;
  /** The lower of two ceilings, treating `undefined` as "no ceiling of mine". */
  const tighter = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  /**
   * The run's *effective* ceilings: a journalled `budgetRaise` from an earlier
   * resume beats the frontmatter value, from the very start of the run, and
   * the starter's cap bounds whatever comes out of that. A `let`, because a
   * raise granted by THIS resume's reply updates it below — and never by
   * mutating the parsed workflow or the file: the file stays the authority for
   * every *fresh* run, and this run's grant lives in its own journal.
   */
  let budgetUsdLimit = tighter(
    resumeFrom?.budgetRaises?.get("usd") ?? workflow.budgetUsd,
    budgetCapUsd,
  );
  let budgetTokensLimit = resumeFrom?.budgetRaises?.get("tokens") ?? workflow.budgetTokens;
  /**
   * Ceilings whose ask a human already answered `continue` to — ask-once, per
   * ceiling: the acknowledged ceiling never asks again this run and will
   * hard-stop exactly as it always did. A raise is deliberately NOT in here:
   * it re-arms the ask against the new limit.
   */
  const budgetAsked = new Set<BudgetCeilingKind>(resumeFrom?.budgetAcks ?? []);
  /**
   * A pause to re-surface before anything runs: the pending budget ask, when
   * this resume did not settle it — no reply at all, a bare nudge, a reply
   * that parses as neither a raise nor the acknowledgement, a malformed or
   * insufficient raise, or a raise from an origin without raise authority. A
   * bad reply re-parks the run with the reason; it never fails it.
   */
  let resurfacedAsk: WorkflowPause | undefined;
  const pendingAsk = resumeFrom?.budgetAsk;
  if (pendingAsk !== undefined) {
    const reply = resumeFrom?.budgetAnswer;
    const raise = reply === undefined ? undefined : parseBudgetRaiseAnswer(reply.text);
    const resurface = (reason?: string): void => {
      const question = budgetAskQuestion(pendingAsk, askAudience);
      resurfacedAsk = {
        stepId: BUDGET_ASK_STEP_ID,
        // The stage's *position*, matching the fresh park below — and the only
        // stage locator the durable ask line carries.
        stageIndex: pendingAsk.stagesDone,
        branchIndex: 0,
        question: reason === undefined ? question : `${reason} ${question}`,
        promptHash: "",
      };
    };
    if (reply === undefined || reply.text.trim() === "") {
      // NO ANSWER. A resume that never addressed the ask — a hand-built state,
      // a crash of the answering host, a client script that nudges every
      // stalled run — re-parks on the same question, and writes NOTHING.
      //
      // The empty gesture used to write the durable `budgetAck` this engine
      // calls "the operator's consent on record", including for a run that
      // crashed between the ask reaching disk and the pause that would have
      // shown it to anybody. Consent nobody gave is not consent, and the
      // role-pause gate already holds this exact line ("an answer, not a
      // nudge"); spending past a ceiling warning needs a person's word.
      resurface(
        reply === undefined
          ? undefined
          : "A budget checkpoint needs an answer, not a nudge — nothing was spent.",
      );
    } else if (isBudgetAckAnswer(reply.text)) {
      // The affirmative: an informed "keep going". Recorded durably so this
      // ceiling never asks again this run — best-effort on the write itself,
      // because an unwritable ack costs one repeated question on a later
      // resume, never the run.
      budgetAsked.add(pendingAsk.ceiling);
      try {
        await journalDurable({ kind: "budgetAck", ceiling: pendingAsk.ceiling, ts: now() });
      } catch {
        // Acknowledged in memory for this run regardless.
      }
    } else if (raise === undefined) {
      resurface(`Reply "${oneLine(reply.text, 60)}" was not understood, so nothing was spent.`);
    } else if (!askAudience.allowRaise) {
      // Terminal-only, by the wire seam's contract. The serve path already
      // refuses raise-shaped answers before starting the run; this is the
      // engine keeping its own invariant for any host that forgets to.
      resurface(budgetWireRaiseRefusal(workflow.source));
    } else if (!isSpendableRaise(pendingAsk.ceiling, raise.raw, raise.value)) {
      resurface(
        pendingAsk.ceiling === "usd"
          ? `"raise ${oneLine(raise.raw, 30)}" needs a positive number.`
          : `"raise ${oneLine(raise.raw, 30)}" needs a positive whole number of tokens, ` +
              "written in digits — the same value budgetTokens: would accept.",
      );
    } else if (raise.value <= pendingAsk.limit || raise.value <= pendingAsk.spent) {
      resurface(
        `A raise must exceed both the current ` +
          `${formatBudgetValue(pendingAsk.ceiling, pendingAsk.limit)} ceiling and the ` +
          `${formatBudgetValue(pendingAsk.ceiling, pendingAsk.spent)} already spent; ` +
          `${formatBudgetValue(pendingAsk.ceiling, raise.value)} does not.`,
      );
    } else if (
      pendingAsk.ceiling === "usd" &&
      budgetCapUsd !== undefined &&
      raise.value > budgetCapUsd
    ) {
      // The starter's cap outranks even a terminal raise. This run was started
      // under a ceiling somebody else asked for; lifting it here would let the
      // acknowledged resume do what the wire was refused at run start. A fresh
      // run is the way to spend more than the run was commissioned for.
      resurface(
        `This run was started with a ${formatCost(budgetCapUsd)} cap of its own, which no ` +
          `resume may lift; ${formatCost(raise.value)} is above it. Start a fresh run to ` +
          "spend more.",
      );
    } else {
      // A valid raise: this run continues under the new ceiling, and the ask
      // re-arms against it. Durable because the grant must survive a crash —
      // a resumed run that forgot its raise would hard-stop at a limit the
      // human already lifted.
      if (pendingAsk.ceiling === "usd") budgetUsdLimit = raise.value;
      else budgetTokensLimit = raise.value;
      try {
        await journalDurable({
          kind: "budgetRaise",
          ceiling: pendingAsk.ceiling,
          value: raise.value,
          ts: now(),
        });
      } catch {
        // The raise still governs this run; only its record degraded.
      }
    }
  }

  // -------------------------------------- the step-failure gate, on resume
  /**
   * Run-scoped turn grants, by {@link turnRaiseKey}. Seeded from the journal
   * so a grant made two resumes ago still governs, and added to below when
   * THIS resume's reply grants one. Never by editing a role file: the file is
   * the authority for every *fresh* run, and this run's grant lives in its own
   * journal.
   */
  const turnRaises = new Map<string, number>(resumeFrom?.turnRaises ?? []);
  /**
   * A step-failure park to re-surface before anything runs: this resume did
   * not settle the pending ask — no reply, a bare nudge, a reply that is
   * neither `retry` nor `abandon` nor a valid raise, or a raise from an origin
   * without raise authority. A bad reply re-parks the run with the reason; it
   * never fails it, and it never silently retries (that is the whole point:
   * every rerun is an explicit human gesture).
   */
  let resurfacedFailAsk: WorkflowPause | undefined;
  /**
   * Set when the human answered `abandon`: the run ends `failed` with the
   * step's own cause, exactly as it did before this gate existed.
   */
  let abandonedFailure: string | undefined;
  /** True when the abandoned failure was a turn ceiling, for the `stop` label. */
  let abandonedTurnCeiling = false;
  const pendingFailAsk = resumeFrom?.stepFailAsk;
  if (pendingFailAsk !== undefined) {
    const reply = resumeFrom?.stepFailAnswer;
    const raise = reply === undefined ? undefined : parseBudgetRaiseAnswer(reply.text);
    const resurface = (reason?: string): void => {
      const question = stepFailAskQuestion(pendingFailAsk, askAudience);
      resurfacedFailAsk = {
        stepId: pendingFailAsk.stepId,
        // The step's own coordinates are not on the durable ask line — a
        // re-surfaced copy can only restate what was recorded — so the pause
        // is reported at the run's own origin, exactly as the budget ask's is.
        stageIndex: 0,
        branchIndex: 0,
        question: reason === undefined ? question : `${reason} ${question}`,
        promptHash: "",
        reason: "step-failure",
      };
    };
    if (reply === undefined || reply.text.trim() === "") {
      // NO ANSWER. A resume that never addressed the park — a hand-built
      // state, a crash of the answering host, a client script that nudges
      // every stalled run — re-parks on the same question and spends nothing.
      // The same line the role-pause and budget gates hold.
      resurface(
        reply === undefined
          ? undefined
          : "A parked step needs an answer, not a nudge — nothing was spent.",
      );
    } else if (isStepAbandonAnswer(reply.text)) {
      // The tombstone, chosen. Recorded durably so a later read can tell "the
      // human stopped this" from "the ask was never answered" — best-effort
      // on the write itself, because the run is ending either way.
      abandonedFailure = pendingFailAsk.cause;
      abandonedTurnCeiling = pendingFailAsk.failureKind === "turn-ceiling";
      try {
        await journalDurable({ kind: "stepAbandon", stepId: pendingFailAsk.stepId, ts: now() });
      } catch {
        // The run still ends failed; only its record degraded.
      }
    } else if (isStepRetryAnswer(reply.text)) {
      // The affirmative: run that step again under the ceiling in force. No
      // line is written for it — the retry's own `stepEnd` is the record, and
      // a crash before that lands re-asks rather than spending twice on one
      // gesture.
    } else if (raise === undefined) {
      resurface(`Reply "${oneLine(reply.text, 60)}" was not understood, so nothing was spent.`);
    } else if (pendingFailAsk.failureKind !== "turn-ceiling") {
      // `raise` is the turn ceiling's lever and nothing else's. A refused
      // patch or a config error is not made runnable by more turns, and
      // pretending otherwise would sell a rerun that fails the same way.
      resurface(
        `This step did not run out of turns, so there is no turn ceiling to raise; reply ` +
          `"${STEP_RETRY_ANSWER}" or "${STEP_ABANDON_ANSWER}".`,
      );
    } else if (!askAudience.allowRaise) {
      // Terminal-only, by the wire seam's contract — the same flag, and the
      // same posture, as the budget raise. The serve path already refuses
      // raise-shaped answers before starting the run; this is the engine
      // keeping its own invariant for any host that forgets to.
      resurface(turnWireRaiseRefusal(workflow.source));
    } else if (!isCountableRaise(raise.raw, raise.value)) {
      resurface(
        `"raise ${oneLine(raise.raw, 30)}" needs a positive whole number of turns, written in ` +
          "digits — the same value maxTurns: would accept.",
      );
    } else if (pendingFailAsk.ceiling !== undefined && raise.value <= pendingFailAsk.ceiling) {
      resurface(
        `A raise must exceed the ${String(pendingFailAsk.ceiling)}-turn ceiling that just ` +
          `tripped; ${String(raise.value)} does not.`,
      );
    } else {
      // A valid raise: this run's copy of the role runs under the new ceiling,
      // and the step is retried. Durable because the grant must survive a
      // crash — a resumed run that forgot its raise would walk into the same
      // wall the human already lifted.
      turnRaises.set(turnRaiseKey(pendingFailAsk.stepId, pendingFailAsk.role), raise.value);
      try {
        await journalDurable({
          kind: "turnRaise",
          stepId: pendingFailAsk.stepId,
          ...(pendingFailAsk.role === undefined ? {} : { role: pendingFailAsk.role }),
          value: raise.value,
          ts: now(),
        });
      } catch {
        // The raise still governs this run; only its record degraded.
      }
    }
  }

  /**
   * Set when journaling was never possible; surfaced on the run result.
   *
   * Declared here, above `finish`, because `finish` runs from the pre-flight
   * validation too — long before the stage loop's own state exists.
   */
  let journalUnavailable: string | undefined;

  const finish = (
    status: WorkflowRunStatus,
    steps: WorkflowStepResult[],
    text: string,
    usage: Usage,
    error?: string,
    paused: readonly WorkflowPause[] = [],
  ): WorkflowRunResult => {
    // A journal that never worked costs resumability, not the run. Say so on
    // the result rather than letting working steps report as a failure — and
    // never silently, which is the habit this whole layer exists to break.
    const body =
      journalUnavailable === undefined ? text : `${text}\n\n${journalUnavailable}`.trim();
    // `pause` is the first of `pauses`: one question for the readers that want
    // one, the whole set for a resume, which must know about every paused step
    // or it will re-execute the ones it never heard of.
    const firstPause = paused[0];
    const result: WorkflowRunResult = {
      workflow: workflow.name,
      status,
      steps,
      text: body,
      usage,
      ...(error === undefined ? {} : { error }),
      ...(firstPause === undefined ? {} : { pause: firstPause }),
      pauses: paused,
      startedAt,
      endedAt: now(),
    };
    // The terminal journal line: its *absence* on read is precisely how
    // `/workflow status` and resume tell a clean end from a process that died
    // mid-run. Fire-and-forget — a run that already produced its result must
    // not be held up (or failed) by one last append.
    //
    // Not awaiting it is safe because the CLI ends by setting `process.exitCode`
    // and letting the loop drain, never by calling `process.exit()`: the pending
    // `fs` write holds the loop open and flushes first. An embedder that does
    // hard-exit can lose this line, and the cost of that is bounded — the run
    // reads back as interrupted, and resuming it replays every completed step
    // from the journal rather than re-executing anything. Tests that delete the
    // journal directory in a `finally` must tolerate this trailing write (see
    // the `rm(..., { maxRetries })` calls in `workflow.test.ts`).
    void journalAppend({ kind: "runEnd", status, ts: now() });
    // The ledger's own terminal, beside the journal's. Everything on it is a
    // name or a number: no prompt, no output, no path, no session id.
    insights?.record({
      kind: "run-end",
      workflow: workflow.name,
      runId: insightsRunId,
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      durationMs: Math.max(0, now() - startedAt),
      usage,
      ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      models: [...insightsModels],
      // Steps that actually reached a terminal — a run short-circuited at
      // stage 2 did not "run" the nine steps it skipped.
      steps: steps.filter((step) => step.status !== "skipped").length,
      parks: insightsParks,
    });
    emit({ type: "workflowEnd", result });
    return result;
  };

  emit({ type: "workflowStart", workflow: workflow.name, totalSteps: allSteps.length });

  // Resolve every `[tag]` before spending a single token: a workflow whose
  // third step names a model that does not exist must fail now, not after two
  // paid steps.
  const models = new Map<string, ModelSpec>();
  for (const step of allSteps) {
    if (step.modelTag === undefined || models.has(step.modelTag)) continue;
    const spec = context.resolveModel?.(step.modelTag);
    if (!spec) {
      const detail = context.resolveModel
        ? `unknown model tag "[${step.modelTag}]" (step ${step.id})`
        : `workflow uses model tag "[${step.modelTag}]" but no model resolver was supplied`;
      return finish(
        "failed",
        allSteps.map((s) => skippedResult(s, "skipped")),
        "",
        emptyUsage(),
        detail,
      );
    }
    models.set(step.modelTag, spec);
  }

  // Same reasoning for `@role`: a typo'd role in stage 6 must not be paid for
  // by stages 1–5. The engine only *validates* here; dispatch stays in the
  // injected runner, which resolves the role again for itself.
  for (const step of allSteps) {
    if (step.agent === undefined) continue;
    if (!context.resolveAgent) {
      return finish(
        "failed",
        allSteps.map((s) => skippedResult(s, "skipped")),
        "",
        emptyUsage(),
        `workflow uses role "@${step.agent}" (step ${step.id}) but no role resolver was supplied`,
      );
    }
    const def = context.resolveAgent(step.agent);
    if (!def) {
      return finish(
        "failed",
        allSteps.map((s) => skippedResult(s, "skipped")),
        "",
        emptyUsage(),
        unknownRoleError(step.agent, step.id, context.agentNames?.() ?? []),
      );
    }
    // A role that declares no tools is refused here for the same reason it is
    // refused at dispatch: "everything" is not a lane, and finding that out in
    // stage 6 would mean paying for stages 1–5 first.
    if (def.tools === undefined) {
      return finish(
        "failed",
        allSteps.map((s) => skippedResult(s, "skipped")),
        "",
        emptyUsage(),
        undeclaredToolsError(def.name, step.id),
      );
    }
  }

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  context.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (context.signal?.aborted) controller.abort();

  // Observability metadata for the event stream: the lane a step runs on
  // (derived from its role's declared tools, exactly as dispatch derives it —
  // never guessed) and the model it will use. Both are read-only look-ups off
  // the already-validated resolvers, so they cannot change what runs.
  const laneOf = (step: WorkflowStep): WorkflowDispatch => {
    if (step.agent === undefined) return "read";
    const def = context.resolveAgent?.(step.agent);
    return def ? roleDispatch(def) : "read";
  };
  const modelNameOf = (step: WorkflowStep): string | undefined =>
    step.modelTag === undefined ? undefined : models.get(step.modelTag)?.displayName;
  // ENFORCED PER-ROLE BUDGETS (RFC 0001 §8.4): the same read-only look-up
  // `laneOf` already performs, reused for the role's own `budget:` ceiling.
  const roleBudgetOf = (step: WorkflowStep): number | undefined => {
    if (step.agent === undefined) return undefined;
    const def = context.resolveAgent?.(step.agent);
    return def ? roleBudgetUsd(def) : undefined;
  };
  /**
   * The run-scoped turn ceiling a human granted for this step, if any.
   *
   * Keyed by {@link turnRaiseKey} — the role when the step named one, so a
   * later stage dispatching the same role inherits the rope rather than
   * parking again for the answer that was already given.
   */
  const turnCeilingFor = (step: WorkflowStep): number | undefined =>
    turnRaises.get(turnRaiseKey(step.id, step.agent));
  /**
   * How many times this step has already been run and failed in this run,
   * across resumes — the base the retry loop's own index continues from.
   *
   * Only the step named by the ask this resume is answering has one: every
   * other step is either finished (replayed from the journal) or has never
   * run.
   */
  const priorAttemptsFor = (stepId: string): number =>
    resumeFrom?.stepFailAsk?.stepId === stepId ? resumeFrom.stepFailAsk.attempts : 0;

  const stepTimeoutMs = workflow.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS;

  // Self-healing retry policy: an explicit injection wins, else the workflow's
  // own `maxStepRetries:`, else the engine default. Backoff sleep and delay
  // reuse the request-layer's abortable/jittered implementation rather than
  // hand-rolling a second one.
  const maxStepRetries =
    context.retry?.maxRetries ?? workflow.maxStepRetries ?? DEFAULT_MAX_STEP_RETRIES;
  const retryPolicy: Required<Pick<WorkflowRetryPolicy, "sleep" | "computeDelay">> = {
    sleep: context.retry?.sleep ?? abortableSleep,
    computeDelay: context.retry?.computeDelay ?? ((attempt) => computeBackoffDelay(attempt)),
  };

  // On a fresh run, open the journal with its header before a single token is
  // spent; a resumed run appends to the header already there. Fire-and-forget:
  // serialized appends keep it ordered ahead of the stage lines regardless.
  if (!resuming) {
    void journalAppend({
      kind: "run",
      v: RUN_JOURNAL_SCHEMA_VERSION,
      runId: context.runId ?? "",
      workflow: workflow.name,
      source: workflow.source,
      input,
      stepTimeoutMs,
      maxStepRetries,
      startedAt,
      // The starter's own cap, so a resume enforces it too. Best-effort like
      // the rest of the header, and safely so: neither resume entry point can
      // continue a run whose header never landed (both read the workflow's
      // name from it), so there is no state where the cap is lost and the run
      // goes on regardless.
      ...(context.budgetCapUsd === undefined ? {} : { budgetCapUsd: context.budgetCapUsd }),
    });
  }

  const results: WorkflowStepResult[] = [];
  // The run's own accumulated state: what a later stage's worktree is seeded
  // with. Snapshotted per stage, so a parallel stage's branches all see the
  // same base no matter which of them finishes first.
  const appliedPatches: string[] = [];
  let usage = emptyUsage();
  // Model turns burned by this run's *live* steps, for the budget snapshot the
  // status view renders. A resumed step contributes none: the journal's
  // `stepEnd` line records a step's usage but not its turn count, so a resumed
  // run counts the turns it actually spends rather than inventing the earlier
  // run's. (Spend has no such gap — `usage.costUsd` is on the recorded line.)
  let runTurns = 0;
  let prev = "";
  // `abandon` at a step-failure park seeds the failure the park was holding
  // open, so every stage is skipped and the run ends `failed` with the step's
  // own cause — byte-for-byte the outcome this engine produced before the park
  // existed, now reached because a person chose it.
  let failure: string | undefined = abandonedFailure;
  let cancelled = controller.signal.aborted;
  /**
   * ENFORCED PER-ROLE BUDGETS' run-level backstop (RFC 0001 §7.4): set once
   * the workflow's own `budgetUsd:` — or `budgetTokens:` — ceiling is
   * crossed. Short-circuits every
   * later stage unconditionally, `continueOnError` included — like `pending`
   * below, a money ceiling is not the kind of per-step failure that flag
   * exists to paper over. `failure` is still set alongside it (see the check
   * itself, after the stage loop below) so the run reports `"failed"` with
   * the ceiling's own message even when no individual step ever failed.
   */
  let budgetExhausted = false;
  /**
   * Record, once, why the whole run halted — the `stop` line
   * {@link WorkflowStopReason} was defined for.
   *
   * It had no writer at all: `workflow-status.ts` reads it, folds it into
   * `JournalRun.stopReason` and renders it as `stopped: <reason>` / `stop:
   * <reason>`, and every run in the wild left that blank. So a pipeline killed
   * by its own `budgetUsd:` ceiling looked, in `/workflow status`, exactly like
   * one that hit a broken step — which is the single question an operator opens
   * that view to answer.
   *
   * Best-effort like every other roll-up: the crash-consistency guarantee is
   * the per-step `stepEnd`, and a run must not fail over a diagnostic.
   *
   * @param reason - Why the pipeline stopped.
   */
  let stopRecorded = false;
  /** The reason recorded above, so the run's `run-end` insight can carry it. */
  let stopReason: WorkflowStopReason | undefined;
  const recordStop = (reason: WorkflowStopReason): void => {
    if (stopRecorded) return;
    stopRecorded = true;
    stopReason = reason;
    void journalAppend({ kind: "stop", reason, ts: now() });
  };
  /**
   * Steps whose child agent ran out of turns, by id — the raw material for the
   * run's `turn-ceiling` stop reason, not the reason itself.
   *
   * The distinction is the bug this closes. Turn exhaustion is discovered
   * *inside* the step loop, and `recordStop` is first-wins, so recording it
   * there beat the stage boundary's own cost/token checks: a run halted by its
   * money ceiling reported `stop: turn-ceiling` whenever any earlier step had
   * also run out of turns (reachable under `continueOnError`, and whenever one
   * step did both). `/workflow status` exists to answer "what killed this",
   * and a budget breach must not be relabelled — so the ceilings record their
   * stop as they happen and this only decides the label for a run that ends
   * with nothing louder to report.
   */
  const turnCeilingSteps = new Set<string>();
  /**
   * Step failures the run must NOT park on, by id.
   *
   * The park exists because a failed step is usually recoverable: the work is
   * captured, and a person can raise a ceiling, resolve a conflict, leave plan
   * mode, wait out an outage — and then say `retry`. Two failures are not, and
   * parking on them would be a loop with extra steps rather than a question:
   *
   * - a STALE RESUME. The workflow file changed under the run, so the recorded
   *   prompt hash no longer matches. Every retry re-derives the same hash and
   *   is refused the same way, forever. The fix is a fresh run, which is what
   *   the refusal already says.
   * - a fatal `ORG-HALT`. The role itself declared the run unrecoverable —
   *   that is what distinguishes it from the `ORG-ASK` beside it — and
   *   offering to run it again would be the engine second-guessing the only
   *   participant that looked at the work.
   */
  const unparkableSteps = new Set<string>();
  /** True when the failure that ENDS the run is a step that ran out of turns. */
  let failureIsTurnCeiling = abandonedTurnCeiling;
  /**
   * The step result behind {@link failure}, when a *step* is what failed.
   *
   * Deliberately not the same thing as `failure`: that string is also written
   * by the run's own money ceilings and by a durability fault, and neither of
   * those is a question a human can answer with "run it again". Only a real
   * step failure parks.
   */
  let failedStep: WorkflowStepResult | undefined;
  /**
   * The human-question gate's pending pauses, once a step raised an `ORG-ASK`.
   *
   * Filled like {@link failure} is — from the step results after a stage
   * settles — and it short-circuits the rest of the run the same way, so no
   * later stage runs on an unanswered question. But it is *not* a failure: the
   * run finishes `"paused"`, journalled durably at a resumable cut point, and
   * `/workflow resume <runId> <answer>` continues from here with the answer
   * spliced in.
   *
   * A LIST, not one pause: a parallel stage's branches all run to a terminal
   * before anything short-circuits, so two roles can each raise a question in
   * the same stage. Both are settled steps waiting on a person, and both must
   * reach the resume state — a paused step a resume never hears about is one it
   * re-executes, repeating whatever irreversible act that step already did.
   */
  const pauses: WorkflowPause[] = [];
  // A budget ask this resume failed to settle re-parks the run before a token
  // is spent: seeding the pause here makes the stage loop skip every stage and
  // the run finish `"paused"` on the re-stated question — the same machinery a
  // role's ORG-ASK rides, with nothing executed underneath an open question.
  if (resurfacedAsk !== undefined) pauses.push(resurfacedAsk);
  // Same seeding for a step-failure park this resume did not settle: the
  // question comes back before a token is spent, and the stage loop skips
  // everything underneath it.
  if (resurfacedFailAsk !== undefined) pauses.push(resurfacedFailAsk);
  /**
   * A durability failure the run must not quietly continue past.
   *
   * A `stepEnd` that never reaches disk is not cosmetic: it is the commit that
   * tells the next resume this step is settled, and without it that resume has
   * to fall back to probing the checkout. When the journal is refusing writes,
   * every later step widens the hole — so the first such failure stops the run
   * at the end of its stage, with the step's own status left truthful (it did
   * run; only the record of it failed).
   */
  let durabilityFault: string | undefined;
  /**
   * Whether any durable record has actually reached the journal.
   *
   * A journal that has never been written cannot be resumed FROM, so losing it
   * costs resumability and nothing else — a run whose home directory is
   * read-only, or a host that supplied a journal it cannot back, must still be
   * able to do its work. A journal that WAS working and then fails is the
   * dangerous case: half a history on disk is what a later resume would trust,
   * and trusting it is how a step whose side effect already landed gets run a
   * second time. Only that case stops the run.
   */
  let journalEstablished = false;
  /** Commit a step's terminal durably, remembering a failure to do so. */
  const commitStepEnd = async (
    line: Extract<JournalLine, { kind: "stepEnd" }>,
    /** Facts the journal line does not carry but the ledger wants. */
    facts: { failureKind?: WorkflowFailureKind; model?: string } = {},
  ): Promise<void> => {
    // The ledger first, and unconditionally: the step DID end, whatever the
    // journal manages to do about it below. Names and numbers only — the
    // line's `text`, `finalText`, `question` and `promptHash` never travel.
    const model = facts.model ?? line.lastTurn?.model;
    if (model !== undefined && model !== "") insightsModels.add(model);
    insights?.record({
      kind: "step-end",
      workflow: workflow.name,
      runId: insightsRunId,
      stepId: line.id,
      ...(line.agent === undefined ? {} : { role: line.agent }),
      status: line.status,
      ...(facts.failureKind === undefined ? {} : { failureKind: facts.failureKind }),
      ...(model === undefined || model === "" ? {} : { model }),
      durationMs: Math.max(0, line.endedAt - line.startedAt),
      usage: line.usage,
      attempts: line.attempts,
      ...(line.lastTurn === undefined ? {} : { lastTurn: line.lastTurn }),
      ...(line.activity === undefined ? {} : { activity: line.activity }),
    });
    try {
      await journalDurable(line);
      journalEstablished = true;
    } catch (error) {
      if (!journalEstablished) {
        // Never wrote anything, so there is nothing for a resume to misread.
        // Record it once — the run summary carries it, since `WorkflowEvent`
        // has no notice channel — and carry on without durability.
        journalUnavailable ??=
          `The run journal could not be written (${errorText(error)}), so this run is not ` +
          "resumable. The work itself is unaffected.";
        return;
      }
      durabilityFault ??=
        `step ${line.id} ran, but its terminal could not be written to the run journal: ` +
        `${errorText(error)}. This run is stopping here — continuing would extend a journal ` +
        "that can no longer be resumed without repeating work that already landed.";
    }
  };

  try {
    // `entries()` for the stage's *position*: `stage.index` is the file's own
    // step number, and "how many stages remain" — which the budget ask below
    // depends on — must come from the list, not from what an author numbered.
    for (const [stagePosition, stage] of workflow.stages.entries()) {
      // A pause short-circuits every later stage unconditionally — even under
      // `continueOnError`: those stages read the paused stage's output as
      // `{{prev}}`, and running them on an *unanswered question* is exactly the
      // guessing the gate exists to prevent. A failure still respects
      // `continueOnError`, as before.
      if (
        cancelled ||
        budgetExhausted ||
        pauses.length > 0 ||
        (failure !== undefined && !workflow.continueOnError)
      ) {
        for (const step of stage.steps) results.push(skippedResult(step, "skipped"));
        continue;
      }

      emit({
        type: "stageStart",
        stageIndex: stage.index,
        parallel: stage.parallel,
        steps: stage.steps.length,
        members: stage.steps.map((step) => {
          const model = modelNameOf(step);
          return {
            branchIndex: step.branchIndex,
            ...(step.agent === undefined ? {} : { agent: step.agent }),
            lane: laneOf(step),
            ...(model === undefined ? {} : { model }),
          };
        }),
      });
      void journalAppend({
        kind: "stageStart",
        stage: stage.index,
        parallel: stage.parallel,
        steps: stage.steps.length,
        ts: now(),
      });

      // RETROSPECTION: what a `{{journal}}` step is shown of the run so far.
      // Snapshotted once per stage for the same reason `appliedPatches` is —
      // every branch of a parallel stage must read the same history whatever
      // order they finish in — and rendered here rather than read back from
      // `journal.jsonl`, because these results *are* what that file records.
      const runDigest = renderRunJournalDigest(results, {
        ...(usage.costUsd === undefined ? {} : { spentUsd: usage.costUsd }),
        ...(runTurns > 0 ? { turns: runTurns } : {}),
      });

      const stageResults = await Promise.all(
        stage.steps.map(async (step): Promise<WorkflowStepResult> => {
          // Expanded WITHOUT the digest: this is the prompt that is recorded,
          // hashed and resumed against. See {@link expandStepPrompt}.
          const prompt = expandStepPrompt(step.prompt, prev, input);
          const base = {
            id: step.id,
            stageIndex: step.stageIndex,
            branchIndex: step.branchIndex,
            ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
            ...(step.agent === undefined ? {} : { agent: step.agent }),
            prompt,
          };
          // RESUME: a step the previous run finished is spliced back in from
          // the journal rather than re-executed — its applied patch is never
          // re-applied, its cost never re-counted, its text re-enters the pipe.
          // Checked before the abort guard so a resume still reconstructs `prev`
          // and `appliedPatches` for finished stages even under cancellation.
          /**
           * STALENESS GUARD: the spliced prompt is recomputed from the
           * reconstructed `prev` (itself rebuilt from stored step text) and the
           * stored `input`, so a hash mismatch means the *workflow file's
           * template* for this step changed since the run. Resuming a mutated
           * pipeline is worse than restarting — and re-running a `done` write
           * step would double-apply its patch — so refuse rather than guess.
           * Shared by both resume paths: an interrupted step is no safer to
           * re-run under a changed prompt than a finished one.
           */
          const staleResume = (): WorkflowStepResult => {
            // Never parkable: a retry re-derives the same prompt hash and is
            // refused identically. See {@link unparkableSteps}.
            unparkableSteps.add(step.id);
            return staleResumeResult();
          };
          const staleResumeResult = (): WorkflowStepResult => ({
            ...base,
            status: "failed",
            text: "",
            usage: emptyUsage(),
            error:
              `step ${step.id} cannot resume: the workflow "${workflow.name}" changed since ` +
              `this run (its prompt no longer matches the recorded one). Start a fresh run, ` +
              "or restore the workflow file to resume this one.",
            startedAt: now(),
            endedAt: now(),
          });
          // RESUME PAST A PAUSE (the human-question gate). A paused step is
          // SETTLED: it ran, it produced output, and it is waiting on a person.
          // So it is never executed again — it is completed with the human's
          // *answer* as its output (so `{{prev}}` carries the answer into the
          // next stage exactly where the asking role's output would have gone),
          // or, with no answer for it yet, re-surfaced exactly as recorded.
          // Both are checked before `completed`/`interrupted`, because a paused
          // step belongs to neither: re-splicing it as `completed` would pipe
          // its *question* onward, and treating it as unseen — which is what
          // happened to every paused step but the first — re-runs it.
          const pausedStep = pausedSteps?.get(step.id);
          const answerText = answerForStep(step);
          if (answerText !== undefined) {
            // Whatever the journal already settled about this step. Normally the
            // paused terminal; `completed` is the belt-and-braces fallback for a
            // paused write step (which the "an applied patch means it landed"
            // rule files under both) and for a hand-built resume state.
            const settled = pausedStep ?? resumeFrom?.completed.get(step.id);
            // Same staleness invariant as every resume path: a changed workflow
            // file means the recorded question is not the one on disk now, so an
            // injected answer would answer the wrong question — refuse instead.
            const askedHash = settled?.promptHash ?? askedHashes.get(step.id);
            if (askedHash !== undefined && hashPrompt(prompt) !== askedHash) {
              const stale = staleResume();
              emit({ type: "stepEnd", result: stale });
              return stale;
            }
            const answeredAt = now();
            // The answer replaces the step's OUTPUT, not its FOOTPRINT. A patch
            // record is the engine's statement about what is in the user's
            // checkout, and a step that applied its patch *and* asked a question
            // really did land it — dropping the record here is what seeded a
            // later stage's worktree without a change that was genuinely there.
            // Its spend rides along for the same reason: this terminal
            // SUPERSEDES the paused one ("latest wins"), so whatever it fails to
            // carry forward is erased from the run's ledger for good.
            const answered: WorkflowStepResult = {
              ...base,
              status: "done",
              text: answerText,
              ...(settled?.record === undefined ? {} : { record: settled.record }),
              usage: settled?.usage ?? emptyUsage(),
              startedAt: answeredAt,
              endedAt: answeredAt,
            };
            emit({ type: "stepEnd", result: answered });
            // Durable terminal, so the *next* read sees a settled `done` step
            // (the pause is answered) rather than re-deriving a pending pause.
            await commitStepEnd({
              kind: "stepEnd",
              id: step.id,
              stage: step.stageIndex,
              branch: step.branchIndex,
              status: "done",
              ...(step.agent === undefined ? {} : { agent: step.agent }),
              ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
              usage: answered.usage,
              ...(answered.record === undefined ? {} : { record: answered.record }),
              text: answerText,
              promptHash: hashPrompt(prompt),
              attempts: 0,
              startedAt: answeredAt,
              endedAt: answeredAt,
              answered: true,
            });
            return answered;
          }
          if (pausedStep !== undefined) {
            if (hashPrompt(prompt) !== pausedStep.promptHash) {
              const stale = staleResume();
              emit({ type: "stepEnd", result: stale });
              return stale;
            }
            // Re-surfaced verbatim — question, patch record, spend and all — so
            // the run pauses again on exactly the question the human still owes
            // an answer to, without this step doing anything a second time. No
            // journal append: this terminal is already on disk, and a duplicate
            // line would only say the same thing again.
            const stillPaused: WorkflowStepResult = {
              ...base,
              status: "paused",
              text: pausedStep.text,
              ...(pausedStep.record === undefined ? {} : { record: pausedStep.record }),
              usage: pausedStep.usage,
              ...(pausedStep.question === undefined ? {} : { question: pausedStep.question }),
              ...(pausedStep.startedAt === undefined ? {} : { startedAt: pausedStep.startedAt }),
              ...(pausedStep.endedAt === undefined ? {} : { endedAt: pausedStep.endedAt }),
            };
            emit({ type: "stepEnd", result: stillPaused });
            return stillPaused;
          }
          const resumed = resumeFrom?.completed.get(step.id);
          if (resumed !== undefined) {
            if (hashPrompt(prompt) !== resumed.promptHash) {
              const stale = staleResume();
              emit({ type: "stepEnd", result: stale });
              return stale;
            }
            const result: WorkflowStepResult = {
              ...base,
              status: resumed.status,
              text: resumed.text,
              ...(resumed.record === undefined ? {} : { record: resumed.record }),
              usage: resumed.usage,
              ...(resumed.startedAt === undefined ? {} : { startedAt: resumed.startedAt }),
              ...(resumed.endedAt === undefined ? {} : { endedAt: resumed.endedAt }),
            };
            // A synthetic `stepEnd` keeps the UI and `prev` correct; the journal
            // already holds this step's terminal line, so it is not re-appended.
            emit({ type: "stepEnd", result });
            return result;
          }
          // RESUME, the dangerous half: a step the previous run *started* and
          // never durably finished. Its side effect may already be in the user's
          // checkout, and the old rule — "no stepEnd, so run it again" — is
          // exactly how that patch gets applied twice (or refused, and reported
          // as a failure of work that actually succeeded). So the decision is
          // made on the step's write-ahead record plus, when one is needed and
          // available, a probe of the real checkout.
          const interrupted = resumeFrom?.interrupted.get(step.id);
          if (interrupted !== undefined) {
            if (
              interrupted.promptHash !== undefined &&
              hashPrompt(prompt) !== interrupted.promptHash
            ) {
              const stale = staleResume();
              emit({ type: "stepEnd", result: stale });
              return stale;
            }
            // Only the genuinely ambiguous case costs a probe: an announced
            // apply whose settlement never reached disk.
            const presence =
              interrupted.act === "apply" &&
              interrupted.applied === undefined &&
              interrupted.patchPath !== undefined
                ? await context.verifyPatch?.(interrupted.patchPath)
                : undefined;
            const verdict = decideInterruptedStep(interrupted, presence);
            if (verdict.action === "recover") {
              const result = recoveredStepResult(base, interrupted, verdict, now());
              emit({ type: "stepEnd", result });
              // Write the reconstructed terminal down, so the *next* resume
              // reads a settled step instead of re-deciding this from evidence
              // that only gets staler.
              await commitStepEnd({
                kind: "stepEnd",
                id: step.id,
                stage: step.stageIndex,
                branch: step.branchIndex,
                status: result.status,
                ...(step.agent === undefined ? {} : { agent: step.agent }),
                ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
                usage: result.usage,
                ...(result.record === undefined ? {} : { record: result.record }),
                text: result.text,
                promptHash: hashPrompt(prompt),
                attempts: 0,
                startedAt: result.startedAt ?? now(),
                endedAt: result.endedAt ?? now(),
                recovered: true,
              });
              return result;
            }
            // "rerun": the record proves nothing landed, so fall through and
            // execute the step live exactly as a fresh run would.
          }
          if (controller.signal.aborted) {
            return { ...base, status: "cancelled", text: "", usage: emptyUsage() };
          }
          const stepModel = modelNameOf(step);
          const promptHash = hashPrompt(prompt);
          emit({
            type: "stepStart",
            id: step.id,
            stageIndex: step.stageIndex,
            branchIndex: step.branchIndex,
            ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
            ...(step.agent === undefined ? {} : { agent: step.agent }),
            prompt,
            lane: laneOf(step),
            ...(stepModel === undefined ? {} : { model: stepModel }),
          });
          void journalAppend({
            kind: "stepStart",
            id: step.id,
            stage: step.stageIndex,
            branch: step.branchIndex,
            ...(step.agent === undefined ? {} : { agent: step.agent }),
            ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
            promptHash,
            ts: now(),
          });
          const stepStartedAt = now();
          /**
           * The machine-readable cause of this step's failure, when it failed.
           *
           * It never reaches the journal line ({@link StepEndLine} carries the
           * human cause instead), so the insights ledger — whose whole "which
           * failures keep happening" table is built on it — has to pick it up
           * here, where the lane's outcome is still in scope.
           */
          let stepFailureKind: WorkflowFailureKind | undefined;
          const model = step.modelTag === undefined ? undefined : models.get(step.modelTag);
          // `signal` here is a placeholder: `runStepWithDeadline` overwrites it
          // with a controller derived from `controller.signal` so the deadline
          // and an external cancellation both reach the runner the same way.
          /**
           * This step's write-ahead log, stamped with its own coordinates.
           *
           * The runner supplies only what it knows (the act, the patch, which
           * attempt it is on); the step's identity and the clock come from
           * here, so a runner cannot mislabel someone else's step. Both methods
           * go through the durable path, so a failure to record reaches the
           * caller — which, on the write lane, is what stops an unrecorded
           * `git apply`.
           */
          const durability: WorkflowStepDurability = {
            intent: (intent) =>
              journalDurable({
                kind: "stepIntent",
                id: step.id,
                stage: step.stageIndex,
                branch: step.branchIndex,
                attempt: intent.attempt ?? 0,
                act: intent.act,
                ...(intent.patchPath === undefined ? {} : { patchPath: intent.patchPath }),
                ...(intent.patchHash === undefined ? {} : { patchHash: intent.patchHash }),
                ...(intent.target === undefined ? {} : { target: intent.target }),
                ts: now(),
              }),
            effect: (effect) =>
              journalDurable({
                kind: "stepEffect",
                id: step.id,
                stage: step.stageIndex,
                branch: step.branchIndex,
                attempt: effect.attempt ?? 0,
                act: effect.act,
                applied: effect.applied,
                ...(effect.patchPath === undefined ? {} : { patchPath: effect.patchPath }),
                ...(effect.record === undefined ? {} : { record: effect.record }),
                ts: now(),
              }),
          };
          const stepRequest: WorkflowStepRequest = {
            step,
            // The dispatched prompt is the only place the digest appears: not
            // in `base.prompt`, not in `promptHash`, not on the journal line.
            prompt: expandStepPrompt(step.prompt, prev, input, runDigest),
            ...(model === undefined ? {} : { model }),
            ...(step.agent === undefined ? {} : { agent: step.agent }),
            state: { appliedPatches: [...appliedPatches] },
            signal: controller.signal,
            durability,
            // Attempts this step already burned in an earlier run of THIS run,
            // so the retry loop's index continues rather than restarts — see
            // {@link WorkflowStepRequest.attempt}.
            ...(priorAttemptsFor(step.id) === 0 ? {} : { attempt: priorAttemptsFor(step.id) }),
            // The human's run-scoped turn grant, when this step (or its role)
            // has one. Read from the journal-backed map rather than from the
            // role file, which was never touched — and handed to the runner,
            // which is the only thing that can reach the child's ceiling.
            ...(turnCeilingFor(step) === undefined ? {} : { turnCeiling: turnCeilingFor(step) }),
          };
          let result: WorkflowStepResult;
          // ENFORCED PER-ROLE BUDGETS (RFC 0001 §8.4): resolved once per step
          // and reused both to bound `runStepAttempts` below and to render
          // the breach message if it trips — the same look-up, read once.
          const roleBudget = roleBudgetOf(step);
          // The self-healing retry loop: one shared step deadline across every
          // attempt (§ {@link runStepAttempts}), so a transient blip re-tries
          // and a deterministic failure does not. `spent`/`stepTurns` are the
          // *whole step's* ledger — every attempt, not just the survivor.
          const {
            attempt,
            attempts,
            usage: spent,
            turns: stepTurns,
          } = await runStepAttempts(
            context.runStep,
            stepRequest,
            controller.signal,
            stepTimeoutMs,
            maxStepRetries,
            retryPolicy,
            now,
            roleBudget,
          );
          if (attempt.kind === "settled") {
            const outcome = attempt.outcome;
            const status: WorkflowStepStatus = outcome.isError
              ? controller.signal.aborted
                ? "cancelled"
                : "failed"
              : "done";
            // The agent's final words, on a failed step only: the pipe stays
            // clean (`text` below is `""`), but the words reach the failure
            // message and the durable terminal so a human sees how far it got.
            const finalWords = status === "failed" ? outcome.finalText : undefined;
            // HONEST TURN EXHAUSTION: a child that ran out of turns is a named
            // condition, not a generic agent error, so the run's `stop` line
            // can finally say so — but only if turn exhaustion is what ends
            // the run. Recorded on the step, resolved after the stage loop:
            // `recordStop` keeps the FIRST reason, and writing it here (before
            // the stage boundary's cost/token checks) relabelled runs that a
            // ceiling actually killed. See the resolution below `finally`.
            if (status === "failed" && outcome.failureKind === "turn-ceiling") {
              turnCeilingSteps.add(step.id);
            }
            if (status === "failed") stepFailureKind = outcome.failureKind;
            result = {
              ...base,
              status,
              // Whatever the agent wrote, the trailer that reaches the next
              // stage is the engine's. Stripping happens on every lane: a
              // read-lane role has no patch to report either.
              text: status === "done" ? stripPatchTrailers(outcome.text) : "",
              ...(outcome.record === undefined ? {} : { record: outcome.record }),
              // Every attempt's spend, not just this final one's — a step that
              // flapped twice before it healed was billed three times.
              usage: spent,
              ...(status === "failed"
                ? {
                    error:
                      (outcome.error ?? `step ${step.id} failed`) +
                      (finalWords === undefined
                        ? ""
                        : `\nIts final words before the stop: ${finalWords}`),
                  }
                : {}),
              ...(finalWords === undefined ? {} : { finalText: finalWords }),
              ...(outcome.lastTurn === undefined ? {} : { lastTurn: outcome.lastTurn }),
              ...(outcome.activity === undefined ? {} : { activity: outcome.activity }),
              startedAt: stepStartedAt,
              endedAt: now(),
            };
          } else if (attempt.kind === "timeout") {
            // The deadline fired before an external cancellation, or the two
            // raced together: an external cancel that also happened to be in
            // flight is reported as "cancelled" exactly like every other path
            // here, so the run's own status (below) is never contradicted by
            // one step's.
            //
            // `usage` is whatever `runStepWithDeadline` last knew the step had
            // spent — never `emptyUsage()`: the abandoned step keeps running
            // in the background exactly because it may keep spending, and a
            // deadline exists to catch (and report) that cost, not hide it.
            // `spent` carries that same last-known figure plus every earlier
            // attempt's, so a step that flapped and *then* hung reports both.
            // The deadline is a named failure kind, exactly as the lane's own
            // are — the ledger's failure table would otherwise show every
            // wall-clock stop as "unclassified".
            stepFailureKind = controller.signal.aborted ? "cancelled" : "timeout";
            result = {
              ...base,
              status: controller.signal.aborted ? "cancelled" : "failed",
              text: "",
              usage: spent,
              ...(controller.signal.aborted
                ? {}
                : { error: stepDeadlineError(step, stepTimeoutMs) }),
              startedAt: stepStartedAt,
              endedAt: now(),
            };
          } else if (attempt.kind === "budget") {
            // ENFORCED PER-ROLE BUDGETS (RFC 0001 §8.4): the same
            // cancelled-races-the-breach reasoning as the deadline branch
            // above — an external cancel in flight at the same instant is
            // still reported as "cancelled", never contradicted by this
            // step's own status.
            //
            // `attempt.spentUsd` is the exact figure that tripped the ceiling
            // (prior attempts' cost plus this attempt's progressive total at
            // the instant of the breach), not `spent.costUsd` — the latter
            // can differ by whatever this attempt spent *after* the abort was
            // fired but before the runner actually stopped.
            result = {
              ...base,
              status: controller.signal.aborted ? "cancelled" : "failed",
              text: "",
              usage: spent,
              ...(controller.signal.aborted
                ? {}
                : {
                    error: roleBudgetExceededError(
                      step,
                      step.agent ?? "",
                      attempt.spentUsd,
                      roleBudget ?? 0,
                    ),
                  }),
              startedAt: stepStartedAt,
              endedAt: now(),
            };
          } else {
            result = {
              ...base,
              status: controller.signal.aborted ? "cancelled" : "failed",
              text: "",
              // A throw carries no outcome, but the attempts behind it still
              // reported spend as they ran — an exceptional fault is not a
              // refund, so `spent` is reported rather than a flat zero. It is
              // `emptyUsage()` anyway for a runner that reported nothing.
              usage: spent,
              ...(controller.signal.aborted ? {} : { error: errorText(attempt.error) }),
              startedAt: stepStartedAt,
              endedAt: now(),
            };
          }
          // A step that needed the retry loop says so on its result, for the
          // retrospective digest. Only when it actually flapped — see
          // {@link WorkflowStepResult.attempts}.
          if (attempts > 1) result = { ...result, attempts };
          // COST: the engine's one mint point (§ {@link priceStepUsage}), run
          // before anything observes the result so the step result, the
          // `stepEnd` line a resume reads back and the run total below can
          // never disagree about what this step cost.
          const pricedUsage = priceStepUsage(result.usage, model);
          if (pricedUsage !== result.usage) result = { ...result, usage: pricedUsage };
          // HUMAN-QUESTION GATE: a *completed* step whose output raised a marker
          // is reclassified before it is journalled or observed, so the engine —
          // not the agent's self-reported status — owns the decision (the same
          // rule patch records follow). A fatal `ORG-HALT` becomes a `failed`
          // step (no resume-with-answer); an `ORG-ASK` becomes a `paused` step
          // whose question is carried on the durable terminal. The same gate
          // catches the opposite fault — a step that raised nothing at all
          // because it did nothing at all (see {@link stepProducedNothing}).
          if (result.status === "done") {
            const halt = classifyStepHalt(result.text);
            if (halt?.kind === "halt") {
              result = { ...result, status: "failed", text: "", error: halt.reason };
              // The role declared this unrecoverable, which is the whole
              // difference between `ORG-HALT` and the `ORG-ASK` beside it. The
              // run does not offer to try again. See {@link unparkableSteps}.
              unparkableSteps.add(step.id);
            } else if (halt?.kind === "ask") {
              result = { ...result, status: "paused", question: halt.question.question };
            } else if (
              stepProducedNothing(result.text, result.record) ||
              (result.lastTurn !== undefined &&
                lastTurnDeliveredNothing(result.lastTurn) &&
                (result.record === undefined || result.record.files === 0))
            ) {
              // The second arm is the same void seen from the last turn: a
              // step whose first turn said "I'll read the survey, then write"
              // and whose last two turns were reasoning alone has a non-empty
              // `text` — that preamble — and still produced nothing. Judged
              // on the turn the run ended on, with the diff as the tiebreak:
              // a role that wrote a file and then went quiet delivered.
              // THE VOID GATE (see {@link stepProducedNothing}): a step that
              // changed no file and said nothing has produced nothing, and
              // `done` is a lie the next seven stages build on. It fails —
              // which, on the park machinery above, means the run stops and
              // ASKS rather than dying, and `retry` is a real answer. Last of
              // the three arms on purpose: an `ORG-HALT` or `ORG-ASK` step has
              // already spoken and is settled by its own branch, and only a
              // step this gate can still see as `done` is judged here.
              result = {
                ...result,
                status: "failed",
                text: "",
                error: emptyStepError(step.id, step.agent),
              };
            }
          }
          runTurns += stepTurns;
          emit({ type: "stepEnd", result });
          // The durability commit: once this `stepEnd` is on disk with its patch
          // record, the step is *done* and a resume never re-runs it. Awaited —
          // and only for a live step — so it lands before the stage below seeds
          // the next stage's worktree from `appliedPatches`. A resumed step is
          // already journaled, so it took the early return above and skips this.
          // Durable, and a failure to write it stops the run (see
          // {@link commitStepEnd}) rather than vanishing into a swallowed catch.
          await commitStepEnd(
            {
              kind: "stepEnd",
              id: step.id,
              stage: step.stageIndex,
              branch: step.branchIndex,
              status: result.status,
              ...(step.agent === undefined ? {} : { agent: step.agent }),
              ...(step.modelTag === undefined ? {} : { modelTag: step.modelTag }),
              usage: result.usage,
              ...(result.record === undefined ? {} : { record: result.record }),
              text: result.text,
              // A paused step carries its question on the durable terminal, so the
              // pause — and what it asked — survive the process dying; a failed
              // one carries the agent's final words for the same reason.
              ...(result.status === "paused" && result.question !== undefined
                ? { question: result.question }
                : {}),
              ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
              // The last turn's shape rides the failed terminal beside the final
              // words: together they say how far it got and what came back.
              ...(result.status === "failed" && result.lastTurn !== undefined
                ? { lastTurn: result.lastTurn }
                : {}),
              // ALWAYS, unlike `lastTurn`: a step that succeeded after eighty
              // turns of reading is the one a retrospective wants to find, and
              // it is a handful of integers.
              ...(result.activity === undefined ? {} : { activity: result.activity }),
              promptHash,
              attempts,
              startedAt: stepStartedAt,
              endedAt: result.endedAt ?? now(),
            },
            {
              // Neither rides the journal line, and both are what the ledger's
              // "which failures keep happening, on which model" tables are made of.
              ...(stepFailureKind === undefined ? {} : { failureKind: stepFailureKind }),
              ...(stepModel === undefined ? {} : { model: stepModel }),
            },
          );
          return result;
        }),
      );

      for (const result of stageResults) {
        results.push(result);
        usage = addUsage(usage, result.usage);
        // Only a patch that actually landed becomes part of the run's state —
        // a refused one is not in the checkout, so seeding with it would hand
        // the next role a base the user never had.
        if (result.record?.status === "applied" && result.record.patchPath !== undefined) {
          appliedPatches.push(result.record.patchPath);
        }
        if (result.status === "cancelled") cancelled = true;
        if (result.status === "failed" && failure === undefined) {
          failure = result.error ?? `step ${result.id} failed`;
          failureIsTurnCeiling = turnCeilingSteps.has(result.id);
          // Kept for the step-failure park at the stage boundary below, which
          // needs more than the message: the role, the captured patch, the
          // attempt count and whether `raise` is even a valid reply.
          failedStep = result;
        }
        // ENFORCED PER-ROLE BUDGETS' run-level backstop (RFC 0001 §7.4): the
        // coarser net behind every role's own real-time `budget:` ceiling
        // above — this one is checked once per settled step against the
        // run's *running total*, not mid-turn, so it cannot abort a step
        // that is still in flight in the same parallel stage. That is an
        // intentional trade against the tighter per-role guard: the ceiling
        // this exists to catch is a *pipeline* nobody stopped, not any one
        // step's overrun, and it still stops every stage after this one.
        if (
          !budgetExhausted &&
          budgetUsdLimit !== undefined &&
          shouldAbortForCost(usage.costUsd ?? 0, budgetUsdLimit)
        ) {
          budgetExhausted = true;
          recordStop("cost-ceiling");
          failure ??= workflowBudgetExceededError(
            workflow.name,
            usage.costUsd ?? 0,
            budgetUsdLimit,
          );
        }
        // TOKEN CEILING (`budgetTokens:`): the same run-scope backstop for
        // the model `budgetUsd` above cannot police — one with no published
        // pricing, whose `usage.costUsd` stays `undefined` forever while its
        // token counts arrive on every turn. All four buckets count (input,
        // output, cache read, cache write; thinking tokens are already inside
        // output). Checked *after* the dollar ceiling on purpose: when one
        // settled result crosses both, `budgetExhausted` is already set and
        // the run deterministically reports `cost-ceiling`.
        // One bind for guard and message alike: the number the error reports
        // is by construction the number the ceiling compared.
        const tokensSpent = totalTokens(usage);
        if (
          !budgetExhausted &&
          budgetTokensLimit !== undefined &&
          shouldAbortForTokens(tokensSpent, budgetTokensLimit)
        ) {
          budgetExhausted = true;
          recordStop("token-ceiling");
          failure ??= workflowTokenBudgetExceededError(
            workflow.name,
            tokensSpent,
            budgetTokensLimit,
          );
        }
        // The human-question gate: EVERY paused step of this stage arms the
        // run-level pause, in branch order. Capturing only the first is what
        // made a parallel stage's second question invisible to the resume that
        // followed — which then re-ran that settled step. A pause still does
        // not override a failure: a broken sibling cannot be un-broken by
        // answering a question, so `failed` wins over `paused` below.
        if (result.status === "paused") {
          pauses.push({
            stepId: result.id,
            stageIndex: result.stageIndex,
            branchIndex: result.branchIndex,
            question: result.question ?? "",
            promptHash: hashPrompt(result.prompt),
          });
        }
      }
      // A journal that could not record this stage's terminals stops the run at
      // the stage boundary: the steps themselves are reported truthfully, and
      // nothing further is started on a record that can no longer be resumed.
      if (durabilityFault !== undefined && failure === undefined) failure = durabilityFault;

      // ============================================================ THE PARK
      // STEP-FAILURE PARK: a failed step is a question, not a tombstone.
      //
      // A step that exhausted its retries used to set `failure`, short-circuit
      // every later stage and write `runEnd{failed}` — which both resume entry
      // points refuse permanently. The nine-stage run that motivated this got
      // through four stages of real, paid work and then died on stage 5's turn
      // ceiling; the survey, the threat model and the ADRs were all on disk,
      // and the only way forward was to buy them again. That is the single
      // most expensive thing this engine did.
      //
      // So it parks instead, on exactly the machinery the stage-boundary
      // budget ask already rides: a durable question at a clean cut point, a
      // `runEnd{paused}` a resume re-enters, and a reply that is a *word*.
      //
      // Deliberately NOT parked:
      //   - `continueOnError: true` — those runs already continue past a
      //     failed step, and that flag's meaning is untouched here;
      //   - a run whose money ceiling tripped (`budgetExhausted`) — the hard
      //     stop owns that, and it has its own checkpoint one stage earlier;
      //   - a durability fault — the ask itself would be unwritable, and a
      //     pause nobody can restate is not a pause;
      //   - a cancellation — the human already said stop.
      if (
        failedStep !== undefined &&
        failure !== undefined &&
        !unparkableSteps.has(failedStep.id) &&
        !workflow.continueOnError &&
        !budgetExhausted &&
        !cancelled &&
        !controller.signal.aborted &&
        durabilityFault === undefined
      ) {
        // Attempts ACROSS resumes: the retry loop's count for this run, on top
        // of whatever the ask this resume answered had already recorded. A
        // second failure of the same step therefore parks again saying so,
        // which is how a human notices they are feeding a hole.
        const broken = failedStep;
        const priorAttempts = priorAttemptsFor(broken.id);
        const captured = broken.record?.status === "captured" ? broken.record.patchPath : undefined;
        const turnCeiling = turnCeilingSteps.has(broken.id);
        // Only meaningful for a turn ceiling, and only when the lane's own
        // cause named the number — it is what a `raise <n>` must exceed.
        const tripped = turnCeiling ? turnCeilingFromCause(broken.error) : undefined;
        const ask: PendingStepFailAsk = {
          stepId: broken.id,
          ...(broken.agent === undefined ? {} : { role: broken.agent }),
          ...(turnCeiling ? { failureKind: "turn-ceiling" as const } : {}),
          cause: failure,
          ...(captured === undefined ? {} : { patchPath: captured }),
          ...(tripped === undefined ? {} : { ceiling: tripped }),
          attempts: priorAttempts + (broken.attempts ?? 1),
          ...(broken.lastTurn === undefined ? {} : { lastTurn: broken.lastTurn }),
          ...(broken.activity === undefined ? {} : { activity: broken.activity }),
        };
        let parked = true;
        try {
          // Durable, and load-bearing for the same reason the budget ask's is:
          // the park only exists if the question is on disk.
          await journalDurable({ kind: "stepFailAsk", ...ask, ts: now() });
        } catch {
          // No durable ask means no ask: fall back to today's behaviour and
          // let the run end `failed`, rather than parking it on a question the
          // journal can never restate.
          parked = false;
        }
        if (parked) {
          insightsParks += 1;
          // Beside the durable ask, and with the same facts minus the words:
          // the cause TEXT is read (to bucket it) and never stored.
          insights?.record({
            kind: "park",
            workflow: workflow.name,
            runId: insightsRunId,
            stepId: ask.stepId,
            ...(ask.role === undefined ? {} : { role: ask.role }),
            ...(ask.failureKind === undefined ? {} : { failureKind: ask.failureKind }),
            attempts: ask.attempts,
            ...(ask.lastTurn === undefined ? {} : { lastTurn: ask.lastTurn }),
            ...(ask.activity === undefined ? {} : { activity: ask.activity }),
            causeKind: parkCauseKind(ask.failureKind, ask.cause),
          });
          // The failure is now a question. The STEP's own status stays
          // `failed` — it did fail, and `--print`/CI still see that — but the
          // RUN stops resumably instead of writing its own tombstone.
          failure = undefined;
          failureIsTurnCeiling = false;
          failedStep = undefined;
          pauses.unshift({
            stepId: ask.stepId,
            stageIndex: stage.index,
            branchIndex: 0,
            question: stepFailAskQuestion(ask, askAudience),
            promptHash: "",
            reason: "step-failure",
            ...(ask.lastTurn === undefined ? {} : { lastTurn: ask.lastTurn }),
            ...(ask.activity === undefined ? {} : { activity: ask.activity }),
          });
        }
      }

      // STAGE-BOUNDARY BUDGET ASK: park the run and ask BEFORE a hard ceiling
      // kills it. The hard stop writes `runEnd{failed}` and a failed run is
      // permanently unresumable — by then the operator's only options are an
      // autopsy or paying for every finished stage again. So once a ceiling is
      // 80% consumed *and stages remain*, the run pauses here instead: a clean,
      // durable, answerable cut point. Never on the final stage (there is
      // nothing left to save), never over a real problem (a failure, a
      // cancellation, a role's own pause, an already-tripped ceiling), and only
      // once per ceiling per run — an acknowledged ceiling runs to the hard
      // stop with the operator's consent on record.
      if (
        !budgetExhausted &&
        !cancelled &&
        !controller.signal.aborted &&
        failure === undefined &&
        pauses.length === 0 &&
        stagePosition < workflow.stages.length - 1
      ) {
        const usdSpent = usage.costUsd ?? 0;
        const tokensNow = totalTokens(usage);
        const nearCeilings: { ceiling: BudgetCeilingKind; spent: number; limit: number }[] = [];
        if (
          budgetUsdLimit !== undefined &&
          !budgetAsked.has("usd") &&
          nearingCeiling(usdSpent, budgetUsdLimit, BUDGET_ASK_FRACTION)
        ) {
          nearCeilings.push({ ceiling: "usd", spent: usdSpent, limit: budgetUsdLimit });
        }
        if (
          budgetTokensLimit !== undefined &&
          !budgetAsked.has("tokens") &&
          nearingCeiling(tokensNow, budgetTokensLimit, BUDGET_ASK_FRACTION)
        ) {
          nearCeilings.push({ ceiling: "tokens", spent: tokensNow, limit: budgetTokensLimit });
        }
        // Both near at once: ask about the tighter one — the higher consumed
        // fraction is the ceiling the next stage is likelier to hit first.
        const tightest = nearCeilings.sort((a, b) => b.spent / b.limit - a.spent / a.limit)[0];
        if (tightest !== undefined) {
          const ask: PendingBudgetAsk = {
            ...tightest,
            stagesDone: stagePosition + 1,
            stagesTotal: workflow.stages.length,
          };
          let parked = true;
          try {
            // Durable, and load-bearing: the park only exists if the ask is on
            // disk. A `runEnd{paused}` with no recorded question would be a
            // pause nobody can answer.
            await journalDurable({ kind: "budgetAsk", ...ask, ts: now() });
          } catch {
            // No durable ask means no ask: fall back to today's behavior and
            // run on to the hard ceiling, rather than parking the run on a
            // question the journal cannot restate.
            parked = false;
          }
          if (parked) {
            insights?.record({
              kind: "budget-ask",
              workflow: workflow.name,
              runId: insightsRunId,
              ceiling: ask.ceiling,
              spent: ask.spent,
              limit: ask.limit,
            });
            pauses.push({
              stepId: BUDGET_ASK_STEP_ID,
              // The stage's *position*, which is what the durable ask line
              // carries and therefore all a re-surfaced copy can restate. The
              // parser refuses non-consecutive numbering, so this is also
              // `stage.index` — but by construction rather than by a rule
              // enforced three thousand lines away.
              stageIndex: ask.stagesDone,
              branchIndex: 0,
              question: budgetAskQuestion(ask, askAudience),
              promptHash: "",
            });
          }
        }
      }

      const stageText = combineStageText(stageResults);
      const stageStatus: WorkflowStepStatus = stageResults.some((r) => r.status === "cancelled")
        ? "cancelled"
        : stageResults.some((r) => r.status === "failed")
          ? "failed"
          : stageResults.some((r) => r.status === "paused")
            ? "paused"
            : "done";
      emit({ type: "stageEnd", stageIndex: stage.index, status: stageStatus, text: stageText });
      // A running spend snapshot and the stage's close, for the status view.
      // Fire-and-forget: the crash-consistency guarantee is the per-step
      // `stepEnd` above, not these roll-ups.
      //
      // `spentUsd` and `turns` are what `/workflow status` renders as
      // "$X.XX · N turns" — the column an operator uses to catch a runaway —
      // so the writer emits exactly what the reader reads. Both degrade to
      // *absent* rather than to a fabricated zero: `usage.costUsd` is
      // `undefined` until at least one step could be priced (an unpriced model
      // has no dollar figure, and `$0.00` would be a lie an operator would act
      // on), and `turns` stays absent until at least one turn was observed. A
      // partially priced run reports the priced part, which is a floor, not a
      // fiction — the same convention `stats.ts` uses for unpriced messages.
      void journalAppend({
        kind: "budget",
        usage,
        ...(usage.costUsd === undefined ? {} : { spentUsd: usage.costUsd }),
        ...(runTurns > 0 ? { turns: runTurns } : {}),
        ts: now(),
      });
      void journalAppend({ kind: "stageEnd", stage: stage.index, status: stageStatus, ts: now() });
      // The pipe carries whatever this stage actually produced — an all-failed
      // `continueOnError` stage therefore hands the next stage an empty
      // `{{prev}}` rather than stale text from two stages ago.
      prev = stageText;
      if (controller.signal.aborted) cancelled = true;
    }
  } finally {
    context.signal?.removeEventListener("abort", onExternalAbort);
  }

  if (cancelled) {
    recordStop("cancelled");
    return finish("cancelled", results, prev, usage, "Workflow cancelled.");
  }
  if (failure !== undefined) {
    // `cost-ceiling` / `token-ceiling` was already recorded at the crossing
    // above, and `recordStop` keeps the first reason: a budget breach that
    // also leaves a failed step must not be relabelled as a plain error on
    // the way out. `turn-ceiling` is claimed here, and only here, because it
    // is a property of the failure that ENDED the run — a step that ran out of
    // turns three stages before a `continueOnError` run hit its ceiling did
    // not stop the pipeline, the ceiling did.
    recordStop(failureIsTurnCeiling ? "turn-ceiling" : "error");
    return finish("failed", results, prev, usage, failure);
  }
  // The human-question gate: a pause is a clean, resumable stop — not a failure.
  // The message is human-facing (it reaches `--print`/CI on `result.error`); the
  // structured pause rides on `result.pause` for the command to act on.
  if (pauses.length > 0) {
    return finish("paused", results, prev, usage, pauseSummary(pauses), pauses);
  }
  return finish("done", results, prev, usage);
}

// ------------------------------------------------------- production step binding

/** The slice of `Agent` a workflow step needs. */
export interface WorkflowChildAgent {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(input: string): Promise<void>;
  abort(): void;
  finalText(): string;
}

/** The slice of `ArcturnRuntime` {@link createRuntimeRunStep} needs. */
export interface WorkflowAgentHost {
  /**
   * Build a scoped child agent for one delegated task.
   *
   * @param task - The step's prompt.
   * @param def - The role the child runs as, when the step named one.
   * @param options - Optional attribution.
   * @param options.origin - {@link workflowStepOrigin} for this step, so a
   *   prompt this child raises can say which role in which step raised it.
   *   Optional so a host predating attribution still satisfies this shape.
   */
  createSubagent(
    task: string,
    def?: AgentDef,
    options?: {
      origin?: string;
      /**
       * A human's run-scoped turn grant for this step (see
       * {@link WorkflowStepRequest.turnCeiling}). The runtime lifts BOTH
       * halves of its `Math.min(role maxTurns, subagentMaxTurns)` clamp for
       * it; omitting it leaves that clamp exactly as it was.
       */
      turnCeiling?: number;
    },
  ): WorkflowChildAgent;
}

/**
 * Label one step's child agent, for the permission prompts it raises.
 *
 * A `/workflow` org run hands one prompting session to seven roles in turn.
 * Unattributed, their prompts arrive as a single undifferentiated stream and
 * the operator cannot tell whether seven roles asked once each or one agent
 * asked seven times — which is what an "ignored" permission mode looks like
 * from the outside. This is the string that tells them apart, carried on
 * `PermissionRequest.origin` and rendered by the host's dialog.
 *
 * A step with no `@role` still gets a label: it is just as delegated, and
 * naming its step is strictly more than the nothing it had before. It is not
 * given a role name it does not have.
 *
 * @param stepId - The step's id, e.g. `"3"` or `"4.2"`.
 * @param roleName - The `@role` the step named, when it named one.
 */
export function workflowStepOrigin(stepId: string, roleName?: string): string {
  return `${roleName === undefined ? "workflow" : `@${roleName}`} · step ${stepId}`;
}

/** Options for {@link createRuntimeRunStep}. */
export interface RuntimeRunStepOptions {
  /** System prompt handed to every *un-roled* step agent. */
  systemPrompt?: string;
  /** Restricted tool set for every un-roled step agent (narrowing only). */
  tools?: readonly string[];
  /**
   * Resolves a step's `@role` to its markdown agent definition. Without it, a
   * roled step fails rather than silently running as an anonymous step.
   */
  resolveAgent?: AgentRoleResolver;
  /** Every known role name, echoed by {@link unknownRoleError}. */
  agentNames?: () => readonly string[];
  /**
   * Resolves a role's own `model:` id to a spec, for the worktree lanes only
   * — the read lane hands the id to `createSubagent`, which resolves it
   * itself.
   */
  resolveModel?: ModelTagResolver;
  /**
   * Worktree primitives, shared by the exec and write lanes: both need the
   * same isolated checkout, and only the write lane goes on to capture and
   * apply what is in it. Named for the lane it was built for; omit it and a
   * role on either worktree lane cannot run at all.
   */
  writeLane?: WriteLane;
  /**
   * Whether the parent session is in plan mode *right now*.
   *
   * A getter, not a boolean: the mode can change between the registration of
   * the command and the dispatch of stage 6.
   */
  planMode?: () => boolean;
  /**
   * Publishes an event onto the *session's* event stream — the host's live
   * region. Wire it and every step's agent shows up there as a namespaced
   * sub-agent while it runs; omit it and a pipeline behaves exactly as it did
   * before, silently. A plain function rather than a host method so the engine
   * stays injectable and testable without a runtime.
   */
  emit?: (event: AgentEvent) => void;
  /**
   * This role's org memory, already rendered as a fenced, bounded prompt
   * block. Return `undefined` for a role with none.
   *
   * A *string* rather than a structure, and consumed at exactly one place
   * below, because that is the whole safety property: memory is appended to
   * the role's `systemPrompt` and reaches nothing else. It cannot add a tool,
   * change a `model`, raise `maxTurns`, or move the role to another lane —
   * every one of those is decided from the role file the loader parsed, and
   * this option never touches them. See `org-memory.ts` for what the block
   * itself is bounded by; production wires
   * {@link import("./org-memory.js").loadOrgMemoryInjector}.
   */
  orgMemory?: (role: string) => string | undefined;
  /**
   * The insights ledger plus this run's coordinates, so a step's own child
   * agent can record a silent turn or a progress warning WITH the step it
   * belongs to.
   *
   * Threaded through the options rather than read from a module global: a host
   * running two pipelines at once (`arcturn serve`) must never attribute one
   * run's silence to the other.
   */
  insights?: InsightsRunScope;
}

// ---------------------------------------------------------------- three lanes

/**
 * Tools that grant a role **authorship**: its work may reach the user's tree.
 *
 * `bash` is deliberately *not* here. A shell is a write primitive with extra
 * steps, which is why it cannot run on the read lane — but it is not a grant
 * to author the user's checkout, which is what the write lane's `git apply`
 * is. That distinction is the exec lane.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multiedit"]);

/**
 * Tools that make a role's step need isolation even though it may not author.
 *
 * One entry today. It is a set because the day a second shell-shaped tool
 * lands, the lane law must move with it rather than be re-derived.
 */
const EXEC_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/**
 * A role's **write authority**: whether its work may reach the user's tree.
 *
 * Two values, because there are only two answers to the question a reviewer
 * of a role file actually asks. `"write"` means this role's diff is replayed
 * into the checkout; `"read"` means it structurally cannot be — whether the
 * role runs through `createSubagent` (read lane) or in a throwaway worktree
 * with a shell (exec lane). {@link roleDispatch} is the finer question of
 * *which* lane runs it.
 */
export type WorkflowLane = "read" | "write";

/** Which of the three lanes actually runs a role's step. */
export type WorkflowDispatch = "read" | "exec" | "write";

/**
 * Decide which lane runs a role's step, from its declared tools alone.
 *
 * - `write`/`edit`/`multiedit` → **write**: worktree, patch captured, patch
 *   applied to the user's checkout.
 * - `bash` without any of those → **exec**: the same worktree, so the role can
 *   build, test and audit — and the diff is discarded unread.
 * - neither → **read**: `createSubagent`, exactly as an untagged step.
 *
 * A role with no `tools:` at all reports `"read"` here, which is the
 * conservative *answer*, but it is not dispatched: see
 * {@link undeclaredToolsError}. Silence is refused rather than interpreted.
 *
 * @param def - The role definition.
 */
export function roleDispatch(def: AgentDef): WorkflowDispatch {
  if (def.tools === undefined) return "read";
  if (def.tools.some((name) => WRITE_TOOLS.has(name))) return "write";
  return def.tools.some((name) => EXEC_TOOLS.has(name)) ? "exec" : "read";
}

/**
 * Decide a role's write authority from its declared tools.
 *
 * The conservative direction is the default: only an explicitly declared
 * `write`, `edit` or `multiedit` buys the authority to change the user's
 * files. A reviewer holding `bash` has none — it runs on the exec lane, whose
 * worktree is thrown away — and a role declaring nothing has none either,
 * because it is refused outright.
 *
 * @param def - The role definition.
 */
export function roleLane(def: AgentDef): WorkflowLane {
  return roleDispatch(def) === "write" ? "write" : "read";
}

/**
 * True when a tool list provably cannot reach the user's checkout.
 *
 * Undeclared is *not* confined: an agent with no `tools:` gets whatever the
 * session has, which in a yolo session is `write` and `bash` on the real tree.
 * That is the same reasoning {@link undeclaredToolsError} applies to roles, in
 * the one place it decides durability rather than dispatch.
 *
 * @param tools - The narrowing a step's agent will run under, if any.
 */
function confinedToReading(tools: readonly string[] | undefined): boolean {
  return (
    tools !== undefined && !tools.some((name) => WRITE_TOOLS.has(name) || EXEC_TOOLS.has(name))
  );
}

/**
 * Promise, in the run journal, that this step announces irreversible acts.
 *
 * Resume re-runs an interrupted step only when this declaration is on disk and
 * no act was announced after it (see `decideInterruptedStep`); without it the
 * step is opaque and is recovered rather than repeated. Failing to record it is
 * therefore safe in the only direction that matters, so it is swallowed — the
 * apply intent is the record that refuses to be.
 *
 * @param request - The step being run, for its durability sink.
 */
async function declareGuarded(request: WorkflowStepRequest): Promise<void> {
  try {
    await request.durability?.intent({
      act: "guarded",
      ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
    });
  } catch {
    // Degrades to "opaque", which resume treats conservatively. Never fatal.
  }
}

/**
 * The message a step fails with when its role declares no `tools:` at all.
 *
 * Shared by the engine's pre-flight and the dispatcher so the two can never
 * drift. An undeclared list is not "the read lane" and never was: `tools:` is
 * the *filter*, so leaving it out means "everything this session has", which
 * in a yolo session is `bash` and `write` on the user's real checkout — the
 * widest grant in the system, written down nowhere. RFC 0001 §8.4: roles
 * narrow; nothing widens.
 *
 * @param role - The role name written after `@`.
 * @param stepId - The step that named it.
 */
export function undeclaredToolsError(role: string, stepId: string): string {
  return (
    `step ${stepId} dispatches @${role}, whose role file declares no "tools:" — and an ` +
    'undeclared tool list means "every tool this session has", which is an authority grant ' +
    "nobody wrote down. Org roles must declare their tools explicitly: add a tools: line to " +
    `the @${role} role file (RFC 0001 §8.4 — roles narrow, nothing widens).`
  );
}

/** What a worktree-lane step's diff ended up as. */
export type WorkflowPatchStatus =
  /** `git apply` landed the patch in the user's checkout. */
  | "applied"
  /** The patch was refused — by the path audit or by git; it is preserved. */
  | "refused"
  /** The role finished without changing anything; there is no patch. */
  | "empty"
  /** The step failed or was cancelled; the diff was saved but never applied. */
  | "captured"
  /** An exec-lane worktree, thrown away unread exactly as the lane promises. */
  | "discarded";

/** Line prefix of the machine-readable trailer on a worktree step's output. */
export const WRITE_LANE_TRAILER_PREFIX = "ARCTURN-PATCH:";

/**
 * What the engine recorded about one worktree-lane step's diff.
 *
 * Minted by the engine from what git actually did, carried structurally on
 * {@link WorkflowStepOutcome} and {@link WorkflowStepResult}, and rendered
 * into the pipe as a canonical trailer. An agent cannot produce one: every
 * {@link WRITE_LANE_TRAILER_PREFIX} line in a step's *text* is stripped before
 * that text is composed into the next stage's `{{prev}}`.
 */
export interface WorkflowPatchRecord {
  readonly status: WorkflowPatchStatus;
  /** Role that produced the diff. */
  readonly role: string;
  /** Step id that dispatched it. */
  readonly stepId: string;
  /** Files touched by the diff. */
  readonly files: number;
  /** Absolute patch path; absent for `"empty"` and `"discarded"`. */
  readonly patchPath?: string;
}

/** Former name of {@link WorkflowPatchStatus}, kept for callers that used it. */
export type WriteLanePatchStatus = WorkflowPatchStatus;

/** Former name of {@link WorkflowPatchRecord}, kept for callers that used it. */
export type WriteLanePatchRecord = WorkflowPatchRecord;

/**
 * Render the trailer appended to a worktree step's output.
 *
 * `patch=` is last and unquoted so the value can be a path containing spaces:
 * {@link parseWriteLaneTrailer} takes the rest of the line for it.
 *
 * @param record - What the engine recorded.
 */
export function formatWriteLaneTrailer(record: WorkflowPatchRecord): string {
  const parts = [
    WRITE_LANE_TRAILER_PREFIX,
    `status=${record.status}`,
    `role=${record.role}`,
    `step=${record.stepId}`,
    `files=${record.files}`,
  ];
  if (record.patchPath !== undefined) parts.push(`patch=${record.patchPath}`);
  return parts.join(" ");
}

/**
 * Parse one line's trailer, or `undefined` when it carries none.
 *
 * The marker is recognised **anywhere on the line**, not only at its start:
 * `{{prev}}` splices a whole stage's text into the middle of a sentence, so a
 * trailer that began a stage's output routinely arrives as
 * `Gate on this: ARCTURN-PATCH: status=…`. {@link stripPatchTrailers} uses the
 * same rule, so the two can never disagree about what is a trailer — a
 * forger cannot hide one behind a word.
 *
 * @param line - One line of text.
 */
function parseTrailerLine(line: string): WorkflowPatchRecord | undefined {
  const at = line.indexOf(WRITE_LANE_TRAILER_PREFIX);
  if (at === -1) return undefined;
  const body = line.slice(at + WRITE_LANE_TRAILER_PREFIX.length).trim();
  const patchAt = body.indexOf("patch=");
  const head = patchAt === -1 ? body : body.slice(0, patchAt);
  const patch = patchAt === -1 ? undefined : body.slice(patchAt + "patch=".length).trim();
  const fields = new Map<string, string>();
  for (const pair of head.split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const status = fields.get("status");
  if (
    status !== "applied" &&
    status !== "refused" &&
    status !== "empty" &&
    status !== "captured" &&
    status !== "discarded"
  ) {
    return undefined;
  }
  return {
    status,
    role: fields.get("role") ?? "",
    stepId: fields.get("step") ?? "",
    files: Number.parseInt(fields.get("files") ?? "0", 10) || 0,
    ...(patch === undefined || patch.length === 0 ? {} : { patchPath: patch }),
  };
}

/**
 * Read every engine trailer out of piped text, in written order.
 *
 * A parallel stage with two worktree steps contributes two trailers, so "the
 * trailer" is not always singular; a gate that must reason about all of them
 * reads them all.
 *
 * @param text - Any text that may contain trailers (usually `{{prev}}`).
 */
export function parseWriteLaneTrailers(text: string): WorkflowPatchRecord[] {
  const records: WorkflowPatchRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const record = parseTrailerLine(line);
    if (record) records.push(record);
  }
  return records;
}

/**
 * How loudly a gate reading one line of text must hear each status.
 *
 * A patch that did *not* land outranks one that did, which outranks nothing
 * having happened. That ordering — not "the last one wins" — is what makes a
 * single-record read safe on a stage that ran several worktree steps: the
 * answer to "did everything land?" can never be spoofed by a benign sibling.
 */
const PATCH_STATUS_RANK: Record<WorkflowPatchStatus, number> = {
  refused: 4,
  captured: 3,
  discarded: 2,
  applied: 1,
  empty: 0,
};

/**
 * Read the trailer a gate must not miss out of piped text.
 *
 * @param text - Any text that may contain trailers (usually `{{prev}}`).
 * @returns The highest-ranked record ({@link PATCH_STATUS_RANK}, ties broken
 *   by written order), or `undefined` when the text carries none.
 */
export function parseWriteLaneTrailer(text: string): WorkflowPatchRecord | undefined {
  let best: WorkflowPatchRecord | undefined;
  for (const record of parseWriteLaneTrailers(text)) {
    if (!best || PATCH_STATUS_RANK[record.status] > PATCH_STATUS_RANK[best.status]) best = record;
  }
  return best;
}

/**
 * Drop every {@link WRITE_LANE_TRAILER_PREFIX} line from a step's own text.
 *
 * Called on *every* step's text before composition, including a read-lane
 * one's: the trailer that reaches the next stage must be the engine's record,
 * and a role that writes the line itself is either confused or forging. The
 * whole line goes, wherever on it the marker sits — prose *about* the trailer
 * is a small loss next to prose that can be *mistaken for* one.
 *
 * @param text - A step's final text.
 */
export function stripPatchTrailers(text: string): string {
  if (!text.includes(WRITE_LANE_TRAILER_PREFIX)) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes(WRITE_LANE_TRAILER_PREFIX))
    .join("\n")
    .trim();
}

/** An isolated checkout one worktree-lane step works in. */
export interface WriteLaneWorktree {
  /** Absolute path of the checkout; also the agent's `cwd`. */
  readonly dir: string;
  /**
   * The seed commit the role's work is diffed against: `HEAD` plus the run's
   * accumulated state, committed inside the worktree. Absent when the lane
   * does no seeding, in which case capture falls back to `git diff --cached`.
   */
  readonly baseRef?: string;
  /** Tear it down. Called on success, and on an exec step either way. */
  remove(): Promise<void>;
}

/** The run state a worktree is seeded with (RFC 0001 §7.1, D2). */
export interface WriteLaneSeed {
  /** Patches this run already applied to the checkout, oldest first. */
  readonly patches: readonly string[];
}

/** What {@link WriteLane.spawn} is asked to build. */
/**
 * A mid-run nudge, evaluated at the top of every turn after the first. A
 * non-blank return is sent to the model once as a user message (the loop
 * dedupes by exact text) and surfaced as a `progressWarning` event.
 */
export type WorkflowProgressCheck = (progress: TurnProgress) => string | undefined;

/**
 * How far into its ceiling a write-lane role may get with nothing written
 * before the loop says so out loud. Half: late enough that a role which reads
 * first is not hectored on turn three, early enough that the other half of the
 * budget can still produce a diff.
 */
const WRITE_LANE_PROGRESS_FRACTION = 0.5;

/**
 * The write lane's mid-run progress check: **you have spent half your turns and
 * changed no file.**
 *
 * The run this exists for: a stage-5 builder spent all eighty of its turns on
 * `bash` (77 calls) and `read` (17), twenty-four minutes and 330K tokens, and
 * hit its ceiling having written nothing. Every guard rail the engine had
 * fired *after* the money was gone — the turn ceiling, the void gate, the park.
 * None of them could say the one thing that would have changed the outcome
 * while there were still forty turns left to change it.
 *
 * WRITE LANE ONLY. A read-lane or exec-lane role produces a *report*, and its
 * diff is discarded unread; telling one of those to "write a file now" would be
 * telling it to do the one thing its lane forbids.
 *
 * Exported so the threshold and the wording are one testable thing rather than
 * a condition buried in a spawn call.
 *
 * @param progress - The turn about to start, and the calls made so far.
 * @returns The nudge, or `undefined` when the step is on track.
 */
export function writeLaneProgressCheck(progress: TurnProgress): string | undefined {
  const threshold = Math.floor(progress.maxTurns * WRITE_LANE_PROGRESS_FRACTION);
  // ONE turn, not "this turn and every one after". The loop dedupes a warning
  // by its exact text and this message names the turn it fired on, so a
  // `>=` test would re-fire with fresh wording every remaining turn — which is
  // precisely how the turn-ceiling warning next to it earned its once-per-run
  // rule: a notice that repeats teaches the model to skip it.
  if (progress.turnIndex !== threshold) return undefined;
  if (countWrites(progress.toolCalls) > 0) return undefined;
  return (
    `Progress check: ${progress.turnIndex} of ${progress.maxTurns} turns are spent and no ` +
    "file has been changed. This is a write-lane step — its result is a diff, and reading " +
    "further will not produce one. Make the smallest change that moves the step forward now " +
    "(create the file, or write its first section), then continue."
  );
}

export interface WriteLaneSpawnRequest {
  /** The role, including the `tools:` the agent must be narrowed to. */
  readonly def: AgentDef;
  /** The worktree the agent is rooted at. */
  readonly cwd: string;
  /** Resolved model (`[tag]` > role `model:` > the host's subagent route). */
  readonly model?: ModelSpec;
  /** The step this agent serves, for titles and session ids. */
  readonly stepId: string;
  /**
   * A human's run-scoped turn grant for this step (see
   * {@link WorkflowStepRequest.turnCeiling}) — the worktree lanes' half of the
   * same plumbing the read lane does through `createSubagent`. A raise that
   * reached only one lane would be a raise that silently did nothing on the
   * other.
   */
  readonly turnCeiling?: number;
  /**
   * Mid-run progress check for this child (see {@link writeLaneProgressCheck}).
   *
   * Only the WRITE dispatch passes one: it is the only lane whose result is a
   * diff. A lane implementation that cannot install one simply ignores it, and
   * the step runs exactly as it did before.
   */
  readonly progressCheck?: WorkflowProgressCheck;
}

/**
 * A worktree-lane child agent, plus the background processes it owns.
 *
 * A role that runs `bash { background: true }` — a dev server, a watcher, a
 * `tail -f` — starts a process that nothing in the step's own control flow
 * ever waits for. Without this handle those processes outlive the step, the
 * worktree they were rooted at (which is deleted underneath them) and the run
 * itself: the next run's probe then reaches the *previous* run's server on the
 * same port and a role can honestly report "responded 200" about a binary from
 * a checkout that no longer exists. So a step owns what it started, and kills
 * it on the way out — success, failure, refusal or abort.
 */
export interface WorkflowLaneAgent extends WorkflowChildAgent {
  /**
   * Kill every background task *this agent* started, and only those.
   *
   * Optional so a lane that cannot see its children's processes (and every
   * pre-existing test double) still satisfies the shape; a lane that can
   * returns how many were still running when they were killed, which is the
   * number the step reports.
   */
  killBackgroundTasks?(): number | Promise<number>;
}

/**
 * The worktree lanes' three primitives, injected so both lanes are testable
 * without git, without a repo and without an LLM.
 *
 * Production builds this from `createWorktree` (`scouts.ts`),
 * `ArcturnRuntime.buildSessionAgent` + `setTools`, and `child_process` —
 * see {@link createRuntimeWriteLane}.
 */
export interface WriteLane {
  /** The checkout the patch is replayed into: the user's real repo root. */
  readonly cwd: string;
  /**
   * Create an isolated worktree, seeded with the run's accumulated state. The
   * patch is written to its **parent** directory, so the parent must outlive
   * {@link WriteLaneWorktree.remove}.
   *
   * @param name - Slug for the worktree directory (step id plus role).
   * @param seed - The run's applied patches, replayed in order before the
   *   seed commit. A lane may ignore it; then `baseRef` is `undefined` and
   *   capture is `HEAD`-relative, which is what the pre-seeding lane did.
   */
  createWorktree(name: string, seed?: WriteLaneSeed): Promise<WriteLaneWorktree>;
  /**
   * Build the role's agent, rooted at the worktree and narrowed to its tools.
   *
   * The agent may carry {@link WorkflowLaneAgent.killBackgroundTasks}, which
   * the step calls in teardown; a lane that does not track processes returns a
   * plain {@link WorkflowChildAgent} and the step reaps nothing.
   */
  spawn(request: WriteLaneSpawnRequest): WorkflowLaneAgent | Promise<WorkflowLaneAgent>;
  /**
   * Run one `git` invocation. Must reject on a non-zero exit — that rejection
   * is how a `git apply` refusal reaches the step.
   *
   * @param cwd - Directory to run in.
   * @param args - Arguments after `git`.
   */
  exec(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}

/**
 * The system prompt a workflow step's agent runs with.
 *
 * A step is a link in a pipeline, not a conversation: its whole output is
 * spliced into the next step's prompt, so preamble and sign-off are actively
 * harmful rather than merely noisy.
 */
export const WORKFLOW_STEP_SYSTEM_PROMPT = [
  "You are executing one step of a scripted, deterministic workflow.",
  "Do exactly what this step asks — no more, and nothing from a later step.",
  "Your entire reply is piped verbatim into the next step's prompt, so answer",
  "with the artifact itself (findings, patch, review) and no preamble, no",
  "restatement of the task and no closing pleasantries.",
].join(" ");

/**
 * Appended to a role's own system prompt when it runs as a pipeline step.
 *
 * The role file describes *who the agent is*; this describes *where its answer
 * goes*. Without it a role writes a chatty preamble that gets spliced verbatim
 * into the next step's prompt.
 */
export const WORKFLOW_ROLE_PIPE_NOTE = [
  "You are running as one step of a scripted pipeline, in the role above.",
  "Do exactly what this step asks — no more, and nothing from a later step.",
  "Your entire reply is piped verbatim into the next step's prompt, so answer",
  "with the artifact itself and no preamble, no restatement of the task and no",
  "closing pleasantries.",
].join(" ");

// -------------------------------------------------------- live progress rows

/**
 * The live-region id for one step's agent.
 *
 * Namespaced by the step, because a parallel stage has several agents running
 * at once and the host keys its rows by this id alone: `step-2.1:qa` and
 * `step-2.2:qa` are two rows, and re-running the same role in a later stage is
 * a third rather than a resurrection of the first.
 *
 * @param stepId - The step's id, e.g. `"3"` or `"2.1"`.
 * @param role - The step's `@role`, when it has one.
 */
export function workflowStepAgentId(stepId: string, role?: string): string {
  return role === undefined ? `step-${stepId}` : `step-${stepId}:${role}`;
}

/** One step's row in the host's live region, for as long as the step runs. */
interface StepLiveRow {
  /** Open the row. */
  start(): void;
  /** Republish one event the step's own agent emitted. */
  relay(event: AgentEvent): void;
  /**
   * Close the row. Must happen on every path out of the step, including
   * cancellation and a throw, or the host shows a step that ended forever.
   */
  end(resultText: string, isError: boolean): void;
}

/** Longest step summary carried on a live row; the host truncates further. */
const LIVE_TASK_MAX = 120;
/** Longest result echoed when a row closes. */
const LIVE_RESULT_MAX = 200;

/**
 * Build the live row for one step, when the host wired a live region at all.
 *
 * The row is described by the *step*, not by the prompt the lane actually
 * sends: a worktree lane wraps the author's line in several paragraphs of
 * lane contract ({@link buildWriteLanePrompt}), and none of that belongs in a
 * one-line status row.
 *
 * @param emit - The host's event sink, or `undefined` for no live region.
 * @param step - The step being run.
 * @param prompt - The step's own prompt, already expanded.
 * @param role - The step's `@role`, when it has one.
 */
function stepLiveRow(
  emit: ((event: AgentEvent) => void) | undefined,
  step: WorkflowStep,
  prompt: string,
  role?: string,
): StepLiveRow | undefined {
  if (emit === undefined) return undefined;
  const agentId = workflowStepAgentId(step.id, role);
  const head = role === undefined ? `step ${step.id}` : `@${role} · step ${step.id}`;
  const task = `${head}: ${oneLine(prompt, LIVE_TASK_MAX)}`;
  // A live region that throws must never be able to fail a pipeline step, so
  // every publish is swallowed the way an event listener's is.
  const publish = (event: AgentEvent): void => {
    try {
      emit(event);
    } catch {
      // A UI bug must never break a run.
    }
  };
  return {
    start: () => publish({ type: "subagentStart", agentId, task }),
    relay: (event) => publish({ type: "subagentEvent", agentId, event }),
    end: (resultText, isError) => publish({ type: "subagentEnd", agentId, resultText, isError }),
  };
}

/** How one agent run ended, plus what it spent. */
interface AgentRunOutcome {
  usage: Usage;
  reason: "completed" | "aborted" | "error";
  errorMessage?: string;
  text: string;
  /**
   * The kind of the terminal LLM error the child surfaced, when it failed on
   * one. Captured from the child's re-emitted `messageStream` error event (the
   * core loop re-emits every stream event, including the terminal `error`), so
   * the workflow can classify a failure transient-vs-deterministic from the
   * `AIError["kind"]` itself rather than by regexing an error string. The
   * stall-timeout fix in `@arcturn/ai` re-labels a dead socket as `network`,
   * which lands here as exactly that.
   */
  errorKind?: AIError["kind"];
  /**
   * The shape of the child's last turn — what it emitted, not what it said.
   * Captured from the `messageEnd` the core loop emits for every turn, so it
   * is the turn the run actually ended on. See {@link LastTurnShape}.
   */
  lastTurn?: LastTurnShape;
  /**
   * What the child spent its turns on: how many turns it took, how many times
   * it called each tool, and how many of those calls authored a file. Counted
   * from the child's own `toolStart`/`turnEnd` events — always present, even
   * for a child that did nothing, because "zero" is the answer that matters.
   */
  activity: StepActivity;
}

/**
 * What a lane wants to hear about its child's turns, beyond usage.
 *
 * Two events, both of which used to exist only in a person's memory of a run:
 * the model that ended a turn saying nothing, and the mid-run progress check
 * that told a role it had written no file. Handed in rather than read from a
 * global so a lane that has no ledger passes nothing.
 */
interface AgentRunSignals {
  /** The model ended a turn with no text and no tool call. */
  silentTurn(model: string, nudged: boolean): void;
  /** A progress check fired and its message was sent to the model. */
  progressWarning(turnIndex: number): void;
}

/**
 * Build the insights signals for one step's child, when a ledger is wired.
 *
 * The step's attribution is captured once here, so every event this child
 * emits lands under the right workflow, run, step and role.
 *
 * @param scope - The ledger plus this run's coordinates, when the host wired one.
 * @param stepId - The step whose child this is.
 * @param role - The step's `@role`, when it named one.
 */
function insightsSignals(
  scope: InsightsRunScope | undefined,
  stepId: string,
  role: string | undefined,
): AgentRunSignals | undefined {
  if (scope === undefined || !scope.recorder.enabled) return undefined;
  const attribution = {
    origin: "workflow" as const,
    workflow: scope.workflow,
    runId: scope.runId,
    stepId,
    ...(role === undefined ? {} : { role }),
  };
  return {
    silentTurn: (model, nudged) =>
      scope.recorder.record({ kind: "silent-turn", model, nudged, ...attribution }),
    progressWarning: (turnIndex) =>
      scope.recorder.record({ kind: "progress-warning", turnIndex, ...attribution }),
  };
}

/**
 * Drive one child agent to completion, accounting usage and honouring abort.
 *
 * Shared by every lane so cost accounting, the abort wiring and the
 * "`Agent.prompt` reports failure as an event, not a rejection" defence exist
 * exactly once.
 *
 * It is also the only place a step's agent is *visible*: the live row opens
 * before the first token and closes in a `finally`, so every lane gets the
 * same live region treatment and no path — completion, failure, cancellation
 * or a throw from the child itself — can leave a row behind.
 *
 * @param agent - The child agent.
 * @param prompt - What to send it.
 * @param signal - The workflow's cancellation signal.
 * @param live - The step's row in the host's live region, when there is one.
 * @param onUsage - Called with the running total after every turn — this is
 *   what lets a step aborted by {@link runStepWithDeadline}'s deadline report
 *   real spend instead of {@link emptyUsage}, even when `agent.prompt` below
 *   never returns: the turn that was in flight when the deadline fired has
 *   already been reported by the time it does.
 */
async function driveAgent(
  agent: WorkflowChildAgent,
  prompt: string,
  signal: AbortSignal,
  live?: StepLiveRow,
  onUsage?: (usage: Usage) => void,
  signals?: AgentRunSignals,
): Promise<AgentRunOutcome> {
  let usage = emptyUsage();
  let reason: "completed" | "aborted" | "error" = "completed";
  let errorMessage: string | undefined;
  let errorKind: AIError["kind"] | undefined;
  let text = "";
  let lastMessage: AssistantMessage | undefined;
  /**
   * What this child actually did, counted as it happens.
   *
   * Tool NAMES and call counts only — never an argument, a path or a result.
   * The eighty-turn builder that read for twenty-four minutes and wrote
   * nothing is invisible in every other record this run keeps, and this is the
   * cheapest possible way to see it.
   */
  let turns = 0;
  const toolCalls: Record<string, number> = {};
  live?.start();
  try {
    const unsubscribe = agent.subscribe((event) => {
      // Verbatim and namespaced, exactly as the `subagent` tool republishes a
      // child: the host's existing rows then track this step's tokens, todos
      // and current tool without knowing that workflows exist.
      live?.relay(event);
      // The turn the run ends on is the one a parked step is diagnosed from.
      if (event.type === "messageEnd") lastMessage = event.message;
      if (event.type === "toolStart") {
        toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
      }
      // The two events that used to leave no trace outside a person's memory
      // of the run. Both are diagnostics, so both are swallowed if the ledger
      // throws — a step must not fail over its own telemetry.
      if (event.type === "silentTurn") {
        try {
          signals?.silentTurn(event.model, event.nudged);
        } catch {
          // A recorder must never be able to fail a step.
        }
      } else if (event.type === "progressWarning") {
        try {
          signals?.progressWarning(event.turnIndex);
        } catch {
          // Same.
        }
      }
      if (event.type === "turnEnd") {
        turns += 1;
        usage = addUsage(usage, event.usage);
        onUsage?.(usage);
      } else if (event.type === "runEnd") {
        reason = event.reason;
        errorMessage = event.errorMessage;
      } else if (event.type === "messageStream" && event.event.type === "error") {
        // The core loop re-emits the terminal stream error before it becomes a
        // `runEnd`; the retry layer only surfaces the *final* error event, so
        // the last kind seen is the one that actually ended the run. This is
        // how a stalled-socket `network` (or a rate limit) reaches the step
        // classifier as a machine-readable kind.
        errorKind = event.event.error.kind;
      }
    });
    const onAbort = (): void => agent.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(prompt);
    } catch (error) {
      // `Agent.prompt` reports runtime failures as a `runEnd` event rather than
      // a rejection; this is the defensive fallback, not the main path.
      reason = "error";
      errorMessage = errorText(error);
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    try {
      text = agent.finalText();
    } catch {
      // A child that cannot render its own last message still ran; its usage and
      // (on the write lane) its diff are the parts that matter.
    }
  } finally {
    live?.end(
      errorMessage ?? (reason === "completed" ? oneLine(text, LIVE_RESULT_MAX) : `run ${reason}`),
      reason !== "completed",
    );
  }
  return {
    usage,
    reason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(errorKind === undefined ? {} : { errorKind }),
    text,
    ...(lastMessage === undefined ? {} : { lastTurn: turnShapeOf(lastMessage) }),
    activity: { turns, toolCalls, writes: countWrites(toolCalls) },
  };
}

/** The `lastTurn` spread every lane outcome carries, when the run saw a turn. */
function lastTurnOf(run: AgentRunOutcome): { lastTurn?: LastTurnShape } {
  return run.lastTurn === undefined ? {} : { lastTurn: run.lastTurn };
}

/**
 * The `activity` spread every lane outcome carries — always, unlike
 * {@link lastTurnOf}. A child that took no turns and called no tool is not an
 * absence of data; it is the loudest datum this record has.
 */
function activityOf(run: AgentRunOutcome): { activity: StepActivity } {
  return { activity: run.activity };
}

/**
 * A step outcome that failed before any agent was built — so, zero usage.
 *
 * Every caller is a *deterministic* refusal (plan mode has no lane, no lane was
 * wired, a role's `model:` is unknown): a rerun cannot change it, so it is
 * tagged `config` and the self-healing retry never touches it.
 */
function refusedStep(error: string): WorkflowStepOutcome {
  return { text: "", usage: emptyUsage(), isError: true, error, failureKind: "config" };
}

/**
 * How much of a failed step's final message survives into the journal and the
 * failure text. The tail rather than the head, because an agent narrates
 * forward: the last ~500 characters are where "I finished 3 of 5 indexes and
 * was starting the 4th" lives.
 */
const FINAL_WORDS_MAX_CHARS = 500;

/**
 * The capped excerpt of what an agent had said when its step errored.
 *
 * `driveAgent` calls `finalText()` unconditionally, so even an errored run
 * carries the agent's last message — the lanes used to throw it away with
 * `text: ""`. The pipe contract stands (a failed step feeds the next stage
 * nothing), but the words themselves go onto the outcome's `finalText`, the
 * durable `stepEnd` line and the failure message a human reads.
 *
 * @param text - The agent's final message, possibly empty.
 * @returns The trimmed tail, or `undefined` when there is nothing to keep.
 */
export function finalWordsExcerpt(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length <= FINAL_WORDS_MAX_CHARS) return trimmed;
  return `…${trimmed.slice(-FINAL_WORDS_MAX_CHARS)}`;
}

/**
 * The cause clause a lane's failure message carries when the child agent
 * exhausted its turn ceiling.
 *
 * The loop's own message ("Reached the maximum of N turns. Send another
 * message to continue…") is written for a person *in* that session; a
 * workflow operator is not, and "send another message" points at a
 * conversation they cannot reach. This names the real cause and the real
 * levers instead. The turn count is lifted from the loop's message (its first
 * integer) rather than re-derived, so the two can never disagree.
 *
 * @param roleName - The role the step dispatched to, when it named one.
 * @param message - The loop's turn-ceiling error text.
 */
function turnCeilingCause(roleName: string | undefined, message: string | undefined): string {
  const turns = message === undefined ? undefined : /\d+/.exec(message)?.[0];
  const ceiling = turns === undefined ? "its turn ceiling" : `its ${turns}-turn ceiling`;
  return roleName === undefined
    ? `hit ${ceiling} before finishing; raise maxTurns (subagentMaxTurns in config) or narrow ` +
        "the step"
    : `role "${roleName}" hit ${ceiling} before finishing; raise maxTurns in the role file or ` +
        "narrow the step";
}

/**
 * Did this settled step have anything at all to show for itself?
 *
 * THE VOID. A step whose whole job was "produce the ADR and write it to
 * `docs/adr/rag-architecture.md`" came back `done` having written no file and
 * said no word: `record{status:"empty", files:0}`, `text: ""`. Seven later
 * stages then cited an ADR that was never written, each re-deriving the
 * architecture from an empty `{{prev}}` and disagreeing with the last, and the
 * run burned hours and millions of tokens before anyone looked back at stage
 * 3. Nothing in the engine had asked the only question that catches it: did
 * this step produce anything observable?
 *
 * "Anything" is deliberately generous, because the strict reading breaks every
 * honest step. ANY non-empty text means the step spoke — a read-lane reviewer
 * that changes no file is the common case, not a fault — and any changed file
 * means it acted, even if it reported entirely through its diff. Only the
 * intersection, no words *and* no file, is nothing.
 *
 * The file half is asked of the engine's own {@link WorkflowPatchRecord}
 * rather than of the agent: a role cannot mint one (see
 * {@link stripPatchTrailers}), so `files` is what git actually saw. An absent
 * record is the read lane, which has no diff to report and is judged on its
 * text alone.
 *
 * @param text - The step's final text, after trailer stripping.
 * @param record - What the lane recorded about its diff, when it had one.
 */
export function stepProducedNothing(text: string, record?: WorkflowPatchRecord): boolean {
  return text.trim() === "" && (record === undefined || record.files === 0);
}

/**
 * The message an empty step fails with — see {@link stepProducedNothing}.
 *
 * Written to be read by whoever finds the parked run: it names what was
 * expected (a file, or failing that a reason), what came back (neither), and
 * the two levers that work — run it again, or ask it for less. Retry really is
 * the recovery path here: the architect that returned this void produced the
 * ADR on the very next attempt.
 *
 * @param stepId - The step that produced nothing.
 * @param role - The role it dispatched to, when it named one.
 */
export function emptyStepError(stepId: string, role: string | undefined): string {
  return (
    `step ${stepId}${role === undefined ? "" : ` (@${role})`} produced nothing — no file was ` +
    "changed and no text was returned. A step that reports neither a result nor a reason has " +
    "not run; retry it, or narrow what it was asked to do."
  );
}

/**
 * The message a write step fails with under a plan-mode parent.
 *
 * @param stepId - The step that tried to write.
 * @param role - The role it dispatches to.
 */
export function planModeWriteRefusal(stepId: string, role: string): string {
  return (
    `step ${stepId} dispatches @${role} on the write lane, and plan mode has no write lane: ` +
    "plan mode promises a read-only session with no prompts and no egress, and a worktree " +
    "whose patch is applied to your checkout is neither. Approve the plan (or leave plan mode) " +
    "and re-run the pipeline."
  );
}

/**
 * The message an exec step fails with under a plan-mode parent.
 *
 * The exec lane never touches the user's checkout, so this is not about the
 * tree: it is about the shell. Plan mode promises no prompts and no egress,
 * and a role holding `bash` — even in a throwaway worktree — can do both.
 *
 * @param stepId - The step that tried to execute.
 * @param role - The role it dispatches to.
 */
export function planModeExecRefusal(stepId: string, role: string): string {
  return (
    `step ${stepId} dispatches @${role} on the exec lane, and plan mode has no exec lane: ` +
    "the lane's worktree is thrown away unread, but the shell inside it is real, and plan " +
    "mode promises a session with no prompts and no egress. Approve the plan (or leave plan " +
    "mode) and re-run the pipeline."
  );
}

/** Count the files a unified diff touches. */
function countDiffFiles(diff: string): number {
  let files = 0;
  for (const line of diff.split("\n")) if (line.startsWith("diff --git ")) files++;
  return files;
}

/** `stderr` off a rejected `execFile`, when there is one. */
function stderrOf(error: unknown): string {
  const value = (error as { stderr?: unknown } | undefined)?.stderr;
  return typeof value === "string" ? value.trim() : "";
}

/** Why `git` refused, preferring its own words over the wrapper's. */
function gitComplaint(error: unknown): string {
  return oneLine(stderrOf(error) || errorText(error), 200);
}

/** Filesystem-safe stem for a step's worktree and patch file. */
function writeLaneSlug(stepId: string, role: string, attempt?: number): string {
  // A retry (`attempt > 0`) gets a distinct slug so its fresh worktree and
  // patch file never collide with the forensic ones the failed attempt kept.
  const suffix = attempt !== undefined && attempt > 0 ? `-r${attempt}` : "";
  return `${stepId}-${role}${suffix}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Pathspec keeping a role's own agent scratch out of every capture. */
const CAPTURE_PATHSPEC = ["--", ".", ":(exclude).arcturn"];

/**
 * Stage and read one worktree's whole delta.
 *
 * `git add --all` first, because an untracked new file is invisible to
 * `git diff <commit>` until it is in the index — and a role's new file is
 * exactly the change a pipeline most wants to keep. The diff is taken against
 * the worktree's **seed commit** when the lane made one, so a role that
 * committed its own work inside the worktree loses nothing; a lane that does
 * no seeding keeps the older `HEAD`-relative `--cached` behaviour.
 *
 * @param lane - The worktree lane.
 * @param worktree - The checkout to capture.
 */
async function captureWorktreeDiff(lane: WriteLane, worktree: WriteLaneWorktree): Promise<string> {
  try {
    await lane.exec(worktree.dir, ["add", "--all", ...CAPTURE_PATHSPEC]);
  } catch {
    // Staging failed (locked index, permissions): diff whatever is tracked
    // anyway — a partial patch beats no patch.
  }
  const args =
    worktree.baseRef === undefined
      ? ["diff", "--cached", "--binary", "--no-color", ...CAPTURE_PATHSPEC]
      : ["diff", "--binary", "--no-color", worktree.baseRef, ...CAPTURE_PATHSPEC];
  return (await lane.exec(worktree.dir, args)).stdout;
}

/**
 * Every path a unified diff would touch, as git would read them.
 *
 * Pulled from the markers that actually name targets — `---`/`+++` hunks,
 * `diff --git` headers, and rename/copy headers — with the `a/`/`b/` prefixes
 * stripped. A path git wrote in quoted C-string form is returned quoted and
 * fails the audit's `..` check on its escaped text, which is the conservative
 * direction.
 *
 * @param diff - A unified diff.
 */
function patchTargetPaths(diff: string): string[] {
  const paths: string[] = [];
  const strip = (raw: string): string => {
    const value = raw.trim();
    if (value === "/dev/null") return value;
    return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // `--- a/path\t2024-01-01` — git only writes the tab form for context
      // diffs, but honour it rather than auditing a timestamp.
      paths.push(strip((line.slice(4).split("\t")[0] ?? "").trim()));
    } else if (line.startsWith("diff --git ")) {
      const parts = line.slice("diff --git ".length).trim().split(/\s+/);
      // Only the unambiguous two-token form is split; anything else (a path
      // containing spaces) is audited whole, which can only over-reject.
      if (parts.length === 2) paths.push(strip(parts[0] ?? ""), strip(parts[1] ?? ""));
      else paths.push(line.slice("diff --git ".length).trim());
    } else if (/^(?:rename|copy) (?:from|to) /.test(line)) {
      paths.push(strip(line.replace(/^(?:rename|copy) (?:from|to) /, "")));
    }
  }
  return paths;
}

/**
 * Reject a patch that reaches outside the checkout before git ever sees it.
 *
 * Git ≥ 2.39.2 refuses `../`, `.git/` and symlinked targets itself, and that
 * hardening is the second wall here, not the only one — arcturn is the party
 * that decided to run `git apply` on a model's output unattended, so the
 * guarantee has to be arcturn's own. A vendored, ancient or misconfigured git
 * must not be the difference between "contained" and "arbitrary file write".
 *
 * @param diff - The captured patch.
 * @returns Every target path that fails the audit, deduplicated and in order;
 *   empty when the patch is confined to the checkout.
 */
export function auditPatchPaths(diff: string): string[] {
  const bad: string[] = [];
  for (const path of patchTargetPaths(diff)) {
    if (path === "" || path === "/dev/null") continue;
    const absolute = path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
    const segments = path.split(/[\\/]+/);
    const escapes = segments.some((segment) => segment === "..");
    const dotGit = segments.some((segment) => segment.toLowerCase() === ".git");
    if ((absolute || escapes || dotGit) && !bad.includes(path)) bad.push(path);
  }
  return bad;
}

/**
 * Run one step on a worktree lane: worktree in, and — on the write lane only
 * — a patch back out into the user's checkout.
 *
 * The invariants, in the order they are enforced:
 *
 * 1. **Plan mode has neither worktree lane.** Refused before a worktree
 *    exists and before a single token is spent.
 * 2. **The role's model is resolved before the worktree**, so a typo in a
 *    role's `model:` costs nothing.
 * 3. **The worktree is seeded** with the run's accumulated state and a seed
 *    commit, so the role sees the pipeline's work so far and its own commits
 *    survive capture.
 * 4. **The exec lane never captures.** Its worktree is deleted on completion
 *    and kept, clearly labelled inspect-only, on failure. Nothing it wrote
 *    can reach the user's checkout, whatever its report says.
 * 5. **Capture always, apply only on success** (write lane). A failed or
 *    cancelled role's partial work is still work: its diff is saved to a
 *    patch file and named in the error, but it never touches the checkout.
 * 6. **Audit, then `git apply`, plain.** Every target path is checked against
 *    {@link auditPatchPaths} first; then `--check`, then apply. No `--3way`,
 *    no `--force`. A refusal is a step error naming the preserved patch —
 *    arcturn surfaces conflicts, it never guesses at a merge.
 * 7. **The worktree is removed only on success.** A failure keeps it for
 *    forensics, and says where it is.
 *
 * @param request - The step being run.
 * @param def - The resolved role.
 * @param options - Lane, plan-mode getter and model resolver.
 * @param dispatch - Which worktree lane this is.
 */
async function runWorktreeStep(
  request: WorkflowStepRequest,
  def: AgentDef,
  options: RuntimeRunStepOptions,
  dispatch: "exec" | "write",
): Promise<WorkflowStepOutcome> {
  const { step, prompt, signal, onUsage } = request;
  if (options.planMode?.() === true) {
    return refusedStep(
      dispatch === "write"
        ? planModeWriteRefusal(step.id, def.name)
        : planModeExecRefusal(step.id, def.name),
    );
  }
  const lane = options.writeLane;
  if (!lane) {
    return refusedStep(
      `step ${step.id} dispatches @${def.name} on the ${dispatch} lane (tools: ${(def.tools ?? []).join(", ")}), ` +
        `but this host wired no ${dispatch} lane, so there is nowhere isolated to run it`,
    );
  }

  let model = request.model;
  if (model === undefined && def.model !== undefined) {
    if (!options.resolveModel) {
      return refusedStep(
        `role "@${def.name}" sets model "${def.model}" but no model resolver was supplied`,
      );
    }
    model = options.resolveModel(def.model);
    if (!model) {
      return refusedStep(
        `role "@${def.name}" names model "${def.model}", which is not a known model id`,
      );
    }
  }

  // A retry gets its own worktree/patch slug: the failed attempt's worktree is
  // kept for forensics, and `git worktree add` at the same path would collide.
  const slug = writeLaneSlug(step.id, def.name, request.attempt);
  let worktree: WriteLaneWorktree;
  try {
    worktree = await lane.createWorktree(slug, {
      patches: request.state?.appliedPatches ?? [],
    });
  } catch (error) {
    const detail = errorText(error);
    return {
      text: "",
      usage: emptyUsage(),
      isError: true,
      error: `step ${step.id} could not create a worktree for @${def.name}: ${detail}`,
      // A git index/ref lock is a transient collision the retry can clear;
      // anything else about worktree creation is a settled config problem.
      failureKind: isGitLockError(detail) ? "git-lock" : "config",
    };
  }

  const patchFile = join(dirname(worktree.dir), `${slug}.patch`);
  const record = (
    status: WorkflowPatchStatus,
    files: number,
    patch?: string,
  ): WorkflowPatchRecord => ({
    status,
    role: def.name,
    stepId: step.id,
    files,
    ...(patch === undefined ? {} : { patchPath: patch }),
  });

  let usage = emptyUsage();
  let agent: WorkflowLaneAgent | undefined;
  let reaped: number | undefined;
  /**
   * Kill the background processes this step started — once, whatever happens.
   *
   * Memoized so the explicit call (right after the agent stops, before the
   * diff is read and long before the worktree is removed) is the one that
   * counts, and the `finally` below is only the guarantee for paths that
   * never reach it. Teardown never decides the step, so a manager that throws
   * is swallowed exactly like a failed `worktree.remove()`.
   */
  const reap = async (): Promise<number> => {
    if (reaped !== undefined) return reaped;
    reaped = 0;
    try {
      reaped = (await agent?.killBackgroundTasks?.()) ?? 0;
    } catch {
      // Nothing to report but the count, and the count is now zero.
    }
    return reaped;
  };
  try {
    agent = await lane.spawn({
      def,
      cwd: worktree.dir,
      ...(model === undefined ? {} : { model }),
      stepId: step.id,
      // The human's run-scoped grant, carried onto the expensive lane too.
      ...(request.turnCeiling === undefined ? {} : { turnCeiling: request.turnCeiling }),
      // WRITE lane only: the exec lane's diff is discarded unread, so a role
      // there is *supposed* to finish with a report and no file.
      ...(dispatch === "write" ? { progressCheck: writeLaneProgressCheck } : {}),
    });
    const run = await driveAgent(
      agent,
      buildWriteLanePrompt(def, prompt, worktree.dir, dispatch),
      signal,
      // The row carries the *step's* prompt, not the lane contract wrapped
      // around it — and it opens here, once there is an agent to watch.
      stepLiveRow(options.emit, step, prompt, def.name),
      onUsage,
      insightsSignals(options.insights, step.id, def.name),
    );
    usage = run.usage;
    // The agent has stopped, so anything it left running is orphaned by
    // definition. Killing here — before the diff is captured, before the
    // patch is applied and before the worktree is removed — also keeps
    // capture deterministic: no process is still writing into the checkout
    // while git reads it.
    const tasks = backgroundTaskNote(await reap(), def.name);
    /** Append the reaping note to a failure message, when there was one. */
    const withTasks = (text: string): string => (tasks === "" ? text : `${text}\n${tasks}`);
    // The failure kind of an errored agent run: a caller-aborted run is
    // `cancelled`, a terminal LLM error carries its own kind (a stalled socket
    // is `network`, retried at the step level), and anything else is a settled
    // `agent-error`. Read where the step's error result is built.
    /** Read once: every branch below asks the same question of the same run. */
    const turnCeiling = isTurnCeilingError(run.errorMessage);
    const laneFailureKind = (): WorkflowFailureKind =>
      run.reason === "aborted"
        ? "cancelled"
        : turnCeiling
          ? "turn-ceiling"
          : run.errorKind !== undefined
            ? failureKindFromAIError(run.errorKind)
            : "agent-error";

    /**
     * The `: cause` fragment a lane's failure message interpolates. Turn
     * exhaustion is rewritten to name the real condition and the real levers
     * (see {@link turnCeilingCause}); any other error passes through verbatim.
     */
    const laneCause = (): string =>
      turnCeiling
        ? `: ${turnCeilingCause(def.name, run.errorMessage)}`
        : run.errorMessage
          ? `: ${run.errorMessage}`
          : "";

    /**
     * The agent's final words, for the error paths that keep them.
     *
     * A function, called from inside those branches only: the happy path
     * discards the excerpt, and computing it eagerly ran a trim and a slice
     * over a whole agent transcript on every worktree step that worked. The
     * same guard `createRuntimeRunStep` uses, expressed the only way it can be
     * here — the write lane decides "did this fail" after an `await`, so the
     * answer cannot be bound before it.
     */
    const laneFinalWords = (): string | undefined => finalWordsExcerpt(run.text);

    // Capture BEFORE any teardown decision — a cancelled role's partial work
    // is still work, and (on the write lane) the patch on disk is the durable
    // product. On the exec lane the same read only ever feeds a file count.
    let diff: string;
    try {
      diff = await captureWorktreeDiff(lane, worktree);
    } catch (error) {
      if (dispatch === "exec") {
        // Nothing was going to be kept anyway; a failed read costs a number.
        diff = "";
      } else {
        const complaint = gitComplaint(error);
        return {
          text: "",
          usage,
          isError: true,
          error: withTasks(
            `step ${step.id} (@${def.name}) could not capture a diff from ${worktree.dir}: ` +
              `${complaint}. The worktree is kept so the work is not lost.`,
          ),
          failureKind: isGitLockError(complaint) ? "git-lock" : "agent-error",
        };
      }
    }
    const files = countDiffFiles(diff);

    if (dispatch === "exec") {
      const discarded = record("discarded", files);
      const trailer = formatWriteLaneTrailer(discarded);
      if (run.reason !== "completed") {
        const finalWords = laneFinalWords();
        return {
          text: "",
          usage,
          isError: true,
          record: discarded,
          error: withTasks(
            `step ${step.id} (@${def.name}) ${run.reason === "aborted" ? "was cancelled" : "failed"}` +
              `${laneCause()}. The exec lane applies nothing, ` +
              `ever. Its worktree is kept at ${worktree.dir} for inspection only — nothing in it ` +
              `will ever be replayed into ${lane.cwd}; delete it when you are done.\n${trailer}`,
          ),
          ...(finalWords === undefined ? {} : { finalText: finalWords }),
          failureKind: laneFailureKind(),
        };
      }
      // A teardown failure here changes nothing about the result: the lane
      // applied nothing by construction, and `pruneWorkflowRuns` sweeps what
      // is left. The step's answer is its report.
      await removeWorktree(worktree);
      return {
        text: [run.text.trim(), tasks, trailer].filter((part) => part !== "").join("\n\n"),
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: false,
        record: discarded,
      };
    }

    if (diff.trim() !== "") {
      await mkdir(dirname(patchFile), { recursive: true });
      await writeFile(patchFile, diff, "utf8");
    }

    // Cancellation is checked here, not only through `run.reason`: Esc can
    // land *after* the agent finished and while git was still reading the
    // diff, and "the user cancelled but we wrote to their checkout anyway" is
    // the one outcome a cancel must never produce. Capture already happened,
    // so nothing is lost — the patch is on disk, unapplied.
    if (run.reason !== "completed" || signal.aborted) {
      // `captured` with no patch path when the role produced nothing: the
      // next stage still learns that a write step ran and landed nothing,
      // which is not the same as no write step having run at all.
      const captured =
        diff.trim() === "" ? record("captured", 0) : record("captured", files, patchFile);
      const kept =
        diff.trim() === ""
          ? ""
          : ` Patch preserved at ${patchFile}.\n${formatWriteLaneTrailer(captured)}`;
      const finalWords = laneFinalWords();
      return {
        text: "",
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: true,
        record: captured,
        error: withTasks(
          `step ${step.id} (@${def.name}) ${run.reason === "completed" || run.reason === "aborted" ? "was cancelled" : "failed"}` +
            `${laneCause()}. Nothing was applied.` +
            ` Worktree kept at ${worktree.dir}.${kept}`,
        ),
        ...(finalWords === undefined ? {} : { finalText: finalWords }),
        // `signal.aborted` here reads as a cancellation the driver records as
        // such; otherwise the agent's own terminal kind decides retryability.
        failureKind: signal.aborted ? "cancelled" : laneFailureKind(),
      };
    }

    if (diff.trim() === "") {
      await removeWorktree(worktree);
      const empty = record("empty", 0);
      return {
        text: [run.text.trim(), tasks, formatWriteLaneTrailer(empty)]
          .filter((part) => part !== "")
          .join("\n\n"),
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: false,
        record: empty,
      };
    }

    const unsafe = auditPatchPaths(diff);
    if (unsafe.length > 0) {
      const refused = record("refused", files, patchFile);
      return {
        text: "",
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: true,
        record: refused,
        error: withTasks(
          `step ${step.id} (@${def.name}): the captured patch targets paths outside this ` +
            `checkout — ${unsafe.join(", ")} — so arcturn refused it before git saw it, and ` +
            `nothing was changed in ${lane.cwd}. The patch is preserved at ${patchFile} and the ` +
            `worktree at ${worktree.dir}; read it before you do anything with it.` +
            `\n${formatWriteLaneTrailer(refused)}`,
        ),
        // A path-escape audit refusal is settled: the same role would produce
        // the same out-of-tree patch on a rerun. Never retried.
        failureKind: "patch-refused",
      };
    }

    // WRITE-AHEAD: the next line mutates the user's real checkout, and the
    // step's terminal is not written until this function returns — so a crash
    // in between used to leave the tree changed and the journal saying "not
    // done", and the resume re-applied. Recording the intent *first*, durably,
    // is what turns that window from ambiguous into recoverable: a resume finds
    // an announced apply, probes the checkout for exactly this patch, and skips
    // or re-runs on evidence. If the record cannot be made, the apply does not
    // happen — an unrecorded mutation is the one state resume cannot reason
    // about, and refusing costs the user a re-run rather than a corrupted tree.
    try {
      await request.durability?.intent({
        act: "apply",
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
        patchPath: patchFile,
        patchHash: hashPatch(diff),
        target: lane.cwd,
      });
    } catch (error) {
      const captured = record("captured", files, patchFile);
      return {
        text: "",
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: true,
        record: captured,
        error: withTasks(
          `step ${step.id} (@${def.name}): arcturn did not apply this patch because it could ` +
            `not record the intent to apply it in the run journal (${errorText(error)}). ` +
            `Nothing was changed in ${lane.cwd}. Applying without that record would leave a ` +
            `crash unable to tell whether the patch landed, and a resume could apply it twice. ` +
            `The patch is preserved at ${patchFile} and the worktree at ${worktree.dir}.` +
            `\n${formatWriteLaneTrailer(captured)}`,
        ),
        // Settled: the journal will not start working because the same step ran
        // again, and retrying would only burn tokens re-deriving this patch.
        failureKind: "config",
      };
    }
    const applied = await serializeApply(lane.cwd, () => applyPatch(lane, patchFile));
    // The outcome, immediately and durably: from here the ambiguous window is
    // one `git apply` wide, and a crash inside it is resolved by probing the
    // checkout (see `createPatchVerifier`) rather than by assuming.
    const settled = applied.ok
      ? record("applied", files, patchFile)
      : record("refused", files, patchFile);
    try {
      await request.durability?.effect({
        act: "apply",
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
        applied: applied.ok,
        patchPath: patchFile,
        record: settled,
      });
    } catch (error) {
      // The act already happened; misreporting *that* would be worse than
      // failing. So the record keeps the truth (`applied` when it landed, which
      // is what stops any resume from re-running this step) and the step fails
      // loudly, stopping the run on a journal that can no longer be trusted.
      return {
        text: "",
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: true,
        record: settled,
        error: withTasks(
          `step ${step.id} (@${def.name}): the patch ${applied.ok ? "was applied to" : "was refused by"} ` +
            `${lane.cwd}, but that outcome could not be written to the run journal ` +
            `(${errorText(error)}). Stopping: this run can no longer be resumed safely. The patch ` +
            `is at ${patchFile}${applied.ok ? " and is already in your checkout" : ""}.`,
        ),
        failureKind: "config",
      };
    }
    if (!applied.ok) {
      // The same record the journal already holds for this attempt, so the
      // step's report and its durable trace cannot drift apart.
      const refused = settled;
      return {
        text: "",
        usage,
        ...lastTurnOf(run),
        ...activityOf(run),
        isError: true,
        record: refused,
        error: withTasks(
          `step ${step.id} (@${def.name}): git apply refused this patch and nothing was changed ` +
            `in ${lane.cwd}. The patch is preserved at ${patchFile} and the worktree at ` +
            `${worktree.dir}; resolve it yourself (git apply --3way ${patchFile}) or re-run the ` +
            `step. git says: ${applied.error}\n${formatWriteLaneTrailer(refused)}`,
        ),
        // A refused apply is a real conflict against the checkout — a rerun of
        // the same patch conflicts identically. Deterministic; never retried.
        failureKind: "patch-refused",
      };
    }

    // The patch has landed: from here the step *succeeded*, and no teardown
    // problem may make it read as though it had not. A re-run of a step whose
    // record said "failed" would double-apply. This is the same record the
    // `stepEffect` line already committed, which is what a resume reads.
    const landed = settled;
    const teardown = await removeWorktree(worktree);
    return {
      text: [
        run.text.trim(),
        tasks,
        teardown === undefined
          ? ""
          : `(the patch landed; its worktree at ${worktree.dir} could not be removed: ${teardown} — it is stale, delete it at your leisure)`,
        formatWriteLaneTrailer(landed),
      ]
        .filter((part) => part !== "")
        .join("\n\n"),
      usage,
      ...activityOf(run),
      isError: false,
      record: landed,
    };
  } catch (error) {
    const tasks = backgroundTaskNote(await reap(), def.name);
    const detail = errorText(error);
    return {
      text: "",
      usage,
      isError: true,
      error:
        `step ${step.id} (@${def.name}) failed on the ${dispatch} lane: ${detail}. ` +
        `Worktree kept at ${worktree.dir}.${tasks === "" ? "" : `\n${tasks}`}`,
      // An unexpected throw here is a git index lock (transient) or a genuine
      // repo/IO fault (deterministic); classify on the message.
      failureKind: isGitLockError(detail) ? "git-lock" : "agent-error",
    };
  } finally {
    // Belt and braces: every path above already reaps before it returns, and
    // `reap` is idempotent — this is what keeps that true of paths added
    // later, and of a throw from anywhere the two explicit calls miss.
    await reap();
  }
}

/**
 * Say that a step killed the processes it started, or say nothing.
 *
 * A role reporting "the server responded 200" is only meaningful if the
 * reader can tell *which* server — so a step that had to reap something says
 * so in its own result text, where the next stage's prompt and the run record
 * both carry it.
 *
 * @param killed - How many of the step's background tasks were still running.
 * @param role - The role that started them.
 * @returns The note, or `""` when there was nothing to kill.
 */
function backgroundTaskNote(killed: number, role: string): string {
  if (killed <= 0) return "";
  return (
    `(killed ${killed} background task${killed === 1 ? "" : "s"} started by @${role}: a workflow ` +
    `step's background processes do not outlive it, and its worktree is gone)`
  );
}

/**
 * Tear a worktree down without letting the teardown decide the step.
 *
 * Removing a checkout is housekeeping; whether the patch landed is the
 * result. A failure here is reported, never raised — and `workflow-runs` is
 * pruned on every later run ({@link pruneWorkflowRuns}), so a leaked
 * directory is temporary rather than permanent.
 *
 * @param worktree - The checkout to remove.
 * @returns The complaint when removal failed, `undefined` when it worked.
 */
async function removeWorktree(worktree: WriteLaneWorktree): Promise<string | undefined> {
  try {
    await worktree.remove();
    return undefined;
  } catch (error) {
    return oneLine(errorText(error), 120);
  }
}

/**
 * One in-flight `git apply` chain per target checkout.
 *
 * A parallel stage may hold two write-lane roles at once (RFC 0001 §3.4 stage
 * 6 is exactly that), and their worktrees are genuinely independent — but the
 * *apply* is not: both replay into the same repository, whose index is a
 * single lock. Two concurrent applies would race for `.git/index.lock` and one
 * would fail with a lock error that reads exactly like a real conflict, which
 * is the worst possible failure mode for a feature whose whole promise is
 * "a refusal means the patch genuinely does not apply".
 *
 * Keyed by checkout so unrelated repositories never wait on each other, and
 * entries are dropped once their chain drains, so the map is bounded by the
 * repositories one process actually writes to.
 */
const applyQueues = new Map<string, Promise<unknown>>();

/**
 * Run one apply with every other apply against the same checkout excluded.
 *
 * @param cwd - The target checkout.
 * @param task - The apply to run.
 */
async function serializeApply<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const previous = applyQueues.get(cwd) ?? Promise.resolve();
  // `then(task, task)` so a failed predecessor still releases the queue.
  const next = previous.then(task, task);
  const guard = next.then(
    () => undefined,
    () => undefined,
  );
  applyQueues.set(cwd, guard);
  void guard.then(() => {
    if (applyQueues.get(cwd) === guard) applyQueues.delete(cwd);
  });
  return await next;
}

/**
 * Check-then-apply, into the lane's real checkout. Never `--3way`, never
 * `--force`: git refuses a patch whose context does not match rather than
 * overwriting, which is the whole reason this is safe to automate.
 *
 * @param lane - The worktree lane.
 * @param patchFile - Absolute path of the captured patch.
 */
async function applyPatch(
  lane: WriteLane,
  patchFile: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = ["apply", "--whitespace=nowarn"];
  try {
    await lane.exec(lane.cwd, [...args, "--check", "--", patchFile]);
  } catch (error) {
    return { ok: false, error: gitComplaint(error) };
  }
  try {
    await lane.exec(lane.cwd, [...args, "--", patchFile]);
  } catch (error) {
    return { ok: false, error: gitComplaint(error) };
  }
  return { ok: true };
}

/**
 * The confinement contract, in the role's own prompt.
 *
 * The permission rules and the `bash` guard enforce this whether the role
 * knows it or not — but a confined agent that does not know it is confined
 * just fails repeatedly, burning its turn budget on the same refused write.
 * So the prompt says where it is, what to type instead, and why the outside
 * is worthless to it: the same three facts the refusal message carries, in
 * the same words, before anything has been refused.
 *
 * @param worktreeDir - The role's own checkout.
 */
function worktreeContractLines(worktreeDir: string): string[] {
  return [
    "That isolation is enforced, not advisory: your write and edit tools are permitted inside",
    `${worktreeDir} only, and a shell command that reaches outside it — a \`cd\` into the user's`,
    "checkout, an absolute path, a `../` escape — is refused. Work from here and address files",
    'by paths relative to this worktree ("src/app.ts"), never by an absolute path into the',
    "user's checkout. Everything your step needs is already here, and this worktree's diff is",
    "the only record of what you did.",
  ];
}

/**
 * Render the prompt handed to a worktree-lane role.
 *
 * The role's instructions are folded into the *prompt* rather than a system
 * prompt for the same reason `team.ts`'s `buildMemberPrompt` does it:
 * `ArcturnRuntime.buildSessionAgent` — the only factory that roots an agent at
 * an arbitrary `cwd` with its own checkpoint store — takes no system-prompt
 * override.
 *
 * The two worktree lanes get different closing paragraphs because they make different
 * promises to the role: the write lane's work is replayed into the user's
 * checkout, the exec lane's is deleted. Telling an exec role otherwise would
 * be a lie it would act on.
 *
 * @param def - The role.
 * @param prompt - The step's spliced prompt.
 * @param worktreeDir - Where the agent is rooted.
 * @param dispatch - Which worktree lane it is running on.
 */
export function buildWriteLanePrompt(
  def: AgentDef,
  prompt: string,
  worktreeDir: string,
  dispatch: "exec" | "write" = "write",
): string {
  const tail =
    dispatch === "write"
      ? [
          `You are in an isolated git worktree at ${worktreeDir} — a detached checkout of the`,
          "user's repository, not the repository itself, seeded with this pipeline's work so far",
          "and committed, so anything you change (or commit) here is your own delta. When you",
          "finish, that delta is captured as a patch and replayed into the user's checkout with a",
          "plain `git apply`, which refuses anything whose context no longer matches. So keep the",
          "change minimal and inside your scope, and finish with a short report: what you changed,",
          "which files, and how you verified it.",
          ...worktreeContractLines(worktreeDir),
          // The engine's own rule, in every write lane — see @arcturn/core large-content.ts.
          ...LARGE_CONTENT_LINES,
        ]
      : [
          `You are in an isolated git worktree at ${worktreeDir} — a detached checkout of the`,
          "user's repository, not the repository itself, seeded with this pipeline's work so far.",
          "You may run whatever builds, tests and audits your role calls for. Nothing you change",
          "here is kept: this worktree is deleted when your step ends and its diff is never",
          "applied to the user's checkout, so editing files is a way to investigate, never a way",
          "to deliver. Your reply is the only thing that survives — finish with the exact commands",
          "you ran, their exit codes, and what you concluded.",
          ...worktreeContractLines(worktreeDir),
        ];
  return [
    `Role instructions (${def.name}):`,
    def.systemPrompt,
    "",
    WORKFLOW_ROLE_PIPE_NOTE,
    "",
    "Your step:",
    prompt,
    "",
    "Nobody can answer questions for you.",
    ...tail,
  ].join("\n");
}

/**
 * Bind {@link WorkflowRunContext.runStep} to real child agents.
 *
 * Four dispatches live here, chosen per step and in this order:
 *
 * 1. **No `@role`** — one anonymous child through `createSubagent`, exactly as
 *    before roles existed.
 * 2. **`@role` with no `tools:` at all** — refused ({@link undeclaredToolsError}).
 * 3. **`@role` whose tools are all non-mutating** — the read lane: the same
 *    `createSubagent` call, but carrying the role's real name, description,
 *    system prompt and model. Its non-yolo narrowing is untouched.
 * 4. **`@role` carrying `bash`, or `write`/`edit`/`multiedit`** — the exec or
 *    write lane ({@link runWorktreeStep}).
 *
 * An unknown role, an undeclared tool list, and a role that cannot run in this
 * session at all all fail the step *before* an agent is built, so a mis-typed
 * or over-broad pipeline costs nothing.
 *
 * @param host - Usually the live `ArcturnRuntime` (taken structurally).
 * @param options - Step-agent overrides, role resolution and the worktree lane.
 */
export function createRuntimeRunStep(
  host: WorkflowAgentHost,
  options: RuntimeRunStepOptions = {},
): WorkflowStepRunner {
  return async (request): Promise<WorkflowStepOutcome> => {
    const { step, prompt, model, signal, onUsage } = request;
    if (signal.aborted) return { text: "", usage: emptyUsage(), isError: true, error: "cancelled" };

    const roleName = request.agent ?? step.agent;
    let role: AgentDef | undefined;
    if (roleName !== undefined) {
      // Announce the write-ahead contract *before* the role resolves into a
      // lane: a resume may only re-run an interrupted step when the runner
      // promised to record any irreversible act first, and all three lanes keep
      // that promise (the write lane announces its `git apply`; the exec lane's
      // worktree is discarded; the read lane's tools cannot reach the
      // checkout). An un-roled step gets this only when its tools were narrowed
      // — see below. A failure to record it is swallowed on purpose: the worst
      // it costs is that a crash leaves this step looking opaque, which resume
      // handles by *not* re-running it. The record that must not be lost is the
      // apply intent, and that one refuses to be swallowed.
      await declareGuarded(request);
      if (!options.resolveAgent) {
        return refusedStep(
          `step ${step.id} names role "@${roleName}" but no role resolver was supplied`,
        );
      }
      role = options.resolveAgent(roleName);
      if (!role) {
        return refusedStep(unknownRoleError(roleName, step.id, options.agentNames?.() ?? []));
      }
      if (role.tools === undefined) return refusedStep(undeclaredToolsError(role.name, step.id));
      // ORG MEMORY: the single injection point, deliberately *after* the role
      // has been resolved and validated and *before* its lane is derived, so
      // the lane is still computed from the role file's own `tools` and a note
      // cannot move a reviewer onto the write lane. Only `systemPrompt`
      // changes; every other field is the loader's.
      const memory = options.orgMemory?.(role.name);
      if (memory !== undefined && memory !== "") {
        role = { ...role, systemPrompt: `${role.systemPrompt.trimEnd()}\n\n${memory}` };
      }
      const dispatch = roleDispatch(role);
      if (dispatch !== "read") return await runWorktreeStep(request, role, options, dispatch);
    }

    // Precedence: an explicit `[tag]` beats the role's own `model:`, which
    // beats the host's subagent route (resolved inside `createSubagent`).
    const def: AgentDef =
      role === undefined
        ? {
            name: `workflow-step-${step.id}`,
            description: `Workflow step ${step.id}`,
            systemPrompt: options.systemPrompt ?? WORKFLOW_STEP_SYSTEM_PROMPT,
            ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
            ...(model === undefined ? {} : { model: model.id }),
            source: "<workflow>",
          }
        : {
            ...role,
            systemPrompt: `${role.systemPrompt.trim()}\n\n${WORKFLOW_ROLE_PIPE_NOTE}`,
            ...(model === undefined ? {} : { model: model.id }),
          };
    // An un-roled step is only *provably* harmless when its tools were narrowed
    // to non-mutating ones. Left wide open (the yolo default) it can write and
    // shell straight into the user's checkout with nothing announcing it, so it
    // stays deliberately un-declared: a crash leaves it opaque, and resume will
    // not re-run an opaque step. Better a step re-done by hand than a change
    // applied twice.
    if (role === undefined && confinedToReading(options.tools)) await declareGuarded(request);
    const agent = host.createSubagent(prompt, def, {
      origin: workflowStepOrigin(step.id, role?.name),
      // A turn ceiling a human raised at a parked step, for this run only.
      ...(request.turnCeiling === undefined ? {} : { turnCeiling: request.turnCeiling }),
    });
    const run = await driveAgent(
      agent,
      prompt,
      signal,
      stepLiveRow(options.emit, step, prompt, role?.name),
      onUsage,
      insightsSignals(options.insights, step.id, role?.name),
    );

    const isError = run.reason !== "completed";
    // A stalled/rate-limited read-lane child surfaces its terminal LLM kind,
    // which the step retry loop reads to self-heal; a child that ran out of
    // turns is the named, deterministic `turn-ceiling`; an aborted child is a
    // cancellation, everything else a settled agent error.
    const turnCeiling = isError && isTurnCeilingError(run.errorMessage);
    const failureKind: WorkflowFailureKind | undefined = !isError
      ? undefined
      : run.reason === "aborted"
        ? "cancelled"
        : turnCeiling
          ? "turn-ceiling"
          : run.errorKind !== undefined
            ? failureKindFromAIError(run.errorKind)
            : "agent-error";
    // The agent's final words are kept on an error — the pipe still gets ""
    // (a failed step must not feed the next stage), but the excerpt reaches
    // the journal and the failure message. See {@link finalWordsExcerpt}.
    const finalWords = isError ? finalWordsExcerpt(run.text) : undefined;
    return {
      text: isError ? "" : run.text,
      usage: run.usage,
      ...lastTurnOf(run),
      ...activityOf(run),
      isError,
      ...(isError
        ? {
            error: turnCeiling
              ? `step ${step.id}${role === undefined ? "" : ` (@${role.name})`}: ` +
                `${turnCeilingCause(role?.name, run.errorMessage)}.`
              : (run.errorMessage ?? `step ${step.id} ${run.reason}`),
          }
        : {}),
      ...(finalWords === undefined ? {} : { finalText: finalWords }),
      ...(failureKind === undefined ? {} : { failureKind }),
    };
  };
}

// ------------------------------------------------ production worktree wiring

/**
 * The slice of a `Tool` the worktree lanes hand back to the agent.
 *
 * `execute` is declared (as a method, so a real `Tool`'s narrower context type
 * still satisfies it) because the lane does not merely *filter* the toolset:
 * it wraps `bash`, so the step can learn which background tasks its own role
 * started. Optional so a test double that only names its tools still fits.
 */
export interface WriteLaneTool {
  readonly definition: { readonly name: string };
  execute?(
    input: Record<string, unknown>,
    ctx: never,
  ): Promise<{ content?: unknown; isError?: boolean; details?: unknown }>;
}

/**
 * The slice of a child's permission engine the worktree lanes seed.
 *
 * Three members, and each one is load-bearing for {@link confineToWorktree}:
 * the rules it inherited (a session agent is built with everything the user
 * has approved *in the real checkout*, which is exactly the wrong authority
 * for an agent rooted somewhere else), the ability to drop those, and the
 * ability to add the confinement's own.
 */
export interface WriteLanePermissions {
  /** The engine's effective rules, in insertion order. */
  readonly rules: readonly PermissionRule[];
  /** Append a rule. */
  addRule(rule: PermissionRule): void;
  /** Drop every rule (or every rule of one scope). */
  clearRules(scope?: PermissionScope): void;
}

/** The slice of `Agent` a worktree lane narrows and drives. */
export interface WriteLaneSessionAgent extends WorkflowChildAgent {
  /** The agent's tools, before narrowing. */
  readonly tools: readonly WriteLaneTool[];
  /** Replace the tool set — how a role's `tools:` becomes a shorter array. */
  setTools(tools: WriteLaneTool[]): void;
  /**
   * The agent's own permission engine, when it has one.
   *
   * Optional so a lane double that only names its tools still fits the shape;
   * a child built without one simply cannot be confined, and
   * {@link confineToWorktree} says so rather than pretending.
   */
  readonly permissions?: WriteLanePermissions;
}

/**
 * The slice of `@arcturn/tools`'s `BackgroundTaskManager` a step's teardown
 * needs: is this task still running, and stop it.
 *
 * The manager is one per session (`createDefaultTools` builds it, the `bash`
 * tool closes over it), so it is shared by every agent this runtime makes —
 * which is exactly why the lane tracks task *ids* per child instead of
 * reaping by `list()`. A step kills what it started; the main session's own
 * tasks, and a sibling step's, are none of its business.
 */
export interface WorkflowBackgroundTasks {
  poll(taskId: string): { readonly running: boolean } | undefined;
  kill(taskId: string): boolean;
}

/** The slice of `ArcturnRuntime` {@link createRuntimeWriteLane} needs. */
export interface WriteLaneHost {
  /** The user's checkout: worktrees branch off it, patches land back in it. */
  readonly cwd: string;
  readonly paths: { readonly home: string };
  readonly router: { specFor(kind: "subagent"): ModelSpec };
  /**
   * The session's background-task manager (`ArcturnRuntime.backgroundTasks`),
   * so a step can kill the processes its role started before its worktree is
   * deleted underneath them.
   *
   * Optional: a host that has none simply reaps nothing, exactly as before.
   */
  readonly backgroundTasks?: WorkflowBackgroundTasks;
  /** The only factory that roots an agent at an arbitrary `cwd`. */
  buildSessionAgent(options: {
    sessionId: string;
    cwd?: string;
    model?: ModelSpec;
    /**
     * The role's own turn ceiling, clamped down by the session's
     * `subagentMaxTurns` inside `buildSessionAgent`. Passed on every spawn,
     * `undefined` included: passing the key is what opts a role's session
     * agent into the subagent ceiling at all.
     */
    maxTurns?: number | undefined;
    /**
     * A human's run-scoped turn grant for this step, which lifts BOTH halves
     * of `buildSessionAgent`'s clamp — the role's `maxTurns:` and the
     * session's `subagentMaxTurns` — for this run only. Absent leaves the
     * clamp byte-for-byte what it was.
     */
    turnCeiling?: number | undefined;
    /**
     * Mid-run progress check for this child, when the lane installs one (see
     * {@link writeLaneProgressCheck}). Optional on the host so a runtime whose
     * agent loop predates the option still satisfies the shape.
     */
    progressCheck?: WorkflowProgressCheck | undefined;
    /**
     * {@link workflowStepOrigin} for the step this agent serves. A worktree
     * role prompts as readily as a read-lane one — more so, since it holds
     * `bash` or `edit` — so its prompts must be as attributable.
     */
    origin?: string;
    /**
     * This child's tool list is the **lane's** to decide, so the runtime must
     * not install a per-turn `getTools` override on top of it.
     *
     * Everything the lane does to a child's tools it does with `setTools`:
     * the role's declared `tools:` becomes a genuinely shorter array, `bash`
     * gets the worktree confinement guard, every tool gets the step's
     * background-task tracking. A deferred/progressively-disclosed toolset
     * replaces exactly that list, every turn, with the runtime's full and
     * unwrapped one — so with `deferredTools.enabled` on, all three would
     * still be installed on the agent and none of them would ever run, while
     * `agent.tools` kept reporting the narrowed list. Progressive disclosure
     * has nothing to offer this child either: a role's tool set is written
     * down in its role file, so there is nothing for it to discover.
     */
    fixedToolset?: boolean;
  }): WriteLaneSessionAgent;
}

/** Per-spawn `git` timeout, matching `scouts.ts`. */
const GIT_TIMEOUT_MS = 15_000;
/** Output cap for a captured diff, matching `team.ts`. */
const DIFF_MAX_BUFFER = 4 * 1024 * 1024;
/**
 * Bound on how many untracked-but-not-ignored files {@link createRuntimeWriteLane}
 * will snapshot for worktree seeding.
 *
 * The feature exists for a developer's scratch file, a fresh config, a stray
 * fixture — not for a whole uncommitted dependency tree a `.gitignore` forgot
 * to cover. Past the cap the snapshot simply stops growing rather than
 * failing the run: a role still gets the tracked baseline and every patch
 * this run has applied, exactly as it did before this feature existed.
 */
const UNTRACKED_SEED_FILE_CAP = 500;
/** Combined byte bound for the untracked snapshot, matching {@link DIFF_MAX_BUFFER}'s order of magnitude. */
const UNTRACKED_SEED_BYTES_CAP = DIFF_MAX_BUFFER;
/**
 * Identity for the seed commit.
 *
 * Passed per-invocation with `-c` rather than configured: the commit exists
 * only inside a throwaway worktree, so borrowing the user's name for it would
 * be both pointless and misleading, and a repository with no `user.email` set
 * at all must still be able to run a pipeline.
 */
const SEED_COMMIT_IDENTITY = [
  "-c",
  "user.email=workflow@arcturn.invalid",
  "-c",
  "user.name=arcturn",
];

// -------------------------------------------------------- worktree confinement

/**
 * Absolute prefixes a confined command may still name.
 *
 * A worktree-lane role legitimately runs the toolchain — `/usr/bin/env`,
 * `/opt/homebrew/bin/node`, a temp file under `/var/folders` — and refusing
 * those would refuse every real command. What is *not* here is the interesting
 * part: the user's home directory and therefore the user's checkout, which is
 * the only place a wandering role does damage that a reviewer never sees.
 *
 * The exemption is for **reading and for running**, and for nothing else. A
 * repository cloned to `/tmp/victim` or `/opt/victim` is somebody's work like
 * any other, so a token under one of these roots that is the *target* of a
 * write ({@link writeTargetIndices}) is refused exactly as one in the user's
 * home is — otherwise the wall would refuse `cd /tmp/victim` while waving
 * `cp out.js /tmp/victim/out.js` through, which is an oversight, not a
 * decision. The one carve-out is {@link isDevicePath}: a redirect into
 * `/dev/null` writes to a device, not to anybody's work.
 */
const SYSTEM_PATH_PREFIXES: readonly string[] = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/opt/",
  "/etc/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/var/",
  "/private/var/",
  "/tmp/",
  "/private/tmp/",
  "/Library/",
  "/System/",
  "/Applications/",
];

/** Builtins that move a whole command's frame of reference. */
const DIRECTORY_BUILTINS: ReadonlySet<string> = new Set(["cd", "pushd", "chdir"]);

/**
 * Tools the confinement hands straight back to the session, unruled.
 *
 * Deny-by-default ({@link worktreeConfinementRules}) would otherwise take
 * these with it, and every one of them is a tool whose subject a *path* rule
 * cannot decide:
 *
 * - the readers (`read`, `grep`, `glob`, `ls`, `search_code`, …) name paths,
 *   but reading the user's checkout is how a role writes a patch that applies
 *   to it — the confinement is about where the bytes land, not what is read;
 * - `bash`'s subject is a command, so *where it writes* is
 *   {@link guardWorktreeBash}'s question and not a rule's — and pass-through
 *   means the session's own answer still stands, so a mode that would have
 *   prompted for a shell command still prompts for it;
 * - `fetch` and `websearch` name a URL and never touch the filesystem;
 * - `todo`, `plan`, `memory` and `skill` write session state or the agent's
 *   own `cwd`, which *is* the worktree.
 */
const CONFINEMENT_PASSTHROUGH_TOOLS: ReadonlySet<string> = new Set([
  ...DEFAULT_READ_ONLY_TOOLS,
  "search_code",
  "symbols",
  "outline",
  "fetch",
  "websearch",
  "todo",
  "plan",
  "memory",
  "skill",
  ...EXEC_TOOLS,
]);

/**
 * The scope the confinement's own fall-through rules carry.
 *
 * `user` is the FARTHEST scope, and that is exactly what these rules want:
 * they are the confinement's floor, not its wall. `matchRules` ranks by scope
 * before anything else, so every rule the child inherited — each of its
 * denies, re-scoped to `session`, and each grant it kept for a
 * {@link CONFINEMENT_PASSTHROUGH_TOOLS} tool — outranks the floor without
 * having to out-score it. That is what keeps deny-by-default from quietly
 * *widening* anything: a session that already answered a question about
 * `bash` or `read` still answers it, and nothing the confinement adds can
 * weaken an inherited deny. The wall proper — the pair of rules per mutating
 * tool — is `session`-scoped, the nearest scope there is.
 */
const CONFINEMENT_FLOOR_SCOPE: PermissionScope = "user";

/** The drive letter a Windows absolute path starts with, e.g. `C:`. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * A path with its drive letter removed and its separators folded to `/`.
 *
 * Windows spells one place several ways — `C:\Windows`, `c:/windows`, and the
 * same directory on `D:` for a runner whose volume is not `C:` — and a wall
 * that compares the bytes reads them as three different places.
 */
function driveRelative(path: string): string {
  return path.replace(DRIVE_PREFIX, "").replace(/\\/g, "/");
}

/**
 * Every sink a Windows path can name, drive-relative and folded — the null
 * device as a POSIX-shaped command spells it (`C:\dev\null`), as Windows
 * spells it (`\\.\NUL`), and the two standard streams a redirect discards to.
 */
const WINDOWS_DEVICE_SINKS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/nul",
  "//./nul",
]);

/**
 * Whether a path names a device rather than somebody's work.
 *
 * `2>/dev/null` is the single most common thing a real command does with an
 * absolute path, and it writes to a character device. Everything else under
 * {@link SYSTEM_PATH_PREFIXES} is a place a checkout can live, so this is the
 * one write the toolchain exemption keeps.
 *
 * A role writes `2>/dev/null` on every platform — the commands a model
 * produces are POSIX shell whatever the host is — and on Windows
 * `path.resolve` hands that back as `C:\dev\null`. Reading it there as "a
 * file called null in somebody's directory" refused the commonest redirect
 * there is on one platform out of three.
 *
 * On a drive-rooted path only the **sinks themselves** count, never the
 * subtree: POSIX has a `/dev` filesystem where everything under it is a
 * device, and Windows has no `/dev` at all — what it has is a great many
 * developers who keep their checkouts in `C:\dev`, and `> C:\dev\repo\out.js`
 * is a write into somebody's work like any other. `\\.\NUL` is the sink
 * spelled the way Windows spells it. A bare `NUL` never arrives here: it is
 * relative, so it resolves *inside* the worktree and is allowed before this
 * is asked.
 *
 * @param path - An absolute, already-resolved path.
 */
export function isDevicePath(path: string): boolean {
  // POSIX, unchanged: the whole of `/dev` is devices.
  if (path === "/dev" || path.startsWith("/dev/")) return true;
  if (!DRIVE_PREFIX.test(path) && !path.startsWith("\\\\")) return false;
  return WINDOWS_DEVICE_SINKS.has(driveRelative(path).toLowerCase());
}

/** A leading `VAR=value` token, which stands in front of the command word. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The redirection prefix on a raw token: `>`, `>>`, `2>`, `&>`, `>|`. */
const WRITE_REDIRECT = /^\d*&?>{1,2}\|?/;

/** Commands whose every non-flag argument is something they change. */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "tee",
  "dd",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "truncate",
  "unlink",
  "shred",
  "chmod",
  "chown",
  "chgrp",
  "ln",
]);

/** Commands whose LAST non-flag argument is the destination. */
const COPY_COMMANDS: ReadonlySet<string> = new Set(["cp", "mv", "install", "rsync", "scp"]);

/** Flags whose value relocates where a command writes, extracts or runs. */
const RELOCATING_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "--cwd",
  "--prefix",
  "--git-dir",
  "--work-tree",
  "--directory",
  "-o",
  "--output",
  "--outfile",
  "--out-dir",
  "--out-file",
  "--output-dir",
  "--dest",
  "--destination",
  "--target-directory",
]);

/** Words after which a quoted string is a COMMAND, and never data. */
const CODE_QUOTE_LEADS: ReadonlySet<string> = new Set([
  "-c",
  "-lc",
  "-ic",
  "--command",
  "eval",
  "--eval",
  ...DIRECTORY_BUILTINS,
]);

/**
 * Commands whose inline-script argument is a *program*, not a pattern.
 *
 * `sed -e` and `awk` are deliberately absent: their scripts are full of
 * slash-delimited addresses that are not paths, and reading those as targets
 * is the exact false-refusal this wall already learned to stop making
 * ({@link isPlausibleTarget}). What is here is the set of runtimes whose
 * one-liner can open a file — which is what makes `node -e "…writeFileSync…"`
 * a write tool wearing a reader's clothes.
 */
const INLINE_SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "php",
  "osascript",
  "tclsh",
  "Rscript",
]);

/** The flags that introduce one. */
const INLINE_SCRIPT_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "-c",
  "--eval",
  "--command",
  "-E",
  "-p",
  "--print",
]);

/** `$NAME` and `${NAME}` — the two spellings a shell expands inside a path. */
const SHELL_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** A variable reference that survived {@link expandVariables}. */
const UNRESOLVED_VARIABLE = /\$\{?[A-Za-z_]/;

/**
 * The path a name really points at, every symlink on the way resolved.
 *
 * Comparing paths lexically is comparing *names*, and a symlink is a second
 * name for someone else's directory: with `escape` inside the worktree linked
 * at the user's checkout, `<worktree>/escape/server.js` reads as "inside" to
 * `relative()` while the bytes land outside. `git worktree add` reproduces
 * every symlink a repository has checked in, and `ln -s "$HOME/repo" link` is
 * one command, so the wall has to be physical or it is not a wall.
 *
 * A path that does not exist yet is the normal case for a write, so the walk
 * climbs to the nearest ancestor that *does* exist, resolves that, and puts
 * the missing tail back on — the leaf cannot be a symlink if it is not there,
 * but any of its parents can be. Nothing here creates, opens or writes
 * anything, and a path whose every component is missing (or unreadable)
 * resolves to itself, which leaves the decision exactly where a lexical one
 * would have left it.
 *
 * Dependency-free by design, and bounded: the climb stops the moment it
 * reaches `stopAt`, which the caller has already resolved and so has nothing
 * left to say. Resolving a path just inside a worktree therefore costs one
 * failed `realpathSync` and no walk above the worktree at all — on an
 * operation that is about to cost a file write or a process spawn anyway.
 *
 * @param value - Any path; relative ones resolve against the process cwd.
 * @param stopAt - An ancestor whose own physical spelling is already known —
 *   i.e. the output of an earlier `physicalPath`, never a raw one. Reaching
 *   it ends the climb.
 * @returns The absolute, symlink-free spelling of `value`.
 */
function physicalPath(value: string, stopAt?: string): string {
  const absolute = resolve(value);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    if (existing === stopAt) return join(existing, ...missing);
    try {
      const real = realpathSync(existing);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(existing);
      // `/` resolves or nothing does; either way stop rather than loop.
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `path` is `root` or something below it, by name alone. */
function within(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether `path` is the root itself or something inside it — *physically*.
 *
 * The question this answers is "do these bytes live in that directory", not
 * "do these strings look alike". Resolving the root as well as the candidate
 * is what keeps the answer right on a macOS temp directory, where `/tmp/wt`
 * and `/private/tmp/wt` are one place spelled two ways.
 *
 * The filesystem is only consulted when it can change the answer. A symlink
 * can carry a path *out* of the root; it cannot carry one in that was never
 * named there — so a candidate that is outside both spellings of the root is
 * outside, decided without a syscall, exactly as it was before this was
 * physical at all.
 *
 * @param path - The candidate path.
 * @param root - The directory it must be inside.
 * @param realRoot - `root` already resolved, for a caller asking about many
 *   candidates against one root (the bash wall asks once per token).
 */
function isUnder(path: string, root: string, realRoot = physicalPath(root)): boolean {
  const target = resolve(path);
  if (!within(target, resolve(root)) && !within(target, realRoot)) return false;
  return within(physicalPath(target, realRoot), realRoot);
}

/**
 * Substitute the shell variables whose value this wall actually knows.
 *
 * An unexpanded `$HOME` is not an exotic quoting trick, it is how everyone
 * writes a home path in a script — and `resolve(worktree, "$HOME/x")` reads
 * it as a *directory named `$HOME` inside the worktree*, i.e. as confined.
 * That is the worst direction a wall can be wrong in, and it is how four of
 * the five ordinary shapes that write the org memory store walked past this
 * one. Expanding what is knowable makes `$HOME/…` behave exactly like the
 * `~/…` the wall has always refused.
 *
 * Only names this function can be sure of are substituted; anything else is
 * left standing, which is what {@link UNRESOLVED_VARIABLE} then reads as
 * "unknown" rather than as "inside".
 *
 * @param value - One token, or the right-hand side of an assignment.
 * @param variables - What is known so far, in command order.
 */
function expandVariables(value: string, variables: ReadonlyMap<string, string>): string {
  if (!value.includes("$")) return value;
  return value.replace(
    SHELL_VARIABLE,
    (whole: string, braced: string | undefined, bare: string | undefined) =>
      variables.get(braced ?? bare ?? "") ?? whole,
  );
}

/**
 * The variables a worktree-lane command starts out knowing.
 *
 * `HOME` because it is the one the escape is spelled with, and `PWD` because
 * a confined role's working directory *is* the worktree — so `> $PWD/out.log`
 * has to keep working, or hardening the wall just moves the false refusals.
 *
 * @param root - The worktree, already resolved.
 */
function baseShellVariables(root: string): Map<string, string> {
  const home = homedir();
  return new Map([
    ["HOME", home],
    ["USERPROFILE", home],
    ["PWD", root],
  ]);
}

/** Expand a leading `~` so `~/repo` is compared as the path it really is. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith(`~${sep}`) || value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
}

/**
 * Toolchain territory on a Windows volume, as {@link SYSTEM_PATH_PREFIXES} is
 * on a POSIX one — drive-rooted and slash-folded, so `C:\Windows\System32`,
 * `c:/windows/system32` and `D:\Program Files\nodejs` all read as one place.
 *
 * These are matched only against a path that carries a drive letter, so a
 * POSIX path can never reach them: `/windows/anything` on Linux is somebody's
 * directory, not a toolchain, and this list must not decide otherwise.
 */
const WINDOWS_SYSTEM_PATH_PREFIXES: readonly string[] = [
  "/windows/",
  "/program files/",
  "/program files (x86)/",
  "/programdata/",
];

/**
 * Whether an absolute path is toolchain territory rather than someone's work.
 *
 * POSIX paths are decided by {@link SYSTEM_PATH_PREFIXES} exactly as before.
 * A drive-rooted path is decided by {@link WINDOWS_SYSTEM_PATH_PREFIXES} as
 * well, and it has to be: on Windows every one of the POSIX prefixes is a
 * string no real path begins with, so the toolchain exemption did not exist
 * there and a role that ran `C:\Windows\System32\where.exe node` — or
 * anything else the shell resolved to an absolute interpreter — was refused
 * for reading the toolchain it was told to use. A false refusal on this wall
 * costs the step a turn and teaches the model the wall is arbitrary, which is
 * the failure mode {@link isPlausibleTarget} was written for.
 *
 * The exemption stays what it was in the direction that matters: **reads and
 * runs only**. A write into any of these is refused on either platform.
 *
 * @param path - An absolute, already-resolved path.
 */
export function isSystemPath(path: string): boolean {
  if (SYSTEM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (!DRIVE_PREFIX.test(path)) return false;
  const rooted = driveRelative(path).toLowerCase();
  return WINDOWS_SYSTEM_PATH_PREFIXES.some((prefix) => rooted.startsWith(prefix));
}

/**
 * The nearest ancestor of `path` — `path` itself included — that exists.
 *
 * Nothing here creates, opens or writes anything; a directory that cannot be
 * stat'd reads as missing, which only ever sends the climb one level further
 * up. The walk is bounded by the depth of the path and ends at the volume
 * root, which is its own parent.
 */
function nearestExistingAncestor(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Whether a token that resolved outside the worktree is plausibly a real
 * filesystem target — as opposed to a string that merely contains a slash.
 *
 * A shell command is full of slashes that are not paths. A `sed` address
 * (`sed -n '/# tests/p'`), a `sed` script (`'/duration_ms/p'`), an `awk`
 * pattern (`'/tests [0-9]/{print}'`) and a `grep` alternation all arrive here
 * as tokens beginning with `/`, and resolving one gives an absolute path that
 * is, of course, outside the worktree. In a live `@qa-functional` run that
 * cost the role five of its fifty turns on refusals it could do nothing
 * about, on commands that never touched anything. **A false refusal is not a
 * safe failure here**: it burns the budget the step is judged on, and it
 * teaches the model that the wall is arbitrary.
 *
 * So a token is only treated as a target when one of these holds:
 *
 * 1. it is **rooted** (`/…`, `~/…`) or it escapes the worktree with `..`,
 *    *and* the path it resolves to has a real anchor on this filesystem: the
 *    nearest existing ancestor is something other than the volume root. A
 *    role's checkout, `/tmp/dang.txt`, `~/repo/dist` — each of those has a
 *    real directory above it. `/tests`, `/#` and `/duration_ms/p` have
 *    nothing above them but `/`, which is where every string beginning with
 *    a slash lands;
 * 2. it is not a bare `..`. `find . -name x -o -name y` and `ls ..` put `..`
 *    in a command as an argument far more often than as an escape, and a
 *    traversal that means it says so with a component after it — `../notes.md`
 *    still resolves, still has a real anchor, and is still refused.
 *
 * A token that is neither rooted nor escaping is relative to the worktree and
 * is inside it by construction (`"test/persistence.test.js"`), so it is never
 * refused as "outside" — including when a symlink in the worktree would carry
 * a *read* through it, which is the confinement's own posture for reads
 * ({@link CONFINEMENT_PASSTHROUGH_TOOLS}: what matters is where the bytes
 * land).
 *
 * **Stated honestly, this is existence-sniffing, and it can be wrong both
 * ways.** A path whose whole branch does not exist yet on a machine where it
 * would (`/Users/...` on Linux) reads as a non-target, and a pattern that
 * happens to name a real top-level directory (`sed -n '/tmp/p'`) reads as
 * one. It is therefore applied to *reads only*: {@link writeTargetIndices}
 * targets and `cd`/`pushd` destinations are filesystem targets by
 * construction and are refused without ever asking this question, so nothing
 * that lands bytes outside the worktree can be talked out of a refusal by a
 * missing directory.
 *
 * @param candidate - The token as the role wrote it, unquoted.
 * @param path - That token resolved against the worktree.
 * @param root - The worktree, already resolved.
 */
function isPlausibleTarget(candidate: string, path: string, root: string): boolean {
  if (candidate === "..") return false;
  if (!isAbsolute(expandHome(candidate)) && within(path, root)) return false;
  const existing = nearestExistingAncestor(path);
  return existing === path || existing !== dirname(existing);
}

/**
 * The org memory store, as a rule specifier.
 *
 * The store is `<arcturn home>/org-memory/<project hash>.json`, and the
 * arcturn home is `$ARCTURN_HOME` or `~/.arcturn` — a path this module is
 * never handed. What it can name is the *shape*, and the shape is enough: a
 * confined child has no business naming an `org-memory/` directory at all,
 * wherever the operator keeps theirs.
 *
 * A directory literally called `org-memory` inside somebody's repository is
 * refused along with it, for the pass-through tools this covers. That is the
 * deliberate direction. The alternative is a rule that only works when it is
 * handed the operator's home, and a wall that depends on a parameter is a
 * wall that is missing everywhere the parameter is — which is exactly how the
 * org memory store came to be one `bash` call from every exec-lane role.
 */
const ORG_MEMORY_STORE_SPECIFIER = "**/org-memory/**";

/**
 * What a confined role is told when it names the org memory store.
 *
 * Not the worktree message: this is not "you are in the wrong directory", it
 * is "this file is not yours". Org memory is standing instructions injected
 * into *later* runs of a role, so a step that could write it could write its
 * own next prompt — and the answer to that is not a better shell wall, it is
 * that a person types `/org memory approve`. The refusal says where the
 * proposal actually goes, because a role that has something worth
 * remembering still needs somewhere to put it.
 */
function orgMemoryConfinementMessage(): string {
  return (
    "Refused: the org memory store is not something a workflow step may read or write. " +
    "Org memory is the operator's: an entry becomes active only when a person runs " +
    "`/org memory approve`, and a lesson you believe the org should keep belongs in your " +
    "report as a `/org memory propose <role> <one line>` line for them to approve."
  );
}

/**
 * What a role is told when the confinement refuses it.
 *
 * A deny the model cannot see the shape of is a deny it walks into again on
 * the next turn — and a worktree role has `maxTurns` of those to spend. So the
 * message is not "denied": it is where the agent actually is, what to do
 * instead, and why the alternative it just tried is worthless (a change made
 * outside the worktree is in nobody's diff, so no reviewer will ever see it
 * and the patch gate will never apply it).
 *
 * @param worktreeDir - The role's own checkout.
 * @param what - The thing that was refused, quoted back at the role.
 */
export function worktreeConfinementMessage(worktreeDir: string, what: string): string {
  return (
    `Refused: ${what} is outside your worktree. You are running in an isolated git worktree ` +
    `at ${worktreeDir}, and everything this step does must happen inside it — use paths ` +
    `relative to it ("src/app.ts", "./test"), never an absolute path into the user's checkout ` +
    "and never `cd` out of here. The user's checkout is off limits and is not yours to change: " +
    "this worktree's diff is the only thing that is captured, reviewed and applied, so a file " +
    "you write anywhere else is unreviewed, unapplied and counts as work not done."
  );
}

/**
 * The complete rule set a worktree-lane child runs with: RFC 0001 §8.1's
 * Layer 2, applied to the lane's own checkout.
 *
 * ## Deny by default
 *
 * The base of the set is one rule — `{ tool: "*", specifier: "*", deny }` —
 * and it is the whole posture: **a worktree child may do nothing, anywhere,
 * until something here says otherwise.** The set it replaced named three
 * tools (`write`, `edit`, `multiedit`), which meant a role holding an MCP or
 * extension write tool matched no rule at all and `yolo` allowed it to write
 * wherever it liked — the exact escape the confinement exists to close, on
 * the exact tools a team is most likely to add to a role. Naming the tools
 * that may write cannot work, because the point of an extension is that its
 * name is not known here.
 *
 * That base and two of the grants on top of it are the confinement's *floor*,
 * carried at {@link CONFINEMENT_FLOOR_SCOPE} so that anything the child
 * inherited outranks them by scope alone; the wall proper — the pair per
 * mutating tool — is `session`-scoped, the nearest scope there is. Within a
 * scope `matchRules` ranks by specificity, then by a deny bias, which is what
 * makes each of these win where it should:
 *
 * - `{ tool: "*", specifier: "*", deny }` (scores 0) — the base.
 * - `{ tool: "*", specifier: "<worktree>/**", ask }` (1) — *any* tool acting
 *   on a path inside the worktree is resolved the way the session would have
 *   resolved it. `ask` is not a prompt: it is "no opinion", the same
 *   fall-through a tool with no matching rule gets, so a `yolo` session still
 *   allows and a `default` session still asks.
 * - one `{ tool, specifier: "*", ask }` per {@link CONFINEMENT_PASSTHROUGH_TOOLS}
 *   (2) — the tools whose subject no path rule can decide, handed back whole.
 * - one `{ tool, specifier: ORG_MEMORY_STORE_SPECIFIER, deny }` per
 *   pass-through tool (3), `session`-scoped — the one subject a pass-through
 *   tool may still not name. Handing `bash` back whole meant handing back
 *   `cp payload $HOME/.arcturn/org-memory/<hash>.json`, and at floor scope
 *   `ask` is "no opinion", which in the `yolo` a pipeline runs in is an
 *   allow. `guardWorktreeBash` is the only other thing in its way and it is
 *   a heuristic over a string, so the store — whose contents become standing
 *   instructions in *later* runs — was one ordinary shell shape from every
 *   exec-lane role. A rule cannot decide where a command writes, but it can
 *   decide that a confined step never names this file, and that decision
 *   lands at step 3, above every mode.
 * - `{ tool, specifier: "<worktree>/**", allow }` per mutating tool (3),
 *   `session`-scoped — a real allow, because a role that must ask permission
 *   to write in its own throwaway checkout cannot run in a non-interactive
 *   pipeline at all.
 * - `{ tool, specifier: "*", deny }` per mutating tool (2), `session`-scoped,
 *   carrying {@link worktreeConfinementMessage} — the same deny the base rule
 *   already makes, at a scope and specificity that beat any inherited grant,
 *   and with the text that tells the role what to do instead.
 *
 * The deny lands at **step 3** of the engine's resolution order, above every
 * mode — which is the point: the owner runs pipelines in `yolo`, and `yolo`
 * only allows at step 5. A rule-level deny is the one decision no mode
 * negotiates with (see `permissions.ts`), which is why confinement is
 * expressed as rules and not as a mode, a prompt or a paragraph of prose.
 *
 * **The tradeoff, stated plainly.** Inverting the default means a tool this
 * file has never heard of is refused unless the engine can *see* that it is
 * working inside the worktree — and it sees that through `defaultSubject`,
 * which reads a handful of well-known argument names (`path`, `file_path`,
 * `url`, `command`, …). An MCP tool that names its argument `destination`
 * presents an empty subject, matches only the base deny, and is refused even
 * when it would have written inside the worktree. That is the safe direction
 * and it is deliberate: the alternative is the status quo, where the same
 * tool writes into the user's checkout and nobody finds out until the diff
 * comes back empty. A role that needs such a tool gets it by teaching
 * `defaultSubject` the argument name, not by widening this.
 *
 * Subjects arrive already absolute: `defaultSubject` resolves a path argument
 * against the agent's `cwd`, and a worktree-lane agent's `cwd` *is* the
 * worktree, so `write { path: "a.ts" }` presents `<worktree>/a.ts` and
 * `write { path: "/Users/me/repo/a.ts" }` presents itself.
 *
 * ## What happens to the rules the child inherited
 *
 * A session agent is seeded with the runtime's *live* rules — the config plus
 * every "always allow" the user has clicked this session — and every one of
 * them was written about the **real checkout**, which is the one place this
 * child may not touch. So they are rebuilt rather than appended to:
 *
 * - **Permissive rules that name somewhere other than the worktree are
 *   dropped.** They are the escape itself: a session-scoped
 *   `allow write /Users/me/repo/server.js` scores 4 and would beat the
 *   confinement's deny (2) outright, and a session-scoped `allow * *` would
 *   beat the floor by scope. A rule naming the worktree is kept — it grants
 *   nothing the confinement's own allow does not — and so is a rule for a
 *   {@link CONFINEMENT_PASSTHROUGH_TOOLS} tool, whose subject this set does
 *   not rule on: that is what keeps a project's `allow bash "npm *"` working
 *   for a worktree role, exactly as it worked for the session.
 * - **Denies are never dropped, and never weakened.** Narrowing may only ever
 *   narrow — so each one is re-scoped to `session` (a deny promoted to a
 *   nearer scope can only deny more, and puts it above every rule the
 *   confinement adds at its floor), a `tool: "*"` deny is *also* mirrored per
 *   mutating tool so the mirror's specificity can match the confinement's own
 *   `session`-scoped allow, and a mutating tool some inherited deny already
 *   blankets gets no allow at all. A user who denied `write **\/.env` still
 *   has it denied inside the worktree, where the diff that lands in their
 *   checkout is made.
 *
 * Known limitation: a worktree path containing `*` or `?` would widen the
 * allow glob, since `globToRegExp` has no escape syntax. Run directories are
 * built from `~/.arcturn/workflow-runs` plus a sanitized slug, so this needs a
 * home directory with a glob character in it to bite.
 *
 * @param worktreeDir - The role's own checkout, already absolute.
 * @param inherited - The rules the child was built with, in their own order.
 * @returns The rules to run the child with, replacing whatever it had.
 */
export function worktreeConfinementRules(
  worktreeDir: string,
  inherited: readonly PermissionRule[] = [],
): ExplainedPermissionRule[] {
  const root = resolve(worktreeDir);
  const rules: ExplainedPermissionRule[] = [];
  /** Mutating tools an inherited deny already blankets, which get no allow. */
  const blanketed = new Set<string>();
  for (const rule of inherited) {
    if (rule.action !== "deny") {
      if (!escapesConfinement(rule, root)) rules.push(rule);
      continue;
    }
    rules.push({ ...rule, scope: "session" });
    const covered =
      rule.tool === "*" ? [...WRITE_TOOLS] : WRITE_TOOLS.has(rule.tool) ? [rule.tool] : [];
    if (rule.specifier === undefined || rule.specifier === "*") {
      for (const tool of covered) blanketed.add(tool);
      continue;
    }
    // `{ tool: "*" }` caps specificity at 2, below the confinement's allow;
    // the per-tool mirror is the same deny at a specificity that can win.
    if (rule.tool === "*") {
      for (const tool of covered) rules.push({ ...rule, tool, scope: "session" });
    }
  }
  const message = worktreeConfinementMessage(root, "that path");
  const inside = join(root, "**");
  const floor = CONFINEMENT_FLOOR_SCOPE;
  rules.push({ tool: "*", specifier: "*", action: "deny", scope: floor, message });
  rules.push({ tool: "*", specifier: inside, action: "ask", scope: floor });
  const storeMessage = orgMemoryConfinementMessage();
  for (const tool of CONFINEMENT_PASSTHROUGH_TOOLS) {
    rules.push({ tool, specifier: "*", action: "ask", scope: floor });
    // …and the one path a pass-through tool may still not name. `session` +
    // a glob scores 3, so it beats both the floor above (scope) and an
    // inherited `allow bash *` (specificity), and ties with an inherited
    // `allow bash "npm *"` — which the deny bias then settles the safe way.
    rules.push({
      tool,
      specifier: ORG_MEMORY_STORE_SPECIFIER,
      action: "deny",
      scope: "session",
      message: storeMessage,
    });
  }
  for (const tool of WRITE_TOOLS) {
    if (!blanketed.has(tool)) {
      rules.push({ tool, specifier: inside, action: "allow", scope: "session" });
    }
    rules.push({ tool, specifier: "*", action: "deny", scope: "session", message });
  }
  return rules;
}

/**
 * Whether a permissive inherited rule is one a confined child may not keep.
 *
 * @param rule - An inherited rule, already known not to be a deny.
 * @param root - The worktree root.
 */
function escapesConfinement(rule: PermissionRule, root: string): boolean {
  const specifier = rule.specifier;
  // Names the worktree: grants nothing the confinement's own allow does not.
  if (specifier !== undefined && (specifier === root || specifier.startsWith(`${root}${sep}`))) {
    return false;
  }
  // A tool the confinement hands back to the session keeps what the session
  // gave it: no rule here decides that tool, so none of its grants can escape.
  if (rule.tool !== "*" && CONFINEMENT_PASSTHROUGH_TOOLS.has(rule.tool)) return false;
  // Everything left names something other than the worktree, for a tool this
  // set does rule on: a blanket `allow write *` (the escape hatch itself), a
  // path in the user's checkout, a glob that spans both. Whatever the tool
  // is, and `tool: "*"` included, that is the grant the confinement exists to
  // take away — and taking it away is safe, because the child keeps every
  // deny and the confinement's floor grants what a role legitimately needs.
  return true;
}

/**
 * Confine a worktree-lane child to its own checkout, in its permission engine.
 *
 * Called on every spawn, before the role sees a single tool. RFC 0001 §7.1's
 * "a role writes in its own checkout" used to be true only of the agent's
 * `cwd` default, which a model leaves behind the moment it writes an absolute
 * path — and the live run that produced this code did exactly that: it wrote
 * into the user's real repository, its worktree stayed empty, the captured
 * diff was empty, the reviewers reviewed nothing and the patch gate never ran.
 *
 * A child with no permission engine (a lane double) is left alone: there is
 * nothing to seed, and the production lane always has one.
 *
 * @param agent - The freshly built child.
 * @param worktreeDir - The checkout it is rooted at.
 */
function confineToWorktree(agent: WriteLaneSessionAgent, worktreeDir: string): void {
  const permissions = agent.permissions;
  if (permissions === undefined) return;
  const confined = worktreeConfinementRules(worktreeDir, permissions.rules);
  permissions.clearRules();
  for (const rule of confined) permissions.addRule(rule);
}

/** Strip surrounding quotes and leading redirection from one shell token. */
function bareToken(token: string): string {
  const redirected = token.replace(/^\d*[<>]{1,2}&?/, "");
  const unquoted = redirected.replace(/^['"]|['"]$/g, "");
  return unquoted;
}

/**
 * The path-shaped things one shell token could name.
 *
 * The token itself, plus the right-hand side of a `--flag=value`, which is how
 * `git --git-dir=/elsewhere/.git` and `npm --prefix=/elsewhere` smuggle a path
 * past a naive whitespace split.
 *
 * @param token - One whitespace-separated token, already unquoted.
 */
function pathCandidates(token: string): string[] {
  const candidates = [token];
  const equals = token.indexOf("=");
  if (equals > 0 && equals < token.length - 1) candidates.push(bareToken(token.slice(equals + 1)));
  return candidates.filter((candidate) => candidate.length > 0);
}

/**
 * Which tokens of one command segment name something it WRITES.
 *
 * The {@link SYSTEM_PATH_PREFIXES} exemption is there so a role can run the
 * toolchain and read from it; it was never a licence to write outside the
 * worktree, and a repository cloned under `/tmp` or `/opt` is as much
 * somebody's work as one in their home. This is what tells reading from a
 * toolchain root apart from writing into it, in the three shapes a command
 * actually writes in:
 *
 * - a redirection — `> out`, `>>out`, `2>out`, `&>out`;
 * - an argument of a command that changes what it is given ({@link
 *   WRITE_COMMANDS}), or the destination of one that copies ({@link
 *   COPY_COMMANDS});
 * - the value of a flag that relocates where the command works ({@link
 *   RELOCATING_FLAGS}), in both `--prefix /elsewhere` and `-C=/elsewhere`.
 *
 * **Still a heuristic, like the rest of this wall.** It reads the command
 * word, so `$SHELL -c …`, a wrapper script, `xargs cp`, `find -exec` or a
 * path built at runtime all walk past it, and a command it does not know (a
 * project's own script, an MCP CLI) is read as a reader. It refuses the
 * shapes an honest agent reaches for; the containment for a hostile one is
 * `config.sandbox` and the OS.
 *
 * @param raw - The segment's tokens, exactly as whitespace split them.
 * @param tokens - The same tokens, unquoted and de-redirected.
 * @returns Indices into `tokens` that name a write destination.
 */
function writeTargetIndices(raw: readonly string[], tokens: readonly string[]): Set<number> {
  const targets = new Set<number>();
  let head = 0;
  while (head < tokens.length && ENV_ASSIGNMENT.test(tokens[head] ?? "")) head++;
  // `/bin/cp` writes exactly as `cp` does.
  const command = basename(tokens[head] ?? "");
  /** Non-flag arguments, for the commands whose destination is positional. */
  const args: number[] = [];
  let expectValue = false;
  for (let index = head + 1; index < raw.length; index++) {
    const token = raw[index] ?? "";
    if (expectValue) {
      targets.add(index);
      expectValue = false;
      continue;
    }
    const redirect = WRITE_REDIRECT.exec(token);
    if (redirect !== null) {
      // `> out` carries its target in the NEXT token; `>out` carries its own.
      if (redirect[0].length === token.length) expectValue = true;
      else targets.add(index);
      continue;
    }
    if (token.startsWith("-")) {
      const equals = token.indexOf("=");
      const flag = equals > 0 ? token.slice(0, equals) : token;
      if (RELOCATING_FLAGS.has(flag)) {
        if (equals > 0) targets.add(index);
        else expectValue = true;
      }
      continue;
    }
    if ((tokens[index] ?? "") !== "") args.push(index);
  }
  if (WRITE_COMMANDS.has(command)) {
    for (const index of args) targets.add(index);
  } else if (COPY_COMMANDS.has(command) && args.length > 1) {
    // `cp a b` reads a and writes b; a lone argument is a malformed command,
    // not a destination.
    targets.add(args[args.length - 1] as number);
  }
  return targets;
}

/**
 * The word standing immediately before position `at`.
 *
 * @param command - The command being scanned.
 * @param at - Index of the opening quote.
 */
function precedingWord(command: string, at: number): string {
  let end = at;
  while (end > 0 && /\s/.test(command[end - 1] ?? "")) end--;
  let start = end;
  while (start > 0 && !/\s/.test(command[start - 1] ?? "")) start--;
  return command.slice(start, end);
}

/**
 * Whether a quoted region is DATA the command carries rather than a path it
 * acts on.
 *
 * Three questions, in this order:
 *
 * 1. does a shell run this string? (`sh -c "…"`, `eval "…"`, and `cd "…"`,
 *    whose argument is a directory whatever it looks like) — then it is code,
 *    and every path in it is a path the command really uses;
 * 2. is it a single word? — then it is one quoted argument, most often a
 *    path someone quoted out of habit;
 * 3. does it start at the root (`/…`, `~/…`)? — then it is a path with
 *    spaces in it.
 *
 * Everything else is prose: a commit message, an `echo`, a note. The point of
 * asking at all is that refusing `echo "the fix belongs in /Users/me/repo"`
 * hands the role a wall it cannot see the shape of, on a command that was
 * never an escape — and the fix for a false positive is a narrower scan, not
 * a wider exemption.
 *
 * @param content - What the quotes contain.
 * @param lead - The word immediately before the opening quote.
 */
function isQuotedData(content: string, lead: string): boolean {
  if (CODE_QUOTE_LEADS.has(lead)) return false;
  const trimmed = content.trim();
  if (trimmed === "") return true;
  if (!/\s/.test(trimmed)) return false;
  return !(trimmed.startsWith("/") || trimmed.startsWith("~"));
}

/**
 * Blank out the parts of a command that are data, so the wall never reads
 * them as paths.
 *
 * Two regions, both replaced by spaces of the same length so every other
 * offset in the command survives:
 *
 * - **heredoc bodies** — `cat > notes.md <<'EOF' … EOF` writes a file whose
 *   *contents* routinely quote a path in the user's checkout;
 * - **quoted strings that are prose** ({@link isQuotedData}).
 *
 * What this deliberately does not do is trust quoting: `bash -c "cd /repo"`
 * and `cp dist/app.js "/repo/app.js"` keep every character, because a quote
 * is how a path is written as often as it is how a sentence is.
 *
 * @param command - The command as the role wrote it.
 * @returns The same string with its data regions blanked.
 */
function maskCommandData(command: string): string {
  const out = command.split("");
  const blank = (from: number, to: number): void => {
    for (let index = Math.max(from, 0); index < Math.min(to, out.length); index++) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  for (let match = heredoc.exec(command); match !== null; match = heredoc.exec(command)) {
    const body = command.indexOf("\n", match.index + match[0].length);
    if (body === -1) continue;
    // The word is `\w+` by construction, so it cannot smuggle a pattern in.
    const terminator = new RegExp(`^[ \\t]*${match[2] ?? ""}[ \\t]*$`, "m").exec(
      command.slice(body + 1),
    );
    blank(body + 1, terminator === null ? command.length : body + 1 + terminator.index);
  }
  const masked = out.join("");
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char !== "'" && char !== '"') {
      index++;
      continue;
    }
    const close = masked.indexOf(char, index + 1);
    // An unbalanced quote is a command this cannot read; scan it as written.
    if (close === -1) break;
    if (isQuotedData(masked.slice(index + 1, close), precedingWord(masked, index))) {
      blank(index, close + 1);
    }
    index = close + 1;
  }
  return out.join("");
}

/**
 * What a role is told when a destination's value is invisible to the wall.
 *
 * `> $OUT/report.json` is not a path this can place: the value belongs to a
 * shell that has not run yet. Reading it as *inside* is what let
 * `H=$HOME; echo … > $H/.arcturn/org-memory/<hash>.json` through, so an
 * unresolvable destination is refused — the one direction that cannot be
 * wrong about where the bytes land.
 *
 * Reads are deliberately left alone: `cat "$FILE"` is an ordinary command and
 * a refusal there costs the step a turn to no purpose. That asymmetry is the
 * same one the rest of this wall already draws — a write target is a target
 * whatever it looks like, a read has to look like a path first.
 *
 * @param worktreeDir - The role's own checkout.
 * @param token - The token as the role wrote it.
 */
function unresolvedDestinationMessage(worktreeDir: string, token: string): string {
  return (
    `Refused: \`${token}\` names a destination this step cannot resolve — a shell variable's ` +
    `value is not known until the command runs, so it cannot be shown to land inside your ` +
    `worktree at ${worktreeDir}, and this step may only write there. Spell the path out ` +
    'relative to the worktree ("dist/report.json") and run it again.'
  );
}

/**
 * Whether a command hands an inline script to a runtime that can open files.
 *
 * @param command - The command as the role wrote it, unmasked.
 */
function hasInlineScript(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const tokens = segment
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map(bareToken);
    let head = 0;
    while (head < tokens.length && ENV_ASSIGNMENT.test(tokens[head] ?? "")) head++;
    if (!INLINE_SCRIPT_COMMANDS.has(basename(tokens[head] ?? ""))) continue;
    if (tokens.slice(head + 1).some((token) => INLINE_SCRIPT_FLAGS.has(token))) return true;
  }
  return false;
}

/**
 * Refuse an inline script that names a rooted path outside the worktree.
 *
 * `node -e "require('fs').writeFileSync('/Users/me/.arcturn/…', '{}')"` is a
 * write, and every other check in this file misses it twice over: the quoted
 * region is masked as prose ({@link isQuotedData} — it has spaces in it and
 * does not begin with a slash), and even unmasked the path is *inside* a
 * token rather than being one, so no amount of splitting on whitespace finds
 * it. So the script is read for what it is: string literals.
 *
 * **Every rooted literal in an inline script is treated as a destination**,
 * `/usr`, `/tmp` and the rest included, because inside a program this wall
 * cannot tell a read from a write and guessing "read" is how the shape got
 * here. The cost is stated rather than hidden: a one-liner that only *reads*
 * an absolute path is refused too, and the role's way past it is `cat`.
 *
 * Bounded to real interpreters ({@link INLINE_SCRIPT_COMMANDS}) with an
 * eval flag, so an ordinary `node --test "test/x.test.js"` never reaches it.
 * `sh -c '…'` is not here and does not need to be: a shell's script is
 * already scanned as a command, by the token walk, with the shell's own
 * read/write distinction intact.
 *
 * @param command - The command as the role wrote it, unmasked.
 * @param root - The worktree, already resolved.
 * @param realRoot - `root` with its symlinks resolved.
 * @param variables - The variables the token walk learned.
 */
function inlineScriptRefusal(
  command: string,
  root: string,
  realRoot: string,
  variables: ReadonlyMap<string, string>,
): string | undefined {
  if (!hasInlineScript(command)) return undefined;
  const literals = /(['"`])([^'"`\n]*)\1/g;
  for (let match = literals.exec(command); match !== null; match = literals.exec(command)) {
    const literal = match[2] ?? "";
    const expanded = expandHome(expandVariables(literal, variables));
    if (!isAbsolute(expanded)) continue;
    const path = resolve(expanded);
    if (isUnder(path, root, realRoot) || isDevicePath(path)) continue;
    return worktreeConfinementMessage(root, `\`${literal}\`, named inside an inline script,`);
  }
  return undefined;
}

/**
 * Refuse a worktree-lane `bash` command that reaches outside the worktree.
 *
 * **This is a heuristic wall, not a sandbox, and it cannot be completed.**
 * It stops an honest agent from wandering — the `cd /Users/me/repo && npm
 * test` and the absolute-path redirect that made the captured diff empty in
 * the run this was written for. It will not stop a hostile one. A path
 * assembled at runtime (`p=org-mem; p="${p}ory"; cp x $HOME/.arcturn/$p/…`),
 * a `printf`-built name, a script file, an `xargs`, a `find -exec`, or a
 * quoting trick nobody here thought of all walk straight through it, and no
 * amount of further pattern-matching changes that: a shell command is a
 * string, and deciding what a string will do is the halting problem with
 * extra steps. Every check below is defence in depth, added because a cheap
 * wall that catches the ordinary shapes is worth having — not because the
 * next one will make the set complete.
 *
 * **Do not read `config.sandbox` as the containment underneath it**, which
 * is what the comment this replaces said. The default is `"off"`
 * (`config.ts`), and `"workspace-write"` leaves `$HOME/.arcturn` *writable*
 * by design (`packages/tools/src/sandbox.ts`) — which is where the org memory
 * store lives. For that one target the containment is the permission rule
 * ({@link ORG_MEMORY_STORE_SPECIFIER}), which is a decision about a name and
 * so is not a guess; for everything else outside the worktree on a default
 * install, this heuristic and the `write`-tool rules above are what there is.
 * That is the honest statement of the guarantee, and the docs say the same.
 *
 * Four checks. The first three run over each segment of a chained command
 * ({@link @arcturn/core#shellSegments}, which over-splits rather than
 * under-splits and so cannot widen anything), after
 * {@link maskCommandData} has removed the parts of the command that are data
 * rather than paths; the fourth runs over the command as the role wrote it,
 * because the thing it is looking for is inside the part that was masked:
 *
 * 1. `cd` / `pushd` anywhere but inside the worktree — refused outright, even
 *    to `/tmp`: a step whose commands run somewhere else is a step whose diff
 *    is not the work.
 * 2. Any token that resolves outside the worktree — absolute, `~`-rooted or
 *    `../`-escaping — unless it is toolchain territory
 *    ({@link SYSTEM_PATH_PREFIXES}) *and the command is not writing to it*
 *    ({@link writeTargetIndices}). Tokens that are not paths at all resolve
 *    harmlessly *inside* the worktree (`npm` → `<worktree>/npm`) and are
 *    ignored by the same test, so no allow-list of command names is needed —
 *    but a token that is not a path and does *not* resolve inside (a `sed`
 *    address, an `awk` pattern, a bare `..`) has to be told apart from a real
 *    one, which is {@link isPlausibleTarget} and is asked of reads only.
 * 3. A write destination whose value the wall cannot see — a variable it
 *    could not expand ({@link expandVariables}) — refused rather than assumed
 *    to be inside ({@link unresolvedDestinationMessage}).
 * 4. A rooted path literal inside an inline interpreter script
 *    ({@link inlineScriptRefusal}), which the token walk structurally cannot
 *    see: the path is a substring of a token, not a token.
 *
 * @param command - The command the role wants to run.
 * @param worktreeDir - The checkout it is confined to.
 * @returns The refusal to hand back, or `undefined` when the command is
 *   confined as far as this can tell.
 */
export function worktreeBashRefusal(command: string, worktreeDir: string): string | undefined {
  const root = resolve(worktreeDir);
  // Resolved once for the whole command: every token below is asked about the
  // same worktree, and the refusal quotes the root the role was told about
  // rather than whatever the filesystem spells it.
  const realRoot = physicalPath(root);
  // Carried across segments, in command order: `H=$HOME` is a statement about
  // every segment after it, which is the whole point of writing it.
  const variables = baseShellVariables(root);
  for (const segment of shellSegments(maskCommandData(command))) {
    // Raw and bare tokens are kept index-aligned: the redirection and the
    // quoting a token arrived with are what say whether it is a target.
    const raw = segment.split(/\s+/).filter((token) => token.length > 0);
    const tokens = raw.map(bareToken);
    // Leading `NAME=value` — both the shell assignment and the per-command
    // env prefix. Recorded before this segment's own tokens are read, since
    // `FOO=$HOME cp x $FOO/y` means it for this command too.
    for (const token of tokens) {
      if (!ENV_ASSIGNMENT.test(token)) break;
      const equals = token.indexOf("=");
      const value = expandVariables(bareToken(token.slice(equals + 1)), variables);
      variables.set(token.slice(0, equals), value);
    }
    const head = tokens[0];
    if (head !== undefined && DIRECTORY_BUILTINS.has(head)) {
      // `cd` with no argument is `cd ~`, which is outside by construction.
      const target = tokens.slice(1).find((token) => token !== "" && !token.startsWith("-"));
      const expanded = expandVariables(target ?? homedir(), variables);
      // A `cd` is a destination by construction, so an unresolvable one is
      // refused for the same reason a write target is.
      if (target !== undefined && UNRESOLVED_VARIABLE.test(expanded)) {
        return unresolvedDestinationMessage(root, target);
      }
      const destination = resolve(root, expandHome(expanded));
      if (!isUnder(destination, root, realRoot)) {
        return worktreeConfinementMessage(root, `\`${head} ${target ?? "~"}\``);
      }
    }
    const targets = writeTargetIndices(raw, tokens);
    for (const [index, token] of tokens.entries()) {
      if (token === "") continue;
      const writing = targets.has(index);
      for (const written of pathCandidates(token)) {
        const candidate = expandVariables(written, variables);
        if (writing && UNRESOLVED_VARIABLE.test(candidate)) {
          return unresolvedDestinationMessage(root, written);
        }
        const path = resolve(root, expandHome(candidate));
        if (isUnder(path, root, realRoot)) continue;
        // A device is nobody's work, wherever it sorts: `2>/dev/null` is a
        // discard, and on Windows it resolves to `C:\dev\null`, which is not
        // under any toolchain root — so asking that question first is what
        // keeps the commonest redirect there is from being refused on one
        // platform out of three.
        if (isDevicePath(path)) continue;
        // Reading from or running the toolchain is fine; writing into it is
        // how a checkout under /tmp gets edited by a role that owes its work
        // to a diff nobody will ever see.
        if (isSystemPath(path) && !writing) continue;
        // A write target is a target whatever it looks like; a read has to
        // look like a path before it is worth a refusal.
        if (!writing && !isPlausibleTarget(candidate, path, root)) continue;
        // Quoted back as the role WROTE it: `$HOME/x` is what it has to fix,
        // and being shown the expansion it never typed reads as a non sequitur.
        return worktreeConfinementMessage(
          root,
          writing ? `writing to \`${written}\`` : `the path \`${written}\``,
        );
      }
    }
  }
  // Last, and over the unmasked command: by here `variables` knows everything
  // the command said about itself.
  return inlineScriptRefusal(command, root, realRoot, variables);
}

/**
 * Wrap `bash` so a worktree-lane role cannot shell its way out of its checkout.
 *
 * The write tools are stopped by the permission engine, which sees a path and
 * can rule on it. `bash`'s subject is a *command*, so no rule can express this
 * — hence a wrapper, which refuses before the real tool runs and returns the
 * refusal as an ordinary error result, exactly as the tool would report any
 * other bad invocation. Every other tool is handed back untouched.
 *
 * @param tool - The tool as the runtime built it.
 * @param worktreeDir - The checkout the role is confined to.
 */
function guardWorktreeBash(tool: WriteLaneTool, worktreeDir: string): WriteLaneTool {
  const execute = tool.execute;
  if (!EXEC_TOOLS.has(tool.definition.name) || execute === undefined) return tool;
  return {
    ...tool,
    async execute(
      input: Record<string, unknown>,
      ctx: never,
    ): Promise<{ content?: unknown; isError?: boolean; details?: unknown }> {
      const command = typeof input.command === "string" ? input.command : "";
      const refusal = worktreeBashRefusal(command, worktreeDir);
      if (refusal === undefined) return await execute.call(tool, input, ctx);
      return {
        content: [{ type: "text", text: refusal }],
        isError: true,
        details: { worktreeConfinement: resolve(worktreeDir) },
      };
    },
  };
}

/**
 * Tool arguments that name a filesystem path.
 *
 * Deliberately the same keys `defaultSubject` treats as paths, because these
 * are exactly the arguments that become the **subject** the confinement's
 * rules are matched against: {@link guardWorktreePaths} is the physical half
 * of that one decision, and an argument the rules never look at is not one it
 * should be second-guessing.
 */
const PATH_ARGUMENT_KEYS: readonly string[] = ["file_path", "filePath", "path", "target"];

/** Built-in tools that only read. A role may read the world; it writes at home. */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(DEFAULT_READ_ONLY_TOOLS);

/**
 * Wrap one tool so a path that is *physically* outside the worktree is
 * refused, however innocent it looks as a string.
 *
 * The permission rules are a wall of **names**: they match a subject against
 * `<worktree>/**`, and a glob cannot call `realpath`. A symlink is a second
 * name for someone else's directory, so `write { path: "vendor/app.ts" }`
 * where `vendor` links at the user's checkout presents a subject squarely
 * inside the worktree and lands its bytes squarely outside — and `git
 * worktree add` reproduces every symlink a repository has checked in, so this
 * is not an exotic setup to arrange. This wrapper closes that gap the only
 * way it can be closed: one {@link isUnder} on the path the tool is about to
 * use, resolved through the filesystem rather than through `relative()`.
 *
 * It is a second wall, not a replacement: the rules still decide first — and
 * a rule-level deny lands before the checkpoint layer can copy a pre-image of
 * a file that was never the role's to touch, which a refusal at execute time
 * could not — so what is left for this to catch is the path the rules read as
 * inside and the filesystem does not.
 *
 * Read-only built-ins are handed back untouched — a confined role may still
 * read the checkout it is working from — and so is any tool naming no path at
 * all, `bash` included: its subject is a command, which is
 * {@link guardWorktreeBash}'s problem.
 *
 * @param tool - The tool as the runtime built it.
 * @param worktreeDir - The checkout the role is confined to.
 */
function guardWorktreePaths(tool: WriteLaneTool, worktreeDir: string): WriteLaneTool {
  const execute = tool.execute;
  if (execute === undefined || READ_ONLY_TOOL_NAMES.has(tool.definition.name)) return tool;
  const root = resolve(worktreeDir);
  return {
    ...tool,
    async execute(
      input: Record<string, unknown>,
      ctx: never,
    ): Promise<{ content?: unknown; isError?: boolean; details?: unknown }> {
      for (const key of PATH_ARGUMENT_KEYS) {
        const value = input[key];
        if (typeof value !== "string" || value.length === 0) continue;
        // Resolved exactly as the tool itself resolves it — against the
        // agent's `cwd`, which for a worktree-lane child is the worktree — so
        // the guard rules on the file the tool would really open.
        if (isUnder(resolve(root, value), root)) continue;
        return {
          content: [{ type: "text", text: worktreeConfinementMessage(root, `\`${value}\``) }],
          isError: true,
          details: { worktreeConfinement: root },
        };
      }
      return await execute.call(tool, input, ctx);
    },
  };
}

/**
 * Wrap one tool so a role's background tasks are attributable to it.
 *
 * Only `bash` is wrapped, and only to read the `taskId` it already reports in
 * its result details — the wrapper decides nothing, denies nothing and adds
 * no argument, so permission checks, hooks, checkpoints and the sandbox all
 * still run inside it, untouched. Spread first, exactly as `wrapToolsWithHooks`
 * does, so anything a tool carries beyond the `Tool` contract survives.
 *
 * Per-child tracking is used because the alternative — diffing the shared
 * manager's `list()` across the step — cannot tell this role's server from
 * the main session's, or from a sibling role's in the same parallel stage,
 * and would kill all three.
 *
 * @param tool - The tool as the runtime built it (already hook-wrapped).
 * @param started - Collects the ids this agent's `bash` hands back.
 */
function trackBackgroundTasks(tool: WriteLaneTool, started: Set<string>): WriteLaneTool {
  const execute = tool.execute;
  if (tool.definition.name !== "bash" || execute === undefined) return tool;
  return {
    ...tool,
    async execute(input: Record<string, unknown>, ctx: never): Promise<{ details?: unknown }> {
      const result = await execute.call(tool, input, ctx);
      const taskId = (result.details as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId === "string") started.add(taskId);
      return result;
    },
  };
}

/**
 * Kill the tasks a step started, and report how many were still alive.
 *
 * `kill` is sent to every id — a finished task's kill is a no-op — but only
 * the ones still running are counted, because a task that already exited is
 * not something the step had to reap. The set is drained so a second call
 * (the step reaps idempotently) neither double-counts nor re-signals a pid
 * the OS may since have handed to someone else.
 *
 * @param manager - The session's background-task manager.
 * @param started - The ids this step's agent started.
 */
function reapBackgroundTasks(manager: WorkflowBackgroundTasks, started: Set<string>): number {
  let killed = 0;
  for (const taskId of started) {
    if (manager.poll(taskId)?.running === true) killed += 1;
    manager.kill(taskId);
  }
  started.clear();
  return killed;
}

/**
 * Build the production {@link WriteLane} from primitives that already exist:
 * `createWorktree` (`scouts.ts`), `buildSessionAgent` + `setTools` (the
 * `createTeamSpawn` pattern) and `git` via `child_process`.
 *
 * Worktrees and patches for one `/workflow` invocation share a run directory
 * under `~/.arcturn/workflow-runs/`, and the parent is passed explicitly so
 * `remove()` deletes only the checkout — the patch beside it outlives the
 * worktree, which is the point of capturing it.
 *
 * **Seeding.** Every worktree is created from `HEAD` and then brought up to
 * the run's accumulated state: the checkout's own uncommitted *tracked* work
 * as of the run's *first* worktree, its untracked-but-not-`.gitignore`d files
 * as of that same moment, then this run's applied patches in order. That
 * state is committed inside the worktree, so the diff captured at the end is
 * exactly the role's own delta, and a role that commits its work keeps it.
 *
 * **Untracked files.** `git diff` cannot represent a file git was never told
 * about, so the tracked baseline above is blind to a developer's scratch
 * file, a fresh config, a fixture nobody `git add`ed — a role dispatched to
 * build on stage N saw the repository, not the desk it was sitting on, and
 * had no way to even discover the gap. `git ls-files --others
 * --exclude-standard` lists exactly the files a plain `git status` would call
 * untracked and a plain `git add -A` would stage — respecting every level of
 * `.gitignore`, `.git/info/exclude` and the global excludes file, so
 * `node_modules/`, build output and `.env` stay out precisely because the
 * checkout's own ignore rules already say so, with no second list to
 * maintain. Three choices make the seeding safe rather than merely
 * convenient:
 *
 * - **Copied to disk, not `git add`ed onto the real checkout.** A snapshot
 *   directory under this run's own `parentDir` holds a byte-for-byte copy of
 *   each file (plain files only — see below); nothing about the user's
 *   actual index or working tree is ever touched to produce it.
 * - **Captured once per run, like the tracked baseline, and for the same
 *   reason.** Recomputing the untracked listing from the *live* checkout on
 *   every stage would read a file a worktree-lane patch had already rewritten
 *   there (`git apply` touches the working tree, never the index, so an
 *   edited file that started untracked stays untracked) — and a later
 *   stage's own `seed.patches` replay is a diff *against the original
 *   content*, so it needs that original content on disk as context, not a
 *   future version of itself. One frozen snapshot, reused by every worktree
 *   this run creates, is what keeps `git apply` finding the context it
 *   expects.
 * - **Copied in before any patch is replayed, every time.** A role's own
 *   patch from an earlier stage can be an ordinary *modify* of a file that
 *   was already untracked when the run began; `git apply` refuses a modify
 *   hunk against a file that is not there yet. So the snapshot lands on disk
 *   first, `base` and `seed.patches` replay on top of it exactly as they
 *   already did against the tracked baseline, and only then is everything
 *   staged and committed together — which is also what keeps a role's own
 *   edit to a pre-existing untracked file a small diff against the seed
 *   commit, not a full-file "new file" diff that double-counts content that
 *   was already there.
 *
 * Only plain files are carried (`lstat`, not `stat` — a symlink is skipped
 * rather than followed): a symlink is a second name for wherever it points,
 * which is exactly the hazard {@link guardWorktreePaths} exists to close for
 * a role's own tool calls, and a snapshot step run before a single tool is
 * installed has no business reopening it. {@link UNTRACKED_SEED_FILE_CAP} and
 * {@link UNTRACKED_SEED_BYTES_CAP} bound the snapshot for the same reason
 * `DIFF_MAX_BUFFER` bounds a diff: this is a convenience for a handful of
 * stray files, not a promise to mirror an entire uncommitted tree a
 * `.gitignore` forgot to cover.
 *
 * @param host - The live runtime (taken structurally).
 * @param runId - Directory name for this run's worktrees and patches.
 */
export function createRuntimeWriteLane(host: WriteLaneHost, runId = createRunId()): WriteLane {
  const parentDir = join(host.paths.home, "workflow-runs", runId);
  const exec = async (
    cwd: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> =>
    await execFileAsync("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BUFFER,
      windowsHide: true,
    });

  /**
   * The run's frozen baseline, on disk beside its patches.
   *
   * Frozen **to disk**, not merely memoized, because a run outlives the
   * process that started it: `/workflow resume <runId>` builds a brand-new
   * lane over the same run directory. Re-reading the live checkout there was
   * a real defect — by the time a resume starts, this run's own earlier stages
   * have already applied their patches to that checkout, so a fresh baseline
   * carried stage 1's edit *and* `seed.patches` replayed stage 1's patch on top
   * of it. `git apply` refused, `createWorktree` threw, and every resume of a
   * pipeline whose earlier stage wrote anything failed at its next worktree
   * with "patch does not apply". The file's *existence* is the freeze, so a
   * run that began against a clean checkout is distinguishable from one nobody
   * has looked at yet.
   */
  const baselineFile = join(parentDir, "_run-baseline.patch");
  // Captured lazily, once per run: "what the user's checkout already looked
  // like before this run touched it".
  let baseline: Promise<string | undefined> | undefined;
  const baselinePatch = async (): Promise<string | undefined> => {
    baseline ??= (async () => {
      try {
        const frozen = await readFile(baselineFile, "utf8");
        return frozen.trim() === "" ? undefined : baselineFile;
      } catch {
        // Not frozen yet — this is the run's first worktree, in its first
        // process. Capture it below.
      }
      let diff = "";
      try {
        diff = (
          await exec(host.cwd, ["diff", "--binary", "--no-color", "HEAD", ...CAPTURE_PATHSPEC])
        ).stdout;
      } catch {
        // No HEAD yet, not a work tree, or a dirty tree too large to buffer.
        // The worktree then starts at HEAD instead of failing the run: for
        // the first two the `git worktree add` below reports the real problem,
        // and for the third the role's own patch still faces `git apply` on
        // the way back, which refuses rather than guessing. Seeding is a
        // convenience for the role; the apply is the guarantee.
        //
        // Deliberately NOT frozen: nothing was read, so a later process must
        // still be allowed to try.
        return undefined;
      }
      await mkdir(parentDir, { recursive: true });
      // Written even when empty — see {@link baselineFile}.
      await writeFile(baselineFile, diff, "utf8");
      return diff.trim() === "" ? undefined : baselineFile;
    })();
    return await baseline;
  };

  // Captured lazily, once per run, for the same reason as `baselinePatch`:
  // a snapshot of every untracked-but-not-ignored file the checkout held
  // before this run touched anything. See "Untracked files" above for why
  // this must be frozen once rather than re-read from the live checkout — and
  // {@link baselineFile} for why the freeze has to survive the process.
  const untrackedSeedDir = join(parentDir, "_run-untracked");
  let untracked: Promise<string | undefined> | undefined;
  const untrackedSnapshot = async (): Promise<string | undefined> => {
    untracked ??= (async () => {
      try {
        // Already frozen by an earlier process running this same run id; an
        // empty snapshot means "frozen, nothing to carry".
        const already = await readdir(untrackedSeedDir);
        return already.length === 0 ? undefined : untrackedSeedDir;
      } catch {
        // Not frozen yet — capture it below.
      }
      let listing = "";
      try {
        listing = (
          await exec(host.cwd, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            ...CAPTURE_PATHSPEC,
          ])
        ).stdout;
      } catch {
        // Same fallback as `baselinePatch`: no HEAD/not a work tree/missing
        // `git` all surface for real at `git worktree add` below instead.
        return undefined;
      }
      const paths = listing.split("\0").filter((path) => path !== "");
      // Created even when there is nothing to carry: the directory's existence
      // is the freeze, exactly as `_run-baseline.patch`'s is — see
      // {@link baselineFile}. Without it, a resumed run re-listed a checkout
      // that this run's own earlier stages had already added files to, and
      // then replayed the patch that created them: `git apply` refused with
      // "already exists" and the later stage could not be seeded at all.
      await mkdir(untrackedSeedDir, { recursive: true });
      if (paths.length === 0) return undefined;
      const dir = untrackedSeedDir;
      let bytes = 0;
      let copied = 0;
      for (const relPath of paths) {
        if (copied >= UNTRACKED_SEED_FILE_CAP || bytes >= UNTRACKED_SEED_BYTES_CAP) break;
        const dest = join(dir, relPath);
        // Defense in depth: `git ls-files` never emits a `..` segment or an
        // absolute path, but this snapshot is about to be copied verbatim
        // into every worktree this run creates, so it gets its own
        // containment check rather than trusting the one upstream promise.
        if (!within(dest, dir)) continue;
        try {
          const src = join(host.cwd, relPath);
          const info = await lstat(src);
          // Plain files only — see the doc comment above.
          if (!info.isFile() || bytes + info.size > UNTRACKED_SEED_BYTES_CAP) continue;
          await mkdir(dirname(dest), { recursive: true });
          await cp(src, dest);
          bytes += info.size;
          copied += 1;
        } catch {
          // Vanished between listing and copying, unreadable, whatever —
          // best effort, exactly like `baselinePatch`'s own catch.
        }
      }
      return copied > 0 ? dir : undefined;
    })();
    return await untracked;
  };

  return {
    cwd: host.cwd,
    async createWorktree(name, seed) {
      await mkdir(parentDir, { recursive: true });
      const base = await baselinePatch();
      const untrackedDir = await untrackedSnapshot();
      const worktree = await createWorktree(host.cwd, name, {
        parentDir,
        gitTimeoutMs: GIT_TIMEOUT_MS,
      });
      try {
        if (untrackedDir !== undefined) {
          // Merged onto the fresh worktree *before* any patch is replayed —
          // see "Untracked files" on this function's doc comment for why a
          // later stage's own patch depends on this content already being
          // there.
          await cp(untrackedDir, worktree.dir, { recursive: true });
        }
        for (const patch of [...(base === undefined ? [] : [base]), ...(seed?.patches ?? [])]) {
          await exec(worktree.dir, ["apply", "--whitespace=nowarn", "--", patch]);
        }
        await exec(worktree.dir, ["add", "--all", ...CAPTURE_PATHSPEC]);
        // `--allow-empty` so the base ref exists even for a run whose state is
        // nothing at all; `--no-verify`/`--no-gpg-sign` so a repository's own
        // hooks and signing config cannot fail a seed they never asked for.
        await exec(worktree.dir, [
          ...SEED_COMMIT_IDENTITY,
          "commit",
          "--allow-empty",
          "--no-verify",
          "--no-gpg-sign",
          "-q",
          "-m",
          "arcturn: workflow seed",
        ]);
        const baseRef = (await exec(worktree.dir, ["rev-parse", "HEAD"])).stdout.trim();
        return {
          dir: worktree.dir,
          ...(baseRef === "" ? {} : { baseRef }),
          remove: () => worktree.remove(),
        };
      } catch (error) {
        // A worktree that does not carry the run's state would silently hand
        // the role the wrong base, so it is not offered at all.
        await worktree.remove().catch(() => undefined);
        throw new Error(
          `could not seed ${worktree.dir} with this run's state: ${gitComplaint(error)}`,
        );
      }
    },
    spawn({ def, cwd, model, stepId, turnCeiling, progressCheck }) {
      const agent = host.buildSessionAgent({
        sessionId: createSessionId(),
        cwd,
        model: model ?? host.router.specFor("subagent"),
        // Which role, in which step, is about to ask — the read lane labels
        // its children the same way, so both lanes prompt legibly.
        origin: workflowStepOrigin(stepId, def.name),
        // RFC 0001 §8.4: a role's declared budget must bind on the expensive
        // lane too. `buildSessionAgent` clamps it down to the session's own
        // subagent ceiling — the key travels even when the role declared no
        // number, which is what opts this agent into that ceiling at all.
        maxTurns: def.maxTurns,
        // A human's run-scoped raise, which lifts BOTH halves of that clamp —
        // the role's own `maxTurns:` AND the session's `subagentMaxTurns`.
        // Lifting one alone leaves `Math.min` where it was, which is exactly
        // the trap that made a hand-edited role file change nothing.
        ...(turnCeiling === undefined ? {} : { turnCeiling }),
        // The mid-run nudge for a role that is reading instead of writing —
        // see {@link writeLaneProgressCheck}. Only the write dispatch supplies
        // one, so the exec lane's children are untouched.
        ...(progressCheck === undefined ? {} : { progressCheck }),
        // The narrowing, the confinement guard and the background tracking
        // below are all installed with `setTools`, and a deferred toolset
        // would quietly outrank every one of them. This child's tools are
        // this lane's to decide, full stop.
        fixedToolset: true,
      });
      // Rooted at the worktree by `cwd`, and *confined* to it by rules: a
      // `cwd` default is a suggestion the first absolute path walks past, and
      // the whole promise of this lane is that the diff it captures is the
      // work. Seeded before the role is handed a single tool.
      confineToWorktree(agent, cwd);
      // Exactly `createTeamSpawn`: `subagent` always goes (no nested orgs,
      // RFC 0001 L6), and the role's `tools:` produces a genuinely shorter
      // array — a role without `edit` has no `edit` object to call.
      const allowed = def.tools === undefined ? undefined : new Set(def.tools);
      const narrowed = agent.tools.filter(
        (tool) =>
          tool.definition.name !== "subagent" &&
          (allowed === undefined || allowed.has(tool.definition.name)),
      );
      // Every background task started through *this* agent's `bash`, and no
      // other: the manager is shared session-wide, so the id is the only
      // thing that says whose process this is.
      const started = new Set<string>();
      const tasks = host.backgroundTasks;
      const tracked =
        tasks === undefined
          ? narrowed
          : narrowed.map((tool) => trackBackgroundTasks(tool, started));
      // The confinement guards go on outermost, so a call that reaches outside
      // the worktree is refused before it can start anything at all —
      // including a background task the step would then have to reap.
      agent.setTools(tracked.map((tool) => guardWorktreeBash(guardWorktreePaths(tool, cwd), cwd)));
      const spawned = agent as WriteLaneSessionAgent & WorkflowLaneAgent;
      // Attached rather than wrapped: the seam that hands `Agent` to a lane
      // is structural, and a facade would hide everything else the real agent
      // exposes (its permission engine, above all) behind this one method.
      spawned.killBackgroundTasks = () =>
        tasks === undefined ? 0 : reapBackgroundTasks(tasks, started);
      return spawned;
    },
    exec,
  };
}

/**
 * A sortable, unique directory name for one workflow run's artifacts.
 *
 * Exported so the `/workflow` command can mint one runId per run and thread the
 * *same* id into the write lane, the journal, and any later `resume` — all three
 * must point at one `~/.arcturn/workflow-runs/<runId>/`.
 */
export function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `${stamp}-${createSessionId().slice(0, 8)}`;
}

/** How long a run's worktrees and patches survive before they are pruned. */
export const WORKFLOW_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Options for {@link pruneWorkflowRuns}. */
export interface PruneWorkflowRunsOptions {
  /** The `workflow-runs` directory to sweep. */
  root: string;
  /** Age past which a run directory is deleted; defaults to seven days. */
  maxAgeMs?: number;
  /** Clock injection point for tests. */
  now?: number;
  /** Checkout to run `git worktree prune` in after deleting anything. */
  repo?: string;
  /** Git runner, injected for tests. */
  exec?: (cwd: string, args: readonly string[]) => Promise<unknown>;
}

/**
 * Delete workflow run directories older than the TTL, then re-register git.
 *
 * A failed step deliberately *keeps* its worktree, so the feature that makes
 * failures debuggable is also a slow leak: patches, checkouts and their
 * administrative entries in `.git/worktrees` accumulate for as long as the
 * user keeps running pipelines. Sweeping on each run bounds that at a week
 * without ever deleting the forensics of the run someone is looking at today.
 *
 * `git worktree prune` runs *after* the deletions and only when something was
 * deleted: removing a preserved worktree's directory leaves git holding a
 * stale registration that would refuse the next worktree at that path.
 *
 * Never rejects: hygiene must not be able to fail a workflow.
 *
 * @param options - Root, TTL, clock and the checkout to prune.
 * @returns The absolute paths that were deleted.
 */
export async function pruneWorkflowRuns(options: PruneWorkflowRunsOptions): Promise<string[]> {
  const maxAgeMs = options.maxAgeMs ?? WORKFLOW_RUN_TTL_MS;
  const now = options.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(options.root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries.sort()) {
    const dir = join(options.root, entry);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // A directory that cannot be read or removed is left alone: it is the
      // next run's problem, not this run's failure.
    }
  }
  if (removed.length > 0 && options.repo !== undefined) {
    const exec =
      options.exec ??
      (async (cwd: string, args: readonly string[]) =>
        await execFileAsync("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }));
    try {
      await exec(options.repo, ["worktree", "prune"]);
    } catch {
      // Not a repository, or git is missing: the directories are still gone.
    }
  }
  return removed;
}

// -------------------------------------------------------------------- commands

/** The slice of `ArcturnRuntime` the `/workflow` command needs. */
export interface WorkflowCommandRuntime extends WorkflowAgentHost {
  readonly paths: { readonly home: string; readonly project: string };
  /**
   * The user's checkout. Used only for hygiene: after a stale run directory
   * is deleted, git still holds its worktree registration.
   */
  readonly cwd?: string;
  /**
   * The markdown agents the runtime loaded — the pipeline's role catalog.
   * Optional so a host with no agent loader still gets `/workflow`; a
   * workflow that names a role then fails with "no roles are loaded".
   */
  readonly agents?: ReadonlyMap<string, AgentDef>;
  /**
   * The runtime's model router, for `tier:<name>` tags.
   *
   * Structural and optional: a real `ArcturnRuntime` has one, a stub runtime
   * in tests may not. Without it a tier tag resolves to nothing and the step
   * is refused with the tag named — which is honest, but the kits ship tier
   * tags now, so production callers should provide it.
   */
  readonly router?: { specForTier(name: string): ModelSpec | undefined };
  /** Current permission mode; `"plan"` disables both worktree lanes. */
  readonly permissionMode?: string;
  /**
   * Publishes an event onto the session's own event stream, the way the live
   * agent's own events are published. This is how a step's child agent
   * becomes *visible* — see {@link workflowStepAgentId}. Optional: a host
   * with no live region omits it and a pipeline runs exactly as before.
   */
  emit?(event: AgentEvent): void;
  /**
   * The local insights ledger this runtime built from `paths.home` and config
   * (see `runtime.ts`). Optional: a host without one records nothing and every
   * pipeline behaves exactly as it did.
   */
  readonly insights?: InsightsRecorder;
}

/** Options for {@link createWorkflowCommands}. */
export interface CreateWorkflowCommandsOptions {
  /**
   * Resolves a step's `[tag]` to a model. Without it, a tagged workflow fails
   * before running rather than silently running on the wrong model.
   *
   * Also used to resolve a *role's* own `model:` id for a worktree lane,
   * which has to hand `buildSessionAgent` a resolved spec.
   */
  resolveModelTag?: ModelTagResolver;
  /** Overrides for the per-step child agents. */
  step?: RuntimeRunStepOptions;
  /** Discovery override, for tests. */
  discover?: (roots: readonly string[], warnings: string[]) => Promise<Workflow[]>;
  /**
   * Role catalog for `@role` steps. Defaults to the runtime's own `agents`
   * map; override in tests to avoid building a runtime.
   */
  agents?: (runtime: WorkflowCommandRuntime) => ReadonlyMap<string, AgentDef>;
  /**
   * Builds the worktree lane for **one** run (called per `/workflow <name>`,
   * so each run gets its own worktree/patch directory, and one run's seeding
   * baseline is captured once). Omit and an exec- or write-lane role fails
   * the step instead of running unisolated.
   *
   * The `runId` is minted by the command and threaded here so the lane's patch
   * files, the run journal, and a later `resume` all share one artifact
   * directory (`~/.arcturn/workflow-runs/<runId>/`).
   */
  writeLane?: (runtime: WorkflowCommandRuntime, runId: string) => WriteLane;
}

/** Roots a workflow may live in, lowest precedence first. */
function workflowRoots(runtime: WorkflowCommandRuntime): string[] {
  return [
    ...new Set([join(runtime.paths.home, "workflows"), join(runtime.paths.project, "workflows")]),
  ];
}

/** Render the discovered workflows as a `/workflow list` table. */
function formatWorkflowList(workflows: readonly Workflow[]): string[] {
  if (workflows.length === 0) {
    return [
      "No workflows found. Add one at ~/.arcturn/workflows/<name>.md or .arcturn/workflows/<name>.md.",
    ];
  }
  const width = Math.max(...workflows.map((workflow) => workflow.name.length));
  return workflows
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((workflow) => {
      const steps = workflow.stages.reduce((total, stage) => total + stage.steps.length, 0);
      const summary = workflow.description === "" ? "" : ` — ${oneLine(workflow.description, 60)}`;
      return `${workflow.name.padEnd(width)}  ${workflow.stages.length} stage(s), ${steps} step(s)${summary}`;
    });
}

/** Render a finished run for the transcript. */
function formatWorkflowRun(result: WorkflowRunResult): string[] {
  const lines = [
    `Workflow ${result.workflow}: ${result.status} in ${formatDuration(result.endedAt - result.startedAt)}`,
  ];
  for (const step of result.steps) {
    const detail =
      step.error !== undefined
        ? ` — ${oneLine(step.error, 80)}`
        : step.status === "paused" && step.question !== undefined
          ? ` — asks: ${oneLine(step.question, 80)}`
          : "";
    // The record, not the step's text, is what actually happened to the
    // user's checkout — so the run report states it rather than leaving it to
    // be read out of a trailer buried in the piped output.
    const patch =
      step.record === undefined
        ? ""
        : ` [patch ${step.record.status}${step.record.files > 0 ? `, ${step.record.files} file(s)` : ""}]`;
    lines.push(
      `  ${step.id}${step.agent ? ` @${step.agent}` : ""} ${step.status}${patch}${detail}`,
    );
  }
  if (result.text.trim() !== "") lines.push("", result.text.trim());
  return lines;
}

/** One line of the run-start permission heads-up. */
export interface WorkflowPostureNotice {
  /** Notice channel: `"info"` for the posture, `"warn"` for the heads-up. */
  readonly level: "info" | "warn";
  /** The line itself. */
  readonly text: string;
}

/** What each permission mode means for a pipeline that is about to start. */
const POSTURE_BY_MODE: Readonly<Record<string, string>> = {
  yolo: "every tool call is auto-approved, so this run will not stop to ask",
  plan: "read-only, so no step may write or run commands",
  acceptEdits: "edits are auto-approved; other tools still stop to ask",
  default: "anything outside your allow rules stops to ask",
};

/**
 * The permission heads-up shown once, at the top of a run.
 *
 * Nothing used to tell an operator, before a pipeline spent anything, whether
 * it would run unattended or stop for approvals — so a seven-stage run that
 * paused six times was indistinguishable from a broken permission mode. This
 * states the posture up front, and when a run WILL stop, names the roles that
 * will stop it and what to do about it.
 *
 * Two lines at most, and only ever a heads-up: it reads the mode and the
 * pipeline, and changes neither.
 *
 * @param workflow - The pipeline about to run.
 * @param permissionMode - The session's mode right now.
 * @param resolveAgent - The run's role catalog, so a role's declared `tools:`
 *   can be read for its lane. A role this cannot resolve, and one that
 *   declared no `tools:` at all, are both left out — neither will reach an
 *   agent (they fail the step first), so promising prompts for them would be
 *   wrong.
 */
export function workflowPostureNotices(
  workflow: Workflow,
  permissionMode: string | undefined,
  resolveAgent: AgentRoleResolver,
): WorkflowPostureNotice[] {
  const mode = permissionMode ?? "default";
  const summary = POSTURE_BY_MODE[mode];
  const notices: WorkflowPostureNotice[] = [
    {
      level: "info",
      text: `Permission mode: ${mode}${summary === undefined ? "." : ` — ${summary}.`}`,
    },
  ];
  if (mode === "yolo") return notices;

  // First-appearance order, deduplicated: a role used in three stages is one
  // name in the warning, and the reader meets them as the run will.
  const gated: string[] = [];
  for (const stage of workflow.stages) {
    for (const step of stage.steps) {
      if (step.agent === undefined || gated.includes(step.agent)) continue;
      const role = resolveAgent(step.agent);
      if (!role || role.tools === undefined) continue;
      if (roleDispatch(role) !== "read") gated.push(step.agent);
    }
  }
  if (gated.length === 0) return notices;

  const names = gated.map((name) => `@${name}`).join(", ");
  // Plan mode does not prompt for these roles — it refuses them outright
  // (`planModeWriteRefusal` / `planModeExecRefusal`). Promising them an
  // approval prompt would be a lie.
  notices.push(
    mode === "plan"
      ? {
          level: "warn",
          text:
            `${names} need to write or run commands, and plan mode has neither lane: ` +
            "those steps will be refused. Change mode with /permissions before running.",
        }
      : {
          level: "warn",
          text:
            `${names} write or run commands, so this run will stop for your approval. ` +
            "Switch to yolo with /permissions to run it unattended, or approve as they come.",
        },
  );
  return notices;
}

/**
 * The `/workflow` slash command.
 *
 * `/workflow list` enumerates discovered workflows; `/workflow <name> [args]`
 * runs one, splicing `args` into `{{input}}`. Registration is a single line in
 * `createCommandRegistry` — see the integration recipe.
 *
 * @param options - Model-tag resolver and per-step agent overrides.
 */
/**
 * Compose a caller's tag resolver with the runtime's tier routing.
 *
 * The split exists because the two halves know different things. A `[tag]` or
 * a role's `model:` that names a concrete id is the caller's to resolve
 * against the model catalog. A `tier:<name>` names an *intent* — "the
 * judgment model", "the build model" — and only the runtime's router knows
 * what this deployment's config points each tier at; unset tiers fall back to
 * the user's own main model inside `specForTier`, which is what makes a kit
 * authored with tiers portable across providers instead of hardcoding one.
 *
 * The hub's kits used to pin `anthropic/claude-opus-5` in every role, and
 * every workflow in the catalog returned 401 to anyone whose Anthropic key
 * was missing or dead — while their configured model sat unused. Tiers are
 * the fix; this function is where they become resolvable.
 */
export function composeTagResolver(
  runtime: Pick<WorkflowCommandRuntime, "router">,
  base: ModelTagResolver | undefined,
): ModelTagResolver | undefined {
  if (base === undefined && runtime.router === undefined) return undefined;
  return (tag: string) => {
    if (tag.startsWith("tier:")) {
      const name = tag.slice("tier:".length).trim();
      if (name === "") return undefined;
      return runtime.router?.specForTier(name);
    }
    return base?.(tag);
  };
}

export function createWorkflowCommands(
  options: CreateWorkflowCommandsOptions = {},
): SlashCommand[] {
  const discover = options.discover ?? discoverWorkflows;
  const command: SlashCommand = {
    name: "workflow",
    description:
      "Run a scripted multi-step workflow: /workflow <name> [args] · /workflow list · /workflow status [runId] · /workflow resume <runId> [answer]",
    source: "built-in",
    async run(context: CommandContext): Promise<void> {
      const { ui } = context;
      const runtime = context.runtime as unknown as WorkflowCommandRuntime;
      // Tier tags resolve through the runtime's router; concrete ids through
      // the caller's resolver. Composed once per invocation — see the helper.
      const resolveTag = composeTagResolver(runtime, options.resolveModelTag);

      // The run-status surface reads the durable journal only — no discovery, no
      // engine, no agent — so an operator can answer "what is it doing / what did
      // it do" for a run in another terminal without an engineer grepping JSONL.
      const trimmedArgs = context.args.trim();
      if (trimmedArgs === "status" || trimmedArgs.startsWith("status ")) {
        const root = join(runtime.paths.home, "workflow-runs");
        const runId = trimmedArgs === "status" ? "" : trimmedArgs.slice("status".length).trim();
        if (runId === "") {
          ui.print(formatRunsTable(await readWorkflowRuns(root)));
        } else {
          const run = await readWorkflowRun(root, runId);
          if (!run) ui.notice("error", `No run journal for "${runId}". Try /workflow status.`);
          else ui.print(formatRunDetail(run));
        }
        return;
      }

      const warnings: string[] = [];
      const workflows = await discover(workflowRoots(runtime), warnings);
      for (const warning of warnings) ui.notice("warn", warning);

      const trimmed = context.args.trim();
      if (trimmed === "" || trimmed === "list") {
        ui.print(formatWorkflowList(workflows));
        return;
      }

      // Roles are the markdown agents the runtime already loaded — the same for
      // a fresh run and a resume, so they are resolved once here.
      const roles = (options.agents ?? ((host) => host.agents ?? new Map()))(runtime);
      const resolveAgent: AgentRoleResolver = (name) => roles.get(name);
      const agentNames = (): readonly string[] => [...roles.keys()];
      const runsRoot = join(runtime.paths.home, "workflow-runs");

      // The single execution path both a fresh run and a resume flow through:
      // one runId names the run's artifact directory, its journal, and (via the
      // lane) its patch files, so a later `/workflow resume <runId>` finds them
      // all together.
      const execute = async (
        wf: Workflow,
        runInput: string,
        runId: string,
        resumeFrom?: ResumeState,
      ): Promise<WorkflowRunResult | undefined> => {
        const posture = workflowPostureNotices(wf, runtime.permissionMode, resolveAgent);
        const journal = createFileRunJournal(join(runsRoot, runId));
        // Built once and used twice: the lane runs the steps, and the *same*
        // checkout answers "is this patch already in there?" when a resume has
        // to rule on a step the last run was killed inside.
        const lane = options.writeLane?.(runtime, runId);
        // ORG MEMORY: loaded once per run, so stage 6 reads what stage 1 read
        // even if the operator edits the store while the pipeline is running.
        // A store that cannot be read degrades to "this org remembers nothing",
        // which is the pre-memory behaviour rather than a failure.
        const orgMemory = await loadOrgMemoryInjector(orgMemoryPath(runtime.paths), (warning) =>
          ui.notice("warn", warning),
        );
        // Esc/Ctrl+C must stop a workflow mid-step, exactly like /scout.
        const controller = new AbortController();
        const onInterrupt = (): void => controller.abort();
        process.once("SIGINT", onInterrupt);
        try {
          const result = await runWorkflow(wf, {
            runStep: createRuntimeRunStep(runtime, {
              resolveAgent,
              agentNames,
              planMode: () => runtime.permissionMode === "plan",
              // The live region. A role agent's events never reach the session's
              // stream on their own, so every step republishes its child there
              // as a namespaced sub-agent and the host's existing rows light up.
              // Called through the runtime so the method keeps its receiver.
              ...(runtime.emit === undefined
                ? {}
                : { emit: (event: AgentEvent) => runtime.emit?.(event) }),
              ...(resolveTag === undefined ? {} : { resolveModel: resolveTag }),
              // The write lane shares this run's id so its patches land in the
              // run's artifact dir — the ones a resume re-seeds worktrees from.
              ...(lane === undefined ? {} : { writeLane: lane }),
              orgMemory,
              // The ledger plus this run's coordinates, so a step's own child
              // agent records its silences and progress warnings under the
              // step they belong to. `enabled: false` (or no ledger at all)
              // makes every one of those calls a no-op.
              ...(runtime.insights === undefined
                ? {}
                : {
                    insights: {
                      recorder: runtime.insights,
                      workflow: wf.name,
                      runId,
                    },
                  }),
              ...(options.step ?? {}),
            }),
            input: runInput,
            resolveAgent,
            agentNames,
            ...(resolveTag === undefined ? {} : { resolveModel: resolveTag }),
            signal: controller.signal,
            runId,
            journal,
            ...(runtime.insights === undefined ? {} : { insights: runtime.insights }),
            // Resume's reality check. Without a lane there is no checkout to
            // probe, and an ambiguous step is recovered rather than repeated.
            ...(lane === undefined ? {} : { verifyPatch: createPatchVerifier(lane) }),
            ...(resumeFrom === undefined ? {} : { resumeFrom }),
            onEvent: (event) => {
              // Durable transcript (the permanent record) and the ephemeral live
              // block are fed side by side: the notices survive a crash and
              // scroll back; the live block updates in place and clears on end.
              reportWorkflowEvent(event, ui);
              ui.workflowLive?.(event);
              // Right after the step count, before a step has spent anything:
              // the operator learns whether this run will stop for them while
              // there is still time to change the mode.
              if (event.type === "workflowStart") {
                for (const notice of posture) ui.notice(notice.level, notice.text);
              }
            },
          });
          ui.print(formatWorkflowRun(result));
          // A pause is a clean, resumable stop, not an error — its question is
          // already surfaced (per-step notice + live block) and the caller
          // offers the human a way to answer. Everything else non-`done` is a
          // real problem worth an error/warn notice.
          if (result.status !== "done" && result.status !== "paused") {
            ui.notice(
              result.status === "cancelled" ? "warn" : "error",
              result.error ?? result.status,
            );
          } else if (result.status === "paused" && result.pauses.length > 0) {
            // A pause is not an error — but it is emphatically not a completed
            // run either, and off a TTY (`--print`, serve, acp, CI) the modal
            // below never appears. This is the one line that says "this
            // pipeline did not finish, and a person has to decide what happens
            // next", loud enough to be grepped out of a CI log — for every
            // kind of pause: a budget checkpoint, a role's question, a parked
            // step. `result.error` already carries `pauseSummary`, whose
            // opening words `--print` keys its exit code on.
            //
            // For a parked step the diagnosis rides the same notice: what the
            // model emitted on the turn it failed on, on the same stream as
            // the park so a job capturing only stderr keeps both. This is the
            // line that used to live in an engineer's head after an hour with
            // the session JSONL.
            const shape = result.pauses[0]?.lastTurn;
            // …and what it spent those turns on, on the line below. "80 turns,
            // zero files written" is the half of the diagnosis the last turn
            // alone cannot show.
            const spentOn = result.pauses[0]?.activity;
            const summary = result.error ?? pauseSummary(result.pauses);
            ui.notice(
              "warn",
              [
                summary,
                ...(shape === undefined ? [] : [describeLastTurn(shape)]),
                ...(spentOn === undefined ? [] : [describeActivity(spentOn)]),
              ].join("\n"),
            );
          }
          return result;
        } catch (error) {
          ui.notice("error", errorText(error));
          return undefined;
        } finally {
          process.removeListener("SIGINT", onInterrupt);
        }
      };

      /**
       * The human-question gate's interactive prompt.
       *
       * Reuses the permission engine's own modal ({@link CommandUi.select}) to
       * ASK the human, then the editor prompt ({@link CommandUi.setInput}) to
       * capture the free-text answer via the same `/workflow resume` path a
       * headless host uses — so there is one answer channel, no new modal, and a
       * crash between the pause and the answer loses nothing (the pause is on
       * disk). A host whose `select` returns `undefined` (headless, or the human
       * cancelled) leaves the run paused for a later resume.
       *
       * A stage can raise several questions at once. Each one is already in the
       * transcript (one notice per paused step), so the modal states how many
       * are outstanding: the reply answers the *stage*, not just the question
       * that happens to fit on the prompt line.
       */
      const offerAnswer = async (
        pauses: readonly WorkflowPause[],
        runId: string,
      ): Promise<void> => {
        const first = pauses[0];
        if (first === undefined) return;
        const title =
          pauses.length === 1
            ? `${HUMAN_STOP_OPENINGS.paused} — ${oneLine(first.question, 80)}`
            : `${HUMAN_STOP_OPENINGS.paused} — ${pauses.length} questions, one reply answers them: ` +
              pauses.map((pause) => oneLine(pause.question, 40)).join(" · ");
        const choice = await ui.select(title, [
          {
            value: "answer",
            label: "Answer now",
            description:
              pauses.length === 1
                ? "type your answer to continue the run"
                : "type one reply covering all of them to continue the run",
            data: "answer" as const,
          },
          {
            value: "later",
            label: "Answer later",
            description: `resume with /workflow resume ${runId} <answer>`,
            data: "later" as const,
          },
        ]);
        if (choice === "answer") {
          ui.setInput(`/workflow resume ${runId} `);
          ui.notice(
            "info",
            "Type your answer after the command and press Enter to continue the run.",
          );
        } else {
          ui.notice(
            "info",
            `Run ${runId} is paused awaiting your answer. Resume with: /workflow resume ${runId} <your answer>`,
          );
        }
      };

      /** Run (fresh or resumed) and, if it paused for a question, offer to answer. */
      const runAndOffer = async (
        wf: Workflow,
        runInput: string,
        runId: string,
        resumeFrom?: ResumeState,
      ): Promise<void> => {
        const result = await execute(wf, runInput, runId, resumeFrom);
        if (result?.status === "paused" && result.pauses.length > 0) {
          await offerAnswer(result.pauses, runId);
        }
      };

      // RESUME: continue a killed OR paused run from its journal, under the same
      // runId, so finished steps are never redone and their patches never
      // re-applied. `/workflow resume <runId>` alone continues a crash; when the
      // run is paused for a human question, the trailing text is the answer:
      // `/workflow resume <runId> <answer>`.
      if (trimmed === "resume" || trimmed.startsWith("resume ")) {
        const rest = trimmed === "resume" ? "" : trimmed.slice("resume".length).trim();
        const gap = rest.search(/\s/);
        const runId = gap === -1 ? rest : rest.slice(0, gap);
        const answerText = gap === -1 ? "" : rest.slice(gap + 1).trim();
        if (runId === "") {
          ui.notice(
            "error",
            "Usage: /workflow resume <runId> [answer] — see /workflow status for ids.",
          );
          return;
        }
        const lines = await readJournalLines(join(runsRoot, runId));
        if (lines.length === 0) {
          ui.notice("error", `No run journal for "${runId}". Try /workflow status.`);
          return;
        }
        const state = buildResumeState(lines);
        // A genuinely finished run (done/failed/cancelled) has nothing to resume.
        // A `"paused"` end is the gate's *soft* stop — resumable with an answer —
        // so it is deliberately excluded from "already finished".
        if (state.ended && state.endedStatus !== "paused") {
          ui.notice(
            "warn",
            `Run ${runId} already finished (${state.endedStatus ?? "done"}); nothing to resume.`,
          );
          return;
        }
        const header = lines.find(
          (line): line is Extract<JournalLine, { kind: "run" }> => line.kind === "run",
        );
        const wfName = state.workflow ?? header?.workflow;
        const wf = workflows.find((candidate) => candidate.name === wfName);
        if (!wf) {
          ui.notice(
            "error",
            `Run ${runId} ran the workflow "${wfName ?? "?"}", which is no longer discoverable; ` +
              "restore the workflow file to resume it.",
          );
          return;
        }
        // No `pruneWorkflowRuns` here: it must not sweep the very run we are
        // about to resume (appending to its journal touches mtime anyway).

        // The stage-boundary budget ask: the run parked short of a ceiling,
        // and the reply is interpreted by the ENGINE (acknowledge, raise, or
        // re-park with the reason) — never parsed here, which is exactly what
        // keeps "raise 40" typed at a role's ORG-ASK an ordinary answer. This
        // interactive path always has raise authority; the serve path passes
        // `allowBudgetRaise: false` by default and the wire refuses raises
        // outright, unless the host started `arcturn serve
        // --allow-ceiling-raise`, in which case it passes `true` and the wire
        // is the SAME origin, reusing this exact grammar.
        if (state.budgetAsk !== undefined) {
          if (answerText === "") {
            // A bare resume is not consent, exactly as it is not an answer to
            // a role's question: re-state the checkpoint and pre-fill the
            // command. Nothing is journalled, and nothing is spent.
            ui.notice(
              "warn",
              `Run ${runId} is parked at a budget checkpoint — ` +
                budgetAskQuestion(state.budgetAsk),
            );
            ui.notice("info", budgetAskResumeHint(runId));
            ui.setInput(`/workflow resume ${runId} `);
            return;
          }
          ui.notice(
            "info",
            isBudgetAckAnswer(answerText)
              ? `Resuming ${wf.name} run ${runId}: budget checkpoint acknowledged — the run ` +
                  "continues to its hard stop and will not ask about this ceiling again."
              : `Resuming ${wf.name} run ${runId} with your reply to its budget checkpoint; ` +
                  `${state.completed.size} finished step(s) are reused, not redone.`,
          );
          const replied: ResumeState = { ...state, budgetAnswer: { text: answerText } };
          await runAndOffer(wf, header?.input ?? "", runId, replied);
          return;
        }

        // The step-failure park: a failed step is a question now, and the
        // reply is interpreted by the ENGINE (retry, abandon, raise, or
        // re-park with the reason) — never parsed here, which is what keeps
        // "retry" typed at a role's ORG-ASK an ordinary answer. This
        // interactive path always has raise authority; the serve path passes
        // `allowBudgetRaise: false` by default and the wire refuses raises
        // outright, unless the host started `arcturn serve
        // --allow-ceiling-raise`, in which case it passes `true`.
        if (state.stepFailAsk !== undefined) {
          if (answerText === "") {
            // A bare resume is not a decision to spend again: re-state the
            // park and pre-fill the command. Nothing is journalled, nothing
            // runs, nothing is charged.
            ui.notice(
              "warn",
              `Run ${runId} is parked at a failed step — ${stepFailAskQuestion(state.stepFailAsk)}`,
            );
            if (state.stepFailAsk.lastTurn !== undefined) {
              ui.notice("warn", describeLastTurn(state.stepFailAsk.lastTurn));
            }
            if (state.stepFailAsk.activity !== undefined) {
              ui.notice("warn", describeActivity(state.stepFailAsk.activity));
            }
            ui.notice("info", stepFailAskResumeHint(runId, state.stepFailAsk));
            ui.setInput(`/workflow resume ${runId} `);
            return;
          }
          ui.notice(
            "info",
            isStepAbandonAnswer(answerText)
              ? `Ending ${wf.name} run ${runId}: step ${state.stepFailAsk.stepId} abandoned, ` +
                  "the run is recorded as failed."
              : `Resuming ${wf.name} run ${runId} at step ${state.stepFailAsk.stepId}; ` +
                  `${state.completed.size} finished step(s) are reused, not redone.`,
          );
          const replied: ResumeState = { ...state, stepFailAnswer: { text: answerText } };
          await runAndOffer(wf, header?.input ?? "", runId, replied);
          return;
        }

        // The human-question gate: a paused run needs an ANSWER, not just a
        // resume. Without one, re-surface the question and pre-fill the answer
        // command; with one, inject it in place of the asking step's output and
        // continue from the next stage — earlier stages are reused, never redone.
        if (state.pending !== undefined) {
          if (answerText === "") {
            // Every question the stage raised, not just the first: an operator
            // shown one of two answers one of two, and the run would pause again
            // on a question they never saw.
            for (const question of state.pendings) {
              ui.notice(
                "warn",
                state.pendings.length === 1
                  ? `Run ${runId} is paused awaiting a human answer — ${question.question}`
                  : `Run ${runId} is paused awaiting a human answer at step ${question.stepId} — ${question.question}`,
              );
            }
            ui.notice("info", `Provide it: /workflow resume ${runId} <your answer>`);
            ui.setInput(`/workflow resume ${runId} `);
            return;
          }
          // One reply settles the whole paused stage (see `ResumeState.answer`):
          // its questions were surfaced together, so they are answered together
          // — and no paused step is ever re-run to get there.
          const others = state.pendings.length - 1;
          ui.notice(
            "info",
            `Resuming ${wf.name} run ${runId} with your answer to step ${state.pending.stepId}` +
              (others > 0 ? ` (and the other ${others} question(s) of that stage)` : "") +
              `; ${state.completed.size} finished step(s) are reused, not redone.`,
          );
          const answered: ResumeState = {
            ...state,
            answer: { stepId: state.pending.stepId, text: answerText },
          };
          await runAndOffer(wf, header?.input ?? "", runId, answered);
          return;
        }

        ui.notice(
          "info",
          `Resuming ${wf.name} run ${runId}: ${state.completed.size} finished step(s) will be ` +
            "reused; the run continues from the first unfinished step." +
            (state.interrupted.size === 0
              ? ""
              : ` ${state.interrupted.size} step(s) were interrupted mid-flight and are ruled on ` +
                "individually — one is only re-run when the record (or your checkout) shows it " +
                "changed nothing."),
        );
        await runAndOffer(wf, header?.input ?? "", runId, state);
        return;
      }

      const space = trimmed.search(/\s/);
      const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
      const input = space === -1 ? "" : trimmed.slice(space + 1).trim();
      const workflow = workflows.find((candidate) => candidate.name === name);
      if (!workflow) {
        ui.notice("error", `No workflow named "${name}". Try /workflow list.`);
        return;
      }

      // Hygiene first, and only for a real run: a failed step keeps its
      // worktree on purpose, so without a sweep the debuggable-forever
      // promise turns into an unbounded pile of checkouts under ~/.arcturn.
      await pruneWorkflowRuns({
        root: runsRoot,
        ...(runtime.cwd === undefined ? {} : { repo: runtime.cwd }),
      });

      // One runId per run names the artifact dir, the journal and the lane's
      // patches; the manifest is a small human-readable header beside them.
      const runId = createRunId();
      await writeManifest(join(runsRoot, runId), {
        v: RUN_JOURNAL_SCHEMA_VERSION,
        runId,
        workflow: workflow.name,
        source: workflow.source,
        input,
        stepTimeoutMs: workflow.stepTimeoutMs ?? DEFAULT_WORKFLOW_STEP_TIMEOUT_MS,
        maxStepRetries: workflow.maxStepRetries ?? DEFAULT_MAX_STEP_RETRIES,
        startedAt: Date.now(),
      });
      await runAndOffer(workflow, input, runId);
    },
  };
  return [command];
}

/**
 * Map one {@link WorkflowEvent} onto the UI's notice channel.
 *
 * Exported so a TUI host can reuse the exact same wording when it subscribes
 * to a workflow started outside the slash command.
 *
 * @param event - The progress event.
 * @param ui - Notice sink (`CommandUi`, or anything with the same `notice`).
 */
export function reportWorkflowEvent(event: WorkflowEvent, ui: Pick<CommandUi, "notice">): void {
  switch (event.type) {
    case "workflowStart":
      ui.notice("info", `Workflow ${event.workflow}: ${event.totalSteps} step(s).`);
      break;
    case "stageStart":
      if (event.parallel) {
        ui.notice("info", `Stage ${event.stageIndex}: ${event.steps} branches in parallel…`);
      }
      break;
    case "stepStart":
      ui.notice(
        "info",
        `Step ${event.id}${event.modelTag ? ` [${event.modelTag}]` : ""}` +
          `${event.agent ? ` @${event.agent}` : ""} (${event.lane} lane): ${oneLine(event.prompt, 70)}`,
      );
      break;
    case "stepEnd":
      if (event.result.status === "paused") {
        // The human-question gate: surface the question in the durable
        // transcript, not just the ephemeral live block, so it scrolls back.
        ui.notice(
          "warn",
          `Step ${event.result.id} paused for a human answer: ${oneLine(event.result.question ?? "", 70)}`,
        );
      } else if (event.result.status !== "done") {
        ui.notice(
          event.result.status === "failed" ? "error" : "warn",
          `Step ${event.result.id} ${event.result.status}${event.result.error ? `: ${oneLine(event.result.error, 70)}` : ""}`,
        );
      } else if (event.result.record?.status === "applied") {
        // A durable one-line record that a patch actually landed — the
        // transcript, not just the ephemeral block, should carry it.
        ui.notice(
          "info",
          `Step ${event.result.id} applied patch (${event.result.record.files} file(s)).`,
        );
      }
      break;
    default:
      break;
  }
}
