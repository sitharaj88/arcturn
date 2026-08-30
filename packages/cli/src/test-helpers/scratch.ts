/** Temp-directory helpers shared by the CLI tests. Excluded from the build. */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EnvMap } from "../paths.js";
import { type ArcturnRuntime, type BuildRuntimeOptions, buildRuntime } from "../runtime.js";
import { fakeLLM, type ScriptedTurn } from "./fake-llm.js";

/** An isolated `$ARCTURN_HOME` plus project directory. */
export interface Scratch {
  /** Root of the scratch tree. */
  root: string;
  /** Directory used as `~/.arcturn`. */
  home: string;
  /** Directory used as the project working directory. */
  cwd: string;
  /** Environment with a fake Anthropic key so model resolution succeeds. */
  env: EnvMap;
}

/** Create an isolated home/project pair. */
export async function makeScratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-cli-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { root, home, cwd, env: { ANTHROPIC_API_KEY: "test-key" } };
}

/**
 * Write a file inside a scratch tree, creating parent directories.
 *
 * @param path - Absolute file path.
 * @param content - File body.
 */
export async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * Build a runtime backed by a scripted LLM, with MCP and extensions disabled.
 *
 * @param scratch - The scratch tree to run in.
 * @param turns - Scripted model turns.
 * @param overrides - Extra {@link BuildRuntimeOptions}.
 */
export async function buildTestRuntime(
  scratch: Scratch,
  turns: readonly ScriptedTurn[] = [{ text: "done" }],
  overrides: BuildRuntimeOptions = {},
): Promise<ArcturnRuntime> {
  return buildRuntime({
    cwd: scratch.cwd,
    home: scratch.home,
    env: scratch.env,
    llm: fakeLLM(turns),
    extensions: false,
    skipRepoLookup: true,
    // A scripted client's turns belong to the test: the fire-and-forget
    // session-title call must not consume one or race an assertion. Titling
    // tests opt back in via overrides (or a config file, which wins anyway).
    sessionTitles: false,
    ...overrides,
  });
}
