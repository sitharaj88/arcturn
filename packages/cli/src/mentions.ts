/**
 * `@`-mention support: fuzzy file-path completion for the prompt editor, and
 * expansion of submitted `@path` tokens into injected file content or image
 * blocks.
 *
 * Two independent pieces live here:
 *
 * - {@link createFileMentionSource} — a completion source that lazily walks
 *   the workspace and fuzzy-matches the token being typed. It implements the
 *   narrow `{ getSuggestions(prefix) }` shape rather than the tui's full
 *   `AutocompleteProvider`, so it stays trivially testable; wiring it into an
 *   {@link import("@arcturn/tui").Editor} is a one-line adapter (see
 *   `INTEGRATION-mentions.md`).
 * - {@link expandMentions} — run once, over the final submitted text, right
 *   before it is handed to the agent. Text-file mentions get their content
 *   appended to the prompt; image mentions become {@link ImageContent}
 *   blocks the caller attaches alongside the (still-mentioned) text.
 *
 * @packageDocumentation
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { ImageContent } from "@arcturn/types";

/** One entry offered by a mention completion source. */
export interface MentionSuggestion {
  /** Text inserted when the suggestion is accepted, e.g. `@src/index.ts`. */
  readonly value: string;
  /** Text shown in the dropdown. */
  readonly label: string;
  /** Secondary text shown next to the label. */
  readonly description?: string;
}

/**
 * A namespaced completion source consulted alongside the workspace file
 * walk — the extension point future MCP-resource mentions (e.g.
 * `@mcp:some-resource`) are expected to plug into.
 *
 * Only sources whose {@link MentionExtraSource.prefix} matches the start of
 * the typed query (the text after `@`) are consulted; the remainder of the
 * query is fuzzy-matched against each item's `label`.
 */
export interface MentionExtraSource {
  /** Namespace the query must start with for this source to be consulted, e.g. `"mcp:"`. */
  readonly prefix: string;
  /** Candidate items this source can offer. Synchronous — see the integration doc. */
  items(): readonly MentionSuggestion[];
}

/** A completion source for `@`-mentions, matching the editor's narrow provider shape. */
export interface FileMentionSource {
  /** Returns up to ten ranked suggestions for the token under the caret (including its `@`). */
  getSuggestions(prefix: string): MentionSuggestion[];
}

const ALWAYS_IGNORED_SEGMENTS = new Set([".git", "node_modules", "dist"]);
const MAX_SUGGESTIONS = 10;
const MAX_WALK_FILES = 20_000;
const CACHE_TTL_MS = 5000;

/** One compiled `.gitignore` line. */
interface IgnorePattern {
  readonly regex: RegExp;
  /** `true` when the pattern contained a `/` (other than a trailing one) and is root-anchored. */
  readonly anchored: boolean;
}

/**
 * Parse the root `.gitignore`, if any, into simple patterns.
 *
 * This is intentionally not a full gitignore engine: no negation, no `**`,
 * just `*` wildcards and the anchored-vs-anywhere distinction that a plain
 * `/`-free entry (`dist/`, `*.log`) vs. a nested one (`website/dist/`) needs.
 *
 * @param cwd - Workspace root to look for `.gitignore` in.
 */
function loadGitignore(cwd: string): IgnorePattern[] {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const patterns: IgnorePattern[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    let pattern = trimmed;
    if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    patterns.push({ regex: new RegExp(`^${escaped}$`), anchored });
  }
  return patterns;
}

/**
 * Whether a workspace-relative path (posix separators) should be skipped.
 *
 * @param relPath - Path relative to the workspace root, `/`-separated.
 * @param segment - The final path segment (file or directory name).
 * @param patterns - Compiled `.gitignore` patterns from {@link loadGitignore}.
 */
function isIgnored(relPath: string, segment: string, patterns: readonly IgnorePattern[]): boolean {
  if (ALWAYS_IGNORED_SEGMENTS.has(segment)) return true;
  for (const pattern of patterns) {
    if (pattern.anchored ? pattern.regex.test(relPath) : pattern.regex.test(segment)) return true;
  }
  return false;
}

