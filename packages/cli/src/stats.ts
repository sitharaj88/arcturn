/**
 * SESSION INSIGHTS — `arcturn stats` / `/stats`.
 *
 * Arcturn already records tokens, cost, cache hits, tool calls, turns and
 * timings for every session (see `@arcturn/core`'s `JsonlSessionStore` and
 * `@arcturn/types`' `SessionEntry`/`Usage`) — but none of it is ever
 * surfaced. This module reads the JSONL session files directly, aggregates
 * them over a time window, and renders both a compact terminal report and a
 * `--json` machine-readable form.
 *
 * ## Where usage comes from, and how double-counting is avoided
 *
 * The *only* place token/cost usage is ever recorded in a session file is on
 * the `usage` field of an assistant `Message` (one `Usage` record per
 * `kind: "message"` entry whose `message.role === "assistant"`). Every
 * total in this module — session totals, per-model totals, the grand
 * report total — is built by summing exactly that field, exactly once per
 * assistant message. Two things that would otherwise be tempting bugs are
 * deliberately avoided:
 *
 * - A "turn" (one user prompt through to the next user prompt) commonly
 *   contains *multiple* assistant messages (a tool-calling round trip: call,
 *   result, call, result, final text), each a distinct billed request with
 *   its own `usage`. Turn counting (`turns`, one per user message) and usage
 *   summing are computed independently — a turn's own subtotal is never
 *   separately tracked and re-added on top of its messages' usage, and
 *   grouping messages into turns never changes how many times a message's
 *   `usage` is added.
 * - A single assistant message can carry *multiple* `toolCall` content
 *   blocks (parallel tool calls) sharing one `usage` record. Tool-call
 *   counting walks those content blocks, but only to tally `byTool`; the
 *   message's `usage` is added once, outside that loop, never once per tool
 *   call it happens to contain.
 *
 * Cost prefers a stored `usage.costUsd`; when a message predates that field
 * (or names a model the local catalog doesn't price), {@link calculateCostUsd}
 * is used as a fallback, and the message is flagged "unpriced" so the report
 * can say plainly that its total is a lower bound rather than pretend to a
 * precision it doesn't have.
 *
 * ## Which entries count
 *
 * Aggregation reads {@link JsonlSessionStore.entries} — every entry ever
 * appended, not just the entries on the active branch
 * ({@link JsonlSessionStore.branch}). A `/rewind` forks the conversation but
 * does not refund the tokens already spent on the abandoned branch, so this
 * module counts them too: "cost" here means money actually spent, not money
 * spent on the conversation as it currently reads.
 *
 * ## Messy data
 *
 * `JsonlSessionStore` already tolerates a torn final line (a session mid
 * live-append) by dropping it rather than failing the read; this module
 * additionally skips any session whose header is unreadable, and every ratio
 * it computes is guarded against a zero denominator, so an idle project or a
 * freshly created session never produces `NaN` or an empty crash — just
 * zeros.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { addUsage, calculateCostUsd, emptyUsage, getModel } from "@arcturn/ai";
import { JsonlSessionStore } from "@arcturn/core";
import type { SessionEntry, SessionHeader, Usage } from "@arcturn/types";
import type { SlashCommand } from "./commands.js";
import { formatCost, formatDuration, formatTokens, oneLine, totalTokens } from "./format.js";
import type { ArcturnPaths } from "./paths.js";

// ---------------------------------------------------------------------------
// Window parsing
// ---------------------------------------------------------------------------

/** Default `--since` window when none is given. */
const DEFAULT_SINCE = "7d";

const MS_PER_UNIT: Readonly<Record<"d" | "h" | "m", number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

const WINDOW_PATTERN = /^(\d+)(d|h|m)$/i;

/** Thrown when a `--since` value isn't `"<n>d"`, `"<n>h"`, `"<n>m"`, or `"all"`. */
export class StatsError extends Error {}

