import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { describe, expect, it, vi } from "vitest";
import {
  createDeferredToolset,
  DEFAULT_ALWAYS_ACTIVE_TOOLS,
  type DeferredToolset,
} from "./deferred-tools.js";
import { contentText } from "./util/content.js";

function tool(name: string, description: string, extra: Record<string, unknown> = {}): Tool {
  return {
    definition: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { input: { type: "string" }, ...extra },
        required: ["input"],
      },
    },
    async execute(): Promise<ToolResult> {
      return { content: [{ type: "text", text: `${name} ran` }] };
    },
  };
}

function ctx(signal: AbortSignal = new AbortController().signal): ToolExecutionContext {
  return {
    cwd: "/work",
    signal,
    requestPermission: async () => ({ behavior: "allow" }) as never,
    onUpdate: () => {},
    sessionId: "s1",
    toolCallId: "c1",
  };
}

const SAMPLE: Tool[] = [
  tool("read", "Read a file from disk."),
  tool("bash", "Run a shell command."),
  tool("web_search", "Search the web for pages matching a query."),
  tool("web_fetch", "Fetch the contents of a URL and convert it to markdown."),
  tool("notebook_edit", "Edit a cell in a Jupyter notebook."),
  tool("send_email", "Send an email message to a recipient."),
];

function makeSet(overrides: Partial<Parameters<typeof createDeferredToolset>[0]> = {}) {
  return createDeferredToolset({ tools: SAMPLE, ...overrides });
}

async function search(
  set: DeferredToolset,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return set.searchTool().execute(input, ctx(signal));
}

describe("DeferredToolset construction", () => {
  it("keeps the default core active and defers the rest", () => {
    const set = makeSet();
    expect(set.activeTools().map((t) => t.definition.name)).toEqual([
      "read",
      "bash",
      "tool_search",
    ]);
    expect(set.deferredTools().map((t) => t.definition.name)).toEqual([
      "web_search",
      "web_fetch",
      "notebook_edit",
      "send_email",
    ]);
    expect(DEFAULT_ALWAYS_ACTIVE_TOOLS).toContain("read");
  });

  it("honours an explicit alwaysActive list and ignores unknown names in it", () => {
    const set = makeSet({ alwaysActive: ["web_search", "nope"] });
    expect(set.isActive("web_search")).toBe(true);
    expect(set.isActive("read")).toBe(false);
    expect(set.isActive("nope")).toBe(false);
  });

  it("drops duplicate tool names, first registration wins", () => {
    const set = createDeferredToolset({
      tools: [tool("dup", "first"), tool("dup", "second")],
      alwaysActive: [],
    });
    expect(set.allTools()).toHaveLength(1);
    expect(set.renderDeferredIndex()).toBe("dup — first");
  });

  it("never registers a host tool that collides with the search tool name", () => {
    const set = createDeferredToolset({
      tools: [tool("tool_search", "impostor")],
      alwaysActive: [],
    });
    expect(set.allTools()).toHaveLength(0);
    expect(set.activeTools().map((t) => t.definition.name)).toEqual(["tool_search"]);
  });

  it("uses a custom search tool name", () => {
    const set = makeSet({ searchToolName: "find_tools" });
    expect(set.searchToolName).toBe("find_tools");
    expect(set.searchTool().definition.name).toBe("find_tools");
    expect(set.isActive("find_tools")).toBe(true);
  });

  it("always includes the search tool, even with nothing deferred", () => {
    const set = createDeferredToolset({
      tools: SAMPLE,
      alwaysActive: SAMPLE.map((t) => t.definition.name),
    });
    expect(set.deferredTools()).toEqual([]);
    expect(set.activeTools().map((t) => t.definition.name)).toContain("tool_search");
    expect(set.searchTool().definition.description).toContain("No tools are deferred");
  });
});

