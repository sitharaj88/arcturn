import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { cardSurface } from "@/components/ui/Card";
import type { PostNeighbours } from "@/lib/blog";
import { cn } from "@/lib/cn";

/**
 * Foot-of-post navigation through the archive, in publication order: the
 * older post on the left with `rel="prev"`, the newer one on the right with
 * `rel="next"`. Either side is absent at the ends of the sequence, and the
 * remaining card keeps its own column so "newer" never slides left into the
 * slot the reader has learned means "older".
 *
 * The surface comes from `cardSurface()` rather than a retyped
 * `border-default bg-surface-card`, so a change to the Card palette reaches
 * these too.
 */
export interface BlogPrevNextProps extends PostNeighbours {
  className?: string;
}

const CARD = cn(
  "group flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-lg border p-4",
  "transition-[background-color,border-color] dur-fast ease-out hover:border-strong hover:bg-surface-hover",
  cardSurface(),
);

const LABEL =
  "flex items-center gap-1.5 text-caption text-faint transition-colors dur-fast ease-out group-hover:text-muted";

const ARROW = "size-3.5 transition-transform dur-fast ease-out";

export function BlogPrevNext({ newer, older, className }: BlogPrevNextProps) {
  if (!newer && !older) return null;

  return (
    <nav aria-label="More posts" className={cn("grid gap-4 sm:grid-cols-2", className)}>
      {older ? (
        <Link href={`/blog/${older.slug}`} rel="prev" className={cn(CARD, "sm:col-start-1")}>
          <span className={LABEL}>
            <ArrowLeft aria-hidden="true" className={cn(ARROW, "group-hover:-translate-x-0.5")} />
            Older post
          </span>
          <span className="min-w-0 text-body-sm font-medium text-text">{older.title}</span>
        </Link>
      ) : null}

      {newer ? (
        <Link
          href={`/blog/${newer.slug}`}
          rel="next"
          className={cn(CARD, "sm:col-start-2 sm:items-end sm:text-right")}
        >
          <span className={LABEL}>
            Newer post
            <ArrowRight aria-hidden="true" className={cn(ARROW, "group-hover:translate-x-0.5")} />
          </span>
          <span className="min-w-0 text-body-sm font-medium text-text">{newer.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