/** A resolved `--since` window. */
export interface StatsWindow {
  /** Inclusive lower bound on `SessionHeader.createdAt`, in epoch ms. Absent means "all time". */
  sinceMs?: number;
  /** Human label for display, e.g. `"7d"`, `"24h"`, `"all"`. */
  label: string;
}

/**
 * Parse a `--since` value into a concrete time window.
 *
 * @param since - `"<n>d"`, `"<n>h"`, `"<n>m"`, or `"all"`. Defaults to `"7d"` when omitted or blank.
 * @param now - Reference clock, in epoch ms. Defaults to `Date.now()`.
 * @throws StatsError when `since` is set but not one of the accepted forms.
 */
export function resolveWindow(since: string | undefined, now: number = Date.now()): StatsWindow {
  const raw = since?.trim() || DEFAULT_SINCE;
  if (raw.toLowerCase() === "all") return { label: "all" };
  const match = WINDOW_PATTERN.exec(raw);
  const amount = match ? Number(match[1]) : Number.NaN;
  const unit = match?.[2]?.toLowerCase() as "d" | "h" | "m" | undefined;
  const unitMs = unit ? MS_PER_UNIT[unit] : undefined;
  if (!match || !Number.isFinite(amount) || amount < 0 || unitMs === undefined) {
    throw new StatsError(
      `Invalid --since value ${JSON.stringify(raw)}; expected e.g. "7d", "24h", "30m", or "all".`,
    );
  }
  return { sinceMs: now - amount * unitMs, label: raw };
}

// ---------------------------------------------------------------------------
// Directory discovery (for --all)
// ---------------------------------------------------------------------------

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Every project's session directory under `~/.arcturn/sessions`, one per
 * working-directory hash (see `paths.ts`'s `cwdHash`/`ArcturnPaths.sessions`).
 *
 * @param sessionsRoot - `ArcturnPaths.sessionsRoot`.
 * @returns Absolute directory paths; empty when the root doesn't exist yet
 *   (nothing has ever been recorded).
 */
export async function discoverProjectDirs(sessionsRoot: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) return [];
    throw error;
  }
  return dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sessionsRoot, entry.name));
}

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Per-model rollup: usage, cost, and how many sessions used it. */
export interface ModelStats {
  /** Catalog id as recorded on the message, e.g. `"anthropic/claude-opus-4-5"`. */
  model: string;
  /** Assistant messages produced by this model. */
  messages: number;
  /** Distinct sessions in which this model produced at least one message. */
  sessions: number;
  usage: Usage;
  costUsd: number;
  /** True only when every message's cost was computable (stored, or priced from the catalog). */
  costKnown: boolean;
}

/** Per-tool rollup: how often it was called and how often its result was an error. */
export interface ToolStats {
  name: string;
  calls: number;
  errors: number;
}

/** A session's aggregate figures, trimmed for display and `--json`. */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  createdAt: number;
  /** Timestamp of the last entry appended to this session. */
  lastActivityAt: number;
  /** `lastActivityAt - createdAt`, floored at 0. */
  durationMs: number;
  turns: number;
  usage: Usage;
  costUsd: number;
  costKnown: boolean;
  toolCalls: number;
}

/** The full aggregation: everything `arcturn stats` / `/stats` reports. */
export interface StatsReport {
  scope: "project" | "all";
  /** Session-store directories that were scanned. */
  sessionDirs: readonly string[];
  window: StatsWindow;
  /** Clock reference the report was generated against, in epoch ms. */
  generatedAt: number;

  sessionCount: number;
  /** Sessions with zero recorded usage (created but never produced an assistant message). */
  emptySessionCount: number;

  totalTurns: number;
  avgTurnsPerSession: number;

  /** Sum of every session's `lastActivityAt - createdAt`. */
  totalDurationMs: number;
  avgSessionDurationMs: number;

  usage: Usage;
  /** `cacheReadTokens / (inputTokens + cacheReadTokens)`; `0` with no denominator. */
  cacheHitRatio: number;

