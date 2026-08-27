import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { chunkFile } from "./chunker.js";
import { indexRepo } from "./indexer.js";
import {
  buildReferenceGraph,
  buildRepoMap,
  COMMON_IDENTIFIER_MULTIPLIER,
  edgeMultiplier,
  LONG_IDENTIFIER_MULTIPLIER,
  MENTIONED_MULTIPLIER,
  PRIVATE_IDENTIFIER_MULTIPLIER,
  type ReferenceGraph,
  renderRepoMap,
  UNREFERENCED_RESIDUAL,
} from "./repomap.js";
import { buildPostings, CodeIndexStore, type IndexSnapshot } from "./store.js";
import { createTempIndexDir, createTempRepo } from "./test-helpers/fixtures.js";
import type { CodeChunk } from "./types.js";

/** A chunk with the boilerplate filled in; only what a test asserts on is passed. */
function makeChunk(fields: Partial<CodeChunk> & { file: string; name: string }): CodeChunk {
  const startLine = fields.startLine ?? 1;
  return {
    id: `${fields.file}:${startLine}:${fields.name}`,
    file: fields.file,
    startLine,
    endLine: fields.endLine ?? startLine,
    kind: fields.kind ?? "function",
    name: fields.name,
    container: fields.container,
    signature: fields.signature,
    doc: fields.doc,
    body: fields.body,
    language: fields.language ?? "typescript",
  };
}

/**
 * Wrap chunks in an {@link IndexSnapshot}.
 *
 * `buildRepoMap` reads only `chunks`, so the retrieval fields are built for the
 * small fixtures (proving the map works against a real snapshot) and skipped
 * for the large synthetic one, where tokenizing megabytes would dwarf the
 * thing being measured.
 */
function snapshotFrom(chunks: CodeChunk[], withPostings = true): IndexSnapshot {
  if (!withPostings) return { chunks, postings: new Map(), docLengths: [], avgDocLength: 0 };
  const { postings, docLengths, avgDocLength } = buildPostings(chunks);
  return { chunks, postings, docLengths, avgDocLength };
}

/** Chunk real source through the real chunker, the way the indexer would. */
function snapshotOfSources(files: Record<string, string>): IndexSnapshot {
  const chunks: CodeChunk[] = [];
  for (const file of Object.keys(files).sort()) chunks.push(...chunkFile(file, files[file] ?? ""));
  return snapshotFrom(chunks);
}

/** One file's out-edges, with node indices resolved back to paths. */
function edgesFrom(
  graph: ReferenceGraph,
  file: string,
): Array<{ to: string; ident: string; weight: number }> {
  const from = graph.files.indexOf(file);
  return (graph.adjacency[from] ?? []).map((edge) => ({
    to: graph.files[edge.to] ?? "?",
    ident: edge.ident,
    weight: edge.weight,
  }));
}

/** How many files share each recurring name in {@link syntheticChunks}. */
const SYNTHETIC_COMMON_NAMES = 20;

/**
 * A synthetic repository: `fileCount` files of `perFile` declarations, each
 * calling `refs` symbols from other files.
 *
 * Shaped to match the real index's profile rather than a uniform grid, because
 * a perfectly regular graph is already at its own PageRank fixed point and
 * would measure nothing. So: ~600 characters of body per chunk; a pool of
 * names that recur across files (the `execute`/`create` case that the
 * many-definers damping exists for); and two of every chunk's references
 * aimed at a handful of hub files, which is what gives the rank distribution
 * something to converge toward.
 */
