import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantContent,
  AssistantMessage,
  Message,
  SessionEntry,
  SessionHeader,
  StopReason,
  Usage,
} from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext, CommandUi, SelectOption } from "./commands.js";
import type { ArcturnPaths } from "./paths.js";
import type { ArcturnRuntime } from "./runtime.js";
import {
  collectStats,
  createStatsCommands,
  discoverProjectDirs,
  formatStatsJson,
  renderStatsText,
  resolveWindow,
  runStatsCommand,
  StatsError,
} from "./stats.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `e${idCounter}`;
}

const HAIKU = "anthropic/claude-haiku-4-5"; // input $1/M, output $5/M, cacheRead $0.1/M, cacheWrite $1.25/M
const OPUS = "anthropic/claude-opus-4-5"; // input $5/M, output $25/M, cacheRead $0.5/M, cacheWrite $6.25/M
const UNPRICED_MODEL = "custom/unknown-model";

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  };
}

function userMessage(timestamp: number): Message {
  return { role: "user", content: [{ type: "text", text: "hi" }], timestamp };
}

function assistantMessage(opts: {
  model: string;
  usage: Usage;
  timestamp: number;
  content?: AssistantContent[];
  stopReason?: StopReason;
}): AssistantMessage {
  return {
    role: "assistant",
    content: opts.content ?? [{ type: "text", text: "ok" }],
    model: opts.model,
    usage: opts.usage,
    stopReason: opts.stopReason ?? "endTurn",
    timestamp: opts.timestamp,
  };
}

function toolResultMessage(opts: {
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  timestamp: number;
}): Message {
  return {
    role: "toolResult",
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    content: [{ type: "text", text: "result" }],
    isError: opts.isError ?? false,
    timestamp: opts.timestamp,
  };
}

/** Chain messages into linear session entries (parentId links each to the last). */
function chain(messages: readonly Message[], startParent: string | null = null): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parent = startParent;
  for (const message of messages) {
    const id = nextId();
    entries.push({ kind: "message", id, parentId: parent, timestamp: message.timestamp, message });
    parent = id;
  }
  return entries;
}

function makeHeader(sessionId: string, createdAt: number, title?: string): SessionHeader {
  return {
    version: 1,
    sessionId,
    cwd: "/proj",
    createdAt,
    ...(title === undefined ? {} : { title }),
  };
}

async function writeSessionFile(
  dir: string,
  header: SessionHeader,
  entries: readonly SessionEntry[],
  options?: { tornLastLine?: boolean },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))];
  let body = `${lines.join("\n")}\n`;
  if (options?.tornLastLine) {
    // A crash mid-append: a fragment of a JSON object with no trailing newline.
    body += '{"kind":"message","id":"torn","parentId":"';
  }
  await writeFile(join(dir, `${header.sessionId}.jsonl`), body, "utf8");
}

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arcturn-stats-"));
}

// ---------------------------------------------------------------------------
// resolveWindow
// ---------------------------------------------------------------------------

describe("resolveWindow", () => {
  const now = Date.UTC(2026, 0, 8); // 2026-01-08T00:00:00Z

  it("defaults to 7d when since is omitted or blank", () => {
    expect(resolveWindow(undefined, now)).toEqual({ sinceMs: now - 7 * 86_400_000, label: "7d" });
    expect(resolveWindow("  ", now)).toEqual({ sinceMs: now - 7 * 86_400_000, label: "7d" });
  });

  it("parses days, hours and minutes", () => {
    expect(resolveWindow("24h", now).sinceMs).toBe(now - 24 * 3_600_000);
    expect(resolveWindow("30m", now).sinceMs).toBe(now - 30 * 60_000);
    expect(resolveWindow("2d", now).sinceMs).toBe(now - 2 * 86_400_000);
  });

  it("treats 'all' as no lower bound", () => {
    expect(resolveWindow("all", now)).toEqual({ label: "all" });
    expect(resolveWindow("ALL", now)).toEqual({ label: "all" });
  });

  it("rejects malformed values", () => {
    expect(() => resolveWindow("banana", now)).toThrow(StatsError);
    expect(() => resolveWindow("7", now)).toThrow(StatsError);
    expect(() => resolveWindow("-3d", now)).toThrow(StatsError);
    expect(() => resolveWindow("7w", now)).toThrow(StatsError);
  });
});

