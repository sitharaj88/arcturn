/**
 * Markdown agents: named sub-agent specializations defined declaratively as
 * `.md` files.
 *
 * This is the sibling of {@link "./skills.js" | markdown skills}: instead of
 * expanding a slash-command prompt, a markdown agent describes a whole
 * delegate — its system prompt, an optional restricted tool set and an
 * optional model override — that the main agent can hand a task to (see
 * `createSubagentTool` in `@arcturn/core` and `ArcturnRuntime.createSubagent`
 * in `./runtime.ts`). `INTEGRATION-agents.md` at the repo root describes how
 * `runtime.ts` should wire this loader in; this module only discovers and
 * parses the files, it does not touch the runtime.
 *
 * File shape: `<root>/<name>.md`, a single frontmatter-delimited markdown
 * file per agent (no folder variant, unlike skills — an agent has no
 * `$SKILL_DIR`-style assets to reference). Frontmatter is the same plain
 * `key: value` block skills use: a leading `---` line, `key: value` pairs
 * with no nesting, quoting stripped, closed by another `---` line. Recognised
 * keys:
 *
 * - `name` — defaults to the filename stem, normalized to `[a-z0-9-]`.
 * - `description` — one-line summary shown to the model when it is choosing
 *   an agent to delegate to.
 * - `tools` — a single comma-separated line, e.g. `tools: read, grep, glob`.
 *   Unknown tool names (checked against a caller-supplied allow-list, such as
 *   `BUILT_IN_TOOL_NAMES` from `./runtime.ts`) are dropped with a warning
 *   rather than rejecting the whole file.
 * - `model` — a model id string, passed through uninterpreted (this module
 *   does not resolve it against `@arcturn/ai`'s catalog).
 * - `maxTurns` — a per-agent turn ceiling, e.g. `maxTurns: 12`. Must be a
 *   positive integer; anything else (zero, negative, non-numeric) is dropped
 *   with a warning rather than silently coerced. `undefined` means "use the
 *   runtime's default subagent ceiling" (`runtime.ts` `createSubagent`).
 *
 * Everything after the frontmatter is the system prompt verbatim (no
 * template substitution, unlike skills — an agent's prompt does not take
 * per-invocation arguments). An empty body is a malformed file and is
 * skipped with a warning, exactly like an empty skill body.
 *
 * Loading is defensive throughout, mirroring `loadSkills`: a missing root is
 * silently fine, an unreadable or malformed file is skipped with a warning
 * pushed onto the caller-supplied collector, and a later root's agent
 * silently wins a name collision (also reported as a warning) so a project
 * agent can override a user agent of the same name.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** A markdown-defined named sub-agent. */
export interface AgentDef {
  /** Agent name, normalized to `[a-z0-9-]`. */
  name: string;
  /** One-line summary; empty string when the file set none. */
  description: string;
  /** The agent's system prompt (the file body, after frontmatter). */
  systemPrompt: string;
  /** Restricted tool set, by name. `undefined` means "no restriction". */
  tools?: string[];
  /** Model id override. `undefined` means "use the parent's model". */
  model?: string;
  /**
   * Per-agent turn ceiling, from `maxTurns:` frontmatter. `undefined` means
   * "use the dispatcher's default" (`createSubagent` falls back to
   * `config.subagentMaxTurns ?? SUBAGENT_MAX_TURNS`).
   */
  maxTurns?: number;
  /** Absolute path of the file the agent was loaded from. */
  source: string;
}

const NAME_STRIP = /[^a-z0-9-]/g;

/**
 * Normalise a raw name into the `[a-z0-9-]` charset the registry expects.
 *
 * @param raw - Candidate name (a filename stem or a frontmatter value).
 */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(NAME_STRIP, "");
}

/** Parsed frontmatter fields understood by agent files. */
interface Frontmatter {
  description?: string;
  name?: string;
  tools?: string;
  model?: string;
  maxTurns?: string;
}

/**
 * Split a markdown agent file into its optional frontmatter and body.
 *
 * Frontmatter is a leading block between two lines that are exactly `---`,
 * containing only simple `key: value` lines (no nesting, no YAML lists, no
 * quoting beyond a single matched pair of quotes) — anything more elaborate
 * is silently skipped rather than parsed wrong. Only `description`, `name`,
 * `tools`, `model` and `maxTurns` keys are recognised; other keys (the org
 * kit's `budget`, `consumes`, `produces`, etc.) are ignored, not rejected —
 * this loader only cares about what it dispatches with.
 *
 * @param raw - Full file contents.
 */