function syntheticChunks(fileCount: number, perFile: number, refs: number): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  for (let f = 0; f < fileCount; f++) {
    const file = `packages/pkg${f % 8}/src/module${f}.ts`;
    for (let d = 0; d < perFile; d++) {
      const shared = d === perFile - 1;
      const name = shared
        ? `commonHandler${f % SYNTHETIC_COMMON_NAMES}`
        : `handleModule${f}Symbol${d}`;
      const lines: string[] = [];
      for (let r = 0; r < refs; r++) {
        const other = r < 2 ? (f + r) % 8 : (f * 7 + r * 13 + d * 3 + 1) % fileCount;
        const symbol = (d * 7 + r * 3) % Math.max(1, perFile - 1);
        lines.push(
          r % 4 === 3
            ? `  const shared${r} = commonHandler${(f + d + r) % SYNTHETIC_COMMON_NAMES}(request);`
            : `  const result${r} = handleModule${other}Symbol${symbol}(request, options);`,
        );
      }
      chunks.push(
        makeChunk({
          file,
          name,
          kind: "function",
          signature: `export function ${name}(request: Request, options: Options): Response`,
          body: `function ${name}(request: Request, options: Options): Response {\n${lines.join("\n")}\n}`,
          startLine: d * 30 + 1,
          endLine: d * 30 + 28,
        }),
      );
    }
  }
  return chunks;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("edgeMultiplier", () => {
  const none: ReadonlySet<string> = new Set();

  it("starts at 1 for an ordinary identifier", () => {
    expect(edgeMultiplier("parse", none, 1)).toBe(1);
  });

  it("boosts an identifier the conversation mentioned", () => {
    expect(edgeMultiplier("parse", new Set(["parse"]), 1)).toBe(MENTIONED_MULTIPLIER);
  });

  it("boosts a long multi-word identifier but not a long single-word one", () => {
    expect(edgeMultiplier("tokenBucket", none, 1)).toBe(LONG_IDENTIFIER_MULTIPLIER);
    expect(edgeMultiplier("parse_tool_call", none, 1)).toBe(LONG_IDENTIFIER_MULTIPLIER);
    // Long, but one word — no more specific than any other bare noun.
    expect(edgeMultiplier("permissions", none, 1)).toBe(1);
    // Multi-word, but too short to be distinctive.
    expect(edgeMultiplier("addRow", none, 1)).toBe(1);
  });

  it("damps a private identifier", () => {
    expect(edgeMultiplier("_cache", none, 1)).toBe(PRIVATE_IDENTIFIER_MULTIPLIER);
  });

  it("damps an identifier defined in more than five files", () => {
    expect(edgeMultiplier("handler", none, 5)).toBe(1);
    expect(edgeMultiplier("handler", none, 6)).toBe(COMMON_IDENTIFIER_MULTIPLIER);
  });

  it("composes the multipliers", () => {
    // Long and multi-word (×10) but private (×0.1) lands back at 1.
    expect(edgeMultiplier("_tokenBucket", none, 1)).toBeCloseTo(1, 12);
    // Mentioned (×10) and long (×10), damped for being everywhere (×0.1).
    expect(edgeMultiplier("tokenBucket", new Set(["tokenBucket"]), 20)).toBeCloseTo(10, 12);
  });
});

