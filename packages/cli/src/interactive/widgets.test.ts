import {
  ColorLevel,
  darkTheme,
  lightTheme,
  setColorLevel,
  setTheme,
  stripAnsi,
  style,
} from "@arcturn/tui";
import type { TodoItem } from "@arcturn/types";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ASCII_GLYPHS, FANCY_GLYPHS } from "../glyphs.js";
import type { SubagentStatus } from "./activity.js";
import {
  CachedDynamic,
  renderSubagentRows,
  renderTodoWidget,
  renderToolCallProgress,
} from "./widgets.js";

beforeAll(() => {
  setColorLevel(ColorLevel.Ansi256);
});

/** A live sub-agent with sensible defaults, overridable per test. */
function agent(overrides: Partial<SubagentStatus> = {}): SubagentStatus {
  return {
    id: "a1",
    task: "map the quiz topics and data structure",
    depth: 0,
    startedAt: 0,
    tokens: 23_100,
    turns: 3,
    toolCalls: 4,
    activity: "bash",
    todos: undefined,
    ...overrides,
  };
}

describe("renderSubagentRows", () => {
  it("renders nothing when no sub-agent is running", () => {
    expect(renderSubagentRows([], 80, FANCY_GLYPHS, 1_000)).toEqual([]);
  });

  it("names the task and reports elapsed, tokens and current tool", () => {
    const [row] = renderSubagentRows([agent()], 80, FANCY_GLYPHS, 252_000).map(stripAnsi);
    expect(row).toContain("↳ map the quiz topics and data structure");
    expect(row).toContain("4m12s");
    expect(row).toContain("23.1k");
    expect(row).toContain("bash");
  });

  it("shows the sub-agent's own todo progress when it keeps a list", () => {
    const rows = renderSubagentRows(
      [agent({ todos: { done: 3, total: 6 } })],
      80,
      FANCY_GLYPHS,
      252_000,
    ).map(stripAnsi);
    expect(rows[0]).toContain("3/6");
  });

  it("indents nested sub-agents by depth", () => {
    const rows = renderSubagentRows(
      [agent({ id: "a1", depth: 0 }), agent({ id: "a2", depth: 1 })],
      80,
      FANCY_GLYPHS,
      252_000,
    ).map(stripAnsi);
    expect(rows[0]?.startsWith("  ↳ ")).toBe(true);
    expect(rows[1]?.startsWith("    ↳ ")).toBe(true);
  });

  it("sheds detail from the right rather than the task as width shrinks", () => {
    for (const width of [80, 60, 44, 32, 24]) {
      const [row] = renderSubagentRows([agent()], width, FANCY_GLYPHS, 252_000).map(stripAnsi);
      expect(row?.length).toBeLessThanOrEqual(width);
      // The task always survives, even when every detail segment is dropped.
      expect(row).toContain("map the");
    }
  });

  it("summarises the overflow past maxRows", () => {
    const agents = [1, 2, 3, 4, 5, 6].map((n) => agent({ id: `a${n}` }));
    const rows = renderSubagentRows(agents, 80, FANCY_GLYPHS, 252_000, 4).map(stripAnsi);
    expect(rows).toHaveLength(5);
    expect(rows[4]).toContain("… 2 more");
  });
});

describe("renderTodoWidget", () => {
  const todos: readonly TodoItem[] = [
    { text: "read the code", status: "done" },
    { text: "write the code", status: "inProgress" },
  ];

  it("colours an in-progress item as active while a run is under way", () => {
    const rows = renderTodoWidget(todos, 80, FANCY_GLYPHS, 8, true);
    const active = rows.find((row) => row.includes("write the code"));
    const done = rows.find((row) => row.includes("read the code"));
    expect(active).toBeDefined();
    expect(active).not.toBe(stripAnsi(active ?? ""));
    // Active and done rows are styled differently from one another.
    expect(active?.slice(0, 10)).not.toBe(done?.slice(0, 10));
  });

  it("warns instead of claiming activity when the run has stopped mid-item", () => {
    const running = renderTodoWidget(todos, 80, FANCY_GLYPHS, 8, true);
    const stopped = renderTodoWidget(todos, 80, FANCY_GLYPHS, 8, false);
    const rowOf = (rows: string[]) => rows.find((row) => row.includes("write the code")) ?? "";
    // Same text, different colour: nothing is running, so the accent that means
    // "happening now" everywhere else would be a lie.
    expect(stripAnsi(rowOf(stopped))).toBe(stripAnsi(rowOf(running)));
    expect(rowOf(stopped)).not.toBe(rowOf(running));
  });
});

describe("renderToolCallProgress", () => {
  it("renders nothing when no tool call is streaming", () => {
    expect(renderToolCallProgress(undefined, 80, FANCY_GLYPHS)).toEqual([]);
    expect(renderToolCallProgress({ name: "write", chars: 0, count: 0 }, 80)).toEqual([]);
  });

  it("names the tool and its streamed argument size", () => {
    const [line] = renderToolCallProgress({ name: "write", chars: 18_240, count: 1 }, 80).map(
      stripAnsi,
    );
    expect(line).toContain("write");
    expect(line).toContain("18.2k chars");
  });

  it("collapses parallel calls into an aggregate instead of naming one", () => {
    const [line] = renderToolCallProgress({ name: "grep", chars: 2_400, count: 3 }, 80).map(
      stripAnsi,
    );
    expect(line).toContain("3 tool calls");
    expect(line).not.toContain("grep");
    expect(line).toContain("2.4k chars");
  });

  it("never overflows the terminal width, in either glyph set", () => {
    for (const glyphs of [FANCY_GLYPHS, ASCII_GLYPHS]) {
      for (const width of [20, 34, 80]) {
        const [line] = renderToolCallProgress(
          { name: "write", chars: 1_234_567, count: 1 },
          width,
          glyphs,
        );
        expect(stripAnsi(line ?? "").length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("CachedDynamic", () => {
  afterEach(() => {
    setTheme(darkTheme);
  });

  it("reuses its lines while width and version hold", () => {
    let calls = 0;
    const zone = new CachedDynamic(
      () => 0,
      () => {
        calls += 1;
        return [style("accent")("zone")];
      },
    );
    expect(zone.render(40)).toEqual(zone.render(40));
    expect(calls).toBe(1);
  });

  it("re-renders when the theme changes, not only when its own version does", () => {
    let calls = 0;
    const zone = new CachedDynamic(
      // A zone whose inputs never change — the status rule is exactly this.
      () => 0,
      () => {
        calls += 1;
        return [style("accent")("zone")];
      },
    );
    const dark = zone.render(40);
    expect(calls).toBe(1);

    setTheme(lightTheme);
    const light = zone.render(40);
    expect(calls).toBe(2);
    // Same text, new palette: a cached zone that ignores the theme would hand
    // back the dark line forever.
    expect(stripAnsi(light[0] ?? "")).toBe(stripAnsi(dark[0] ?? ""));
    expect(light).not.toEqual(dark);

    // And the new palette is itself cached: no re-render cost per frame.
    expect(zone.render(40)).toEqual(light);
    expect(calls).toBe(2);
  });
});
