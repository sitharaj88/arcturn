import type { SessionEntry } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { diffReplays, extractPrompts, type ReplayResult, replaySession } from "./replay.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: Date.now(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  text: string,
  toolCalls: { id: string; name: string }[] = [],
): SessionEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: Date.now(),
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...toolCalls.map((call) => ({
          type: "toolCall" as const,
          id: call.id,
          name: call.name,
          arguments: {},
        })),
      ],
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: toolCalls.length > 0 ? "toolCalls" : "endTurn",
      timestamp: Date.now(),
    },
  };
}

function toolResultEntry(id: string, parentId: string | null, toolCallId: string): SessionEntry {
  return {
    kind: "message",
    id,
    parentId,
    timestamp: Date.now(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "ls",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: Date.now(),
    },
  };
}

describe("extractPrompts", () => {
  it("returns user prompts in chronological order", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "first prompt"),
      assistantEntry("e2", "e1", "first answer"),
      userEntry("e3", "e2", "second prompt"),
      assistantEntry("e4", "e3", "second answer"),
    ];
    expect(extractPrompts(entries)).toEqual(["first prompt", "second prompt"]);
  });

  it("skips tool results and assistant messages", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "run ls"),
      assistantEntry("e2", "e1", "", [{ id: "t1", name: "ls" }]),
      toolResultEntry("e3", "e2", "t1"),
      assistantEntry("e4", "e3", "done"),
    ];
    expect(extractPrompts(entries)).toEqual(["run ls"]);
  });

  it("skips steering messages injected after a tool batch", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "run ls"),
      assistantEntry("e2", "e1", "", [{ id: "t1", name: "ls" }]),
      toolResultEntry("e3", "e2", "t1"),
      // Agent.steer() appends its message right after the tool results of the
      // batch it interrupted — its parent is a toolResult, unlike any prompt
      // submitted while the agent was idle.
      userEntry("e4", "e3", "actually stop and just summarize"),
      assistantEntry("e5", "e4", "done"),
      userEntry("e6", "e5", "second real prompt"),
      assistantEntry("e7", "e6", "second answer"),
    ];
    expect(extractPrompts(entries)).toEqual(["run ls", "second real prompt"]);
  });

  it("skips non-message entries (compaction, label, state)", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "first prompt"),
      assistantEntry("e2", "e1", "first answer"),
      { kind: "label", id: "e3", parentId: "e2", timestamp: Date.now(), label: "checkpoint" },
      {
        kind: "compaction",
        id: "e4",
        parentId: "e3",
        timestamp: Date.now(),
        summary: "summary",
        upToId: "e2",
        tokensBefore: 100,
        tokensAfter: 10,
      },
      { kind: "state", id: "e5", parentId: "e4", timestamp: Date.now(), model: "other-model" },
      userEntry("e6", "e5", "second prompt"),
    ];
    expect(extractPrompts(entries)).toEqual(["first prompt", "second prompt"]);
  });

  it("joins multiple text blocks and drops image blocks, ignores empty text", () => {
    const entries: SessionEntry[] = [
      {
        kind: "message",
        id: "e1",
        parentId: null,
        timestamp: Date.now(),
        message: {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "line two" },
          ],
          timestamp: Date.now(),
        },
      },
      {
        kind: "message",
        id: "e2",
        parentId: "e1",
        timestamp: Date.now(),
        message: { role: "user", content: [{ type: "text", text: "   " }], timestamp: Date.now() },
      },
    ];
    expect(extractPrompts(entries)).toEqual(["line one\nline two"]);
  });

  it("returns an empty array for an empty session", () => {
    expect(extractPrompts([])).toEqual([]);
  });
});

