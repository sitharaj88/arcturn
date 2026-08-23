/**
 * TOOL-OUTPUT OFFLOADING — keep an oversized tool result out of the context
 * window without ever losing it.
 *
 * A single `bash` run, a wide `grep`, or an MCP tool that answers with a
 * megabyte of JSON can consume more of the context window than the rest of the
 * conversation put together, and the model usually needs three lines of it.
 * Plain truncation solves the budget and destroys the data: whatever was cut is
 * gone, and the model's only recourse is to run the command again.
 *
 * {@link wrapToolsWithOffload} takes the third option. When a result's text
 * exceeds {@link OffloadOptions.maxChars}, the *full* text is written to a file
 * under {@link OffloadOptions.dir} and the model receives a stub instead: the
 * head and tail of the output, the exact counts of what was omitted, and the
 * absolute path of the file — phrased so the natural next move is a `read`
 * (or `grep`) on that path. The context cost becomes bounded and constant; the
 * data stays addressable with tools the agent already has.
 *
 * Design rules this module holds to:
 *
 * - **Pure wrapper.** It wraps `execute()` and nothing else. It emits no
 *   events, never calls `ctx.onUpdate`, and does not touch agent state — the
 *   only trace of an offload outside the result text is
 *   {@link OffloadDetails} merged into `ToolResult.details`.
 * - **Identity pass-through.** A result that is not oversized is returned as
 *   the *same object*, and a tool whose name is excluded is returned
 *   unwrapped, so callers can rely on `wrapToolsWithOffload(tools, …)[i] ===
 *   tools[i]` for excluded tools and on referential equality for untouched
 *   results.
 * - **Never lose data.** If the write fails for any reason (read-only disk,
 *   ENOSPC, a bad `dir`), the *original untruncated* result is returned. A
 *   full context window is a lesser failure than a destroyed tool output.
 * - **Text only.** Image blocks are passed through in place, never written to
 *   disk and never counted against the budget; `isError`, `details` and
 *   `structuredContent` survive an offload unchanged.
 *
 * `read` is excluded by default ({@link DEFAULT_OFFLOAD_EXCLUDE}). It already
 * bounds its own output (line limit, per-line truncation, auto-outline), it is
 * the very tool the stub tells the model to use, and offloading a file read
 * into *another* file on disk is a copy with a redirection note attached —
 * pure loss. Add other self-limiting tools to {@link OffloadOptions.exclude}
 * for the same reason; do not exclude `bash`, which is the main offender.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { TextContent, Tool, ToolResult, ToolResultContent } from "@arcturn/types";

/** Text length (characters) at or below which a result is left alone. */
export const DEFAULT_OFFLOAD_MAX_CHARS = 16_000;
/** Characters of the original output kept at the start of the stub excerpt. */
export const DEFAULT_OFFLOAD_KEEP_HEAD = 4_000;
/** Characters of the original output kept at the end of the stub excerpt. */
export const DEFAULT_OFFLOAD_KEEP_TAIL = 1_000;
/**
 * Tools never offloaded by default — see the module doc for why `read` is on
 * this list.
 */
export const DEFAULT_OFFLOAD_EXCLUDE: readonly string[] = ["read"];

/**
 * The filesystem surface this module needs, so tests (and hosts with a virtual
 * FS) can substitute one. Structurally compatible with `node:fs/promises`.
 */
export interface OffloadFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(path: string, data: string, options: { encoding: "utf8"; flag: string }): Promise<void>;
}

/** Options for {@link wrapToolsWithOffload}. */
export interface OffloadOptions {
  /**
   * Directory the full outputs are written to, e.g. `<sessionDir>/offload`.
   * Created on demand (recursively). A relative path is resolved against
   * `process.cwd()` at wrap time, because the stub must quote an absolute path
   * the model can hand straight to `read`.
   */
  dir: string;
  /**
   * Combined length of a result's text blocks at or below which nothing
   * happens. Defaults to {@link DEFAULT_OFFLOAD_MAX_CHARS}. Values below 1 are
   * treated as the default.
   */
  maxChars?: number;
  /**
   * Characters kept from the start of the output in the stub excerpt.
   * Defaults to {@link DEFAULT_OFFLOAD_KEEP_HEAD}.
   */
  keepHead?: number;
  /**
   * Characters kept from the end of the output in the stub excerpt. Defaults
   * to {@link DEFAULT_OFFLOAD_KEEP_TAIL}. The tail matters more than its size
   * suggests: a command's exit status, error summary and "N tests failed" line
   * all live there.
   */
  keepTail?: number;
  /**
   * Tool names never offloaded. Defaults to {@link DEFAULT_OFFLOAD_EXCLUDE}.
   * Pass `[]` to offload everything, including `read`.
   */
  exclude?: readonly string[];
  /** Clock for the `offloadedAt` detail. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Short unique suffix used only when the derived file name is already
   * taken (the same `toolCallId` offloading twice). Defaults to a random hex
   * string; inject for deterministic tests.
   */
  createId?: () => string;
  /** Filesystem to write through. Defaults to `node:fs/promises`. */
  fs?: OffloadFileSystem;
}

