import type { AssistantMessage, Message, ToolResultMessage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_CHARS_TO_ELIDE,
  DEFAULT_PROTECTED_TOOL_NAMES,
  ELIDED_DETAIL_KEY,
  editContext,
  findElisionBoundary,
  isElided,
  renderElisionStub,
  resolveContextEditOptions,
  shouldEditContext,
  toolResultChars,
  totalToolResultChars,
} from "./context-edit.js";
import { usage } from "./test-helpers/fake-llm.js";
import { text, userMessage } from "./util/content.js";

function assistantCall(id: string, name = "read"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: `/a/${id}` } }],
    model: "test-model",
    usage: usage(0, 0),
    stopReason: "toolCalls",
    timestamp: 1,
  };
}

function toolResult(
  id: string,
  body: string,
  overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [text(body)],
    isError: false,
    timestamp: 1,
    ...overrides,
  };
}

/** `turns` tool-calling turns of `size` characters each, plus a leading prompt. */
function conversation(turns: number, size = 5_000): Message[] {
  const messages: Message[] = [userMessage("start")];
  for (let i = 0; i < turns; i++) {
    messages.push(assistantCall(`call-${i}`));
    messages.push(toolResult(`call-${i}`, `${i}`.repeat(size)));
  }
  return messages;
}

/** Options that always trigger, for tests focused on the elision rules. */
function options(overrides: Parameters<typeof resolveContextEditOptions>[0] = {}) {
  return resolveContextEditOptions({ maxTotalToolResultChars: 0, ...overrides });
}

describe("resolveContextEditOptions", () => {
  it("fills in defaults", () => {
    const resolved = resolveContextEditOptions();
    expect(resolved.enabled).toBe(true);
    expect(resolved.keepRecentTurns).toBe(3);
    expect(resolved.minCharsToElide).toBe(DEFAULT_MIN_CHARS_TO_ELIDE);
    expect(resolved.maxTotalToolResultChars).toBe(100_000);
    expect(resolved.protectToolNames).toEqual(DEFAULT_PROTECTED_TOOL_NAMES);
    expect(resolved.renderStub).toBe(renderElisionStub);
  });

  it("keeps explicit values, including falsy ones", () => {
    const resolved = resolveContextEditOptions({
      enabled: false,
      keepRecentTurns: 0,
      minCharsToElide: 0,
      maxTotalToolResultChars: 0,
      protectToolNames: [],
    });
    expect(resolved).toMatchObject({
      enabled: false,
      keepRecentTurns: 0,
      minCharsToElide: 0,
      maxTotalToolResultChars: 0,
      protectToolNames: [],
    });
  });

  it("returns something shouldEditContext accepts back", () => {
    const resolved = resolveContextEditOptions({ maxTotalToolResultChars: 10 });
    expect(shouldEditContext(conversation(1, 100), resolved)).toBe(true);
  });
});

describe("toolResultChars", () => {
  it("counts text characters", () => {
    expect(toolResultChars([text("abc"), text("de")])).toBe(5);
  });

  it("counts an image's base64 payload", () => {
    expect(toolResultChars([{ type: "image", data: "x".repeat(40), mimeType: "image/png" }])).toBe(
      40,
    );
  });

  it("is zero for empty content", () => {
    expect(toolResultChars([])).toBe(0);
  });
});

describe("totalToolResultChars", () => {
  it("sums only tool results", () => {
    const messages: Message[] = [
      userMessage("y".repeat(999)),
      assistantCall("a"),
      toolResult("a", "z".repeat(30)),
      toolResult("b", "z".repeat(20)),
    ];
    expect(totalToolResultChars(messages)).toBe(50);
  });

  it("is zero for a conversation without tools", () => {
    expect(totalToolResultChars([userMessage("hi")])).toBe(0);
  });
});

