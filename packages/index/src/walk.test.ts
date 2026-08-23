import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "./test-helpers/fixtures.js";
import { walkRepository } from "./walk.js";

let repo: TempRepo | null = null;

afterEach(async () => {
  await repo?.cleanup();
  repo = null;
});

/** Collect a whole walk into a sorted array. */
async function collect(options: Parameters<typeof walkRepository>[0]): Promise<string[]> {
  const out: string[] = [];
  for await (const file of walkRepository(options)) out.push(file);
  return out.sort();
}

describe("walkRepository", () => {
  it("yields repo-relative POSIX paths for every ordinary file", async () => {
    repo = await createTempRepo({
      "src/a.ts": "export const a = 1;",
      "src/nested/b.py": "x = 1",
      "README.md": "# hi",
    });
    expect(await collect({ root: repo.root })).toEqual([
      "README.md",
      "src/a.ts",
      "src/nested/b.py",
    ]);
  });

  it("skips build output, dependencies, lockfiles and binaries by default", async () => {
    repo = await createTempRepo({
      "src/a.ts": "export const a = 1;",
      "node_modules/pkg/index.js": "module.exports = 1;",
      "dist/bundle.js": "console.log(1)",
      "target/debug/app.rs": "fn main() {}",
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "vendor/lib.go": "package lib",
      "assets/logo.png": "not really a png",
      "app.min.js": "var a=1;",
      ".git/config": "[core]",
    });
    expect(await collect({ root: repo.root })).toEqual(["src/a.ts"]);
  });

  it("respects .gitignore, including nested ones and negations", async () => {
    repo = await createTempRepo({
      ".gitignore": "*.tmp\ngenerated/\n!important.tmp",
      "a.tmp": "x",
      "important.tmp": "x",
      "generated/out.ts": "x",
      "src/keep.ts": "x",
      "src/.gitignore": "local/",
      "src/local/skip.ts": "x",
    });
    expect(await collect({ root: repo.root })).toEqual([
      ".gitignore",
      "important.tmp",
      "src/.gitignore",
      "src/keep.ts",
    ]);
  });

  it("can be told to ignore .gitignore", async () => {
    repo = await createTempRepo({ ".gitignore": "*.tmp", "a.tmp": "x" });
    const files = await collect({ root: repo.root, respectGitignore: false });
    expect(files).toContain("a.tmp");
  });

  it("applies extra ignore patterns on top of the defaults", async () => {
    repo = await createTempRepo({ "src/a.ts": "x", "src/a.spec.ts": "x" });
    expect(await collect({ root: repo.root, extraIgnores: ["*.spec.ts"] })).toEqual(["src/a.ts"]);
  });

  it("stops at maxFiles", async () => {
    repo = await createTempRepo({ "a.ts": "x", "b.ts": "x", "c.ts": "x" });
    expect(await collect({ root: repo.root, maxFiles: 2 })).toHaveLength(2);
  });

  it("stops promptly when the signal aborts", async () => {
    repo = await createTempRepo({ "a.ts": "x", "b.ts": "x", "c.ts": "x" });
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const file of walkRepository({ root: repo.root, signal: controller.signal })) {
      seen.push(file);
      controller.abort();
    }
    expect(seen).toHaveLength(1);
  });

  it("returns nothing for a missing root instead of throwing", async () => {
    await expect(collect({ root: "/definitely/not/a/real/path" })).resolves.toEqual([]);
  });
});
