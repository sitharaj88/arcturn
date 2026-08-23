import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The recurring "read more about this" affordance that closes a marketing
 * section. It is a link, not a button: the section it ends is prose, and the
 * next step is more reading.
 */
export interface SectionLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

export function SectionLink({ href, children, className }: SectionLinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex min-h-11 items-center gap-1.5 text-body-sm font-medium text-accent",
        "hover:text-accent-hover sm:min-h-0",
        className,
      )}
    >
      {children}
      <ArrowRight
        aria-hidden="true"
        className="size-4 transition-transform dur-fast ease-out group-hover:translate-x-0.5"
      />
    </Link>
  );
}
