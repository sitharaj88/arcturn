/**
 * AGENT TEAMS — a supervisor that decomposes one goal, dispatches specialists
 * in parallel, and reconciles their work.
 *
 * Arcturn already had two ways to spend a second agent: `subagent` (one-shot,
 * synchronous, answers a question) and `/bg` (fire-and-forget, durable, runs
 * a whole task off-thread). Neither is *orchestration*: several agents moving
 * one goal forward at once, and someone responsible for putting the pieces
 * back together. That is what this module adds.
 *
 * ## The shape of a team run
 *
 * 1. **Decompose.** One supervisor turn asks the model to split the goal into
 *    2–5 subtasks, each with an explicit, *disjoint* file scope.
 * 2. **Validate the plan — this is the whole feature.** A supervisor that
 *    splits a task badly produces three agents fighting over the same file,
 *    and the merge step then has to choose whose work to lose. So a plan is
 *    never dispatched until its scopes are provably disjoint: overlapping
 *    subtasks trigger exactly one re-ask with the conflicts spelled out, and
 *    if the second plan still overlaps the colliding subtasks are **merged
 *    into one member** ({@link repairTeamPlan}) rather than dispatched.
 *    Merging loses parallelism; dispatching an overlapping plan loses work.
 * 3. **Dispatch.** One agent per subtask, each rooted in its own
 *    `git worktree add --detach` checkout (reusing `scouts.ts`'s
 *    {@link createWorktree}, the isolation primitive this feature is built
 *    on), bounded by a concurrency cap and a per-team cost/turn ceiling.
 * 4. **Capture.** When a member settles, its `git diff` is written to a
 *    **patch file on disk** and its worktree is destroyed in a `finally`.
 *    The patch — not the worktree — is the durable work product, which is why
 *    a crash, a cancel or a conflict can never lose a member's output.
 * 5. **Reconcile.** `/team merge` replays those patches into the user's tree
 *    with `git apply`, one member at a time, checking each before applying.
 *
 * ## Conflict policy: surface, never guess
 *
 * `git apply` is used **without** `--3way` and **never** with `--force`. It
 * refuses a patch whose context does not match, so it cannot clobber. On the
 * first refusal the merge **stops**, reports which members landed and which
 * did not, and points at the still-present patch file. Arcturn does not attempt a
 * clever auto-merge and does not write conflict markers into the user's tree:
 * the user chooses (`git apply --3way <patch>`, re-run the member, or
 * `/team discard`). Members already applied stay applied and are recorded as
 * merged, so re-running `/team merge` resumes instead of double-applying.
 *
 * ## Why the caller supplies `plan` and `spawn`
 *
 * {@link TeamManager} never imports `ArcturnRuntime`. It takes a
 * {@link TeamPlanner} (goal in, raw model text out) and a {@link TeamSpawn}
 * (subtask + worktree in, something satisfying {@link TeamAgent} out) — the
 * same structural trick `scouts.ts` uses. A real `Agent` satisfies
 * {@link TeamAgent} as-is, so production wiring is a one-liner, while the
 * tests drive planning, validation, dispatch, budgets, cancellation, merge
 * conflicts and crash recovery with a scripted `LLMClient`, fake agents and a
 * fake `git`, touching neither the network nor this repository.
 *
 * See `INTEGRATION-team.md` for the single registration site.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { calculateCostUsd } from "@arcturn/ai";
import { contentText, createSessionId, DEFAULT_READ_ONLY_TOOLS, errorText } from "@arcturn/core";
import type { AgentEvent, ModelSpec, Tool, Usage } from "@arcturn/types";
import type { AgentDef } from "./agents.js";
import type { CommandContext, CommandUi, SlashCommand } from "./commands.js";
import { formatCost, formatCostTotal, formatDuration, oneLine } from "./format.js";
import { isProcessAlive } from "./process-liveness.js";
import type { ArcturnRuntime } from "./runtime.js";
import { createWorktree, type ExecFn, type GitExecResult, type Worktree } from "./scouts.js";

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------ constants

/** Team members running at once by default; the rest queue. */
export const DEFAULT_TEAM_CONCURRENCY = 3;

/** Default per-team spend ceiling in USD. Exceeding it cancels the whole team. */
export const DEFAULT_TEAM_MAX_COST_USD = 5;

/** Default turn ceiling for one member. */
export const DEFAULT_TEAM_MAX_TURNS = 40;

/** Most subtasks a plan may contain. Beyond this the plan is re-asked. */
export const MAX_TEAM_MEMBERS = 5;

/** Fewest subtasks a plan may contain before it is re-asked. */
export const MIN_TEAM_MEMBERS = 2;

/** Per-`git`-spawn timeout in milliseconds. */
const GIT_TIMEOUT_MS = 15_000;

/** Output cap for bookkeeping git calls. */
const SMALL_MAX_BUFFER = 256 * 1024;

/** Output cap for a captured `git diff`. */
const DIFF_MAX_BUFFER = 8 * 1024 * 1024;

const defaultExecFn: ExecFn = (command, args, options) =>
  execFileAsync(command, [...args], { ...options, windowsHide: true });

function messageOf(error: unknown): string {
  return errorText(error);
}

function stderrOf(error: unknown): string {
  const value = (error as { stderr?: unknown } | undefined)?.stderr;
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------- roles

/** A named specialist a team member can be given. */
export interface TeamRole {
  /** Lowercase role name, e.g. `"reviewer"`. */
  readonly name: string;
  /** One-line summary, shown to the supervisor when it picks roles. */
  readonly description: string;
  /** Role instructions prepended to the member's prompt. */
  readonly systemPrompt: string;
  /**
   * Tool names this role may use. `undefined` means "no narrowing" — the
   * member gets whatever the host's spawn function hands it.
   */
  readonly tools?: readonly string[];
  /** `true` when {@link TeamRole.tools} contains no mutating tool. */
  readonly readOnly: boolean;
}

const READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(DEFAULT_READ_ONLY_TOOLS);

function roleReadOnly(tools: readonly string[] | undefined): boolean {
  if (tools === undefined) return false;
  return tools.every((name) => READ_ONLY_TOOL_SET.has(name));
}

/**
 * The roles Arcturn ships with.
 *
 * `reviewer` is deliberately **read-only**: a reviewer that can edit stops
 * being a second opinion and becomes a fourth author racing the others for
 * the same lines. A project can still override any of these with a markdown
 * agent of the same name (see {@link resolveTeamRole}).
 */
export const BUILT_IN_TEAM_ROLES: ReadonlyMap<string, TeamRole> = new Map<string, TeamRole>([
  [
    "implementer",
    {
      name: "implementer",
      description: "Writes the production change for one file scope.",
      systemPrompt:
        "You are the implementer on this subtask. Write the smallest correct change that " +
        "satisfies it, in the files you own and nowhere else. Match the surrounding style.",
      readOnly: false,
    },
  ],
  [
    "tester",
    {
      name: "tester",
      description: "Writes and runs tests for one file scope.",
      systemPrompt:
        "You are the tester on this subtask. Write tests that would fail without the change " +
        "and pass with it, in the test files you own. Do not edit production code to make a " +
        "test pass — report the problem instead.",
      readOnly: false,
    },
  ],
  [
    "reviewer",
    {
      name: "reviewer",
      description: "Reads and critiques; cannot modify anything (read-only tools).",
      systemPrompt:
        "You are the reviewer on this subtask. You have read-only tools: you cannot modify " +
        "anything, and you should not try. Report concrete findings with file paths and line " +
        "numbers, worst first, and say plainly when you found nothing.",
      tools: [...DEFAULT_READ_ONLY_TOOLS],
      readOnly: true,
    },
  ],
  [
    "documenter",
    {
      name: "documenter",
      description: "Writes docs and comments for one file scope.",
      systemPrompt:
        "You are the documenter on this subtask. Update the prose and doc comments in the " +
        "files you own so they describe what the code actually does. Do not change behaviour.",
      readOnly: false,
    },
  ],
]);

/** Role assigned when a plan names none, or names one nobody can resolve. */
export const DEFAULT_TEAM_ROLE_NAME = "implementer";

/**
 * Adapt a markdown agent definition (`.arcturn/agents/<name>.md`) into a role.
 *
 * Reuses the existing named-agent mechanism rather than inventing a second
 * one: whatever `runtime.agents` holds is already a system prompt plus an
 * optional tool narrowing, which is exactly a role.
 *
 * @param def - The loaded agent definition.
 */
export function teamRoleFromAgentDef(def: AgentDef): TeamRole {
  return {
    name: def.name,
    description: def.description || `Named agent from ${def.source}.`,
    systemPrompt: def.systemPrompt,
    ...(def.tools === undefined ? {} : { tools: [...def.tools] }),
    readOnly: roleReadOnly(def.tools),
  };
}

/**
 * Resolve a role name to a {@link TeamRole}.
 *
 * A host-supplied role (typically built from `runtime.agents`) wins over a
 * built-in of the same name, so a project can redefine `reviewer` without
 * touching Arcturn.
 *
 * @param name - Role name; matched case-insensitively.
 * @param extra - Host roles, e.g. from `runtime.agents`.
 * @returns The role, or `undefined` when the name is unknown.
 */
export function resolveTeamRole(
  name: string,
  extra?: ReadonlyMap<string, TeamRole>,
): TeamRole | undefined {
  const key = name.trim().toLowerCase();
  if (key === "") return undefined;
  return extra?.get(key) ?? BUILT_IN_TEAM_ROLES.get(key);
}

/** Every role name a team may use, host roles first. */
function knownRoleNames(extra?: ReadonlyMap<string, TeamRole>): string[] {
  const names = new Set<string>(extra ? [...extra.keys()] : []);
  for (const name of BUILT_IN_TEAM_ROLES.keys()) names.add(name);
  return [...names];
}

// -------------------------------------------------------------- decomposition

/** One subtask of a decomposed goal. */
export interface TeamSubtask {
  /** Stable slug identifying the member that will run this subtask. */
  id: string;
  /** Short label for status display. */
  title: string;
  /** Role name; resolved through {@link resolveTeamRole}. */
  role: string;
  /** The full task handed to the member. */
  task: string;
  /** Declared file scope: paths or globs this subtask is allowed to touch. */
  files: string[];
}

/** A validated decomposition of one goal. */
export interface TeamPlan {
  /** The goal the user asked for. */
  goal: string;
  /** Disjoint subtasks, in dispatch order. */
  subtasks: TeamSubtask[];
  /** The supervisor's own notes about the split, when it offered any. */
  notes?: string;
}

/** Outcome of {@link parseTeamPlan}. */
export type TeamPlanParseResult =
  | { ok: true; subtasks: TeamSubtask[]; notes?: string }
  | { ok: false; error: string };

/** The system prompt for the supervisor's decomposition turn. */
export const TEAM_PLAN_SYSTEM_PROMPT: string = [
  "You are the supervisor of a team of coding agents. You do not write code.",
  "Your single job is to split one goal into subtasks that can run AT THE SAME TIME,",
  "in separate copies of the repository, without any of them needing to see the others.",
  "",
  "The hard constraint: FILE SCOPES MUST BE DISJOINT. Two subtasks that touch the same",
  "file will produce two conflicting edits to it and one of them will have to be thrown",
  "away. If a piece of work cannot be split without sharing a file, put all of it in ONE",
  "subtask — a smaller team that merges cleanly beats a larger one that does not.",
  "",
  "Answer with JSON only. No prose, no code fence, no explanation outside the JSON.",
].join("\n");

/** Everything {@link TeamPlanner} needs to produce a decomposition. */
export interface TeamPlanRequest {
  /** The user's goal, verbatim. */
  goal: string;
  /** Role names the plan may assign. */
  roles: readonly string[];
  /** Role names the user pinned with `--roles`, in order, when they did. */
  requestedRoles?: readonly string[];
  /** Fewest subtasks the plan may contain. */
  minMembers: number;
  /** Most subtasks the plan may contain. */
  maxMembers: number;
  /**
   * Why the previous attempt was rejected. Present only on the single re-ask;
   * a planner should feed it back to the model verbatim.
   */
  previousError?: string;
  /** Cancels the supervisor turn. */
  signal?: AbortSignal;
}

/**
 * Produces the supervisor's raw decomposition text.
 *
 * Wired in production to one `llm.complete()` call (see
 * {@link getTeamManager}); a test hands back a fixed string.
 */
export type TeamPlanner = (request: TeamPlanRequest) => Promise<string>;

/**
 * Render the decomposition prompt.
 *
 * The prompt demands an explicit `files` scope per subtask, because
 * {@link validateTeamPlan} cannot prove disjointness without one — a subtask
 * that declines to say what it will touch is treated as claiming everything.
 *
 * @param request - Goal, roles and bounds; plus the rejection text on a re-ask.
 */
export function buildDecompositionPrompt(request: TeamPlanRequest): string {
  const lines: string[] = [];
  if (request.previousError !== undefined) {
    lines.push(
      "Your previous plan was REJECTED and is being re-asked exactly once.",
      `Reason: ${request.previousError}`,
      "Fix it. If you cannot make the scopes disjoint, return FEWER subtasks.",
      "",
    );
  }
  lines.push(
    `Goal: ${request.goal}`,
    "",
    `Split it into ${request.minMembers}–${request.maxMembers} subtasks that can run in parallel.`,
    `Available roles: ${request.roles.join(", ")}.`,
  );
  if (request.requestedRoles && request.requestedRoles.length > 0) {
    lines.push(
      `The user asked for these roles, in this order: ${request.requestedRoles.join(", ")}. ` +
        "Assign them in that order where it makes sense.",
    );
  }
  lines.push(
    "",
    "Rules:",
    "- Every subtask MUST list the files or globs it will touch in `files`.",
    "- No two subtasks may list the same file, or globs that could match the same file.",
    "- A subtask must be completable without reading another subtask's output.",
    "- Prefer fewer, cleanly separated subtasks over more, overlapping ones.",
    "",
    "Reply with exactly this JSON shape:",
    "{",
    '  "subtasks": [',
    "    {",
    '      "id": "short-slug",',
    '      "title": "five words or fewer",',
    `      "role": "one of: ${request.roles.join(" | ")}",`,
    '      "task": "the complete instruction for this member, including how to verify it",',
    '      "files": ["path/or/glob", "..."]',
    "    }",
    "  ],",
    '  "notes": "optional: anything the supervisor should know when merging"',
    "}",
  );
  return lines.join("\n");
}

/** Turn arbitrary text into a stable `[a-z0-9-]` id fragment. */
function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
}

