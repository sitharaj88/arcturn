import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "./grep.js";
import { resolvePath } from "./path-utils.js";
import { createFakeContext } from "./test-utils.js";

describe("grep tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-grep-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export function needle() {\n  return 1;\n}\n");
    await writeFile(join(dir, "src", "b.ts"), "// no match here\nconst x = 1;\n");
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "needle needle needle");
    await writeFile(join(dir, ".git", "config"), "needle in git config");
    await writeFile(
      join(dir, "binary.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds matches and skips .git, node_modules, and binary files", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle" }, ctx);

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(".git");
    expect(text).not.toContain("binary.bin");
  });

  it("spells every match's path with forward slashes, whatever the host separator is", async () => {
    // Not cosmetic. The model hands this path straight back in the next tool
    // call, inside a JSON string, and `"src\new.ts"` is valid JSON whose value
    // is `src`, a newline, `ew.ts` — a Windows-shaped path silently becomes a
    // corrupted `read` argument that nobody can see go wrong. `/` has no such
    // trap and win32 accepts it everywhere `\` works.
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle" }, ctx);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("src/a.ts:1:");
    expect(text).not.toContain("\\");
    // ...and the rendered path is a path: it resolves back to the file it named.
    const rendered = (text.split(":")[0] ?? "").trim();
    expect(resolvePath(dir, rendered)).toBe(join(dir, "src", "a.ts"));
  });

  it("supports case-insensitive search", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "NEEDLE", caseInsensitive: true }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/a.ts");
  });

  it("filters by glob", async () => {
    await writeFile(join(dir, "src", "c.md"), "needle in markdown");
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "needle", glob: "**/*.ts" }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).not.toContain("c.md");
  });

  it("includes context lines when requested", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "return 1", contextLines: 1 }, ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("export function needle()");
    expect(text).toContain("}");
  });

  it("returns a no-matches message when nothing matches", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "zzz_not_present_zzz" }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("No matches");
  });

  it("returns isError for an invalid regular expression", async () => {
    const tool = createGrepTool();
    const { ctx } = createFakeContext({ cwd: dir });

    const result = await tool.execute({ pattern: "(unclosed" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("does not request permission", async () => {
    const tool = createGrepTool();
    const { ctx, permissionRequests } = createFakeContext({ cwd: dir });

    await tool.execute({ pattern: "needle" }, ctx);
    expect(permissionRequests).toHaveLength(0);
  });
});
