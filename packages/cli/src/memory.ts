/**
 * Durable project memory: small markdown notes the agent writes for itself so
 * later sessions don't relearn the same facts a static `ARCTURN.md` can't capture
 * (things discovered mid-task — "the flaky test is `foo.test.ts:42`, rerun
 * with `--retry`" — rather than things the user wrote down up front).
 *
 * Notes live one-per-file under a caller-provided directory (typically
 * `<cwd>/.arcturn/memory`), named `<slug>.md` with an optional frontmatter title:
 *
 * ```markdown
 * ---
 * title: Flaky test workaround
 * ---
 * `foo.test.ts:42` is flaky under load; rerun with `--retry 2`.
 * ```
 *
 * Frontmatter is parsed by hand (only `title` is understood, mirroring the
 * `description`/`name` fields `skills.ts` recognises) so the CLI carries no
 * new dependency for it. Loading is defensive throughout: a missing directory
 * is fine, an unreadable or empty-bodied file is skipped with a warning
 * pushed onto the caller-supplied collector rather than failing the load.
 *
 * {@link createMemoryTool} exposes a `memory` tool the model calls to write,
 * list, and delete notes. It never requests permission — every write is
 * confined to the memory directory by construction, not by asking the user —
 * so the slug is validated defensively: anything that looks like a path
 * (`/`, `\`, `..`) is rejected outright rather than sanitised, and the
 * resolved file path is re-checked against the directory as a second layer.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";

// `@arcturn/tools` does not export its `result-utils` helpers from its
// package root, and this module must not gain a new cross-package coupling
// to reach them — so the (tiny) `ToolResult` shaping helpers are reimplemented
// locally, matching `packages/tools/src/result-utils.ts` exactly.

/** Build a successful text-only tool result. */
function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/** Build an error tool result (an expected failure, not a thrown exception). */
function errorResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], isError: true, details };
}

/** Standard result returned when a tool observes `ctx.signal` has aborted. */
function abortedResult(): ToolResult {
  return errorResult("Aborted: the operation was cancelled before it completed.");
}

/** One durable note loaded from disk. */
export interface Memory {
  /** Filename stem, already normalized to `[a-z0-9-]`. */
  slug: string;
  /** Frontmatter `title`, or a title derived from the slug when absent. */
  title: string;
  /** Trimmed note body (everything after the frontmatter fence, if any). */
  body: string;
  /** Absolute path of the file the note was loaded from. */
  source: string;
  /** File modification time, used for recency ordering. */
  updatedAt: Date;
}

/** Maximum size (in UTF-8 bytes) of a single note's content. */
export const MAX_MEMORY_NOTE_BYTES = 8 * 1024;

/** Default cap on {@link formatMemoriesForPrompt}'s rendered output. */
export const DEFAULT_MEMORY_PROMPT_MAX_CHARS = 4_000;

const SLUG_DISALLOWED = /[^a-z0-9-]/g;

/**
 * Normalize free text into the `[a-z0-9-]` slug charset: lowercase, spaces
 * become hyphens, everything else outside the charset is dropped, and
 * repeated/leading/trailing hyphens are collapsed away.
 *
 * @param raw - Candidate slug text (a filename stem or a title).
 */
function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(SLUG_DISALLOWED, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Detect a raw (pre-normalization) slug that looks like a path rather than a
 * plain name. Checked before normalization, on any explicitly-supplied slug,
 * so an escape attempt is rejected with an error instead of silently
 * sanitized into something else.
 *
 * @param raw - The slug exactly as supplied by the caller/model.
 */
function looksLikePathEscape(raw: string): boolean {
  return raw.includes("/") || raw.includes("\\") || raw.includes("..");
}

/**
 * Derive a human-readable title from a slug (`fix-flaky-test` → `Fix Flaky
 * Test`), used when a note has no frontmatter/explicit title.
 *
 * @param slug - An already-normalized slug.
 */
function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

/** Parsed frontmatter fields understood by memory files. */
interface MemoryFrontmatter {
  title?: string;
}

/**
 * Split a memory file into its optional frontmatter and body, mirroring the
 * fence format `skills.ts` uses: a leading block between two bare `---`
 * lines, `key: value` per line, no nesting. Only `title` is recognised.
 *
 * @param raw - Full file contents.
 */
function parseFrontmatter(raw: string): { frontmatter: MemoryFrontmatter; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const frontmatter: MemoryFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === "title") frontmatter.title = value;
  }
  const body = lines.slice(end + 1).join("\n");
  return { frontmatter, body };
}

/**
 * Load every memory note from a directory.
 *
 * A missing directory is fine (empty result, no warning) — a project simply
 * hasn't written any memory yet. An unreadable file or one whose body is
 * empty after trimming is skipped with a warning pushed onto `warnings`.
 *
 * @param dir - Memory directory (e.g. `<cwd>/.arcturn/memory`).
 * @param warnings - Collector for non-fatal problems.
 */
