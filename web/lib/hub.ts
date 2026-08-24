/**
 * The hub data layer — `registry/*.json` read at build time (RFC 0002).
 *
 * The registry of record is a directory of JSON files at the repository root,
 * not a database and not a fetch: `/hub` is a static render of what is in git
 * at export time, and a future `arcturn search` reads the same files. This
 * module is the one place that knows their shape.
 *
 * **Everything here validates.** A malformed entry throws during
 * `next build` rather than rendering a half-empty card, because the thing an
 * entry describes is an install that can reach a reader's agent roots — a
 * disclosure block that silently lost its `executable` flag is worse than a
 * failed build. `parseEntry` therefore refuses defaults for required fields.
 *
 * No `@/` imports and no React: `web/scripts/hub.test.ts` loads this module
 * directly from the monorepo suite, which resolves neither.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * The asset taxonomy, in the order badges and filters render it — the RFC's
 * own order (risk ascending, roughly), not alphabetical, so `extensions`
 * always lands last where a reader's eye finishes.
 */
export const HUB_KINDS = [
  "skills",
  "agents",
  "workflows",
  "org-kit",
  "mcp",
  "themes",
  "extensions",
] as const;

export type HubKind = (typeof HUB_KINDS)[number];

/** The three dispatch lanes, derived from a role's tools by the engine. */
export type AgentLane = "read" | "exec" | "write";

/**
 * What each lane actually means for the reader's checkout, in the same words
 * `/docs/agent-organizations` uses. Kept here so the hub's table and the docs'
 * table cannot drift into two different explanations of one guarantee.
 */
export const LANE_NOTE: Record<AgentLane, string> = {
  read: "No shell and no writer — it cannot modify anything.",
  exec: "Isolated worktree so it can run things; its diff is always discarded.",
  write: "Isolated worktree; its patch is captured and applied to your checkout.",
};

export interface HubMaintainer {
  name: string;
  url: string;
}

/** One agent role the package would install, with its derived lane. */
export interface DisclosedAgent {
  name: string;
  lane: AgentLane;
  tools: string[];
}

/** One workflow the package would install. */
export interface DisclosedWorkflow {
  name: string;
  /** Numbered lines in the pipeline file; a parallel stage counts once. */
  stages: number;
  /** The file's own `budgetUsd:`, absent when it declares none. */
  budgetUsd?: number;
}

/** One skill the package would install. */
export interface DisclosedSkill {
  name: string;
  /**
   * The skill's first description line. Optional on purpose: an entry may be
   * listed before its files exist (see `registry/README.md`), and a
   * hand-typed line the package could contradict is worse than no line.
   */
  line?: string;
}

/** One MCP server the package's `mcp.json` would merge in. */
export interface DisclosedMcpServer {
  name: string;
  transport: string;
}

/** What installing the package would add, in `arcturn inspect`'s vocabulary. */
export interface HubDisclosure {
  agents?: DisclosedAgent[];
  workflows?: DisclosedWorkflow[];
  skills?: DisclosedSkill[];
  mcp?: DisclosedMcpServer[];
  /** Required, never inferred: does this package ship `extensions/` code? */
  executable: boolean;
}

/** One listed asset: exactly the contents of one `registry/<name>.json`. */
export interface HubEntry {
  name: string;
  kinds: HubKind[];
  /** What a reader types after `arcturn add` — a source the CLI resolves. */
  source: string;
  description: string;
  maintainer: HubMaintainer;
  disclosure: HubDisclosure;
}

/* ------------------------------------------------------------------ *
 * Locating the registry
 * ------------------------------------------------------------------ */

/**
 * `registry/` at the repository root, found from either working directory it
 * is legitimately read from.
 *
 * `next build` runs with the cwd at `web/`; the vitest suite runs with the cwd
 * at the repository root. Rather than pick one and break the other — the same
 * dual-spelling problem `vitest.config.ts` documents for its `include` globs —
 * both candidates are probed for the README that only the real directory has.
 */
let cachedDir: string | undefined;

export function registryDir(): string {
  if (cachedDir) return cachedDir;
  const candidates = [
    path.join(process.cwd(), "registry"),
    path.join(process.cwd(), "..", "registry"),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "README.md"))) {
      cachedDir = dir;
      return dir;
    }
  }
  throw new Error(
    `registry/ not found from ${process.cwd()} (looked in: ${candidates.join(", ")})`,
  );
}

/* ------------------------------------------------------------------ *
 * Parsing and validation
 * ------------------------------------------------------------------ */