describe("buildReferenceGraph", () => {
  it("runs an edge from the referencing file to the defining file", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({ file: "src/bucket.ts", name: "TokenBucket", kind: "class", startLine: 3 }),
        makeChunk({
          file: "src/limiter.ts",
          name: "throttle",
          body: "const bucket = new TokenBucket(10);\nreturn bucket;",
        }),
      ]),
    );

    expect(graph.files).toEqual(["src/bucket.ts", "src/limiter.ts"]);
    expect(edgesFrom(graph, "src/limiter.ts")).toEqual([
      { to: "src/bucket.ts", ident: "TokenBucket", weight: LONG_IDENTIFIER_MULTIPLIER },
    ]);
    expect(edgesFrom(graph, "src/bucket.ts")).toEqual([]);
  });

  it("emits no edge for an identifier nothing defines", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({ file: "src/a.ts", name: "alpha" }),
        makeChunk({ file: "src/b.ts", name: "beta", body: "return CompletelyUnknownThing();" }),
      ]),
    );

    expect(graph.edgeCount).toBe(0);
  });

  it("takes the square root of the reference count", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({ file: "src/bucket.ts", name: "TokenBucket", kind: "class" }),
        makeChunk({
          file: "src/limiter.ts",
          name: "throttle",
          body: "TokenBucket; TokenBucket; TokenBucket; TokenBucket;",
        }),
      ]),
    );

    // Four references, not four times the weight: sqrt(4) = 2.
    expect(edgesFrom(graph, "src/limiter.ts")[0]?.weight).toBeCloseTo(
      LONG_IDENTIFIER_MULTIPLIER * 2,
      12,
    );
  });

  it("applies the mentioned-identifier boost to the edge weight", () => {
    const chunks = [
      makeChunk({ file: "src/p.ts", name: "parse" }),
      makeChunk({ file: "src/q.ts", name: "caller", body: "return parse(input);" }),
    ];

    expect(edgesFrom(buildReferenceGraph(snapshotFrom(chunks)), "src/q.ts")[0]?.weight).toBe(1);
    expect(
      edgesFrom(
        buildReferenceGraph(snapshotFrom(chunks), { mentionedIdentifiers: ["parse"] }),
        "src/q.ts",
      )[0]?.weight,
    ).toBe(MENTIONED_MULTIPLIER);
  });

  it("damps an identifier defined in many files, and points at every definer", () => {
    const chunks: CodeChunk[] = [];
    for (let i = 0; i < 6; i++) chunks.push(makeChunk({ file: `src/h${i}.ts`, name: "handler" }));
    chunks.push(makeChunk({ file: "src/use.ts", name: "caller", body: "handler(request);" }));

    const edges = edgesFrom(buildReferenceGraph(snapshotFrom(chunks)), "src/use.ts");

    expect(edges).toHaveLength(6);
    for (const edge of edges) expect(edge.weight).toBeCloseTo(COMMON_IDENTIFIER_MULTIPLIER, 12);
  });

  it("damps a private identifier", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({ file: "src/a.ts", name: "_cache" }),
        makeChunk({ file: "src/b.ts", name: "caller", body: "return _cache.get(key);" }),
      ]),
    );

    expect(edgesFrom(graph, "src/b.ts")[0]?.weight).toBeCloseTo(PRIVATE_IDENTIFIER_MULTIPLIER, 12);
  });

  it("counts references from signatures and doc comments, not only bodies", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({ file: "src/bucket.ts", name: "TokenBucket", kind: "class" }),
        makeChunk({
          file: "src/sig.ts",
          name: "build",
          signature: "function build(): TokenBucket",
        }),
        makeChunk({
          file: "src/doc.ts",
          name: "notes",
          doc: "Wraps the TokenBucket used by the limiter.",
        }),
      ]),
    );

    expect(edgesFrom(graph, "src/sig.ts")).toHaveLength(1);
    expect(edgesFrom(graph, "src/doc.ts")).toHaveLength(1);
  });

  it("never counts a declaration as referencing itself", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({
          file: "src/a.ts",
          name: "tokenBucket",
          signature: "function tokenBucket(): void",
          body: "function tokenBucket() { return tokenBucket; }",
        }),
      ]),
    );

    expect(graph.edgeCount).toBe(0);
  });

  it("ignores whole-file and Markdown-section chunks as definitions", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        // A whole-file chunk is named after the file stem, which would make
        // `index` a "definition" in every package at once.
        makeChunk({ file: "src/index.ts", name: "index", kind: "file" }),
        makeChunk({ file: "docs/guide.md", name: "Getting started", kind: "section" }),
        makeChunk({ file: "src/b.ts", name: "caller", body: "import index from './index';" }),
      ]),
    );

    expect(graph.definitions.map((definition) => definition.name)).toEqual(["caller"]);
    expect(graph.edgeCount).toBe(0);
  });

  it("keeps self-edges, which carry a file's internal usage", () => {
    const graph = buildReferenceGraph(
      snapshotFrom([
        makeChunk({ file: "src/a.ts", name: "tokenBucket" }),
        makeChunk({ file: "src/a.ts", name: "caller", startLine: 9, body: "tokenBucket();" }),
      ]),
    );

    expect(edgesFrom(graph, "src/a.ts")).toEqual([
      { to: "src/a.ts", ident: "tokenBucket", weight: LONG_IDENTIFIER_MULTIPLIER },
    ]);
  });
});

