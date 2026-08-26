/**
 * Turn grouping and the tool card's one-line summary, driven as functions.
 *
 * Same technique as `webview-markdown.test.ts` — the shipped source compiled
 * and called — so what is asserted here is the bytes the page runs.
 */

import { describe, expect, it } from "vitest";
import type { ChatBlock, ToolBlock, ToolStatus } from "./chat-state.js";
import { type ToolIcon, TRANSCRIPT_SOURCE, type Turn } from "./webview-transcript.js";

const api = new Function(
  `${TRANSCRIPT_SOURCE}\nreturn { groupTurns, toolSummary, toolStatusLabel, toolIcon, showWorking, toolGroup, toolDiff, formatElapsed };`,
)() as {
  groupTurns: (blocks: readonly ChatBlock[]) => Turn[];
  toolSummary: (argsText: string) => string;
  toolStatusLabel: (status: string) => string;
  toolIcon: (name: string) => ToolIcon;
  showWorking: (blocks: readonly ChatBlock[], running: boolean) => boolean;
  toolGroup: (before: string, after: string) => string;
  toolDiff: (
    argsText: string,
    complete: boolean,
  ) => {
    label: string;
    lines: { sign: string; text: string }[];
    hidden: number;
    rest: string;
  } | null;
  formatElapsed: (ms: number) => string;
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

describe("showWorking", () => {
  function toolAt(status: ToolStatus): ToolBlock {
    return { ...(tool("tool:k1") as ToolBlock), status };
  }

  it("says nothing is working when nothing is running", () => {
    expect(api.showWorking([user("u1")], false)).toBe(false);
    expect(api.showWorking([], false)).toBe(false);
  });

  it("covers the wait between a submitted prompt and the first output", () => {
    // The whole reason it exists: the user has pressed Enter, the host has
    // echoed the prompt into the log, and nothing else has arrived yet.
    expect(api.showWorking([user("u1")], true)).toBe(true);
    expect(api.showWorking([], true)).toBe(true);
  });

  it("stands down once something on screen is already moving", () => {
    // Two indicators for one state is a panel that looks busier than the run
    // it is describing. Streamed text has the caret; a running tool has the
    // spinner in its own card.
    expect(api.showWorking([user("u1"), text("t1")], true)).toBe(false);
    expect(api.showWorking([user("u1"), toolAt("running")], true)).toBe(false);
    expect(api.showWorking([user("u1"), toolAt("awaitingPermission")], true)).toBe(false);
    expect(
      api.showWorking([{ kind: "thinking", id: "th1", text: "hm", collapsed: false }], true),
    ).toBe(false);
  });

  it("comes back in the gap after a tool has finished and before the model answers", () => {
    // A settled tool card is not motion; without this the panel goes still
    // while the model is deciding what to do next.
    expect(api.showWorking([user("u1"), toolAt("ok")], true)).toBe(true);
    expect(api.showWorking([user("u1"), toolAt("error")], true)).toBe(true);
    expect(api.showWorking([{ kind: "notice", id: "n1", level: "info", text: "x" }], true)).toBe(
      true,
    );
  });
});

describe("toolGroup", () => {
  it("gives a lone tool call its own chrome", () => {
    expect(api.toolGroup("text", "text")).toBe("solo");
    expect(api.toolGroup("", "")).toBe("solo");
  });

  it("stacks a run of consecutive tool calls into one card", () => {
    expect(api.toolGroup("text", "tool")).toBe("first");
    expect(api.toolGroup("tool", "tool")).toBe("mid");
    expect(api.toolGroup("tool", "text")).toBe("last");
  });
});

describe("toolDiff", () => {
  const edit = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ path: "a.ts", oldText: "one\ntwo", newText: "one\nTWO", ...extra });

  it("draws an edit as removed lines above added ones", () => {
    // The whole point: JSON.stringify puts both versions on one line with the
    // newlines as backslash-n, and that is what a reader was being shown.
    const change = api.toolDiff(edit(), true);
    expect(change?.label).toBe("Change");
    expect(change?.lines).toEqual([
      { sign: "-", text: "one" },
      { sign: "-", text: "two" },
      { sign: "+", text: "one" },
      { sign: "+", text: "TWO" },
    ]);
  });

  it("keeps every argument the diff did not consume", () => {
    // An edit reviewed with replaceAll hidden is worse than the raw JSON was:
    // one is hard to read, the other is missing the thing that changes what
    // the call does.
    const change = api.toolDiff(edit({ replaceAll: true }), true);
    expect(JSON.parse(change?.rest ?? "{}")).toEqual({ path: "a.ts", replaceAll: true });
  });

  it("refuses to draw a change out of arguments that are still arriving", () => {
    // Half a newText is a change nobody is making. Mid-stream the fragment
    // does not parse anyway, but the flag is what makes the refusal true even
    // for a prefix that happens to be valid JSON on its own.
    const partial = '{"path":"a.ts","oldText":"one","newText":"on';
    expect(api.toolDiff(partial, true)).toBeNull();
    expect(api.toolDiff(edit(), false)).toBeNull();
  });

  it("returns nothing for a tool whose arguments are not a change", () => {
    expect(api.toolDiff(JSON.stringify({ command: "ls -la" }), true)).toBeNull();
    expect(api.toolDiff("not json", true)).toBeNull();
    expect(api.toolDiff(JSON.stringify(["a", "b"]), true)).toBeNull();
    // A no-op edit is not a diff: two identical sides would draw every line
    // as both removed and added.
    expect(
      api.toolDiff(JSON.stringify({ path: "a.ts", oldText: "x", newText: "x" }), true),
    ).toBeNull();
  });

  it("draws a lone body of text unsigned, because there is nothing to contrast it with", () => {
    // Green means "added, as against that red". With one side it is only
    // decoration, and on an unrecognised MCP tool it would be a claim the
    // panel has no basis for.
    const written = api.toolDiff(JSON.stringify({ path: "new.ts", content: "a\nb\n" }), true);
    expect(written?.label).toBe("Content");
    expect(written?.lines).toEqual([
      { sign: "", text: "a" },
      { sign: "", text: "b" },
    ]);
  });

  it("caps the lines it draws and says how many it left out", () => {
    // Stopping at 400 lines in silence reads as a complete change that is
    // exactly 400 lines long.
    const body = Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n");
    const written = api.toolDiff(JSON.stringify({ path: "big.ts", content: body }), true);
    expect(written?.lines).toHaveLength(400);
    expect(written?.hidden).toBe(50);
  });

  it("reads the spellings other engines and MCP servers use", () => {
    // The panel renders whatever engine it is pointed at, not only its own
    // tools, and old_string/new_string is the other common spelling.
    const change = api.toolDiff(
      JSON.stringify({ file_path: "a.ts", old_string: "x", new_string: "y" }),
      true,
    );
    expect(change?.lines).toEqual([
      { sign: "-", text: "x" },
      { sign: "+", text: "y" },
    ]);
  });
});

describe("formatElapsed", () => {
  it("uses the coarsest unit that still says something", () => {
    expect(api.formatElapsed(0)).toBe("0ms");
    expect(api.formatElapsed(940)).toBe("940ms");
    expect(api.formatElapsed(4_200)).toBe("4.2s");
    expect(api.formatElapsed(42_000)).toBe("42s");
    expect(api.formatElapsed(94_523)).toBe("1m 35s");
    expect(api.formatElapsed(3_600_000)).toBe("1h 0m");
  });

  it("carries instead of printing a sixtieth second", () => {
    // 119.6s rounds to 60 seconds past the first minute, which is 2m 0s.
    expect(api.formatElapsed(119_600)).toBe("2m 0s");
  });

  it("says nothing rather than printing a placeholder time", () => {
    expect(api.formatElapsed(Number.NaN)).toBe("");
    expect(api.formatElapsed(-1)).toBe("");
    expect(api.formatElapsed(Number.POSITIVE_INFINITY)).toBe("");
  });
});
