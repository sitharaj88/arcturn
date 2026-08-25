/**
 * Markdown skills: slash commands defined declaratively as `.md` files.
 *
 * Arcturn discovers skills in one or more "skills roots" (typically
 * `~/.arcturn/skills` and `<cwd>/.arcturn/skills`), so a user can add a slash command
 * by dropping a markdown file on disk — no JavaScript, no build step.
 *
 * Two file shapes are recognised in each root:
 *
 * 1. `<root>/<name>.md` — a single command. `<name>` (lowercased, with any
 *    character outside `[a-z0-9-]` stripped) is the default command name.
 * 2. `<root>/<name>/SKILL.md` — a skill folder. The folder may hold other
 *    assets alongside `SKILL.md` (ignored by the loader itself, but the body
 *    may reference them through the `$SKILL_DIR` substitution).
 *
 * Both shapes share an optional frontmatter block delimited by `---` lines
 * with plain `key: value` pairs — only `description` and `name` are
 * understood, and unknown or malformed lines are ignored rather than
 * rejected. Everything after the frontmatter (or the whole file, if there is
 * none) is the prompt template.
 *
 * The template supports a handful of substitutions, expanded by
 * {@link Skill.buildPrompt}:
 *
 * - `$ARGUMENTS` — the full argument string typed after the command.
 * - `$1`..`$9` — positional arguments, splitting `$ARGUMENTS` on whitespace
 *   while respecting double-quoted segments; a missing position becomes `""`.
 * - `$CWD` — the working directory passed to `buildPrompt`.
 * - `$SKILL_DIR` — the skill folder's absolute path (folder skills only).
 *
 * Loading is defensive throughout: a missing root is silently fine, a
 * malformed file (empty body, unreadable) is skipped with a warning pushed
 * onto the caller-supplied collector, and a later root's skill silently wins
 * a name collision (also reported as a warning) so project skills can
 * override user skills of the same name.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** A markdown-defined skill, ready to be registered as a slash command. */
export interface Skill {
  /** Command name, without the leading slash. */
  name: string;
  /** One-line help text; empty string when the file set none. */
  description: string;
  /** Absolute path of the file the skill was loaded from. */
  source: string;
  /**
   * Expand the prompt template for one invocation.
   *
   * @param args - Text typed after the command name, already trimmed.
   * @param cwd - Working directory to substitute for `$CWD`.
   * @returns The fully substituted prompt text.
   */
  buildPrompt(args: string, cwd: string): string;
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

/** Parsed frontmatter fields understood by skill files. */
interface Frontmatter {
  description?: string;
  name?: string;
}

/**
 * Split a markdown skill file into its optional frontmatter and body.
 *
 * Frontmatter is a leading block between two lines that are exactly `---`,
 * containing only simple `key: value` lines (no nesting, no lists, no
 * quoting) — anything more elaborate is silently skipped rather than parsed
 * wrong. Only `description` and `name` keys are recognised; other keys are
 * ignored.
 *
 * @param raw - Full file contents.
 */
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
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
  }
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter, body };
}

/**
 * Split an argument string into positional words.
 *
 * Whitespace-separated, except a double-quoted span (`"like this"`) counts
 * as one word with its quotes removed. An unterminated quote runs to the end
 * of the string.
 *
 * @param args - The full argument string.
 */
function splitArguments(args: string): string[] {
  const words: string[] = [];
  let i = 0;
  const n = args.length;
  while (i < n) {
    while (i < n && /\s/.test(args[i] as string)) i++;
    if (i >= n) break;
    if (args[i] === '"') {
      const close = args.indexOf('"', i + 1);
      if (close === -1) {
        words.push(args.slice(i + 1));
        i = n;
      } else {
        words.push(args.slice(i + 1, close));
        i = close + 1;
      }
    } else {
      const start = i;
      while (i < n && !/\s/.test(args[i] as string)) i++;
      words.push(args.slice(start, i));
    }
  }
  return words;
}

/** Every token {@link expandTemplate} understands, matched in one pass. */
const TEMPLATE_TOKEN = /\$(ARGUMENTS|CWD|SKILL_DIR|[1-9])/g;

