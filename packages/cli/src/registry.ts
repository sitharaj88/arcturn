/**
 * The package registry: install, list, remove and update shareable bundles of
 * skills, extensions, themes and MCP server configs.
 *
 * A **package** is a directory — usually a git repository — that contains any
 * mix of:
 *
 * - `skills/` — markdown skills (see `skills.ts`); a package with no manifest
 *   and no `skills/` directory but plain `.md` files at its root is *also*
 *   recognised as skills, so "the simplest possible package is just a folder
 *   of markdown".
 * - `agents/` — markdown agent roles (see `agents.ts`): one `.md` file per
 *   role, whose `tools:` line decides the lane the workflow engine runs it on
 *   (`roleDispatch` in `workflow.ts` — read, exec or write).
 * - `workflows/` — numbered-markdown pipelines (see `workflow.ts`): one `.md`
 *   file per workflow, optionally capped by a `budgetUsd:` frontmatter key.
 *   A package carrying both `agents/` and `workflows/` is an **org kit**.
 * - `extensions/` — JavaScript/TypeScript extension modules (see
 *   `extensions.ts`). Unlike skills, loading one of these means **executing
 *   arbitrary code with the user's full permissions**.
 * - `themes/` — custom TUI theme JSON files (see `themes.ts`).
 * - `mcp.json` — an `{ "servers": { ... } } ` document merged into the user's
 *   own MCP config.
 * - `arcturn.json` — an optional manifest naming the package and, when the
 *   convention-based directories aren't the right shape, explicitly listing
 *   what it provides (`{ "provides": { "skills": [...], "agents": [...],
 *   "workflows": [...], "extensions": [...], "themes": [...] } }`). Absent a
 *   manifest, everything is detected by convention.
 *
 * `arcturn add <source>` / `/add <source>` resolves a source (a git URL, a
 * `owner/repo[/subdir][@ref]` GitHub shorthand, or a local path), clones or
 * copies it into `~/.arcturn/packages/<name>/`, records the exact resolved commit
 * for reproducibility, and links (or, when a symlink can't be made, copies)
 * each piece it finds into the root Arcturn already scans — `~/.arcturn/skills`,
 * `~/.arcturn/agents`, `~/.arcturn/workflows`, `~/.arcturn/extensions`,
 * `~/.arcturn/themes`, `~/.arcturn/mcp.json` — so it is immediately available
 * with no further setup.
 *
 * `arcturn inspect <source>` is the install's counterpart: it stages a source
 * through the very same {@link resolveSource} and {@link stageSource} an
 * install uses, links **nothing**, and reports what an install *would* add —
 * see {@link inspectPackage}.
 *
 * SECURITY MODEL
 * ---------------
 * Installing a package that provides extensions means running someone else's
 * JavaScript with the user's full permissions the moment Arcturn next loads
 * `~/.arcturn/extensions`; installing one that provides only skills, agents or
 * workflows carries no code-execution risk (each is markdown — a prompt and
 * capability surface, not an execution one; an agent role can only ever hold
 * tools the session already grants, and a workflow only ever spends money the
 * user watches). This module treats the two very differently:
 *
 * - {@link installPackage} (and {@link updatePackage}, since an update can
 *   introduce or change extension code) never links a single extension file
 *   without an explicit, per-install "yes" from {@link InstallOptions.confirmExecutableCode}
 *   that names the files involved. That callback **defaults to a hard "no"**
 *   — an install that doesn't wire up a real confirmation prompt (for
 *   example, a caller that forgot to pass one) fails closed rather than
 *   silently running code.
 * - Declining the prompt installs **nothing at all**, not even the package's
 *   skills: the whole install is staged in a scratch directory first and only
 *   materialised into `~/.arcturn/packages/` after any required confirmation is
 *   granted.
 * - `skillsOnly: true` (`--skills-only`) skips extension detection entirely
 *   from the linking step — the extension files still land on disk under
 *   `~/.arcturn/packages/<name>/`, inert, but are never copied or symlinked into
 *   `~/.arcturn/extensions`, so jiti (which only scans that directory) never
 *   loads them and no confirmation is needed.
 * - Agents and workflows are **never** put behind that gate — doing so would
 *   train the user to click through the one prompt that matters — but they are
 *   never installed silently either: {@link formatInstallSummary} names every
 *   role that landed together with the lane {@link roleDispatch} derives for it
 *   from its own `tools:` line, and every workflow with its `budgetUsd:` cap.
 * - Package names are validated against `[a-z0-9._-]` and checked to resolve
 *   *inside* `~/.arcturn/packages` before any filesystem write, closing off path
 *   traversal (`../../evil`) both by charset and by an absolute-path
 *   containment check. The same containment check applies to a GitHub
 *   shorthand's `/subdir` component against the cloned repository.
 * - Every `git` invocation is spawned with an argument array (never a shell
 *   string) via the same {@link GitExecFn} seam `git.ts` uses, and a
 *   caller-supplied ref is rejected outright if it starts with `-` (defends
 *   against flag injection into `git checkout <ref>`).
 * - The exact resolved commit is recorded in `.arcturn-install.json` inside the
 *   package directory, so an install is auditable and reproducible.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { loadAgentDefs } from "./agents.js";
import type { CommandContext, CommandUi, SlashCommand } from "./commands.js";
import { oneLine } from "./format.js";
import { loadSkills } from "./skills.js";
import type { Workflow, WorkflowDispatch } from "./workflow.js";
import { isWorkflowParseError, parseWorkflow, roleDispatch } from "./workflow.js";

const execFileAsync = promisify(execFile);

/* Errors ---------------------------------------------------------------- */

/** Any problem the registry raises: a malformed source, a git failure, a rejected name. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* Filesystem roots -------------------------------------------------------- */

/**
 * Every directory the registry reads from or writes to. Mirrors the roots
 * `runtime.ts`/`workflow.ts`/`paths.ts` already scan (`~/.arcturn/skills`,
 * `~/.arcturn/agents`, `~/.arcturn/workflows`, `~/.arcturn/extensions`,
 * `~/.arcturn/themes`, `~/.arcturn/mcp.json`) plus `~/.arcturn/packages`, where
 * installed packages themselves live.
 */
export interface RegistryPaths {
  /** `~/.arcturn/packages` — one subdirectory per installed package. */
  readonly packagesRoot: string;
  /** `~/.arcturn/skills` — the user-scope root `skills.ts` scans. */
  readonly skillsRoot: string;
  /** `~/.arcturn/agents` — the user-scope root `loadAgentDefs` scans (runtime.ts). */
  readonly agentsRoot: string;
  /** `~/.arcturn/workflows` — the user-scope root `workflowRoots` scans (workflow.ts). */
  readonly workflowsRoot: string;
  /** `~/.arcturn/extensions` — the user-scope root `extensions.ts` scans. */
  readonly extensionsRoot: string;
  /** `~/.arcturn/themes` — the user-scope root `themes.ts` scans. */
  readonly themesRoot: string;
  /** `~/.arcturn/mcp.json` — merged with each package's `mcp.json`, when present. */
  readonly mcpConfigPath: string;
}

/**
 * Derive {@link RegistryPaths} from a Arcturn home directory (`paths.home` from
 * `resolveArcturnPaths()`, or any equivalent `~/.arcturn`-shaped root).
 *
 * @param home - Absolute path to the Arcturn user directory.
 */
export function registryPathsFromHome(home: string): RegistryPaths {
  const root = resolve(home);
  return {
    packagesRoot: join(root, "packages"),
    skillsRoot: join(root, "skills"),
    agentsRoot: join(root, "agents"),
    workflowsRoot: join(root, "workflows"),
    extensionsRoot: join(root, "extensions"),
    themesRoot: join(root, "themes"),
    mcpConfigPath: join(root, "mcp.json"),
  };
}

/* Package name validation -------------------------------------------------- */

const PACKAGE_NAME_PATTERN = /^[a-z0-9._-]+$/;

/**
 * Whether a name is safe to use as a single path segment under
 * `~/.arcturn/packages`: lowercase letters, digits, `.`, `_` and `-` only, and
 * no leading or trailing dot.
 *
 * The dot rule is what makes {@link resolvePackageDir}'s containment check hold
 * on Windows, and it is not a style preference. `...` passes the charset and is
 * neither `.` nor `..`, so it used to be accepted — and Win32 discards a path
 * component's trailing dots before the filesystem ever sees the name. So
 * `<packagesRoot>\...` *is* `<packagesRoot>`, while the containment check
 * compares the lexical spelling, where the dots are still there and the path
 * looks like an ordinary child. `arcturn ext install <src> --name "..."` would
 * therefore unpack a package over the root of the package store, and
 * `arcturn ext remove "..."` would `rm -rf` the store itself, every other
 * installed package with it. `foo.` is the same defect one dot in: it names
 * `foo` on Windows and `foo.` everywhere else, so two spellings would install
 * over each other on one platform and not the other.
 *
 * Nothing legitimate is lost: {@link slugifyName} strips leading and trailing
 * dots from every derived name already, so only an explicit `--name` could ever
 * carry one. Subsumes the old `.`/`..` special cases.
 *
 * @param name - Candidate package name.
 */
export function isValidPackageName(name: string): boolean {
  return PACKAGE_NAME_PATTERN.test(name) && !name.startsWith(".") && !name.endsWith(".");
}

/**
 * Resolve a package name to its directory under `packagesRoot`, rejecting
 * anything that fails {@link isValidPackageName} or whose resolved path
 * would escape `packagesRoot` — the second check is defense in depth on top
 * of the charset check, not a substitute for it.
 *
 * @param packagesRoot - `~/.arcturn/packages`.
 * @param name - Candidate package name.
 */
export function resolvePackageDir(packagesRoot: string, name: string): string {
  if (!isValidPackageName(name)) {
    throw new RegistryError(
      `invalid package name "${name}": use only lowercase letters, digits, ".", "_" and "-"`,
    );
  }
  const root = resolve(packagesRoot);
  const dir = resolve(root, name);
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new RegistryError(`package name "${name}" resolves outside the packages directory`);
  }
  return dir;
}

function assertInside(root: string, candidate: string, label: string): void {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  if (candidateResolved !== rootResolved && !candidateResolved.startsWith(rootResolved + sep)) {
    throw new RegistryError(`${label} escapes its containing directory`);
  }
}

/* Source resolution --------------------------------------------------------- */

/** How a source string was recognised. */
export type SourceKind = "git-url" | "github-shorthand" | "local-path";

/** A parsed, not-yet-fetched package source. */
export interface ResolvedSource {
  /** How the source was recognised. */
  readonly kind: SourceKind;
  /** What to pass to `git clone` (`git-url`/`github-shorthand`) or copy from (`local-path`). */
  readonly location: string;
  /** Pinned tag, branch or commit, when the source named one with a trailing `@ref`. */
  readonly ref?: string;
  /** Subdirectory within the repository to treat as the package root (GitHub shorthand only). */
  readonly subdir?: string;
  /** Package name derived from the source, before an explicit `--name` override. */
  readonly defaultName: string;
  /** The original text, unmodified. */
  readonly raw: string;
}

/** Options for {@link resolveSource}. */
export interface ResolveSourceOptions {
  /** Base directory relative local paths (`./foo`, `../foo`) resolve against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory `~/foo` local paths expand against. Defaults to `os.homedir()`. */
  homeDir?: string;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^[\w.-]+@[\w.-]+:[\w./-]+$/;
const GITHUB_SHORTHAND =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/([a-zA-Z0-9._-]+)((?:\/[a-zA-Z0-9._-]+)*)$/;

/**
 * A drive-qualified Windows path: a letter, a colon, and exactly one separator.
 *
 * The one-separator rule is what keeps `c://host/p` a URL — a scheme is a
 * letter run followed by `://`, and a drive letter is a *single* letter
 * followed by one separator, so the two shapes never overlap.
 */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/](?![\\/])/;

