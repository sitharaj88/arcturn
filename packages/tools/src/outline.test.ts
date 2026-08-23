import { describe, expect, it } from "vitest";
import { formatOutlineEntry, type OutlineDeclaration, scanOutline } from "./outline.js";

/** Find one declaration by name, failing the test with a readable dump if absent. */
function byName(decls: readonly OutlineDeclaration[], name: string): OutlineDeclaration {
  const found = decls.find((d) => d.name === name);
  if (!found) {
    throw new Error(
      `no declaration named ${name}; got ${decls.map((d) => `${d.kind} ${d.name}`).join(", ")}`,
    );
  }
  return found;
}

describe("scanOutline — TypeScript", () => {
  const source = [
    "/** Token bucket rate limiter. */",
    "export class TokenBucket implements Limiter {",
    "  private tokens = 0;",
    "",
    "  /** Try to consume n tokens. */",
    "  async tryConsume(n: number): Promise<boolean> {",
    "    const ok = this.tokens >= n;",
    "    if (ok) {",
    "      this.tokens -= n;",
    "      return true;",
    "    }",
    "    return false;",
    "  }",
    "}",
    "",
    "export const DEFAULT_CAPACITY = 100;",
    "",
    "export function makeBucket(capacity: number): TokenBucket {",
    "  const bucket = new TokenBucket();",
    "  return bucket;",
    "}",
    "",
    "export const clamp = (value: number, max: number) => Math.min(value, max);",
    "",
    "export interface Limiter {",
    "  tryConsume(n: number): Promise<boolean>;",
    "}",
    "",
    "export type Millis = number;",
  ].join("\n");

  const decls = scanOutline("src/rate-limit.ts", source);

  it("finds the top-level class, function, const, interface and type", () => {
    expect(byName(decls, "TokenBucket").kind).toBe("class");
    expect(byName(decls, "makeBucket").kind).toBe("function");
    // Top-level, so it keeps its plain "const" kind — the "property" rename only applies one
    // level inside a container (see the class method test below).
    expect(byName(decls, "DEFAULT_CAPACITY").kind).toBe("const");
    expect(byName(decls, "clamp").kind).toBe("function");
    expect(byName(decls, "Limiter").kind).toBe("interface");
    expect(byName(decls, "Millis").kind).toBe("type");
  });

  it("finds the class's method one level nested, prefixed with its container", () => {
    const method = byName(decls, "TokenBucket.tryConsume");
    expect(method.kind).toBe("method");
    expect(method.signature).toContain("(n: number): Promise<boolean>");
  });

  it("does not capture local variables inside function or method bodies", () => {
    expect(decls.some((d) => d.name.endsWith(".ok") || d.name === "ok")).toBe(false);
    expect(decls.some((d) => d.name.endsWith(".bucket") || d.name === "bucket")).toBe(false);
  });

  it("records line numbers matching the declaration line", () => {
    expect(byName(decls, "TokenBucket").line).toBe(2);
    expect(byName(decls, "DEFAULT_CAPACITY").line).toBe(16);
  });
});

describe("scanOutline — Python", () => {
  const source = [
    '"""Module docstring."""',
    "RATE_LIMIT = 100",
    "",
    "",
    "class TokenBucket:",
    "    def __init__(self, capacity):",
    "        self.capacity = capacity",
    "        local_var = capacity * 2",
    "        self.tokens = local_var",
    "",
    "    def try_consume(self, n=1):",
    "        if self.tokens >= n:",
    "            self.tokens -= n",
    "            return True",
    "        return False",
    "",
    "",
    "def compute_wait(bucket, n):",
    "    deficit = n - bucket.tokens",
    "    return deficit",
  ].join("\n");

  const decls = scanOutline("ratelimit.py", source);

  it("finds the module const, class, its methods, and a top-level function", () => {
    expect(byName(decls, "RATE_LIMIT").kind).toBe("const");
    expect(byName(decls, "TokenBucket").kind).toBe("class");
    expect(byName(decls, "TokenBucket.__init__").kind).toBe("method");
    expect(byName(decls, "TokenBucket.try_consume").kind).toBe("method");
    expect(byName(decls, "compute_wait").kind).toBe("function");
  });

  it("does not capture local variables inside a method or function body", () => {
    const names = decls.map((d) => d.name);
    expect(names).not.toContain("local_var");
    expect(names).not.toContain("deficit");
    expect(names.some((n) => n.endsWith(".local_var"))).toBe(false);
  });
});

