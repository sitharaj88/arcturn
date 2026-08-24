/**
 * The hub cannot describe a package the install would not produce.
 *
 * `registry/*.json` carries a **disclosure block** — the lanes each agent role
 * runs on, the tools it declares, the stage count and budget of each workflow.
 * Those are claims about files that live somewhere else, and a claim nobody
 * checks rots the first time the underlying file is edited. Every first-party
 * entry points into *this* repository, so the claim is checkable here: this
 * suite derives the same facts from `examples/**` and from the engine's own
 * lane law in `packages/cli/src/workflow.ts`, and fails when an entry drifts.
 *
 * Nothing below hard-codes a lane or a stage count. The tool sets are parsed
 * out of the engine source rather than restated, so the day `EXEC_TOOLS` gains
 * a second shell-shaped tool the hub's claims are re-derived with it instead
 * of quietly going stale — the same discipline `contrast.test.ts` applies to
 * the colour tokens.
 *
 * Third-party entries (a `source` that is not this repository) are *not*
 * checked here and cannot be: their tree is not on this disk. That gap is the
 * curation stance in `registry/README.md`, stated rather than papered over.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allEntries,
  entryByName,
  HUB_KINDS,
  installCommand,
  registryDir,
  sourceUrl,
} from "../lib/hub";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = join(WEB_DIR, "..");
const WORKFLOW_SRC = join(REPO_DIR, "packages", "cli", "src", "workflow.ts");
const REGISTRY_SRC = join(REPO_DIR, "packages", "cli", "src", "registry.ts");

/** The `owner/repo/subdir` prefix every first-party entry's source starts with. */
const FIRST_PARTY = "sitharaj88/arcturn/";

/* ------------------------------------------------------------------ *
 * The engine's lane law, parsed from the engine
 * ------------------------------------------------------------------ */

