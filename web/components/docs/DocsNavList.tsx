import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DocNavGroup } from "@/lib/docs";

/**
 * The grouped documentation nav, shared by the desktop sidebar and the mobile
 * drawer so there is exactly one source of nav markup. It carries no state of
 * its own: the active page comes in as a slug, and `onNavigate` is only ever
 * passed by the drawer (which closes itself on a click).
 */
export interface DocsNavListProps {
  nav: DocNavGroup[];
  activeSlug?: string;
  onNavigate?: () => void;
  className?: string;
}

export function DocsNavList({ nav, activeSlug, onNavigate, className }: DocsNavListProps) {
  return (
    <div className={cn("flex flex-col gap-7", className)}>
      {nav.map((group) => (
        <div key={group.section}>
          <p className="px-3 text-eyebrow uppercase text-faint">{group.section}</p>
          <ul className="mt-2 list-none">
            {group.items.map((item) => {
              const active = item.slug === activeSlug;
              return (
                <li key={item.slug}>
                  <Link
                    href={`/docs/${item.slug}`}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center rounded-md border-l-2 px-3 py-1.5 text-body-sm",
                      "transition-colors dur-fast ease-out lg:min-h-0",
                      active
                        ? "border-l-accent bg-surface-card font-medium text-text"
                        : "border-l-transparent text-muted hover:bg-surface-hover hover:text-text",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