describe("buildRepoMap", () => {
  it("pushes a file's rank onto the definitions its references named", () => {
    const snapshot = snapshotFrom([
      makeChunk({ file: "src/a.ts", name: "alphaHandler" }),
      makeChunk({ file: "src/a.ts", name: "betaHandler", startLine: 20 }),
      makeChunk({
        file: "src/b.ts",
        name: "caller",
        body: "alphaHandler(); alphaHandler();",
      }),
    ]);

    const map = buildRepoMap(snapshot);
    const byName = new Map(map.definitions.map((d) => [d.name, d.score]));
    const rankA = map.fileRanks.get("src/a.ts") ?? 0;
    const rankB = map.fileRanks.get("src/b.ts") ?? 0;

    // b.ts has exactly one out-edge, so all of its rank lands on the one
    // definition that edge named; beta gets only the unreferenced residual.
    expect(byName.get("alphaHandler") ?? 0).toBeCloseTo(
      rankB + (UNREFERENCED_RESIDUAL * rankA) / 2,
      12,
    );
    expect(byName.get("betaHandler") ?? 0).toBeCloseTo((UNREFERENCED_RESIDUAL * rankA) / 2, 12);
    expect(map.definitions[0]?.name).toBe("alphaHandler");
  });

  it("splits a file's rank between its out-edges in proportion to weight", () => {
    const snapshot = snapshotFrom([
      makeChunk({ file: "src/a.ts", name: "alphaHandler" }),
      makeChunk({ file: "src/c.ts", name: "gammaHandler" }),
      // Four references to alpha (weight 10·√4 = 20) against one to gamma (10).
      makeChunk({
        file: "src/b.ts",
        name: "caller",
        body: "alphaHandler(); alphaHandler(); alphaHandler(); alphaHandler(); gammaHandler();",
      }),
    ]);

    const map = buildRepoMap(snapshot);
    const byName = new Map(map.definitions.map((d) => [d.name, d.score]));
    const residual = (file: string): number =>
      UNREFERENCED_RESIDUAL * (map.fileRanks.get(file) ?? 0);
    const alpha = (byName.get("alphaHandler") ?? 0) - residual("src/a.ts");
    const gamma = (byName.get("gammaHandler") ?? 0) - residual("src/c.ts");

    expect(alpha / gamma).toBeCloseTo(2, 9);
  });

  it("lifts focus files and everything they reach", () => {
    const snapshot = snapshotFrom([
      makeChunk({ file: "src/hub.ts", name: "sharedHelper" }),
      makeChunk({ file: "src/one.ts", name: "callerOne", body: "sharedHelper();" }),
      makeChunk({ file: "src/two.ts", name: "callerTwo", body: "sharedHelper();" }),
      makeChunk({ file: "src/lonely.ts", name: "lonelyThing", body: "sharedHelper();" }),
    ]);

    const plain = buildRepoMap(snapshot);
    const focused = buildRepoMap(snapshot, { focusFiles: ["src/lonely.ts"] });
    const order = (map: ReturnType<typeof buildRepoMap>): string[] =>
      [...map.fileRanks].sort((a, b) => b[1] - a[1]).map(([file]) => file);

    // The three callers are structurally identical, so uniform teleport ties
    // them; focusing on one breaks the tie decisively in its favour.
    expect(plain.fileRanks.get("src/lonely.ts")).toBeCloseTo(
      plain.fileRanks.get("src/one.ts") ?? 0,
      12,
    );
    expect(focused.fileRanks.get("src/lonely.ts") ?? 0).toBeGreaterThan(
      plain.fileRanks.get("src/lonely.ts") ?? 0,
    );
    expect(focused.fileRanks.get("src/lonely.ts") ?? 0).toBeGreaterThan(
      focused.fileRanks.get("src/one.ts") ?? 0,
    );
    // The hub everything references still leads; the focus file is now second,
    // ahead of its identical peers.
    expect(order(plain).indexOf("src/lonely.ts")).toBeGreaterThan(1);
    expect(order(focused)[1]).toBe("src/lonely.ts");
  });

  it("resolves focus files given as absolute or ./-prefixed paths", () => {
    const snapshot = snapshotFrom([
      makeChunk({ file: "src/hub.ts", name: "sharedHelper" }),
      makeChunk({ file: "src/lonely.ts", name: "lonelyThing", body: "sharedHelper();" }),
    ]);
    const baseline = buildRepoMap(snapshot).fileRanks.get("src/lonely.ts") ?? 0;

    for (const path of ["/Users/me/repo/src/lonely.ts", "./src/lonely.ts", "src\\lonely.ts"]) {
      expect(
        buildRepoMap(snapshot, { focusFiles: [path] }).fileRanks.get("src/lonely.ts") ?? 0,
      ).toBeGreaterThan(baseline);
    }
  });

  it("promotes a symbol the conversation mentioned", () => {
    const snapshot = snapshotFrom([
      makeChunk({ file: "src/a.ts", name: "parse" }),
      makeChunk({ file: "src/b.ts", name: "render" }),
      makeChunk({ file: "src/c.ts", name: "callerOne", body: "parse(x); render(y); render(z);" }),
    ]);

    const plain = buildRepoMap(snapshot);
    const mentioned = buildRepoMap(snapshot, { mentionedIdentifiers: ["parse"] });
    const rank = (map: ReturnType<typeof buildRepoMap>, name: string): number =>
      map.definitions.findIndex((definition) => definition.name === name);

    expect(rank(plain, "parse")).toBeGreaterThan(rank(plain, "render"));
    expect(rank(mentioned, "parse")).toBeLessThan(rank(mentioned, "render"));
  });

  it("reports what it saw", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(6, 3, 2)));

    expect(map.stats.files).toBe(6);
    expect(map.stats.chunks).toBe(18);
    expect(map.stats.definitions).toBe(18);
    expect(map.stats.edges).toBeGreaterThan(0);
    expect(map.stats.converged).toBe(true);
    expect(map.stats.iterations).toBeGreaterThan(0);
    expect([...map.fileRanks.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("caps the definition list", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(6, 3, 2)), { maxDefinitions: 5 });

    expect(map.definitions).toHaveLength(5);
    expect(map.stats.definitions).toBe(18);
  });

  it("handles an empty snapshot", () => {
    const map = buildRepoMap(snapshotFrom([]));

    expect(map.definitions).toEqual([]);
    expect(map.fileRanks.size).toBe(0);
    expect(map.stats).toMatchObject({ files: 0, chunks: 0, edges: 0 });
    expect(renderRepoMap(map).text).toBe("");
  });

  it("is deterministic: the same snapshot yields an identical map", () => {
    const snapshot = snapshotFrom(syntheticChunks(20, 6, 4));
    const options = { focusFiles: ["packages/pkg1/src/module9.ts"], mentionedIdentifiers: ["x"] };

    const first = buildRepoMap(snapshot, options);
    const second = buildRepoMap(snapshot, options);

    expect(second).toEqual(first);
    expect(renderRepoMap(second).text).toBe(renderRepoMap(first).text);
  });

  it("builds a large snapshot fast enough to run every turn", () => {
    // 8,000 chunks, ~4.2 MB of bodies, ~207,000 edges — a heavier workload
    // than the Arcturn repository's own index (7,774 chunks, 3.3 MB, 151,000
    // edges), which builds in ~65 ms warm; this one measures ~90 ms on the
    // same machine. The ceiling is a regression guard with room for slower CI
    // hardware, not the target.
    const snapshot = snapshotFrom(syntheticChunks(400, 20, 8), false);

    buildRepoMap(snapshot); // warm the JIT: this runs every turn, never once
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      buildRepoMap(snapshot);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(snapshot.chunks.length).toBe(8_000);
    expect(buildRepoMap(snapshot).stats.edges).toBeGreaterThan(150_000);
    expect(samples[2] ?? Number.POSITIVE_INFINITY).toBeLessThan(400);
  });
});

