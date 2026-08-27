import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileMentionSource,
  expandMentions,
  fuzzyScore,
  type MentionExtraSource,
} from "./mentions.js";

/** A tiny valid 1x1 transparent PNG, for image-mention tests. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4AWMAAQAABQABDQottAAAAABJRU5ErkJggg==",
  "base64",
);

/** Build a temp workspace populated with the given relative files. */
async function workspace(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-mentions-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

describe("fuzzyScore", () => {
  it("matches a subsequence and rejects a non-subsequence", () => {
    expect(fuzzyScore("edt", "editor.ts")).not.toBeNull();
    expect(fuzzyScore("zzz", "editor.ts")).toBeNull();
  });

  it("scores an empty query as a (weak) match on everything", () => {
    expect(fuzzyScore("", "anything.ts")).toBe(0);
  });

  it("scores a path-boundary match higher than a mid-word match", () => {
    // "editor" starts right after "/" in both, but the second has a longer, noisier prefix.
    const boundary = fuzzyScore("editor", "src/editor.ts");
    const midWord = fuzzyScore("editor", "xeditorx.ts");
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(boundary as number).toBeGreaterThan(midWord as number);
  });
});

describe("createFileMentionSource", () => {
  it("ranks fuzzy matches, preferring boundary/contiguous hits", async () => {
    const dir = await workspace({
      "src/editor.ts": "",
      "src/deeply/nested/somewhat/editorish.ts": "",
      "readme.md": "",
    });
    const source = createFileMentionSource(dir);
    const results = source.getSuggestions("@edit");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.value).toBe("@src/editor.ts");
    expect(results.every((r) => r.value.startsWith("@"))).toBe(true);
  });

  it("returns at most ten suggestions", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`file-${i}.txt`] = "";
    const dir = await workspace(files);
    const source = createFileMentionSource(dir);
    expect(source.getSuggestions("@file").length).toBeLessThanOrEqual(10);
  });

  it("quotes suggestion values for paths containing spaces", async () => {
    const dir = await workspace({ "my file.txt": "" });
    const source = createFileMentionSource(dir);
    const results = source.getSuggestions("@my");
    expect(results.some((r) => r.value === '@"my file.txt"')).toBe(true);
  });

  it("returns nothing when the token has no @ trigger", async () => {
    const dir = await workspace({ "a.txt": "" });
    const source = createFileMentionSource(dir);
    expect(source.getSuggestions("a")).toEqual([]);
  });

  it("ignores .git, node_modules, dist and root .gitignore patterns", async () => {
    const dir = await workspace({
      ".gitignore": "*.log\nbuild/\n",
      "src/keep.ts": "",
      "node_modules/pkg/index.js": "",
      ".git/HEAD": "",
      "dist/out.js": "",
      "build/out.js": "",
      "debug.log": "",
    });
    const source = createFileMentionSource(dir);
    const all = source.getSuggestions("@");
    const values = all.map((s) => s.value);
    expect(values).toContain("@src/keep.ts");
    for (const bad of [
      "node_modules/pkg/index.js",
      ".git/HEAD",
      "dist/out.js",
      "build/out.js",
      "debug.log",
    ]) {
      expect(values.some((v) => v.includes(bad))).toBe(false);
    }
  });

  it("caches the workspace walk instead of re-scanning every call", async () => {
    const dir = await workspace({ "a.txt": "" });
    const source = createFileMentionSource(dir);
    expect(source.getSuggestions("@a").map((s) => s.value)).toEqual(["@a.txt"]);
    await writeFile(join(dir, "b.txt"), "");
    // Within the 5s cache window the new file should not appear yet.
    expect(source.getSuggestions("@").map((s) => s.value)).not.toContain("@b.txt");
  });

  it("consults an extra source by namespace prefix instead of the file walk", async () => {
    const dir = await workspace({ "real-file.txt": "" });
    const extra: MentionExtraSource = {
      prefix: "mcp:",
      items: () => [{ value: "@mcp:widgets", label: "mcp:widgets", description: "MCP resource" }],
    };
    const source = createFileMentionSource(dir, [extra]);
    const results = source.getSuggestions("@mcp:wid");
    expect(results).toEqual([
      { value: "@mcp:widgets", label: "mcp:widgets", description: "MCP resource" },
    ]);
  });
});

