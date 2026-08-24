import { ArrowLeft } from "lucide-react";
// The shared code-block chrome (`.code-figure`, `.code-head`, the copy slot).
// Docs get it from their layout and marketing pages get it through
// `<CodeBlock>`'s own import — a blog post renders the pipeline's raw HTML
// with neither on the page, so without this import the header bar ships
// unstyled: an invisible strip with a floating copy button.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import "@/app/docs/docs.css";
import { BlogPrevNext } from "@/components/blog/BlogPrevNext";
import { PostMeta } from "@/components/blog/PostMeta";
import { ReadingProgress } from "@/components/blog/ReadingProgress";
import { CodeCopyLayer } from "@/components/docs/CodeCopyLayer";
import { AuthorCard } from "@/components/site/AuthorCard";
import { CTASection } from "@/components/site/CTASection";
import { Container } from "@/components/ui/Container";
import { Prose } from "@/components/ui/Prose";
import { adjacentPosts, allPostSlugs, postBySlug } from "@/lib/blog";
import { SITE_URL } from "@/lib/utils";

interface BlogPostPageProps {
  params: Promise<{ slug: string }>;
}

/** The element the reading-progress bar measures: the header and the body. */
const ARTICLE_ID = "post-article";

export function generateStaticParams(): { slug: string }[] {
  return allPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await postBySlug(slug);
  if (!post) return {};

  const url = `${SITE_URL}/blog/${post.slug}`;
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      url,
      siteName: "Arcturn",
      publishedTime: post.date,
      authors: [post.author],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
    },
  };
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = await postBySlug(slug);
  if (!post) notFound();

  const { newer, older } = adjacentPosts(slug);

  return (
    <>
      <ReadingProgress targetId={ARTICLE_ID} />
      <CodeCopyLayer containerId={ARTICLE_ID} />

      <Container size="prose" className="pb-16 pt-16 md:pb-20 md:pt-24">
        <Link
          href="/blog"
          className="inline-flex min-h-11 items-center gap-1.5 text-body-sm text-muted transition-colors dur-fast ease-out hover:text-accent sm:min-h-0"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All posts
        </Link>

        <article id={ARTICLE_ID} className="mt-6">
          <header>
            {/* `text-display-2` is the interior-page display size, matching
                every other `h1` on the site. It gets `text-balance` and no
                max-width of its own: at this size the prose column is already
                a ~22-character line, and a measure token on top of it would
                narrow the title below its own container for no reason. The
                description underneath takes `--measure-lede`, which is the
                one measure a lede uses site-wide. */}
            <h1 className="text-display-2 text-balance text-text">{post.title}</h1>
            <p className="mt-4 max-w-(--measure-lede) text-lede text-muted">{post.description}</p>
            <PostMeta
              date={post.date}
              author={post.author}
              readingTime={post.readingTime}
              className="mt-6"
            />
          </header>

          <hr className="mt-8 border-0 border-t border-default" />

          <Prose html={post.html} className="mt-10" />
        </article>

        <hr className="mt-16 border-0 border-t border-default" />

        <BlogPrevNext newer={newer} older={older} className="mt-8" />

        <AuthorCard className="mt-16" />
      </Container>

      {/* Outside the `container-prose` above: `CTASection` renders its own
          container, and nesting the two doubled the horizontal padding.
          No `band` — every other page closes on the page ground, and the
          footer is already a raised surface a beat below it. */}
      <CTASection variant="compact" />
    </>
  );
}
