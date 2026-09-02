/**
 * The hub cannot describe a package the install would not produce.
 *
 * `registry/*.json` carries a **disclosure block** — the lanes each agent role
 * runs on, the tools it declares, the stage count and budget of each workflow.
 * Those are claims about files that live somewhere else, and a claim nobody
 * checks rots the first time the underlying file is edited. Every first-party
 * entry points into *this* repository, so the claim is checkable here: this
 * suite derives the same facts from `kits/**` and from the engine's own
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
  allEntryNames,
  entryByName,
  HUB_INDEX_VERSION,
  HUB_KINDS,
  hubIndex,
  installCommand,
  installSource,
  parseEntry,
  registryDir,
  sourceUrl,
} from "../lib/hub";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = join(WEB_DIR, "..");
const WORKFLOW_SRC = join(REPO_DIR, "packages", "cli", "src", "workflow.ts");
const REGISTRY_SRC = join(REPO_DIR, "packages", "cli", "src", "registry.ts");
const HUB_INDEX_SRC = join(REPO_DIR, "packages", "cli", "src", "hub-index.ts");
const INDEX_ROUTE = join(WEB_DIR, "app", "hub", "index.json", "route.ts");

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
      "https://github.com/sitharaj88/arcturn/tree/HEAD/kits/enterprise-org",
    );
  });
});

describe("first-party disclosure matches the tree it points at", () => {
  const firstParty = allEntries().filter((e) => e.source.startsWith(FIRST_PARTY));

  it("has first-party entries to check", () => {
    expect(firstParty.length).toBeGreaterThan(0);
  });

  it("pins no provider-specific model anywhere a kit resolves one", () => {
    // Every role and workflow step used to name `anthropic/claude-opus-5` (or
    // a sibling) outright, and every workflow in the hub answered 401 to
    // anyone whose Anthropic key was missing or dead — while their configured
    // model sat unused. Kits express *intent* now: `tier:judgment`,
    // `tier:build`, `tier:fast`, which a deployment's `route.tiers` maps to
    // real ids and which fall back to the user's own model otherwise. A
    // concrete provider id in a kit is portable to exactly one billing
    // account, so this walks every role's `model:` line and every workflow
    // step's `[tag]` and refuses the pin.
    const kitsRoot = join(REPO_DIR, "kits");
    const offences: string[] = [];
    for (const kit of readdirSync(kitsRoot)) {
      for (const sub of ["agents", "workflows"] as const) {
        const dir = join(kitsRoot, kit, sub);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
          const text = readFileSync(join(dir, file), "utf8");
          const model = /^model:\s*(.+)$/m.exec(text)?.[1]?.trim();
          if (model !== undefined && !model.startsWith("tier:")) {
            offences.push(`${kit}/${sub}/${file}: model: ${model}`);
          }
          for (const tag of text.matchAll(/^\d+[.)]\s*\[([^\]]+)\]/gm)) {
            if (!(tag[1] ?? "").startsWith("tier:")) {
              offences.push(`${kit}/${sub}/${file}: [${tag[1]}]`);
            }
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("names files that exist, in every kit manifest", () => {
    // enterprise-org shipped for two releases with `architect.md` where the
    // file is `agents/architect.md`. `arcturn add` does not fall back to
    // convention when a manifest is present, so every entry missed, nothing
    // linked, and the install still reported success — an eleven-role kit that
    // installed as an empty directory, on the live hub, for two releases.
    //
    // Asserted over every kit rather than that one, and against the filesystem
    // rather than against a list, so the next manifest to drift fails here.
    for (const entry of firstParty) {
      const root = join(REPO_DIR, entry.source.slice("sitharaj88/arcturn/".length));
      const manifest = join(root, "arcturn.json");
      if (!existsSync(manifest)) continue;
      const provides = (
        JSON.parse(readFileSync(manifest, "utf8")) as {
          provides?: Record<string, string[] | undefined>;
        }
      ).provides;
      for (const [kind, entries] of Object.entries(provides ?? {})) {
        for (const relative of entries ?? []) {
          expect(
            existsSync(join(root, relative)),
            `${entry.name}: provides.${kind} "${relative}"`,
          ).toBe(true);
        }
      }
    }
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

/* ------------------------------------------------------------------ *
 * The index the CLI reads
 * ------------------------------------------------------------------ */

