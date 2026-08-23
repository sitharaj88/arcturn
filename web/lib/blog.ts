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

const BLOG_DIR = path.join(process.cwd(), "content", "blog");

/** Frontmatter shape every post in `content/blog/*.md` must have. */
export interface PostFrontmatter {
  title: string;
  description: string;
  /** ISO date string, e.g. "2026-08-20". */
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

function readingTimeFrom(markdown: string): string {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

async function renderMarkdown(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
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
        date: fm.date,
        author: fm.author,
        readingTime: readingTimeFrom(content),
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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
    date: fm.date,
    author: fm.author,
    html,
    readingTime: readingTimeFrom(content),
  };
}
