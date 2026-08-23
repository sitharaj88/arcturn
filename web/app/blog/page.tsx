import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { allPosts } from "@/lib/blog";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Blog",
  description: "Notes on building an agent harness you can audit.",
};

/**
 * The blog index (DESIGN.md §3.12). There is currently one post — the
 * layout is a deliberate single-column stack, not a grid with empty cells.
 */
export default function BlogIndexPage() {
  const posts = allPosts();

  return (
    <>
      <Container size="content" className="pt-16 md:pt-24">
        <PageHeader title="Blog" lede="Notes on building an agent harness you can audit." />
      </Container>

      <Container size="prose" className="py-16 md:py-20">
        <ul className="flex flex-col divide-y divide-default">
          {posts.map((post) => (
            <li key={post.slug} className="py-8 first:pt-0 last:pb-0">
              <p className="text-caption text-faint">
                <time dateTime={post.date}>{formatDate(post.date)}</time>
                <span aria-hidden="true"> · </span>
                {post.readingTime}
              </p>
              <h2 className="mt-2 text-h3">
                <Link
                  href={`/blog/${post.slug}`}
                  className="text-text underline-offset-4 hover:text-accent hover:underline"
                >
                  {post.title}
                </Link>
              </h2>
              <p className="mt-2 max-w-[60ch] text-body text-muted">{post.description}</p>
              <p className="mt-3 text-body-sm text-faint">{post.author}</p>
            </li>
          ))}
        </ul>
      </Container>
    </>
  );
}