/**
 * Extract the first balanced JSON value from a model reply.
 *
 * Models fence their JSON, preface it with "Here's the plan:", or both. This
 * finds the first `{` or `[` and scans to its match, respecting strings and
 * escapes, so trailing prose does not break the parse.
 */
function extractJson(raw: string): string | undefined {
  const fence = /```(?:json|jsonc)?\s*\r?\n([\s\S]*?)```/i.exec(raw);
  const text = fence?.[1] ?? raw;
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Read a `files`-ish field, accepting an array, a single string, or nothing. */
function asScopeList(entry: Record<string, unknown>): string[] {
  const raw = entry.files ?? entry.paths ?? entry.scope ?? entry.fileScope;
  const values: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const scopes: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const part of value.split(",")) {
      const scope = normalizeScope(part);
      if (scope !== "" && !scopes.includes(scope)) scopes.push(scope);
    }
  }
  return scopes;
}

/**
 * Parse the supervisor's reply into subtasks.
 *
 * Tolerant of fences, prose and key aliases (`subtasks` / `members` / `tasks`,
 * `files` / `paths` / `scope`), because the alternative is burning a whole
 * re-ask on a formatting nit. Intolerant of anything that would change what
 * gets dispatched: a subtask with no `task` text is a parse failure, not a
 * subtask with an empty prompt.
 *
 * @param raw - The model's reply.
 * @returns Subtasks with normalized, de-duplicated ids and scopes, or an error.
 */
export function parseTeamPlan(raw: string): TeamPlanParseResult {
  const json = extractJson(raw);
  if (json === undefined) {
    return { ok: false, error: "the reply contained no JSON object or array" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `the JSON did not parse (${messageOf(error)})` };
  }

  const root = asRecord(parsed);
  const listValue = Array.isArray(parsed)
    ? parsed
    : (root?.subtasks ?? root?.members ?? root?.tasks ?? root?.plan);
  if (!Array.isArray(listValue)) {
    return { ok: false, error: 'the JSON has no "subtasks" array' };
  }
  if (listValue.length === 0) {
    return { ok: false, error: 'the "subtasks" array is empty' };
  }

  const subtasks: TeamSubtask[] = [];
  const seen = new Set<string>();
  for (const [index, item] of listValue.entries()) {
    const entry = asRecord(item);
    if (!entry) {
      return { ok: false, error: `subtask ${index + 1} is not an object` };
    }
    const task = asString(entry.task) ?? asString(entry.description) ?? asString(entry.prompt);
    if (task === undefined) {
      return { ok: false, error: `subtask ${index + 1} has no "task" text` };
    }
    const title = asString(entry.title) ?? asString(entry.name) ?? oneLine(task, 48);
    let id = slugify(asString(entry.id) ?? title, `member-${index + 1}`);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    subtasks.push({
      id,
      title,
      role: (asString(entry.role) ?? asString(entry.agent) ?? DEFAULT_TEAM_ROLE_NAME).toLowerCase(),
      task,
      files: asScopeList(entry),
    });
  }

  const notes = root === undefined ? undefined : asString(root.notes);
  return { ok: true, subtasks, ...(notes === undefined ? {} : { notes }) };
}

// ------------------------------------------------------------ scope validation

/**
 * Normalise one scope entry into a comparable relative path.
 *
 * @param raw - A path or glob as the model wrote it.
 * @returns A `/`-separated relative path with no leading `./` or `/` and no
 *   trailing slash; the empty string when there was nothing left.
 */
