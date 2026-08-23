/** The `glob` built-in tool: find files by glob pattern via tinyglobby. */

import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { glob as tinyGlob } from "tinyglobby";
import { resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

const MAX_RESULTS = 500;

export interface GlobToolDetails {
  matchCount: number;
  truncated: boolean;
}

/** Create the `glob` tool. No permission is required (read-only). */
export function createGlobTool(): Tool {
  return {
    definition: {
      name: "glob",
      description:
        `Find files matching one or more glob patterns (e.g. '**/*.ts'), sorted by most recently ` +
        `modified first. Skips .git and node_modules. Capped at ${MAX_RESULTS} results.`,
      parameters: {
        type: "object",
        properties: {
          pattern: {
            description: "A glob pattern, or array of glob patterns, to match files against.",
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          path: {
            type: "string",
            description:
              "Base directory to search from, absolute or relative to the working directory. Defaults to cwd.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      let patterns: string[];
      if (typeof input.pattern === "string" && input.pattern.length > 0) {
        patterns = [input.pattern];
      } else if (
        Array.isArray(input.pattern) &&
        input.pattern.length > 0 &&
        input.pattern.every((p) => typeof p === "string")
      ) {
        patterns = input.pattern as string[];
      } else {
        return errorResult(
          "`pattern` is required and must be a non-empty string or array of strings.",
        );
      }

      const root = resolvePath(ctx.cwd, typeof input.path === "string" ? input.path : ".");

      let matches: string[];
      try {
        matches = await tinyGlob(patterns, {
          cwd: root,
          absolute: true,
          dot: true,
          ignore: ["**/.git/**", "**/node_modules/**"],
          signal: ctx.signal,
        });
      } catch (error) {
        if (ctx.signal.aborted) return abortedResult();
        return errorResult(`Glob failed: ${(error as Error).message}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const withMtime = await Promise.all(
        matches.map(async (path) => {
          try {
            const s = await stat(path);
            return { path, mtimeMs: s.mtimeMs };
          } catch {
            return { path, mtimeMs: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const truncated = withMtime.length > MAX_RESULTS;
      const capped = withMtime.slice(0, MAX_RESULTS);
      const relPaths = capped.map((m) => relative(ctx.cwd, m.path) || m.path);

      const details: GlobToolDetails = { matchCount: withMtime.length, truncated };
      let text = relPaths.length > 0 ? relPaths.join("\n") : "No files matched.";
      if (truncated) {
        text += `\n\n[Truncated: showing first ${MAX_RESULTS} of ${withMtime.length} matches.]`;
      }
      return textResult(text, details as unknown as Record<string, unknown>);
    },
  };
}
