/**
 * Filesystem layout for the `arcturn` CLI.
 *
 * Everything Arcturn persists lives under a single user directory (`~/.arcturn` by
 * default, overridable with `ARCTURN_HOME`) plus an optional per-project directory
 * (`<cwd>/.arcturn`). Session transcripts are bucketed by a hash of the working
 * directory so `--continue` only ever sees sessions started in the same place.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultCaseInsensitivePaths } from "@arcturn/core";

/** A read-only environment map. */
export type EnvMap = Record<string, string | undefined>;

/** Options for {@link resolveArcturnPaths}. */
export interface ResolveArcturnPathsOptions {
  /** Project working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** User directory root. Defaults to `$ARCTURN_HOME` or `~/.arcturn`. */
  home?: string;
  /** Environment used to read `ARCTURN_HOME`. Defaults to `process.env`. */
  env?: EnvMap;
}

/** Every path the CLI reads from or writes to. */
export interface ArcturnPaths {
  /** Absolute working directory. */
  readonly cwd: string;
  /** User-scope root, e.g. `~/.arcturn`. */
  readonly home: string;
  /** `~/.arcturn/config.json`. */
  readonly userConfig: string;
  /** `~/.arcturn/mcp.json`. */
  readonly userMcp: string;
  /** `~/.arcturn/extensions`. */
  readonly userExtensions: string;
  /** `~/.arcturn/auth` — one `0600` JSON file per OAuth MCP server, in a `0700` directory. */
  readonly auth: string;
  /** `~/.arcturn/sessions`. */
  readonly sessionsRoot: string;
  /** `~/.arcturn/live-models.json` — cache for live model discovery. */
  readonly liveModelsCache: string;
  /**
   * `~/.arcturn/trust.json` — which projects may run their own code.
   *
   * The ONE entry here with no `<cwd>/.arcturn` twin, and deliberately so.
   * Every other pair below exists because a project may legitimately
   * contribute to it; consent is the one thing a project may never contribute
   * to, so there is no project spelling for a repository to write. Not a
   * config layer either: never merged, never scoped, never tagged. See
   * `project-trust.ts`, and the structural assertion in
   * `security-review-5.test.ts` that keeps a future twin from appearing.
   */
  readonly trust: string;
  /** `<cwd>/.arcturn`. */
  readonly project: string;
  /** `<cwd>/.arcturn/config.json`. */
  readonly projectConfig: string;
  /** `<cwd>/.arcturn/mcp.json`. */
  readonly projectMcp: string;
  /** `<cwd>/.arcturn/extensions`. */
  readonly projectExtensions: string;
  /** Session directory for this working directory. */
  readonly sessions: string;
}

/** Join path segments with POSIX-ish semantics that also work on Windows. */
function join(...segments: string[]): string {
  return resolve(...segments);
}

/** Options for {@link cwdHash}. */
export interface CwdHashOptions {
  /**
   * Whether two spellings of the directory that differ only in case are the
   * same directory. Defaults to `@arcturn/core`'s
   * {@link defaultCaseInsensitivePaths}, which probes the real filesystem.
   */
  readonly caseInsensitive?: boolean;
}

/**
 * Stable short hash of a working directory, used as the session bucket name.
 *
 * The bucket has to answer "is this the same project I ran in before?", so it
 * is keyed the way the filesystem answers that: on a case-insensitive volume
 * (every Windows volume, and macOS as it ships) `Project` and `project` are
 * one directory and get one bucket. Hashing the raw spelling split it in two,
 * so `arcturn --continue` after `cd project` when the session was started from
 * `cd Project` found an empty history — intact, but invisible — and a fresh
 * bucket was created beside it.
 *
 * Case is folded only where the filesystem folds it, so a Linux checkout that
 * really does have two directories differing only in case keeps two buckets.
 *
 * The spelling is settled by {@link resolve} unconditionally, not only when the
 * path looks relative. `path.isAbsolute("/work/repo")` is `true` on Windows and
 * the path is still not a directory: it is rooted on whatever drive the process
 * happens to be on, so `resolve` turns it into `D:\work\repo` — the spelling
 * every caller here passes, since they all get their `cwd` from
 * {@link resolveArcturnPaths}. Trusting `isAbsolute` therefore gave one
 * directory two buckets on Windows depending on how it was spelled, which is
 * the exact defect the case folding below exists to prevent. `resolve` also
 * settles `C:/work/repo` and `/work/repo/` onto the same bucket as
 * `C:\work\repo`, and is the identity on a path that is already settled — so
 * no existing bucket moves.
 *
 * @param cwd - Directory to hash. Resolved to an absolute path first.
 * @param options - Overrides the case policy (for tests, or an unusual mount).
 * @returns 16 lowercase hex characters.
 */
export function cwdHash(cwd: string, options: CwdHashOptions = {}): string {
  const absolute = resolve(cwd);
  const caseInsensitive = options.caseInsensitive ?? defaultCaseInsensitivePaths();
  return createHash("sha256")
    .update(caseInsensitive ? absolute.toLowerCase() : absolute)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Resolve every path the CLI uses.
 *
 * @param options - Working directory, user root and environment overrides.
 */
/**
 * The session bucket for a directory, preferring a pre-existing legacy one.
 *
 * {@link cwdHash} folds case where the filesystem does, which is correct — but
 * it also renames every bucket created before that change. A user with real
 * history would open an existing project and find `--continue` and `--resume`
 * looking at an empty directory: the sessions are intact, just addressed by a
 * name nothing computes any more.
 *
 * So: use the folded name, unless the unfolded one already exists and the
 * folded one does not. New projects get the folded bucket; existing ones keep
 * theirs. That costs one `existsSync` per launch and makes this module
 * filesystem-aware, which is a fair price for not stranding a user's history.
 *
 * @param sessionsRoot - `<home>/sessions`.
 * @param cwd - Absolute working directory.
 */
function sessionBucket(sessionsRoot: string, cwd: string): string {
  const folded = join(sessionsRoot, cwdHash(cwd));
  if (existsSync(folded)) return folded;
  const legacy = join(sessionsRoot, cwdHash(cwd, { caseInsensitive: false }));
  return existsSync(legacy) ? legacy : folded;
}

export function resolveArcturnPaths(options: ResolveArcturnPathsOptions = {}): ArcturnPaths {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? env.ARCTURN_HOME ?? join(homedir(), ".arcturn"));
  const project = join(cwd, ".arcturn");
  const sessionsRoot = join(home, "sessions");

  return {
    cwd,
    home,
    userConfig: join(home, "config.json"),
    userMcp: join(home, "mcp.json"),
    userExtensions: join(home, "extensions"),
    auth: join(home, "auth"),
    sessionsRoot,
    liveModelsCache: join(home, "live-models.json"),
    trust: join(home, "trust.json"),
    project,
    projectConfig: join(project, "config.json"),
    projectMcp: join(project, "mcp.json"),
    projectExtensions: join(project, "extensions"),
    sessions: sessionBucket(sessionsRoot, cwd),
  };
}
