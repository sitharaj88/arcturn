import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ColorLevel, setColorLevel } from "@arcturn/tui";
import type { AgentEvent, ToolResultMessage } from "@arcturn/types";
import { beforeEach, describe, expect, it } from "vitest";
import { TranscriptFormatter } from "./display.js";
import { ASCII_GLYPHS, FANCY_GLYPHS } from "./glyphs.js";

beforeEach(() => {
  // Deterministic, colour-free output so assertions can match plain text.
  // Per test, not once: colour is global process state, so a test that raises
  // before restoring it would otherwise leak styling into every later
  // assertion — which is exactly how one platform-specific failure became
  // three.
  setColorLevel(ColorLevel.None);
});

function toolResult(
  overrides: Partial<ToolResultMessage> & { toolName: string },
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: overrides.toolName,
    content: overrides.content ?? [{ type: "text", text: "" }],
    isError: overrides.isError ?? false,
    ...(overrides.details === undefined ? {} : { details: overrides.details }),
    timestamp: 0,
  };
}

function lines(formatter: TranscriptFormatter, events: AgentEvent[]): string[] {
  return events.flatMap((event) => formatter.format(event));
}

describe("hyperlinks", () => {
  it("links a tool card's file path to its file:// URL when enabled", () => {
    // OSC 8 rides the colour gate: a terminal stripped to ColorLevel.None
    // gets no escapes of any kind, links included.
    setColorLevel(ColorLevel.Basic);
    const cwd = process.platform === "win32" ? "C:\\repo" : "/repo";
    const expected = pathToFileURL(join(cwd, "src", "cart.ts")).href;
    const formatter = new TranscriptFormatter({ hyperlinks: { cwd } });
    const line = formatter
      .format({
        type: "toolStart",
        toolCallId: "t1",
        toolName: "read",
        input: { path: "src/cart.ts" },
      })
      .join("\n");
    // The URL is built the way the formatter builds it, so this asserts the
    // link exists and points at the resolved file — not that any one platform
    // spells a file URL the way POSIX does.
    expect(line).toContain(`\u001b]8;;${expected}\u0007`);
    expect(line).toContain("\u001b]8;;\u0007"); // and the link is closed
  });

  it("emits nothing link-shaped by default, so headless output stays byte-stable", () => {
    const formatter = new TranscriptFormatter();
    const line = formatter
      .format({
        type: "toolStart",
        toolCallId: "t1",
        toolName: "read",
        input: { path: "src/cart.ts" },
      })
      .join("\n");
    expect(line).not.toContain("]8;;");
  });
});

