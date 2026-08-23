import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOverlay, MAX_DIFF_LINES_PER_FILE, wrapToolsWithOverlay } from "./overlay.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fakeContext(cwd: string): ToolExecutionContext {
  return {
    cwd,
    signal: new AbortController().signal,
    requestPermission: async () => ({ requestId: "r", behavior: "allow" }),
    onUpdate: () => {},
    sessionId: "s1",
    toolCallId: "t1",
  };
}

/**
 * Stand-ins for the real tools, with just enough behaviour to observe the
 * redirect: `write` creates the file, `edit` requires it to exist already, and
 * `read` returns its content.
 */
function fakeTool(name: string): Tool {
  return {
    definition: { name, description: name, parameters: { type: "object", properties: {} } },
    async execute(input): Promise<ToolResult> {
      const path = input.path as string;
      if (name === "write") {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, input.content as string, "utf8");
        return { content: [{ type: "text", text: `wrote ${path}` }] };
      }
      if (name === "edit") {
        let current: string;
        try {
          current = await readFile(path, "utf8");
        } catch {
          return { content: [{ type: "text", text: `missing ${path}` }], isError: true };
        }
        await writeFile(path, current.replace(input.oldText as string, input.newText as string));
        return { content: [{ type: "text", text: `edited ${path}` }] };
      }
      try {
        return { content: [{ type: "text", text: await readFile(path, "utf8") }] };
      } catch {
        return { content: [{ type: "text", text: `missing ${path}` }], isError: true };
      }
    },
  };
}

