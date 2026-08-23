/** The `write` built-in tool: create or overwrite a file, requesting permission first. */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

export interface WriteToolDetails {
  path: string;
  created: boolean;
  bytes: number;
}

/** Create the `write` tool. Always requests permission before touching disk. */
export function createWriteTool(): Tool {
  return {
    definition: {
      name: "write",
      description:
        "Write content to a file, creating it (and any missing parent directories) if it does not " +
        "exist, or overwriting it if it does. Requires user permission before writing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path to the file to write, absolute or relative to the working directory.",
          },
          content: {
            type: "string",
            description: "The full text content to write to the file.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const rawPath = input.path;
      const content = input.content;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return errorResult("`path` is required and must be a non-empty string.");
      }
      if (typeof content !== "string") {
        return errorResult("`content` is required and must be a string.");
      }

      const absolutePath = resolvePath(ctx.cwd, rawPath);
      const parentDir = dirname(absolutePath);

      let created = true;
      try {
        await stat(absolutePath);
        created = false;
      } catch {
        created = true;
      }

      const decision = await ctx.requestPermission({
        toolName: "write",
        toolCallId: ctx.toolCallId,
        subject: absolutePath,
        description: `${created ? "Create" : "Overwrite"} file ${absolutePath}`,
        suggestedRule: { tool: "write", specifier: `${parentDir}/**`, action: "allow" },
      });
      if (decision.behavior !== "allow") {
        return errorResult(decision.message ?? `Permission denied to write ${absolutePath}.`);
      }
      if (ctx.signal.aborted) return abortedResult();

      try {
        await mkdir(parentDir, { recursive: true });
        await writeFile(absolutePath, content, "utf8");
      } catch (error) {
        return errorResult(`Failed to write ${absolutePath}: ${(error as Error).message}`);
      }

      const bytes = Buffer.byteLength(content, "utf8");
      const details: WriteToolDetails = { path: absolutePath, created, bytes };
      return textResult(
        `${created ? "Created" : "Updated"} ${absolutePath} (${bytes} bytes).`,
        details as unknown as Record<string, unknown>,
      );
    },
  };
}
