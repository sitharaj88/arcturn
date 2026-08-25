/**
 * Turn grouping and the tool card's one-line summary, driven as functions.
 *
 * Same technique as `webview-markdown.test.ts` — the shipped source compiled
 * and called — so what is asserted here is the bytes the page runs.
 */

import { describe, expect, it } from "vitest";
import type { ChatBlock } from "./chat-state.js";
import { type ToolIcon, TRANSCRIPT_SOURCE, type Turn } from "./webview-transcript.js";

const api = new Function(
  `${TRANSCRIPT_SOURCE}\nreturn { groupTurns, toolSummary, toolStatusLabel, toolIcon };`,
)() as {
  groupTurns: (blocks: readonly ChatBlock[]) => Turn[];
  toolSummary: (argsText: string) => string;
  toolStatusLabel: (status: string) => string;
  toolIcon: (name: string) => ToolIcon;
};

function user(id: string): ChatBlock {
  return { kind: "user", id, text: "hi" };
}
function text(id: string): ChatBlock {
  return { kind: "text", id, text: "sure" };
}
function tool(id: string): ChatBlock {
  return {
    kind: "tool",
    id,
    toolCallId: id,
    name: "bash",
    argsText: "",
    argsComplete: false,
    status: "running",
    progress: "",
    result: "",
    collapsed: true,
  };
}
function notice(id: string): ChatBlock {
  return { kind: "notice", id, level: "warn", text: "Run aborted" };
}

describe("groupTurns", () => {
  it("gathers everything the model did after a prompt into one turn", () => {
    expect(api.groupTurns([user("u1"), text("t1"), tool("k1"), text("t2")])).toEqual([
      { key: "u1", role: "user", blockIds: ["u1"] },
      { key: "t1", role: "assistant", blockIds: ["t1", "k1", "t2"] },
    ]);
  });

  it("starts a new turn for a second prompt rather than merging the two", () => {
    expect(api.groupTurns([user("u1"), user("u2")]).map((turn) => turn.key)).toEqual(["u1", "u2"]);
  });

  it("keeps notices out of the assistant's turn", () => {
    expect(api.groupTurns([text("t1"), notice("n1"), notice("n2"), text("t2")])).toEqual([
      { key: "t1", role: "assistant", blockIds: ["t1"] },
      { key: "n1", role: "notice", blockIds: ["n1", "n2"] },
      { key: "t2", role: "assistant", blockIds: ["t2"] },
    ]);
  });

  it("keys a turn by its first block, so a repaint can match it to what is on screen", () => {
    const before = api.groupTurns([user("u1"), text("t1")]);
    const after = api.groupTurns([user("u1"), text("t1"), tool("k1")]);
    expect(after.map((turn) => turn.key)).toEqual(before.map((turn) => turn.key));
  });

  it("has nothing to say about nothing", () => {
    expect(api.groupTurns([])).toEqual([]);
  });
});

describe("toolSummary", () => {
  it("names the command a shell tool was given", () => {
    expect(api.toolSummary('{"command":"pnpm -r run typecheck","timeout":120}')).toBe(
      "pnpm -r run typecheck",
    );
  });

  it("names the file a read or an edit was pointed at", () => {
    expect(api.toolSummary('{"path":"/repo/src/index.ts"}')).toBe("/repo/src/index.ts");
    expect(api.toolSummary('{"file_path":"/repo/a.ts","old_string":"x"}')).toBe("/repo/a.ts");
  });

  it("reads a fragment that has not finished arriving", () => {
    expect(api.toolSummary('{"command":"npm run bui')).toBe("npm run bui");
    expect(api.toolSummary('{"file_path":"/repo/src/we')).toBe("/repo/src/we");
  });

  it("collapses whitespace so a multi-line argument stays one line", () => {
    expect(api.toolSummary('{"command":"a\\n  b\\tc"}')).toBe("a b c");
    expect(api.toolSummary('{"command":"a\\n  b')).toBe("a b");
  });

  it("truncates rather than letting one argument push the status off the row", () => {
    const long = api.toolSummary(JSON.stringify({ command: "x".repeat(400) }));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("says nothing when the arguments say nothing yet", () => {
    expect(api.toolSummary("")).toBe("");
    expect(api.toolSummary("{")).toBe("");
    expect(api.toolSummary("{}")).toBe("");
  });

  it("falls back to the first string argument for a tool it has never heard of", () => {
    expect(api.toolSummary('{"count":3,"needle":"widget"}')).toBe("widget");
  });
});

describe("toolStatusLabel", () => {
  it("gives every status the engine reports a word a person would use", () => {
    expect(api.toolStatusLabel("running")).toBe("Running");
    expect(api.toolStatusLabel("ok")).toBe("Done");
    expect(api.toolStatusLabel("error")).toBe("Failed");
    expect(api.toolStatusLabel("denied")).toBe("Denied");
    expect(api.toolStatusLabel("awaitingPermission")).toBe("Needs permission");
    expect(api.toolStatusLabel("pending")).toBe("Queued");
  });
});

describe("toolIcon", () => {
  it("recognises the tool families the engine ships", () => {
    expect(api.toolIcon("bash")).toBe("terminal");
    expect(api.toolIcon("Read")).toBe("file");
    expect(api.toolIcon("write_file")).toBe("edit");
    expect(api.toolIcon("apply_patch")).toBe("edit");
    expect(api.toolIcon("grep")).toBe("search");
    expect(api.toolIcon("web_fetch")).toBe("web");
    expect(api.toolIcon("todo_write")).toBe("list");
  });

  it("reads whole name segments, not substrings", () => {
    // "frobniCATe" contains "cat"; a substring test would call it a file read.
    expect(api.toolIcon("frobnicate")).toBe("tool");
    // "todo_write" is a todo list before it is a write; "web_search" is the web.
    expect(api.toolIcon("todo_write")).toBe("list");
    expect(api.toolIcon("web_search")).toBe("web");
    // camelCase is a segment boundary too.
    expect(api.toolIcon("readFile")).toBe("file");
    expect(api.toolIcon("Bash")).toBe("terminal");
  });

  it("draws the generic mark rather than a wrong one for a tool it does not know", () => {
    expect(api.toolIcon("mcp__acme__frobnicate")).toBe("tool");
    expect(api.toolIcon("")).toBe("tool");
  });
});
