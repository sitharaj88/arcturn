/**
 * PROJECT CODE TRUST — one consent decision covering everything a cloned
 * repository can make this machine execute.
 *
 * `providers.ts` closed the case where a repository declares an *endpoint* in
 * data. Its own module doc names the hole it did not close, and this is that
 * hole: `<cwd>/.arcturn` can put four kinds of executable code in front of a
 * user who did nothing but `git clone` and `cd`.
 *
 * - **hooks** — `config.json`'s `hooks` block. A `sessionStart` hook runs
 *   `$SHELL -c` inside `buildRuntime`, before the user has typed anything.
 * - **verify** — `config.json`'s `verify` command, shelled out after every
 *   successful `write`/`edit`.
 * - **extensions** — `<cwd>/.arcturn/extensions`, `jiti.import`ed at startup.
 * - **MCP servers** — `<cwd>/.arcturn/mcp.json`, connected by `connectMcp`. A
 *   `stdio` entry is a command line this process spawns. An `http` entry is
 *   not a process at all, and is covered anyway — see below.
 *
 * ## Why one decision and not four
 *
 * The four are transitively equivalent. A `sessionStart` hook can write the
 * extensions directory, `mcp.json` and `~/.arcturn/config.json`, so approving
 * any one of them grants the others anyway. Three checkboxes that are secretly
 * one checkbox is worse than one checkbox: it costs the user three decisions
 * and buys them no separation. `registry.ts` states the same doctrine for
 * package installs — "the blast radius sets the gate, not the mechanism".
 *
 * ## The trust store is user-scope, and has no project twin
 *
 * Consent lives in `~/.arcturn/trust.json` ({@link ArcturnPaths.trust}), which
 * is deliberately the ONE entry in `ArcturnPaths` with no `<cwd>/.arcturn`
 * analogue. It is not a config layer: not merged, not scoped, not taggable.
 * That deletes a whole class of bug by construction — `parseRule` lets a
 * project file label a rule `scope: "user"`, so `providers.ts` has to read the
 * user config file by hand to keep a hostile repo from granting itself consent
 * (see its `userProviderRules`). Nothing can tag a trust record at all, so
 * there is nothing here to hand-roll around.
 *
 * Records store **counts, never the attacker-controlled command strings**. The
 * surface is re-derived from disk on every launch anyway, so storing the text
 * would buy nothing and would mean every future reader of this file had to
 * sanitise it. A missing, unreadable or corrupt `trust.json` reads as "no
 * consent on record" and never as a crash, mirroring `readLayer`'s posture.
 *
 * ## The digest: declarations for hooks/verify/MCP, CONTENTS for extensions
 *
 * A grant is content-addressed: it covers the project *as it was*, so a repo
 * that later grows a hook has to ask again. The digest is one canonical,
 * versioned, sorted blob (see {@link projectSurfaceDigest}).
 *
 * Extension files are hashed **recursively over every regular file**, not just
 * the entry points `discoverExtensionFiles` returns: an `index.ts` importing a
 * changed `helpers.ts` must re-ask. Symlinks hash as their target *string* and
 * are never followed.
 *
 * The asymmetry with hooks is deliberate. An extension entry IS the code, so
 * hashing it is a real guarantee. A hook command is a *pointer into a shell*
 * whose eventual payload is undecidable — `eval $(cat x)`, `$TOOL/bin/y`, PATH
 * order — so this module does **not** attempt best-effort path extraction from
 * hook commands. Its failure mode would be false coverage: a prompt implying
 * it had hashed what will run when it had hashed one spelling of one pointer.
 * That is the exact ragged guarantee the providers post-mortem punished
 * (`apiKeyEnv` was "the first name in a chain, not the only one"). The consent
 * prompt carries the limitation in words instead.
 *
 * The consequence, which is a property to preserve rather than an accident:
 * editing `src/**`, `README.md`, `.arcturn/skills/*.md`, `.arcturn/agents/*.md`
 * or the config's `model`/`route`/`theme` does NOT re-ask. Adding or editing a
 * hook, ANY file under `extensions/`, `verify`, or an MCP server of either
 * transport does. Changing a server's TRANSPORT at the same name re-asks too:
 * the digest carries `stdio` and `http` entries as different line kinds, so a
 * trusted `stdio` entry cannot quietly become egress to a URL. A gate that
 * re-asks for nothing gets clicked through, so the no-noise property is itself
 * a security property (`taint.ts` makes the same argument about false
 * positives) — which is also why the `stdio` line kept its exact original
 * spelling when `http` was added, rather than re-asking every project on earth
 * for a change that affected none of them.
 *
 * ## Why an `http` MCP server is on this list
 *
 * `registry.ts` gates `stdio` servers a *package* installs and deliberately
 * does not gate `http` ones: "an `http` server is not on this list: it is
 * egress to a URL the disclosure already prints, not a process on this
 * machine." That premise is true there and false here, twice over.
 *
 * First, "the disclosure already prints it" is a statement about a person
 * running `arcturn add` and reading the output. Nobody reads a cloned repo's
 * `mcp.json`; that is the entire threat model of this file.
 *
 * Second, the consequence is worse than plain egress. Connecting to an MCP
 * server puts its tool NAMES AND DESCRIPTIONS — attacker-written prose — into
 * the model's tool list, which is a prompt-injection surface with no filter in
 * front of it, and every argument the model then passes to one of those tools
 * is sent to that host, conversation content included. The blast radius sets
 * the gate, not the mechanism; the mechanism here is a socket rather than a
 * process, and the blast radius is not smaller for it.
 *
 * A `stdio` entry is still shown as a command line and an `http` entry as a
 * URL plus the headers it would send, because those are what the two decisions
 * actually are. Header values are shown **verbatim and unexpanded**: a value
 * like `Bearer ${GITHUB_TOKEN}` is the interesting half of the disclosure, and
 * expanding it would print the user's real credential into a terminal and hash
 * it into a digest.
 *
 * ## Fail-open case, written down rather than discovered later
 *
 * An **untagged** hook or verify entry — one built in code by an embedder or a
 * test rather than parsed from a project file — reads as TRUSTED. Only
 * `parseConfigFile` mints `scope: "project"`. This is defensible because code
 * that calls `buildRuntime` with a hand-built config is already trusted code
 * running in this process; it is also why the blast radius on the existing test
 * suite is small. It is a real decision, not an oversight, and it is stated
 * here so a later reader does not "fix" it into a cries-wolf gate.
 *
 * ## What this gate deliberately does NOT cover
 *
 * - **User-layer hooks, verify, extensions and MCP servers.** `~/.arcturn` is
 *   the user's own directory. Gating it is the cries-wolf failure.
 * - **Packages installed by `arcturn add`.** Already gated at install time by
 *   `registry.ts`'s `executableCodeGate`.
 * - **Project *data*** — skills, agents, memory, themes, `ARCTURN.md`. Those
 *   are untrusted *content*, and `skill-tool.ts`'s `isTrusted` already handles
 *   them with the right mechanism. This gate must not swallow that one.
 * - **What an approved server later becomes.** The digest pins the
 *   *declaration* — a URL, a command line — not the thing on the other end. An
 *   approved host may serve different tools tomorrow, exactly as an approved
 *   hook command may invoke a file whose contents changed. Same limitation,
 *   stated the same way, for the same reason: a guarantee the prompt implies
 *   but does not have is worse than none.
 * - **The case `paths.project === paths.home`.** Running from `~` means there
 *   is no project layer at all (`loadConfig` skips it), so there is nothing to
 *   ask about and this must not prompt.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultCaseInsensitivePaths } from "@arcturn/core";
import type { ArcturnConfig } from "./config.js";
import type { HookEvent } from "./hooks.js";
import type { ArcturnPaths, EnvMap } from "./paths.js";

/** Version tag of both the digest blob and the on-disk trust file. */
export const PROJECT_TRUST_VERSION = 1;

