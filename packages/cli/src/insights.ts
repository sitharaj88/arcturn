/**
 * THE FEEDBACK LOOP — `arcturn insights` / `/insights`.
 *
 * Every serious defect this project found in its first week of real pipeline
 * runs was found by a person reading session JSONL by hand: which model went
 * quiet, on which step, how often, whether the nudge recovered it, what a run
 * cost before it parked. The engine knew all of it in the moment and kept none
 * of it, so the second occurrence of a fault cost exactly as much to diagnose
 * as the first.
 *
 * This module is the ledger that keeps it, and the command that turns it into
 * answers. Two halves:
 *
 * - {@link createInsightsRecorder} — an append-only JSONL ledger at
 *   `~/.arcturn/insights/events.jsonl`, written beside the four durable
 *   workflow journal writes and from the agent loop's `silentTurn` event.
 *   Writes are queued (never interleaved), never awaited by a run, and a
 *   failure is a warning rather than an error: a full disk must not fail a
 *   pipeline over a diagnostic. It rotates once at
 *   {@link INSIGHTS_ROTATE_BYTES} and keeps one generation.
 * - {@link aggregateInsights} / {@link renderInsights} — the read side, over
 *   both generations, with a `--json` form and a `--share` form.
 *
 * ## Privacy, which is the whole reason this is safe to keep
 *
 * The ledger records **names and numbers**: workflow names, step ids, role
 * names, model ids, run ids, statuses, failure kinds, durations, token counts,
 * tool-call counts. It records **no prompt text, no reasoning, no file
 * contents, no file paths, no user input and no session ids** — and that is
 * enforced structurally rather than by convention: {@link stampEvent} builds
 * every on-disk record field by field from a fixed whitelist, so a caller that
 * hands the recorder an object with extra keys writes none of them. In
 * particular a last-turn shape's `reasoningTail` — the one field in this
 * codebase that can carry model reasoning — is dropped on the way in, and
 * `insights.test.ts` asserts a tail never reaches the file.
 *
 * `"insights": false` in config disables recording entirely; the recorder then
 * touches no disk at all.
 *
 * Nothing here is ever sent anywhere. `--share` prints a markdown block and a
 * pre-filled GitHub issue URL; opening it is the human's decision.
 *
 * @packageDocumentation
 */

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SlashCommand } from "./commands.js";
import { formatCost, formatDuration, formatTokens } from "./format.js";
import { ASCII_GLYPHS, FANCY_GLYPHS, type GlyphSet, supportsUnicode } from "./glyphs.js";
import { type ArcturnPaths, type EnvMap, resolveArcturnPaths } from "./paths.js";
import { resolveWindow, StatsError, type StatsWindow } from "./stats.js";

// ---------------------------------------------------------------------------
// The on-disk record
// ---------------------------------------------------------------------------

/** Schema version stamped on every line. */
export const INSIGHTS_SCHEMA_VERSION = 1;

/** Rotate the ledger once it would pass this many bytes. One generation is kept. */
export const INSIGHTS_ROTATE_BYTES = 5 * 1024 * 1024;

/** Where a silent turn happened, when the ledger can tell. */
export type InsightsOrigin = "main" | "subagent" | "workflow";

/**
 * Why a run parked, reduced to a handful of buckets a person can act on.
 *
 * Coarser than `WorkflowFailureKind` on purpose: the question this answers is
 * "what keeps happening", and eleven kinds spread over four parks answers
 * nothing. See {@link parkCauseKind} for the mapping.
 */
export type ParkCauseKind =
  | "produced-nothing"
  | "turn-ceiling"
  | "no-progress"
  | "timeout"
  | "patch-refused"
  | "agent-error"
  | "network"
  | "other";

/** One block of a recorded turn — kind and size, never content. */
export interface InsightsTurnBlock {
  readonly type: "text" | "thinking" | "toolCall";
  readonly chars: number;
  readonly name?: string;
}

/**
 * A model's last turn as the ledger keeps it: model, stop reason, block shapes.
 *
 * Deliberately NOT `LastTurnShape` — it is that type minus `reasoningTail`, and
 * the difference is the point. The tail is the one field in the run journal
 * that can carry model reasoning, and a ledger meant to be shareable must never
 * hold it.
 */
export interface InsightsLastTurn {
  readonly model: string;
  readonly stopReason: string;
  readonly blocks: readonly InsightsTurnBlock[];
}

/** What a step's agent spent its turns on — counts and tool names only. */
export interface InsightsActivity {
  readonly turns: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  readonly writes: number;
}

/** Token counts only. Money rides on `run-end`'s own `costUsd`. */
export interface InsightsUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Fields every ledger line carries. */
interface InsightsEventBase {
  /** Schema version — {@link INSIGHTS_SCHEMA_VERSION}. */
  readonly v: number;
  /** Epoch milliseconds. */
  readonly ts: number;
}

/**
 * A model ended a turn with no text and no tool call.
 *
 * `nudged: true` is the first silence, which the loop handed back to ask again;
 * `nudged: false` is the second in a row, which ends the run empty-handed.
 */
export interface SilentTurnRecord extends InsightsEventBase {
  readonly kind: "silent-turn";
  readonly model: string;
  readonly nudged: boolean;
  readonly origin: InsightsOrigin;
  readonly workflow?: string;
  readonly stepId?: string;
  readonly role?: string;
  readonly runId?: string;
}

/** One workflow step's terminal. Written for every status, not just failures. */
export interface StepEndRecord extends InsightsEventBase {
  readonly kind: "step-end";
  readonly workflow: string;
  readonly runId: string;
  readonly stepId: string;
  readonly role?: string;
  readonly status: string;
  readonly failureKind?: string;
  /** The resolved model id, when the step ran long enough to name one. */
  readonly model?: string;
  readonly durationMs: number;
  readonly usage: InsightsUsage;
  readonly attempts: number;
  readonly lastTurn?: InsightsLastTurn;
  readonly activity?: InsightsActivity;
}

