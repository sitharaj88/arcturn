import { describe, expect, it } from "vitest";
import {
  AIErrorException,
  createAIError,
  isRetryableError,
  parseRetryAfterMs,
  toAIError,
} from "./errors.js";

describe("toAIError", () => {
  it("maps HTTP statuses onto kinds", () => {
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [403, "auth"],
      [429, "rateLimit"],
      [529, "overloaded"],
      [503, "overloaded"],
      [500, "overloaded"],
      [400, "invalidRequest"],
      [404, "invalidRequest"],
      [408, "network"],
    ];
    for (const [status, kind] of cases) {
      const error = toAIError(Object.assign(new Error("nope"), { status }));
      expect(error.kind, `status ${status}`).toBe(kind);
      expect(error.status).toBe(status);
    }
  });

  it("classifies aborts before anything else", () => {
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    expect(toAIError(abort).kind).toBe("aborted");

    const controller = new AbortController();
    controller.abort();
    expect(toAIError(Object.assign(new Error("x"), { status: 500 }), controller.signal).kind).toBe(
      "aborted",
    );
  });

  it("maps Google RPC status strings", () => {
    expect(toAIError({ status: "RESOURCE_EXHAUSTED", message: "quota" }).kind).toBe("rateLimit");
    expect(toAIError({ status: "UNAUTHENTICATED", message: "bad key" }).kind).toBe("auth");
    expect(toAIError({ status: "UNAVAILABLE", message: "later" }).kind).toBe("overloaded");
  });

  it("maps Node network error codes, including nested causes", () => {
    expect(toAIError(Object.assign(new Error("boom"), { code: "ECONNRESET" })).kind).toBe(
      "network",
    );
    expect(
      toAIError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })).kind,
    ).toBe("network");
  });

  it("falls back to message heuristics", () => {
    expect(toAIError(new Error("Overloaded, try again")).kind).toBe("overloaded");
    expect(toAIError(new Error("rate limit exceeded")).kind).toBe("rateLimit");
    expect(toAIError(new Error("invalid api key")).kind).toBe("auth");
    expect(toAIError(new Error("something odd")).kind).toBe("unknown");
  });

  it("extracts retry-after from Headers and plain objects", () => {
    const withHeaders = Object.assign(new Error("slow down"), {
      status: 429,
      headers: new Headers({ "retry-after": "3" }),
    });
    expect(toAIError(withHeaders).retryAfterMs).toBe(3000);

    const plain = Object.assign(new Error("slow down"), {
      status: 429,
      headers: { "Retry-After-Ms": "1500" },
    });
    expect(toAIError(plain).retryAfterMs).toBe(1500);
  });

  it("round-trips an AIErrorException", () => {
    const original = createAIError("rateLimit", "slow", { status: 429, retryAfterMs: 10 });
    expect(toAIError(new AIErrorException(original))).toEqual(original);
  });

  it("handles non-Error throwables", () => {
    expect(toAIError("just a string").message).toBe("just a string");
    expect(toAIError(undefined).message).toBe("Unknown provider error");
  });
});

describe("parseRetryAfterMs", () => {
  it("reads seconds, milliseconds and HTTP dates", () => {
    expect(parseRetryAfterMs({ "retry-after": "2" })).toBe(2000);
    expect(parseRetryAfterMs({ "retry-after-ms": "250" })).toBe(250);
    const now = Date.now();
    const future = new Date(now + 5000).toUTCString();
    expect(parseRetryAfterMs({ "retry-after": future }, now)).toBeGreaterThanOrEqual(4000);
  });

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeUndefined();
  });
});

describe("isRetryableError", () => {
  it("only retries transient kinds", () => {
    expect(isRetryableError(createAIError("rateLimit", ""))).toBe(true);
    expect(isRetryableError(createAIError("overloaded", ""))).toBe(true);
    expect(isRetryableError(createAIError("network", ""))).toBe(true);
    expect(isRetryableError(createAIError("auth", ""))).toBe(false);
    expect(isRetryableError(createAIError("invalidRequest", ""))).toBe(false);
    expect(isRetryableError(createAIError("aborted", ""))).toBe(false);
  });
});
