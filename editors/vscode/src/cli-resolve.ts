/**
 * Pure half of CLI provisioning: where the `arcturn` binary could be, whether
 * the one we found is new enough, and what to type to get a newer one.
 *
 * Nothing here touches `vscode`, the filesystem, or a child process — the
 * caller injects those (see `cli.ts`). That is what makes every rule in this
 * file, including the Windows shim ordering and the prerelease comparison,
 * testable without a running editor.
 */

import { posix as posixPath, win32 as win32Path } from "node:path";

/** The npm package that publishes the engine. Also the bare command name. */
export const CLI_PACKAGE = "arcturn";

/**
 * The oldest engine this extension is willing to drive.
 *
 * Bump it only when the extension actually starts depending on something the
 * older engine cannot do; every bump nags every user who is behind it.
 *
 * 0.4.0, because the panel now speaks verbs no earlier engine answers: session
 * replay and delete, setPermissionMode, editor context, the slash commands,
 * rewind and the workflow and background-agent listings. Against 0.3.0 the
 * panel still opens — the nag is a warning, never a block — but its history
 * comes back empty, the permission chip cannot change anything and the command
 * menu is bare. Better to say so once than to let it read as breakage.
 */
export const MIN_ENGINE_VERSION = "0.4.0";

/**
 * Executable names to probe, in order, for a platform.
 *
 * `npm install -g arcturn` on Windows writes three files: `arcturn` (a sh
 * script), `arcturn.cmd`, and `arcturn.ps1`. The extension-less one is the
 * trap — it exists, so a naive "does this file exist" probe finds it, and
 * neither cmd.exe nor PowerShell can execute it. Probing `.cmd` first means
 * the hit we return is always something the shell can actually run.
 */
export function cliExecutableNames(platform: NodeJS.Platform): string[] {
  if (platform === "win32")
    return [`${CLI_PACKAGE}.cmd`, `${CLI_PACKAGE}.exe`, `${CLI_PACKAGE}.bat`];
  return [CLI_PACKAGE];
}

/** Everything {@link findCliOnPath} needs from the outside world. */
export interface PathProbe {
  /** The raw `PATH` environment variable, or `undefined` when it is unset. */
  readonly pathVar: string | undefined;
  /** Host platform — decides the separator, the join, and the names probed. */
  readonly platform: NodeJS.Platform;
  /** Returns true when the candidate exists and can be executed. */
  readonly isExecutable: (candidate: string) => boolean;
}

/**
 * Walk `PATH` for the engine binary and return the first runnable hit.
 *
 * Entries are visited in order because that is the order the user's shell
 * would resolve them in: an extension that launched a different `arcturn`
 * than `arcturn` in the terminal would be a very confusing bug to chase.
 */