  costUsd: number;
  /** True only when every assistant message's cost was computable. */
  costKnown: boolean;
  /** Assistant messages whose cost could not be determined. */
  unpricedMessageCount: number;

  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  /** `toolErrorCount / toolResultCount`; `0` with no denominator. */
  toolErrorRate: number;

  assistantMessageCount: number;
  assistantErrorCount: number;
  /** `assistantErrorCount / assistantMessageCount`; `0` with no denominator. */
  assistantErrorRate: number;
  abortCount: number;
  /** `abortCount / assistantMessageCount`; `0` with no denominator. */
  abortRate: number;

  /** Sorted by cost descending, ties broken by total tokens descending. */
  byModel: ModelStats[];
  /** Sorted by call count descending, capped at {@link MAX_TOOL_ROWS}. */
  byTool: ToolStats[];

  /** The costliest single session, when any session's cost was `> 0`. */
  mostExpensiveSession?: SessionSummary;
  sessions: SessionSummary[];

  /** Plain-language observations; only ever stated when the data supports them. */
  insights: string[];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Rows kept in the "top tools" table. */
const MAX_TOOL_ROWS = 10;
/** Below this many sessions, a cost trend would be noise, not signal — never asserted. */
const MIN_SESSIONS_FOR_TREND = 3;
/** A cost swing smaller than this fraction between window-halves reads as "flat". */
const TREND_THRESHOLD = 0.1;

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Stored cost when present, else the catalog-priced estimate; `undefined` when neither is known. */
function resolveCost(model: string, usage: Usage): number | undefined {
  if (usage.costUsd !== undefined) return usage.costUsd;
  const spec = getModel(model);
  return spec ? calculateCostUsd(spec, usage) : undefined;
}

interface ModelAccumulator {
  model: string;
  messages: number;
  usage: Usage;
  costUsd: number;
  unpriced: number;
  sessions: number;
}

interface ToolAccumulator {
  name: string;
  calls: number;
  errors: number;
}

interface SessionAggregate {
  summary: SessionSummary;
  models: Map<string, ModelAccumulator>;
  tools: Map<string, ToolAccumulator>;
  assistantMessages: number;
  assistantErrors: number;
  aborts: number;
  toolResults: number;
  toolErrors: number;
  unpriced: number;
}

/**
 * Walk one session's entries once, attributing each assistant message's
 * `usage` exactly once (see the module-level double-counting note) and
 * tallying turns, tool calls and errors alongside it.
 */
function summarizeSession(
  header: SessionHeader,
  entries: readonly SessionEntry[],
): SessionAggregate {
  let turns = 0;
  let usage = emptyUsage();
  let costUsd = 0;
  let unpriced = 0;
  let toolCalls = 0;
  let assistantMessages = 0;
  let assistantErrors = 0;
  let aborts = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let lastActivityAt = header.createdAt;
  const models = new Map<string, ModelAccumulator>();
  const tools = new Map<string, ToolAccumulator>();

  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    if (entry.timestamp > lastActivityAt) lastActivityAt = entry.timestamp;
    const message = entry.message;

    if (message.role === "user") {
      turns += 1;
      continue;
    }

    if (message.role === "toolResult") {
      toolResults += 1;
      // A user interrupting a run is not the tool failing. Counting aborts as
      // errors made subagent look like it failed two calls in three, when most
      // of those were interruptions and turn-budget exhaustion.
      const aborted = message.details?.aborted === true;
      if (message.isError && !aborted) {
        toolErrors += 1;
        const acc = tools.get(message.toolName) ?? { name: message.toolName, calls: 0, errors: 0 };
        acc.errors += 1;
        tools.set(message.toolName, acc);
      }
      continue;
    }

    // message.role === "assistant"
    assistantMessages += 1;
    usage = addUsage(usage, message.usage);

    const cost = resolveCost(message.model, message.usage);
    if (cost === undefined) unpriced += 1;
    else costUsd += cost;

    const modelAcc = models.get(message.model) ?? {
      model: message.model,
      messages: 0,
      usage: emptyUsage(),
      costUsd: 0,
      unpriced: 0,
      sessions: 1,
    };
    modelAcc.messages += 1;
    modelAcc.usage = addUsage(modelAcc.usage, message.usage);
    if (cost === undefined) modelAcc.unpriced += 1;
    else modelAcc.costUsd += cost;
    models.set(message.model, modelAcc);

    if (message.stopReason === "error") assistantErrors += 1;
    if (message.stopReason === "aborted") aborts += 1;

    // Tool-call *count* walks content blocks; usage above was already added
    // exactly once for the whole message and must not be touched again here.
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      toolCalls += 1;
      const acc = tools.get(block.name) ?? { name: block.name, calls: 0, errors: 0 };
      acc.calls += 1;
      tools.set(block.name, acc);
    }
  }

  const durationMs = Math.max(0, lastActivityAt - header.createdAt);
  const summary: SessionSummary = {
    sessionId: header.sessionId,
    cwd: header.cwd,
    ...(header.title === undefined ? {} : { title: header.title }),
    createdAt: header.createdAt,
    lastActivityAt,
    durationMs,
    turns,
    usage,
    costUsd,
    costKnown: unpriced === 0,
    toolCalls,
  };

  return {
    summary,
    models,
    tools,
    assistantMessages,
    assistantErrors,
    aborts,
    toolResults,
    toolErrors,
    unpriced,
  };
}

