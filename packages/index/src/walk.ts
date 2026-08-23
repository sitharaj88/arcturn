/**
 * Repository traversal: which files are worth indexing at all.
 *
 * Two ideas here. First, **the walk is a generator**, so a caller can stop it
 * at any file — abort handling is `break`, not a flag checked between phases.
 * Second, **skipping is layered**: a built-in default set that no repository
 * should have to restate (`node_modules/`, lockfiles, images, minified
 * bundles), then the repository's own `.gitignore` files, honored per
 * directory the way git honors them.
 *
 * Directory pruning happens before descent, so an ignored `node_modules/` costs
 * one `readdir` entry rather than a subtree walk.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IgnoreMatcher, parseIgnoreFile } from "./gitignore.js";

/**
 * Patterns skipped for every repository, in gitignore syntax.
 *
 * Build outputs and dependency directories dominate file counts while being
 * the least useful thing an agent could retrieve; lockfiles are enormous and
 * carry no symbols; binary and font assets have no text at all. Skipping them
 * is what keeps the index small enough to load on every search.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  "target/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  ".gradle/",
  ".idea/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".tox/",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.bmp",
  "*.ico",
  "*.svg",
  "*.pdf",
  "*.zip",
  "*.gz",
  "*.bz2",
  "*.xz",
  "*.tar",
  "*.7z",
  "*.rar",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.otf",
  "*.eot",
  "*.mp3",
  "*.mp4",
  "*.mov",
  "*.avi",
  "*.webm",
  "*.wasm",
  "*.so",
  "*.dylib",
  "*.dll",
  "*.exe",
  "*.class",
  "*.jar",
  "*.o",
  "*.a",
  "*.pyc",
  "*.pyo",
  "*.bin",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
];

/** Options for {@link walkRepository}. */
export interface WalkOptions {
  /** Absolute path of the repository root. */
  root: string;
  /** Stops the walk between entries. */
  signal?: AbortSignal;
  /** Honor `.gitignore` files found in the tree. Defaults to true. */
  respectGitignore?: boolean;
  /** Extra gitignore-syntax patterns applied on top of the defaults. */
  extraIgnores?: readonly string[];
  /** Skip the built-in {@link DEFAULT_IGNORE_PATTERNS}. Mainly for tests. */
  skipDefaultIgnores?: boolean;
  /** Stop after this many files. Defaults to 50,000. */
  maxFiles?: number;
}

/** Default ceiling on files walked, so a pathological tree cannot run forever. */
export const DEFAULT_MAX_FILES = 50_000;

/** Join two repo-relative POSIX path segments. */
function relJoin(base: string, name: string): string {
  return base.length === 0 ? name : `${base}/${name}`;
}

/**
 * Yield every indexable file under `root`, as a repo-relative POSIX path, in
 * directory order.
 *
 * Unreadable directories are skipped silently: a permission error deep in a
 * tree must degrade the index, not fail the search.
 */
export async function* walkRepository(options: WalkOptions): AsyncGenerator<string> {
  const { root, signal } = options;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const respectGitignore = options.respectGitignore !== false;

  const base = new IgnoreMatcher();
  if (!options.skipDefaultIgnores) base.add(DEFAULT_IGNORE_PATTERNS);
  if (options.extraIgnores) base.add(options.extraIgnores);

  let emitted = 0;

  /** Depth-first walk of one directory, carrying the ignore matchers in scope. */
  async function* walkDir(
    relative: string,
    matchers: readonly IgnoreMatcher[],
  ): AsyncGenerator<string> {
    if (signal?.aborted || emitted >= maxFiles) return;

    let entries: Dirent[];
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }

    let scoped = matchers;
    if (respectGitignore && entries.some((entry) => entry.name === ".gitignore")) {
      try {
        const contents = await readFile(join(root, relative, ".gitignore"), "utf8");
        const local = new IgnoreMatcher().add(parseIgnoreFile(contents), relative);
        if (!local.isEmpty) scoped = [...matchers, local];
      } catch {
        // An unreadable .gitignore just does not apply.
      }
    }

    const ignored = (path: string, isDirectory: boolean): boolean =>
      scoped.some((matcher) => matcher.ignores(path, isDirectory));

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (signal?.aborted || emitted >= maxFiles) return;
      const path = relJoin(relative, entry.name);
      if (entry.isDirectory()) {
        if (ignored(path, true)) continue;
        yield* walkDir(path, scoped);
      } else if (entry.isFile()) {
        if (ignored(path, false)) continue;
        emitted++;
        yield path;
      }
      // Symlinks are deliberately not followed: a self-referential link would
      // walk forever, and a link out of the tree indexes files the agent
      // cannot address by a repo-relative path.
    }
  }

  yield* walkDir("", [base]);
}