export function normalizeScope(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * The literal directory prefix a scope can never escape.
 *
 * `packages/cli/src/*.ts` → `packages/cli/src`; `packages/**` → `packages`;
 * `**\/*.ts` → `""`, meaning "could be anywhere".
 */
function scopePrefix(scope: string): string {
  const wildcard = scope.search(/[*?[{]/);
  if (wildcard === -1) return scope;
  const head = scope.slice(0, wildcard);
  const slash = head.lastIndexOf("/");
  return slash === -1 ? "" : head.slice(0, slash);
}

function isPathPrefix(prefix: string, path: string): boolean {
  return prefix === "" || prefix === path || path.startsWith(`${prefix}/`);
}

/**
 * Whether two declared scopes could name the same file.
 *
 * Deliberately conservative — it compares the literal prefixes either side of
 * the first wildcard, so `src/**` and `src/a.ts` collide and `src/a.ts` and
 * `src/b.ts` do not. A false positive costs one merged member; a false
 * negative costs a member's work at merge time.
 *
 * @param a - First scope, already {@link normalizeScope}d.
 * @param b - Second scope, already {@link normalizeScope}d.
 */
export function scopesOverlap(a: string, b: string): boolean {
  const left = scopePrefix(a);
  const right = scopePrefix(b);
  return isPathPrefix(left, right) || isPathPrefix(right, left);
}

/** Two subtasks whose declared scopes collide. */
export interface ScopeConflict {
  /** Id of the earlier subtask. */
  a: string;
  /** Id of the later subtask. */
  b: string;
  /** The colliding scope pairs, rendered as `"<a-scope> ↔ <b-scope>"`. */
  paths: string[];
}

/** Why a plan cannot be dispatched as written. */
export type TeamPlanIssue =
  | { kind: "too-few"; count: number; min: number }
  | { kind: "too-many"; count: number; max: number }
  | { kind: "unscoped"; ids: string[] }
  | { kind: "overlap"; conflicts: ScopeConflict[] }
  | { kind: "unknown-role"; ids: string[]; roles: string[] };

/** Outcome of {@link validateTeamPlan}. */
export interface TeamPlanValidation {
  /** `true` when the plan may be dispatched as written. */
  ok: boolean;
  /** Everything wrong with it, in reporting order. */
  issues: TeamPlanIssue[];
}

/** Options for {@link validateTeamPlan}. */
export interface ValidateTeamPlanOptions {
  /** Fewest subtasks. Default {@link MIN_TEAM_MEMBERS}. */
  minMembers?: number;
  /** Most subtasks. Default {@link MAX_TEAM_MEMBERS}. */
  maxMembers?: number;
  /** Role names that resolve; an unknown role is an issue. */
  roles?: readonly string[];
}

/** Render one issue as the sentence fed back to the model on the re-ask. */
export function describeTeamPlanIssue(issue: TeamPlanIssue): string {
  switch (issue.kind) {
    case "too-few":
      return `you returned ${issue.count} subtask(s); at least ${issue.min} are needed`;
    case "too-many":
      return `you returned ${issue.count} subtasks; at most ${issue.max} are allowed`;
    case "unscoped":
      return `these subtasks declared no files, so their scopes cannot be checked: ${issue.ids.join(", ")}`;
    case "overlap":
      return `these subtasks claim overlapping files: ${issue.conflicts
        .map((conflict) => `${conflict.a} ↔ ${conflict.b} (${conflict.paths.join("; ")})`)
        .join(" · ")}`;
    case "unknown-role":
      return `these subtasks name unknown roles: ${issue.ids.join(", ")} (valid roles: ${issue.roles.join(", ")})`;
  }
}

/**
 * Check that a decomposition is safe to dispatch.
 *
 * The load-bearing check is `overlap`: two members editing the same file in
 * two worktrees produce two patches that cannot both be applied, and the merge
 * step would then have to pick a loser. A subtask that declared no scope at
 * all is reported as `unscoped` rather than waved through, because "it did not
 * say" and "it will not touch anything" are not the same claim.
 *
 * @param subtasks - Parsed subtasks.
 * @param options - Bounds and the valid role names.
 */
export function validateTeamPlan(
  subtasks: readonly TeamSubtask[],
  options?: ValidateTeamPlanOptions,
): TeamPlanValidation {
  const min = options?.minMembers ?? MIN_TEAM_MEMBERS;
  const max = options?.maxMembers ?? MAX_TEAM_MEMBERS;
  const issues: TeamPlanIssue[] = [];

  if (subtasks.length < min) issues.push({ kind: "too-few", count: subtasks.length, min });
  if (subtasks.length > max) issues.push({ kind: "too-many", count: subtasks.length, max });

  const unscoped = subtasks.filter((task) => task.files.length === 0).map((task) => task.id);
  if (unscoped.length > 0) issues.push({ kind: "unscoped", ids: unscoped });

  const conflicts: ScopeConflict[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    const left = subtasks[i];
    if (!left) continue;
    for (let j = i + 1; j < subtasks.length; j++) {
      const right = subtasks[j];
      if (!right) continue;
      const paths: string[] = [];
      for (const a of left.files) {
        for (const b of right.files) {
          if (scopesOverlap(a, b)) paths.push(`${a} ↔ ${b}`);
        }
      }
      if (paths.length > 0) conflicts.push({ a: left.id, b: right.id, paths });
    }
  }
  if (conflicts.length > 0) issues.push({ kind: "overlap", conflicts });

  if (options?.roles && options.roles.length > 0) {
    const valid = new Set(options.roles.map((role) => role.toLowerCase()));
    const bad = subtasks.filter((task) => !valid.has(task.role)).map((task) => task.id);
    if (bad.length > 0) issues.push({ kind: "unknown-role", ids: bad, roles: [...options.roles] });
  }

  return { ok: issues.length === 0, issues };
}

/** Outcome of {@link repairTeamPlan}. */
export interface TeamPlanRepair {
  /** The dispatchable subtasks. */
  subtasks: TeamSubtask[];
  /** Human-readable description of every change made. */
  changes: string[];
}

/**
 * Make an invalid plan dispatchable **without dropping any of its work**.
 *
 * The repair is the last resort, applied only after the single re-ask already
 * failed. It does three things, all of them unions rather than deletions:
 *
 * - subtasks with overlapping scopes are merged, transitively, into one member
 *   (their tasks are concatenated and their scopes unioned) — one agent doing
 *   two things beats two agents fighting over one file;
 * - a subtask that declared no scope is treated as claiming everything, so it
 *   merges with the rest rather than being dispatched unbounded;
 * - an over-long plan has its tail folded into the last allowed member.
 *
 * A repair can legitimately collapse a plan to a single member. That is the
 * honest answer to "this goal does not decompose", and the caller reports it.
 *
 * @param subtasks - The rejected subtasks.
 * @param options - `maxMembers` bound; defaults to {@link MAX_TEAM_MEMBERS}.
 */
export function repairTeamPlan(
  subtasks: readonly TeamSubtask[],
  options?: { maxMembers?: number },
): TeamPlanRepair {
  const max = options?.maxMembers ?? MAX_TEAM_MEMBERS;
  const changes: string[] = [];
  if (subtasks.length === 0) return { subtasks: [], changes };

  // An unscoped subtask claims everything; "**" overlaps every other scope.
  const working = subtasks.map((task) => {
    if (task.files.length > 0) return { ...task, files: [...task.files] };
    changes.push(`"${task.id}" declared no file scope and was treated as claiming everything`);
    return { ...task, files: ["**"] };
  });

  // Union-find over the overlap graph, so A↔B and B↔C collapse into one member.
  const parent = working.map((_task, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };
  for (let i = 0; i < working.length; i++) {
    for (let j = i + 1; j < working.length; j++) {
      const left = working[i];
      const right = working[j];
      if (!left || !right) continue;
      if (left.files.some((a) => right.files.some((b) => scopesOverlap(a, b)))) union(i, j);
    }
  }

  const groups = new Map<number, TeamSubtask[]>();
  for (const [index, task] of working.entries()) {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(task);
    else groups.set(root, [task]);
  }

  let merged = [...groups.values()].map((group) => mergeSubtaskGroup(group, changes));

  if (merged.length > max) {
    const head = merged.slice(0, max - 1);
    const tail = merged.slice(max - 1);
    changes.push(
      `folded ${tail.length} trailing subtasks into one member to stay within ${max} members`,
    );
    merged = [...head, mergeSubtaskGroup(tail, changes)];
  }

  return { subtasks: merged, changes };
}

function mergeSubtaskGroup(group: readonly TeamSubtask[], changes: string[]): TeamSubtask {
  const first = group[0];
  if (!first) throw new Error("mergeSubtaskGroup: empty group");
  if (group.length === 1) return first;
  changes.push(
    `merged ${group.map((task) => `"${task.id}"`).join(", ")} into one member — ` +
      "their file scopes overlapped, so running them in parallel would have collided",
  );
  const files: string[] = [];
  for (const task of group) {
    for (const scope of task.files) if (!files.includes(scope)) files.push(scope);
  }
  return {
    id: first.id,
    title: `${first.title} (+${group.length - 1} merged)`,
    role: first.role,
    task: group
      .map((task, index) => `Part ${index + 1} — ${task.title}:\n${task.task}`)
      .join("\n\n"),
    files,
  };
}

// -------------------------------------------------------------------- members

/** Everything {@link TeamSpawn} needs to build one member's agent. */
export interface TeamMemberBrief {
  /** Member id, unique within the team. */
  readonly id: string;
  /** The team this member belongs to. */
  readonly teamId: string;
  /** Short label. */
  readonly title: string;
  /** The subtask text. */
  readonly task: string;
  /** The resolved role, including its tool narrowing. */
  readonly role: TeamRole;
  /** The member's declared file scope. */
  readonly files: readonly string[];
  /** The team's overall goal, for context. */
  readonly goal: string;
  /** Turn ceiling the host should give this member's agent. */
  readonly maxTurns: number;
}

/**
 * The subset of `@arcturn/core`'s `Agent` a team member needs.
 *
 * Structural on purpose, exactly like `scouts.ts`'s `ScoutAgent`: a real
 * `Agent` satisfies it without adaptation, and a test can implement it in ten
 * lines.
 */
export interface TeamAgent {
  /** Run the member's subtask to completion (or until {@link TeamAgent.abort}). */
  prompt(input: string): Promise<void>;
  /** Abort the in-flight run; called on cancel, on budget cutoff, on turn cap. */
  abort(): void;
  /** Text of the last assistant message — the member's report. */
  finalText(): string;
  /**
   * Subscribe to the agent's events, used for cost, turn and tool accounting.
   *
   * @param listener - Receives every event.
   * @returns An unsubscribe function.
   */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Session id, when the host's agent has one, for `/resume`-style follow-up. */
  readonly sessionId?: string;
}

/**
 * Builds the agent for one member, rooted at its worktree.
 *
 * @param brief - The member being dispatched.
 * @param cwd - The member's isolated worktree directory.
 */
export type TeamSpawn = (brief: TeamMemberBrief, cwd: string) => TeamAgent | Promise<TeamAgent>;

/**
 * Render the prompt handed to one member.
 *
 * The role's instructions are folded into the *prompt* rather than the system
 * prompt because `ArcturnRuntime.buildSessionAgent` — the only factory that roots
 * an agent at an arbitrary `cwd` with its own checkpoint store — does not take
 * a system-prompt override. `INTEGRATION-team.md` §3 describes the six-line
 * runtime addition that would move it where it belongs; nothing here depends
 * on that happening.
 *
 * @param brief - The member being dispatched.
 */
export function buildMemberPrompt(brief: TeamMemberBrief): string {
  const scope =
    brief.files.length === 0
      ? ["  (no scope was declared — stay as narrow as you can)"]
      : brief.files.map((file) => `  - ${file}`);
  return [
    `Role instructions (${brief.role.name}):`,
    brief.role.systemPrompt,
    "",
    `Team goal: ${brief.goal}`,
    "",
    `Your subtask — ${brief.title}:`,
    brief.task,
    "",
    "Files you own. Do not create or edit anything outside this scope:",
    ...scope,
    "",
    "You are in an isolated git worktree. Your teammates are working other parts of this",
    "goal in their own worktrees at the same time: you cannot see their changes and they",
    "cannot see yours. Do not wait for them, do not coordinate with them, and do not fix",
    "problems outside your scope — describe those in your final answer instead.",
    "",
    "Nobody can answer questions for you. Finish with a short report: what you changed,",
    "which files, how you verified it, and anything the supervisor needs in order to merge.",
  ].join("\n");
}

// --------------------------------------------------------------------- status

/** Lifecycle of one team member. */
export type TeamMemberStatusValue =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Lifecycle of a team.
 *
 * `review` is the interesting one: every member has settled and its patch is
 * on disk, but nothing has touched the user's tree yet. A team sits in
 * `review` until `/team merge` or `/team discard`.
 */
export type TeamStatusValue =
  | "planning"
  | "running"
  | "review"
  | "merged"
  | "discarded"
  | "cancelled"
  | "failed"
  | "interrupted";

/** File/line counts derived from a member's captured diff. */
export interface DiffStat {
  /** Number of `diff --git` file headers. */
  files: number;
  /** Added lines. */
  added: number;
  /** Removed lines. */
  removed: number;
}

/** A snapshot of one member's progress and outcome. */
export interface TeamMemberStatus {
  /** Member id, unique within the team. */
  readonly id: string;
  /** Owning team id. */
  readonly teamId: string;
  /** Short label. */
  readonly title: string;
  /** Role name. */
  readonly role: string;
  /** The subtask text. */
  readonly task: string;
  /** Declared file scope. */
  readonly files: readonly string[];
  readonly status: TeamMemberStatusValue;
  /** Session id of the member's agent, once spawned. */
  readonly sessionId?: string;
  /** The member's worktree, while it still exists. */
  readonly worktreeDir?: string;
  /** Absolute path of the captured patch — the durable work product. */
  readonly patchFile?: string;
  /** Size of the captured diff. */
  readonly diffStat: DiffStat;
  /** `true` once the patch has been applied to the user's tree. */
  readonly merged: boolean;
  /** `true` once the user threw this member's work away. */
  readonly discarded: boolean;
  /**
   * USD cost of this member's turns that could be priced.
   *
   * A floor, not a bill, whenever {@link TeamMemberStatus.unpricedTurns} is
   * non-zero.
   */
  readonly costUsd: number;
  /**
   * Turns this member ran on a model nobody could price.
   *
   * The team's spend reaches the session through `recordExternalCost`, so
   * flattening an unknown to `0` here would put a fabricated "free" into
   * `/cost` and the footer by way of `/team`.
   */
  readonly unpricedTurns: number;
  /** Turns the member completed. */
  readonly turns: number;
  /** Tool calls the member made. */
  readonly toolCalls: number;
  /** Wall time from dispatch to settle, in ms. */
  readonly elapsedMs: number;
  /** The member's final report. */
  readonly finalText?: string;
  /** Failure text when `status` is `"failed"`, or the reason on a cancel. */
  readonly error?: string;
}

/** A snapshot of one team. */
export interface TeamStatus {
  /** Short id, e.g. `team-a1b2c3d4`. */
  readonly id: string;
  /** The goal the user asked for. */
  readonly goal: string;
  /** Roles the user pinned with `--roles`, when they did. */
  readonly roles: readonly string[];
  readonly status: TeamStatusValue;
  /** Supervisor notes from the accepted plan. */
  readonly notes?: string;
  readonly createdAt: number;
  /** Wall time since dispatch, in ms. */
  readonly elapsedMs: number;
  /** Summed member cost in USD, counting only turns that could be priced. */
  readonly costUsd: number;
  /** Summed member turns that could not be priced; non-zero makes `costUsd` a floor. */
  readonly unpricedTurns: number;
  /** Members, in dispatch order. */
  readonly members: readonly TeamMemberStatus[];
  /** Non-fatal problems: plan repairs, failed cleanups, budget cutoffs. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------- persistence

interface StoredMember {
  id: string;
  title: string;
  role: string;
  task: string;
  files: string[];
  status: TeamMemberStatusValue;
  sessionId?: string;
  worktreeDir?: string;
  patchFile?: string;
  diffStat: DiffStat;
  merged: boolean;
  discarded: boolean;
  costUsd: number;
  /** Optional: records written before unpriced turns were tracked have none. */
  unpricedTurns?: number;
  turns: number;
  toolCalls: number;
  startedAt?: number;
  endedAt?: number;
  finalText?: string;
  error?: string;
}

interface StoredTeam {
  id: string;
  goal: string;
  roles: string[];
  status: TeamStatusValue;
  notes?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  warnings: string[];
  members: StoredMember[];
  /**
   * Set while a process owns this team; cleared once {@link TeamManager.recover}
   * has salvaged and torn down its worktrees. A record loaded with this still
   * set belongs to a process that died — unless {@link StoredTeam.ownerPid}
   * says otherwise.
   */
  needsRecovery?: boolean;
  /**
   * The pid of the process that started this team, while it owns it.
   *
   * `~/.arcturn` is shared: `arcturn serve` and a terminal session run side by
   * side over the same records directory. Without this, *constructing* a
   * manager in the second process rewrote every still-`running` record to
   * `interrupted` and marked it recoverable — and the next `recover()` (which
   * `start`, `merge` and `discard` all await) captured a half-written diff and
   * tore down the worktrees the *live* team was still editing.
   *
   * So a record names its owner, and a loader that finds that owner alive
   * leaves the record alone. Absent (a record written before this existed) is
   * read as "gone", which is the pre-existing behaviour and the safe default
   * for the case this was always right about: a process that really did die.
   */
  ownerPid?: number;
}

/** State for a team this process is actively running. */
interface LiveTeam {
  controller: AbortController;
  agents: Map<string, TeamAgent>;
  worktrees: Map<string, Worktree>;
  cutoffReason?: string;
  /** Resolves when the team is cut short (cancel, cost ceiling). */
  cutoff: Promise<void>;
  /** Resolves {@link LiveTeam.cutoff}; idempotent. */
  fireCutoff: () => void;
  settled: Promise<void>;
}

// -------------------------------------------------------------------- results

/** What happened to one member during a merge. */
export interface TeamMergeOutcome {
  /** Member id. */
  memberId: string;
  /** Member label. */
  title: string;
  /** Outcome kind; see {@link TeamMergeReport}. */
  result: "merged" | "already-merged" | "empty" | "conflict" | "skipped" | "discarded" | "failed";
  /** Why the member failed, when `result` is `"failed"`. */
  failure?: string;
  /** The patch that was (or would have been) applied. */
  patchFile?: string;
  /** `git apply`'s complaint, when `result` is `"conflict"`. */
  conflict?: string;
  /** Size of this member's diff. */
  stat: DiffStat;
}

/** The outcome of one {@link TeamManager.merge} call. */
export interface TeamMergeReport {
  /** The team merged. */
  teamId: string;
  /** One entry per member, in dispatch order. */
  outcomes: TeamMergeOutcome[];
  /** How many patches landed in the user's tree this call. */
  merged: number;
  /** How many refused to apply. */
  conflicts: number;
  /** `true` when nothing is left to merge. */
  complete: boolean;
  /** Non-fatal problems. */
  warnings: string[];
}

/** What {@link TeamManager.recover} salvaged from a dead process. */
export interface TeamRecoveryReport {
  /** Teams whose records were corrected from `running` to `interrupted`. */
  teams: string[];
  /** `"<teamId>/<memberId>"` for every member whose diff was rescued to a patch. */
  salvaged: string[];
  /** Worktree directories removed. */
  removedWorktrees: string[];
  /** Non-fatal problems. */
  warnings: string[];
}

// -------------------------------------------------------------------- manager

/** Construction options for {@link TeamManager}. */
export interface TeamManagerOptions {
  /** Directory team records, patches and worktrees live under. Created if missing. */
  dir: string;
  /** Repository the members' worktrees branch from, and merges apply to. */
  repoRoot: string;
  /** Produces the supervisor's decomposition text. */
  plan: TeamPlanner;
  /** Builds one member's agent, rooted at its worktree. */
  spawn: TeamSpawn;
  /** Host roles (e.g. from `runtime.agents`), keyed by lowercase name. */
  roles?: ReadonlyMap<string, TeamRole>;
  /** Members running at once. Default {@link DEFAULT_TEAM_CONCURRENCY}. */
  concurrency?: number;
  /** Per-team USD ceiling. Default {@link DEFAULT_TEAM_MAX_COST_USD}; `0` disables. */
  maxCostUsd?: number;
  /** Per-member turn ceiling. Default {@link DEFAULT_TEAM_MAX_TURNS}. */
  maxTurnsPerMember?: number;
  /** Most members a plan may produce. Default {@link MAX_TEAM_MEMBERS}. */
  maxMembers?: number;
  /** Fewest members a plan may produce. Default {@link MIN_TEAM_MEMBERS}. */
  minMembers?: number;
  /**
   * Prices a turn when the provider did not. Default: `usage.costUsd`.
   *
   * Return `undefined` when the turn cannot be priced at all — the manager
   * counts it rather than billing it at zero, so nothing downstream reports an
   * unpriced model as free.
   */
  costOf?: (usage: Usage) => number | undefined;
  /** Injectable process spawner, shared by worktrees, diffs and merges. */
  execFn?: ExecFn;
  /** Per-`git`-spawn timeout in ms. Default `15000`. */
  gitTimeoutMs?: number;
  /** Clock override, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Does a pid name a live process? Defaults to a `kill(pid, 0)` probe.
   *
   * Used to tell a record left behind by a dead process from one another
   * *living* process (`arcturn serve` beside a terminal) is still working in —
   * see {@link StoredTeam.ownerPid}.
   */
  isProcessAlive?: (pid: number) => boolean;
  /** This process's own pid, stamped on the teams it starts. For tests. */
  ownerPid?: number;
}

/** Options for {@link TeamManager.start}. */
export interface StartTeamOptions {
  /** Roles to pin, in order; the supervisor is told to prefer them. */
  roles?: readonly string[];
  /** Override the member cap for this run. */
  maxMembers?: number;
  /** Override the cost ceiling for this run. */
  maxCostUsd?: number;
  /** Override the concurrency cap for this run. */
  concurrency?: number;
  /** Cancels planning and every member; see {@link TeamManager.cancel}. */
  signal?: AbortSignal;
}

/** Summarize a unified diff into file/line counts. */
function statOf(diff: string | undefined): DiffStat {
  const stat: DiffStat = { files: 0, added: 0, removed: 0 };
  if (!diff) return stat;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) stat.files++;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) stat.added++;
    else if (line.startsWith("-")) stat.removed++;
  }
  return stat;
}

/**
 * Whether a member that finished produced nothing: no text AND no file.
 *
 * The team's copy of the workflow engine's `stepProducedNothing`, opened by
 * the same fault — a `done` nobody had checked against evidence. Either half
 * alone is a result: a member that changed a file but said nothing has a
 * patch to merge, and one that changed nothing but said why is the honest
 * "no changes" that {@link TeamManager.merge} reports as `empty`. Only the
 * intersection, no words *and* no file, is nothing.
 *
 * The file half is asked of what git saw in the worktree, never of the agent:
 * `patchFile` is written only from a non-empty captured diff and `diffStat`
 * is counted from that same diff.
 *
 * @param member - The member, after its final text and diff were captured.
 */
function memberProducedNothing(member: StoredMember): boolean {
  return (
    (member.finalText ?? "").trim() === "" &&
    (member.patchFile === undefined || member.diffStat.files === 0)
  );
}

/**
 * The message an empty member fails with — see {@link memberProducedNothing}.
 *
 * Written to be read by whoever finds the report: it names what was expected
 * (a file, or failing that a reason), what came back (neither), and the two
 * levers that work — run the team again, or ask the member for less.
 *
 * @param memberId - The member that produced nothing.
 */
function emptyMemberError(memberId: string): string {
  return (
    `member "${memberId}" produced nothing — no file was changed and no text was returned. ` +
    "A member that reports neither a result nor a reason has not run; run the team again, " +
    "or narrow what it was asked to do."
  );
}

/**
 * Decomposes a goal, runs one agent per subtask in its own worktree, and
 * reconciles the results.
 *
 * Durability mirrors `background-agents.ts`: every record is written
 * synchronously to `<dir>/records` on each status change and re-read
 * synchronously at construction. A record still `running` when a fresh manager
 * loads it belongs to a process that is gone, so it is corrected to
 * `interrupted` — and, unlike a background agent, it may own worktrees, which
 * {@link TeamManager.recover} salvages (capturing each surviving worktree's
 * diff to a patch) and then tears down. Recovery is idempotent: running it
 * twice, or against worktrees git has already forgotten, is a no-op.
 */
export class TeamManager {
  readonly #dir: string;
  readonly #recordsDir: string;
  readonly #teamsDir: string;
  readonly #worktreesDir: string;
  readonly #repoRoot: string;
  readonly #plan: TeamPlanner;
  readonly #maxMembers: number;
  readonly #minMembers: number;
  readonly #maxTurnsPerMember: number;
  readonly #gitTimeoutMs: number;
  readonly #now: () => number;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #ownerPid: number;

  #spawn: TeamSpawn;
  #roles: ReadonlyMap<string, TeamRole>;
  #concurrency: number;
  #maxCostUsd: number;
  #costOf: (usage: Usage) => number | undefined;
  #execFn: ExecFn;

  readonly #records = new Map<string, StoredTeam>();
  readonly #order: string[] = [];
  readonly #live = new Map<string, LiveTeam>();
  readonly #listeners = new Set<(status: TeamStatus) => void>();
  #recovery: Promise<TeamRecoveryReport> | undefined;

  constructor(options: TeamManagerOptions) {
    this.#dir = options.dir;
    this.#recordsDir = join(options.dir, "records");
    this.#teamsDir = join(options.dir, "patches");
    this.#worktreesDir = join(options.dir, "worktrees");
    this.#repoRoot = options.repoRoot;
    this.#plan = options.plan;
    this.#spawn = options.spawn;
    this.#roles = options.roles ?? new Map();
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_TEAM_CONCURRENCY));
    this.#maxCostUsd = Math.max(0, options.maxCostUsd ?? DEFAULT_TEAM_MAX_COST_USD);
    this.#maxTurnsPerMember = Math.max(
      1,
      Math.floor(options.maxTurnsPerMember ?? DEFAULT_TEAM_MAX_TURNS),
    );
    this.#maxMembers = Math.max(1, Math.floor(options.maxMembers ?? MAX_TEAM_MEMBERS));
    this.#minMembers = Math.max(1, Math.floor(options.minMembers ?? MIN_TEAM_MEMBERS));
    this.#costOf = options.costOf ?? ((usage) => usage.costUsd);
    this.#execFn = options.execFn ?? defaultExecFn;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#isProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.#ownerPid = options.ownerPid ?? process.pid;
    mkdirSync(this.#recordsDir, { recursive: true });
    mkdirSync(this.#teamsDir, { recursive: true });
    this.#load();
  }

  /** Where this manager keeps records, patches and worktrees. */
  get dir(): string {
    return this.#dir;
  }

  /** Role names a plan may assign, host roles first. */
  get roleNames(): string[] {
    return knownRoleNames(this.#roles);
  }

  /**
   * Refresh what future teams are built from.
   *
   * Cheap; a host holding one manager across a session (see
   * {@link getTeamManager}) calls this whenever its own defaults may have
   * moved — a `/model` switch, a newly attached MCP server.
   *
   * @param defaults - Any subset of the mutable defaults.
   */
  setDefaults(defaults: {
    spawn?: TeamSpawn;
    roles?: ReadonlyMap<string, TeamRole>;
    concurrency?: number;
    maxCostUsd?: number;
    costOf?: (usage: Usage) => number | undefined;
    execFn?: ExecFn;
  }): void {
    if (defaults.spawn) this.#spawn = defaults.spawn;
    if (defaults.roles) this.#roles = defaults.roles;
    if (defaults.concurrency !== undefined) {
      this.#concurrency = Math.max(1, Math.floor(defaults.concurrency));
    }
    if (defaults.maxCostUsd !== undefined) this.#maxCostUsd = Math.max(0, defaults.maxCostUsd);
    if (defaults.costOf) this.#costOf = defaults.costOf;
    if (defaults.execFn) this.#execFn = defaults.execFn;
  }

  /** Every team this manager knows about, newest first. */
  list(): TeamStatus[] {
    return this.#order
      .map((id) => this.#records.get(id))
      .filter((record): record is StoredTeam => record !== undefined)
      .map((record) => this.#toStatus(record))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * One team's current status.
   *
   * @param id - Team id.
   * @returns `undefined` for an unknown id.
   */
  get(id: string): TeamStatus | undefined {
    const record = this.#records.get(id);
    return record ? this.#toStatus(record) : undefined;
  }

  /** The most recently created team, or `undefined` when there are none. */
  latest(): TeamStatus | undefined {
    return this.list()[0];
  }

  /**
   * Subscribe to team snapshots, emitted on every plan and member transition.
   *
   * @param listener - Receives the whole team snapshot each time.
   * @returns An unsubscribe function.
   */
  onUpdate(listener: (status: TeamStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Decompose a goal, dispatch one agent per subtask into its own worktree,
   * and resolve once every member has settled and its patch is on disk.
   *
   * Planning takes at most **two** supervisor turns: the first ask, and one
   * re-ask if the plan failed to parse or claimed overlapping file scopes. If
   * the second plan is still unusable it is repaired by merging the colliding
   * subtasks ({@link repairTeamPlan}) — never dispatched as-is, and never
   * silently truncated.
   *
   * @param goal - What the team should achieve.
   * @param options - Role pins and per-run budget overrides.
   * @returns The team's final status; check `status` for `review` (ready to
   *   merge), `failed` (planning never produced a usable plan) or `cancelled`.
   * @throws When `goal` is empty.
   */
  async start(goal: string, options?: StartTeamOptions): Promise<TeamStatus> {
    const trimmed = goal.trim();
    if (trimmed === "") throw new Error("goal must be a non-empty string");
    await this.recover();

    const roles = (options?.roles ?? []).map((role) => role.trim().toLowerCase()).filter(Boolean);
    const record: StoredTeam = {
      id: this.#newId(),
      goal: trimmed,
      roles,
      status: "planning",
      createdAt: this.#now(),
      startedAt: this.#now(),
      warnings: [],
      members: [],
      needsRecovery: true,
      ownerPid: this.#ownerPid,
    };
    this.#records.set(record.id, record);
    this.#order.push(record.id);
    this.#persist(record);
    this.#emit(record);

    const maxMembers = Math.max(1, Math.floor(options?.maxMembers ?? this.#maxMembers));
    const planned = await this.#decompose(record, roles, maxMembers, options?.signal);
    if (!planned) {
      record.status = "failed";
      record.endedAt = this.#now();
      record.needsRecovery = false;
      this.#persist(record);
      this.#emit(record);
      return this.#toStatus(record);
    }

    record.members = planned.subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.title,
      role: subtask.role,
      task: subtask.task,
      files: [...subtask.files],
      status: "queued",
      diffStat: { files: 0, added: 0, removed: 0 },
      merged: false,
      discarded: false,
      costUsd: 0,
      unpricedTurns: 0,
      turns: 0,
      toolCalls: 0,
    }));
    if (planned.notes !== undefined) record.notes = planned.notes;
    record.status = "running";
    this.#persist(record);
    this.#emit(record);

    await this.#dispatch(record, options);
    return this.#toStatus(record);
  }

  /**
   * Cancel a team: aborts every live member (which cascades through
   * `@arcturn/core`'s loop, appending synthetic tool results so no call is
   * left dangling), skips every queued member, captures whatever each member
   * had written as a patch, and removes every worktree.
   *
   * @param id - Team id.
   * @returns `false` for an unknown id or one that already settled; `true`
   *   once cancellation has been initiated. Await the promise from
   *   {@link TeamManager.start}, or {@link TeamManager.settled}, to observe it.
   */
  cancel(id: string): boolean {
    const record = this.#records.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "planning") return false;
    const live = this.#live.get(id);
    if (!live) {
      // Planning, or a record this process does not own: mark it and let the
      // owning `start()` (if any) observe the aborted controller.
      record.status = "cancelled";
      record.endedAt = this.#now();
      this.#persist(record);
      this.#emit(record);
      return true;
    }
    live.controller.abort();
    return true;
  }

  /**
   * Resolve once a team this process is running has settled.
   *
   * @param id - Team id.
   * @returns The final status, immediately when the team is not live.
   */
  async settled(id: string): Promise<TeamStatus | undefined> {
    const live = this.#live.get(id);
    if (live) await live.settled;
    return this.get(id);
  }

  /**
   * Apply members' patches to the user's working tree, one at a time.
   *
   * Each patch is checked with `git apply --check` before it is applied, and
   * `git apply` is used **without** `--3way` and **without** `--force`: it
   * refuses a patch whose context does not match rather than overwriting, so
   * a merge can fail but cannot clobber. The first refusal **stops the merge**
   * and is reported with the offending member and git's own complaint; members
   * applied before it stay applied and are recorded as merged, so a later
   * `/team merge` resumes rather than double-applying.
   *
   * Nothing is deleted on conflict. The patch file stays on disk, so the user
   * can resolve it however they like (`git apply --3way <patch>`, re-run the
   * member, or discard it).
   *
   * @param id - Team id.
   * @param options - `members` limits the merge to specific member ids.
   * @returns Per-member outcomes; `undefined` for an unknown team.
   */
  async merge(
    id: string,
    options?: { members?: readonly string[] },
  ): Promise<TeamMergeReport | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    await this.recover();

    const only = options?.members ? new Set(options.members) : undefined;
    const report: TeamMergeReport = {
      teamId: id,
      outcomes: [],
      merged: 0,
      conflicts: 0,
      complete: false,
      warnings: [],
    };
    let stopped = false;

    for (const member of record.members) {
      if (stopped) {
        report.outcomes.push({
          memberId: member.id,
          title: member.title,
          result: "skipped",
          stat: member.diffStat,
          ...(member.patchFile === undefined ? {} : { patchFile: member.patchFile }),
        });
        continue;
      }
      const base = { memberId: member.id, title: member.title, stat: member.diffStat };
      if (member.discarded) {
        report.outcomes.push({ ...base, result: "discarded" });
        continue;
      }
      if (member.merged) {
        report.outcomes.push({ ...base, result: "already-merged" });
        continue;
      }
      if (only && !only.has(member.id)) {
        report.outcomes.push({ ...base, result: "skipped" });
        continue;
      }
      if (!member.patchFile || member.diffStat.files === 0) {
        // "No changes" and "never got to make changes" are different news. A
        // member that FAILED — its worktree never came up, its agent threw —
        // must not be folded into "empty": that is how a team whose member
        // died on a loaded machine reported itself merged-and-complete, and
        // the record lied. The flake that exposed this was a `git worktree
        // add` killed by a timeout on a busy CI mac.
        if (member.status === "failed") {
          report.outcomes.push({
            ...base,
            result: "failed",
            ...(member.error === undefined ? {} : { failure: member.error }),
          });
          continue;
        }
        report.outcomes.push({ ...base, result: "empty" });
        continue;
      }

      const applied = await this.#applyPatch(member.patchFile);
      if (!applied.ok) {
        member.error = `merge conflict: ${applied.error}`;
        this.#persist(record);
        report.outcomes.push({
          ...base,
          result: "conflict",
          patchFile: member.patchFile,
          conflict: applied.error,
        });
        report.conflicts++;
        // Stop: every later patch was cut against the same base, so applying
        // them over a half-merged tree is exactly the "clever auto-merge" this
        // module refuses to attempt.
        stopped = true;
        continue;
      }
      member.merged = true;
      member.error = undefined;
      this.#persist(record);
      report.outcomes.push({ ...base, result: "merged", patchFile: member.patchFile });
      report.merged++;
      this.#emit(record);
    }

    report.complete = record.members.every(
      (member) =>
        member.merged ||
        member.discarded ||
        // Zero files is completeness only for a member that RAN and changed
        // nothing (or was cancelled before starting). A failed member's zero
        // is absence of evidence, and a team is not "merged" while one of its
        // members' work never existed to merge.
        (member.diffStat.files === 0 && member.status !== "failed"),
    );
    const mergeable: readonly TeamStatusValue[] = ["review", "cancelled", "interrupted"];
    if (report.complete && mergeable.includes(record.status)) {
      record.status = "merged";
      record.endedAt = this.#now();
    }
    this.#persist(record);
    this.#emit(record);
    return report;
  }

  /**
   * Throw away a team's (or specific members') work: deletes the captured
   * patches and removes any worktree still standing.
   *
   * Deliberately explicit — nothing else in this module deletes a patch, so
   * `discard` is the only way a member's output leaves the disk.
   *
   * @param id - Team id.
   * @param options - `members` limits the discard to specific member ids.
   * @returns The updated status; `undefined` for an unknown team.
   */
  async discard(
    id: string,
    options?: { members?: readonly string[] },
  ): Promise<TeamStatus | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    const only = options?.members ? new Set(options.members) : undefined;

    for (const member of record.members) {
      if (only && !only.has(member.id)) continue;
      if (member.worktreeDir) {
        const removed = await this.#removeWorktreeDir(member.worktreeDir);
        if (removed.warning) record.warnings.push(removed.warning);
        member.worktreeDir = undefined;
      }
      if (member.patchFile) {
        try {
          rmSync(member.patchFile, { force: true });
        } catch {
          // A patch we cannot delete is a cosmetic problem, not a failure.
        }
        member.patchFile = undefined;
      }
      member.discarded = true;
      member.merged = false;
    }

    if (record.members.every((member) => member.discarded)) {
      record.status = "discarded";
      record.endedAt ??= this.#now();
    }
    if (!only) {
      await this.#cleanupTeamWorktrees(record.id);
      record.needsRecovery = false;
    }
    this.#persist(record);
    this.#emit(record);
    return this.#toStatus(record);
  }

  /**
   * Salvage and tear down anything a dead process left behind.
   *
   * For every record that was still `running` when this manager loaded it:
   * each member's surviving worktree has its diff captured to a patch file
   * (so a crash costs no work) and is then removed, and `git worktree prune`
   * clears any administrative entry whose directory is already gone.
   *
   * Idempotent and memoized: calling it twice, or on a manager with nothing to
   * recover, does no git work the second time. Every command entry point calls
   * it, so a user never has to know it exists.
   */
  async recover(): Promise<TeamRecoveryReport> {
    this.#recovery ??= this.#runRecovery();
    return this.#recovery;
  }

  // ----------------------------------------------------------------- internals

  /**
   * Is this record's owning process still alive and not this manager's?
   *
   * A record we started ourselves is excluded deliberately: our own pid is
   * always alive, and a team this process is genuinely running must not be
   * recovered out from under itself either. What is left — no pid, a dead pid,
   * or a pid that is alive but was never recorded — recovers exactly as before.
   *
   * @param record - The stored team to judge.
   */
  #ownedByLiveProcess(record: StoredTeam): boolean {
    return record.ownerPid !== undefined && this.#isProcessAlive(record.ownerPid);
  }

  #newId(): string {
    let id: string;
    do {
      id = `team-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    } while (this.#records.has(id));
    return id;
  }

  async #decompose(
    record: StoredTeam,
    roles: readonly string[],
    maxMembers: number,
    signal?: AbortSignal,
  ): Promise<{ subtasks: TeamSubtask[]; notes?: string } | undefined> {
    const roleNames = knownRoleNames(this.#roles);
    const minMembers = Math.min(this.#minMembers, maxMembers);
    let previousError: string | undefined;
    let lastParsed: { subtasks: TeamSubtask[]; notes?: string } | undefined;

    // Two attempts, no more: the first ask and exactly one re-ask carrying the
    // rejection back to the model. A third would just be paying again for the
    // same misunderstanding.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) {
        record.warnings.push("Planning was cancelled.");
        return undefined;
      }
      const request: TeamPlanRequest = {
        goal: record.goal,
        roles: roleNames,
        minMembers,
        maxMembers,
        ...(roles.length === 0 ? {} : { requestedRoles: roles }),
        ...(previousError === undefined ? {} : { previousError }),
        ...(signal === undefined ? {} : { signal }),
      };
      let raw: string;
      try {
        raw = await this.#plan(request);
      } catch (error) {
        previousError = `the supervisor turn failed (${messageOf(error)})`;
        record.warnings.push(`Decomposition attempt ${attempt + 1} failed: ${previousError}`);
        continue;
      }

      const parsed = parseTeamPlan(raw);
      if (!parsed.ok) {
        previousError = parsed.error;
        record.warnings.push(`Decomposition attempt ${attempt + 1} rejected: ${parsed.error}`);
        continue;
      }
      lastParsed = {
        subtasks: parsed.subtasks,
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
      };

      const validation = validateTeamPlan(parsed.subtasks, {
        minMembers,
        maxMembers,
        roles: roleNames,
      });
      if (validation.ok) return lastParsed;

      // An unknown role is not worth a re-ask on its own — it downgrades to the
      // default role silently. Everything else means the plan would collide.
      const blocking = validation.issues.filter((issue) => issue.kind !== "unknown-role");
      if (blocking.length === 0) return lastParsed;
      previousError = blocking.map(describeTeamPlanIssue).join("; ");
      record.warnings.push(`Decomposition attempt ${attempt + 1} rejected: ${previousError}`);
    }

    if (!lastParsed) {
      record.warnings.push(
        "The supervisor never produced a usable plan; no agents were dispatched.",
      );
      return undefined;
    }

    // Repair rather than dispatch: colliding members are merged, never dropped.
    const repaired = repairTeamPlan(lastParsed.subtasks, { maxMembers });
    for (const change of repaired.changes) record.warnings.push(`Plan repair: ${change}`);
    if (repaired.subtasks.length === 0) {
      record.warnings.push("The repaired plan had no subtasks left; nothing was dispatched.");
      return undefined;
    }
    if (repaired.subtasks.length === 1) {
      record.warnings.push(
        "Decomposition collapsed to a single member — this goal does not split into " +
          "independent file scopes. Running it as one agent.",
      );
    }
    return {
      subtasks: repaired.subtasks,
      ...(lastParsed.notes === undefined ? {} : { notes: lastParsed.notes }),
    };
  }

  async #dispatch(record: StoredTeam, options?: StartTeamOptions): Promise<void> {
    const controller = new AbortController();
    let fireCutoff: () => void = () => {};
    const cutoffPromise = new Promise<void>((resolve) => {
      fireCutoff = resolve;
    });
    const live: LiveTeam = {
      controller,
      agents: new Map(),
      worktrees: new Map(),
      cutoff: cutoffPromise,
      fireCutoff,
      settled: Promise.resolve(),
    };
    let markSettled: () => void = () => {};
    live.settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#live.set(record.id, live);

    const cutoff = (reason: string): void => {
      if (live.cutoffReason !== undefined) return;
      live.cutoffReason = reason;
      record.warnings.push(reason);
      for (const agent of live.agents.values()) {
        try {
          agent.abort();
        } catch (error) {
          record.warnings.push(`abort failed for a team member: ${messageOf(error)}`);
        }
      }
      live.fireCutoff();
    };
    const onCancel = (): void => cutoff("The team was cancelled.");
    controller.signal.addEventListener("abort", onCancel, { once: true });
    const onExternal = (): void => controller.abort();
    options?.signal?.addEventListener("abort", onExternal, { once: true });
    if (options?.signal?.aborted) controller.abort();

    const maxCostUsd = Math.max(0, options?.maxCostUsd ?? this.#maxCostUsd);
    const limit = Math.max(
      1,
      Math.min(
        Math.floor(options?.concurrency ?? this.#concurrency),
        Math.max(1, record.members.length),
      ),
    );

    mkdirSync(join(this.#worktreesDir, record.id), { recursive: true });
    mkdirSync(join(this.#teamsDir, record.id), { recursive: true });

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const member = record.members[index];
        if (member === undefined) return;
        await this.#runMember(record, member, index, live, cutoff, maxCostUsd);
        this.#persist(record);
        this.#emit(record);
      }
    };

    try {
      await Promise.all(Array.from({ length: limit }, worker));
    } finally {
      controller.signal.removeEventListener("abort", onCancel);
      options?.signal?.removeEventListener("abort", onExternal);
      // Release anything still racing the cutoff before the state goes away.
      live.fireCutoff();
      await this.#cleanupTeamWorktrees(record.id);
      this.#live.delete(record.id);
      markSettled();
    }

    record.endedAt = this.#now();
    record.needsRecovery = false;
    // A cut-short team says so even when some members landed first: their
    // patches are still on disk and still mergeable, and the report says that.
    record.status =
      live.cutoffReason !== undefined
        ? "cancelled"
        : record.members.every((member) => member.status === "failed")
          ? "failed"
          : "review";
    this.#persist(record);
    this.#emit(record);
  }

  async #runMember(
    record: StoredTeam,
    member: StoredMember,
    index: number,
    live: LiveTeam,
    cutoff: (reason: string) => void,
    maxCostUsd: number,
  ): Promise<void> {
    member.startedAt = this.#now();
    if (live.cutoffReason !== undefined) {
      member.status = "cancelled";
      member.error = live.cutoffReason;
      member.endedAt = this.#now();
      return;
    }
    member.status = "running";
    this.#persist(record);
    this.#emit(record);

    const role =
      resolveTeamRole(member.role, this.#roles) ??
      resolveTeamRole(DEFAULT_TEAM_ROLE_NAME, this.#roles);
    if (!role) {
      member.status = "failed";
      member.error = `No role "${member.role}" and no fallback role is configured.`;
      member.endedAt = this.#now();
      return;
    }
    member.role = role.name;

    let worktree: Worktree | undefined;
    try {
      worktree = await createWorktree(this.#repoRoot, `${index + 1}-${member.id}`, {
        execFn: this.#execFn,
        gitTimeoutMs: this.#gitTimeoutMs,
        parentDir: join(this.#worktreesDir, record.id),
      });
    } catch (error) {
      member.status = "failed";
      member.error = messageOf(error);
      member.endedAt = this.#now();
      return;
    }
    member.worktreeDir = worktree.dir;
    live.worktrees.set(member.id, worktree);
    this.#persist(record);

    const brief: TeamMemberBrief = {
      id: member.id,
      teamId: record.id,
      title: member.title,
      task: member.task,
      role,
      files: [...member.files],
      goal: record.goal,
      maxTurns: this.#maxTurnsPerMember,
    };

    let agent: TeamAgent | undefined;
    let unsubscribe: (() => void) | undefined;
    let failure: string | undefined;
    let cancelled = false;
    try {
      agent = await this.#spawn(brief, worktree.dir);
      if (agent.sessionId !== undefined) member.sessionId = agent.sessionId;
      const spawned = agent;
      unsubscribe = spawned.subscribe((event) => {
        if (event.type === "toolStart") member.toolCalls++;
        if (event.type !== "turnEnd") return;
        member.turns++;
        // An unpriced turn adds nothing to the running dollar figure — the
        // team ceiling below still enforces every dollar it can see — and is
        // counted instead, so the report and the session can both admit it.
        const spent = this.#costOf(event.usage);
        if (spent === undefined) member.unpricedTurns = (member.unpricedTurns ?? 0) + 1;
        else member.costUsd += spent;
        const total = record.members.reduce((sum, entry) => sum + entry.costUsd, 0);
        if (maxCostUsd > 0 && total >= maxCostUsd) {
          cutoff(
            `The team hit its ${formatCost(maxCostUsd)} ceiling; every remaining member was stopped.`,
          );
        } else if (member.turns >= this.#maxTurnsPerMember) {
          member.error = `Stopped at the ${this.#maxTurnsPerMember}-turn ceiling.`;
          try {
            spawned.abort();
          } catch {
            // A member whose abort throws is still recorded below.
          }
        }
      });
      live.agents.set(member.id, agent);
      // The cutoff may have fired while `spawn()` was in flight, in which case
      // this agent missed the abort fan-out.
      if (live.cutoffReason !== undefined) {
        cancelled = true;
        try {
          agent.abort();
        } catch {
          // Recorded as cancelled regardless.
        }
      }
      // Racing the cutoff rather than relying on abort() alone: a member whose
      // run ignores its abort signal must still be torn down when the team is
      // cancelled, or one stuck agent holds every worktree open forever. The
      // trade-off is deliberate — such an agent may still be streaming when its
      // worktree is deleted, which is strictly better than never cleaning up.
      const run = agent.prompt(buildMemberPrompt(brief));
      // The loser of the race stays pending; swallow its eventual rejection so
      // a cancelled member cannot raise an unhandled rejection.
      run.catch(() => undefined);
      const finished = await Promise.race([
        run.then(() => true as const),
        live.cutoff.then(() => false as const),
      ]);
      // A member that genuinely finished before the buzzer keeps its `done`
      // status even if the team was cut short around it — its patch is valid.
      if (!finished) cancelled = true;
    } catch (error) {
      failure = messageOf(error);
    } finally {
      unsubscribe?.();
      live.agents.delete(member.id);
    }

    if (agent) {
      try {
        member.finalText = agent.finalText() || undefined;
      } catch (error) {
        record.warnings.push(`finalText() failed for "${member.id}": ${messageOf(error)}`);
      }
    }

    // Capture BEFORE teardown, always: the patch on disk is the durable work
    // product, and a cancelled or failed member's partial work is still work.
    const captured = await this.#captureDiff(worktree.dir);
    if (captured.warning) record.warnings.push(captured.warning);
    if (captured.diff !== undefined && captured.diff.trim() !== "") {
      const patchFile = this.#writePatch(record.id, member.id, captured.diff);
      member.patchFile = patchFile;
      member.diffStat = statOf(captured.diff);
    }

    // ALWAYS: an orphaned worktree outlives the run and shows up in the user's
    // `git worktree list` forever.
    try {
      await worktree.remove();
    } catch (error) {
      record.warnings.push(messageOf(error));
    }
    live.worktrees.delete(member.id);
    member.worktreeDir = undefined;
    member.endedAt = this.#now();
    // THE VOID GATE, the team's copy of the one the workflow engine keeps for
    // steps (see `stepProducedNothing` in workflow.ts): a member that finished
    // on its own, changed no file and said nothing has produced nothing, and
    // `done` is a lie — merge() folds it into "empty", `complete` comes up
    // true and the record flips to "merged" while the member's work never
    // existed. It fails, and merge() reports the failure. Judged last on
    // purpose: a cancelled member was stopped by the team and a thrown one
    // has its own reason, so only a member the gate can still see as `done`
    // is judged here. A reason the run already recorded — the turn ceiling —
    // outranks the generic message, because it says WHY nothing came back.
    if (!cancelled && failure === undefined && memberProducedNothing(member)) {
      failure = member.error ?? emptyMemberError(member.id);
    }
    member.status = cancelled ? "cancelled" : failure !== undefined ? "failed" : "done";
    if (failure !== undefined) member.error = failure;
    else if (cancelled) member.error ??= live.cutoffReason ?? "cancelled";
  }

  #writePatch(teamId: string, memberId: string, diff: string): string {
    const dir = join(this.#teamsDir, teamId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${memberId}.patch`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, diff);
    renameSync(tmp, file);
    return file;
  }

  #git(cwd: string, args: readonly string[], maxBuffer = SMALL_MAX_BUFFER): Promise<GitExecResult> {
    return this.#execFn("git", args, { cwd, timeout: this.#gitTimeoutMs, maxBuffer });
  }

  /**
   * Stage everything and capture the worktree's diff.
   *
   * Staged first so files a member *created* — usually most of the work —
   * appear in the diff instead of being invisible as untracked noise, and
   * `--binary` so a patch containing a binary file can still be applied.
   */
  async #captureDiff(dir: string): Promise<{ diff?: string; warning?: string }> {
    try {
      await this.#git(dir, ["add", "--all"]);
    } catch {
      // Staging failed (locked index, permissions): diff the tracked changes
      // anyway — a partial patch beats no patch.
    }
    try {
      const { stdout } = await this.#git(
        dir,
        ["diff", "--cached", "--binary", "--no-color"],
        DIFF_MAX_BUFFER,
      );
      return { diff: stdout };
    } catch (error) {
      return { warning: `could not capture a diff from ${dir}: ${messageOf(error)}` };
    }
  }

  /** Check-then-apply. Never `--3way`, never `--force`. */
  async #applyPatch(patchFile: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const args = ["apply", "--whitespace=nowarn"];
    try {
      await this.#git(this.#repoRoot, [...args, "--check", "--", patchFile]);
    } catch (error) {
      return { ok: false, error: stderrOf(error).trim() || messageOf(error) };
    }
    try {
      await this.#git(this.#repoRoot, [...args, "--", patchFile]);
    } catch (error) {
      return { ok: false, error: stderrOf(error).trim() || messageOf(error) };
    }
    return { ok: true };
  }

  async #removeWorktreeDir(dir: string): Promise<{ warning?: string }> {
    let warning: string | undefined;
    try {
      await this.#git(this.#repoRoot, ["worktree", "remove", "--force", dir]);
    } catch (error) {
      warning = `git worktree remove failed for ${dir}: ${stderrOf(error).trim() || messageOf(error)}`;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The git call above usually already deleted it.
    }
    return warning === undefined ? {} : { warning };
  }

  /** Remove the team's worktree parent and prune git's administrative entries. */
  async #cleanupTeamWorktrees(teamId: string): Promise<void> {
    try {
      rmSync(join(this.#worktreesDir, teamId), { recursive: true, force: true });
    } catch {
      // Best effort; `git worktree prune` below clears the admin entries.
    }
    try {
      await this.#git(this.#repoRoot, ["worktree", "prune"]);
    } catch {
      // Pruning is opportunistic: it only removes entries whose directory is
      // already gone, so failing to run it can never lose anything.
    }
  }

  async #runRecovery(): Promise<TeamRecoveryReport> {
    const report: TeamRecoveryReport = {
      teams: [],
      salvaged: [],
      removedWorktrees: [],
      warnings: [],
    };
    const stale = [...this.#records.values()].filter(
      (record) => record.needsRecovery === true && !this.#ownedByLiveProcess(record),
    );
    if (stale.length === 0) return report;

    for (const record of stale) {
      report.teams.push(record.id);
      for (const member of record.members) {
        const dir = member.worktreeDir;
        if (dir === undefined) continue;
        if (!member.patchFile) {
          const captured = await this.#captureDiff(dir);
          if (captured.warning) report.warnings.push(captured.warning);
          if (captured.diff !== undefined && captured.diff.trim() !== "") {
            member.patchFile = this.#writePatch(record.id, member.id, captured.diff);
            member.diffStat = statOf(captured.diff);
            report.salvaged.push(`${record.id}/${member.id}`);
          }
        }
        const removed = await this.#removeWorktreeDir(dir);
        if (removed.warning) report.warnings.push(removed.warning);
        else report.removedWorktrees.push(dir);
        member.worktreeDir = undefined;
      }
      await this.#cleanupTeamWorktrees(record.id);
      record.needsRecovery = false;
      this.#persist(record);
      this.#emit(record);
    }
    return report;
  }

  #toStatus(record: StoredTeam): TeamStatus {
    const start = record.startedAt ?? record.createdAt;
    const end =
      record.endedAt ??
      (record.status === "running" || record.status === "planning" ? this.#now() : start);
    const members = record.members.map((member) => this.#toMemberStatus(record.id, member));
    return {
      id: record.id,
      goal: record.goal,
      roles: [...record.roles],
      status: record.status,
      ...(record.notes === undefined ? {} : { notes: record.notes }),
      createdAt: record.createdAt,
      elapsedMs: Math.max(0, end - start),
      costUsd: members.reduce((sum, member) => sum + member.costUsd, 0),
      unpricedTurns: members.reduce((sum, member) => sum + member.unpricedTurns, 0),
      members,
      warnings: [...record.warnings],
    };
  }

  #toMemberStatus(teamId: string, member: StoredMember): TeamMemberStatus {
    const start = member.startedAt ?? 0;
    const end = member.endedAt ?? (member.status === "running" ? this.#now() : start);
    return {
      id: member.id,
      teamId,
      title: member.title,
      role: member.role,
      task: member.task,
      files: [...member.files],
      status: member.status,
      diffStat: { ...member.diffStat },
      merged: member.merged,
      discarded: member.discarded,
      costUsd: member.costUsd,
      // Records written before this was tracked have none; they are not
      // retroactively "fully priced", but they are also not re-runnable, and
      // reading a missing counter as zero keeps an old record readable.
      unpricedTurns: member.unpricedTurns ?? 0,
      turns: member.turns,
      toolCalls: member.toolCalls,
      elapsedMs: start === 0 ? 0 : Math.max(0, end - start),
      ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
      ...(member.worktreeDir === undefined ? {} : { worktreeDir: member.worktreeDir }),
      ...(member.patchFile === undefined ? {} : { patchFile: member.patchFile }),
      ...(member.finalText === undefined ? {} : { finalText: member.finalText }),
      ...(member.error === undefined ? {} : { error: member.error }),
    };
  }

  #emit(record: StoredTeam): void {
    const status = this.#toStatus(record);
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch {
        // A listener must never be able to break the manager.
      }
    }
  }

  #persist(record: StoredTeam): void {
    const file = join(this.#recordsDir, `${record.id}.json`);
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(record));
      renameSync(tmp, file);
    } catch {
      // A team that cannot be persisted still runs; it just will not be
      // recoverable. Failing the run over a bookkeeping write would be worse.
    }
  }

  #load(): void {
    let files: string[];
    try {
      files = readdirSync(this.#recordsDir);
    } catch {
      files = [];
    }
    const loaded: StoredTeam[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      let record: StoredTeam;
      try {
        record = JSON.parse(readFileSync(join(this.#recordsDir, file), "utf8")) as StoredTeam;
      } catch {
        continue; // Corrupt or partially written record; skip it.
      }
      if (typeof record?.id !== "string" || !Array.isArray(record.members)) continue;
      record.warnings ??= [];
      record.roles ??= [];
      for (const member of record.members) member.unpricedTurns ??= 0;
      // A fresh manager has no live handle for anything it did not itself
      // launch: a record still running here belongs to a process that is gone
      // — UNLESS its owner is still alive, which is the ordinary shape of
      // `arcturn serve` running beside a terminal over one `~/.arcturn`. That
      // team is not interrupted, and its worktrees are not ours to tear down.
      if (
        (record.status === "running" || record.status === "planning") &&
        !this.#ownedByLiveProcess(record)
      ) {
        record.status = "interrupted";
        record.endedAt ??= this.#now();
        record.warnings.push("The process running this team exited before it finished.");
        for (const member of record.members) {
          if (member.status === "running" || member.status === "queued") {
            member.status = "interrupted";
            member.endedAt ??= this.#now();
          }
        }
        record.needsRecovery = true;
        this.#persist(record);
      }
      loaded.push(record);
    }
    loaded.sort((a, b) => a.createdAt - b.createdAt);
    for (const record of loaded) {
      this.#records.set(record.id, record);
      this.#order.push(record.id);
    }
  }
}

// ------------------------------------------------------------------- wiring

const managers = new WeakMap<ArcturnRuntime, TeamManager>();

/**
 * Roles a runtime offers: its markdown agents (`runtime.agents`), adapted,
 * layered over the built-ins by {@link resolveTeamRole}.
 *
 * @param runtime - The live runtime.
 */
export function teamRolesFor(runtime: ArcturnRuntime): ReadonlyMap<string, TeamRole> {
  const roles = new Map<string, TeamRole>();
  for (const [name, def] of runtime.agents) {
    roles.set(name.toLowerCase(), teamRoleFromAgentDef(def));
  }
  return roles;
}

/**
 * The supervisor turn as one tool-less `llm.complete()` call on the `main`
 * route — decomposition is a reasoning task, not a cheap one.
 *
 * @param runtime - The live runtime.
 */
export function createTeamPlanner(runtime: ArcturnRuntime): TeamPlanner {
  return async (request) => {
    const message = await runtime.llm.complete({
      model: runtime.router.specFor("main"),
      system: TEAM_PLAN_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildDecompositionPrompt(request) }],
          timestamp: Date.now(),
        },
      ],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return contentText(message.content);
  };
}