describe("replaySession", () => {
  it("feeds each prompt to the agent in sequence, collecting per-turn results", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(
      scratch,
      [
        { text: "answer one", usage: { costUsd: 0.01 } },
        { toolCalls: [{ id: "t1", name: "ls", arguments: { path: "." } }] },
        { text: "answer two", usage: { costUsd: 0.02 } },
      ],
      { permissionMode: "yolo" },
    );

    const onTurnCalls: [number, string, string][] = [];
    const result = await replaySession({
      prompts: ["prompt one", "prompt two"],
      runtime,
      onTurn: (index, prompt, finalText) => onTurnCalls.push([index, prompt, finalText]),
    });

    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]).toMatchObject({
      prompt: "prompt one",
      finalText: "answer one",
      toolCalls: [],
    });
    expect(result.turns[1]).toMatchObject({
      prompt: "prompt two",
      finalText: "answer two",
      toolCalls: ["ls"],
    });
    expect(result.turns[0]?.costUsd).toBeGreaterThan(0);
    expect(result.turns[1]?.costUsd).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeCloseTo(
      (result.turns[0]?.costUsd ?? 0) + (result.turns[1]?.costUsd ?? 0),
      6,
    );
    expect(onTurnCalls).toEqual([
      [0, "prompt one", "answer one"],
      [1, "prompt two", "answer two"],
    ]);
    await runtime.dispose();
  });

  it("records an error for a failed turn and continues with the rest", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch, [
      { error: "provider exploded" },
      { text: "recovered" },
    ]);

    const result = await replaySession({ prompts: ["will fail", "will succeed"], runtime });

    expect(result.turns[0]?.error).toContain("provider exploded");
    expect(result.turns[1]?.error).toBeUndefined();
    expect(result.turns[1]?.finalText).toBe("recovered");
    await runtime.dispose();
  });

  it("returns an empty result for no prompts", async () => {
    const scratch = await makeScratch();
    const runtime = await buildTestRuntime(scratch);
    const result = await replaySession({ prompts: [], runtime });
    expect(result).toEqual({ turns: [], totalCostUsd: 0 });
    await runtime.dispose();
  });
});

describe("diffReplays", () => {
  function turn(overrides: Partial<ReplayResult["turns"][number]> = {}) {
    return {
      prompt: "p",
      finalText: "hello world",
      toolCalls: ["ls"],
      costUsd: 0.01,
      ...overrides,
    };
  }

  it("reports a match when both replays behave identically", () => {
    const a: ReplayResult = { turns: [turn()], totalCostUsd: 0.01 };
    const b: ReplayResult = { turns: [turn()], totalCostUsd: 0.01 };

    const summary = diffReplays(a, b);

    expect(summary).toContain("tools match");
    expect(summary).not.toContain("DIVERGED");
    expect(summary).toContain("0 tool-call mismatch(es)");
    expect(summary).toContain("0 text divergence(s)");
  });

  it("flags a diverging tool-call sequence, text-length divergence and cost delta", () => {
    const a: ReplayResult = {
      turns: [turn({ toolCalls: ["ls"], finalText: "short", costUsd: 0.01 })],
      totalCostUsd: 0.01,
    };
    const b: ReplayResult = {
      turns: [
        turn({
          toolCalls: ["ls", "grep"],
          finalText: "a much, much longer answer than before",
          costUsd: 0.05,
        }),
      ],
      totalCostUsd: 0.05,
    };

    const summary = diffReplays(a, b);

    expect(summary).toContain("DIFFER");
    expect(summary).toContain("DIVERGED");
    expect(summary).toContain("1 tool-call mismatch(es)");
    expect(summary).toContain("1 text divergence(s)");
    expect(summary).toContain("+0.0400");
  });

  it("flags mismatched turn counts and per-turn errors", () => {
    const a: ReplayResult = { turns: [turn(), turn({ error: "boom" })], totalCostUsd: 0.02 };
    const b: ReplayResult = { turns: [turn()], totalCostUsd: 0.01 };

    const summary = diffReplays(a, b);

    expect(summary).toContain("Turn count differs: 2 (a) vs 1 (b)");
    expect(summary).toContain("present only in a");
  });
});