export function findCliOnPath(probe: PathProbe): string | undefined {
  if (probe.pathVar === undefined || probe.pathVar === "") return undefined;
  const isWindows = probe.platform === "win32";
  const path = isWindows ? win32Path : posixPath;
  const entries = probe.pathVar.split(isWindows ? ";" : ":");
  const names = cliExecutableNames(probe.platform);
  for (const raw of entries) {
    // Windows PATH entries are sometimes written quoted; the quotes are shell
    // syntax, not part of the directory name.
    const dir = isWindows ? raw.replace(/^"(.*)"$/, "$1") : raw;
    if (dir.trim() === "") continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (probe.isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Turn the `arcturn.cliPath` setting into a path, or `undefined` when it is
 * effectively unset.
 *
 * A settings UI writes `""` for "I cleared this", and people paste paths with
 * trailing spaces. Both have to mean "fall back to PATH" rather than "look
 * for a binary named empty string".
 */
export function normalizeCliPathSetting(
  raw: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return undefined;
  const path = platform === "win32" ? win32Path : posixPath;
  if (trimmed === "~") return home;
  const tildePrefix =
    trimmed.startsWith("~/") || (platform === "win32" && trimmed.startsWith("~\\"));
  if (tildePrefix) return path.join(home, trimmed.slice(2));
  return trimmed;
}

const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/**
 * Pull a version out of whatever `arcturn --version` wrote.
 *
 * Today it prints a bare `0.2.0`, but a shim, a wrapper script, or a future
 * banner could decorate it. Returning `undefined` for unparseable output is
 * deliberate: see {@link isOutdated}.
 */
export function parseVersionOutput(raw: string): string | undefined {
  const match = VERSION_PATTERN.exec(raw);
  return match?.[1];
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  // A release outranks any prerelease of the same numbers: 0.3.0 > 0.3.0-rc.1.
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : undefined;
    const rn = /^\d+$/.test(r) ? Number(r) : undefined;
    if (ln !== undefined && rn !== undefined) {
      if (ln !== rn) return ln < rn ? -1 : 1;
      continue;
    }
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function splitVersion(v: string): { core: string; pre: string | undefined } {
  const dash = v.indexOf("-");
  if (dash === -1) return { core: v, pre: undefined };
  return { core: v.slice(0, dash), pre: v.slice(dash + 1) };
}

/** Semver-ish ordering: negative when `a` is older, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const aParts = left.core.split(".");
  const bParts = right.core.split(".");
  for (let i = 0; i < 3; i++) {
    const l = Number(aParts[i] ?? 0);
    const r = Number(bParts[i] ?? 0);
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

/**
 * Should we offer an upgrade?
 *
 * An unreadable version answers `false`. Not knowing what is installed is not
 * evidence that it is old, and a nag aimed at someone already up to date is
 * the kind of thing people disable the extension over.
 */
export function isOutdated(current: string | undefined, minimum: string): boolean {
  if (current === undefined) return false;
  return compareVersions(current, minimum) < 0;
}

/**
 * The exact line typed into the user's terminal.
 *
 * `@latest` on the upgrade path matters: without it npm sees a satisfied
 * global install and does nothing, and the user watches a no-op scroll by.
 */
export function installCommand(kind: "install" | "upgrade"): string {
  return kind === "upgrade"
    ? `npm install -g ${CLI_PACKAGE}@latest`
    : `npm install -g ${CLI_PACKAGE}`;
}

/** Where a resolved binary came from — shown to the user when things go wrong. */
export type CliSource = "setting" | "path";

/** The engine binary, located. Mirrored by `ResolvedCli` in `cli.ts`. */
export interface CliLocation {
  readonly command: string;
  readonly source: CliSource;
}

/** The outcome of a lookup, with enough detail to write an honest message. */
export type CliDecision =
  | { readonly kind: "found"; readonly cli: CliLocation }
  | {
      readonly kind: "missing";
      readonly reason: "setting-not-executable" | "not-on-path";
      readonly configured?: string;
    };

/** Everything {@link decideCli} needs from the outside world. */
export interface CliLookup extends PathProbe {
  /** `arcturn.cliPath`, already normalized by {@link normalizeCliPathSetting}. */
  readonly configured: string | undefined;
}

/**
 * Decide which binary to run, or why we cannot.
 *
 * A configured path that is not executable is a hard miss, not a reason to
 * try PATH. Falling back would run a *different* engine than the one the user
 * named — a version, a worktree, a debug build — and nothing on screen would
 * say so.
 */
export function decideCli(lookup: CliLookup): CliDecision {
  if (lookup.configured !== undefined) {
    if (lookup.isExecutable(lookup.configured)) {
      return { kind: "found", cli: { command: lookup.configured, source: "setting" } };
    }
    return { kind: "missing", reason: "setting-not-executable", configured: lookup.configured };
  }
  const onPath = findCliOnPath(lookup);
  if (onPath !== undefined) return { kind: "found", cli: { command: onPath, source: "path" } };
  return { kind: "missing", reason: "not-on-path" };
}

/**
 * Appended to the "not found" notification when the login-shell probe failed.
 *
 * Without it the message is misleading on exactly the machine where it matters
 * most: a GUI-launched editor searching `launchd`'s `PATH` will not find a
 * binary in `/opt/homebrew/bin` no matter how correctly it is installed, and
 * "not found on your PATH" reads as a claim about the user's shell rather than
 * about the four directories the editor actually looked in.
 */
export const SHELL_ENV_FALLBACK_NOTE =
  "Arcturn could not read your login shell's environment, so it searched only the PATH VS Code " +
  "itself was started with — which on a Dock- or Spotlight-launched editor does not include " +
  "Homebrew or a version manager.";

/**
 * The one notification the user gets when the engine is not there.
 *
 * @param decision - Why the lookup missed.
 * @param shellEnvFellBack - Whether the login-shell probe failed, in which
 *   case the PATH that was searched is not the user's own.
 */
export function describeMissingCli(
  decision: Extract<CliDecision, { kind: "missing" }>,
  shellEnvFellBack = false,
): string {
  const note = shellEnvFellBack ? ` ${SHELL_ENV_FALLBACK_NOTE}` : "";
  if (decision.reason === "setting-not-executable") {
    return `Arcturn: the arcturn.cliPath setting points at "${decision.configured}", which is not an executable file.${note}`;
  }
  return `Arcturn: the ${CLI_PACKAGE} CLI was not found on your PATH.${note}`;
}

/** The upgrade nag. Both numbers are named so the user can check the claim. */
export function describeUpgrade(current: string, minimum: string): string {
  return `Arcturn: the installed ${CLI_PACKAGE} CLI is ${current}; this extension needs ${minimum} or newer.`;
}
