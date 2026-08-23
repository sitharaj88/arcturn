import { cn } from "@/lib/cn";
import type { DocNavGroup } from "@/lib/docs";
import { DocsNavList } from "./DocsNavList";

/**
 * The ≥1024px documentation sidebar: sticky under the 4rem header, scrolling
 * inside itself rather than dragging the page with it (DESIGN.md §3.11).
 */
export interface DocsSidebarProps {
  nav: DocNavGroup[];
  activeSlug?: string;
  className?: string;
}

export function DocsSidebar({ nav, activeSlug, className }: DocsSidebarProps) {
  return (
    <nav
      aria-label="Documentation"
      className={cn(
        "sticky top-16 h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain",
        "border-r border-default py-10 pr-4",
        className,
      )}
    >
      <DocsNavList nav={nav} activeSlug={activeSlug} />
    </nav>
  );
}