/**
 * Build one member's agent from a runtime.
 *
 * `buildSessionAgent` is the right factory: it does not swap the runtime's
 * current agent, and it gives the new agent its own checkpoint store rooted at
 * the `cwd` passed — so a member's writes snapshot against its worktree, never
 * against the user's tree. The role's tool narrowing is then applied with
 * `setTools`, which is a real restriction (a read-only reviewer literally has
 * no `write`, `edit` or `bash` to call), and `subagent` is always removed so a
 * member cannot fan out into a team of its own.
 *
 * @param runtime - The live runtime.
 */
export function createTeamSpawn(runtime: ArcturnRuntime): TeamSpawn {
  return (brief, cwd) => {
    const agent = runtime.buildSessionAgent({
      sessionId: createSessionId(),
      cwd,
      model: runtime.router.specFor("subagent"),
      // A member's tool set is fixed by its role, so it must never be handed a
      // deferred toolset: `getTools` would out-rank the `setTools` narrowing
      // below on every turn, quietly handing a read-only reviewer `write`,
      // `edit` and `bash` back — and re-adding the `subagent` tool this
      // deliberately removes. Found by the worktree-confinement escape hunt,
      // which hit the identical seam in the workflow write lane.
      fixedToolset: true,
    });
    const allowed = brief.role.tools === undefined ? undefined : new Set(brief.role.tools);
    const tools: Tool[] = agent.tools.filter(
      (tool) =>
        tool.definition.name !== "subagent" &&
        (allowed === undefined || allowed.has(tool.definition.name)),
    );
    agent.setTools(tools);
    return agent;
  };
}

