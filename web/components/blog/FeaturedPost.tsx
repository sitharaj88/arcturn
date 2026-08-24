import Link from "next/link";
import { SectionLink } from "@/components/marketing/SectionLink";
import { ArcEyebrow } from "@/components/ui/ArcEyebrow";
import { Container } from "@/components/ui/Container";
import { SECTION_BAND, SECTION_RHYTHM } from "@/components/ui/Section";
import type { PostSummary } from "@/lib/blog";
import { cn } from "@/lib/cn";
import { PostMeta } from "./PostMeta";

/**
 * The newest post, given the whole width of a band (DESIGN.md §2.3.1).
 *
 * The site has no stock photography, so the "start here" signal has to come
 * from ground and type: one step of `--surface-raised` between two hairlines,
 * the title at `h2` rather than the list's `h3`, and the description at full
 * lede size instead of body. That is also why this is a band and not a card —
 * a card would put the featured post *inside* the same rectangle vocabulary
 * as the list below it, and the point is that it is not one of them.
 *
 * Two links to the same post is deliberate: the title carries the accessible
 * name, and `Read the post` is the affordance a reader looks for at the end
 * of a description. Both are short, so neither produces a paragraph-length
 * link name the way wrapping the whole block in one anchor would.
 */
export interface FeaturedPostProps {
  post: PostSummary;
  className?: string;
}

export function FeaturedPost({ post, className }: FeaturedPostProps) {
  const href = `/blog/${post.slug}`;

  return (
    <section className={cn(SECTION_RHYTHM.default, SECTION_BAND, className)}>
      <Container>
        {/* Not a heading: the h2 below is this block's heading, and a second
            one here would put "Latest" above the post's own title. */}
        <p className="flex items-center gap-2 text-eyebrow uppercase text-faint">
          <ArcEyebrow />
          <span>Latest</span>
        </p>

        <h2 className="mt-4 max-w-(--measure-body) text-h2 text-balance">
          <Link
            href={href}
            className="text-text underline-offset-4 transition-colors dur-fast ease-out hover:text-accent hover:underline"
          >
            {post.title}
          </Link>
        </h2>

        <p className="mt-4 max-w-(--measure-lede) text-lede text-muted">{post.description}</p>

        <PostMeta
          date={post.date}
          author={post.author}
          readingTime={post.readingTime}
          className="mt-5"
        />

        <SectionLink href={href} className="mt-4">
          Read the post
        </SectionLink>
      </Container>
    </section>
  );
}