export function parseAgentFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Unterminated fence: treat the whole file as body rather than guessing.
    return { frontmatter: {}, body: raw };
  }
  const frontmatter: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === "description") frontmatter.description = value;
    else if (key === "name") frontmatter.name = value;
    else if (key === "tools") frontmatter.tools = value;
    else if (key === "model") frontmatter.model = value;
    else if (key === "maxTurns") frontmatter.maxTurns = value;
  }
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter, body };
}

/**
 * Parse a `tools:` frontmatter value into individual tool names.
 *
 * Kept deliberately simple, matching the doc comment's "comma-separated on
 * one line" contract: split on commas, trim, drop empties. No YAML list
 * syntax (`- read`) is understood.
 *
 * @param raw - The raw frontmatter value.
 */
function parseToolsList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * List `.md` agent-file candidates directly under one root.
 *
 * A missing root yields no candidates. Non-markdown files and dotfiles are
 * ignored; unlike skills, agents have no folder (`<name>/SKILL.md`) variant.
 *
 * @param root - Directory to scan.
 */
async function discoverCandidates(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    if (!entry.endsWith(".md")) continue;
    const full = join(root, entry);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    candidates.push(full);
  }
  return candidates;
}

/**
 * Load and parse one candidate file into an {@link AgentDef}, or `undefined`
 * on any problem (unreadable file, empty body, name empty after
 * normalization).
 *
 * @param file - The discovered file to load.
 * @param validToolNames - Known tool names; a `tools:` entry outside this set
 *   is dropped with a warning. `undefined` skips validation entirely.
 * @param warnings - Collector for non-fatal problems.
 */
async function loadCandidate(
  file: string,
  validToolNames: readonly string[] | undefined,
  warnings: string[],
): Promise<AgentDef | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    warnings.push(
      `${file}: could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
  const { frontmatter, body } = parseAgentFrontmatter(raw);
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    warnings.push(`${file}: agent has an empty body (skipped)`);
    return undefined;
  }
  const defaultName = basename(file, ".md");
  const rawName = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : defaultName;
  const name = normalizeName(rawName);
  if (name.length === 0) {
    warnings.push(`${file}: agent name is empty after normalization (skipped)`);
    return undefined;
  }
  const description = frontmatter.description ?? "";

  let tools: string[] | undefined;
  if (frontmatter.tools !== undefined) {
    const requested = parseToolsList(frontmatter.tools);
    if (validToolNames === undefined) {
      tools = requested;
    } else {
      const known = new Set(validToolNames);
      const accepted = requested.filter((toolName) => known.has(toolName));
      const dropped = requested.filter((toolName) => !known.has(toolName));
      for (const bad of dropped) {
        warnings.push(`${file}: unknown tool "${bad}" in "tools:" list (dropped)`);
      }
      tools = accepted;
    }
  }

  const model = frontmatter.model && frontmatter.model.length > 0 ? frontmatter.model : undefined;

  let maxTurns: number | undefined;
  if (frontmatter.maxTurns !== undefined) {
    const parsed = Number(frontmatter.maxTurns);
    if (Number.isInteger(parsed) && parsed > 0) {
      maxTurns = parsed;
    } else {
      warnings.push(`${file}: "maxTurns" must be a positive integer (dropped)`);
    }
  }

  return {
    name,
    description,
    systemPrompt: body.trim(),
    ...(tools === undefined ? {} : { tools }),
    ...(model === undefined ? {} : { model }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    source: file,
  };
}

/**
 * Discover and load every markdown agent under the given roots.
 *
 * Roots are scanned in order and later roots win name collisions — pass the
 * user root first and the project root second so a project agent can
 * override a user agent of the same name. A collision is reported as a
 * warning naming both the discarded and the winning file. A root directory
 * that does not exist is silently skipped.
 *
 * @param roots - Agent-root directories, lowest priority first.
 * @param warnings - Collector for non-fatal problems (missing/empty files,
 *   unknown tool names, collisions).
 * @param validToolNames - Known tool names for validating a `tools:` list
 *   (e.g. `BUILT_IN_TOOL_NAMES` from `./runtime.ts`, plus any extension tool
 *   names). Omit to accept every requested name uncritically.
 */
export async function loadAgentDefs(
  roots: readonly string[],
  warnings: string[],
  validToolNames?: readonly string[],
): Promise<AgentDef[]> {
  const byName = new Map<string, AgentDef>();
  for (const root of roots) {
    const files = await discoverCandidates(root);
    for (const file of files) {
      const def = await loadCandidate(file, validToolNames, warnings);
      if (!def) continue;
      const existing = byName.get(def.name);
      if (existing) {
        warnings.push(`agent "${def.name}" in ${def.source} overrides ${existing.source}`);
      }
      byName.set(def.name, def);
    }
  }
  return [...byName.values()];
}
