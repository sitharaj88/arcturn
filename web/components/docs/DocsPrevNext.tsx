import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DocNeighbours } from "@/lib/docs";

/**
 * Foot-of-article pagination in the sidebar's order. Either side may be
 * absent at the ends of the sequence; the remaining card keeps its side of
 * the row so "next" never slides left into the "previous" slot.
 */
export interface DocsPrevNextProps extends DocNeighbours {
  className?: string;
}

export function DocsPrevNext({ prev, next, className }: DocsPrevNextProps) {
  if (!prev && !next) return null;

  const card =
    "group flex min-h-11 flex-col justify-center gap-1 rounded-lg border border-default bg-surface-card p-4 transition-[background-color,border-color] dur-fast ease-out hover:border-strong hover:bg-surface-hover";

  return (
    <nav
      aria-label="Documentation pagination"
      className={cn("grid gap-4 sm:grid-cols-2", className)}
    >
      {prev ? (
        <Link href={`/docs/${prev.slug}`} className={cn(card, "sm:col-start-1")} rel="prev">
          <span className="flex items-center gap-1.5 text-caption text-faint">
            <ArrowLeft
              className="size-3.5 transition-transform dur-fast ease-out group-hover:-translate-x-0.5"
              aria-hidden="true"
            />
            Previous
          </span>
          <span className="text-body-sm font-medium text-text">{prev.title}</span>
        </Link>
      ) : null}

      {next ? (
        <Link
          href={`/docs/${next.slug}`}
          className={cn(card, "sm:col-start-2 sm:items-end sm:text-right")}
          rel="next"
        >
          <span className="flex items-center gap-1.5 text-caption text-faint">
            Next
            <ArrowRight
              className="size-3.5 transition-transform dur-fast ease-out group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </span>
          <span className="text-body-sm font-medium text-text">{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
