import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chunkFile } from "./chunker.js";
import { indexRepo } from "./indexer.js";
import { compilePathFilter, searchIndex } from "./search.js";
import { CodeIndexStore, type IndexSnapshot } from "./store.js";
import { symbolScore } from "./symbol-score.js";
import { createTempIndexDir, createTempRepo, type TempRepo } from "./test-helpers/fixtures.js";
import { splitIdentifier } from "./tokenize.js";
import type { Embedder } from "./types.js";

/**
 * A repository designed to make the precision test hard: the class named
 * `TokenBucket` competes against four other things that mention it — a
 * consumer whose body is full of the identifier, a doc page whose heading IS
 * the identifier, a file whose *name* is the identifier, and a test file that
 * repeats it more than the declaration ever does.
 */
const REPO = {
  "src/rate-limit.ts": [
    "/** Token bucket rate limiter for outbound requests. */",
    "export class TokenBucket implements Limiter {",
    "  private tokens = 0;",
    "",
    "  /** Consume n tokens, returning false when the bucket is empty. */",
    "  tryConsume(n: number): boolean {",
    "    return this.tokens >= n;",
    "  }",
    "}",
    "",
    "export interface Limiter {",
    "  tryConsume(n: number): boolean;",
    "}",
  ].join("\n"),
  "src/gateway.ts": [
    "import { TokenBucket } from './rate-limit.js';",
    "",
    "/** Wires a TokenBucket into the gateway. */",
    "export function createGateway() {",
    "  const bucket = new TokenBucket();",
    "  const secondBucket = new TokenBucket();",
    "  const thirdBucket = new TokenBucket();",
    "  return { bucket, secondBucket, thirdBucket, TokenBucket };",
    "}",
  ].join("\n"),
  "src/token-bucket.test.ts": [
    "import { TokenBucket } from './rate-limit.js';",
    "",
    "export function testTokenBucketBehaviour() {",
    "  const a = new TokenBucket();",
    "  const b = new TokenBucket();",
    "  const c = new TokenBucket();",
    "  const d = new TokenBucket();",
    "  return [a, b, c, d];",
    "}",
  ].join("\n"),
  "docs/TokenBucket.md": [
    "# TokenBucket",
    "",
    "TokenBucket is the rate limiting strategy we use. TokenBucket refills over time.",
    "",
    "## TokenBucket tuning",
    "",
    "Set the TokenBucket capacity carefully.",
  ].join("\n"),
  "src/users/repository.ts": [
    "/** Look one user up by their identifier. */",
    "export async function getUserById(id: string) {",
    "  return db.users.find(id);",
    "}",
    "",
    "/** Remove a user. */",
    "export async function deleteUser(id: string) {",
    "  return db.users.remove(id);",
    "}",
  ].join("\n"),
  "src/net/backoff.ts": [
    "/** Waits progressively longer between attempts when a call keeps failing. */",
    "export function computeDelay(attempt: number): number {",
    "  return Math.min(2 ** attempt * 100, 30_000);",
    "}",
  ].join("\n"),
  "config/settings.toml": "[server]\nport = 8080\n",
};

let repo: TempRepo;
let indexDir: string;
let snapshot: IndexSnapshot;

beforeAll(async () => {
  repo = await createTempRepo(REPO);
  indexDir = await createTempIndexDir();
  const store = await CodeIndexStore.open(indexDir, repo.root);
  await indexRepo({ root: repo.root, store, chunkFile });
  snapshot = store.snapshot();
});

