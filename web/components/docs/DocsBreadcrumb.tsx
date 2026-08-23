import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DocSection } from "@/lib/docs";

/**
 * `Docs / <Section> / <Title>`. Long titles push this past 360px, so it owns
 * its own horizontal scroll rather than widening the page (DESIGN.md §2.3.5).
 */
export interface DocsBreadcrumbProps {
  section: DocSection;
  title: string;
  className?: string;
}

export function DocsBreadcrumb({ section, title, className }: DocsBreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn("overflow-x-auto", className)}>
      <ol className="flex list-none items-center gap-2 whitespace-nowrap text-caption text-faint">
        <li>
          <Link href="/docs" className="transition-colors dur-fast ease-out hover:text-accent">
            Docs
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li>{section}</li>
        <li aria-hidden="true">/</li>
        <li className="text-muted" aria-current="page">
          {title}
        </li>
      </ol>
    </nav>
  );
}