describe("scanOutline — Go", () => {
  const source = [
    "package ratelimit",
    "",
    "const DefaultCapacity = 100",
    "",
    "type TokenBucket struct {",
    "\tcapacity int",
    "}",
    "",
    "func NewTokenBucket(capacity int) *TokenBucket {",
    "\tlocal := capacity * 2",
    "\treturn &TokenBucket{capacity: local}",
    "}",
    "",
    "func (t *TokenBucket) TryConsume(n int) bool {",
    "\treturn t.capacity >= n",
    "}",
  ].join("\n");

  const decls = scanOutline("ratelimit.go", source);

  it("finds the const, struct, plain function and receiver method", () => {
    expect(byName(decls, "DefaultCapacity").kind).toBe("const");
    expect(byName(decls, "TokenBucket").kind).toBe("struct");
    expect(byName(decls, "NewTokenBucket").kind).toBe("function");
    const method = byName(decls, "TokenBucket.TryConsume");
    expect(method.kind).toBe("method");
    expect(method.signature).toContain("(n int) bool");
  });

  it("does not capture the local `local` variable inside NewTokenBucket", () => {
    expect(decls.some((d) => d.name === "local")).toBe(false);
  });
});

describe("scanOutline — Rust", () => {
  const source = [
    "pub const DEFAULT_CAPACITY: u32 = 100;",
    "",
    "pub struct TokenBucket {",
    "    capacity: u32,",
    "}",
    "",
    "impl TokenBucket {",
    "    pub fn new(capacity: u32) -> Self {",
    "        let local = capacity * 2;",
    "        TokenBucket { capacity: local }",
    "    }",
    "",
    "    pub fn try_consume(&mut self, n: u32) -> bool {",
    "        self.capacity >= n",
    "    }",
    "}",
  ].join("\n");

  const decls = scanOutline("rate_limit.rs", source);

  it("finds the const, struct, impl block and its two methods", () => {
    expect(byName(decls, "DEFAULT_CAPACITY").kind).toBe("const");
    expect(byName(decls, "TokenBucket").kind).toBe("struct");
    expect(byName(decls, "TokenBucket").line).toBe(3);
    const ctor = byName(decls, "TokenBucket.new");
    expect(ctor.kind).toBe("method");
    const consume = byName(decls, "TokenBucket.try_consume");
    expect(consume.kind).toBe("method");
    expect(consume.signature).toContain("(&mut self, n: u32) -> bool");
  });

  it("does not capture the local `local` binding inside new()", () => {
    expect(decls.some((d) => d.name.endsWith(".local"))).toBe(false);
  });
});

describe("scanOutline — Java", () => {
  const source = [
    "package com.example;",
    "",
    "public class TokenBucket {",
    "    private int capacity;",
    "",
    "    public TokenBucket(int capacity) {",
    "        int local = capacity * 2;",
    "        this.capacity = local;",
    "    }",
    "",
    "    public boolean tryConsume(int n) {",
    "        return this.capacity >= n;",
    "    }",
    "}",
  ].join("\n");

  const decls = scanOutline("TokenBucket.java", source);

  it("finds the class and the real method, but not the constructor (no return type)", () => {
    expect(byName(decls, "TokenBucket").kind).toBe("class");
    const method = byName(decls, "TokenBucket.tryConsume");
    expect(method.signature).toBe("(int n)");
    expect(decls.some((d) => d.name === "TokenBucket.TokenBucket")).toBe(false);
  });

  it("does not capture the constructor's local variable", () => {
    expect(decls.some((d) => d.name.endsWith(".local"))).toBe(false);
  });
});

