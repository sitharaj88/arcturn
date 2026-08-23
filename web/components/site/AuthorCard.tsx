import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { AUTHOR_LINKS } from "@/lib/utils";

/**
 * Author & support (DESIGN.md §5.3). The same four links as the footer, in
 * the same order — this block is in addition to the footer, never instead of it.
 */
export function AuthorCard({ className }: { className?: string }) {
  return (
    <Card className={cn("", className)}>
      <p className="text-eyebrow uppercase text-faint">Author &amp; support</p>
      <p className="mt-3 text-h4 text-text">Sitharaj Seenivasan</p>
      <p className="mt-1.5 text-body-sm text-muted">
        Arcturn is built and maintained by one person. If it is useful to you, the links below are
        the ways to say so.
      </p>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-body-sm">
        {AUTHOR_LINKS.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-accent hover:text-accent-hover sm:min-h-0"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