/**
 * Recursively list files under `dir`, skipping ignored directories.
 *
 * @param root - Workspace root (used to compute relative, posix-style paths).
 * @param dir - Directory currently being scanned.
 * @param patterns - Compiled ignore patterns.
 * @param out - Accumulator, mutated in place; capped at {@link MAX_WALK_FILES}.
 */
function walk(root: string, dir: string, patterns: readonly IgnorePattern[], out: string[]): void {
  if (out.length >= MAX_WALK_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_WALK_FILES) return;
    const full = join(dir, entry.name);
    const relPath = relative(root, full).split(sep).join("/");
    if (isIgnored(relPath, entry.name, patterns)) continue;
    if (entry.isDirectory()) {
      walk(root, full, patterns, out);
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
}

/**
 * Score how well `query` matches `candidate` as a case-insensitive fuzzy
 * subsequence, or return `null` when it does not match at all.
 *
 * Consecutive-character runs and matches starting right after a path
 * boundary (`/`, `.`, `-`, `_`, or the start of the string) score extra, and
 * shorter overall candidates get a small tie-breaking bonus.
 *
 * @param query - Text typed after `@` (and after stripping any extra-source prefix).
 * @param candidate - A workspace-relative path or suggestion label.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let ci = 0;
  let score = 0;
  let consecutive = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    let found = -1;
    for (let i = ci; i < c.length; i++) {
      if (c[i] === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    const before = c[found - 1];
    const boundary =
      found === 0 || before === "/" || before === "." || before === "-" || before === "_";
    score += 1;
    if (boundary) score += 5;
    if (found === ci) {
      consecutive += 1;
      score += consecutive;
    } else {
      consecutive = 0;
    }
    ci = found + 1;
  }
  score += Math.max(0, 40 - candidate.length) * 0.05;
  return score;
}

/** Build a {@link MentionSuggestion} for a workspace-relative path. */
function toSuggestion(relPath: string): MentionSuggestion {
  const needsQuoting = /\s/.test(relPath);
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  return {
    value: needsQuoting ? `@"${relPath}"` : `@${relPath}`,
    label: relPath,
    ...(dir !== "" ? { description: dir } : {}),
  };
}

/**
 * Rank a set of ready-made suggestions against a query, keeping the top ten.
 *
 * @param items - Candidate suggestions (already `{ value, label, ... }`).
 * @param query - Text to fuzzy-match against each item's `label`.
 */
function rankSuggestions(items: readonly MentionSuggestion[], query: string): MentionSuggestion[] {
  const scored: Array<{ item: MentionSuggestion; score: number }> = [];
  for (const item of items) {
    const score = fuzzyScore(query, item.label);
    if (score === null) continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length);
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.item);
}

/**
 * Build a `@`-mention completion source rooted at `cwd`.
 *
 * The workspace file list is walked lazily (on first use) and cached for
 * {@link CACHE_TTL_MS}; `.git`, `node_modules` and `dist` are always skipped,
 * plus whatever the workspace root's `.gitignore` adds.
 *
 * @param cwd - Workspace root; suggestion values are `@`-prefixed paths relative to it.
 * @param extraSources - Additional namespaced sources (see {@link MentionExtraSource}).
 */
