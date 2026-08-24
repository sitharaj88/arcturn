import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/utils";

/**
 * The caption line every blog surface shares (DESIGN.md §3.12): date, then
 * optionally the author, then the reading time. One component so the index,
 * the featured slot and the post header cannot drift into three formats.
 *
 * `formatDate` pins locale and time zone; the raw ISO string stays in
 * `<time dateTime>` for machines.
 */
export type PostMetaLayout = "inline" | "rail";

export interface PostMetaProps {
  /** ISO date string from the frontmatter. */
  date: string;
  readingTime: string;
  /** Omitted where the author is already named nearby. */
  author?: string;
  /** `rail` stacks onto its own column from `md` up, for the index list. */
  layout?: PostMetaLayout;
  className?: string;
}

const LAYOUT: Record<PostMetaLayout, string> = {
  inline: "flex flex-wrap items-center gap-x-2 gap-y-1",
  rail: "flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-col md:items-start md:gap-x-0",
};

/** In the rail the line break already separates the items, so the dot goes. */
const SEPARATOR: Record<PostMetaLayout, string> = {
  inline: "",
  rail: "md:hidden",
};

export function PostMeta({
  date,
  readingTime,
  author,
  layout = "inline",
  className,
}: PostMetaProps) {
  const separator = SEPARATOR[layout];

  return (
    <p className={cn("text-caption text-faint", LAYOUT[layout], className)}>
      <time dateTime={date}>{formatDate(date)}</time>
      {author ? (
        <>
          <span aria-hidden="true" className={separator}>
            ·
          </span>
          <span>{author}</span>
        </>
      ) : null}
      <span aria-hidden="true" className={separator}>
        ·
      </span>
      <span>{readingTime}</span>
    </p>
  );
}
