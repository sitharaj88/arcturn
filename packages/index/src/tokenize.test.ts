import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  expandIdentifier,
  splitIdentifier,
  tokenize,
  tokenizePath,
  weightedTokens,
} from "./tokenize.js";

describe("splitIdentifier", () => {
  it("splits camelCase", () => {
    expect(splitIdentifier("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits acronym boundaries correctly", () => {
    expect(splitIdentifier("parseHTTPResponse")).toEqual(["parse", "http", "response"]);
    expect(splitIdentifier("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits snake_case, kebab-case, dots and digits", () => {
    expect(splitIdentifier("MAX_RETRY_COUNT")).toEqual(["max", "retry", "count"]);
    expect(splitIdentifier("rate-limit.ts")).toEqual(["rate", "limit", "ts"]);
    expect(splitIdentifier("parse2Json")).toEqual(["parse", "2", "json"]);
  });

  it("leaves a single lowercase word alone", () => {
    expect(splitIdentifier("bucket")).toEqual(["bucket"]);
  });
});

describe("expandIdentifier", () => {
  it("emits the whole identifier and its parts", () => {
    expect(expandIdentifier("getUserById")).toEqual(["getuserbyid", "get", "user", "by", "id"]);
  });

  it("does not duplicate a single-word identifier", () => {
    expect(expandIdentifier("bucket")).toEqual(["bucket"]);
  });

  it("drops single-character noise", () => {
    expect(expandIdentifier("aB")).toEqual(["ab"]);
  });
});

describe("tokenize", () => {
  it('makes `getUserById` reachable from "user id"', () => {
    const documentTerms = new Set(tokenize("function getUserById(id: string) {}"));
    for (const term of tokenize("user id")) {
      expect(documentTerms.has(term)).toBe(true);
    }
  });

  it("strips leading and trailing underscores and dollars", () => {
    expect(tokenize("__dirname")).toContain("dirname");
    expect(tokenize("$scope")).toContain("scope");
  });

  it("returns nothing for punctuation-only text", () => {
    expect(tokenize("!!! ??? ...")).toEqual([]);
  });
});

describe("tokenizePath", () => {
  it("makes each path segment searchable", () => {
    const terms = tokenizePath("src/auth/session-store.ts");
    expect(terms).toContain("auth");
    expect(terms).toContain("session");
    expect(terms).toContain("store");
  });
});

describe("weightedTokens", () => {
  it("repeats terms to emulate BM25 field weighting", () => {
    expect(weightedTokens("bucket", 3)).toEqual(["bucket", "bucket", "bucket"]);
    expect(weightedTokens("bucket", 1)).toEqual(["bucket"]);
  });
});

describe("estimateTokens", () => {
  it("uses the chars/4 heuristic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