/**
 * `owner/repo[/subdir…]`, the same shape `GITHUB_SHORTHAND` accepts in
 * `packages/cli/src/registry.ts`.
 *
 * Restated rather than imported: the CLI is a separate package with its own
 * build, and the site's static export must not depend on it having been built.
 * `web/scripts/hub.test.ts` parses the real regex out of that file and checks
 * every entry against it, so the restatement cannot drift unnoticed.
 */
const GITHUB_SHORTHAND = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;

/** `@ref` suffix, split off before the shorthand is matched. */
const REF_SUFFIX = /@([^@/]+)$/;

function fail(file: string, message: string): never {
  throw new Error(`registry/${file}: ${message}`);
}

function requireString(value: unknown, file: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    fail(file, `${field} must be a non-empty string`);
  return value;
}

function requireArray(value: unknown, file: string, field: string): unknown[] {
  if (!Array.isArray(value)) fail(file, `${field} must be an array`);
  return value;
}

function parseAgents(value: unknown, file: string): DisclosedAgent[] {
  return requireArray(value, file, "disclosure.agents").map((raw, i) => {
    const row = raw as Record<string, unknown>;
    const lane = requireString(row.lane, file, `disclosure.agents[${i}].lane`);
    if (lane !== "read" && lane !== "exec" && lane !== "write") {
      fail(file, `disclosure.agents[${i}].lane must be read, exec or write (got "${lane}")`);
    }
    return {
      name: requireString(row.name, file, `disclosure.agents[${i}].name`),
      lane,
      tools: requireArray(row.tools, file, `disclosure.agents[${i}].tools`).map((tool, j) =>
        requireString(tool, file, `disclosure.agents[${i}].tools[${j}]`),
      ),
    };
  });
}

function parseWorkflows(value: unknown, file: string): DisclosedWorkflow[] {
  return requireArray(value, file, "disclosure.workflows").map((raw, i) => {
    const row = raw as Record<string, unknown>;
    const stages = row.stages;
    if (typeof stages !== "number" || !Number.isInteger(stages) || stages < 1) {
      fail(file, `disclosure.workflows[${i}].stages must be a positive integer`);
    }
    const budget = row.budgetUsd;
    if (budget !== undefined && (typeof budget !== "number" || !Number.isFinite(budget))) {
      fail(file, `disclosure.workflows[${i}].budgetUsd must be a number when present`);
    }
    return {
      name: requireString(row.name, file, `disclosure.workflows[${i}].name`),
      stages,
      ...(budget === undefined ? {} : { budgetUsd: budget as number }),
    };
  });
}

function parseSkills(value: unknown, file: string): DisclosedSkill[] {
  return requireArray(value, file, "disclosure.skills").map((raw, i) => {
    const row = raw as Record<string, unknown>;
    const line = row.line;
    if (line !== undefined && typeof line !== "string") {
      fail(file, `disclosure.skills[${i}].line must be a string when present`);
    }
    return {
      name: requireString(row.name, file, `disclosure.skills[${i}].name`),
      ...(line === undefined ? {} : { line: line as string }),
    };
  });
}

function parseServers(value: unknown, file: string): DisclosedMcpServer[] {
  return requireArray(value, file, "disclosure.mcp").map((raw, i) => {
    const row = raw as Record<string, unknown>;
    return {
      name: requireString(row.name, file, `disclosure.mcp[${i}].name`),
      transport: requireString(row.transport, file, `disclosure.mcp[${i}].transport`),
    };
  });
}

/**
 * One entry, validated. `slug` is the filename stem and wins over any `name`
 * inside the file that disagrees with it — the URL is the identity, and two
 * files claiming one name would otherwise fight over one route.
 */