/** A failed step parked the run and asked a human what to do. */
export interface ParkRecord extends InsightsEventBase {
  readonly kind: "park";
  readonly workflow: string;
  readonly runId: string;
  readonly stepId: string;
  readonly role?: string;
  readonly failureKind?: string;
  readonly attempts: number;
  readonly lastTurn?: InsightsLastTurn;
  readonly activity?: InsightsActivity;
  readonly causeKind: ParkCauseKind;
}

/**
 * A per-turn progress check told a model it was spending its budget on the
 * wrong thing — the write-lane step forty turns in with nothing written.
 *
 * The warning TEXT is not recorded: it is one of this codebase's own constants,
 * so storing it would add bytes and no information. What is worth keeping is
 * *when* it fired and *to whom*, because a role that trips it on every run is a
 * role whose step is mis-scoped.
 */
export interface ProgressWarningRecord extends InsightsEventBase {
  readonly kind: "progress-warning";
  /** Which turn the check fired on. */
  readonly turnIndex: number;
  readonly origin: InsightsOrigin;
  readonly workflow?: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly role?: string;
}

/** A stage-boundary budget checkpoint parked the run before a ceiling killed it. */
export interface BudgetAskRecord extends InsightsEventBase {
  readonly kind: "budget-ask";
  readonly workflow: string;
  readonly runId: string;
  readonly ceiling: string;
  readonly spent: number;
  readonly limit: number;
}

/** A run ended — cleanly, failed, parked or cancelled. */
export interface RunEndRecord extends InsightsEventBase {
  readonly kind: "run-end";
  readonly workflow: string;
  readonly runId: string;
  readonly status: string;
  readonly stopReason?: string;
  readonly durationMs: number;
  readonly usage: InsightsUsage;
  readonly costUsd?: number;
  /** Distinct model ids the run's steps actually ran on. */
  readonly models: readonly string[];
  /** Steps that reached a terminal (skipped steps are not counted). */
  readonly steps: number;
  readonly parks: number;
}

/** One line of the ledger. */
export type InsightsEvent =
  | SilentTurnRecord
  | ProgressWarningRecord
  | StepEndRecord
  | ParkRecord
  | BudgetAskRecord
  | RunEndRecord;

/** What a caller hands {@link InsightsRecorder.record}: an event without `v`/`ts`. */
export type InsightsEventInput =
  | Omit<SilentTurnRecord, "v" | "ts">
  | Omit<ProgressWarningRecord, "v" | "ts">
  | Omit<StepEndRecord, "v" | "ts">
  | Omit<ParkRecord, "v" | "ts">
  | Omit<BudgetAskRecord, "v" | "ts">
  | Omit<RunEndRecord, "v" | "ts">;

/** Every kind the reader recognises; anything else is a line from the future. */
const EVENT_KINDS: ReadonlySet<string> = new Set([
  "silent-turn",
  "progress-warning",
  "step-end",
  "park",
  "budget-ask",
  "run-end",
]);

// ---------------------------------------------------------------------------
// Whitelisting — the privacy guarantee
// ---------------------------------------------------------------------------

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Copy only the four token counts; `costUsd` and `thinkingTokens` never ride along here. */
function usageFacts(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): InsightsUsage {
  return {
    inputTokens: positiveInt(usage.inputTokens),
    outputTokens: positiveInt(usage.outputTokens),
    cacheReadTokens: positiveInt(usage.cacheReadTokens),
    cacheWriteTokens: positiveInt(usage.cacheWriteTokens),
  };
}

/**
 * Reduce a last-turn shape to the ledger's copy — **dropping `reasoningTail`**.
 *
 * The single most important lines in this module. The journal's shape may
 * legitimately carry the tail of a silent turn's reasoning (it is how a human
 * diagnoses a park); the ledger is a different artefact with a different
 * promise, and it holds no reasoning at all. Rebuilt field by field rather than
 * spread-and-delete so a field added to `LastTurnShape` later is *absent* here
 * until someone decides otherwise.
 *
 * @param shape - The journal's own last-turn shape.
 */
export function insightsLastTurn(shape: {
  model: string;
  stopReason: string;
  blocks: readonly { type: "text" | "thinking" | "toolCall"; chars: number; name?: string }[];
}): InsightsLastTurn {
  return {
    model: shape.model,
    stopReason: shape.stopReason,
    blocks: shape.blocks.map((block) => ({
      type: block.type,
      chars: positiveInt(block.chars),
      ...(block.name === undefined || block.name === "" ? {} : { name: block.name }),
    })),
  };
}

/**
 * Reduce an activity record to the ledger's copy: counts and tool names only.
 *
 * @param activity - The step's recorded counts.
 */
export function insightsActivity(activity: {
  turns: number;
  toolCalls: Readonly<Record<string, number>>;
  writes: number;
}): InsightsActivity {
  const toolCalls: Record<string, number> = {};
  for (const [name, count] of Object.entries(activity.toolCalls)) {
    const n = positiveInt(count);
    if (name !== "" && n > 0) toolCalls[name] = n;
  }
  return { turns: positiveInt(activity.turns), toolCalls, writes: positiveInt(activity.writes) };
}

/** Include an optional string field only when it is a non-empty string. */
function str(key: string, value: unknown): Record<string, string> {
  return typeof value === "string" && value !== "" ? { [key]: value } : {};
}

/**
 * Stamp an input event with `v`/`ts` and rebuild it from a fixed whitelist.
 *
 * This is where the privacy promise is *enforced* rather than documented: the
 * returned object is constructed key by key, so an input carrying a prompt, a
 * path, a session id or a reasoning tail writes none of them.
 *
 * @param input - What a hook site recorded.
 * @param ts - Epoch milliseconds, from the caller's clock.
 */
