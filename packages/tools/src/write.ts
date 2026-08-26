/** The `write` built-in tool: create or overwrite a file, requesting permission first. */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { resolvePath, resolveSubjectPath } from "./path-utils.js";
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

      // The permission subject must name where the bytes will actually land,
      // not where the argument's spelling suggests: `writeFile` follows a
      // symlink, and a link inside the workspace pointing outside it would
      // otherwise present a subject that an `allow write <workspace>/**` rule
      // happily matches. See `resolveSubjectPath`.
      const subjectPath = await resolveSubjectPath(ctx.cwd, absolutePath);
      const viaNote = subjectPath === absolutePath ? "" : ` (via ${absolutePath})`;
      const decision = await ctx.requestPermission({
        toolName: "write",
        toolCallId: ctx.toolCallId,
        subject: subjectPath,
        description: `${created ? "Create" : "Overwrite"} file ${subjectPath}${viaNote}`,
        suggestedRule: { tool: "write", specifier: `${dirname(subjectPath)}/**`, action: "allow" },
      });
      if (decision.behavior !== "allow") {
        return errorResult(decision.message ?? `Permission denied to write ${subjectPath}.`);
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
      // Say where the bytes went whenever that is not where the path pointed.
      // A symlink is invisible in the argument, so `Updated <workspace>/x.txt`
      // would otherwise be the only thing a model ever learns about a write
      // that landed somewhere else entirely.
      const landedNote =
        subjectPath === absolutePath ? "" : ` The file it resolves to is ${subjectPath}.`;
      return textResult(
        `${created ? "Created" : "Updated"} ${absolutePath} (${bytes} bytes).${landedNote}`,
        details as unknown as Record<string, unknown>,
      );
    },
  };
}