/** Read a `const NAME: ReadonlySet<string> = new Set([...])` literal. */
function toolSet(name: string): Set<string> {
  const src = readFileSync(WORKFLOW_SRC, "utf8");
  const match = new RegExp(`const ${name}[^=]*= new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
  if (!match) throw new Error(`${name} not found in workflow.ts — the lane law moved`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

const WRITE_TOOLS = toolSet("WRITE_TOOLS");
const EXEC_TOOLS = toolSet("EXEC_TOOLS");

/** `roleDispatch`, re-derived from the sets it reads. */
function laneFor(tools: string[]): "read" | "exec" | "write" {
  if (tools.some((t) => WRITE_TOOLS.has(t))) return "write";
  return tools.some((t) => EXEC_TOOLS.has(t)) ? "exec" : "read";
}

/* ------------------------------------------------------------------ *
 * The example tree, read as the CLI would read it
 * ------------------------------------------------------------------ */

function frontmatter(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  return match ? match[1] : "";
}

function field(block: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block);
  return match ? match[1].trim() : undefined;
}

function toolsOf(block: string): string[] {
  const raw = field(block, "tools") ?? "";
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

interface RealAgent {
  name: string;
  lane: "read" | "exec" | "write";
  tools: string[];
}

function realAgents(dir: string): RealAgent[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const block = frontmatter(readFileSync(join(dir, f), "utf8"));
      const tools = toolsOf(block);
      return { name: field(block, "name") ?? f.replace(/\.md$/, ""), lane: laneFor(tools), tools };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

interface RealWorkflow {
  name: string;
  stages: number;
  budgetUsd?: number;
}

/** `NUMBERED_LINE` in workflow.ts: a stage is a line starting `N.` or `N)`. */
const NUMBERED_LINE = /^(\d+)[.)](?:[ \t]+(.*))?$/;

function realWorkflows(dir: string): RealWorkflow[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf8");
      const block = frontmatter(raw);
      const body = raw.slice(raw.indexOf("---", 3) + 3);
      const stages = body.split(/\r?\n/).filter((line) => NUMBERED_LINE.test(line)).length;
      const budget = field(block, "budgetUsd");
      return {
        name: field(block, "name") ?? f.replace(/\.md$/, ""),
        stages,
        budgetUsd: budget === undefined ? undefined : Number(budget),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/* ------------------------------------------------------------------ *
 * The registry itself
 * ------------------------------------------------------------------ */

describe("the registry of record", () => {
  it("holds at least one entry and parses every file in the directory", () => {
    const entries = allEntries();
    expect(entries.length).toBeGreaterThan(0);
    const files = readdirSync(registryDir()).filter((f) => f.endsWith(".json"));
    expect(entries.length).toBe(files.length);
  });

  it("names each entry after its own file, uniquely", () => {
    const names = allEntries().map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(existsSync(join(registryDir(), `${name}.json`))).toBe(true);
    }
  });

  it("uses only kinds the taxonomy defines", () => {
    for (const entry of allEntries()) {
      expect(entry.kinds.length).toBeGreaterThan(0);
      for (const kind of entry.kinds) expect(HUB_KINDS).toContain(kind);
    }
  });

  it("writes every source in a shape the CLI's own resolver accepts", () => {
    // The literal regex out of registry.ts, so a hub entry can never advertise
    // an install command the installer would reject.
    const src = readFileSync(REGISTRY_SRC, "utf8");
    const match = /const GITHUB_SHORTHAND =\s*(\/\^.*\$\/);/s.exec(src);
    expect(match, "GITHUB_SHORTHAND not found in registry.ts").toBeTruthy();
    const body = (match as RegExpExecArray)[1].slice(1, -1);
    const shorthand = new RegExp(body);
    for (const entry of allEntries()) {
      expect(shorthand.test(entry.source.split("@")[0]), entry.source).toBe(true);
    }
  });

  it("builds the install command and the source link from the source alone", () => {
    const entry = entryByName("enterprise-org");
    expect(entry).toBeDefined();
    expect(installCommand(entry!)).toBe(`arcturn add ${entry!.source}`);
    expect(sourceUrl(entry!)).toBe(
      "https://github.com/sitharaj88/arcturn/tree/HEAD/examples/enterprise-org",
    );
  });
});

describe("first-party disclosure matches the tree it points at", () => {
  const firstParty = allEntries().filter((e) => e.source.startsWith(FIRST_PARTY));

  it("has first-party entries to check", () => {
    expect(firstParty.length).toBeGreaterThan(0);
  });

  it("discloses the lane the engine would actually derive for every role", () => {
    for (const entry of firstParty) {
      const dir = join(REPO_DIR, entry.source.slice("sitharaj88/arcturn/".length), "agents");
      if (!existsSync(dir)) continue;
      const real = realAgents(dir);
      const disclosed = [...(entry.disclosure.agents ?? [])].sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
      expect(disclosed, `${entry.name}: agents`).toEqual(real);
    }
  });

  it("discloses the stage count and budget every workflow file declares", () => {
    for (const entry of firstParty) {
      const dir = join(REPO_DIR, entry.source.slice("sitharaj88/arcturn/".length), "workflows");
      if (!existsSync(dir)) continue;
      const real = realWorkflows(dir);
      const disclosed = [...(entry.disclosure.workflows ?? [])].sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
      expect(disclosed, `${entry.name}: workflows`).toEqual(real);
    }
  });

  it("claims executable code only when the tree really carries extensions/", () => {
    for (const entry of firstParty) {
      const root = join(REPO_DIR, entry.source.slice("sitharaj88/arcturn/".length));
      if (!existsSync(root)) continue;
      expect(entry.disclosure.executable, `${entry.name}: executable`).toBe(
        existsSync(join(root, "extensions")),
      );
    }
  });
});

describe("the starter-skills contract", () => {
  it("lists exactly the three skills the package is contracted to ship", () => {
    const entry = entryByName("starter-skills");
    expect(entry).toBeDefined();
    expect((entry!.disclosure.skills ?? []).map((s) => s.name)).toEqual([
      "commit-message",
      "pr-description",
      "release-notes",
    ]);
    expect(entry!.kinds).toEqual(["skills"]);
  });
});
