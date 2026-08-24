/**
 * Blog data layer (DESIGN.md §3.12).
 *
 * Reads `content/blog/*.md` with `gray-matter` and renders markdown through
 * the same pipeline shape the docs use — `unified → remark-parse →
 * remark-gfm → remark-rehype → rehype-slug → rehype-autolink-headings →
 * rehype-pretty-code → rehype-stringify` — with build-time dual-theme Shiki
 * highlighting (zero client JS).
 *
 * Note on duplication: `web/lib/docs.ts` does not exist at the time this
 * file was written, so this is a self-contained copy of the pipeline rather
 * than a shared import. If a docs pipeline lands later, the two renderers
 * are candidates for consolidation into one `lib/markdown.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import {
  collectCode,
  decorateCodeFigures,
  hardenExternalLinks,
  normalizeInternalLinks,
  wrapTables,
} from "./docs";

const BLOG_DIR = path.join(process.cwd(), "content", "blog");

/** Frontmatter shape every post in `content/blog/*.md` must have. */
export interface PostFrontmatter {
  title: string;
  description: string;
  /**
   * ISO date string, e.g. "2026-08-20". YAML resolves the unquoted form to a
   * `Date`, so `isoDate` below normalises it back before it leaves this
   * module — everything downstream can rely on the string.
   */
  date: string;
  author: string;
}

export interface Post extends PostFrontmatter {
  slug: string;
  /** Rendered HTML body, ready for `<Prose html={...} />`. */
  html: string;
  /** Honest word-count-derived estimate, e.g. "4 min read". */
  readingTime: string;
}

export interface PostSummary extends PostFrontmatter {
  slug: string;
  readingTime: string;
}

/**
 * Normalise a frontmatter date to `YYYY-MM-DD`.
 *
 * Posts write the date unquoted (`date: 2026-08-24`), and YAML resolves that
 * to a `Date`, not a string — so `data.date` arrives as an object however the
 * interface above types it. Left alone it reached `<time dateTime>` as
 * `"Mon Aug 24 2026 05:30:00 GMT+0530 (India Standard Time)"`, which is not a
 * valid datetime value, and `article:published_time` as `"[object Object]"`.
 * It also broke sorting: two `Date` objects for the same day are never `===`,
 * so same-day posts could not be detected as ties.
 *
 * A bare `yyyy-mm-dd` resolves at UTC midnight, so slicing the ISO string
 * returns the day the author typed with no timezone drift. A quoted date is
 * already a string and passes through the same slice.
 */
function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function readingTimeFrom(markdown: string): string {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

async function renderMarkdown(markdown: string): Promise<string> {
  // Raw fence sources, in document order — decorateCodeFigures pairs them
  // back up with the highlighted figures so the copy button gets the source,
  // not a reconstruction of the token spans.
  const codes: string[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(collectCode(codes))
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: "append",
      properties: { className: ["heading-anchor"], ariaHidden: "true", tabIndex: -1 },
      content: { type: "text", value: " #" },
    })
    .use(rehypePrettyCode, {
      theme: { light: "github-light", dark: "github-dark-default" },
      defaultLang: "text",
    })
    // Shared with the docs pipeline (see the export note in docs.ts): code
    // figures get the one header bar with the copy hook, tables get their own
    // scroll container, internal hrefs match trailingSlash, and external
    // links are hardened — properties a post needs no less than a doc.
    .use(decorateCodeFigures(codes))
    .use(wrapTables)
    .use(normalizeInternalLinks)
    .use(hardenExternalLinks)
    .use(rehypeStringify)
    .process(markdown);

  return String(file);
}

function slugFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "");
}

/** Every post slug — filename stems of `content/blog/*.md`. */
export function allPostSlugs(): string[] {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith(".md"))
    .map(slugFromFilename);
}

/** Every post, newest first by `date`, without the rendered HTML body. */
export function allPosts(): PostSummary[] {
  return allPostSlugs()
    .map((slug) => {
      const raw = readFileSync(path.join(BLOG_DIR, `${slug}.md`), "utf8");
      const { data, content } = matter(raw);
      const fm = data as PostFrontmatter;
      return {
        slug,
        title: fm.title,
        description: fm.description,
        date: isoDate(fm.date),
        author: fm.author,
        readingTime: readingTimeFrom(content),
      };
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      // Three posts currently share 2026-08-24, so ties are not hypothetical.
      // Without an explicit tiebreak the order is whatever `readdirSync`
      // returns, which POSIX does not define — the featured slot and the
      // prev/next links below would then differ between machines. Compared
      // as plain strings, not `localeCompare`, because that reads the
      // build machine's locale.
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
}

/**
 * The chronological neighbours of a post, in the order `allPosts()` sorts by:
 * `newer` was published after it, `older` before it. Either is `undefined` at
 * the ends of the sequence, and both are for a slug that has no post.
 */
export interface PostNeighbours {
  newer?: PostSummary;
  older?: PostSummary;
}

/** The posts either side of `slug`. Pure — it re-reads the same directory. */
export function adjacentPosts(slug: string): PostNeighbours {
  const posts = allPosts();
  const index = posts.findIndex((post) => post.slug === slug);
  if (index === -1) return {};
  return {
    // Not `posts.at(index - 1)`: at the newest post that is `at(-1)`, which
    // wraps to the oldest and links the sequence into a loop.
    newer: index > 0 ? posts[index - 1] : undefined,
    older: posts.at(index + 1),
  };
}

/** One post by slug, rendered to HTML, or `undefined` if it doesn't exist. */
export async function postBySlug(slug: string): Promise<Post | undefined> {
  let raw: string;
  try {
    raw = readFileSync(path.join(BLOG_DIR, `${slug}.md`), "utf8");
  } catch {
    return undefined;
  }
  const { data, content } = matter(raw);
  const fm = data as PostFrontmatter;
  const html = await renderMarkdown(content);
  return {
    slug,
    title: fm.title,
    description: fm.description,
    date: isoDate(fm.date),
    author: fm.author,
    html,
    readingTime: readingTimeFrom(content),
  };
}
