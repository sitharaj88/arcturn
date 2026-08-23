import type { AgentEvent, ToolResultMessage } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import {
  FakeDocument,
  FakeElement,
  loadWebClient,
  tagsOf,
  textOf,
  type ViewState,
  vnodeText,
} from "./test-helpers/load.js";

const { model, app } = loadWebClient();

function toolResult(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
    ...overrides,
  };
}

/** Render a state's transcript into a fake DOM container and return it. */
function renderTranscript(state: ViewState): FakeElement {
  const doc = new FakeDocument();
  const container = new FakeElement("main");
  app.mount(doc, container, model.transcriptNodes(state));
  return container;
}

describe("web client model: reducer", () => {
  it("records a user prompt from runStart", () => {
    const state = model.createState();
    model.applyEvent(state, {
      type: "runStart",
      sessionId: "s1",
      prompt: { role: "user", content: [{ type: "text", text: "ship it" }], timestamp: 0 },
    });
    expect(state.running).toBe(true);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: "user", text: "ship it" });
  });

  it("accumulates streaming text and clears it on messageEnd", () => {
    const state = model.createState();
    model.applyEvent(state, { type: "messageStream", event: { type: "textStart", blockIndex: 0 } });
    model.applyEvent(state, {
      type: "messageStream",
      event: { type: "textDelta", blockIndex: 0, delta: "hel" },
    });
    model.applyEvent(state, {
      type: "messageStream",
      event: { type: "textDelta", blockIndex: 0, delta: "lo" },
    });
    expect(state.streaming).toBe(true);
    expect(state.streamText).toBe("hello");
    expect(model.liveNodes(state)).toHaveLength(1);

    model.applyEvent(state, {
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "endTurn",
        timestamp: 0,
      },
    });
    expect(state.streaming).toBe(false);
    expect(model.liveNodes(state)).toHaveLength(0);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "assistant", text: "hello" });
  });

  it("pairs toolEnd with the toolStart that opened the call", () => {
    const state = model.createState();
    model.applyEvent(
      state,
      { type: "toolStart", toolCallId: "c1", toolName: "bash", input: { command: "ls -la" } },
      1_000,
    );
    expect(state.blocks[0]).toMatchObject({
      kind: "tool",
      name: "bash",
      subject: "ls -la",
      status: "running",
    });

    model.applyEvent(
      state,
      {
        type: "toolEnd",
        toolCallId: "c1",
        result: toolResult({
          content: [{ type: "text", text: "a\nb\nc" }],
          details: { exitCode: 2 },
        }),
      },
      3_500,
    );
    // One block, mutated in place — not a second one appended.
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ status: "ok", elapsedMs: 2_500 });
    const text = textOf(renderTranscript(state));
    expect(text).toContain("bash");
    expect(text).toContain("ls -la");
    expect(text).toContain("exit 2");
    expect(text).toContain("2s");
  });

  it("renders an edit result as a coloured, numbered diff", () => {
    const state = model.createState();
    model.applyEvent(state, {
      type: "toolStart",
      toolCallId: "c2",
      toolName: "edit",
      input: { path: "src/a.ts" },
    });
    model.applyEvent(state, {
      type: "toolEnd",
      toolCallId: "c2",
      result: toolResult({
        toolName: "edit",
        content: [{ type: "text", text: "edited" }],
        details: {
          path: "src/a.ts",
          diff: ["@@ -1,2 +1,2 @@", " keep", "-old line", "+new line"].join("\n"),
        },
      }),
    });

    const container = renderTranscript(state);
    const classes = container.childNodes[0]?.childNodes.map((child) => child.getAttribute("class"));
    expect(classes).toContain("diff");
    const text = textOf(container);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("+1");
    expect(text).toContain("-1");
    expect(text).toContain("+new line");
    expect(text).toContain("-old line");
  });

  it("summarizes read/grep/write results the way the CLI does", () => {
    const cases: { name: string; result: ToolResultMessage; expected: string }[] = [
      {
        name: "read",
        result: toolResult({ toolName: "read", details: { totalLines: 12 } }),
        expected: "12 lines",
      },
      {
        name: "grep",
        result: toolResult({
          toolName: "grep",
          details: { matchCount: 3, filesSearched: 9 },
        }),
        expected: "3 matches",
      },
      {
        name: "write",
        result: toolResult({
          toolName: "write",
          details: { path: "/x/y.ts", bytes: 42, created: true },
        }),
        expected: "created /x/y.ts (42 bytes)",
      },
    ];
    for (const testCase of cases) {
      const state = model.createState();
      model.applyEvent(state, {
        type: "toolStart",
        toolCallId: "c",
        toolName: testCase.name,
        input: {},
      });
      model.applyEvent(state, { type: "toolEnd", toolCallId: "c", result: testCase.result });
      expect(textOf(renderTranscript(state))).toContain(testCase.expected);
    }
  });

  it("keeps a live todo checklist", () => {
    const state = model.createState();
    model.applyEvent(state, {
      type: "todoUpdate",
      todos: [
        { id: "1", text: "first", status: "done" },
        { id: "2", text: "second", status: "inProgress" },
        { id: "3", text: "third", status: "pending" },
      ],
    });
    const doc = new FakeDocument();
    const list = new FakeElement("ul");
    app.mount(doc, list, model.todoNodes(state));
    expect(list.childNodes).toHaveLength(3);
    expect(list.childNodes.map((item) => item.getAttribute("data-status"))).toEqual([
      "done",
      "inProgress",
      "pending",
    ]);
    expect(textOf(list)).toContain("second");
  });

  it("tracks open permission requests and clears them on a decision", () => {
    const state = model.createState();
    const request = {
      id: "p1",
      toolName: "bash",
      toolCallId: "c9",
      subject: "rm -rf /tmp/x",
      description: "Run bash: rm -rf /tmp/x",
    };
    model.applyEvent(state, {
      type: "toolStart",
      toolCallId: "c9",
      toolName: "bash",
      input: { command: "rm -rf /tmp/x" },
    });
    model.applyEvent(state, { type: "permissionRequest", request });
    expect(state.permissions).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ status: "asking" });
    // A duplicate request id never queues twice.
    model.applyEvent(state, { type: "permissionRequest", request });
    expect(state.permissions).toHaveLength(1);

    model.applyEvent(state, {
      type: "permissionDecision",
      decision: { requestId: "p1", behavior: "allow" },
    });
    expect(state.permissions).toHaveLength(0);
  });

  it("closes a run with elapsed time and token count", () => {
    const state = model.createState();
    model.applyEvent(
      state,
      {
        type: "runStart",
        sessionId: "s",
        prompt: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 },
      },
      0,
    );
    model.applyEvent(state, {
      type: "turnEnd",
      turnIndex: 0,
      usage: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    model.applyEvent(state, { type: "runEnd", reason: "completed" }, 5_000);
    expect(state.running).toBe(false);
    const text = textOf(renderTranscript(state));
    expect(text).toContain("5s");
    expect(text).toContain("1.5k tokens");
  });

  it("reports an aborted or failed run", () => {
    const aborted = model.createState();
    model.applyEvent(aborted, { type: "runEnd", reason: "aborted" });
    expect(textOf(renderTranscript(aborted))).toContain("Interrupted.");

    const failed = model.createState();
    model.applyEvent(failed, { type: "runEnd", reason: "error", errorMessage: "boom" });
    expect(textOf(renderTranscript(failed))).toContain("boom");
  });

  it("shows sub-agent activity nested under its task", () => {
    const state = model.createState();
    model.applyEvent(state, { type: "subagentStart", agentId: "a1", task: "explore the repo" });
    model.applyEvent(state, {
      type: "subagentEvent",
      agentId: "a1",
      event: { type: "toolStart", toolCallId: "x", toolName: "grep", input: { pattern: "todo" } },
    });
    model.applyEvent(state, {
      type: "subagentEnd",
      agentId: "a1",
      resultText: "found 3",
      isError: false,
    });
    const text = textOf(renderTranscript(state));
    expect(text).toContain("explore the repo");
    expect(text).toContain("grep todo");
    expect(text).toContain("found 3");
  });

  it("ignores events it does not understand", () => {
    const state = model.createState();
    const before = state.blocks.length;
    model.applyEvent(state, { type: "nonsense" } as unknown as AgentEvent);
    model.applyEvent(state, undefined as unknown as AgentEvent);
    expect(state.blocks).toHaveLength(before);
  });

  it("caps the transcript so a long session cannot grow without bound", () => {
    const state = model.createState();
    for (let index = 0; index < 500; index++) {
      model.applyEvent(state, { type: "notice", level: "info", text: `n${index}` });
    }
    expect(state.blocks.length).toBeLessThanOrEqual(400);
    expect(textOf(renderTranscript(state))).toContain("n499");
  });
});