/**
 * Offload bookkeeping merged into `ToolResult.details`. Present only on
 * results that were actually offloaded, so `details.offloaded === true` is a
 * reliable discriminator for a UI or a session reader.
 */
export interface OffloadDetails {
  /** Always `true` on an offloaded result. */
  offloaded: true;
  /** Absolute path of the file holding the full output. */
  path: string;
  /** Length of the original combined text, in characters. */
  originalChars: number;
  /** Byte length of the written file (UTF-8). */
  originalBytes: number;
  /** Line count of the original combined text. */
  originalLines: number;
  /** Length of the stub that replaced it, in characters. */
  stubChars: number;
  /** Timestamp from {@link OffloadOptions.now}. */
  offloadedAt: number;
}

interface ResolvedOffloadOptions {
  dir: string;
  maxChars: number;
  keepHead: number;
  keepTail: number;
  exclude: ReadonlySet<string>;
  now: () => number;
  createId: () => string;
  fs: OffloadFileSystem;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function resolveOptions(options: OffloadOptions): ResolvedOffloadOptions {
  return {
    dir: isAbsolute(options.dir) ? options.dir : resolve(options.dir),
    maxChars: positiveInt(options.maxChars, DEFAULT_OFFLOAD_MAX_CHARS),
    keepHead: nonNegativeInt(options.keepHead, DEFAULT_OFFLOAD_KEEP_HEAD),
    keepTail: nonNegativeInt(options.keepTail, DEFAULT_OFFLOAD_KEEP_TAIL),
    exclude: new Set(options.exclude ?? DEFAULT_OFFLOAD_EXCLUDE),
    now: options.now ?? Date.now,
    createId: options.createId ?? (() => randomUUID().slice(0, 8)),
    fs: options.fs ?? {
      mkdir,
      writeFile: (path, data, opts) => writeFile(path, data, opts),
    },
  };
}

function isTextContent(entry: ToolResultContent): entry is TextContent {
  return entry.type === "text";
}

/**
 * Concatenate a result's text blocks the way `hooks.ts` and `taint.ts` do —
 * newline-joined, images skipped. This joined document is what gets written to
 * disk and what the excerpt is cut from.
 *
 * @param content - Tool result content blocks.
 */
export function offloadableText(content: readonly ToolResultContent[]): string {
  return content
    .filter(isTextContent)
    .map((entry) => entry.text)
    .join("\n");
}

/**
 * Turn a tool name and call id into a file name that is safe on every platform
 * and still recognizable in a directory listing.
 *
 * @param toolName - Name of the tool that produced the output.
 * @param toolCallId - Provider-assigned call id; kept so a stub path can be
 * traced back to the exact tool call in the transcript.
 */
export function offloadFileName(toolName: string, toolCallId: string): string {
  const safe = (value: string): string => {
    const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned.length > 0 ? cleaned.slice(0, 80) : "unknown";
  };
  return `${safe(toolName)}-${safe(toolCallId)}.txt`;
}

/** Count lines the way an editor does: a document of `n` newlines has `n + 1` lines. */
function countLines(value: string): number {
  if (value.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/** The excerpt shown inline, plus the counts describing what it left out. */
interface Excerpt {
  text: string;
  omittedChars: number;
}

function buildExcerpt(full: string, keepHead: number, keepTail: number): Excerpt {
  // Clamp so head and tail can never overlap, and so a degenerate
  // keepHead+keepTail >= length never produces a "0 characters omitted" note.
  let head = Math.min(keepHead, full.length);
  let tail = Math.min(keepTail, full.length - head);
  if (head + tail >= full.length) {
    // Leave at least one omitted character, otherwise the stub would be
    // larger than the output it replaces.
    tail = Math.max(0, full.length - head - 1);
    if (head + tail >= full.length) head = Math.max(0, full.length - tail - 1);
  }
  const omittedChars = full.length - head - tail;
  const headText = full.slice(0, head);
  const tailText = tail > 0 ? full.slice(full.length - tail) : "";
  const omittedLines = countLines(full.slice(head, full.length - tail));
  const separator =
    `\n\n[… ${omittedChars} characters (~${omittedLines} lines) omitted — ` +
    "read the file above for the full output …]\n\n";
  return { text: `${headText}${separator}${tailText}`, omittedChars };
}

/**
 * Build the stub text that replaces an offloaded output.
 *
 * Exported so a host UI (and the tests) can match the exact wording.
 *
 * @param params - Tool name, absolute file path, size counts and excerpt.
 */
export function buildOffloadStub(params: {
  toolName: string;
  path: string;
  chars: number;
  bytes: number;
  lines: number;
  maxChars: number;
  excerpt: string;
}): string {
  const header =
    `[tool output offloaded] The \`${params.toolName}\` output was ${params.chars} characters ` +
    `(${params.bytes} bytes, ${params.lines} lines), over the ${params.maxChars}-character ` +
    "limit for inline tool results, so the full untruncated output was written to:\n" +
    `${params.path}\n` +
    "Nothing was lost. Read the part you need with the read tool — " +
    `read({ path: ${JSON.stringify(params.path)}, offset: 1, limit: 200 }) — or search it with ` +
    `grep({ pattern: "…", path: ${JSON.stringify(params.path)} }). ` +
    "Do not re-run the tool just to see the output again.\n" +
    "\nAn excerpt (start and end of the output) follows:\n";
  return `${header}\n${params.excerpt}`;
}

/**
 * Replace the text blocks of a result with a single stub block, keeping every
 * image block in its original relative order after the stub.
 */
function stubbedContent(content: readonly ToolResultContent[], stub: string): ToolResultContent[] {
  const images = content.filter((entry) => !isTextContent(entry));
  return [{ type: "text", text: stub }, ...images];
}

async function offloadResult(
  result: ToolResult,
  toolName: string,
  toolCallId: string,
  options: ResolvedOffloadOptions,
): Promise<ToolResult> {
  const full = offloadableText(result.content);
  const path = await writeOffloadFile(full, toolName, toolCallId, options);
  if (path === undefined) return result; // write failed — never lose the output.

  const bytes = Buffer.byteLength(full, "utf8");
  const lines = countLines(full);
  const excerpt = buildExcerpt(full, options.keepHead, options.keepTail);
  const stub = buildOffloadStub({
    toolName,
    path,
    chars: full.length,
    bytes,
    lines,
    maxChars: options.maxChars,
    excerpt: excerpt.text,
  });
  const details: OffloadDetails = {
    offloaded: true,
    path,
    originalChars: full.length,
    originalBytes: bytes,
    originalLines: lines,
    stubChars: stub.length,
    offloadedAt: options.now(),
  };
  return {
    ...result,
    content: stubbedContent(result.content, stub),
    details: { ...result.details, ...details },
  };
}

/**
 * Write the full output, returning the absolute path or `undefined` if the
 * write failed (in which case the caller keeps the original result).
 *
 * Uses the exclusive `wx` flag so a second offload for the same `toolCallId`
 * cannot silently clobber the first; on collision it retries once with a short
 * unique suffix.
 */
async function writeOffloadFile(
  full: string,
  toolName: string,
  toolCallId: string,
  options: ResolvedOffloadOptions,
): Promise<string | undefined> {
  const fileName = offloadFileName(toolName, toolCallId);
  const path = join(options.dir, fileName);
  try {
    await options.fs.mkdir(options.dir, { recursive: true });
    await options.fs.writeFile(path, full, { encoding: "utf8", flag: "wx" });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  const retryPath = path.replace(/\.txt$/, `-${options.createId()}.txt`);
  try {
    await options.fs.writeFile(retryPath, full, { encoding: "utf8", flag: "wx" });
    return retryPath;
  } catch {
    return undefined;
  }
}

/**
 * Wrap each tool so an oversized text result is written to disk and replaced
 * by a pointer stub.
 *
 * Untouched by design: tools named in {@link OffloadOptions.exclude} (returned
 * by reference, unwrapped), results whose combined text is within
 * `maxChars` (returned by reference, unmodified), image content, `isError`,
 * and `structuredContent`. Errors thrown by the wrapped `execute()` — a
 * programming error, per the `Tool` contract — propagate unchanged, and a
 * result produced after `ctx.signal` aborted is passed straight through
 * rather than writing a file the run will never read.
 *
 * @param tools - Tools to wrap.
 * @param options - Destination directory and thresholds; see {@link OffloadOptions}.
 * @returns A new array; excluded tools are the original objects.
 */
export function wrapToolsWithOffload(tools: readonly Tool[], options: OffloadOptions): Tool[] {
  const resolved = resolveOptions(options);
  return tools.map((tool) => {
    if (resolved.exclude.has(tool.definition.name)) return tool;
    return {
      ...tool,
      async execute(input, ctx): Promise<ToolResult> {
        const result = await tool.execute(input, ctx);
        if (ctx.signal.aborted) return result;
        const chars = offloadableText(result.content).length;
        if (chars <= resolved.maxChars) return result;
        return offloadResult(result, tool.definition.name, ctx.toolCallId, resolved);
      },
    };
  });
}
