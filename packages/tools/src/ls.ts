/** The `ls` built-in tool: list a directory's contents. */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

const MAX_ENTRIES = 500;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface LsToolDetails {
  path: string;
  entryCount: number;
  truncated: boolean;
}

/** Create the `ls` tool. No permission is required (read-only). */
export function createLsTool(): Tool {
  return {
    definition: {
      name: "ls",
      description:
        `List the contents of a directory. Directories are suffixed with "/"; files show their size. ` +
        `Sorted with directories first, then alphabetically. Capped at ${MAX_ENTRIES} entries.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory to list, absolute or relative to the working directory. Defaults to cwd.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const dirPath = resolvePath(ctx.cwd, typeof input.path === "string" ? input.path : ".");

      let dirEntries: Dirent[];
      try {
        dirEntries = await readdir(dirPath, { withFileTypes: true });
      } catch (error) {
        return errorResult(`Cannot list directory: ${dirPath}. ${(error as Error).message}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const entries: Entry[] = await Promise.all(
        dirEntries.map(async (entry): Promise<Entry> => {
          const isDir = entry.isDirectory();
          let size = 0;
          if (!isDir) {
            try {
              size = (await stat(join(dirPath, entry.name))).size;
            } catch {
              size = 0;
            }
          }
          return { name: entry.name, isDir, size };
        }),
      );

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const truncated = entries.length > MAX_ENTRIES;
      const capped = entries.slice(0, MAX_ENTRIES);
      const lines = capped.map((e) =>
        e.isDir ? `${e.name}/` : `${e.name}  (${formatSize(e.size)})`,
      );

      const details: LsToolDetails = { path: dirPath, entryCount: entries.length, truncated };
      let text = lines.length > 0 ? lines.join("\n") : "(empty directory)";
      if (truncated) {
        text += `\n\n[Truncated: showing first ${MAX_ENTRIES} of ${entries.length} entries.]`;
      }
      return textResult(text, details as unknown as Record<string, unknown>);
    },
  };
}
