/** The `read` built-in tool: read a text or image file from disk. */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Tool, ToolResult } from "@arcturn/types";
import { formatOutlineEntry, scanOutline } from "./outline.js";
import { resolvePath } from "./path-utils.js";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

/** Maximum number of lines returned when `limit` is not supplied. */
export const DEFAULT_LINE_LIMIT = 2000;
/** Long lines are truncated to this many characters. */
export const MAX_LINE_LENGTH = 2000;
/**
 * File size (bytes) at or above which a text file auto-summarizes as a structural outline
 * instead of its full body, when the caller gives neither `offset` nor `limit`. Matches Zed's
 * `read_file` `AUTO_OUTLINE_SIZE` — see `docs/code-index-architecture.md`.
 */
export const DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES = 16_384;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function detectImageMimeType(path: string): string | undefined {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()];
}

/** Right-pads a 1-indexed line number the way `cat -n` does, followed by a tab. */
function formatLine(lineNumber: number, text: string): string {
  const truncated =
    text.length > MAX_LINE_LENGTH
      ? `${text.slice(0, MAX_LINE_LENGTH)}… [line truncated at ${MAX_LINE_LENGTH} chars]`
      : text;
  return `${String(lineNumber).padStart(6, " ")}\t${truncated}`;
}

export interface ReadToolDetails {
  path: string;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  /** True when this result is a structural outline rather than file content. */
  outline?: boolean;
  /** Number of declarations found, when `outline` is true. */
  declarationCount?: number;
  /** True when an outline was attempted but unavailable, so a truncated body was returned instead. */
  outlineUnavailable?: boolean;
}

export interface CreateReadToolOptions {
  /**
   * File size (bytes) at or above which a text file auto-outlines. Defaults to
   * {@link DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES}. Only applies when the caller gives neither
   * `offset` nor `limit` nor an explicit `outline` value — see the tool description for the
   * full precedence rules.
   */
  autoOutlineThresholdBytes?: number;
}