export function createFileMentionSource(
  cwd: string,
  extraSources: readonly MentionExtraSource[] = [],
): FileMentionSource {
  const root = resolve(cwd);
  let cache: { time: number; files: readonly string[] } | undefined;

  function listFiles(): readonly string[] {
    const now = Date.now();
    if (cache && now - cache.time < CACHE_TTL_MS) return cache.files;
    const patterns = loadGitignore(root);
    const files: string[] = [];
    walk(root, root, patterns, files);
    cache = { time: now, files };
    return files;
  }

  return {
    getSuggestions(prefix: string): MentionSuggestion[] {
      if (!prefix.startsWith("@")) return [];
      const query = prefix.slice(1);

      for (const source of extraSources) {
        if (source.prefix !== "" && query.startsWith(source.prefix)) {
          return rankSuggestions(source.items(), query.slice(source.prefix.length));
        }
      }

      const files = listFiles();
      if (query === "") {
        return [...files]
          .sort((a, b) => a.length - b.length || a.localeCompare(b))
          .slice(0, MAX_SUGGESTIONS)
          .map(toSuggestion);
      }
      const scored: Array<{ relPath: string; score: number }> = [];
      for (const relPath of files) {
        const score = fuzzyScore(query, relPath);
        if (score === null) continue;
        scored.push({ relPath, score });
      }
      scored.sort((a, b) => b.score - a.score || a.relPath.length - b.relPath.length);
      return scored.slice(0, MAX_SUGGESTIONS).map((s) => toSuggestion(s.relPath));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mention expansion                                                           */
/* -------------------------------------------------------------------------- */

/** One mention the engine would not read, and why. */
export interface MentionRefusal {
  /** The mention exactly as it was written, `@` included. */
  what: string;
  /** One sentence a person can act on. */
  reason: string;
}

/** Result of {@link expandMentions}. */
export interface ExpandedMentions {
  /** The original text, with text-mention content appended at the end. */
  text: string;
  /** Image blocks for mentioned image files, ready to attach to the prompt. */
  images: ImageContent[];
  /**
   * Workspace-relative paths of {@link ExpandedMentions.images}, index-aligned.
   *
   * A parallel array rather than a field on `ImageContent`, because that type
   * is what goes to a provider and must carry nothing a provider does not
   * define. It exists so a caller that has to *refuse* an image — a served
   * session on a text-only model — can name the file rather than say "an
   * image": see `SessionHost.prompt`.
   */
  imagePaths: string[];
  /**
   * Mentions that resolve outside the workspace. Never read.
   *
   * Reported rather than silently skipped, which is what this function did
   * before RFC 0005: the TUI could get away with it because the user could see
   * their own filesystem, but over `arcturn serve` a mention that quietly did
   * nothing was indistinguishable from one that worked. The refusal is not
   * fatal — the token stays in the text — it is just no longer invisible.
   */
  refusals: MentionRefusal[];
}

/** What {@link readContextFile} made of one already-confined path. */
export type ContextFileContent =
  /** Text to append to a prompt: a fenced block, headed by `heading`. */
  | { kind: "text"; text: string; truncated: boolean }
  /** A vision block. */
  | { kind: "image"; content: ImageContent }
  /**
   * Past the inline ceiling; nothing was read. `text` is the note a mention
   * appends instead, and `bytes`/`limit` are what a caller that must refuse
   * outright (an attachment) composes its own message from.
   */
  | { kind: "tooLarge"; text: string; bytes: number; limit: number }
  /** A directory, a socket, or something that vanished between checks. */
  | { kind: "notAFile" };

/**
 * File extensions this engine turns into vision blocks, and the media type each
 * becomes.
 *
 * Exported because it is the *definition* of "this is an image" for every
 * context path in this codebase: `readContextFile` decides with it, and
 * `context.ts` answers `resolveContext`'s `kind` with it. A second copy would
 * let a picker call a file a file that a prompt then sends as a picture.
 */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_LINES = 2000;
const MAX_TEXT_BYTES = 200 * 1024;
/** Files larger than this are never buffered for injection at all. */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** One `@token` found in submitted text. */
interface MentionToken {
  /** Raw path text as typed, quotes stripped. */
  path: string;
}

/**
 * Find every `@path` token in `text`.
 *
 * A mention starts at an `@` preceded by the start of the string or
 * whitespace (so `foo@bar.com` is left alone), and its path is either a
 * double-quoted span (spaces allowed, unterminated quotes run to the end of
 * the string) or a run of non-whitespace characters.
 *
 * @param text - Submitted prompt text.
 */
function findMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const at = text.indexOf("@", i);
    if (at === -1) break;
    const prev = at === 0 ? undefined : text[at - 1];
    if (prev !== undefined && !/\s/.test(prev)) {
      i = at + 1;
      continue;
    }
    let end: number;
    let path: string;
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2);
      if (close === -1) {
        end = n;
        path = text.slice(at + 2);
      } else {
        end = close + 1;
        path = text.slice(at + 2, close);
      }
    } else {
      let j = at + 1;
      while (j < n && !/\s/.test(text[j]!)) j++;
      end = j;
      path = text.slice(at + 1, j);
    }
    if (path.length > 0) tokens.push({ path });
    i = Math.max(end, at + 1);
  }
  return tokens;
}