describe("web client model: markdown", () => {
  it("renders headings, lists, code fences and inline spans as elements", () => {
    const nodes = model.markdownNodes(
      ["# Title", "", "- one `code`", "- two **bold**", "", "```", "raw <b>", "```"].join("\n"),
    );
    const tags = nodes.flatMap((node) => [node.tag, ...node.children.map((kid) => kid.tag)]);
    expect(tags).toContain("h3");
    expect(tags).toContain("ul");
    expect(tags).toContain("li");
    expect(nodes.some((node) => node.tag === "pre")).toBe(true);
    const text = nodes.map((node) => vnodeText(node)).join("\n");
    expect(text).toContain("Title");
    expect(text).toContain("code");
    expect(text).toContain("raw <b>");
  });

  it("renders a link as its label plus a plain-text URL, never an anchor", () => {
    const nodes = model.markdownNodes("see [docs](javascript:alert(1))");
    const tags = nodes.flatMap((node) => [node.tag, ...node.children.map((kid) => kid.tag)]);
    expect(tags).not.toContain("a");
    expect(nodes.map((node) => vnodeText(node)).join("")).toContain("docs");
  });

  it("terminates on pathological input", () => {
    expect(() => model.markdownNodes("*".repeat(500))).not.toThrow();
    expect(() => model.markdownNodes("```\nunterminated")).not.toThrow();
  });
});

