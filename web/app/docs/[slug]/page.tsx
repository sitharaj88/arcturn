import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  CodeCopyLayer,
  DocsBreadcrumb,
  DocsNavDrawer,
  DocsPrevNext,
  DocsSidebar,
  EditOnGitHub,
  TableOfContents,
  TocDisclosure,
} from "@/components/docs";
import { Prose } from "@/components/ui/Prose";
import { docBySlug, docMetaBySlug, docNav, docNeighbours, docSlugs } from "@/lib/docs";

/** The element the copy layer scans; also the article's own landmark id. */
const ARTICLE_ID = "doc-article";

interface DocPageProps {
  /** Next 16 hands params in as a promise — it must be awaited. */
  params: Promise<{ slug: string }>;
}

/** One static page per markdown file; required by `output: "export"`. */
export function generateStaticParams(): { slug: string }[] {
  return docSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: DocPageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = docMetaBySlug(slug);
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description,
    openGraph: { title: `${doc.title} — Arcturn`, description: doc.description },
    twitter: {
      card: "summary_large_image",
      title: `${doc.title} — Arcturn`,
      description: doc.description,
    },
  };
}

export default async function DocPage({ params }: DocPageProps) {
  const { slug } = await params;
  const doc = await docBySlug(slug);
  if (!doc) notFound();

  const nav = docNav();
  const { prev, next } = docNeighbours(slug);

  return (
    <div className="container-shell">
      <DocsNavDrawer nav={nav} activeSlug={slug} section={doc.section} title={doc.title} />

      <div className="grid gap-10 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_15rem]">
        <DocsSidebar nav={nav} activeSlug={slug} className="hidden lg:block" />

        <article id={ARTICLE_ID} className="docs-article py-10 lg:py-14">
          <DocsBreadcrumb section={doc.section} title={doc.title} />

          <h1 className="mt-5 text-display-2 text-balance text-text">{doc.title}</h1>
          <p className="mt-4 max-w-[60ch] text-lede text-muted">{doc.description}</p>

          <hr className="mt-8 border-0 border-t border-default" />

          <TocDisclosure headings={doc.headings} className="mt-8" />

          <Prose html={doc.html} className="mt-10" />

          <hr className="mt-16 border-0 border-t border-default" />

          <div className="mt-4">
            <EditOnGitHub slug={slug} />
          </div>

          <DocsPrevNext prev={prev} next={next} className="mt-8" />

          {/* Adds the copy buttons to the build-time code figures above. */}
          <CodeCopyLayer containerId={ARTICLE_ID} />
        </article>

        <TableOfContents headings={doc.headings} className="hidden xl:block" />
      </div>
    </div>
  );
}
