import { readdirSync } from "node:fs";
import path from "node:path";
import type { MetadataRoute } from "next";
import { allPostSlugs } from "@/lib/blog";
import { SITE_URL } from "@/lib/utils";

/** Required by `output: "export"` — this route has no per-request data. */
export const dynamic = "force-static";

/** Static routes that don't come from `content/**` (DESIGN.md §5.4). */
const STATIC_ROUTES = [
  "/",
  "/features",
  "/features/control",
  "/features/accountability",
  "/features/extensibility",
  "/features/models",
  "/sdk",
  "/security",
  "/terminal",
  "/open-source",
  "/docs",
  "/blog",
];

function docSlugs(): string[] {
  const dir = path.join(process.cwd(), "content", "docs");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/, ""));
}

/**
 * Statically exportable sitemap (`output: "export"` supports build-time
 * `MetadataRoute.Sitemap`). Covers every URL in DESIGN.md §5.4: the static
 * pages, every doc slug and every blog slug.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: now,
  }));

  const docEntries: MetadataRoute.Sitemap = docSlugs().map((slug) => ({
    url: `${SITE_URL}/docs/${slug}`,
    lastModified: now,
  }));

  const blogEntries: MetadataRoute.Sitemap = allPostSlugs().map((slug) => ({
    url: `${SITE_URL}/blog/${slug}`,
    lastModified: now,
  }));

  return [...staticEntries, ...docEntries, ...blogEntries];
}