/**
 * Where a client-supplied path landed, relative to the workspace it must stay
 * inside.
 *
 * Three outcomes rather than a nullable path, because "you may not read this"
 * and "there is nothing here" are different answers and a caller that conflates
 * them tells a user something false — a file picker reporting a traversal
 * attempt as "no such file", or an attachment refusal that reads like a typo.
 */
export type WorkspacePathVerdict =
  /** Confined and real. `realPath` is symlink-resolved; read *that*. */
  | { outcome: "inside"; path: string; realPath: string; relativePath: string }
  /**
   * Escapes the workspace, lexically or through a symlink. **Never read**, and
   * never even stat'ed — everything here is string arithmetic over what the
   * caller supplied.
   */
  | { outcome: "outside"; path: string; reason: string }
  /** Inside the workspace, but nothing is there (or it could not be resolved). */
  | { outcome: "missing"; path: string; relativePath: string; reason: string };

/**
 * The one workspace-confinement gate every context path in this codebase goes
 * through — `@`-mentions, `prompt` attachments, and `resolveContext`.
 *
 * Deliberately one function. RFC 0005 §1.1 requires the served path to inherit
 * "the strictest existing rule rather than a new one", and the way a rule stops
 * being the strictest is that somebody writes a second one that agrees with it
 * until it does not. This *is* the rule the TUI has always applied; the served
 * path now calls it rather than approximating it.
 *
 * Two gates, and both are needed:
 *
 * 1. **Lexical.** `resolve` collapses `../` and absolutizes, so a mention that
 *    names a path outside the root is refused before any syscall.
 * 2. **Real.** A symlink *inside* the workspace can still point outside it, so
 *    the final check compares symlink-resolved paths. A mention never reads
 *    through such a link (see `security-review.test.ts`).
 *
 * @param root - Workspace root; resolved here, so a relative one is fine.
 * @param rawPath - Path as the client wrote it.
 */
export async function confineToWorkspace(
  root: string,
  rawPath: string,
): Promise<WorkspacePathVerdict> {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, rawPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    return {
      outcome: "outside",
      path: resolved,
      reason: "resolves outside the workspace, so it was not read",
    };
  }
  const relativePath = relative(resolvedRoot, resolved).split(sep).join("/");
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(resolvedRoot), realpath(resolved)]);
  } catch {
    return { outcome: "missing", path: resolved, relativePath, reason: "does not exist" };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return {
      outcome: "outside",
      path: resolved,
      reason: "is a symlink leading outside the workspace, so it was not read",
    };
  }
  return { outcome: "inside", path: resolved, realPath: realTarget, relativePath };
}