export function parseEntry(json: unknown, slug: string): HubEntry {
  const file = `${slug}.json`;
  if (typeof json !== "object" || json === null) fail(file, "must contain a JSON object");
  const raw = json as Record<string, unknown>;

  const name = requireString(raw.name, file, "name");
  if (name !== slug) fail(file, `name "${name}" must match the filename stem "${slug}"`);

  const kinds = requireArray(raw.kinds, file, "kinds").map((kind, i) => {
    const value = requireString(kind, file, `kinds[${i}]`);
    if (!(HUB_KINDS as readonly string[]).includes(value)) {
      fail(file, `kinds[${i}] "${value}" is not one of ${HUB_KINDS.join(", ")}`);
    }
    return value as HubKind;
  });
  if (kinds.length === 0) fail(file, "kinds must list at least one kind");

  const source = requireString(raw.source, file, "source");
  if (!GITHUB_SHORTHAND.test(source.replace(REF_SUFFIX, ""))) {
    fail(file, `source "${source}" is not an owner/repo[/subdir][@ref] shorthand the CLI accepts`);
  }

  const maintainerRaw = raw.maintainer;
  if (typeof maintainerRaw !== "object" || maintainerRaw === null)
    fail(file, "maintainer is required");
  const maintainer = maintainerRaw as Record<string, unknown>;

  const disclosureRaw = raw.disclosure;
  if (typeof disclosureRaw !== "object" || disclosureRaw === null)
    fail(file, "disclosure is required");
  const disclosure = disclosureRaw as Record<string, unknown>;
  if (typeof disclosure.executable !== "boolean") {
    // Required, never defaulted: "we didn't say" and "no executable code" must
    // not render as the same page to someone deciding whether to run it.
    fail(file, "disclosure.executable must be present and boolean");
  }

  return {
    name,
    kinds,
    source,
    description: requireString(raw.description, file, "description"),
    maintainer: {
      name: requireString(maintainer.name, file, "maintainer.name"),
      url: requireString(maintainer.url, file, "maintainer.url"),
    },
    disclosure: {
      ...(disclosure.agents === undefined ? {} : { agents: parseAgents(disclosure.agents, file) }),
      ...(disclosure.workflows === undefined
        ? {}
        : { workflows: parseWorkflows(disclosure.workflows, file) }),
      ...(disclosure.skills === undefined ? {} : { skills: parseSkills(disclosure.skills, file) }),
      ...(disclosure.mcp === undefined ? {} : { mcp: parseServers(disclosure.mcp, file) }),
      executable: disclosure.executable,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reading the directory
 * ------------------------------------------------------------------ */

/** Every entry name — filename stems of `registry/*.json`, sorted. */
export function allEntryNames(): string[] {
  return readdirSync(registryDir())
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every entry, validated, in name order.
 *
 * Sorted as plain strings rather than by `localeCompare`, which reads the
 * build machine's locale — the same reason `allPosts()` sorts the way it does.
 */
export function allEntries(): HubEntry[] {
  return allEntryNames().map((name) => {
    const raw = readFileSync(path.join(registryDir(), `${name}.json`), "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new Error(`registry/${name}.json: invalid JSON — ${(error as Error).message}`);
    }
    return parseEntry(json, name);
  });
}

/** One entry by name, or `undefined` when nothing is listed under it. */
export function entryByName(name: string): HubEntry | undefined {
  return allEntries().find((entry) => entry.name === name);
}

/* ------------------------------------------------------------------ *
 * Derived display values
 * ------------------------------------------------------------------ */

/**
 * The command a reader copies. Written from `source` alone so the page cannot
 * advertise an install that differs from the entry it is describing.
 */
export function installCommand(entry: HubEntry): string {
  return `arcturn add ${entry.source}`;
}

/**
 * A browsable GitHub URL for the source shorthand.
 *
 * `HEAD` rather than `main` for the tree link: the default branch is the
 * host's business, and hard-coding a branch name invents a fact about someone
 * else's repository. GitHub resolves `/tree/HEAD/…` to whatever it really is.
 */
export function sourceUrl(entry: HubEntry): string {
  const ref = REF_SUFFIX.exec(entry.source)?.[1];
  const [owner, repo, ...rest] = entry.source.replace(REF_SUFFIX, "").split("/");
  const base = `https://github.com/${owner}/${repo}`;
  if (rest.length === 0) return ref ? `${base}/tree/${ref}` : base;
  return `${base}/tree/${ref ?? "HEAD"}/${rest.join("/")}`;
}

/** An entry's kinds in taxonomy order, whatever order the file listed them. */
export function orderedKinds(entry: HubEntry): HubKind[] {
  return HUB_KINDS.filter((kind) => entry.kinds.includes(kind));
}

/** Every kind at least one listed entry actually carries, in taxonomy order. */
export function kindsInUse(entries: readonly HubEntry[]): HubKind[] {
  return HUB_KINDS.filter((kind) => entries.some((entry) => entry.kinds.includes(kind)));
}

/**
 * How a kind is spelled on the page. Only `mcp` differs from its own token —
 * the rest are the vocabulary the CLI and the docs already use, and renaming
 * them for the web would make the hub and the shell disagree.
 */
export function kindLabel(kind: HubKind): string {
  return kind === "mcp" ? "MCP" : kind;
}

/** A one-line count of what an entry would add, for the card and the header. */
export function disclosureSummary(entry: HubEntry): string {
  const { agents, workflows, skills, mcp } = entry.disclosure;
  const parts: string[] = [];
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  if (agents?.length) parts.push(plural(agents.length, "role"));
  if (workflows?.length) parts.push(plural(workflows.length, "workflow"));
  if (skills?.length) parts.push(plural(skills.length, "skill"));
  if (mcp?.length) parts.push(plural(mcp.length, "MCP server"));
  return parts.length > 0 ? parts.join(" · ") : "Nothing disclosed yet";
}
