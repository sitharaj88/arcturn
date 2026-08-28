/**
 * The built-in git extension's API, typed to what this extension uses.
 *
 * This extension spawns exactly one process — `arcturn serve` — and that
 * restraint is worth keeping. The built-in git extension already holds every
 * repository open and answers diffs, logs and the commit input box without a
 * process, a PATH, or a shell. Reached structurally, typed to the members
 * actually used, and its absence degrades to `undefined`: git being disabled
 * is a configuration, not a fault.
 */

import * as vscode from "vscode";

/** One commit, as `repository.log` reports it. */
export interface GitCommitLike {
  readonly message: string;
}

/** The members this extension uses from one repository. */
export interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  /** The Source Control view's message box. */
  readonly inputBox: { value: string };
  /** `cached: true` is the staged diff; `false` the unstaged one. */
  diff(cached: boolean): Promise<string>;
  /** Recent commits, newest first. */
  log(options?: { maxEntries?: number }): Promise<GitCommitLike[]>;
}

/** The slice of the git extension's API this extension uses. */
export interface GitApiLike {
  readonly repositories: readonly GitRepositoryLike[];
}

/** The API, or `undefined` when the git extension is disabled or absent. */
export async function gitApi(): Promise<GitApiLike | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApiLike }>(
    "vscode.git",
  );
  if (extension === undefined) return undefined;
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

/**
 * The repository to act on.
 *
 * The one containing the active editor's file when there is one, the first
 * otherwise. A multi-root workspace with two repositories and no active file
 * is ambiguous, and "the first" is at least predictable — the same answer the
 * SCM view's own ordering gives.
 */
export function repositoryFor(
  api: GitApiLike,
  active: vscode.Uri | undefined,
): GitRepositoryLike | undefined {
  if (active !== undefined) {
    const holder = api.repositories.find((repo) => active.fsPath.startsWith(repo.rootUri.fsPath));
    if (holder !== undefined) return holder;
  }
  return api.repositories[0];
}