interface ReportMeta {
  now: number;
  window: StatsWindow;
  scope: "project" | "all";
  sessionDirs: readonly string[];
}

function buildReport(aggregates: readonly SessionAggregate[], meta: ReportMeta): StatsReport {
  const sessionCount = aggregates.length;
  let usage = emptyUsage();
  let costUsd = 0;
  let unpricedMessageCount = 0;
  let totalTurns = 0;
  let totalDurationMs = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let assistantMessageCount = 0;
  let assistantErrorCount = 0;
  let abortCount = 0;
  let emptySessionCount = 0;

  const modelTotals = new Map<string, ModelAccumulator>();
  const toolTotals = new Map<string, ToolAccumulator>();
  const sessions: SessionSummary[] = [];
  let mostExpensiveSession: SessionSummary | undefined;

  for (const agg of aggregates) {
    sessions.push(agg.summary);
    usage = addUsage(usage, agg.summary.usage);
    costUsd += agg.summary.costUsd;
    unpricedMessageCount += agg.unpriced;
    totalTurns += agg.summary.turns;
    totalDurationMs += agg.summary.durationMs;
    toolCallCount += agg.summary.toolCalls;
    toolResultCount += agg.toolResults;
    toolErrorCount += agg.toolErrors;
    assistantMessageCount += agg.assistantMessages;
    assistantErrorCount += agg.assistantErrors;
    abortCount += agg.aborts;
    if (totalTokens(agg.summary.usage) === 0) emptySessionCount += 1;

    if (
      agg.summary.costUsd > 0 &&
      (mostExpensiveSession === undefined || agg.summary.costUsd > mostExpensiveSession.costUsd)
    ) {
      mostExpensiveSession = agg.summary;
    }

    for (const [name, acc] of agg.models) {
      const existing = modelTotals.get(name);
      if (existing) {
        existing.messages += acc.messages;
        existing.usage = addUsage(existing.usage, acc.usage);
        existing.costUsd += acc.costUsd;
        existing.unpriced += acc.unpriced;
        existing.sessions += 1;
      } else {
        modelTotals.set(name, { ...acc });
      }
    }
    for (const [name, acc] of agg.tools) {
      const existing = toolTotals.get(name);
      if (existing) {
        existing.calls += acc.calls;
        existing.errors += acc.errors;
      } else {
        toolTotals.set(name, { ...acc });
      }
    }
  }

  const byModel = [...modelTotals.values()]
    .map(
      (acc): ModelStats => ({
        model: acc.model,
        messages: acc.messages,
        sessions: acc.sessions,
        usage: acc.usage,
        costUsd: acc.costUsd,
        costKnown: acc.unpriced === 0,
      }),
    )
    .sort((a, b) => b.costUsd - a.costUsd || totalTokens(b.usage) - totalTokens(a.usage));

  const byTool = [...toolTotals.values()].sort((a, b) => b.calls - a.calls).slice(0, MAX_TOOL_ROWS);

  const report: StatsReport = {
    scope: meta.scope,
    sessionDirs: meta.sessionDirs,
    window: meta.window,
    generatedAt: meta.now,
    sessionCount,
    emptySessionCount,
    totalTurns,
    avgTurnsPerSession: safeDiv(totalTurns, sessionCount),
    totalDurationMs,
    avgSessionDurationMs: safeDiv(totalDurationMs, sessionCount),
    usage,
    cacheHitRatio: safeDiv(usage.cacheReadTokens, usage.cacheReadTokens + usage.inputTokens),
    costUsd,
    costKnown: unpricedMessageCount === 0,
    unpricedMessageCount,
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    toolErrorRate: safeDiv(toolErrorCount, toolResultCount),
    assistantMessageCount,
    assistantErrorCount,
    assistantErrorRate: safeDiv(assistantErrorCount, assistantMessageCount),
    abortCount,
    abortRate: safeDiv(abortCount, assistantMessageCount),
    byModel,
    byTool,
    ...(mostExpensiveSession ? { mostExpensiveSession } : {}),
    sessions,
    insights: [],
  };
  report.insights = buildInsights(report);
  return report;
}

