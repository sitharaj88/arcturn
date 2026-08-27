import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandSucceeds,
  custom,
  fileContains,
  fileExists,
  fileMatches,
  noFileDeleted,
} from "./task.js";

describe("assertion helpers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-evals-task-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  describe("fileExists", () => {
    it("passes when the file exists", async () => {
      await writeFile(join(dir, "a.txt"), "hi", "utf8");
      const result = await fileExists("a.txt").check(dir);
      expect(result.passed).toBe(true);
    });

    it("fails with a message when the file is missing", async () => {
      const result = await fileExists("missing.txt").check(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/missing\.txt/);
    });
  });

  describe("fileContains", () => {
    it("passes for a matching substring", async () => {
      await writeFile(join(dir, "a.txt"), "hello world", "utf8");
      const result = await fileContains("a.txt", "world").check(dir);
      expect(result.passed).toBe(true);
    });

    it("passes for a matching regex", async () => {
      await writeFile(join(dir, "a.txt"), "value = 42", "utf8");
      const result = await fileContains("a.txt", /value = \d+/).check(dir);
      expect(result.passed).toBe(true);
    });

    it("fails when the substring is absent", async () => {
      await writeFile(join(dir, "a.txt"), "hello world", "utf8");
      const result = await fileContains("a.txt", "goodbye").check(dir);
      expect(result.passed).toBe(false);
    });

    it("fails when the file does not exist", async () => {
      const result = await fileContains("missing.txt", "x").check(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/exist/);
    });
  });

  describe("fileMatches", () => {
    it("passes when the predicate returns true", async () => {
      await writeFile(join(dir, "a.json"), JSON.stringify({ ok: true }), "utf8");
      const isOk = (content: string): boolean => JSON.parse(content).ok === true;
      const result = await fileMatches("a.json", isOk).check(dir);
      expect(result.passed).toBe(true);
    });

    it("fails when the predicate returns false", async () => {
      await writeFile(join(dir, "a.json"), JSON.stringify({ ok: false }), "utf8");
      const isOk = (content: string): boolean => JSON.parse(content).ok === true;
      const result = await fileMatches("a.json", isOk).check(dir);
      expect(result.passed).toBe(false);
    });

    it("supports async predicates", async () => {
      await writeFile(join(dir, "a.txt"), "async ok", "utf8");
      const result = await fileMatches("a.txt", async (content) => content.includes("async")).check(
        dir,
      );
      expect(result.passed).toBe(true);
    });

    it("uses the provided description as the assertion name", () => {
      const assertion = fileMatches("a.txt", () => true, "a custom name");
      expect(assertion.name).toBe("a custom name");
    });
  });

  describe("commandSucceeds", () => {
    it("passes for a command that exits 0", async () => {
      const result = await commandSucceeds('node -e "process.exit(0)"').check(dir);
      expect(result.passed).toBe(true);
    });

    it("fails for a command that exits non-zero, with diagnostic output", async () => {
      const result = await commandSucceeds(
        "node -e \"console.error('boom'); process.exit(1)\"",
      ).check(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/boom/);
    });

    it("runs in the workspace directory by default", async () => {
      await writeFile(join(dir, "marker.txt"), "present", "utf8");
      const result = await commandSucceeds("test -f marker.txt").check(dir);
      expect(result.passed).toBe(true);
    });

    it("respects a relative cwd option", async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "marker.txt"), "present", "utf8");
      const result = await commandSucceeds("test -f marker.txt", { cwd: "sub" }).check(dir);
      expect(result.passed).toBe(true);
    });
  });

  describe("noFileDeleted", () => {
    it("passes when every path still exists", async () => {
      await writeFile(join(dir, "a.txt"), "a", "utf8");
      await writeFile(join(dir, "b.txt"), "b", "utf8");
      const result = await noFileDeleted(["a.txt", "b.txt"]).check(dir);
      expect(result.passed).toBe(true);
    });

    it("fails and names the missing files", async () => {
      await writeFile(join(dir, "a.txt"), "a", "utf8");
      const result = await noFileDeleted(["a.txt", "b.txt"]).check(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/b\.txt/);
    });
  });

  describe("custom", () => {
    it("accepts a boolean-returning function", async () => {
      const passing = await custom("always true", () => true).check(dir);
      expect(passing.passed).toBe(true);

      const failing = await custom("always false", () => false).check(dir);
      expect(failing.passed).toBe(false);
    });

    it("accepts a function that returns a full AssertionResult", async () => {
      const result = await custom("detailed", () => ({
        name: "detailed",
        passed: false,
        message: "explained",
      })).check(dir);
      expect(result.passed).toBe(false);
      expect(result.message).toBe("explained");
    });

    it("receives the workspace directory", async () => {
      let seen: string | undefined;
      await custom("captures dir", (d) => {
        seen = d;
        return true;
      }).check(dir);
      expect(seen).toBe(dir);
    });
  });
});