export function stampEvent(input: InsightsEventInput, ts: number): InsightsEvent {
  const base = { v: INSIGHTS_SCHEMA_VERSION, ts };
  switch (input.kind) {
    case "silent-turn":
      return {
        ...base,
        kind: "silent-turn",
        model: input.model,
        nudged: input.nudged === true,
        origin: input.origin,
        ...str("workflow", input.workflow),
        ...str("stepId", input.stepId),
        ...str("role", input.role),
        ...str("runId", input.runId),
      };
    case "progress-warning":
      return {
        ...base,
        kind: "progress-warning",
        turnIndex: positiveInt(input.turnIndex),
        origin: input.origin,
        ...str("workflow", input.workflow),
        ...str("runId", input.runId),
        ...str("stepId", input.stepId),
        ...str("role", input.role),
      };
    case "step-end":
      return {
        ...base,
        kind: "step-end",
        workflow: input.workflow,
        runId: input.runId,
        stepId: input.stepId,
        ...str("role", input.role),
        status: input.status,
        ...str("failureKind", input.failureKind),
        ...str("model", input.model),
        durationMs: positiveInt(input.durationMs),
        usage: usageFacts(input.usage),
        attempts: positiveInt(input.attempts),
        ...(input.lastTurn === undefined ? {} : { lastTurn: insightsLastTurn(input.lastTurn) }),
        ...(input.activity === undefined ? {} : { activity: insightsActivity(input.activity) }),
      };
    case "park":
      return {
        ...base,
        kind: "park",
        workflow: input.workflow,
        runId: input.runId,
        stepId: input.stepId,
        ...str("role", input.role),
        ...str("failureKind", input.failureKind),
        attempts: positiveInt(input.attempts),
        ...(input.lastTurn === undefined ? {} : { lastTurn: insightsLastTurn(input.lastTurn) }),
        ...(input.activity === undefined ? {} : { activity: insightsActivity(input.activity) }),
        causeKind: input.causeKind,
      };
    case "budget-ask":
      return {
        ...base,
        kind: "budget-ask",
        workflow: input.workflow,
        runId: input.runId,
        ceiling: input.ceiling,
        spent: finiteNumber(input.spent),
        limit: finiteNumber(input.limit),
      };
    case "run-end":
      return {
        ...base,
        kind: "run-end",
        workflow: input.workflow,
        runId: input.runId,
        status: input.status,
        ...str("stopReason", input.stopReason),
        durationMs: positiveInt(input.durationMs),
        usage: usageFacts(input.usage),
        ...(typeof input.costUsd === "number" && Number.isFinite(input.costUsd)
          ? { costUsd: input.costUsd }
          : {}),
        models: [...new Set(input.models.filter((id) => typeof id === "string" && id !== ""))],
        steps: positiveInt(input.steps),
        parks: positiveInt(input.parks),
      };
  }
}

/**
 * Bucket a park's cause.
 *
 * The wording match for `produced-nothing` mirrors `workflow.ts`'s
 * `emptyStepError`, which is the only producer of that phrase. It is checked
 * first and regardless of `failureKind`, because the void gate reclassifies a
 * `done` step *after* the lane returned and therefore attaches no kind at all —
 * "produced nothing" is what the cause says, and it is what happened.
 *
 * @param failureKind - The step's `WorkflowFailureKind`, when it had one.
 * @param cause - The park's one-line cause text. Read here, never stored.
 */
