import type { AssistantMessage, Message, ToolResultMessage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  compactMessages,
  estimateMessageTokens,
  estimateTokens,
  findCutPoint,
  resolveCompactionOptions,
  serializeConversation,
  shouldCompact,
} from "./compaction.js";
import { createScriptedLLM, TEST_MODEL, textTurn, usage } from "./test-helpers/fake-llm.js";
import { text, userMessage } from "./util/content.js";

function assistant(content: string, tokens = 0): AssistantMessage {
  return {
    role: "assistant",
    content: [text(content)],
    model: "test-model",
    usage: usage(tokens, 0),
    stopReason: "endTurn",
    timestamp: 1,
  };
}

function assistantToolCall(id: string, name: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: "/a" } }],
    model: "test-model",
    usage: usage(0, 0),
    stopReason: "toolCalls",
    timestamp: 1,
  };
}

function toolResult(id: string, name: string, body: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [text(body)],
    isError: false,
    timestamp: 1,
  };
}

describe("estimateTokens", () => {
  it("falls back to a character estimate with no usage data", () => {
    const tokens = estimateTokens([userMessage("x".repeat(400))]);
    expect(tokens).toBeGreaterThan(90);
    expect(tokens).toBeLessThan(140);
  });

  it("anchors on the last real usage and estimates the tail", () => {
    const messages: Message[] = [
      userMessage("hello"),
      assistant("hi", 5_000),
      userMessage("y".repeat(4_000)),
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThanOrEqual(5_000 + 1_000);
    expect(tokens).toBeLessThan(5_000 + 1_200);
  });

  it("ignores assistant messages that reported no usage", () => {
    const messages: Message[] = [assistant("no usage", 0), userMessage("hi")];
    expect(estimateTokens(messages)).toBe(
      messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    );
  });
});

describe("shouldCompact", () => {
  it("triggers only past the reserved head-room", () => {
    expect(shouldCompact(100_000, 200_000)).toBe(false);
    expect(shouldCompact(190_000, 200_000)).toBe(true);
    expect(shouldCompact(190_000, 200_000, { reserveTokens: 5_000 })).toBe(false);
  });

  it("handles a reserve larger than the window", () => {
    expect(shouldCompact(1, 1_000, { reserveTokens: 2_000 })).toBe(true);
    expect(shouldCompact(0, 1_000, { reserveTokens: 2_000 })).toBe(false);
  });
});

describe("findCutPoint", () => {
  const long = "z".repeat(4_000); // ~1000 tokens per message

  it("returns 0 when there is nothing worth folding", () => {
    expect(findCutPoint([userMessage("a")], 10)).toBe(0);
    expect(findCutPoint([userMessage("a"), assistant("b")], 100_000)).toBe(0);
  });

  it("cuts at a user message boundary", () => {
    const messages: Message[] = [
      userMessage(long),
      assistant(long),
      userMessage(long),
      assistant(long),
      userMessage(long),
      assistant(long),
    ];
    const cut = findCutPoint(messages, 1_500);
    expect(cut).toBeGreaterThan(0);
    expect(messages[cut]?.role).toBe("user");
  });

  it("never splits an assistant tool call from its results", () => {
    const messages: Message[] = [
      userMessage(long),
      assistantToolCall("c1", "read"),
      toolResult("c1", "read", long),
      userMessage(long),
      assistantToolCall("c2", "read"),
      toolResult("c2", "read", long),
    ];
    const cut = findCutPoint(messages, 1_200);
    expect(messages[cut]?.role).toBe("user");
    expect(cut).toBe(3);
    // Everything folded away ends on a complete tool exchange.
    expect(messages[cut - 1]?.role).toBe("toolResult");
  });

  it("keeps more than requested rather than cutting mid-turn", () => {
    const messages: Message[] = [
      userMessage(long),
      assistant(long),
      assistant(long),
      assistant(long),
      assistant(long),
    ];
    // The only boundary is index 0, which would fold nothing.
    expect(findCutPoint(messages, 500)).toBe(0);
  });
});

describe("serializeConversation", () => {
  it("renders users, assistants, tool calls and tool results", () => {
    const rendered = serializeConversation([
      userMessage("do the thing"),
      assistantToolCall("c1", "read"),
      toolResult("c1", "read", "file body"),
      assistant("done"),
    ]);
    expect(rendered).toContain("[User]: do the thing");
    expect(rendered).toContain('[Assistant tool calls]: read(path="/a")');
    expect(rendered).toContain("[Tool result read]: file body");
    expect(rendered).toContain("[Assistant]: done");
  });

  it("truncates very long tool results", () => {
    const rendered = serializeConversation([toolResult("c1", "read", "x".repeat(5_000))]);
    expect(rendered).toContain("more characters truncated");
    expect(rendered.length).toBeLessThan(3_000);
  });
});

describe("buildSummaryPrompt", () => {
  it("asks for the five structured sections", () => {
    const prompt = buildSummaryPrompt("transcript");
    for (const section of [
      "## Goal",
      "## Progress",
      "## Key decisions",
      "## Next steps",
      "## Critical context",
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("transcript");
  });
});

describe("compactMessages", () => {
  const long = "z".repeat(4_000);
  const history: Message[] = [
    userMessage(long),
    assistant(long),
    userMessage(long),
    assistant(long),
    userMessage("latest question"),
    assistant("latest answer"),
  ];

  it("summarizes the head and keeps the tail", async () => {
    const llm = createScriptedLLM([
      textTurn("## Goal\nship arcturn\n\n## Next steps\nfinish core"),
    ]);
    const result = await compactMessages({
      llm,
      model: TEST_MODEL,
      messages: history,
      options: { keepRecentTokens: 500 },
    });

    expect(result).toBeDefined();
    const compaction = result!;
    expect(compaction.summary).toContain("ship arcturn");
    expect(compaction.cutIndex).toBeGreaterThan(0);
    // The cut lands on a turn boundary and the tail is preserved verbatim.
    expect(history[compaction.cutIndex]?.role).toBe("user");
    expect(compaction.messages).toHaveLength(history.length - compaction.cutIndex + 1);
    expect(JSON.stringify(compaction.messages[0])).toContain("compacted-history");
    expect(compaction.messages.slice(1)).toEqual(history.slice(compaction.cutIndex));
    expect(JSON.stringify(compaction.messages.at(-1))).toContain("latest answer");
    expect(compaction.tokensAfter).toBeLessThan(compaction.tokensBefore);

    const request = llm.requests[0]!;
    expect(request.system).toContain("compress coding-agent transcripts");
    expect(JSON.stringify(request.messages)).toContain("## Critical context");
  });

  it("returns undefined when no cut point exists", async () => {
    const llm = createScriptedLLM([textTurn("unused")]);
    const result = await compactMessages({
      llm,
      model: TEST_MODEL,
      messages: [userMessage("only one")],
    });
    expect(result).toBeUndefined();
    expect(llm.consumed).toBe(0);
  });

  it("honours a custom prompt builder and model", async () => {
    const llm = createScriptedLLM([textTurn("custom summary")]);
    const other = { ...TEST_MODEL, id: "test/small", model: "small" };
    await compactMessages({
      llm,
      model: TEST_MODEL,
      messages: history,
      options: { keepRecentTokens: 500, model: other, buildPrompt: (c) => `SUMMARIZE: ${c}` },
    });
    expect(llm.requests[0]?.model.model).toBe("small");
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain("SUMMARIZE:");
  });

  it("throws when the summarizer fails", async () => {
    const llm = createScriptedLLM([
      [
        { type: "start", model: "test-model" },
        {
          type: "error",
          error: { kind: "overloaded", message: "busy" },
          message: {
            role: "assistant",
            content: [],
            model: "test-model",
            usage: usage(0, 0),
            stopReason: "error",
            errorMessage: "busy",
            timestamp: 1,
          },
        },
      ],
    ]);
    await expect(
      compactMessages({
        llm,
        model: TEST_MODEL,
        messages: history,
        options: { keepRecentTokens: 500 },
      }),
    ).rejects.toThrow("busy");
  });
});

describe("resolveCompactionOptions", () => {
  it("fills in the documented defaults", () => {
    const resolved = resolveCompactionOptions();
    expect(resolved).toMatchObject({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
    expect(resolved.buildPrompt("x")).toContain("## Goal");
  });
});