/**
 * Whether a source string names a directory on this machine rather than a
 * repository to clone.
 *
 * Every shape is recognised in both separators, on every platform. The Windows
 * spellings — `.\pkg`, `..\pkg`, `C:\pkgs\pkg`, `\\server\share\pkg`,
 * `~\pkgs\pkg` — matched none of the POSIX prefixes below, so they fell
 * through to the git-URL and `owner/repo` shapes, matched neither of those
 * either, and came back as `could not parse package source`: on Windows,
 * `arcturn ext install` could not be handed a local package by the spelling the
 * shell itself completes.
 *
 * Recognised everywhere rather than behind `process.platform` because a source
 * string is text a user typed, not a property of the machine parsing it, and a
 * platform branch here would make the same argument mean different things in
 * the same documentation. The cost on POSIX is that `C:\pkgs\pkg` now fails
 * later ("no such directory") instead of immediately ("could not parse") —
 * which is the more accurate of the two messages anyway, since a directory of
 * that name is legal there.
 */
function isLocalPathSpec(text: string): boolean {
  return (
    text === "." ||
    text === ".." ||
    text.startsWith("/") ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("~") ||
    // `\pkg` (rooted on the current drive) and `\\server\share\pkg` (UNC).
    text.startsWith("\\") ||
    text.startsWith(".\\") ||
    text.startsWith("..\\") ||
    WINDOWS_DRIVE_PATH.test(text)
  );
}

/**
 * Split a trailing `@ref` pin off the final path segment of a source string.
 *
 * Only the segment after the last `/` is searched, so an scp-style
 * `git@host:path` user-info prefix (which sits before any `/`) is never
 * mistaken for a ref.
 *
 * @param text - Source text with any local-path prefix already ruled out.
 */
function splitRef(text: string): { withoutRef: string; ref: string | undefined } {
  const lastSlash = text.lastIndexOf("/");
  const tailStart = lastSlash === -1 ? 0 : lastSlash + 1;
  const tail = text.slice(tailStart);
  const at = tail.indexOf("@");
  if (at <= 0) return { withoutRef: text, ref: undefined };
  const ref = text.slice(tailStart + at + 1);
  if (ref === "") return { withoutRef: text, ref: undefined };
  return { withoutRef: text.slice(0, tailStart + at), ref };
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function gitSource(location: string, ref: string | undefined, raw: string): ResolvedSource {
  const lastSegment = location.replace(/\/+$/, "").split(/[/:]/).pop() ?? location;
  const defaultName = slugifyName(lastSegment.replace(/\.git$/i, ""));
  return { kind: "git-url", location, ref, subdir: undefined, defaultName, raw };
}

function githubShorthandSource(
  match: RegExpExecArray,
  ref: string | undefined,
  raw: string,
): ResolvedSource {
  const owner = match[1] as string;
  const repo = match[2] as string;
  const subdirRaw = match[3] as string;
  const subdir = subdirRaw === "" ? undefined : subdirRaw.slice(1);
  if (subdir !== undefined) {
    for (const segment of subdir.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        throw new RegistryError(`invalid subdirectory in source "${raw}"`);
      }
    }
  }
  const location = `https://github.com/${owner}/${repo}.git`;
  const leaf = subdir ? (subdir.split("/").pop() as string) : repo;
  return { kind: "github-shorthand", location, ref, subdir, defaultName: slugifyName(leaf), raw };
}

/** The last non-empty segment of a path, in either separator. */
function pathLeaf(location: string): string {
  const segments = location.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? location;
}

function localSource(text: string, options: ResolveSourceOptions, raw: string): ResolvedSource {
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const tilde = text === "~" ? "" : /^~[\\/]/.test(text) ? text.slice(2) : undefined;
  const expanded = tilde === undefined ? text : tilde === "" ? homeDir : join(homeDir, tilde);
  const location = resolve(cwd, expanded);
  // Split rather than `basename`, because the leaf of `C:\pkgs\my-pkg` is
  // `my-pkg` whoever is reading it — `path.basename` only knows that on
  // Windows, and on POSIX would name the package after the whole string.
  return {
    kind: "local-path",
    location,
    ref: undefined,
    subdir: undefined,
    defaultName: slugifyName(pathLeaf(location)),
    raw,
  };
}

/**
 * Resolve a source string into a {@link ResolvedSource}: a git URL, a GitHub
 * `owner/repo[/subdir][@ref]` shorthand, or a local path.
 *
 * Recognised shapes, checked in this order:
 *
 * 1. A local path: starts with `/`, `./`, `../`, `~`, or is exactly `.`/`..`.
 *    Never carries a `@ref` — pin a local checkout with a `file://` URL instead.
 * 2. A URL (any `scheme://`, including `file://`) or an scp-like
 *    `git@host:owner/repo.git` address, with an optional trailing `@ref`.
 * 3. A GitHub shorthand `owner/repo[/subdir...][@ref]`, resolved to
 *    `https://github.com/owner/repo.git`.
 *
 * Anything else — including a bare single segment, or a malformed shorthand
 * like `owner/` — throws a {@link RegistryError}.
 *
 * @param raw - The text the user typed.
 * @param options - Base directories for local-path resolution.
 */
export function resolveSource(raw: string, options: ResolveSourceOptions = {}): ResolvedSource {
  const trimmed = raw.trim();
  if (trimmed === "") throw new RegistryError("a package source is required");

  if (isLocalPathSpec(trimmed)) return localSource(trimmed, options, raw);

  const { withoutRef, ref } = splitRef(trimmed);
  if (ref?.startsWith("-")) {
    throw new RegistryError(`invalid ref "${ref}" in source "${raw}"`);
  }

  if (URL_SCHEME.test(withoutRef) || SCP_LIKE.test(withoutRef)) {
    return gitSource(withoutRef, ref, raw);
  }
  const shorthand = GITHUB_SHORTHAND.exec(withoutRef);
  if (shorthand) return githubShorthandSource(shorthand, ref, raw);

  throw new RegistryError(
    `could not parse package source "${raw}": expected a git URL, an "owner/repo" GitHub ` +
      "shorthand, or a local path",
  );
}

/* Manifest ------------------------------------------------------------------ */

const MANIFEST_FILE = "arcturn.json";

/** What a package's `arcturn.json` may declare, when present. */
export interface PackageManifestProvides {
  skills?: string[];
  /** Markdown agent roles. Each entry is a path to one `.md` file. */
  agents?: string[];
  /** Numbered-markdown pipelines. Each entry is a path to one `.md` file. */
  workflows?: string[];
  extensions?: string[];
  themes?: string[];
}

/** A package's optional `arcturn.json` manifest. Absent, detection falls back to convention. */
export interface PackageManifest {
  name?: string;
  description?: string;
  version?: string;
  provides?: PackageManifestProvides;
}

/**
 * Read and validate a package's `arcturn.json`, if present.
 *
 * A missing file is not a warning (most packages have none); a present but
 * malformed one is — it is reported and treated as absent, falling back to
 * convention-based detection, rather than failing the whole install.
 *
 * @param root - Package root to look in.
 * @param warnings - Collector for non-fatal problems.
 */
async function readManifest(
  root: string,
  warnings: string[],
): Promise<PackageManifest | undefined> {
  const file = join(root, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`${file}: invalid JSON (${errorMessage(error)}); ignoring manifest`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    warnings.push(`${file}: expected a JSON object; ignoring manifest`);
    return undefined;
  }
  const manifest: PackageManifest = {};
  if (typeof parsed.name === "string" && parsed.name.trim() !== "") manifest.name = parsed.name;
  if (typeof parsed.description === "string") manifest.description = parsed.description;
  if (typeof parsed.version === "string") manifest.version = parsed.version;
  if (isRecord(parsed.provides)) {
    const provides: PackageManifestProvides = {};
    for (const key of ["skills", "agents", "workflows", "extensions", "themes"] as const) {
      const value = parsed.provides[key];
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        provides[key] = value as string[];
      } else if (value !== undefined) {
        warnings.push(`${file}: "provides.${key}" must be an array of strings; ignored`);
      }
    }
    if (Object.keys(provides).length > 0) manifest.provides = provides;
  }
  return manifest;
}

function pickManifestSummary(manifest: PackageManifest): InstallRecord["manifest"] {
  const summary: NonNullable<InstallRecord["manifest"]> = {};
  if (manifest.name !== undefined) summary.name = manifest.name;
  if (manifest.description !== undefined) summary.description = manifest.description;
  if (manifest.version !== undefined) summary.version = manifest.version;
  return summary;
}

/* Content detection ----------------------------------------------------------- */

