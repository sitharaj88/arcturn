import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentDefs, parseAgentFrontmatter } from "./agents.js";
import { BUILT_IN_TOOL_NAMES } from "./runtime.js";

/** `<repo root>/kits/enterprise-org/agents` — the real org-kit role files. */
const ENTERPRISE_ORG_AGENTS_ROOT = fileURLToPath(
  new URL("../../../kits/enterprise-org/agents", import.meta.url),
);

/** Build a temp directory populated with the given relative files. */
async function agentsRoot(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-agents-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source, "utf8");
  }
  return dir;
}

describe("parseAgentFrontmatter", () => {
  it("parses a full frontmatter block", () => {
    const raw = [
      "---",
      "name: reviewer",
      "description: Reviews diffs",
      "tools: read, grep, glob",
      "model: claude-sonnet-4-5",
      "---",
      "You are a careful reviewer.",
    ].join("\n");
    const { frontmatter, body } = parseAgentFrontmatter(raw);
    expect(frontmatter).toEqual({
      name: "reviewer",
      description: "Reviews diffs",
      tools: "read, grep, glob",
      model: "claude-sonnet-4-5",
    });
    expect(body).toBe("You are a careful reviewer.");
  });

  it("returns an empty frontmatter and the raw text when there is no leading fence", () => {
    const { frontmatter, body } = parseAgentFrontmatter("Just a body, no fences at all.");
    expect(frontmatter).toEqual({});
    expect(body).toBe("Just a body, no fences at all.");
  });

  it("treats an unterminated fence as body rather than guessing", () => {
    const raw = ["---", "name: broken", "no closing fence here"].join("\n");
    const { frontmatter, body } = parseAgentFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it("ignores unknown keys and strips matched quotes", () => {
    const raw = [
      "---",
      'description: "Quoted description"',
      "unknown: ignored",
      "---",
      "Body.",
    ].join("\n");
    const { frontmatter } = parseAgentFrontmatter(raw);
    expect(frontmatter).toEqual({ description: "Quoted description" });
  });

  it("captures maxTurns as a raw frontmatter string", () => {
    const raw = ["---", "name: dev", "maxTurns: 25", "---", "Body."].join("\n");
    const { frontmatter } = parseAgentFrontmatter(raw);
    expect(frontmatter).toEqual({ name: "dev", maxTurns: "25" });
  });
});

describe("loadAgentDefs", () => {
  it("is silently fine when a root does not exist", async () => {
    const warnings: string[] = [];
    const defs = await loadAgentDefs([join(tmpdir(), "arcturns-missing-root-xyz")], warnings);
    expect(defs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("loads a full agent definition", async () => {
    const root = await agentsRoot({
      "reviewer.md": [
        "---",
        "name: reviewer",
        "description: Reviews diffs for correctness",
        "tools: read, grep, glob",
        "model: claude-sonnet-4-5",
        "---",
        "You are a careful code reviewer. Look for bugs, not style.",
      ].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings, ["read", "grep", "glob", "bash"]);
    expect(warnings).toEqual([]);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      name: "reviewer",
      description: "Reviews diffs for correctness",
      systemPrompt: "You are a careful code reviewer. Look for bugs, not style.",
      tools: ["read", "grep", "glob"],
      model: "claude-sonnet-4-5",
      source: join(root, "reviewer.md"),
    });
  });

  it("derives the name from the filename when frontmatter omits it (minimal def)", async () => {
    const root = await agentsRoot({
      "My Cool Agent!.md": "You help with things.",
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(warnings).toEqual([]);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      name: "mycoolagent",
      description: "",
      systemPrompt: "You help with things.",
      source: join(root, "My Cool Agent!.md"),
    });
    expect(defs[0]?.tools).toBeUndefined();
    expect(defs[0]?.model).toBeUndefined();
  });

  it("parses a comma-separated tools list, trimming whitespace", async () => {
    const root = await agentsRoot({
      "scoped.md": ["---", "tools:  read ,  grep,glob  ", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings, ["read", "grep", "glob", "bash"]);
    expect(warnings).toEqual([]);
    expect(defs[0]?.tools).toEqual(["read", "grep", "glob"]);
  });

  it("parses a YAML inline flow sequence, brackets and quotes and all", async () => {
    // The spelling that cost a live workflow run its `edit` tool: the closing
    // bracket stayed glued to the last item, so `edit]` was dropped as unknown
    // and the agent rewrote whole files for 104 turns instead.
    const root = await agentsRoot({
      "writer.md": ["---", "tools: [read, write, edit]", "---", "Body."].join("\n"),
      "quoted.md": ["---", `tools: ['read', "grep" , glob]`, "---", "Body."].join("\n"),
      "truncated.md": ["---", "tools: [read, write", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings, ["read", "write", "edit", "grep", "glob"]);
    expect(warnings).toEqual([]);
    const byName = new Map(defs.map((def) => [def.name, def.tools]));
    expect(byName.get("writer")).toEqual(["read", "write", "edit"]);
    expect(byName.get("quoted")).toEqual(["read", "grep", "glob"]);
    expect(byName.get("truncated")).toEqual(["read", "write"]);
  });

  it("drops unknown tool names with a warning when a valid set is given", async () => {
    const root = await agentsRoot({
      "scoped.md": ["---", "tools: read, teleport, bash", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings, ["read", "bash"]);
    expect(defs[0]?.tools).toEqual(["read", "bash"]);
    expect(warnings).toEqual([
      `${join(root, "scoped.md")}: unknown tool "teleport" in "tools:" list (dropped)`,
    ]);
  });

  it("accepts every tool name uncritically when no valid set is given", async () => {
    const root = await agentsRoot({
      "scoped.md": ["---", "tools: read, teleport", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs[0]?.tools).toEqual(["read", "teleport"]);
    expect(warnings).toEqual([]);
  });

  it("parses the model field", async () => {
    const root = await agentsRoot({
      "fast.md": ["---", "model: groq/llama-3.3-70b-versatile", "---", "Be quick."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs[0]?.model).toBe("groq/llama-3.3-70b-versatile");
  });

  it("skips a file with an empty body and warns", async () => {
    const root = await agentsRoot({
      "empty.md": ["---", "description: nothing here", "---", "   ", ""].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs).toEqual([]);
    expect(warnings).toEqual([`${join(root, "empty.md")}: agent has an empty body (skipped)`]);
  });

  it("lets a later root win a name collision and warns naming both files", async () => {
    const userRoot = await agentsRoot({ "reviewer.md": "user body" });
    const projectRoot = await agentsRoot({ "reviewer.md": "project body" });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([userRoot, projectRoot], warnings);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.systemPrompt).toBe("project body");
    expect(defs[0]?.source).toBe(join(projectRoot, "reviewer.md"));
    expect(warnings).toEqual([
      `agent "reviewer" in ${join(projectRoot, "reviewer.md")} overrides ${join(userRoot, "reviewer.md")}`,
    ]);
  });

  it("ignores non-markdown files and dotfiles", async () => {
    const root = await agentsRoot({
      "notes.txt": "ignored",
      ".hidden.md": "ignored too",
      "real.md": "A real agent body.",
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("real");
  });

  it("parses a positive integer maxTurns", async () => {
    const root = await agentsRoot({
      "dev.md": ["---", "maxTurns: 25", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(warnings).toEqual([]);
    expect(defs[0]?.maxTurns).toBe(25);
  });

  it("drops a zero maxTurns with a warning", async () => {
    const root = await agentsRoot({
      "dev.md": ["---", "maxTurns: 0", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs[0]?.maxTurns).toBeUndefined();
    expect(warnings).toEqual([
      `${join(root, "dev.md")}: "maxTurns" must be a positive integer (dropped)`,
    ]);
  });

  it("drops a negative maxTurns with a warning", async () => {
    const root = await agentsRoot({
      "dev.md": ["---", "maxTurns: -4", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs[0]?.maxTurns).toBeUndefined();
    expect(warnings).toEqual([
      `${join(root, "dev.md")}: "maxTurns" must be a positive integer (dropped)`,
    ]);
  });

  it("drops a non-numeric maxTurns with a warning", async () => {
    const root = await agentsRoot({
      "dev.md": ["---", "maxTurns: soon", "---", "Body."].join("\n"),
    });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs[0]?.maxTurns).toBeUndefined();
    expect(warnings).toEqual([
      `${join(root, "dev.md")}: "maxTurns" must be a positive integer (dropped)`,
    ]);
  });

  it("leaves maxTurns undefined when the key is absent, no warning", async () => {
    const root = await agentsRoot({ "plain.md": "Body." });
    const warnings: string[] = [];
    const defs = await loadAgentDefs([root], warnings);
    expect(defs[0]?.maxTurns).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("loads every enterprise-org role file warning-free, tolerating its budget/consumes/produces/etc. keys", async () => {
    const warnings: string[] = [];
    const defs = await loadAgentDefs([ENTERPRISE_ORG_AGENTS_ROOT], warnings, BUILT_IN_TOOL_NAMES);
    expect(warnings).toEqual([]);
    // 10 named roles per the RFC's role catalog (§4) / two-lane table (§7.1).
    expect(defs.length).toBeGreaterThanOrEqual(10);
    const architect = defs.find((def) => def.name === "architect");
    // Every role file in the kit carries `maxTurns:` — confirms the new field
    // actually threads through loadAgentDefs, not just a synthetic fixture.
    // 50 since every role was flattened to one uniform ceiling (comfortably
    // inside the session's own subagentMaxTurns clamp) — see architect.md.
    expect(architect?.maxTurns).toBe(50);
    for (const def of defs) {
      expect(def.maxTurns).toBeGreaterThan(0);
    }
  });
});