/** Environment variable that grants trust for one invocation. */
export const TRUST_PROJECT_ENV = "ARCTURN_TRUST_PROJECT";

/**
 * Ceiling on files walked under `<cwd>/.arcturn/extensions`.
 *
 * A hostile repository can otherwise make startup walk an arbitrarily large
 * tree. Tripping the cap sets {@link ProjectCodeSurface.truncated}, which
 * suppresses stored-digest matching entirely: past the cap the digest is no
 * longer a complete statement of the contents, so it may never stand in for
 * one. Such a project re-asks on every launch, which is the correct nuisance.
 */
export const MAX_EXTENSION_FILES = 2000;

/** Ceiling on directory depth walked under the extensions directory. */
const MAX_EXTENSION_DEPTH = 32;

/** One project-declared lifecycle hook, as the consent prompt shows it. */
export interface ProjectHookSurface {
  readonly event: HookEvent;
  readonly command: string;
  readonly matcher?: string;
  readonly timeoutMs?: number;
}

/** The project-declared verify command, as the consent prompt shows it. */
export interface ProjectVerifySurface {
  readonly command: string;
  readonly globs: readonly string[];
  readonly runOn: "edit" | "manual";
}

/** One file under `<cwd>/.arcturn/extensions`, and what it hashed to. */
export interface ProjectExtensionFile {
  /** Path relative to the extensions directory, `/`-separated. */
  readonly path: string;
  /**
   * `sha256:<hex>` of the bytes for a regular file, `symlink:<target>` for a
   * symbolic link (recorded by target STRING, never followed), or `other` for
   * anything else (fifo, socket, device).
   */
  readonly hash: string;
}

/** One project-declared `stdio` MCP server: a command line this machine spawns. */
export interface ProjectStdioMcpSurface {
  readonly transport: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Sorted `KEY=value` pairs, verbatim from the file (never expanded). */
  readonly env: readonly string[];
  readonly cwd?: string;
}

/**
 * One project-declared `http` MCP server: egress to a URL the repository chose.
 *
 * Not a process on this machine, and gated anyway. See the module doc: the
 * `arcturn add` reasoning it used to inherit — "egress to a URL the disclosure
 * already prints" — does not survive the move to a cloned checkout, because
 * nobody reads a cloned repo's `mcp.json`, and because the consequence is
 * worse than plain egress. The host's tool NAMES AND DESCRIPTIONS are placed
 * in the model's tool list, and every argument the model passes to one of them
 * is sent there, conversation content included.
 */
export interface ProjectHttpMcpSurface {
  readonly transport: "http";
  readonly name: string;
  /** The URL verbatim from the file — `${ENV}` references are NOT expanded. */
  readonly url: string;
  /**
   * Sorted `Name: value` pairs, verbatim from the file (never expanded).
   *
   * Shown rather than hidden, and by value rather than by name alone. These
   * headers are the repository's, not the user's, and they are half of what is
   * being approved: `Authorization: Bearer ${GITHUB_TOKEN}` says which of the
   * user's secrets this host would be handed. Expanding is the thing that must
   * not happen — that would print the real credential and put it in a digest —
   * and it is exactly what {@link readProjectMcpServers} refuses to do.
   */
  readonly headers: readonly string[];
  /** `"oauth"` when the entry asks for the OAuth authorization-code flow. */
  readonly auth?: "oauth";
}

/** One project-declared MCP server of any transport, as the prompt shows it. */
export type ProjectMcpSurface = ProjectStdioMcpSurface | ProjectHttpMcpSurface;

/** How many of each kind of executable thing a project declares. */
export interface ProjectCodeCounts {
  readonly hook: number;
  readonly verify: number;
  readonly extension: number;
  readonly mcp: number;
}

/** Everything a project would run, and the digest that pins it. */
export interface ProjectCodeSurface {
  /** Absolute, resolved working directory this surface belongs to. */
  readonly cwd: string;
  /** `<cwd>/.arcturn`. */
  readonly dir: string;
  /** `<cwd>/.arcturn/config.json` — declares the hooks and the verify command. */
  readonly configFile: string;
  /** `<cwd>/.arcturn/extensions`. */
  readonly extensionsDir: string;
  /** `<cwd>/.arcturn/mcp.json`. */
  readonly mcpFile: string;
  readonly hooks: readonly ProjectHookSurface[];
  readonly verify?: ProjectVerifySurface;
  readonly extensionFiles: readonly ProjectExtensionFile[];
  readonly mcpServers: readonly ProjectMcpSurface[];
  readonly counts: ProjectCodeCounts;
  /** `sha256:<hex>` over the canonical blob. See the module doc. */
  readonly digest: string;
  /** Whether the project declares nothing this gate covers. */
  readonly empty: boolean;
  /** Whether the extension walk hit {@link MAX_EXTENSION_FILES} or the depth cap. */
  readonly truncated: boolean;
  /** Non-fatal problems collecting the surface (unreadable mcp.json, ...). */
  readonly warnings: readonly string[];
}

/**
 * Approve or decline running everything one project declares.
 *
 * There is deliberately no safe default that returns `true`: every call site
 * defaults an absent confirmer to a hard `() => false`, the doctrine
 * `registry.ts` and `providers.ts` both state for executable code.
 */
export type ConfirmProjectTrust = (surface: ProjectCodeSurface) => Promise<boolean> | boolean;