/** What was found in a package root, as paths relative to it. */
interface DetectedContents {
  skills: string[];
  agents: string[];
  workflows: string[];
  extensions: string[];
  themes: string[];
  mcp?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

async function expandProvided(
  root: string,
  rel: string,
  warnings: string[],
  kind: string,
): Promise<string[]> {
  const full = join(root, rel);
  try {
    assertInside(root, full, `manifest "provides.${kind}" entry "${rel}"`);
  } catch (error) {
    warnings.push(errorMessage(error));
    return [];
  }
  if (!(await pathExists(full))) {
    warnings.push(`manifest "provides.${kind}" entry "${rel}" was not found`);
    return [];
  }
  return [rel];
}

/**
 * Directories whose meaning is fixed by convention, so a flat-markdown package
 * never re-reads one of them as a root-level skill. `skills` is absent because
 * the fallback that consults this list only runs when there is no `skills/`.
 */
const CONVENTION_DIRS: readonly string[] = ["agents", "workflows", "extensions", "themes"];

/**
 * List the `.md` files directly inside one convention directory.
 *
 * @param root - Package root.
 * @param dir - Directory name (`agents` or `workflows`).
 */
async function detectMarkdownDir(root: string, dir: string): Promise<string[]> {
  const full = join(root, dir);
  if (!(await isDirectory(full))) return [];
  const out: string[] = [];
  for (const entry of await listDir(full)) {
    if (entry.endsWith(".md") && (await isFile(join(full, entry)))) out.push(join(dir, entry));
  }
  return out;
}

/** Well-known repository files that are never mistaken for a root-level skill. */
const NON_SKILL_MARKDOWN = new Set([
  "readme.md",
  "changelog.md",
  "license.md",
  "contributing.md",
  "code_of_conduct.md",
  "security.md",
]);

/**
 * Detect what a package provides: an explicit manifest wins field by field,
 * falling back to convention (`skills/`, `agents/`, `workflows/`,
 * `extensions/`, `themes/` directories, a root-level `mcp.json`) for anything
 * the manifest didn't declare. A package with no manifest and no `skills/`
 * directory but plain markdown files at its root is treated as a flat set of
 * skills.
 *
 * `agents/` and `workflows/` are `.md`-only, the way `themes/` is `.json`-only
 * and unlike `skills/`, which also admits a `<name>/SKILL.md` folder: neither
 * loader has a folder form (an agent has no `$SKILL_DIR`-style assets and a
 * workflow has no sibling files), so a directory in one of those roots is
 * something the real loader would skip, and linking it would put a file into a
 * scanned root that nothing ever reads.
 *
 * @param root - Package root (after any subdir extraction).
 * @param manifest - The package's parsed manifest, if any.
 * @param warnings - Collector for non-fatal problems.
 */
async function detectContents(
  root: string,
  manifest: PackageManifest | undefined,
  warnings: string[],
): Promise<DetectedContents> {
  const skills: string[] = [];
  if (manifest?.provides?.skills) {
    for (const rel of manifest.provides.skills) {
      skills.push(...(await expandProvided(root, rel, warnings, "skills")));
    }
  } else {
    const skillsDir = join(root, "skills");
    if (await isDirectory(skillsDir)) {
      for (const entry of await listDir(skillsDir)) skills.push(join("skills", entry));
    } else {
      for (const entry of await listDir(root)) {
        if (CONVENTION_DIRS.includes(entry) || entry === MANIFEST_FILE || entry === "mcp.json") {
          continue;
        }
        if (entry.endsWith(".md")) {
          if (!NON_SKILL_MARKDOWN.has(entry.toLowerCase())) skills.push(entry);
          continue;
        }
        if (await isFile(join(root, entry, "SKILL.md"))) skills.push(entry);
      }
    }
  }

  const agents: string[] = [];
  if (manifest?.provides?.agents) {
    for (const rel of manifest.provides.agents) {
      agents.push(...(await expandProvided(root, rel, warnings, "agents")));
    }
  } else {
    agents.push(...(await detectMarkdownDir(root, "agents")));
  }

  const workflows: string[] = [];
  if (manifest?.provides?.workflows) {
    for (const rel of manifest.provides.workflows) {
      workflows.push(...(await expandProvided(root, rel, warnings, "workflows")));
    }
  } else {
    workflows.push(...(await detectMarkdownDir(root, "workflows")));
  }

  const extensions: string[] = [];
  if (manifest?.provides?.extensions) {
    for (const rel of manifest.provides.extensions) {
      extensions.push(...(await expandProvided(root, rel, warnings, "extensions")));
    }
  } else {
    const extDir = join(root, "extensions");
    if (await isDirectory(extDir)) {
      for (const entry of await listDir(extDir)) extensions.push(join("extensions", entry));
    }
  }

  const themes: string[] = [];
  if (manifest?.provides?.themes) {
    for (const rel of manifest.provides.themes) {
      themes.push(...(await expandProvided(root, rel, warnings, "themes")));
    }
  } else {
    const themesDir = join(root, "themes");
    if (await isDirectory(themesDir)) {
      for (const entry of await listDir(themesDir)) {
        if (entry.endsWith(".json")) themes.push(join("themes", entry));
      }
    }
  }

  const mcp = (await isFile(join(root, "mcp.json"))) ? "mcp.json" : undefined;

  return { skills, agents, workflows, extensions, themes, mcp };
}

/* Disclosure ------------------------------------------------------------------- */

/**
 * One agent role, as the real loaders read it.
 *
 * {@link PackageDisclosure} is the shape `arcturn inspect` prints and `--json`
 * emits, and the same shape {@link formatInstallSummary} renders for what an
 * install just linked. That is the point: what a person reads before installing
 * and what they are told after installing come from one code path, so the two
 * can never describe different packages.
 *
 * Every field here is *derived*, never copied out of the package's own prose: a
 * role's lane comes from {@link roleDispatch} reading its `tools:` line, a
 * workflow's stage count and budget from `parseWorkflow`, a skill's description
 * from the loader the runtime itself uses.
 */
export interface AgentDisclosure {
  /** Role name, normalized by `loadAgentDefs` exactly as the runtime normalizes it. */
  name: string;
  /** First line of its `description:`; `""` when it set none. */
  description: string;
  /** The lane {@link roleDispatch} derives from `tools:` — what it can touch. */
  lane: WorkflowDispatch;
  /** Declared tools. Absent means the file declared none, which a workflow step refuses to dispatch. */
  tools?: string[];
  /** Path inside the package. */
  path: string;
}

/** One workflow, as `parseWorkflow` reads it. */
export interface WorkflowDisclosure {
  /** Workflow name, normalized by the parser. */
  name: string;
  /** First line of its `description:`; `""` when it set none. */
  description: string;
  /** Number of stages. */
  stages: number;
  /** Number of steps across every stage — a parallel stage contributes more than one. */
  steps: number;
  /** The `budgetUsd:` ceiling for a whole run, when the file set one. */
  budgetUsd?: number;
  /** Every `@role` the pipeline names, deduplicated, in first-use order. */
  roles: string[];
  /** Path inside the package. */
  path: string;
  /** Present when the file did not parse; the other fields are then empty, not guesses. */
  error?: string;
}

/** One skill, as `loadSkills` reads it. */
export interface SkillDisclosure {
  /** Command name, without the leading slash. */
  name: string;
  /** First line of its `description:`; `""` when it set none. */
  description: string;
  /** Path inside the package. */
  path: string;
}

/** One MCP server a package would merge into `~/.arcturn/mcp.json`. */
export interface McpServerDisclosure {
  /** Server name — the key it would take in the merged config. */
  name: string;
  /** `"stdio"`, `"http"`, or `"unknown"` when the entry names no recognised transport. */
  transport: string;
  /** The command (stdio) or URL (http) it would reach — the thing worth reading. */
  target: string;
}

/** Everything an install of one source would add, with nothing linked. */
export interface PackageDisclosure {
  /** The name the package would be installed under. */
  name: string;
  /** The source string exactly as it was given. */
  source: string;
  /** How that source was recognised. */
  sourceKind: SourceKind;
  /** Resolved clone URL or local path. */
  location: string;
  /** The exact commit staged, when the source is (or lives in) a git repository. */
  commit?: string;
  /** The package's own `arcturn.json` name/description/version, when it has one. */
  manifest?: { name?: string; description?: string; version?: string };
  /** Agent roles, with the lane each would run on. */
  agents: AgentDisclosure[];
  /** Workflows, with stage counts and budgets. */
  workflows: WorkflowDisclosure[];
  /** Skills, with their first description line. */
  skills: SkillDisclosure[];
  /** MCP servers that would be merged into the user's config. */
  mcpServers: McpServerDisclosure[];
  /** Executable extension files. Non-empty means installing this runs someone else's code. */
  extensions: string[];
  /** Theme files. */
  themes: string[];
  /** Non-fatal problems found while reading: a bad manifest, an unparseable file. */
  warnings: string[];
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/**
 * A frontmatter description, collapsed to one line and left **whole**.
 *
 * Truncation belongs to the renderer, not to the record: `--json` is the
 * contract the hub builds its listing pages from, and a description cut at a
 * terminal's width there would make the page say something the package does
 * not. {@link formatInspectReport} shortens it for the screen instead.
 *
 * @param text - The raw `description:` value.
 */
function descriptionLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Forward only the loader warnings that are about files we actually asked
 * about.
 *
 * The real loaders take a *directory*, not a file list, so describing a
 * manifest-declared subset of a directory would otherwise report problems in
 * that directory's other files — which this package may not even provide. Every
 * such warning names its file by absolute path, so a substring check is exact.
 *
 * @param probe - Warnings the loader produced for the whole directory.
 * @param wanted - Absolute paths of the files this package actually declares.
 * @param out - The caller's warning collector.
 */
function forwardWarnings(probe: readonly string[], wanted: Iterable<string>, out: string[]): void {
  const files = [...wanted];
  for (const warning of probe) {
    if (files.some((file) => warning.includes(file))) out.push(warning);
  }
}

/**
 * Map each declared entry to the file the real loader would read, so a
 * loader's `source` can be matched back to the path inside the package.
 *
 * @param baseDir - Package root.
 * @param relPaths - Declared entries, relative to it.
 * @param folderFile - For skills, `"SKILL.md"`: an entry that is a *directory*
 *   is read one level deeper. Agents and workflows have no folder form, so
 *   they pass nothing.
 */
async function loaderFiles(
  baseDir: string,
  relPaths: readonly string[],
  folderFile?: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const rel of relPaths) {
    const full = resolve(baseDir, rel);
    if (folderFile !== undefined && (await isDirectory(full))) {
      map.set(resolve(full, folderFile), rel);
    } else {
      map.set(full, rel);
    }
  }
  return map;
}

/**
 * Describe agent roles with {@link loadAgentDefs} and {@link roleDispatch} —
 * the very functions `runtime.ts` and the workflow engine use.
 *
 * The lane is derived here rather than restated, because a lane a package
 * *claims* is worth nothing: the engine reads `tools:` and dispatches on what
 * it finds there, so that is the only reading a disclosure may show.
 *
 * `validToolNames` is deliberately not passed to the loader: an unknown tool
 * name would be dropped from the list, and a disclosure must show what the file
 * says rather than a filtered version of it. Dropping could not change the lane
 * either way — every name {@link roleDispatch} looks for is a built-in.
 *
 * @param baseDir - Package root.
 * @param relPaths - Declared agent files, relative to it.
 * @param warnings - Collector for non-fatal problems.
 */
async function describeAgents(
  baseDir: string,
  relPaths: readonly string[],
  warnings: string[],
): Promise<AgentDisclosure[]> {
  if (relPaths.length === 0) return [];
  const wanted = await loaderFiles(baseDir, relPaths);
  const out: AgentDisclosure[] = [];
  const probe: string[] = [];
  for (const dir of new Set([...wanted.keys()].map((file) => dirname(file)))) {
    for (const def of await loadAgentDefs([dir], probe)) {
      const rel = wanted.get(resolve(def.source));
      if (rel === undefined) continue;
      out.push({
        name: def.name,
        description: descriptionLine(def.description),
        lane: roleDispatch(def),
        ...(def.tools === undefined ? {} : { tools: def.tools }),
        path: rel,
      });
    }
  }
  forwardWarnings(probe, wanted.keys(), warnings);
  return out.sort(byName);
}

/**
 * Collect a pipeline's `@role` mentions, deduplicated, in first-use order.
 *
 * @param workflow - A parsed workflow.
 */
function workflowRoles(workflow: Workflow): string[] {
  const seen = new Set<string>();
  for (const stage of workflow.stages) {
    for (const step of stage.steps) {
      if (step.agent !== undefined) seen.add(step.agent);
    }
  }
  return [...seen];
}

/**
 * Describe workflows with `parseWorkflow` — the same strict parser
 * `discoverWorkflows` runs, so a file this reports as broken is a file the
 * engine would refuse too.
 *
 * @param baseDir - Package root.
 * @param relPaths - Declared workflow files, relative to it.
 */
async function describeWorkflows(
  baseDir: string,
  relPaths: readonly string[],
): Promise<WorkflowDisclosure[]> {
  const out: WorkflowDisclosure[] = [];
  for (const rel of relPaths) {
    const file = resolve(baseDir, rel);
    const stem = basename(rel, ".md");
    const broken = (error: string): WorkflowDisclosure => ({
      name: stem,
      description: "",
      stages: 0,
      steps: 0,
      roles: [],
      path: rel,
      error,
    });
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      out.push(broken(errorMessage(error)));
      continue;
    }
    const parsed = parseWorkflow(raw, { name: stem, source: file });
    if (isWorkflowParseError(parsed)) {
      out.push(broken(parsed.error));
      continue;
    }
    out.push({
      name: parsed.name,
      description: descriptionLine(parsed.description),
      stages: parsed.stages.length,
      steps: parsed.stages.reduce((total, stage) => total + stage.steps.length, 0),
      ...(parsed.budgetUsd === undefined ? {} : { budgetUsd: parsed.budgetUsd }),
      roles: workflowRoles(parsed),
      path: rel,
    });
  }
  return out.sort(byName);
}

/**
 * Describe skills with `loadSkills`, in both shapes it recognises.
 *
 * The loader root for an entry is always the directory the **entry** sits in,
 * never the directory its file sits in: a folder skill `skills/deep` is found
 * by scanning `skills/`, where `deep` is a directory whose `SKILL.md` supplies
 * the body and whose *folder name* supplies the name. Handing `skills/deep`
 * itself to the loader also "works" — it finds `SKILL.md` as a plain file — and
 * gets the name wrong, calling the skill `skill`. Scanning both and taking
 * whichever came first therefore renamed every folder skill in the disclosure.
 *
 * @param baseDir - Package root.
 * @param relPaths - Declared skill entries, relative to it.
 * @param warnings - Collector for non-fatal problems.
 */
