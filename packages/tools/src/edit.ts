/** The `edit` built-in tool: exact string replacement in an existing file. */

import { readFile, stat, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "@arcturn/types";
import { createUnifiedDiff } from "./diff.js";
import { resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

export interface EditToolDetails {
  path: string;
  replacements: number;
  diff: string;
  /**
   * `true` when `oldText` did not match verbatim and was recovered by treating
   * `\n` and `\r\n` as equivalent line breaks (see {@link lineEndingTolerantPattern}).
   * Absent (not merely `false`) on the common exact-match path.
   */
  lineEndingNormalized?: boolean;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + needle.length;
  }
  return count;
}

/** Escapes a literal string for embedding inside a `RegExp` source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a global `RegExp` that matches `needle` verbatim except that every
 * line break inside it — `\n` or `\r\n` — also accepts the other style.
 *
 * This exists for CRLF working copies (git-for-windows checks out CRLF by
 * default): a model reads a file's lines split on `"\n"`, so the trailing
 * `"\r"` of each line is invisible to it and the `oldText` it echoes back is
 * LF-joined even though the file on disk is CRLF. An exact match then fails
 * on every multi-line edit, with no way for the model to recover — it will
 * retry the same, still-wrong, oldText.
 *
 * Only line breaks are made flexible; every other character in `needle` is
 * matched literally, so this cannot turn a real content mismatch into a
 * false match.
 */
function lineEndingTolerantPattern(needle: string): RegExp {
  const segments = needle.split(/\r\n|\n/).map(escapeRegExp);
  return new RegExp(segments.join("\r?\n"), "g");
}

/** Rewrites `text`'s line breaks to match the style found in `sample` (CRLF iff `sample` contains one). */
function matchLineEndingStyle(text: string, sample: string): string {
  return sample.includes("\r\n") ? text.replace(/\r\n|\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

/** Create the `edit` tool. Always requests permission before writing the change. */
export function createEditTool(): Tool {
  return {
    definition: {
      name: "edit",
      description:
        "Replace an exact substring in an existing file. `oldText` must match the file contents " +
        "exactly (including whitespace) and, unless `replaceAll` is set, must occur exactly once. " +
        "A multi-line `oldText` may use `\\n` line breaks even if the file on disk uses `\\r\\n` " +
        "(CRLF) — the match still succeeds and the file's existing line endings are preserved. " +
        "Fails if the file does not exist, if `oldText` is not found, or if it is ambiguous.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit, absolute or relative to the working directory.",
          },
          oldText: {
            type: "string",
            description: "Exact text to find and replace. Must match the file contents verbatim.",
          },
          newText: {
            type: "string",
            description: "Text to replace `oldText` with. Must differ from `oldText`.",
          },
          replaceAll: {
            type: "boolean",
            description:
              "Replace every occurrence of `oldText` instead of requiring a unique match.",
          },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const rawPath = input.path;
      const oldText = input.oldText;
      const newText = input.newText;
      const replaceAll = input.replaceAll === true;

      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return errorResult("`path` is required and must be a non-empty string.");
      }
      if (typeof oldText !== "string" || oldText.length === 0) {
        return errorResult("`oldText` is required and must be a non-empty string.");
      }
      if (typeof newText !== "string") {
        return errorResult("`newText` is required and must be a string.");
      }
      if (oldText === newText) {
        return errorResult("`oldText` and `newText` must differ.");
      }

      const absolutePath = resolvePath(ctx.cwd, rawPath);

      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.isDirectory()) {
          return errorResult(`${absolutePath} is a directory, not a file.`);
        }
      } catch {
        return errorResult(
          `File not found: ${absolutePath}. The edit tool cannot create new files (use write).`,
        );
      }
      if (ctx.signal.aborted) return abortedResult();

      let originalContent: string;
      try {
        originalContent = await readFile(absolutePath, "utf8");
      } catch (error) {
        return errorResult(`Failed to read ${absolutePath}: ${(error as Error).message}`);
      }

      let occurrences = countOccurrences(originalContent, oldText);
      let lineEndingRecovered = false;

      // Exact match failed. If oldText spans multiple lines, the only other
      // reason it could fail is a CRLF/LF mismatch between it and the file on
      // disk — try again treating "\n" and "\r\n" as the same line break.
      if (occurrences === 0 && /\r\n|\n/.test(oldText)) {
        const recovered = originalContent.match(lineEndingTolerantPattern(oldText));
        if (recovered !== null && recovered.length > 0) {
          occurrences = recovered.length;
          lineEndingRecovered = true;
        }
      }

      if (occurrences === 0) {
        return errorResult(
          `Could not find the given oldText in ${absolutePath}. It must match the file contents exactly, including whitespace.`,
        );
      }
      if (!replaceAll && occurrences > 1) {
        return errorResult(
          `Found ${occurrences} occurrences of oldText in ${absolutePath}. Provide more context to make it unique, or pass replaceAll: true.`,
        );
      }

      // Recovery never rewrites line endings outside what it matched: each
      // occurrence's replacement is re-encoded to that *occurrence's own*
      // CRLF/LF style, so untouched lines elsewhere in the file — even a file
      // with genuinely mixed line endings — are left exactly as they were.
      const newContent = lineEndingRecovered
        ? originalContent.replace(lineEndingTolerantPattern(oldText), (matched) =>
            matchLineEndingStyle(newText, matched),
          )
        : replaceAll
          ? originalContent.split(oldText).join(newText)
          : originalContent.replace(oldText, newText);
      const replacements = replaceAll ? occurrences : 1;

      const decision = await ctx.requestPermission({
        toolName: "edit",
        toolCallId: ctx.toolCallId,
        subject: absolutePath,
        description: `Edit ${absolutePath} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
        suggestedRule: { tool: "edit", specifier: absolutePath, action: "allow" },
      });
      if (decision.behavior !== "allow") {
        return errorResult(decision.message ?? `Permission denied to edit ${absolutePath}.`);
      }
      if (ctx.signal.aborted) return abortedResult();

      try {
        await writeFile(absolutePath, newContent, "utf8");
      } catch (error) {
        return errorResult(`Failed to write ${absolutePath}: ${(error as Error).message}`);
      }

      const diff = createUnifiedDiff(rawPath, originalContent, newContent);
      const details: EditToolDetails = {
        path: absolutePath,
        replacements,
        diff,
        ...(lineEndingRecovered ? { lineEndingNormalized: true } : {}),
      };
      const recoveryNote = lineEndingRecovered
        ? " (oldText matched after normalizing \\n/\\r\\n line endings; the file's own line endings were preserved.)"
        : "";
      return textResult(
        `Edited ${absolutePath} (${replacements} replacement${replacements === 1 ? "" : "s"}).${recoveryNote}\n\n${diff}`,
        details as unknown as Record<string, unknown>,
      );
    },
  };
}