/**
 * Price a member's turn from the model that served it.
 *
 * Returns `undefined` — never `0` — when neither the provider nor the catalog
 * can price the turn. Zero is a real amount an operator would act on; the
 * absence has to stay an absence all the way to the display.
 */
function costOfFor(model: ModelSpec): (usage: Usage) => number | undefined {
  return (usage) => usage.costUsd ?? calculateCostUsd(model, usage);
}

/**
 * Get (or lazily create) the {@link TeamManager} bound to one
 * {@link ArcturnRuntime}, memoized by runtime identity.
 *
 * Both the `/team` commands and a host application call this — always the same
 * function — so they observe the same manager instance. Defaults are refreshed
 * on every call, so a `/model` switch or a newly attached MCP server is picked
 * up by the next team dispatched.
 *
 * @param runtime - The live runtime.
 */
export function getTeamManager(runtime: ArcturnRuntime): TeamManager {
  let manager = managers.get(runtime);
  if (!manager) {
    manager = new TeamManager({
      dir: join(runtime.paths.home, "teams"),
      repoRoot: runtime.cwd,
      plan: createTeamPlanner(runtime),
      spawn: createTeamSpawn(runtime),
      roles: teamRolesFor(runtime),
      costOf: costOfFor(runtime.router.specFor("subagent")),
    });
    managers.set(runtime, manager);
  } else {
    manager.setDefaults({
      spawn: createTeamSpawn(runtime),
      roles: teamRolesFor(runtime),
      costOf: costOfFor(runtime.router.specFor("subagent")),
    });
  }
  return manager;
}

