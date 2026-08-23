import type { ReactNode } from "react";
import { ArcEyebrow } from "@/components/ui/ArcEyebrow";
import { cn } from "@/lib/cn";

/**
 * The interior-page section: eyebrow, `h2`, body copy at a readable measure,
 * and one supporting block (a table, a code sample, terminal art) beneath it.
 * Feature pages are a stack of these.
 */
export interface ProseSectionProps {
  id?: string;
  eyebrow?: string;
  title: string;
  /** The supporting block rendered below the copy. */
  media?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function ProseSection({
  id,
  eyebrow,
  title,
  media,
  className,
  children,
}: ProseSectionProps) {
  return (
    <section id={id} className={cn("scroll-mt-20", className)}>
      {eyebrow ? (
        <p className="flex items-center gap-2 text-eyebrow uppercase text-faint">
          <ArcEyebrow />
          <span>{eyebrow}</span>
        </p>
      ) : null}
      <h2 className={cn("text-h2 text-balance text-text", eyebrow && "mt-3")}>{title}</h2>
      <div className="mt-5 flex max-w-[68ch] flex-col gap-4 text-body text-muted">{children}</div>
      {media ? <div className="mt-8">{media}</div> : null}
    </section>
  );
}