// ---------------------------------------------------------------------------
// Insights — plain language, only ever stated when the data supports them
// ---------------------------------------------------------------------------

/** Estimated USD saved by cache reads vs. paying full input price for the same tokens. */
function estimateCacheSavingsUsd(byModel: readonly ModelStats[]): number {
  let savings = 0;
  for (const model of byModel) {
    const spec = getModel(model.model);
    if (!spec?.cost) continue;
    const cacheRate = spec.cost.cacheRead ?? spec.cost.input;
    const delta = spec.cost.input - cacheRate;
    if (delta <= 0) continue;
    savings += (model.usage.cacheReadTokens * delta) / 1_000_000;
  }
  return savings;
}

function computeCostTrend(sessions: readonly SessionSummary[]): string | undefined {
  if (sessions.length < MIN_SESSIONS_FOR_TREND) return undefined;
  const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt);
  const mid = Math.ceil(ordered.length / 2);
  const first = ordered.slice(0, mid);
  const second = ordered.slice(mid);
  if (first.length === 0 || second.length === 0) return undefined;

  const firstAvg = first.reduce((sum, s) => sum + s.costUsd, 0) / first.length;
  const secondAvg = second.reduce((sum, s) => sum + s.costUsd, 0) / second.length;
  if (firstAvg === 0 && secondAvg === 0) return undefined;
  if (firstAvg === 0) {
    return `Cost per session is trending up, from $0 to ${formatCost(secondAvg)} across the window.`;
  }

  const change = (secondAvg - firstAvg) / firstAvg;
  if (Math.abs(change) < TREND_THRESHOLD) {
    return (
      `Cost per session has stayed roughly flat across the window ` +
      `(${formatCost(firstAvg)} -> ${formatCost(secondAvg)}).`
    );
  }
  const direction = change > 0 ? "up" : "down";
  return (
    `Cost per session is trending ${direction} ~${Math.round(Math.abs(change) * 100)}% across the window ` +
    `(${formatCost(firstAvg)} -> ${formatCost(secondAvg)}).`
  );
}