export function parkCauseKind(failureKind: string | undefined, cause: string): ParkCauseKind {
  if (/\bproduced nothing\b/.test(cause)) return "produced-nothing";
  switch (failureKind) {
    case "turn-ceiling":
      return "turn-ceiling";
    // Its own bucket, never folded into `turn-ceiling`: they look alike (a
    // step that read and read) and the answer to them is opposite. A ceiling
    // says "this step needed more rope"; a stall says "more rope is exactly
    // what it does not need". A pipeline whose parks are mostly this one is a
    // pipeline with steps briefed too broadly to start.
    case "no-progress":
      return "no-progress";
    case "timeout":
      return "timeout";
    case "patch-refused":
      return "patch-refused";
    case "agent-error":
    case "config":
      return "agent-error";
    case "network":
    case "rateLimit":
    case "overloaded":
      return "network";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/**
 * Absolute path of the insights directory for a home root.
 *
 * @param home - User-scope root.
 */
export function insightsDir(home: string): string {
  return join(home, "insights");
}

/**
 * `~/.arcturn/insights/events.jsonl` — the live generation.
 *
 * @param home - User-scope root.
 */
export function insightsFile(home: string): string {
  return join(insightsDir(home), "events.jsonl");
}

/**
 * `~/.arcturn/insights/events.1.jsonl` — the one rotated generation kept.
 *
 * @param home - User-scope root.
 */
export function insightsRotatedFile(home: string): string {
  return join(insightsDir(home), "events.1.jsonl");
}

/**
 * An append-only ledger of failure-shaped events.
 *
 * `record` is fire-and-forget by contract: it never throws, never rejects and
 * never blocks the caller. A run must not be slowed — let alone failed — by a
 * diagnostic, so the whole write path is a queued side effect.
 */
export interface InsightsRecorder {
  /** `false` for the no-op recorder built when `insights: false`. */
  readonly enabled: boolean;
  /** Queue one event. Returns immediately; failures become a single warning. */
  record(event: InsightsEventInput): void;
  /** Resolve once every queued write has settled. Never rejects. */
  flush(): Promise<void>;
}

/** Options for {@link createInsightsRecorder}. */
export interface CreateInsightsRecorderOptions {
  /** User-scope root — `ArcturnPaths.home`. */
  home: string;
  /** `false` builds the no-op recorder. Defaults to `true`. */
  enabled?: boolean;
  /** Clock, injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Called at most once, with the first write failure. */
  onWarn?: (message: string) => void;
  /** Rotation threshold in bytes. Defaults to {@link INSIGHTS_ROTATE_BYTES}. */
  rotateBytes?: number;
}

/** The recorder handed out when insights are off: it touches nothing. */
const DISABLED_RECORDER: InsightsRecorder = {
  enabled: false,
  record: () => undefined,
  flush: () => Promise.resolve(),
};

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Open (or create, on first write) the insights ledger.
 *
 * Mirrors `audit.ts`'s write-queue: each `record` chains onto the previous
 * write through one promise, so two concurrent callers still produce two whole,
 * newline-terminated lines rather than a torn interleaving. The directory is
 * created lazily — a session that records nothing never touches disk.
 *
 * Rotation happens at the append that *would* cross `rotateBytes`: the live
 * file is renamed over `events.1.jsonl` (the previous generation is discarded)
 * and the new line starts a fresh file. One generation, no compaction, no
 * background work.
 *
 * @param options - Home root, enablement, clock and warning sink.
 */
export function createInsightsRecorder(options: CreateInsightsRecorderOptions): InsightsRecorder {
  if (options.enabled === false) return DISABLED_RECORDER;
  const now = options.now ?? Date.now;
  const rotateBytes = options.rotateBytes ?? INSIGHTS_ROTATE_BYTES;
  const file = insightsFile(options.home);
  const rotated = insightsRotatedFile(options.home);
  let queue: Promise<void> = Promise.resolve();
  let dirReady: Promise<void> | undefined;
  /** Bytes currently in the live file; `undefined` until the first append. */
  let bytes: number | undefined;
  let warned = false;

  const ensureDir = (): Promise<void> => {
    dirReady ??= mkdir(insightsDir(options.home), { recursive: true }).then(() => undefined);
    return dirReady;
  };

  return {
    enabled: true,
    record(event: InsightsEventInput): void {
      let line: string;
      try {
        line = `${JSON.stringify(stampEvent(event, now()))}\n`;
      } catch {
        // An un-serializable event is a bug in a hook site, never a run failure.
        return;
      }
      const size = Buffer.byteLength(line, "utf8");
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          try {
            await ensureDir();
            bytes ??= await fileSize(file);
            if (bytes > 0 && bytes + size > rotateBytes) {
              await rename(file, rotated);
              bytes = 0;
            }
            await appendFile(file, line, "utf8");
            bytes += size;
          } catch (error) {
            if (warned) return;
            warned = true;
            const detail = error instanceof Error ? error.message : String(error);
            options.onWarn?.(
              `the insights ledger could not be written (${detail}); ` +
                'this run is unaffected. Set "insights": false to stop trying.',
            );
          }
        });
    },
    flush(): Promise<void> {
      return queue.catch(() => undefined);
    },
  };
}

/**
 * The recorder plus the run coordinates a step-level hook needs.
 *
 * Threaded through `RuntimeRunStepOptions` rather than kept in a module global,
 * so two concurrent runs (`arcturn serve` hosts several) can never attribute
 * one run's silence to the other.
 */
export interface InsightsRunScope {
  readonly recorder: InsightsRecorder;
  readonly workflow: string;
  readonly runId: string;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Thrown when the ledger exists but cannot be read at all. */
export class InsightsError extends Error {}

/** Both generations, in append order, plus how many lines were unreadable. */
export interface InsightsLedger {
  readonly events: readonly InsightsEvent[];
  /** Lines that were not parseable JSON, or not a recognised event. */
  readonly skippedLines: number;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parseLine(line: string): InsightsEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !EVENT_KINDS.has(raw.kind)) return undefined;
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return undefined;
  return raw as unknown as InsightsEvent;
}

async function readGeneration(path: string): Promise<{ events: InsightsEvent[]; skipped: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { events: [], skipped: 0 };
    throw new InsightsError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const events: InsightsEvent[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseLine(line);
    if (parsed === undefined) skipped += 1;
    else events.push(parsed);
  }
  return { events, skipped };
}

/**
 * Read both generations of the ledger, oldest first.
 *
 * A ledger that does not exist reads back as empty — nothing recorded is not an
 * error. An individual unparseable line is skipped and counted (a torn final
 * append is normal for a file being written live); only a file that cannot be
 * read at all raises {@link InsightsError}.
 *
 * @param home - User-scope root.
 */
export async function readInsightsLedger(home: string): Promise<InsightsLedger> {
  const older = await readGeneration(insightsRotatedFile(home));
  const current = await readGeneration(insightsFile(home));
  return {
    events: [...older.events, ...current.events],
    skippedLines: older.skipped + current.skipped,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** One workflow to step to role bucket of parks. */
export interface ParkGroup {
  readonly workflow: string;
  readonly stepId: string;
  readonly role?: string;
  readonly count: number;
  /** The causeKind that accounts for the most parks in this bucket. */
  readonly causeKind: ParkCauseKind;
  /** Parks in this bucket whose cause was `produced-nothing`. */
  readonly producedNothing: number;
  /** Of those, how many had a silent turn recorded for the same run and step. */
  readonly producedNothingSilent: number;
}

/** Silent turns for one model. */
export interface SilentTurnGroup {
  readonly model: string;
  readonly count: number;
  readonly nudged: number;
  /** Nudged silences whose step later ended `done`. */
  readonly recovered: number;
  /** Nudged silences the ledger could judge at all (they have a later `step-end`). */
  readonly judged: number;
  /** `recovered / judged`, absent when nothing was judgeable. */
  readonly recoveryRate?: number;
}

/** A role's step-failure rate, over at least {@link MIN_ROLE_STEPS} steps. */
export interface RoleFailureRate {
  readonly role: string;
  readonly steps: number;
  readonly failed: number;
  readonly rate: number;
}

/** A role's median step duration. */
export interface RoleDuration {
  readonly role: string;
  readonly steps: number;
  readonly medianDurationMs: number;
}

/** Everything `arcturn insights` prints, and exactly what `--json` emits. */
export interface InsightsAggregate {
  readonly window: { readonly label: string; readonly sinceMs?: number };
  readonly workflow?: string;
  /** Events inside the window and filter. */
  readonly events: number;
  readonly skippedLines: number;
  readonly runs: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly medianDurationMs: number;
    readonly costUsd: number;
    /** `false` when at least one run had no priced cost — the total is a lower bound. */
    readonly costKnown: boolean;
    readonly tokens: number;
  };
  readonly parks: readonly ParkGroup[];
  /** Mid-run progress checks that fired, by role. */
  readonly progressWarnings: {
    readonly total: number;
    readonly byRole: readonly { readonly role: string; readonly count: number }[];
  };
  readonly silentTurns: readonly SilentTurnGroup[];
  readonly stepFailures: {
    readonly byFailureKind: readonly { readonly failureKind: string; readonly count: number }[];
    readonly byRole: readonly RoleFailureRate[];
  };
  readonly slowestRoles: readonly RoleDuration[];
}

/** A role needs this many recorded steps before its failure rate means anything. */
export const MIN_ROLE_STEPS = 3;

/** How many rows the slowest-roles section shows. */
const SLOWEST_ROLES_SHOWN = 5;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(value);
}

