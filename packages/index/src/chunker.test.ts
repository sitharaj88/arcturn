import { describe, expect, it } from "vitest";
import { chunkFile, MAX_CONTAINER_BODY_LINES } from "./chunker.js";
import { detectLanguage } from "./language.js";
import type { CodeChunk } from "./types.js";

/** Find one chunk by name, failing the test with a readable dump if absent. */
function byName(chunks: readonly CodeChunk[], name: string): CodeChunk {
  const found = chunks.find((chunk) => chunk.name === name);
  if (!found) {
    throw new Error(
      `no chunk named ${name}; got ${chunks.map((c) => `${c.kind} ${c.name}`).join(", ")}`,
    );
  }
  return found;
}

describe("detectLanguage", () => {
  it("maps extensions and known filenames", () => {
    expect(detectLanguage("src/a.ts")).toBe("typescript");
    expect(detectLanguage("src/a.tsx")).toBe("typescript");
    expect(detectLanguage("a.py")).toBe("python");
    expect(detectLanguage("a.rs")).toBe("rust");
    expect(detectLanguage("Rakefile")).toBe("ruby");
    expect(detectLanguage("a.unknownext")).toBe("text");
    expect(detectLanguage("LICENSE")).toBe("text");
  });
});

describe("chunkFile — TypeScript", () => {
  const source = [
    "/** Token bucket rate limiter. */",
    "export class TokenBucket implements Limiter {",
    "  private tokens = 0;",
    "",
    "  /** Try to consume n tokens. */",
    "  async tryConsume(n: number): Promise<boolean> {",
    "    if (this.tokens >= n) {",
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
    "  return new TokenBucket();",
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

  const chunks = chunkFile("src/rate-limit.ts", source);

  it("finds classes, methods, functions, consts, interfaces and types", () => {
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "tryConsume").kind).toBe("method");
    expect(byName(chunks, "makeBucket").kind).toBe("function");
    expect(byName(chunks, "clamp").kind).toBe("function");
    expect(byName(chunks, "DEFAULT_CAPACITY").kind).toBe("const");
    expect(byName(chunks, "Limiter").kind).toBe("interface");
    expect(byName(chunks, "Millis").kind).toBe("type");
  });

  it("records containers for members", () => {
    expect(byName(chunks, "tryConsume").container).toBe("TokenBucket");
    expect(byName(chunks, "tokens").container).toBe("TokenBucket");
    expect(byName(chunks, "makeBucket").container).toBeUndefined();
  });

  it("captures signatures without the body", () => {
    expect(byName(chunks, "tryConsume").signature).toBe(
      "async tryConsume(n: number): Promise<boolean>",
    );
    expect(byName(chunks, "TokenBucket").signature).toBe(
      "export class TokenBucket implements Limiter",
    );
  });

  it("keeps a signature whose default value contains braces", () => {
    const chunks = chunkFile(
      "src/opts.ts",
      "export function createTool(options: ToolOptions = {}): Tool {\n  return null;\n}",
    );
    expect(byName(chunks, "createTool").signature).toBe(
      "export function createTool(options: ToolOptions = {}): Tool",
    );
  });

  it("tidies a wrapped signature when its lines are joined", () => {
    const chunks = chunkFile(
      "src/wrapped.ts",
      [
        "export function fuse(",
        "  lists: readonly FusionList[],",
        "  k: number = 60,",
        "): FusedEntry[] {",
        "  return [];",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "fuse").signature).toBe(
      "export function fuse(lists: readonly FusionList[], k: number = 60): FusedEntry[]",
    );
  });

  it("captures leading doc comments", () => {
    expect(byName(chunks, "TokenBucket").doc).toBe("Token bucket rate limiter.");
    expect(byName(chunks, "tryConsume").doc).toBe("Try to consume n tokens.");
  });

  it("spans the declaration's full extent", () => {
    const method = byName(chunks, "tryConsume");
    expect(method.startLine).toBe(6);
    expect(method.endLine).toBe(12);
  });

  it("does not chunk local variables inside function bodies", () => {
    const inner = chunkFile(
      "src/x.ts",
      ["function outer() {", "  const secretLocal = 1;", "  return secretLocal;", "}"].join("\n"),
    );
    expect(inner.map((c) => c.name)).toEqual(["outer"]);
  });

  it("does not chunk locals declared inside callbacks (describe/it, IIFEs, blocks)", () => {
    const testFile = chunkFile(
      "src/x.test.ts",
      [
        'import { describe, it } from "vitest";',
        "",
        "export const REAL_FIXTURE = 1;",
        "",
        'describe("suite", () => {',
        "  const localTool = createTool();",
        '  it("works", async () => {',
        "    const localResult = await localTool.run();",
        "    expect(localResult).toBe(1);",
        "  });",
        "});",
      ].join("\n"),
    );
    const names = testFile.map((chunk) => chunk.name);
    expect(names).toContain("REAL_FIXTURE");
    expect(names).not.toContain("localTool");
    expect(names).not.toContain("localResult");
  });

  it("does not chunk statements nested inside an if or try block", () => {
    const chunks = chunkFile(
      "src/y.ts",
      [
        "export const TOP = 1;",
        "",
        "if (process.env.DEBUG) {",
        "  const hidden = 2;",
        "}",
        "",
        "try {",
        "  const alsoHidden = 3;",
        "} catch {}",
      ].join("\n"),
    );
    expect(chunks.map((c) => c.name)).toEqual(["TOP"]);
  });

  it("ignores declarations inside strings and comments", () => {
    const tricky = chunkFile(
      "src/t.ts",
      [
        "// export class NotReal {}",
        "const template = `class AlsoNotReal { }`;",
        "export function real() { return 1; }",
      ].join("\n"),
    );
    const names = tricky.map((c) => c.name);
    expect(names).toContain("real");
    expect(names).not.toContain("NotReal");
    expect(names).not.toContain("AlsoNotReal");
  });
});