// ---------------------------------------------------------------------------
// discoverProjectDirs
// ---------------------------------------------------------------------------

describe("discoverProjectDirs", () => {
  let root: string;

  beforeEach(async () => {
    root = await scratchDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists only directories, ignoring files", async () => {
    const sessionsRoot = join(root, "sessions");
    await mkdir(join(sessionsRoot, "aaa111"), { recursive: true });
    await mkdir(join(sessionsRoot, "bbb222"), { recursive: true });
    await writeFile(join(sessionsRoot, "not-a-dir.txt"), "x", "utf8");

    const dirs = await discoverProjectDirs(sessionsRoot);
    expect(dirs.sort()).toEqual(
      [join(sessionsRoot, "aaa111"), join(sessionsRoot, "bbb222")].sort(),
    );
  });

  it("returns an empty list when the root doesn't exist", async () => {
    expect(await discoverProjectDirs(join(root, "never-created"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectStats — core aggregation
// ---------------------------------------------------------------------------

describe("collectStats", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scratchDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("aggregates several sessions across two models, hand-checked", async () => {
    // Session 1: haiku, one turn, stored costUsd.
    const h1 = makeHeader("s1", 1_000, "Session One");
    const s1Entries = chain([
      userMessage(1_000),
      assistantMessage({
        model: HAIKU,
        usage: usage({ inputTokens: 1000, outputTokens: 200, costUsd: 0.0012 }),
        timestamp: 1_500,
      }),
    ]);
    await writeSessionFile(dir, h1, s1Entries);

    // Session 2: opus, one turn, cost falls back to calculateCostUsd (no stored costUsd).
    const h2 = makeHeader("s2", 2_000, "Session Two");
    const opusUsage = usage({ inputTokens: 2000, outputTokens: 500, cacheReadTokens: 1000 });
    const s2Entries = chain([
      userMessage(2_000),
      assistantMessage({ model: OPUS, usage: opusUsage, timestamp: 2_500 }),
    ]);
    await writeSessionFile(dir, h2, s2Entries);

    const report = await collectStats({ sessionDirs: [dir], now: 10_000 });

    expect(report.sessionCount).toBe(2);
    expect(report.totalTurns).toBe(2);
    expect(report.assistantMessageCount).toBe(2);

    // Hand-computed: haiku 0.0012 (stored) + opus (2000*5 + 500*25 + 1000*0.5)/1e6
    const expectedOpusCost = (2000 * 5 + 500 * 25 + 1000 * 0.5) / 1_000_000;
    expect(report.costUsd).toBeCloseTo(0.0012 + expectedOpusCost, 10);
    expect(report.costKnown).toBe(true);

    expect(report.usage.inputTokens).toBe(3000);
    expect(report.usage.outputTokens).toBe(700);
    expect(report.usage.cacheReadTokens).toBe(1000);

    expect(report.byModel).toHaveLength(2);
    const haikuStats = report.byModel.find((m) => m.model === HAIKU);
    const opusStats = report.byModel.find((m) => m.model === OPUS);
    expect(haikuStats?.messages).toBe(1);
    expect(haikuStats?.sessions).toBe(1);
    expect(opusStats?.costUsd).toBeCloseTo(expectedOpusCost, 10);
    // Sorted by cost descending: opus costs more than haiku here.
    expect(report.byModel[0]?.model).toBe(OPUS);
  });

  it("does not double-count usage across a multi-message turn (tool round trip)", async () => {
    const header = makeHeader("s1", 1_000);
    const msg1Usage = usage({ inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    const msg2Usage = usage({ inputTokens: 150, outputTokens: 40, costUsd: 0.02 });
    const entries = chain([
      userMessage(1_000), // one turn
      assistantMessage({
        model: HAIKU,
        usage: msg1Usage,
        timestamp: 1_100,
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
        stopReason: "toolCalls",
      }),
      toolResultMessage({ toolCallId: "c1", toolName: "bash", timestamp: 1_200 }),
      assistantMessage({ model: HAIKU, usage: msg2Usage, timestamp: 1_300 }), // same turn, final answer
    ]);
    await writeSessionFile(dir, header, entries);

    const report = await collectStats({ sessionDirs: [dir] });

    // One user message => one turn, even though it took two assistant calls.
    expect(report.totalTurns).toBe(1);
    expect(report.assistantMessageCount).toBe(2);
    // Usage summed exactly once per message — not doubled by turn grouping.
    expect(report.usage.inputTokens).toBe(100 + 150);
    expect(report.usage.outputTokens).toBe(20 + 40);
    expect(report.costUsd).toBeCloseTo(0.01 + 0.02, 10);
    expect(report.toolCallCount).toBe(1);
  });

  it("does not double-count usage across parallel tool calls in one message", async () => {
    const header = makeHeader("s1", 1_000);
    const oneUsage = usage({ inputTokens: 100, outputTokens: 20, costUsd: 0.05 });
    const entries = chain([
      userMessage(1_000),
      assistantMessage({
        model: HAIKU,
        usage: oneUsage,
        timestamp: 1_100,
        content: [
          { type: "toolCall", id: "c1", name: "bash", arguments: {} },
          { type: "toolCall", id: "c2", name: "read", arguments: {} },
        ],
        stopReason: "toolCalls",
      }),
    ]);
    await writeSessionFile(dir, header, entries);

    const report = await collectStats({ sessionDirs: [dir] });

    // Two tool calls counted...
    expect(report.toolCallCount).toBe(2);
    expect(report.byTool.find((t) => t.name === "bash")?.calls).toBe(1);
    expect(report.byTool.find((t) => t.name === "read")?.calls).toBe(1);
    // ...but the message's usage/cost is added exactly once, not once per tool call.
    expect(report.usage.inputTokens).toBe(100);
    expect(report.usage.outputTokens).toBe(20);
    expect(report.costUsd).toBeCloseTo(0.05, 10);
  });

  it("skips a torn final JSONL line instead of failing", async () => {
    const header = makeHeader("s1", 1_000);
    const goodEntries = chain([
      userMessage(1_000),
      assistantMessage({
        model: HAIKU,
        usage: usage({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 }),
        timestamp: 1_100,
      }),
    ]);
    await writeSessionFile(dir, header, goodEntries, { tornLastLine: true });

    const report = await collectStats({ sessionDirs: [dir] });

    expect(report.sessionCount).toBe(1);
    expect(report.totalTurns).toBe(1);
    expect(report.assistantMessageCount).toBe(1);
    expect(report.costUsd).toBeCloseTo(0.001, 10);
  });

  it("handles a session with zero recorded usage without NaN or divide-by-zero", async () => {
    const header = makeHeader("s1", 1_000);
    await writeSessionFile(dir, header, []); // header only, no messages ever appended

    const report = await collectStats({ sessionDirs: [dir], now: 5_000 });

    expect(report.sessionCount).toBe(1);
    expect(report.emptySessionCount).toBe(1);
    expect(report.costUsd).toBe(0);
    expect(report.cacheHitRatio).toBe(0);
    expect(report.toolErrorRate).toBe(0);
    expect(report.assistantErrorRate).toBe(0);
    expect(report.abortRate).toBe(0);
    expect(report.avgTurnsPerSession).toBe(0);
    expect(Number.isNaN(report.avgSessionDurationMs)).toBe(false);
    expect(report.mostExpensiveSession).toBeUndefined();
    for (const value of Object.values(report)) {
      if (typeof value === "number") expect(Number.isNaN(value)).toBe(false);
    }
  });

  it("flags cost as a lower bound when a model has no known pricing", async () => {
    const header = makeHeader("s1", 1_000);
    const entries = chain([
      userMessage(1_000),
      assistantMessage({
        model: UNPRICED_MODEL,
        usage: usage({ inputTokens: 100, outputTokens: 20 }), // no costUsd, unknown model
        timestamp: 1_100,
      }),
    ]);
    await writeSessionFile(dir, header, entries);

    const report = await collectStats({ sessionDirs: [dir] });

    expect(report.costUsd).toBe(0);
    expect(report.costKnown).toBe(false);
    expect(report.unpricedMessageCount).toBe(1);
    expect(report.insights.some((line) => line.includes("lower bound"))).toBe(true);
  });

  it("filters sessions by window (--since)", async () => {
    const now = 100_000_000;
    const inWindow = makeHeader("recent", now - 2 * 3_600_000); // 2h ago
    const outOfWindow = makeHeader("old", now - 10 * 3_600_000); // 10h ago
    await writeSessionFile(
      dir,
      inWindow,
      chain([
        userMessage(inWindow.createdAt),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 1 }),
          timestamp: inWindow.createdAt + 1,
        }),
      ]),
    );
    await writeSessionFile(
      dir,
      outOfWindow,
      chain([
        userMessage(outOfWindow.createdAt),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 1 }),
          timestamp: outOfWindow.createdAt + 1,
        }),
      ]),
    );

    const windowed = await collectStats({
      sessionDirs: [dir],
      now,
      window: resolveWindow("6h", now),
    });
    expect(windowed.sessionCount).toBe(1);
    expect(windowed.sessions[0]?.sessionId).toBe("recent");

    const unwindowed = await collectStats({
      sessionDirs: [dir],
      now,
      window: resolveWindow("all", now),
    });
    expect(unwindowed.sessionCount).toBe(2);
  });

  it("scopes to one project directory vs across all of them", async () => {
    const root = await scratchDir();
    try {
      const sessionsRoot = join(root, "sessions");
      const projectA = join(sessionsRoot, "hashA");
      const projectB = join(sessionsRoot, "hashB");
      await writeSessionFile(
        projectA,
        makeHeader("a1", 1_000),
        chain([
          userMessage(1_000),
          assistantMessage({ model: HAIKU, usage: usage({ inputTokens: 1 }), timestamp: 1_001 }),
        ]),
      );
      await writeSessionFile(
        projectB,
        makeHeader("b1", 1_000),
        chain([
          userMessage(1_000),
          assistantMessage({ model: HAIKU, usage: usage({ inputTokens: 1 }), timestamp: 1_001 }),
        ]),
      );

      const projectOnly = await collectStats({ sessionDirs: [projectA], scope: "project" });
      expect(projectOnly.sessionCount).toBe(1);
      expect(projectOnly.sessions[0]?.sessionId).toBe("a1");

      const all = await collectStats({
        sessionDirs: await discoverProjectDirs(sessionsRoot),
        scope: "all",
      });
      expect(all.sessionCount).toBe(2);
      expect(all.sessions.map((s) => s.sessionId).sort()).toEqual(["a1", "b1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("computes cache-hit ratio and cache savings against hand-computed values", async () => {
    const header = makeHeader("s1", 1_000);
    // input 4000, cacheRead 1000 => ratio = 1000 / (4000+1000) = 0.2
    const entries = chain([
      userMessage(1_000),
      assistantMessage({
        model: OPUS,
        usage: usage({ inputTokens: 4000, outputTokens: 100, cacheReadTokens: 1000 }),
        timestamp: 1_100,
      }),
    ]);
    await writeSessionFile(dir, header, entries);

    const report = await collectStats({ sessionDirs: [dir] });
    expect(report.cacheHitRatio).toBeCloseTo(1000 / 5000, 10);
    // Savings = cacheReadTokens * (input - cacheRead) / 1e6 = 1000 * (5 - 0.5) / 1e6
    const savingsLine = report.insights.find((line) => line.includes("saving an estimated"));
    expect(savingsLine).toBeDefined();
    const expectedSavings = (1000 * (5 - 0.5)) / 1_000_000;
    expect(savingsLine).toContain(expectedSavings.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  });

  it("suppresses the trend insight when the sample is too small", async () => {
    const t0 = 1_000_000;
    await writeSessionFile(
      dir,
      makeHeader("s1", t0),
      chain([
        userMessage(t0),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 100, costUsd: 0.01 }),
          timestamp: t0 + 1,
        }),
      ]),
    );
    await writeSessionFile(
      dir,
      makeHeader("s2", t0 + 10_000),
      chain([
        userMessage(t0 + 10_000),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 100, costUsd: 0.5 }),
          timestamp: t0 + 10_001,
        }),
      ]),
    );

    const report = await collectStats({ sessionDirs: [dir] });
    expect(report.sessionCount).toBe(2);
    expect(report.insights.some((line) => /trending|roughly flat/.test(line))).toBe(false);
  });

  it("states a trend once the sample is large enough and the swing is clear", async () => {
    const t0 = 1_000_000;
    const costs = [0.01, 0.01, 0.5, 0.6]; // clear jump between first and second half
    for (const [index, cost] of costs.entries()) {
      const createdAt = t0 + index * 10_000;
      await writeSessionFile(
        dir,
        makeHeader(`s${index}`, createdAt),
        chain([
          userMessage(createdAt),
          assistantMessage({
            model: HAIKU,
            usage: usage({ inputTokens: 100, costUsd: cost }),
            timestamp: createdAt + 1,
          }),
        ]),
      );
    }

    const report = await collectStats({ sessionDirs: [dir] });
    expect(report.sessionCount).toBe(4);
    const trendLine = report.insights.find((line) => line.includes("trending"));
    expect(trendLine).toBeDefined();
    expect(trendLine).toContain("up");
  });

  it("picks the single most expensive session for the insight", async () => {
    await writeSessionFile(
      dir,
      makeHeader("cheap", 1_000, "Cheap run"),
      chain([
        userMessage(1_000),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 10, costUsd: 0.001 }),
          timestamp: 1_001,
        }),
      ]),
    );
    await writeSessionFile(
      dir,
      makeHeader("pricey", 2_000, "Pricey run"),
      chain([
        userMessage(2_000),
        assistantMessage({
          model: OPUS,
          usage: usage({ inputTokens: 10, costUsd: 5.0 }),
          timestamp: 2_001,
        }),
      ]),
    );

    const report = await collectStats({ sessionDirs: [dir] });
    expect(report.mostExpensiveSession?.sessionId).toBe("pricey");
    expect(
      report.insights.some((line) => line.includes("Pricey run") && line.includes("$5.00")),
    ).toBe(true);
  });

  it("returns an empty-but-valid report when there are no sessions at all", async () => {
    const report = await collectStats({ sessionDirs: [dir] });
    expect(report.sessionCount).toBe(0);
    expect(report.costUsd).toBe(0);
    expect(report.byModel).toEqual([]);
    expect(report.byTool).toEqual([]);
    expect(report.insights).toEqual([]);
    expect(renderStatsText(report).join("\n")).toContain("No sessions found");
  });
});

