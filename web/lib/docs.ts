/**
 * The docs data layer (DESIGN.md §3.11).
 *
 * Everything here runs at build time only: `content/docs/*.md` is read from
 * disk, parsed with gray-matter and rendered to HTML with a unified pipeline
 * whose syntax highlighting is baked in by Shiki. Nothing in this module ever
 * reaches the browser, and the rendered pages ship with zero highlighting JS.
 *
 * Three facts drive the shape of the exports:
 *
 * 1. Sections are ordered by meaning, not alphabet — `Start`, `Core concepts`,
 *    `Extend`, `Reference` — so the order lives here as a constant.
 * 2. `order` is a float (`4.65`, `8.92`, `10.5`) so new pages can be slotted
 *    between existing ones. It must always be compared numerically.
 * 3. Prev/next is a walk of the *grouped* order flattened, not of the
 *    filesystem, so the reader moves through the docs the way the sidebar
 *    reads.
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
import type { Plugin } from "unified";
import { unified } from "unified";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The four doc sections, in the order the sidebar and index render them. */
export const DOC_SECTIONS = ["Start", "Core concepts", "Extend", "Reference"] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];

/** Frontmatter every file in `content/docs` is required to carry. */
export interface DocFrontmatter {
  title: string;
  description: string;
  section: DocSection;
  order: number;
}

/** A `h2`/`h3` extracted for the table of contents. */
export interface DocHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** A doc without its body — enough for nav, cards, prev/next and metadata. */
export interface DocMeta extends DocFrontmatter {
  slug: string;
  /** Relative path inside the repo, used by the "edit on GitHub" link. */
  sourcePath: string;
}

/** A fully rendered doc. */
export interface Doc extends DocMeta {
  html: string;
  headings: DocHeading[];
}

/** One sidebar / index group. */
export interface DocNavGroup {
  section: DocSection;
  items: DocMeta[];
}

/** The pages either side of a doc in the flattened nav order. */
export interface DocNeighbours {
  prev?: DocMeta;
  next?: DocMeta;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const DOCS_DIR = path.join(process.cwd(), "content", "docs");

/** Where the markdown lives in the repository, for edit links. */
const REPO_DOCS_PATH = "web/content/docs";

const REPO_BLOB_BASE = "https://github.com/sitharaj88/arcturn/blob/main";

/** The GitHub URL that edits a doc's markdown source. */
export function docEditUrl(slug: string): string {
  return `${REPO_BLOB_BASE}/${REPO_DOCS_PATH}/${slug}.md`;
}

/* ------------------------------------------------------------------ *
 * Minimal hast/mdast shapes
 *
 * `@types/hast` and `@types/mdast` are not direct dependencies of this
 * workspace, and adding one is not allowed here, so the handful of node
 * fields the custom plugins touch are declared structurally instead. This is
 * still fully typed — there is no `any` anywhere in the pipeline.
 * ------------------------------------------------------------------ */

interface UnistNode {
  type: string;
  children?: UnistNode[];
  value?: string;
}

interface HastElement extends UnistNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: UnistNode[];
}

function isElement(node: UnistNode): node is HastElement {
  return node.type === "element" && typeof (node as HastElement).tagName === "string";
}

/** Depth-first walk, parent-aware so plugins can replace a child in place. */
function walk(
  node: UnistNode,
  visitor: (node: UnistNode, parent: UnistNode | undefined, index: number) => void,
  parent?: UnistNode,
  index = 0,
): void {
  visitor(node, parent, index);
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i += 1) {
    walk(children[i], visitor, node, i);
  }
}

/** The visible text of a node, ignoring the autolink anchors. */
function textOf(node: UnistNode): string {
  if (node.type === "text") return node.value ?? "";
  if (isElement(node) && node.properties?.ariaHidden === "true") return "";
  return (node.children ?? []).map(textOf).join("");
}

