/** The `grep` built-in tool: pure-JS recursive regex content search. */

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { glob as tinyGlob } from "tinyglobby";
import { looksBinary } from "./binary.js";
import { displayPath, resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_MATCHES = 200;

/**
 * Collect every searchable file under `dir`.
 *
 * Symlinks are followed, because the alternative is two different answers from
 * one tool: `readdir` reports a symlinked subdirectory as neither a file nor a
 * directory, so the old walk dropped the whole subtree — while the *same*
 * grep call with a `glob` argument goes through `tinyglobby`, which walks into
 * it. A repo with `docs -> ../shared-docs` was searched or not searched
 * depending on an argument that is only supposed to narrow the search.
 *
 * `seen` holds the realpath of every directory already visited, which both
 * terminates a symlink cycle (`a/loop -> .`) and keeps a subtree reachable by
 * two names from being reported twice.
 */
async function walk(
  dir: string,
  signal: AbortSignal,
  out: string[],
  seen: Set<string>,
): Promise<void> {
  if (signal.aborted) return;
  let canonical: string;
  try {
    canonical = await realpath(dir);
  } catch {
    return;
  }
  if (seen.has(canonical)) return;
  seen.add(canonical);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal.aborted) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, signal, out, seen);
    } else if (entry.isFile()) {
      out.push(full);
    } else if (entry.isSymbolicLink()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      let target: Awaited<ReturnType<typeof stat>>;
      try {
        target = await stat(full);
      } catch {
        continue; // dangling link
      }
      if (target.isDirectory()) await walk(full, signal, out, seen);
      else if (target.isFile()) out.push(full);
    }
  }
}

async function collectFiles(
  root: string,
  rootIsFile: boolean,
  globPattern: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  // A file path names exactly what to search. Without this, walk() calls
  // readdir on it, swallows ENOTDIR, and reports "no matches" — a silent
  // false negative a model reads as evidence of absence. Found by a live
  // watched-fire run in wave 3. A glob cannot narrow a single named file.
  if (rootIsFile) return [root];
  if (globPattern) {
    return tinyGlob(globPattern, {
      cwd: root,
      absolute: true,
      dot: true,
      ignore: ["**/.git/**", "**/node_modules/**"],
      signal,
    });
  }
  const out: string[] = [];
  await walk(root, signal, out, new Set<string>());
  return out;
}

export interface GrepToolDetails {
  matchCount: number;
  filesSearched: number;
  truncated: boolean;
}

/** Create the `grep` tool. No permission is required (read-only). */
export function createGrepTool(): Tool {
  return {
    definition: {
      name: "grep",
      description:
        "Recursively search file contents for a JavaScript regular expression. Skips .git and " +
        `node_modules directories and binary files. Caps output at ${MAX_MATCHES} matches.`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regular expression source to search for (no surrounding slashes).",
          },
          path: {
            type: "string",
            description:
              "File or directory to search, absolute or relative to the working directory. Defaults to cwd.",
          },
          glob: {
            type: "string",
            description: "Optional glob to restrict which files are searched, e.g. '**/*.ts'.",
          },
          caseInsensitive: {
            type: "boolean",
            description: "Match case-insensitively.",
          },
          contextLines: {
            type: "number",
            description:
              "Number of lines of context to include before and after each match. Defaults to 0.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const pattern = input.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        return errorResult("`pattern` is required and must be a non-empty string.");
      }
      const root = resolvePath(ctx.cwd, typeof input.path === "string" ? input.path : ".");
      const globPattern = typeof input.glob === "string" ? input.glob : undefined;
      const caseInsensitive = input.caseInsensitive === true;
      const contextLines =
        typeof input.contextLines === "number" && input.contextLines > 0
          ? Math.floor(input.contextLines)
          : 0;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, caseInsensitive ? "i" : "");
      } catch (error) {
        return errorResult(`Invalid regular expression: ${(error as Error).message}`);
      }

      // A path that is not there is not an absence of matches, it is a
      // question that could not be asked. Answering "No matches found" to a
      // typo'd or renamed path hands the model evidence of absence for a file
      // it never opened — the same silent false negative the file-path case
      // above was fixed for, one level up.
      let rootIsFile: boolean;
      try {
        rootIsFile = (await stat(root)).isFile();
      } catch {
        return errorResult(
          `Cannot search ${root}: no such file or directory. Nothing was searched, so this is ` +
            `not a report that /${pattern}/ is absent. Check the path (relative paths resolve ` +
            `against ${ctx.cwd}).`,
        );
      }

      let files: string[];
      try {
        files = await collectFiles(root, rootIsFile, globPattern, ctx.signal);
      } catch (error) {
        return errorResult(`Failed to search ${root}: ${(error as Error).message}`);
      }
      files.sort();
      if (ctx.signal.aborted) return abortedResult();

      const blocks: string[] = [];
      let matchCount = 0;
      let truncated = false;
      let filesSearched = 0;

      for (const file of files) {
        if (ctx.signal.aborted) return abortedResult();
        if (matchCount >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        let buffer: Buffer;
        try {
          buffer = await readFile(file);
        } catch {
          continue;
        }
        if (looksBinary(buffer)) continue;
        filesSearched++;

        const lines = buffer.toString("utf8").split("\n");
        const relPath = displayPath(ctx.cwd, file);
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= MAX_MATCHES) {
            truncated = true;
            break;
          }
          const line = lines[i] ?? "";
          if (!regex.test(line)) continue;
          matchCount++;
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          const blockLines: string[] = [];
          for (let l = start; l <= end; l++) {
            const marker = l === i ? ":" : "-";
            blockLines.push(`${relPath}${marker}${l + 1}${marker}${lines[l] ?? ""}`);
          }
          blocks.push(blockLines.join("\n"));
        }
      }

      const details: GrepToolDetails = { matchCount, filesSearched, truncated };
      if (matchCount === 0) {
        return textResult(
          `No matches found for /${pattern}/ under ${root}.`,
          details as unknown as Record<string, unknown>,
        );
      }

      let text = blocks.join("\n--\n");
      if (truncated) {
        text += `\n\n[Truncated: showing first ${MAX_MATCHES} matches. Narrow the pattern, path, or glob.]`;
      }
      return textResult(text, details as unknown as Record<string, unknown>);
    },
  };
}