describe("renderRepoMap", () => {
  const SOURCES: Record<string, string> = {
    "packages/core/src/permissions.ts": [
      "/** Decides whether a tool call may proceed. */",
      "export class PermissionEngine {",
      "  check(toolName: string): boolean {",
      "    return matchSpecifier(toolName, this.subject);",
      "  }",
      "}",
      "",
      "/** Match one rule specifier against a subject. */",
      "export function matchSpecifier(specifier: string, subject: string): boolean {",
      "  return specifier === subject;",
      "}",
    ].join("\n"),
    "packages/cli/src/run.ts": [
      'import { PermissionEngine } from "../../core/src/permissions.js";',
      "",
      "export function run(): void {",
      "  const engine = new PermissionEngine();",
      '  engine.check("read");',
      '  matchSpecifier("read", "read");',
      "}",
    ].join("\n"),
  };

  it("groups symbols under one line per file, signatures only", () => {
    const map = buildRepoMap(snapshotOfSources(SOURCES));
    const { text } = renderRepoMap(map, { tokenBudget: 400 });

    expect(text).toContain("packages/core/src/permissions.ts\n");
    expect(text).toContain("\n  class PermissionEngine");
    expect(text).toContain(
      "\n  function matchSpecifier(specifier: string, subject: string): boolean",
    );
    // Signatures only: no bodies, no line numbers, no doc comments.
    expect(text).not.toContain("return specifier === subject");
    expect(text).not.toContain("Decides whether");
    for (const line of text.split("\n")) {
      if (line.startsWith("  ")) expect(line.startsWith("    ")).toBe(false);
    }
  });

  it("keeps a method's container in its label", () => {
    const map = buildRepoMap(snapshotOfSources(SOURCES));
    const { text } = renderRepoMap(map, { tokenBudget: 400 });

    expect(text).toContain("PermissionEngine.check");
  });

  it("never exceeds the budget, and fills it to within the tolerance", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(40, 10, 4)));

    for (const tokenBudget of [100, 250, 500, 1_000, 2_000]) {
      const rendered = renderRepoMap(map, { tokenBudget });
      expect(rendered.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
      expect(Math.ceil(rendered.text.length / 4)).toBe(rendered.estimatedTokens);
      // Truncated renders must actually use the budget they were given.
      expect(rendered.estimatedTokens).toBeGreaterThanOrEqual(tokenBudget * 0.85);
      expect(rendered.truncated).toBe(true);
    }
  });

  it("honours a caller-supplied tolerance", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(40, 10, 4)));
    const rendered = renderRepoMap(map, { tokenBudget: 1_000, tolerance: 0.02 });

    expect(rendered.estimatedTokens).toBeLessThanOrEqual(1_000);
    expect(rendered.estimatedTokens).toBeGreaterThanOrEqual(980);
  });

  it("says what it left out rather than dropping it silently", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(40, 10, 4)));
    const rendered = renderRepoMap(map, { tokenBudget: 500 });

    expect(rendered.omitted).toBe(map.definitions.length - rendered.definitions);
    expect(rendered.text).toContain(`… ${rendered.omitted} more symbols not shown`);
    expect(rendered.files).toBeGreaterThan(0);
  });

  it("shows everything, with no notice, when the budget is ample", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(4, 3, 2)));
    const rendered = renderRepoMap(map, { tokenBudget: 8_000 });

    expect(rendered.definitions).toBe(map.definitions.length);
    expect(rendered.omitted).toBe(0);
    expect(rendered.truncated).toBe(false);
    expect(rendered.text).not.toContain("not shown");
  });

  it("orders files by rank and symbols by source line", () => {
    const map = buildRepoMap(snapshotFrom(syntheticChunks(10, 5, 3)));
    const { text } = renderRepoMap(map, { tokenBudget: 4_000 });

    const lines = text.split("\n");
    let previousLine = 0;
    for (const line of lines) {
      if (!line.startsWith("  ")) {
        previousLine = 0;
        continue;
      }
      const match = /Symbol(\d+)/.exec(line);
      if (!match) continue;
      const symbol = Number(match[1]);
      expect(symbol).toBeGreaterThanOrEqual(previousLine);
      previousLine = symbol;
    }
  });
});