/** `runId stepId` — the key a silence and a terminal are correlated on. */
function stepKey(runId: string, stepId: string): string {
  return `${runId} ${stepId}`;
}

/** Options for {@link aggregateInsights}. */
export interface AggregateInsightsOptions {
  readonly window: StatsWindow;
  /** Keep only events belonging to this workflow. */
  readonly workflow?: string;
  /** Unreadable lines the reader skipped, carried onto the report. */
  readonly skippedLines?: number;
}

/**
 * Fold a ledger into the report.
 *
 * Pure: no clock, no filesystem. The window and the workflow filter are applied
 * first, so every count below is a count *within the filter* — including the
 * correlations, which is why a `--workflow` view never credits a recovery to a
 * step-end from another pipeline.
 *
 * @param events - Ledger lines, in append order.
 * @param options - Window, optional workflow filter, and the reader's skip count.
 */
export function aggregateInsights(
  events: readonly InsightsEvent[],
  options: AggregateInsightsOptions,
): InsightsAggregate {
  const sinceMs = options.window.sinceMs;
  const workflow = options.workflow;
  const inWindow = events.filter((event) => {
    if (sinceMs !== undefined && event.ts < sinceMs) return false;
    if (workflow === undefined) return true;
    // A silent turn recorded outside a workflow has no workflow to match, so a
    // `--workflow` view excludes it rather than guessing.
    return "workflow" in event && event.workflow === workflow;
  });

  // ------------------------------------------------------------------ runs
  const runEnds = inWindow.filter((e): e is RunEndRecord => e.kind === "run-end");
  const byStatus: Record<string, number> = {};
  let costUsd = 0;
  let costKnown = true;
  let tokens = 0;
  for (const run of runEnds) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    if (typeof run.costUsd === "number") costUsd += run.costUsd;
    else costKnown = false;
    tokens +=
      run.usage.inputTokens +
      run.usage.outputTokens +
      run.usage.cacheReadTokens +
      run.usage.cacheWriteTokens;
  }

  // ----------------------------------------------------------------- steps
  const stepEnds = inWindow.filter((e): e is StepEndRecord => e.kind === "step-end");
  /**
   * The terminal each step reached, by run+step. "Latest wins": a resumed step
   * supersedes the terminal the previous attempt wrote, exactly as the run
   * journal's own fold does.
   */
  const terminalOf = new Map<string, StepEndRecord>();
  for (const step of stepEnds) terminalOf.set(stepKey(step.runId, step.stepId), step);

  // ---------------------------------------------------------- silent turns
  const silences = inWindow.filter((e): e is SilentTurnRecord => e.kind === "silent-turn");
  const silentSteps = new Set<string>();
  for (const silence of silences) {
    if (silence.runId !== undefined && silence.stepId !== undefined) {
      silentSteps.add(stepKey(silence.runId, silence.stepId));
    }
  }
  const silentByModel = new Map<
    string,
    { count: number; nudged: number; recovered: number; judged: number }
  >();
  for (const silence of silences) {
    const row = silentByModel.get(silence.model) ?? {
      count: 0,
      nudged: 0,
      recovered: 0,
      judged: 0,
    };
    row.count += 1;
    if (silence.nudged) {
      row.nudged += 1;
      // APPROXIMATION, and deliberately a stated one. "Recovered" really means
      // "the model answered the nudge with something", which only the agent
      // loop sees. What the ledger can see is the step's own terminal, so a
      // nudged silence counts as recovered when the next `step-end` for that
      // run+step says `done`. It over-counts a step that recovered and then
      // failed for another reason, and under-counts a nudge that produced text
      // the void gate still rejected; over a hundred runs it is the right
      // shape, and it costs nothing.
      const terminal =
        silence.runId !== undefined && silence.stepId !== undefined
          ? terminalOf.get(stepKey(silence.runId, silence.stepId))
          : undefined;
      if (terminal !== undefined && terminal.ts >= silence.ts) {
        row.judged += 1;
        if (terminal.status === "done") row.recovered += 1;
      }
    }
    silentByModel.set(silence.model, row);
  }
  const silentTurns: SilentTurnGroup[] = [...silentByModel.entries()]
    .map(([model, row]) => ({
      model,
      count: row.count,
      nudged: row.nudged,
      recovered: row.recovered,
      judged: row.judged,
      ...(row.judged === 0 ? {} : { recoveryRate: row.recovered / row.judged }),
    }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  // ----------------------------------------------------------------- parks
  const parkRecords = inWindow.filter((e): e is ParkRecord => e.kind === "park");
  const parkBuckets = new Map<
    string,
    {
      workflow: string;
      stepId: string;
      role?: string;
      count: number;
      causes: Map<ParkCauseKind, number>;
      producedNothing: number;
      producedNothingSilent: number;
    }
  >();
  for (const park of parkRecords) {
    const key = `${park.workflow} ${park.stepId} ${park.role ?? ""}`;
    const bucket = parkBuckets.get(key) ?? {
      workflow: park.workflow,
      stepId: park.stepId,
      ...(park.role === undefined ? {} : { role: park.role }),
      count: 0,
      causes: new Map<ParkCauseKind, number>(),
      producedNothing: 0,
      producedNothingSilent: 0,
    };
    bucket.count += 1;
    bucket.causes.set(park.causeKind, (bucket.causes.get(park.causeKind) ?? 0) + 1);
    if (park.causeKind === "produced-nothing") {
      bucket.producedNothing += 1;
      if (silentSteps.has(stepKey(park.runId, park.stepId))) bucket.producedNothingSilent += 1;
    }
    parkBuckets.set(key, bucket);
  }
  const parks: ParkGroup[] = [...parkBuckets.values()]
    .map((bucket) => {
      const dominant = [...bucket.causes.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0];
      return {
        workflow: bucket.workflow,
        stepId: bucket.stepId,
        ...(bucket.role === undefined ? {} : { role: bucket.role }),
        count: bucket.count,
        causeKind: dominant?.[0] ?? ("other" as ParkCauseKind),
        producedNothing: bucket.producedNothing,
        producedNothingSilent: bucket.producedNothingSilent,
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.workflow.localeCompare(b.workflow) ||
        a.stepId.localeCompare(b.stepId),
    );

  // ---------------------------------------------------- progress warnings
  const warnings = inWindow.filter(
    (e): e is ProgressWarningRecord => e.kind === "progress-warning",
  );
  const warningsByRole = new Map<string, number>();
  for (const warning of warnings) {
    const role = warning.role ?? "(no role)";
    warningsByRole.set(role, (warningsByRole.get(role) ?? 0) + 1);
  }
  const progressWarnings = {
    total: warnings.length,
    byRole: [...warningsByRole.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role)),
  };

  // ---------------------------------------------------------- step failures
  const kindCounts = new Map<string, number>();
  const roleStats = new Map<string, { steps: number; failed: number; durations: number[] }>();
  for (const step of stepEnds) {
    if (step.status === "failed" && step.failureKind !== undefined) {
      kindCounts.set(step.failureKind, (kindCounts.get(step.failureKind) ?? 0) + 1);
    }
    if (step.role === undefined) continue;
    const row = roleStats.get(step.role) ?? { steps: 0, failed: 0, durations: [] };
    row.steps += 1;
    if (step.status === "failed") row.failed += 1;
    if (step.durationMs > 0) row.durations.push(step.durationMs);
    roleStats.set(step.role, row);
  }
  const byFailureKind = [...kindCounts.entries()]
    .map(([failureKind, count]) => ({ failureKind, count }))
    .sort((a, b) => b.count - a.count || a.failureKind.localeCompare(b.failureKind));
  const byRole: RoleFailureRate[] = [...roleStats.entries()]
    .filter(([, row]) => row.steps >= MIN_ROLE_STEPS && row.failed > 0)
    .map(([role, row]) => ({
      role,
      steps: row.steps,
      failed: row.failed,
      rate: row.failed / row.steps,
    }))
    .sort((a, b) => b.rate - a.rate || a.role.localeCompare(b.role));

  // --------------------------------------------------------- slowest roles
  const slowestRoles: RoleDuration[] = [...roleStats.entries()]
    .filter(([, row]) => row.durations.length > 0)
    .map(([role, row]) => ({
      role,
      steps: row.durations.length,
      medianDurationMs: median(row.durations),
    }))
    .sort((a, b) => b.medianDurationMs - a.medianDurationMs || a.role.localeCompare(b.role))
    .slice(0, SLOWEST_ROLES_SHOWN);

  return {
    window: {
      label: options.window.label,
      ...(options.window.sinceMs === undefined ? {} : { sinceMs: options.window.sinceMs }),
    },
    ...(workflow === undefined ? {} : { workflow }),
    events: inWindow.length,
    skippedLines: options.skippedLines ?? 0,
    runs: {
      total: runEnds.length,
      byStatus,
      medianDurationMs: median(runEnds.map((run) => run.durationMs)),
      costUsd,
      costKnown: runEnds.length === 0 ? true : costKnown,
      tokens,
    },
    parks,
    progressWarnings,
    silentTurns,
    stepFailures: { byFailureKind, byRole },
    slowestRoles,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function windowLabel(window: InsightsAggregate["window"]): string {
  if (window.sinceMs === undefined) return "all time";
  return `last ${window.label} (since ${new Date(window.sinceMs).toISOString().slice(0, 10)})`;
}

/**
 * Render the aggregate as the report `arcturn insights` and `/insights` print.
 *
 * Every section is omitted when it has nothing to say, so a fresh install shows
 * one honest line rather than five empty tables.
 *
 * @param report - Aggregate from {@link aggregateInsights}.
 * @param glyphs - Glyph set; the ASCII set is used on terminals that need it.
 */
export function renderInsights(
  report: InsightsAggregate,
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  const scope = report.workflow === undefined ? "" : ` ${glyphs.dot} workflow ${report.workflow}`;
  const lines: string[] = [`Insights — ${windowLabel(report.window)}${scope}`];

  if (report.events === 0) {
    lines.push(
      "",
      report.skippedLines > 0
        ? `Nothing readable in this window (${report.skippedLines} unreadable line${
            report.skippedLines === 1 ? "" : "s"
          } skipped).`
        : "Nothing recorded in this window. Run a workflow, or widen --since.",
    );
    return lines;
  }
  if (report.skippedLines > 0) {
    lines.push(
      `${report.skippedLines} unreadable line${report.skippedLines === 1 ? "" : "s"} skipped.`,
    );
  }

  // 1 ------------------------------------------------------------------ runs
  if (report.runs.total > 0) {
    const statuses = Object.entries(report.runs.byStatus)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([status, count]) => `${status} ${count}`)
      .join(` ${glyphs.dot} `);
    lines.push("", `Runs (${report.runs.total})`);
    lines.push(`  status          ${statuses}`);
    lines.push(`  median duration ${formatDuration(report.runs.medianDurationMs)}`);
    lines.push(
      `  spend           ${formatCost(report.runs.costUsd)}` +
        `${report.runs.costKnown ? "" : " (lower bound; some runs unpriced)"} ` +
        `${glyphs.dot} ${formatTokens(report.runs.tokens)} tokens`,
    );
  }

  // 2 ----------------------------------------------------------------- parks
  if (report.parks.length > 0) {
    const total = report.parks.reduce((n, group) => n + group.count, 0);
    lines.push("", `Parks (${total})`);
    const rows = report.parks.map((group) => [
      group.workflow,
      group.stepId,
      group.role === undefined ? "-" : `@${group.role}`,
      String(group.count),
      group.causeKind,
      group.producedNothing === 0
        ? "-"
        : `${group.producedNothingSilent}/${group.producedNothing} silent`,
    ]);
    for (const line of pad(
      ["workflow", "step", "role", "parks", "cause", "produced-nothing"],
      rows,
    )) {
      lines.push(`  ${line}`);
    }
  }

  // 2b ------------------------------------------------- progress warnings
  if (report.progressWarnings.total > 0) {
    lines.push("", `Progress warnings (${report.progressWarnings.total})`);
    lines.push(
      `  ${report.progressWarnings.byRole
        .map((row) => `${row.role === "(no role)" ? row.role : `@${row.role}`} ${row.count}`)
        .join(` ${glyphs.dot} `)}`,
    );
  }

  // 3 ---------------------------------------------------------- silent turns
  if (report.silentTurns.length > 0) {
    const total = report.silentTurns.reduce((n, row) => n + row.count, 0);
    lines.push("", `Silent turns (${total})`);
    const rows = report.silentTurns.map((row) => [
      row.model,
      String(row.count),
      String(row.nudged),
      row.recoveryRate === undefined
        ? "-"
        : `${row.recovered}/${row.judged} (${percent(row.recoveryRate)})`,
    ]);
    for (const line of pad(["model", "silences", "nudged", "recovered"], rows)) {
      lines.push(`  ${line}`);
    }
  }

  // 4 --------------------------------------------------------- step failures
  if (report.stepFailures.byFailureKind.length > 0 || report.stepFailures.byRole.length > 0) {
    lines.push("", "Step failures");
    if (report.stepFailures.byFailureKind.length > 0) {
      lines.push(
        `  ${report.stepFailures.byFailureKind
          .map((row) => `${row.failureKind} ${row.count}`)
          .join(` ${glyphs.dot} `)}`,
      );
    }
    if (report.stepFailures.byRole.length > 0) {
      lines.push(`  by role (min ${MIN_ROLE_STEPS} steps)`);
      const rows = report.stepFailures.byRole.map((row) => [
        `@${row.role}`,
        `${row.failed}/${row.steps}`,
        percent(row.rate),
      ]);
      for (const line of pad(["role", "failed", "rate"], rows)) lines.push(`    ${line}`);
    }
  }

  // 5 --------------------------------------------------------- slowest roles
  if (report.slowestRoles.length > 0) {
    lines.push("", "Slowest roles (median step)");
    const rows = report.slowestRoles.map((row) => [
      `@${row.role}`,
      formatDuration(row.medianDurationMs),
      `${row.steps} step${row.steps === 1 ? "" : "s"}`,
    ]);
    for (const line of pad(["role", "median", "n"], rows)) lines.push(`  ${line}`);
  }

  return lines;
}

/**
 * Serialize the aggregate for `--json`.
 *
 * @param report - Aggregate from {@link aggregateInsights}.
 */
export function formatInsightsJson(report: InsightsAggregate): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// --share
// ---------------------------------------------------------------------------

/** The one-line statement printed above every shared block. */
export const INSIGHTS_PRIVACY_STATEMENT =
  "Contains model ids, workflow/step/role names and counts; " +
  "no prompts, reasoning, paths or content.";

/** Where `--share` points. Nothing is ever posted for you. */
const ISSUE_URL = "https://github.com/sitharaj88/arcturn/issues/new";

/** Hard ceiling on the generated URL, so no browser or proxy truncates it silently. */
export const SHARE_URL_MAX_BYTES = 8 * 1024;

function issueUrl(title: string, body: string): string {
  return `${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * Render the shareable form: a markdown block, the privacy statement, and a
 * pre-filled GitHub issue URL.
 *
 * **Nothing is sent.** The command prints a link; opening it is a human
 * gesture, and the issue body is visible in the terminal before it is.
 *
 * The body is truncated — from the end, marking the cut — until the whole URL
 * fits {@link SHARE_URL_MAX_BYTES}, because a URL a browser silently clips is
 * worse than a short one that says it was clipped.
 *
 * @param report - Aggregate from {@link aggregateInsights}.
 * @param glyphs - Glyph set for the embedded report.
 */
export function renderInsightsShare(
  report: InsightsAggregate,
  glyphs: GlyphSet = FANCY_GLYPHS,
): string[] {
  const title = `insights: ${windowLabel(report.window)}`;
  const block = renderInsights(report, glyphs).join("\n");
  const fence = "```";
  const markdown = [
    `## Arcturn insights — ${windowLabel(report.window)}`,
    "",
    `_${INSIGHTS_PRIVACY_STATEMENT}_`,
    "",
    `${fence}text`,
    block,
    fence,
  ].join("\n");

  let body = markdown;
  while (
    Buffer.byteLength(issueUrl(title, body), "utf8") > SHARE_URL_MAX_BYTES &&
    body.length > 0
  ) {
    // Shrink by a tenth each pass: percent-encoding expands unpredictably, so
    // measure the real URL rather than guessing a character budget.
    const keep = Math.max(0, Math.floor(body.length * 0.9) - 32);
    body = `${body.slice(0, keep)}\n... (truncated)\n${fence}`;
    if (keep === 0) break;
  }

  return [
    ...markdown.split("\n"),
    "",
    "Nothing was sent. To report this, open the pre-filled issue yourself:",
    issueUrl(title, body),
  ];
}

// ---------------------------------------------------------------------------
// `arcturn insights` (top level)
// ---------------------------------------------------------------------------

/** Options for {@link runInsightsCommand}. */
export interface RunInsightsCommandOptions {
  /** User-scope root. Resolved from `env`/`$ARCTURN_HOME` when omitted. */
  home?: string;
  /** Environment used to resolve the home directory and terminal capability. */
  env?: EnvMap;
  /** `"7d"`, `"30d"`, `"all"`, ... Defaults to `"7d"`. */
  since?: string;
  /** Restrict the report to one workflow by name. */
  workflow?: string;
  /** Print the aggregate as one JSON object. */
  json?: boolean;
  /** Print the markdown block plus a pre-filled issue URL. Sends nothing. */
  share?: boolean;
  /** Clock reference, for deterministic tests. */
  now?: number;
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: (chunk: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: (chunk: string) => void;
}

/**
 * `arcturn insights` — what has been going wrong, from the local ledger.
 *
 * @param options - Home, window, filters and output sinks.
 * @returns Exit code: `0` on success, `1` when the ledger cannot be read at
 *   all, `2` on a malformed `--since`.
 */
export async function runInsightsCommand(options: RunInsightsCommandOptions = {}): Promise<number> {
  const out = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));
  const env = options.env ?? process.env;

  let window: StatsWindow;
  try {
    window = resolveWindow(options.since, options.now ?? Date.now());
  } catch (error) {
    if (!(error instanceof StatsError)) throw error;
    err(`arcturn: ${error.message}\n`);
    return 2;
  }

  const home = options.home ?? resolveArcturnPaths({ env }).home;
  let ledger: InsightsLedger;
  try {
    ledger = await readInsightsLedger(home);
  } catch (error) {
    err(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const report = aggregateInsights(ledger.events, {
    window,
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    skippedLines: ledger.skippedLines,
  });
  if (options.json === true) {
    out(`${formatInsightsJson(report)}\n`);
    return 0;
  }
  const glyphs = supportsUnicode(env) ? FANCY_GLYPHS : ASCII_GLYPHS;
  const lines =
    options.share === true ? renderInsightsShare(report, glyphs) : renderInsights(report, glyphs);
  out(`${lines.join("\n")}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// `/insights` (slash command)
// ---------------------------------------------------------------------------

/** What {@link parseInsightsArgs} understood. */
export interface ParsedInsightsArgs {
  since?: string;
  workflow?: string;
  json: boolean;
  share: boolean;
}

/**
 * Parse `[--since <window>] [--workflow <name>] [--json] [--share]`.
 *
 * One parser for the slash command and the top-level verb, so `/insights` and
 * `arcturn insights` cannot drift.
 *
 * @param argv - Tokens after the command word.
 */
export function parseInsightsArgs(argv: readonly string[]): ParsedInsightsArgs {
  let since: string | undefined;
  let workflow: string | undefined;
  let json = false;
  let share = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") json = true;
    else if (token === "--share") share = true;
    else if (token === "--since") since = argv[++i];
    else if (token?.startsWith("--since=")) since = token.slice("--since=".length);
    else if (token === "--workflow") workflow = argv[++i];
    else if (token?.startsWith("--workflow=")) workflow = token.slice("--workflow=".length);
  }
  return {
    ...(since === undefined ? {} : { since }),
    ...(workflow === undefined ? {} : { workflow }),
    json,
    share,
  };
}

/**
 * The `/insights` slash command — the same report as `arcturn insights`, over
 * the running session's home directory.
 *
 * Usage: `/insights [--since 7d|30d|all] [--workflow <name>] [--json] [--share]`.
 * `--share` prints a markdown block and a pre-filled GitHub issue URL; it never
 * sends anything anywhere.
 */
export function createInsightsCommands(): SlashCommand[] {
  return [
    {
      name: "insights",
      description:
        "What has been going wrong: parks, silent turns, step failures, slow roles; " +
        "also: --since <window>, --workflow <name>, --json, --share (prints a link, sends nothing)",
      source: "built-in",
      async run({ runtime, ui, args }) {
        const parsed = parseInsightsArgs(args.split(/\s+/).filter((token) => token.length > 0));
        let window: StatsWindow;
        try {
          window = resolveWindow(parsed.since);
        } catch (error) {
          ui.notice("error", error instanceof Error ? error.message : String(error));
          return;
        }
        const paths = runtime.paths as ArcturnPaths;
        let ledger: InsightsLedger;
        try {
          ledger = await readInsightsLedger(paths.home);
        } catch (error) {
          ui.notice("error", error instanceof Error ? error.message : String(error));
          return;
        }
        const report = aggregateInsights(ledger.events, {
          window,
          ...(parsed.workflow === undefined ? {} : { workflow: parsed.workflow }),
          skippedLines: ledger.skippedLines,
        });
        if (parsed.json) {
          ui.print(formatInsightsJson(report));
          return;
        }
        ui.print(parsed.share ? renderInsightsShare(report) : renderInsights(report));
      },
    },
  ];
}
