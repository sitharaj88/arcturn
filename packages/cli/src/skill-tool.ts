/**
 * `skill`: a model-invoked tool onto the same markdown skill library
 * `skills.ts` exposes to the user as slash commands.
 *
 * `skills.ts` is the *user*-facing path into a skill: someone types `/review`
 * and the matching file's template is expanded and submitted as a prompt. As
 * skill libraries grow, a user cannot always remember every command name, and
 * the model itself may recognise mid-task that a skill applies — the
 * "progressive disclosure" pattern where a compact index of names and
 * one-line descriptions rides in a single tool's description, and the model
 * calls the tool by name only when a task actually matches one.
 *
 * This module adds exactly that: {@link createSkillTool} builds a `skill`
 * tool whose description is the index, and whose `execute` returns one
 * skill's fully-substituted body — reusing {@link Skill.buildPrompt} (the
 * same expansion `skillCommand` in `runtime.ts` drives for `/name`) rather
 * than reimplementing frontmatter stripping or `$ARGUMENTS`/`$1`/`$CWD`
 * substitution here. Nothing in `skills.ts` is duplicated: only discovery
 * (`loadSkills`) and the `Skill` type are reused, both already exported.
 *
 * Design choices worth calling out:
 *
 * - **Index freshness is lazy, not eager.** `definition` is a getter, so the
 *   description string (and therefore what the model sees the next time it
 *   reads the tool list) is rebuilt from `options.registry()` on every
 *   access rather than frozen at `createSkillTool` time. `registry` is
 *   typically a closure over the same `Skill[]` `buildRuntime` already holds
 *   after `loadSkills` — see the integration recipe for exactly where. This
 *   costs a small string rebuild whenever the definition is read (once per
 *   turn, at most), which is worth it: skills do not currently reload after
 *   startup in this codebase, but a future watcher-based reload must not
 *   require rebuilding this tool to pick it up.
 * - **Unlike `/name`, this never touches the live agent.** A slash command
 *   (`skillCommand` in `runtime.ts`) submits the expanded prompt as a new
 *   turn or steers the running one; this tool just *returns* the expanded
 *   text as its result, letting the calling model decide what to do with it
 *   (usually: follow it as instructions for the rest of the current turn).
 *   That is the standard "loaded skill becomes context" shape, not a command
 *   dispatch.
 */

import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import type { Skill } from "./skills.js";

/** Build a successful text-only tool result. */
function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/** Build an error tool result (an expected failure, not a thrown exception). */
function errorResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], isError: true, details };
}

/** Standard result returned when a tool observes `ctx.signal` has aborted. */
function abortedResult(): ToolResult {
  return errorResult("Aborted: the operation was cancelled before it completed.");
}

/** Default cap on a returned skill body before it is truncated. */
export const DEFAULT_SKILL_TOOL_MAX_BODY_CHARS = 8_000;

/** How many near-miss names to suggest when an unknown skill is requested. */
const MAX_SUGGESTIONS = 3;

/** Options for {@link createSkillTool}. */
export interface CreateSkillToolOptions {
  /**
   * Returns the current discovered-skill collection (the array
   * `loadSkills` from `./skills.js` resolves to). Called fresh every time
   * the tool's `definition` or `execute` runs, so a caller
   * that reloads skills after startup is picked up automatically; a caller
   * that loaded skills once at startup can just close over that array
   * (`() => skills`).
   */
  registry: () => readonly Skill[];
  /**
   * Character cap on a returned skill body. Longer bodies are truncated with
   * a trailing note rather than rejected outright, so the model still gets a
   * usable (if partial) result. Defaults to
   * {@link DEFAULT_SKILL_TOOL_MAX_BODY_CHARS}.
   */
  maxBodyChars?: number;
  /**
   * Classifies a skill's origin as user-authored (trusted) or not. An
   * untrusted skill — typically one from `<cwd>/.arcturn/skills`, which a
   * cloned repository controls — is still listed by NAME and remains callable,
   * but its `description` text is never embedded in the model-facing index:
   * with no user action at all that text would otherwise ride in every
   * request, a direct prompt-injection channel. Defaults to trusting
   * everything, so embedders that only serve user-authored skills need not
   * pass it; the CLI passes a project-root check.
   */
  isTrusted?: (skill: Skill) => boolean;
}