// ---------------------------------------------------------------------------
// renderStatsText / formatStatsJson
// ---------------------------------------------------------------------------

describe("renderStatsText", () => {
  it("renders a summary, per-model table, top-tools table and insights", async () => {
    const dir = await scratchDir();
    try {
      await writeSessionFile(
        dir,
        makeHeader("s1", 1_000, "Demo"),
        chain([
          userMessage(1_000),
          assistantMessage({
            model: HAIKU,
            usage: usage({ inputTokens: 1000, outputTokens: 200, costUsd: 0.01 }),
            timestamp: 1_100,
            content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
            stopReason: "toolCalls",
          }),
          toolResultMessage({ toolCallId: "c1", toolName: "bash", timestamp: 1_200 }),
          assistantMessage({
            model: HAIKU,
            usage: usage({ inputTokens: 50, outputTokens: 10, costUsd: 0.002 }),
            timestamp: 1_300,
          }),
        ]),
      );
      const report = await collectStats({ sessionDirs: [dir] });
      const text = renderStatsText(report).join("\n");
      expect(text).toContain("Summary");
      expect(text).toContain("By model");
      expect(text).toContain(HAIKU);
      expect(text).toContain("Top tools");
      expect(text).toContain("bash");
      expect(text).toContain("Insights");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatStatsJson", () => {
  it("round-trips through JSON with the expected shape", async () => {
    const dir = await scratchDir();
    try {
      await writeSessionFile(
        dir,
        makeHeader("s1", 1_000),
        chain([
          userMessage(1_000),
          assistantMessage({
            model: HAIKU,
            usage: usage({ inputTokens: 10, costUsd: 0.001 }),
            timestamp: 1_001,
          }),
        ]),
      );
      const report = await collectStats({ sessionDirs: [dir] });
      const parsed = JSON.parse(formatStatsJson(report));

      expect(parsed.sessionCount).toBe(1);
      expect(Array.isArray(parsed.byModel)).toBe(true);
      expect(Array.isArray(parsed.byTool)).toBe(true);
      expect(Array.isArray(parsed.insights)).toBe(true);
      expect(Array.isArray(parsed.sessions)).toBe(true);
      expect(typeof parsed.costUsd).toBe("number");
      expect(typeof parsed.cacheHitRatio).toBe("number");
      expect(parsed.usage).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        cacheReadTokens: expect.any(Number),
        cacheWriteTokens: expect.any(Number),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runStatsCommand (top-level `arcturn stats`)
// ---------------------------------------------------------------------------

describe("runStatsCommand", () => {
  let home: string;
  let paths: ArcturnPaths;

  beforeEach(async () => {
    home = await scratchDir();
    const sessions = join(home, "sessions", "proj-hash");
    paths = {
      cwd: "/proj",
      home,
      userConfig: join(home, "config.json"),
      userMcp: join(home, "mcp.json"),
      userExtensions: join(home, "extensions"),
      auth: join(home, "auth"),
      sessionsRoot: join(home, "sessions"),
      liveModelsCache: join(home, "live-models.json"),
      project: join("/proj", ".arcturn"),
      projectConfig: join("/proj", ".arcturn", "config.json"),
      projectMcp: join("/proj", ".arcturn", "mcp.json"),
      projectExtensions: join("/proj", ".arcturn", "extensions"),
      sessions,
    };
    await writeSessionFile(
      sessions,
      makeHeader("s1", Date.now() - 1_000, "Live session"),
      chain([
        userMessage(Date.now() - 1_000),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 }),
          timestamp: Date.now() - 900,
        }),
      ]),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("prints a text report and exits 0", async () => {
    const chunks: string[] = [];
    const code = await runStatsCommand({ paths, stdout: (c) => chunks.push(c) });
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("Session insights");
    expect(chunks.join("")).toContain("Live session".length > 0 ? "Summary" : "");
  });

  it("prints JSON when json: true", async () => {
    const chunks: string[] = [];
    const code = await runStatsCommand({ paths, json: true, stdout: (c) => chunks.push(c) });
    expect(code).toBe(0);
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.sessionCount).toBe(1);
  });

  it("returns exit code 2 and writes to stderr for a malformed --since", async () => {
    const errChunks: string[] = [];
    const code = await runStatsCommand({
      paths,
      since: "nonsense",
      stderr: (c) => errChunks.push(c),
    });
    expect(code).toBe(2);
    expect(errChunks.join("")).toContain("Invalid --since");
  });

  it("scans every project with all: true", async () => {
    const otherProject = join(home, "sessions", "other-hash");
    await writeSessionFile(
      otherProject,
      makeHeader("other1", Date.now() - 1_000, "Other project"),
      chain([
        userMessage(Date.now() - 1_000),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 10, costUsd: 0.001 }),
          timestamp: Date.now() - 900,
        }),
      ]),
    );

    const chunks: string[] = [];
    const code = await runStatsCommand({
      paths,
      all: true,
      json: true,
      stdout: (c) => chunks.push(c),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.sessionCount).toBe(2);
    expect(parsed.scope).toBe("all");
  });
});

// ---------------------------------------------------------------------------
// createStatsCommands (`/stats`)
// ---------------------------------------------------------------------------

interface FakeUi extends CommandUi {
  lines: string[];
  notices: { level: "info" | "warn" | "error"; text: string }[];
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    lines: [],
    notices: [],
    print(content) {
      ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
    },
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(_title: string, _options: readonly SelectOption<T>[]) {
      return undefined;
    },
    setInput() {},
    clear() {},
    exit() {},
  };
  return ui;
}

describe("createStatsCommands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await scratchDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runtimeWithSessions(sessions: string): ArcturnRuntime {
    return {
      paths: {
        sessions,
        sessionsRoot: join(dir, "sessions-root-unused"),
      },
    } as unknown as ArcturnRuntime;
  }

  it("registers exactly one 'stats' command", () => {
    const commands = createStatsCommands();
    expect(commands.map((c) => c.name)).toEqual(["stats"]);
  });

  it("prints the report for the running project by default", async () => {
    await writeSessionFile(
      dir,
      makeHeader("s1", Date.now() - 1_000, "Demo"),
      chain([
        userMessage(Date.now() - 1_000),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 10, costUsd: 0.001 }),
          timestamp: Date.now() - 900,
        }),
      ]),
    );
    const [command] = createStatsCommands();
    const ui = fakeUi();
    const context: CommandContext = {
      runtime: runtimeWithSessions(dir),
      ui,
      args: "",
      commands: undefined as unknown as CommandContext["commands"],
    };
    await command?.run(context);
    expect(ui.lines.some((line) => line.includes("Session insights"))).toBe(true);
  });

  it("prints JSON with --json", async () => {
    await writeSessionFile(
      dir,
      makeHeader("s1", Date.now() - 1_000),
      chain([
        userMessage(Date.now() - 1_000),
        assistantMessage({
          model: HAIKU,
          usage: usage({ inputTokens: 10, costUsd: 0.001 }),
          timestamp: Date.now() - 900,
        }),
      ]),
    );
    const [command] = createStatsCommands();
    const ui = fakeUi();
    const context: CommandContext = {
      runtime: runtimeWithSessions(dir),
      ui,
      args: "--json",
      commands: undefined as unknown as CommandContext["commands"],
    };
    await command?.run(context);
    const parsed = JSON.parse(ui.lines.join("\n"));
    expect(parsed.sessionCount).toBe(1);
  });

  it("notices an error instead of throwing on a bad --since", async () => {
    const [command] = createStatsCommands();
    const ui = fakeUi();
    const context: CommandContext = {
      runtime: runtimeWithSessions(dir),
      ui,
      args: "--since nonsense",
      commands: undefined as unknown as CommandContext["commands"],
    };
    await command?.run(context);
    expect(ui.notices.some((n) => n.level === "error" && n.text.includes("Invalid --since"))).toBe(
      true,
    );
    expect(ui.lines).toEqual([]);
  });
});