function stringProperty(element: HastElement, key: string): string | undefined {
  const value = element.properties?.[key];
  return typeof value === "string" ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * Custom pipeline steps
 * ------------------------------------------------------------------ */

/**
 * Collect `h2`/`h3` for the table of contents.
 *
 * Runs after `rehype-slug` (so ids exist) and before the autolink plugin (so
 * the `#` anchor never leaks into the heading text).
 */
function collectHeadings(sink: DocHeading[]): Plugin<[], UnistNode> {
  return () => (tree: UnistNode) => {
    walk(tree, (node) => {
      if (!isElement(node)) return;
      const depth = node.tagName === "h2" ? 2 : node.tagName === "h3" ? 3 : undefined;
      if (depth === undefined) return;
      const id = stringProperty(node, "id");
      if (!id) return;
      const text = textOf(node).trim();
      if (!text) return;
      sink.push({ id, text, depth });
    });
  };
}

/**
 * Turn raw HTML nodes back into literal text.
 *
 * None of the docs use HTML on purpose, but plenty of them write placeholders
 * like `<provider>` or `(<reason>)` in prose. Markdown parses those as raw
 * HTML: dropped by default (the words silently vanish) or passed through as a
 * bogus element (the browser swallows them). Rendering them as text is the
 * only option that preserves what the author wrote.
 */
const rawHtmlAsText: Plugin<[], UnistNode> = () => (tree: UnistNode) => {
  walk(tree, (node) => {
    if (node.type === "html") {
      node.type = "text";
    }
  });
};

/**
 * Record every fenced block's raw source, in document order, before Shiki
 * tokenises it away. The matching rehype step hands it back to the copy
 * button as a `data-code` attribute, so the clipboard gets the source rather
 * than a reconstruction of the highlighted DOM.
 */
function collectCode(sink: string[]): Plugin<[], UnistNode> {
  return () => (tree: UnistNode) => {
    walk(tree, (node) => {
      if (node.type !== "code") return;
      sink.push((node.value ?? "").replace(/\n+$/, ""));
    });
  };
}

/**
 * Finish the code figures: attach the recorded source, hoist the language
 * onto the figure for the chip, and give the client copy layer a hook.
 *
 * Runs after `rehype-pretty-code`, which emits one
 * `figure[data-rehype-pretty-code-figure]` per fenced block, in the same
 * order the remark step recorded them.
 */
function decorateCodeFigures(codes: readonly string[]): Plugin<[], UnistNode> {
  return () => (tree: UnistNode) => {
    let index = 0;
    walk(tree, (node) => {
      if (!isElement(node)) return;
      if (node.tagName !== "figure") return;
      const properties = node.properties ?? {};
      if (!("data-rehype-pretty-code-figure" in properties)) return;

      const pre = (node.children ?? []).find(
        (child): child is HastElement => isElement(child) && child.tagName === "pre",
      );
      const language = pre ? stringProperty(pre, "data-language") : undefined;
      const source = codes[index] ?? "";
      index += 1;

      node.properties = {
        ...properties,
        className: ["code-figure"],
        "data-code": source,
      };

      if (language && language !== "text" && language !== "plaintext") {
        const chip: HastElement = {
          type: "element",
          tagName: "span",
          properties: { className: ["code-lang"], "aria-hidden": "true" },
          children: [{ type: "text", value: language }],
        };
        node.children.unshift(chip);
      }
    });
  };
}

/**
 * Give every prose table its own horizontal scroll container. `body` must
 * never scroll sideways at 360px (DESIGN.md §2.3.5), and several reference
 * docs have five-column tables.
 */
const wrapTables: Plugin<[], UnistNode> = () => (tree: UnistNode) => {
  walk(tree, (node, parent, index) => {
    if (!parent?.children) return;
    if (!isElement(node) || node.tagName !== "table") return;
    const wrapper: HastElement = {
      type: "element",
      tagName: "div",
      properties: { className: ["table-scroll"] },
      children: [node],
    };
    parent.children[index] = wrapper;
  });
};

/**
 * Match `trailingSlash: true`.
 *
 * The markdown writes `/docs/permissions`; the static export emits
 * `docs/permissions/index.html`. Rewriting the href to `/docs/permissions/`
 * means the browser asks for exactly the file that exists, instead of relying
 * on the host to redirect. Fragments and query strings are preserved.
 */
const normalizeInternalLinks: Plugin<[], UnistNode> = () => (tree: UnistNode) => {
  walk(tree, (node) => {
    if (!isElement(node) || node.tagName !== "a") return;
    const href = stringProperty(node, "href");
    if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) return;

    const match = /^([^?#]*)(.*)$/.exec(href);
    if (!match) return;
    const [, pathname, suffix] = match;
    if (pathname.endsWith("/") || /\.[a-z0-9]+$/i.test(pathname)) return;

    node.properties = { ...(node.properties ?? {}), href: `${pathname}/${suffix}` };
  });
};

/**
 * Harden links that leave the site. Markdown authors write plain URLs; a
 * static export cannot patch this at runtime.
 */
const hardenExternalLinks: Plugin<[], UnistNode> = () => (tree: UnistNode) => {
  walk(tree, (node) => {
    if (!isElement(node) || node.tagName !== "a") return;
    const href = stringProperty(node, "href");
    if (!href || !/^https?:\/\//.test(href)) return;
    node.properties = {
      ...(node.properties ?? {}),
      target: "_blank",
      rel: ["noopener", "noreferrer"],
    };
  });
};

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/** Result of rendering one markdown document. */
export interface RenderedMarkdown {
  html: string;
  headings: DocHeading[];
}

/**
 * Render markdown to the site's prose HTML.
 *
 * A *record* theme makes rehype-pretty-code run Shiki with both palettes at
 * once, so every token carries a `--shiki-light` and a `--shiki-dark` custom
 * property; `globals.css` picks between them per theme, and switching themes
 * costs no JavaScript at all (DESIGN.md §2.2.4).
 */
export async function renderMarkdown(source: string): Promise<RenderedMarkdown> {
  const headings: DocHeading[] = [];
  const codes: string[] = [];

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(rawHtmlAsText)
    .use(collectCode(codes))
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(collectHeadings(headings))
    .use(rehypeAutolinkHeadings, {
      behavior: "append",
      properties: {
        className: ["heading-anchor"],
        ariaHidden: "true",
        tabIndex: -1,
      },
      content: { type: "text", value: "#" },
    })
    .use(rehypePrettyCode, {
      // A theme *record* makes rehype-pretty-code emit both palettes as
      // `--shiki-light` / `--shiki-dark` custom properties on every token,
      // which is exactly what globals.css switches between.
      theme: { light: "github-light", dark: "github-dark-default" },
      keepBackground: false,
      defaultLang: "text",
      bypassInlineCode: true,
    })
    .use(decorateCodeFigures(codes))
    .use(wrapTables)
    .use(normalizeInternalLinks)
    .use(hardenExternalLinks)
    .use(rehypeStringify)
    .process(source);

  return { html: String(file), headings };
}

/* ------------------------------------------------------------------ *
 * Reading the corpus
 * ------------------------------------------------------------------ */

function isDocSection(value: unknown): value is DocSection {
  return typeof value === "string" && (DOC_SECTIONS as readonly string[]).includes(value);
}

function parseFrontmatter(slug: string, data: Record<string, unknown>): DocFrontmatter {
  const { title, description, section, order } = data;
  if (typeof title !== "string" || title.length === 0) {
    throw new Error(`content/docs/${slug}.md: frontmatter "title" is required`);
  }
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(`content/docs/${slug}.md: frontmatter "description" is required`);
  }
  if (!isDocSection(section)) {
    throw new Error(
      `content/docs/${slug}.md: frontmatter "section" must be one of ${DOC_SECTIONS.join(", ")}`,
    );
  }
  const numericOrder = typeof order === "number" ? order : Number(order);
  if (!Number.isFinite(numericOrder)) {
    throw new Error(`content/docs/${slug}.md: frontmatter "order" must be a number`);
  }
  return { title, description, section, order: numericOrder };
}

interface DocSource extends DocMeta {
  body: string;
}

let cache: DocSource[] | undefined;

/** Read and validate every doc once per build. */
function readDocs(): DocSource[] {
  if (cache) return cache;

  const files = readdirSync(DOCS_DIR).filter((name) => name.endsWith(".md"));
  const docs = files.map((name): DocSource => {
    const slug = name.replace(/\.md$/, "");
    const raw = readFileSync(path.join(DOCS_DIR, name), "utf8");
    const parsed = matter(raw);
    const frontmatter = parseFrontmatter(slug, parsed.data as Record<string, unknown>);
    return {
      ...frontmatter,
      slug,
      sourcePath: `${REPO_DOCS_PATH}/${name}`,
      body: parsed.content,
    };
  });

  cache = docs;
  return docs;
}

function toMeta({ body: _body, ...meta }: DocSource): DocMeta {
  return meta;
}

/* ------------------------------------------------------------------ *
 * Public helpers
 * ------------------------------------------------------------------ */

/**
 * Every doc, flattened in nav order: sections in `DOC_SECTIONS` order, and
 * within a section by ascending numeric `order`. This is also the prev/next
 * sequence.
 */
export function allDocs(): DocMeta[] {
  return docNav().flatMap((group) => group.items);
}

/** The docs grouped for the sidebar and the index page. */
export function docNav(): DocNavGroup[] {
  const docs = readDocs();
  return DOC_SECTIONS.map((section) => ({
    section,
    items: docs
      .filter((doc) => doc.section === section)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map(toMeta),
  })).filter((group) => group.items.length > 0);
}

/** Every slug, for `generateStaticParams`. */
export function docSlugs(): string[] {
  return readDocs().map((doc) => doc.slug);
}

/** Frontmatter only — cheap enough to call from `generateMetadata`. */
export function docMetaBySlug(slug: string): DocMeta | undefined {
  const doc = readDocs().find((entry) => entry.slug === slug);
  return doc ? toMeta(doc) : undefined;
}

/** A doc with its body rendered. Returns `undefined` for an unknown slug. */
export async function docBySlug(slug: string): Promise<Doc | undefined> {
  const doc = readDocs().find((entry) => entry.slug === slug);
  if (!doc) return undefined;
  const { html, headings } = await renderMarkdown(doc.body);
  return { ...toMeta(doc), html, headings };
}

/** The pages either side of `slug`; either may be absent at the ends. */
export function docNeighbours(slug: string): DocNeighbours {
  const flat = allDocs();
  const index = flat.findIndex((doc) => doc.slug === slug);
  if (index === -1) return {};
  return {
    prev: index > 0 ? flat[index - 1] : undefined,
    next: index < flat.length - 1 ? flat[index + 1] : undefined,
  };
}
