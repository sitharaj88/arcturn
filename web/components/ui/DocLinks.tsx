import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { cardSurface } from "./Card";

/** The "read the docs" block that closes a marketing section. */
export interface DocLink {
  href: string;
  title: string;
}

export interface DocLinksProps {
  links: DocLink[];
  title?: string;
  className?: string;
}

export function DocLinks({ links, title = "Read the docs", className }: DocLinksProps) {
  return (
    <nav
      aria-label={title}
      // Card's surface, not a copy of it — but flat: this block sits inside a
      // section rather than floating above the page (DESIGN.md §2.3.4).
      className={cn("rounded-lg border p-5", cardSurface({ elevated: false }), className)}
    >
      <p className="text-eyebrow uppercase text-faint">{title}</p>
      <ul className="mt-3 list-none space-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="group inline-flex min-h-11 items-center gap-2 text-body-sm text-accent hover:text-accent-hover sm:min-h-0 sm:py-1"
            >
              {link.title}
              <ArrowRight
                aria-hidden="true"
                className="size-4 transition-transform dur-fast ease-out group-hover:translate-x-0.5"
              />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