describe("repo map over a real indexed repository", () => {
  it("maps a temp repo end to end", async () => {
    const repo = await createTempRepo({
      "src/bucket.ts": [
        "/** A rate limiter. */",
        "export class TokenBucket {",
        "  tryConsume(count: number): boolean {",
        "    return count > 0;",
        "  }",
        "}",
      ].join("\n"),
      "src/limiter.ts": [
        'import { TokenBucket } from "./bucket.js";',
        "",
        "export function throttle(): boolean {",
        "  const bucket = new TokenBucket();",
        "  return bucket.tryConsume(1);",
        "}",
      ].join("\n"),
    });
    const dir = await createTempIndexDir();
    cleanups.push(async () => {
      await repo.cleanup();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    const store = await CodeIndexStore.open(dir, repo.root);
    await indexRepo({ root: repo.root, store });
    const map = buildRepoMap(store.snapshot(), { focusFiles: ["src/limiter.ts"] });
    const rendered = renderRepoMap(map, { tokenBudget: 600 });

    expect(map.stats.chunks).toBe(store.chunkCount);
    expect(map.fileRanks.has("src/bucket.ts")).toBe(true);
    expect(map.definitions.map((definition) => definition.name)).toContain("TokenBucket");
    expect(rendered.text).toContain("src/bucket.ts");
    expect(rendered.text).toContain("class TokenBucket");
    expect(rendered.estimatedTokens).toBeLessThanOrEqual(600);
  });
});
