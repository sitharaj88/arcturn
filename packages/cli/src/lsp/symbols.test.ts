import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSymbolsTool,
  documentSymbols,
  formatSymbols,
  type SymbolCapableClient,
  type SymbolCapableManager,
  type SymbolInfo,
  workspaceSymbols,
} from "./symbols.js";

/**
 * An absolute path fixture that is genuinely absolute on the platform the
 * test runs on: `/repo/a.ts` on POSIX, `<current drive>:\repo\a.ts` on
 * Windows (a leading-slash path there is drive-*relative*, not absolute).
 *
 * `pathToFileURL` resolves a drive-less path against the current drive in
 * exactly the same way, so a `file://` URI built from this value round-trips
 * back to this value — which is the property these tests are about.
 */
function repoPath(...segments: string[]): string {
  return resolve("/repo", ...segments);
}

/** A fake {@link SymbolCapableClient} that answers fixed methods with canned results or delays. */
function fakeClient(
  handlers: Record<string, (params: unknown) => Promise<unknown>>,
): SymbolCapableClient {
  return {
    request(method, params) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(new Error(`fakeClient: unexpected method "${method}"`));
      return handler(params);
    },
  };
}

/** Never resolves within any reasonable test timeout, to exercise the timeout path. */
function neverResolves(): Promise<unknown> {
  return new Promise(() => {});
}

function fakeManager(options: {
  client?: SymbolCapableClient | null;
  activeClients?: SymbolCapableClient[];
}): SymbolCapableManager {
  return {
    clientFor: async () => options.client ?? null,
    activeClients: async () => options.activeClients ?? [],
  };
}

