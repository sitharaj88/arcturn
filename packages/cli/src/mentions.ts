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
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageContent, LineRange } from "@arcturn/types";

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
  | { kind: "notAFile" }
  /**
   * A {@link LineRange} was asked for that this file cannot answer — a `start`
   * past the last line, or a range on an image. Nothing was injected.
   *
   * Its own outcome rather than an empty `text` block, because those two are
   * the difference between "the selection you named is not there" and "the
   * selection you named is blank", and a model handed the second would answer
   * about emptiness it was never shown.
   */
  | { kind: "rangeRefused"; reason: string };

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
  /** Path text as typed, quotes stripped and any `:12-34` suffix taken off. */
  path: string;
  /**
   * The same run with the suffix still on it.
   *
   * Kept because `:12-34` is only *probably* a line range: a file genuinely
   * named `notes:12-34` is legal on every platform this runs on, and the
   * literal reading has to be able to win when the stripped one resolves to
   * nothing. See {@link expandMentions}.
   */
  raw: string;
  /** The selection the suffix named, when it named a usable one. */
  range?: LineRange;
}

/**
 * A trailing `:12-34` or `:12` on a mention.
 *
 * Anchored at both ends, and the line numbers must be the very last thing in
 * the run, so `@src/auth.ts` and a Windows-shaped `@C:\Users\me\notes.md` are
 * untouched — the tail after the final colon has to be digits for this to fire
 * at all.
 */
const MENTION_RANGE_SUFFIX = /^(.+):(\d+)(?:-(\d+))?$/;

/**
 * Split a `path:start-end` run into its two halves, when it has two.
 *
 * A single number (`@src/auth.ts:12`) is one line: `{ start: 12, end: 12 }`,
 * matching {@link LineRange}'s inclusive convention rather than inventing a
 * half-open one for this spelling alone.
 *
 * Returns `undefined` — leaving the whole run to be treated as a path, exactly
 * as it was before the suffix was taught — when the numbers cannot mean a
 * range: `:0`, `:34-12`, or a value too large to be a whole number. That is
 * the quiet outcome a nonexistent mention has always had, and it is the right
 * one here: refusing the prompt over a token inside prose would be a far
 * bigger change than the suffix is worth.
 *
 * @param run - The mention's text after `@`, quotes already stripped.
 */
function parseRangeSuffix(run: string): { path: string; range: LineRange } | undefined {
  const match = MENTION_RANGE_SUFFIX.exec(run);
  if (!match) return undefined;
  const [, path, startText, endText] = match;
  if (path === undefined || startText === undefined) return undefined;
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start < 1 || end < start) return undefined;
  return { path, range: { start, end } };
}

/**
 * Find every `@path` token in `text`.
 *
 * A mention starts at an `@` preceded by the start of the string or
 * whitespace (so `foo@bar.com` is left alone), and its path is either a
 * double-quoted span (spaces allowed, unterminated quotes run to the end of
 * the string) or a run of non-whitespace characters.
 *
 * Either spelling may carry a `:12-34` line-range suffix — `@src/auth.ts:12-34`
 * and `@"my notes.md":12-34` both work, which is why the quoted form checks
 * past its closing quote. Before this, the whole run was taken as a path, so
 * the suffix did not narrow the mention: it defeated it, and the file was
 * never injected at all.
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
    let range: LineRange | undefined;
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2);
      if (close === -1) {
        end = n;
        path = text.slice(at + 2);
      } else {
        end = close + 1;
        path = text.slice(at + 2, close);
        // The suffix sits *outside* the quotes: the quotes exist to let a path
        // hold spaces, and the line numbers are not part of the name.
        let k = end;
        while (k < n && !/\s/.test(text[k]!)) k++;
        const suffix = text.slice(end, k);
        const parsed = suffix === "" ? undefined : parseRangeSuffix(`x${suffix}`);
        if (parsed?.path === "x") {
          range = parsed.range;
          end = k;
        }
      }
    } else {
      let j = at + 1;
      while (j < n && !/\s/.test(text[j]!)) j++;
      end = j;
      path = text.slice(at + 1, j);
    }
    const raw = path;
    if (range === undefined) {
      const parsed = parseRangeSuffix(path);
      if (parsed) {
        path = parsed.path;
        range = parsed.range;
      }
    }
    if (path.length > 0) {
      tokens.push({ path, raw, ...(range === undefined ? {} : { range }) });
    }
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
 * Rewrites a paste that is nothing but file paths into `@`-mentions.
 *
 * A drag-and-drop onto a terminal *is* a paste: the emulator inserts the
 * dropped file's absolute path (shell-escaped on macOS, quoted on some
 * Linux terminals) as pasted text. This is the other half of "attach from
 * anywhere" — the engine accepts absolute paths, and this makes the drop
 * gesture produce one. Deliberately strict about when it fires: every
 * whitespace-separated token must unescape to an existing absolute path, so
 * pasted prose, code, or a lone `/` can never be rewritten. Anything else
 * returns `undefined` and the paste inserts verbatim.
 *
 * @param text - The pasted text.
 * @param isFile - Filesystem probe, injectable for tests.
 */