/** Max chars of a single skill's description that reach the index line. */
export const INDEX_LINE_MAX_CHARS = 160;
/** Max number of skills listed in the index before it is capped. */
const INDEX_MAX_ENTRIES = 200;
/** Hard ceiling on the whole rendered index, independent of entry count. */
const INDEX_MAX_TOTAL_CHARS = 24_000;

/**
 * Reduce an untrusted description to a single safe index line.
 *
 * A skill's `description` is untrusted markdown from `~/.arcturn/skills` or —
 * critically — `<cwd>/.arcturn/skills`, which a cloned repository controls.
 * The index is embedded verbatim in the `skill` tool's description and sent on
 * every request, so an unbounded or multi-line description is both a
 * prompt-injection surface (no user action needed) and a cache/cost hazard.
 * We take only the first line, strip control characters, and truncate — the
 * same discipline `deferred-tools.ts` applies to its own index lines.
 *
 * Exported because RFC 0005 §1.3's `listCommands` puts the same strings on a
 * different wire: a skill's description now reaches a remote client's `/` menu,
 * where it is rendered as UI rather than embedded in a prompt. The threat is
 * not identical — a menu entry needs a person to click it, where the model
 * index rides on every request with no user action — but the *string* is the
 * same untrusted markdown from the same attacker-controlled file, and there is
 * no good reason for two sanitizers to exist and drift. See
 * `serve-commands.ts` for the one difference in treatment, and why.
 *
 * `maxChars` defaults to {@link INDEX_LINE_MAX_CHARS} — the skill index's own
 * budget — but is a parameter rather than a second copy of this function: a
 * parked run's `diagnosis` (`serve-workflows.ts`) is read once, at a park, not
 * embedded on every request the way the skill index is, so it earns a wider
 * cap while going through the exact same first-line/control-char/truncate
 * discipline.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing control chars to spaces is the point.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function sanitizeDescription(raw: string, maxChars: number = INDEX_LINE_MAX_CHARS): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const cleaned = firstLine.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

/**
 * Render the compact skill index embedded in the tool description: one line
 * per skill that has a non-empty `description`, `name — description`, sorted
 * by name for a stable, cache-friendly string.
 *
 * Every description is passed through {@link sanitizeDescription} first, and
 * the whole index is capped by entry count and total length, because a
 * project-root skill file is attacker-controlled in a cloned repo (see
 * that function's note). Skills with no description are omitted from the index
 * but remain callable by name — a skill meant to be found by the model needs a
 * `description` frontmatter line, exactly as it needs one for `/help`.
 *
 * @param skills - The current skill collection.
 */
function renderIndex(skills: readonly Skill[], isTrusted: (skill: Skill) => boolean): string {
  const described = skills
    .filter((skill) => skill.description.trim().length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (described.length === 0) {
    return "No skills currently have a description; nothing to index yet.";
  }
  const shown = described.slice(0, INDEX_MAX_ENTRIES);
  const lines: string[] = [];
  let total = 0;
  for (const skill of shown) {
    const line = isTrusted(skill)
      ? `${skill.name} — ${sanitizeDescription(skill.description)}`
      : `${skill.name} — (project-provided skill; description withheld, call by name to load it)`;
    if (total + line.length + 1 > INDEX_MAX_TOTAL_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  const omitted = described.length - lines.length;
  if (omitted > 0) {
    lines.push(`…and ${omitted} more skill(s); call one by name to load it.`);
  }
  return lines.join("\n");
}

/**
 * Levenshtein edit distance, used only to rank near-miss skill names for the
 * "unknown skill" error — small inputs (skill names), so the classic O(n*m)
 * DP table is plenty fast and needs no dependency.
 *
 * @param a - First string.
 * @param b - Second string.
 */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) table[i]![0] = i;
  for (let j = 0; j < cols; j++) table[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i]![j] = Math.min(
        table[i - 1]![j]! + 1,
        table[i]![j - 1]! + 1,
        table[i - 1]![j - 1]! + cost,
      );
    }
  }
  return table[rows - 1]![cols - 1]!;
}