// ----------------------------------------------------------------- reporting

const MEMBER_MARK: Readonly<Record<TeamMemberStatusValue, string>> = {
  queued: "·",
  running: "◐",
  done: "✓",
  failed: "✗",
  cancelled: "⊘",
  interrupted: "⚠",
};

function formatStat(stat: DiffStat): string {
  if (stat.files === 0) return "no changes";
  return `${stat.files} file${stat.files === 1 ? "" : "s"}, +${stat.added}/-${stat.removed}`;
}

/** One live-progress line for a member. */
function formatMemberLine(member: TeamMemberStatus): string {
  const parts = [`  ${MEMBER_MARK[member.status]} ${member.id} [${member.role}] ${member.status}`];
  if (member.status !== "queued" && member.status !== "running") {
    parts.push(
      formatStat(member.diffStat),
      formatCostTotal(member.costUsd, member.unpricedTurns === 0),
    );
  }
  return parts.join(" · ");
}

function excerpt(text: string | undefined, maxLines: number): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

/**
 * Render the reconciliation view: what each member produced, and what to do
 * about it.
 *
 * @param status - The team snapshot.
 * @param options - `excerptLines` caps each member's quoted report (default `4`).
 */
export function formatTeamReport(status: TeamStatus, options?: { excerptLines?: number }): string {
  const excerptLines = options?.excerptLines ?? 4;
  const lines: string[] = [
    `Team ${status.id} — ${status.status} · ${status.members.length} member` +
      `${status.members.length === 1 ? "" : "s"} · ${formatDuration(status.elapsedMs)} · ` +
      formatCostTotal(status.costUsd, status.unpricedTurns === 0),
    `  goal: ${oneLine(status.goal, 88)}`,
  ];
  if (status.notes) lines.push(`  supervisor: ${oneLine(status.notes, 88)}`);
  lines.push("");

  for (const member of status.members) {
    const flags: string[] = [];
    if (member.merged) flags.push("merged");
    if (member.discarded) flags.push("discarded");
    lines.push(
      `[${member.id}] ${member.title} — ${member.role} · ${member.status}` +
        `${flags.length === 0 ? "" : ` (${flags.join(", ")})`}`,
    );
    lines.push(
      `    scope: ${member.files.length === 0 ? "(none declared)" : member.files.join(", ")}`,
    );
    lines.push(
      `    diff: ${formatStat(member.diffStat)} · ${member.turns} turn` +
        `${member.turns === 1 ? "" : "s"} · ${member.toolCalls} tool call` +
        `${member.toolCalls === 1 ? "" : "s"} · ` +
        formatCostTotal(member.costUsd, member.unpricedTurns === 0),
    );
    if (member.patchFile) lines.push(`    patch: ${member.patchFile}`);
    if (member.error) lines.push(`    note: ${member.error}`);
    for (const note of excerpt(member.finalText, excerptLines)) lines.push(`    | ${note}`);
    lines.push("");
  }

  if (status.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of status.warnings) lines.push(`  - ${warning}`);
    lines.push("");
  }

  const pending = status.members.filter(
    (member) => !member.merged && !member.discarded && member.diffStat.files > 0,
  );
  lines.push(
    pending.length === 0
      ? "Nothing left to merge."
      : `${pending.length} member${pending.length === 1 ? "" : "s"} produced changes that are ` +
          `NOT in your tree yet. Apply them with /team merge ${status.id}, or throw them away ` +
          `with /team discard ${status.id}.`,
  );
  return lines.join("\n");
}

