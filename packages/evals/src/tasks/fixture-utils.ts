/** Shared helper for writing a task fixture's files into its workspace. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Write a map of relative paths to file content into `dir`, creating parent
 * directories as needed.
 *
 * @param dir - The task's isolated workspace.
 * @param files - Relative path -> file content.
 */
export async function writeFixtureFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}
