import type { Metadata } from "next";
import { FeaturedPost } from "@/components/blog/FeaturedPost";
import { PostCard } from "@/components/blog/PostCard";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { allPosts } from "@/lib/blog";

const LEDE = "Notes on building an agent harness you can audit.";

export const metadata: Metadata = {
  title: "Blog",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Blog — Arcturn",
    description: LEDE,
    url: "/blog",
  },
};

/**
 * The blog index (DESIGN.md §3.12): the newest post on a band, then the rest
 * as a dated chronological list.
 *
 * **Why a list and not a two-column card grid.** The archive is a sequence,
 * and a sequence read left-to-right-then-down is harder to scan by date than
 * one read straight down — the date rail on each row is doing the work a
 * grid's second column would take away. It also degrades in both directions
 * without a special case: the featured slot always consumes one post, so a
 * grid's remainder is odd whenever the total is even, and a build that
 * catches this page with a single post would leave a two-column grid with one
 * filled cell and one hole. Here it leaves the featured band alone on the
 * page, which is the correct answer rather than a fallback.
 *
 * Every heading below the `h1` is an `h2`; the list titles take the `h3` size
 * without taking the level, so the order stays valid with no intermediate
 * heading invented to carry the "Earlier posts" label.
 */
export default function BlogIndexPage() {
  const posts = allPosts();
  const featured = posts.at(0);
  const earlier = posts.slice(1);

  return (
    <>
      <Container className="pb-12 pt-16 md:pb-16 md:pt-20">
        <PageHeader eyebrow="Project" title="Blog" lede={LEDE} />
      </Container>

      {featured ? <FeaturedPost post={featured} /> : null}

      {earlier.length > 0 ? (
        <Section eyebrow="Earlier posts">
          <ul className="flex flex-col divide-y divide-default">
            {earlier.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </ul>
        </Section>
      ) : null}

      {featured ? null : (
        <Container className="pb-16 md:pb-20">
          <p className="max-w-(--measure-body) text-body text-muted">
            Nothing published yet. The first post will appear here.
          </p>
        </Container>
      )}
    </>
  );
}