function fakeContext(cwd: string, signal?: AbortSignal): ToolExecutionContext {
  return {
    cwd,
    signal: signal ?? new AbortController().signal,
    requestPermission: async () => ({ requestId: "r", behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "s1",
    toolCallId: "t1",
  };
}

/** Extract the text of a `ToolResult`'s first content block, failing loudly if there isn't one. */
function firstText(result: ToolResult): string {
  const item = result.content[0];
  if (item?.type !== "text") throw new Error("expected a text content block");
  return item.text;
}

describe("documentSymbols", () => {
  it("returns null when the manager has no client for this path", async () => {
    const manager = fakeManager({ client: null });
    const result = await documentSymbols(manager, repoPath("a.ts"), "const a = 1;");
    expect(result).toBeNull();
  });

  it("parses a hierarchical DocumentSymbol[] response, flattening children", async () => {
    const client = fakeClient({
      "textDocument/documentSymbol": async () => [
        {
          name: "Foo",
          kind: 5, // class
          range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          children: [
            {
              name: "bar",
              kind: 6, // method
              range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
            },
          ],
        },
        {
          name: "helper",
          kind: 12, // function
          range: { start: { line: 12, character: 0 }, end: { line: 14, character: 1 } },
        },
      ],
    });
    const manager = fakeManager({ client });
    const result = await documentSymbols(manager, repoPath("a.ts"), "class Foo {}");
    expect(result).toEqual([
      { name: "Foo", kind: "class", path: repoPath("a.ts"), line: 1 },
      { name: "bar", kind: "method", path: repoPath("a.ts"), line: 2 },
      { name: "helper", kind: "function", path: repoPath("a.ts"), line: 13 },
    ] satisfies SymbolInfo[]);
  });

  it("parses a flat SymbolInformation[] response", async () => {
    const uri = pathToFileURL(repoPath("a.ts")).toString();
    const client = fakeClient({
      "textDocument/documentSymbol": async () => [
        {
          name: "Foo",
          kind: 5,
          location: {
            uri,
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } },
          },
        },
      ],
    });
    const manager = fakeManager({ client });
    const result = await documentSymbols(manager, repoPath("a.ts"), "class Foo {}");
    expect(result).toEqual([{ name: "Foo", kind: "class", path: repoPath("a.ts"), line: 5 }]);
  });

  it("maps unknown SymbolKind numbers to a fallback name", async () => {
    const client = fakeClient({
      "textDocument/documentSymbol": async () => [
        {
          name: "weird",
          kind: 999,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    });
    const manager = fakeManager({ client });
    const result = await documentSymbols(manager, repoPath("a.ts"), "");
    expect(result).toEqual([{ name: "weird", kind: "symbol", path: repoPath("a.ts"), line: 1 }]);
  });

  it("returns an empty array when the server reports no symbols", async () => {
    const client = fakeClient({ "textDocument/documentSymbol": async () => [] });
    const manager = fakeManager({ client });
    const result = await documentSymbols(manager, repoPath("a.ts"), "");
    expect(result).toEqual([]);
  });

  it("returns null when the request does not resolve within the timeout", async () => {
    const client = fakeClient({ "textDocument/documentSymbol": neverResolves });
    const manager = fakeManager({ client });
    const result = await documentSymbols(manager, repoPath("a.ts"), "", 20);
    expect(result).toBeNull();
  });

  it("returns null when the request rejects", async () => {
    const client = fakeClient({
      "textDocument/documentSymbol": async () => {
        throw new Error("server exploded");
      },
    });
    const manager = fakeManager({ client });
    const result = await documentSymbols(manager, repoPath("a.ts"), "");
    expect(result).toBeNull();
  });
});

describe("workspaceSymbols", () => {
  it("returns null when there are no active clients", async () => {
    const manager = fakeManager({ activeClients: [] });
    const result = await workspaceSymbols(manager, "Foo");
    expect(result).toBeNull();
  });

  it("combines matches from every active client", async () => {
    const uriA = pathToFileURL(repoPath("a.ts")).toString();
    const uriB = pathToFileURL(repoPath("b.py")).toString();
    const clientA = fakeClient({
      "workspace/symbol": async () => [
        {
          name: "FooA",
          kind: 5,
          location: {
            uri: uriA,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        },
      ],
    });
    const clientB = fakeClient({
      "workspace/symbol": async () => [
        {
          name: "FooB",
          kind: 12,
          location: {
            uri: uriB,
            range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
          },
        },
      ],
    });
    const manager = fakeManager({ activeClients: [clientA, clientB] });
    const result = await workspaceSymbols(manager, "Foo");
    expect(result).toEqual([
      { name: "FooA", kind: "class", path: repoPath("a.ts"), line: 1 },
      { name: "FooB", kind: "function", path: repoPath("b.py"), line: 10 },
    ]);
  });

  it("drops entries whose location uri cannot be parsed to a path", async () => {
    const client = fakeClient({
      "workspace/symbol": async () => [{ name: "Nowhere", kind: 5, location: { uri: 42 } }],
    });
    const manager = fakeManager({ activeClients: [client] });
    const result = await workspaceSymbols(manager, "Nowhere");
    expect(result).toEqual([]);
  });

  it("decodes a percent-escaped file:// uri back to the exact path on disk", async () => {
    // A language server answers with a `file://` URI, and what that URI looks
    // like is platform-dependent: on Windows it carries a drive letter and
    // forward slashes (`file:///C:/repo/...`) where POSIX has neither. Either
    // way the parsed result must be the path the file actually lives at, with
    // every escape decoded — a naive `uri.slice("file://".length)` passes on
    // POSIX for tidy names and is wrong for both of these.
    const messy = repoPath("a dir", "sp#ce & \u00fcnicode.ts");
    const uri = pathToFileURL(messy).toString();
    expect(uri).toContain("%"); // the URI really is escaped, so decoding is load-bearing
    const client = fakeClient({
      "workspace/symbol": async () => [
        {
          name: "Messy",
          kind: 5,
          location: {
            uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        },
      ],
    });
    const manager = fakeManager({ activeClients: [client] });
    const result = await workspaceSymbols(manager, "Messy");
    expect(result).toEqual([{ name: "Messy", kind: "class", path: messy, line: 1 }]);
    expect(fileURLToPath(uri)).toBe(messy);
  });

  it("returns null when every active client times out", async () => {
    const client = fakeClient({ "workspace/symbol": neverResolves });
    const manager = fakeManager({ activeClients: [client] });
    const result = await workspaceSymbols(manager, "Foo", 20);
    expect(result).toBeNull();
  });

  it("keeps results from clients that answer even if one sibling times out", async () => {
    const uri = pathToFileURL(repoPath("a.ts")).toString();
    const slow = fakeClient({ "workspace/symbol": neverResolves });
    const fast = fakeClient({
      "workspace/symbol": async () => [
        {
          name: "Fast",
          kind: 5,
          location: {
            uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        },
      ],
    });
    const manager = fakeManager({ activeClients: [slow, fast] });
    const result = await workspaceSymbols(manager, "Fast", 20);
    expect(result).toEqual([{ name: "Fast", kind: "class", path: repoPath("a.ts"), line: 1 }]);
  });
});

describe("formatSymbols", () => {
  it("returns a placeholder message for an empty list", () => {
    expect(formatSymbols([])).toBe("No symbols found.");
  });

  it("renders compact 'kind name  path:line' lines", () => {
    const symbols: SymbolInfo[] = [
      { name: "Foo", kind: "class", path: "/repo/a.ts", line: 1 },
      { name: "bar", kind: "method", path: "/repo/a.ts", line: 2 },
    ];
    expect(formatSymbols(symbols)).toBe("class Foo  /repo/a.ts:1\nmethod bar  /repo/a.ts:2");
  });

  it("caps output at 50 entries with a trailing '… N more'", () => {
    const symbols: SymbolInfo[] = Array.from({ length: 65 }, (_, i) => ({
      name: `sym${i}`,
      kind: "function",
      path: "/repo/a.ts",
      line: i + 1,
    }));
    const formatted = formatSymbols(symbols);
    const lines = formatted.split("\n");
    expect(lines).toHaveLength(51);
    expect(lines[50]).toBe("… 15 more");
    expect(lines[0]).toBe("function sym0  /repo/a.ts:1");
  });
});

describe("createSymbolsTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-symbols-tool-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is named 'symbols' and requires no permission field", () => {
    const tool: Tool = createSymbolsTool(fakeManager({ client: null }));
    expect(tool.definition.name).toBe("symbols");
    expect(tool.definition.parameters).toMatchObject({ type: "object" });
  });

  it("errors when neither file nor query is given", async () => {
    const tool = createSymbolsTool(fakeManager({ client: null }));
    const result = await tool.execute({}, fakeContext(dir));
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/provide either/i);
  });

  it("errors when both file and query are given", async () => {
    const tool = createSymbolsTool(fakeManager({ client: null }));
    const result = await tool.execute({ file: "a.ts", query: "Foo" }, fakeContext(dir));
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/only one/i);
  });

  it("returns document symbols for `file`, formatted, with details", async () => {
    const filePath = join(dir, "a.ts");
    await writeFile(filePath, "class Foo {}\n", "utf8");
    const client = fakeClient({
      "textDocument/documentSymbol": async () => [
        {
          name: "Foo",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
        },
      ],
    });
    const tool = createSymbolsTool(fakeManager({ client }));
    const result = await tool.execute({ file: "a.ts" }, fakeContext(dir));
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe(`class Foo  ${filePath}:1`);
    expect(result.details).toEqual({ symbolCount: 1, mode: "file" });
  });

  it("returns a friendly message when no server is available for `file`", async () => {
    const filePath = join(dir, "a.ts");
    await writeFile(filePath, "class Foo {}\n", "utf8");
    const tool = createSymbolsTool(fakeManager({ client: null }));
    const result = await tool.execute({ file: "a.ts" }, fakeContext(dir));
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toMatch(/no language server/i);
  });

  it("errors when `file` cannot be read", async () => {
    const tool = createSymbolsTool(fakeManager({ client: null }));
    const result = await tool.execute({ file: "does-not-exist.ts" }, fakeContext(dir));
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/could not read/i);
  });

  it("returns workspace symbols for `query`, formatted, with details", async () => {
    const uri = pathToFileURL(join(dir, "a.ts")).toString();
    const client = fakeClient({
      "workspace/symbol": async () => [
        {
          name: "Foo",
          kind: 5,
          location: {
            uri,
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
          },
        },
      ],
    });
    const tool = createSymbolsTool(fakeManager({ activeClients: [client] }));
    const result = await tool.execute({ query: "Foo" }, fakeContext(dir));
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe(`class Foo  ${join(dir, "a.ts")}:3`);
    expect(result.details).toEqual({ symbolCount: 1, mode: "query" });
  });

  it("returns a friendly message when no server is active for `query`", async () => {
    const tool = createSymbolsTool(fakeManager({ activeClients: [] }));
    const result = await tool.execute({ query: "Foo" }, fakeContext(dir));
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toMatch(/no language server/i);
  });

  it("returns an aborted error when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createSymbolsTool(fakeManager({ client: null }));
    const result = await tool.execute({ query: "Foo" }, fakeContext(dir, controller.signal));
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/aborted/i);
  });
});
