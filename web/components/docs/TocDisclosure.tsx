import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DocHeading } from "@/lib/docs";

/**
 * The under-1024px table of contents: a native `<details>`, so it opens,
 * closes and is keyboard operable with no JavaScript at all.
 */
export interface TocDisclosureProps {
  headings: DocHeading[];
  className?: string;
}

export function TocDisclosure({ headings, className }: TocDisclosureProps) {
  if (headings.length === 0) return null;

  return (
    <details
      className={cn(
        "group rounded-lg border border-default bg-surface-card px-4 py-1 xl:hidden",
        className,
      )}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-body-sm font-medium text-text marker:content-['']">
        On this page
        <ChevronDown
          className="size-4 text-faint transition-transform dur-fast ease-out group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <nav aria-label="On this page" className="pb-3">
        <ul className="list-none border-l border-default">
          {headings.map((heading) => (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                className={cn(
                  "block py-1.5 text-body-sm text-muted transition-colors dur-fast ease-out hover:text-text",
                  heading.depth === 3 ? "pl-6" : "pl-3",
                )}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}