/**
 * Expand `$ARGUMENTS`, `$1`..`$9`, `$CWD` and (optionally) `$SKILL_DIR` in a
 * prompt template.
 *
 * **One pass, deliberately.** Substituted text is never re-scanned: a
 * template's own tokens expand, and what they expand *to* is final. This used
 * to be four sequential `replaceAll`/`replace` calls, which meant argument
 * text was still on the table when the later tokens were substituted — so an
 * argument of `$SKILL_DIR/../../etc/passwd` came back with the skill folder's
 * real absolute path spliced in, handing the caller both a path outside the
 * workspace and the fact of where the skill library lives. That was survivable
 * while the only caller was a person typing into their own terminal; RFC 0005
 * §1.3 makes `args` remote-caller text on the serve path, and remote text that
 * can name substitution tokens is an injection channel.
 *
 * @param template - The raw template body.
 * @param args - Full argument string for `$ARGUMENTS` and positional splits.
 * @param cwd - Working directory for `$CWD`.
 * @param skillDir - Absolute skill folder path for `$SKILL_DIR`, when applicable.
 */
function expandTemplate(template: string, args: string, cwd: string, skillDir?: string): string {
  const positional = splitArguments(args);
  return template.replace(TEMPLATE_TOKEN, (match, token: string) => {
    if (token === "ARGUMENTS") return args;
    if (token === "CWD") return cwd;
    // A plain `<name>.md` has no folder, and has always left the token alone
    // rather than substituting an empty string for it.
    if (token === "SKILL_DIR") return skillDir ?? match;
    return positional[Number(token) - 1] ?? "";
  });
}

/** One file discovered on disk, before it is parsed into a {@link Skill}. */
interface Candidate {
  /** Absolute path of the `.md` file (either `<name>.md` or `<name>/SKILL.md`). */
  file: string;
  /** Name derived from the filename or folder name, before frontmatter override. */
  defaultName: string;
  /** Absolute folder path, for `$SKILL_DIR`; unset for a plain `<name>.md`. */
  skillDir?: string;
}

/**
 * List skill-file candidates directly under one root.
 *
 * A missing root yields no candidates. Non-markdown files and dotfiles are
 * ignored; a subdirectory contributes its `SKILL.md`, if present.
 *
 * @param root - Directory to scan.
 */
async function discoverCandidates(root: string): Promise<Candidate[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(root, entry);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const skillFile = join(full, "SKILL.md");
      try {
        await stat(skillFile);
      } catch {
        continue;
      }
      candidates.push({ file: skillFile, defaultName: entry, skillDir: full });
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    candidates.push({ file: full, defaultName: basename(entry, ".md") });
  }
  return candidates;
}

/**
 * Load and parse one candidate file into a {@link Skill}, or `undefined` on
 * any problem (unreadable file, empty body).
 *
 * @param candidate - The discovered file to load.
 * @param warnings - Collector for non-fatal problems.
 */
async function loadCandidate(candidate: Candidate, warnings: string[]): Promise<Skill | undefined> {
  let raw: string;
  try {
    raw = await readFile(candidate.file, "utf8");
  } catch (error) {
    warnings.push(
      `${candidate.file}: could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    warnings.push(`${candidate.file}: skill has an empty body (skipped)`);
    return undefined;
  }
  const rawName =
    frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : candidate.defaultName;
  const name = normalizeName(rawName);
  if (name.length === 0) {
    warnings.push(`${candidate.file}: skill name is empty after normalization (skipped)`);
    return undefined;
  }
  const description = frontmatter.description ?? "";
  const skillDir = candidate.skillDir;
  return {
    name,
    description,
    source: candidate.file,
    buildPrompt(args: string, cwd: string): string {
      return expandTemplate(body, args, cwd, skillDir);
    },
  };
}

/**
 * Discover and load every markdown skill under the given roots.
 *
 * Roots are scanned in order and later roots win name collisions — pass the
 * user root first and the project root second so a project skill can
 * override a user skill of the same name. A collision is reported as a
 * warning naming both the discarded and the winning file. A root directory
 * that does not exist is silently skipped.
 *
 * @param roots - Skill-root directories, lowest priority first.
 * @param warnings - Collector for non-fatal problems (missing/empty files, collisions).
 */
export async function loadSkills(roots: readonly string[], warnings: string[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    const candidates = await discoverCandidates(root);
    for (const candidate of candidates) {
      const skill = await loadCandidate(candidate, warnings);
      if (!skill) continue;
      const existing = byName.get(skill.name);
      if (existing) {
        warnings.push(`skill "${skill.name}" in ${skill.source} overrides ${existing.source}`);
      }
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