describe("overlay", () => {
  let root: string;
  let workDir: string;
  let shadowDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "arcturn-overlay-"));
    workDir = join(root, "work");
    shadowDir = join(root, "shadow");
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("redirect", () => {
    it("maps a workspace path into the shadow tree, preserving structure", () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      expect(overlay.redirect(join(workDir, "src", "a.ts"))).toBe(join(shadowDir, "src", "a.ts"));
      expect(overlay.redirect(join(workDir, "a.txt"))).toBe(join(shadowDir, "a.txt"));
    });

    it("passes paths outside cwd through unchanged", () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const outside = join(root, "elsewhere", "secrets.env");
      expect(overlay.redirect(outside)).toBe(outside);
      // A sibling directory whose name merely starts with cwd is still outside.
      expect(overlay.redirect(`${workDir}-other${sep}f.txt`)).toBe(`${workDir}-other${sep}f.txt`);
      // The workspace root itself is a directory, not a sheltered file.
      expect(overlay.redirect(workDir)).toBe(workDir);
    });
  });

  describe("materialize", () => {
    it("copies the real file in once and never clobbers the shadow afterwards", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const real = join(workDir, "src", "a.txt");
      await mkdir(join(workDir, "src"), { recursive: true });
      await writeFile(real, "v1", "utf8");

      await overlay.materialize(real);
      const shadow = overlay.redirect(real);
      expect(await readFile(shadow, "utf8")).toBe("v1");

      // The agent edits the shadow, then touches the same file again.
      await writeFile(shadow, "pending", "utf8");
      await writeFile(real, "v2-from-elsewhere", "utf8");
      await overlay.materialize(real);
      expect(await readFile(shadow, "utf8")).toBe("pending");
    });

    it("is a no-op for an absent real file and for a path outside cwd", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      await overlay.materialize(join(workDir, "never-existed.txt"));
      expect(await exists(join(shadowDir, "never-existed.txt"))).toBe(false);

      const outside = join(root, "outside.txt");
      await writeFile(outside, "secret", "utf8");
      await overlay.materialize(outside);
      expect(await exists(shadowDir)).toBe(false);
    });
  });

  describe("wrapped tools", () => {
    it("writes through the overlay and leaves the real workspace untouched", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const real = join(workDir, "src", "new.txt");

      const result = await write!.execute({ path: real, content: "hello" }, fakeContext(workDir));
      expect(result.isError).toBeUndefined();
      expect(await exists(real)).toBe(false);
      expect(await readFile(join(shadowDir, "src", "new.txt"), "utf8")).toBe("hello");
    });

    it("edits the materialized copy, so the real file keeps its old content", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [edit] = wrapToolsWithOverlay([fakeTool("edit")], overlay);
      const real = join(workDir, "a.txt");
      await writeFile(real, "alpha beta", "utf8");

      // Without materialize the fake `edit` would report the file as missing.
      const result = await edit!.execute(
        { path: "a.txt", oldText: "beta", newText: "gamma" },
        fakeContext(workDir),
      );
      expect(result.isError).toBeUndefined();
      expect(await readFile(real, "utf8")).toBe("alpha beta");
      expect(await readFile(join(shadowDir, "a.txt"), "utf8")).toBe("alpha gamma");
    });

    it("reads the shadow copy when one exists and the real file otherwise", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write, read] = wrapToolsWithOverlay([fakeTool("write"), fakeTool("read")], overlay);
      const pending = join(workDir, "a.txt");
      const untouched = join(workDir, "b.txt");
      await writeFile(pending, "on disk", "utf8");
      await writeFile(untouched, "unchanged", "utf8");

      await write!.execute({ path: pending, content: "pending edit" }, fakeContext(workDir));

      const seen = await read!.execute({ path: pending }, fakeContext(workDir));
      expect(seen.content[0]).toMatchObject({ type: "text", text: "pending edit" });

      const passthrough = await read!.execute({ path: untouched }, fakeContext(workDir));
      expect(passthrough.content[0]).toMatchObject({ type: "text", text: "unchanged" });
    });

    it("passes paths outside cwd straight through to the real filesystem", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const outside = join(root, "outside.txt");

      await write!.execute({ path: outside, content: "not sheltered" }, fakeContext(workDir));
      expect(await readFile(outside, "utf8")).toBe("not sheltered");
      expect(await exists(shadowDir)).toBe(false);
    });

    it("leaves every other tool exactly as it was", () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const bash = fakeTool("bash");
      const grep = fakeTool("grep");
      const glob = fakeTool("glob");
      const write = fakeTool("write");
      const wrapped = wrapToolsWithOverlay([bash, grep, glob, write], overlay);
      expect(wrapped[0]).toBe(bash);
      expect(wrapped[1]).toBe(grep);
      expect(wrapped[2]).toBe(glob);
      expect(wrapped[3]).not.toBe(write);
    });

    it("passes through when the input has no usable path", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [read] = wrapToolsWithOverlay([fakeTool("read")], overlay);
      const result = await read!.execute({ path: "" }, fakeContext(workDir));
      expect(result.isError).toBe(true);
    });
  });

  describe("changes", () => {
    it("reports added and modified files with before/after content", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const existing = join(workDir, "a.txt");
      const created = join(workDir, "nested", "b.txt");
      await writeFile(existing, "old\n", "utf8");

      await write!.execute({ path: existing, content: "new\n" }, fakeContext(workDir));
      await write!.execute({ path: created, content: "fresh\n" }, fakeContext(workDir));

      const changes = await overlay.changes();
      expect(changes).toEqual([
        { path: existing, kind: "modified", before: "old\n", after: "new\n" },
        { path: created, kind: "added", before: null, after: "fresh\n" },
      ]);
    });

    it("is empty when nothing was written and when a shadow file matches the real one", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      expect(await overlay.changes()).toEqual([]);

      const real = join(workDir, "a.txt");
      await writeFile(real, "same", "utf8");
      await overlay.materialize(real); // Copied in, never edited.
      expect(await overlay.changes()).toEqual([]);
    });
  });

  describe("diff", () => {
    it("renders an added file against /dev/null and a modified file as a hunk", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      await writeFile(join(workDir, "a.txt"), "one\ntwo\nthree\n", "utf8");

      await write!.execute(
        { path: join(workDir, "a.txt"), content: "one\nTWO\nthree\n" },
        fakeContext(workDir),
      );
      await write!.execute(
        { path: join(workDir, "new.txt"), content: "hello\n" },
        fakeContext(workDir),
      );

      const diff = await overlay.diff();
      expect(diff).toContain("--- a/a.txt");
      expect(diff).toContain("+++ b/a.txt");
      expect(diff).toContain("-two");
      expect(diff).toContain("+TWO");
      expect(diff).toContain(" one");
      expect(diff).toContain("--- /dev/null");
      expect(diff).toContain("+++ b/new.txt");
      expect(diff).toContain("+hello");
      expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
      expect(await overlay.diff()).toBe(diff); // Pure: reading it twice is stable.
    });

    it("caps a huge diff per file and marks the truncation", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");

      await write!.execute({ path: join(workDir, "big.txt"), content: big }, fakeContext(workDir));

      const diff = await overlay.diff();
      const lines = diff.split("\n");
      // 2 header lines + capped body + 1 marker line.
      expect(lines).toHaveLength(MAX_DIFF_LINES_PER_FILE + 3);
      expect(lines.at(-1)).toContain("diff truncated");
      expect(lines.at(-1)).toContain("big.txt");
    });

    it("is empty when there are no pending changes", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      expect(await overlay.diff()).toBe("");
    });
  });

  describe("apply", () => {
    it("writes every pending change back over the real files", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const existing = join(workDir, "a.txt");
      const created = join(workDir, "nested", "b.txt");
      await writeFile(existing, "old", "utf8");

      await write!.execute({ path: existing, content: "new" }, fakeContext(workDir));
      await write!.execute({ path: created, content: "fresh" }, fakeContext(workDir));

      const result = await overlay.apply();
      expect(result.errors).toEqual([]);
      expect(new Set(result.applied)).toEqual(new Set([existing, created]));
      expect(await readFile(existing, "utf8")).toBe("new");
      expect(await readFile(created, "utf8")).toBe("fresh");
      // After applying, the shadow matches the workspace: nothing is pending.
      expect(await overlay.changes()).toEqual([]);
    });

    it("collects a per-path error and still applies the rest", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const ok = join(workDir, "ok.txt");
      // `blocked` is a *file* in the real workspace, so writing a child of it
      // cannot create the parent directory.
      await writeFile(join(workDir, "blocked"), "i am a file", "utf8");

      await write!.execute({ path: ok, content: "fine" }, fakeContext(workDir));
      await write!.execute(
        { path: join(workDir, "blocked", "child.txt"), content: "nope" },
        fakeContext(workDir),
      );

      const result = await overlay.apply();
      expect(result.applied).toEqual([ok]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe(join(workDir, "blocked", "child.txt"));
      expect(result.errors[0]?.message.length).toBeGreaterThan(0);
      expect(await readFile(ok, "utf8")).toBe("fine");
      expect(await readFile(join(workDir, "blocked"), "utf8")).toBe("i am a file");
    });

    it("does nothing when there is nothing pending", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      expect(await overlay.apply()).toEqual({ applied: [], errors: [] });
    });
  });

  describe("discard", () => {
    it("removes the whole shadow tree and leaves the workspace alone", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      const [write] = wrapToolsWithOverlay([fakeTool("write")], overlay);
      const real = join(workDir, "a.txt");
      await writeFile(real, "original", "utf8");
      await write!.execute({ path: real, content: "throwaway" }, fakeContext(workDir));
      expect(await exists(shadowDir)).toBe(true);

      await overlay.discard();
      expect(await exists(shadowDir)).toBe(false);
      expect(await readFile(real, "utf8")).toBe("original");
      expect(await overlay.changes()).toEqual([]);
    });

    it("is safe when the shadow tree was never created", async () => {
      const overlay = createOverlay({ cwd: workDir, dir: shadowDir });
      await expect(overlay.discard()).resolves.toBeUndefined();
    });
  });
});