const MERGE_LABEL: Readonly<Record<TeamMergeOutcome["result"], string>> = {
  merged: "applied",
  "already-merged": "already applied",
  empty: "no changes",
  conflict: "CONFLICT",
  skipped: "not attempted",
  discarded: "discarded",
  failed: "FAILED — no work to merge",
};

/**
 * Render a {@link TeamMergeReport}.
 *
 * @param report - The report from {@link TeamManager.merge}.
 */
export function formatMergeReport(report: TeamMergeReport): string {
  const lines: string[] = [
    `Merge of team ${report.teamId} — ${report.merged} applied, ${report.conflicts} conflict` +
      `${report.conflicts === 1 ? "" : "s"}`,
  ];
  for (const outcome of report.outcomes) {
    lines.push(
      `  ${outcome.memberId}: ${MERGE_LABEL[outcome.result]} (${formatStat(outcome.stat)})`,
    );
    if (outcome.failure) {
      for (const line of outcome.failure.split("\n").slice(0, 3)) {
        if (line.trim() !== "") lines.push(`      ${line.trim()}`);
      }
    }
    if (outcome.conflict) {
      for (const line of outcome.conflict.split("\n").slice(0, 6)) {
        if (line.trim() !== "") lines.push(`      ${line.trim()}`);
      }
      if (outcome.patchFile) lines.push(`      patch kept at: ${outcome.patchFile}`);
    }
  }
  if (report.conflicts > 0) {
    lines.push(
      "",
      "The merge stopped at the first conflict; nothing was overwritten and no patch was",
      "deleted. Resolve it yourself — `git apply --3way <patch>` gives you conflict markers —",
      "then re-run /team merge to continue with the remaining members.",
    );
  } else if (report.complete) {
    lines.push("", "Every member's work is in your tree.");
  }
  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ command

/** Sub-commands `/team` accepts. */
export type TeamSubcommand = "status" | "cancel" | "merge" | "discard";

/** Parsed `/team` arguments. */
export interface ParsedTeamArgs {
  /** The sub-command, when the arguments named one. */
  sub?: TeamSubcommand;
  /** Team id for a sub-command, when given. */
  id?: string;
  /** The goal, for a dispatch. */
  goal: string;
  /** Roles pinned with `--roles`. */
  roles?: string[];
  /** Member cap from `--members`. */
  maxMembers?: number;
  /** Cost ceiling from `--max-cost`. */
  maxCostUsd?: number;
  /** Concurrency cap from `--parallel`. */
  concurrency?: number;
}

const SUBCOMMAND = /^(status|cancel|merge|discard)(?:\s+(\S+))?\s*$/;

/**
 * Parse `/team` arguments: leading flags, then either a sub-command or a goal.
 *
 * A sub-command is only recognised when it is the *entire* remaining text
 * (optionally followed by an id), so `/team status page shows stale data` is a
 * goal, not a malformed `/team status`.
 *
 * @param args - Text typed after `/team`.
 */
export function parseTeamArgs(args: string): ParsedTeamArgs {
  let rest = args.trim();
  let roles: string[] | undefined;
  let maxMembers: number | undefined;
  let maxCostUsd: number | undefined;
  let concurrency: number | undefined;

  for (;;) {
    const flag = /^--(roles|members|max-cost|parallel|concurrency)(?:=|\s+)(\S+)\s*/.exec(rest);
    if (!flag) break;
    const [, name, rawValue] = flag;
    const value = rawValue ?? "";
    if (name === "roles") {
      roles = value
        .split(",")
        .map((role) => role.trim().toLowerCase())
        .filter((role) => role !== "");
    } else if (name === "members") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) maxMembers = parsed;
    } else if (name === "max-cost") {
      const parsed = Number.parseFloat(value.replace(/^\$/, ""));
      if (Number.isFinite(parsed) && parsed >= 0) maxCostUsd = parsed;
    } else {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) concurrency = parsed;
    }
    rest = rest.slice(flag[0].length);
  }

  const sub = SUBCOMMAND.exec(rest.trim());
  const base = {
    ...(roles === undefined ? {} : { roles }),
    ...(maxMembers === undefined ? {} : { maxMembers }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(concurrency === undefined ? {} : { concurrency }),
  };
  if (sub) {
    const [, verb, id] = sub;
    return {
      ...base,
      sub: verb as TeamSubcommand,
      ...(id === undefined ? {} : { id }),
      goal: "",
    };
  }
  return { ...base, goal: rest.trim() };
}