/** One project's recorded decision in `~/.arcturn/trust.json`. */
export interface ProjectTrustRecord {
  /** The {@link ProjectCodeSurface.digest} the decision was made against. */
  readonly digest: string;
  readonly decision: "allow" | "deny";
  /** ISO 8601 instant, for a human reading the file. */
  readonly decidedAt: string;
  /** What was on offer, by kind. Never the commands themselves. */
  readonly counts: ProjectCodeCounts;
}

/** Why {@link resolveProjectTrust} decided what it decided. */
export type ProjectTrustReason =
  | "no-project-layer"
  | "nothing-declared"
  | "disabled"
  | "recorded-allow"
  | "recorded-deny"
  | "flag"
  | "config-trusted-projects"
  | "approved"
  | "declined"
  | "not-approved";

/** The decision `buildRuntime` enforces and `connectMcp` later reads. */
export interface ProjectTrustResult {
  readonly surface: ProjectCodeSurface;
  /** Whether this project's hooks, verify, extensions and MCP servers run. */
  readonly allowed: boolean;
  readonly reason: ProjectTrustReason;
  /** Whether a confirmer was actually called. */
  readonly asked: boolean;
  /** Lines for `runtime.warnings`. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Path keying
// ---------------------------------------------------------------------------

/**
 * The key one project's record is stored under.
 *
 * The absolute resolved path, exactly as {@link cwdHash} settles it, so a
 * relative `--cwd`, a trailing slash or a Windows drive-relative spelling all
 * land on one record instead of silently minting a second.
 */
export function trustKey(cwd: string): string {
  return resolve(cwd);
}

/** Whether two path spellings name the same directory on this filesystem. */
function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  if (a === b) return true;
  return caseInsensitive && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether the arcturn home sits inside the working directory.
 *
 * `ARCTURN_HOME` is ordinarily the one place a repository cannot reach, which
 * is the whole reason the trust store lives there. Point it inside the checkout
 * — a sandbox, a test harness, a `--cwd` that contains every project on the
 * machine — and that stops being true: `trust.json` and `config.json` become
 * files the repository can ship, so a hostile checkout could arrive with its
 * own approval already recorded and never ask anybody anything.
 *
 * The answer is NOT to refuse: pointing the home inside a scratch tree is what
 * every sandboxed run and every end-to-end test legitimately does, and breaking
 * it would trade a contrived attack for a real outage. Instead a recorded ALLOW
 * from such a store is not honoured (a recorded DENY still is — that direction
 * is fail-safe), the weaker `trustedProjects` opt-in is ignored, and the run
 * says so. `--trust-project` and the interactive prompt still work, because
 * both are gestures a person made outside the repository.
 *
 * `mcp-serve.ts` makes the same call for the same configuration, and says so
 * out loud rather than silently narrowing.
 */
function homeInsideProject(paths: ArcturnPaths): boolean {
  const home = resolve(paths.home);
  const cwd = resolve(paths.cwd);
  if (samePath(home, cwd, defaultCaseInsensitivePaths())) return true;
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  return defaultCaseInsensitivePaths()
    ? home.toLowerCase().startsWith(prefix.toLowerCase())
    : home.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// Surface collection
// ---------------------------------------------------------------------------

/** `true` when a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk `<cwd>/.arcturn/extensions` and hash every regular file in it.
 *
 * Recursive on purpose (see the module doc): the entry point is not the whole
 * of the code it imports. Symlinks are recorded by target string and never
 * followed, so neither a link out of the tree nor a cycle can steer this walk.
 */
async function hashExtensionTree(
  root: string,
  warnings: string[],
): Promise<{ files: ProjectExtensionFile[]; truncated: boolean }> {
  const files: ProjectExtensionFile[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > MAX_EXTENSION_DEPTH) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Missing directory is the common case, and means "no extensions".
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_EXTENSION_FILES) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await readlink(full);
        } catch {
          target = "(unreadable)";
        }
        files.push({ path: rel, hash: `symlink:${target}` });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        files.push({ path: rel, hash: "other" });
        continue;
      }
      try {
        const bytes = await readFile(full);
        files.push({
          path: rel,
          hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        });
      } catch (error) {
        warnings.push(
          `${full} could not be read while checking this project's extensions ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
        files.push({ path: rel, hash: "unreadable" });
      }
    }
  };

  await walk(root, 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, truncated };
}

/** Sorted `<key><sep><value>` pairs from a string-valued record, verbatim. */
function pairs(value: unknown, separator: string): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((pair): pair is [string, string] => typeof pair[1] === "string")
    .map(([key, val]) => `${key}${separator}${val}`)
    .sort();
}

/**
 * Read the project's `mcp.json`, both transports.
 *
 * Parsed here rather than through `@arcturn/mcp`'s `loadMcpConfig` for two
 * reasons: that function throws on an unset `${ENV_VAR}` (a hostile repo could
 * make the gate itself fail), and it *expands* env references, which would put
 * the user's secrets into a digest for no benefit. The raw declaration is also
 * the more faithful thing to show and to hash — it is what the file says.
 *
 * `stdio` AND `http` entries are both collected. See the module doc for why
 * the `registry.ts` line that once excluded `http` does not hold here.
 */
async function readProjectMcpServers(
  file: string,
  warnings: string[],
): Promise<ProjectMcpSurface[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // `connectMcp` reports the parse failure properly; here it only means
    // "nothing provable to consent to", which is the safe reading.
    warnings.push(`${file} is not valid JSON; its MCP servers were not offered for approval`);
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.servers)) return [];
  const out: ProjectMcpSurface[] = [];
  for (const [name, value] of Object.entries(parsed.servers)) {
    if (!isRecord(value)) continue;
    if (value.type === "stdio") {
      if (typeof value.command !== "string" || value.command.length === 0) continue;
      const args = Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      out.push({
        transport: "stdio",
        name,
        command: value.command,
        args,
        env: pairs(value.env, "="),
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      });
      continue;
    }
    if (value.type === "http") {
      if (typeof value.url !== "string" || value.url.length === 0) continue;
      out.push({
        transport: "http",
        name,
        url: value.url,
        headers: pairs(value.headers, ": "),
        ...(value.auth === "oauth" ? { auth: "oauth" as const } : {}),
      });
    }
  }
  // Sorted by transport then name, so the digest cannot depend on key order
  // and two entries of different transports at one name never collide.
  out.sort((a, b) =>
    a.transport !== b.transport
      ? a.transport < b.transport
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  return out;
}

/**
 * The canonical blob a surface's digest is taken over.
 *
 * One line per declared thing, `\0` between fields so no value can forge a
 * field boundary, every line sorted so `readdir` order and config key order
 * cannot change the digest, and a leading version tag so a future change to
 * this format invalidates old grants instead of silently reinterpreting them.
 *
 * Exported for the unit tests, which pin the ordering rules.
 */
export function projectSurfaceBlob(surface: {
  hooks: readonly ProjectHookSurface[];
  verify?: ProjectVerifySurface | undefined;
  extensionFiles: readonly ProjectExtensionFile[];
  mcpServers: readonly ProjectMcpSurface[];
  truncated?: boolean;
}): string {
  const lines: string[] = [];
  for (const hook of surface.hooks) {
    lines.push(
      `hook ${hook.event}\0${hook.command}\0${hook.matcher ?? ""}\0${hook.timeoutMs ?? ""}`,
    );
  }
  if (surface.verify) {
    lines.push(
      `verify ${surface.verify.command}\0${surface.verify.globs.join("\0")}\0${surface.verify.runOn}`,
    );
  }
  for (const file of surface.extensionFiles) {
    lines.push(`ext ${file.path}\0${file.hash}`);
  }
  for (const server of surface.mcpServers) {
    // Two line KINDS, not a transport field inside one kind, so that flipping
    // `stdio` → `http` at the same name changes the blob and re-asks.
    //
    // The `stdio` line is byte-identical to the one that shipped, deliberately:
    // extending this gate to cover `http` must not invalidate the grant of
    // every project that only ever had `stdio` servers. A gate that re-asks for
    // nothing gets clicked through, which is the property the module doc calls
    // a security property in its own right.
    lines.push(
      server.transport === "stdio"
        ? `mcp ${server.name}\0${server.command}\0${server.args.join("\0")}\0` +
            `${server.env.join("\0")}\0${server.cwd ?? ""}`
        : `mcp-http ${server.name}\0${server.url}\0${server.headers.join("\0")}\0` +
            `${server.auth ?? ""}`,
    );
  }
  if (surface.truncated === true) lines.push("truncated");
  lines.sort();
  return [`v${PROJECT_TRUST_VERSION}`, ...lines].join("\n");
}

/** `sha256:<hex>` over {@link projectSurfaceBlob}. */
export function projectSurfaceDigest(surface: Parameters<typeof projectSurfaceBlob>[0]): string {
  return `sha256:${createHash("sha256").update(projectSurfaceBlob(surface), "utf8").digest("hex")}`;
}

/**
 * Derive everything this project would execute, from disk and the merged config.
 *
 * Hooks and the verify command are taken from the MERGED config filtered to
 * `scope === "project"`, because that is the only place the layering is already
 * resolved; `parseConfigFile` is the only thing that mints that tag.
 *
 * @param options - Resolved paths plus the merged config.
 */
export async function collectProjectCodeSurface(options: {
  paths: ArcturnPaths;
  config: Pick<ArcturnConfig, "hooks" | "verify">;
}): Promise<ProjectCodeSurface> {
  const { paths, config } = options;
  const warnings: string[] = [];

  const hooks: ProjectHookSurface[] = [];
  const events: readonly HookEvent[] = ["preToolUse", "postToolUse", "sessionStart", "runEnd"];
  for (const event of events) {
    for (const def of config.hooks?.[event] ?? []) {
      if (def.scope !== "project") continue;
      hooks.push({
        event,
        command: def.command,
        ...(def.matcher === undefined ? {} : { matcher: def.matcher }),
        ...(def.timeoutMs === undefined ? {} : { timeoutMs: def.timeoutMs }),
      });
    }
  }

  const verify: ProjectVerifySurface | undefined =
    config.verify && config.verify.scope === "project"
      ? {
          command: config.verify.command,
          globs: config.verify.globs ?? [],
          runOn: config.verify.runOn ?? "edit",
        }
      : undefined;

  const { files: extensionFiles, truncated } = await hashExtensionTree(
    paths.projectExtensions,
    warnings,
  );
  const mcpServers = await readProjectMcpServers(paths.projectMcp, warnings);

  const counts: ProjectCodeCounts = {
    hook: hooks.length,
    verify: verify ? 1 : 0,
    extension: extensionFiles.length,
    mcp: mcpServers.length,
  };
  const empty =
    counts.hook === 0 && counts.verify === 0 && counts.extension === 0 && counts.mcp === 0;

  return {
    cwd: trustKey(paths.cwd),
    dir: paths.project,
    configFile: paths.projectConfig,
    extensionsDir: paths.projectExtensions,
    mcpFile: paths.projectMcp,
    hooks,
    ...(verify === undefined ? {} : { verify }),
    extensionFiles,
    mcpServers,
    counts,
    digest: projectSurfaceDigest({ hooks, verify, extensionFiles, mcpServers, truncated }),
    empty,
    truncated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The trust store
// ---------------------------------------------------------------------------

function parseCounts(raw: unknown): ProjectCodeCounts {
  const counted = (value: unknown): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  const record = isRecord(raw) ? raw : {};
  return {
    hook: counted(record.hook),
    verify: counted(record.verify),
    extension: counted(record.extension),
    mcp: counted(record.mcp),
  };
}

/**
 * Read `~/.arcturn/trust.json`.
 *
 * Every failure — missing, unreadable, not JSON, not an object, wrong version,
 * a malformed entry — reads as "no consent on record". A corrupt trust file
 * must never crash a launch, and must never be read as an approval.
 */
export async function readProjectTrustStore(
  file: string,
): Promise<Map<string, ProjectTrustRecord>> {
  const out = new Map<string, ProjectTrustRecord>();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;
  if (parsed.version !== PROJECT_TRUST_VERSION) return out;
  if (!isRecord(parsed.projects)) return out;
  for (const [key, value] of Object.entries(parsed.projects)) {
    if (!isRecord(value)) continue;
    const { digest, decision, decidedAt } = value;
    if (typeof digest !== "string" || digest === "") continue;
    if (decision !== "allow" && decision !== "deny") continue;
    out.set(key, {
      digest,
      decision,
      decidedAt: typeof decidedAt === "string" ? decidedAt : "",
      counts: parseCounts(value.counts),
    });
  }
  return out;
}

/** The record for one directory, honouring this filesystem's case policy. */
export function lookupTrustRecord(
  store: ReadonlyMap<string, ProjectTrustRecord>,
  cwd: string,
  caseInsensitive: boolean = defaultCaseInsensitivePaths(),
): ProjectTrustRecord | undefined {
  const key = trustKey(cwd);
  const exact = store.get(key);
  if (exact) return exact;
  if (!caseInsensitive) return undefined;
  for (const [stored, record] of store) {
    if (samePath(stored, key, true)) return record;
  }
  return undefined;
}

/**
 * Write one project's decision, preserving every other project's.
 *
 * Written via a sibling temp file and `rename` so an interrupted write cannot
 * leave a half-file that the next launch reads as "no consent" — which would be
 * safe, but would silently drop every other project's grant too.
 */
export async function writeProjectTrustDecision(
  file: string,
  cwd: string,
  record: ProjectTrustRecord,
): Promise<void> {
  const store = await readProjectTrustStore(file);
  const key = trustKey(cwd);
  // Drop any case-variant spelling so one directory never holds two records.
  const caseInsensitive = defaultCaseInsensitivePaths();
  for (const stored of [...store.keys()]) {
    if (stored !== key && samePath(stored, key, caseInsensitive)) store.delete(stored);
  }
  store.set(key, record);
  await writeTrustStore(file, store);
}

/** Forget one project's decision. Returns whether there was one to forget. */
export async function revokeProjectTrust(file: string, cwd: string): Promise<boolean> {
  const store = await readProjectTrustStore(file);
  const key = trustKey(cwd);
  const caseInsensitive = defaultCaseInsensitivePaths();
  let removed = false;
  for (const stored of [...store.keys()]) {
    if (samePath(stored, key, caseInsensitive)) {
      store.delete(stored);
      removed = true;
    }
  }
  if (removed) await writeTrustStore(file, store);
  return removed;
}

async function writeTrustStore(
  file: string,
  store: ReadonlyMap<string, ProjectTrustRecord>,
): Promise<void> {
  const projects: Record<string, ProjectTrustRecord> = {};
  for (const key of [...store.keys()].sort()) {
    const record = store.get(key);
    if (record) projects[key] = record;
  }
  const body = `${JSON.stringify({ version: PROJECT_TRUST_VERSION, projects }, null, 2)}\n`;
  const temp = join(dirname(file), `.trust.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, body, "utf8");
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// trustedProjects (user layer only)
// ---------------------------------------------------------------------------

/**
 * `trustedProjects` as written in the USER config file, and nowhere else.
 *
 * Read directly from `~/.arcturn/config.json` rather than from the merged
 * config for exactly the reason `providers.ts` reads its rules that way: a
 * project file that could contribute here would be granting itself trust.
 * `parseConfigFile` also warns and drops the key from a project layer, so the
 * two halves agree and the user is told when a repo tried.
 */
export async function userTrustedProjects(paths: ArcturnPaths): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.userConfig, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const raw = parsed.trustedProjects;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/**
 * Whether a `trustedProjects` pattern covers a directory.
 *
 * Two shapes only, kept deliberately dull: an exact directory, or a pattern
 * ending in `/*`, which covers that directory and everything beneath it at any
 * depth. This is the weaker, NON-content-addressed opt-in — it approves a path,
 * so whatever that path later contains runs — and it is documented as such.
 */
export function trustedProjectMatches(
  pattern: string,
  cwd: string,
  caseInsensitive: boolean = defaultCaseInsensitivePaths(),
): boolean {
  const target = trustKey(cwd);
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  if (trimmed.endsWith("/*") || trimmed.endsWith(`${sep}*`)) {
    const root = resolve(trimmed.slice(0, -2));
    if (samePath(root, target, caseInsensitive)) return true;
    const prefix = root.endsWith(sep) ? root : root + sep;
    return caseInsensitive
      ? target.toLowerCase().startsWith(prefix.toLowerCase())
      : target.startsWith(prefix);
  }
  return samePath(resolve(trimmed), target, caseInsensitive);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Options for {@link resolveProjectTrust}. */
export interface ResolveProjectTrustOptions {
  /** Resolved layout; `paths.trust` is the store and `paths.cwd` the key. */
  readonly paths: ArcturnPaths;
  /** The merged configuration, for its `scope`-tagged hooks and verify. */
  readonly config: Pick<ArcturnConfig, "hooks" | "verify">;
  /** Asks the user. Absent means `() => false`. */
  readonly confirm?: ConfirmProjectTrust;
  /**
   * `--trust-project` / `ARCTURN_TRUST_PROJECT=1`: run this project's code
   * without asking, for a pipeline that already trusts the checkout.
   * Deliberately NOT persisted — a per-invocation decision must not silently
   * become a standing grant.
   */
  readonly trustProject?: boolean;
  /**
   * `--no-project-code`: collect and list the surface, run none of it, and ask
   * nothing. The `--no-providers` analogue.
   */
  readonly enable?: boolean;
  /** Environment, for {@link TRUST_PROJECT_ENV}. Defaults to `process.env`. */
  readonly env?: EnvMap;
  /** Pre-collected surface, when a caller already has one (the `trust` command). */
  readonly surface?: ProjectCodeSurface;
}

/**
 * Decide whether this project's code may run, asking at most once.
 *
 * Called by `buildRuntime` as its FIRST side-effecting step — before
 * `registerConfiguredProviders`, and therefore long before extensions load,
 * hooks are wired, the verifier is built, `sessionStart` fires or `connectMcp`
 * spawns anything.
 */
export async function resolveProjectTrust(
  options: ResolveProjectTrustOptions,
): Promise<ProjectTrustResult> {
  const { paths, config } = options;
  const env = options.env ?? process.env;

  // Running from `~` means `<cwd>/.arcturn` IS `~/.arcturn`: there is no
  // project layer (`loadConfig` skips it) and nothing to ask about.
  if (paths.project === paths.home) {
    const surface = emptySurface(paths);
    return { surface, allowed: true, reason: "no-project-layer", asked: false, warnings: [] };
  }

  const surface = options.surface ?? (await collectProjectCodeSurface({ paths, config }));
  const warnings = [...surface.warnings];

  if (surface.empty) {
    return { surface, allowed: true, reason: "nothing-declared", asked: false, warnings };
  }

  if (options.enable === false) {
    warnings.push(projectCodeDisabledWarning(surface));
    return { surface, allowed: false, reason: "disabled", asked: false, warnings };
  }

  // See {@link homeInsideProject}: when the store is inside the tree it
  // authorises, a recorded APPROVAL is something the repository could have
  // written, so it is not one.
  const selfWritable = homeInsideProject(paths);

  const store = await readProjectTrustStore(paths.trust);
  const record = lookupTrustRecord(store, paths.cwd);
  // A stored digest may only stand in for the contents when the walk actually
  // covered them; see MAX_EXTENSION_FILES.
  if (record && !surface.truncated && record.digest === surface.digest) {
    if (record.decision === "deny") {
      warnings.push(projectCodeRefusalWarning(surface, paths, "recorded-deny"));
      return { surface, allowed: false, reason: "recorded-deny", asked: false, warnings };
    }
    if (!selfWritable) {
      return { surface, allowed: true, reason: "recorded-allow", asked: false, warnings };
    }
    warnings.push(
      `${paths.trust} records an approval for this project, but it sits INSIDE ${paths.cwd} — ` +
        "a file this project can write. It is being ignored. Point ARCTURN_HOME outside the " +
        "checkout, or pass --trust-project if you already trust it.",
    );
  }

  if (options.trustProject === true || env[TRUST_PROJECT_ENV] === "1") {
    return { surface, allowed: true, reason: "flag", asked: false, warnings };
  }

  const patterns = await userTrustedProjects(paths);
  if (patterns.some((pattern) => trustedProjectMatches(pattern, paths.cwd))) {
    if (!selfWritable) {
      return { surface, allowed: true, reason: "config-trusted-projects", asked: false, warnings };
    }
    warnings.push(
      `${paths.userConfig} lists this directory in "trustedProjects", but it sits INSIDE ` +
        `${paths.cwd} — a file this project can write. It is being ignored.`,
    );
  }

  const confirm = options.confirm ?? ((): boolean => false);
  const approved = await confirm(surface);
  if (approved) {
    try {
      await writeProjectTrustDecision(paths.trust, paths.cwd, {
        digest: surface.digest,
        decision: "allow",
        decidedAt: new Date().toISOString(),
        counts: surface.counts,
      });
    } catch (error) {
      warnings.push(
        "this project's code was approved for this session but the approval could not be " +
          `saved to ${paths.trust}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { surface, allowed: true, reason: "approved", asked: true, warnings };
  }

  // A declined prompt is NOT persisted as a deny: an accidental "n" must not
  // become a standing refusal the user cannot find. `arcturn trust --deny` is
  // the deliberate gesture for that.
  const asked = options.confirm !== undefined;
  warnings.push(projectCodeRefusalWarning(surface, paths, asked ? "declined" : "not-approved"));
  return {
    surface,
    allowed: false,
    reason: asked ? "declined" : "not-approved",
    asked,
    warnings,
  };
}

/** A surface for a directory that has no project layer at all. */
function emptySurface(paths: ArcturnPaths): ProjectCodeSurface {
  return {
    cwd: trustKey(paths.cwd),
    dir: paths.project,
    configFile: paths.projectConfig,
    extensionsDir: paths.projectExtensions,
    mcpFile: paths.projectMcp,
    hooks: [],
    extensionFiles: [],
    mcpServers: [],
    counts: { hook: 0, verify: 0, extension: 0, mcp: 0 },
    digest: projectSurfaceDigest({ hooks: [], extensionFiles: [], mcpServers: [] }),
    empty: true,
    truncated: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Rendering — every string below is attacker-written
// ---------------------------------------------------------------------------

/**
 * Strip everything a terminal would obey from a repository-authored string.
 *
 * The consent prompt prints commands, matchers, server names, arguments, env
 * pairs and filenames, and a cloned repository chose all of them. An adversarial
 * pass found exactly this bug in the providers prompt
 * (`security-review-4.test.ts`), where a `baseUrl` carrying `ESC [ 2 J` could
 * erase the screen and repaint a dialog naming a host the user trusts. Complete
 * escape sequences are removed first (so their payload does not survive as
 * literal noise), then every remaining C0/DEL/C1 code point becomes a space —
 * a space rather than nothing, so `rm -rf<NL>/` cannot render as `rm -rf/`.
 */
export function sanitizeForTerminal(value: string): string {
  const ESC = 0x1b;
  const BEL = 0x07;
  const C1_CSI = 0x9b;
  const C1_OSC = 0x9d;
  const C1_ST = 0x9c;
  const isControl = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  // Written as a scanner rather than four regexes because Biome forbids a
  // control character inside a regex literal — and `config.ts` reaches for
  // `charCodeAt` for the same reason in `hasControlCharacter`.
  let out = "";
  let i = 0;
  const skipCsi = (from: number): number => {
    let j = from;
    while (j < value.length) {
      const code = value.charCodeAt(j);
      // Parameter bytes 0x30-0x3f, then intermediates 0x20-0x2f, then one
      // final byte 0x40-0x7e which ends the sequence.
      if (code >= 0x30 && code <= 0x3f) j++;
      else if (code >= 0x20 && code <= 0x2f) j++;
      else return code >= 0x40 && code <= 0x7e ? j + 1 : j;
    }
    return j;
  };
  const skipOsc = (from: number): number => {
    let j = from;
    while (j < value.length) {
      const code = value.charCodeAt(j);
      if (code === BEL || code === C1_ST) return j + 1;
      if (code === ESC && value.charCodeAt(j + 1) === 0x5c) return j + 2;
      j++;
    }
    return j;
  };
  while (i < value.length) {
    const code = value.charCodeAt(i);
    if (code === ESC) {
      const next = value.charCodeAt(i + 1);
      if (next === 0x5b) i = skipCsi(i + 2);
      else if (next === 0x5d) i = skipOsc(i + 2);
      else i += Number.isNaN(next) ? 1 : 2;
      continue;
    }
    if (code === C1_CSI) {
      i = skipCsi(i + 1);
      continue;
    }
    if (code === C1_OSC) {
      i = skipOsc(i + 1);
      continue;
    }
    // A space, not nothing: dropping the byte would render `rm -rf<LF>/` as
    // `rm -rf/`, which is a different and more dangerous command.
    out += isControl(code) ? " " : value[i];
    i++;
  }
  return out;
}

/** Longest repository-authored string printed before it is cut. */
export const MAX_DISPLAYED_COMMAND_CHARS = 400;

/** Longest list of entries printed under one heading before it is cut. */
export const MAX_DISPLAYED_ENTRIES = 20;

/** Sanitise and cut one repository-authored string. */
function display(value: string, max = MAX_DISPLAYED_COMMAND_CHARS): string {
  const clean = sanitizeForTerminal(value);
  return clean.length <= max ? clean : `${clean.slice(0, max)}… (truncated)`;
}

/**
 * `2 hooks, 1 verify command, 3 extension files and 1 MCP server`.
 *
 * Only non-zero kinds appear: a prompt that says "0 MCP servers" is a prompt
 * that trained its reader to skim.
 */
export function describeProjectCodeCounts(counts: ProjectCodeCounts): string {
  const parts: string[] = [];
  if (counts.hook > 0) parts.push(`${counts.hook} hook${counts.hook === 1 ? "" : "s"}`);
  if (counts.verify > 0) parts.push("1 verify command");
  if (counts.extension > 0) {
    parts.push(`${counts.extension} extension file${counts.extension === 1 ? "" : "s"}`);
  }
  if (counts.mcp > 0) parts.push(`${counts.mcp} MCP server${counts.mcp === 1 ? "" : "s"}`);
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** `hooks, verify command, extensions and MCP servers`, for the refusal line. */
function describeProjectCodeKinds(counts: ProjectCodeCounts): string {
  const parts: string[] = [];
  // Always plural: these nouns feed a sentence ending in "are NOT running",
  // so the noun-verb agreement must hold even when the count is one.
  if (counts.hook > 0) parts.push("hooks");
  if (counts.verify > 0) parts.push("verify command");
  if (counts.extension > 0) parts.push("extensions");
  if (counts.mcp > 0) parts.push("MCP servers");
  if (parts.length === 0) return "project code";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Append a list, cut at {@link MAX_DISPLAYED_ENTRIES} with a pointer to the file. */
function pushEntries(lines: string[], entries: readonly string[], source: string): void {
  for (const entry of entries.slice(0, MAX_DISPLAYED_ENTRIES)) lines.push(`    ${entry}`);
  const hidden = entries.length - MAX_DISPLAYED_ENTRIES;
  if (hidden > 0) {
    // Never a bare ellipsis: an elided list must say it is elided and say
    // where the rest is, or it reads as a complete inventory.
    lines.push(`    … and ${hidden} more (truncated; read ${source} before answering)`);
  }
}

/**
 * The whole consent prompt, as a string.
 *
 * Pure and exported so the tests can assert on exactly what a terminal would
 * receive without owning one.
 */
export function renderProjectTrustPrompt(surface: ProjectCodeSurface): string {
  return [
    "",
    "This project wants to run code on your machine.",
    "",
    ...renderProjectCodeInventory(surface),
    "  Approving runs all of it as you, every time arcturn starts here — hooks before",
    "  you have typed anything. Commands run through your shell, so Arcturn cannot see",
    "  what the files they invoke will contain later.",
    ...remoteMcpNote(surface),
    "",
  ].join("\n");
}

/**
 * The extra sentence an `http` MCP server earns, when there is one.
 *
 * Only when there is one: a prompt that explains a risk the project does not
 * take is the same "0 MCP servers" mistake {@link describeProjectCodeCounts}
 * avoids, and it trains its reader to skim.
 */
function remoteMcpNote(surface: ProjectCodeSurface): string[] {
  if (!surface.mcpServers.some((server) => server.transport === "http")) return [];
  return [
    "",
    "  An http server is not a process on this machine, but approving one puts tool names",
    "  and descriptions THAT HOST WRITES into the model's tool list, and sends it whatever",
    "  the model passes to those tools — your conversation included.",
  ];
}

/**
 * Every command and file the project declares, grouped by the file that
 * declared it — the body of both the consent prompt and `arcturn trust --list`.
 *
 * EVERY string placed here was written by the repository: commands, matchers,
 * globs, server names, arguments, env pairs and filenames all come from a
 * cloned checkout. They go through {@link sanitizeForTerminal} and a length cap
 * without exception. See that function for the attack this is answering.
 */
export function renderProjectCodeInventory(surface: ProjectCodeSurface): string[] {
  const lines: string[] = [
    `  ${display(surface.dir, 200)} declares ${describeProjectCodeCounts(surface.counts)}.`,
    "",
  ];

  if (surface.hooks.length > 0) {
    lines.push(`  hooks — from ${display(surface.configFile, 200)}`);
    pushEntries(
      lines,
      surface.hooks.map((hook) => {
        const matcher = hook.matcher === undefined ? "" : `  (tools: ${display(hook.matcher, 80)})`;
        return `${hook.event}  ${display(hook.command)}${matcher}`;
      }),
      display(surface.configFile, 200),
    );
    lines.push("");
  }

  if (surface.verify) {
    lines.push(`  verify command — from ${display(surface.configFile, 200)}`);
    const when =
      surface.verify.runOn === "manual"
        ? "on request"
        : surface.verify.globs.length === 0
          ? "after every write or edit"
          : `after a write or edit matching ${display(surface.verify.globs.join(", "), 120)}`;
    lines.push(`    ${display(surface.verify.command)}  (${when})`);
    lines.push("");
  }

  if (surface.extensionFiles.length > 0) {
    lines.push(`  extension files — loaded from ${display(surface.extensionsDir, 200)}`);
    pushEntries(
      lines,
      surface.extensionFiles.map((file) => display(file.path, 200)),
      display(surface.extensionsDir, 200),
    );
    lines.push("");
  }

  if (surface.mcpServers.length > 0) {
    lines.push(`  MCP servers — from ${display(surface.mcpFile, 200)}`);
    pushEntries(
      lines,
      surface.mcpServers.map((server) => {
        const name = display(server.name, 80);
        if (server.transport === "stdio") {
          const env = server.env.length === 0 ? "" : `  [${display(server.env.join(" "), 160)}]`;
          return `${name}  (stdio)  ${display([server.command, ...server.args].join(" "))}${env}`;
        }
        // The URL is the whole decision for an http entry, and the headers say
        // which of the user's secrets this host would be handed — both are the
        // repository's text and both go through `display`.
        const headers =
          server.headers.length === 0 ? "" : `  [${display(server.headers.join("  "), 160)}]`;
        const auth = server.auth === "oauth" ? "  (asks you to authorize via OAuth)" : "";
        return `${name}  (http)  ${display(server.url)}${headers}${auth}`;
      }),
      display(surface.mcpFile, 200),
    );
    lines.push("");
  }

  if (surface.truncated) {
    lines.push(
      `  This project has more than ${MAX_EXTENSION_FILES} extension files, so the list above`,
      "  is incomplete and no approval of it can be remembered. Read the directory yourself.",
      "",
    );
  }
  return lines;
}

/**
 * The warning a run owes when this project's code was not approved.
 *
 * Loud and unconditional, because disabling a project's hooks can remove a
 * PROTECTIVE one — a `preToolUse` guard the repository's authors added on
 * purpose — not only an offensive one. Silence here is a security regression
 * disguised as tidiness.
 *
 * Returned without an `arcturn: ` prefix: every caller adds one.
 */
export function projectCodeRefusalWarning(
  surface: ProjectCodeSurface,
  paths: ArcturnPaths,
  reason: "declined" | "not-approved" | "recorded-deny",
): string {
  const why =
    reason === "recorded-deny"
      ? `They were denied for this directory; \`arcturn trust --revoke\` forgets that.`
      : reason === "declined"
        ? "You declined them just now."
        : "Nothing has approved them, and a non-interactive run has nobody to ask.";
  return [
    `this project's ${describeProjectCodeKinds(surface.counts)} are NOT running.`,
    `  ${surface.dir} declares ${describeProjectCodeCounts(surface.counts)}.`,
    `  ${why} Your own ${paths.home} hooks and extensions are unaffected.`,
    "  To approve: run arcturn interactively here once, or `arcturn trust --allow`, or pass",
    `  --trust-project (${TRUST_PROJECT_ENV}=1) from a pipeline that already trusts this`,
    "  checkout. To see what would run: `arcturn trust --list`.",
  ].join("\n");
}

/** The quieter note for `--no-project-code`, which the user asked for. */
export function projectCodeDisabledWarning(surface: ProjectCodeSurface): string {
  return (
    `--no-project-code is on, so this project's ${describeProjectCodeKinds(surface.counts)} ` +
    `are not running (${surface.dir} declares ${describeProjectCodeCounts(surface.counts)}).`
  );
}

/**
 * Fail-closed default confirmer for real terminal use.
 *
 * Returns `false` outright when stdin is not a TTY: a `--print` run, a pipe, a
 * CI job, `serve`, `acp`, `mcp-serve`, a background agent and an eval cannot
 * give informed consent, and guessing on their behalf is precisely the
 * execution this gate exists to stop.
 *
 * `erase` lets the caller take down `main.ts`'s boot banner before the first
 * byte lands: `runCli` erases it only *after* `buildRuntime` returns, so
 * without this the prompt paints over the banner (the providers prompt has
 * this bug today).
 */
export async function terminalProjectTrustConfirm(
  surface: ProjectCodeSurface,
  io: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    erase?: () => void;
  } = {},
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  io.erase?.();
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    output.write(renderProjectTrustPrompt(surface));
    const answer = await rl.question("Run this project's code? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// `arcturn trust` and `/trust`
// ---------------------------------------------------------------------------

/** What `arcturn trust` / `/trust` was asked to do. */
export type TrustCommandAction = "status" | "allow" | "deny" | "revoke" | "list";

/** Options for {@link runTrustCommand}. */
export interface RunTrustCommandOptions {
  readonly action: TrustCommandAction;
  /** `--cwd`; defaults to the process's own directory. */
  readonly cwd?: string;
  /** User root override. Defaults to `$ARCTURN_HOME` or `~/.arcturn`. */
  readonly home?: string;
  /** Where the report goes. Defaults to stdout. */
  readonly out?: (line: string) => void;
  /** Where problems go. Defaults to stderr. */
  readonly err?: (line: string) => void;
}

/**
 * The line every state-changing verb owes.
 *
 * A previous release shipped `/permissions suggest` saying "Saved" while the
 * live agent went on prompting for exactly what had just been approved —
 * saving is not applying, and a message that conflates them is a lie the user
 * only finds out about later. Nothing re-reads `trust.json` mid-session and
 * nothing re-imports an extension into a running process, so this says when
 * the change takes effect in the same breath as saying it was saved.
 */
const NEXT_LAUNCH_NOTE =
  "This takes effect the NEXT time arcturn starts in this directory — nothing is " +
  "loaded or unloaded in a session that is already running.";

/**
 * Implement `arcturn trust [--allow|--deny|--revoke|--list]`.
 *
 * @returns The process exit code.
 */
export async function runTrustCommand(options: RunTrustCommandOptions): Promise<number> {
  const out = options.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const { loadConfig } = await import("./config.js");
  const { config, paths } = await loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.home === undefined ? {} : { home: options.home }),
  });

  if (paths.project === paths.home) {
    out(`${paths.cwd} has no project layer of its own (its .arcturn IS ${paths.home}).`);
    out("There is nothing here to trust or refuse.");
    return 0;
  }

  const surface = await collectProjectCodeSurface({ paths, config });
  for (const warning of surface.warnings) err(`arcturn: ${warning}`);

  const store = await readProjectTrustStore(paths.trust);
  const record = lookupTrustRecord(store, paths.cwd);
  const current =
    record === undefined
      ? "never asked"
      : record.digest !== surface.digest
        ? `${record.decision === "allow" ? "allowed" : "denied"} for DIFFERENT contents ` +
          `(decided ${record.decidedAt || "at an unknown time"}) — it will ask again`
        : `${record.decision === "allow" ? "allowed" : "denied"} ` +
          `(decided ${record.decidedAt || "at an unknown time"})`;

  switch (options.action) {
    case "list":
    case "status": {
      out(`Project:  ${paths.cwd}`);
      out(`Declares: ${describeProjectCodeCounts(surface.counts)}`);
      out(`Decision: ${current}`);
      out(`Recorded in ${paths.trust}`);
      if (surface.empty) {
        out("");
        out("Nothing here runs project code, so nothing is gated.");
        return 0;
      }
      if (options.action === "list") {
        out("");
        for (const line of renderProjectCodeInventory(surface)) out(line);
        out("  Commands run through your shell, so Arcturn cannot see what the files they");
        out("  invoke will contain later.");
      } else {
        out("");
        out("Run `arcturn trust --list` to see exactly what would run.");
      }
      return 0;
    }
    case "allow":
    case "deny": {
      if (surface.empty) {
        err("arcturn: this project declares no hooks, verify command, extensions or MCP servers.");
        return 2;
      }
      try {
        await writeProjectTrustDecision(paths.trust, paths.cwd, {
          digest: surface.digest,
          decision: options.action,
          decidedAt: new Date().toISOString(),
          counts: surface.counts,
        });
      } catch (error) {
        err(
          `arcturn: could not write ${paths.trust}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
      out(
        options.action === "allow"
          ? `Approved: ${paths.cwd} may run its own ${describeProjectCodeCounts(surface.counts)}.`
          : `Refused: ${paths.cwd} may not run its own code.`,
      );
      out(`Saved to ${paths.trust}. ${NEXT_LAUNCH_NOTE}`);
      if (options.action === "allow") {
        out(
          "The approval covers these exact contents: changing a hook, the verify command, " +
            "any file under the extensions directory, or an MCP server — its transport " +
            "included — asks again.",
        );
      }
      return 0;
    }
    case "revoke": {
      const removed = await revokeProjectTrust(paths.trust, paths.cwd);
      out(
        removed
          ? `Forgot the decision recorded for ${paths.cwd}.`
          : `No decision was recorded for ${paths.cwd}; nothing to forget.`,
      );
      if (removed) out(NEXT_LAUNCH_NOTE);
      return 0;
    }
  }
}