function buildInsights(report: StatsReport): string[] {
  const lines: string[] = [];

  const [topTool] = report.byTool;
  if (topTool && report.toolCallCount > 0) {
    const pct = Math.round((topTool.calls / report.toolCallCount) * 100);
    lines.push(
      `${topTool.name} dominates tool use: ${topTool.calls} call${topTool.calls === 1 ? "" : "s"} ` +
        `(${pct}% of ${report.toolCallCount} tool call${report.toolCallCount === 1 ? "" : "s"}).`,
    );
  }

  if (report.usage.cacheReadTokens > 0) {
    const pct = (report.cacheHitRatio * 100).toFixed(1);
    const savings = estimateCacheSavingsUsd(report.byModel);
    lines.push(
      savings > 0
        ? `Prompt caching is paying off: cache reads covered ${pct}% of input-token volume, ` +
            `saving an estimated ${formatCost(savings)}.`
        : `Cache reads covered ${pct}% of input-token volume, but pricing wasn't available to estimate savings.`,
    );
  } else if (report.usage.inputTokens > 0) {
    lines.push("No prompt-cache reads this window — every input token was billed at full price.");
  }

  const pricedModels = report.byModel.filter((m) => m.sessions > 0 && m.costKnown && m.costUsd > 0);
  if (pricedModels.length >= 2) {
    const worst = pricedModels.reduce((max, m) =>
      m.costUsd / m.sessions > max.costUsd / max.sessions ? m : max,
    );
    lines.push(
      `${worst.model} costs the most per session, averaging ${formatCost(worst.costUsd / worst.sessions)} ` +
        `across ${worst.sessions} session${worst.sessions === 1 ? "" : "s"}.`,
    );
  }

  if (report.mostExpensiveSession) {
    const s = report.mostExpensiveSession;
    const label = s.title ? oneLine(s.title, 50) : s.sessionId;
    lines.push(`The priciest single session was "${label}" at ${formatCost(s.costUsd)}.`);
  }

  const trend = computeCostTrend(report.sessions);
  if (trend) lines.push(trend);

  if (report.unpricedMessageCount > 0) {
    lines.push(
      `Cost is a lower bound: ${report.unpricedMessageCount} assistant message` +
        `${report.unpricedMessageCount === 1 ? "" : "s"} used a model with no known pricing.`,
    );
  }

  if (report.toolResultCount > 0 && report.toolErrorRate >= 0.1) {
    lines.push(
      `${Math.round(report.toolErrorRate * 100)}% of tool calls returned an error ` +
        `(${report.toolErrorCount} of ${report.toolResultCount}).`,
    );
  }

  if (report.abortCount > 0) {
    lines.push(
      `${report.abortCount} assistant turn${report.abortCount === 1 ? " was" : "s were"} aborted ` +
        `(${Math.round(report.abortRate * 100)}% of ${report.assistantMessageCount}).`,
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Collection entry point
// ---------------------------------------------------------------------------

/** Options for {@link collectStats}. */
export interface CollectStatsOptions {
  /** One directory per project bucket to scan; each is a {@link JsonlSessionStore} directory. */
  sessionDirs: readonly string[];
  /** Time window; omit for no lower bound ("all"). */
  window?: StatsWindow;
  /** Clock reference echoed onto the report and used by the trend insight. Defaults to `Date.now()`. */
  now?: number;
  /** Echoed onto the report for display. Defaults to `"project"`. */
  scope?: "project" | "all";
}

/**
 * Read every session under `sessionDirs`, filter to `window`, and aggregate
 * cost, tokens, turns, tool usage and error/abort rates into a
 * {@link StatsReport}.
 *
 * A session whose header can't be read, or one entirely outside the window,
 * is skipped without failing the run; a torn final line within an otherwise
 * good session is dropped by {@link JsonlSessionStore.entries} itself. See
 * the module-level doc comment for exactly how usage is attributed once.
 *
 * @param options - Directories to scan, the time window, and display metadata.
 */
export async function collectStats(options: CollectStatsOptions): Promise<StatsReport> {
  const now = options.now ?? Date.now();
  const window = options.window ?? { label: "all" };
  const aggregates: SessionAggregate[] = [];

  for (const dir of options.sessionDirs) {
    const store = new JsonlSessionStore({ dir });
    let headers: SessionHeader[];
    try {
      headers = await store.list();
    } catch {
      continue;
    }
    for (const header of headers) {
      if (window.sinceMs !== undefined && header.createdAt < window.sinceMs) continue;
      let entries: SessionEntry[];
      try {
        entries = await store.entries(header.sessionId);
      } catch {
        continue;
      }
      aggregates.push(summarizeSession(header, entries));
    }
  }

  return buildReport(aggregates, {
    now,
    window,
    scope: options.scope ?? "project",
    sessionDirs: options.sessionDirs,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Serialize a {@link StatsReport} for `--json`. */
export function formatStatsJson(report: StatsReport): string {
  return JSON.stringify(report, null, 2);
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), ...rows.map((row) => renderRow(row))];
}

function formatWindowLabel(window: StatsWindow): string {
  if (window.sinceMs === undefined) return "all time";
  return `last ${window.label} (since ${new Date(window.sinceMs).toISOString().slice(0, 10)})`;
}

/**
 * Render a {@link StatsReport} as the compact terminal report `arcturn stats`
 * and `/stats` both show: a summary block, a per-model table, a top-tools
 * table, and the insight lines.
 *
 * @param report - Report from {@link collectStats}.
 */
export function renderStatsText(report: StatsReport): string[] {
  const scopeLabel = report.scope === "all" ? "all projects" : "this project";
  const lines: string[] = [`Session insights — ${scopeLabel}, ${formatWindowLabel(report.window)}`];

  if (report.sessionCount === 0) {
    lines.push(
      "",
      `No sessions found in this window.${report.scope === "project" ? " Try --all, or a wider --since." : " Try a wider --since."}`,
    );
    return lines;
  }

  lines.push("", "Summary");
  lines.push(
    `  sessions      ${report.sessionCount}` +
      (report.emptySessionCount > 0 ? ` (${report.emptySessionCount} with no usage)` : ""),
  );
  lines.push(
    `  turns         ${report.totalTurns} (${report.avgTurnsPerSession.toFixed(1)} / session)`,
  );
  lines.push(
    `  wall time     ${formatDuration(report.totalDurationMs)} total, ` +
      `${formatDuration(report.avgSessionDurationMs)} / session`,
  );
  lines.push(
    `  tokens        ${formatTokens(totalTokens(report.usage))} total — ` +
      `${formatTokens(report.usage.inputTokens)} in · ${formatTokens(report.usage.outputTokens)} out · ` +
      `${formatTokens(report.usage.cacheReadTokens)} cache-read · ${formatTokens(report.usage.cacheWriteTokens)} cache-write`,
  );
  lines.push(
    `  cache hit     ${(report.cacheHitRatio * 100).toFixed(1)}%  (cache-read / (input + cache-read))`,
  );
  lines.push(
    `  cost          ${formatCost(report.costUsd)}` +
      (report.costKnown ? "" : " (lower bound; some usage unpriced)"),
  );
  lines.push(
    `  tool calls    ${
      report.toolCallCount > 0
        ? `${report.toolCallCount} (${(report.toolErrorRate * 100).toFixed(1)}% error rate over ${report.toolResultCount} result${report.toolResultCount === 1 ? "" : "s"})`
        : "0"
    }`,
  );
  lines.push(
    `  aborts        ${report.abortCount} (${(report.abortRate * 100).toFixed(1)}% of ${report.assistantMessageCount} assistant turn${report.assistantMessageCount === 1 ? "" : "s"})`,
  );

  if (report.byModel.length > 0) {
    lines.push("", "By model");
    const rows = report.byModel.map((m) => [
      m.model,
      String(m.messages),
      formatTokens(m.usage.inputTokens),
      formatTokens(m.usage.outputTokens),
      `${formatTokens(m.usage.cacheReadTokens)}/${formatTokens(m.usage.cacheWriteTokens)}`,
      `${formatCost(m.costUsd)}${m.costKnown ? "" : "+"}`,
    ]);
    for (const line of renderTable(
      ["model", "msgs", "input", "output", "cache r/w", "cost"],
      rows,
    )) {
      lines.push(`  ${line}`);
    }
  }

  if (report.byTool.length > 0) {
    lines.push("", "Top tools");
    const rows = report.byTool.map((t) => [t.name, String(t.calls), String(t.errors)]);
    for (const line of renderTable(["tool", "calls", "errors"], rows)) {
      lines.push(`  ${line}`);
    }
  }

  if (report.insights.length > 0) {
    lines.push("", "Insights");
    for (const insight of report.insights) lines.push(`  - ${insight}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// `arcturn stats` (top-level)
// ---------------------------------------------------------------------------

/** Options for {@link runStatsCommand}. */
export interface RunStatsCommandOptions {
  /** Resolved filesystem layout: `paths.sessions` is this project's bucket, `paths.sessionsRoot` roots `all`. */
  paths: ArcturnPaths;
  /** Scan every project's sessions instead of just this one. Defaults to `false`. */
  all?: boolean;
  /** Window, e.g. `"7d"`, `"24h"`, `"30m"`, or `"all"`. Defaults to `"7d"`. */
  since?: string;
  /** Emit the {@link StatsReport} as JSON instead of the terminal report. Defaults to `false`. */
  json?: boolean;
  /** Clock reference, for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: (chunk: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: (chunk: string) => void;
}

/**
 * `arcturn stats` — print session insights for this project (or every project
 * with `all: true`) over a time window.
 *
 * @param options - Paths, scope, window and output encoding; see {@link RunStatsCommandOptions}.
 * @returns Process exit code: `0` on success, `2` when `since` is malformed.
 */
export async function runStatsCommand(options: RunStatsCommandOptions): Promise<number> {
  const out = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));
  const now = options.now ?? Date.now();

  let window: StatsWindow;
  try {
    window = resolveWindow(options.since, now);
  } catch (error) {
    err(`arcturn: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const sessionDirs = options.all
    ? await discoverProjectDirs(options.paths.sessionsRoot)
    : [options.paths.sessions];

  const report = await collectStats({
    sessionDirs,
    window,
    now,
    scope: options.all ? "all" : "project",
  });

  out(options.json ? `${formatStatsJson(report)}\n` : `${renderStatsText(report).join("\n")}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// `/stats` (slash command)
// ---------------------------------------------------------------------------

interface ParsedStatsArgs {
  all: boolean;
  since?: string;
  json: boolean;
}

function parseStatsArgs(args: string): ParsedStatsArgs {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  let all = false;
  let json = false;
  let since: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--all") {
      all = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--since") {
      i += 1;
      since = tokens[i];
    } else if (token?.startsWith("--since=")) {
      since = token.slice("--since=".length);
    }
  }
  return { all, json, ...(since === undefined ? {} : { since }) };
}

/**
 * The `/stats` slash command: session insights for the running project.
 *
 * Usage: `/stats [--all] [--since <window>] [--json]` — `--all` scans every
 * project under `~/.arcturn/sessions`, `--since` accepts `"<n>d"`, `"<n>h"`,
 * `"<n>m"`, or `"all"` (default `"7d"`), and `--json` prints the raw
 * {@link StatsReport} instead of the formatted report.
 */
export function createStatsCommands(): SlashCommand[] {
  return [
    {
      name: "stats",
      description:
        "Session insights: cost, tokens, cache and tool usage; also: --all, --since <window>, --json",
      source: "built-in",
      async run({ runtime, ui, args }) {
        const parsed = parseStatsArgs(args);
        let window: StatsWindow;
        try {
          window = resolveWindow(parsed.since);
        } catch (error) {
          ui.notice("error", error instanceof Error ? error.message : String(error));
          return;
        }

        const sessionDirs = parsed.all
          ? await discoverProjectDirs(runtime.paths.sessionsRoot)
          : [runtime.paths.sessions];

        const report = await collectStats({
          sessionDirs,
          window,
          scope: parsed.all ? "all" : "project",
        });

        ui.print(parsed.json ? formatStatsJson(report) : renderStatsText(report));
      },
    },
  ];
}