/**
 * `/hub/index.json` is the registry as the CLI sees it: `arcturn search`
 * lists it and `arcturn add <name>` resolves a bare name through it. What is
 * checked here is the contract between this file and `hub-index.ts` in the
 * CLI — the version, the name charset, the ref shape — because the two are
 * maintained in two packages and the day they disagree every CLI in the
 * field reads the whole index as malformed.
 */
describe("the hub index (/hub/index.json)", () => {
  it("is version 1, stamped with the export time, and carries every entry in name order", () => {
    const index = hubIndex(new Date("2026-09-02T00:00:00Z"));
    expect(index.v).toBe(1);
    expect(index.v).toBe(HUB_INDEX_VERSION);
    expect(index.generatedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(index.entries).toEqual(allEntries());
    expect(index.entries.map((entry) => entry.name)).toEqual(allEntryNames());
  });

  it("round-trips through JSON, and every entry re-validates as itself", () => {
    const index = hubIndex();
    const back = JSON.parse(JSON.stringify(index)) as ReturnType<typeof hubIndex>;
    expect(back).toEqual(index);
    for (const entry of back.entries) expect(parseEntry(entry, entry.name)).toEqual(entry);
  });

  it("names every entry in the charset the CLI treats as a bare hub name", () => {
    // The literal out of hub-index.ts, so a registry file the CLI would reject
    // by name cannot reach the index.
    const src = readFileSync(HUB_INDEX_SRC, "utf8");
    const match = /export const HUB_NAME = (\/\^.*?\$\/);/.exec(src);
    expect(match, "HUB_NAME not found in hub-index.ts").toBeTruthy();
    const hubName = new RegExp((match as RegExpExecArray)[1].slice(1, -1));
    for (const entry of hubIndex().entries) expect(entry.name).toMatch(hubName);
  });

  it("carries a well-formed ref wherever an entry pins one", () => {
    for (const entry of hubIndex().entries) {
      if (entry.ref === undefined) continue;
      expect(entry.ref, entry.name).toMatch(/^[^\s/@-][^\s/@]*$/);
      expect(entry.source, entry.name).not.toMatch(/@[^/]*$/);
    }
  });

  it("refuses a malformed ref, a double pin, or a name outside the charset at build time", () => {
    const base = JSON.parse(readFileSync(join(registryDir(), "starter-skills.json"), "utf8"));
    for (const ref of ["v 1", "a/b", "-x", "v1@2", "", 1, null]) {
      expect(() => parseEntry({ ...base, ref }, "starter-skills"), JSON.stringify(ref)).toThrow(
        /ref/,
      );
    }
    expect(() =>
      parseEntry({ ...base, source: `${base.source}@v1`, ref: "v2" }, "starter-skills"),
    ).toThrow(/pins/);
    expect(() => parseEntry({ ...base, name: "Starter_Skills" }, "Starter_Skills")).toThrow(/name/);
  });

  it("puts a pinned ref into the install command and the source link alike", () => {
    // One string for the page and for `arcturn add <name>`: a listing that
    // vouched for one commit cannot advertise another.
    const base = JSON.parse(readFileSync(join(registryDir(), "starter-skills.json"), "utf8"));
    const pinned = parseEntry({ ...base, ref: "v1.2.0" }, "starter-skills");
    expect(pinned.ref).toBe("v1.2.0");
    expect(installSource(pinned)).toBe(`${base.source}@v1.2.0`);
    expect(installCommand(pinned)).toBe(`arcturn add ${base.source}@v1.2.0`);
    expect(sourceUrl(pinned)).toBe(
      "https://github.com/sitharaj88/arcturn/tree/v1.2.0/kits/starter-skills",
    );
    const unpinned = parseEntry(base, "starter-skills");
    expect("ref" in unpinned).toBe(false);
    expect(installSource(unpinned)).toBe(base.source);
  });

  it("is exported as a static route handler, so a site deploy is an index deploy", () => {
    const route = readFileSync(INDEX_ROUTE, "utf8");
    expect(route).toContain('export const dynamic = "force-static"');
    expect(route).toContain("hubIndex()");
  });
});