describe("scanOutline — C#", () => {
  const source = [
    "namespace RateLimit",
    "{",
    "    public class TokenBucket",
    "    {",
    "        public TokenBucket(int capacity)",
    "        {",
    "            int local = capacity * 2;",
    "        }",
    "",
    "        public bool TryConsume(int n)",
    "        {",
    "            return true;",
    "        }",
    "    }",
    "}",
  ].join("\n");

  const decls = scanOutline("TokenBucket.cs", source);

  it("does not let the namespace wrapper consume the class's one level of nesting", () => {
    expect(byName(decls, "RateLimit").kind).toBe("namespace");
    expect(byName(decls, "TokenBucket").kind).toBe("class");
    const method = byName(decls, "TokenBucket.TryConsume");
    expect(method.kind).toBe("method");
  });
});

describe("scanOutline — Ruby", () => {
  const source = [
    "RATE_LIMIT = 100",
    "",
    "class TokenBucket",
    "  def initialize(capacity)",
    "    local = capacity * 2",
    "    @tokens = local",
    "  end",
    "",
    "  def try_consume(n = 1)",
    "    @tokens >= n",
    "  end",
    "end",
    "",
    "module RateLimiting",
    "  def self.helper(x)",
    "    x * 2",
    "  end",
    "end",
  ].join("\n");

  const decls = scanOutline("token_bucket.rb", source);

  it("finds the class, its methods, and a module method", () => {
    expect(byName(decls, "TokenBucket").kind).toBe("class");
    expect(byName(decls, "TokenBucket.initialize").kind).toBe("method");
    expect(byName(decls, "TokenBucket.try_consume").kind).toBe("method");
    expect(byName(decls, "RateLimiting").kind).toBe("module");
    expect(byName(decls, "RateLimiting.helper").kind).toBe("method");
  });
});

describe("scanOutline — C", () => {
  const source = [
    "typedef struct TokenBucket {",
    "    int capacity;",
    "} TokenBucket;",
    "",
    "int try_consume(TokenBucket *bucket, int n) {",
    "    int ok = bucket->capacity >= n;",
    "    return ok;",
    "}",
  ].join("\n");

  const decls = scanOutline("token_bucket.c", source);

  it("finds the struct and the function, with its parameter list", () => {
    expect(byName(decls, "TokenBucket").kind).toBe("struct");
    const fn = byName(decls, "try_consume");
    expect(fn.signature).toContain("(TokenBucket *bucket, int n)");
  });
});

describe("scanOutline — honest degradation", () => {
  it("returns [] for an unrecognized extension", () => {
    expect(scanOutline("data.xyz", "class Foo {}\nfunction bar() {}\n".repeat(100))).toEqual([]);
  });

  it("returns [] for a recognized extension with no declarations", () => {
    const prose = Array.from(
      { length: 500 },
      (_, i) => `// line ${i}: just a comment, nothing declared here at all`,
    ).join("\n");
    expect(scanOutline("notes.ts", prose)).toEqual([]);
  });

  it("returns [] for a minified single-line file with no recognizable declarations", () => {
    const minified = `(function(){${"var a=1,b=2,c=3;".repeat(2000)}})();`;
    expect(minified.includes("\n")).toBe(false);
    expect(scanOutline("bundle.min.js", minified)).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(scanOutline("empty.ts", "")).toEqual([]);
  });

  it("never throws on adversarial input", () => {
    const adversarial = [
      "class ".repeat(500),
      "function".repeat(1000),
      "\0\0\0binary-ish garbage�".repeat(50),
      "(".repeat(5000),
      "{".repeat(5000),
    ].join("\n");
    expect(() => scanOutline("weird.ts", adversarial)).not.toThrow();
  });
});

describe("formatOutlineEntry", () => {
  it("renders a callable as `line │ kind name(signature)`", () => {
    const text = formatOutlineEntry({
      line: 42,
      kind: "method",
      name: "TokenBucket.tryConsume",
      signature: "(n: number): boolean",
    });
    expect(text).toBe("    42 │ method TokenBucket.tryConsume(n: number): boolean");
  });

  it("renders a non-callable with a space before its signature", () => {
    const text = formatOutlineEntry({
      line: 5,
      kind: "class",
      name: "TokenBucket",
      signature: "extends Base",
    });
    expect(text).toBe("     5 │ class TokenBucket extends Base");
  });

  it("renders a bare name when there is no signature", () => {
    const text = formatOutlineEntry({ line: 1, kind: "module", name: "Foo", signature: "" });
    expect(text).toBe("     1 │ module Foo");
  });
});