async function describeSkills(
  baseDir: string,
  relPaths: readonly string[],
  warnings: string[],
): Promise<SkillDisclosure[]> {
  if (relPaths.length === 0) return [];
  const wanted = await loaderFiles(baseDir, relPaths, "SKILL.md");
  const out: SkillDisclosure[] = [];
  const probe: string[] = [];
  const roots = new Set<string>();
  for (const rel of relPaths) roots.add(dirname(resolve(baseDir, rel)));
  for (const root of roots) {
    for (const skill of await loadSkills([root], probe)) {
      const rel = wanted.get(resolve(skill.source));
      if (rel === undefined) continue;
      if (out.some((entry) => entry.path === rel)) continue;
      out.push({ name: skill.name, description: descriptionLine(skill.description), path: rel });
    }
  }
  forwardWarnings(probe, wanted.keys(), warnings);
  return out.sort(byName);
}

/**
 * Read a package's `mcp.json` for the server names and transports it would
 * merge into the user's own config.
 *
 * @param file - Absolute path of the package's `mcp.json`.
 * @param warnings - Collector for non-fatal problems.
 */
async function describeMcpServers(
  file: string,
  warnings: string[],
): Promise<McpServerDisclosure[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    warnings.push(`${file}: could not be read as JSON (${errorMessage(error)})`);
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.servers)) {
    warnings.push(`${file}: expected { "servers": { ... } }`);
    return [];
  }
  const out: McpServerDisclosure[] = [];
  for (const [name, value] of Object.entries(parsed.servers)) {
    if (!isRecord(value)) {
      out.push({ name, transport: "unknown", target: "" });
      continue;
    }
    const transport = typeof value.type === "string" ? value.type : "unknown";
    const url = typeof value.url === "string" ? value.url : undefined;
    const command = typeof value.command === "string" ? value.command : undefined;
    const args = Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const target = url ?? (command === undefined ? "" : [command, ...args].join(" "));
    out.push({ name, transport, target });
  }
  return out.sort(byName);
}

/* git plumbing ---------------------------------------------------------------- */

/**
 * Injectable `git` subprocess runner. Tests point it at real, throwaway local
 * repositories (created with `fs.mkdtemp` + real `git init`, installed from
 * `file://` paths) so the whole registry is exercised with real git and zero
 * network access. Every call is spawned with an argument array, never a
 * shell string.
 */
export type GitExecFn = (
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

const GIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;

const defaultGitExec: GitExecFn = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return { stdout, stderr };
};

interface Outcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function fieldOf(error: unknown, key: "stdout" | "stderr" | "message"): string {
  if (typeof error === "object" && error !== null) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function stderrOf(error: unknown): string {
  const stderr = fieldOf(error, "stderr").trim();
  if (stderr !== "") return stderr;
  const message = fieldOf(error, "message").trim();
  return message !== "" ? message : String(error);
}

function stdoutOf(error: unknown): string {
  return fieldOf(error, "stdout").trim();
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

async function git(exec: GitExecFn, cwd: string, args: readonly string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await exec(args, cwd);
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: stdoutOf(error), stderr: stderrOf(error) };
  }
}

/**
 * Clone `location` into the already-created empty directory `dest`, checking
 * out `ref` when given, and return the resolved HEAD commit.
 *
 * With no ref, a single shallow clone grabs the remote's default branch. With
 * a ref, a shallow `--branch=<ref>` clone is tried first (the common case: a
 * tag or branch name); a commit SHA (or anything else `--branch` can't
 * shallow-clone) falls back to a full clone followed by `git checkout`.
 *
 * @param exec - Git subprocess runner.
 * @param location - Clone URL (or local/`file://` path).
 * @param ref - Tag, branch or commit to pin to; `undefined` tracks the default branch.
 * @param parentDir - An existing directory to run the initial `clone` from.
 * @param dest - The (existing, empty) destination directory.
 */
async function cloneAtRef(
  exec: GitExecFn,
  location: string,
  ref: string | undefined,
  parentDir: string,
  dest: string,
): Promise<string> {
  if (ref === undefined) {
    const clone = await git(exec, parentDir, [
      "clone",
      "--depth",
      "1",
      "--no-tags",
      "--",
      location,
      dest,
    ]);
    if (!clone.ok) {
      throw new RegistryError(
        `could not clone "${location}": ${firstLine(clone.stderr) || "unknown git error"}`,
      );
    }
  } else {
    const shallow = await git(exec, parentDir, [
      "clone",
      "--depth",
      "1",
      "--no-tags",
      `--branch=${ref}`,
      "--",
      location,
      dest,
    ]);
    if (!shallow.ok) {
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true });
      const full = await git(exec, parentDir, ["clone", "--no-tags", "--", location, dest]);
      if (!full.ok) {
        throw new RegistryError(
          `could not clone "${location}": ${firstLine(full.stderr) || "unknown git error"}`,
        );
      }
      const checkout = await git(exec, dest, ["checkout", "--quiet", ref]);
      if (!checkout.ok) {
        throw new RegistryError(
          `ref "${ref}" was not found in "${location}": ` +
            `${firstLine(checkout.stderr) || "unknown git error"}`,
        );
      }
    }
  }
  const head = await git(exec, dest, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim() === "") {
    throw new RegistryError(`could not resolve HEAD after cloning "${location}"`);
  }
  return head.stdout.trim();
}

async function bestEffortLocalCommit(
  exec: GitExecFn,
  location: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await exec(["rev-parse", "HEAD"], location);
    const sha = stdout.trim();
    return sha === "" ? undefined : sha;
  } catch {
    return undefined;
  }
}

/* Filesystem plumbing ----------------------------------------------------------- */

async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

async function copyTree(src: string, dest: string, exclude: readonly string[]): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (source) => !exclude.includes(basename(source)),
  });
}

async function sameSymlinkTarget(dest: string, src: string): Promise<boolean> {
  try {
    const info = await lstat(dest);
    if (!info.isSymbolicLink()) return false;
    const target = await readlink(dest);
    const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(dest), target);
    return resolve(resolvedTarget) === resolve(src);
  } catch {
    return false;
  }
}

/**
 * Link (or, when a symlink can't be created, copy) one top-level entry from
 * an installed package into a scanned root, named after its basename.
 *
 * A pre-existing entry at the destination that isn't already a symlink to
 * this exact source is left untouched and reported as a warning — later
 * packages never silently clobber an earlier one's (or the user's own) files.
 *
 * @param packageDir - The installed package's own directory.
 * @param relPath - Path of the entry, relative to `packageDir`.
 * @param destRoot - Scanned root to link into (e.g. `~/.arcturn/skills`).
 * @param warnings - Collector for non-fatal problems.
 * @returns The destination basename actually linked, or `undefined` on a collision.
 */
async function linkEntry(
  packageDir: string,
  relPath: string,
  destRoot: string,
  warnings: string[],
): Promise<string | undefined> {
  const src = join(packageDir, relPath);
  const name = basename(relPath);
  const dest = join(destRoot, name);
  if (await pathExists(dest)) {
    if (await sameSymlinkTarget(dest, src)) {
      await rm(dest, { force: true });
    } else {
      warnings.push(
        `"${name}" already exists in ${destRoot}; this package's copy was not linked ` +
          "(remove or rename the conflicting entry first)",
      );
      return undefined;
    }
  }
  await mkdir(destRoot, { recursive: true });
  const info = await stat(src);
  try {
    await symlink(src, dest, info.isDirectory() ? "dir" : "file");
  } catch {
    await cp(src, dest, { recursive: true });
  }
  return name;
}

async function unlinkEntry(destRoot: string, name: string): Promise<void> {
  await rm(join(destRoot, name), { recursive: true, force: true });
}

/* MCP config merge -------------------------------------------------------------- */

async function mergeMcpServers(
  mcpConfigPath: string,
  sourceFile: string,
  warnings: string[],
): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(sourceFile, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`${sourceFile}: invalid JSON (${errorMessage(error)}); mcp config skipped`);
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.servers)) {
    warnings.push(`${sourceFile}: expected { "servers": { ... } }; mcp config skipped`);
    return [];
  }
  let existing: Record<string, unknown> = {};
  try {
    const parsedExisting: unknown = JSON.parse(await readFile(mcpConfigPath, "utf8"));
    if (isRecord(parsedExisting)) existing = parsedExisting;
  } catch {
    // Missing or unreadable: start from an empty document.
  }
  const servers: Record<string, unknown> = isRecord(existing.servers)
    ? { ...existing.servers }
    : {};
  const added: string[] = [];
  for (const [key, value] of Object.entries(parsed.servers)) {
    if (key in servers) {
      warnings.push(`mcp server "${key}" is already configured; skipped`);
      continue;
    }
    servers[key] = value;
    added.push(key);
  }
  if (added.length > 0) {
    await mkdir(dirname(mcpConfigPath), { recursive: true });
    await writeFile(
      mcpConfigPath,
      `${JSON.stringify({ ...existing, servers }, null, 2)}\n`,
      "utf8",
    );
  }
  return added;
}

async function removeMcpServers(mcpConfigPath: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  let existing: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(mcpConfigPath, "utf8"));
    existing = isRecord(parsed) ? parsed : {};
  } catch {
    return;
  }
  if (!isRecord(existing.servers)) return;
  const servers = { ...existing.servers };
  for (const key of keys) delete servers[key];
  await writeFile(mcpConfigPath, `${JSON.stringify({ ...existing, servers }, null, 2)}\n`, "utf8");
}

/* Install record ---------------------------------------------------------------- */

const INSTALL_RECORD_FILE = ".arcturn-install.json";

/** What one installed package actually links into the scanned roots. */
export interface InstallProvides {
  skills: string[];
  /**
   * Agent-role basenames linked into `~/.arcturn/agents`.
   *
   * Optional because records written before packages learned agents have no
   * such field; every reader here treats a missing list as empty rather than
   * failing to uninstall a package installed by an older build.
   */
  agents?: string[];
  /** Workflow basenames linked into `~/.arcturn/workflows`. Optional for the same reason as {@link InstallProvides.agents}. */
  workflows?: string[];
  extensions: string[];
  themes: string[];
  mcpServers: string[];
}

/** Persisted at `<packageDir>/.arcturn-install.json`; also what {@link listPackages} returns. */
export interface InstallRecord {
  /** Installed package name (the `~/.arcturn/packages/<name>` directory). */
  name: string;
  /** The source string exactly as the user typed it, so `arcturn update` can re-resolve it. */
  source: string;
  sourceKind: SourceKind;
  /** Resolved clone URL or local path. */
  location: string;
  /** Requested tag/branch/commit, when the source named one. */
  ref?: string;
  /** True when `ref` was given — an update never moves a pinned package. */
  pinned: boolean;
  /** Subdirectory within the repository used as the package root, when given. */
  subdir?: string;
  /** The exact resolved commit, when known (git sources, and local paths that are themselves a repo). */
  commit?: string;
  installedAt: string;
  updatedAt?: string;
  /** Whether extensions were excluded from linking at install time. */
  skillsOnly: boolean;
  manifest?: { name?: string; description?: string; version?: string };
  provides: InstallProvides;
}