export function pastedPathsAsMentions(
  text: string,
  isFile: (path: string) => boolean,
): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("\n")) return undefined;
  // Tokenize the way a shell drop is written: a quoted run is one token
  // (some Linux terminals quote), `\ ` is an escaped space (Finder
  // escapes), bare whitespace separates a multi-file drop.
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const close = trimmed.indexOf(ch, i + 1);
      if (close === -1) return undefined;
      tokens.push(trimmed.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < trimmed.length && (!/\s/.test(trimmed[j] ?? "") || trimmed[j - 1] === "\\")) {
      j += 1;
    }
    tokens.push(trimmed.slice(i, j).replaceAll("\\ ", " "));
    i = j;
  }
  if (tokens.length === 0) return undefined;
  const paths: string[] = [];
  for (const candidate of tokens) {
    if (!isAbsolute(candidate) || !isFile(candidate)) return undefined;
    paths.push(candidate);
  }
  return `${paths.map((path) => (/\s/.test(path) ? `@"${path}"` : `@${path}`)).join(" ")} `;
}

/**
 * The one path gate every context path in this codebase goes through —
 * `@`-mentions, `prompt` attachments, and `resolveContext`.
 *
 * Deliberately one function. RFC 0005 §1.1 requires the served path to inherit
 * "the strictest existing rule rather than a new one", and the way a rule stops
 * being the strictest is that somebody writes a second one that agrees with it
 * until it does not. Both front-ends call this rather than approximating it.
 *
 * The rule: **an absolute path attaches from anywhere; a relative path stays
 * inside the workspace.** Writing `/` (or dragging a file in — a drop always
 * carries an absolute path) is an explicit gesture at a known location by the
 * person the engine works for, and their screenshot in `~/Downloads` is
 * legitimate context. What stays refused is the *covert* escape: a mention
 * that reads as workspace-local — `src/../../secrets`, or a symlink inside
 * the tree pointing out of it — must not quietly leave, because the person
 * reading `@src/config` has been told a lie about what was read. Verdicts for
 * an allowed absolute path report `outcome: "inside"` — historically "inside
 * the workspace", now "cleared to attach" — with the absolute path as its own
 * display path.
 *
 * Two gates guard the relative case, and both are needed:
 *
 * 1. **Lexical.** `resolve` collapses `../`, so a relative mention that names
 *    a path outside the root is refused before any syscall.
 * 2. **Real.** A symlink *inside* the workspace can still point outside it, so
 *    the final check compares symlink-resolved paths. A relative mention never
 *    reads through such a link (see `security-review.test.ts`).
 *
 * @param root - Workspace root; resolved here, so a relative one is fine.
 * @param rawPath - Path as the client wrote it.
 */