/** Create the `read` tool. No permission is required to read files. */
export function createReadTool(options: CreateReadToolOptions = {}): Tool {
  const autoOutlineThresholdBytes =
    typeof options.autoOutlineThresholdBytes === "number" && options.autoOutlineThresholdBytes > 0
      ? Math.floor(options.autoOutlineThresholdBytes)
      : DEFAULT_AUTO_OUTLINE_THRESHOLD_BYTES;

  return {
    definition: {
      name: "read",
      description:
        "Read a file from the local filesystem. Accepts an absolute path or a path relative to " +
        "the working directory. Text output is formatted like `cat -n` (line number, tab, text), " +
        `capped at ${DEFAULT_LINE_LIMIT} lines by default (use offset/limit to page through larger ` +
        `files) with individual lines truncated past ${MAX_LINE_LENGTH} characters. Image files ` +
        "(.png, .jpg, .jpeg, .gif, .webp) are returned as base64-encoded image content instead of " +
        `text. Files at or above ${autoOutlineThresholdBytes} bytes are returned as a structural ` +
        "declaration outline (kind, name, signature, line number) instead of their body, so a " +
        "large file never floods context — read the region you actually need with offset/limit " +
        "once you know what you're looking for. Passing offset or limit always returns literal " +
        "lines and skips the outline, regardless of file size.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read, absolute or relative to the working directory.",
          },
          offset: {
            type: "number",
            description:
              "1-indexed line number to start reading from. Defaults to 1. Supplying offset (or " +
              "limit) always returns literal lines, never an outline.",
          },
          limit: {
            type: "number",
            description:
              `Maximum number of lines to return. Defaults to ${DEFAULT_LINE_LIMIT}. Supplying ` +
              "limit (or offset) always returns literal lines, never an outline.",
          },
          outline: {
            type: "boolean",
            description:
              "Force (`true`) or suppress (`false`) a structural outline instead of the file body. " +
              `Ignored whenever offset or limit is given. When omitted, files at or above ` +
              `${autoOutlineThresholdBytes} bytes auto-outline and smaller files read in full.`,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const rawPath = input.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return errorResult("`path` is required and must be a non-empty string.");
      }
      const offset =
        typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.floor(input.limit)
          : DEFAULT_LINE_LIMIT;
      // Explicit reads always win: offset/limit means the caller already decided what it wants,
      // so an outline (auto or requested) never overrides them.
      const explicitRange = input.offset !== undefined || input.limit !== undefined;
      const outlineFlag = typeof input.outline === "boolean" ? input.outline : undefined;

      const absolutePath = resolvePath(ctx.cwd, rawPath);

      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        return errorResult(
          `File not found: ${absolutePath}\nCheck the path and try again (it may need to be relative to ${ctx.cwd}).`,
        );
      }
      if (ctx.signal.aborted) return abortedResult();
      if (fileStat.isDirectory()) {
        return errorResult(
          `${absolutePath} is a directory, not a file. Use the ls or glob tools instead.`,
        );
      }

      const mimeType = detectImageMimeType(absolutePath);
      if (mimeType) {
        let buffer: Buffer;
        try {
          buffer = await readFile(absolutePath);
        } catch (error) {
          return errorResult(`Failed to read image ${absolutePath}: ${(error as Error).message}`);
        }
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}], ${buffer.length} bytes.` },
            { type: "image", data: buffer.toString("base64"), mimeType },
          ],
          details: { path: absolutePath },
        };
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(absolutePath);
      } catch (error) {
        return errorResult(`Failed to read ${absolutePath}: ${(error as Error).message}`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const text = buffer.toString("utf8");
      const allLines = text.split("\n");
      const totalLines = allLines.length;

      // Precedence: explicit offset/limit > explicit outline flag > auto-outline by size.
      const wantsOutline =
        !explicitRange &&
        (outlineFlag === true ||
          (outlineFlag === undefined && fileStat.size >= autoOutlineThresholdBytes));

      let outlineNote: string | undefined;
      if (wantsOutline) {
        let declarations: ReturnType<typeof scanOutline> = [];
        try {
          declarations = scanOutline(absolutePath, text);
        } catch {
          declarations = [];
        }
        if (declarations.length > 0) {
          const plural = declarations.length === 1 ? "" : "s";
          const header =
            `${absolutePath} — ${fileStat.size} bytes, ${totalLines} lines, ` +
            `${declarations.length} declaration${plural}. Showing a structural outline instead ` +
            "of the file body.\n" +
            `To read a region of the file itself: read({ path: ${JSON.stringify(rawPath)}, ` +
            "offset: 120, limit: 80 }).\n";
          const body = declarations.map(formatOutlineEntry).join("\n");
          const details: ReadToolDetails = {
            path: absolutePath,
            totalLines,
            outline: true,
            declarationCount: declarations.length,
          };
          return textResult(`${header}\n${body}`, details as unknown as Record<string, unknown>);
        }
        outlineNote =
          "[No structural outline was available for this file (unrecognized language, minified " +
          "content, or no declarations found) — showing the file instead.]\n\n";
      }

      const startIndex = Math.min(offset - 1, totalLines);
      if (startIndex >= totalLines) {
        return errorResult(
          `Offset ${offset} is beyond the end of the file (${totalLines} lines total).`,
        );
      }
      const endIndex = Math.min(startIndex + limit, totalLines);
      const selected = allLines.slice(startIndex, endIndex);
      const formatted = selected.map((line, i) => formatLine(startIndex + i + 1, line)).join("\n");

      const truncated = endIndex < totalLines;
      let outputText = outlineNote ? outlineNote + formatted : formatted;
      if (truncated) {
        outputText += `\n\n[Showing lines ${startIndex + 1}-${endIndex} of ${totalLines}. Use offset=${
          endIndex + 1
        } to continue reading.]`;
      }

      const details: ReadToolDetails = {
        path: absolutePath,
        totalLines,
        startLine: startIndex + 1,
        endLine: endIndex,
        truncated,
        ...(outlineNote ? { outlineUnavailable: true } : {}),
      };
      return textResult(outputText, details as unknown as Record<string, unknown>);
    },
  };
}