/** Truncate text to {@link MAX_TEXT_LINES} lines and {@link MAX_TEXT_BYTES} bytes. */
function truncateText(raw: string): { content: string; truncated: boolean } {
  let truncated = false;
  const lines = raw.split("\n");
  let content = raw;
  if (lines.length > MAX_TEXT_LINES) {
    content = lines.slice(0, MAX_TEXT_LINES).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
    content = Buffer.from(content, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8");
    truncated = true;
  }
  return { content, truncated };
}

/**
 * Turn one confined path into the content a prompt carries.
 *
 * The single place a context file is read in this codebase — mentions and
 * `prompt` attachments both come through here, so the caps below (5 MB image,
 * 2 MB file, 2000 lines / 200 KB inlined) are one set of numbers rather than
 * two that drift. The caller has already run {@link confineToWorkspace}; this
 * function never resolves a path and never checks one.
 *
 * @param realPath - The symlink-resolved path from a `"inside"` verdict.
 * @param heading - What to call the file in the emitted block, e.g.
 *   `"@src/auth.ts"` for a mention or `"src/auth.ts (attached)"` for an
 *   attachment. This is what makes a context block "say what it is".
 */
export async function readContextFile(
  realPath: string,
  heading: string,
): Promise<ContextFileContent> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(realPath);
  } catch {
    return { kind: "notAFile" };
  }
  if (!info.isFile()) return { kind: "notAFile" };

  const mimeType = IMAGE_MIME_TYPES[extname(realPath).toLowerCase()];
  if (mimeType) {
    if (info.size > MAX_IMAGE_BYTES) {
      return {
        kind: "tooLarge",
        text: `\n\n${heading} (too large)`,
        bytes: info.size,
        limit: MAX_IMAGE_BYTES,
      };
    }
    const data = await readFile(realPath);
    return { kind: "image", content: { type: "image", data: data.toString("base64"), mimeType } };
  }

  if (info.size > MAX_TEXT_FILE_BYTES) {
    return {
      kind: "tooLarge",
      text: `\n\n${heading} (too large to inline)`,
      bytes: info.size,
      limit: MAX_TEXT_FILE_BYTES,
    };
  }
  const raw = await readFile(realPath, "utf8");
  const { content, truncated } = truncateText(raw);
  const marker = truncated ? "\n… truncated (2000 line / 200KB cap)" : "";
  return {
    kind: "text",
    text: `\n\n${heading}:\n\`\`\`\n${content}${marker}\n\`\`\``,
    truncated,
  };
}

/**
 * Expand `@path` mentions in submitted prompt text.
 *
 * `@`-tokens are left in place in `text` no matter what — this only appends
 * injected content at the end and collects image blocks separately, so the
 * user's original wording (and the mention itself, as context for the model)
 * survives untouched:
 *
 * - **Images** (`.png` `.jpg` `.jpeg` `.gif` `.webp`) under 5MB become
 *   {@link ImageContent} blocks in the returned `images` array. Over the cap,
 *   the token is left as-is and a `"(too large)"` note is appended to `text`
 *   instead of the file's bytes.
 * - **Everything else** that resolves to a file is read as UTF-8 and
 *   appended as a fenced block, capped at 2000 lines / 200KB with a
 *   truncation marker when either limit is hit.
 * - **Nonexistent paths, directories, and anything resolving outside `cwd`**
 *   (traversal via `../`, or an absolute path elsewhere) are left completely
 *   untouched — no note, no error.
 *
 * @param text - Submitted prompt text, as typed (including all `@` tokens).
 * @param cwd - Workspace root mentions are resolved against.
 */
export async function expandMentions(text: string, cwd: string): Promise<ExpandedMentions> {
  const root = resolve(cwd);
  const tokens = findMentionTokens(text);
  const images: ImageContent[] = [];
  const imagePaths: string[] = [];
  const refusals: MentionRefusal[] = [];
  const appended: string[] = [];

  for (const token of tokens) {
    const verdict = await confineToWorkspace(root, token.path);
    if (verdict.outcome === "outside") {
      // Reported, not read. A `@here` in prose that happens not to exist stays
      // silent (the `"missing"` branch below); only an actual escape is worth
      // a sentence, so this stays quiet for ordinary typing.
      refusals.push({ what: `@${token.path}`, reason: verdict.reason });
      continue;
    }
    if (verdict.outcome === "missing") continue;

    const content = await readContextFile(verdict.realPath, `@${verdict.relativePath}`);
    if (content.kind === "notAFile") continue;
    if (content.kind === "image") {
      images.push(content.content);
      imagePaths.push(verdict.relativePath);
      continue;
    }
    appended.push(content.text);
  }

  return { text: text + appended.join(""), images, imagePaths, refusals };
}