describe("TranscriptFormatter", () => {
  it("echoes the user prompt that starts a run", () => {
    const out = lines(new TranscriptFormatter(), [
      {
        type: "runStart",
        sessionId: "s",
        prompt: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
      },
    ]);
    expect(out.join("\n")).toContain("▌ hello");
  });

  it("can suppress the prompt echo", () => {
    const out = lines(new TranscriptFormatter({ showUserPrompt: false }), [
      {
        type: "runStart",
        sessionId: "s",
        prompt: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
      },
    ]);
    expect(out).toEqual([]);
  });

  it("renders assistant text as markdown", () => {
    const out = lines(new TranscriptFormatter({ width: 60 }), [
      {
        type: "messageEnd",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "# Title\n\nSome text." }],
          model: "m",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: "endTurn",
          timestamp: 0,
        },
      },
    ]);
    const text = out.join("\n");
    expect(text).toContain("Title");
    expect(text).toContain("Some text.");
    expect(text).not.toContain("# Title");
  });

  it("hides thinking unless asked", () => {
    const message: AgentEvent = {
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "answer" },
        ],
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "endTurn",
        timestamp: 0,
      },
    };
    expect(lines(new TranscriptFormatter(), [message]).join("\n")).not.toContain("secret");
    expect(lines(new TranscriptFormatter({ showThinking: true }), [message]).join("\n")).toContain(
      "secret reasoning",
    );
  });

  it("shows the tool name and its subject on start", () => {
    const out = lines(new TranscriptFormatter(), [
      {
        type: "toolStart",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "git status --short" },
      },
    ]);
    expect(out[0]).toContain("bash");
    expect(out[0]).toContain("git status --short");
  });

  it("leads each tool with a status dot and its per-tool glyph before the name", () => {
    const fancy = new TranscriptFormatter({ glyphs: FANCY_GLYPHS });
    const read = fancy.format({
      type: "toolStart",
      toolCallId: "r1",
      toolName: "read",
      input: { path: "src/a.ts" },
    })[0];
    // ● (status dot) ◇ (read glyph) read … — the glyph precedes the tool name.
    expect(read).toContain("●");
    expect(read?.indexOf("◇")).toBeGreaterThanOrEqual(0);
    expect(read?.indexOf("◇")).toBeLessThan(read?.indexOf("read") ?? -1);

    const bash = fancy.format({
      type: "toolStart",
      toolCallId: "b1",
      toolName: "bash",
      input: { command: "ls" },
    })[0];
    expect(bash?.indexOf("❯")).toBeLessThan(bash?.indexOf("bash") ?? -1);
  });

  it("uses the ASCII glyph set when the terminal cannot render Unicode", () => {
    const ascii = new TranscriptFormatter({ glyphs: ASCII_GLYPHS });
    const line = ascii.format({
      type: "toolStart",
      toolCallId: "r1",
      toolName: "read",
      input: { path: "src/a.ts" },
    })[0];
    expect(line).not.toContain("●");
    expect(line).not.toContain("◇");
    expect(line).toContain("* - read");
  });

  it("shows the tail of bash output and a non-zero exit code", () => {
    const formatter = new TranscriptFormatter({ maxOutputLines: 2 });
    formatter.format({
      type: "toolStart",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "x" },
    });
    const out = formatter.format({
      type: "toolEnd",
      toolCallId: "c1",
      result: toolResult({
        toolName: "bash",
        content: [{ type: "text", text: "one\ntwo\nthree" }],
        details: { command: "x", exitCode: 1 },
      }),
    });
    const text = out.join("\n");
    expect(text).toContain("1 earlier lines");
    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(text).toContain("exit 1");
  });

  it("renders an edit as a diff with the file path", () => {
    const formatter = new TranscriptFormatter();
    formatter.format({
      type: "toolStart",
      toolCallId: "c1",
      toolName: "edit",
      input: { file_path: "/a/b.ts" },
    });
    const out = formatter.format({
      type: "toolEnd",
      toolCallId: "c1",
      result: toolResult({
        toolName: "edit",
        content: [{ type: "text", text: "edited" }],
        details: { path: "/a/b.ts", replacements: 1, diff: "@@ -1 +1 @@\n-old\n+new" },
      }),
    });
    const text = out.join("\n");
    expect(text).toContain("/a/b.ts");
    expect(text).toContain("-old");
    expect(text).toContain("+new");
  });

  it("summarises a write from its details", () => {
    const formatter = new TranscriptFormatter();
    const out = formatter.format({
      type: "toolEnd",
      toolCallId: "c1",
      result: toolResult({
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { path: "/a/new.ts", created: true, bytes: 12 },
      }),
    });
    expect(out.join("\n")).toContain("created /a/new.ts (12 bytes)");
  });

  it("renders tool errors in the error style", () => {
    const formatter = new TranscriptFormatter();
    const out = formatter.format({
      type: "toolEnd",
      toolCallId: "c1",
      result: toolResult({
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "command not found" }],
      }),
    });
    expect(out.join("\n")).toContain("command not found");
  });

  it("indents sub-agent activity and its result", () => {
    const formatter = new TranscriptFormatter();
    const out = lines(formatter, [
      { type: "subagentStart", agentId: "a1", task: "find the callers of foo" },
      {
        type: "subagentEvent",
        agentId: "a1",
        event: { type: "toolStart", toolCallId: "n1", toolName: "grep", input: { pattern: "foo" } },
      },
      { type: "subagentEnd", agentId: "a1", resultText: "3 callers in src/", isError: false },
    ]);
    const text = out.join("\n");
    expect(text).toContain("subagent");
    expect(text).toContain("find the callers of foo");
    expect(text).toContain("↳ grep foo");
    expect(text).toContain("⎿ 3 callers in src/");
  });

  it("styles notices by level and returns nothing for stream noise", () => {
    const formatter = new TranscriptFormatter();
    expect(formatter.format({ type: "notice", level: "warn", text: "careful" })[0]).toContain(
      "⚠ careful",
    );
    expect(formatter.format({ type: "notice", level: "error", text: "boom" })[0]).toContain(
      "✗ boom",
    );
    expect(
      formatter.format({
        type: "messageStream",
        event: { type: "textDelta", blockIndex: 0, delta: "x" },
      }),
    ).toEqual([]);
    expect(formatter.format({ type: "turnStart", turnIndex: 0 })).toEqual([]);
  });

  it("reports compaction and run failures", () => {
    const formatter = new TranscriptFormatter();
    expect(
      formatter
        .format({ type: "compactionEnd", summary: "s", tokensBefore: 40_000, tokensAfter: 8_000 })
        .join(""),
    ).toContain("40k → 8k tokens");
    expect(
      formatter.format({ type: "compactionEnd", summary: "", tokensBefore: 1, tokensAfter: 1 }),
    ).toEqual([]);
    expect(
      formatter.format({ type: "runEnd", reason: "error", errorMessage: "nope" })[0],
    ).toContain("✗ nope");
    expect(formatter.format({ type: "runEnd", reason: "aborted" })[0]).toContain("Interrupted");
    expect(formatter.format({ type: "runEnd", reason: "completed" })).toEqual([]);
  });

  it("renders todos only when configured to", () => {
    const todos: AgentEvent = {
      type: "todoUpdate",
      todos: [
        { id: "1", text: "first", status: "done" },
        { id: "2", text: "second", status: "inProgress" },
      ],
    };
    expect(new TranscriptFormatter().format(todos)).toEqual([]);
    const shown = new TranscriptFormatter({ showTodos: true }).format(todos).join("\n");
    expect(shown).toContain("first");
    expect(shown).toContain("second");
  });

  it("tracks width changes", () => {
    const formatter = new TranscriptFormatter({ width: 40 });
    expect(formatter.width).toBe(40);
    formatter.setWidth(120);
    expect(formatter.width).toBe(120);
  });
});