afterAll(async () => {
  await repo.cleanup();
  await rm(indexDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("searchIndex — precision", () => {
  it("ranks the symbol NAMED TokenBucket above everything that merely mentions it", async () => {
    const result = await searchIndex(snapshot, "TokenBucket");
    const top = result.hits[0];

    expect(top?.chunk.name).toBe("TokenBucket");
    expect(top?.chunk.kind).toBe("class");
    expect(top?.chunk.file).toBe("src/rate-limit.ts");
    expect(top?.chunk.startLine).toBe(2);
    // The symbol-name signal is what put it there.
    expect(top?.signals.symbol).toBe(1);
  });

  it("still finds the mentions, just below the declaration", async () => {
    const result = await searchIndex(snapshot, "TokenBucket", { limit: 20 });
    const files = result.hits.map((hit) => hit.chunk.file);
    expect(files[0]).toBe("src/rate-limit.ts");
    expect(files).toContain("src/gateway.ts");
    expect(result.totalMatches).toBeGreaterThan(3);
  });

  it("matches a split identifier from a natural phrase", async () => {
    const result = await searchIndex(snapshot, "user id");
    expect(result.hits[0]?.chunk.name).toBe("getUserById");
  });

  it("matches a partial symbol name by prefix", async () => {
    const result = await searchIndex(snapshot, "tryConsume");
    expect(result.hits[0]?.chunk.name).toBe("tryConsume");
  });

  it("finds a concept that lives only in a doc comment", async () => {
    const result = await searchIndex(snapshot, "waits longer between attempts");
    expect(result.hits[0]?.chunk.name).toBe("computeDelay");
  });

  it("finds a file by its path even when the words are not in its text", async () => {
    const result = await searchIndex(snapshot, "settings toml");
    expect(result.hits[0]?.chunk.file).toBe("config/settings.toml");
  });

  it("records which signals produced each hit", async () => {
    const result = await searchIndex(snapshot, "TokenBucket");
    const top = result.hits[0];
    expect(top?.signals.bm25).toBeGreaterThan(0);
    expect(top?.signals.symbol).toBeGreaterThan(0);
    expect(top?.signals.vector).toBeUndefined();
  });
});

describe("searchIndex — filters", () => {
  it("filters by a single kind before ranking", async () => {
    const result = await searchIndex(snapshot, "TokenBucket", { kind: "section" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.chunk.kind === "section")).toBe(true);
  });

  it("filters by several kinds", async () => {
    const result = await searchIndex(snapshot, "TokenBucket", { kind: ["class", "interface"] });
    expect(result.hits.every((hit) => ["class", "interface"].includes(hit.chunk.kind))).toBe(true);
  });

  it("filters by a path glob", async () => {
    const result = await searchIndex(snapshot, "TokenBucket", { path: "docs/**" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.chunk.file.startsWith("docs/"))).toBe(true);
  });

  it("filters by a path substring", async () => {
    const result = await searchIndex(snapshot, "user", { path: "users/" });
    expect(result.hits.every((hit) => hit.chunk.file.includes("users/"))).toBe(true);
  });

  it("reports zero candidates when a filter excludes everything", async () => {
    const result = await searchIndex(snapshot, "TokenBucket", { path: "nowhere/**" });
    expect(result.candidates).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it("honors limit", async () => {
    const result = await searchIndex(snapshot, "TokenBucket", { limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.totalMatches).toBeGreaterThan(2);
  });
});

describe("searchIndex — degenerate inputs", () => {
  it("returns nothing for an empty query", async () => {
    expect((await searchIndex(snapshot, "   ")).hits).toEqual([]);
  });

  it("returns nothing for an empty index", async () => {
    const empty: IndexSnapshot = {
      chunks: [],
      postings: new Map(),
      docLengths: [],
      avgDocLength: 0,
    };
    expect((await searchIndex(empty, "anything")).hits).toEqual([]);
  });

  it("returns nothing for a query with no matching terms", async () => {
    const result = await searchIndex(snapshot, "zzzzqqqqxxxx");
    expect(result.hits).toEqual([]);
  });
});

describe("symbolScore tiers", () => {
  const chunk = {
    id: "x",
    file: "src/a.ts",
    startLine: 1,
    endLine: 2,
    kind: "class" as const,
    name: "TokenBucket",
    container: "limiter",
    language: "typescript" as const,
  };

  const score = (query: string): number =>
    symbolScore(chunk, query.toLowerCase(), splitIdentifier(query));

  it("orders exact above prefix above containment above subsequence", () => {
    expect(score("TokenBucket")).toBeGreaterThan(score("Token"));
    expect(score("Token")).toBeGreaterThan(score("Bucket"));
    expect(score("Bucket")).toBeGreaterThan(score("tkbk"));
    expect(score("tkbk")).toBeGreaterThan(0);
  });

  it("matches the qualified path exactly", () => {
    expect(score("limiter.TokenBucket")).toBeGreaterThan(score("Token"));
  });

  it("matches an unordered word set", () => {
    expect(score("bucket token")).toBeGreaterThan(0);
  });

  it("scores an unrelated query at zero", () => {
    expect(score("qqqq")).toBe(0);
  });

  it("prefers a declaration over a doc heading with the same name", () => {
    const heading = { ...chunk, kind: "section" as const, container: undefined };
    const declaration = { ...chunk, container: undefined };
    expect(symbolScore(declaration, "tokenbucket", ["token", "bucket"])).toBeGreaterThan(
      symbolScore(heading, "tokenbucket", ["token", "bucket"]),
    );
  });
});

describe("compilePathFilter", () => {
  it("treats a plain string as a case-insensitive substring", () => {
    const match = compilePathFilter("Auth");
    expect(match("src/auth/session.ts")).toBe(true);
    expect(match("src/db/index.ts")).toBe(false);
  });

  it("treats a pattern with glob characters as a glob", () => {
    const match = compilePathFilter("src/**/*.ts");
    expect(match("src/a/b.ts")).toBe(true);
    expect(match("src/b.ts")).toBe(true);
    expect(match("test/b.ts")).toBe(false);
  });

  it("matches a bare extension glob at any depth", () => {
    const match = compilePathFilter("*.py");
    expect(match("deep/nested/x.py")).toBe(true);
    expect(match("deep/nested/x.ts")).toBe(false);
  });

  it("accepts everything for an empty pattern", () => {
    expect(compilePathFilter("   ")("anything")).toBe(true);
  });
});

describe("searchIndex — the optional embedding signal", () => {
  /** Offline, deterministic: vectors point at whichever keyword the text contains. */
  const embedder: Embedder = {
    id: "keyword-v1",
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const lower = text.toLowerCase();
        return [
          lower.includes("longer between attempts") || lower.includes("retry") ? 1 : 0,
          lower.includes("token") ? 1 : 0,
          0.01,
        ];
      });
    },
  };

  afterEach(async () => {
    /* each test builds its own store */
  });

  it("is absent from the fusion unless vectors were indexed", async () => {
    const result = await searchIndex(snapshot, "retry", { embedder });
    expect(result.hits.every((hit) => hit.signals.vector === undefined)).toBe(true);
  });

  it("adds semantic recall when a caller opts in and pays for it", async () => {
    const dir = await createTempIndexDir();
    try {
      const store = await CodeIndexStore.open(dir, repo.root);
      await indexRepo({ root: repo.root, store, chunkFile, embedder });
      const withVectors = store.snapshot();

      const lexicalOnly = await searchIndex(withVectors, "retry");
      expect(lexicalOnly.hits.some((hit) => hit.chunk.name === "computeDelay")).toBe(false);

      const hybrid = await searchIndex(withVectors, "retry", { embedder });
      const delay = hybrid.hits.find((hit) => hit.chunk.name === "computeDelay");
      expect(delay).toBeDefined();
      expect(delay?.signals.vector).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