describe("chunkFile — Python", () => {
  const source = [
    "import os",
    "",
    "MAX_RETRIES = 3",
    "",
    "",
    "class RetryPolicy:",
    '    """Controls how failed calls are retried."""',
    "",
    "    def should_retry(self, attempt):",
    '        """Return True when another attempt is warranted."""',
    "        return attempt < MAX_RETRIES",
    "",
    "",
    "def build_policy(",
    "    retries,",
    "):",
    '    """Factory for a policy."""',
    "    return RetryPolicy()",
  ].join("\n");

  const chunks = chunkFile("app/retry.py", source);

  it("finds classes, methods and module constants", () => {
    expect(byName(chunks, "RetryPolicy").kind).toBe("class");
    expect(byName(chunks, "should_retry").kind).toBe("method");
    expect(byName(chunks, "should_retry").container).toBe("RetryPolicy");
    expect(byName(chunks, "build_policy").kind).toBe("function");
    expect(byName(chunks, "MAX_RETRIES").kind).toBe("const");
  });

  it("uses docstrings as docs, including after a wrapped signature", () => {
    expect(byName(chunks, "RetryPolicy").doc).toBe("Controls how failed calls are retried.");
    expect(byName(chunks, "should_retry").doc).toBe(
      "Return True when another attempt is warranted.",
    );
    expect(byName(chunks, "build_policy").doc).toBe("Factory for a policy.");
  });

  it("does not chunk assignments nested inside a module-level if", () => {
    const chunks = chunkFile(
      "app/conf.py",
      ["TOP = 1", "", "if os.environ.get('DEBUG'):", "    HIDDEN = 2", ""].join("\n"),
    );
    expect(chunks.map((c) => c.name)).toEqual(["TOP"]);
  });

  it("ends a block at the dedent", () => {
    const method = byName(chunks, "should_retry");
    expect(method.startLine).toBe(9);
    expect(method.endLine).toBe(11);
  });
});

