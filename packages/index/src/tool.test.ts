import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkFile as realChunkFile } from "./chunker.js";
import {
  createFakeContext,
  createTempIndexDir,
  createTempRepo,
  resultText,
  type TempRepo,
} from "./test-helpers/fixtures.js";
import { CodeIndexService, createSearchCodeTool, defaultIndexRoot, indexDirFor } from "./tool.js";
import type { CodeChunk } from "./types.js";

const REPO = {
  "src/rate-limit.ts": [
    "/** Token bucket rate limiter. */",
    "export class TokenBucket {",
    "  tryConsume(n: number): boolean {",
    "    return n > 0;",
    "  }",
    "}",
  ].join("\n"),
  "src/users/repository.ts": [
    "/** Look one user up by their identifier. */",
    "export async function getUserById(id: string) {",
    "  return null;",
    "}",
  ].join("\n"),
  "docs/guide.md": "# Guide\n\nHow the limiter works.\n",
};

let repo: TempRepo | null = null;
const indexRoots: string[] = [];

afterEach(async () => {
  await repo?.cleanup();
  repo = null;
  await Promise.all(indexRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(overrides: Record<string, unknown> = {}) {
  repo = await createTempRepo(REPO);
  const indexRoot = await createTempIndexDir();
  indexRoots.push(indexRoot);
  const tool = createSearchCodeTool({ indexRoot, ...overrides });
  return { tool, root: repo.root, indexRoot };
}

describe("search_code — definition", () => {
  it("is named search_code and takes only a query as required input", async () => {
    const { tool } = await setup();
    expect(tool.definition.name).toBe("search_code");
    const params = tool.definition.parameters as { required: string[]; properties: object };
    expect(params.required).toEqual(["query"]);
    expect(Object.keys(params.properties).sort()).toEqual([
      "detail",
      "kind",
      "limit",
      "path",
      "query",
    ]);
  });

  it("teaches the model when to prefer it over grep, glob and symbols", async () => {
    const { tool } = await setup();
    const description = tool.definition.description;
    expect(description).toContain("grep");
    expect(description).toContain("glob");
    expect(description).toContain("symbols");
    expect(description).toContain("ADDRESSES");
    expect(description).toContain("signatures");
    expect(description).toMatch(/Prefer `search_code` over `grep` when/);
    expect(description).toMatch(/Prefer `grep` over `search_code` when/);
  });
});

describe("search_code — execution", () => {
  it("indexes the working directory on first use and returns addresses", async () => {
    const { tool, root } = await setup();
    const result = await tool.execute({ query: "TokenBucket" }, createFakeContext(root));

    expect(result.isError).toBeFalsy();
    const text = resultText(result);
    expect(text).toContain("src/rate-limit.ts:2");
    expect(text).toContain("class TokenBucket");
    expect(text).toContain('Next: read({"path":"src/rate-limit.ts","offset":2');
    expect(text).not.toContain("return n > 0;");
  });

  it("addresses files with forward slashes, whatever the platform's separator is", async () => {
    // The index is a shared vocabulary: the model is told "paths are
    // repo-relative with forward slashes", the `path` filter is matched
    // against that spelling, and the `read` call the result suggests is fed
    // straight back in. If a Windows run stored `src\users\repository.ts`
    // instead, every stored key, every path filter and every suggested next
    // step would diverge by platform.
    const { tool, root } = await setup();
    const ctx = createFakeContext(root);

    const text = resultText(await tool.execute({ query: "user id" }, ctx));
    expect(text).toContain("src/users/repository.ts");
    expect(text).not.toContain("\\");

    // ...and the `path` filter speaks the same dialect.
    const scoped = resultText(await tool.execute({ query: "user id", path: "src/users/**" }, ctx));
    expect(scoped).toContain("src/users/repository.ts");
  });

  it("reports index and budget accounting in details", async () => {
    const { tool, root } = await setup();
    const result = await tool.execute({ query: "TokenBucket" }, createFakeContext(root));
    expect(result.details).toMatchObject({ detail: "signatures", truncated: false });
    expect(result.details?.matchCount).toBeGreaterThan(0);
    expect(result.details?.estimatedTokens).toBeGreaterThan(0);
    expect(result.details?.indexedChunks).toBeGreaterThan(0);
  });

  it("finds a symbol from a natural phrase", async () => {
    const { tool, root } = await setup();
    const text = resultText(await tool.execute({ query: "user id" }, createFakeContext(root)));
    expect(text).toContain("src/users/repository.ts:2");
    expect(text).toContain("getUserById");
  });

  it("honors kind, path, limit and detail", async () => {
    const { tool, root } = await setup();
    const ctx = createFakeContext(root);

    const sections = resultText(
      await tool.execute({ query: "guide limiter", kind: "section" }, ctx),
    );
    expect(sections).toContain("docs/guide.md");
    expect(sections).not.toContain("rate-limit.ts");

    const scoped = resultText(await tool.execute({ query: "TokenBucket", path: "docs/**" }, ctx));
    expect(scoped).not.toContain("src/rate-limit.ts:");

    const limited = await tool.execute({ query: "TokenBucket", limit: 1 }, ctx);
    expect(limited.details?.shown).toBe(1);

    const snippets = resultText(
      await tool.execute({ query: "TokenBucket", detail: "snippets" }, ctx),
    );
    expect(snippets).toContain("2| export class TokenBucket {");
  });

  it("ignores unknown kind and detail values rather than failing", async () => {
    const { tool, root } = await setup();
    const result = await tool.execute(
      { query: "TokenBucket", kind: "not-a-kind", detail: "verbose" },
      createFakeContext(root),
    );
    expect(result.isError).toBeFalsy();
    expect(result.details?.detail).toBe("signatures");
    expect(resultText(result)).toContain("src/rate-limit.ts:2");
  });

  it("explains an empty result instead of returning nothing", async () => {
    const { tool, root } = await setup();
    const text = resultText(await tool.execute({ query: "zzzqqqxxx" }, createFakeContext(root)));
    expect(text).toContain("No indexed symbol matches");
    expect(text).toContain("grep");
  });

  it("rejects a missing or empty query", async () => {
    const { tool, root } = await setup();
    const ctx = createFakeContext(root);
    expect((await tool.execute({}, ctx)).isError).toBe(true);
    expect((await tool.execute({ query: "   " }, ctx)).isError).toBe(true);
  });

  it("returns the standard aborted result when the signal is already aborted", async () => {
    const { tool, root } = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      { query: "TokenBucket" },
      createFakeContext(root, controller.signal),
    );
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Aborted");
  });

  it("does not re-chunk on a second search in the same session", async () => {
    const calls: string[] = [];
    const chunkFile = (file: string, text: string): CodeChunk[] => {
      calls.push(file);
      return realChunkFile(file, text);
    };
    const { tool, root } = await setup({ chunkFile });
    const ctx = createFakeContext(root);

    await tool.execute({ query: "TokenBucket" }, ctx);
    const afterFirst = calls.length;
    expect(afterFirst).toBe(3);

    await tool.execute({ query: "getUserById" }, ctx);
    expect(calls.length).toBe(afterFirst);
  });

  it("answers from a partial index rather than blocking, and says so", async () => {
    const { tool, root } = await setup({ refreshBudgetMs: -1_000 });
    const result = await tool.execute({ query: "TokenBucket" }, createFakeContext(root));
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("still warming up");
    expect(result.details?.indexWarming).toBe(true);
  });
});

describe("CodeIndexService", () => {
  it("persists each root under its own hashed directory", async () => {
    // `indexDirFor` joins with the platform separator, so the expectation is
    // spelled with `join` rather than with a POSIX literal.
    const indexRoot = join("/tmp", "arcturn-test-index");
    const service = new CodeIndexService({ indexRoot });
    const a = service.directoryFor("/repo/a");
    const b = service.directoryFor("/repo/b");
    expect(a).not.toBe(b);
    expect(a.startsWith(indexRoot + sep)).toBe(true);
    expect(a).toBe(indexDirFor(indexRoot, "/repo/a"));
  });

  it("defaults to ~/.arcturn/index", () => {
    const root = defaultIndexRoot();
    expect(root.startsWith(homedir() + sep)).toBe(true);
    expect(root.split(sep).slice(-2)).toEqual([".arcturn", "index"]);
  });

  it("shares one in-flight refresh between concurrent searches", async () => {
    const calls: string[] = [];
    repo = await createTempRepo(REPO);
    const indexRoot = await createTempIndexDir();
    indexRoots.push(indexRoot);
    const service = new CodeIndexService({
      indexRoot,
      chunkFile: (file, text) => {
        calls.push(file);
        return realChunkFile(file, text);
      },
    });

    const [first, second] = await Promise.all([
      service.search(repo.root, "TokenBucket"),
      service.search(repo.root, "getUserById"),
    ]);

    expect(calls).toHaveLength(3);
    expect(first.result.hits[0]?.chunk.name).toBe("TokenBucket");
    expect(second.result.hits[0]?.chunk.name).toBe("getUserById");
  });

  it("picks up a file edited between searches", async () => {
    repo = await createTempRepo(REPO);
    const indexRoot = await createTempIndexDir();
    indexRoots.push(indexRoot);
    const service = new CodeIndexService({ indexRoot, minRefreshIntervalMs: 0 });

    const before = await service.search(repo.root, "LeakyBucket");
    expect(before.result.hits.map((hit) => hit.chunk.name)).not.toContain("LeakyBucket");

    await repo.write({ "src/leaky.ts": "export class LeakyBucket {}\n" });

    const after = await service.search(repo.root, "LeakyBucket");
    expect(after.result.hits[0]?.chunk.name).toBe("LeakyBucket");
  });
});