describe("web client model: helpers", () => {
  it("parses unified diffs and numbers them against the new file", () => {
    const rows = model.parseDiff(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"));
    expect(rows?.map((row) => row.kind)).toEqual([" ", "-", "+", " "]);
    expect(rows?.map((row) => row.lineNo)).toEqual([1, null, 2, 3]);
    expect(model.parseDiff("no hunks here")).toBeNull();
  });

  it("derives a tool subject from the same keys core does", () => {
    expect(model.subjectOf({ command: "ls -la" })).toBe("ls -la");
    expect(model.subjectOf({ file_path: "/a.ts", content: "x" })).toBe("/a.ts");
    expect(model.subjectOf({ url: "https://x.dev" })).toBe("https://x.dev");
    expect(model.subjectOf({ nothing: 1 })).toBe("");
    expect(model.subjectOf(null)).toBe("");
  });

  it("suggests the same persisted rule the TUI does", () => {
    expect(model.suggestRule({ toolName: "bash", subject: "git status --short" })).toEqual({
      tool: "bash",
      specifier: "git *",
      action: "allow",
    });
    expect(model.suggestRule({ toolName: "write", subject: "/a.ts" })).toEqual({
      tool: "write",
      specifier: "/a.ts",
      action: "allow",
    });
  });

  it("refuses approval while the request has not been read to the end", () => {
    expect(model.approvalGate({ scrollable: false, atBottom: false })).toBe(true);
    expect(model.approvalGate({ scrollable: true, atBottom: false })).toBe(false);
    expect(model.approvalGate({ scrollable: true, atBottom: true })).toBe(true);
  });

  it("formats durations and token counts like the CLI", () => {
    expect(model.formatDuration(2_500)).toBe("2s");
    expect(model.formatDuration(65_000)).toBe("1m05s");
    expect(model.formatTokens(1_500)).toBe("1.5k");
  });
});

describe("web client mounter", () => {
  it("reuses an unchanged node and replaces a revised one", () => {
    const doc = new FakeDocument();
    const container = new FakeElement("main");
    const state = model.createState();
    model.applyEvent(state, { type: "notice", level: "info", text: "first" });
    app.mount(doc, container, model.transcriptNodes(state));
    const first = container.childNodes[0];

    model.applyEvent(state, { type: "notice", level: "info", text: "second" });
    app.mount(doc, container, model.transcriptNodes(state));
    expect(container.childNodes).toHaveLength(2);
    // The untouched block keeps its element: no full re-render on every event.
    expect(container.childNodes[0]).toBe(first);

    // Mutating a tool block bumps its revision, so its element is rebuilt.
    model.applyEvent(state, {
      type: "toolStart",
      toolCallId: "c",
      toolName: "bash",
      input: { command: "id" },
    });
    app.mount(doc, container, model.transcriptNodes(state));
    const toolElement = container.childNodes[2];
    model.applyEvent(state, { type: "toolEnd", toolCallId: "c", result: toolResult() });
    app.mount(doc, container, model.transcriptNodes(state));
    expect(container.childNodes[2]).not.toBe(toolElement);
  });

  it("drops trailing elements when the node list shrinks", () => {
    const doc = new FakeDocument();
    const container = new FakeElement("main");
    const state = model.createState();
    model.applyEvent(state, { type: "notice", level: "info", text: "a" });
    model.applyEvent(state, { type: "notice", level: "info", text: "b" });
    app.mount(doc, container, model.transcriptNodes(state));
    expect(container.childNodes).toHaveLength(2);
    app.mount(doc, container, []);
    expect(container.childNodes).toHaveLength(0);
  });

  it("only ever builds elements from a fixed tag vocabulary", () => {
    const state = model.createState();
    model.applyEvent(state, {
      type: "messageEnd",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "# hi\n\n- a\n\n```\nx\n```" }],
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "endTurn",
        timestamp: 0,
      },
    });
    const allowed = new Set([
      "main",
      "div",
      "span",
      "p",
      "pre",
      "code",
      "strong",
      "ul",
      "ol",
      "li",
      "hr",
      "blockquote",
      "h3",
      "h4",
      "h5",
      "button",
    ]);
    for (const tag of tagsOf(renderTranscript(state))) {
      expect(allowed.has(tag)).toBe(true);
    }
  });
});
