import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_BUDGET, formatSearchResult, hitLabel, nextStepFor } from "./format.js";
import { estimateTokens } from "./tokenize.js";
import type { CodeChunk, SearchHit, SearchResult } from "./types.js";

/** A realistic method chunk with a 40-line body. */
function makeHit(index: number, file = `src/module${index}/service.ts`): SearchHit {
  const body = [
    `  async handleRequest(input: RequestPayload): Promise<Response> {`,
    ...Array.from(
      { length: 38 },
      (_unused, line) => `    const step${line} = await this.pipeline.run(input, ${line});`,
    ),
    "  }",
  ].join("\n");
  const startLine = 42 + index * 100;
  const chunk: CodeChunk = {
    id: `${file}:${startLine}:handleRequest`,
    file,
    startLine,
    endLine: startLine + 40,
    kind: "method",
    name: "handleRequest",
    container: `Service${index}`,
    signature: "async handleRequest(input: RequestPayload): Promise<Response>",
    doc: "Handles one inbound request end to end, applying auth and rate limits.",
    body,
    language: "typescript",
  };
  return { chunk, score: 1 / (index + 1), signals: { bm25: index + 1, symbol: index + 1 } };
}

function makeResult(count: number, sameFile = false): SearchResult {
  const hits = Array.from({ length: count }, (_unused, index) =>
    makeHit(index, sameFile ? "src/one/service.ts" : undefined),
  );
  return { query: "handle request", hits, totalMatches: count, candidates: count * 3 };
}