describe("renderDeferredIndex", () => {
  it("renders one compact line per deferred tool in registration order", () => {
    const set = makeSet();
    expect(set.renderDeferredIndex()).toBe(
      [
        "web_search — Search the web for pages matching a query.",
        "web_fetch — Fetch the contents of a URL and convert it to markdown.",
        "notebook_edit — Edit a cell in a Jupyter notebook.",
        "send_email — Send an email message to a recipient.",
      ].join("\n"),
    );
  });

  it("uses only the first line and truncates long descriptions", () => {
    const long = `${"x".repeat(400)}\nsecond line`;
    const set = createDeferredToolset({ tools: [tool("big", long)], alwaysActive: [] });
    const line = set.renderDeferredIndex();
    expect(line.startsWith("big — xxx")).toBe(true);
    expect(line).not.toContain("second line");
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(200);
  });

  it("is empty once nothing is deferred", () => {
    const set = makeSet();
    set.activate(["web_search", "web_fetch", "notebook_edit", "send_email"]);
    expect(set.renderDeferredIndex()).toBe("");
  });
});

describe("search tool description", () => {
  it("embeds the deferred index and refreshes as tools activate", () => {
    const set = makeSet();
    const searchTool = set.searchTool();
    expect(searchTool.definition.description).toContain("web_search — Search the web");

    set.activate(["web_search"]);

    // Same tool object, updated description — the loop re-reads .definition per turn.
    expect(set.searchTool()).toBe(searchTool);
    expect(searchTool.definition.description).not.toContain("web_search —");
    expect(searchTool.definition.description).toContain("notebook_edit —");
  });

  it("exposes a query/select schema and read-only annotations", () => {
    const set = makeSet();
    const def = set.searchTool().definition;
    const props = (def.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["query", "select"]);
    expect(set.searchTool().annotations?.readOnlyHint).toBe(true);
  });
});

describe("activate", () => {
  it("reports activated, already-active and unknown names without throwing", () => {
    const set = makeSet();
    const first = set.activate(["web_search"]);
    expect(first).toEqual({ activated: ["web_search"], alreadyActive: [], unknown: [] });

    const second = set.activate(["web_search", "read", "ghost", "web_fetch"]);
    expect(second).toEqual({
      activated: ["web_fetch"],
      alreadyActive: ["web_search", "read"],
      unknown: ["ghost"],
    });
  });

  it("de-duplicates names inside a single call", () => {
    const set = makeSet();
    expect(set.activate(["web_fetch", "web_fetch"]).activated).toEqual(["web_fetch"]);
  });

  it("fires onActivate only for newly activated names", () => {
    const onActivate = vi.fn();
    const set = makeSet({ onActivate });
    set.activate(["web_search"]);
    set.activate(["web_search"]);
    set.activate(["ghost"]);
    set.activate(["send_email", "web_fetch"]);
    expect(onActivate.mock.calls).toEqual([[["web_search"]], [["send_email", "web_fetch"]]]);
  });

  it("adds activated tools to activeTools in registration order", () => {
    const set = makeSet();
    set.activate(["send_email"]);
    set.activate(["web_search"]);
    expect(set.activeTools().map((t) => t.definition.name)).toEqual([
      "read",
      "bash",
      "web_search",
      "send_email",
      "tool_search",
    ]);
  });
});