describe("findElisionBoundary", () => {
  it("returns 0 when there are fewer assistant turns than kept", () => {
    expect(findElisionBoundary(conversation(2), 3)).toBe(0);
  });

  it("points at the Nth-from-last assistant message", () => {
    const messages = conversation(4);
    // indices: 0 user, 1 asst, 2 tr, 3 asst, 4 tr, 5 asst, 6 tr, 7 asst, 8 tr
    expect(findElisionBoundary(messages, 1)).toBe(7);
    expect(findElisionBoundary(messages, 2)).toBe(5);
    expect(findElisionBoundary(messages, 3)).toBe(3);
    expect(findElisionBoundary(messages, 4)).toBe(1);
    expect(findElisionBoundary(messages, 5)).toBe(0);
  });

  it("protects nothing when keepRecentTurns is zero or negative", () => {
    const messages = conversation(3);
    expect(findElisionBoundary(messages, 0)).toBe(messages.length);
    expect(findElisionBoundary(messages, -1)).toBe(messages.length);
  });

  it("handles an empty conversation", () => {
    expect(findElisionBoundary([], 3)).toBe(0);
  });

  it("never moves backwards as messages are appended", () => {
    const messages = conversation(8);
    let previous = -1;
    for (let n = 0; n <= messages.length; n++) {
      const boundary = findElisionBoundary(messages.slice(0, n), 3);
      expect(boundary).toBeGreaterThanOrEqual(previous);
      previous = boundary;
    }
  });
});

describe("shouldEditContext", () => {
  it("is false below the threshold", () => {
    expect(shouldEditContext(conversation(2, 1_000), { maxTotalToolResultChars: 10_000 })).toBe(
      false,
    );
  });

  it("is true above the threshold", () => {
    expect(shouldEditContext(conversation(4, 5_000), { maxTotalToolResultChars: 10_000 })).toBe(
      true,
    );
  });

  it("is false when disabled", () => {
    expect(
      shouldEditContext(conversation(4, 5_000), {
        enabled: false,
        maxTotalToolResultChars: 10_000,
      }),
    ).toBe(false);
  });

  it("uses the default threshold when unspecified", () => {
    expect(shouldEditContext(conversation(4, 5_000))).toBe(false);
    expect(shouldEditContext(conversation(40, 5_000))).toBe(true);
  });

  it("stays true once it has fired, as the conversation grows", () => {
    const messages = conversation(20, 5_000);
    let fired = false;
    for (let n = 0; n <= messages.length; n++) {
      const now = shouldEditContext(messages.slice(0, n), { maxTotalToolResultChars: 20_000 });
      if (fired) expect(now).toBe(true);
      fired ||= now;
    }
    expect(fired).toBe(true);
  });
});

