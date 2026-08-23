import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReadTool,
  DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES,
  DEFAULT_LINE_LIMIT,
} from "./read.js";
import { createFakeContext } from "./test-utils.js";

/**
 * A well-formed TypeScript source comfortably over the default auto-outline threshold: `count`
 * exported functions, each with a multi-line body so the file body is much larger than a
 * one-line-per-declaration outline of it.
 */
function bigTsSource(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      `export function processItem${i}(item: Item, index: number): ProcessedItem {`,
      `  const validated = validateItem(item);`,
      `  const normalized = normalizeItem(validated);`,
      `  const enriched = enrichItem(normalized, index);`,
      `  return finalizeItem(enriched);`,
      `}`,
      "",
    );
  }
  return parts.join("\n");
}

describe("read tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-read-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a whole small file in cat -n style", async () => {
    await writeFile(join(dir, "hello.txt"), "line one\nline two\nline three");
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "hello.txt" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1\tline one");
    expect(text).toContain("2\tline two");
    expect(text).toContain("3\tline three");
  });

  it("resolves relative paths against ctx.cwd", async () => {
    await writeFile(join(dir, "rel.txt"), "content");
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });
    const result = await tool.execute({ path: "rel.txt" }, ctx);
    expect(result.isError).toBeFalsy();
  });

  it("honors offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(join(dir, "paged.txt"), lines);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "paged.txt", offset: 3, limit: 2 }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("3\tline 3");
    expect(text).toContain("4\tline 4");
    expect(text).not.toContain("line 5");
    expect(text).not.toContain("line 2");
  });

  it("caps output at the default 2000-line limit and notes truncation", async () => {
    const lines = Array.from({ length: DEFAULT_LINE_LIMIT + 50 }, (_, i) => `l${i + 1}`).join("\n");
    await writeFile(join(dir, "big.txt"), lines);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "big.txt" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`Showing lines 1-${DEFAULT_LINE_LIMIT}`);
    expect(text).not.toContain(`l${DEFAULT_LINE_LIMIT + 1}\n`);
  });

  it("truncates very long lines", async () => {
    const longLine = "x".repeat(3000);
    await writeFile(join(dir, "longline.txt"), longLine);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "longline.txt" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("[line truncated at 2000 chars]");
  });

  it("returns isError with a helpful message for a missing file", async () => {
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "does-not-exist.txt" }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("File not found");
  });

  it("does not request permission", async () => {
    await writeFile(join(dir, "hello.txt"), "hi");
    const tool = createReadTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ path: "hello.txt" }, ctx);
    expect(permissionRequests).toHaveLength(0);
  });

  it("returns image content for image files", async () => {
    const pngPath = join(dir, "pixel.png");
    // Minimal 1x1 transparent PNG.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await writeFile(pngPath, Buffer.from(pngBase64, "base64"));
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "pixel.png" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("returns isError quickly when already aborted", async () => {
    await writeFile(join(dir, "hello.txt"), "hi");
    const tool = createReadTool();
    const controller = new AbortController();
    controller.abort();
    const { ctx } = createFakeContext({ cwd: dir, signal: controller.signal });

    const result = await tool.execute({ path: "hello.txt" }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe("read tool — auto-outline", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-read-outline-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a structural outline with no body for a large file", async () => {
    const source = bigTsSource(200);
    expect(Buffer.byteLength(source)).toBeGreaterThan(DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES);
    await writeFile(join(dir, "big.ts"), source);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "big.ts" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    // Every declaration shows up as a `line │ kind name(signature)` entry…
    expect(text).toContain("function processItem0(item: Item, index: number): ProcessedItem");
    expect(text).toContain("function processItem199(item: Item, index: number): ProcessedItem");
    // …and the body itself — the local `const` lines inside each function — is not present.
    expect(text).not.toContain("const validated");
    expect(text).not.toContain("const normalized");
    expect(result.details).toMatchObject({ outline: true, declarationCount: 200 });
  });

  it("returns literal lines, never an outline, when offset/limit is given for the same file", async () => {
    const source = bigTsSource(200);
    await writeFile(join(dir, "big.ts"), source);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "big.ts", offset: 1, limit: 5 }, ctx);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1\texport function processItem0");
    expect(text).toContain("const validated = validateItem(item);");
    expect(result.details).not.toMatchObject({ outline: true });

    // Explicit reads win even when outline: true is also passed alongside offset/limit.
    const combined = await tool.execute(
      { path: "big.ts", offset: 1, limit: 5, outline: true },
      ctx,
    );
    const combinedText = (combined.content[0] as { text: string }).text;
    expect(combinedText).toContain("1\texport function processItem0");
    expect(combined.details).not.toMatchObject({ outline: true });
  });

  it("honors outline: true on a file well under the threshold", async () => {
    const source = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export class Greeter {",
      "  greet(name: string): string {",
      "    return name.toUpperCase();",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(Buffer.byteLength(source)).toBeLessThan(DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES);
    await writeFile(join(dir, "small.ts"), source);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "small.ts", outline: true }, ctx);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("function add(a: number, b: number): number");
    expect(text).toContain("class Greeter");
    expect(text).toContain("method Greeter.greet(name: string): string");
    expect(text).not.toContain("return a + b;");
    expect(result.details).toMatchObject({ outline: true });
  });

  it("honors outline: false on a large file, forcing the full body", async () => {
    const source = bigTsSource(200);
    await writeFile(join(dir, "big.ts"), source);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "big.ts", outline: false }, ctx);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("export function processItem0");
    expect(text).toContain("const validated = validateItem(item);");
    expect(result.details).not.toMatchObject({ outline: true });
  });

  it("falls back to a truncated read for a large file in an unrecognized language", async () => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `record ${i}: field_a=${i}, field_b=${i * 2}, field_c=some-plain-data-value`,
    );
    const source = lines.join("\n");
    await writeFile(join(dir, "big.unknownlang"), source);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "big.unknownlang" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No structural outline was available");
    expect(text).toContain("record 0: field_a=0");
    expect(result.details).toMatchObject({ outlineUnavailable: true });
  });

  it("falls back gracefully for a large minified single-line file", async () => {
    const minified = `(function(){${"var a=1,b=2,c=3;".repeat(2000)}})();`;
    expect(minified.includes("\n")).toBe(false);
    expect(Buffer.byteLength(minified)).toBeGreaterThan(DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES);
    await writeFile(join(dir, "bundle.min.js"), minified);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "bundle.min.js" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No structural outline was available");
    expect(text).toContain("(function(){var a=1,b=2,c=3;");
    expect(result.details).toMatchObject({ outlineUnavailable: true });
  });

  it("falls back gracefully for a large recognized-language file with no declarations", async () => {
    const prose = Array.from(
      { length: 600 },
      (_, i) => `// note ${i}: this is just a comment explaining something, no code here`,
    ).join("\n");
    expect(Buffer.byteLength(prose)).toBeGreaterThan(DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES);
    await writeFile(join(dir, "notes.ts"), prose);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "notes.ts" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No structural outline was available");
    expect(text).toContain("note 0: this is just a comment");
    expect(result.details).toMatchObject({ outlineUnavailable: true });
  });

  it("respects a custom autoOutlineThresholdBytes", async () => {
    const source = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
    ].join("\n");
    await writeFile(join(dir, "tiny.ts"), source);
    const tool = createReadTool({ autoOutlineThresholdBytes: 10 });
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ path: "tiny.ts" }, ctx);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("function add(a: number, b: number): number");
    expect(text).not.toContain("return a + b;");
    expect(result.details).toMatchObject({ outline: true });
  });

  it("shrinks a large file's context cost dramatically (chars/4 token estimate)", async () => {
    const source = bigTsSource(300);
    expect(Buffer.byteLength(source)).toBeGreaterThan(DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES);
    await writeFile(join(dir, "big.ts"), source);
    const tool = createReadTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const outlineResult = await tool.execute({ path: "big.ts" }, ctx);
    const outlineText = (outlineResult.content[0] as { text: string }).text;
    const bodyResult = await tool.execute({ path: "big.ts", outline: false }, ctx);
    const bodyText = (bodyResult.content[0] as { text: string }).text;

    // chars/4 is the estimator the harness's own architecture notes call out — the whole point
    // of the outline is that this ratio is dramatic, not marginal. This fixture measures at
    // roughly a 4x reduction; 0.4 leaves comfortable margin without being a meaningless bound.
    const outlineTokens = outlineText.length / 4;
    const bodyTokens = bodyText.length / 4;
    expect(outlineTokens).toBeLessThan(bodyTokens * 0.4);
  });
});