describe("tool_search execution", () => {
  it("activates matches by query and returns their schemas", async () => {
    const set = makeSet();
    const result = await search(set, { query: "search the web" });

    expect(result.isError).toBeUndefined();
    const body = contentText(result.content);
    expect(body).toContain("## web_search");
    expect(body).toContain('"type": "object"');
    expect(body).toContain("Still deferred:");
    expect(set.isActive("web_search")).toBe(true);
    expect(result.details?.activated).toContain("web_search");
  });

  it("ranks an exact name match first and is deterministic", async () => {
    const set = makeSet();
    const result = await search(set, { query: "web_fetch" });
    const activated = result.details?.activated as string[];
    expect(activated[0]).toBe("web_fetch");
  });

  it("matches on description tokens as well as names", async () => {
    const set = makeSet();
    await search(set, { query: "jupyter" });
    expect(set.isActive("notebook_edit")).toBe(true);
  });

  it("caps results at maxResults", async () => {
    const set = makeSet({ maxResults: 1 });
    const result = await search(set, { query: "web" });
    const activated = result.details?.activated as string[];
    expect(activated.length).toBe(1);
  });

  it("activates exact names given in select", async () => {
    const set = makeSet();
    const result = await search(set, { query: "", select: ["send_email"] });
    expect(result.isError).toBeUndefined();
    expect(set.isActive("send_email")).toBe(true);
  });

  it("reports unknown select names instead of throwing", async () => {
    const set = makeSet();
    const result = await search(set, { select: ["send_email", "ghost"] });
    expect(result.isError).toBeUndefined();
    expect(contentText(result.content)).toContain("No such tool, ignored: ghost.");
    expect(result.details?.unknown).toEqual(["ghost"]);
  });

  it("errors with the index when only unknown names are selected", async () => {
    const set = makeSet();
    const result = await search(set, { select: ["ghost"] });
    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain("Unknown names: ghost.");
    expect(contentText(result.content)).toContain("Deferred tools:");
  });

  it("errors with the index when the query matches nothing", async () => {
    const set = makeSet();
    const result = await search(set, { query: "quantum tunnelling" });
    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain('No deferred tool matched "quantum tunnelling"');
    expect(contentText(result.content)).toContain("send_email —");
  });

  it("errors and shows the index for an empty query with no select", async () => {
    const set = makeSet();
    for (const input of [{}, { query: "   " }, { query: "", select: [] }]) {
      const result = await search(set, input);
      expect(result.isError).toBe(true);
      expect(contentText(result.content)).toContain("Provide a query or select.");
    }
  });

  it("re-searching an active tool is a reported no-op", async () => {
    const set = makeSet();
    await search(set, { select: ["web_search"] });
    const again = await search(set, { select: ["web_search"] });
    expect(again.isError).toBeUndefined();
    expect(again.details?.activated).toEqual([]);
    expect(contentText(again.content)).toContain(
      "Already active (call them directly): web_search.",
    );
  });

  it("rejects malformed input as an error value", async () => {
    const set = makeSet();
    expect((await search(set, { query: 42 })).isError).toBe(true);
    expect((await search(set, { select: "web_search" })).isError).toBe(true);
    expect((await search(set, { select: [1, 2] })).isError).toBe(true);
    expect(set.snapshot().activated).toEqual([]);
  });

  it("returns an error result when the run is already aborted", async () => {
    const set = makeSet();
    const controller = new AbortController();
    controller.abort();
    const result = await search(set, { query: "web" }, controller.signal);
    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toBe("Tool search aborted.");
    expect(set.isActive("web_search")).toBe(false);
  });

  it("says so when nothing remains deferred", async () => {
    const set = makeSet();
    const result = await search(set, {
      select: ["web_search", "web_fetch", "notebook_edit", "send_email"],
    });
    expect(contentText(result.content)).toContain("No tools remain deferred.");
    expect(result.details?.deferred).toEqual([]);
  });
});

describe("snapshot / restore", () => {
  it("round-trips activation state across instances", () => {
    const set = makeSet();
    set.activate(["send_email", "web_fetch"]);
    const snap = set.snapshot();
    expect(snap.activated).toEqual(["send_email", "web_fetch"]);

    const fresh = makeSet();
    fresh.restore(snap);
    expect(fresh.isActive("send_email")).toBe(true);
    expect(fresh.isActive("web_fetch")).toBe(true);
    expect(fresh.isActive("notebook_edit")).toBe(false);
    expect(fresh.searchTool().definition.description).not.toContain("send_email —");
  });

  it("drops names that no longer exist and never fires onActivate", () => {
    const onActivate = vi.fn();
    const set = createDeferredToolset({ tools: SAMPLE.slice(0, 3), onActivate });
    set.restore({ activated: ["web_search", "gone", "read"] });
    expect(set.snapshot().activated).toEqual(["web_search"]);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("replaces rather than merges prior activation", () => {
    const set = makeSet();
    set.activate(["send_email"]);
    set.restore({ activated: ["web_fetch"] });
    expect(set.snapshot().activated).toEqual(["web_fetch"]);
    expect(set.isActive("send_email")).toBe(false);
  });
});
