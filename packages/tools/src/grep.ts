/** The `grep` built-in tool: pure-JS recursive regex content search. */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { glob as tinyGlob } from "tinyglobby";
import { displayPath, resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_MATCHES = 200;
const BINARY_SNIFF_BYTES = 8000;

/** Heuristic binary-file detector: a NUL byte in the first few KB. */
function looksBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function walk(dir: string, signal: AbortSignal, out: string[]): Promise<void> {
  if (signal.aborted) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal.aborted) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), signal, out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

async function collectFiles(
  root: string,
  globPattern: string | undefined,
  signal: AbortSignal,
): Promise<string[]> {
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
  await walk(root, signal, out);
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
              "Directory to search, absolute or relative to the working directory. Defaults to cwd.",
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

      let files: string[];
      try {
        files = await collectFiles(root, globPattern, ctx.signal);
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