export async function confineToWorkspace(
  root: string,
  rawPath: string,
): Promise<WorkspacePathVerdict> {
  const resolvedRoot = resolve(root);
  if (isAbsolute(rawPath)) {
    const absolute = resolve(rawPath);
    // Inside-the-root absolutes keep their workspace-relative identity so an
    // absolute drop of a project file dedupes with the same file mentioned
    // relatively; genuinely outside ones are their own display path.
    const within = absolute === resolvedRoot || absolute.startsWith(resolvedRoot + sep);
    const display = within ? relative(resolvedRoot, absolute).split(sep).join("/") : absolute;
    try {
      const real = await realpath(absolute);
      return { outcome: "inside", path: absolute, realPath: real, relativePath: display };
    } catch {
      return {
        outcome: "missing",
        path: absolute,
        relativePath: display,
        reason: "does not exist",
      };
    }
  }
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

/**
 * What {@link sliceRange} made of a range against a file's actual contents.
 *
 * `note` is the honest sentence that goes above the fence, and it is built
 * here rather than at the injection site for one reason: this is the only
 * place that knows how many lines the file has, so it is the only place that
 * can say `of 800` — or say that the range was clamped — without guessing.
 */
type RangeSlice =
  | { outcome: "sliced"; content: string; note: string }
  | { outcome: "refused"; reason: string };

/**
 * Cut a {@link LineRange} out of a file's text, clamping what can be clamped
 * and refusing what cannot.
 *
 * The convention is `LineRange`'s: **1-based, inclusive at both ends**. Line
 * counting follows `wc -l` rather than an editor's phantom final line — a file
 * ending in `\n` has as many lines as it has newlines, not one more — so
 * "lines 1-2 of 2" means what a person reading a two-line file expects. An
 * editor that counts the phantom line and asks for one past the end simply has
 * its `end` clamped, which is the right outcome either way.
 *
 * @param raw - The whole file, already read and confined.
 * @param range - The selection, as the client named it.
 */
function sliceRange(raw: string, range: LineRange): RangeSlice {
  const lines = raw.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = raw === "" ? 0 : lines.length;

  if (range.start > total) {
    // Refused, not clamped. There is no excerpt to clamp *to*, and quietly
    // substituting the file's tail would hand the model a different selection
    // than the one that was named — which is the exact substitution a range
    // exists to prevent.
    return {
      outcome: "refused",
      reason:
        total === 0
          ? `starts at line ${String(range.start)}, but the file is empty`
          : `starts at line ${String(range.start)}, but the file has ${String(total)} lines`,
    };
  }

  const clamps: string[] = [];
  let end = range.end;
  if (end > total) {
    end = total;
    clamps.push(`the file ends at line ${String(total)}`);
  }
  const lineCeiling = range.start + MAX_TEXT_LINES - 1;
  if (end > lineCeiling) {
    end = lineCeiling;
    clamps.push(`this engine inlines at most ${String(MAX_TEXT_LINES)} lines`);
  }
  const clamped =
    clamps.length === 0
      ? ""
      : `; ${String(range.start)}-${String(range.end)} was requested, but ` +
        `${clamps.join(" and ")}, so the range was clamped`;

  return {
    outcome: "sliced",
    content: lines.slice(range.start - 1, end).join("\n"),
    note:
      `excerpt, lines ${String(range.start)}-${String(end)} of ${String(total)}${clamped}; ` +
      "the rest of the file was not read",
  };
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
 * A `range` narrows the result to an excerpt. It changes nothing about *which*
 * file is read, or under what caps — the 2 MiB ceiling below still gates the
 * read, because slicing happens after the bytes are in hand and this stays one
 * reader with one set of numbers. What it does change is the heading, which
 * then states plainly that the model is looking at part of a file and which
 * part, so a clamped or narrowed range is never something the model has to
 * infer from the content it was given.
 *
 * @param realPath - The symlink-resolved path from a `"inside"` verdict.
 * @param heading - What to call the file in the emitted block, e.g.
 *   `"@src/auth.ts"` for a mention or `"src/auth.ts (attached)"` for an
 *   attachment. This is what makes a context block "say what it is".
 * @param range - Optional selection, 1-based and inclusive at both ends. See
 *   {@link LineRange} for the convention and {@link sliceRange} for what
 *   happens to one that does not fit.
 */
export async function readContextFile(
  realPath: string,
  heading: string,
  range?: LineRange,
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
    if (range) {
      // Refused rather than ignored, and refused before the read. `kind: "file"`
      // on a `.png` is the one way a range can reach here for something with no
      // lines — the wire validator rejects a range on `kind: "image"` outright.
      return {
        kind: "rangeRefused",
        reason: "is an image, and a line range means nothing for one",
      };
    }
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
  let selected = raw;
  let note = "";
  if (range) {
    const slice = sliceRange(raw, range);
    if (slice.outcome === "refused") return { kind: "rangeRefused", reason: slice.reason };
    selected = slice.content;
    note = ` — ${slice.note}`;
  }
  const { content, truncated } = truncateText(selected);
  const marker = truncated ? "\n… truncated (2000 line / 200KB cap)" : "";
  return {
    kind: "text",
    text: `\n\n${heading}${note}:\n\`\`\`\n${content}${marker}\n\`\`\``,
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
 * - A **`:12-34` suffix** (or `:12` for one line) narrows the mention to those
 *   lines, 1-based and inclusive at both ends — the same {@link LineRange}
 *   convention a `prompt` attachment's `range` speaks, read by the same
 *   reader. The injected block says it is an excerpt and which lines it holds.
 *   A suffix whose numbers cannot mean a range (`:0`, `:34-12`) is not a
 *   suffix, and the whole run is treated as a path, as it always was.
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
    let verdict = await confineToWorkspace(root, token.path);
    let range = token.range;
    if (range !== undefined && verdict.outcome === "missing" && token.raw !== token.path) {
      // The suffix might not have been a suffix. A file really named
      // `notes:12-34` is legal, and the literal reading has to win when the
      // stripped one resolves to nothing — but only then, so an ordinary
      // `@src/auth.ts:12-34` costs exactly one confinement call as before.
      const literal = await confineToWorkspace(root, token.raw);
      if (literal.outcome === "inside") {
        verdict = literal;
        range = undefined;
      }
    }
    if (verdict.outcome === "outside") {
      // Reported, not read. A `@here` in prose that happens not to exist stays
      // silent (the `"missing"` branch below); only an actual escape is worth
      // a sentence, so this stays quiet for ordinary typing.
      refusals.push({ what: `@${token.raw}`, reason: verdict.reason });
      continue;
    }
    if (verdict.outcome === "missing") continue;

    const content = await readContextFile(verdict.realPath, `@${verdict.relativePath}`, range);
    if (content.kind === "notAFile") continue;
    if (content.kind === "rangeRefused") {
      // Reported like an escape rather than skipped like a typo: the user
      // named lines, and a mention that quietly injected nothing is exactly
      // what the missing suffix used to do.
      refusals.push({ what: `@${token.raw}`, reason: content.reason });
      continue;
    }
    if (content.kind === "image") {
      images.push(content.content);
      imagePaths.push(verdict.relativePath);
      continue;
    }
    appended.push(content.text);
  }

  return { text: text + appended.join(""), images, imagePaths, refusals };
}