describe("editContext", () => {
  it("does nothing below the trigger", () => {
    const messages = conversation(6, 1_000);
    const result = editContext(messages, resolveContextEditOptions());
    expect(result.elidedCount).toBe(0);
    expect(result.charsSaved).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("does nothing when disabled", () => {
    const messages = conversation(10, 5_000);
    const result = editContext(messages, options({ enabled: false }));
    expect(result.elidedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("elides old tool results and keeps the recent turns verbatim", () => {
    const messages = conversation(6, 5_000);
    const result = editContext(messages, options({ keepRecentTurns: 3 }));

    expect(result.elidedCount).toBe(3);
    expect(result.messages).toHaveLength(messages.length);
    const boundary = findElisionBoundary(messages, 3);
    for (let i = 0; i < messages.length; i++) {
      const before = messages[i]!;
      const after = result.messages[i]!;
      if (before.role === "toolResult" && i < boundary) {
        expect(isElided(after)).toBe(true);
      } else {
        expect(after).toBe(before);
      }
    }
  });

  it("preserves tool-call pairing and message identity fields", () => {
    const messages = conversation(6, 5_000);
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    const ids = (list: readonly Message[]) =>
      list.map((m) => (m.role === "toolResult" ? m.toolCallId : m.role));
    expect(ids(result.messages)).toEqual(ids(messages));

    const edited = result.messages[2] as ToolResultMessage;
    const original = messages[2] as ToolResultMessage;
    expect(edited.role).toBe("toolResult");
    expect(edited.toolCallId).toBe(original.toolCallId);
    expect(edited.toolName).toBe(original.toolName);
    expect(edited.isError).toBe(original.isError);
    expect(edited.timestamp).toBe(original.timestamp);
  });

  it("does not mutate the input", () => {
    const messages = conversation(6, 5_000);
    const snapshot = structuredClone(messages);
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    expect(messages).toEqual(snapshot);
    expect(result.messages).not.toBe(messages);
  });

  it("reports characters saved net of the stub text", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(5_000)),
      assistantCall("b"),
      toolResult("b", "y".repeat(10)),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1, minCharsToElide: 1 }));
    const stub = (result.messages[1] as ToolResultMessage).content[0];
    expect(stub?.type).toBe("text");
    const stubLength = stub?.type === "text" ? stub.text.length : 0;
    expect(result.charsSaved).toBe(5_000 - stubLength);
    expect(stubLength).toBeGreaterThan(0);
  });

  it("skips results smaller than minCharsToElide", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(100)),
      assistantCall("b"),
      assistantCall("c"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1, minCharsToElide: 500 }));
    expect(result.elidedCount).toBe(0);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it("never elides protected tools", () => {
    const messages: Message[] = [
      assistantCall("a", "todo"),
      toolResult("a", "x".repeat(5_000), { toolName: "todo" }),
      assistantCall("b", "plan"),
      toolResult("b", "y".repeat(5_000), { toolName: "plan" }),
      assistantCall("c"),
      toolResult("c", "z".repeat(5_000)),
      assistantCall("d"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    expect(result.elidedCount).toBe(1);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[3]).toBe(messages[3]);
    expect(isElided(result.messages[5]!)).toBe(true);
  });

  it("elides oversized images too", () => {
    const messages: Message[] = [
      assistantCall("a", "screenshot"),
      toolResult("a", "", {
        toolName: "screenshot",
        content: [{ type: "image", data: "d".repeat(40_000), mimeType: "image/png" }],
      }),
      assistantCall("b"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    expect(result.elidedCount).toBe(1);
    const edited = result.messages[1] as ToolResultMessage;
    expect(edited.content).toHaveLength(1);
    expect(edited.content[0]?.type).toBe("text");
  });

  it("marks elided results in details and keeps existing detail keys", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(5_000), { details: { lines: 12 } }),
      assistantCall("b"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    const edited = result.messages[1] as ToolResultMessage;
    expect(edited.details).toEqual({ lines: 12, [ELIDED_DETAIL_KEY]: true, elidedChars: 5_000 });
    expect(isElided(edited)).toBe(true);
  });

  it("points at the offloaded file when the result was offloaded", () => {
    const messages: Message[] = [
      assistantCall("a", "bash"),
      toolResult("a", "x".repeat(5_000), {
        toolName: "bash",
        details: { offloaded: true, path: "/tmp/out/bash-1.txt" },
      }),
      assistantCall("b"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    const stub = (result.messages[1] as ToolResultMessage).content[0];
    const body = stub?.type === "text" ? stub.text : "";
    expect(body).toContain("/tmp/out/bash-1.txt");
    expect(body).toContain("bash");
    expect(body).toContain("5000");
    expect(body).not.toContain("Re-run the tool");
  });

  it("ignores an offload path when details.offloaded is not true", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(5_000), { details: { path: "/tmp/out/read-1.txt" } }),
      assistantCall("b"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    const stub = result.messages[1] as ToolResultMessage;
    const body = stub.content[0]?.type === "text" ? stub.content[0].text : "";
    expect(body).not.toContain("/tmp/out/read-1.txt");
    expect(body).toContain("Re-run the tool");
  });

  it("mentions that an error result was an error", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(5_000), { isError: true }),
      assistantCall("b"),
    ];
    const result = editContext(messages, options({ keepRecentTurns: 1 }));
    const edited = result.messages[1] as ToolResultMessage;
    expect(edited.isError).toBe(true);
    const body = edited.content[0]?.type === "text" ? edited.content[0].text : "";
    expect(body).toContain("error result");
  });

  it("supports a custom stub renderer", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(5_000)),
      assistantCall("b"),
    ];
    const result = editContext(
      messages,
      options({
        keepRecentTurns: 1,
        renderStub: (info) => `<gone ${info.toolName} ${info.originalChars}>`,
      }),
    );
    const edited = result.messages[1] as ToolResultMessage;
    expect(edited.content[0]).toEqual(text("<gone read 5000>"));
  });

  it("skips a renderer whose stub is no smaller than the original", () => {
    const messages: Message[] = [
      assistantCall("a"),
      toolResult("a", "x".repeat(5_000)),
      assistantCall("b"),
    ];
    const result = editContext(
      messages,
      options({ keepRecentTurns: 1, renderStub: () => "y".repeat(6_000) }),
    );
    expect(result.elidedCount).toBe(0);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it("is idempotent: re-editing its own output changes nothing", () => {
    const messages = conversation(8, 5_000);
    const opts = options({ keepRecentTurns: 3 });
    const first = editContext(messages, opts);
    const second = editContext(first.messages, opts);
    expect(second.elidedCount).toBe(0);
    expect(second.charsSaved).toBe(0);
    expect(second.messages).toEqual(first.messages);
  });

  it("handles an empty conversation and one with no tool results", () => {
    expect(editContext([], options())).toEqual({ messages: [], elidedCount: 0, charsSaved: 0 });
    const chat: Message[] = [userMessage("hi"), assistantCall("a")];
    const result = editContext(chat, options({ minCharsToElide: 0 }));
    expect(result.elidedCount).toBe(0);
  });

  it("elides everything eligible when keepRecentTurns is 0", () => {
    const messages = conversation(3, 5_000);
    const result = editContext(messages, options({ keepRecentTurns: 0 }));
    expect(result.elidedCount).toBe(3);
  });
});