describe("token discipline", () => {
  const result = makeResult(20);

  it("keeps a 20-hit signatures result inside the default token budget", () => {
    const formatted = formatSearchResult(result, { detail: "signatures" });
    expect(formatted.shown).toBe(20);
    expect(formatted.truncated).toBe(false);
    expect(formatted.estimatedTokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
  });

  it("holds each hit to roughly 30 tokens", () => {
    const formatted = formatSearchResult(result, { detail: "signatures" });
    const hitLines = formatted.text
      .split("\n")
      .filter((line) => /^src\/module\d+\/service\.ts:\d+/.test(line));
    expect(hitLines).toHaveLength(20);
    for (const line of hitLines) {
      expect(estimateTokens(line)).toBeLessThanOrEqual(30);
    }
    // The `nextStep` line is one fixed cost for the whole result, not per hit.
    const overhead = estimateTokens(formatted.nextStep ?? "");
    const perHit = (formatted.estimatedTokens - overhead) / formatted.shown;
    expect(perHit).toBeLessThanOrEqual(30);
  });

  it("costs dramatically more in full mode for the very same hits", () => {
    const signatures = formatSearchResult(result, {
      detail: "signatures",
      tokenBudget: 200_000,
    });
    const full = formatSearchResult(result, { detail: "full", tokenBudget: 200_000 });

    expect(full.shown).toBe(signatures.shown);
    expect(full.estimatedTokens / signatures.estimatedTokens).toBeGreaterThan(8);
  });

  it("orders the detail levels by cost: signatures < snippets < full", () => {
    const budget = 200_000;
    const signatures = formatSearchResult(result, { detail: "signatures", tokenBudget: budget });
    const snippets = formatSearchResult(result, { detail: "snippets", tokenBudget: budget });
    const full = formatSearchResult(result, { detail: "full", tokenBudget: budget });

    expect(snippets.estimatedTokens).toBeGreaterThan(signatures.estimatedTokens);
    expect(full.estimatedTokens).toBeGreaterThan(snippets.estimatedTokens);
  });

  it("enforces the budget in full mode by truncating, never by overflowing", () => {
    const full = formatSearchResult(result, { detail: "full" });
    expect(full.estimatedTokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
    expect(full.truncated).toBe(true);
    expect(full.shown).toBeLessThan(20);
  });

  it("never silently drops matches: truncation says how many and how to narrow", () => {
    const full = formatSearchResult(result, { detail: "full" });
    expect(full.text).toMatch(/… \d+ more matches not shown/);
    expect(full.text).toContain("token budget reached");
    expect(full.text).toContain('kind:"function"');
    expect(full.text).toContain('path:"src/**"');
  });

  it("renders at least one hit even when a single hit exceeds the whole budget", () => {
    const tiny = formatSearchResult(makeResult(1), { detail: "full", tokenBudget: 100 });
    expect(tiny.shown).toBe(1);
    expect(tiny.text).toContain("src/module0/service.ts:42");
  });
});

describe("collapsing", () => {
  it("writes the path once when several hits share a file", () => {
    const formatted = formatSearchResult(makeResult(5, true), { detail: "signatures" });
    const lines = formatted.text.split("\n");

    // Five hits, but the path is written as a header rather than on each line.
    expect(lines[0]).toBe("src/one/service.ts");
    expect(lines.filter((line) => line.startsWith("  :"))).toHaveLength(3);
    expect(formatted.text).toContain("+ 2 more here");

    // It appears only in the header, the collapse hint, and the `read` call —
    // never once per hit.
    expect(formatted.text.split("src/one/service.ts").length - 1).toBe(3);
  });

  it("drops a hit already contained in a better-ranked hit from the same file", () => {
    const outer = makeHit(0, "src/a.ts");
    const inner: SearchHit = {
      ...outer,
      chunk: { ...outer.chunk, id: "inner", name: "innerHelper", startLine: 50, endLine: 60 },
      score: 0.5,
    };
    const formatted = formatSearchResult({
      query: "x",
      hits: [outer, inner],
      totalMatches: 2,
      candidates: 2,
    });
    expect(formatted.text).not.toContain("innerHelper");
    expect(formatted.shown).toBe(1);
  });
});

describe("detail levels", () => {
  it("signatures renders no body lines", () => {
    const formatted = formatSearchResult(makeResult(1), { detail: "signatures" });
    expect(formatted.text).not.toContain("const step0");
  });

  it("snippets renders a bounded window of the body", () => {
    const formatted = formatSearchResult(makeResult(1), { detail: "snippets", contextLines: 3 });
    expect(formatted.text).toContain("42| ");
    expect(formatted.text).toContain("const step0");
    expect(formatted.text).not.toContain("const step30");
    expect(formatted.text).toContain("more lines");
  });

  it("full renders the body with line numbers", () => {
    const formatted = formatSearchResult(makeResult(1), {
      detail: "full",
      tokenBudget: 200_000,
    });
    expect(formatted.text).toContain("42| ");
    expect(formatted.text).toContain("const step30");
  });
});

describe("the next step", () => {
  it("names the exact read call for the top hit", () => {
    const formatted = formatSearchResult(makeResult(3));
    expect(formatted.nextStep).toBe(
      'Next: read({"path":"src/module0/service.ts","offset":42,"limit":41}) for Service0.handleRequest.',
    );
    expect(formatted.text.endsWith(formatted.nextStep ?? "")).toBe(true);
  });

  it("caps the suggested read at 200 lines", () => {
    const hit = makeHit(0);
    hit.chunk.endLine = 5_000;
    expect(nextStepFor(hit)).toContain('"limit":200');
  });
});

describe("labels", () => {
  it("qualifies a member with its container and keeps the parameter list", () => {
    expect(hitLabel(makeHit(1))).toBe(
      "Service1.handleRequest(input: RequestPayload): Promise<Response>",
    );
  });

  it("falls back to the bare name when there is no signature", () => {
    const hit = makeHit(0);
    hit.chunk.signature = undefined;
    hit.chunk.container = undefined;
    expect(hitLabel(hit)).toBe("handleRequest");
  });

  it("keeps a class's `extends`/`implements` tail", () => {
    const hit = makeHit(0);
    hit.chunk.kind = "class";
    hit.chunk.name = "TokenBucket";
    hit.chunk.container = undefined;
    hit.chunk.signature = "export class TokenBucket implements Limiter";
    expect(hitLabel(hit)).toBe("TokenBucket implements Limiter");
  });
});

describe("no matches", () => {
  it("explains what to try instead, including grep", () => {
    const formatted = formatSearchResult({
      query: "zzz",
      hits: [],
      totalMatches: 0,
      candidates: 10,
    });
    expect(formatted.text).toContain('No indexed symbol matches "zzz"');
    expect(formatted.text).toContain("grep");
    expect(formatted.shown).toBe(0);
    expect(formatted.nextStep).toBeUndefined();
  });
});