/**
 * Nearest skill names to an unrecognised request, for the error message.
 * A substring match (either direction) always outranks a pure edit-distance
 * guess — `"revie"` should suggest `"review"` before anything unrelated that
 * merely happens to be a similar length — ties broken by edit distance, then
 * name, for a deterministic order.
 *
 * Exported because RFC 0005 §1.3's `/name` expansion refuses an unrecognised
 * command on the serve path and owes the same "did you mean" — the same
 * question against the same registry, so it gets the same answer rather than a
 * second ranking that drifts.
 *
 * Typed against `{ name }` rather than `Skill` only so that caller can rank a
 * built-in's name alongside a skill's; nothing else about it changes.
 *
 * @param name - The (normalized) name that was not found.
 * @param candidates - The current command collection to search.
 */
export function nearestMatches(
  name: string,
  candidates: readonly { readonly name: string }[],
): string[] {
  const scored = candidates.map((skill) => {
    const substring = skill.name.includes(name) || name.includes(skill.name);
    const distance = levenshtein(name, skill.name);
    return { name: skill.name, substring, distance };
  });
  scored.sort((a, b) => {
    if (a.substring !== b.substring) return a.substring ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.name.localeCompare(b.name);
  });
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.name);
}

/**
 * Build the `skill` tool: lets the model pull a markdown skill's expanded
 * body into context by name, the model-invoked counterpart to `/name`.
 *
 * @param options - The skill registry to read from, and an optional body
 *   size cap.
 */
export function createSkillTool(options: CreateSkillToolOptions): Tool {
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_SKILL_TOOL_MAX_BODY_CHARS;
  const isTrusted = options.isTrusted ?? (() => true);
  return {
    get definition() {
      const skills = options.registry();
      return {
        name: "skill",
        description:
          "Load a reusable skill from this project's skill library into context. Each skill is a " +
          "markdown playbook for a recurring task; call this when the current task matches one " +
          "below by name or description, then follow the returned instructions for the rest of " +
          "this turn. Pass `args` to fill in the skill's arguments the same way typing them after " +
          "`/name` would.\n\nAvailable skills:\n" +
          renderIndex(skills, isTrusted),
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The skill's name, as listed in this tool's description.",
            },
            args: {
              type: "string",
              description:
                "Argument text for the skill's $ARGUMENTS/$1../$9 substitutions, exactly as it " +
                "would be typed after `/name`. Optional; omitted means no arguments.",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
      };
    },
    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();
      const rawName = input.name;
      if (typeof rawName !== "string" || rawName.trim().length === 0) {
        return errorResult("`name` is required and must be a non-empty string.");
      }
      const name = rawName.trim();
      const args = typeof input.args === "string" ? input.args : "";

      const skills = options.registry();
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) {
        const suggestions = nearestMatches(name, skills);
        const hint =
          suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : skills.length === 0
              ? " No skills are currently loaded."
              : "";
        return errorResult(`Unknown skill "${name}".${hint}`);
      }

      const body = skill.buildPrompt(args, ctx.cwd);
      const truncated = body.length > maxBodyChars;
      const text = truncated
        ? `${body.slice(0, maxBodyChars)}\n…(truncated; skill body was ${body.length} chars, over the ${maxBodyChars}-char limit)`
        : body;
      return textResult(text, { skill: skill.name, chars: text.length });
    },
  };
}