describe("prompt-cache stability", () => {
  it("elides the same positions identically as history grows", () => {
    const full = conversation(12, 5_000);
    const opts = options({ keepRecentTurns: 3 });

    // Position -> the exact JSON that position was last sent as, once elided.
    const elidedAt = new Map<number, string>();
    for (let n = 1; n <= full.length; n++) {
      const edited = editContext(full.slice(0, n), opts).messages;
      for (let i = 0; i < edited.length; i++) {
        const message = edited[i]!;
        const serialized = JSON.stringify(message);
        const seen = elidedAt.get(i);
        if (seen !== undefined) {
          // Once elided, a position is elided identically for ever after.
          expect(serialized).toBe(seen);
          continue;
        }
        if (isElided(message)) {
          elidedAt.set(i, serialized);
          continue;
        }
        // Not yet elided: still byte-identical to the raw history.
        expect(message).toBe(full[i]);
      }
    }
    expect(elidedAt.size).toBeGreaterThan(0);
  });

  it("only ever elides more, never fewer, results", () => {
    const full = conversation(12, 5_000);
    const opts = options({ keepRecentTurns: 2 });
    let previous = 0;
    for (let n = 1; n <= full.length; n++) {
      const count = editContext(full.slice(0, n), opts).elidedCount;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });

  it("keeps the prefix stable across the turn the trigger fires on", () => {
    // Real threshold, so early requests are untouched and later ones are edited.
    const full = conversation(30, 5_000);
    const opts = resolveContextEditOptions({ keepRecentTurns: 3 });
    const before = editContext(full.slice(0, 8), opts);
    const after = editContext(full, opts);
    expect(before.elidedCount).toBe(0);
    expect(after.elidedCount).toBeGreaterThan(0);
    // Once firing, the decision for a given position is stable from then on.
    const later = editContext([...full, userMessage("more")], opts);
    for (let i = 0; i < after.messages.length; i++) {
      expect(JSON.stringify(later.messages[i])).toBe(JSON.stringify(after.messages[i]));
    }
  });
});

describe("renderElisionStub", () => {
  it("names the tool, size and recovery path", () => {
    expect(renderElisionStub({ toolName: "read", originalChars: 1234, isError: false })).toBe(
      '[context-edited: the "read" result (1234 characters) was elided to save context. ' +
        "Re-run the tool if you need this output again.]",
    );
  });

  it("uses a locale-independent number so the prefix is byte-stable", () => {
    const stub = renderElisionStub({ toolName: "read", originalChars: 1_234_567, isError: false });
    expect(stub).toContain("1234567");
  });
});