export async function loadMemories(dir: string, warnings: string[]): Promise<Memory[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const memories: Memory[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);

    let raw: string;
    let mtime: Date;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      mtime = info.mtime;
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      warnings.push(
        `${filePath}: could not be read (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(raw);
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      warnings.push(`${filePath}: memory has an empty body (skipped)`);
      continue;
    }

    const slug = normalizeSlug(basename(entry, ".md"));
    if (slug.length === 0) {
      warnings.push(`${filePath}: filename normalizes to an empty slug (skipped)`);
      continue;
    }

    const title =
      frontmatter.title && frontmatter.title.length > 0 ? frontmatter.title : titleFromSlug(slug);
    memories.push({ slug, title, body: trimmedBody, source: filePath, updatedAt: mtime });
  }
  return memories;
}

/**
 * Order memories newest-first, tying on slug — the ordering
 * {@link formatMemoriesForPrompt} renders in, chosen to be deterministic
 * (same input set always renders identically) so prompt caching isn't
 * churned by directory-listing order.
 */
function byRecencyThenSlug(a: Memory, b: Memory): number {
  const byDate = b.updatedAt.getTime() - a.updatedAt.getTime();
  return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug);
}

/**
 * Render memories as a compact markdown section for the system prompt,
 * newest-first, truncated at `maxChars` with a trailing marker (matching how
 * `readProjectDoc` truncates `ARCTURN.md`).
 *
 * @param memories - Notes to render (order does not matter; this sorts).
 * @param maxChars - Character budget for the rendered output.
 */
export function formatMemoriesForPrompt(
  memories: readonly Memory[],
  maxChars: number = DEFAULT_MEMORY_PROMPT_MAX_CHARS,
): string {
  if (memories.length === 0) return "";
  const sorted = [...memories].sort(byRecencyThenSlug);
  const rendered = sorted
    .map((memory) => `## ${memory.title} (\`${memory.slug}\`)\n${memory.body}`)
    .join("\n\n");
  return rendered.length > maxChars ? `${rendered.slice(0, maxChars)}\n…(truncated)` : rendered;
}

/** Options for {@link createMemoryTool}. */
export interface CreateMemoryToolOptions {
  /**
   * Memory directory (e.g. `<cwd>/.arcturn/memory`), or a function of the calling
   * tool context.
   *
   * The function form matters for agents rooted somewhere other than the main
   * workspace — a scout in a throwaway worktree, or a served session with its
   * own cwd. A fixed string would send their notes into the user's real repo.
   */
  dir: string | ((ctx: ToolExecutionContext) => string);
  /** Called after any successful write or delete, so a caller can re-render a live view. */
  onChange?: () => void;
}

/** Resolve the configured memory directory for one tool call. */
function resolveDir(
  dir: string | ((ctx: ToolExecutionContext) => string),
  ctx: ToolExecutionContext,
): string {
  return typeof dir === "function" ? dir(ctx) : dir;
}

/**
 * Validate and normalize a slug supplied explicitly by the model (as opposed
 * to one derived from a title). Returns an error message when the raw slug
 * looks like a path or normalizes away to nothing; otherwise the normalized
 * slug.
 *
 * @param raw - The slug exactly as supplied in tool input.
 */
function resolveExplicitSlug(raw: string): { slug: string } | { error: string } {
  if (looksLikePathEscape(raw)) {
    return { error: `\`slug\` must not contain "/", "\\", or "..": ${JSON.stringify(raw)}` };
  }
  const slug = normalizeSlug(raw);
  if (slug.length === 0) {
    return {
      error: `\`slug\` ${JSON.stringify(raw)} is empty after normalization; use letters, digits, or hyphens.`,
    };
  }
  return { slug };
}

/**
 * Resolve `<dir>/<slug>.md` and re-check (defense in depth, on top of the
 * `[a-z0-9-]` slug charset that already makes escape impossible) that it
 * still lives inside `dir`.
 *
 * @param dir - Memory directory.
 * @param slug - Already-normalized slug.
 */
function resolveMemoryPath(dir: string, slug: string): { path: string } | { error: string } {
  const resolvedDir = `${resolve(dir)}${sep}`;
  const path = join(dir, `${slug}.md`);
  if (!resolve(path).startsWith(resolvedDir)) {
    return { error: "Resolved memory path escapes the memory directory." };
  }
  return { path };
}

async function handleWrite(
  input: Record<string, unknown>,
  dir: string,
  options: CreateMemoryToolOptions,
): Promise<ToolResult> {
  const content = input.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return errorResult("`content` is required and must be a non-empty string.");
  }
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_MEMORY_NOTE_BYTES) {
    return errorResult(
      `Memory note is ${byteLength} bytes, over the ${MAX_MEMORY_NOTE_BYTES}-byte limit. ` +
        "Summarize it into a shorter note before saving.",
    );
  }

  const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
  const rawSlug = typeof input.slug === "string" ? input.slug.trim() : "";

  let slug: string;
  if (rawSlug.length > 0) {
    const resolved = resolveExplicitSlug(rawSlug);
    if ("error" in resolved) return errorResult(resolved.error);
    slug = resolved.slug;
  } else if (rawTitle.length > 0) {
    slug = normalizeSlug(rawTitle);
    if (slug.length === 0) {
      return errorResult(
        `\`title\` ${JSON.stringify(rawTitle)} has no letters, digits, or hyphens to build a slug from; pass an explicit \`slug\`.`,
      );
    }
  } else {
    return errorResult("Either `slug` or `title` is required.");
  }

  const resolvedPath = resolveMemoryPath(dir, slug);
  if ("error" in resolvedPath) return errorResult(resolvedPath.error);

  const title = rawTitle.length > 0 ? rawTitle.replace(/\r?\n/g, " ") : titleFromSlug(slug);
  const fileContents = `---\ntitle: ${title}\n---\n${content.trim()}\n`;

  const tmpPath = join(dir, `.${slug}.md.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, fileContents, "utf8");
    await rename(tmpPath, resolvedPath.path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return errorResult(`Failed to save memory "${slug}": ${(error as Error).message}`);
  }

  options.onChange?.();
  return textResult(`Saved memory "${slug}" (${title}).`, {
    slug,
    title,
    path: resolvedPath.path,
    bytes: byteLength,
  });
}

async function handleList(dir: string): Promise<ToolResult> {
  const warnings: string[] = [];
  const memories = (await loadMemories(dir, warnings)).sort(byRecencyThenSlug);
  const summary = memories.map(({ slug, title }) => ({ slug, title }));
  if (memories.length === 0) {
    return textResult("No memories stored.", { memories: summary });
  }
  const lines = memories.map((memory) => `- ${memory.slug}: ${memory.title}`);
  return textResult(
    `${memories.length} ${memories.length === 1 ? "memory" : "memories"} stored:\n${lines.join("\n")}`,
    { memories: summary },
  );
}

async function handleDelete(
  input: Record<string, unknown>,
  dir: string,
  options: CreateMemoryToolOptions,
): Promise<ToolResult> {
  const rawSlug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (rawSlug.length === 0) {
    return errorResult("`slug` is required.");
  }
  const resolved = resolveExplicitSlug(rawSlug);
  if ("error" in resolved) return errorResult(resolved.error);
  const slug = resolved.slug;

  const resolvedPath = resolveMemoryPath(dir, slug);
  if ("error" in resolvedPath) return errorResult(resolvedPath.error);

  try {
    await unlink(resolvedPath.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return textResult(`No memory named "${slug}" was found; nothing to delete.`, {
        slug,
        deleted: false,
      });
    }
    return errorResult(`Failed to delete memory "${slug}": ${(error as Error).message}`);
  }

  options.onChange?.();
  return textResult(`Deleted memory "${slug}".`, { slug, deleted: true });
}

/**
 * Build the `memory` tool: the model's write/list/delete interface onto the
 * notes {@link loadMemories} reads back next session.
 *
 * Writes never request permission — every path they can touch is confined to
 * `options.dir` by the slug validation above, so there is nothing to ask
 * about beyond what the directory's own filesystem permissions already
 * gate — but they are guarded by a size cap ({@link MAX_MEMORY_NOTE_BYTES})
 * and an atomic temp-file-then-rename write so a crash mid-write can never
 * leave a half-written note behind.
 *
 * @param options - Memory directory and an optional change callback.
 */
export function createMemoryTool(options: CreateMemoryToolOptions): Tool {
  return {
    definition: {
      name: "memory",
      description:
        "Read, write, and delete durable project notes that persist across sessions (a static " +
        "ARCTURN.md the user writes once cannot capture things you discover mid-task). Use `write` to " +
        "save a short, self-contained note — a fact, a gotcha, a preference you learned — for your " +
        "future self; `list` to see what is already stored so you don't duplicate it; `delete` to " +
        "remove a note that is no longer true. Keep each note short: it is summarized into the next " +
        "session's system prompt, not this one.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["write", "list", "delete"],
            description: "The operation to perform.",
          },
          slug: {
            type: "string",
            description:
              "Identifier for the note (`write`/`delete`), e.g. `flaky-test-workaround`. Letters, " +
              "digits, and hyphens only; derived from `title` when omitted on `write`.",
          },
          title: {
            type: "string",
            description: "Short human-readable title (`write` only). Also used to derive `slug`.",
          },
          content: {
            type: "string",
            description: `The note body (\`write\` only). Max ${MAX_MEMORY_NOTE_BYTES} bytes — summarize longer findings.`,
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();
      const action = input.action;
      if (action === "write") return handleWrite(input, resolveDir(options.dir, ctx), options);
      if (action === "list") return handleList(resolveDir(options.dir, ctx));
      if (action === "delete") return handleDelete(input, resolveDir(options.dir, ctx), options);
      return errorResult('`action` must be "write", "list", or "delete".');
    },
  };
}