describe("expandMentions", () => {
  it("injects text-file content at the end and leaves the token in place", async () => {
    const dir = await workspace({ "notes.txt": "hello from notes" });
    const result = await expandMentions("look at @notes.txt please", dir);
    expect(result.text).toContain("look at @notes.txt please");
    expect(result.text).toContain("@notes.txt:");
    expect(result.text).toContain("hello from notes");
    expect(result.images).toEqual([]);
  });

  it("truncates text content over the line/byte cap and adds a marker", async () => {
    const manyLines = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const dir = await workspace({ "big.txt": manyLines });
    const result = await expandMentions("@big.txt", dir);
    expect(result.text).toContain("truncated");
    // Only the first 2000 lines should have made it in.
    expect(result.text).toContain("line 1999");
    expect(result.text).not.toContain("line 2499");
  });

  it("truncates content over the 200KB cap even under the line cap", async () => {
    const bigLine = "x".repeat(250_000);
    const dir = await workspace({ "big.txt": bigLine });
    const result = await expandMentions("@big.txt", dir);
    expect(result.text).toContain("truncated");
    expect(result.text.length).toBeLessThan(bigLine.length + 200);
  });

  it("turns an image mention into an exact ImageContent block", async () => {
    const dir = await workspace({ "pic.png": TINY_PNG });
    const result = await expandMentions("check @pic.png out", dir);
    expect(result.images).toEqual([
      { type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" },
    ]);
    expect(result.text).toBe("check @pic.png out");
  });

  it("leaves an over-cap image token in place and notes it is too large", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const dir = await workspace({ "huge.png": big });
    const result = await expandMentions("@huge.png", dir);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("@huge.png");
    expect(result.text).toContain("too large");
  });

  it("supports double-quoted paths containing spaces", async () => {
    const dir = await workspace({ "my file.txt": "quoted content" });
    const result = await expandMentions('see @"my file.txt" now', dir);
    expect(result.text).toContain('@"my file.txt" now');
    expect(result.text).toContain("quoted content");
    expect(result.text).toContain("@my file.txt:");
  });

  it("leaves a nonexistent mention completely untouched", async () => {
    const dir = await workspace({});
    const result = await expandMentions("@nope.txt is missing", dir);
    expect(result.text).toBe("@nope.txt is missing");
    expect(result.images).toEqual([]);
  });

  it("rejects traversal outside cwd, leaving the token untouched", async () => {
    const dir = await workspace({});
    const result = await expandMentions("@../../etc/passwd is scary", dir);
    expect(result.text).toBe("@../../etc/passwd is scary");
    expect(result.images).toEqual([]);
  });

  it("rejects an absolute path outside cwd", async () => {
    const dir = await workspace({});
    const result = await expandMentions("@/etc/passwd", dir);
    expect(result.text).toBe("@/etc/passwd");
    expect(result.images).toEqual([]);
  });

  it("does not treat an email-like token as a mention", async () => {
    const dir = await workspace({});
    const result = await expandMentions("ping me@example.com", dir);
    expect(result.text).toBe("ping me@example.com");
    expect(result.images).toEqual([]);
  });

  it("ignores a mention that resolves to a directory", async () => {
    const dir = await workspace({ "sub/file.txt": "x" });
    const result = await expandMentions("@sub is a dir", dir);
    expect(result.text).toBe("@sub is a dir");
    expect(result.images).toEqual([]);
  });
});

/** A file whose every line names itself, 1-based and zero-padded. */
function numbered(count: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) lines.push(`L${String(i).padStart(3, "0")}`);
  return `${lines.join("\n")}\n`;
}