describe("chunkFile — Go, Rust, Java, Kotlin, Ruby, PHP, C, C++, C#, Swift, shell", () => {
  it("Go: functions, methods with receivers, structs and interfaces", () => {
    const chunks = chunkFile(
      "limiter.go",
      [
        "package limiter",
        "",
        "// TokenBucket limits work.",
        "type TokenBucket struct {",
        "\tcapacity int",
        "}",
        "",
        "func (b *TokenBucket) TryConsume(n int) bool {",
        "\treturn true",
        "}",
        "",
        "func New(capacity int) *TokenBucket {",
        "\treturn &TokenBucket{}",
        "}",
        "",
        "type Limiter interface {",
        "\tTryConsume(n int) bool",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("struct");
    expect(byName(chunks, "TokenBucket").doc).toBe("TokenBucket limits work.");
    expect(byName(chunks, "TryConsume").kind).toBe("method");
    expect(byName(chunks, "TryConsume").container).toBe("TokenBucket");
    expect(byName(chunks, "New").kind).toBe("function");
    expect(byName(chunks, "Limiter").kind).toBe("interface");
  });

  it("Rust: fns, structs, traits, impls and macros, with lifetimes intact", () => {
    const chunks = chunkFile(
      "src/lib.rs",
      [
        "/// A token bucket.",
        "pub struct TokenBucket {",
        "    capacity: u32,",
        "}",
        "",
        "pub trait Limiter {",
        "    fn try_consume(&mut self, n: u32) -> bool;",
        "}",
        "",
        "impl Limiter for TokenBucket {",
        "    pub fn try_consume(&mut self, n: u32) -> bool {",
        "        true",
        "    }",
        "}",
        "",
        "pub fn borrow_name<'a>(input: &'a str) -> &'a str {",
        "    input",
        "}",
        "",
        "macro_rules! shout {",
        "    () => {};",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("struct");
    expect(byName(chunks, "TokenBucket").doc).toBe("A token bucket.");
    expect(byName(chunks, "Limiter").kind).toBe("trait");
    expect(chunks.some((c) => c.kind === "impl" && c.name === "TokenBucket")).toBe(true);
    expect(byName(chunks, "borrow_name").kind).toBe("function");
    expect(byName(chunks, "shout").kind).toBe("macro");
  });

  it("Java: classes, methods, constructors and fields", () => {
    const chunks = chunkFile(
      "TokenBucket.java",
      [
        "package limiter;",
        "",
        "/** Limits work. */",
        "public final class TokenBucket implements Limiter {",
        "  private int capacity;",
        "",
        "  public TokenBucket(int capacity) {",
        "    this.capacity = capacity;",
        "  }",
        "",
        "  @Override",
        "  public boolean tryConsume(int n) {",
        "    if (n > capacity) {",
        "      return false;",
        "    }",
        "    return true;",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "TokenBucket").doc).toBe("Limits work.");
    expect(byName(chunks, "tryConsume").kind).toBe("method");
    expect(byName(chunks, "tryConsume").container).toBe("TokenBucket");
    expect(byName(chunks, "capacity").kind).toBe("property");
  });

  it("Kotlin: classes, funs and properties", () => {
    const chunks = chunkFile(
      "Limiter.kt",
      [
        "class TokenBucket(private val capacity: Int) : Limiter {",
        "    override fun tryConsume(n: Int): Boolean = n <= capacity",
        "}",
        "",
        "fun makeBucket(capacity: Int): TokenBucket = TokenBucket(capacity)",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "tryConsume").kind).toBe("method");
    expect(byName(chunks, "makeBucket").kind).toBe("function");
  });

  it("Ruby: classes, modules and methods", () => {
    const chunks = chunkFile(
      "limiter.rb",
      [
        "# Limits work.",
        "class TokenBucket",
        "  MAX = 10",
        "",
        "  def try_consume(n)",
        "    [1, 2].each do |x|",
        "      puts x",
        "    end",
        "    true",
        "  end",
        "",
        "  def self.build",
        "    new",
        "  end",
        "end",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "TokenBucket").doc).toBe("Limits work.");
    const tryConsume = byName(chunks, "try_consume");
    expect(tryConsume.kind).toBe("method");
    expect(tryConsume.container).toBe("TokenBucket");
    expect(tryConsume.endLine).toBe(10);
    expect(byName(chunks, "build").container).toBe("TokenBucket");
    expect(byName(chunks, "MAX").kind).toBe("const");
  });

  it("PHP: classes, methods and traits", () => {
    const chunks = chunkFile(
      "Limiter.php",
      [
        "<?php",
        "namespace App;",
        "",
        "/** Limits work. */",
        "final class TokenBucket implements Limiter {",
        "    private int $capacity;",
        "",
        "    public function tryConsume(int $n): bool {",
        "        return $n <= $this->capacity;",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "tryConsume").kind).toBe("method");
    expect(byName(chunks, "capacity").kind).toBe("property");
  });

  it("C: functions, structs and macros", () => {
    const chunks = chunkFile(
      "bucket.c",
      [
        "#define MAX_TOKENS 100",
        "",
        "struct token_bucket {",
        "  int capacity;",
        "};",
        "",
        "/* Consume tokens. */",
        "static int try_consume(struct token_bucket *b, int n) {",
        "  if (n > b->capacity) {",
        "    return 0;",
        "  }",
        "  return 1;",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "MAX_TOKENS").kind).toBe("macro");
    expect(byName(chunks, "token_bucket").kind).toBe("struct");
    expect(byName(chunks, "try_consume").kind).toBe("function");
    expect(byName(chunks, "try_consume").doc).toBe("Consume tokens.");
  });

  it("C++: namespaces, classes and methods", () => {
    const chunks = chunkFile(
      "bucket.cpp",
      [
        "namespace limiter {",
        "",
        "class TokenBucket {",
        " public:",
        "  bool TryConsume(int n) {",
        "    return true;",
        "  }",
        "};",
        "",
        "}  // namespace limiter",
      ].join("\n"),
    );
    expect(byName(chunks, "limiter").kind).toBe("module");
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "TryConsume").kind).toBe("method");
  });

  it("C#: classes, methods and properties", () => {
    const chunks = chunkFile(
      "TokenBucket.cs",
      [
        "namespace Limiter;",
        "",
        "public sealed class TokenBucket : ILimiter",
        "{",
        "    public int Capacity { get; init; }",
        "",
        "    public bool TryConsume(int n)",
        "    {",
        "        return n <= Capacity;",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("class");
    expect(byName(chunks, "TryConsume").kind).toBe("method");
    expect(byName(chunks, "Capacity").kind).toBe("property");
  });

  it("Swift: structs, funcs, protocols and extensions", () => {
    const chunks = chunkFile(
      "TokenBucket.swift",
      [
        "/// Limits work.",
        "public struct TokenBucket: Limiter {",
        "    private var capacity: Int",
        "",
        "    public init(capacity: Int) {",
        "        self.capacity = capacity",
        "    }",
        "",
        "    public func tryConsume(_ n: Int) -> Bool {",
        "        return n <= capacity",
        "    }",
        "}",
        "",
        "protocol Limiter {",
        "    func tryConsume(_ n: Int) -> Bool",
        "}",
        "",
        "extension TokenBucket {",
        "    func reset() {}",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "TokenBucket").kind).toBe("struct");
    expect(byName(chunks, "TokenBucket").doc).toBe("Limits work.");
    expect(byName(chunks, "tryConsume").kind).toBe("method");
    expect(byName(chunks, "init").kind).toBe("method");
    expect(byName(chunks, "Limiter").kind).toBe("trait");
    expect(chunks.some((c) => c.kind === "extension")).toBe(true);
  });

  it("shell: function definitions in both syntaxes", () => {
    const chunks = chunkFile(
      "deploy.sh",
      [
        "#!/usr/bin/env bash",
        "",
        "# Push the build.",
        "deploy_release() {",
        "  echo deploying",
        "}",
        "",
        "function rollback {",
        "  echo rolling back",
        "}",
      ].join("\n"),
    );
    expect(byName(chunks, "deploy_release").kind).toBe("function");
    expect(byName(chunks, "deploy_release").doc).toBe("Push the build.");
    expect(byName(chunks, "rollback").kind).toBe("function");
  });
});

describe("chunkFile — Markdown", () => {
  const chunks = chunkFile(
    "docs/guide.md",
    [
      "# Guide",
      "",
      "How to use the thing.",
      "",
      "## Networking",
      "",
      "Talks to servers.",
      "",
      "### Retries",
      "",
      "Retries use exponential backoff.",
      "",
      "```sh",
      "# not a heading",
      "```",
      "",
      "## Storage",
      "",
      "Writes files.",
    ].join("\n"),
  );

  it("chunks by heading with ancestor containers", () => {
    expect(chunks.map((c) => c.name)).toEqual(["Guide", "Networking", "Retries", "Storage"]);
    expect(byName(chunks, "Retries").container).toBe("Guide / Networking");
    expect(byName(chunks, "Retries").doc).toBe("Retries use exponential backoff.");
    expect(byName(chunks, "Retries").kind).toBe("section");
  });

  it("does not treat comments inside fenced code as headings", () => {
    expect(chunks.map((c) => c.name)).not.toContain("not a heading");
  });

  it("ends a section before the next same-or-shallower heading", () => {
    const networking = byName(chunks, "Networking");
    expect(networking.startLine).toBe(5);
    expect(networking.endLine).toBe(16);
  });
});

describe("chunkFile — robustness", () => {
  it("indexes an unrecognized file type as one whole-file chunk", () => {
    const chunks = chunkFile("config/settings.toml", "[server]\nport = 8080\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("file");
    expect(chunks[0]?.name).toBe("settings");
    expect(chunks[0]?.endLine).toBeGreaterThan(0);
  });

  it("indexes a syntactically broken source file without throwing", () => {
    const broken = "export class Broken {\n  method( {\n    if (a { \n'unclosed string\n";
    const chunks = chunkFile("src/broken.ts", broken);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.endLine >= c.startLine)).toBe(true);
  });

  it("indexes a file with replacement characters without throwing", () => {
    const chunks = chunkFile("data/weird.txt", "�� binary-ish � text");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("file");
  });

  it("handles an empty file", () => {
    const chunks = chunkFile("src/empty.ts", "");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(1);
  });

  it("does not store a container's full body twice (once in it, once in its members)", () => {
    const lines = ["export class Big {"];
    for (let i = 0; i < 120; i++) {
      lines.push(`  method${i}() {`, `    return ${i};`, "  }");
    }
    lines.push("}");
    const chunks = chunkFile("src/big.ts", lines.join("\n"));

    const big = chunks.find((chunk) => chunk.name === "Big");
    const member = chunks.find((chunk) => chunk.name === "method100");
    expect(big?.body?.split("\n").length).toBeLessThanOrEqual(MAX_CONTAINER_BODY_LINES);
    // The member still carries its own full body, which is what `full` renders.
    expect(member?.body).toContain("return 100;");
    expect(big?.endLine).toBe(lines.length);
  });

  it("gives every chunk in a file a unique id", () => {
    const chunks = chunkFile(
      "src/dup.ts",
      ["function a() {}", "function b() {}", "function c() {}"].join("\n"),
    );
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });
});