async function readInstallRecord(packageDir: string): Promise<InstallRecord | undefined> {
  try {
    const raw = await readFile(join(packageDir, INSTALL_RECORD_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !isRecord(parsed.provides)) {
      return undefined;
    }
    return parsed as unknown as InstallRecord;
  } catch {
    return undefined;
  }
}

async function writeInstallRecord(packageDir: string, record: InstallRecord): Promise<void> {
  await writeFile(
    join(packageDir, INSTALL_RECORD_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

/* Executable-code confirmation --------------------------------------------------- */

/** Names the risk a caller must explicitly approve before an install links any extension. */
export interface ExecutableCodeWarning {
  /** The package about to have code linked. */
  packageName: string;
  /** Extension entries (relative paths inside the package) that would be linked. */
  extensionFiles: string[];
}

/**
 * Approve or decline linking a package's extensions. Called only when the
 * package has extensions and `skillsOnly` was not requested.
 *
 * There is deliberately no safe default that returns `true`: every call site
 * in this module defaults an absent confirmer to a hard `() => false`.
 */
export type ConfirmExecutableCode = (warning: ExecutableCodeWarning) => Promise<boolean> | boolean;

/* Install ------------------------------------------------------------------------- */

/** Options for {@link installPackage}. */
export interface InstallOptions {
  /** Source string: a git URL, a GitHub `owner/repo[/subdir][@ref]` shorthand, or a local path. */
  source: string;
  /** Explicit package name; defaults to one derived from the source. */
  name?: string;
  /** Where the registry reads from and writes to. */
  paths: RegistryPaths;
  /**
   * Skip extensions entirely: they are copied to disk but never linked, and
   * never executed.
   *
   * The name predates agents and workflows and is now narrower than it reads —
   * it means "no executable code", not "skills and nothing else". Agents,
   * workflows and themes still link under it, because none of them is code and
   * suppressing them would give the flag a second, unrelated job.
   */
  skillsOnly?: boolean;
  /**
   * Approves linking any detected extensions. Defaults to `() => false` —
   * an install with extensions and no confirmer installs nothing.
   */
  confirmExecutableCode?: ConfirmExecutableCode;
  /** Injectable `git` runner. Defaults to real `git` via `child_process`. */
  exec?: GitExecFn;
  /** Base directory for resolving a relative local-path source. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Base directory for expanding `~` in a local-path source. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Clock override for `installedAt`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Outcome of {@link installPackage}. */
export interface InstallResult {
  /** `false` when the executable-code confirmation was declined — nothing was written. */
  installed: boolean;
  /** The (would-be) package name. */
  name: string;
  /** `true` specifically when the outcome was a decline, as opposed to nothing to confirm. */
  declined: boolean;
  /** Present when `installed` is `true`. */
  record?: InstallRecord;
  /** Non-fatal problems: manifest issues, skipped name collisions, skipped mcp servers. */
  warnings: string[];
  /**
   * What the agents and workflows that just landed turn out to be, read back
   * through the real loaders.
   *
   * A role file is not code, so it does not go behind the executable-code gate
   * — but it *is* a capability surface, and a workflow spends real money. The
   * install therefore says what arrived: {@link formatInstallSummary} prints
   * each role's derived lane and each workflow's `budgetUsd:` cap, so nothing
   * lands unannounced. Absent when the package provided neither.
   */
  landed?: { agents: AgentDisclosure[]; workflows: WorkflowDisclosure[] };
}

/**
 * Describe the agents and workflows an install just linked.
 *
 * Matches each linked *basename* back to the path it came from inside the
 * package, so the description is of the file on disk. Returns `undefined` when
 * the package landed neither, so a skills-only install's summary is unchanged.
 *
 * @param packageDir - The installed package directory.
 * @param contents - What was detected, as paths relative to it.
 * @param provides - What actually linked, as destination basenames.
 * @param warnings - Collector for non-fatal problems.
 */
async function describeLanded(
  packageDir: string,
  contents: DetectedContents,
  provides: InstallProvides,
  warnings: string[],
): Promise<{ agents: AgentDisclosure[]; workflows: WorkflowDisclosure[] } | undefined> {
  const landedPaths = (rels: readonly string[], linked: readonly string[]): string[] => {
    const names = new Set(linked);
    return rels.filter((rel) => names.has(basename(rel)));
  };
  const agentPaths = landedPaths(contents.agents, provides.agents ?? []);
  const workflowPaths = landedPaths(contents.workflows, provides.workflows ?? []);
  if (agentPaths.length === 0 && workflowPaths.length === 0) return undefined;
  return {
    agents: await describeAgents(packageDir, agentPaths, warnings),
    workflows: await describeWorkflows(packageDir, workflowPaths),
  };
}

async function materialize(
  paths: RegistryPaths,
  packageDir: string,
  contents: DetectedContents,
  skillsOnly: boolean,
  warnings: string[],
): Promise<InstallProvides> {
  /** Link every entry of one kind, dropping the ones that collided. */
  const linkAll = async (rels: readonly string[], destRoot: string): Promise<string[]> => {
    const linked: string[] = [];
    for (const rel of rels) {
      const name = await linkEntry(packageDir, rel, destRoot, warnings);
      if (name !== undefined) linked.push(name);
    }
    return linked;
  };

  const skills = await linkAll(contents.skills, paths.skillsRoot);
  // Agents and workflows are markdown: a prompt and capability surface, never
  // an execution one, so they link on exactly the terms skills do — no gate,
  // and the same refusal to overwrite anything already in the root.
  const agents = await linkAll(contents.agents, paths.agentsRoot);
  const workflows = await linkAll(contents.workflows, paths.workflowsRoot);
  const extensions = skillsOnly ? [] : await linkAll(contents.extensions, paths.extensionsRoot);
  const themes = await linkAll(contents.themes, paths.themesRoot);
  const mcpServers = contents.mcp
    ? await mergeMcpServers(paths.mcpConfigPath, join(packageDir, contents.mcp), warnings)
    : [];

  return { skills, agents, workflows, extensions, themes, mcpServers };
}

/**
 * Fetch/copy a source into a staging directory and resolve its content root
 * (peeling off a GitHub-shorthand subdir, when given).
 */
async function stageSource(
  source: ResolvedSource,
  exec: GitExecFn,
  packagesRoot: string,
  staging: string,
): Promise<{ contentRoot: string; commit: string | undefined }> {
  if (source.kind === "local-path") {
    if (!(await isDirectory(source.location))) {
      throw new RegistryError(`local source "${source.location}" is not a directory`);
    }
    await copyTree(source.location, staging, [".git"]);
    const commit = await bestEffortLocalCommit(exec, source.location);
    return { contentRoot: staging, commit };
  }
  const commit = await cloneAtRef(exec, source.location, source.ref, packagesRoot, staging);
  let contentRoot = staging;
  if (source.subdir !== undefined) {
    contentRoot = join(staging, source.subdir);
    assertInside(staging, contentRoot, "subdirectory");
    if (!(await isDirectory(contentRoot))) {
      throw new RegistryError(
        `subdirectory "${source.subdir}" was not found in ${source.location}`,
      );
    }
  }
  return { contentRoot, commit };
}

/**
 * Install a package: resolve its source, stage it, detect what it provides,
 * gate any extensions behind {@link InstallOptions.confirmExecutableCode},
 * and — only once approved — move it into `~/.arcturn/packages/<name>` and link
 * its skills/extensions/themes/mcp config into the roots Arcturn scans.
 *
 * @param options - See {@link InstallOptions}.
 */
export async function installPackage(options: InstallOptions): Promise<InstallResult> {
  const exec = options.exec ?? defaultGitExec;
  const now = options.now ?? (() => new Date());
  const confirm = options.confirmExecutableCode ?? (() => false);
  const warnings: string[] = [];

  const source = resolveSource(options.source, { cwd: options.cwd, homeDir: options.homeDir });
  const name = options.name ?? source.defaultName;
  if (name === "") {
    throw new RegistryError(
      `could not derive a package name from "${options.source}"; pass an explicit name`,
    );
  }
  const packageDir = resolvePackageDir(options.paths.packagesRoot, name);
  if (await pathExists(packageDir)) {
    throw new RegistryError(
      `"${name}" is already installed. Remove it first with "arcturn remove ${name}", or install ` +
        "under a different name.",
    );
  }

  await mkdir(options.paths.packagesRoot, { recursive: true });
  const staging = await mkdtemp(join(options.paths.packagesRoot, ".staging-"));
  try {
    const { contentRoot, commit } = await stageSource(
      source,
      exec,
      options.paths.packagesRoot,
      staging,
    );

    const manifest = await readManifest(contentRoot, warnings);
    const contents = await detectContents(contentRoot, manifest, warnings);
    const skillsOnly = options.skillsOnly === true;

    if (contents.extensions.length > 0 && !skillsOnly) {
      const approved = await confirm({ packageName: name, extensionFiles: contents.extensions });
      if (!approved) {
        return { installed: false, name, declined: true, warnings };
      }
    }

    if (contentRoot === staging) {
      await rm(join(staging, ".git"), { recursive: true, force: true });
    }
    await moveDir(contentRoot, packageDir);
    if (contentRoot !== staging) {
      await rm(staging, { recursive: true, force: true });
    }

    const provides = await materialize(options.paths, packageDir, contents, skillsOnly, warnings);
    // Described from what actually LINKED, not from what the package shipped:
    // an entry dropped for a name collision is not on this machine, and a
    // summary that named it anyway would be reporting a file the user does not
    // have.
    const landed = await describeLanded(packageDir, contents, provides, warnings);

    const record: InstallRecord = {
      name,
      source: options.source,
      sourceKind: source.kind,
      location: source.location,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      pinned: source.ref !== undefined,
      ...(source.subdir === undefined ? {} : { subdir: source.subdir }),
      ...(commit === undefined ? {} : { commit }),
      installedAt: now().toISOString(),
      skillsOnly,
      ...(manifest ? { manifest: pickManifestSummary(manifest) } : {}),
      provides,
    };
    await writeInstallRecord(packageDir, record);

    return {
      installed: true,
      name,
      declined: false,
      record,
      warnings,
      ...(landed === undefined ? {} : { landed }),
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/* List -------------------------------------------------------------------------- */

/**
 * List every installed package, sorted by name.
 *
 * @param paths - Registry roots.
 */
export async function listPackages(paths: RegistryPaths): Promise<InstallRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.packagesRoot);
  } catch {
    return [];
  }
  const records: InstallRecord[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const record = await readInstallRecord(join(paths.packagesRoot, entry));
    if (record) records.push(record);
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

/* Remove ------------------------------------------------------------------------- */

/** Outcome of {@link removePackage}. */
export interface RemoveResult {
  name: string;
  removedSkills: string[];
  /** Agent roles unlinked from `~/.arcturn/agents`. */
  removedAgents: string[];
  /** Workflows unlinked from `~/.arcturn/workflows`. */
  removedWorkflows: string[];
  removedExtensions: string[];
  removedThemes: string[];
  removedMcpServers: string[];
}

/**
 * Uninstall a package: unlink everything it provided from the scanned roots,
 * remove any MCP servers it merged in, and delete its directory.
 *
 * @param name - Installed package name.
 * @param paths - Registry roots.
 */
export async function removePackage(name: string, paths: RegistryPaths): Promise<RemoveResult> {
  const packageDir = resolvePackageDir(paths.packagesRoot, name);
  const record = await readInstallRecord(packageDir);
  if (!record) throw new RegistryError(`"${name}" is not installed`);

  // `?? []` throughout: a record written before packages learned agents and
  // workflows has neither field, and an uninstall must still work on it.
  const agents = record.provides.agents ?? [];
  const workflows = record.provides.workflows ?? [];
  for (const skill of record.provides.skills) await unlinkEntry(paths.skillsRoot, skill);
  for (const agent of agents) await unlinkEntry(paths.agentsRoot, agent);
  for (const workflow of workflows) await unlinkEntry(paths.workflowsRoot, workflow);
  for (const extension of record.provides.extensions)
    await unlinkEntry(paths.extensionsRoot, extension);
  for (const theme of record.provides.themes) await unlinkEntry(paths.themesRoot, theme);
  if (record.provides.mcpServers.length > 0) {
    await removeMcpServers(paths.mcpConfigPath, record.provides.mcpServers);
  }
  await rm(packageDir, { recursive: true, force: true });

  return {
    name,
    removedSkills: record.provides.skills,
    removedAgents: agents,
    removedWorkflows: workflows,
    removedExtensions: record.provides.extensions,
    removedThemes: record.provides.themes,
    removedMcpServers: record.provides.mcpServers,
  };
}

/* Update ------------------------------------------------------------------------- */

/** Options for {@link updatePackage} / {@link updateAllPackages}. */
export interface UpdateOptions {
  paths: RegistryPaths;
  exec?: GitExecFn;
  /** Same contract as {@link InstallOptions.confirmExecutableCode}. */
  confirmExecutableCode?: ConfirmExecutableCode;
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
}

/** Why {@link UpdateReport.changed} is what it is. */
export type UpdateReason =
  | "not-a-package"
  | "pinned"
  | "up-to-date"
  | "updated"
  | "declined"
  | "error";

/** Outcome of one {@link updatePackage} call. */
export interface UpdateReport {
  name: string;
  changed: boolean;
  reason: UpdateReason;
  fromCommit?: string;
  toCommit?: string;
  addedFiles: string[];
  removedFiles: string[];
  modifiedFiles: string[];
  error?: string;
}

function blankReport(name: string, reason: UpdateReason): UpdateReport {
  return { name, changed: false, reason, addedFiles: [], removedFiles: [], modifiedFiles: [] };
}

async function walkFiles(root: string, exclude: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await collectFiles(root, "", out, exclude);
  return out;
}

async function collectFiles(
  dir: string,
  rel: string,
  out: Set<string>,
  exclude: readonly string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || exclude.includes(entry.name)) continue;
    const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(join(dir, entry.name), relPath, out, exclude);
    } else if (entry.isFile()) {
      out.add(relPath);
    }
  }
}

async function filesEqual(a: string, b: string): Promise<boolean> {
  try {
    const [bufA, bufB] = await Promise.all([readFile(a), readFile(b)]);
    return bufA.equals(bufB);
  } catch {
    return false;
  }
}

async function diffTrees(
  oldDir: string,
  newDir: string,
  exclude: readonly string[],
): Promise<{ added: string[]; removed: string[]; modified: string[] }> {
  const oldFiles = await walkFiles(oldDir, exclude);
  const newFiles = await walkFiles(newDir, exclude);
  const added: string[] = [];
  const modified: string[] = [];
  for (const rel of newFiles) {
    if (!oldFiles.has(rel)) {
      added.push(rel);
    } else if (!(await filesEqual(join(oldDir, rel), join(newDir, rel)))) {
      modified.push(rel);
    }
  }
  const removed = [...oldFiles].filter((rel) => !newFiles.has(rel));
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

/**
 * Re-fetch one installed package and report what changed.
 *
 * A pinned package (installed with an explicit `@ref`) is never moved — this
 * returns immediately with `reason: "pinned"`. An unpinned package is
 * re-resolved from its original source string, re-staged, and compared
 * against what's on disk; if the content differs, the same executable-code
 * confirmation gate {@link installPackage} uses applies again before any
 * extension is (re-)linked, and the package directory plus its links are
 * replaced atomically-ish (old links removed, new ones added, directory
 * swapped).
 *
 * @param name - Installed package name.
 * @param options - See {@link UpdateOptions}.
 */
export async function updatePackage(name: string, options: UpdateOptions): Promise<UpdateReport> {
  const packageDir = resolvePackageDir(options.paths.packagesRoot, name);
  const record = await readInstallRecord(packageDir);
  if (!record) return blankReport(name, "not-a-package");
  if (record.pinned) {
    return { ...blankReport(name, "pinned"), fromCommit: record.commit, toCommit: record.commit };
  }

  const exec = options.exec ?? defaultGitExec;
  const now = options.now ?? (() => new Date());
  const confirm = options.confirmExecutableCode ?? (() => false);

  let source: ResolvedSource;
  try {
    source = resolveSource(record.source, { cwd: options.cwd, homeDir: options.homeDir });
  } catch (error) {
    return { ...blankReport(name, "error"), error: errorMessage(error) };
  }

  await mkdir(options.paths.packagesRoot, { recursive: true });
  const staging = await mkdtemp(join(options.paths.packagesRoot, ".staging-"));
  try {
    let staged: { contentRoot: string; commit: string | undefined };
    try {
      staged = await stageSource(source, exec, options.paths.packagesRoot, staging);
    } catch (error) {
      return { ...blankReport(name, "error"), error: errorMessage(error) };
    }
    const { contentRoot, commit } = staged;

    if (commit !== undefined && record.commit !== undefined && commit === record.commit) {
      return { ...blankReport(name, "up-to-date"), fromCommit: record.commit, toCommit: commit };
    }

    const diff = await diffTrees(packageDir, contentRoot, [INSTALL_RECORD_FILE]);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
      await writeInstallRecord(packageDir, {
        ...record,
        ...(commit === undefined ? {} : { commit }),
        updatedAt: now().toISOString(),
      });
      return { ...blankReport(name, "up-to-date"), fromCommit: record.commit, toCommit: commit };
    }

    const warnings: string[] = [];
    const manifest = await readManifest(contentRoot, warnings);
    const contents = await detectContents(contentRoot, manifest, warnings);
    const skillsOnly = record.skillsOnly;

    if (contents.extensions.length > 0 && !skillsOnly) {
      const approved = await confirm({ packageName: name, extensionFiles: contents.extensions });
      if (!approved) {
        return {
          ...blankReport(name, "declined"),
          fromCommit: record.commit,
          toCommit: commit,
          addedFiles: diff.added,
          removedFiles: diff.removed,
          modifiedFiles: diff.modified,
        };
      }
    }

    for (const skill of record.provides.skills) await unlinkEntry(options.paths.skillsRoot, skill);
    for (const agent of record.provides.agents ?? []) {
      await unlinkEntry(options.paths.agentsRoot, agent);
    }
    for (const workflow of record.provides.workflows ?? []) {
      await unlinkEntry(options.paths.workflowsRoot, workflow);
    }
    for (const extension of record.provides.extensions) {
      await unlinkEntry(options.paths.extensionsRoot, extension);
    }
    for (const theme of record.provides.themes) await unlinkEntry(options.paths.themesRoot, theme);
    if (record.provides.mcpServers.length > 0) {
      await removeMcpServers(options.paths.mcpConfigPath, record.provides.mcpServers);
    }

    if (contentRoot === staging) {
      await rm(join(staging, ".git"), { recursive: true, force: true });
    }
    await rm(packageDir, { recursive: true, force: true });
    await moveDir(contentRoot, packageDir);
    if (contentRoot !== staging) {
      await rm(staging, { recursive: true, force: true });
    }

    const provides = await materialize(options.paths, packageDir, contents, skillsOnly, warnings);

    const updatedRecord: InstallRecord = {
      ...record,
      ...(commit === undefined ? {} : { commit }),
      updatedAt: now().toISOString(),
      ...(manifest ? { manifest: pickManifestSummary(manifest) } : {}),
      provides,
    };
    await writeInstallRecord(packageDir, updatedRecord);

    return {
      name,
      changed: true,
      reason: "updated",
      fromCommit: record.commit,
      toCommit: commit,
      addedFiles: diff.added,
      removedFiles: diff.removed,
      modifiedFiles: diff.modified,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Update every installed package. Errors on one package don't stop the rest;
 * each failure is reported in its own {@link UpdateReport} instead.
 *
 * @param options - See {@link UpdateOptions}.
 */
export async function updateAllPackages(options: UpdateOptions): Promise<UpdateReport[]> {
  const records = await listPackages(options.paths);
  const reports: UpdateReport[] = [];
  for (const record of records) reports.push(await updatePackage(record.name, options));
  return reports;
}

/* Inspect ------------------------------------------------------------------------ */

/** How much of a description survives the terminal, before the renderer elides it. */
const DESCRIPTION_WIDTH = 96;

/** Options for {@link inspectPackage}. */
export interface InspectOptions {
  /** Source string: a git URL, a GitHub `owner/repo[/subdir][@ref]` shorthand, or a local path. */
  source: string;
  /** Explicit package name; defaults to one derived from the source. */
  name?: string;
  /** Where to stage. Only `packagesRoot` is written to, and only transiently. */
  paths: RegistryPaths;
  /** Injectable `git` runner. Defaults to real `git` via `child_process`. */
  exec?: GitExecFn;
  /** Base directory for resolving a relative local-path source. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Base directory for expanding `~` in a local-path source. Defaults to `os.homedir()`. */
  homeDir?: string;
}

/**
 * Stage a source exactly as an install would, read it with the real loaders,
 * link **nothing**, and return what an install *would* add.
 *
 * This is the disclosure half of the install command, and its value comes
 * entirely from being the same code path: the same {@link resolveSource}, the
 * same {@link stageSource} (so the same clone, the same ref pinning, the same
 * subdirectory extraction), the same {@link readManifest} and
 * {@link detectContents}. A separate "preview" implementation would eventually
 * disagree with the installer about what a package contains, and the one moment
 * it mattered would be the moment someone was deciding whether to trust it.
 *
 * Staging happens under `packagesRoot` rather than the system temp directory
 * for the same reason: it is where the install would put it, on the volume the
 * install would use, so an inspect that succeeds is evidence the install can.
 * The directory is removed on every path out, including a thrown clone error.
 *
 * @param options - See {@link InspectOptions}.
 */
export async function inspectPackage(options: InspectOptions): Promise<PackageDisclosure> {
  const exec = options.exec ?? defaultGitExec;
  const warnings: string[] = [];
  const source = resolveSource(options.source, { cwd: options.cwd, homeDir: options.homeDir });
  const name = options.name ?? source.defaultName;

  await mkdir(options.paths.packagesRoot, { recursive: true });
  const staging = await mkdtemp(join(options.paths.packagesRoot, ".staging-"));
  try {
    const { contentRoot, commit } = await stageSource(
      source,
      exec,
      options.paths.packagesRoot,
      staging,
    );
    const manifest = await readManifest(contentRoot, warnings);
    const contents = await detectContents(contentRoot, manifest, warnings);

    return {
      name,
      source: options.source,
      sourceKind: source.kind,
      location: source.location,
      ...(commit === undefined ? {} : { commit }),
      ...(manifest ? { manifest: pickManifestSummary(manifest) } : {}),
      agents: await describeAgents(contentRoot, contents.agents, warnings),
      workflows: await describeWorkflows(contentRoot, contents.workflows),
      skills: await describeSkills(contentRoot, contents.skills, warnings),
      mcpServers: contents.mcp
        ? await describeMcpServers(join(contentRoot, contents.mcp), warnings)
        : [],
      extensions: [...contents.extensions].sort(),
      themes: [...contents.themes].sort(),
      warnings,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render a {@link PackageDisclosure} for a person to read before deciding.
 *
 * Ordered by risk, ascending, so the last thing on screen is the thing that
 * matters most: what would run as them. The executable-code section is a
 * banner rather than a list item for the same reason — it is the one section
 * whose absence is also worth stating, which is why a clean package says so
 * explicitly instead of leaving a gap where the warning would have been.
 *
 * @param disclosure - See {@link inspectPackage}.
 */
export function formatInspectReport(disclosure: PackageDisclosure): string[] {
  const lines: string[] = [`${disclosure.name}  —  ${disclosure.source}`];
  if (disclosure.manifest?.description) lines.push(`  ${disclosure.manifest.description}`);
  const version = disclosure.manifest?.version;
  lines.push(
    `  ${disclosure.sourceKind}  ${disclosure.commit ? short(disclosure.commit) : "no commit"}` +
      (version ? `  v${version}` : ""),
  );
  lines.push('  nothing has been installed; this is what "arcturn add" would add.');

  if (disclosure.agents.length > 0) {
    lines.push("", `Agent roles (${disclosure.agents.length})`);
    for (const agent of disclosure.agents) {
      lines.push(`  ${agent.name}  [${agent.lane} lane]${formatTools(agent.tools)}`);
      if (agent.description) lines.push(`    ${oneLine(agent.description, DESCRIPTION_WIDTH)}`);
    }
  }

  if (disclosure.workflows.length > 0) {
    lines.push("", `Workflows (${disclosure.workflows.length})`);
    for (const workflow of disclosure.workflows) {
      lines.push(`  ${workflow.name}  ${formatWorkflowFacts(workflow)}`);
      if (workflow.description) {
        lines.push(`    ${oneLine(workflow.description, DESCRIPTION_WIDTH)}`);
      }
    }
  }

  if (disclosure.skills.length > 0) {
    lines.push("", `Skills (${disclosure.skills.length})`);
    for (const skill of disclosure.skills) {
      const summary = skill.description
        ? `  —  ${oneLine(skill.description, DESCRIPTION_WIDTH)}`
        : "";
      lines.push(`  /${skill.name}${summary}`);
    }
  }

  if (disclosure.themes.length > 0) {
    lines.push("", `Themes (${disclosure.themes.length})`);
    for (const theme of disclosure.themes) lines.push(`  ${basename(theme)}`);
  }

  if (disclosure.mcpServers.length > 0) {
    lines.push("", `MCP servers (${disclosure.mcpServers.length})`);
    for (const server of disclosure.mcpServers) {
      lines.push(
        `  ${server.name}  [${server.transport}]${server.target ? `  ${server.target}` : ""}`,
      );
    }
  }

  if (disclosure.extensions.length > 0) {
    lines.push(
      "",
      "!! EXECUTABLE CODE !!",
      "  Installing this package runs the following files with your full",
      "  permissions. Arcturn will ask again, per install, before linking them.",
    );
    for (const file of disclosure.extensions) lines.push(`    ${file}`);
  } else {
    lines.push("", "No extensions: this package ships no executable code.");
  }

  if (disclosure.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of disclosure.warnings) lines.push(`  ${warning}`);
  }
  return lines;
}

/* Formatting ------------------------------------------------------------------ */

function describeProvides(provides: InstallProvides): string {
  const parts: string[] = [];
  if (provides.skills.length) parts.push(`${provides.skills.length} skill(s)`);
  if (provides.agents?.length) parts.push(`${provides.agents.length} agent(s)`);
  if (provides.workflows?.length) parts.push(`${provides.workflows.length} workflow(s)`);
  if (provides.extensions.length) parts.push(`${provides.extensions.length} extension(s)`);
  if (provides.themes.length) parts.push(`${provides.themes.length} theme(s)`);
  if (provides.mcpServers.length) parts.push(`${provides.mcpServers.length} MCP server(s)`);
  return parts.join(", ");
}

/** `  tools: read, bash`, or nothing at all when the file declared none. */
function formatTools(tools: readonly string[] | undefined): string {
  return tools === undefined || tools.length === 0 ? "" : `  tools: ${tools.join(", ")}`;
}

/**
 * The facts a workflow is judged on before it is run: how much of the pipeline
 * there is, and what it is allowed to spend.
 *
 * "no budget cap" is spelled out rather than left blank, because the absence of
 * a ceiling is the more expensive of the two answers and should not read as
 * missing information.
 */
function formatWorkflowFacts(workflow: WorkflowDisclosure): string {
  if (workflow.error !== undefined) return `does not parse — ${workflow.error}`;
  const stages = `${workflow.stages} stage${workflow.stages === 1 ? "" : "s"}`;
  const steps = `${workflow.steps} step${workflow.steps === 1 ? "" : "s"}`;
  const budget = workflow.budgetUsd === undefined ? "no budget cap" : `$${workflow.budgetUsd}`;
  const roles = workflow.roles.length === 0 ? "" : `, roles: ${workflow.roles.join(", ")}`;
  return `${stages}, ${steps}, ${budget}${roles}`;
}

function short(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : "unknown";
}

/**
 * Render {@link listPackages}' result as printable lines, for `/packages` and
 * the `--print` output of a future `arcturn packages` command.
 *
 * @param records - Installed packages, as returned by {@link listPackages}.
 */
export function formatPackageList(records: readonly InstallRecord[]): string[] {
  if (records.length === 0) {
    return ['No packages installed. Try "/add <source>" or "arcturn add <source>".'];
  }
  const lines: string[] = ["Installed packages"];
  for (const record of records) {
    const pin = record.pinned ? (record.ref ?? "pinned") : "tracking latest";
    lines.push(`  ${record.name}  —  ${record.source}`);
    lines.push(
      `    ${pin} @ ${short(record.commit)}` +
        (describeProvides(record.provides) ? `  (${describeProvides(record.provides)})` : ""),
    );
  }
  return lines;
}

/**
 * Render {@link installPackage}'s result as printable lines.
 *
 * @param result - See {@link InstallResult}.
 */
export function formatInstallSummary(result: InstallResult): string[] {
  if (!result.installed || !result.record) {
    return [
      result.declined
        ? `Installation of "${result.name}" was cancelled: executable code was not approved. ` +
          "Nothing was installed."
        : `Installation of "${result.name}" was cancelled. Nothing was installed.`,
    ];
  }
  const { record } = result;
  const lines = [`Installed "${record.name}" from ${record.source}`];
  if (record.commit) lines.push(`  commit ${record.commit}`);
  const description = describeProvides(record.provides);
  lines.push(
    `  ${description || "nothing to link (no skills, agents, workflows, extensions, themes or mcp config found)"}`,
  );
  if (record.provides.skills.length)
    lines.push(`  skills:      ${record.provides.skills.join(", ")}`);
  // Roles and workflows get a line each rather than a comma list: the lane and
  // the budget are the two facts a person needs before the next `/workflow`
  // run spends their money, and a name alone does not carry either.
  for (const agent of result.landed?.agents ?? []) {
    lines.push(`  agent:       ${agent.name}  [${agent.lane} lane]${formatTools(agent.tools)}`);
  }
  for (const workflow of result.landed?.workflows ?? []) {
    lines.push(`  workflow:    ${workflow.name}  ${formatWorkflowFacts(workflow)}`);
  }
  if (record.provides.extensions.length) {
    lines.push(`  extensions:  ${record.provides.extensions.join(", ")}`);
  }
  if (record.provides.themes.length)
    lines.push(`  themes:      ${record.provides.themes.join(", ")}`);
  if (record.provides.mcpServers.length) {
    lines.push(`  mcp servers: ${record.provides.mcpServers.join(", ")}`);
  }
  return lines;
}

/**
 * Render {@link removePackage}'s result as printable lines.
 *
 * @param result - See {@link RemoveResult}.
 */
export function formatRemoveSummary(result: RemoveResult): string[] {
  const lines = [`Removed "${result.name}"`];
  if (result.removedSkills.length) lines.push(`  skills:      ${result.removedSkills.join(", ")}`);
  if (result.removedAgents.length) lines.push(`  agents:      ${result.removedAgents.join(", ")}`);
  if (result.removedWorkflows.length) {
    lines.push(`  workflows:   ${result.removedWorkflows.join(", ")}`);
  }
  if (result.removedExtensions.length) {
    lines.push(`  extensions:  ${result.removedExtensions.join(", ")}`);
  }
  if (result.removedThemes.length) lines.push(`  themes:      ${result.removedThemes.join(", ")}`);
  if (result.removedMcpServers.length) {
    lines.push(`  mcp servers: ${result.removedMcpServers.join(", ")}`);
  }
  return lines;
}

/**
 * Render one {@link updatePackage}/{@link updateAllPackages} report as a
 * printable line (or two, when files changed).
 *
 * @param report - See {@link UpdateReport}.
 */
export function formatUpdateReport(report: UpdateReport): string {
  switch (report.reason) {
    case "not-a-package":
      return `"${report.name}" is not installed.`;
    case "pinned":
      return `"${report.name}" is pinned to ${short(report.fromCommit)}; not moving.`;
    case "up-to-date":
      return `"${report.name}" is already up to date (${short(report.fromCommit)}).`;
    case "declined":
      return (
        `"${report.name}" has new executable code that was not approved; update cancelled ` +
        "(the package was left as it was)."
      );
    case "error":
      return `"${report.name}": update failed — ${report.error ?? "unknown error"}`;
    case "updated": {
      const changes = [
        ...report.addedFiles.map((file) => `+${file}`),
        ...report.removedFiles.map((file) => `-${file}`),
        ...report.modifiedFiles.map((file) => `~${file}`),
      ];
      const header = `"${report.name}" updated ${short(report.fromCommit)} -> ${short(report.toCommit)}`;
      return changes.length > 0 ? `${header}\n  ${changes.join(", ")}` : header;
    }
  }
}

/* Slash commands ----------------------------------------------------------------- */

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i] as string)) i++;
    if (i >= n) break;
    const ch = text[i] as string;
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) {
        tokens.push(text.slice(i + 1));
        i = n;
      } else {
        tokens.push(text.slice(i + 1, close));
        i = close + 1;
      }
    } else {
      const start = i;
      while (i < n && !/\s/.test(text[i] as string)) i++;
      tokens.push(text.slice(start, i));
    }
  }
  return tokens;
}

interface ParsedAddArgs {
  source?: string;
  name?: string;
  skillsOnly: boolean;
  yes: boolean;
  error?: string;
}

/** Shared by `/add` and `arcturn add`: `<source> [--name <name>] [--skills-only] [--yes|-y]`. */
function parseAddArgv(argv: readonly string[]): ParsedAddArgs {
  let source: string | undefined;
  let name: string | undefined;
  let skillsOnly = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--name" || token === "-n") {
      const value = argv[i + 1];
      if (value === undefined) return { skillsOnly, yes, error: `${token} needs a value` };
      name = value;
      i++;
    } else if (token === "--skills-only") {
      skillsOnly = true;
    } else if (token === "--yes" || token === "-y") {
      yes = true;
    } else if (token.startsWith("-") && token !== "-") {
      return { skillsOnly, yes, error: `unknown flag "${token}"` };
    } else if (source === undefined) {
      source = token;
    } else {
      return { skillsOnly, yes, error: `unexpected argument "${token}"` };
    }
  }
  return { source, name, skillsOnly, yes };
}

