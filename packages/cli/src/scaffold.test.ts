/**
 * The scaffolder's only real claim is that what it writes *parses*, so every
 * test here round-trips the generated file through the loader the runtime
 * actually uses — `loadAgentDefs`, `parseWorkflow`, `loadSkills` — rather than
 * asserting on the template text. A template that drifts out of the format is
 * a bug the file's own author would never see, because they never run it.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentDefs } from "./agents.js";
import { runNewCommand, SCAFFOLD_KINDS, ScaffoldError, scaffold } from "./scaffold.js";
import { loadSkills } from "./skills.js";
import { isWorkflowParseError, parseWorkflow, roleDispatch } from "./workflow.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

async function scratch(): Promise<{ cwd: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-scaffold-"));
  cleanupDirs.push(root);
  return { cwd: join(root, "project"), home: join(root, "home") };
}

describe("scaffold", () => {
  it("knows exactly three kinds", () => {
    expect([...SCAFFOLD_KINDS]).toEqual(["skill", "agent", "workflow"]);
  });

  it("writes an agent the real loader accepts, with a lane its tools decide", async () => {
    const { cwd, home } = await scratch();

    const result = await scaffold({ kind: "agent", name: "reviewer", cwd, home });

    expect(result.file).toBe(join(cwd, ".arcturn", "agents", "reviewer.md"));
    const warnings: string[] = [];
    const defs = await loadAgentDefs([join(cwd, ".arcturn", "agents")], warnings);
    expect(warnings).toEqual([]);
    expect(defs).toHaveLength(1);
    const def = defs[0];
    expect(def?.name).toBe("reviewer");
    expect(def?.description).not.toBe("");
    expect(def?.systemPrompt.trim()).not.toBe("");
    // A role with no `tools:` is refused by the workflow engine outright, so a
    // scaffold that omitted it would hand the author a file that cannot run.
    expect(def?.tools?.length).toBeGreaterThan(0);
    expect(roleDispatch(def!)).toBe("read");
    // The rule that decides the lane is stated where the author will read it.
    const raw = await readFile(result.file, "utf8");
    expect(raw).toMatch(/tools:.*lane/is);
  });

  it("writes a workflow parseWorkflow accepts, budget and all", async () => {
    const { cwd, home } = await scratch();

    const result = await scaffold({ kind: "workflow", name: "ship-it", cwd, home });

    const raw = await readFile(result.file, "utf8");
    const parsed = parseWorkflow(raw, { name: "ship-it", source: result.file });
    if (isWorkflowParseError(parsed)) throw new Error(`scaffold does not parse: ${parsed.error}`);
    expect(parsed.name).toBe("ship-it");
    expect(parsed.description).not.toBe("");
    expect(parsed.stages.length).toBeGreaterThanOrEqual(2);
    expect(parsed.budgetUsd).toBeGreaterThan(0);
    // The teaching comments live above the first numbered line, which is the
    // only place the parser treats as documentation.
    expect(raw).toMatch(/budgetUsd:.*(whole run|run may spend)/is);
    // …and they name the token ceiling too — the only one that can fire on a
    // model with no published pricing, where budgetUsd never trips.
    expect(raw).toMatch(/budgetTokens:.*total tokens/is);
  });

  it("writes a skill the real loader accepts", async () => {
    const { cwd, home } = await scratch();

    const result = await scaffold({ kind: "skill", name: "changelog", cwd, home });

    expect(result.file).toBe(join(cwd, ".arcturn", "skills", "changelog.md"));
    const warnings: string[] = [];
    const skills = await loadSkills([join(cwd, ".arcturn", "skills")], warnings);
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("changelog");
    expect(skills[0]?.description).not.toBe("");
    expect(skills[0]?.buildPrompt("v2.1", "/work")).toContain("v2.1");
  });

  it("--user writes into the user root instead of the project", async () => {
    const { cwd, home } = await scratch();

    const result = await scaffold({ kind: "agent", name: "scribe", scope: "user", cwd, home });

    expect(result.file).toBe(join(home, "agents", "scribe.md"));
    expect(await loadAgentDefs([join(home, "agents")], [])).toHaveLength(1);
  });

  it("refuses to overwrite an existing file", async () => {
    const { cwd, home } = await scratch();
    const first = await scaffold({ kind: "skill", name: "dupe", cwd, home });
    await writeFile(first.file, "my own work, please do not clobber", "utf8");

    await expect(scaffold({ kind: "skill", name: "dupe", cwd, home })).rejects.toThrow(
      ScaffoldError,
    );
    expect(await readFile(first.file, "utf8")).toBe("my own work, please do not clobber");
  });

  it("rejects a name that is not a single safe path segment", async () => {
    const { cwd, home } = await scratch();
    for (const name of ["../evil", "a/b", "Caps", "", ".hidden", "with space"]) {
      await expect(scaffold({ kind: "agent", name, cwd, home })).rejects.toThrow(ScaffoldError);
    }
  });
});

describe("runNewCommand", () => {
  it("scaffolds and reports the path it wrote", async () => {
    const { cwd, home } = await scratch();
    const out: string[] = [];

    const code = await runNewCommand({
      argv: ["workflow", "release"],
      cwd,
      home,
      stdout: (text) => out.push(text),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(out.join("\n")).toContain(join(cwd, ".arcturn", "workflows", "release.md"));
    // The next step has to be one that actually works from here: a workflow is
    // run, not inspected, and the hint said so wrongly once already.
    expect(out.join("\n")).toContain("/workflow release");
  });

  it("tells each kind the next step that is true for it", async () => {
    const { cwd, home } = await scratch();
    const say = async (argv: string[]): Promise<string> => {
      const out: string[] = [];
      await runNewCommand({ argv, cwd, home, stdout: (text) => out.push(text), stderr: () => {} });
      return out.join("\n");
    };
    expect(await say(["skill", "hello"])).toContain("/hello");
    expect(await say(["agent", "checker"])).toContain("@checker");
    // ".arcturn" alone is not a local path to `resolveSource` (no "./" prefix),
    // so a hint that spelled it that way would fail the moment anyone ran it.
    expect(await say(["agent", "checker2"])).toContain("arcturn inspect ./.arcturn");
  });

  it("passes --user through", async () => {
    const { cwd, home } = await scratch();
    const out: string[] = [];
    const code = await runNewCommand({
      argv: ["skill", "greet", "--user"],
      cwd,
      home,
      stdout: (text) => out.push(text),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(join(home, "skills", "greet.md"));
  });

  it("exits 2 on a usage error and 1 when the file already exists", async () => {
    const { cwd, home } = await scratch();
    const errs: string[] = [];
    const io = { cwd, home, stdout: () => {}, stderr: (text: string) => errs.push(text) };

    expect(await runNewCommand({ argv: [], ...io })).toBe(2);
    expect(await runNewCommand({ argv: ["agent"], ...io })).toBe(2);
    expect(await runNewCommand({ argv: ["gadget", "x"], ...io })).toBe(2);
    expect(errs.join("\n")).toContain("skill");

    expect(await runNewCommand({ argv: ["agent", "twice"], ...io })).toBe(0);
    expect(await runNewCommand({ argv: ["agent", "twice"], ...io })).toBe(1);
  });
});