describe("expandMentions — @path:12-34 line ranges", () => {
  it("injects only the named lines, and says it is an excerpt", async () => {
    const dir = await workspace({ "big.ts": numbered(60) });
    const result = await expandMentions("look at @big.ts:12-14 please", dir);

    // The token itself survives in the prose, exactly as an unranged one does.
    expect(result.text).toContain("@big.ts:12-14 please");
    expect(result.text).toContain("L012");
    expect(result.text).toContain("L014");
    expect(result.text).not.toContain("L011");
    expect(result.text).not.toContain("L015");
    expect(result.text).toContain("excerpt, lines 12-14 of 60");
    expect(result.refusals).toEqual([]);
  });

  it("reads @path:12 as the single line 12, both ends inclusive", async () => {
    const dir = await workspace({ "big.ts": numbered(60) });
    const result = await expandMentions("@big.ts:12", dir);
    expect(result.text).toContain("excerpt, lines 12-12 of 60");
    expect(result.text).toContain("L012");
    expect(result.text).not.toContain("L013");
  });

  it("accepts the suffix on a quoted path too", async () => {
    const dir = await workspace({ "my file.ts": numbered(30) });
    const result = await expandMentions('@"my file.ts":5-6 here', dir);
    expect(result.text).toContain("excerpt, lines 5-6 of 30");
    expect(result.text).toContain("L005");
    expect(result.text).not.toContain("L007");
  });

  it("clamps an end past the last line and reports the clamp", async () => {
    const dir = await workspace({ "big.ts": numbered(60) });
    const result = await expandMentions("@big.ts:58-9000", dir);
    expect(result.text).toContain("excerpt, lines 58-60 of 60");
    expect(result.text).toContain("58-9000 was requested");
    expect(result.text).toContain("clamped");
    expect(result.text).not.toContain("L057");
  });

  it("refuses a start past the last line, with a reason, injecting nothing", async () => {
    const dir = await workspace({ "big.ts": numbered(60) });
    const result = await expandMentions("@big.ts:900-950", dir);
    expect(result.text).toBe("@big.ts:900-950");
    expect(result.refusals).toEqual([
      { what: "@big.ts:900-950", reason: "starts at line 900, but the file has 60 lines" },
    ]);
  });

  it("refuses a range on an image, which has no lines", async () => {
    const dir = await workspace({ "shot.png": TINY_PNG });
    const result = await expandMentions("@shot.png:1-2", dir);
    expect(result.images).toEqual([]);
    expect(result.refusals[0]?.reason).toMatch(/image/);
  });

  // Both of these turn on a filename containing a colon, and NTFS reserves
  // the colon for alternate data streams — the fixture cannot exist on
  // Windows, so there is no ambiguity there for the parser to resolve.
  it.skipIf(process.platform === "win32")(
    "prefers a real file whose NAME ends in something that looks like a range",
    async () => {
      // `notes:12-34` is a legal filename; the literal reading has to win when
      // the stripped one resolves to nothing.
      const dir = await workspace({ "notes:12-34": "LITERAL_NAME_SENTINEL\n" });
      const result = await expandMentions("@notes:12-34", dir);
      expect(result.text).toContain("LITERAL_NAME_SENTINEL");
      expect(result.text).not.toContain("excerpt");
    },
  );

  it("leaves a suffix that cannot mean a range as part of the path", async () => {
    const dir = await workspace({ "big.ts": numbered(10) });
    for (const text of ["@big.ts:0-4", "@big.ts:8-3"]) {
      const result = await expandMentions(text, dir);
      // Quiet, exactly as a nonexistent mention has always been — not a refusal
      // of the prompt over one token inside prose.
      expect(result.text).toBe(text);
      expect(result.refusals).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not mistake a path with a colon in it for a range",
    async () => {
      const dir = await workspace({ "a:b.ts": "COLON_NAME_SENTINEL\n" });
      const result = await expandMentions("@a:b.ts", dir);
      expect(result.text).toContain("COLON_NAME_SENTINEL");
    },
  );

  it("still refuses a ranged mention that escapes the workspace, unread", async () => {
    const dir = await workspace({});
    const result = await expandMentions("@../../etc/passwd:1-2", dir);
    expect(result.text).toBe("@../../etc/passwd:1-2");
    expect(result.refusals[0]?.what).toBe("@../../etc/passwd:1-2");
    expect(result.refusals[0]?.reason).toMatch(/outside the workspace/);
  });
});
