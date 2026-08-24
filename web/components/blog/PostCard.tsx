import Link from "next/link";
import type { PostSummary } from "@/lib/blog";
import { cn } from "@/lib/cn";
import { PostMeta } from "./PostMeta";

/**
 * One row of the index list. An `<li>` — the caller owns the `<ul>` and the
 * hairlines between rows.
 *
 * From `md` up the metadata moves into a fixed left rail so the titles all
 * start on one line and the archive can be scanned by date; below that the
 * rail collapses to a caption above the title. The content column is
 * `minmax(0,1fr)` with `min-w-0` on the cell: a grid child's default
 * `min-width: auto` is exactly what dragged the phone layout past 360px in
 * the code-sample grid this week.
 */
export interface PostCardProps {
  post: PostSummary;
  className?: string;
}

export function PostCard({ post, className }: PostCardProps) {
  return (
    <li
      className={cn(
        "grid gap-2 py-8 first:pt-0 last:pb-0",
        "md:grid-cols-[9.5rem_minmax(0,1fr)] md:gap-x-8 md:gap-y-0",
        className,
      )}
    >
      <PostMeta
        date={post.date}
        readingTime={post.readingTime}
        layout="rail"
        className="min-w-0 md:pt-1.5"
      />

      <div className="min-w-0">
        <h2 className="text-h3 text-balance">
          <Link
            href={`/blog/${post.slug}`}
            className="text-text underline-offset-4 transition-colors dur-fast ease-out hover:text-accent hover:underline"
          >
            {post.title}
          </Link>
        </h2>
        <p className="mt-2 max-w-(--measure-body) text-body text-muted">{post.description}</p>
      </div>
    </li>
  );
}
