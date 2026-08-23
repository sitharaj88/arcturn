import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuthorCard } from "@/components/site/AuthorCard";
import { CTASection } from "@/components/site/CTASection";
import { Container } from "@/components/ui/Container";
import { Prose } from "@/components/ui/Prose";
import { allPostSlugs, postBySlug } from "@/lib/blog";
import { formatDate, SITE_URL } from "@/lib/utils";

interface BlogPostPageProps {
  params: Promise<{ slug: string }>;
}

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

  return (
    <Container size="prose" className="py-16 md:py-24">
      <Link
        href="/blog"
        className="inline-flex items-center gap-1.5 text-body-sm text-muted transition-colors dur-fast ease-out hover:text-accent"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        All posts
      </Link>

      <header className="mt-6">
        <h1 className="text-display-2 text-balance text-text">{post.title}</h1>
        <p className="mt-4 text-caption text-faint">
          <time dateTime={post.date}>{formatDate(post.date)}</time>
          <span aria-hidden="true"> · </span>
          {post.author}
          <span aria-hidden="true"> · </span>
          {post.readingTime}
        </p>
      </header>

      <hr className="mt-8 border-default" />

      <Prose html={post.html} className="mt-10" />

      <div className="mt-16 flex flex-col gap-10">
        <AuthorCard />
        <CTASection variant="compact" />
      </div>
    </Container>
  );
}