describe("aborted tool calls", () => {
  it("does not count a user abort as a tool error", async () => {
    // Real data showed subagent failing 10 of 15 calls; most were user aborts
    // and turn-budget exhaustion, not the tool failing. An interruption is the
    // user's choice, so counting it against the tool misreports the harness.
    const dir = await scratchDir();
    const header = makeHeader("s-abort", 1_000);
    const aborted = toolResultMessage({
      toolCallId: "c1",
      toolName: "subagent",
      isError: true,
      timestamp: 1_100,
    });
    // Calls are counted from the assistant's toolCall blocks, so the fixture
    // needs the requesting turns as well as their results.
    const entries = chain([
      userMessage(1_000),
      assistantMessage({
        model: HAIKU,
        usage: usage(),
        timestamp: 1_050,
        content: [
          { type: "toolCall", id: "c1", name: "subagent", arguments: {} },
          { type: "toolCall", id: "c2", name: "subagent", arguments: {} },
        ],
        stopReason: "toolCalls",
      }),
      { ...aborted, details: { aborted: true } },
      toolResultMessage({
        toolCallId: "c2",
        toolName: "subagent",
        isError: true,
        timestamp: 1_200,
      }),
    ]);
    await writeSessionFile(dir, header, entries);

    const report = await collectStats({ sessionDirs: [dir] });

    const subagent = report.byTool.find((tool) => tool.name === "subagent");
    // Two calls recorded, but only the genuine failure counts as an error.
    expect(subagent?.calls).toBe(2);
    expect(subagent?.errors).toBe(1);
    expect(report.toolErrorCount).toBe(1);
  });
});