const ADD_USAGE = "Usage: /add <source> [--name <name>] [--skills-only] [--yes]";

async function promptExecutableCode(
  ui: CommandUi,
  warning: ExecutableCodeWarning,
): Promise<boolean> {
  const count = warning.extensionFiles.length;
  const choice = await ui.select(
    `"${warning.packageName}" includes executable code (${count} extension file${count === 1 ? "" : "s"}: ` +
      `${warning.extensionFiles.join(", ")}). Installing it runs someone else's code with your ` +
      "full permissions.",
    [
      { value: "yes", label: "Install and run this code", data: true },
      { value: "no", label: "Cancel — install nothing", data: false },
    ],
  );
  return choice === true;
}

function addCommand(): SlashCommand {
  return {
    name: "add",
    description: "Install a skills/extensions package: /add <source> [--name x] [--skills-only]",
    source: "built-in",
    async run({ ui, runtime, args }: CommandContext) {
      const parsed = parseAddArgv(tokenize(args));
      if (parsed.error || !parsed.source) {
        ui.notice("error", parsed.error ?? ADD_USAGE);
        return;
      }
      const paths = registryPathsFromHome(runtime.paths.home);
      let result: InstallResult;
      try {
        result = await installPackage({
          source: parsed.source,
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          skillsOnly: parsed.skillsOnly,
          paths,
          cwd: runtime.cwd,
          confirmExecutableCode: parsed.yes
            ? () => true
            : (warning) => promptExecutableCode(ui, warning),
        });
      } catch (error) {
        ui.notice("error", errorMessage(error));
        return;
      }
      for (const warning of result.warnings) ui.notice("warn", warning);
      ui.print(formatInstallSummary(result));
    },
  };
}