/** Resolve a `[id]` argument to a team, defaulting to the newest one. */
function resolveTeam(manager: TeamManager, ui: CommandUi, id?: string): TeamStatus | undefined {
  const status = id === undefined ? manager.latest() : manager.get(id);
  if (status) return status;
  ui.notice(
    "error",
    id === undefined ? "No teams yet. Try /team <goal>." : `No team "${id}". Try /team status.`,
  );
  return undefined;
}

/** `run()` for `/team status`. */
function statusRun(manager: TeamManager, ui: CommandUi, id?: string): void {
  if (id === undefined) {
    const rows = manager.list();
    if (rows.length === 0) {
      ui.notice("info", "No teams yet. Try /team <goal>.");
      return;
    }
    const width = rows.reduce((max, row) => Math.max(max, row.id.length), 2);
    ui.print([
      "Teams",
      ...rows.map(
        (row) =>
          `  ${row.id.padEnd(width)}  ${row.status.padEnd(11)}  ` +
          `${String(row.members.length).padStart(2)} members  ` +
          `${formatCostTotal(row.costUsd, row.unpricedTurns === 0).padEnd(9)}  ` +
          `${oneLine(row.goal, 50)}`,
      ),
    ]);
    return;
  }
  const status = resolveTeam(manager, ui, id);
  if (status) ui.print(formatTeamReport(status));
}

/** `run()` for `/team <goal>`: plan, dispatch, then show the reconciliation. */
async function dispatchRun(
  manager: TeamManager,
  ui: CommandUi,
  parsed: ParsedTeamArgs,
  runtime: ArcturnRuntime,
): Promise<void> {
  const seen = new Map<string, TeamMemberStatusValue>();
  let announced = false;
  const unsubscribe = manager.onUpdate((status) => {
    if (!announced && status.members.length > 0) {
      announced = true;
      ui.print([
        `Team ${status.id} — ${status.members.length} members dispatched in parallel worktrees:`,
        ...status.members.map(
          (member) =>
            `  ${member.id} [${member.role}] ${oneLine(member.title, 44)} — ` +
            `${member.files.length === 0 ? "(no scope)" : member.files.join(", ")}`,
        ),
      ]);
    }
    for (const member of status.members) {
      if (seen.get(member.id) === member.status) continue;
      seen.set(member.id, member.status);
      if (member.status !== "queued") ui.print(formatMemberLine(member));
    }
  });

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const status = await manager.start(parsed.goal, {
      signal: controller.signal,
      ...(parsed.roles === undefined ? {} : { roles: parsed.roles }),
      ...(parsed.maxMembers === undefined ? {} : { maxMembers: parsed.maxMembers }),
      ...(parsed.maxCostUsd === undefined ? {} : { maxCostUsd: parsed.maxCostUsd }),
      ...(parsed.concurrency === undefined ? {} : { concurrency: parsed.concurrency }),
    });
    // Members bill against their own agents, so without this a team's spend is
    // invisible to /cost and to --max-cost — the session could burn the team
    // ceiling several times over and still look untouched.
    runtime.recordExternalCost(status.costUsd);
    // Turns the team could not price are reported as unknown, one apiece. A
    // team that priced nothing sums to `0`, which `recordExternalCost` ignores
    // — so without this the session would show no trace of a team that ran,
    // and the footer would keep claiming nothing had been spent.
    for (let index = 0; index < status.unpricedTurns; index++) {
      runtime.recordExternalCost(undefined);
    }
    ui.print(formatTeamReport(status));
    if (status.status === "failed") {
      ui.notice("error", "The supervisor could not decompose that goal into disjoint subtasks.");
    }
  } catch (error) {
    ui.notice("error", messageOf(error));
  } finally {
    process.off("SIGINT", onSigint);
    unsubscribe();
  }
}

/**
 * Build the `/team` slash command.
 *
 * - `/team <goal>` — decompose, dispatch one agent per subtask in its own
 *   worktree, then show the reconciliation view.
 * - `/team --roles implementer,tester,reviewer <goal>` — pin the specialists.
 * - `/team status [id]` — list teams, or show one team's report.
 * - `/team cancel [id]` — abort every member and clean up their worktrees.
 * - `/team merge [id]` — apply the members' patches to the working tree.
 * - `/team discard [id]` — throw the members' patches away.
 *
 * @param options - `manager` overrides how the manager is obtained from the
 *   runtime; tests use it to inject a manager over a scratch directory.
 */
export function createTeamCommands(options?: {
  manager?: (runtime: ArcturnRuntime) => TeamManager;
}): SlashCommand[] {
  const resolveManager = options?.manager ?? getTeamManager;
  const command: SlashCommand = {
    name: "team",
    description:
      "Run a team of agents on one goal: /team <goal> · status|cancel|merge|discard [id]",
    source: "built-in",
    async run(context: CommandContext): Promise<void> {
      const { ui, runtime } = context;
      const manager = resolveManager(runtime);
      const parsed = parseTeamArgs(context.args);
      const recovered = await manager.recover();
      for (const salvaged of recovered.salvaged) {
        ui.notice("warn", `Salvaged an interrupted team member's work: ${salvaged}`);
      }

      if (parsed.sub === undefined) {
        if (parsed.goal === "") {
          statusRun(manager, ui, undefined);
          return;
        }
        await dispatchRun(manager, ui, parsed, runtime);
        return;
      }

      if (parsed.sub === "status") {
        statusRun(manager, ui, parsed.id);
        return;
      }

      const status = resolveTeam(manager, ui, parsed.id);
      if (!status) return;

      if (parsed.sub === "cancel") {
        if (manager.cancel(status.id)) {
          ui.notice("info", `Cancelling team ${status.id}; every member's worktree is removed.`);
          await manager.settled(status.id);
        } else {
          ui.notice("warn", `Team ${status.id} is already ${status.status}.`);
        }
        return;
      }

      if (parsed.sub === "merge") {
        const report = await manager.merge(status.id);
        if (!report) return;
        ui.print(formatMergeReport(report));
        if (report.conflicts > 0) ui.notice("warn", "Merge stopped at a conflict; nothing lost.");
        return;
      }

      const discarded = await manager.discard(status.id);
      if (discarded) {
        ui.notice("info", `Discarded team ${status.id}: patches deleted, worktrees removed.`);
      }
    },
  };
  return [command];
}
