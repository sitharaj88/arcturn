import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryTool,
  formatMemoriesForPrompt,
  loadMemories,
  MAX_MEMORY_NOTE_BYTES,
  type Memory,
} from "./memory.js";

/** Build a temp directory populated with the given relative files. */
async function memoryRoot(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-memory-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source, "utf8");
  }
  return dir;
}

/** Minimal fake `ToolExecutionContext` — the memory tool never touches permissions. */
function fakeContext(): ToolExecutionContext {
  return {
    cwd: "/does/not/matter",
    signal: new AbortController().signal,
    requestPermission: () => {
      throw new Error("the memory tool must never request permission");
    },
    onUpdate: () => {},
    sessionId: "test-session",
    toolCallId: "test-call",
  };
}

describe("loadMemories", () => {
  it("is silently fine when the directory does not exist", async () => {
    const warnings: string[] = [];
    const memories = await loadMemories(join(tmpdir(), "arcturn-memory-missing-xyz"), warnings);
    expect(memories).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("returns an empty list for an empty directory", async () => {
    const dir = await memoryRoot();
    const warnings: string[] = [];
    const memories = await loadMemories(dir, warnings);
    expect(memories).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("uses the frontmatter title when present, and derives one from the slug otherwise", async () => {
    const dir = await memoryRoot({
      "with-title.md": ["---", "title: Custom Title", "---", "Body one."].join("\n"),
      "no-frontmatter-note.md": "Body two, no fences at all.",
    });
    const warnings: string[] = [];
    const memories = await loadMemories(dir, warnings);
    expect(warnings).toEqual([]);
    const byName = new Map(memories.map((m) => [m.slug, m]));
    expect(byName.get("with-title")).toMatchObject({ title: "Custom Title", body: "Body one." });
    expect(byName.get("no-frontmatter-note")).toMatchObject({
      title: "No Frontmatter Note",
      body: "Body two, no fences at all.",
    });
  });

  it("skips an empty-bodied note with a warning", async () => {
    const dir = await memoryRoot({
      "empty.md": ["---", "title: Empty", "---", "   "].join("\n"),
      "fine.md": "Some content.",
    });
    const warnings: string[] = [];
    const memories = await loadMemories(dir, warnings);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.slug).toBe("fine");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("empty.md");
  });

  it("skips a directory entry named like a note without warning", async () => {
    const dir = await memoryRoot({ "note.md": "Body." });
    await mkdir(join(dir, "not-a-file.md"), { recursive: true });
    const warnings: string[] = [];
    const memories = await loadMemories(dir, warnings);
    expect(memories.map((m) => m.slug)).toEqual(["note"]);
  });

  // Windows: chmod's mode argument only ever toggles the read-only
  // attribute (write access for the owner) — there is no POSIX-style
  // owner/group/other bit that `readFile` consults, so `chmod(path, 0o000)`
  // never blocks a read there and this file loads normally instead of
  // producing the warning under test. Skipped rather than weakened; the
  // POSIX behavior below is unchanged and still fully asserted.
  it.skipIf(process.platform === "win32")(
    "skips an unreadable file with a warning instead of throwing",
    async () => {
      const dir = await memoryRoot({ "note.md": "Body.", "locked.md": "Secret." });
      await chmod(join(dir, "locked.md"), 0o000);
      const warnings: string[] = [];
      try {
        const memories = await loadMemories(dir, warnings);
        expect(memories.map((m) => m.slug)).toEqual(["note"]);
        expect(warnings.some((w) => w.includes("locked.md"))).toBe(true);
      } finally {
        // Restore permissions so the temp-dir cleanup in afterEach can remove it.
        await chmod(join(dir, "locked.md"), 0o644);
      }
    },
  );
});

describe("formatMemoriesForPrompt", () => {
  function memory(overrides: Partial<Memory>): Memory {
    return {
      slug: "slug",
      title: "Title",
      body: "Body",
      source: "/x/slug.md",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  it("returns an empty string for no memories", () => {
    expect(formatMemoriesForPrompt([])).toBe("");
  });

  it("orders newest-first, tying on slug ascending", () => {
    const a = memory({ slug: "a", updatedAt: new Date("2026-01-01T00:00:00Z") });
    const b = memory({ slug: "b", updatedAt: new Date("2026-01-03T00:00:00Z") });
    const c = memory({ slug: "c", updatedAt: new Date("2026-01-03T00:00:00Z") }); // ties with b
    const rendered = formatMemoriesForPrompt([a, b, c]);
    const order = [...rendered.matchAll(/`([abc])`/g)].map((m) => m[1]);
    expect(order).toEqual(["b", "c", "a"]);
  });

  it("is deterministic regardless of input order", () => {
    const a = memory({ slug: "a", updatedAt: new Date("2026-01-01T00:00:00Z") });
    const b = memory({ slug: "b", updatedAt: new Date("2026-01-03T00:00:00Z") });
    expect(formatMemoriesForPrompt([a, b])).toBe(formatMemoriesForPrompt([b, a]));
  });

  it("truncates at maxChars with a trailing marker", () => {
    const long = memory({ slug: "long", body: "x".repeat(100) });
    const rendered = formatMemoriesForPrompt([long], 20);
    expect(rendered.length).toBe(20 + "\n…(truncated)".length);
    expect(rendered.endsWith("\n…(truncated)")).toBe(true);
  });

  it("does not truncate when under the budget", () => {
    const short = memory({ slug: "short", body: "tiny" });
    const rendered = formatMemoriesForPrompt([short], 4000);
    expect(rendered).not.toContain("truncated");
  });
});

describe("memory tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-memory-tool-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("writes a note, then lists and deletes it (round trip)", async () => {
    const tool = createMemoryTool({ dir });
    const ctx = fakeContext();

    const writeResult = await tool.execute(
      { action: "write", title: "My Note", content: "Remember this." },
      ctx,
    );
    expect(writeResult.isError).toBeFalsy();
    expect(writeResult.details).toMatchObject({ slug: "my-note", title: "My Note" });

    const written = await readFile(join(dir, "my-note.md"), "utf8");
    expect(written).toContain("title: My Note");
    expect(written).toContain("Remember this.");

    const listResult = await tool.execute({ action: "list" }, ctx);
    expect(listResult.isError).toBeFalsy();
    expect(listResult.details).toMatchObject({ memories: [{ slug: "my-note", title: "My Note" }] });

    const deleteResult = await tool.execute({ action: "delete", slug: "my-note" }, ctx);
    expect(deleteResult.isError).toBeFalsy();
    expect(deleteResult.details).toMatchObject({ deleted: true });

    const listAfter = await tool.execute({ action: "list" }, ctx);
    expect(listAfter.details).toMatchObject({ memories: [] });
    await expect(readFile(join(dir, "my-note.md"), "utf8")).rejects.toThrow();
  });

  it("deleting a missing slug is not an error", async () => {
    const tool = createMemoryTool({ dir });
    const result = await tool.execute({ action: "delete", slug: "never-existed" }, fakeContext());
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({ deleted: false });
  });

  it("normalizes a messy title into a slug", async () => {
    const tool = createMemoryTool({ dir });
    const result = await tool.execute(
      { action: "write", title: "  Weird!! Title -- With Spaces  ", content: "Body." },
      fakeContext(),
    );
    expect(result.details).toMatchObject({ slug: "weird-title-with-spaces" });
    const written = await readFile(join(dir, "weird-title-with-spaces.md"), "utf8");
    expect(written).toContain("Body.");
  });

  it("calls onChange after a write and after a delete", async () => {
    let changes = 0;
    const tool = createMemoryTool({ dir, onChange: () => changes++ });
    const ctx = fakeContext();
    await tool.execute({ action: "write", slug: "a", content: "x" }, ctx);
    expect(changes).toBe(1);
    await tool.execute({ action: "delete", slug: "a" }, ctx);
    expect(changes).toBe(2);
  });

  it("does not call onChange when a write is rejected", async () => {
    let changes = 0;
    const tool = createMemoryTool({ dir, onChange: () => changes++ });
    await tool.execute({ action: "write", content: "no title or slug" }, fakeContext());
    expect(changes).toBe(0);
  });

  it("rejects an unknown action", async () => {
    const tool = createMemoryTool({ dir });
    const result = await tool.execute({ action: "wipe-everything" }, fakeContext());
    expect(result.isError).toBe(true);
  });

  it("requires content on write", async () => {
    const tool = createMemoryTool({ dir });
    const result = await tool.execute({ action: "write", title: "No content" }, fakeContext());
    expect(result.isError).toBe(true);
  });

  it("requires slug or title on write", async () => {
    const tool = createMemoryTool({ dir });
    const result = await tool.execute({ action: "write", content: "orphan" }, fakeContext());
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("slug");
  });

  it("refuses a note over the size limit with a clear message", async () => {
    const tool = createMemoryTool({ dir });
    const oversized = "x".repeat(MAX_MEMORY_NOTE_BYTES + 1);
    const result = await tool.execute(
      { action: "write", slug: "too-big", content: oversized },
      fakeContext(),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/summarize/i);
    await expect(readFile(join(dir, "too-big.md"), "utf8")).rejects.toThrow();
  });

  it.each([["../evil"], ["/etc/passwd"], ["a\\b"], ["nested/../escape"], ["..\\..\\windows"]])(
    "rejects a path-escape slug on write: %s",
    async (badSlug) => {
      const tool = createMemoryTool({ dir });
      const result = await tool.execute(
        { action: "write", slug: badSlug, content: "malicious" },
        fakeContext(),
      );
      expect(result.isError).toBe(true);
      // Nothing should have been written anywhere near or above the memory dir.
      const entries = await readdir(dir).catch(() => []);
      expect(entries).toEqual([]);
    },
  );

  it.each([["../evil"], ["/etc/passwd"], ["a\\b"], ["nested/../escape"]])(
    "rejects a path-escape slug on delete: %s",
    async (badSlug) => {
      const tool = createMemoryTool({ dir });
      const result = await tool.execute({ action: "delete", slug: badSlug }, fakeContext());
      expect(result.isError).toBe(true);
    },
  );

  it("leaves no temp file behind after a successful write", async () => {
    const tool = createMemoryTool({ dir });
    await tool.execute({ action: "write", slug: "clean", content: "no crumbs" }, fakeContext());
    const entries = await readdir(dir);
    expect(entries).toEqual(["clean.md"]);
    expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
  });

  it("upserts: writing the same slug twice overwrites rather than duplicating", async () => {
    const tool = createMemoryTool({ dir });
    const ctx = fakeContext();
    await tool.execute({ action: "write", slug: "note", content: "v1" }, ctx);
    await tool.execute({ action: "write", slug: "note", content: "v2" }, ctx);
    const entries = await readdir(dir);
    expect(entries).toEqual(["note.md"]);
    const written = await readFile(join(dir, "note.md"), "utf8");
    expect(written).toContain("v2");
    expect(written).not.toContain("v1");
  });
});