function packagesCommand(): SlashCommand {
  return {
    name: "packages",
    description: "List installed packages",
    source: "built-in",
    async run({ ui, runtime }: CommandContext) {
      const paths = registryPathsFromHome(runtime.paths.home);
      const records = await listPackages(paths);
      ui.print(formatPackageList(records));
    },
  };
}

function removeCommand(): SlashCommand {
  return {
    name: "remove",
    description: "Uninstall a package: /remove <name>",
    source: "built-in",
    async run({ ui, runtime, args }: CommandContext) {
      const name = args.trim();
      if (name === "") {
        ui.notice("error", "Usage: /remove <name>");
        return;
      }
      const paths = registryPathsFromHome(runtime.paths.home);
      const confirmed = await ui.select(`Remove package "${name}"?`, [
        { value: "yes", label: "Remove it", data: true },
        { value: "no", label: "Cancel", data: false },
      ]);
      if (confirmed !== true) {
        ui.notice("info", "Cancelled.");
        return;
      }
      try {
        const result = await removePackage(name, paths);
        ui.print(formatRemoveSummary(result));
      } catch (error) {
        ui.notice("error", errorMessage(error));
      }
    },
  };
}

function updateCommand(): SlashCommand {
  return {
    name: "update",
    description: "Re-fetch a package (or all): /update [name]",
    source: "built-in",
    async run({ ui, runtime, args }: CommandContext) {
      const paths = registryPathsFromHome(runtime.paths.home);
      const confirm = (warning: ExecutableCodeWarning): Promise<boolean> =>
        promptExecutableCode(ui, warning);
      const name = args.trim();
      try {
        if (name === "") {
          const reports = await updateAllPackages({
            paths,
            cwd: runtime.cwd,
            confirmExecutableCode: confirm,
          });
          if (reports.length === 0) {
            ui.notice("info", "No packages installed.");
            return;
          }
          for (const report of reports) ui.print(formatUpdateReport(report).split("\n"));
        } else {
          const report = await updatePackage(name, {
            paths,
            cwd: runtime.cwd,
            confirmExecutableCode: confirm,
          });
          ui.print(formatUpdateReport(report).split("\n"));
        }
      } catch (error) {
        ui.notice("error", errorMessage(error));
      }
    },
  };
}

