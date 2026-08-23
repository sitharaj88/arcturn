import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeContext } from "./test-utils.js";
import {
  createWebSearchTool,
  formatResults,
  parseBraveResponse,
  parseDuckDuckGoHtml,
} from "./websearch.js";

const DDG_FIXTURE = `
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="result__body">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&amp;rut=abc">First Result &amp; Title</a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">This is the <b>first</b> snippet.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="result__body">
      <a class="result__a" href="https://example.org/second">Second Result</a>
      <a class="result__snippet" href="x">Second snippet text.</a>
    </div>
  </div>
</div>
`;

describe("parseDuckDuckGoHtml", () => {
  it("extracts titles, decoded redirect URLs, and snippets", () => {
    const results = parseDuckDuckGoHtml(DDG_FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "First Result & Title",
      url: "https://example.com/first",
      description: "This is the first snippet.",
    });
    expect(results[1]).toEqual({
      title: "Second Result",
      url: "https://example.org/second",
      description: "Second snippet text.",
    });
  });

  it("returns an empty array when there are no result anchors", () => {
    expect(parseDuckDuckGoHtml("<html><body>no results here</body></html>")).toEqual([]);
  });
});

describe("parseBraveResponse", () => {
  it("extracts title/url/description from web.results", () => {
    const results = parseBraveResponse({
      web: {
        results: [
          { title: "Brave One", url: "https://a.example", description: "desc <b>one</b>" },
          { title: "Brave Two", url: "https://b.example", description: "desc two" },
        ],
      },
    });
    expect(results).toEqual([
      { title: "Brave One", url: "https://a.example", description: "desc one" },
      { title: "Brave Two", url: "https://b.example", description: "desc two" },
    ]);
  });

  it("returns an empty array for malformed/missing shapes", () => {
    expect(parseBraveResponse({})).toEqual([]);
    expect(parseBraveResponse(null)).toEqual([]);
    expect(parseBraveResponse({ web: {} })).toEqual([]);
    expect(parseBraveResponse({ web: { results: "nope" } })).toEqual([]);
  });

  it("skips entries missing a title or url", () => {
    const results = parseBraveResponse({
      web: { results: [{ title: "", url: "https://a.example" }, { url: "https://b.example" }] },
    });
    expect(results).toEqual([]);
  });
});

describe("formatResults", () => {
  it("numbers results as 'title — url' with indented snippets", () => {
    const text = formatResults([
      { title: "Foo", url: "https://foo.example", description: "a snippet" },
      { title: "Bar", url: "https://bar.example", description: "" },
    ]);
    expect(text).toBe(
      "1. Foo — https://foo.example\n    a snippet\n\n2. Bar — https://bar.example",
    );
  });
});

describe("websearch tool", () => {
  const originalBraveKey = process.env.BRAVE_API_KEY;

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBraveKey === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = originalBraveKey;
    }
  });

  it("has a read-only definition and requires a query", async () => {
    const tool = createWebSearchTool();
    expect(tool.definition.name).toBe("websearch");
    expect(tool.definition.parameters).toMatchObject({ required: ["query"] });

    const { ctx } = createFakeContext({ cwd: "/" });
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
  });

  it("does not request permission (read-only tool)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(DDG_FIXTURE, { status: 200 })),
    );
    const tool = createWebSearchTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: "/" });

    await tool.execute({ query: "example" }, ctx);
    expect(permissionRequests).toHaveLength(0);
  });

  it("uses the Brave API when BRAVE_API_KEY is set", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input as string | URL);
      expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
      expect(url.searchParams.get("q")).toBe("cats");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["X-Subscription-Token"]).toBe("test-key");
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Cats 101", url: "https://cats.example", description: "All about cats" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/" });
    const result = await tool.execute({ query: "cats" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Cats 101");
    expect(text).toContain("https://cats.example");
    expect(result.details).toMatchObject({ provider: "brave", resultCount: 1 });
  });

  it("falls back to DuckDuckGo when BRAVE_API_KEY is unset", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://html.duckduckgo.com/html/");
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("q=example");
      return new Response(DDG_FIXTURE, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/" });
    const result = await tool.execute({ query: "example" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("First Result & Title");
    expect(result.details).toMatchObject({ provider: "duckduckgo" });
  });

  it("caps maxResults at 10 and defaults to 5", async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      description: "",
    }));
    process.env.BRAVE_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ web: { results: manyResults } }), { status: 200 }),
      ),
    );

    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const capped = await tool.execute({ query: "x", maxResults: 999 }, ctx);
    expect(capped.details).toMatchObject({ resultCount: 10 });

    const defaulted = await tool.execute({ query: "x" }, ctx);
    expect(defaulted.details).toMatchObject({ resultCount: 5 });
  });

  it("returns an error result (never throws) on a non-2xx HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("service unavailable", { status: 503 })),
    );
    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ query: "example" }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("503");
  });

  it("returns an error result (never throws) on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ query: "example" }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("network down");
  });

  it("returns an error result when there are zero results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body>nothing</body></html>", { status: 200 })),
    );
    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/" });

    const result = await tool.execute({ query: "zzzznoresults" }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("No results found");
  });

  it("returns aborted result immediately when ctx.signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createWebSearchTool();
    const { ctx } = createFakeContext({ cwd: "/", signal: controller.signal });

    const result = await tool.execute({ query: "example" }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Aborted");
  });
});
