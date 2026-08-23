import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { exportHtml, exportMarkdown, suggestExportFilename } from "./export.js";

function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(text: string, timestamp = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "endTurn",
    timestamp,
  };
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  timestamp = 2,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "toolCalls",
    timestamp,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
  timestamp = 3,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp,
  };
}

describe("exportMarkdown", () => {
  it("renders a heading per turn and the title", () => {
    const md = exportMarkdown([user("hi there"), assistantText("hello!")], { title: "My Chat" });
    expect(md).toContain("# My Chat");
    expect(md).toContain("## User");
    expect(md).toContain("hi there");
    expect(md).toContain("## Assistant");
    expect(md).toContain("hello!");
    // User heading precedes assistant heading.
    expect(md.indexOf("## User")).toBeLessThan(md.indexOf("## Assistant"));
  });

  it("includes model and exportedAt in the header when provided", () => {
    const md = exportMarkdown([user("hi")], {
      model: "claude-x",
      exportedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(md).toContain("Model: claude-x");
    expect(md).toContain("Exported: 2026-01-02T03:04:05.000Z");
  });

  it("defaults to a generic title when none is given", () => {
    const md = exportMarkdown([]);
    expect(md).toContain("# Arcturn Session");
  });

  it("renders tool calls as collapsed blocks with fenced input and result", () => {
    const messages: Message[] = [
      assistantToolCall("call-1", "read_file", { path: "foo.txt" }),
      toolResult("call-1", "read_file", "file contents here"),
    ];
    const md = exportMarkdown(messages);
    expect(md).toContain("<details>");
    expect(md).toContain("🔧 read_file");
    expect(md).toContain("```json");
    expect(md).toContain('"path": "foo.txt"');
    expect(md).toContain("**Result:**");
    expect(md).toContain("file contents here");
    expect(md).toContain("</details>");
    // The standalone toolResult message must not get its own duplicate heading.
    expect(md.match(/## Tool/g)).toBeNull();
  });

  it("marks an errored tool result", () => {
    const messages: Message[] = [
      assistantToolCall("call-1", "run", { cmd: "false" }),
      toolResult("call-1", "run", "boom", true),
    ];
    const md = exportMarkdown(messages);
    expect(md).toContain("**Result:** (error)");
  });

  it("renders an orphaned tool result under its own heading", () => {
    const messages: Message[] = [toolResult("call-x", "mystery", "orphan output")];
    const md = exportMarkdown(messages);
    expect(md).toContain("## Tool");
    expect(md).toContain("🔧 mystery");
    expect(md).toContain("orphan output");
  });

  it("notes a call with no matching result", () => {
    const messages: Message[] = [assistantToolCall("call-1", "read_file", { path: "x" })];
    const md = exportMarkdown(messages);
    expect(md).toContain("_No result recorded._");
  });

  it("truncates tool results longer than 200 lines with a marker", () => {
    const longOutput = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const messages: Message[] = [
      assistantToolCall("call-1", "cat", {}),
      toolResult("call-1", "cat", longOutput),
    ];
    const md = exportMarkdown(messages);
    expect(md).toContain("line 0");
    expect(md).toContain("line 199");
    expect(md).not.toContain("line 200");
    expect(md).toContain("truncated (50 more line");
  });

  it("does not truncate results at or under the limit", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const messages: Message[] = [
      assistantToolCall("call-1", "cat", {}),
      toolResult("call-1", "cat", output),
    ];
    const md = exportMarkdown(messages);
    expect(md).toContain("line 199");
    expect(md).not.toContain("truncated");
  });

  it("omits thinking blocks by default and includes them when requested", () => {
    const withThinking: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pondering the meaning of foo" },
        { type: "text", text: "the answer is foo" },
      ],
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 2,
    };

    const withoutOption = exportMarkdown([withThinking]);
    expect(withoutOption).not.toContain("pondering the meaning of foo");
    expect(withoutOption).toContain("the answer is foo");

    const withOption = exportMarkdown([withThinking], {}, { showThinking: true });
    expect(withOption).toContain("pondering the meaning of foo");
    expect(withOption).toContain("🧠 Thinking");
  });

  it("notes images inline", () => {
    const withImage: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "abc123", mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    const md = exportMarkdown([withImage]);
    expect(md).toContain("look at this");
    expect(md).toContain("[image]");
  });

  it("handles an empty conversation", () => {
    const md = exportMarkdown([]);
    expect(md).toContain("No messages in this session");
    expect(md).not.toContain("## User");
    expect(md).not.toContain("## Assistant");
  });
});

describe("exportHtml", () => {
  it("produces one self-contained page with dark-friendly CSS", () => {
    const html = exportHtml([user("hi"), assistantText("hello")], { title: "My Chat" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>My Chat</title>");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain("<link ");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("visually distinguishes user and assistant turns", () => {
    const html = exportHtml([user("hi"), assistantText("hello")]);
    expect(html).toContain('class="turn user"');
    expect(html).toContain('class="turn assistant"');
  });

  it("puts tool calls in <details> blocks with <pre> code", () => {
    const messages: Message[] = [
      assistantToolCall("call-1", "read_file", { path: "foo.txt" }),
      toolResult("call-1", "read_file", "contents"),
    ];
    const html = exportHtml(messages);
    expect(html).toContain('<details class="tool">');
    expect(html).toContain("<pre>");
    expect(html).toContain("read_file");
    expect(html).toContain("contents");
  });

  it("escapes script tags and CDATA-like sequences in user and model content", () => {
    const messages: Message[] = [
      user("<script>alert(1)</script> and ]]> too"),
      assistantToolCall("call-1", "run", { note: "<img src=x onerror=alert(2)>" }),
      toolResult("call-1", "run", "<b>bold</b> ]]>"),
    ];
    const html = exportHtml(messages);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&gt;");
    expect(html).not.toMatch(/[^&]\]\]>/);
  });

  it("escapes quotes and ampersands", () => {
    const html = exportHtml([user(`He said "hi" & left`)]);
    expect(html).toContain("&quot;hi&quot;");
    expect(html).toContain("&amp;");
  });

  it("omits thinking by default, includes it when requested", () => {
    const withThinking: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "done" },
      ],
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "endTurn",
      timestamp: 2,
    };
    expect(exportHtml([withThinking])).not.toContain("secret reasoning");
    expect(exportHtml([withThinking], {}, { showThinking: true })).toContain("secret reasoning");
  });

  it("notes images inline", () => {
    const withImage: UserMessage = {
      role: "user",
      content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
      timestamp: 1,
    };
    const html = exportHtml([withImage]);
    expect(html).toContain("[image]");
  });

  it("truncates long tool results with a marker", () => {
    const longOutput = Array.from({ length: 210 }, (_, i) => `row ${i}`).join("\n");
    const messages: Message[] = [
      assistantToolCall("call-1", "cat", {}),
      toolResult("call-1", "cat", longOutput),
    ];
    const html = exportHtml(messages);
    expect(html).toContain("row 0");
    expect(html).not.toContain("row 200");
    expect(html).toContain("truncated (10 more line");
  });

  it("handles an empty conversation", () => {
    const html = exportHtml([]);
    expect(html).toContain("No messages in this session");
  });
});

describe("suggestExportFilename", () => {
  it("formats the timestamp from meta.exportedAt", () => {
    const name = suggestExportFilename({ exportedAt: "2026-08-18T14:05:00.000Z" }, "md");
    expect(name).toBe("arcturn-session-2026-08-18-1405.md");
  });

  it("supports the html extension", () => {
    const name = suggestExportFilename({ exportedAt: "2026-08-18T14:05:00.000Z" }, "html");
    expect(name).toBe("arcturn-session-2026-08-18-1405.html");
  });

  it("matches the expected shape", () => {
    const name = suggestExportFilename({ exportedAt: "2026-01-01T00:00:00.000Z" }, "md");
    expect(name).toMatch(/^arcturn-session-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  });

  it("falls back to a deterministic timestamp when exportedAt is missing", () => {
    const name = suggestExportFilename({}, "md");
    expect(name).toBe("arcturn-session-1970-01-01-0000.md");
  });
});