/**
 * Build the four registry slash commands: `/add`, `/packages`, `/remove`,
 * `/update`. Each derives {@link RegistryPaths} from `runtime.paths.home` and
 * uses the live {@link CommandUi} to prompt for the executable-code
 * confirmation and for `/remove`'s destructive-action confirmation.
 */
export function createRegistryCommands(): SlashCommand[] {
  return [addCommand(), packagesCommand(), removeCommand(), updateCommand()];
}

/* Top-level `arcturn` commands -------------------------------------------------------- */

/** Writes one line of output, mirroring `process.stdout.write`/`process.stderr.write`. */
export type RegistryWriter = (text: string) => void;

function defaultStdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

function defaultStderr(text: string): void {
  process.stderr.write(`${text}\n`);
}

function defaultHome(): string {
  return join(homedir(), ".arcturn");
}

/**
 * Fail-closed default confirmer for real terminal use: prints the risk and
 * asks on stdin. Never used in tests (they always inject `confirm`), and
 * returns `false` outright when stdin isn't a TTY (a non-interactive/piped
 * invocation can't give informed consent).
 */
async function terminalConfirm(warning: ExecutableCodeWarning): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      `\n"${warning.packageName}" includes executable code:\n` +
        warning.extensionFiles.map((file) => `  ${file}\n`).join("") +
        "Installing it means running someone else's code with your full permissions.\n",
    );
    const answer = await rl.question("Continue? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Options for {@link runAddCommand}. */
export interface RunAddCommandOptions {
  /** Arguments after `arcturn add`, e.g. `["owner/repo", "--skills-only"]`. */
  argv: readonly string[];
  /** Working directory for resolving a relative local-path source. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Arcturn user directory. Pass `paths.home` from `resolveArcturnPaths()` to honor `ARCTURN_HOME`; defaults to `~/.arcturn`. */
  home?: string;
  /** Where normal output goes. Defaults to `process.stdout`. */
  stdout?: RegistryWriter;
  /** Where errors go. Defaults to `process.stderr`. */
  stderr?: RegistryWriter;
  /** Executable-code confirmer. Defaults to a real stdin y/N prompt (fails closed off a TTY). */
  confirm?: ConfirmExecutableCode;
  /** Injectable `git` runner, for tests. */
  exec?: GitExecFn;
  /** Clock override, for tests. */
  now?: () => Date;
}

/**
 * `arcturn add <source> [--name <name>] [--skills-only] [--yes]` — install a
 * package. Exit code `0` on success, `1` on a declined confirmation or
 * install failure, `2` on a usage error.
 *
 * @param options - See {@link RunAddCommandOptions}.
 */
export async function runAddCommand(options: RunAddCommandOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const parsed = parseAddArgv(options.argv);
  if (parsed.error || !parsed.source) {
    stderr(
      `arcturn: ${parsed.error ?? "usage: arcturn add <source> [--name <name>] [--skills-only] [--yes]"}`,
    );
    return 2;
  }
  const paths = registryPathsFromHome(options.home ?? defaultHome());
  const confirm = parsed.yes ? () => true : (options.confirm ?? terminalConfirm);
  let result: InstallResult;
  try {
    result = await installPackage({
      source: parsed.source,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      skillsOnly: parsed.skillsOnly,
      paths,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.exec === undefined ? {} : { exec: options.exec }),
      ...(options.now === undefined ? {} : { now: options.now }),
      confirmExecutableCode: confirm,
    });
  } catch (error) {
    stderr(`arcturn: ${errorMessage(error)}`);
    return 1;
  }
  for (const warning of result.warnings) stderr(`arcturn: ${warning}`);
  for (const line of formatInstallSummary(result)) stdout(line);
  return result.installed ? 0 : 1;
}

/** Options for {@link runRemoveCommand}. */
export interface RunRemoveCommandOptions {
  /** Arguments after `arcturn remove`, i.e. `[<name>]`. */
  argv: readonly string[];
  /** Arcturn user directory; defaults to `~/.arcturn`. */
  home?: string;
  stdout?: RegistryWriter;
  stderr?: RegistryWriter;
}

/**
 * `arcturn remove <name>` — uninstall a package. Exit code `0` on success, `1` if
 * it isn't installed, `2` on a usage error.
 *
 * @param options - See {@link RunRemoveCommandOptions}.
 */
export async function runRemoveCommand(options: RunRemoveCommandOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const name = options.argv[0];
  if (!name) {
    stderr("arcturn: usage: arcturn remove <name>");
    return 2;
  }
  const paths = registryPathsFromHome(options.home ?? defaultHome());
  try {
    const result = await removePackage(name, paths);
    for (const line of formatRemoveSummary(result)) stdout(line);
    return 0;
  } catch (error) {
    stderr(`arcturn: ${errorMessage(error)}`);
    return 1;
  }
}

/** Options for {@link runUpdateCommand}. */
export interface RunUpdateCommandOptions {
  /** Arguments after `arcturn update`, i.e. `[<name>]`; all packages when empty. */
  argv: readonly string[];
  home?: string;
  cwd?: string;
  stdout?: RegistryWriter;
  stderr?: RegistryWriter;
  confirm?: ConfirmExecutableCode;
  exec?: GitExecFn;
  now?: () => Date;
}

/**
 * `arcturn update [name]` — re-fetch one package, or every installed package when
 * `name` is omitted. Exit code `0` unless a named package isn't installed.
 *
 * @param options - See {@link RunUpdateCommandOptions}.
 */
export async function runUpdateCommand(options: RunUpdateCommandOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const paths = registryPathsFromHome(options.home ?? defaultHome());
  const updateOptions: UpdateOptions = {
    paths,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.exec === undefined ? {} : { exec: options.exec }),
    ...(options.now === undefined ? {} : { now: options.now }),
    confirmExecutableCode: options.confirm ?? terminalConfirm,
  };
  const name = options.argv[0];
  try {
    if (!name) {
      const reports = await updateAllPackages(updateOptions);
      if (reports.length === 0) {
        stdout("No packages installed.");
        return 0;
      }
      for (const report of reports) stdout(formatUpdateReport(report));
      return reports.some((report) => report.reason === "error") ? 1 : 0;
    }
    const report = await updatePackage(name, updateOptions);
    stdout(formatUpdateReport(report));
    return report.reason === "not-a-package" || report.reason === "error" ? 1 : 0;
  } catch (error) {
    stderr(`arcturn: ${errorMessage(error)}`);
    return 1;
  }
}

/** Options for {@link runPackagesCommand}. */
export interface RunPackagesCommandOptions {
  /** Arguments after `arcturn packages`; none are accepted. */
  argv: readonly string[];
  /** Arcturn user directory; defaults to `~/.arcturn`. */
  home?: string;
  stdout?: RegistryWriter;
  stderr?: RegistryWriter;
}

/**
 * `arcturn packages` — list what is installed. Exit code `0`, or `2` on a
 * usage error.
 *
 * @param options - See {@link RunPackagesCommandOptions}.
 */
export async function runPackagesCommand(options: RunPackagesCommandOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  if (options.argv.length > 0) {
    stderr(`arcturn: usage: arcturn packages (takes no arguments)`);
    return 2;
  }
  const paths = registryPathsFromHome(options.home ?? defaultHome());
  for (const line of formatPackageList(await listPackages(paths))) stdout(line);
  return 0;
}

interface ParsedInspectArgs {
  source?: string;
  name?: string;
  json: boolean;
  error?: string;
}

/** `<source> [--name <name>] [--json]`. */
function parseInspectArgv(argv: readonly string[]): ParsedInspectArgs {
  let source: string | undefined;
  let name: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--name" || token === "-n") {
      const value = argv[i + 1];
      if (value === undefined) return { json, error: `${token} needs a value` };
      name = value;
      i++;
    } else if (token === "--json") {
      json = true;
    } else if (token.startsWith("-") && token !== "-") {
      return { json, error: `unknown flag "${token}"` };
    } else if (source === undefined) {
      source = token;
    } else {
      return { json, error: `unexpected argument "${token}"` };
    }
  }
  return { source, name, json };
}

/** Options for {@link runInspectCommand}. */
export interface RunInspectCommandOptions {
  /** Arguments after `arcturn inspect`, e.g. `["owner/repo", "--json"]`. */
  argv: readonly string[];
  /** Working directory for resolving a relative local-path source. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Arcturn user directory; only its `packages/` is touched, and only for staging. */
  home?: string;
  stdout?: RegistryWriter;
  stderr?: RegistryWriter;
  /** Injectable `git` runner, for tests. */
  exec?: GitExecFn;
}

/**
 * `arcturn inspect <source> [--name <name>] [--json]` — stage a package, print
 * what installing it would add, and install nothing. Exit code `0` on success,
 * `1` when the source could not be staged, `2` on a usage error.
 *
 * `--json` emits the {@link PackageDisclosure} itself, unwrapped and
 * pretty-printed. It is the machine contract this command exists to provide:
 * the hub at arcturn.dev renders its listing pages from this shape, and a
 * future `arcturn search` reads the same one back, so the page a person reads
 * and the command they run cannot drift apart.
 *
 * @param options - See {@link RunInspectCommandOptions}.
 */
export async function runInspectCommand(options: RunInspectCommandOptions): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const parsed = parseInspectArgv(options.argv);
  if (parsed.error || !parsed.source) {
    stderr(
      `arcturn: ${parsed.error ?? "usage: arcturn inspect <source> [--name <name>] [--json]"}`,
    );
    return 2;
  }
  const paths = registryPathsFromHome(options.home ?? defaultHome());
  let disclosure: PackageDisclosure;
  try {
    disclosure = await inspectPackage({
      source: parsed.source,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      paths,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.exec === undefined ? {} : { exec: options.exec }),
    });
  } catch (error) {
    stderr(`arcturn: ${errorMessage(error)}`);
    return 1;
  }
  if (parsed.json) {
    stdout(JSON.stringify(disclosure, null, 2));
    return 0;
  }
  // Warnings are part of the disclosure, so they print with it on stdout
  // rather than being split off to stderr where a piped read would lose them.
  for (const line of formatInspectReport(disclosure)) stdout(line);
  return 0;
}
